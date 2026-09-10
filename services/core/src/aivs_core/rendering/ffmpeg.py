from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..media.windows_job import WindowsKillJob
from ..performance import measured
from ..projects import DomainError


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


def _lerp_expression(track: dict[str, Any], scalar: bool) -> str:
    """B3：关键帧轨道 → 段内相对秒 t 的 FFmpeg 表达式（分段线性）。

    帧升序唯一（core 已校验）；窗口外取边界值。position 展开 x/y 两段，
    其余属性展开标量 v。
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
                lerp = f"({v0:.6f}+((t-{frames[low]['t_us'] / 1_000_000:.6f})*{v1 - v0:.6f}/{span:.6f}))"
                return f"if(lt(t,{t1:.6f}),{lerp},{v1:.6f})"
            mid = (low + high) // 2
            # 二分分段：左半管 [low, mid)，右半递归；不影响线性语义（嵌套 if 按 t 分派）。
            return f"if(lt(t,{frames[mid]['t_us'] / 1_000_000:.6f}),{build(low, mid)},{build(mid, high)})"

        return build(0, len(frames) - 1)

    if scalar:
        return channel("v")
    x_expr = channel("x")
    y_expr = channel("y")
    return x_expr, y_expr


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
) -> list[str]:
    """组装 FFmpeg 参数图。

    C21a：input_windows（rendering/input_window.plan_input_windows 的输出）
    非 None 时为**深定位图**——eligible 段的输入前插 -ss（准确 seek），
    其 visual_chain/atrim 的精裁坐标回移 seek 量（实证与旧图输出帧一致，
    见 test_render_input_window 的对拍）；legacy 段（None 窗口或不合格）
    保持旧参数。None = 完整旧图（测试 oracle 与回退路径）。
    """
    segments = plan["segments"]
    if len(segments) != len(segment_paths) or len(segments) != len(segment_probes):
        raise DomainError("RENDER_PLAN_INVALID", "渲染输入数量不一致")
    # 多轨道（剪映式）：当前渲染图为"主视频轨（V1）"单视觉轨语义——只消费
    # V1 上可见的片段，按 timeline_start_us 排序；相邻段之间的空隙插入黑底
    # 填充段（lavfi color），保证 concat 图的输出长度与时间线总长一致。
    # 主轨被隐藏（或为空）时输出全程黑场。其他视频轨（覆盖轨）与 A1 音频
    # 混音为后续工作（audio 段缺视频流，旧实现会让整图失败，这里显式跳过）。
    timeline_total_us = max(
        (int(segment["timeline_end_us"]) for segment in segments),
        default=0,
    )
    visual_items = [
        (index, segment)
        for index, segment in enumerate(segments)
        if (
            segment["asset_kind"] != "audio"
            and segment.get("track_id", "V1") == "V1"
            and not segment.get("track_hidden", False)
        )
    ]
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
            if int(successor["timeline_start_us"]) == int(segment["timeline_end_us"]):
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
        # 主轨隐藏/为空但时间线有内容：输出全程黑场（音频保持各段静音占位）。
        graph_items.append({"kind": "black", "duration_us": timeline_total_us})

    # B3：position/opacity 动画需要一个黑底 lavfi 输入（blend/overlay 用）。
    needs_black_input = any(
        item["kind"] == "segment"
        and isinstance(item["segment"].get("keyframes"), dict)
        and ({"position", "opacity"} & set(item["segment"]["keyframes"]))
        for item in graph_items
    )
    black_input_index = len(segments) if needs_black_input else -1
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])
    args = ["-hide_banner", "-nostdin", "-y"]
    for position, (segment, path) in enumerate(zip(segments, segment_paths, strict=True)):
        # C21a：深定位图——eligible 输入前插 -ss（-i 前为准确 seek）；
        # legacy 输入零改动。图像输入不定位（loop 无 seek 语义）。
        if segment["asset_kind"] == "image":
            args += ["-loop", "1", "-framerate", "30"]
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
            f"color=c=black:s={width}x{height}:r=30:d={black_duration}",
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
                f"color=c=black:s={width}x{height}:r=30:d={fill_duration}",
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
        base = f"{source},{_square_pixel_filter()},{visual},setsar=1,fps=30,format=yuv420p"
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
                    f"color=c=black:s={width}x{height}:r=30:d={bg_duration:.6f},setsar=1[ppbg{label_id}]"
                )
                clauses.append(
                    f"[ppbg{label_id}][vpre{label_id}]overlay=x={cx * width - pip_w / 2:.1f}"
                    f":y={cy * height - pip_h / 2:.1f},format=yuv420p[{out_label}]"
                )
                return clauses
        return _keyframe_animation_filters(
            segment, base, f"vbase{label_id}", out_label, width, height,
            black_input_index if black_input_index is not None else -1,
        )

    for position, item in enumerate(graph_items):
        if item["kind"] == "black":
            # 黑底填充段（时间线空隙）：lavfi color 输入裁出空隙时长。
            fill_duration = _seconds(item["duration_us"])
            filters.append(
                f"[{item['input_index']}:v]trim=duration={fill_duration},"
                "setpts=PTS-STARTPTS,fps=30,format=yuv420p"
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
                f"{tempo_chain}volume={gain:.3f}dB,apad,atrim=duration={duration}[a{position}]"
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

    if not has_active_transitions:
        filters.append(f"{''.join(concat_inputs)}concat=n={len(graph_items)}:v=1:a=1[vcat][aout]")
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
                filters.extend(
                    visual_chain(
                        right_segment, item["input_index"], f"vh{step}",
                        window_us=(0, right_total_us - head_us - next_tail_us),
                        black_input_index=black_input_index,
                        seek_shift_us=seek_shift_us,
                    )
                )
                filters.extend(
                    visual_chain(
                        right_segment, item["input_index"], f"vr{step}",
                        window_us=(head_us, next_tail_us),
                        black_input_index=black_input_index,
                        seek_shift_us=seek_shift_us,
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
        filters.append(f"[{video_label_prev}]null[vcat];[{audio_label_prev}]anull[aout]")
    video_label = "vcat"
    # P1 覆盖轨（画中画）合成：V1 之外的视频/图片覆盖帧，按时间窗以不透明
    # 实心浮层叠到主画面上（PIP 语义），并持久复用 [MAINPIP] 标签供逐段叠加。
    overlay_segments = [
        (index, segment)
        for index, segment in enumerate(segments)
        if (
            segment["asset_kind"] != "audio"
            and segment.get("track_id", "V1") != "V1"
            and not segment.get("track_hidden", False)
        )
    ]
    if overlay_segments:
        main_label = "MAINPIP"
        filters.append(f"[vcat]null[{main_label}]")
        for index, segment in overlay_segments:
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
    if encoder == "libopenh264":
        args += ["-b:v", "3M" if width == 540 else "10M"]
    elif encoder in {"h264_nvenc", "h264_qsv", "h264_amf"}:
        args += ["-b:v", "4M" if width == 540 else "12M"]
    args += [
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
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
    """
    if not isinstance(mask, dict):
        return None
    kind = mask.get("kind")
    if kind not in ("linear", "rect", "ellipse"):
        return None
    cx = _mask_num(mask, "x", 0.5) * pw
    cy = _mask_num(mask, "y", 0.5) * ph
    feather = max(0.0, min(1.0, _mask_num(mask, "feather", 0.02)))
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
        inside = f"max(0,min(255,255*(1-{d})))"
    elif kind == "rect":
        hal_w = max(1.0, _mask_num(mask, "width", 0.5) * pw / 2.0)
        hal_h = max(1.0, _mask_num(mask, "height", 0.5) * ph / 2.0)
        ux = f"{cs}*(X-{cx:.1f})+{sn}*(Y-{cy:.1f})"
        uy = f"-{sn}*(X-{cx:.1f})+{cs}*(Y-{cy:.1f})"
        norm = f"max(abs({ux})/{hal_w:.1f},abs({uy})/{hal_h:.1f})"
        inside = f"255*max(0,1-min(1,{norm}))"
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


def _mask_invert(expr, invert):
    return f"(255-({expr}))" if invert else expr


def _pip_overlay_chain(
    segment, input_index, width, height, *, probe=None, enable_start_us, enable_end_us, main_label="MAINPIP",
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
    cx = min(max(cx, 0.0), 1.0)
    cy = min(max(cy, 0.0), 1.0)
    scale_val = min(max(scale_val, 0.05), 5.0)
    # 内容盒尺寸：fit / blurred_background 按素材宽高比等比适配进画布（SAR 归一）；
    # crop_fill 与未知尺寸回退满画布。
    streams = (probe or {}).get("video_streams") or []
    content_only = segment["layout"] in ("fit", "blurred_background") and bool(streams) and "reframe" not in segment
    if content_only:
        coded_w = int(streams[0].get("width") or width)
        coded_h = int(streams[0].get("height") or height)
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
        start = _seconds(int(segment["source_start_us"]))
        end = _seconds(int(segment["source_end_us"]))
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
    if rotate_val != 0.0:
        # 浮层旋转的角落必须透明（露出下层），走 rgba + 黑透明填充。
        # 度数语义（contracts -180..180°）→ rotate 滤镜弧度参数，与关键帧 rotate 路径一致。
        head += ",format=rgba,rotate='{}*PI/180':fillcolor=black@0:ow=iw:oh=ih".format(f"{rotate_val:.4f}")
    head += f"[{label}]"
    # 生成「灰阶 alpha（0..255）」贡献：蒙版 geq 灰 + 抠像 colorkey alphaextract。
    # 最终 RGB 帧 + 每个 alpha 来源各一条 split 分支（避免 [label] 被多处消费）。
    gray_sources: list[str] = []
    alpha_clause: list[str] = []
    mask_obj = segment.get("mask")
    keying_obj = segment.get("keying")
    want_mask = isinstance(mask_obj, dict) and bool(_mask_alpha_expr(mask_obj, pip_w, pip_h))
    want_key = isinstance(keying_obj, dict) and bool(keying_obj)
    n_branches = 1 + (1 if want_mask else 0) + (1 if want_key else 0)
    if n_branches > 1:
        split_spec = "".join(f"[{label}_b{i}]" for i in range(n_branches))
        alpha_clause.append(f"[{label}]split={n_branches}{split_spec}")
        rgb_branch = f"{label}_b0"
        next_branch = 1
        if want_mask:
            expr = _mask_alpha_expr(mask_obj, pip_w, pip_h)
            alpha_clause.append(
                f"[{label}_b{next_branch}]format=gray,geq='{expr}'[{label}_mask_a]"
            )
            gray_sources.append(f"{label}_mask_a")
            next_branch += 1
        if want_key:
            key_color = str(keying_obj.get("color", "00FF00"))
            try:
                key_sim = float(keying_obj.get("similarity", 0.3))
            except (TypeError, ValueError):
                key_sim = 0.3
            try:
                key_blend = float(keying_obj.get("blend", 0.1))
            except (TypeError, ValueError):
                key_blend = 0.1
            key_sim = min(max(key_sim, 0.0), 1.0)
            key_blend = min(max(key_blend, 0.0), 1.0)
            if key_sim <= 0.0:
                key_sim = 0.3
            if key_blend <= 0.0:
                key_blend = 0.1
            alpha_clause.append(
                f"[{label}_b{next_branch}]colorkey=color=0x{key_color}:similarity={key_sim:.3f}:blend={key_blend:.3f},"
                f"format=rgba,alphaextract[{label}_key_a]"
            )
            gray_sources.append(f"{label}_key_a")
            next_branch += 1
        # 合并 alpha（多来源 multiply 求交）。
        if len(gray_sources) == 1:
            final_gray = gray_sources[0]
        else:
            g0, g1 = gray_sources[0], gray_sources[1]
            alpha_clause.append(f"[{g0}][{g1}]blend=all_mode=multiply[{label}_cmb_a]")
            final_gray = f"{label}_cmb_a"
        align_label = f"{label}vis"
        alpha_clause.append(
            f"[{rgb_branch}]format=rgba[{label}_rgb_b];[{label}_rgb_b][{final_gray}]alphamerge[{align_label}]"
        )
    else:
        align_label = label
    align = f"[{align_label}]setpts=PTS+{enable_start_us / 1_000_000:.6f}[{label}a]"
    # transform.x/y 为「中心点归一化位置」（0..1，与 contracts 注释及交互预览
    # translate(-50%,-50%) 语义一致）：overlay 左上角 = 中心点像素 − PIP 尺寸一半。
    # 负值表示 PIP 部分出画（overlay 自动裁剪），与预览画布 overflow 裁剪行为对齐。
    x_expr = f"{cx * width - pip_w / 2:.1f}"
    y_expr = f"{cy * height - pip_h / 2:.1f}"
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
