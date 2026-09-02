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


def _two_segment_plan_with_transition() -> dict:
    return {
        "segments": [
            {
                "clip_id": "left",
                "input_id": "I0",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 4_000_000,
                "timeline_start_us": 0,
                "timeline_end_us": 4_000_000,
                "layout": "fit",
                "audio_enabled": True,
                "gain_db": 0.0,
                "speed_milli": 1000,
                "transition_in": {"transition_id": "t1", "kind": "fade", "duration_us": 500_000},
            },
            {
                "clip_id": "right",
                "input_id": "I1",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 3_000_000,
                "timeline_start_us": 4_000_000,
                "timeline_end_us": 7_000_000,
                "layout": "fit",
                "audio_enabled": True,
                "gain_db": 0.0,
                "speed_milli": 1000,
                "transition_in": None,
            },
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }


def test_builder_uses_xfade_chain_with_window_trims_for_transitions() -> None:
    plan = _two_segment_plan_with_transition()
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    # 右段拆两路独立链（FFmpeg 输出标签只能消费一次，不可复用主管线 [v1]）：
    # 头部借用区 0–0.5s 进 xfade；剩余主体 0.5–3.0s（右段全长 3s，无尾借用）concat 接回。
    assert "[vh1]" in graph and "[vr1]" in graph
    assert "trim=start=0.000000:end=0.500000,setpts=PTS-STARTPTS" in graph
    assert "trim=start=0.500000:end=3.000000,setpts=PTS-STARTPTS" in graph
    # offset = 左段全长 4s − 0.5s = 3.5s。
    assert "xfade=transition=fade:duration=0.500000:offset=3.500000" in graph
    assert "acrossfade=duration=0.500000" in graph
    assert "concat=n=2:v=1:a=0" in graph
    # 有转场时不使用全段 concat。
    assert "concat=n=" not in graph.replace("concat=n=2:v=1:a=0", "")


def test_builder_transition_chain_offsets_accumulate() -> None:
    plan = _two_segment_plan_with_transition()
    # 链式：段 0 锚 t1（转场到段 1），段 1 锚 t2（转场到段 2）。
    plan["segments"][1]["transition_in"] = {"transition_id": "t2", "kind": "dissolve", "duration_us": 1_000_000}
    third = {
        "clip_id": "third",
        "input_id": "I2",
        "asset_kind": "video",
        "source_start_us": 0,
        "source_end_us": 5_000_000,
        "timeline_start_us": 7_000_000,
        "timeline_end_us": 12_000_000,
        "layout": "fit",
        "audio_enabled": True,
        "gain_db": 0.0,
        "speed_milli": 1000,
        "transition_in": None,
    }
    plan["segments"].append(third)
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    # 转场 1：offset = 4 − 0.5 = 3.5；转场 2：累积 = 4 + (3 − 0.5) = 6.5，offset = 6.5 − 1 = 5.5。
    assert "xfade=transition=fade:duration=0.500000:offset=3.500000" in graph
    assert "xfade=transition=dissolve:duration=1.000000:offset=5.500000" in graph


def test_builder_rejects_transition_oversized_relative_to_clips() -> None:
    plan = _two_segment_plan_with_transition()
    plan["segments"][0]["transition_in"]["duration_us"] = 4_000_000  # 前段仅 4s，offset = 0
    with pytest.raises(DomainError) as exc:
        build_timeline_args(
            plan,
            [Path("a.mp4"), Path("b.mp4")],
            [{"audio_streams": []}, {"audio_streams": []}],
            "libopenh264",
            "out.mp4",
            captions=False,
        )
    assert exc.value.code == "RENDER_PLAN_INVALID"


def test_lerp_expression_two_frames_and_multi_frame_nesting() -> None:
    from aivs_core.rendering.ffmpeg import _lerp_expression

    track = {"frames": [{"t_us": 0, "v": 1.0}, {"t_us": 2_000_000, "v": 2.0}]}
    expr = _lerp_expression(track, True)
    # 单段：lt(t,2) 守护 + lerp。
    assert expr == "if(lt(t,2.000000),(1.000000+((t-0.000000)*1.000000/2.000000)),2.000000)"

    multi = {"frames": [{"t_us": 0, "v": 1.0}, {"t_us": 1_000_000, "v": 2.0}, {"t_us": 3_000_000, "v": 0.5}]}
    expr3 = _lerp_expression(multi, True)
    assert "if(lt(t,1.000000)" in expr3 and "if(lt(t,3.000000)" in expr3
    # 括号平衡。
    assert expr3.count("(") == expr3.count(")")


def test_keyframe_animation_filters_generated_and_passthrough() -> None:
    from aivs_core.rendering.ffmpeg import _keyframe_animation_filters

    no_kf = {"clip_id": "c"}
    assert _keyframe_animation_filters(no_kf, "srcchain", "vbase1", "out", 540, 960, -1) == ["srcchain[vbase1]", "[vbase1]null[out]"]

    segment = {
        "clip_id": "c",
        "keyframes": {
            "scale": {"frames": [{"t_us": 0, "v": 1.0}, {"t_us": 1_000_000, "v": 1.5}]},
            "position": {"frames": [{"t_us": 0, "x": 0.0, "y": 0.0}, {"t_us": 1_000_000, "x": 0.25, "y": -0.25}]},
        },
    }
    result = _keyframe_animation_filters(segment, "srcchain", "vbase1", "out", 540, 960, 2)
    joined = ";".join(result)
    assert "scale=w='iw*max(" in joined and ":eval=frame" in joined
    assert "overlay=x='(W-w)/2+" in joined and "*(W/2)'" in joined
    assert "[2:v][ks1]overlay=" in joined
    assert result[-1].endswith("[out]")


def test_builder_embeds_animation_chain_for_keyframed_segment() -> None:
    plan = _two_segment_plan_with_transition()
    del plan["segments"][0]["transition_in"]
    plan["segments"][0]["keyframes"] = {
        "opacity": {"frames": [{"t_us": 0, "v": 1.0}, {"t_us": 1_000_000, "v": 0.5}]},
    }
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    assert "fade=alpha=1:st=0.000000" in graph
    # concat 仍从各段 [vN] 消费（无转场场景）。
    assert "concat=n=2:v=1:a=1" in graph


def test_ass_inline_override_tags_snapshot() -> None:
    from aivs_core.rendering.ass import build_ass

    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, _font = resources.load()
    captions = [
        # 无覆盖：标签前缀为空，正文无前导 {。
        {"caption_id": "a", "preset_id": "default-bottom", "start_us": 0, "end_us": 1_000_000, "text": "无覆盖正文"},
        # 全字段覆盖：fs/c/3c/bord/an/marginv。
        {"caption_id": "b", "preset_id": "default-bottom", "start_us": 0, "end_us": 1_000_000, "text": "全字段",
         "style_override": {"font_size": 96, "primary_color": "&H0030FFFF", "outline_color": "&H00000000",
                            "outline": 6, "alignment": 8, "margin_v": 200}},
        # 自定义坐标：\pos 换算（0.25*1080=270, 0.75*1920=1440），不出现 an。
        {"caption_id": "c", "preset_id": "default-bottom", "start_us": 0, "end_us": 1_000_000, "text": "自定义坐标",
         "style_override": {"pos_x": 0.25, "pos_y": 0.75}},
        # 特殊字符正文 + 覆盖组合：转义不失效、标签在正文之外。
        {"caption_id": "d", "preset_id": "default-bottom", "start_us": 0, "end_us": 1_000_000, "text": "{\pos(1,1)}注入",
         "style_override": {"font_size": 48}},
    ]
    result = build_ass(captions, bundle, presets)
    lines = result.splitlines()
    dialogue = [line for line in lines if line.startswith("Dialogue:")]
    assert len(dialogue) == 4
    assert "无覆盖正文" in dialogue[0] and not dialogue[0].split(",,")[-1].startswith("{\\")
    assert r"\fs96" in dialogue[1] and r"\c&H30FFFF&" in dialogue[1] and r"\3c&H000000&" in dialogue[1] and r"\bord6" in dialogue[1] and r"\an8" in dialogue[1] and r"\marginv200" in dialogue[1]
    assert "\pos(270,1440)" in dialogue[2] and "\an" not in dialogue[2].split(",,")[-1]
    # 注入正文被转义：原始 {\pos(1,1)} 不出现在 Dialogue 正文（只允许我们的覆盖标签）。
    assert "{\pos(1,1)}注入" not in dialogue[3]
    assert "注入" in dialogue[3]
    # 预设 Style 行仍按预设生成（不受覆盖影响）。
    assert any("Style: default-bottom" in line for line in lines)


# ── 自由定位：时间空隙黑底填充与休眠转场 ─────────────────────────────────────


def _gapped_plan() -> dict:
    """两段视觉段：段 A [0, 4s)，段 B [6s, 9s)，中间 2s 空隙。

    段 B 在列表中排在前面，用于同时验证渲染图按 timeline_start_us 排序。
    """
    return {
        "segments": [
            {
                "clip_id": "right",
                "input_id": "I1",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 3_000_000,
                "timeline_start_us": 6_000_000,
                "timeline_end_us": 9_000_000,
                "layout": "fit",
                "audio_enabled": True,
                "gain_db": 0.0,
                "speed_milli": 1000,
                "transition_in": None,
            },
            {
                "clip_id": "left",
                "input_id": "I0",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 4_000_000,
                "timeline_start_us": 0,
                "timeline_end_us": 4_000_000,
                "layout": "fit",
                "audio_enabled": True,
                "gain_db": 0.0,
                "speed_milli": 1000,
                "transition_in": None,
            },
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }


def test_builder_inserts_black_filler_for_timeline_gaps() -> None:
    plan = _gapped_plan()
    paths = [Path("a.mp4"), Path("b.mp4")]
    probes = [{"audio_streams": [{}]}, {"audio_streams": [{}]}]
    args = build_timeline_args(plan, paths, probes, "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]

    # 空隙 → 追加一个 lavfi 黑底输入（2 个文件输入 + 1 个填充输入 = 3 个 -i）。
    assert args.count("-i") == 3
    # 填充色源带显式时长（d=2s），避免 concat 图 EOF 死锁。
    assert args.count("color=c=black:s=540x960:r=30:d=2.000000") == 1
    # 填充段按空隙时长裁剪（2s），且位于段 A 之后、段 B 之前。
    assert "trim=duration=2.000000,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v1]" in graph
    # 按时间排序后三段 concat（A → 填充 → B）。
    assert "concat=n=3:v=1:a=1" in graph
    # 排序正确：段 B（input 0）的链在段 A（input 1）之后出现。
    assert graph.index("[1:v:0]") < graph.index("[0:v:0]")


def test_builder_dormant_transition_across_gap_is_skipped() -> None:
    plan = _gapped_plan()
    # 锚点转场跨空隙：休眠，不参与渲染图。
    plan["segments"][1]["transition_in"] = {
        "transition_id": "t1",
        "kind": "fade",
        "duration_us": 500_000,
    }
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    assert "xfade" not in graph
    assert "concat=n=3:v=1:a=1" in graph


def test_builder_fills_leading_gap_before_first_segment() -> None:
    plan = _gapped_plan()
    # 首段改为 [1s, 5s)：1s 引导空隙 + 1s 段间空隙 → 2 个填充段。
    plan["segments"][1]["timeline_start_us"] = 1_000_000
    plan["segments"][1]["timeline_end_us"] = 5_000_000
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    # 两段填充（1s 引导 + 1s 段间）各带显式时长。
    assert args.count("color=c=black:s=540x960:r=30:d=1.000000") == 2
    assert "trim=duration=1.000000,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v0]" in graph
    assert "trim=duration=1.000000,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v2]" in graph
    assert "concat=n=4:v=1:a=1" in graph


def test_builder_skips_audio_segments_in_visual_graph() -> None:
    plan = _gapped_plan()
    audio_segment = {
        "clip_id": "a1clip",
        "input_id": "I2",
        "asset_kind": "audio",
        "source_start_us": 0,
        "source_end_us": 2_000_000,
        "timeline_start_us": 0,
        "timeline_end_us": 2_000_000,
        "layout": "fit",
        "audio_enabled": True,
        "gain_db": 0.0,
        "speed_milli": 1000,
        "transition_in": None,
    }
    plan["segments"].append(audio_segment)
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264",
        "out.mp4",
        captions=False,
    )
    graph = args[args.index("-filter_complex") + 1]
    # audio 段不参与视觉装配（视觉 concat 仍为 3 项：A → 填充 → B）。
    assert "concat=n=3:v=1:a=1" in graph
    assert "[2:v:0]" not in graph


def test_rendered_duration_accounts_for_gaps_and_dormant_transitions() -> None:
    from aivs_core.rendering.service import _rendered_duration_us

    plan = _gapped_plan()
    # 生效转场：首尾相接才扣减。
    assert _rendered_duration_us(plan["segments"]) == 9_000_000
    # 跨空隙的转场休眠：不减转场时长，总长按最大终点。
    plan["segments"][1]["transition_in"] = {
        "transition_id": "t1",
        "kind": "fade",
        "duration_us": 500_000,
    }
    assert _rendered_duration_us(plan["segments"]) == 9_000_000
    # 贴合后转场生效：总长 − 0.5s（段 A 改为 [2s, 6s)，与段 B [6s, 9s) 相接）。
    plan["segments"][1]["timeline_start_us"] = 2_000_000
    plan["segments"][1]["timeline_end_us"] = 6_000_000
    assert _rendered_duration_us(plan["segments"]) == 8_500_000
