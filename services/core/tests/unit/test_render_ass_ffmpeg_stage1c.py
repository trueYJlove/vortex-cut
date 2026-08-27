from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.projects import DomainError
from aivs_core.rendering.ass import CaptionResources, build_ass, escape_ass_text
from aivs_core.rendering.ffmpeg import build_timeline_args


def _plan() -> dict:
    segments = []
    for index, (kind, layout, enabled, gain) in enumerate(
        (
            ("video", "blurred_background", True, -3.0),
            ("video", "crop_fill", False, 0.0),
            ("image", "fit", False, 0.0),
        )
    ):
        segments.append(
            {
                "clip_id": f"c{index}",
                "input_id": f"I{index}",
                "asset_kind": kind,
                "source_start_us": 0 if kind == "video" else None,
                "source_end_us": 1_000_000 if kind == "video" else None,
                "timeline_start_us": index * 1_000_000,
                "timeline_end_us": (index + 1) * 1_000_000,
                "layout": layout,
                "audio_enabled": enabled,
                "gain_db": gain,
            }
        )
    return {
        "segments": segments,
        "captions": {"items": [{"text": "user;[x]{\\tag}", "start_us": 0}]},
        "output": {"width": 540, "height": 960},
    }


def test_ass_resources_presets_and_injection_escaping() -> None:
    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, font_path = resources.load()
    assert font_path.is_file()
    captions = [
        {
            "start_us": 0,
            "end_us": 1_000_000,
            "text": "中文 {\\pos(1,2)} \\N",
            "preset_id": "default-bottom",
        },
        {
            "start_us": 1_000_000,
            "end_us": 2_000_000,
            "text": "game safe",
            "preset_id": "game-safe-bottom",
        },
        {
            "start_us": 2_000_000,
            "end_us": 3_000_000,
            "text": "contrast",
            "preset_id": "high-contrast",
        },
    ]
    result = build_ass(captions, bundle, presets)
    assert "Noto Sans CJK SC" in result
    assert "default-bottom" in result
    assert "game-safe-bottom" in result
    assert "high-contrast" in result
    assert "{\\pos" not in result
    assert "\\N" not in result
    assert "｛＼pos(1,2)｝" in result
    with pytest.raises(DomainError):
        escape_ass_text("bad\x00text")


def test_builder_has_three_layouts_continuous_audio_and_no_text_in_filter() -> None:
    plan = _plan()
    paths = [Path("C:/素材/a.mp4"), Path("C:/素材/b.mp4"), Path("C:/素材/c.png")]
    probes = [
        {"audio_streams": [{}]},
        {"audio_streams": []},
        {"audio_streams": []},
    ]
    args = build_timeline_args(
        plan, paths, probes, "libopenh264", "output.mp4", captions=True
    )
    graph = args[args.index("-filter_complex") + 1]
    assert "gblur=sigma=20" in graph
    assert graph.count("trunc(iw*sar/2)*2") == 3
    assert "setpts=PTS-STARTPTS,setsar=1" not in graph
    assert "force_original_aspect_ratio=increase" in graph
    assert "pad=540:960" in graph
    assert graph.count("anullsrc=channel_layout=stereo:sample_rate=48000") == 2
    assert "volume=-3.000dB" in graph
    assert "concat=n=3:v=1:a=1" in graph
    assert "ass=filename=captions.ass:fontsdir=fonts" in graph
    assert "user;[x]" not in graph
    assert "C:/素材" not in graph
    assert args.count("-i") == 3
    assert "shell" not in " ".join(args).lower()


def test_builder_rejects_unknown_layout() -> None:
    plan = _plan()
    plan["segments"][0]["layout"] = "unknown"
    with pytest.raises(DomainError) as exc:
        build_timeline_args(
            plan,
            [Path("a"), Path("b"), Path("c")],
            [{"audio_streams": []}] * 3,
            "libopenh264",
            "out.mp4",
            captions=False,
        )
    assert exc.value.code == "RENDER_PLAN_INVALID"


def test_builder_applies_speed_and_reverse_filters() -> None:
    plan = _plan()
    # 三段：2x 视频（有声）、0.25x 视频（无声）、倒放视频（有声原速）。
    plan["segments"] = plan["segments"][:1] * 0 + [
        {
            "clip_id": "fast",
            "input_id": "I0",
            "asset_kind": "video",
            "source_start_us": 1_000_000,
            "source_end_us": 5_000_000,
            "timeline_start_us": 0,
            "timeline_end_us": 2_000_000,
            "layout": "fit",
            "audio_enabled": True,
            "gain_db": 0.0,
            "speed_milli": 2000,
        },
        {
            "clip_id": "slow",
            "input_id": "I1",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 4_000_000,
            "timeline_start_us": 2_000_000,
            "timeline_end_us": 18_000_000,
            "layout": "fit",
            "audio_enabled": False,
            "gain_db": 0.0,
            "speed_milli": 250,
        },
        {
            "clip_id": "rev",
            "input_id": "I2",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 3_000_000,
            "timeline_start_us": 18_000_000,
            "timeline_end_us": 21_000_000,
            "layout": "fit",
            "audio_enabled": True,
            "gain_db": -6.0,
            "speed_milli": 1000,
            "reverse_playback": True,
        },
    ]
    paths = [Path("a.mp4"), Path("b.mp4"), Path("c.mp4")]
    probes = [{"audio_streams": [{}]}, {"audio_streams": []}, {"audio_streams": [{}]}]
    args = build_timeline_args(plan, paths, probes, "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]

    # 2x：视频 PTS 除以速度；音频链 atempo=2.0。
    assert "[0:v:0]trim=start=1.000000:end=5.000000,setpts=PTS-STARTPTS,setpts=PTS/2.000000" in graph
    assert "atempo=2.000000" in graph
    # 0.25x：音频未启用 → 静音占位；视频需要两级减速。
    assert "[1:v:0]trim=start=0.000000:end=4.000000,setpts=PTS-STARTPTS,setpts=PTS/0.250000" in graph
    # 倒放：reverse 在变速 setpts 之前（原速无 setpts）；音频静音占位且不出现 atempo/reverse 混入。
    assert "trim=start=0.000000:end=3.000000,setpts=PTS-STARTPTS,reverse,setpts=PTS-STARTPTS" in graph
    assert graph.count("anullsrc") == 2
    assert "atempo=0." not in graph.replace("atempo=0.500000", "")  # 无反向 0.25 误挂音频


def test_builder_audio_tempo_chain_splits_beyond_single_atempo_range() -> None:
    plan = _plan()
    plan["segments"] = [
        {
            "clip_id": "quarter",
            "input_id": "I0",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 4_000_000,
            "timeline_start_us": 0,
            "timeline_end_us": 16_000_000,
            "layout": "fit",
            "audio_enabled": True,
            "gain_db": 0.0,
            "speed_milli": 250,
        },
        {
            "clip_id": "quad",
            "input_id": "I1",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 8_000_000,
            "timeline_start_us": 16_000_000,
            "timeline_end_us": 18_000_000,
            "layout": "fit",
            "audio_enabled": True,
            "gain_db": 0.0,
            "speed_milli": 4000,
        },
    ]
    paths = [Path("a.mp4"), Path("b.mp4")]
    probes = [{"audio_streams": [{}]}, {"audio_streams": [{}]}]
    args = build_timeline_args(plan, paths, probes, "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # 0.25x = 0.5 × 0.5 两级；4x = 2.0 × 2.0 两级。
    assert "atempo=0.500000,atempo=0.500000" in graph
    assert "atempo=2.000000,atempo=2.000000" in graph
