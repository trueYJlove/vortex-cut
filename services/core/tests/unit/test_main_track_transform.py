# -*- coding: utf-8 -*-
"""主轨（V1）定位：transform 是否反映到 IR 的 main.content（2026-11-16）。

背景：用户要求预览区是「一块画布 + 所有素材可在上面自由排版」，
而此前主轨素材被当作不可移动的底板。

代码层面的实际状态（本轮核实）：
- `set_clip_transform` 不过滤轨道，V1 的 transform 能落库（端到端已验证）；
- `segment_frame` 第 542-546 行已经在用 static_scale / static_cx / static_cy
  重算 content 盒。

因此这两条测试的作用是**把「主轨可定位」这件事钉住**——
它现在是成立的，回归时若有人重新把主轨当底板、忽略 transform，这两条会红。
"""
from __future__ import annotations

from aivs_core.rendering.ir import project_preview_ir

US = 1_000_000


def _geometry(width: int = 1920, height: int = 1080) -> dict:
    return {"video_streams": [{"width": width, "height": height, "sample_aspect_ratio": "1:1"}]}


def _segment(clip_id: str, src0: int, src1: int, tl0: int, tl1: int, **extra) -> dict:
    base = {
        "clip_id": clip_id, "track_id": "V1", "asset_kind": "video",
        "asset_id": "asset0", "input_id": "I0",
        "source_start_us": src0, "source_end_us": src1,
        "timeline_start_us": tl0, "timeline_end_us": tl1,
        "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
    }
    base.update(extra)
    return base


def _plan(segments: list[dict]) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:test", "mode": "authoritative_preview",
        "timeline_revision_id": "rev1", "canvas_background_color": "#000000",
        "output": {"profile_id": "preview-169-v1", "width": 960, "height": 540,
                   "fps_num": 30, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000, "pixel_format": "yuv420p"},
        "inputs": [{"input_id": "I0", "asset_id": "asset0", "asset_kind": "video",
                    "fingerprint": "fp0", "duration_us": 30_000_000, "has_audio": False}],
        "segments": segments,
        "captions": {"format": "ass", "preset_version": 1, "font_bundle_version": 1, "items": []},
        "transitions": [],
    }


def _main_content(transform: dict | None) -> dict:
    extra = {"transform": transform} if transform is not None else {}
    plan = _plan([_segment("a", 0, 2 * US, 0, 2 * US, **extra)])
    ir = project_preview_ir(plan, {"asset0": _geometry()})
    for frame in ir["frames"]:
        if frame["main"]["kind"] == "segment":
            return frame["main"]["content"]
    raise AssertionError("没有 segment 帧")


def test_main_track_scale_shrinks_content_box() -> None:
    """scale 0.5 → 主轨内容盒宽度减半（此前主轨被当底板、恒为全画布）。"""
    full = _main_content(None)
    half = _main_content({"x": 0.5, "y": 0.5, "scale": 0.5})
    assert full == {"x": 0, "y": 0, "w": 960, "h": 540}, full
    assert half["w"] < full["w"], half
    assert abs(half["w"] - full["w"] / 2) <= 2, half
    assert half["x"] > 0, half


def test_main_track_position_offsets_content_center() -> None:
    """x/y 是中心点（0..1）：0.25 / 0.75 时内容盒中心应落在该处。"""
    box = _main_content({"x": 0.25, "y": 0.75, "scale": 0.5})
    cx = box["x"] + box["w"] / 2
    cy = box["y"] + box["h"] / 2
    assert abs(cx - 0.25 * 960) <= 4, (cx, box)
    assert abs(cy - 0.75 * 540) <= 4, (cy, box)
