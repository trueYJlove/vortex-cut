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

from ..performance import measured
from ..projects import DomainError
from .interval_index import IntervalLookup, RegionSweep

FPS = 30
IR_SCHEMA = "preview-ir-v1"
# **投影语义变更 ⇒ 必须升版本**：版本号是唯一的跨版本失效机制（磁盘缓存按
# projector_version 比对）。语义变了不升，旧条目会带着旧逻辑被重新采信，
# 表现为「改了没反应」——这不是靠人记得，而是靠这里必须动。
# v5（2026-11-03）：输入 geometry 携带显示方向——新增 display_width/display_height/
# rotation（width/height 仍表示解码平面尺寸，供纹理上传）；_fit_content_box 与
# crop_fill 改为**按显示方向**计算内容盒（竖拍素材不再被当成横版铺满画布）；
# ffprobe 旋转解析改为扫描整个 side_data_list（iPhone 的 side_data_list[0] 是
# Dolby Vision 记录，只看 [0] 取不到 rotation）。旧条目缺 display_* ⇒ 旧布局语义，
# 必须整体失效。
# v4（2026-10-10）：主轨空时以可见覆盖轨终点作时长下限（对齐权威端「全程黑场+
# 覆盖轨叠加」）；v3（2026-09-17 v0.4）：覆盖轨 mask/keying 重入（overlay 条目携带 effects）。
IR_PROJECTOR_VERSION = 5
MAX_IR_FRAMES = 27_000  # 15 分钟 @30fps（O2 体量护栏）

ALLOWED_KEYFRAME_PROPS = {"position", "opacity", "scale", "rotate"}
ALLOWED_TRANSITIONS = {"fade", "fadeblack"}
ALLOWED_MAIN_LAYOUTS = {"fit", "blurred_background", "crop_fill"}


def _fail(clip_id: str, what: str) -> DomainError:
    return DomainError("PREVIEW_IR_UNSUPPORTED", f"段 {clip_id}: {what} 超出实时合成子集")


def _unsupported(what: str) -> DomainError:
    return DomainError("PREVIEW_IR_UNSUPPORTED", what)


def _split_overlapped_inputs(
    plan: dict[str, Any],
    inputs: list[dict[str, Any]],
    segment_input: dict[str, str],
    geometry_by_input: dict[str, dict[str, Any]],
) -> dict[str, str]:
    """重叠可视段分配复制输入（W4，见调用处注释）。

    判定 = timeline 窗口与**其他可视 segment**重叠（同轨重叠被时间线契约
    禁止，实际即跨轨）。窗口完全相同的双位置（V1+V2 同素材同窗）也视为
    重叠——两消费位置相同但各自需要稳定槽位语义，统一拆分。
    首个消费者保持原 input；同素材第 n 个重叠消费者得 `I<k>~n`。
    inputs 列表按需追加同 asset/geometry 条目（会话按条目建 rig，ticket
    按 asset_id 解析不变）。
    """
    visual = [
        segment for segment in plan["segments"]
        if segment["asset_kind"] != "audio" and not segment.get("track_hidden")
    ]
    if len(visual) < 2:
        return segment_input
    by_input: dict[str, list[dict[str, Any]]] = {}
    for segment in visual:
        by_input.setdefault(segment["input_id"], []).append(segment)
    result = dict(segment_input)
    for input_id, segments in by_input.items():
        if len(segments) < 2:
            continue
        # 输入内两两判重叠（每输入段数小，O(k²) 可接受）
        overlapped_flags = [False] * len(segments)
        for i, seg_i in enumerate(segments):
            for j in range(i + 1, len(segments)):
                seg_j = segments[j]
                if (
                    int(seg_i["timeline_start_us"]) < int(seg_j["timeline_end_us"])
                    and int(seg_j["timeline_start_us"]) < int(seg_i["timeline_end_us"])
                ):
                    overlapped_flags[i] = True
                    overlapped_flags[j] = True
        if not any(overlapped_flags):
            continue
        # 重叠组成员按 plan 顺序编号：首成员保持原 input，其余 ~1..~n
        members = [seg for seg, flag in zip(segments, overlapped_flags) if flag]
        base_input = next(item for item in inputs if item["input_id"] == input_id)
        for ordinal, seg in enumerate(members):
            if ordinal == 0:
                continue
            new_input_id = f"{input_id}~{ordinal}"
            result[seg["clip_id"]] = new_input_id
            inputs.append({**base_input, "input_id": new_input_id})
            geometry_by_input[new_input_id] = geometry_by_input[input_id]
    return result


def _validate_whitelist(plan: dict[str, Any]) -> None:
    for segment in plan["segments"]:
        clip_id = segment["clip_id"]
        # v0.4 重入：覆盖轨 mask/keying 放行（合成器 shader 内逐像素算 alpha，
        # 语义对齐 _mask_alpha_expr / colorkey）；主轨（V1）权威端不消费这两个
        # 字段，保持拒绝并明示原因。
        if segment.get("mask") and segment["track_id"] == "V1":
            raise _fail(clip_id, "主轨蒙版（蒙版仅覆盖轨支持实时合成）")
        if segment.get("keying") and segment["track_id"] == "V1":
            raise _fail(clip_id, "主轨抠像（抠像仅覆盖轨支持实时合成）")
        if segment.get("reframe"):
            raise _fail(clip_id, "reframe（重构图）")
        if segment.get("reverse_playback"):
            raise _fail(clip_id, "reverse_playback（倒放）")
        if segment.get("track_hidden"):
            raise _fail(clip_id, "track_hidden（隐藏轨）")
        if segment["asset_kind"] not in ("video", "audio"):
            raise _fail(clip_id, f"asset_kind={segment['asset_kind']}（图片素材暂不支持实时合成预览）")
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
        # B4 收官后预览子集放开 style_override：数值样式随 per-caption 覆盖
        # 解析（_caption_override_style），合成器 Canvas 消费——预览=导出。
        # 结构性字段（font_name 自由串/pos 坐标）仍维持"仅权威预览"：
        # font_name 需 FontFace 注册链路，pos 需合成器坐标换算，均为独立增量。
        override = caption.get("style_override")
        if isinstance(override, dict):
            structural = {
                key for key in ("font_name", "pos_x", "pos_y")
                if override.get(key) is not None
            }
            if structural:
                raise _unsupported(
                    f"字幕 {caption['caption_id']}: style_override 结构性字段 "
                    f"{sorted(structural)} 超出实时合成子集")


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
    # 用 display_*（旋转后方向）；缺字段回落原始值（老 IR 兼容）。
    disp_w_raw = int(geometry.get("display_width") or geometry["width"])
    disp_h_raw = int(geometry.get("display_height") or geometry["height"])
    disp_w = disp_w_raw * geometry["sar"]
    scale = min(width / disp_w, height / disp_h_raw)
    content_w = int(round(disp_w * scale / 2) * 2)
    content_h = int(round(disp_h_raw * scale / 2) * 2)
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


def resolved_caption_styles(presets: dict[str, Any],
                            default_font_family: str | None = None) -> dict[str, dict[str, Any]]:
    """预设 → 数值样式（Core 单点解析，Renderer 端只消费；PlayRes = 渲染画布）。

    多字体：default_font_family（bundle 默认族名）随样式下发——Renderer
    Canvas 按注册 FontFace 名取用（与导出 ASS Fontname 同源）。"""
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
            **({"font_family": default_font_family} if default_font_family else {}),
        }
    return resolved


# 预览子集放行的 style_override 数值字段（B4 收官；结构性字段 font_name/
# pos_x/pos_y 仍"仅权威预览"，见 _validate_whitelist）。
_CAPTION_OVERRIDE_STYLE_KEYS = (
    "font_size", "primary_color", "outline_color", "outline",
    "alignment", "margin_v", "letter_spacing", "bold", "italic", "underline",
    "back_color", "border_style", "shadow", "fx_preset",
)


def caption_override_style(caption: dict[str, Any]) -> dict[str, Any] | None:
    """字幕 style_override → 预览可消费的数值样式覆盖（逐字段与预设合并）。

    返回 None = 无覆盖（消费预设）。alpha 位仅气泡底衬（back_color）消费。"""
    override = caption.get("style_override")
    if not isinstance(override, dict) or not override:
        return None
    style: dict[str, Any] = {}
    if override.get("font_size") is not None:
        style["font_size"] = int(override["font_size"])
    for color_key, rgb_key in (("primary_color", "primary_rgb"),
                               ("outline_color", "outline_rgb"),
                               ("back_color", "back_rgb")):
        value = override.get(color_key)
        if value is not None:
            style[rgb_key] = _parse_ass_color(value)
    if override.get("outline") is not None:
        style["outline"] = int(override["outline"])
    if override.get("shadow") is not None:
        style["shadow"] = int(override["shadow"])
    if override.get("border_style") is not None:
        style["border_style"] = int(override["border_style"])
    if override.get("margin_v") is not None:
        style["margin_v"] = int(override["margin_v"])
    if override.get("letter_spacing") is not None:
        style["letter_spacing"] = float(override["letter_spacing"])
    for flag in ("bold", "italic", "underline"):
        if override.get(flag) is not None:
            style[flag] = bool(override[flag])
    if override.get("alignment") is not None:
        style["alignment"] = int(override["alignment"])
    if override.get("fx_preset") is not None:
        style["fx_preset"] = str(override["fx_preset"])
    return style or None


def _anchor_of(regions: list[dict[str, Any]], blend_region: dict[str, Any]) -> dict[str, Any]:
    """转场锚点段 = blend 区段之前、时间上覆盖 blend 窗口的段区段。
    （A04 后生产路径走 RegionSweep.anchor_region 的构造期预映射；本函数
    保留为扫线语义的测试 oracle——见 test_render_ir_index。）"""
    index = regions.index(blend_region)
    for candidate in reversed(regions[:index]):
        if candidate["item"]["kind"] == "segment" and candidate["t0"] <= blend_region["t0"]:
            return candidate["item"]["segment"]
    raise _unsupported("转场锚点段缺失")


@measured("ir_project")
def project_preview_ir(plan: dict[str, Any], probes: dict[str, dict[str, Any]],
                       caption_styles: dict[str, Any] | None = None) -> dict[str, Any]:
    _validate_whitelist(plan)
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])

    inputs: list[dict[str, Any]] = []
    geometry_by_input: dict[str, dict[str, Any]] = {}
    for item in plan["inputs"]:
        # 纯音频输入（A1）：无视频流，几何占位（合成器不消费；音频走前端 WebAudio）。
        if item["asset_kind"] == "audio":
            geometry = {"width": 0, "height": 0, "sar": 1.0}
        else:
            stream = ((probes.get(item["asset_id"]) or {}).get("video_streams") or [None])[0]
            if stream is None:
                raise _unsupported(f"input {item['asset_id']} 缺少输入流几何（ffprobe）")
            sar_text = str(stream.get("sample_aspect_ratio") or "1:1")
            try:
                num, den = sar_text.replace("/", ":").split(":")
                sar = float(num) / float(den) if float(den) > 0 else 1.0
            except ValueError:
                sar = 1.0
            # **旋转感知 geometry**（P206/P212，2026-11-03 实测定案）：
            # width/height = 解码平面的原始方向（合成器上传纹理用，
            # frame_decode 的 -noautorotate 保证平面就是这个方向）；
            # display_width/display_height = 按 display matrix 换轴后的**显示方向**
            # （布局 fit/cover 必须用它算内容盒）。
            # 混淆二者会导致两种真机缺陷：用原始尺寸算布局 ⇒ 竖拍素材被当成
            # 16:9 横版铺进 9:16 画布，合成器把竖画面横向拉伸（2026-11-03 用户
            # 截图确认）；用显示尺寸上传纹理 ⇒ 行宽错位花屏（更早踩过）。
            raw_w = int(stream.get("width") or 0)
            raw_h = int(stream.get("height") or 0)
            rot = int(stream.get("rotation") or 0) % 360
            swapped = rot in (90, 270)
            geometry = {
                "width": raw_w, "height": raw_h, "sar": sar, "rotation": rot,
                "display_width": raw_h if swapped else raw_w,
                "display_height": raw_w if swapped else raw_h,
            }
        # P203：HDR 标记随 input 下发。理由：前端 WebCodecs 路径解 10-bit HLG
        # 在部分 GPU 上会产出 format=null 的坏帧并让渲染进程永久堵死，而产品
        # 此前**连素材是不是 HDR 都不知道**，无法在点播放前提示用户。
        # 判定只看 transfer（PQ=smpte2084 / HLG=arib-std-b67）；缺失或其它值
        # 一律按 SDR（保守：宁可漏报，不能把 SDR 误报成 HDR 造成虚假告警）。
        color_transfer = None if item["asset_kind"] == "audio" else (
            ((probes.get(item["asset_id"]) or {}).get("video_streams") or [{}])[0].get("color_transfer")
        )
        inputs.append({
            "input_id": item["input_id"], "asset_id": item["asset_id"],
            "asset_kind": item["asset_kind"], "duration_us": item["duration_us"],
            "has_audio": item["has_audio"], "geometry": geometry,
            "hdr": color_transfer in ("smpte2084", "arib-std-b67"),
        })
        geometry_by_input[item["input_id"]] = geometry
    segment_input = {segment["clip_id"]: segment["input_id"] for segment in plan["segments"]}

    # GAP-CROSS-TRACK-OVERLAP（2026-09-15 缺陷批 W4）：同素材跨轨重叠片段
    # 共享一个 input → 会话侧共享一个环形纹理池（深 8）+ 单调解码链——两个
    # 相距 >8 帧的源消费位置互相淘汰槽位，frameReady 永假，播放头停滞。
    # 投影层拆分：可视 segments 中与**其他可视 segment**（任意轨道）timeline
    # 重叠者，自第二份起分配复制输入（input_id 加后缀），桌面侧各得独立
    # worker/环池。首个消费者保持原 input——非重叠同素材复用不变（F03 三窗口、
    # F07 速度矩阵仍是单输入）；音频/A1 不在此列（无视觉装配）。权威渲染
    # 路径零影响（本函数仅服务预览投影）。
    segment_input = _split_overlapped_inputs(plan, inputs, segment_input, geometry_by_input)

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
    borrow_points: list[tuple[int, int]] = []  # (输入时间轴借用点 = 左段终点, 借用量)
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
                borrow_points.append((int(segment["timeline_end_us"]), int(transition["duration_us"])))
        graph_items.append({
            "kind": "segment", "input_index": input_index, "segment": segment,
            "transition_in": active_transition,
        })
        cursor_us = max(cursor_us, int(segment["timeline_end_us"]))

    def _output_window(segment: dict[str, Any]) -> tuple[int, int]:
        """段在**输出时间轴**上的窗口：转场借用在输入时间轴上是阶跃前移——
        借用点（左段终点）及之后开始的段整体前移借用量。前端音频调度消费
        本窗口（帧表 t_us 亦为输出时间轴，原 timeline_* 是输入时间轴）。
        跨越借用点的段按整体不前移近似（音频跨越主轨转场的已知近似）。"""
        shift = sum(borrow for point, borrow in borrow_points if int(segment["timeline_start_us"]) >= point)
        return (int(segment["timeline_start_us"]) - shift, int(segment["timeline_end_us"]) - shift)

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
        # 静态 transform（V1 主轨，与权威端 visual_chain 静态变换对齐）：
        # 内容盒 × scale，中心点 (cx·W, cy·H)；rotate 度数；opacity 乘入 alpha。
        static_scale = 1.0
        static_cx, static_cy = 0.5, 0.5
        static_rotate = 0.0
        static_alpha = 1.0
        transform = segment.get("transform")
        if isinstance(transform, dict) and transform:
            try:
                static_scale = min(max(float(transform.get("scale", 1.0)), 0.05), 5.0)
                static_cx = min(max(float(transform.get("x", 0.5)), 0.0), 1.0)
                static_cy = min(max(float(transform.get("y", 0.5)), 0.0), 1.0)
                static_rotate = float(transform.get("rotate", 0.0))
                static_alpha = min(max(float(transform.get("opacity", 1.0)), 0.0), 1.0)
            except (TypeError, ValueError):
                pass
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
        rotation_deg = static_rotate
        if keyframes and "position" in keyframes:
            x = _lerp_channel(keyframes["position"]["frames"], t_seg_us, "x")
            y = _lerp_channel(keyframes["position"]["frames"], t_seg_us, "y")
            # 权威端：关键帧平移作用于静态变换前的全画布内容，
            # 静态 scale 缩放整个画面 → 平移量随静态缩放同比例收缩（近似，组合场景文档已记）
            shift_dx = x * (width / 2) * static_scale
            shift_dy = y * (height / 2) * static_scale
        if keyframes and "rotate" in keyframes:
            # rotate 关键帧真实可见：绕画布中心旋转，角落为黑（透明→yuv 黑）
            rotation_deg += _lerp_channel(keyframes["rotate"]["frames"], t_seg_us, "v")
        # scale 关键帧：权威端逐帧 scale 后被静态归一化（scale=min(iw,W)+pad，为 concat
        # 段一致）完全抵消——渲染为无视觉效果（M3-0 实证：f=0.5/1.5 内容边界恒全画布）。
        # IR 不携带 scale，合成器一致忽略；UI 数值语义与渲染不一致属权威端已知限制。
        # 布局分派（B4 追加）：fit/blurred_background = contain 缩进+黑边居中；
        # crop_fill = cover 等比放大到短边顶满、长边溢出裁切（语义对齐
        # _visual_filter("crop_fill"): force_original_aspect_ratio=increase+crop）。
        if segment.get("layout") == "crop_fill":
            disp_w_full = int(geometry.get("display_width") or geometry["width"]) * geometry["sar"]
            disp_h_full = int(geometry.get("display_height") or geometry["height"])
            cover_scale = max(width / disp_w_full, height / disp_h_full)
            cover_w = int(round(disp_w_full * cover_scale / 2) * 2)
            cover_h = int(round(disp_h_full * cover_scale / 2) * 2)
            content_x, content_y = (width - cover_w) // 2, (height - cover_h) // 2
            content_w, content_h = cover_w, cover_h
        else:
            content_x, content_y, content_w, content_h = _fit_content_box(geometry, width, height)
        if static_scale != 1.0 or static_cx != 0.5 or static_cy != 0.5:
            content_w = max(2, int(round(content_w * static_scale / 2) * 2))
            content_h = max(2, int(round(content_h * static_scale / 2) * 2))
            content_x = int(static_cx * width - content_w / 2)
            content_y = int(static_cy * height - content_h / 2)
        return {
            "clip_id": segment["clip_id"], "input_id": input_id,
            "src_n": src_n,
            "src_t_us": int(src_n * 1_000_000 / FPS),
            "content": {"x": content_x, "y": content_y, "w": content_w, "h": content_h},
            "shift": {"dx": round(shift_dx, 3), "dy": round(shift_dy, 3)},
            "alpha": round(_opacity_alpha(keyframes, t_seg_us) * static_alpha, 6),
            "rotation_deg": round(rotation_deg, 4),
            # 主轨布局（blurred_background = 模糊垫底 + fit 内容；合成器消费）。
            "layout": segment.get("layout", "fit"),
        }

    # 输出时长：可视化区段终点与 A1 纯音频窗口终点取大——音频长于画面时以
    # 黑场延长输出（前端合成器对越界帧渲染黑场，音频照常调度）。
    # 主轨为空（V1 无可见视频段）时以**可见覆盖轨终点**作时长下限：权威端对
    # 同形态输出「全程黑场 + 覆盖轨照常叠加」（ffmpeg.py 空主轨黑场分支，
    # 时长 = 全时间线，含覆盖轨终点），预览必须同语义——缺失时 total_frames=0
    # → play() 首个 tick 即结束、静默无任何提示（W2.6 末条登记缺陷）。
    # V1 非空时不取覆盖轨终点：权威端视频长度 = 主轨链长，覆盖轨窗口超出
    # 主画面的部分被 overlay 主输入时长截断，预览保持一致。
    audio_tail_end = max(
        (_output_window(segment)[1] for segment in segments
         if segment["asset_kind"] == "audio" and not segment.get("track_hidden")),
        default=0,
    )
    overlay_tail_end = (
        max((int(segment["timeline_end_us"]) for segment in overlays), default=0)
        if not visual else 0
    )
    total_us = max(regions[-1]["t1"] if regions else 0, audio_tail_end, overlay_tail_end)
    total_frames = -(-int(total_us) * FPS // 1_000_000)
    # O2 体量护栏（M3-2）：全量逐帧数值表按帧数线性增长，超长时间线先拒绝，
    # 分页/按需投影留待后续增量（设计 §7-O2）。
    if total_frames > MAX_IR_FRAMES:
        raise DomainError(
            "PREVIEW_IR_TOO_LARGE",
            f"时间线输出 {total_frames} 帧超出实时合成预览上限 {MAX_IR_FRAMES} 帧",
        )

    frames = []
    # A04 扫线索引（投影开始时建一次）：主轨 region 扫线（半开 + 倒序命中
    # 语义 + 锚点预映射）；overlays/captions 含端 lookup（输出保持原顺序）。
    region_sweep = RegionSweep(regions)
    overlay_lookup = IntervalLookup([
        (int(segment["timeline_start_us"]), int(segment["timeline_end_us"]), (order, segment))
        for order, segment in enumerate(overlays)
    ])
    caption_lookup = IntervalLookup([
        (int(caption["start_us"]), int(caption["end_us"]), (order, caption))
        for order, caption in enumerate(plan["captions"]["items"])
    ])
    for n in range(total_frames):
        t_us = n * 1_000_000 // FPS
        t_exact_us = n * 1_000_000 / FPS
        region = region_sweep.next_region(t_exact_us)
        if region is None or region["item"]["kind"] == "black":
            main_entry: dict[str, Any] = {"kind": "black"}
        else:
            item = region["item"]
            segment = item["segment"]
            if region["phase"] == "blend":
                blend = region["blend"]
                p = (t_exact_us - blend["offset_us"]) / blend["duration_us"]
                anchor_segment = region_sweep.anchor_region(region)["item"]["segment"]
                main_entry = {
                    "kind": "transition",
                    "transition": blend["kind"],
                    "p": round(min(max(p, 0.0), 1.0), 6),
                    "left": segment_frame(anchor_segment, t_exact_us, "full"),
                    "right": segment_frame(segment, t_exact_us, "blend", head_us=blend["duration_us"],
                                           content_origin_us=blend["offset_us"]),
                }
            else:
                main_entry = {"kind": "segment", **segment_frame(segment, t_exact_us, region["phase"], head_us=region.get("head_us", 0),
                                                                 content_origin_us=region["t0"])}
        overlay_entries = []
        for segment in overlay_lookup.next_batch(t_exact_us):
            box_x, box_y, pip_w, pip_h, rotation = _pip_box(
                segment, geometry_by_input[segment_input[segment["clip_id"]]], width, height)
            entry = {
                "clip_id": segment["clip_id"],
                "input_id": segment_input[segment["clip_id"]],
                "src_n": _source_frame_n(segment, t_exact_us, 0),
                "src_t_us": int(_source_frame_n(segment, t_exact_us, 0) * 1_000_000 / FPS),
                "box": {"x": round(box_x, 3), "y": round(box_y, 3), "w": pip_w, "h": pip_h},
                "rotation_deg": rotation,
                # 权威端 _pip_overlay_chain 不消费 transform.opacity（已知近似清单）
                "alpha": 1.0,
            }
            # v0.4：覆盖轨 mask/keying 静态参数随 overlay 条目携带（不随帧变化，
            # 合成器 shader 内逐像素算 alpha）。字段原样透传（白名单校验已确认
            # schema），合成器端按 _mask_alpha_expr / colorkey 同构语义消费。
            effects: dict[str, Any] = {}
            if isinstance(segment.get("mask"), dict) and segment["mask"]:
                effects["mask"] = segment["mask"]
            if isinstance(segment.get("keying"), dict) and segment["keying"]:
                effects["keying"] = segment["keying"]
            if effects:
                entry["effects"] = effects
            overlay_entries.append(entry)
        active_captions = [
            caption["caption_id"] for caption in caption_lookup.next_batch(t_exact_us)
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
                "input_id": segment_input[segment["clip_id"]] if segment["asset_kind"] != "audio" else segment["input_id"],
                "source_start_us": segment["source_start_us"], "source_end_us": segment["source_end_us"],
                "timeline_start_us": segment["timeline_start_us"], "timeline_end_us": segment["timeline_end_us"],
                "output_start_us": _output_window(segment)[0], "output_end_us": _output_window(segment)[1],
                "layout": segment["layout"], "speed_milli": segment.get("speed_milli", 1000),
            }
            for segment in segments
        ],
        "captions": plan["captions"]["items"],
        "caption_styles": caption_styles or {},
        # B4 收官：per-caption 数值样式覆盖（合成器 Canvas 消费；预览=导出）。
        "caption_override_styles": {
            caption["caption_id"]: style
            for caption in plan["captions"]["items"]
            if (style := caption_override_style(caption)) is not None
        },
        "transition_windows": [
            {"clip_id": region["item"]["segment"]["clip_id"], **region["blend"]}
            for region in regions if region.get("blend")
        ],
        "known_approximations": [
            "opacity 关键帧 = fade=alpha=1:st=0:d=末关键帧t 整体渐入近似（权威端实际行为，非 lerp）",
            "scale 关键帧 = 无视觉效果（逐帧 scale 被静态归一化 scale=min(iw,W)+pad 完全抵消；M3-0 实证 bbox 恒全画布）——IR 与合成器一致忽略",
            "PiP overlay 忽略 transform.opacity（_pip_overlay_chain 未消费）",
            "字幕帧文本光栅化 libass vs 浏览器（单独口径：bbox IoU + diff 比率）",
            "A1 音频窗口按段起点取借用位移；跨越主轨转场借用点的音频段不做分段重映射",
            "blurred_background 垫底 = 两级降采样(÷4→÷16)线性放大近似 gblur sigma=20",
            "keying.invert 权威端 alpha 链不消费——合成器同语义忽略（蒙版 invert 正常生效）",
        ],
        "frames": frames,
    }
