"""M3-0 中立 IR 投影器（P2，冻结方案 §7.2，ZhangSan 范围）。

从生产 RenderPlanCompiler 输出投影"渲染计划中立 JSON"草案（schema 仅本探针使用，
不冻结、不进契约）。要点：
- 白名单硬失败（R11）：遇 mask/keying/reframe、scale/rotate 关键帧、reverse、
  非 fade/fadeblack 转场、非 V1 关键帧、链接转场（next_tail>0）等子集外语义直接 raise；
- IR 携带按 30fps 展开的解析后逐帧数值表 + 已解析转场窗口/offset：
  插值、借用式 offset、黑底填充收敛到 Core 单点，两端（FFmpeg 基准端 /
  WebGL 合成器）只做"应用"（直接支撑 R4）；
- inputs 增补输入视频流几何（width/height/SAR，来自 ffprobe）——PiP 内容盒必需；
- opacity 关键帧按 ffmpeg.py 实际权威行为复刻整体 fade 近似
  （fade=alpha=1:st=0:d=末关键帧t，恒 0→1 渐入），而非"真 lerp"。

输出区段模型（与 build_timeline_args 的合并循环同构）：
  full   : [t0,t1) 该段完整链（源 trim→布局→关键帧动画）
  blend  : [offset, offset+T) xfade 混合窗口；p=(t-offset)/T；右输入=后继段头部借用
  body   : [offset+T, offset+T+body_len) 后继段剩余主体 concat 接回
  black  : 时间线空隙黑底填充

用法：python ir_projector.py <plan.json> <ffprobe.json> <输出 ir.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

FPS = 30
IR_SCHEMA = "m3-0-probe-ir-draft/1"
PROJECTOR_VERSION = "m3p2-ir-1"

ALLOWED_KEYFRAME_PROPS = {"position", "opacity"}
ALLOWED_TRANSITIONS = {"fade", "fadeblack"}
ALLOWED_MAIN_LAYOUTS = {"fit"}  # 主轨实测布局（blurred_background/crop_fill 不在 P2 实测画布）


class IrProjectionError(RuntimeError):
    """子集外语义硬失败（R11）。"""


def _fail(clip_id: str, what: str) -> IrProjectionError:
    return IrProjectionError(f"[R11 白名单硬失败] 段 {clip_id}: {what} 不在 P2 实测子集")


def _validate_whitelist(plan: dict) -> None:
    for segment in plan["segments"]:
        clip_id = segment["clip_id"]
        if segment.get("mask"):
            raise _fail(clip_id, "mask")
        if segment.get("keying"):
            raise _fail(clip_id, "keying")
        if segment.get("reframe"):
            raise _fail(clip_id, "reframe")
        if segment.get("reverse_playback"):
            raise _fail(clip_id, "reverse_playback")
        if segment.get("track_hidden"):
            raise _fail(clip_id, "track_hidden（隐藏轨不在实测子集）")
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
            raise IrProjectionError(f"[R11] 字幕 {caption['caption_id']}: style_override 不在实测子集")


def _lerp_channel(frames: list[dict], t_seg_us: int, key: str) -> float:
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


def _opacity_alpha(keyframes: dict | None, t_seg_us: int) -> float:
    """权威端实际行为：fade=alpha=1:st=0:d=末关键帧t（恒 0→1 渐入）。

    注意这不是 _lerp_expression 的 opacity 插值（该分支未参与渲染）——
    IR 与 WebGL 端必须复刻该近似，并记入"权威端已知近似"清单。
    """
    if not isinstance(keyframes, dict) or "opacity" not in keyframes:
        return 1.0
    d_us = int(keyframes["opacity"]["frames"][-1]["t_us"])
    if d_us <= 0:
        return 1.0
    return max(0.0, min(1.0, t_seg_us / d_us))


def _fit_content_box(geometry: dict, width: int, height: int) -> tuple[int, int, int, int]:
    """主轨 fit 布局内容盒（复刻 _visual_filter("fit")：等比缩进 + 黑边居中）。"""
    disp_w = geometry["width"] * geometry["sar"]
    scale = min(width / disp_w, height / geometry["height"])
    content_w = int(round(disp_w * scale / 2) * 2)
    content_h = int(round(geometry["height"] * scale / 2) * 2)
    return (width - content_w) // 2, (height - content_h) // 2, content_w, content_h


def _pip_box(segment: dict, geometry: dict, width: int, height: int) -> tuple[float, float, int, int]:
    """复刻 _pip_overlay_chain：内容盒 × transform.scale，中心点 (cx*W, cy*H)。"""
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


def _source_frame_n(segment: dict, t_exact_us: float, offset_from_us: float) -> int:
    """段内源帧号（绝对帧号，相对整个源文件）。offset_from_us：借用头部 body 相的源偏移（= T*speed）。

    语义对齐权威端：链内 fps=30 按"最新已到帧"hold —— 源位置为连续量，
    src_n = floor(源位置×30)（恰为整帧边界时取该帧）。repeatlast：源位置
    钳制到 [source_start, source_end − 1帧]。t_exact_us 用精确帧边界
    （n×1e6/30），避免向下取整的 µs 在整帧边界处提前一帧。
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
    """&Haabbggrr → [r, g, b]（alpha 不在 P2 基础样式范围）。"""
    body = str(value)[2:].strip("&")
    if len(body) != 8:
        return [255, 255, 255]
    rr, gg, bb = body[6:8], body[4:6], body[2:4]
    return [int(rr, 16), int(gg, 16), int(bb, 16)]


def _resolved_caption_styles(presets: dict) -> dict:
    """预设 → 数值样式（Core 单点解析，GL 端只消费；PlayRes = 渲染画布）。"""
    resolved = {}
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


def project(plan: dict, probes: dict[str, dict], caption_styles: dict | None = None) -> dict:
    _validate_whitelist(plan)
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])

    inputs = []
    geometry_by_input: dict[str, dict] = {}
    for item in plan["inputs"]:
        probe = probes.get(item["asset_id"])
        stream = ((probe or {}).get("video_streams") or [None])[0] if item["asset_kind"] != "audio" else None
        if stream is None:
            raise IrProjectionError(f"input {item['asset_id']} 缺少 ffprobe 视频流几何（冻结方案 B4 增补项）")
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
    graph_items: list[dict] = []
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

    def _span_us(item: dict) -> int:
        if item["kind"] == "black":
            return int(item["duration_us"])
        return int(item["segment"]["timeline_end_us"]) - int(item["segment"]["timeline_start_us"])

    # 输出区段表（与 ffmpeg.py 合并循环同构；offset/窗口在此单点解析）
    regions: list[dict] = []
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
                    raise IrProjectionError("转场区间超出相邻片段有效时长（与权威端一致硬失败）")
                if item["kind"] != "segment":
                    raise IrProjectionError("转场后继片段缺失（与权威端一致硬失败）")
                next_tail_us = (
                    int(item["segment"]["transition_in"]["duration_us"])
                    if isinstance(item["segment"].get("transition_in"), dict) else 0
                )
                if next_tail_us > 0:
                    raise _fail(item["segment"]["clip_id"], "链接转场（后继段同时锚定下一转场）不在实测子集")
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
    total_us = max((int(segment["timeline_end_us"]) for segment in segments), default=0)
    total_frames = -(-total_us * FPS // 1_000_000)

    # 段 → 内容输出起点（full/body 区段 t0）。转场借用压缩输出时间轴：
    # 后继段内容时间 = t − 区段t0（≠ t − timeline_start），与权威端链内 t 一致。
    region_t0_by_id: dict[str, float] = {}
    for region in regions:
        if region["item"]["kind"] == "segment" and region["phase"] in ("full", "body"):
            region_t0_by_id.setdefault(region["item"]["segment"]["clip_id"], region["t0"])

    def segment_frame(segment: dict, t_exact_us: float, phase: str, head_us: int = 0, content_origin_us: float | None = None) -> dict:
        input_id = segment_input[segment["clip_id"]]
        geometry = geometry_by_input[input_id]
        keyframes = segment.get("keyframes") if isinstance(segment.get("keyframes"), dict) else None
        origin_us = region_t0_by_id.get(segment["clip_id"], float(segment["timeline_start_us"])) if content_origin_us is None else content_origin_us
        t_seg_us = max(0, t_exact_us - origin_us)
        if phase == "blend":
            # 头部借用路径（窗口 (0, …)）：源从 source_start 起播，
            # blend 相对时间 = t − offset（content origin = offset）。
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
            main_entry: dict = {"kind": "black"}
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
        "projector_version": PROJECTOR_VERSION,
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
            "opacity 关键帧 = fade=alpha=1:st=0:d=末关键帧t 整体渐入近似（ffmpeg.py 实际行为，非 lerp）",
            "PiP overlay 忽略 transform.opacity（_pip_overlay_chain 未消费）",
            "transform.rotate 单位错位：数值被原样传给 ffmpeg rotate 滤镜（弧度参数），UI 度数语义在权威端被按弧度解释（P2 实证：8 度输入渲染为 8 弧度 ≈ 98° 旋转）——IR/GL 端复刻该实际行为",
            "V1 主轨 position 关键帧链缺陷：overlay 主输入为 d=timeline_total 黑底源（eof_action=repeat），段链被撑至时间线总长，concat 输出超长并冻结尾部（生产校验必失败；IR 按其实际输出语义投影）",
            "字幕帧文本光栅化 libass vs 浏览器（单独口径：bbox IoU + diff 比率）",
        ],
        "frames": frames,
    }


def _anchor_of(regions: list[dict], blend_region: dict) -> dict:
    """转场锚点段 = blend 区段之前、时间上覆盖 blend 窗口的段区段。"""
    index = regions.index(blend_region)
    for candidate in reversed(regions[:index]):
        if candidate["item"]["kind"] == "segment" and candidate["t0"] <= blend_region["t0"]:
            return candidate["item"]["segment"]
    raise IrProjectionError("转场锚点段缺失")


def main() -> None:
    plan_path = Path(sys.argv[1])
    probes_path = Path(sys.argv[2])
    out_path = Path(sys.argv[3])
    presets_path = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    probes = json.loads(probes_path.read_text(encoding="utf-8"))
    caption_styles = None
    if presets_path and presets_path.is_file():
        caption_styles = _resolved_caption_styles(json.loads(presets_path.read_text(encoding="utf-8")))
    ir = project(plan, probes, caption_styles)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
    frames = ir["frames"]
    print(f"[ok] ir.json → {out_path}")
    print(f"     frames={len(frames)} canvas={ir['canvas']['width']}x{ir['canvas']['height']}")
    print(f"     transition_windows={ir['transition_windows']}")
    print(f"     overlay_frames={sum(1 for f in frames if f['overlays'])} "
          f"transition_frames={sum(1 for f in frames if f['main']['kind'] == 'transition')} "
          f"black_frames={sum(1 for f in frames if f['main']['kind'] == 'black')} "
          f"caption_frames={sum(1 for f in frames if f['captions'])}")


if __name__ == "__main__":
    main()
