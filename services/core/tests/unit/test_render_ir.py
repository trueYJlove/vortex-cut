from __future__ import annotations

import pytest

from aivs_core.projects import DomainError
from aivs_core.rendering.ir import project_preview_ir, resolved_caption_styles

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


def _plan(segments: list[dict], *, transitions: list[dict] | None = None,
          captions: list[dict] | None = None) -> dict:
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


def _frames(plan: dict) -> list[dict]:
    return project_preview_ir(plan, _probe(plan), {"default-bottom": {
        "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}})["frames"]


def test_simple_timeline_frame_table() -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US), _segment("b", 0, 1 * US, 2 * US, 3 * US)])
    ir = project_preview_ir(plan, _probe(plan))
    assert ir["canvas"]["duration_frames"] == 90
    assert ir["frames"][0]["main"] == {
        "kind": "segment", "clip_id": "a", "input_id": "I0", "src_n": 0, "src_t_us": 0,
        "content": {"x": 0, "y": 0, "w": 960, "h": 540},
        "shift": {"dx": 0.0, "dy": 0.0}, "alpha": 1.0}
    # 1920x1080 fit 960x540：恰为 2:1，无黑边
    assert ir["frames"][30]["main"]["src_n"] == 30
    assert ir["frames"][60]["main"]["clip_id"] == "b"
    assert ir["frames"][89]["main"]["src_n"] == 29


def test_transition_borrowed_offset_and_blend() -> None:
    plan = _plan([
        _segment("a", 0, 20 * US, 0, 20 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 1 * US}),
        _segment("b", 0, 25 * US, 20 * US, 45 * US),
    ], transitions=[{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 1 * US}])
    frames = _frames(plan)
    # 输出时长 = 45s − 1s 借用 = 44s；blend 窗口 [19, 20)
    assert len(frames) == 44 * 30
    assert frames[570]["main"]["kind"] == "transition" and frames[570]["main"]["p"] == 0.0
    assert frames[585]["main"]["p"] == 0.5
    assert frames[585]["main"]["left"]["src_n"] == 585
    assert frames[585]["main"]["right"]["src_n"] == 15  # 头部借用：blend 相对 0.5s × 30fps（1×）
    assert frames[600]["main"]["kind"] == "segment"
    assert frames[600]["main"]["src_n"] == 30  # body 起点跳过头借 1s（1× = 30 帧）
    assert frames[570]["main"]["left"]["shift"]["dx"] == 0.0


def test_speed_nearest_frame_mapping() -> None:
    plan = _plan([_segment("b", 0, 20 * US, 0, 25 * US, speed_milli=800)])
    frames = _frames(plan)
    # 0.8×：输出 t=1s → 源 0.8s → 帧 24
    assert frames[30]["main"]["src_n"] == 24
    assert frames[60]["main"]["src_n"] == 48
    # 帧边界恰为整帧时取该帧
    assert frames[375]["main"]["src_n"] == 300


def test_position_keyframes_lerp() -> None:
    plan = _plan([_segment("c", 0, 15 * US, 0, 15 * US, keyframes={
        "position": {"frames": [
            {"t_us": 0, "x": -0.6, "y": 0.0},
            {"t_us": 5 * US, "x": 0.0, "y": -0.4},
            {"t_us": 10 * US, "x": 0.6, "y": 0.0}]}})])
    frames = _frames(plan)
    # t_seg=2.5s：x=-0.3 → dx=-144；y=-0.2 → dy=-54
    f = frames[75]["main"]
    assert f["shift"] == {"dx": -144.0, "dy": -54.0}
    # 窗口外取边界值
    assert frames[0]["main"]["shift"]["dx"] == -288.0
    assert frames[14 * 30]["main"]["shift"]["dx"] == 288.0


def test_opacity_fade_approximation() -> None:
    plan = _plan([_segment("c", 0, 15 * US, 0, 15 * US, keyframes={
        "opacity": {"frames": [{"t_us": 0, "v": 0.0}, {"t_us": 6 * US, "v": 1.0}]}})])
    frames = _frames(plan)
    assert frames[90]["main"]["alpha"] == 0.5  # t=3s / d=6s
    assert frames[180]["main"]["alpha"] == 1.0
    # 帧值 v 不参与（近似语义：恒 0→1）
    assert frames[0]["main"]["alpha"] == 0.0


def test_pip_content_box_and_transform() -> None:
    plan = _plan([
        _segment("a", 0, 30 * US, 0, 30 * US),
        _segment("p", 0, 20 * US, 10 * US, 30 * US, asset_idx=1, track_id="V2",
                 transform={"x": 0.7, "y": 0.3, "scale": 0.35, "rotate": 15.0}),
    ])
    frames = _frames(plan)
    # 内容盒 960x540 × 0.35 → pip 336x188；中心 (672, 162)
    assert frames[450]["overlays"] == [{
        "clip_id": "p", "input_id": "I1", "src_n": 150, "src_t_us": 5_000_000,
        "box": {"x": 504.0, "y": 68.0, "w": 336, "h": 188},
        "rotation_deg": 15.0, "alpha": 1.0}]
    # enable 窗口外无叠加（窗口 [10s,30s] 含末帧 899）
    assert frames[0]["overlays"] == []
    assert frames[899]["overlays"][0]["src_n"] == 599
    assert frames[900 - 1 - 1]["overlays"][0]["src_n"] == 598


def test_output_duration_uses_borrow_compression() -> None:
    plan = _plan([
        _segment("a", 0, 5 * US, 0, 5 * US,
                 transition_in={"transition_id": "t", "kind": "fade", "duration_us": 500_000}),
        _segment("b", 0, 5 * US, 5 * US, 10 * US),
    ], transitions=[{"transition_id": "t", "after_clip_id": "a", "kind": "fade", "duration_us": 500_000}])
    ir = project_preview_ir(plan, _probe(plan))
    # 时间线 10s，借用 0.5s → 输出 9.5s（285 帧），非时间线口径的 300 帧
    assert ir["canvas"]["duration_frames"] == 285
    # blend [4.5,5)，b body [5,9.5)
    assert ir["frames"][149]["main"]["kind"] == "transition"
    assert ir["frames"][150]["main"]["kind"] == "segment"


def test_black_fill_for_timeline_gap() -> None:
    plan = _plan([
        _segment("a", 0, 1 * US, 0, 1 * US),
        _segment("b", 0, 1 * US, 2 * US, 3 * US),
    ])
    frames = _frames(plan)
    assert frames[15]["main"]["kind"] == "segment"   # a 段播放中
    assert frames[45]["main"]["kind"] == "black"     # 空隙 [1s,2s)
    assert frames[59]["main"]["kind"] == "black"
    assert frames[60]["main"]["kind"] == "segment" and frames[60]["main"]["clip_id"] == "b"


def test_caption_timing() -> None:
    plan = _plan([_segment("a", 0, 3 * US, 0, 3 * US)],
                 captions=[{"caption_id": "c1", "start_us": US, "end_us": 2 * US,
                            "text": "测试", "preset_id": "default-bottom"}])
    frames = _frames(plan)
    assert frames[0]["captions"] == []
    assert frames[45]["captions"] == ["c1"]
    assert frames[89]["captions"] == []


def test_resolved_caption_styles() -> None:
    styles = resolved_caption_styles({"presets": {"default-bottom": {
        "font_size": 64, "primary_color": "&H00FFFFFF", "outline_color": "&H00000000",
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}}})
    assert styles == {"default-bottom": {
        "font_size": 64, "primary_rgb": [255, 255, 255], "outline_rgb": [0, 0, 0],
        "outline": 4, "shadow": 0, "border_style": 1, "margin_v": 150}}


@pytest.mark.parametrize("mutation,fragment", [
    ({"mask": {"kind": "rect"}}, "mask（蒙版）"),
    ({"keying": {"color": "00FF00"}}, "keying（抠像）"),
    ({"reverse_playback": True}, "reverse_playback（倒放）"),
    ({"keyframes": {"scale": {"frames": [{"t_us": 0, "v": 1.0}]}}}, "关键帧属性"),
    ({"keyframes": {"position": {"frames": [{"t_us": 0, "x": 0.0, "y": 0.0}]}}, "track_id": "V2"}, "非 V1 轨关键帧"),
    ({"transition_in": {"transition_id": "t", "kind": "dissolve", "duration_us": US}}, "转场 dissolve"),
])
def test_whitelist_hard_fail(mutation: dict, fragment: str) -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US, **mutation)])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, _probe(plan))
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"
    assert fragment in exc.value.message


def test_whitelist_rejects_style_override() -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)],
                 captions=[{"caption_id": "c1", "start_us": 0, "end_us": US, "text": "x",
                            "preset_id": "default-bottom", "style_override": {"font_size": 80}}])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, _probe(plan))
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"


def test_whitelist_rejects_missing_geometry() -> None:
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US)])
    with pytest.raises(DomainError) as exc:
        project_preview_ir(plan, {**_probe(plan), "asset0": {"video_streams": []}})
    assert exc.value.code == "PREVIEW_IR_UNSUPPORTED"


def test_whitelist_rejects_oversized_timeline() -> None:
    long_segments = [_segment(f"c{i}", 0, 2 * US, i * 2 * US, (i + 1) * 2 * US,
                              asset_idx=i % 2)
                     for i in range(8)]  # 16s < 15min，需直接构造超长
    long_segments = [_segment("a", 0, 920 * US, 0, 920 * US)]
    # 920s ≈ 27600 帧 > 27000
    with pytest.raises(DomainError) as exc:
        project_preview_ir(long_segments and _plan(long_segments), _probe(_plan(long_segments)))
    assert exc.value.code == "PREVIEW_IR_TOO_LARGE"
