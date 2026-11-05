"""旋转/代理链路回归锁（P206/P212；2026-11-03 真机 5 缺陷链）。

缺陷症状与根因隔得很远，链路任一环静默回退都会整条复发：

- A: `ffprobe._rotation` 只读 `side_data_list[0]`。iPhone 素材第 0 项是
  Dolby Vision configuration record，displaymatrix 排在后面 ⇒ rotation 恒为 0
  ⇒ 整条链路都以为这是横版素材。
- B: `proxy_profiles.display_size` 拿原始值比对 `(90, 270)`，而 ffprobe 给的是
  带符号的 -90 ⇒ 落空 ⇒ 不换轴。
- C: `proxy_args` 曾自己 transpose 转正像素，但 ffmpeg 仍把源 display matrix
  写进输出 ⇒ 播放器再转一次 ⇒ 画面侧躺。现交由 autorotate（不得加
  `-noautorotate`，也不得再 transpose）。
- D: `ir.py` 的 geometry 只有原始尺寸 ⇒ `_fit_content_box` 按横版算内容盒
  ⇒ 竖画面被横向拉伸填进竖画布。

全部为纯函数/归一化层断言：不读真实媒体文件、不调 ffmpeg。
"""
from __future__ import annotations

import pytest

from aivs_core.media.ffprobe import _rotation
from aivs_core.media.proxy_profiles import coded_size, display_size, proxy_args
from aivs_core.rendering.ir import _fit_content_box

# ffprobe -show_streams 里排在 displaymatrix **之前**的项（iPhone 素材真实形态）。
DOVI_ENTRY = {"side_data_type": "DOVI configuration record", "dv_profile": 8}
DISPLAY_MATRIX_ENTRY = {"side_data_type": "Display Matrix"}


def _rotated_stream(rotation: int) -> dict:
    """ffprobe -show_streams 形状的 dict：displaymatrix 排在第 0 项之后。"""
    return {
        "width": 3840,
        "height": 2160,
        "side_data_list": [dict(DOVI_ENTRY), {**DISPLAY_MATRIX_ENTRY, "rotation": rotation}],
    }


class TestRotationScansWholeSideDataList:
    """缺陷 A：旋转元数据不在 side_data_list[0] 时也必须取到。"""

    def test_rotation_found_when_displaymatrix_is_not_first(self) -> None:
        # -90 归一化到 0..359 = 270（竖拍）
        assert _rotation(_rotated_stream(-90)) == 270

    def test_rotation_found_behind_multiple_leading_entries(self) -> None:
        stream = {
            "width": 3840,
            "height": 2160,
            "side_data_list": [
                dict(DOVI_ENTRY),
                {"side_data_type": "Mastering display metadata"},
                {**DISPLAY_MATRIX_ENTRY, "rotation": -90},
            ],
        }
        assert _rotation(stream) == 270

    def test_tags_rotate_still_wins_over_side_data(self) -> None:
        # 既有行为不能回退：tags.rotate 优先于 side_data_list
        stream = _rotated_stream(-90)
        stream["tags"] = {"rotate": "90"}
        assert _rotation(stream) == 90

    def test_side_data_without_rotation_returns_zero(self) -> None:
        # 负向：没有任何 rotation 字段 ⇒ 0，且不得抛异常
        stream = {"width": 3840, "height": 2160, "side_data_list": [dict(DOVI_ENTRY)]}
        assert _rotation(stream) == 0

    def test_missing_or_malformed_side_data_returns_zero(self) -> None:
        assert _rotation({"width": 3840, "height": 2160}) == 0
        assert _rotation({"side_data_list": [None, "junk", dict(DOVI_ENTRY)]}) == 0
        assert _rotation({"side_data_list": [{**DISPLAY_MATRIX_ENTRY, "rotation": "bad"}]}) == 0


class TestDisplaySizeAcceptsSignedRotation:
    """缺陷 B：ffprobe 的 -90 必须与 270 等价换轴。"""

    @pytest.mark.parametrize(
        ("rotation", "expected"),
        [
            (-90, (2160, 3840)),  # iPhone 竖拍真实取值
            (270, (2160, 3840)),  # 同义角度，结果必须一致
            (90, (2160, 3840)),
            (0, (3840, 2160)),
            (180, (3840, 2160)),  # 180° 仍是横版宽高比
        ],
    )
    def test_display_size(self, rotation: int, expected: tuple[int, int]) -> None:
        assert display_size(3840, 2160, 1.0, rotation) == expected

    def test_coded_size_is_portrait_for_signed_rotation(self) -> None:
        assert coded_size("preview-1080-v1", 3840, 2160, 1.0, -90) == (1080, 1920)
        assert coded_size("preview-1080-v1", 3840, 2160, 1.0, 270) == (1080, 1920)


def _filter_chain(args: list[str]) -> str:
    return args[args.index("-vf") + 1]


def _args_for(rotation: int) -> list[str]:
    return proxy_args(
        "in.mkv", "out.mp4", "preview-1080-v1", 3840, 2160, "libx264", rotation=rotation
    )


class TestProxyArgsLeavesRotationToAutorotate:
    """缺陷 C：方向交给 ffmpeg autorotate，既不关它也不自己 transpose。"""

    def test_rotated_source_keeps_autorotate_enabled(self) -> None:
        args = _args_for(-90)
        assert "-noautorotate" not in args

    def test_rotated_source_does_not_transpose(self) -> None:
        # transpose 会让源 display matrix 残留在输出里 ⇒ 播放器再转一次
        assert "transpose" not in _filter_chain(_args_for(-90))

    def test_rotated_source_scales_to_portrait(self) -> None:
        # 像素方向最终由 autorotate 决定，所以 scale 目标必须已是竖版
        assert "scale=1080:1920:force_original_aspect_ratio=disable" in _filter_chain(
            _args_for(-90)
        )

    def test_unrotated_source_behaviour_unchanged(self) -> None:
        args = _args_for(0)
        chain = _filter_chain(args)
        assert "transpose" not in chain
        assert "-noautorotate" not in args
        assert "scale=1920:1080:force_original_aspect_ratio=disable" in chain


VERTICAL_GEOMETRY = {
    "width": 3840,
    "height": 2160,
    "sar": 1.0,
    "rotation": 270,
    "display_width": 2160,
    "display_height": 3840,
}


class TestFitContentBoxUsesDisplayOrientation:
    """缺陷 D：布局 fit 必须按显示方向（display_*）算内容盒。"""

    def test_vertical_source_fills_vertical_canvas(self) -> None:
        assert _fit_content_box(VERTICAL_GEOMETRY, 540, 960) == (0, 0, 540, 960)

    def test_raw_dimensions_would_not_fill_the_canvas(self) -> None:
        # display_* 是承重的：只给原始尺寸算出来的盒铺不满竖画布（= 旧缺陷）
        raw_only = {"width": 3840, "height": 2160, "sar": 1.0, "rotation": 270}
        assert _fit_content_box(raw_only, 540, 960) != (0, 0, 540, 960)

    def test_legacy_geometry_without_display_fields_falls_back(self) -> None:
        # 老 IR 只有 width/height/sar：回落原行为，不 KeyError
        assert _fit_content_box({"width": 1920, "height": 1080, "sar": 1.0}, 960, 540) == (
            0,
            0,
            960,
            540,
        )
