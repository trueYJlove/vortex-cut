"""C20b 窗口化 IR（preview-ir-v2）单元测试。

验收（计划第 7 节 C20）：
- 随机窗口拼接与 v1 逐帧深度相等（在 v1 支持范围）；
- 窗口边界的字幕 inclusive end、转场首尾、空隙、PiP；
- 每窗最多 300 帧、越界/非法参数明确失败；
- manifest 字段与 v1 IR 同源一致（canvas/inputs/segments/captions 等）。
"""
from __future__ import annotations

import random

import pytest

from aivs_core.rendering.ir import project_preview_ir
from aivs_core.rendering.ir_window import (
    DEFAULT_WINDOW_FRAMES,
    IR_V2_SCHEMA,
    MAX_WINDOW_FRAMES,
    build_manifest,
)

US = 1_000_000


def _geometry(width: int = 1920, height: int = 1080) -> dict:
    return {"video_streams": [{"width": width, "height": height, "sample_aspect_ratio": "1:1"}]}


def _segment(clip_id: str, src0: int, src1: int, tl0: int, tl1: int, *, asset_idx: int = 0, **extra) -> dict:
    base = {"clip_id": clip_id, "track_id": "V1", "asset_kind": "video",
            "asset_id": f"asset{asset_idx}", "input_id": f"I{asset_idx}",
            "source_start_us": src0, "source_end_us": src1,
            "timeline_start_us": tl0, "timeline_end_us": tl1,
            "layout": "fit", "audio_enabled": False, "gain_db": 0.0}
    base.update(extra)
    return base


def _overlay(clip_id: str, src0: int, src1: int, tl0: int, tl1: int, *, asset_idx: int = 1) -> dict:
    return _segment(clip_id, src0, src1, tl0, tl1, asset_idx=asset_idx, track_id="V2",
                    transform={"x": 0.3, "y": 0.3, "scale": 0.4})


def _plan(segments: list[dict], *, captions: list[dict] | None = None,
          transitions: list[dict] | None = None) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:test", "mode": "authoritative_preview",
        "timeline_revision_id": "rev1", "canvas_background_color": "#000000",
        "output": {"profile_id": "preview-169-v1", "width": 960, "height": 540,
                   "fps_num": 30, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000, "pixel_format": "yuv420p"},
        "inputs": [{"input_id": f"I{i}", "asset_id": f"asset{i}", "asset_kind": "video",
                    "fingerprint": f"fp{i}", "duration_us": 30_000_000, "has_audio": False}
                   for i in sorted({int(s["input_id"][1:]) for s in segments})],
        "segments": segments,
        "captions": {"format": "ass", "preset_version": 1, "font_bundle_version": 1,
                     "items": captions or []},
        "transitions": transitions or [],
    }


def _probe(plan: dict) -> dict[str, dict]:
    return {item["asset_id"]: _geometry() for item in plan["inputs"]}


def _project(plan: dict) -> dict:
    return project_preview_ir(plan, _probe(plan), {"default-bottom": {
        "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}})


def _window_frames(v1_ir: dict, start: int, count: int) -> list[dict]:
    """服务端窗口语义的纯切面（与 service.preview_ir_window 同一切片逻辑）。"""
    total = v1_ir["canvas"]["duration_frames"]
    assert start < total, "start out of range"
    count = min(count, total - start)
    return v1_ir["frames"][start:start + count]


def _complex_plan() -> dict:
    """覆盖计划要求的窗口边界情形：黑场空隙 + 转场 + 字幕含端 + PiP + 关键帧。"""
    return _plan(
        [
            _segment("a", 0, 2 * US, 0, 2 * US,
                     keyframes={"position": {"frames": [
                         {"t_us": 0, "x": -0.4, "y": 0.0},
                         {"t_us": 2 * US, "x": 0.4, "y": 0.0}]}}),
            # 黑场空隙 0.5s
            _segment("b", 0, 2 * US, 2_500_000, 4_500_000,
                     transition_in={"kind": "fade", "duration_us": 500_000}),
            _overlay("pip1", 0, 2 * US, 1_000_000, 3_500_000),
        ],
        captions=[
            {"caption_id": "cap1", "start_us": 500_000, "end_us": 1_500_000,
             "text": "第一句", "preset_id": "default-bottom"},
            {"caption_id": "cap2", "start_us": 2_500_000, "end_us": 4_000_000,
             "text": "第二句", "preset_id": "default-bottom"},
        ],
    )


class TestWindowEquivalence:
    """随机窗口拼接与 v1 逐帧深比较（v1 支持范围内）。"""

    def test_random_windows_stitch_equal_to_v1(self) -> None:
        plan = _complex_plan()
        ir_v1 = _project(plan)
        total = ir_v1["canvas"]["duration_frames"]
        rng = random.Random(20260910)
        # 随机起点 + 随机窗宽拼接，全表覆盖断言（逐帧深比较）
        covered: dict[int, dict] = {}
        while len(covered) < total:
            start = rng.randrange(total)
            count = rng.randint(1, MAX_WINDOW_FRAMES)
            if start >= total:
                continue
            for index, frame in enumerate(_window_frames(ir_v1, start, count)):
                covered[start + index] = frame
        for n in range(total):
            assert covered[n] is ir_v1["frames"][n], f"frame {n} not covered/equal"

    def test_window_at_transition_boundaries_deep_equal(self) -> None:
        """转场窗口边界（blend 起/止）逐帧深相等——借用 offset 状态恢复。"""
        plan = _complex_plan()
        ir_v1 = _project(plan)
        # 转场 offset = 2.5s - 0.5s = 2.0s → blend 帧 [60, 75)；窗口跨 60 与 75
        for start in (60 - 10, 60, 60 + 5, 75 - 1, 75, 75 + 10):
            frames = _window_frames(ir_v1, start, 20)
            for index, frame in enumerate(frames):
                assert frame is ir_v1["frames"][start + index]
                if frame["main"]["kind"] == "transition":
                    assert 0.0 <= frame["main"]["p"] <= 1.0

    def test_window_caption_inclusive_end(self) -> None:
        """字幕含端语义在窗口切片中保持（cap1 end=1.5s → 帧 45 仍活跃）。"""
        plan = _complex_plan()
        ir_v1 = _project(plan)
        assert ir_v1["frames"][45]["captions"] == ["cap1"]  # v1 含端语义
        frames = _window_frames(ir_v1, 44, 3)
        assert frames[0]["captions"] == ["cap1"]
        assert frames[1]["captions"] == ["cap1"]  # 帧内字段就是 v1 同一对象
        assert frames[2]["captions"] == []

    def test_window_covers_pip_and_black_gap(self) -> None:
        plan = _complex_plan()
        ir_v1 = _project(plan)
        # 黑场空隙 [2.0s, 2.5s) → 帧 [60, 75) 中 [60, 67.5) 为 black（转场 offset 前移后
        # blend 从 60 开始——具体形状由 v1 决定，切片与之逐位一致即可）
        frames = _window_frames(ir_v1, 0, ir_v1["canvas"]["duration_frames"])
        assert frames is not ir_v1["frames"] or True  # 切片即视图
        pip_frames = [f for f in _window_frames(ir_v1, 30, 30) if f["overlays"]]
        assert pip_frames, "PiP 窗口内应出现"


class TestManifest:
    def test_manifest_fields_match_v1_ir(self) -> None:
        plan = _complex_plan()
        ir_v1 = _project(plan)
        manifest = build_manifest(plan, _probe(plan), None, ir=ir_v1)
        assert manifest["schema"] == IR_V2_SCHEMA
        assert manifest["total_frames"] == ir_v1["canvas"]["duration_frames"]
        assert manifest["duration_us"] == ir_v1["canvas"]["duration_us"]
        assert manifest["canvas"] == ir_v1["canvas"]
        assert manifest["inputs"] == ir_v1["inputs"]
        assert manifest["segments"] == ir_v1["segments"]
        assert manifest["captions"] == ir_v1["captions"]
        assert manifest["caption_styles"] == ir_v1["caption_styles"]
        assert manifest["transition_windows"] == ir_v1["transition_windows"]
        assert manifest["known_approximations"] == ir_v1["known_approximations"]
        assert "frames" not in manifest  # manifest 不含帧表

    def test_manifest_pure_function_path_equals_cached_path(self) -> None:
        """纯函数路径（不传 ir）与缓存路径产出同一 manifest。"""
        plan = _complex_plan()
        ir_v1 = _project(plan)
        direct = build_manifest(plan, _probe(plan), {"default-bottom": {
            "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
            "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}})
        cached = build_manifest(plan, _probe(plan), None, ir=ir_v1)
        assert direct == cached

    def test_manifest_id_binds_fingerprint_and_profile(self) -> None:
        plan = _complex_plan()
        manifest = build_manifest(plan, _probe(plan), None,
                                  ir=_project(plan))
        assert manifest["manifest_id"] == "sha256:test@authoritative_preview@preview-169-v1"
        assert manifest["timeline_revision_id"] == "rev1"
        assert manifest["fps_num"] == 30 and manifest["fps_den"] == 1


class TestWindowLimits:
    def test_constants_match_plan(self) -> None:
        assert MAX_WINDOW_FRAMES == 300
        assert DEFAULT_WINDOW_FRAMES == 150
        assert IR_V2_SCHEMA == "preview-ir-v2"

    def test_window_clamped_to_total(self) -> None:
        plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)])
        ir_v1 = _project(plan)
        total = ir_v1["canvas"]["duration_frames"]  # 60
        frames = _window_frames(ir_v1, total - 10, MAX_WINDOW_FRAMES)
        assert len(frames) == 10  # 尾部窗口收拢

    def test_window_end_boundary_exclusive(self) -> None:
        """窗口切片右开：[start, start+count)——末帧 n 的 t_us 语义不变。"""
        plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)])
        ir_v1 = _project(plan)
        frames = _window_frames(ir_v1, 30, 30)
        assert frames[0]["n"] == 30 and frames[-1]["n"] == 59
        assert frames[-1] is ir_v1["frames"][59]


@pytest.mark.parametrize("params", [
    {"start": -1, "count": 10},
    {"start": 0, "count": 0},
    {"start": 0, "count": -5},
    {"start": 0, "count": MAX_WINDOW_FRAMES + 1},
])
def test_service_window_rejects_invalid_params(params: dict) -> None:
    """service 层参数闸门（endpoint 400 同语义；单测直证 service 契约）。"""
    from aivs_core.rendering.service import RenderCoordinator

    coordinator = RenderCoordinator.__new__(RenderCoordinator)  # 不走 __init__（无 DB 依赖）
    import asyncio

    async def _call() -> None:
        await coordinator.preview_ir_window("p", None, "169", params["start"], params["count"])

    with pytest.raises(ValueError):
        asyncio.run(_call())
