from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..media.process import run_process
from ..media.windows_job import WindowsKillJob
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
        clauses.append(
            f"[{black_input_index}:v][{current}]overlay=x='(W-w)/2+{x_expr}*(W/2)':y='(H-h)/2+{y_expr}*(H/2)':eval=frame:eof_action=repeat[{positioned}]"
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
) -> list[str]:
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
    for segment, path in zip(segments, segment_paths, strict=True):
        if segment["asset_kind"] == "image":
            args += ["-loop", "1", "-framerate", "30"]
        args += ["-i", str(path)]
    next_input_index = len(segments)
    if needs_black_input:
        args += ["-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=30"]
        next_input_index += 1
    for item in graph_items:
        if item["kind"] == "black":
            item["input_index"] = next_input_index
            next_input_index += 1
            args += ["-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=30"]

    filters: list[str] = []
    concat_inputs = []
    label_seq = [0]

    def visual_chain(
        segment: dict[str, Any], input_index: int, out_label: str,
        *, window_us: tuple[int, int] | None = None,
        black_input_index: int | None = None,
    ) -> list[str]:
        """一段的"源 trim（可选取窗）→ 视觉滤镜 → 关键帧动画"链。

        window_us 为时间线窗口 (head_us, tail_us)；返回子句列表（动画
        叠加可能产生多条，含 color 源与 overlay），以分号连接后追加到图。
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
            start = _seconds(int(segment["source_start_us"]) + round(head_us * speed_milli / 1000))
            end = _seconds(int(segment["source_end_us"]) - round(tail_us * speed_milli / 1000))
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
        # 转场模式下，被 xfade 旁路的段的视频链在转场分支独立构建（其 [vN] 会悬空）。
        is_transition_right = position > 0 and isinstance(
            graph_items[position - 1].get("transition_in"), dict
        )
        if not is_transition_right:
            filters.extend(
                visual_chain(
                    segment, item["input_index"], f"v{position}",
                    black_input_index=black_input_index,
                )
            )
        has_audio = bool(probe.get("audio_streams"))
        if (
            segment["asset_kind"] == "video"
            and has_audio
            and segment["audio_enabled"]
            and not reverse
        ):
            start = _seconds(segment["source_start_us"])
            end = _seconds(segment["source_end_us"])
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
                    )
                )
                filters.extend(
                    visual_chain(
                        right_segment, item["input_index"], f"vr{step}",
                        window_us=(head_us, next_tail_us),
                        black_input_index=black_input_index,
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
    if captions:
        filters.append("[vcat]ass=filename=captions.ass:fontsdir=fonts[vout]")
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


async def decode_validate(ffmpeg: Path, path: Path) -> None:
    result = await run_process(
        ffmpeg,
        ["-hide_banner", "-v", "error", "-i", str(path), "-f", "null", "-"],
        120,
    )
    if result.returncode != 0:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物无法完整解码")


def _seconds(value_us: int) -> str:
    return f"{int(value_us) / 1_000_000:.6f}"
