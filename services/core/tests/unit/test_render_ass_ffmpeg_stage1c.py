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
    # P231 统一盒模型：非首段（c1/c2）走 overlay 链（各含一次 trunc），
    # 首段（c0）走 concat 基底（一次 trunc）——共 5 次（首段 concat + 2 层
    # overlay × 2 段各 1 次 + 1 次 blurred_background split 前置）。
    assert graph.count("trunc(iw*sar/2)*2") == 5
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


def test_builder_composes_pip_overlay_for_track_v2() -> None:
    """P1 画中画：V1 之上新增 V2 覆盖段，应生成 overlay 时间窗叠加且继承 transform。"""
    plan = {
        "segments": [
            {
                "clip_id": "main", "track_id": "V1", "asset_kind": "video",
                "source_start_us": 0, "source_end_us": 3_000_000,
                "timeline_start_us": 0, "timeline_end_us": 3_000_000,
                "layout": "crop_fill", "audio_enabled": False, "gain_db": 0.0,
            },
            {
                "clip_id": "pip", "track_id": "V2", "asset_kind": "video",
                "source_start_us": 0, "source_end_us": 1_000_000,
                "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
                "layout": "blurred_background", "audio_enabled": False, "gain_db": 0.0,
                "transform": {"x": 0.7, "y": 0.2, "scale": 0.4, "rotate": 15.0},
            },
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan,
                               [Path("main.mp4"), Path("pip.mp4")],
                               [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # P231 统一盒模型：首段（main，无 transform）直通 concat 基底；
    # 非首段（pip）走 overlay 链。基底 concat=n=2（含 A1 静音占位），
    # 或按实际 graph_items 数量（首段 + 黑填充）。
    assert "concat=n=" in graph
    # 统一 overlay 链：MAINPIP 起装（基底 → null → MAINPIP）。
    assert "[vcat]null[MAINPIP]" in graph
    # 覆盖段子句：源取帧 → PIP 缩放 → 旋转 → PTS 平移 → overlay 时间窗。
    assert "[1:v:0]" in graph
    assert "scale=216:384" in graph            # 540*0.4=216, 960*0.4=384
    assert "rotate='15.0000*PI/180'" in graph  # 度数语义：rotate 滤镜参数为弧度
    assert "setpts=PTS+0.500000" in graph
    assert "enable='between(t,0.500000,1.500000)'" in graph
    # overlay 复用 [MAINPIP] 作为输入与输出（多覆盖段可继续叠加）。
    # 坐标为中心点语义：x 左上角 = 0.7*540 − 216/2 = 270.0；y = 0.2*960 − 384/2 = 0.0。
    assert "overlay=x='270.0':y='0.0':" in graph
    assert "[MAINPIP][pip1a]overlay=" in graph
    assert "MAINPIP" in graph


def test_builder_composes_pip_overlay_with_reframe() -> None:
    """P1 回归：覆盖轨片段带 reframe（重构图）时应使用重构图裁切滤镜且构建不崩。

    历史上此分支引用了未定义变量 ref（NameError），任何带重构图快照的 PIP 片段
    都会让渲染任务崩溃；此处锁定修复。
    """
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "crop_fill", "audio_enabled": False, "gain_db": 0.0},
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
             "layout": "crop_fill", "audio_enabled": False, "gain_db": 0.0,
             "transform": {"x": 0.5, "y": 0.5, "scale": 0.5},
             "reframe": {"horizontal_anchor": "center", "vertical_anchor": "center",
                          "geometry_contract_version": 1, "crop_x": 0, "crop_y": 0}},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan,
                               [Path("main.mp4"), Path("pip.mp4")],
                               [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # PIP 分支使用重构图裁切（带偏移量的 crop），而不是普通 layout 滤镜。
    assert "crop=540:960:0:0" in graph
    assert "[MAINPIP][pip1a]overlay=" in graph


def test_builder_applies_static_transform_on_v1() -> None:
    """P1 扩展：V1 主轨片段带 transform 时，缩放 + 全幅黑底合成（中心点语义）。"""
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
             "transform": {"x": 0.3, "y": 0.2, "scale": 0.5}},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan, [Path("main.mp4")], [{"audio_streams": [{}]}],
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "scale=270:480:force_divisible_by=2" in graph      # 540*0.5 / 960*0.5
    assert "color=c=black:s=540x960:r=30" in graph            # 全幅黑底
    assert "overlay=x=27.0:y=-48.0" in graph                  # 0.3*540-135 / 0.2*960-240
    assert "format=yuv420p[" in graph
    # 无 transform 时保持原直通路径（无黑底合成）。
    plan["segments"][0].pop("transform")
    args2 = build_timeline_args(plan, [Path("main.mp4")], [{"audio_streams": [{}]}],
                                "libopenh264", "out.mp4", captions=False)
    graph2 = args2[args2.index("-filter_complex") + 1]
    assert "color=c=black:s=540x960" not in graph2


def test_builder_composes_pip_content_fit_box() -> None:
    """剪映式内容盒：fit 布局的覆盖轨元素 = 素材等比适配进画布的实际大小（无黑边）。"""
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 0, "timeline_end_us": 1_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    probes = [
        {"audio_streams": [{}]},
        {"audio_streams": [], "video_streams": [{"index": 0, "codec": "h264", "width": 1920, "height": 1080, "sample_aspect_ratio": "1:1"}]},
    ]
    args = build_timeline_args(plan, [Path("main.mp4"), Path("pip.mp4")], probes,
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # 内容盒：min(540/1920, 960/1080)=0.28125 → 内容 540×304（偶数取整）。
    assert "scale=540:304:force_original_aspect_ratio=decrease" in graph
    # 中心点叠放：x=0.5*540-540/2=0.0, y=0.5*960-304/2=328.0。
    assert "overlay=x='0.0':y='328.0'" in graph


def test_builder_composes_mask_alpha_for_track_v2(tmp_path: Path) -> None:
    """P2 蒙版：V2 覆盖段带椭圆蒙版时，graph 插入 rgba-geq alpha（v0.4 新链），
    overlay 消费蒙版后标签。旧 split+gray-geq+alphamerge 链在 alphamerge 处
    污染 RGB 平面（实测 RGB=alpha 灰度），已替换为单 geq（a= 表达式，RGB 通道
    恒等）。"""
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
             "transform": {"x": 0.5, "y": 0.5, "scale": 0.5},
             "mask": {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.8, "feather": 0.05}},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan,
                               [Path("main.mp4"), Path("pip.mp4")],
                               [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # rgba-geq：a 表达式 = 椭圆硬边式/feather（0.05 过渡窗口），RGB 通道恒等。
    assert "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a=" in graph
    assert ")/0.0500" in graph  # feather 过渡窗口
    assert "[pip1vis]setpts=PTS+0.500000" in graph
    # overlay 仍复用 [MAINPIP]（时间窗合成）。
    assert "[MAINPIP][pip1a]overlay=" in graph
    # 无蒙版时不应出现 geq（回归）。
    plan["segments"][1].pop("mask")
    args2 = build_timeline_args(plan, ["main.mp4", "pip.mp4"],
                                [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                                "libopenh264", "out.mp4", captions=False)
    graph2 = args2[args2.index("-filter_complex") + 1]
    assert "geq=" not in graph2


def test_builder_composes_chroma_keying_for_track_v2(tmp_path: Path) -> None:
    """P3 抠像：V2 覆盖段带绿幕 keying 时，graph 插入 rgba-geq 色距斜坡（v0.4 新链，
    实测标定 dist01 = RGB 欧氏/(255√3)），overlay 消费抠后标签。"""
    plan = {
        "segments": [
            {"clip_id": "main", "track_id": "V1", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 3_000_000,
             "timeline_start_us": 0, "timeline_end_us": 3_000_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0},
            {"clip_id": "pip", "track_id": "V2", "asset_kind": "video",
             "source_start_us": 0, "source_end_us": 1_000_000,
             "timeline_start_us": 500_000, "timeline_end_us": 1_500_000,
             "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
             "transform": {"x": 0.5, "y": 0.5, "scale": 0.5},
             "keying": {"color": "00FF00", "similarity": 0.4, "blend": 0.1}},
        ],
        "captions": {"items": []},
        "output": {"width": 540, "height": 960},
    }
    args = build_timeline_args(plan,
                               [Path("main.mp4"), Path("pip.mp4")],
                               [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                               "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    # 色距斜坡：dist01 - sim / blend × 255（255√3 = 441.67 归一常数）。
    assert "pow(g(X,Y)-255,2)" in graph
    assert "-0.4000)/0.1000*255" in graph
    assert "[pip1vis]setpts=PTS+0.500000" in graph
    assert "[MAINPIP][pip1a]overlay=" in graph

    # 蒙版 + 抠像组合：a 表达式 = mask × key（0..255 域乘积 /255）。
    plan["segments"][1]["mask"] = {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.6, "feather": 0.0}
    args2 = build_timeline_args(plan, ["main.mp4", "pip.mp4"],
                                [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                                "libopenh264", "out.mp4", captions=False)
    graph2 = args2[args2.index("-filter_complex") + 1]
    assert ")*(" in graph2  # mask × key 组合
    assert ")/255'" in graph2  # 0..255 域乘积归一
    # 无 keying 时不应出现色距表达式（回归；mask geq 仍在）。
    plan["segments"][1].pop("keying")
    args3 = build_timeline_args(plan, ["main.mp4", "pip.mp4"],
                              [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
                              "libopenh264", "out.mp4", captions=False)
    graph3 = args3[args3.index("-filter_complex") + 1]
    assert "pow(g(X,Y)-255,2)" not in graph3


def test_builder_rejects_reverse_segment_beyond_memory_budget() -> None:
    """C23 结项护栏：reverse 滤镜未压缩帧驻留（实测 60s 1080p ≈ 4.9GiB）。

    超预算倒放段显式失败（RENDER_REVERSE_TOO_LONG），不伪装成可完成的
    长任务；预算内（如 3s 540p）照常构建。
    """
    from aivs_core.projects import DomainError

    plan = _plan()
    plan["output"] = {"width": 1920, "height": 1080}
    plan["segments"] = [
        {
            "clip_id": "rev-long",
            "input_id": "I0",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 60_000_000,  # 60s @30fps = 1800 帧 ≈ 5.3GiB
            "timeline_start_us": 0,
            "timeline_end_us": 60_000_000,
            "layout": "fit",
            "audio_enabled": False,
            "gain_db": 0.0,
            "reverse_playback": True,
        },
    ]
    with pytest.raises(DomainError) as exc_info:
        build_timeline_args(
            plan, [Path("a.mp4")], [{"audio_streams": [{}]}],
            "libopenh264", "out.mp4", captions=False)
    assert exc_info.value.code == "RENDER_REVERSE_TOO_LONG"

    # 预算内（3s）：照常构建（既有行为不变）。
    plan["segments"][0]["clip_id"] = "rev-short"
    plan["segments"][0]["source_end_us"] = 3_000_000
    plan["segments"][0]["timeline_end_us"] = 3_000_000
    args = build_timeline_args(
        plan, [Path("a.mp4")], [{"audio_streams": [{}]}],
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "reverse" in graph


def test_builder_reverse_budget_ignores_hidden_track_and_forward_segments() -> None:
    """预算护栏只作用于可见视频倒放段；隐藏轨/正向段不受影响。"""
    plan = _plan()
    plan["output"] = {"width": 1920, "height": 1080}
    plan["segments"] = [
        {
            "clip_id": "hidden-rev",
            "input_id": "I0",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 600_000_000,
            "timeline_start_us": 0,
            "timeline_end_us": 10_000_000,
            "layout": "fit",
            "audio_enabled": False,
            "gain_db": 0.0,
            "reverse_playback": True,
            "track_hidden": True,
        },
        {
            "clip_id": "forward-long",
            "input_id": "I1",
            "asset_kind": "video",
            "source_start_us": 0,
            "source_end_us": 600_000_000,
            "timeline_start_us": 10_000_000,
            "timeline_end_us": 610_000_000,
            "layout": "fit",
            "audio_enabled": False,
            "gain_db": 0.0,
        },
    ]
    args = build_timeline_args(
        plan, [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264", "out.mp4", captions=False)
    assert "-filter_complex" in args


# ── A1 音频混音（M3-3 第一段）──────────────────────────────────────────────


def _a1_segment(clip_id: str, input_id: str, tl0: int, tl1: int, *, gain_db: float = 0.0,
                reverse: bool = False, speed_milli: int = 1000) -> dict:
    return {
        "clip_id": clip_id,
        "input_id": input_id,
        "asset_kind": "audio",
        "source_start_us": 0,
        "source_end_us": tl1 - tl0,
        "timeline_start_us": tl0,
        "timeline_end_us": tl1,
        "layout": "fit",
        "audio_enabled": True,
        "gain_db": gain_db,
        "speed_milli": speed_milli,
        "reverse_playback": reverse,
        "transition_in": None,
    }


def test_no_a1_graph_unchanged() -> None:
    """无 A1 段：[acat]anull[aout],图与旧版语义一致（回归锁）。"""
    plan = _gapped_plan()
    args = build_timeline_args(
        plan, [Path("a.mp4"), Path("b.mp4")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "concat=n=3:v=1:a=1[vcat][acat]" in graph
    assert "[acat]anull[aout]" in graph
    assert "amix" not in graph


def test_single_a1_segment_enters_mix() -> None:
    """单 A1 段：adelay 平移 + amix(inputs=2) 汇入 [aout],atrim 钉回视觉总长。"""
    plan = _gapped_plan()
    plan["segments"].append(_a1_segment("a1clip", "I2", 1_000_000, 3_000_000))
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("music.mp3")],
        [{"audio_streams": [{}]}, {"audio_streams": [{}]}, {"audio_streams": [{}]}],
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "amix=inputs=2:normalize=0:duration=longest[mixed]" in graph
    assert "[acat]anull[aout]" not in graph
    # A1 段从 timeline 1s 起 → adelay=1000;链尾 atrim 回视觉总长 9s。
    assert "adelay=1000:all=1[a1s0]" in graph
    assert "[mixed]atrim=duration=9.000000,asetpts=PTS-STARTPTS[aout]" in graph


def test_two_a1_segments_same_window() -> None:
    """两 A1 段同窗：amix inputs=3,各自 delay/增益独立。"""
    plan = _gapped_plan()
    plan["segments"].append(_a1_segment("a1a", "I2", 0, 4_000_000))
    plan["segments"].append(_a1_segment("a1b", "I3", 2_000_000, 6_000_000, gain_db=-6.0))
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("m1.mp3"), Path("m2.mp3")],
        [{"audio_streams": [{}]}] * 4,
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "amix=inputs=3:normalize=0:duration=longest[mixed]" in graph
    assert "adelay=0:all=1[a1s0]" in graph
    assert "adelay=2000:all=1[a1s1]" in graph
    assert "volume=-6.000dB" in graph


def test_a1_reverse_and_muted_silent_placeholder() -> None:
    """倒放 A1 段静音占位（amix 输入数稳定）;muted(solo 语义合并)不入图。"""
    plan = _gapped_plan()
    plan["segments"].append(_a1_segment("a1rev", "I2", 0, 2_000_000, reverse=True))
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp3")],
        [{"audio_streams": [{}]}] * 3,
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "amix=inputs=2:normalize=0:duration=longest[mixed]" in graph
    assert "anullsrc=channel_layout=stereo:sample_rate=48000" in graph
    assert "[2:a:0]" not in graph  # 倒放段不消费音频源

    # audio_enabled=False（mute/solo 已在 plan 合并）→ 段不入混音图。
    plan2 = _gapped_plan()
    muted = _a1_segment("a1m", "I2", 0, 2_000_000)
    muted["audio_enabled"] = False
    plan2["segments"].append(muted)
    args2 = build_timeline_args(
        plan2,
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp3")],
        [{"audio_streams": [{}]}] * 3,
        "libopenh264", "out.mp4", captions=False)
    graph2 = args2[args2.index("-filter_complex") + 1]
    assert "amix" not in graph2
    assert "[acat]anull[aout]" in graph2


def test_a1_speed_atempo_chain() -> None:
    """A1 段变速 0.5x:atempo 链进 A1 链。"""
    plan = _gapped_plan()
    plan["segments"].append(_a1_segment("a1slow", "I2", 0, 4_000_000, speed_milli=500))
    args = build_timeline_args(
        plan,
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp3")],
        [{"audio_streams": [{}]}] * 3,
        "libopenh264", "out.mp4", captions=False)
    graph = args[args.index("-filter_complex") + 1]
    assert "atempo=0.500000" in graph


# ── 气泡/花字渲染（B4 收官）────────────────────────────────────────────────

def _fx_caption(override: dict) -> dict:
    return {
        "start_us": 0, "end_us": 1_000_000, "text": "样式字幕",
        "preset_id": "default-bottom", "style_override": override,
    }


def test_bubble_derived_style_line_generated() -> None:
    """气泡 border_style=3 + back_color：派生 Style 行生成且 Dialogue 引用它。"""
    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, _ = resources.load()
    caption = _fx_caption({"border_style": 3, "back_color": "&H80202040", "shadow": 2})
    result = build_ass([caption], bundle, presets)
    # 派生 Style 行：名字含预设与覆盖参数,BorderStyle=3、BackColour=覆盖色。
    assert "Style: default-bottom__bs3__80202040__sh2," in result
    assert ",&H80202040," in result  # 派生行 BackColour 已覆盖
    # Dialogue 行以 \r 引用派生 Style(在其余标签之前)。
    assert r"{\rdefault-bottom__bs3__80202040__sh2" in result


def test_bubble_derived_style_deduplicated() -> None:
    """两条相同气泡覆盖 → 派生 Style 只生成一行(去重)。"""
    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, _ = resources.load()
    caption = _fx_caption({"border_style": 3, "back_color": "&H80202040"})
    result = build_ass([caption, {**caption, "start_us": 1_000_000, "end_us": 2_000_000}], bundle, presets)
    assert result.count("Style: default-bottom__bs3__80202040,") == 1


def test_fx_preset_tag_sequences() -> None:
    """花字模板:每个枚举展开固定标签序列;none 无标签。"""
    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, _ = resources.load()
    gold = build_ass([_fx_caption({"fx_preset": "gold-gradient"})], bundle, presets)
    assert r"{\c&H20C0FF&\3c&H402000&\bord6\blur1" in gold
    neon = build_ass([_fx_caption({"fx_preset": "neon-glow"})], bundle, presets)
    assert r"{\c&H00FFFF&\3c&H804000&\bord8\blur3\shad2" in neon
    sticker = build_ass([_fx_caption({"fx_preset": "sticker-outline"})], bundle, presets)
    assert r"{\c&HFFFFFF&\3c&H101010&\bord10\blur0\shad0" in sticker
    soft = build_ass([_fx_caption({"fx_preset": "soft-shadow"})], bundle, presets)
    assert r"{\c&HFFFFFF&\bord2\shad4\4a&H60000000&" in soft
    none = build_ass([_fx_caption({"fx_preset": "none"})], bundle, presets)
    assert "\bord10" not in none


def test_fx_with_position_keeps_order() -> None:
    """fx + 自定义坐标共存:\pos 在前(自定义坐标),fx 序列其后。"""
    resources = CaptionResources(Path("resources/fonts"))
    bundle, presets, _ = resources.load()
    caption = _fx_caption({"fx_preset": "gold-gradient", "pos_x": 0.5, "pos_y": 0.2})
    result = build_ass([caption], bundle, presets)
    line = next(l for l in result.splitlines() if l.startswith("Dialogue:") and "样式字幕" in l)
    pos_at = line.index(r"\pos(")
    fx_at = line.index(r"\c&H20C0FF&")
    assert pos_at < fx_at
