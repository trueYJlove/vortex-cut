"""预览合成 IR 投影（preview-ir-v1，M3-1）。

把 RenderPlanCompiler 输出（render-plan-v1）投影为"逐帧数值表 IR"：插值、
借用式转场 offset、变速帧对位、黑底填充、PiP 内容盒、字幕样式解析全部
收敛到本模块单点，Renderer 端只做应用（架构决策 R4，M3-0 实证）。

- 白名单硬失败：子集外语义抛 PREVIEW_IR_UNSUPPORTED（R11），
  子集定义见 docs/STAGE_M3_0_IR_CONTRACT_DRAFT.md（v0.2）；
- 输出时长 = 转场借用压缩后的输出时间轴（≠ 时间线最大终点）；
- 纯函数、无 IO：同输入必得同 IR（独立验收已复核逐位一致）。

毕业来源：M3-0 探针 tools/m3_0/ir_projector.py（语义零改动，见
docs/STAGE_M3_0_TECH_VALIDATION_REPORT.md）。
"""
from __future__ import annotations

from typing import Any

from ..projects import DomainError

FPS = 30
IR_SCHEMA = "preview-ir-v1"
IR_PROJECTOR_VERSION = 1

ALLOWED_KEYFRAME_PROPS = {"position", "opacity"}
ALLOWED_TRANSITIONS = {"fade", "fadeblack"}
ALLOWED_MAIN_LAYOUTS = {"fit"}


def _fail(clip_id: str, what: str) -> DomainError:
    return DomainError("PREVIEW_IR_UNSUPPORTED", f"段 {clip_id}: {what} 超出实时合成子集")


def _unsupported(what: str) -> DomainError:
    return DomainError("PREVIEW_IR_UNSUPPORTED", what)


def _validate_whitelist(plan: dict[str, Any]) -> None:
    for segment in plan["segments"]:
        clip_id = segment["clip_id"]
        if segment.get("mask"):
            raise _fail(clip_id, "mask（蒙版）")
        if segment.get("keying"):
            raise _fail(clip_id, "keying（抠像）")
        if segment.get("reframe"):
            raise _fail(clip_id, "reframe（重构图）")
        if segment.get("reverse_playback"):
            raise _fail(clip_id, "reverse_playback（倒放）")
        if segment.get("track_hidden"):
            raise _fail(clip_id, "track_hidden（隐藏轨）")
        keyframes = segment.get("keyframes")
        if isinstance(keyframes, dict) and keyframes:
            if segment["track_id"] != "V1":
                raise _fail(clip_id, "非 V1 轨关键帧（权威端覆盖轨链路不叠加动画）")
            unknown = set(keyframes) - ALLOWED_KEYFRAME_PROPS
            if unknown:
                raise _fail(clip_id, f"关键帧属性 {sorted(unknown)}")
        if segment.get("transition_in"):
            if segment["transition_in"]["kind"] not in ALLOWED_TRANSITIONS:
                raise _fail(clip_id, f"转场 {segment['transition_in']['kind']}")
            if segment["track_id"] != "V1":
                raise _fail(clip_id, "覆盖轨转场（权威端仅 V1 相邻段）")
    for caption in plan["captions"]["items"]:
        if caption.get("style_override"):
            raise _unsupported(f"字幕 {caption['caption_id']}: style_override 超出实时合成子集")


def _lerp_channel(frames: list[dict[str, Any]], t_seg_us: int, key: str) -> float:
    """复刻 _lerp_expression 语义：帧升序唯一、分段线性、窗口外取边界值。"""
    if len(frames) == 1:
        return float(frames[0].get(key, 0.0))
    if t_seg_us <= frames[0]["t_us"]:
        return float(frames[0].get(key, 0.0))
    if t_seg_us >= frames[-1]["t_us"]:
        return float(frames[-1].get(key, 0.0))
    for low, high in zip(frames, frames[1:]):
        if low["t_us"] <= t_seg_us <= high["t_us"]:
            span = high["t_us"] - low["t_us"]
            if span <= 0:
                return float(high.get(key, 0.0))
            weight = (t_seg_us - low["t_us"]) / span
            return float(low.get(key, 0.0)) + (float(high.get(key, 0.0)) - float(low.get(key, 0.0))) * weight
    raise AssertionError("unreachable")


def _opacity_alpha(keyframes: dict[str, Any] | None, t_seg_us: int) -> float:
    """权威端实际行为：fade=alpha=1:st=0:d=末关键帧t（恒 0→1 渐入，v 值不参与）。"""
    if not isinstance(keyframes, dict) or "opacity" not in keyframes:
        return 1.0
    d_us = int(keyframes["opacity"]["frames"][-1]["t_us"])
    if d_us <= 0:
        return 1.0
    return max(0.0, min(1.0, t_seg_us / d_us))


def _fit_content_box(geometry: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    """主轨 fit 布局内容盒（复刻 _visual_filter("fit")：等比缩进 + 黑边居中）。"""
    disp_w = geometry["width"] * geometry["sar"]
    scale = min(width / disp_w, height / geometry["height"])
    content_w = int(round(disp_w * scale / 2) * 2)
    content_h = int(round(geometry["height"] * scale / 2) * 2)
    return (width - content_w) // 2, (height - content_h) // 2, content_w, content_h


def _pip_box(segment: dict[str, Any], geometry: dict[str, Any], width: int, height: int) -> tuple[float, float, int, int, float]:
    """复刻 _pip_overlay_chain：内容盒 × transform.scale，中心点 (cx·W, cy·H)。"""
    transform = segment.get("transform") or {}
    try:
        scale_val = min(max(float(transform.get("scale", 1.0)), 0.05), 5.0)
    except (TypeError, ValueError):
        scale_val = 1.0
    try:
        cx = min(max(float(transform.get("x", 0.5)), 0.0), 1.0)
        cy = min(max(float(transform.get("y", 0.5)), 0.0), 1.0)
    except (TypeError, ValueError):
        cx, cy = 0.5, 0.5
    try:
        rotate_val = float(transform.get("rotate", 0.0))
    except (TypeError, ValueError):
        rotate_val = 0.0
    disp_w = geometry["width"] * geometry["sar"]
    fit_scale = min(width / disp_w, height / geometry["height"])
    content_w = max(2, int(round(disp_w * fit_scale / 2) * 2))
    content_h = max(2, int(round(geometry["height"] * fit_scale / 2) * 2))
    pip_w = max(2, int(round(content_w * scale_val / 2) * 2))
    pip_h = max(2, int(round(content_h * scale_val / 2) * 2))
    return cx * width - pip_w / 2, cy * height - pip_h / 2, pip_w, pip_h, rotate_val


def _source_frame_n(segment: dict[str, Any], t_exact_us: float, offset_from_us: float) -> int:
    """段内源帧号（绝对帧号）。offset_from_us：借用头部 body 相的源偏移（= T*speed）。

    speed≠1 时源位置连续，权威端链内 fps=30 按"最新已到帧"hold——
    src_n = floor(源位置×30)（恰为整帧边界时取该帧）。repeatlast：源位置
    钳制到 [source_start, source_end − 1帧]。
    """
    if segment["asset_kind"] != "video":
        return 0
    speed_milli = int(segment.get("speed_milli", 1000))
    source_start = int(segment["source_start_us"])
    source_end = int(segment["source_end_us"])
    elapsed = t_exact_us - int(segment["timeline_start_us"])
    position = source_start + offset_from_us + elapsed * speed_milli / 1000.0
    position = min(max(position, source_start), max(source_start, source_end - 1_000_000 / FPS))
    return max(int(position * FPS / 1_000_000 + 1e-6), 0)


def _parse_ass_color(value: str) -> list[int]:
    """&Haabbggrr → [r, g, b]（alpha 不在基础样式范围）。"""
    body = str(value)[2:].strip("&")
    if len(body) != 8:
        return [255, 255, 255]
    return [int(body[6:8], 16), int(body[4:6], 16), int(body[2:4], 16)]


def resolved_caption_styles(presets: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """预设 → 数值样式（Core 单点解析，Renderer 端只消费；PlayRes = 渲染画布）。"""
    resolved: dict[str, dict[str, Any]] = {}
    for preset_id, value in (presets.get("presets") or {}).items():
        resolved[preset_id] = {
            "font_size": int(value["font_size"]),
            "primary_rgb": _parse_ass_color(value["primary_color"]),
            "outline_rgb": _parse_ass_color(value["outline_color"]),
            "outline": int(value["outline"]),
            "shadow": int(value["shadow"]),
            "border_style": int(value["border_style"]),
            "margin_v": int(value["margin_v"]),
        }
    return resolved


def _anchor_of(regions: list[dict[str, Any]], blend_region: dict[str, Any]) -> dict[str, Any]:
    """转场锚点段 = blend 区段之前、时间上覆盖 blend 窗口的段区段。"""
    index = regions.index(blend_region)
    for candidate in reversed(regions[:index]):
        if candidate["item"]["kind"] == "segment" and candidate["t0"] <= blend_region["t0"]:
            return candidate["item"]["segment"]
    raise _unsupported("转场锚点段缺失")


def project_preview_ir(plan: dict[str, Any], probes: dict[str, dict[str, Any]],
                       caption_styles: dict[str, Any] | None = None) -> dict[str, Any]:
    _validate_whitelist(plan)
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])

    inputs: list[dict[str, Any]] = []
    geometry_by_input: dict[str, dict[str, Any]] = {}
    for item in plan["inputs"]:
        stream = ((probes.get(item["asset_id"]) or {}).get("video_streams") or [None])[0] if item["asset_kind"] != "audio" else None
        if stream is None:
            raise _unsupported(f"input {item['asset_id']} 缺少输入流几何（ffprobe）")
        sar_text = str(stream.get("sample_aspect_ratio") or "1:1")
        try:
            num, den = sar_text.replace("/", ":").split(":")
            sar = float(num) / float(den) if float(den) > 0 else 1.0
        except ValueError:
            sar = 1.0
        geometry = {"width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0), "sar": sar}
        inputs.append({
            "input_id": item["input_id"], "asset_id": item["asset_id"],
            "asset_kind": item["asset_kind"], "duration_us": item["duration_us"],
            "has_audio": item["has_audio"], "geometry": geometry,
        })
        geometry_by_input[item["input_id"]] = geometry
    segment_input = {segment["clip_id"]: segment["input_id"] for segment in plan["segments"]}

    segments = plan["segments"]
    visual = [
        (index, segment)
        for index, segment in enumerate(segments)
        if segment["asset_kind"] != "audio" and segment.get("track_id", "V1") == "V1" and not segment.get("track_hidden")
    ]
    visual.sort(key=lambda item: int(item[1]["timeline_start_us"]))
    overlays = [
        segment for segment in segments
        if segment["asset_kind"] != "audio" and segment.get("track_id", "V1") != "V1" and not segment.get("track_hidden")
    ]

    # 图项序列：黑底填充 + 段；转场仅在时间序后继首尾相接时激活（休眠转场 = 无转场）
    graph_items: list[dict[str, Any]] = []
    cursor_us = 0
    for position, (input_index, segment) in enumerate(visual):
        start_us = int(segment["timeline_start_us"])
        if start_us > cursor_us:
            graph_items.append({"kind": "black", "duration_us": start_us - cursor_us})
        active_transition = None
        transition = segment.get("transition_in")
        if isinstance(transition, dict) and position + 1 < len(visual):
            successor = visual[position + 1][1]
            if int(successor["timeline_start_us"]) == int(segment["timeline_end_us"]):
                active_transition = transition
        graph_items.append({
            "kind": "segment", "input_index": input_index, "segment": segment,
            "transition_in": active_transition,
        })
        cursor_us = max(cursor_us, int(segment["timeline_end_us"]))

    def _span_us(item: dict[str, Any]) -> int:
        if item["kind"] == "black":
            return int(item["duration_us"])
        return int(item["segment"]["timeline_end_us"]) - int(item["segment"]["timeline_start_us"])

    # 输出区段表（与权威端 build_timeline_args 合并循环同构；offset/窗口在此单点解析）
    regions: list[dict[str, Any]] = []
    if graph_items:
        acc = _span_us(graph_items[0])
        regions.append({"t0": 0, "t1": acc, "item": graph_items[0], "phase": "full"})
        for position in range(1, len(graph_items)):
            item = graph_items[position]
            previous = graph_items[position - 1]
            if previous["kind"] == "segment" and isinstance(previous.get("transition_in"), dict):
                duration_us = int(previous["transition_in"]["duration_us"])
                offset_us = acc - duration_us
                if offset_us <= 0:
                    raise _unsupported("转场区间超出相邻片段有效时长（与权威端一致硬失败）")
                if item["kind"] != "segment":
                    raise _unsupported("转场后继片段缺失（与权威端一致硬失败）")
                next_tail_us = (
                    int(item["segment"]["transition_in"]["duration_us"])
                    if isinstance(item["segment"].get("transition_in"), dict) else 0
                )
                if next_tail_us > 0:
                    raise _fail(item["segment"]["clip_id"], "链接转场（后继段同时锚定下一转场）不在实时合成子集")
                right_span = _span_us(item)
                regions.append({"t0": offset_us, "t1": acc, "item": item, "phase": "blend",
                                "blend": {"kind": previous["transition_in"]["kind"],
                                          "offset_us": offset_us, "duration_us": duration_us}})
                regions.append({"t0": acc, "t1": acc + (right_span - duration_us), "item": item,
                                "phase": "body", "head_us": duration_us})
                acc = acc + (right_span - duration_us)
            else:
                regions.append({"t0": acc, "t1": acc + _span_us(item), "item": item, "phase": "full"})
                acc += _span_us(item)

    region_t0_by_id: dict[str, float] = {}
    for region in regions:
        if region["item"]["kind"] == "segment" and region["phase"] in ("full", "body"):
            region_t0_by_id.setdefault(region["item"]["segment"]["clip_id"], region["t0"])

    def segment_frame(segment: dict[str, Any], t_exact_us: float, phase: str,
                      head_us: int = 0, content_origin_us: float | None = None) -> dict[str, Any]:
        input_id = segment_input[segment["clip_id"]]
        geometry = geometry_by_input[input_id]
        keyframes = segment.get("keyframes") if isinstance(segment.get("keyframes"), dict) else None
        origin_us = region_t0_by_id.get(segment["clip_id"], float(segment["timeline_start_us"])) if content_origin_us is None else content_origin_us
        t_seg_us = max(0, t_exact_us - origin_us)
        if phase == "blend":
            # 头部借用路径（窗口 (0, …)）：源从 source_start 起播，blend 相对时间 = t − offset。
            speed_milli = int(segment.get("speed_milli", 1000))
            blend_elapsed = t_exact_us - origin_us
            src_n = _source_frame_n(segment, int(segment["timeline_start_us"]) + blend_elapsed, 0)
        elif phase == "body":
            speed_milli = int(segment.get("speed_milli", 1000))
            src_n = _source_frame_n(segment, int(segment["timeline_start_us"]) + t_seg_us, round(head_us * speed_milli / 1000))
        else:
            src_n = _source_frame_n(segment, int(segment["timeline_start_us"]) + t_seg_us, 0)
        shift_dx = shift_dy = 0.0
        if keyframes and "position" in keyframes:
            x = _lerp_channel(keyframes["position"]["frames"], t_seg_us, "x")
            y = _lerp_channel(keyframes["position"]["frames"], t_seg_us, "y")
            # 权威端：overlay x='(W-w)/2 + x*(W/2)'；段内容已全画布 → 等价整体平移
            shift_dx = x * (width / 2)
            shift_dy = y * (height / 2)
        content_x, content_y, content_w, content_h = _fit_content_box(geometry, width, height)
        return {
            "clip_id": segment["clip_id"], "input_id": input_id,
            "src_n": src_n,
            "src_t_us": int(src_n * 1_000_000 / FPS),
            "content": {"x": content_x, "y": content_y, "w": content_w, "h": content_h},
            "shift": {"dx": round(shift_dx, 3), "dy": round(shift_dy, 3)},
            "alpha": round(_opacity_alpha(keyframes, t_seg_us), 6),
        }

    total_us = regions[-1]["t1"] if regions else max((int(segment["timeline_end_us"]) for segment in segments), default=0)
    total_frames = -(-int(total_us) * FPS // 1_000_000)

    frames = []
    for n in range(total_frames):
        t_us = n * 1_000_000 // FPS
        t_exact_us = n * 1_000_000 / FPS
        region = None
        for candidate in reversed(regions):
            if candidate["t0"] <= t_exact_us < candidate["t1"]:
                region = candidate
                break
        if region is None or region["item"]["kind"] == "black":
            main_entry: dict[str, Any] = {"kind": "black"}
        else:
            item = region["item"]
            segment = item["segment"]
            if region["phase"] == "blend":
                blend = region["blend"]
                p = (t_exact_us - blend["offset_us"]) / blend["duration_us"]
                main_entry = {
                    "kind": "transition",
                    "transition": blend["kind"],
                    "p": round(min(max(p, 0.0), 1.0), 6),
                    "left": segment_frame(_anchor_of(regions, region), t_exact_us, "full"),
                    "right": segment_frame(segment, t_exact_us, "blend", head_us=blend["duration_us"],
                                           content_origin_us=blend["offset_us"]),
                }
            else:
                main_entry = {"kind": "segment", **segment_frame(segment, t_exact_us, region["phase"], head_us=region.get("head_us", 0),
                                                                 content_origin_us=region["t0"])}
        overlay_entries = []
        for segment in overlays:
            start_us = int(segment["timeline_start_us"])
            end_us = int(segment["timeline_end_us"])
            if t_exact_us < start_us or t_exact_us > end_us:
                continue  # enable=between(t, start, end) 含边界
            box_x, box_y, pip_w, pip_h, rotation = _pip_box(
                segment, geometry_by_input[segment_input[segment["clip_id"]]], width, height)
            overlay_entries.append({
                "clip_id": segment["clip_id"],
                "input_id": segment_input[segment["clip_id"]],
                "src_n": _source_frame_n(segment, t_exact_us, 0),
                "src_t_us": int(_source_frame_n(segment, t_exact_us, 0) * 1_000_000 / FPS),
                "box": {"x": round(box_x, 3), "y": round(box_y, 3), "w": pip_w, "h": pip_h},
                "rotation_deg": rotation,
                # 权威端 _pip_overlay_chain 不消费 transform.opacity（已知近似清单）
                "alpha": 1.0,
            })
        active_captions = [
            caption["caption_id"] for caption in plan["captions"]["items"]
            if int(caption["start_us"]) <= t_exact_us <= int(caption["end_us"])
        ]
        frames.append({"n": n, "t_us": t_us, "main": main_entry,
                       "overlays": overlay_entries, "captions": active_captions})

    return {
        "schema": IR_SCHEMA,
        "projector_version": IR_PROJECTOR_VERSION,
        "generated_from": {
            "compiler_version": plan["compiler_version"],
            "content_fingerprint": plan["content_fingerprint"],
            "mode": plan["mode"],
        },
        "canvas": {
            "width": width, "height": height, "fps": FPS,
            "duration_frames": total_frames, "duration_us": total_us,
            "background": plan.get("canvas_background_color", "#000000"),
        },
        "inputs": inputs,
        "segments": [
            {
                "clip_id": segment["clip_id"], "track_id": segment["track_id"],
                "input_id": segment["input_id"],
                "source_start_us": segment["source_start_us"], "source_end_us": segment["source_end_us"],
                "timeline_start_us": segment["timeline_start_us"], "timeline_end_us": segment["timeline_end_us"],
                "layout": segment["layout"], "speed_milli": segment.get("speed_milli", 1000),
            }
            for segment in segments
        ],
        "captions": plan["captions"]["items"],
        "caption_styles": caption_styles or {},
        "transition_windows": [
            {"clip_id": region["item"]["segment"]["clip_id"], **region["blend"]}
            for region in regions if region.get("blend")
        ],
        "known_approximations": [
            "opacity 关键帧 = fade=alpha=1:st=0:d=末关键帧t 整体渐入近似（权威端实际行为，非 lerp）",
            "PiP overlay 忽略 transform.opacity（_pip_overlay_chain 未消费）",
            "字幕帧文本光栅化 libass vs 浏览器（单独口径：bbox IoU + diff 比率）",
        ],
        "frames": frames,
    }
