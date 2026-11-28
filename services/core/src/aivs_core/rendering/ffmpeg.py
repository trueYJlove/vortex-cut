from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..media.windows_job import WindowsKillJob
from ..performance import measured
from ..projects import DomainError
from .plan import ACTIVE_TRANSITION_RENDER_STATUS, OPENFILM_MOVE_PRESET_STATUS

# C23：单段倒放的 FFmpeg reverse 滤镜内存预算（字节）。实测 60s 1080p
# 段 RSS ≈ 4.9GiB（未压缩帧驻留）；预算取 2GiB——1080p 下约 22s 段长，
# 540p 预览下约 89s。超出即显式失败（RENDER_REVERSE_TOO_LONG）。
REVERSE_MEMORY_BUDGET_BYTES = 2 * (1 << 30)


def _transition_tail_us(segment: dict[str, Any]) -> int:
    """该段尾部被转场借用的时间（锚定于该段的转场）。"""
    transition = segment.get("transition_in")
    return int(transition["duration_us"]) if isinstance(transition, dict) else 0


def _transition_head_us(segments: list[dict[str, Any]], index: int) -> int:
    """该段头部被前一个转场借用的时间。"""
    if index == 0:
        return 0
    return _transition_tail_us(segments[index - 1])


def _effective_duration_us(segments: list[dict[str, Any]], index: int) -> int:
    total = segments[index]["timeline_end_us"] - segments[index]["timeline_start_us"]
    return total - _transition_tail_us(segments[index]) - _transition_head_us(segments, index)


def _lerp_expression(track: dict[str, Any], scalar: bool, time_var: str = "t") -> str:
    """B3：关键帧轨道 → 段内相对秒 t 的 FFmpeg 表达式（分段线性）。

    帧升序唯一（core 已校验）；窗口外取边界值。position 展开 x/y 两段，
    其余属性展开标量 v。time_var 默认 "t"；overlay 滤镜时间为全局 t，
    传入 "(t-start_s)" 可转换为段内相对时间。
    """
    frames = track["frames"]

    def channel(pick: str) -> str:
        if len(frames) == 1:
            return f"{frames[0][pick]:.6f}"

        def build(low: int, high: int) -> str:
            """递归构造 frames[low..high] 的分段 lerp（括号天然平衡）。"""
            if high - low == 1:
                t1 = frames[high]["t_us"] / 1_000_000
                v0 = frames[low][pick]
                v1 = frames[high][pick]
                span = t1 - frames[low]["t_us"] / 1_000_000
                lerp = f"({v0:.6f}+(({time_var}-{frames[low]['t_us'] / 1_000_000:.6f})*{v1 - v0:.6f}/{span:.6f}))"
                return f"if(lt({time_var},{t1:.6f}),{lerp},{v1:.6f})"
            mid = (low + high) // 2
            # 二分分段：左半管 [low, mid)，右半递归；不影响线性语义（嵌套 if 按 t 分派）。
            return f"if(lt({time_var},{frames[mid]['t_us'] / 1_000_000:.6f}),{build(low, mid)},{build(mid, high)})"

        return build(0, len(frames) - 1)

    if scalar:
        return channel("v")
    x_expr = channel("x")
    y_expr = channel("y")
    return x_expr, y_expr


def _base_segment_uses_overlay(
    segment: dict[str, Any],
    probe: dict[str, Any] | None,
    multi_track: bool,
    in_transition: bool,
) -> bool:
    """判断基底轨片段是否改为在 _pip_overlay_chain 单绘（避免与 [vcat] 双绘）。"""
    if in_transition:
        return False
    if (isinstance(segment.get("mask"), dict) and segment["mask"]) or (
        isinstance(segment.get("keying"), dict) and segment["keying"]
    ):
        return True
    if isinstance(segment.get("transform"), dict) and segment["transform"]:
        return multi_track or bool((probe or {}).get("video_streams"))
    return False


def _keyframe_animation_filters(
    segment: dict[str, Any], base_clause: str, base_label: str, out_label: str,
    width: int, height: int, black_input_index: int,
) -> list[str]:
    """在布局输出后叠加四属性动画变换（按需生成滤镜；无关键帧时直通）。

    base_clause 为不含输出标签的"源 trim → 视觉滤镜"链文本；黑底输入为
    预先追加的 lavfi -i color（black_input_index），供 opacity/position 使用。
    返回子句列表。
    """
    keyframes = segment.get("keyframes")
    clauses = [f"{base_clause}[{base_label}]"]
    if not keyframes:
        clauses.append(f"[{base_label}]null[{out_label}]")
        return clauses
    t_scale = _lerp_expression(keyframes["scale"], True) if "scale" in keyframes else None
    rotate_expr = _lerp_expression(keyframes["rotate"], True) if "rotate" in keyframes else None
    opacity_expr = _lerp_expression(keyframes["opacity"], True) if "opacity" in keyframes else None
    position = _lerp_expression(keyframes["position"], False) if "position" in keyframes else None
    step = 0
    current = base_label
    # FFmpeg 表达式内的逗号必须转义（\,），否则被当成滤镜参数分隔符。
    comma = "\\,"
    if t_scale is not None:
        step += 1
        scaled = f"ks{step}"
        clauses.append(
            f"[{current}]scale=w='iw*max({t_scale}{comma}0.05)':h='ih*max({t_scale}{comma}0.05)'"
            f":eval=frame[{scaled}]"
        )
        current = scaled
    if rotate_expr is not None:
        step += 1
        rotated = f"kr{step}"
        clauses.append(f"[{current}]rotate='{rotate_expr}*PI/180':c=black@0:ow=iw:oh=ih[{rotated}]")
        current = rotated
    if opacity_expr is not None:
        # 渲染能力约束（实测）：colorchannelmixer/geq 无时间表达式、blend
        # 表达式无 if()、fade 只能"当前值→0"或"0→当前值"。因此 opacity
        # 动画本期近似为：末值 < 首值 → 整段 fade out（至 0）；否则 →
        # 整段 fade in（从 0）。中间帧的复杂曲线为已知限制：模型保留完整
        # 帧列表，UI 数值仍按插值显示，渲染统一为线性整体渐变。
        frames = keyframes["opacity"]["frames"]
        clauses.append(f"[{current}]format=yuva420p[{current}y]")
        fade_target = f"ko{step}"
        clauses.append(
            f"[{current}y]fade=alpha=1:st=0.000000:d={_seconds(frames[-1]['t_us'])}[{fade_target}]"
        )
        current = fade_target
        _ = black_input_index  # opacity 不需要黑底输入
    if position is not None:
        x_expr, y_expr = position
        step += 1
        positioned = f"kp{step}"
        # 位置在预置黑底输入上合成（段内容浮于其上）。
        # shortest=1：黑底主输入时长为 timeline_total（远超本段），不终止输出会把
        # 段链撑到时间线总长（concat 超长、渲染校验失败），必须止于内容长度。
        clauses.append(
            f"[{black_input_index}:v][{current}]overlay=x='(W-w)/2+{x_expr}*(W/2)':y='(H-h)/2+{y_expr}*(H/2)':eval=frame:eof_action=repeat:shortest=1[{positioned}]"
        )
        current = positioned
    if current != base_label:
        # scale/rotate 动画会改变帧尺寸；concat 要求各段一致。归一化只缩不放
        # （min(iw,W)/min(ih,H)），否则小尺寸动画帧会被重新放大回满画布，
        # 抵消缩放动画；超出的部分按比例缩进，再 pad 居中。
        clauses.append(
            f"[{current}]scale=w='min(iw\\,{width})':h='min(ih\\,{height})'"
            f":force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black[{out_label}]"
        )
    return clauses


def build_timeline_args(
    plan: dict[str, Any],
    segment_paths: list[Path],
    segment_probes: list[dict[str, Any]],
    encoder: str,
    output_name: str,
    *,
    captions: bool,
    input_windows: list[Any] | None = None,
    quality: str = "standard",
) -> list[str]:
    """组装 FFmpeg 参数图。

    C21a：input_windows（rendering/input_window.plan_input_windows 的输出）
    非 None 时为**深定位图**——eligible 段的输入前插 -ss（准确 seek），
    其 visual_chain/atrim 的精裁坐标回移 seek 量（实证与旧图输出帧一致，
    见 test_render_input_window 的对拍）；legacy 段（None 窗口或不合格）
    保持旧参数。None = 完整旧图（测试 oracle 与回退路径）。
    quality（M2 第四梯队）：导出画质分层 standard|high|ultra——仅影响视频
    码率（×1.0/×1.5/×2.2），权威预览恒 standard。
    """
    segments = plan["segments"]
    if len(segments) != len(segment_paths) or len(segments) != len(segment_probes):
        raise DomainError("RENDER_PLAN_INVALID", "渲染输入数量不一致")
    for transition in plan.get("active_transitions", []):
        kind = transition.get("kind")
        status = ACTIVE_TRANSITION_RENDER_STATUS.get(kind, "open: unknown transition kind")
        if not status.startswith("supported"):
            presets = [
                transition.get("incoming_move_preset_id"),
                transition.get("outgoing_move_preset_id"),
            ]
            preset_text = ", ".join(item for item in presets if isinstance(item, str))
            detail = f" ({preset_text})" if preset_text else ""
            raise DomainError(
                "RENDER_PLAN_INVALID",
                f"active transition {kind}{detail} 未实现：{status}；拒绝静默降级",
            )
    for segment in segments:
        if segment.get("track_hidden"):
            continue
        for edge in ("move_in", "move_out"):
            move = segment.get(edge)
            if isinstance(move, dict):
                preset_id = str(move.get("preset_id") or "unknown")
                status = OPENFILM_MOVE_PRESET_STATUS.get(preset_id, "open: unknown preset")
                raise DomainError(
                    "RENDER_PLAN_INVALID",
                    f"segment {segment['clip_id']} {edge} preset {preset_id} 未实现：{status}；拒绝静默忽略",
                )
    # P231 统一盒模型：全部非音频非隐藏段都进入盒叠加（overlay 链），
    # 但时间轴 concat/xfade 基底只由最下层视觉轨的同轨时间链构成；
    # 跨轨同时段片段不再被串联播放。z 序 = track_index 降序
    # （下层先画、上层后画），与 IR layers 同一顺序。audio 段走 A1 混音。
    timeline_total_us = max(
        (int(segment["timeline_end_us"]) for segment in segments),
        default=0,
    )
    all_visual_items = [
        (index, segment)
        for index, segment in enumerate(segments)
        if (
            segment["asset_kind"] != "audio"
            and not segment.get("track_hidden", False)
        )
    ]
    visual_total_us = max(
        (int(segment["timeline_end_us"]) for _index, segment in all_visual_items),
        default=0,
    )
    # P231 修复：时间轴基底只走最下层视觉轨的同轨时间链；其它轨经下方
    # overlay 盒链按真实时间窗叠加。缺 track_index 的多轨计划回退 V1
    # （若无 V1 取排序首轨），单轨旧夹具保持逐字节兼容。
    has_track_index = any(int(segment.get("track_index", 0)) != 0 for _index, segment in all_visual_items)
    distinct_track_ids = {str(segment.get("track_id", "V1")) for _index, segment in all_visual_items}
    multi_track = has_track_index or len(distinct_track_ids) > 1
    if has_track_index:
        bottom_index = max(int(segment.get("track_index", 0)) for _index, segment in all_visual_items)
        visual_items = [item for item in all_visual_items if int(item[1].get("track_index", 0)) == bottom_index]
    elif len(distinct_track_ids) > 1:
        bottom_track_id = "V1" if "V1" in distinct_track_ids else sorted(distinct_track_ids)[0]
        visual_items = [item for item in all_visual_items if str(item[1].get("track_id", "V1")) == bottom_track_id]
    else:
        visual_items = list(all_visual_items)
    visual_items.sort(key=lambda item: int(item[1]["timeline_start_us"]))

    # 图项序列：黑底填充（kind=black）与视觉段（kind=segment）交错；段的
    # transition_in 仅在时间上与后继段首尾相接时生效（有空隙的转场休眠）。
    graph_items: list[dict[str, Any]] = []
    cursor_us = 0
    for position, (input_index, segment) in enumerate(visual_items):
        start_us = int(segment["timeline_start_us"])
        if start_us > cursor_us:
            graph_items.append({"kind": "black", "duration_us": start_us - cursor_us})
        active_transition = None
        transition = segment.get("transition_in")
        if isinstance(transition, dict) and position + 1 < len(visual_items):
            successor = visual_items[position + 1][1]
            # P231 Q5：与 IR 同口径——转场仅同轨邻接（首尾相接）。
            if (successor.get("track_id") == segment.get("track_id")
                    and int(successor["timeline_start_us"]) == int(segment["timeline_end_us"])):
                active_transition = transition
        graph_items.append(
            {
                "kind": "segment",
                "input_index": input_index,
                "segment": segment,
                "transition_in": active_transition,
            }
        )
        cursor_us = max(cursor_us, int(segment["timeline_end_us"]))
    if not graph_items and timeline_total_us > 0:
        # 无可见视觉段但时间线有内容（纯音频/全隐藏）：输出全程黑场
        # （音频保持各段静音占位）。
        graph_items.append({"kind": "black", "duration_us": timeline_total_us})

    base_overlay_indices: set[int] = set()
    for pos, gi in enumerate(graph_items):
        if gi["kind"] != "segment":
            continue
        in_trans = isinstance(gi.get("transition_in"), dict) or (
            pos > 0 and isinstance(graph_items[pos - 1].get("transition_in"), dict)
        )
        idx = gi["input_index"]
        if _base_segment_uses_overlay(gi["segment"], segment_probes[idx], multi_track, in_trans):
            base_overlay_indices.add(idx)

    # B3：position/opacity 动画需要一个黑底 lavfi 输入（blend/overlay 用）。
    needs_black_input = any(
        item["kind"] == "segment"
        and item["input_index"] not in base_overlay_indices
        and isinstance(item["segment"].get("keyframes"), dict)
        and ({"position", "opacity"} & set(item["segment"]["keyframes"]))
        for item in graph_items
    )
    black_input_index = len(segments) if needs_black_input else -1
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])
    # 帧率档（导出可选 24/25/30/60；预览恒 30）：plan["output"] 是唯一来源，
    # 合成时间域（图片循环/黑底 lavfi/倒放预算/-r）全部随它走。
    fps = max(1, int(plan["output"].get("fps_num") or 30) // max(1, int(plan["output"].get("fps_den") or 1)))
    # C23 结项护栏：reverse 滤镜在单段全部解码帧驻留内存（实测 60s 1080p
    # ≈ 4.9GiB——FFmpeg 滤镜缓存未压缩帧）。超出预算的倒放段显式失败
    # （RENDER_REVERSE_TOO_LONG），不伪装成可完成的长任务；分块倒放
    # （C23 实验项）未实施，见 docs/specs/preview-and-rendering.md §4.2。
    for segment in segments:
        if (
            segment["asset_kind"] == "video"
            and segment.get("reverse_playback")
            and not segment.get("track_hidden", False)
        ):
            source_us = max(int(segment["source_end_us"]) - int(segment["source_start_us"]), 0)
            frames = source_us / 1_000_000 * fps
            est_bytes = frames * width * height * 1.5  # yuv420p 未压缩帧
            if est_bytes > REVERSE_MEMORY_BUDGET_BYTES:
                raise DomainError(
                    "RENDER_REVERSE_TOO_LONG",
                    f"段 {segment['clip_id']}: 倒放段超出内存预算"
                    f"（{est_bytes / (1 << 30):.1f}GiB > 预算），请缩短片段或拆分倒放",
                )
    args = ["-hide_banner", "-nostdin", "-y"]
    for position, (segment, path) in enumerate(zip(segments, segment_paths, strict=True)):
        # Video-backed audio clips each get an independent audio-role input.
        # Disable video at that input so FFmpeg never submits visual frames to
        # a decoder; a separate visual-role segment keeps its normal input/map.
        if segment.get("asset_kind") == "audio" and segment.get("source_asset_kind") == "video":
            args.append("-vn")
        # C21a：深定位图——eligible 输入前插 -ss（-i 前为准确 seek）；
        # legacy 输入零改动。图像输入不定位（loop 无 seek 语义）。
        if segment["asset_kind"] == "image":
            args += ["-loop", "1", "-framerate", str(fps)]
        else:
            window = input_windows[position] if input_windows is not None and position < len(input_windows) else None
            if window is not None and getattr(window, "eligible", False):
                args += ["-ss", _seconds(int(window.seek_us))]
        args += ["-i", str(path)]
    next_input_index = len(segments)
    if needs_black_input:
        # 与黑底填充段一致：给无限 color 源显式时长，避免 concat 图 EOF 死锁。
        black_duration = _seconds(max(timeline_total_us, 1))
        args += [
            "-f", "lavfi", "-i",
            f"color=c=black:s={width}x{height}:r={fps}:d={black_duration}",
        ]
        next_input_index += 1
    for item in graph_items:
        if item["kind"] == "black":
            item["input_index"] = next_input_index
            next_input_index += 1
            # color 源默认无限持续，concat 在部分 ffmpeg 构建下会因 EOF 异常
            # 死锁；显式 d= 时长让该输入在填充段结束时正常 EOF。
            fill_duration = _seconds(item["duration_us"])
            args += [
                "-f", "lavfi", "-i",
                f"color=c=black:s={width}x{height}:r={fps}:d={fill_duration}",
            ]

    filters: list[str] = []
    concat_inputs = []
    label_seq = [0]

    def visual_chain(
        segment: dict[str, Any], input_index: int, out_label: str,
        *, window_us: tuple[int, int] | None = None,
        black_input_index: int | None = None,
        seek_shift_us: int = 0,
    ) -> list[str]:
        """一段的"源 trim（可选取窗）→ 视觉滤镜 → 关键帧动画"链。

        window_us 为时间线窗口 (head_us, tail_us)；seek_shift_us 为 C21a
        深定位的坐标回移量（输入 -ss 已前移源起点——trim 的绝对源坐标
        必须减去该量才是 -ss 后流上的相对坐标；0 = 旧图不变）。返回
        子句列表（动画叠加可能产生多条，含 color 源与 overlay），以
        分号连接后追加到图。
        """
        label_seq[0] += 1
        label_id = label_seq[0]  # blurred_background 中间标签唯一化
        speed_milli = int(segment.get("speed_milli", 1000))
        speed = speed_milli / 1000
        reverse = bool(segment.get("reverse_playback", False))
        duration_us = segment["timeline_end_us"] - segment["timeline_start_us"]
        duration = _seconds(duration_us)
        if segment["asset_kind"] == "video":
            head_us, tail_us = window_us if window_us is not None else (0, 0)
            # C21a：精裁坐标回移——源绝对坐标减 seek 偏移（-ss 后流上的
            # 相对坐标；0 时与旧图逐字符一致）。
            start = _seconds(max(int(segment["source_start_us"]) + round(head_us * speed_milli / 1000) - seek_shift_us, 0))
            end = _seconds(max(int(segment["source_end_us"]) - round(tail_us * speed_milli / 1000) - seek_shift_us, 0))
            source = f"[{input_index}:v:0]trim=start={start}:end={end},setpts=PTS-STARTPTS"
            if reverse:
                # 倒放：先反转帧序列；setpts 重置为从 0 起始的时间戳。
                source += ",reverse,setpts=PTS-STARTPTS"
            if speed != 1.0:
                # 变速：PTS 除以速度倍率（>1 加速）。
                source += f",setpts=PTS/{speed:.6f}"
        else:
            source = f"[{input_index}:v:0]trim=duration={duration},setpts=PTS-STARTPTS"
        reframe = segment.get("reframe")
        visual = (
            _reframe_crop_filter(width, height, reframe["crop_x"], reframe["crop_y"])
            if isinstance(reframe, dict)
            else _visual_filter(segment["layout"], width, height, label_id)
        )
        base = f"{source},{_square_pixel_filter()},{visual},setsar=1,fps={fps},format=yuv420p"
        # P1 扩展：静态画面变换（transform，中心点语义）对主轨（V1）与所有视觉
        # 片段生效——缩放至目标尺寸（可选旋转）后叠到全幅黑底；透明度 <1 时走
        # rgba + colorchannelmixer。变换先后：关键帧动画在前，静态变换在后
        # （关键帧末尾已归一化回全幅）。无变换时直通原关键帧路径。
        transform = segment.get("transform")
        if isinstance(transform, dict) and transform:
            cx = min(max(float(transform.get("x", 0.5)), 0.0), 1.0)
            cy = min(max(float(transform.get("y", 0.5)), 0.0), 1.0)
            scale_val = min(max(float(transform.get("scale", 1.0)), 0.05), 5.0)
            rotate_val = float(transform.get("rotate", 0.0))
            opacity = min(max(float(transform.get("opacity", 1.0)), 0.0), 1.0)
            if (
                abs(scale_val - 1.0) > 1e-9
                or abs(cx - 0.5) > 1e-9
                or abs(cy - 0.5) > 1e-9
                or abs(rotate_val) > 1e-9
                or opacity < 1.0
            ):
                pip_w = max(2, int(round(width * scale_val / 2) * 2))
                pip_h = max(2, int(round(height * scale_val / 2) * 2))
                needs_alpha = abs(rotate_val) > 1e-9 or opacity < 1.0
                window_len_us = duration_us if window_us is None else duration_us - int(window_us[0]) - int(window_us[1])
                bg_duration = max(window_len_us / 1_000_000, 0.04)
                clauses = _keyframe_animation_filters(
                    segment, base, f"vbase{label_id}", f"vkf{label_id}",
                    width, height,
                    black_input_index if black_input_index is not None else -1,
                )
                static = f"[vkf{label_id}]"
                if needs_alpha:
                    static += "format=rgba,"
                static += f"scale={pip_w}:{pip_h}:force_divisible_by=2"
                if abs(rotate_val) > 1e-9:
                    # 度数语义（contracts -180..180°）→ rotate 滤镜弧度参数，与关键帧 rotate 路径一致
                    static += f",rotate='{rotate_val:.4f}*PI/180':fillcolor=black@0:ow=iw:oh=ih"
                if opacity < 1.0:
                    static += f",colorchannelmixer=aa={opacity:.3f}"
                static += f"[vpre{label_id}]"
                clauses.append(static)
                clauses.append(
                    f"color=c=black:s={width}x{height}:r={fps}:d={bg_duration:.6f},setsar=1[ppbg{label_id}]"
                )
                clauses.append(
                    f"[ppbg{label_id}][vpre{label_id}]overlay=x={cx * width - pip_w / 2:.1f}"
                    f":y={cy * height - pip_h / 2:.1f},format=yuv420p[{out_label}]"
                )
                if window_us is None:
                    clauses = _picture_fade_clauses(clauses, segment, duration_us, out_label)
                return clauses
        clauses = _keyframe_animation_filters(
            segment, base, f"vbase{label_id}", out_label, width, height,
            black_input_index if black_input_index is not None else -1,
        )
        if window_us is None:
            clauses = _picture_fade_clauses(clauses, segment, duration_us, out_label)
        return clauses

    for position, item in enumerate(graph_items):
        if item["kind"] == "black":
            # 黑底填充段（时间线空隙）：lavfi color 输入裁出空隙时长。
            fill_duration = _seconds(item["duration_us"])
            filters.append(
                f"[{item['input_index']}:v]trim=duration={fill_duration},"
                f"setpts=PTS-STARTPTS,fps={fps},format=yuv420p"
                f"[v{position}]"
            )
            filters.append(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={fill_duration},asetpts=PTS-STARTPTS[a{position}]"
            )
            concat_inputs.append(f"[v{position}][a{position}]")
            continue
        segment = item["segment"]
        probe = segment_probes[item["input_index"]]
        duration_us = segment["timeline_end_us"] - segment["timeline_start_us"]
        duration = _seconds(duration_us)
        speed_milli = int(segment.get("speed_milli", 1000))
        speed = speed_milli / 1000
        reverse = bool(segment.get("reverse_playback", False))
        # C21a：本段输入的深定位窗口（eligible → -ss 已前移，精裁坐标回移）。
        window = (input_windows[item["input_index"]]
                  if input_windows is not None and item["input_index"] < len(input_windows)
                  else None)
        seek_shift_us = int(window.shift_us) if window is not None and getattr(window, "eligible", False) else 0
        # 转场模式下，被 xfade 旁路的段的视频链在转场分支独立构建（其 [vN] 会悬空）。
        is_transition_right = position > 0 and isinstance(
            graph_items[position - 1].get("transition_in"), dict
        )
        if not is_transition_right:
            if item["input_index"] in base_overlay_indices:
                filters.append(
                    f"color=c=black:s={width}x{height}:r={fps}:d={duration},"
                    f"setsar=1,fps={fps},format=yuv420p[v{position}]"
                )
            else:
                filters.extend(
                    visual_chain(
                        segment, item["input_index"], f"v{position}",
                        black_input_index=black_input_index,
                        seek_shift_us=seek_shift_us,
                    )
                )
        has_audio = bool(probe.get("audio_streams"))
        if (
            segment["asset_kind"] == "video"
            and has_audio
            and segment["audio_enabled"]
            and not reverse
        ):
            # C21a：音频精裁坐标与视频同一窗口回移（实证对拍：A/V 偏差不变）。
            start = _seconds(max(int(segment["source_start_us"]) - seek_shift_us, 0))
            end = _seconds(max(int(segment["source_end_us"]) - seek_shift_us, 0))
            gain = float(segment["gain_db"])
            tempo_chain = ""
            if speed != 1.0:
                # atempo 单级支持 0.5-2.0；跨级拆分（如 0.25 → 0.5×0.5，4x → 2×2）。
                factors: list[float] = []
                remaining = speed
                while remaining > 2.0:
                    factors.append(2.0)
                    remaining /= 2.0
                while remaining < 0.5:
                    factors.append(0.5)
                    remaining /= 0.5
                factors.append(remaining)
                tempo_chain = ",".join(f"atempo={factor:.6f}" for factor in factors) + ","
            filters.append(
                f"[{item['input_index']}:a:0]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
                "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"{tempo_chain}volume={gain:.3f}dB{_fade_chain(segment, duration_us)},"
                f"apad,atrim=duration={duration}[a{position}]"
            )
        elif segment["asset_kind"] == "video" and has_audio and segment["audio_enabled"]:
            # 倒放片段的音频暂不支持：以静音占位，保证轨长与混流正确。
            filters.append(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={duration},asetpts=PTS-STARTPTS[a{position}]"
            )
        else:
            filters.append(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={duration},asetpts=PTS-STARTPTS[a{position}]"
            )
        concat_inputs.append(f"[v{position}][a{position}]")
    has_active_transitions = any(
        item["kind"] == "segment" and isinstance(item.get("transition_in"), dict)
        for item in graph_items
    )

    def _item_span_us(item: dict[str, Any]) -> int:
        if item["kind"] == "black":
            return int(item["duration_us"])
        segment = item["segment"]
        return int(segment["timeline_end_us"]) - int(segment["timeline_start_us"])

    base_borrow_us = sum(
        int(item["transition_in"]["duration_us"])
        for item in graph_items
        if item["kind"] == "segment" and isinstance(item.get("transition_in"), dict)
    )
    if not has_active_transitions:
        filters.append(f"{''.join(concat_inputs)}concat=n={len(graph_items)}:v=1:a=1[vcat][acat]")
        base_video_us = sum(_item_span_us(item) for item in graph_items)
    else:
        # B2 借用式重叠（实测 FFmpeg xfade 语义：输出在 offset+duration 处结束，
        # 右输入对齐到 offset 且超出 duration 的部分被丢弃）。因此：
        # - 右段拆两路：头部借用区（恰 T 秒）进 xfade，剩余主体 concat 接回；
        # - FFmpeg 图中输出标签只能消费一次，故两路各自从输入流独立重走
        #   "源 trim → 视觉滤镜" 链（visual_chain），不引用 [vN]；
        # - xfade 的 offset = 当前累积输出长度 − T；输出长度保持 = 累积长度；
        # - 音频用 acrossfade（overlap 语义，输出 = 左 + 右 − T），无需拆分。
        # 从左到右逐项合并：普通相邻项 concat，锚点项与后继之间 xfade；
        # 最终视频长度 = 时间线总长（含空隙填充）− ΣT，与 _rendered_duration_us 一致。
        video_label_prev = "v0"
        audio_label_prev = "a0"
        accumulated_us = _item_span_us(graph_items[0])
        for position in range(1, len(graph_items)):
            item = graph_items[position]
            previous = graph_items[position - 1]
            step = position
            if previous["kind"] == "segment" and isinstance(previous.get("transition_in"), dict):
                transition = previous["transition_in"]
                duration_us = int(transition["duration_us"])
                duration = duration_us / 1_000_000
                offset_us = accumulated_us - duration_us
                if offset_us <= 0:
                    raise DomainError("RENDER_PLAN_INVALID", "转场区间超出相邻片段有效时长")
                if item["kind"] != "segment":
                    raise DomainError("RENDER_PLAN_INVALID", "转场后继片段缺失")
                right_segment = item["segment"]
                # 右段头借用 = 本转场 T；剩余主体避开头部借用与其自身尾部借用。
                head_us = duration_us
                next_tail_us = (
                    int(item["transition_in"]["duration_us"])
                    if isinstance(item.get("transition_in"), dict)
                    else 0
                )
                right_total_us = _item_span_us(item)
                # C21b：右段深定位窗口取右段自己的（左锚点段的 seek_shift
                # 只对其自身 trim 生效——stale shift 会把右段坐标错移）。
                right_window = (
                    input_windows[item["input_index"]]
                    if input_windows is not None and item["input_index"] < len(input_windows)
                    else None
                )
                right_shift_us = (
                    int(right_window.shift_us)
                    if right_window is not None and getattr(right_window, "eligible", False)
                    else 0
                )
                filters.extend(
                    visual_chain(
                        right_segment, item["input_index"], f"vh{step}",
                        window_us=(0, right_total_us - head_us - next_tail_us),
                        black_input_index=black_input_index,
                        seek_shift_us=right_shift_us,
                    )
                )
                filters.extend(
                    visual_chain(
                        right_segment, item["input_index"], f"vr{step}",
                        window_us=(head_us, next_tail_us),
                        black_input_index=black_input_index,
                        seek_shift_us=right_shift_us,
                    )
                )
                filters.append(
                    f"[{video_label_prev}][vh{step}]"
                    f"xfade=transition={transition['kind']}:duration={duration:.6f}"
                    f":offset={offset_us / 1_000_000:.6f}[vx{step}]"
                )
                filters.append(f"[vx{step}][vr{step}]concat=n=2:v=1:a=0[vx{step}f]")
                filters.append(
                    f"[{audio_label_prev}][a{position}]"
                    f"acrossfade=duration={duration:.6f}:curve1=tri:curve2=tri[ax{step}]"
                )
                video_label_prev = f"vx{step}f"
                audio_label_prev = f"ax{step}"
                # 累积输出 = 已消耗段全长 − 已发生转场区间（concat 剩余主体后自动成立）。
                accumulated_us = right_total_us + (accumulated_us - duration_us)
            else:
                filters.append(
                    f"[{video_label_prev}][v{position}]concat=n=2:v=1:a=0[vx{step}]"
                )
                filters.append(
                    f"[{audio_label_prev}][a{position}]concat=n=2:v=0:a=1[ax{step}]"
                )
                video_label_prev = f"vx{step}"
                audio_label_prev = f"ax{step}"
                accumulated_us += _item_span_us(item)
        filters.append(f"[{video_label_prev}]null[vcat];[{audio_label_prev}]anull[acat]")
        base_video_us = accumulated_us

    target_visual_us = max(base_video_us, visual_total_us - base_borrow_us)
    # P231 统一盒模型：所有可见视觉段按**轨道序**（下层先画、上层后画）
    # 逐层叠加到时间序基底上——上层轨道盖下层（剪映/OpenFilm 同语义）。
    overlay_segments = [
        (index, segment)
        for index, segment in enumerate(segments)
        if (
            segment["asset_kind"] != "audio"
            and not segment.get("track_hidden", False)
        )
    ]
    # P231 修复：与 IR layers 同一 z 序——track_index 降序（下层先画、
    # 上层后画），缺 track_index 时 V1 排最下层，同轨按时间排序。
    overlay_segments.sort(
        key=lambda item: (
            -int(item[1].get("track_index", 0)),
            0 if (not has_track_index and str(item[1].get("track_id", "V1")) == "V1") else 1,
            int(item[1]["timeline_start_us"]),
        )
    )
    base_index_set = {index for index, _segment in visual_items}
    if multi_track:
        overlay_segments = [
            (index, segment) for index, segment in overlay_segments
            if index not in base_index_set or index in base_overlay_indices
        ]
    else:
        overlay_segments = [
            (index, segment) for index, segment in overlay_segments
            if not (
                index in base_index_set
                and index not in base_overlay_indices
                and isinstance(segment.get("transform"), dict)
            )
        ]
    needs_tail_extend = bool(overlay_segments) and target_visual_us > base_video_us

    # A1 音频混音（M3-3 第一段）：纯音频段（asset_kind=audio）此前被整图
    # 跳过——预览侧 syncAudio 对 A1 出声而导出无声（预览≠导出）。各 A1 段
    # 构造与视觉段同构的音频链（atrim/aresample/atempo/volume；倒放段
    # 静音占位），adelay 平移到时间线起点后与基底混音轨 amix（normalize=0
    # 直接相加——与预览 WebAudio 多 rig 并存的 sum 语义同构；削波由素材级
    # gain_db 控制）。混音结果 atrim 回视觉轨总长：成片时长口径 =
    # _rendered_duration_us（validation ±83ms 硬门），音频尾超出部分裁掉
    # （与预览"音频长于画面以黑场延长"显示不冲突——导出容器时长必须钉死）。
    # 无 A1 段时 [acat]anull[aout]，图与旧版逐字节一致。
    a1_segments = [
        (index, segment)
        for index, segment in enumerate(segments)
        if segment["asset_kind"] == "audio" and segment["audio_enabled"]
    ]
    if a1_segments:
        mix_inputs = ["[acat]"]
        for mix_index, (index, segment) in enumerate(a1_segments):
            probe = segment_probes[index]
            start = _seconds(max(int(segment["source_start_us"]), 0))
            end = _seconds(max(int(segment["source_end_us"]), 0))
            gain = float(segment["gain_db"])
            speed_milli = int(segment.get("speed_milli", 1000))
            speed = speed_milli / 1000
            tempo_chain = ""
            if speed != 1.0:
                factors: list[float] = []
                remaining = speed
                while remaining > 2.0:
                    factors.append(2.0)
                    remaining /= 2.0
                while remaining < 0.5:
                    factors.append(0.5)
                    remaining /= 0.5
                factors.append(remaining)
                tempo_chain = ",".join(f"atempo={factor:.6f}" for factor in factors) + ","
            delay_ms = int(segment["timeline_start_us"]) // 1000
            a1_duration_us = int(segment["timeline_end_us"]) - int(segment["timeline_start_us"])
            if segment.get("reverse_playback") or not probe.get("audio_streams"):
                # 倒放/无音轨：静音占位（保证 amix 输入数稳定）。
                filters.append(
                    "anullsrc=channel_layout=stereo:sample_rate=48000,"
                    f"atrim=duration={_seconds(a1_duration_us)},"
                    f"asetpts=PTS-STARTPTS[a1s{mix_index}]"
                )
            else:
                # 淡入/淡出插在 volume 之后、apad 之前：afade 的 st/d 以本段
                # 时间轴为准，apad 补长与 atrim 钉死都不改变已成的包络。
                filters.append(
                    f"[{index}:a:0]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
                    "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"{tempo_chain}volume={gain:.3f}dB{_fade_chain(segment, a1_duration_us)},"
                    f"apad,atrim=duration={_seconds(a1_duration_us)},"
                    f"adelay={delay_ms}:all=1[a1s{mix_index}]"
                )
            mix_inputs.append(f"[a1s{mix_index}]")
        filters.append(
            f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:normalize=0:duration=longest[mixed]"
        )
        filters.append(f"[mixed]atrim=duration={_seconds(timeline_total_us)},asetpts=PTS-STARTPTS[aout]")
    elif needs_tail_extend:
        filters.append(
            f"[acat]apad,atrim=duration={_seconds(target_visual_us)},asetpts=PTS-STARTPTS[aout]"
        )
    else:
        filters.append("[acat]anull[aout]")
    video_label = "vcat"
    if overlay_segments:
        main_label = "MAINPIP"
        if needs_tail_extend:
            filters.append(
                f"color=c=black:s={width}x{height}:r={fps}:d={_seconds(target_visual_us)},"
                f"setsar=1,format=yuv420p[tailbg]"
            )
            filters.append(f"[tailbg][vcat]overlay=eof_action=pass:format=auto[{main_label}]")
        else:
            filters.append(f"[vcat]null[{main_label}]")
        first_visual_clip = graph_items[0]["segment"]["clip_id"] if graph_items and graph_items[0]["kind"] == "segment" else None
        for index, segment in overlay_segments:
            # 首段（时间序首段）无 transform/mask/keying → 已在 concat 基底
            # 中绘制，跳过 overlay 链（避免画两遍）。
            is_first_plain = (
                segment["clip_id"] == first_visual_clip
                and not isinstance(segment.get("transform"), dict)
                and not isinstance(segment.get("mask"), dict)
                and not isinstance(segment.get("keying"), dict)
            )
            if is_first_plain:
                continue
            pip_window = (
                input_windows[index]
                if input_windows is not None and index < len(input_windows)
                else None
            )
            filters.extend(
                _pip_overlay_chain(
                    segment,
                    index,
                    width,
                    height,
                    probe=segment_probes[index],
                    enable_start_us=segment["timeline_start_us"],
                    enable_end_us=segment["timeline_end_us"],
                    main_label=main_label,
                    seek_shift_us=(
                        int(pip_window.shift_us)
                        if pip_window is not None and getattr(pip_window, "eligible", False)
                        else 0
                    ),
                )
            )
        video_label = main_label
    if captions:
        filters.append(f"[{video_label}]ass=filename=captions.ass:fontsdir=fonts[vout]")
        video_label = "vout"
    args += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        f"[{video_label}]",
        "-map",
        "[aout]",
        "-c:v",
        encoder,
    ]
    # 码率 = 分辨率基线 × 画质系数（standard=×1 high=×1.5 ultra=×2.2）。
    # 基线按短边面积缩放（1080p 锚点：软件 10M / 硬件 12M；540p 预览
    # 落回旧基线 3M/4M）——分辨率档解耦后不再用 width==540 硬编码分档。
    short_edge = min(width, height)
    multiplier = {"high": 1.5, "ultra": 2.2}.get(quality, 1.0)
    if encoder == "libopenh264":
        base = max(3, round(10 * (short_edge / 1080) ** 2))
        args += ["-b:v", f"{base * multiplier:g}M"]
    elif encoder in {"h264_nvenc", "h264_qsv", "h264_amf"}:
        base = max(4, round(12 * (short_edge / 1080) ** 2))
        args += ["-b:v", f"{base * multiplier:g}M"]
    args += [
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(fps),
        "-fps_mode",
        "cfr",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        output_name,
    ]
    return args


def _visual_filter(layout: str, width: int, height: int, index: int) -> str:
    # index 仅用于中间标签唯一化：转场分支会对同一输入建多个取窗链，
    # 由调用方保证传入的 id 互不重复。
    tag = str(index)
    if layout == "crop_fill":
        return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
    if layout == "fit":
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:"
            "force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    if layout == "blurred_background":
        return (
            f"split=2[bg{tag}][fg{tag}];"
            f"[bg{tag}]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=20[blur{tag}];"
            f"[fg{tag}]scale={width}:{height}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2[front{tag}];"
            f"[blur{tag}][front{tag}]overlay=(W-w)/2:(H-h)/2"
        )
    raise DomainError("RENDER_PLAN_INVALID", "不支持的布局")


def _reframe_crop_filter(width: int, height: int, crop_x: int, crop_y: int) -> str:
    values = (width, height, crop_x, crop_y)
    if (
        any(not isinstance(value, int) for value in values)
        or width <= 0
        or height <= 0
        or crop_x < 0
        or crop_y < 0
        or any(value % 2 for value in values)
    ):
        raise DomainError("RENDER_PLAN_INVALID", "重构图裁切几何不合法")
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2,"
        f"crop={width}:{height}:{crop_x}:{crop_y}"
    )


def _square_pixel_filter() -> str:
    return "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1"


def _mask_alpha_expr(mask, pw, ph):
    """把线性/矩形/椭圆蒙版转成 FFmpeg geq 的 alpha 表达式（值 0..255）。

    匹配 apply 到 pip 尺寸 pw x ph 的帧（X,Y 为该帧坐标）。几何项归一化 0..1；
    rotation 角度制；invert 为真则保留外部（alpha 反转）。返回供 `a='...'` 使用。

    feather 语义（v0.4 增补，双端同式——effects.ts / 合成器 shader 镜像）：
    - linear：feather·pw = 软边过渡带宽（分界线两侧线性）；
    - ellipse/rect：alpha 在归一化距离（d / norm）∈ [1−feather, 1] 线性从 1
      降到 0，过渡带**收进形状边界内侧**（边界处 alpha=0，不外溢）；
      feather=0 → **真硬边**（形状内 255、形状外 0，一步跳变）；feather=1
      最柔（渐变铺满形状半径）。像素过渡带宽 = feather×轴长/半宽（随形状
      尺寸成比例）。
    """
    if not isinstance(mask, dict):
        return None
    kind = mask.get("kind")
    if kind not in ("linear", "rect", "ellipse"):
        return None
    cx = _mask_num(mask, "x", 0.5) * pw
    cy = _mask_num(mask, "y", 0.5) * ph
    feather = max(0.0, min(1.0, _mask_num(mask, "feather", 0.0)))
    import math as _m
    rot = _mask_num(mask, "rotation", 0.0) * _m.pi / 180.0
    cs = f"{_m.cos(rot):.4f}"
    sn = f"{_m.sin(rot):.4f}"
    invert = bool(mask.get("invert"))
    if kind == "ellipse":
        ax = max(1.0, _mask_num(mask, "width", 0.5) * pw / 2.0)
        ay = max(1.0, _mask_num(mask, "height", 0.5) * ph / 2.0)
        ux = f"{cs}*(X-{cx:.1f})+{sn}*(Y-{cy:.1f})"
        uy = f"-{sn}*(X-{cx:.1f})+{cs}*(Y-{cy:.1f})"
        d = f"sqrt(pow({ux},2)/pow({ax:.1f},2)+pow({uy},2)/pow({ay:.1f},2))"
        if feather > 0.0:
            inside = f"min(255,max(0,255*min(1,(1-({d}))/{feather:.4f})))"
        else:
            # 本 build 的 ffmpeg 表达式无 le/ge（实测 n8.0）；硬边用 if(lt(d,1))——
            # 边界 d=1 归形状外（与 effects.ts 的 d<1 严格口径一致）。
            inside = f"if(lt({d},1),255,0)"
    elif kind == "rect":
        hal_w = max(1.0, _mask_num(mask, "width", 0.5) * pw / 2.0)
        hal_h = max(1.0, _mask_num(mask, "height", 0.5) * ph / 2.0)
        ux = f"{cs}*(X-{cx:.1f})+{sn}*(Y-{cy:.1f})"
        uy = f"-{sn}*(X-{cx:.1f})+{cs}*(Y-{cy:.1f})"
        norm = f"max(abs({ux})/{hal_w:.1f},abs({uy})/{hal_h:.1f})"
        if feather > 0.0:
            inside = f"min(255,max(0,255*min(1,(1-min(1,{norm}))/{feather:.4f})))"
        else:
            inside = f"if(lt(min(1,{norm}),1),255,0)"
    else:  # linear 硬边分界
        ux = f"{cs}*(X-{cx:.1f})+{sn}*(Y-{cy:.1f})"
        inside = f"min(255,max(0,255*(0.5+({ux})/{max(1.0, feather*pw):.2f})))"
    expr = _mask_invert(inside, invert)
    return f"clip({expr},0,255)"


def _mask_num(mask, key, default):
    v = mask.get(key) if isinstance(mask, dict) else default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _keying_alpha_expr(keying, pw, ph):
    """抠像 alpha 表达式（rgba-geq 的 a 分量用，值域 0..255——geq alpha 平面
    与 mask 表达式同域；实测 a='0.5' 输出近乎全透明，非 0..1）。

    复刻 FFmpeg colorkey 语义：与键色的 RGB 欧氏色距（0..255 域），色距 ≤
    similarity·255 全透明、≥ (similarity+blend)·255 全不透明、中间线性。
    与 Renderer effects.ts keyingAlpha 同式（彼侧 0..1 域 /√3 归一，两侧同形
    线性斜坡，常数因子由 P2 step0 自校准吸收）。r(X,Y)/g(X,Y)/b(X,Y) 为 geq
    的同帧 RGB 取值函数。键色非法/缺省回绿幕 00FF00；similarity/blend 缺省
    0.3/0.1，clamp 0..1，≤0 回缺省（与旧 colorkey 参数处理一致）。invert
    权威端不消费（known_approximations 登记）。
    """
    if not isinstance(keying, dict) or not keying:
        return None
    import re as _re

    color = str(keying.get("color", "00FF00"))
    if not _re.fullmatch(r"[0-9A-Fa-f]{6}", color):
        color = "00FF00"
    kr = int(color[0:2], 16)
    kg = int(color[2:4], 16)
    kb = int(color[4:6], 16)
    try:
        sim = float(keying.get("similarity", 0.3))
    except (TypeError, ValueError):
        sim = 0.3
    try:
        blend = float(keying.get("blend", 0.1))
    except (TypeError, ValueError):
        blend = 0.1
    sim = min(max(sim, 0.0), 1.0)
    blend = min(max(blend, 0.0), 1.0)
    if sim <= 0.0:
        sim = 0.3
    if blend <= 0.0:
        blend = 0.1
    # 色距归一（实测标定 2026-09-17：对键=黑/绿双组渐变读 alpha 剖面拟合）：
    # dist01 = RGB 欧氏/(255·√3)，a255 = clip((dist01−sim)/blend)·255 —— 与
    # FFmpeg colorkey 实测行为及 effects.ts keyingAlpha（0..1 域）同式。
    dist = (
        "sqrt(pow(r(X,Y)-%d,2)+pow(g(X,Y)-%d,2)+pow(b(X,Y)-%d,2))/441.67" % (kr, kg, kb)
    )
    return f"clip(({dist}-{sim:.4f})/{blend:.4f}*255,0,255)"


def _mask_invert(expr, invert):
    return f"(255-({expr}))" if invert else expr


def _pip_overlay_chain(
    segment, input_index, width, height, *, probe=None, enable_start_us, enable_end_us, main_label="MAINPIP",
    seek_shift_us: int = 0,
):
    """覆盖轨（画中画）片段子句：源取帧 -> 内容盒 -> transform(缩放/旋转) -> PTS 对齐
    -> overlay 时间窗叠加。

    剪映式语义：fit / blurred_background 的浮层元素 = **内容实际大小**（等比适配进
    画布、无黑边），位置/缩放/蒙版均相对内容盒，区域外透明露出下层；crop_fill
    （裁切填满）与重构图仍为满画布盒。旋转/透明度走 rgba（角落透明，不遮挡下层）。

    返回子句列表；外层以分号连接并持久复用 [MAINPIP] 标签。enable 的 t 是主输出
    时间，故用 setpts=PTS+start 把覆盖流对齐到主时间轴。
    """
    transform = segment.get("transform") or {}
    try:
        cx = float(transform.get("x", 0.5))
    except (TypeError, ValueError):
        cx = 0.5
    try:
        cy = float(transform.get("y", 0.5))
    except (TypeError, ValueError):
        cy = 0.5
    try:
        scale_val = float(transform.get("scale", 1.0))
    except (TypeError, ValueError):
        scale_val = 1.0
    try:
        rotate_val = float(transform.get("rotate", 0.0))
    except (TypeError, ValueError):
        rotate_val = 0.0
    try:
        opacity = float(transform.get("opacity", 1.0))
    except (TypeError, ValueError):
        opacity = 1.0
    cx = min(max(cx, 0.0), 1.0)
    cy = min(max(cy, 0.0), 1.0)
    scale_val = min(max(scale_val, 0.05), 5.0)
    opacity = min(max(opacity, 0.0), 1.0)
    keyframes = segment.get("keyframes") if isinstance(segment.get("keyframes"), dict) else None
    # 内容盒尺寸：fit / blurred_background 按素材宽高比等比适配进画布（SAR 归一）；
    # crop_fill 与未知尺寸回退满画布。
    streams = (probe or {}).get("video_streams") or []
    content_only = segment["layout"] in ("fit", "blurred_background") and bool(streams) and "reframe" not in segment
    if content_only:
        raw_w = int(streams[0].get("width") or width)
        raw_h = int(streams[0].get("height") or height)
        rot = int(streams[0].get("rotation") or 0) % 360
        coded_w, coded_h = (raw_h, raw_w) if rot in (90, 270) else (raw_w, raw_h)
        sar_text = str(streams[0].get("sample_aspect_ratio") or "1:1")
        try:
            sar_num, sar_den = sar_text.split(":")
            sar = float(sar_num) / float(sar_den) if float(sar_den) > 0 else 1.0
        except ValueError:
            sar = 1.0
        disp_w = max(2.0, coded_w * (sar if sar > 0 else 1.0))
        fit_scale = min(width / disp_w, height / coded_h)
        content_w = max(2, int(round(disp_w * fit_scale / 2) * 2))
        content_h = max(2, int(round(coded_h * fit_scale / 2) * 2))
    else:
        content_w, content_h = width, height
    pip_w = max(2, int(round(content_w * scale_val / 2) * 2))
    pip_h = max(2, int(round(content_h * scale_val / 2) * 2))
    duration_us = segment["timeline_end_us"] - segment["timeline_start_us"]
    speed_milli = int(segment.get("speed_milli", 1000))
    speed = speed_milli / 1000
    reverse = bool(segment.get("reverse_playback", False))
    if segment["asset_kind"] == "video":
        # C21b：PiP 源精裁坐标同主轨语义回移（-ss 后流上的相对坐标；0 = 旧图）。
        start = _seconds(max(int(segment["source_start_us"]) - seek_shift_us, 0))
        end = _seconds(max(int(segment["source_end_us"]) - seek_shift_us, 0))
        source = f"[{input_index}:v:0]trim=start={start}:end={end},setpts=PTS-STARTPTS"
        if reverse:
            source += ",reverse,setpts=PTS-STARTPTS"
        if speed != 1.0:
            source += f",setpts=PTS/{speed:.6f}"
    else:
        source = f"[{input_index}:v:0]trim=duration={_seconds(duration_us)},setpts=PTS-STARTPTS"
    reframe = segment.get("reframe")
    if content_only:
        # 内容即元素：等比缩放到内容盒（无底、无黑边），区域外透明。
        visual = f"scale={content_w}:{content_h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    else:
        visual = (
            _reframe_crop_filter(width, height, reframe["crop_x"], reframe["crop_y"])
            if isinstance(reframe, dict)
            else _visual_filter(segment["layout"], width, height, 901 + input_index)
        )
    label = f"pip{input_index}"
    head = f"{source},{_square_pixel_filter()},{visual},scale={pip_w}:{pip_h}:force_divisible_by=2"
    has_rotate_kf = bool(keyframes and "rotate" in keyframes)
    has_rotate = rotate_val != 0.0 or has_rotate_kf
    if has_rotate_kf:
        rot_expr = _lerp_expression(keyframes["rotate"], True).replace(",", "\\,")
        angle_expr = f"({rotate_val:.4f}+({rot_expr}))*PI/180" if rotate_val != 0.0 else f"({rot_expr})*PI/180"
        head += f",format=rgba,rotate='{angle_expr}':fillcolor=black@0:ow=iw:oh=ih"
    elif rotate_val != 0.0:
        # 浮层旋转的角落必须透明（露出下层），走 rgba + 黑透明填充。
        # 度数语义（contracts -180..180°）→ rotate 滤镜弧度参数，与关键帧 rotate 路径一致。
        head += ",format=rgba,rotate='{}*PI/180':fillcolor=black@0:ow=iw:oh=ih".format(f"{rotate_val:.4f}")
    head += f"[{label}]"
    # v0.4：mask/keying alpha 并入单条 rgba-geq（a 表达式逐像素计算，RGB 通道
    # 恒等 r(X,Y)/g(X,Y)/b(X,Y)）。旧实现（split → gray-geq / colorkey
    # alphaextract → blend=multiply → alphamerge）在本环境实测把 RGB 平面污染成
    # alpha 灰度（RGB=alpha 的输出帧，硬边路径同样受累、此前采样点恰好不敏感）；
    # 单 geq 既消除污染又少 4 个滤镜节点。a 平面值域 0..255（实测 a='0.5' 即近
    # 全透明）：mask 表达式本输出 0..255，keying 表达式同域复刻 colorkey 斜坡，
    # 两者相乘 = 乘积/255（0..255 域的 alpha 求交）。keying 色距公式与 Renderer
    # effects.ts keyingAlpha 同形（彼侧 0..1 域 /√3 归一，线性斜坡同式，常数因子
    # 由 P2 step0 自校准吸收）。
    mask_obj = segment.get("mask")
    keying_obj = segment.get("keying")
    mask_expr = _mask_alpha_expr(mask_obj, pip_w, pip_h) if isinstance(mask_obj, dict) else None
    key_expr = _keying_alpha_expr(keying_obj, pip_w, pip_h) if isinstance(keying_obj, dict) else None
    if mask_expr is not None or key_expr is not None:
        parts: list[str] = []
        if mask_expr is not None:
            parts.append(f"({mask_expr})")
        if key_expr is not None:
            parts.append(f"({key_expr})")
        joined = "*".join(parts)
        a_expr = joined if len(parts) == 1 else f"{joined}/255"
        if has_rotate:
            a_expr = f"({a_expr})*alpha(X,Y)/255"
        alpha_clause: list[str] = [
            f"[{label}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{a_expr}'[{label}vis]"
        ]
        align_label = f"{label}vis"
    else:
        alpha_clause = []
        align_label = label
    if opacity < 1.0:
        op_label = f"{label}op"
        alpha_clause.append(
            f"[{align_label}]format=rgba,colorchannelmixer=aa={opacity:.6f}[{op_label}]"
        )
        align_label = op_label
    if keyframes and "opacity" in keyframes:
        d_us = int(keyframes["opacity"]["frames"][-1]["t_us"])
        if d_us > 0:
            kop_label = f"{label}kop"
            alpha_clause.append(
                f"[{align_label}]format=rgba,fade=alpha=1:st=0.000000:d={_seconds(d_us)}[{kop_label}]"
            )
            align_label = kop_label
    picture_fade_in = max(int(segment.get("picture_fade_in_us") or 0), 0)
    picture_fade_out = max(int(segment.get("picture_fade_out_us") or 0), 0)
    if picture_fade_in or picture_fade_out:
        if picture_fade_in + picture_fade_out > duration_us:
            total_fade = picture_fade_in + picture_fade_out
            picture_fade_in = int(picture_fade_in * duration_us / total_fade)
            picture_fade_out = duration_us - picture_fade_in
        fade_chain = ["format=rgba"]
        if picture_fade_in:
            fade_chain.append(
                f"fade=t=in:st=0:d={_seconds(picture_fade_in)}:alpha=1"
            )
        if picture_fade_out:
            fade_chain.append(
                f"fade=t=out:st={_seconds(duration_us - picture_fade_out)}:"
                f"d={_seconds(picture_fade_out)}:alpha=1"
            )
        faded_label = f"{label}picturefade"
        alpha_clause.append(f"[{align_label}]{','.join(fade_chain)}[{faded_label}]")
        align_label = faded_label
    align = f"[{align_label}]setpts=PTS+{enable_start_us / 1_000_000:.6f}[{label}a]"
    # transform.x/y 为「中心点归一化位置」（0..1，与 contracts 注释及交互预览
    # translate(-50%,-50%) 语义一致）：overlay 左上角 = 中心点像素 − PIP 尺寸一半。
    # 负值表示 PIP 部分出画（overlay 自动裁剪），与预览画布 overflow 裁剪行为对齐。
    base_x = cx * width - pip_w / 2
    base_y = cy * height - pip_h / 2
    if keyframes and "position" in keyframes:
        local_t = f"(t-{enable_start_us / 1_000_000:.6f})"
        kx_expr, ky_expr = _lerp_expression(keyframes["position"], False, time_var=local_t)
        kx_esc = kx_expr.replace(",", "\\,")
        ky_esc = ky_expr.replace(",", "\\,")
        x_expr = f"{base_x:.1f}+({kx_esc})*({width / 2 * scale_val:.6f})"
        y_expr = f"{base_y:.1f}+({ky_esc})*({height / 2 * scale_val:.6f})"
    else:
        x_expr = f"{base_x:.1f}"
        y_expr = f"{base_y:.1f}"
    overlay = (
        f"[{main_label}][{label}a]overlay=x='{x_expr}':y='{y_expr}':"
        f"enable='between(t,{_seconds(enable_start_us)},{_seconds(enable_end_us)})':"
        f"eval=frame:repeatlast=1:format=auto[{main_label}]"
    )
    return [head] + alpha_clause + [align, overlay]




@measured("encode")
async def run_timeline_render(
    ffmpeg: Path,
    args: list[str],
    cwd: Path,
    expected_us: int,
    cancel_event: asyncio.Event,
    progress: Callable[[float], None],
    worker_pid: Callable[[int | None], None],
) -> None:
    creationflags = getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0)
    creationflags |= getattr(asyncio.subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=creationflags,
    )
    try:
        kill_job = WindowsKillJob.attach(process.pid)
    except OSError as exc:
        await terminate_process_tree(process)
        raise RuntimeError(f"RENDER_FAILED: unable to isolate FFmpeg: {exc}") from exc
    worker_pid(process.pid)

    async def read_progress() -> None:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if line.startswith("out_time_us="):
                try:
                    value = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                progress(min(max(value / expected_us, 0), 0.99) if expected_us else 0)

    progress_task = asyncio.create_task(read_progress())
    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    try:
        while process.returncode is None:
            if cancel_event.is_set():
                await terminate_process_tree(process)
                raise RuntimeError("JOB_CANCELLED")
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
            except TimeoutError:
                pass
        await progress_task
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-32768:]
    finally:
        worker_pid(None)
        if kill_job is not None:
            kill_job.close()
        if not progress_task.done():
            progress_task.cancel()
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise RuntimeError("JOB_CANCELLED")
    if process.returncode != 0:
        raise RuntimeError(f"RENDER_FAILED: {stderr[-1000:]}")


async def terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
        )
        await killer.wait()
    else:
        process.kill()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()


@measured("validate_decode")
async def decode_validate(
    ffmpeg: Path,
    path: Path,
    *,
    cancel_event: asyncio.Event | None = None,
    on_progress: Callable[[float], None] | None = None,
    media_duration_us: int | None = None,
) -> None:
    """C22：可取消的完整解码校验（-f null 全量解码，非抽帧冒充）。

    超时拆分（计划 C22-4）：
    - stall 120s：无 out_time/帧推进（定期日志不算媒体进度）；
    - 绝对上限 max(300s, 5×媒体时长)：慢盘/长尾有兜底。
    取消走进程树终止；stderr 有界 ring（末 32KiB），不再整段读入。
    """
    args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        str(path),
        "-f",
        "null",
        "-",
    ]
    creationflags = getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0)
    creationflags |= getattr(asyncio.subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=creationflags,
    )
    try:
        kill_job = WindowsKillJob.attach(process.pid)
    except OSError as exc:
        await terminate_process_tree(process)
        raise RuntimeError(f"RENDER_VALIDATION_FAILED: unable to isolate FFmpeg: {exc}") from exc

    absolute_limit = max(300.0, 5.0 * (media_duration_us or 0) / 1_000_000)
    stall_limit = 120.0
    stderr_ring = _StderrRing(32 * 1024)
    last_progress = asyncio.get_running_loop().time()
    started = last_progress
    cancelled = False
    try:
        assert process.stdout is not None
        assert process.stderr is not None

        async def read_progress() -> None:
            nonlocal last_progress
            async for raw in process.stdout:
                last_progress = asyncio.get_running_loop().time()
                line = raw.decode("utf-8", errors="replace").strip()
                if line.startswith("out_time_us=") and on_progress is not None:
                    try:
                        value = int(line.split("=", 1)[1])
                    except ValueError:
                        continue
                    on_progress(min(max(value, 0), 1) if not media_duration_us
                                else min(max(value / media_duration_us, 0), 0.99))

        async def read_stderr() -> None:
            async for raw in process.stderr:
                stderr_ring.append(raw)

        progress_task = asyncio.create_task(read_progress())
        stderr_task = asyncio.create_task(read_stderr())
        try:
            while process.returncode is None:
                if cancel_event is not None and cancel_event.is_set():
                    cancelled = True
                    await terminate_process_tree(process)
                    break
                now = asyncio.get_running_loop().time()
                if now - last_progress > stall_limit or now - started > absolute_limit:
                    await terminate_process_tree(process)
                    raise RuntimeError(
                        "RENDER_VALIDATION_TIMEOUT: "
                        + ("no decode progress" if now - last_progress > stall_limit
                           else "absolute validation limit exceeded")
                    )
                try:
                    await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
                except TimeoutError:
                    pass
            await progress_task
            await stderr_task
        finally:
            if not progress_task.done():
                progress_task.cancel()
            if not stderr_task.done():
                stderr_task.cancel()
    finally:
        if kill_job is not None:
            kill_job.close()
    if cancelled or (cancel_event is not None and cancel_event.is_set()):
        raise RuntimeError("JOB_CANCELLED")
    if process.returncode != 0:
        raise RuntimeError(f"RENDER_VALIDATION_FAILED: {stderr_ring.tail(1000)}")


class _StderrRing:
    """有界 stderr 保留（末 N 字节）——decode_validate/长任务统一模式，
    替换"先整段 read() 再切片"的洪泛内存放大。线程安全不需要：全部访问
    在事件循环协程内。"""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._buffer = bytearray()

    def append(self, raw: bytes) -> None:
        self._buffer.extend(raw)
        if len(self._buffer) > self._capacity:
            del self._buffer[:-self._capacity]

    def tail(self, limit: int) -> str:
        return self._buffer[-limit:].decode("utf-8", errors="replace")


def _seconds(value_us: int) -> str:
    return f"{int(value_us) / 1_000_000:.6f}"


def _fade_us(segment: dict[str, Any], duration_us: int) -> tuple[int, int]:
    """段的淡入/淡出时长（微秒），已按段时长夹住。

    超限处置：fade_in + fade_out > 段时长时**按比例收缩到恰好占满整段**
    （fade_in 向下取整，fade_out 吃掉余数，保证两者之和 == 段时长）。理由：
    afade 的 st 为负会直接让整条导出失败，而"把用户设的 5s 淡入丢给只有 2s
    的片段"是编辑器里最普通的操作（先设淡变、再裁短），不该变成导出错误。
    收缩只发生在**图构造期**，文档里的用户意图原样保留——把片段拉回原长，
    淡变自动恢复。0/缺省 ⇒ (0, 0)，调用方据此完全不生成 afade（默认路径不变）。
    """
    try:
        fade_in = max(int(segment.get("fade_in_us") or 0), 0)
        fade_out = max(int(segment.get("fade_out_us") or 0), 0)
    except (TypeError, ValueError):
        return (0, 0)
    duration = int(duration_us)
    if (fade_in == 0 and fade_out == 0) or duration <= 0:
        return (0, 0)
    if fade_in + fade_out > duration:
        fade_in = int(fade_in * duration / (fade_in + fade_out))
        fade_out = duration - fade_in
    return (fade_in, fade_out)


def _fade_chain(segment: dict[str, Any], duration_us: int) -> str:
    """afade 滤镜片段（前导逗号）；无淡变时返回空串，链与旧版逐字节一致。"""
    fade_in, fade_out = _fade_us(segment, duration_us)
    clauses: list[str] = []
    if fade_in > 0:
        clauses.append(f"afade=t=in:st=0:d={_seconds(fade_in)}")
    if fade_out > 0:
        clauses.append(
            f"afade=t=out:st={_seconds(int(duration_us) - fade_out)}:d={_seconds(fade_out)}"
        )
    return "".join(f",{clause}" for clause in clauses)


def _picture_fade_clauses(
    clauses: list[str], segment: dict[str, Any], duration_us: int, output_label: str,
) -> list[str]:
    """Apply clip-local picture fades to a full segment stream, toward black."""
    try:
        fade_in = max(int(segment.get("picture_fade_in_us") or 0), 0)
        fade_out = max(int(segment.get("picture_fade_out_us") or 0), 0)
    except (TypeError, ValueError):
        return clauses
    duration = max(int(duration_us), 0)
    if duration <= 0 or (fade_in <= 0 and fade_out <= 0):
        return clauses
    if fade_in + fade_out > duration:
        fade_in = int(fade_in * duration / (fade_in + fade_out))
        fade_out = duration - fade_in
    terminal = f"{output_label}_pf_source"
    clauses[-1] = clauses[-1].replace(f"[{output_label}]", f"[{terminal}]")
    current = terminal
    fade_specs = []
    if fade_in > 0:
        fade_specs.append(("in", 0, fade_in))
    if fade_out > 0:
        fade_specs.append(("out", duration - fade_out, fade_out))
    for index, (direction, start, length) in enumerate(fade_specs):
        next_label = output_label if index == len(fade_specs) - 1 else f"{output_label}_pf{index}"
        clauses.append(
            f"[{current}]fade=t={direction}:st={_seconds(start)}:"
            f"d={_seconds(length)}:color=black[{next_label}]"
        )
        current = next_label
    return clauses
