from __future__ import annotations

import copy
import hashlib
import re
import sqlite3
import unicodedata
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .projects import DomainError

LAYOUTS = {"blurred_background", "crop_fill", "fit"}
CAPTION_PRESETS = {"default-bottom", "game-safe-bottom", "high-contrast"}
CREATED_BY = {"user", "system", "import"}
PATCH_OPERATIONS = {
    "insert_asset_clip",
    "insert_transcript_segments",
    "remove_clip",
    "move_clip",
    "position_clip",
    "position_clips",
    "split_timeline_clips",
    "duplicate_timeline_items",
    "replace_clip_source",
    "trim_clip",
    "set_clip_source_window",
    "split_clip",
    "set_layout",
    "set_audio",
    "set_speed",
    "set_reverse_playback",
    "set_image_duration",
    "add_caption",
    "import_captions",
    "remove_caption",
    "update_caption",
    "set_caption_timing",
    "set_caption_preset",
    "set_clip_locked",
    "add_transition",
    "update_transition",
    "remove_transition",
    "set_clip_transition_facts",
    "set_clip_keyframes",
    "clear_clip_keyframes",
    "set_clip_transform",
    "set_clip_mask",
    "set_clip_keying",
    "set_caption_style",
    "clear_caption_style",
    "add_track",
    "remove_track",
    "move_track",
    "set_track_flags",
    # W0.3 声画链接（结构域，不进 AI 白名单——见 CLIP_LINKAGE_PLANNING_GATE §2.5）
    "detach_audio",
    "set_clip_link",
    "clear_clip_link",
    # W1.4 L/J cut（DEC-7 准入 AI 白名单）
    "split_edit",
}
# AI 白名单（WHITELIST_EXPANSION 2026-09-22）：显式冻结集合 + 导入期断言，
# 替代历史"差集"写法——差集让 8-28 后新增 op 未经裁决自动成为 AI 可用
# （漂移至 24 种且契约/字段清单未跟随）。准入制：新 op 必须"白名单 +
# TIMELINE_PATCH_OPERATIONS_SCHEMA oneOf + _PATCH_FIELDS"三处同步（一致性
# 由 test_provider_operations_consistency 钉死）。
#   - set_clip_mask / set_clip_keying 显式排除：蒙版形状/抠像色彩是像素级
#     数据，文本指令生成即猜测（无 CV 信号辅助前无效能）；
#   - add_caption / import_captions 排除：字幕文本创作属人工输入域；
#   - 其余结构性操作（素材插入/转录插入/轨道增删移/锁定）排除不变。
AI_PATCH_OPERATIONS = frozenset({
    "remove_clip",
    "move_clip",
    "position_clip",
    "trim_clip",
    "split_clip",
    "set_layout",
    "set_audio",
    "set_speed",
    "set_reverse_playback",
    "set_image_duration",
    "remove_caption",
    "update_caption",
    "set_caption_timing",
    "set_caption_preset",
    "add_transition",
    "update_transition",
    "remove_transition",
    "set_caption_style",
    "clear_caption_style",
    "set_clip_transform",
    "set_clip_keyframes",
    "clear_clip_keyframes",
    "split_edit",
})
assert AI_PATCH_OPERATIONS <= PATCH_OPERATIONS, (
    "AI_PATCH_OPERATIONS contains operations absent from PATCH_OPERATIONS"
)
def _ignore_link(operation: dict[str, Any]) -> bool:
    value = operation.get("ignore_link")
    if value is None:
        return False
    if not isinstance(value, bool):
        raise DomainError("TIMELINE_INVALID", "ignore_link 状态不合法")
    return value


MIN_VIDEO_US = 100_000


def _clip_link_members(document: dict[str, Any], clip: dict[str, Any]) -> list[dict[str, Any]]:
    """W0.3：链接组成员；无 link_group_id 时仅自身（旧语义）。"""
    group_id = clip.get("link_group_id")
    if not group_id:
        return [clip]
    return [c for c in document["clips"] if c.get("link_group_id") == group_id]


def _assign_link_group(clips: list[dict[str, Any]], members: list[dict[str, Any]], group_id: str) -> None:
    for member in members:
        member["link_group_id"] = group_id


def _drop_empty_link_groups(document: dict[str, Any]) -> None:
    """序列化前清理：组内仅剩 0/1 个成员时不落 link_group_id（保持旧形状）。"""
    counts: dict[str, int] = {}
    for clip in document["clips"]:
        gid = clip.get("link_group_id")
        if gid:
            counts[gid] = counts.get(gid, 0) + 1
    for clip in document["clips"]:
        gid = clip.get("link_group_id")
        if gid and counts.get(gid, 0) < 2:
            del clip["link_group_id"]


MIN_IMAGE_US = 100_000
MAX_IMAGE_US = 9_007_199_254_740_991


def _patch_failure(
    reason: str, operation_index: int, op: Any, field: str
) -> ValueError:
    """AI-1-2：op 级失败的结构化 detail（挂 __cause__，供 agent 循环反馈）。"""
    failure = ValueError("patch_operation_failure")
    failure.args = (
        {
            "reason": reason,
            "operation_index": operation_index,
            "op": op if isinstance(op, str) else None,
            "field": field,
        },
    )
    return failure


def _patch_failure_field(exc: DomainError) -> str:
    """从 DomainError 推断失败字段（供结构化反馈；推断不出给 op 级标记）。"""
    return "operation"


def _patch_failure_reason(exc: DomainError) -> str:
    return exc.code
MIN_CAPTION_US = 100_000
MAX_PADDING_US = 300_000
MIN_SPEED_MILLI = 100
MAX_SPEED_MILLI = 100_000
MIN_TRANSITION_US = 100_000
MAX_TRANSITION_US = 2_000_000
TRANSITION_EPS_US = 1_500
# 转场作用于同轨相邻的这两类片段（P231：任意视觉轨，V1 轨 = 同轨特例）。
TRANSITIONABLE_KINDS = ("video", "image")
TRANSITION_KINDS = {
    "fade", "fadeblack", "dissolve", "wipeleft", "wiperight",
    "slideleft", "slideup", "zoomin",
}
TRANSITION_MOVE_PRESET_IDS = frozenset({
    "motions/move-push-left", "motions/move-push-right", "motions/move-push-up", "motions/move-push-down",
    "motions/move-slide-left", "motions/move-slide-right", "motions/move-slide-up", "motions/move-slide-down",
    "motions/move-reveal-left", "motions/move-squeeze", "motions/move-flip", "motions/move-wipe-right",
    "motions/move-wipe-left", "motions/move-wipe-down", "motions/move-wipe-up", "motions/move-soft-wipe",
    "motions/move-iris", "motions/move-diamond", "motions/move-split-open", "motions/move-split-across",
    "motions/move-blur-dissolve", "motions/move-blur-rush", "motions/move-flash-dissolve",
    "motions/move-zoom-in", "motions/move-zoom-out", "motions/move-spin",
})
MAX_TRANSITIONS = 50
# 多轨道结构（剪映式）：tracks 数组顺序 = 自上而下
# [动态视频/文本轨道...] → C1(字幕轨) → V1(主视频轨) → A1(音频轨)。
# C1/V1/A1 恒存在且相对位置固定；动态轨道（V2+ 视频轨 / T1+ 文本轨）只能在
# C1 之上的区域自由添加、删除与交换位置。
MAIN_TRACK_ID = "V1"
CAPTION_TRACK_ID = "C1"
AUDIO_TRACK_ID = "A1"
TRACK_KINDS = ("video", "text", "audio")


def _picture(clip: dict[str, Any]) -> bool:
    return clip.get("asset_kind") != "audio"


def _picture_fade(clip: dict[str, Any], edge: str) -> int:
    value = clip.get(f"picture_fade_{edge}_us", 0)
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def _audio_fade(clip: dict[str, Any], edge: str) -> int:
    audio = clip.get("audio")
    value = audio.get(f"fade_{edge}_us", 0) if isinstance(audio, dict) else 0
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def _source_edge_contiguous(head: dict[str, Any], rest: dict[str, Any]) -> bool:
    if head.get("asset_kind") == "image" or rest.get("asset_kind") == "image":
        return head.get("asset_kind") == rest.get("asset_kind") == "image"
    speed = _clip_speed(head)
    if speed != _clip_speed(rest):
        return False
    head_start, head_end = head.get("source_start_us"), head.get("source_end_us")
    rest_start, rest_end = rest.get("source_start_us"), rest.get("source_end_us")
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in (head_start, head_end, rest_start, rest_end)):
        return False
    source_tol = round(TRANSITION_EPS_US * max(1, speed / 1000))
    if head.get("reverse_playback"):
        return abs(rest_end - head_start) <= source_tol
    return abs(rest_start - head_end) <= source_tol


def _project_active_transitions(
    document: dict[str, Any],
    *,
    system_white_page_asset_ids: set[str] | frozenset[str] = frozenset(),
) -> list[dict[str, Any]]:
    """Pure projection of OpenFilm's final-layout findTransitions rules.

    The trusted white-page asset set is supplied by the owning Core/page service; a
    user-authored clip field is deliberately not accepted as a white-page marker.
    """
    tracks = document.get("tracks") if isinstance(document.get("tracks"), list) else []
    clips = document.get("clips") if isinstance(document.get("clips"), list) else []
    track_order = {track.get("id"): index for index, track in enumerate(tracks) if isinstance(track, dict)}
    ordered: list[dict[str, Any]] = []
    for track_id, track_index in track_order.items():
        lane = [clip for clip in clips if isinstance(clip, dict) and clip.get("track_id") == track_id]
        lane.sort(key=lambda clip: (clip.get("timeline_start_us", 0), clip.get("order_index", 0)))
        ordered.extend(lane)
    # Keep the persisted clip order as a stable fallback for malformed/untracked inputs.
    ordered_ids = {clip.get("clip_id") for clip in ordered}
    ordered.extend(clip for clip in clips if isinstance(clip, dict) and clip.get("clip_id") not in ordered_ids)
    is_white = lambda clip: clip.get("asset_id") in system_white_page_asset_ids
    incoming = [
        clip for clip in ordered
        if not is_white(clip) and (
            (_picture_fade(clip, "in") if _picture(clip) else _audio_fade(clip, "in")) > 0
            or (isinstance(clip.get("move_in"), dict) and clip["move_in"].get("duration_us", 0) > 0)
        )
    ]
    outgoing = sorted(ordered, key=lambda clip: not _picture(clip))
    used_outgoing: set[str] = set()
    used_incoming: set[str] = set()
    projected: list[dict[str, Any]] = []

    def duration_us(clip: dict[str, Any]) -> int:
        return clip.get("timeline_end_us", 0) - clip.get("timeline_start_us", 0)

    def find_rest(head: dict[str, Any]) -> dict[str, Any] | None:
        group = head.get("link_group_id")
        if not group:
            return None
        for candidate in ordered:
            if candidate is head or candidate.get("track_id") == head.get("track_id"):
                continue
            if candidate.get("link_group_id") != group:
                continue
            if abs(candidate.get("timeline_start_us", 0) - head.get("timeline_end_us", 0)) > TRANSITION_EPS_US:
                continue
            if candidate.get("asset_kind") != head.get("asset_kind") or candidate.get("asset_id") != head.get("asset_id"):
                continue
            if _source_edge_contiguous(head, candidate):
                return candidate
        return None

    for out_clip in outgoing:
        out_id = out_clip.get("clip_id")
        if not isinstance(out_id, str) or out_id in used_outgoing or is_white(out_clip):
            continue
        out_picture = _picture(out_clip)
        out_track = track_order.get(out_clip.get("track_id"), 10**9)
        for in_clip in incoming:
            in_id = in_clip.get("clip_id")
            if not isinstance(in_id, str) or in_id == out_id or in_id in used_incoming or is_white(in_clip):
                continue
            if _picture(in_clip) != out_picture:
                continue
            in_track = track_order.get(in_clip.get("track_id"), 10**9)
            lap = out_clip.get("timeline_end_us", 0) - in_clip.get("timeline_start_us", 0)
            move_in = in_clip.get("move_in") if isinstance(in_clip.get("move_in"), dict) else None
            in_fade = _picture_fade(in_clip, "in") if out_picture else _audio_fade(in_clip, "in")
            out_fade = _picture_fade(out_clip, "out") if out_picture else _audio_fade(out_clip, "out")
            moved = bool(
                out_picture and move_in and lap > TRANSITION_EPS_US and in_track < out_track
                and abs(move_in.get("duration_us", -10**30) - lap) <= TRANSITION_EPS_US
            )
            overlap = moved or (
                lap > TRANSITION_EPS_US
                and in_track != out_track
                and abs(in_fade - lap) <= TRANSITION_EPS_US
                and (
                    abs(out_fade - lap) <= TRANSITION_EPS_US
                    or (out_picture and out_fade <= TRANSITION_EPS_US and in_track < out_track)
                )
            )
            touch = (
                out_fade > 0
                and abs(in_clip.get("timeline_start_us", 0) - out_clip.get("timeline_end_us", 0)) <= TRANSITION_EPS_US
                and in_track == out_track
            )
            if not overlap and not touch:
                continue
            if moved:
                kind = "move"
            elif overlap:
                kind = "dissolve" if out_picture else "crossfade"
            else:
                kind = "dip-black"
            start_us = in_clip["timeline_start_us"] if overlap else out_clip["timeline_end_us"] - out_fade
            end_us = out_clip["timeline_end_us"] if overlap else in_clip["timeline_start_us"] + in_fade
            white_clip = None
            if touch and out_picture:
                white_clip = next((
                    candidate for candidate in ordered
                    if is_white(candidate)
                    and abs(candidate.get("timeline_start_us", 0) - start_us) <= TRANSITION_EPS_US
                    and abs(candidate.get("timeline_end_us", 0) - end_us) <= TRANSITION_EPS_US
                ), None)
                if white_clip is not None:
                    kind = "dip-white"
            rest = find_rest(in_clip) if overlap else None
            on_clip = out_clip if rest is not None or not overlap else in_clip
            pair_key = f"{out_id}\0{in_id}"
            item: dict[str, Any] = {
                "transition_id": f"transition_{hashlib.sha256(pair_key.encode('utf-8')).hexdigest()[:24]}",
                "outgoing_clip_id": out_id,
                "incoming_clip_id": in_id,
                "kind": kind,
                "start_us": start_us,
                "end_us": end_us,
                "cut_us": out_clip["timeline_end_us"],
                "on_clip_id": on_clip["clip_id"],
            }
            if rest is not None:
                item["rest_clip_id"] = rest["clip_id"]
            if white_clip is not None:
                item["white_page_asset_id"] = white_clip["asset_id"]
            if isinstance(move_in, dict):
                item["incoming_move_preset_id"] = move_in["preset_id"]
            move_out = out_clip.get("move_out")
            if isinstance(move_out, dict):
                item["outgoing_move_preset_id"] = move_out["preset_id"]
            projected.append(item)
            used_outgoing.add(out_id)
            used_incoming.add(in_id)
            break

    # A linked picture transition owns its matching sound crossfade; don't show a second mark.
    pictures = [item for item in projected if _picture(next(c for c in ordered if c["clip_id"] == item["outgoing_clip_id"]))]
    clip_by_id = {clip.get("clip_id"): clip for clip in ordered}
    return [
        item for item in projected
        if _picture(clip_by_id[item["outgoing_clip_id"]])
        or not any(
            clip_by_id[picture["outgoing_clip_id"]].get("link_group_id")
            and clip_by_id[picture["outgoing_clip_id"]].get("link_group_id") == clip_by_id[item["outgoing_clip_id"]].get("link_group_id")
            and clip_by_id[picture["incoming_clip_id"]].get("link_group_id")
            and clip_by_id[picture["incoming_clip_id"]].get("link_group_id") == clip_by_id[item["incoming_clip_id"]].get("link_group_id")
            for picture in pictures
        )
    ]


def _normalize_transition_facts(clip: dict[str, Any]) -> None:
    """Validate and canonicalize persisted picture transition facts in-place."""
    duration = clip.get("timeline_end_us", 0) - clip.get("timeline_start_us", 0)
    fields = ("picture_fade_in_us", "picture_fade_out_us", "move_in", "move_out")
    if clip.get("asset_kind") == "audio" and any(field in clip for field in fields):
        raise DomainError("TIMELINE_INVALID", "音频片段不能带画面转场来源事实")
    for field in fields[:2]:
        if field not in clip:
            continue
        value = _integer(clip[field], "画面淡变时长不合法")
        if value < 0 or value > duration:
            raise DomainError("TIMELINE_TRANSITION_INVALID", "画面淡变时长超出片段范围")
        if value == 0:
            clip.pop(field, None)
        else:
            clip[field] = value
    for field in fields[2:]:
        if field not in clip:
            continue
        value = clip[field]
        if not isinstance(value, dict):
            raise DomainError("TIMELINE_INVALID", "运动转场事实不合法")
        _exact_keys(value, {"preset_id", "duration_us"})
        preset_id = _enum(value.get("preset_id"), TRANSITION_MOVE_PRESET_IDS, "运动转场预设不合法")
        move_duration = _integer(value.get("duration_us"), "运动转场时长不合法")
        if move_duration < 0 or move_duration > duration:
            raise DomainError("TIMELINE_TRANSITION_INVALID", "运动转场时长超出片段范围")
        if move_duration == 0:
            clip.pop(field, None)
        else:
            clip[field] = {"preset_id": preset_id, "duration_us": move_duration}
    if clip.get("picture_fade_in_us", 0) + clip.get("picture_fade_out_us", 0) > duration:
        raise DomainError("TIMELINE_TRANSITION_INVALID", "画面淡入淡出总时长不得超过片段时长")


def _empty_track(track_id: str, kind: str) -> dict[str, Any]:
    return {
        "id": track_id,
        "kind": kind,
        "locked": False,
        "hidden": False,
        "muted": False,
        "solo": False,
    }
# B3 关键帧：属性白名单与取值范围。
KEYFRAME_PROPERTIES = ("position", "scale", "rotate", "opacity")
KEYFRAME_MAX_FRAMES = 32
KEYFRAME_RANGES = {
    "position": None,  # x/y 比率，-0.5..0.5
    "scale": (0.1, 5.0),
    "rotate": (-180.0, 180.0),
    "opacity": (0.0, 1.0),
}
# B4 字幕样式覆盖：字段白名单与取值范围。
CAPTION_STYLE_FONT_RANGE = (24, 144)
CAPTION_STYLE_OUTLINE_RANGE = (0, 10)
CAPTION_STYLE_ALIGNMENT = {1, 2, 3, 4, 5, 6, 7, 8, 9}
CAPTION_STYLE_MARGIN_RANGE = (0, 600)
# 花字模板枚举（M2-B4 收官）：none=清除；其余为服务端固定标签序列（见 ass.py）。
CAPTION_FX_PRESETS = ("none", "gold-gradient", "neon-glow", "sticker-outline", "soft-shadow")


def _validate_caption_style(style: Any, font_families: set[str] | None = None) -> dict[str, Any]:
    """校验字幕样式覆盖并返回规范化副本（部分字段；见设计 §1.1）。

    气泡/花字扩展（M2-B4 收官）：back_color/border_style/shadow（气泡底衬）
    与 fx_preset（花字模板枚举，服务端展开固定标签序列）。
    font_families（多字体）= 注册字体族白名单；None = 跳过白名单（旧测试）。
    """
    if not isinstance(style, dict) or not style:
        raise DomainError("TIMELINE_INVALID", "字幕样式覆盖不能为空")
    allowed = {
        "font_name", "font_size", "primary_color", "outline_color", "outline",
        "alignment", "margin_v", "letter_spacing", "bold", "italic", "underline",
        "pos_x", "pos_y",
        "back_color", "border_style", "shadow", "fx_preset",
    }
    if set(style) - allowed:
        raise DomainError("TIMELINE_INVALID", "字幕样式字段不合法")
    result: dict[str, Any] = {}
    font_name = style.get("font_name")
    if font_name is not None:
        if not isinstance(font_name, str) or not 0 < len(font_name) <= 60:
            raise DomainError("TIMELINE_INVALID", "字体名称不合法")
        if font_families is not None and font_name not in font_families:
            raise DomainError("TIMELINE_INVALID", "字体未注册（仅内置字体可选）")
        result["font_name"] = font_name
    font_size = style.get("font_size")
    if font_size is not None:
        if isinstance(font_size, bool) or not isinstance(font_size, int):
            raise DomainError("TIMELINE_INVALID", "字号不合法")
        low, high = CAPTION_STYLE_FONT_RANGE
        if not low <= font_size <= high:
            raise DomainError("TIMELINE_INVALID", f"字号需在 {low}-{high} 之间")
        result["font_size"] = font_size
    for color_key in ("primary_color", "outline_color"):
        color = style.get(color_key)
        if color is not None:
            if (
                not isinstance(color, str)
                or not re.fullmatch(r"&H[0-9A-Fa-f]{8}", color)
            ):
                raise DomainError("TIMELINE_INVALID", "字幕颜色需为 &Haabbggrr 格式")
            result[color_key] = color
    outline = style.get("outline")
    if outline is not None:
        if isinstance(outline, bool) or not isinstance(outline, int):
            raise DomainError("TIMELINE_INVALID", "描边宽度不合法")
        low, high = CAPTION_STYLE_OUTLINE_RANGE
        if not low <= outline <= high:
            raise DomainError("TIMELINE_INVALID", f"描边宽度需在 {low}-{high} 之间")
        result["outline"] = outline
    alignment = style.get("alignment")
    if alignment is not None:
        if isinstance(alignment, bool) or not isinstance(alignment, int) or alignment not in CAPTION_STYLE_ALIGNMENT:
            raise DomainError("TIMELINE_INVALID", "字幕对齐需为 ASS numpad 1-9")
        result["alignment"] = alignment
    letter_spacing = style.get("letter_spacing")
    if letter_spacing is not None:
        if isinstance(letter_spacing, bool) or not isinstance(letter_spacing, (int, float)) or not 0 <= letter_spacing <= 50:
            raise DomainError("TIMELINE_INVALID", "字间距需在 0-50 之间")
        result["letter_spacing"] = float(letter_spacing)
    for flag_key in ("bold", "italic", "underline"):
        flag = style.get(flag_key)
        if flag is None:
            continue
        if not isinstance(flag, bool):
            raise DomainError("TIMELINE_INVALID", "样式开关需为布尔值")
        result[flag_key] = flag
    margin_v = style.get("margin_v")
    if margin_v is not None:
        if isinstance(margin_v, bool) or not isinstance(margin_v, int):
            raise DomainError("TIMELINE_INVALID", "字幕边距不合法")
        low, high = CAPTION_STYLE_MARGIN_RANGE
        if not low <= margin_v <= high:
            raise DomainError("TIMELINE_INVALID", f"字幕边距需在 {low}-{high} 之间")
        result["margin_v"] = margin_v
    for pos_key in ("pos_x", "pos_y"):
        pos = style.get(pos_key)
        if pos is None:
            continue
        if isinstance(pos, bool) or not isinstance(pos, (int, float)):
            raise DomainError("TIMELINE_INVALID", "自定义坐标需为 0-1 比率或 null")
        if not 0 <= pos <= 1:
            raise DomainError("TIMELINE_INVALID", "自定义坐标需为 0-1 比率或 null")
        result[pos_key] = float(pos)
    # 气泡：底衬色（ASS &Haabbggrr，同既有颜色格式）+ BorderStyle 枚举
    # （1=描边+阴影 3=不透明底衬块）+ 底衬深度 shadow。
    back_color = style.get("back_color")
    if back_color is not None:
        if (
            not isinstance(back_color, str)
            or not re.fullmatch(r"&H[0-9A-Fa-f]{8}", back_color)
        ):
            raise DomainError("TIMELINE_INVALID", "字幕颜色需为 &Haabbggrr 格式")
        result["back_color"] = back_color
    border_style = style.get("border_style")
    if border_style is not None:
        if isinstance(border_style, bool) or not isinstance(border_style, int) or border_style not in (1, 3):
            raise DomainError("TIMELINE_INVALID", "字幕底衬样式需为 1（描边）或 3（底衬块）")
        result["border_style"] = border_style
    shadow = style.get("shadow")
    if shadow is not None:
        if isinstance(shadow, bool) or not isinstance(shadow, int):
            raise DomainError("TIMELINE_INVALID", "阴影深度不合法")
        if not 0 <= shadow <= 10:
            raise DomainError("TIMELINE_INVALID", "阴影深度需在 0-10 之间")
        result["shadow"] = shadow
    # 花字：模板枚举（服务端展开固定标签序列；与基础色控件互斥由渲染后置
    # 覆盖 + UI 禁用表达）。
    fx_preset = style.get("fx_preset")
    if fx_preset is not None:
        if fx_preset not in CAPTION_FX_PRESETS:
            raise DomainError("TIMELINE_INVALID", "花字模板不合法")
        result["fx_preset"] = fx_preset
    return result


def _clip_speed(clip: dict[str, Any]) -> int:
    speed = clip.get("speed_milli", 1000)
    if isinstance(speed, bool) or not isinstance(speed, int):
        raise DomainError("TIMELINE_INVALID", "片段速度不合法")
    return speed


def _clip_timeline_duration_us(source_start: int | None, source_end: int | None, speed_milli: int) -> int:
    """时间线时长 = 源范围时长 / 速度（round-half-even 向下取整保护最小 1us）。"""
    if source_start is None or source_end is None:
        raise DomainError("TIMELINE_INVALID", "源范围缺失")
    if speed_milli == 1000:
        return source_end - source_start
    return max(1, round((source_end - source_start) * 1000 / speed_milli))


def _round_half_up_ratio(numerator: int, denominator: int) -> int:
    if denominator <= 0 or numerator < 0:
        raise DomainError("TIMELINE_INVALID", "时间映射参数不合法")
    return (2 * numerator + denominator) // (2 * denominator)


def _source_to_timeline_us(clip: dict[str, Any], source_us: int) -> int:
    source_start = clip.get("source_start_us")
    source_end = clip.get("source_end_us")
    if not isinstance(source_start, int) or not isinstance(source_end, int):
        raise DomainError("TIMELINE_INVALID", "字幕来源片段缺少源时间范围")
    speed = _clip_speed(clip)
    source_delta = source_end - source_us if clip.get("reverse_playback") else source_us - source_start
    if source_delta < 0:
        raise DomainError("TIMELINE_INVALID", "字幕来源时间映射越界")
    return int(clip["timeline_start_us"]) + _round_half_up_ratio(source_delta * 1000, speed)


_CLOSING_PUNCTUATION = set("，。！？；：、）》】〕〉》」』”’!?;:,.%)」』】〕〉")


def _caption_cut_index(text: str, ratio: float) -> int:
    """Choose a surrogate-safe OpenFilm-like word/CJK boundary near the time ratio."""
    if len(text) < 2:
        raise DomainError("TIMELINE_INVALID", "字幕文本过短，无法拆分")
    target = max(1, min(len(text) - 1, _round_half_up_ratio(int(ratio * 1_000_000), 1_000_000)))
    boundaries: set[int] = set()
    for index in range(1, len(text)):
        if text[index - 1].isspace():
            boundaries.add(index)
        elif "\u3400" <= text[index - 1] <= "\u9fff" or "\u3400" <= text[index] <= "\u9fff":
            boundaries.add(index)
    legal = []
    for boundary in boundaries:
        candidate = boundary
        while candidate < len(text) - 1 and text[candidate] in _CLOSING_PUNCTUATION:
            candidate += 1
        if 0 < candidate < len(text):
            legal.append(candidate)
    if legal:
        return min(legal, key=lambda candidate: (abs(candidate - target), candidate))
    # Python indexes Unicode code points, so this fallback cannot split a surrogate pair.
    return target


class TimelineService:
    def __init__(self, db: Database, *, font_families: list[str] | None = None) -> None:
        self.db = db
        # 字幕字体族白名单（多字体）：None = 跳过 font_name 白名单校验
        # （旧单测直构服务不受影响；生产路径由 app 注入注册表）。
        self.font_families = set(font_families) if font_families is not None else None

    def create(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        _exact_keys(
            request,
            {"schema_version", "source", "default_layout", "caption_preset_id"},
        )
        self._require_schema(request)
        default_layout = _enum(request.get("default_layout"), LAYOUTS, "布局不合法")
        caption_preset = _enum(request.get("caption_preset_id"), CAPTION_PRESETS, "字幕预设不合法")
        source = _mapping(request.get("source"), "创建来源不合法")
        with self.db.connection() as db:
            project = self._project(db, project_id)
            if project["current_timeline_revision_id"] is not None:
                raise DomainError("TIMELINE_ALREADY_EXISTS", "项目已存在时间线")
            document = self._empty_document(project_id, project["canvas_json"])
            kind = source.get("kind")
            if kind == "empty":
                _exact_keys(source, {"kind"})
            elif kind == "full_asset":
                _exact_keys(source, {"kind", "asset_id"})
                document["clips"].append(
                    self._asset_clip(db, project_id, source.get("asset_id"), default_layout)
                )
            elif kind == "transcript_selection":
                _exact_keys(
                    source,
                    {
                        "kind",
                        "transcript_id",
                        "segment_ids",
                        "padding_before_us",
                        "padding_after_us",
                        "create_captions",
                    },
                )
                clips, captions, transcript_id = self._transcript_clips(
                    db,
                    project_id,
                    source,
                    default_layout,
                    caption_preset,
                )
                document["clips"].extend(clips)
                document["captions"].extend(captions)
                document["provenance"]["source_transcript_ids"] = [transcript_id]
            else:
                raise DomainError("TIMELINE_SOURCE_INVALID", "时间线创建来源不合法")
            self._normalize_and_validate(db, document)
            summary = {
                "empty": "创建空时间线",
                "full_asset": "从完整素材创建时间线",
                "transcript_selection": "从转录选段创建时间线",
            }[kind]
            db.execute("BEGIN")
            try:
                latest = db.execute(
                    "SELECT current_timeline_revision_id FROM projects WHERE id=?", (project_id,)
                ).fetchone()
                if latest is None or latest[0] is not None:
                    raise DomainError("TIMELINE_ALREADY_EXISTS", "项目已存在时间线")
                self._normalize_and_validate(db, document)
                revision = self._insert_revision(db, project_id, None, document, summary, "user")
                now = utc_now()
                db.execute(
                    "UPDATE projects SET current_timeline_revision_id=?,updated_at=? WHERE id=?",
                    (revision["timeline_revision_id"], now, project_id),
                )
                db.execute(
                    "INSERT INTO timeline_navigation(project_id,redo_stack_json,updated_at) "
                    "VALUES (?,?,?)",
                    (project_id, "[]", now),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return self.get_state(project_id)

    def get_state(self, project_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            project = self._project(db, project_id)
            revision_id = project["current_timeline_revision_id"]
            if revision_id is None:
                raise DomainError("TIMELINE_NOT_FOUND", "项目尚未创建时间线")
            revision = self._revision(db, revision_id)
            draft_row = db.execute(
                "SELECT * FROM timeline_drafts WHERE project_id=?", (project_id,)
            ).fetchone()
            redo_row = db.execute(
                "SELECT redo_stack_json FROM timeline_navigation WHERE project_id=?",
                (project_id,),
            ).fetchone()
        draft = self._draft_dto(draft_row, revision_id) if draft_row else None
        redo_stack = json_loads(redo_row[0]) if redo_row else []
        return {
            "project_id": project_id,
            "current_revision": revision,
            "draft": draft,
            "can_undo": revision["parent_revision_id"] is not None,
            "can_redo": bool(redo_stack),
            "current_preview": None,
            "active_transitions": _project_active_transitions(revision["document"]),
        }

    def create_revision_from_document(
        self,
        db: sqlite3.Connection,
        project_id: str,
        base_revision_id: str | None,
        document: dict[str, Any],
        summary: str,
    ) -> dict[str, Any]:
        """Internal Planning boundary. Callers own the surrounding transaction."""
        project = self._project(db, project_id)
        if project["current_timeline_revision_id"] != base_revision_id:
            raise DomainError("TIMELINE_CONFLICT", "时间线基线已变化")
        self._normalize_and_validate(db, document)
        revision = self._insert_revision(
            db, project_id, base_revision_id, document, summary, "user"
        )
        now = utc_now()
        db.execute(
            "UPDATE projects SET current_timeline_revision_id=?,updated_at=? WHERE id=?",
            (revision["timeline_revision_id"], now, project_id),
        )
        db.execute(
            "INSERT INTO timeline_navigation(project_id,redo_stack_json,updated_at) VALUES (?,?,?) "
            "ON CONFLICT(project_id) DO UPDATE SET redo_stack_json=excluded.redo_stack_json,updated_at=excluded.updated_at",  # noqa: E501
            (project_id, "[]", now),
        )
        return revision

    def build_asset_insert_document(
        self,
        db: sqlite3.Connection,
        *,
        project_id: str,
        base_document: dict[str, Any],
        asset_id: str,
        proposed_clip_id: str,
        at_index: int,
        duration_us: int,
        layout: str,
    ) -> tuple[dict[str, Any], dict[str, int]]:
        """Build one deterministic image insertion without writing to SQLite."""
        document = copy.deepcopy(base_document)
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline Document 不合法")
        old_starts = {clip["clip_id"]: clip["timeline_start_us"] for clip in clips}
        old_caption_starts = {caption["caption_id"]: caption["start_us"] for caption in captions}
        clip = self._asset_clip(db, project_id, asset_id, layout, None, None, duration_us)
        clip["clip_id"] = _identifier(proposed_clip_id, "Clip ID 不合法")
        self._place_clip_on_track(clips, captions, clip, at_index, MAIN_TRACK_ID)
        self._normalize_and_validate(db, document)
        shifted_clip_count = sum(
            1
            for item in clips
            if item["clip_id"] in old_starts
            and item["timeline_start_us"] != old_starts[item["clip_id"]]
        )
        shifted_caption_count = sum(
            1
            for item in captions
            if item["caption_id"] in old_caption_starts
            and item["start_us"] != old_caption_starts[item["caption_id"]]
        )
        before = max((c["timeline_end_us"] for c in base_document["clips"]), default=0)
        after = max((c["timeline_end_us"] for c in document["clips"]), default=0)
        return document, {
            "clip_count_before": len(base_document["clips"]),
            "shifted_clip_count": shifted_clip_count,
            "shifted_caption_count": shifted_caption_count,
            "duration_before_us": before,
            "duration_after_us": after,
        }

    def get_revision(self, revision_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            return self._revision(db, revision_id)

    def list_revisions(
        self, project_id: str, limit: int = 50, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        if limit < 1 or limit > 100:
            raise DomainError("TIMELINE_INVALID", "limit 参数范围需为 1-100")
        offset = _cursor(cursor)
        with self.db.connection() as db:
            self._project(db, project_id)
            rows = db.execute(
                "SELECT id,parent_revision_id,document_sha256,summary,created_by,created_at "
                "FROM timeline_revisions WHERE project_id=? "
                "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                (project_id, limit, offset),
            ).fetchall()
        items = [
            {
                "timeline_revision_id": row["id"],
                "project_id": project_id,
                "parent_revision_id": row["parent_revision_id"],
                "document_sha256": row["document_sha256"],
                "summary": row["summary"],
                "created_by": row["created_by"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
        return items, str(offset + len(items)) if len(items) == limit else None

    def patch(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        _exact_keys(
            request,
            {"schema_version", "base_revision_id", "operations", "summary"},
        )
        self._require_schema(request)
        base_revision_id = _identifier(request.get("base_revision_id"), "Revision ID 不合法")
        operations = request.get("operations")
        if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
            raise DomainError("TIMELINE_INVALID", "Patch 操作数量需为 1-100")
        summary = _summary(request.get("summary"))
        with self.db.connection() as db:
            project = self._project(db, project_id)
            self._require_base(project, base_revision_id)
            current = self._revision(db, base_revision_id)
            document = copy.deepcopy(current["document"])
            for raw_operation in operations:
                operation = _mapping(raw_operation, "Patch 操作不合法")
                self._apply_operation(db, project_id, document, operation)
            _drop_empty_link_groups(document)
            # 传基线文档：缺失素材上的既有引用必须放行，否则「删片段自救」被挡住。
            self._normalize_and_validate(db, document, previous_document=current["document"])
            db.execute("BEGIN")
            try:
                latest = db.execute(
                    "SELECT current_timeline_revision_id FROM projects WHERE id=?", (project_id,)
                ).fetchone()
                if latest is None or latest[0] != base_revision_id:
                    raise DomainError("TIMELINE_CONFLICT", "时间线已被其他操作修改")
                self._normalize_and_validate(db, document, previous_document=current["document"])
                revision = self._insert_revision(
                    db, project_id, base_revision_id, document, summary, "user"
                )
                now = utc_now()
                db.execute(
                    "UPDATE projects SET current_timeline_revision_id=?,updated_at=? WHERE id=?",
                    (revision["timeline_revision_id"], now, project_id),
                )
                db.execute(
                    "INSERT INTO timeline_navigation(project_id,redo_stack_json,updated_at) "
                    "VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET "
                    "redo_stack_json=excluded.redo_stack_json,updated_at=excluded.updated_at",
                    (project_id, "[]", now),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return self.get_state(project_id)

    def apply_in_memory(
        self,
        db: sqlite3.Connection,
        project_id: str,
        document: dict[str, Any],
        operations: list[dict[str, Any]],
        *,
        ai: bool = False,
        require_non_empty: bool = True,
    ) -> dict[str, Any]:
        if not 1 <= len(operations) <= 100:
            raise DomainError("TIMELINE_INVALID", "Patch 操作数量需为 1-100")
        result = copy.deepcopy(document)
        result.setdefault("locked_elements", [])
        # AI-1-2：op 级失败带机器可读 detail（步骤/字段级反馈给 agent 循环重试）。
        # 既有调用方只读 code/message——detail 为增量字段，行为不变。
        for operation_index, raw_operation in enumerate(operations, start=1):
            operation = _mapping(raw_operation, "Patch 操作不合法")
            if ai and operation.get("op") not in AI_PATCH_OPERATIONS:
                raise DomainError(
                    "TIMELINE_PATCH_PROPOSAL_INVALID", "AI Patch 包含禁止操作"
                ) from _patch_failure(
                    "op_forbidden", operation_index, operation.get("op"), "op"
                )
            try:
                self._apply_operation(db, project_id, result, operation)
            except DomainError as exc:
                raise DomainError(exc.code, exc.message) from _patch_failure(
                    _patch_failure_reason(exc), operation_index, operation.get("op"),
                    _patch_failure_field(exc),
                )
        _drop_empty_link_groups(result)
        self._normalize_and_validate(db, result, previous_document=document)
        if require_non_empty and not result["clips"]:
            raise DomainError("TIMELINE_PATCH_PROPOSAL_INVALID", "AI Patch 不得产生空时间线")
        return result

    def compare_revisions(
        self, project_id: str, base_revision_id: str, target_revision_id: str
    ) -> dict[str, Any]:
        with self.db.connection() as db:
            base = self._revision(db, base_revision_id)
            target = self._revision(db, target_revision_id)
        if base["project_id"] != project_id or target["project_id"] != project_id:
            raise DomainError("TIMELINE_DIFF_INVALID", "Revision 不属于当前项目")
        return timeline_diff(base, target)

    def undo(self, project_id: str, base_revision_id: str) -> dict[str, Any]:
        return self._navigate(project_id, base_revision_id, redo=False)

    def redo(self, project_id: str, base_revision_id: str) -> dict[str, Any]:
        return self._navigate(project_id, base_revision_id, redo=True)

    def save_draft(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        _exact_keys(request, {"schema_version", "base_revision_id", "document"})
        self._require_schema(request)
        base_revision_id = _identifier(request.get("base_revision_id"), "Revision ID 不合法")
        document = copy.deepcopy(_mapping(request.get("document"), "草稿文档不合法"))
        with self.db.connection() as db:
            project = self._project(db, project_id)
            if project["current_timeline_revision_id"] is None:
                raise DomainError("TIMELINE_NOT_FOUND", "项目尚未创建时间线")
            if project["current_timeline_revision_id"] != base_revision_id:
                raise DomainError("TIMELINE_DRAFT_CONFLICT", "草稿基线已过期")
            if document.get("project_id") != project_id:
                raise DomainError("TIMELINE_INVALID", "草稿不属于当前项目")
            self._normalize_and_validate(db, document)
            now = utc_now()
            db.execute(
                "INSERT INTO timeline_drafts(project_id,base_revision_id,document_json,updated_at) "
                "VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET "
                "base_revision_id=excluded.base_revision_id,document_json=excluded.document_json,"
                "updated_at=excluded.updated_at",
                (project_id, base_revision_id, json_dumps(document), now),
            )
            row = db.execute(
                "SELECT * FROM timeline_drafts WHERE project_id=?", (project_id,)
            ).fetchone()
        return self._draft_dto(row, base_revision_id)

    def delete_draft(self, project_id: str) -> None:
        with self.db.connection() as db:
            project = self._project(db, project_id)
            if project["current_timeline_revision_id"] is None:
                raise DomainError("TIMELINE_NOT_FOUND", "项目尚未创建时间线")
            db.execute("DELETE FROM timeline_drafts WHERE project_id=?", (project_id,))

    def purge_asset_clips(self, db: sqlite3.Connection, asset_id: str) -> dict[str, int]:
        """删除所有时间线 Revision 与草稿中引用某素材的片段（含级联）。

        素材删除的级联入口：Clip 以 document_json 存于 timeline_revisions /
        timeline_drafts（无外键），且 revisions 不可变（触发器禁止 UPDATE），
        因此在调用方事务内临时移除不可变触发器，重写全部文档后原样重建。

        每个 document 的处理镜像 remove_clip 语义：
        - 移除引用该素材的片段（保持其余片段的 timeline_start_us，自由定位
          模型下不推移、留空隙）；
        - 移除其 source_clip_id 指向被删片段的字幕；
        - 移除以被删片段为锚点、或以其“被删后同轨时间序直接后继”为锚点的转场（P231 同轨邻接）；
        - 按轨道顺序重排 order_index，并执行失去时间序后继的转场 GC；
        - 重算 document_sha256（文档内容已变化）。

        不调用 _normalize_and_validate：文档可能包含其它缺失/不可用素材，
        且历史 Revision 仅需一致清理，不做完整校验。

        调用方持有事务并负责 BEGIN/COMMIT；调用前应已确认素材确有引用。
        """
        removed_clips = 0
        removed_captions = 0
        rows = db.execute(
            "SELECT id, project_id, document_json FROM timeline_revisions "
            "WHERE document_json LIKE ?",
            (f'%"{asset_id}"%',),
        ).fetchall()
        drafts = db.execute(
            "SELECT project_id, document_json FROM timeline_drafts WHERE document_json LIKE ?",
            (f'%"{asset_id}"%',),
        ).fetchall()
        if not rows and not drafts:
            return {"removed_clips": 0, "removed_captions": 0}
        db.execute("DROP TRIGGER IF EXISTS timeline_revisions_no_update")
        try:
            for row in rows:
                document = json_loads(row["document_json"])
                removed = self._remove_asset_clips_from_document(document, asset_id)
                document_json = json_dumps(document)
                digest = f"sha256:{hashlib.sha256(document_json.encode('utf-8')).hexdigest()}"
                db.execute(
                    "UPDATE timeline_revisions SET document_json=?,document_sha256=? WHERE id=?",
                    (document_json, digest, row["id"]),
                )
                removed_clips += removed["clips"]
                removed_captions += removed["captions"]
            for row in drafts:
                document = json_loads(row["document_json"])
                removed = self._remove_asset_clips_from_document(document, asset_id)
                db.execute(
                    "UPDATE timeline_drafts SET document_json=? WHERE project_id=?",
                    (json_dumps(document), row["project_id"]),
                )
                removed_clips += removed["clips"]
                removed_captions += removed["captions"]
        finally:
            db.execute(
                "CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_update "
                "BEFORE UPDATE ON timeline_revisions "
                "BEGIN SELECT RAISE(ABORT, 'timeline revisions are immutable'); END;"
            )
        # 被清理片段的重做已无意义：清空各项目重做栈，避免恢复出幽灵片段。
        affected = {row["project_id"] for row in rows} | {row["project_id"] for row in drafts}
        now = utc_now()
        for project_id in affected:
            db.execute(
                "INSERT INTO timeline_navigation(project_id,redo_stack_json,updated_at) "
                "VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET "
                "redo_stack_json='[]',updated_at=excluded.updated_at",
                (project_id, "[]", now),
            )
        return {"removed_clips": removed_clips, "removed_captions": removed_captions}

    def _remove_asset_clips_from_document(
        self, document: dict[str, Any], asset_id: str
    ) -> dict[str, int]:
        """按 remove_clip 语义从单个文档中移除引用某素材的片段。"""
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            return {"clips": 0, "captions": 0}
        removed_ids = {
            clip["clip_id"]
            for clip in clips
            if isinstance(clip, dict) and clip.get("asset_id") == asset_id and "clip_id" in clip
        }
        if not removed_ids:
            return {"clips": 0, "captions": 0}
        document["clips"] = [clip for clip in clips if not (isinstance(clip, dict) and clip.get("clip_id") in removed_ids)]
        removed_captions = len([caption for caption in captions if isinstance(caption, dict) and caption.get("source_clip_id") in removed_ids])
        document["captions"] = [
            caption
            for caption in captions
            if not (isinstance(caption, dict) and caption.get("source_clip_id") in removed_ids)
        ]
        transitions = document.get("transitions")
        if isinstance(transitions, list) and transitions:
            document["transitions"] = [
                item for item in transitions
                if not (
                    isinstance(item, dict)
                    and (item.get("after_clip_id") in removed_ids or item.get("incoming_clip_id") in removed_ids)
                )
            ]
        # 按轨道重排 order_index（与 _normalize_timing 一致：只重排，不动时间）。
        track_clips: dict[str, list[dict[str, Any]]] = {}
        for clip in document["clips"]:
            if isinstance(clip, dict) and isinstance(clip.get("track_id"), str):
                track_clips.setdefault(clip["track_id"], []).append(clip)
        for group in track_clips.values():
            for index, clip in enumerate(group):
                clip["order_index"] = index
        self._gc_unreachable_transitions(document)
        return {"clips": len(removed_ids), "captions": removed_captions}

    def _navigate(self, project_id: str, base_revision_id: str, *, redo: bool) -> dict[str, Any]:
        base_revision_id = _identifier(base_revision_id, "Revision ID 不合法")
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                project = self._project(db, project_id)
                self._require_base(project, base_revision_id)
                current = self._revision(db, base_revision_id)
                row = db.execute(
                    "SELECT redo_stack_json FROM timeline_navigation WHERE project_id=?",
                    (project_id,),
                ).fetchone()
                stack = json_loads(row[0]) if row else []
                if redo:
                    if not stack:
                        raise DomainError("TIMELINE_CONFLICT", "没有可重做的时间线版本")
                    target = stack.pop()
                    self._revision(db, target)
                else:
                    target = current["parent_revision_id"]
                    if target is None:
                        raise DomainError("TIMELINE_CONFLICT", "没有可撤销的时间线版本")
                    stack.append(base_revision_id)
                now = utc_now()
                db.execute(
                    "UPDATE projects SET current_timeline_revision_id=?,updated_at=? WHERE id=?",
                    (target, now, project_id),
                )
                db.execute(
                    "INSERT INTO timeline_navigation(project_id,redo_stack_json,updated_at) "
                    "VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET "
                    "redo_stack_json=excluded.redo_stack_json,updated_at=excluded.updated_at",
                    (project_id, json_dumps(stack), now),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return self.get_state(project_id)

    def _apply_operation(
        self,
        db: sqlite3.Connection,
        project_id: str,
        document: dict[str, Any],
        operation: dict[str, Any],
    ) -> None:
        op = operation.get("op")
        if op not in PATCH_OPERATIONS:
            raise DomainError("TIMELINE_OPERATION_UNSUPPORTED", "不支持的时间线操作")
        clips = document["clips"]
        captions = document["captions"]
        document.setdefault("locked_elements", [])
        if op != "set_clip_locked" and op != "set_track_flags":
            self._require_unlocked(document, operation)
        old_starts = {clip["clip_id"]: clip["timeline_start_us"] for clip in clips}
        if op == "insert_asset_clip":
            _exact_keys(
                operation,
                {
                    "op",
                    "asset_id",
                    "at_index",
                    "source_start_us",
                    "source_end_us",
                    "duration_us",
                    "layout",
                    "speed_milli",
                    "reverse_playback",
                    "track_id",
                    "as_audio",
                    "link_to_clip_id",
                    "timeline_start_us",
                    "edit_mode",
                    "linkage_enabled",
                },
                optional={
                    "source_start_us",
                    "source_end_us",
                    "duration_us",
                    "layout",
                    "speed_milli",
                    "reverse_playback",
                    "track_id",
                    "as_audio",
                    "link_to_clip_id",
                    "timeline_start_us",
                    "edit_mode",
                    "linkage_enabled",
                },
            )
            edit_mode = operation.get("edit_mode")
            if edit_mode not in (None, "place", "insert", "overwrite"):
                raise DomainError("TIMELINE_INVALID", "素材落点编辑模式不合法")
            if edit_mode is not None and "timeline_start_us" not in operation:
                raise DomainError("TIMELINE_INVALID", "明确的素材编辑模式需要时间落点")
            if edit_mode is None and "timeline_start_us" in operation:
                raise DomainError("TIMELINE_INVALID", "指定时间落点需要素材编辑模式")
            linkage_enabled = operation.get("linkage_enabled", True)
            if not isinstance(linkage_enabled, bool):
                raise DomainError("TIMELINE_INVALID", "链接联动状态不合法")
            # as_audio（M3-3）：视频素材取其音轨铺到 A1（音频轨拒收视频素材的
            # 既有缺口）。素材必须是 video 且确有音轨；片段按 A1 纯音频语义
            # 落轨（固定轨尾、asset_kind=audio、audio.enabled=true）。
            as_audio = operation.get("as_audio")
            if as_audio is not None and not isinstance(as_audio, bool):
                raise DomainError("TIMELINE_INVALID", "as_audio 状态不合法")
            speed_milli = operation.get("speed_milli")
            if speed_milli is not None and (
                isinstance(speed_milli, bool)
                or not isinstance(speed_milli, int)
                or not MIN_SPEED_MILLI <= speed_milli <= MAX_SPEED_MILLI
            ):
                raise DomainError("TIMELINE_INVALID", "速度需在 0.1x-100x 之间")
            reverse_playback = operation.get("reverse_playback")
            if reverse_playback is not None and not isinstance(reverse_playback, bool):
                raise DomainError("TIMELINE_INVALID", "倒放状态不合法")
            clip = self._asset_clip(
                db,
                project_id,
                operation.get("asset_id"),
                operation.get("layout", "blurred_background"),
                operation.get("source_start_us"),
                operation.get("source_end_us"),
                operation.get("duration_us"),
            )
            if as_audio:
                if clip["asset_kind"] != "video":
                    raise DomainError("TIMELINE_INVALID", "只有视频素材可以取音轨入音频轨")
                # 音轨存在性在 clip.audio.enabled 中已编码（_asset_clip 依
                # media_info.audio_streams 判定）；无声视频取音轨即拒绝。
                if not clip["audio"]["enabled"]:
                    raise DomainError("TIMELINE_INVALID", "视频素材没有音轨")
                clip["track_id"] = AUDIO_TRACK_ID
                clip["asset_kind"] = "audio"
                clip["layout"] = "fit"
            if clip["asset_kind"] == "image":
                if speed_milli is not None and speed_milli != 1000:
                    raise DomainError("TIMELINE_INVALID", "图片片段不能变速")
                if reverse_playback:
                    raise DomainError("TIMELINE_INVALID", "图片片段不能倒放")
            if speed_milli is not None:
                clip["speed_milli"] = speed_milli
            if reverse_playback:
                if clip["asset_kind"] != "video":
                    raise DomainError("TIMELINE_INVALID", "只有视频片段可以倒放")
                clip["reverse_playback"] = True
            if clip.get("speed_milli", 1000) != 1000 and clip["asset_kind"] in ("video", "audio"):
                clip["timeline_end_us"] = clip["timeline_start_us"] + _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], clip["speed_milli"]
                )
            op_track_id = operation.get("track_id")
            if op_track_id is not None:
                if not isinstance(op_track_id, str) or not op_track_id:
                    raise DomainError("TIMELINE_INVALID", "目标轨道不合法")
            if clip["asset_kind"] == "audio":
                target_track_id = op_track_id or clip["track_id"] or AUDIO_TRACK_ID
                target_track = next((track for track in document.get("tracks", []) if track.get("id") == target_track_id), None)
                if target_track is None or target_track.get("kind") != "audio":
                    raise DomainError("TIMELINE_INVALID", "音频素材只能放到音频轨道")
                clip["track_id"] = target_track_id
                if edit_mode == "overwrite":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._overwrite_track_range(document, target_track_id, start, start + duration)
                    self._place_clip_at_time(clips, clip, target_track_id)
                elif edit_mode == "insert":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    self._ripple_track_from_time(document, target_track_id, start, duration, linkage_enabled)
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._place_clip_at_time(clips, clip, target_track_id)
                elif edit_mode == "place":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._place_clip_at_time(clips, clip, target_track_id)
                else:
                    audio_clips = [c for c in clips if c["track_id"] == target_track_id]
                    last_end = max((c["timeline_end_us"] for c in audio_clips), default=0)
                    clip["timeline_start_us"] = last_end
                    clip["timeline_end_us"] = last_end + (clip["source_end_us"] - clip["source_start_us"])
                    clip["order_index"] = len(audio_clips)
                    clips.append(clip)
            else:
                # 视频/图片片段：默认落主视频轨（V1），可用 track_id 指定任意
                # 视频轨道；落到时间槽 `at_index`，冲突片段在该轨内涟漪右推。
                target_track_id = op_track_id or clip["track_id"]
                target_track = next(
                    (
                        track
                        for track in document.get("tracks", [])
                        if track.get("id") == target_track_id
                    ),
                    None,
                )
                if target_track is None or target_track.get("kind") != "video":
                    raise DomainError("TIMELINE_INVALID", "目标轨道不是视频轨道")
                clip["track_id"] = target_track_id
                if edit_mode == "overwrite":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._overwrite_track_range(document, target_track_id, start, start + duration)
                    self._place_clip_at_time(clips, clip, target_track_id)
                elif edit_mode == "insert":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    self._ripple_track_from_time(document, target_track_id, start, duration, linkage_enabled)
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._place_clip_at_time(clips, clip, target_track_id)
                elif edit_mode == "place":
                    start = _integer(operation.get("timeline_start_us"), "时间线落点不合法")
                    duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                    clip["timeline_start_us"] = start
                    clip["timeline_end_us"] = start + duration
                    self._place_clip_at_time(clips, clip, target_track_id)
                else:
                    self._place_clip_on_track(
                        clips, captions, clip, operation.get("at_index"), target_track_id
                    )
            link_to = operation.get("link_to_clip_id")
            if link_to is not None:
                partner = _clip(document, link_to)
                group_id = partner.get("link_group_id") or f"link_{new_id()}"
                partner["link_group_id"] = group_id
                clip["link_group_id"] = group_id
        elif op == "insert_transcript_segments":
            _exact_keys(
                operation,
                {
                    "op",
                    "transcript_id",
                    "segment_ids",
                    "at_index",
                    "padding_before_us",
                    "padding_after_us",
                    "create_captions",
                    "layout",
                },
                optional={"layout"},
            )
            at_index = _insert_index(operation.get("at_index"), len(clips))
            transcript_source = {key: value for key, value in operation.items() if key != "op"}
            layout = transcript_source.pop("layout", "blurred_background")
            transcript_source.pop("at_index")
            new_clips, new_captions, transcript_id = self._transcript_clips(
                db,
                project_id,
                transcript_source,
                layout,
                "default-bottom",
            )
            insertion_time = (
                clips[at_index]["timeline_start_us"]
                if at_index < len(clips)
                else max(
                    (
                        c["timeline_end_us"]
                        for c in clips
                        if c.get("track_id") == "V1"
                    ),
                    default=0,
                )
            )
            for caption in new_captions:
                caption["start_us"] += insertion_time
                caption["end_us"] += insertion_time
            clips[at_index:at_index] = new_clips
            captions.extend(new_captions)
            # 自由定位模型：显式把新片段落到 insertion_time 起的连续区间，
            # 再把撞上的既有片段涟漪右推（保持其相对顺序与空隙）。
            cursor = insertion_time
            for new_clip in new_clips:
                new_duration = (
                    new_clip["timeline_end_us"] - new_clip["timeline_start_us"]
                )
                new_clip["timeline_start_us"] = cursor
                new_clip["timeline_end_us"] = cursor + new_duration
                cursor += new_duration
            for new_clip in new_clips:
                self._ripple_track_right(clips, captions, new_clip)
            provenance = document["provenance"]["source_transcript_ids"]
            if transcript_id not in provenance:
                provenance.append(transcript_id)
        elif op == "remove_clip":
            _exact_keys(operation, {"op", "clip_id", "ignore_link"}, optional={"ignore_link"})
            clip = _clip(document, operation.get("clip_id"))
            targets = (
                [clip] if _ignore_link(operation) else list(_clip_link_members(document, clip))
            )
            for target in list(targets):
                if target not in clips:
                    continue
                clips.remove(target)
                captions[:] = [
                    c for c in captions if c["source_clip_id"] != target["clip_id"]
                ]
                if document.get("transitions"):
                    document["transitions"] = [
                        item
                        for item in document["transitions"]
                        if item.get("after_clip_id") != target["clip_id"]
                        and item.get("incoming_clip_id") != target["clip_id"]
                    ]
            _drop_empty_link_groups(document)
        elif op == "move_clip":
            _exact_keys(
                operation,
                {"op", "clip_id", "to_index", "ignore_link"},
                optional={"ignore_link"},
            )
            clip = _clip(document, operation.get("clip_id"))
            to_index = operation.get("to_index")
            if (
                not isinstance(to_index, int)
                or isinstance(to_index, bool)
                or not 0 <= to_index < len(clips)
            ):
                raise DomainError("TIMELINE_INVALID", "目标片段位置不合法")
            if _ignore_link(operation) or not clip.get("link_group_id"):
                clips.remove(clip)
                clips.insert(to_index, clip)
            else:
                # W0.3：整组保持相对次序落到目标邻域（规划门 §5.2）。
                members = _clip_link_members(document, clip)
                member_ids = {m["clip_id"] for m in members}
                block = [c for c in clips if c["clip_id"] in member_ids]
                rest = [c for c in clips if c["clip_id"] not in member_ids]
                insert_at = max(0, min(to_index, len(rest)))
                clips[:] = rest[:insert_at] + block + rest[insert_at:]
        elif op == "position_clips":
            # 一次原子重排：先校验全部目标，再统一落位，避免交换/涟漪编辑
            # 在中间状态碰到同轨重叠。每个位置显式给出，调用方负责链接组规划。
            _exact_keys(operation, {"op", "placements", "ignore_link"}, optional={"ignore_link"})
            placements = operation.get("placements")
            if not isinstance(placements, list) or not placements:
                raise DomainError("TIMELINE_INVALID", "批量位置不能为空")
            ignore_link = operation.get("ignore_link", False)
            if not isinstance(ignore_link, bool):
                raise DomainError("TIMELINE_INVALID", "批量位置链接选项不合法")
            prepared: list[tuple[dict[str, Any], int, str]] = []
            seen: set[str] = set()
            track_by_id = {track["id"]: track for track in document.get("tracks", [])}
            locked_ids = set(document.get("locked_elements", []))
            for raw in placements:
                item = _mapping(raw, "批量位置不合法")
                _exact_keys(
                    item, {"clip_id", "timeline_start_us", "track_id"}, optional={"track_id"}
                )
                clip = _clip(document, item.get("clip_id"))
                if clip["clip_id"] in seen:
                    raise DomainError("TIMELINE_INVALID", "批量位置包含重复片段")
                seen.add(clip["clip_id"])
                start = _integer(item.get("timeline_start_us"), "时间线开始时间不合法")
                target_id = item.get("track_id", clip["track_id"])
                target = track_by_id.get(target_id) if isinstance(target_id, str) else None
                expected = "audio" if clip["asset_kind"] == "audio" else "video"
                if start < 0 or target is None or target.get("kind") != expected:
                    raise DomainError("TIMELINE_INVALID", "批量位置或目标轨道不合法")
                if (
                    clip["clip_id"] in locked_ids
                    or track_by_id.get(clip["track_id"], {}).get("locked")
                    or target.get("locked")
                ):
                    raise DomainError("TIMELINE_LOCKED", "片段或目标轨道已锁定")
                prepared.append((clip, start, target_id))
            placement_by_id = {clip["clip_id"]: (start, target_id) for clip, start, target_id in prepared}
            moving_ids = set(placement_by_id)
            if not ignore_link:
                for clip, start, _target_id in prepared:
                    link_id = clip.get("link_group_id")
                    if not link_id:
                        continue
                    remaining = [
                        member for member in clips
                        if member.get("link_group_id") == link_id
                    ]
                    missing = [
                        member for member in remaining
                        if member["clip_id"] not in moving_ids
                        and member["clip_id"] not in locked_ids
                        and not track_by_id.get(member["track_id"], {}).get("locked")
                    ]
                    if missing:
                        raise DomainError("TIMELINE_LINKED", "批量移动必须包含所有未锁定的链接成员")
                    delta = start - clip["timeline_start_us"]
                    if any(
                        placement_by_id[member["clip_id"]][0] - member["timeline_start_us"] != delta
                        for member in remaining
                        if member["clip_id"] in moving_ids
                    ):
                        raise DomainError("TIMELINE_LINKED", "链接组成员必须保持相同时间位移")
            for clip, start, target_id in prepared:
                delta = start - clip["timeline_start_us"]
                duration = clip["timeline_end_us"] - clip["timeline_start_us"]
                if delta and clip["asset_kind"] != "audio":
                    for caption in captions:
                        if caption.get("source_clip_id") == clip["clip_id"]:
                            caption["start_us"] += delta
                            caption["end_us"] += delta
                clip["track_id"] = target_id
                clip["timeline_start_us"] = start
                clip["timeline_end_us"] = start + duration
        elif op == "split_timeline_clips":
            self._split_timeline_items(db, project_id, document, operation)
        elif op == "duplicate_timeline_items":
            self._duplicate_timeline_items(db, project_id, document, operation)
        elif op == "replace_clip_source":
            self._replace_clip_source(db, project_id, document, operation)
        elif op == "position_clip":
            # 自由定位：视频与音频片段都可以放在任意时间位置（同轨允许空隙）。
            # 可选 track_id：跨轨道移动（仅限同类型轨道；视频片段在视频轨之间
            # 移动，音频片段固定 A1）。同轨禁止重叠——前端负责钳制，这里兜底拒绝。
            _exact_keys(
                operation,
                {"op", "clip_id", "timeline_start_us", "track_id", "ignore_link"},
                optional={"track_id", "ignore_link"},
            )
            clip = _clip(document, operation.get("clip_id"))
            new_start = _integer(operation.get("timeline_start_us"), "时间线开始时间不合法")
            if new_start < 0:
                raise DomainError("TIMELINE_INVALID", "时间线开始时间不合法")
            op_track_id = operation.get("track_id")
            if op_track_id is not None and op_track_id != clip["track_id"]:
                target_track = next(
                    (
                        track
                        for track in document.get("tracks", [])
                        if track.get("id") == op_track_id
                    ),
                    None,
                )
                if target_track is None:
                    raise DomainError("TIMELINE_INVALID", "目标轨道不存在")
                expected_kind = "audio" if clip["asset_kind"] == "audio" else "video"
                if target_track.get("kind") != expected_kind:
                    raise DomainError("TIMELINE_INVALID", "片段与目标轨道类型不匹配")
                clip["track_id"] = op_track_id
            duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            if clip["asset_kind"] != "audio":
                for other in document["clips"]:
                    if (
                        other is not clip
                        and other.get("track_id") == clip["track_id"]
                        and new_start < other["timeline_end_us"]
                        and other["timeline_start_us"] < new_start + duration
                    ):
                        raise DomainError("TIMELINE_INVALID", "视频片段不能与其他片段重叠")
                delta = new_start - clip["timeline_start_us"]
                if delta:
                    for caption in document.get("captions", []):
                        if caption.get("source_clip_id") == clip["clip_id"]:
                            caption["start_us"] += delta
                            caption["end_us"] += delta
            position_delta = new_start - clip["timeline_start_us"]
            clip["timeline_start_us"] = new_start
            clip["timeline_end_us"] = new_start + duration
            if (
                not _ignore_link(operation)
                and clip.get("link_group_id")
                and position_delta
            ):
                for member in _clip_link_members(document, clip):
                    if member is clip:
                        continue
                    member["timeline_start_us"] += position_delta
                    member["timeline_end_us"] += position_delta
        elif op == "trim_clip":
            _exact_keys(
                operation,
                {"op", "clip_id", "source_start_us", "source_end_us", "ignore_link"},
                optional={"ignore_link"},
            )
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] not in ("video", "audio"):
                raise DomainError("TIMELINE_INVALID", "只有视频/音频片段可以修剪")
            new_start = _integer(operation.get("source_start_us"), "源开始时间不合法")
            new_end = _integer(operation.get("source_end_us"), "源结束时间不合法")
            old_source_start = clip["source_start_us"]
            old_source_end = clip["source_end_us"]
            if new_start < 0 or new_end - new_start < MIN_VIDEO_US or new_end > MAX_IMAGE_US:
                raise DomainError("TIMELINE_INVALID", "修剪范围无效或短于 100ms")
            asset = self._asset(db, project_id, clip["asset_id"])
            media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
            source_duration = media.get("duration_us")
            if (
                isinstance(source_duration, int)
                and not isinstance(source_duration, bool)
                and source_duration > 0
                and new_end > source_duration
            ):
                raise DomainError("TIMELINE_SOURCE_INVALID", "修剪范围超出原始素材时长")
            speed = _clip_speed(clip)
            retained_start = clip["timeline_start_us"] + round(
                (new_start - old_source_start) * 1000 / speed
            )
            clip["source_start_us"] = new_start
            clip["source_end_us"] = new_end
            clip["timeline_start_us"] = retained_start
            clip["timeline_end_us"] = retained_start + _clip_timeline_duration_us(
                new_start, new_end, speed
            )
            if clip["asset_kind"] == "video":
                # 绑定字幕直接钳制进新窗口（不再按"重打包回零"的位移回移）。
                self._trim_bound_captions(
                    document, clip["clip_id"], clip["timeline_start_us"], clip["timeline_end_us"], 0
                )
            if not _ignore_link(operation) and clip.get("link_group_id"):
                locked_ids = set(document.get("locked_elements", []))
                locked_tracks = {
                    track.get("id")
                    for track in document.get("tracks", [])
                    if track.get("locked")
                }
                lead_speed = _clip_speed(clip)
                lead_start_delta_us = round((new_start - old_source_start) * 1000 / lead_speed)
                lead_end_delta_us = round((new_end - old_source_end) * 1000 / lead_speed)
                for member in _clip_link_members(document, clip):
                    if member is clip:
                        continue
                    # OpenFilm trims every writable link partner together and leaves a locked
                    # partner where it is; one locked follower must not block the lead trim.
                    if member["clip_id"] in locked_ids or member["track_id"] in locked_tracks:
                        continue
                    if (
                        member.get("asset_id") != clip.get("asset_id")
                        or member.get("asset_kind") not in ("video", "audio")
                    ):
                        raise DomainError(
                            "TIMELINE_INVALID", "链接组成员素材不一致，无法联动修剪"
                        )
                    member_speed = _clip_speed(member)
                    old_member_start = member["source_start_us"]
                    old_member_end = member["source_end_us"]
                    member_start_delta_us = round(lead_start_delta_us * member_speed / 1000)
                    member_new_start = old_member_start + member_start_delta_us
                    member_end_delta_us = round(lead_end_delta_us * member_speed / 1000)
                    member_new_end = old_member_end + member_end_delta_us
                    if member_new_end - member_new_start < MIN_VIDEO_US:
                        raise DomainError(
                            "TIMELINE_INVALID", "修剪后链接组成员短于 100ms"
                        )
                    retained_start = member["timeline_start_us"] + lead_start_delta_us
                    retained_end = retained_start + _clip_timeline_duration_us(
                        member_new_start, member_new_end, member_speed
                    )
                    member["source_start_us"] = member_new_start
                    member["source_end_us"] = member_new_end
                    member["timeline_start_us"] = retained_start
                    member["timeline_end_us"] = retained_end
                    if member["asset_kind"] == "video":
                        self._trim_bound_captions(
                            document, member["clip_id"], retained_start, retained_end, 0
                        )
        elif op == "set_clip_source_window":
            _exact_keys(
                operation,
                {"op", "clip_id", "source_start_us", "source_end_us", "anchor"},
            )
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] not in ("video", "audio"):
                raise DomainError("TIMELINE_INVALID", "只有视频/音频片段可以调整素材源范围")
            new_start = _integer(operation.get("source_start_us"), "源开始时间不合法")
            new_end = _integer(operation.get("source_end_us"), "源结束时间不合法")
            anchor = _enum(operation.get("anchor"), {"start", "end", "timeline"}, "编辑锚点不合法")
            if new_start < 0 or new_end - new_start < MIN_VIDEO_US or new_end > MAX_IMAGE_US:
                raise DomainError("TIMELINE_INVALID", "素材源范围必须至少为 100ms")

            for member in _clip_link_members(document, clip):
                if (
                    member.get("asset_id") != clip.get("asset_id")
                    or member.get("asset_kind") not in ("video", "audio")
                ):
                    raise DomainError("TIMELINE_INVALID", "链接组素材不一致，无法调整素材源范围")
                asset = self._asset(db, project_id, member["asset_id"])
                media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
                asset_duration = media.get("duration_us")
                if isinstance(asset_duration, bool) or (
                    asset_duration is not None and not isinstance(asset_duration, int)
                ):
                    raise DomainError("TIMELINE_SOURCE_INVALID", "素材源范围超出原始素材时长")
                duration_known = asset_duration is not None and asset_duration > 0
                if duration_known and (asset_duration < MIN_VIDEO_US or new_end > asset_duration):
                    raise DomainError("TIMELINE_SOURCE_INVALID", "素材源范围超出原始素材时长")

                old_start = member["timeline_start_us"]
                old_end = member["timeline_end_us"]
                speed = _clip_speed(member)
                duration = _clip_timeline_duration_us(new_start, new_end, speed)
                if anchor == "start":
                    timeline_start, timeline_end = old_start, old_start + duration
                elif anchor == "end":
                    timeline_start, timeline_end = old_end - duration, old_end
                else:
                    if duration != old_end - old_start:
                        raise DomainError(
                            "TIMELINE_INVALID",
                            "滑移素材源范围不能改变片段在时间线中的时长",
                        )
                    timeline_start, timeline_end = old_start, old_end

                member["source_start_us"] = new_start
                member["source_end_us"] = new_end
                member["timeline_start_us"] = timeline_start
                member["timeline_end_us"] = timeline_end
                if anchor != "timeline" and member["asset_kind"] == "video":
                    self._trim_bound_captions(
                        document, member["clip_id"], timeline_start, timeline_end, 0
                    )
        elif op == "split_clip":
            _exact_keys(operation, {"op", "clip_id", "source_time_us"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] != "video":
                raise DomainError("TIMELINE_INVALID", "只有视频片段可以拆分")
            split_source = _integer(operation.get("source_time_us"), "拆分时间不合法")
            if not clip["source_start_us"] < split_source < clip["source_end_us"]:
                raise DomainError("TIMELINE_INVALID", "拆分时间必须位于片段内部")
            if (
                split_source - clip["source_start_us"] < MIN_VIDEO_US
                or clip["source_end_us"] - split_source < MIN_VIDEO_US
            ):
                raise DomainError("TIMELINE_INVALID", "拆分后的片段不得短于 100ms")
            split_timeline = clip["timeline_start_us"] + round(
                (split_source - clip["source_start_us"]) * 1000 / _clip_speed(clip)
            )
            right = copy.deepcopy(clip)
            right["clip_id"] = f"clip_{new_id()}"
            right["source_start_us"] = split_source
            clip["source_end_us"] = split_source
            index = clips.index(clip)
            clips.insert(index + 1, right)
            _remap_transition_outgoing_after_split(document, clip["clip_id"], right["clip_id"])
            # 自由定位模型：显式落位（左段止于拆分点、右段从拆分点起），
            # normalize 不再重排 V1 时间。
            old_timeline_end = clip["timeline_end_us"]
            clip["timeline_end_us"] = split_timeline
            right["timeline_start_us"] = split_timeline
            right["timeline_end_us"] = old_timeline_end
            _split_fade_pair(clip, right)
            # B3：关键帧按拆分点切分归两侧。
            split_t_us = split_timeline - clip["timeline_start_us"]
            _split_clip_keyframes(clip, right, split_t_us)
            self._split_bound_captions(document, clip["clip_id"], right["clip_id"], split_timeline)
        elif op == "split_edit":
            # W1.4：原子「画面切点 + 声音偏移 Δ」。音频切点 = source_time + audio_delta_us。
            # J-cut：delta<0（下段声先入）；L-cut：delta>0（上段声延后）。
            _exact_keys(
                operation,
                {"op", "clip_id", "source_time_us", "audio_delta_us"},
            )
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] != "video":
                raise DomainError("TIMELINE_INVALID", "只有视频片段可以做声画分离剪辑")
            split_source = _integer(operation.get("source_time_us"), "拆分时间不合法")
            audio_delta = _integer(operation.get("audio_delta_us"), "声音偏移不合法")
            if not clip["source_start_us"] < split_source < clip["source_end_us"]:
                raise DomainError("TIMELINE_INVALID", "拆分时间必须位于片段内部")
            if (
                split_source - clip["source_start_us"] < MIN_VIDEO_US
                or clip["source_end_us"] - split_source < MIN_VIDEO_US
            ):
                raise DomainError("TIMELINE_INVALID", "拆分后的片段不得短于 100ms")
            audio_cut = split_source + audio_delta
            if not (
                clip["source_start_us"] <= audio_cut <= clip["source_end_us"]
            ):
                raise DomainError("TIMELINE_INVALID", "声音切点越出素材范围")
            if (
                audio_cut - clip["source_start_us"] < MIN_VIDEO_US
                and clip["source_end_us"] - audio_cut < MIN_VIDEO_US
            ):
                raise DomainError("TIMELINE_INVALID", "声音切点两侧均过短")
            # 画面拆分（同 split_clip 自由定位语义）
            speed = _clip_speed(clip)
            split_timeline = clip["timeline_start_us"] + round(
                (split_source - clip["source_start_us"]) * 1000 / speed
            )
            right = copy.deepcopy(clip)
            right["clip_id"] = f"clip_{new_id()}"
            right["source_start_us"] = split_source
            clip["source_end_us"] = split_source
            index = clips.index(clip)
            clips.insert(index + 1, right)
            _remap_transition_outgoing_after_split(document, clip["clip_id"], right["clip_id"])
            old_timeline_end = clip["timeline_end_us"]
            clip["timeline_end_us"] = split_timeline
            right["timeline_start_us"] = split_timeline
            right["timeline_end_us"] = old_timeline_end
            _split_fade_pair(clip, right)
            _split_clip_keyframes(clip, right, split_timeline - clip["timeline_start_us"])
            self._split_bound_captions(
                document, clip["clip_id"], right["clip_id"], split_timeline
            )
            # 声音：内嵌 → 派生 A1 并静音 V1（防双声）；已有链接 A1 → 拆 A1。
            gain = clip["audio"].get("gain_db", 0.0)
            linked_audio = next(
                (
                    c
                    for c in _clip_link_members(document, clip)
                    if c is not clip and c.get("asset_kind") == "audio"
                ),
                None,
            )
            if linked_audio is not None:
                if not (
                    linked_audio["source_start_us"]
                    <= audio_cut
                    <= linked_audio["source_end_us"]
                ):
                    raise DomainError("TIMELINE_INVALID", "声音切点越出音频素材范围")
                audio_right = copy.deepcopy(linked_audio)
                audio_right["clip_id"] = f"clip_{new_id()}"
                audio_right["source_start_us"] = audio_cut
                linked_audio["source_end_us"] = audio_cut
                a_index = clips.index(linked_audio)
                clips.insert(a_index + 1, audio_right)
                a_split_t = linked_audio["timeline_start_us"] + (
                    audio_cut - linked_audio["source_start_us"]
                )
                a_old_end = linked_audio["timeline_end_us"]
                linked_audio["timeline_end_us"] = a_split_t
                audio_right["timeline_start_us"] = a_split_t
                audio_right["timeline_end_us"] = a_old_end
                # 组内若拆成多段，保持 link_group_id
                if right.get("link_group_id"):
                    audio_right["link_group_id"] = right["link_group_id"]
            elif clip["audio"].get("enabled"):
                # 内嵌音轨：派生 A1 两段（音频切点），V1 两段静音
                left_audio = {
                    "clip_id": f"clip_{new_id()}",
                    "track_id": AUDIO_TRACK_ID,
                    "order_index": 0,
                    "asset_id": clip["asset_id"],
                    "asset_kind": "audio",
                    "source_start_us": clip["source_start_us"],
                    "source_end_us": audio_cut,
                    "timeline_start_us": clip["timeline_start_us"],
                    "timeline_end_us": clip["timeline_start_us"]
                    + max(0, audio_cut - clip["source_start_us"]),
                    "layout": "fit",
                    "audio": _fade_carried(
                        {"enabled": True, "gain_db": gain}, clip["audio"], "in"
                    ),
                    "speed_milli": 1000,
                }
                right_audio = {
                    "clip_id": f"clip_{new_id()}",
                    "track_id": AUDIO_TRACK_ID,
                    "order_index": 0,
                    "asset_id": clip["asset_id"],
                    "asset_kind": "audio",
                    "source_start_us": audio_cut,
                    "source_end_us": right["source_end_us"],
                    "timeline_start_us": right["timeline_start_us"],
                    "timeline_end_us": right["timeline_start_us"]
                    + max(0, right["source_end_us"] - audio_cut),
                    "layout": "fit",
                    # 淡出取**右段**的 audio：_split_fade_pair 已把淡出归给右段。
                    "audio": _fade_carried(
                        {"enabled": True, "gain_db": gain}, right["audio"], "out"
                    ),
                    "speed_milli": 1000,
                }
                # 时间线长度对齐源音频段（speed=1000）
                left_audio["timeline_end_us"] = left_audio["timeline_start_us"] + (
                    audio_cut - clip["source_start_us"]
                )
                right_audio["timeline_end_us"] = right_audio["timeline_start_us"] + (
                    right["source_end_us"] - audio_cut
                )
                clip["audio"] = {"enabled": False, "gain_db": gain}
                right["audio"] = {"enabled": False, "gain_db": gain}
                clips.append(left_audio)
                clips.append(right_audio)
                for offset, aclip in enumerate(
                    [c for c in clips if c["track_id"] == AUDIO_TRACK_ID]
                ):
                    aclip["order_index"] = offset
            else:
                clip["audio"] = {"enabled": False, "gain_db": gain}
                right["audio"] = {"enabled": False, "gain_db": gain}
            _drop_empty_link_groups(document)
        elif op == "detach_audio":
            # W0.3：A/V 对构造器——同源派生 A1 音频并与画面默认链接（D1）。
            _exact_keys(operation, {"op", "clip_id"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] != "video":
                raise DomainError("TIMELINE_INVALID", "只有视频片段可以分离音频")
            if not clip["audio"].get("enabled"):
                raise DomainError("TIMELINE_INVALID", "视频片段没有可分离的音轨")
            if any(
                c.get("asset_kind") == "audio"
                and c.get("asset_id") == clip.get("asset_id")
                and c.get("source_start_us") == clip.get("source_start_us")
                and c.get("source_end_us") == clip.get("source_end_us")
                and c.get("track_id") == AUDIO_TRACK_ID
                for c in clips
            ):
                raise DomainError("TIMELINE_INVALID", "该片段音频已分离")
            audio_clip = {
                "clip_id": f"clip_{new_id()}",
                "track_id": AUDIO_TRACK_ID,
                "order_index": 0,
                "asset_id": clip["asset_id"],
                "asset_kind": "audio",
                "source_start_us": clip["source_start_us"],
                "source_end_us": clip["source_end_us"],
                "timeline_start_us": clip["timeline_start_us"],
                "timeline_end_us": clip["timeline_end_us"],
                "layout": "fit",
                "audio": {
                    **{
                        field: clip["audio"][field]
                        for field in ("fade_in_us", "fade_out_us")
                        if field in clip["audio"]
                    },
                    "enabled": True,
                    "gain_db": clip["audio"].get("gain_db", 0.0),
                },
                "speed_milli": clip.get("speed_milli", 1000),
            }
            group_id = clip.get("link_group_id") or f"link_{new_id()}"
            clip["link_group_id"] = group_id
            audio_clip["link_group_id"] = group_id
            clip["audio"] = {"enabled": False, "gain_db": clip["audio"].get("gain_db", 0.0)}
            clips.append(audio_clip)
            a1_clips = [c for c in clips if c["track_id"] == AUDIO_TRACK_ID]
            audio_clip["order_index"] = len(a1_clips) - 1
        elif op == "set_clip_link":
            _exact_keys(operation, {"op", "clip_ids"})
            clip_ids = operation.get("clip_ids")
            if (
                not isinstance(clip_ids, list)
                or len(clip_ids) < 2
                or len(set(clip_ids)) != len(clip_ids)
            ):
                raise DomainError("TIMELINE_INVALID", "链接至少需要两个不同片段")
            members = [_clip(document, clip_id) for clip_id in clip_ids]
            group_id = f"link_{new_id()}"
            for member in members:
                member["link_group_id"] = group_id
        elif op == "clear_clip_link":
            _exact_keys(operation, {"op", "clip_id"})
            clip = _clip(document, operation.get("clip_id"))
            for member in _clip_link_members(document, clip):
                member.pop("link_group_id", None)
        elif op == "set_layout":
            _exact_keys(operation, {"op", "clip_id", "layout"})
            _clip(document, operation.get("clip_id"))["layout"] = _enum(
                operation.get("layout"), LAYOUTS, "布局不合法"
            )
        elif op == "set_audio":
            _exact_keys(
                operation,
                {"op", "clip_id", "enabled", "gain_db", "fade_in_us", "fade_out_us"},
                optional={"fade_in_us", "fade_out_us"},
            )
            clip = _clip(document, operation.get("clip_id"))
            enabled = operation.get("enabled")
            gain_db = _float_value(operation.get("gain_db"), "音频增益不合法")
            if not isinstance(enabled, bool) or not -60 <= gain_db <= 12:
                raise DomainError("TIMELINE_INVALID", "音频设置不合法")
            if clip["asset_kind"] == "image" and enabled:
                raise DomainError("TIMELINE_INVALID", "图片片段不能启用音频")
            # 淡入/淡出为可选字段：出现时必须是非负整数微秒。缺省 = 保留原值
            # （响度统一等既有 op 只写 enabled/gain_db，不能悄悄清掉用户设的淡变）。
            audio = {"enabled": enabled, "gain_db": gain_db}
            for field in ("fade_in_us", "fade_out_us"):
                if field in operation:
                    # 显式 0 = 清除该淡变：归一为「键不存在」，与老文档同形。
                    value = _fade_value(operation.get(field), "音频淡入淡出时长不合法")
                    if value > 0:
                        audio[field] = value
                elif field in clip["audio"]:
                    audio[field] = clip["audio"][field]
            clip["audio"] = audio
        elif op == "set_clip_transition_facts":
            if not any(field in operation for field in ("picture_fade_in_us", "picture_fade_out_us", "move_in", "move_out")):
                raise DomainError("TIMELINE_INVALID", "转场来源事实操作至少需要一个字段")
            _exact_keys(
                operation,
                {"op", "clip_id", "picture_fade_in_us", "picture_fade_out_us", "move_in", "move_out"},
                optional={"picture_fade_in_us", "picture_fade_out_us", "move_in", "move_out"},
            )
            clip = _clip(document, operation.get("clip_id"))
            if clip.get("asset_kind") == "audio":
                raise DomainError("TIMELINE_INVALID", "画面转场来源事实只能设置在视觉片段上")
            clip_duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            for field in ("picture_fade_in_us", "picture_fade_out_us"):
                if field not in operation:
                    continue
                value = operation[field]
                if value is None:
                    clip.pop(field, None)
                    continue
                duration = _integer(value, "画面淡变时长不合法")
                if duration < 0 or duration > clip_duration:
                    raise DomainError("TIMELINE_TRANSITION_INVALID", "画面淡变时长不得超过片段时长")
                if duration == 0:
                    clip.pop(field, None)
                else:
                    clip[field] = duration
            for field in ("move_in", "move_out"):
                if field not in operation:
                    continue
                value = operation[field]
                if value is None:
                    clip.pop(field, None)
                    continue
                _exact_keys(value, {"preset_id", "duration_us"})
                preset_id = _enum(value.get("preset_id"), TRANSITION_MOVE_PRESET_IDS, "运动转场预设不合法")
                duration = _integer(value.get("duration_us"), "运动转场时长不合法")
                if duration < 0 or duration > clip_duration:
                    raise DomainError("TIMELINE_TRANSITION_INVALID", "运动转场时长不得超过片段时长")
                if duration == 0:
                    clip.pop(field, None)
                else:
                    clip[field] = {"preset_id": preset_id, "duration_us": duration}
            if clip.get("picture_fade_in_us", 0) + clip.get("picture_fade_out_us", 0) > clip_duration:
                raise DomainError("TIMELINE_TRANSITION_INVALID", "画面淡入淡出总时长不得超过片段时长")
        elif op == "set_speed":
            _exact_keys(operation, {"op", "clip_id", "speed_milli", "ripple"}, optional={"ripple"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] not in ("video", "audio"):
                raise DomainError("TIMELINE_INVALID", "只有视频/音频片段可以变速")
            speed = operation.get("speed_milli")
            if (
                isinstance(speed, bool)
                or not isinstance(speed, int)
                or not MIN_SPEED_MILLI <= speed <= MAX_SPEED_MILLI
            ):
                raise DomainError("TIMELINE_INVALID", "速度需在 0.1x-100x 之间")
            old_duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            clip["speed_milli"] = speed
            if clip["asset_kind"] == "video":
                # V1 自由定位：起点不动、终点随速度变化；变长时把撞上的
                # 后续片段涟漪右推（变短则留出空隙）。
                new_duration = _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], speed
                )
                clip["timeline_end_us"] = clip["timeline_start_us"] + new_duration
                if operation.get("ripple", True):
                    self._ripple_track_right(clips, captions, clip)
                # B3：片段时长变化，关键帧时间等比重映射。
                _remap_clip_keyframes(clip, old_duration, new_duration)
            else:
                # A1 自由定位：右缘固定、左缘平移以保持终点。
                new_duration = _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], speed
                )
                clip["timeline_start_us"] = clip["timeline_end_us"] - new_duration
                _remap_clip_keyframes(clip, old_duration, new_duration)
        elif op == "set_reverse_playback":
            _exact_keys(operation, {"op", "clip_id", "reverse_playback"})
            clip = _clip(document, operation.get("clip_id"))
            reversed_flag = operation.get("reverse_playback")
            if not isinstance(reversed_flag, bool):
                raise DomainError("TIMELINE_INVALID", "倒放状态不合法")
            if clip["asset_kind"] != "video":
                raise DomainError("TIMELINE_INVALID", "只有视频片段可以倒放")
            clip["reverse_playback"] = reversed_flag
        elif op == "set_image_duration":
            _exact_keys(operation, {"op", "clip_id", "duration_us"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] != "image":
                raise DomainError("TIMELINE_INVALID", "只有图片片段可以设置时长")
            duration = _integer(operation.get("duration_us"), "图片时长不合法")
            if not MIN_IMAGE_US <= duration <= MAX_IMAGE_US:
                raise DomainError("TIMELINE_INVALID", "图片时长需至少为 100ms，且不得超出安全整数范围")
            old_duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            clip["timeline_end_us"] = clip["timeline_start_us"] + duration
            # P231：涟漪按轨——任意视觉轨的图片片段时长变化均涟漪右推
            # 同轨后续片段（V1 轨 = 同轨特例，行为不变）。
            self._ripple_track_right(clips, captions, clip)
            _remap_clip_keyframes(clip, old_duration, duration)
        elif op == "add_caption":
            _exact_keys(
                operation,
                {"op", "start_us", "end_us", "text", "preset_id", "source_clip_id"},
            )
            if operation.get("source_clip_id") is not None:
                raise DomainError("TIMELINE_INVALID", "手工字幕 source_clip_id 必须为 null")
            captions.append(
                {
                    "caption_id": f"caption_{new_id()}",
                    "track_id": "C1",
                    "source_clip_id": None,
                    "start_us": _integer(operation.get("start_us"), "字幕开始时间不合法"),
                    "end_us": _integer(operation.get("end_us"), "字幕结束时间不合法"),
                    "text": _caption_text(operation.get("text")),
                    "preset_id": _enum(
                        operation.get("preset_id"), CAPTION_PRESETS, "字幕预设不合法"
                    ),
                    "origin": "user",
                    "edited": True,
                    "source_segment_ids": [],
                }
            )
        elif op == "import_captions":
            # 批量导入字幕（SRT/ASS/LRC 在 desktop 端解析为结构化条目）。
            # replace_existing=true 时先清空手工字幕（origin=user）再导入；
            # 条目按时间排序、校验不重叠，逐条走 add_caption 相同的落库路径。
            _exact_keys(
                operation,
                {"op", "entries", "preset_id", "replace_existing"},
            )
            entries = operation.get("entries")
            if not isinstance(entries, list) or not entries:
                raise DomainError("TIMELINE_INVALID", "字幕条目不合法")
            if len(entries) > 2000:
                raise DomainError("TIMELINE_INVALID", "单次最多导入 2000 条字幕")
            preset = _enum(operation.get("preset_id"), CAPTION_PRESETS, "字幕预设不合法")
            parsed: list[tuple[int, int, str]] = []
            for entry in entries:
                if not isinstance(entry, dict) or set(entry.keys()) != {"start_us", "end_us", "text"}:
                    raise DomainError("TIMELINE_INVALID", "字幕条目不合法")
                start = _integer(entry.get("start_us"), "字幕开始时间不合法")
                end = _integer(entry.get("end_us"), "字幕结束时间不合法")
                if start < 0 or end - start < MIN_CAPTION_US:
                    raise DomainError("TIMELINE_INVALID", "字幕条目时长不足 0.2s")
                parsed.append((start, end, _caption_text(entry.get("text"))))
            parsed.sort(key=lambda item: item[0])
            for index in range(1, len(parsed)):
                if parsed[index][0] < parsed[index - 1][1]:
                    raise DomainError("TIMELINE_INVALID", "字幕条目时间重叠")
            if operation.get("replace_existing") is True:
                captions[:] = [c for c in captions if c.get("origin") != "user"]
            for start, end, text in parsed:
                captions.append(
                    {
                        "caption_id": f"caption_{new_id()}",
                        "track_id": "C1",
                        "source_clip_id": None,
                        "start_us": start,
                        "end_us": end,
                        "text": text,
                        "preset_id": preset,
                        "origin": "user",
                        "edited": True,
                        "source_segment_ids": [],
                    }
                )
        elif op == "remove_caption":
            _exact_keys(operation, {"op", "caption_id"})
            captions.remove(_caption(document, operation.get("caption_id")))
        elif op == "update_caption":
            _exact_keys(operation, {"op", "caption_id", "text"})
            caption = _caption(document, operation.get("caption_id"))
            caption["text"] = _caption_text(operation.get("text"))
            caption["edited"] = True
        elif op == "set_caption_timing":
            _exact_keys(operation, {"op", "caption_id", "start_us", "end_us"})
            caption = _caption(document, operation.get("caption_id"))
            caption["start_us"] = _integer(operation.get("start_us"), "字幕开始时间不合法")
            caption["end_us"] = _integer(operation.get("end_us"), "字幕结束时间不合法")
            caption["edited"] = True
        elif op == "set_caption_preset":
            _exact_keys(operation, {"op", "caption_id", "preset_id"})
            caption = _caption(document, operation.get("caption_id"))
            caption["preset_id"] = _enum(
                operation.get("preset_id"), CAPTION_PRESETS, "字幕预设不合法"
            )
            caption["edited"] = True
        elif op == "set_caption_style":
            # B4：部分覆盖合并（未提及字段保留预设或既有覆盖）。
            _exact_keys(operation, {"op", "caption_id", "style"})
            caption = _caption(document, operation.get("caption_id"))
            style = _validate_caption_style(operation.get("style"), self.font_families)
            override = dict(caption.get("style_override") or {})
            override.update(style)
            caption["style_override"] = override
            caption["edited"] = True
        elif op == "clear_caption_style":
            _exact_keys(operation, {"op", "caption_id"})
            caption = _caption(document, operation.get("caption_id"))
            if "style_override" not in caption:
                raise DomainError("TIMELINE_INVALID", "该字幕没有样式覆盖")
            del caption["style_override"]
            caption["edited"] = True
        elif op == "set_clip_locked":
            _exact_keys(operation, {"op", "clip_id", "locked"})
            clip_id = _clip(document, operation.get("clip_id"))["clip_id"]
            locked = operation.get("locked")
            if not isinstance(locked, bool):
                raise DomainError("TIMELINE_INVALID", "锁定状态不合法")
            locked_ids = document["locked_elements"]
            if locked and clip_id not in locked_ids:
                locked_ids.append(clip_id)
            elif not locked and clip_id in locked_ids:
                locked_ids.remove(clip_id)
        elif op == "add_track":
            _exact_keys(
                operation,
                {"op", "kind", "track_id", "before_track_id", "after_track_id", "audio_index"},
                optional={"track_id", "before_track_id", "after_track_id", "audio_index"},
            )
            kind = _enum(operation.get("kind"), ("video", "audio", "text"), "轨道类型不合法")
            tracks_list = document["tracks"]
            prefix = {"video": "V", "audio": "A", "text": "T"}[kind]
            first_number = {"video": 2, "audio": 2, "text": 1}[kind]
            existing_ids = {track.get("id") for track in tracks_list}
            requested_id = operation.get("track_id")
            if requested_id is None:
                number = first_number
                while f"{prefix}{number}" in existing_ids:
                    number += 1
                requested_id = f"{prefix}{number}"
            if (
                not isinstance(requested_id, str)
                or not requested_id.startswith(prefix)
                or requested_id in existing_ids
                or requested_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID, CAPTION_TRACK_ID}
                or not requested_id[len(prefix):].isdigit()
                or int(requested_id[len(prefix):]) < first_number
            ):
                raise DomainError("TIMELINE_INVALID", "新增轨道 ID 不合法或已存在")
            _identifier(requested_id, "新增轨道 ID 不合法")
            before_id = operation.get("before_track_id")
            after_id = operation.get("after_track_id")
            audio_index = operation.get("audio_index")
            if before_id is not None and after_id is not None:
                raise DomainError("TIMELINE_INVALID", "新增轨道锚点不能同时指定前后位置")
            if audio_index is not None and (before_id is not None or after_id is not None or kind != "audio"):
                raise DomainError("TIMELINE_INVALID", "audio_index 仅适用于无锚点的新增音频轨")
            new_track = _empty_track(requested_id, kind)
            if kind == "audio":
                audio_ids = [track["id"] for track in tracks_list if track.get("kind") == "audio"]
                if audio_index is not None:
                    if (
                        isinstance(audio_index, bool)
                        or not isinstance(audio_index, int)
                        or not 0 <= audio_index <= len(audio_ids) - 1
                    ):
                        raise DomainError("TIMELINE_INVALID", "音频轨插入位置不合法")
                    slot = audio_index
                    insertion_id = audio_ids[slot + 1] if slot < len(audio_ids) - 1 else None
                    insert_at = (
                        next(i for i, track in enumerate(tracks_list) if track["id"] == insertion_id)
                        if insertion_id is not None else len(tracks_list)
                    )
                elif before_id is not None or after_id is not None:
                    anchor_id = before_id if before_id is not None else after_id
                    anchor = next((i for i, track in enumerate(tracks_list) if track["id"] == anchor_id), None)
                    if anchor is None or tracks_list[anchor].get("kind") != "audio" or anchor_id == AUDIO_TRACK_ID and before_id is not None:
                        raise DomainError("TIMELINE_INVALID", "音频轨锚点必须是音频轨")
                    insert_at = anchor + (1 if after_id is not None else 0)
                else:
                    insert_at = len(tracks_list)
            else:
                if before_id is not None or after_id is not None:
                    anchor_id = before_id if before_id is not None else after_id
                    anchor = next((i for i, track in enumerate(tracks_list) if track["id"] == anchor_id), None)
                    if anchor is None or anchor_id == CAPTION_TRACK_ID or tracks_list[anchor].get("kind") not in ("video", "text"):
                        raise DomainError("TIMELINE_INVALID", "视觉轨锚点必须是视频或文本轨")
                    insert_at = anchor + (1 if after_id is not None else 0)
                else:
                    insert_at = next(
                        (i for i, track in enumerate(tracks_list) if track.get("id") == CAPTION_TRACK_ID),
                        next(i for i, track in enumerate(tracks_list) if track.get("id") == MAIN_TRACK_ID),
                    )
            tracks_list.insert(insert_at, new_track)
        elif op == "remove_track":
            # 删除动态轨道：其上的片段与绑定字幕一并级联删除。
            # 仅主视频轨与音频轨位置、数量固定；文本轨与其他动态轨一致可删除。
            _exact_keys(operation, {"op", "track_id"})
            track_id = operation.get("track_id")
            if track_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID}:
                raise DomainError("TIMELINE_INVALID", "固定轨道不能删除")
            tracks_list = document["tracks"]
            track = next((t for t in tracks_list if t.get("id") == track_id), None)
            if track is None:
                raise DomainError("TIMELINE_INVALID", "轨道不存在")
            removed_clip_ids = {
                clip["clip_id"] for clip in clips if clip.get("track_id") == track_id
            }
            if removed_clip_ids.intersection(document.get("locked_elements", [])):
                raise DomainError("TIMELINE_LOCKED", "轨道中存在锁定的片段")
            for clip in clips:
                if clip["clip_id"] in removed_clip_ids and clip.get("link_group_id"):
                    for member in _clip_link_members(document, clip):
                        member_track = next(
                            (t for t in tracks_list if t.get("id") == member.get("track_id")), None
                        )
                        if member["clip_id"] in document.get("locked_elements", []) or (
                            member_track and member_track.get("locked")
                        ):
                            raise DomainError("TIMELINE_LOCKED", "轨道中存在已锁定的链接片段")
            clips[:] = [clip for clip in clips if clip.get("track_id") != track_id]
            captions[:] = [
                caption
                for caption in captions
                if caption.get("source_clip_id") not in removed_clip_ids
            ]
            document["locked_elements"] = [
                item
                for item in document.get("locked_elements", [])
                if item not in removed_clip_ids
            ]
            tracks_list.remove(track)
        elif op == "move_track":
            # to_index 是同一轨道组内的 0-based 动态位置；A1/V1/C1 保持固定。
            _exact_keys(operation, {"op", "track_id", "to_index"})
            track_id = operation.get("track_id")
            to_index = operation.get("to_index")
            if track_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID}:
                raise DomainError("TIMELINE_INVALID", "固定轨道不能移动")
            tracks_list = document["tracks"]
            track = next((t for t in tracks_list if t.get("id") == track_id), None)
            if track is None:
                raise DomainError("TIMELINE_INVALID", "轨道不存在")
            if track.get("id") in {MAIN_TRACK_ID, AUDIO_TRACK_ID, CAPTION_TRACK_ID}:
                raise DomainError("TIMELINE_INVALID", "固定轨道不能移动")
            fixed_track_ids = {MAIN_TRACK_ID, AUDIO_TRACK_ID, CAPTION_TRACK_ID}
            if track.get("kind") == "audio":
                group = [
                    item for item in tracks_list
                    if item.get("kind") == "audio" and item.get("id") not in fixed_track_ids
                ]
            else:
                group = [
                    item for item in tracks_list
                    if item.get("kind") in ("video", "text") and item.get("id") not in fixed_track_ids
                ]
            dynamic_count = len(group)
            if (
                not isinstance(to_index, int)
                or isinstance(to_index, bool)
                or not 0 <= to_index < dynamic_count
            ):
                raise DomainError("TIMELINE_INVALID", "目标轨道位置不合法")
            group.remove(track)
            group.insert(to_index, track)
            if track.get("kind") == "audio":
                first_dynamic_audio = next(i for i, item in enumerate(tracks_list) if item.get("id") == AUDIO_TRACK_ID) + 1
                tracks_list[:] = [item for item in tracks_list if item.get("kind") != "audio" or item.get("id") == AUDIO_TRACK_ID]
                tracks_list[first_dynamic_audio:first_dynamic_audio] = group
            else:
                slots = [
                    i for i, item in enumerate(tracks_list)
                    if item.get("kind") in ("video", "text") and item.get("id") not in fixed_track_ids
                ]
                for slot, member in zip(slots, group, strict=True):
                    tracks_list[slot] = member
        elif op == "set_track_flags":
            # 轨道属性（部分覆盖）：锁定全类型；隐藏仅视频/文本；
            # 静音/独奏仅视频/音频。
            _exact_keys(
                operation,
                {"op", "track_id", "locked", "hidden", "muted", "solo"},
                optional={"locked", "hidden", "muted", "solo"},
            )
            track = next(
                (
                    item
                    for item in document.get("tracks", [])
                    if item.get("id") == operation.get("track_id")
                ),
                None,
            )
            if track is None:
                raise DomainError("TIMELINE_INVALID", "轨道不存在")
            kind = track.get("kind")
            for flag in ("locked", "hidden", "muted", "solo"):
                value = operation.get(flag)
                if value is None:
                    continue
                if not isinstance(value, bool):
                    raise DomainError("TIMELINE_INVALID", "轨道标志不合法")
                if flag == "hidden" and kind not in ("video", "text"):
                    raise DomainError("TIMELINE_INVALID", "音频轨道不支持隐藏")
                if flag in ("muted", "solo") and kind not in ("video", "audio"):
                    raise DomainError("TIMELINE_INVALID", "文本轨道不支持静音/独奏")
                track[flag] = value
        elif op == "set_clip_keyframes":
            # B3：整属性覆盖（拖拽幂等提交，单 Revision 可撤销）。
            _exact_keys(operation, {"op", "clip_id", "property", "frames"})
            clip = _clip(document, operation.get("clip_id"))
            property_name = operation.get("property")
            if property_name not in KEYFRAME_PROPERTIES:
                raise DomainError("TIMELINE_INVALID", "关键帧属性不合法")
            frames = _validate_keyframe_track(
                operation.get("frames"), property_name,
                clip["timeline_end_us"] - clip["timeline_start_us"],
            )
            keyframes = clip.setdefault("keyframes", {})
            keyframes[property_name] = {"frames": frames}
        elif op == "clear_clip_keyframes":
            _exact_keys(operation, {"op", "clip_id", "property"})
            clip = _clip(document, operation.get("clip_id"))
            property_name = operation.get("property")
            if property_name not in KEYFRAME_PROPERTIES:
                raise DomainError("TIMELINE_INVALID", "关键帧属性不合法")
            keyframes = clip.get("keyframes")
            if not keyframes or property_name not in keyframes:
                raise DomainError("TIMELINE_INVALID", "该属性没有关键帧")
            del keyframes[property_name]
            if not keyframes:
                del clip["keyframes"]
        elif op == "set_clip_transform":
            # P1：整块替换片段静态变换（ful自可撤销）；字段必须合法。
            _exact_keys(operation, {"op", "clip_id", "transform"})
            clip = _clip(document, operation.get("clip_id"))
            transform = operation.get("transform")
            if not isinstance(transform, dict):
                raise DomainError("TIMELINE_INVALID", "静态变换不合法")
            _exact_keys(
                transform,
                {"x", "y", "scale", "rotate", "opacity"},
                optional={"x", "y", "scale", "rotate", "opacity"},
            )
            cleaned: dict[str, Any] = {}
            for field, value in transform.items():
                if field == "opacity" or field == "scale" or field == "rotate":
                    if isinstance(value, bool) or not isinstance(value, (int, float)):
                        raise DomainError("TIMELINE_INVALID", f"静态 {field} 不合法")
                if field == "x" or field == "y":
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
                        raise DomainError("TIMELINE_INVALID", f"静态 {field} 不合法")
                cleaned[field] = value
            if not cleaned:
                clip.pop("transform", None)
            else:
                clip["transform"] = cleaned
        elif op == "set_clip_mask":
            # P2：整块替换片段蒙版（线性/矩形/椭圆）；字段必须合法，空 dict 清除。
            _exact_keys(operation, {"op", "clip_id", "mask"})
            clip = _clip(document, operation.get("clip_id"))
            mask = operation.get("mask")
            if not isinstance(mask, dict):
                raise DomainError("TIMELINE_INVALID", "蒙版不合法")
            if not mask:
                clip.pop("mask", None)
                return
            _exact_keys(
                mask,
                {"kind", "x", "y", "width", "height", "rotation", "feather", "invert"},
                optional={"x", "y", "width", "height", "rotation", "feather", "invert"},
            )
            if mask.get("kind") not in ("linear", "rect", "ellipse"):
                raise DomainError("TIMELINE_INVALID", "蒙版类型不合法")
            cleaned_mask: dict[str, Any] = {}
            for field, value in mask.items():
                if field == "invert":
                    if value is not None and not isinstance(value, bool):
                        raise DomainError("TIMELINE_INVALID", "蒙版反选不合法")
                    cleaned_mask[field] = value
                    continue
                if field == "kind":
                    cleaned_mask[field] = value
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise DomainError("TIMELINE_INVALID", f"蒙版 {field} 不合法")
                if field == "width" or field == "height":
                    if value <= 0 or value > 1:
                        raise DomainError("TIMELINE_INVALID", f"蒙版 {field} 不合法")
                elif field in ("x", "y", "feather"):
                    if not 0 <= value <= 1:
                        raise DomainError("TIMELINE_INVALID", f"蒙版 {field} 不合法")
                elif field == "rotation":
                    if not -180 <= value <= 180:
                        raise DomainError("TIMELINE_INVALID", f"蒙版 {field} 不合法")
                cleaned_mask[field] = value
            if not cleaned_mask:
                clip.pop("mask", None)
            else:
                if cleaned_mask.get("kind") is None:
                    raise DomainError("TIMELINE_INVALID", "蒙版类型必填")
                clip["mask"] = cleaned_mask
        elif op == "set_clip_keying":
            # P3：整块替换片段抠像（纯色/绿幕）。空 dict 清除；字段必须合法。
            _exact_keys(operation, {"op", "clip_id", "keying"})
            clip = _clip(document, operation.get("clip_id"))
            keying = operation.get("keying")
            if not isinstance(keying, dict):
                raise DomainError("TIMELINE_INVALID", "抠像不合法")
            if not keying:
                clip.pop("keying", None)
                return
            _exact_keys(keying, {"color", "similarity", "blend", "invert"}, optional={"color", "similarity", "blend", "invert"})
            if "color" in keying and not (
                isinstance(keying["color"], str)
                and len(keying["color"]) == 6
                and all(ch in "0123456789abcdefABCDEF" for ch in keying["color"])
            ):
                raise DomainError("TIMELINE_INVALID", "抠像颜色需为 6 位十六进制")
            cleaned_keying: dict[str, Any] = {}
            for field in ("similarity", "blend"):
                value = keying.get(field)
                if value is None:
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
                    raise DomainError("TIMELINE_INVALID", f"抠像 {field} 不合法")
                cleaned_keying[field] = value
            if "color" in keying:
                cleaned_keying["color"] = keying["color"]
            if "invert" in keying:
                if not isinstance(keying["invert"], bool):
                    raise DomainError("TIMELINE_INVALID", "抠像反选不合法")
                cleaned_keying["invert"] = keying["invert"]
            clip["keying"] = cleaned_keying
        elif op == "add_transition":
            _exact_keys(operation, {"op", "after_clip_id", "kind", "duration_us"})
            document.setdefault("transitions", [])
            anchor, successor = self._transition_neighbors(clips, operation.get("after_clip_id"))
            self._require_unlocked(
                document,
                {"op": op, "clip_id": anchor["clip_id"], "after_clip_id": anchor["clip_id"], "incoming_clip_id": successor["clip_id"]},
            )
            kind = _enum(operation.get("kind"), TRANSITION_KINDS, "转场类型不合法")
            duration = _integer(operation.get("duration_us"), "转场时长不合法")
            if not MIN_TRANSITION_US <= duration <= MAX_TRANSITION_US:
                raise DomainError("TIMELINE_TRANSITION_INVALID", "转场时长需为 0.1-2 秒")
            if any(item["after_clip_id"] == anchor["clip_id"] for item in document["transitions"]):
                raise DomainError("TIMELINE_TRANSITION_EXISTS", "两片段之间已存在转场")
            if len(document["transitions"]) >= MAX_TRANSITIONS:
                raise DomainError("TIMELINE_TRANSITION_INVALID", "转场数量已达上限")
            document["transitions"].append(
                {
                    "transition_id": f"transition_{new_id()}",
                    "after_clip_id": anchor["clip_id"],
                    "incoming_clip_id": successor["clip_id"],
                    "kind": kind,
                    "duration_us": duration,
                }
            )
        elif op == "update_transition":
            _exact_keys(
                operation,
                {"op", "transition_id", "kind", "duration_us"},
                optional={"kind", "duration_us"},
            )
            transition = _transition(document, operation.get("transition_id"))
            kind = operation.get("kind")
            if kind is not None:
                transition["kind"] = _enum(kind, TRANSITION_KINDS, "转场类型不合法")
            duration = operation.get("duration_us")
            if duration is not None:
                duration = _integer(duration, "转场时长不合法")
                if not MIN_TRANSITION_US <= duration <= MAX_TRANSITION_US:
                    raise DomainError("TIMELINE_TRANSITION_INVALID", "转场时长需为 0.1-2 秒")
                transition["duration_us"] = duration
        elif op == "remove_transition":
            _exact_keys(operation, {"op", "transition_id"})
            transition = _transition(document, operation.get("transition_id"))
            document["transitions"].remove(transition)
        self._normalize_timing(document, old_starts)

    def _replace_clip_source(
        self, db: sqlite3.Connection, project_id: str, document: dict[str, Any], operation: dict[str, Any]
    ) -> None:
        _exact_keys(operation, {"op", "clip_id", "asset_id"})
        clip = _clip(document, operation.get("clip_id"))
        target_asset_id = _identifier(operation.get("asset_id"), "Asset ID 不合法")
        if target_asset_id == clip.get("asset_id"):
            raise DomainError("TIMELINE_INVALID", "替换素材必须与当前素材不同")
        self._require_unlocked(document, {"op": "replace_clip_source", "clip_id": clip["clip_id"]})
        track = next((item for item in document["tracks"] if item.get("id") == clip.get("track_id")), None)
        if track is None or track.get("locked"):
            raise DomainError("TIMELINE_LOCKED", "目标轨道已锁定或不存在")
        asset = self._asset(db, project_id, target_asset_id)
        media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
        old_duration = int(clip["timeline_end_us"]) - int(clip["timeline_start_us"])
        start = int(clip["timeline_start_us"])
        is_audio_target = track.get("kind") == "audio"
        if is_audio_target:
            if asset["kind"] not in ("audio", "video"):
                raise DomainError("TIMELINE_INVALID", "音频轨只能替换为音频或视频素材")
            source_kind = "audio"
        else:
            if asset["kind"] not in ("video", "image"):
                raise DomainError("TIMELINE_INVALID", "视觉轨只能替换为视频或图片素材")
            source_kind = asset["kind"]

        replacement = copy.deepcopy(clip)
        replacement["asset_id"] = target_asset_id
        replacement["asset_kind"] = source_kind
        replacement["layout"] = clip.get("layout", "fit")
        if source_kind != "video":
            replacement.pop("reverse_playback", None)

        if source_kind == "image":
            replacement["source_start_us"] = None
            replacement["source_end_us"] = None
            replacement.pop("speed_milli", None)
            replacement["audio"] = {"enabled": False, "gain_db": float(clip["audio"].get("gain_db", 0.0))}
            duration = old_duration
        else:
            asset_duration = media.get("duration_us")
            if isinstance(asset_duration, bool) or (
                asset_duration is not None
                and not isinstance(asset_duration, int)
            ):
                raise DomainError("TIMELINE_SOURCE_INVALID", "替换素材缺少可校验的有限时长")
            duration_known = asset_duration is not None and asset_duration > 0
            if duration_known and asset_duration < MIN_VIDEO_US:
                raise DomainError("TIMELINE_SOURCE_INVALID", "替换素材缺少可校验的有限时长")
            speed = _clip_speed(clip)
            needed_source = _round_half_up_ratio(old_duration * speed, 1000)
            source_start = 0
            source_end = (
                min(asset_duration, needed_source)
                if duration_known
                else needed_source
            )
            if source_end > MAX_IMAGE_US - source_start:
                raise DomainError("TIMELINE_INVALID", "替换源范围超出安全整数范围")
            if source_end < MIN_VIDEO_US:
                raise DomainError("TIMELINE_INVALID", "替换素材不足 100ms")
            duration = _clip_timeline_duration_us(source_start, source_end, speed)
            if duration < MIN_VIDEO_US:
                raise DomainError("TIMELINE_INVALID", "替换素材不足 100ms")
            replacement["source_start_us"] = source_start
            replacement["source_end_us"] = source_end
            replacement["speed_milli"] = speed
            old_audio = clip["audio"]
            has_audio = bool(media.get("audio_streams"))
            if is_audio_target:
                replacement["audio"] = {
                    **{key: old_audio[key] for key in ("fade_in_us", "fade_out_us") if key in old_audio},
                    "enabled": True,
                    "gain_db": float(old_audio.get("gain_db", 0.0)),
                }
                if asset["kind"] == "video" and not has_audio:
                    # Retain audio clip semantics; renderer supplies equal-length silence.
                    pass
            else:
                replacement["audio"] = {
                    **({key: old_audio[key] for key in ("fade_in_us", "fade_out_us") if key in old_audio} if has_audio else {}),
                    "enabled": bool(old_audio.get("enabled")) and has_audio,
                    "gain_db": float(old_audio.get("gain_db", 0.0)),
                }
            # A shorter source shortens the clip from its original start; a longer source
            # is trimmed to the exact source window needed to keep the target duration.
        end = start + duration
        if end > MAX_IMAGE_US:
            raise DomainError("TIMELINE_INVALID", "替换后的时间线结束点超出安全整数范围")
        replacement["timeline_start_us"] = start
        replacement["timeline_end_us"] = end
        old_duration = end - start
        if source_kind == "image":
            replacement["timeline_end_us"] = start + duration
        if source_kind == "audio":
            for field in ("keyframes", "transform", "mask", "keying"):
                replacement.pop(field, None)
        clip.clear()
        clip.update(replacement)

    def _duplicate_timeline_items(
        self, db: sqlite3.Connection, project_id: str, document: dict[str, Any], operation: dict[str, Any]
    ) -> None:
        _exact_keys(operation, {"op", "copies"})
        copies = operation.get("copies")
        if not isinstance(copies, list) or not copies:
            raise DomainError("TIMELINE_INVALID", "复制列表不能为空")
        existing_clip_ids = {item["clip_id"] for item in document["clips"]}
        existing_caption_ids = {item["caption_id"] for item in document["captions"]}
        copy_ids: set[str] = set()
        prepared: list[dict[str, Any]] = []
        track_by_id = {item["id"]: item for item in document["tracks"]}
        for raw in copies:
            item = _mapping(raw, "复制项不合法")
            item_kind = item.get("item_kind")
            required = {"item_kind", "source_id", "copy_id", "timeline_start_us"}
            optional = {"snapshot"}
            if item_kind == "clip":
                required.add("track_id")
                optional.add("track_id")
            _exact_keys(item, required | optional, optional=optional)
            source_id = _identifier(item.get("source_id"), "复制来源 ID 不合法")
            copy_id = _identifier(item.get("copy_id"), "复制目标 ID 不合法")
            start = _integer(item.get("timeline_start_us"), "复制时间不合法")
            if not 0 <= start <= MAX_IMAGE_US or copy_id in copy_ids or copy_id in existing_clip_ids or copy_id in existing_caption_ids:
                raise DomainError("TIMELINE_INVALID", "复制 ID 或时间不合法")
            copy_ids.add(copy_id)
            if item_kind == "clip":
                source = next((clip for clip in document["clips"] if clip["clip_id"] == source_id), None)
                snapshot = item.get("snapshot")
                if source is None:
                    if snapshot is None:
                        raise DomainError("TIMELINE_CLIP_NOT_FOUND", "复制来源不存在且缺少有效快照")
                    source = _validate_duplicate_clip_snapshot(snapshot, source_id)
                if source_id in document.get("locked_elements", []) or track_by_id.get(source.get("track_id"), {}).get("locked"):
                    raise DomainError("TIMELINE_LOCKED", "复制来源片段或轨道已锁定")
                target_id = _identifier(item.get("track_id"), "复制目标轨道 ID 不合法")
                target = track_by_id.get(target_id)
                expected = "audio" if source.get("asset_kind") == "audio" else "video"
                if target is None or target.get("kind") != expected or target.get("locked"):
                    raise DomainError("TIMELINE_INVALID", "复制目标轨道类型不匹配或已锁定")
                duration = int(source["timeline_end_us"]) - int(source["timeline_start_us"])
                if start + duration > MAX_IMAGE_US:
                    raise DomainError("TIMELINE_INVALID", "复制片段结束点超出安全整数范围")
                prepared.append({"item": item, "source": source, "kind": "clip", "target": target_id, "duration": duration})
            elif item_kind == "caption":
                source = next((caption for caption in document["captions"] if caption["caption_id"] == source_id), None)
                snapshot = item.get("snapshot")
                if source is None:
                    if snapshot is None:
                        raise DomainError("TIMELINE_CAPTION_NOT_FOUND", "复制字幕来源不存在且缺少有效快照")
                    source = _validate_duplicate_caption_snapshot(snapshot, source_id)
                if track_by_id.get(CAPTION_TRACK_ID, {}).get("locked"):
                    raise DomainError("TIMELINE_LOCKED", "字幕轨道已锁定")
                duration = int(source["end_us"]) - int(source["start_us"])
                if start + duration > MAX_IMAGE_US:
                    raise DomainError("TIMELINE_INVALID", "复制字幕结束点超出安全整数范围")
                prepared.append({"item": item, "source": source, "kind": "caption", "target": CAPTION_TRACK_ID, "duration": duration})
            else:
                raise DomainError("TIMELINE_INVALID", "复制项类型不合法")

        copy_link_sources: dict[str, set[str]] = {}
        for entry in prepared:
            source = entry["source"]
            link_id = source.get("link_group_id") if entry["kind"] == "clip" else None
            if link_id:
                copy_link_sources.setdefault(link_id, set()).add(source["clip_id"])
        new_link_ids = {
            link_id: f"link_{new_id()}"
            for link_id, source_ids in copy_link_sources.items()
            if len(source_ids) >= 2
        }
        for entry in prepared:
            item, source = entry["item"], entry["source"]
            start = int(item["timeline_start_us"])
            if entry["kind"] == "clip":
                clone = copy.deepcopy(source)
                clone.update({
                    "clip_id": item["copy_id"],
                    "track_id": entry["target"],
                    "timeline_start_us": start,
                    "timeline_end_us": start + entry["duration"],
                })
                old_link = source.get("link_group_id")
                if old_link and old_link in new_link_ids:
                    clone["link_group_id"] = new_link_ids[old_link]
                else:
                    clone.pop("link_group_id", None)
                document["clips"].append(clone)
            else:
                clone = copy.deepcopy(source)
                clone.update({
                    "caption_id": item["copy_id"],
                    "track_id": CAPTION_TRACK_ID,
                    "source_clip_id": None,
                    "start_us": start,
                    "end_us": start + entry["duration"],
                    "origin": "user",
                    "edited": True,
                    "source_segment_ids": [],
                })
                document["captions"].append(clone)

    def _split_timeline_items(
        self, db: sqlite3.Connection, project_id: str, document: dict[str, Any], operation: dict[str, Any]
    ) -> None:
        _exact_keys(operation, {"op", "clip_ids", "caption_ids", "timeline_time_us"})
        clip_ids, caption_ids = operation.get("clip_ids"), operation.get("caption_ids")
        if (
            not isinstance(clip_ids, list) or not isinstance(caption_ids, list)
            or not clip_ids and not caption_ids
            or any(not isinstance(value, str) for value in clip_ids + caption_ids)
            or len(set(clip_ids)) != len(clip_ids) or len(set(caption_ids)) != len(caption_ids)
        ):
            raise DomainError("TIMELINE_INVALID", "拆分目标列表为空或含重复项")
        cut = _integer(operation.get("timeline_time_us"), "拆分时间不合法")
        if not 0 < cut <= MAX_IMAGE_US:
            raise DomainError("TIMELINE_INVALID", "拆分时间超出安全整数范围")
        clip_split: dict[str, dict[str, Any]] = {}
        originals: dict[str, dict[str, Any]] = {}
        locked = set(document.get("locked_elements", []))
        tracks = {track["id"]: track for track in document["tracks"]}
        for clip_id in clip_ids:
            clip = _clip(document, clip_id)
            if clip_id in locked or tracks.get(clip["track_id"], {}).get("locked"):
                raise DomainError("TIMELINE_LOCKED", "拆分片段或轨道已锁定")
            if clip["asset_kind"] not in ("video", "audio", "image"):
                raise DomainError("TIMELINE_INVALID", "该素材类型不能拆分")
            start, end = int(clip["timeline_start_us"]), int(clip["timeline_end_us"])
            if not start < cut < end or cut - start < MIN_VIDEO_US or end - cut < MIN_VIDEO_US:
                raise DomainError("TIMELINE_INVALID", "拆分点必须使两半都至少为 100ms")
            original = copy.deepcopy(clip)
            right = copy.deepcopy(clip)
            right_id = f"clip_{new_id()}"
            right["clip_id"] = right_id
            split_timeline = cut
            if clip["asset_kind"] != "image":
                source_start, source_end = int(clip["source_start_us"]), int(clip["source_end_us"])
                speed = _clip_speed(clip)
                timeline_delta = cut - start
                source_delta = _round_half_up_ratio(timeline_delta * speed, 1000)
                source_cut = source_end - source_delta if clip.get("reverse_playback") else source_start + source_delta
                split_timeline = _source_to_timeline_us(original, source_cut)
                if (
                    source_cut - source_start < MIN_VIDEO_US
                    or source_end - source_cut < MIN_VIDEO_US
                    or split_timeline - start < MIN_VIDEO_US
                    or end - split_timeline < MIN_VIDEO_US
                ):
                    raise DomainError("TIMELINE_INVALID", "拆分源区间任一半短于 100ms")
                if clip.get("reverse_playback"):
                    clip["source_start_us"] = source_cut
                    right["source_end_us"] = source_cut
                else:
                    clip["source_end_us"] = source_cut
                    right["source_start_us"] = source_cut
            clip["timeline_end_us"] = split_timeline
            right["timeline_start_us"] = split_timeline
            _split_fade_pair(clip, right)
            _split_clip_keyframes(clip, right, split_timeline - start)
            insert_at = document["clips"].index(clip) + 1
            document["clips"].insert(insert_at, right)
            originals[clip_id] = original
            clip_split[clip_id] = {"right_id": right_id, "timeline_time_us": split_timeline, "right": right}

        right_groups: dict[str, list[dict[str, Any]]] = {}
        for clip_id in clip_ids:
            clip = _clip(document, clip_id)
            group = clip.get("link_group_id")
            if group:
                right_groups.setdefault(group, []).append(clip_split[clip_id]["right"])
        for group, right_members in right_groups.items():
            if len(right_members) >= 2:
                new_group = f"link_{new_id()}"
                for member in right_members:
                    member["link_group_id"] = new_group
            else:
                right_members[0].pop("link_group_id", None)

        for clip_id, split in clip_split.items():
            _remap_transition_outgoing_after_split(document, clip_id, split["right_id"])

        caption_id_set = set(caption_ids)
        captions_by_id = {caption["caption_id"]: caption for caption in document["captions"]}
        if not caption_id_set.issubset(captions_by_id):
            raise DomainError("TIMELINE_CAPTION_NOT_FOUND", "拆分字幕不存在")
        if tracks.get(CAPTION_TRACK_ID, {}).get("locked") and caption_id_set:
            raise DomainError("TIMELINE_LOCKED", "字幕轨道已锁定")
        original_captions = list(document["captions"])
        new_captions: list[dict[str, Any]] = []
        drop_caption_ids: set[str] = set()
        for caption in original_captions:
            source_clip_id = caption.get("source_clip_id")
            linked_split = clip_split.get(source_clip_id)
            caption_start, caption_end = int(caption["start_us"]), int(caption["end_us"])
            should_split = caption["caption_id"] in caption_id_set or (
                linked_split is not None and caption_start < linked_split["timeline_time_us"] < caption_end
            )
            if not should_split:
                if linked_split is not None and caption_start >= linked_split["timeline_time_us"]:
                    caption["source_clip_id"] = linked_split["right_id"]
                continue
            caption_cut = cut if linked_split is None else linked_split["timeline_time_us"]
            if caption["caption_id"] in caption_id_set and not caption_start < caption_cut < caption_end:
                raise DomainError("TIMELINE_INVALID", "字幕拆分点必须位于字幕内部")
            left_duration, right_duration = caption_cut - caption_start, caption_end - caption_cut
            if left_duration < MIN_CAPTION_US or right_duration < MIN_CAPTION_US:
                raise DomainError("TIMELINE_INVALID", "字幕拆分后每半至少为 100ms")
            source_clip = originals.get(source_clip_id) if source_clip_id in originals else next(
                (item for item in document["clips"] if item["clip_id"] == source_clip_id), None
            )
            left_source_ids: list[str] = []
            right_source_ids: list[str] = []
            if caption.get("origin") == "transcript":
                segment_ids = caption.get("source_segment_ids")
                if not isinstance(segment_ids, list) or not segment_ids or source_clip is None:
                    raise DomainError("TIMELINE_INVALID", "转录字幕来源无法映射")
                rows = db.execute(
                    f"SELECT id,start_us,end_us FROM transcript_segments WHERE id IN ({','.join('?' for _ in segment_ids)})",
                    segment_ids,
                ).fetchall()
                by_segment = {row["id"]: row for row in rows}
                if set(by_segment) != set(segment_ids):
                    raise DomainError("TIMELINE_INVALID", "字幕 transcript segment 不存在")
                for segment_id in segment_ids:
                    row = by_segment[segment_id]
                    source_start = int(source_clip["source_start_us"])
                    source_end = int(source_clip["source_end_us"])
                    seg_start, seg_end = max(source_start, int(row["start_us"])), min(source_end, int(row["end_us"]))
                    if seg_end <= seg_start:
                        continue
                    midpoint = seg_start + (seg_end - seg_start) // 2
                    mapped_midpoint = _source_to_timeline_us(source_clip, midpoint)
                    (left_source_ids if mapped_midpoint <= caption_cut else right_source_ids).append(segment_id)
            ratio = left_duration / (left_duration + right_duration)
            cut_index = _caption_cut_index(caption["text"], ratio)
            if caption.get("origin") == "transcript" and source_clip is not None:
                words = db.execute(
                    f"SELECT w.start_us,w.text FROM transcript_words w WHERE w.segment_id IN ({','.join('?' for _ in caption['source_segment_ids'])}) ORDER BY w.segment_id,w.ordinal",
                    caption["source_segment_ids"],
                ).fetchall()
                search_from = 0
                mapped_word_starts: list[tuple[int, int]] = []
                for word in words:
                    token = str(word["text"]).strip()
                    if not token:
                        continue
                    source_word_start = int(word["start_us"])
                    if not int(source_clip["source_start_us"]) <= source_word_start <= int(source_clip["source_end_us"]):
                        continue
                    pos = caption["text"].find(token, search_from)
                    if pos < 0:
                        mapped_word_starts = []
                        break
                    mapped_word_starts.append((_source_to_timeline_us(source_clip, source_word_start), pos))
                    search_from = pos + len(token)
                word_cut = next((pos for time_us, pos in mapped_word_starts if time_us >= caption_cut and pos > 0), None)
                if word_cut is not None:
                    cut_index = word_cut
            left_text, right_text = caption["text"][:cut_index].strip(), caption["text"][cut_index:].strip()
            _caption_text(left_text)
            _caption_text(right_text)
            left = copy.deepcopy(caption)
            right = copy.deepcopy(caption)
            left["end_us"] = caption_cut
            right["caption_id"] = f"caption_{new_id()}"
            right["start_us"] = caption_cut
            left["text"], right["text"] = left_text, right_text
            if caption.get("origin") == "transcript":
                left["source_segment_ids"] = left_source_ids
                right["source_segment_ids"] = right_source_ids
                left_clip_id = source_clip_id
                right_clip_id = linked_split["right_id"] if linked_split is not None else source_clip_id
                if left_source_ids:
                    left["source_clip_id"] = left_clip_id
                else:
                    left.update({"origin": "user", "source_clip_id": None, "source_segment_ids": [], "edited": True})
                if right_source_ids:
                    right["source_clip_id"] = right_clip_id
                else:
                    right.update({"origin": "user", "source_clip_id": None, "source_segment_ids": [], "edited": True})
            else:
                left.update({"origin": "user", "source_clip_id": None, "source_segment_ids": [], "edited": True})
                right.update({"origin": "user", "source_clip_id": None, "source_segment_ids": [], "edited": True})
            drop_caption_ids.add(caption["caption_id"])
            new_captions.extend((left, right))
        document["captions"] = [
            caption for caption in document["captions"] if caption["caption_id"] not in drop_caption_ids
        ] + new_captions

    @staticmethod
    def _require_unlocked(document: dict[str, Any], operation: dict[str, Any]) -> None:
        locked = set(document.get("locked_elements", []))
        clip_id = operation.get("clip_id")
        if isinstance(clip_id, str) and clip_id in locked:
            raise DomainError("TIMELINE_LOCKED", "Timeline Clip 已锁定")
        # 轨道锁定：操作目标片段所在轨道被锁定即拒绝（set_track_flags 自身
        # 负责解锁，不在此检查）。
        track_locks = {
            track["id"]: track.get("locked", False)
            for track in document.get("tracks", [])
            if isinstance(track, dict)
        }
        # 链接操作会修改组内其他片段；锁定保护必须覆盖实际受影响的成员，
        # 而不只是用户点击的那个片段。
        affected_ids: set[str] = set()
        if operation.get("op") == "set_clip_link" and isinstance(operation.get("clip_ids"), list):
            affected_ids = {item for item in operation["clip_ids"] if isinstance(item, str)}
        if affected_ids:
            for member in document.get("clips", []):
                if member.get("clip_id") in affected_ids:
                    affected_ids.update(c["clip_id"] for c in _clip_link_members(document, member))
        link_ops = {
            "remove_clip", "move_clip", "position_clip", "trim_clip", "set_clip_source_window", "split_clip", "clear_clip_link",
        }
        affects_group = operation.get("op") in {"split_clip", "clear_clip_link"} or not operation.get(
            "ignore_link", False
        )
        if isinstance(clip_id, str) and operation.get("op") in link_ops and affects_group:
            target = next(
                (c for c in document.get("clips", []) if c.get("clip_id") == clip_id), None
            )
            if target is not None:
                members = _clip_link_members(document, target)
                if operation.get("op") == "trim_clip":
                    affected_ids.update(
                        member["clip_id"]
                        for member in members
                        if member["clip_id"] not in locked
                        and not track_locks.get(member.get("track_id"), False)
                    )
                else:
                    affected_ids.update(c["clip_id"] for c in members)
        for member in document.get("clips", []):
            if member.get("clip_id") in affected_ids and (
                member["clip_id"] in locked or track_locks.get(member.get("track_id"), False)
            ):
                raise DomainError("TIMELINE_LOCKED", "链接片段或其轨道已锁定")
        if isinstance(clip_id, str) and track_locks:
            clip = next((c for c in document.get("clips", []) if c.get("clip_id") == clip_id), None)
            if clip is not None and track_locks.get(clip.get("track_id"), False):
                raise DomainError("TIMELINE_LOCKED", "片段所在轨道已锁定")
        target_track_id = operation.get("track_id")
        if (
            operation.get("op") not in {"set_track_flags", "move_track"}
            and isinstance(target_track_id, str)
            and track_locks.get(target_track_id, False)
        ):
            # 锁定保护片段内容：换位是结构性操作不受限；删除/投放到锁定轨仍被拒。
            raise DomainError("TIMELINE_LOCKED", "目标轨道已锁定")
        caption_id = operation.get("caption_id")
        if isinstance(caption_id, str):
            caption = _caption(document, caption_id)
            if caption.get("source_clip_id") in locked:
                raise DomainError("TIMELINE_LOCKED", "关联 Caption 所属 Clip 已锁定")
        # 转场事实/兼容操作：固定 pair 中任一端点锁定即拒绝。
        after_clip_id = operation.get("after_clip_id")
        if isinstance(after_clip_id, str) and after_clip_id in locked:
            raise DomainError("TIMELINE_LOCKED", "转场锚点片段已锁定")
        incoming_clip_id = operation.get("incoming_clip_id")
        if isinstance(incoming_clip_id, str) and incoming_clip_id in locked:
            raise DomainError("TIMELINE_LOCKED", "转场后继片段已锁定")
        if operation.get("op") == "set_clip_transition_facts":
            target_id = operation.get("clip_id")
            if isinstance(target_id, str) and target_id in locked:
                raise DomainError("TIMELINE_LOCKED", "转场来源片段已锁定")
        transition_id = operation.get("transition_id")
        if isinstance(transition_id, str):
            for transition in document.get("transitions", []):
                if transition["transition_id"] != transition_id:
                    continue
                endpoint_ids = {transition.get("after_clip_id"), transition.get("incoming_clip_id")}
                endpoint_clips = [clip for clip in document.get("clips", []) if clip.get("clip_id") in endpoint_ids]
                if any(
                    clip.get("clip_id") in locked or track_locks.get(clip.get("track_id"), False)
                    for clip in endpoint_clips
                ):
                    raise DomainError("TIMELINE_LOCKED", "转场关联片段已锁定")

    def _transition_neighbors(
        self, clips: list[dict[str, Any]], after_clip_id: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        anchor = _clip({"clips": clips}, after_clip_id)
        # P231：转场锚定放宽为同轨邻接（任意视觉轨的视频/图片片段均可作锚点，
        # 后继须同轨且首尾相接）。V1 轨 = 同轨特例，行为不变。
        if anchor.get("asset_kind") not in TRANSITIONABLE_KINDS:
            raise DomainError("TIMELINE_TRANSITION_INVALID", "转场只能加在视频/图片片段之后")
        successor = _transition_successor(clips, anchor)
        if successor.get("asset_kind") not in TRANSITIONABLE_KINDS:
            raise DomainError("TIMELINE_TRANSITION_INVALID", "转场后继必须是视频/图片片段")
        if successor["timeline_start_us"] != anchor["timeline_end_us"]:
            raise DomainError(
                "TIMELINE_TRANSITION_INVALID",
                "转场要求两个片段首尾相接（中间不能有空隙）",
            )
        return anchor, successor

    def _asset_clip(
        self,
        db: sqlite3.Connection,
        project_id: str,
        asset_id: Any,
        layout: Any,
        source_start_us: Any = None,
        source_end_us: Any = None,
        duration_us: Any = None,
    ) -> dict[str, Any]:
        asset_id = _identifier(asset_id, "素材 ID 不合法")
        layout = _enum(layout, LAYOUTS, "布局不合法")
        asset = self._asset(db, project_id, asset_id)
        if asset["kind"] == "video":
            if duration_us is not None or (source_start_us is None) != (source_end_us is None):
                raise DomainError("TIMELINE_SOURCE_INVALID", "视频源范围参数不合法")
            media_info = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
            asset_duration = media_info.get("duration_us")
            if not isinstance(asset_duration, int) or asset_duration < MIN_VIDEO_US:
                raise DomainError("TIMELINE_SOURCE_INVALID", "视频素材时长无效")
            start = 0 if source_start_us is None else _integer(source_start_us, "源开始时间不合法")
            end = (
                asset_duration
                if source_end_us is None
                else _integer(source_end_us, "源结束时间不合法")
            )
            if start < 0 or end > asset_duration or end - start < MIN_VIDEO_US:
                raise DomainError("TIMELINE_SOURCE_INVALID", "视频源范围无效")
            has_audio = bool(media_info.get("audio_streams"))
            return {
                "clip_id": f"clip_{new_id()}",
                "track_id": "V1",
                "order_index": 0,
                "asset_id": asset_id,
                "asset_kind": "video",
                "source_start_us": start,
                "source_end_us": end,
                "timeline_start_us": 0,
                "timeline_end_us": end - start,
                "layout": layout,
                "audio": {"enabled": has_audio, "gain_db": 0.0},
                "speed_milli": 1000,
                "reverse_playback": False,
            }
        if asset["kind"] == "audio":
            if duration_us is not None or (source_start_us is None) != (source_end_us is None):
                raise DomainError("TIMELINE_SOURCE_INVALID", "音频源范围参数不合法")
            media_info = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
            asset_duration = media_info.get("duration_us")
            if not isinstance(asset_duration, int) or asset_duration < MIN_VIDEO_US:
                raise DomainError("TIMELINE_SOURCE_INVALID", "音频素材时长无效")
            start = 0 if source_start_us is None else _integer(source_start_us, "源开始时间不合法")
            end = (
                asset_duration
                if source_end_us is None
                else _integer(source_end_us, "源结束时间不合法")
            )
            if start < 0 or end > asset_duration or end - start < MIN_VIDEO_US:
                raise DomainError("TIMELINE_SOURCE_INVALID", "音频源范围无效")
            return {
                "clip_id": f"clip_{new_id()}",
                "track_id": "A1",
                "order_index": 0,
                "asset_id": asset_id,
                "asset_kind": "audio",
                "source_start_us": start,
                "source_end_us": end,
                "timeline_start_us": 0,
                "timeline_end_us": end - start,
                "layout": layout,
                "audio": {"enabled": True, "gain_db": 0.0},
                "speed_milli": 1000,
            }
        if source_start_us is not None or source_end_us is not None:
            raise DomainError("TIMELINE_SOURCE_INVALID", "图片不能包含源时间范围")
        duration = 3_000_000 if duration_us is None else _integer(duration_us, "图片时长不合法")
        if not MIN_IMAGE_US <= duration <= MAX_IMAGE_US:
            raise DomainError("TIMELINE_SOURCE_INVALID", "图片时长需至少为 100ms，且不得超出安全整数范围")
        return {
            "clip_id": f"clip_{new_id()}",
            "track_id": "V1",
            "order_index": 0,
            "asset_id": asset_id,
            "asset_kind": "image",
            "source_start_us": None,
            "source_end_us": None,
            "timeline_start_us": 0,
            "timeline_end_us": duration,
            "layout": layout,
            "audio": {"enabled": False, "gain_db": 0.0},
        }

    def _transcript_clips(
        self,
        db: sqlite3.Connection,
        project_id: str,
        source: dict[str, Any],
        layout: Any,
        caption_preset: Any,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
        transcript_id = _identifier(source.get("transcript_id"), "Transcript ID 不合法")
        segment_ids = source.get("segment_ids")
        before = _padding(source.get("padding_before_us"))
        after = _padding(source.get("padding_after_us"))
        create_captions = source.get("create_captions")
        if not isinstance(create_captions, bool):
            raise DomainError("TIMELINE_SOURCE_INVALID", "create_captions 必须为布尔值")
        if (
            not isinstance(segment_ids, list)
            or not segment_ids
            or any(not isinstance(value, str) for value in segment_ids)
            or len(set(segment_ids)) != len(segment_ids)
        ):
            raise DomainError("TIMELINE_SOURCE_INVALID", "转录选段不能为空或重复")
        transcript = db.execute(
            "SELECT t.*,a.project_id,a.kind,a.availability,a.fingerprint,a.media_info_json "
            "FROM transcripts t JOIN assets a ON a.id=t.asset_id WHERE t.id=?",
            (transcript_id,),
        ).fetchone()
        if (
            transcript is None
            or transcript["status"] != "ready"
            or transcript["project_id"] != project_id
            or transcript["kind"] != "video"
            or transcript["availability"] != "available"
            or transcript["source_fingerprint"] != transcript["fingerprint"]
        ):
            raise DomainError("TIMELINE_SOURCE_INVALID", "转录来源无效或已过期")
        placeholders = ",".join("?" for _ in segment_ids)
        rows = db.execute(
            f"SELECT * FROM transcript_segments WHERE transcript_id=? AND id IN ({placeholders})",
            (transcript_id, *segment_ids),
        ).fetchall()
        by_id = {row["id"]: row for row in rows}
        if set(by_id) != set(segment_ids):
            raise DomainError("TIMELINE_SOURCE_INVALID", "转录选段不存在")
        segments = [by_id[segment_id] for segment_id in segment_ids]
        if any(
            segments[index]["start_us"] < segments[index - 1]["end_us"]
            for index in range(1, len(segments))
        ):
            raise DomainError("TIMELINE_SOURCE_INVALID", "转录选段必须按时间有序且不重叠")
        asset_duration = transcript["duration_us"]
        clips: list[dict[str, Any]] = []
        captions: list[dict[str, Any]] = []
        timeline_offset = 0
        for segment in segments:
            start = max(0, segment["start_us"] - before)
            end = min(asset_duration, segment["end_us"] + after)
            clip = self._asset_clip(
                db, project_id, transcript["asset_id"], layout, start, end, None
            )
            clip["timeline_start_us"] = timeline_offset
            clip["timeline_end_us"] = timeline_offset + end - start
            clips.append(clip)
            if create_captions:
                captions.append(
                    {
                        "caption_id": f"caption_{new_id()}",
                        "track_id": "C1",
                        "source_clip_id": clip["clip_id"],
                        "start_us": timeline_offset + segment["start_us"] - start,
                        "end_us": timeline_offset + segment["end_us"] - start,
                        "text": _caption_text(segment["text"]),
                        "preset_id": _enum(caption_preset, CAPTION_PRESETS, "字幕预设不合法"),
                        "origin": "transcript",
                        "edited": False,
                        "source_segment_ids": [segment["id"]],
                    }
                )
            timeline_offset += end - start
        return clips, captions, transcript_id

    def _place_clip_at_time(
        self, clips: list[dict[str, Any]], clip: dict[str, Any], track_id: str
    ) -> None:
        """Insert a freely positioned clip into the document's same-track time order."""
        start = clip["timeline_start_us"]
        insert_at = next(
            (
                index
                for index, candidate in enumerate(clips)
                if candidate.get("track_id") == track_id
                and candidate["timeline_start_us"] >= start
            ),
            len(clips),
        )
        clips.insert(insert_at, clip)

    def _overwrite_track_range(
        self,
        document: dict[str, Any],
        track_id: str,
        start_us: int,
        end_us: int,
    ) -> None:
        """Replace one track range while preserving the uncovered ends of intersecting clips.

        OpenFilm's Alt-drop overwrite takes time off the destination track. Linked clips
        remain protected; transitions are recomputed from the final clip facts.
        """
        if end_us <= start_us:
            raise DomainError("TIMELINE_INVALID", "覆盖区间必须大于零")
        tracks = document.get("tracks", [])
        track = next((item for item in tracks if item.get("id") == track_id), None)
        if track is None or track.get("kind") not in {"video", "audio"}:
            raise DomainError("TIMELINE_INVALID", "覆盖目标轨道不可编辑")
        if track.get("locked"):
            raise DomainError("TIMELINE_LOCKED", "目标轨道已锁定")

        clips = document["clips"]
        captions = document["captions"]
        locked_ids = set(document.get("locked_elements", []))
        overlaps = [
            clip
            for clip in clips
            if clip.get("track_id") == track_id
            and clip["timeline_start_us"] < end_us
            and clip["timeline_end_us"] > start_us
        ]
        if any(clip["clip_id"] in locked_ids for clip in overlaps):
            raise DomainError("TIMELINE_LOCKED", "覆盖范围内有锁定片段")
        if any(clip.get("link_group_id") for clip in overlaps):
            raise DomainError("TIMELINE_LINKED", "覆盖范围内有链接片段，请先取消链接")
        def source_window(
            clip: dict[str, Any], segment_start: int, segment_end: int
        ) -> tuple[int, int]:
            source_start = clip["source_start_us"]
            source_end = clip["source_end_us"]
            speed = _clip_speed(clip)
            offset_start = round((segment_start - clip["timeline_start_us"]) * speed / 1000)
            offset_end = round((segment_end - clip["timeline_start_us"]) * speed / 1000)
            if clip.get("reverse_playback"):
                return source_end - offset_end, source_end - offset_start
            return source_start + offset_start, source_start + offset_end

        def apply_segment(
            clip: dict[str, Any], segment_start: int, segment_end: int
        ) -> None:
            if segment_end - segment_start < (
                MIN_IMAGE_US if clip["asset_kind"] == "image" else MIN_VIDEO_US
            ):
                raise DomainError("TIMELINE_INVALID", "覆盖会留下短于最小时长的片段")
            if clip["asset_kind"] in ("video", "audio"):
                new_source_start, new_source_end = source_window(clip, segment_start, segment_end)
                clip["source_start_us"] = new_source_start
                clip["source_end_us"] = new_source_end
            clip["timeline_start_us"] = segment_start
            clip["timeline_end_us"] = segment_end
            if clip["asset_kind"] in ("video", "audio") and (
                _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], _clip_speed(clip)
                )
                != segment_end - segment_start
            ):
                raise DomainError("TIMELINE_INVALID", "覆盖边界与片段帧率/速度不匹配，请将落点吸附到片段边界")

        for clip in list(overlaps):
            old_start, old_end = clip["timeline_start_us"], clip["timeline_end_us"]
            cut_start, cut_end = max(old_start, start_us), min(old_end, end_us)
            keep_left = old_start < cut_start
            keep_right = cut_end < old_end
            if not keep_left and not keep_right:
                clips.remove(clip)
                captions[:] = [item for item in captions if item.get("source_clip_id") != clip["clip_id"]]
                document["locked_elements"] = [item for item in document.get("locked_elements", []) if item != clip["clip_id"]]
                continue

            if keep_left and keep_right:
                right = copy.deepcopy(clip)
                right["clip_id"] = f"clip_{new_id()}"
                middle = copy.deepcopy(clip)
                left_offset = cut_start - old_start
                removed_duration = cut_end - cut_start
                _split_clip_keyframes(clip, middle, left_offset)
                _split_fade_pair(clip, middle)
                _split_clip_keyframes(middle, right, removed_duration)
                _split_fade_pair(middle, right)
                self._split_bound_captions(document, clip["clip_id"], right["clip_id"], cut_start)
                self._trim_bound_captions(document, clip["clip_id"], old_start, cut_start, 0)
                self._trim_bound_captions(document, right["clip_id"], cut_end, old_end, 0)
                apply_segment(clip, old_start, cut_start)
                apply_segment(right, cut_end, old_end)
                insert_at = clips.index(clip) + 1
                clips.insert(insert_at, right)
            elif keep_left:
                temp_right = copy.deepcopy(clip)
                _split_clip_keyframes(clip, temp_right, cut_start - old_start)
                _split_fade_pair(clip, temp_right)
                self._trim_bound_captions(document, clip["clip_id"], old_start, cut_start, 0)
                apply_segment(clip, old_start, cut_start)
            else:
                temp_right = copy.deepcopy(clip)
                _split_clip_keyframes(clip, temp_right, cut_end - old_start)
                _split_fade_pair(clip, temp_right)
                self._trim_bound_captions(document, clip["clip_id"], cut_end, old_end, 0)
                if "keyframes" in temp_right:
                    clip["keyframes"] = temp_right["keyframes"]
                else:
                    clip.pop("keyframes", None)
                clip["audio"] = temp_right["audio"]
                apply_segment(clip, cut_end, old_end)

    def _place_clip_on_track(
        self,
        clips: list[dict[str, Any]],
        captions: list[dict[str, Any]],
        clip: dict[str, Any],
        at_index: Any,
        track_id: str,
    ) -> None:
        """把新片段安置到指定轨道的时间槽 `at_index`（或该轨内容末尾）。

        落点 = 目标轨道时间序第 at_index 个片段的起点（追加时为该轨内容最大
        终点）；混合列表按该锚点片段的位置插入，保持列表顺序可读。冲突片段
        在目标轨道内涟漪右推。
        """
        track_clips = sorted(
            (c for c in clips if c["track_id"] == track_id),
            key=lambda c: c["timeline_start_us"],
        )
        track_count = len(track_clips)
        # at_index 来自混合列表序号（可能含 A1 片段），钳制到目标轨范围。
        clamped_index = max(0, min(int(at_index) if isinstance(at_index, int) and not isinstance(at_index, bool) else track_count, track_count))
        slot = clamped_index
        if slot < track_count:
            target_start = track_clips[slot]["timeline_start_us"]
        else:
            target_start = max((c["timeline_end_us"] for c in track_clips), default=0)
        duration = clip["timeline_end_us"] - clip["timeline_start_us"]
        clip["timeline_start_us"] = target_start
        clip["timeline_end_us"] = target_start + duration
        insert_pos = clips.index(track_clips[slot]) if slot < track_count else len(clips)
        clips.insert(insert_pos, clip)
        self._ripple_track_right(clips, captions, clip)

    def _ripple_track_right(
        self,
        clips: list[dict[str, Any]],
        captions: list[dict[str, Any]],
        changed: dict[str, Any],
    ) -> None:
        """把与 changed 片段当前占用区间冲突的**同轨**片段向右顺延（涟漪推移）。

        前置不变量：操作前该轨道内片段互不重叠。从变更片段的终点开始向右走，
        依次把撞上屏障的片段推到屏障处，直到某片段起点不再早于屏障。
        被推移片段绑定的字幕随片段平移；保持相对顺序与既有空隙。
        """
        start = changed["timeline_start_us"]
        barrier = changed["timeline_end_us"]
        track_id = changed["track_id"]
        track_others = sorted(
            (c for c in clips if c.get("track_id") == track_id and c is not changed),
            key=lambda c: c["timeline_start_us"],
        )
        for other in track_others:
            if other["timeline_start_us"] >= barrier:
                break  # 已按起点排序：之后不会再撞屏障
            if other["timeline_start_us"] < start:
                continue  # 位于变更片段左侧，不受影响
            delta = barrier - other["timeline_start_us"]
            other["timeline_start_us"] += delta
            other["timeline_end_us"] += delta
            barrier = other["timeline_end_us"]
            for caption in captions:
                if caption.get("source_clip_id") == other["clip_id"]:
                    caption["start_us"] += delta
                    caption["end_us"] += delta

    def _ripple_track_from_time(
        self,
        document: dict[str, Any],
        track_id: str,
        at_us: int,
        delta_us: int,
        linkage_enabled: bool,
    ) -> None:
        """Insert time on one media track and carry linked clips when linkage is enabled."""
        if delta_us <= 0:
            raise DomainError("TIMELINE_INVALID", "插入时长必须大于零")
        clips = document["clips"]
        captions = document["captions"]
        track = next((item for item in document["tracks"] if item.get("id") == track_id), None)
        if track is None or track.get("kind") not in {"video", "audio"}:
            raise DomainError("TIMELINE_INVALID", "插入目标轨道不可编辑")
        if track.get("locked"):
            raise DomainError("TIMELINE_LOCKED", "插入目标轨道已锁定")
        locked_ids = set(document.get("locked_elements", []))
        target_clips = [clip for clip in clips if clip.get("track_id") == track_id]
        if any(clip["timeline_start_us"] < at_us < clip["timeline_end_us"] for clip in target_clips):
            raise DomainError("TIMELINE_INVALID", "素材插入点必须落在片段边界或空隙")
        moved = {clip["clip_id"] for clip in target_clips if clip["timeline_start_us"] >= at_us}
        if linkage_enabled:
            groups = {clip.get("link_group_id") for clip in target_clips if clip["clip_id"] in moved and clip.get("link_group_id")}
            moved.update(clip["clip_id"] for clip in clips if clip.get("link_group_id") in groups)
        if moved & locked_ids:
            raise DomainError("TIMELINE_LOCKED", "插入会移动锁定的链接片段")
        for clip in clips:
            if clip["clip_id"] not in moved:
                continue
            if clip["clip_id"] not in {item["clip_id"] for item in target_clips}:
                linked_track = next((item for item in document["tracks"] if item.get("id") == clip.get("track_id")), None)
                if linked_track and linked_track.get("locked"):
                    raise DomainError("TIMELINE_LOCKED", "插入会移动锁定轨道上的链接片段")
            clip["timeline_start_us"] += delta_us
            clip["timeline_end_us"] += delta_us
            for caption in captions:
                if caption.get("source_clip_id") == clip["clip_id"]:
                    caption["start_us"] += delta_us
                    caption["end_us"] += delta_us

    def _normalize_tracks(self, document: dict[str, Any]) -> None:
        """迁移并规范化轨道数组到剪映式结构（就地修改）。

        - 旧 kind 映射：visual→video、caption→text；
        - 补齐缺失的标志位（locked/hidden/muted/solo）与缺失的 A1 轨道；
        - 顺序规范化为 [动态轨道...] + [C1, V1, A1]，动态轨道保持相对顺序。
        """
        tracks = document.get("tracks")
        normalized: list[dict[str, Any]] = []
        if isinstance(tracks, list):
            for track in tracks:
                if not isinstance(track, dict):
                    continue
                kind = track.get("kind")
                if kind == "visual":
                    kind = "video"
                elif kind == "caption":
                    kind = "text"
                normalized.append(
                    {
                        "id": track.get("id"),
                        "kind": kind,
                        "locked": bool(track.get("locked", False)),
                        "hidden": bool(track.get("hidden", False)),
                        "muted": bool(track.get("muted", False)),
                        "solo": bool(track.get("solo", False)),
                    }
                )
        # 固定轨道：V1(主视频)/A1(默认音频) 始终存在；C1 可删除。
        # 动态音频轨只出现在 A1 之后，视觉/文本动态轨位于 C1/V1 之前。
        defaults = {
            MAIN_TRACK_ID: "video",
            AUDIO_TRACK_ID: "audio",
        }
        fixed: dict[str, dict[str, Any]] = {}
        for track_id, kind in defaults.items():
            existing = next((t for t in normalized if t.get("id") == track_id), None)
            if existing is None:
                existing = _empty_track(track_id, kind)
            existing["kind"] = kind
            fixed[track_id] = existing
        caption = next((t for t in normalized if t.get("id") == CAPTION_TRACK_ID), None)
        visual_dynamic = [
            track
            for track in normalized
            if track.get("id") not in defaults
            and track.get("id") != CAPTION_TRACK_ID
            and track.get("kind") in ("video", "text")
        ]
        audio_dynamic = [
            track
            for track in normalized
            if track.get("id") not in defaults
            and track.get("id") != CAPTION_TRACK_ID
            and track.get("kind") == "audio"
        ]
        caption_part = [caption] if caption is not None else []
        document["tracks"] = [
            *visual_dynamic,
            *caption_part,
            fixed[MAIN_TRACK_ID],
            fixed[AUDIO_TRACK_ID],
            *audio_dynamic,
        ]

    def _gc_unreachable_transitions(self, document: dict[str, Any]) -> None:
        """Normalize legacy identity and remove only effects with deleted endpoints.

        Old records without an incoming identity remain null/dormant. Never infer a
        successor from the current layout: a later edit must not rebind an old effect.
        """
        transitions = document.get("transitions")
        clips = document.get("clips")
        if not transitions or not isinstance(clips, list):
            return
        clip_ids = {clip.get("clip_id") for clip in clips if isinstance(clip, dict)}
        normalized: list[dict[str, Any]] = []
        for item in transitions:
            if not isinstance(item, dict) or item.get("after_clip_id") not in clip_ids:
                continue
            if "incoming_clip_id" not in item:
                item["incoming_clip_id"] = None
            incoming_id = item.get("incoming_clip_id")
            if incoming_id is not None and incoming_id not in clip_ids:
                continue
            normalized.append(item)
        document["transitions"] = normalized

    def _normalize_and_validate(
        self,
        db: sqlite3.Connection,
        document: dict[str, Any],
        previous_document: dict[str, Any] | None = None,
    ) -> None:
        """校验文档；previous_document 为基线文档（patch 类路径必须传）。

        区分「保留既有引用」与「引入新引用」：素材文件缺失时，若 clip 在基线里
        已存在且 asset_id 未变，则放行——否则「删除坏引用」这个唯一能自救的
        操作会被校验自己挡住（2026-10 事故：删片段被拒 ⇒ 素材仍被引用 ⇒
        素材删不掉，项目永久不可操作）。新增 clip 或改动 asset_id 仍按新引用
        fail-closed 校验。
        """
        retained_assets: dict[str, str] = {}
        if previous_document is not None:
            retained_assets = {
                clip["clip_id"]: clip.get("asset_id")
                for clip in previous_document.get("clips") or []
                if isinstance(clip, dict) and isinstance(clip.get("clip_id"), str)
            }
        _exact_keys(
            document,
            {
                "schema_version",
                "project_id",
                "canvas",
                "tracks",
                "clips",
                "captions",
                "provenance",
                "locked_elements",
                "transitions",
            },
            optional={"locked_elements", "transitions"},
        )
        document.setdefault("locked_elements", [])
        document.setdefault("transitions", [])
        self._normalize_tracks(document)
        self._normalize_timing(document, {})
        self._gc_unreachable_transitions(document)
        if document.get("schema_version") != 1:
            raise DomainError("TIMELINE_INVALID", "Timeline schema_version 必须为 1")
        _identifier(document.get("project_id"), "项目 ID 不合法")
        if document.get("canvas") != {
            "width": 1080,
            "height": 1920,
            "fps_num": 30,
            "fps_den": 1,
            "background_color": "#000000",
        }:
            raise DomainError("TIMELINE_INVALID", "Timeline 画布不符合 v1")
        tracks = document.get("tracks")
        # 固定顺序：视觉/文本动态轨、可选 C1、V1、A1、动态音频轨。
        if not isinstance(tracks, list) or len(tracks) < 2:
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        track_ids = [track.get("id") for track in tracks]
        try:
            video_index = track_ids.index(MAIN_TRACK_ID)
            audio_index = track_ids.index(AUDIO_TRACK_ID)
        except ValueError as exc:
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法") from exc
        caption_index = track_ids.index(CAPTION_TRACK_ID) if CAPTION_TRACK_ID in track_ids else -1
        if (
            audio_index != video_index + 1
            or tracks[video_index].get("kind") != "video"
            or tracks[audio_index].get("kind") != "audio"
            or (caption_index != -1 and caption_index != video_index - 1)
            or any(track.get("kind") not in ("video", "text") for track in tracks[:video_index])
            or any(track.get("kind") != "audio" for track in tracks[audio_index:])
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        if (
            len(set(track_ids)) != len(track_ids)
            or any(not isinstance(track_id, str) or not track_id for track_id in track_ids)
            or any(track_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID} for track_id in track_ids if track_ids.count(track_id) > 1)
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        for track in tracks:
            if not isinstance(track, dict):
                raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
            for flag in ("locked", "hidden", "muted", "solo"):
                if not isinstance(track.get(flag), bool):
                    raise DomainError("TIMELINE_INVALID", "Timeline 轨道标志不合法")
        for track in tracks:
            track_id = track.get("id")
            if track_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID, CAPTION_TRACK_ID}:
                continue
            expected_kind = (
                "video"
                if isinstance(track_id, str) and track_id.startswith("V")
                else "text"
                if isinstance(track_id, str) and track_id.startswith("T")
                else "audio"
                if isinstance(track_id, str) and track_id.startswith("A")
                else None
            )
            if expected_kind is None or track.get("kind") != expected_kind:
                raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        tracks_by_id = {track["id"]: track for track in tracks}
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline clips/captions 不合法")
        clip_ids: set[str] = set()
        order_counters: dict[str, int] = {}
        for index, clip in enumerate(clips):
            if not isinstance(clip, dict) or clip.get("track_id") not in tracks_by_id:
                raise DomainError("TIMELINE_INVALID", "视频/音频轨片段不合法")
            _exact_keys(
                clip,
                {
                    "clip_id",
                    "track_id",
                    "order_index",
                    "asset_id",
                    "asset_kind",
                    "source_start_us",
                    "source_end_us",
                    "timeline_start_us",
                    "timeline_end_us",
                    "layout",
                    "audio",
                    "picture_fade_in_us",
                    "picture_fade_out_us",
                    "move_in",
                    "move_out",
                    "speed_milli",
                    "reverse_playback",
                    "keyframes",
                    "transform",
                    "mask",
                    "keying",
                    "link_group_id",
                },
                optional={
                    "speed_milli",
                    "reverse_playback",
                    "keyframes",
                    "transform",
                    "mask",
                    "keying",
                    "link_group_id",
                    "picture_fade_in_us",
                    "picture_fade_out_us",
                    "move_in",
                    "move_out",
                },
            )
            if "link_group_id" in clip and (
                not isinstance(clip.get("link_group_id"), str) or not clip.get("link_group_id")
            ):
                raise DomainError("TIMELINE_INVALID", "链接组 ID 不合法")
            clip_id = _identifier(clip.get("clip_id"), "Clip ID 不合法")
            if clip_id in clip_ids:
                raise DomainError("TIMELINE_INVALID", "Clip ID 重复")
            clip_ids.add(clip_id)
            timeline_start = _integer(clip.get("timeline_start_us"), "时间线开始时间不合法")
            timeline_end = _integer(clip.get("timeline_end_us"), "时间线结束时间不合法")
            if timeline_start < 0 or not timeline_start < timeline_end <= MAX_IMAGE_US:
                raise DomainError("TIMELINE_INVALID", "Clip 时间范围超出安全整数范围")
            _normalize_transition_facts(clip)
            asset = self._asset(
                db,
                document["project_id"],
                clip.get("asset_id"),
                allow_unavailable=(
                    previous_document is not None
                    and retained_assets.get(clip_id) == clip.get("asset_id")
                ),
            )
            if asset["kind"] != clip.get("asset_kind"):
                # as_audio 派生片段白名单（M3-3）：视频素材取音轨铺 A1——
                # clip.asset_kind=audio 但源素材是 video；audio.enabled=true
                # 由插入路径保证（无声视频在插入时已拒），此处防绕过。
                derived_audio = (
                    clip.get("asset_kind") == "audio"
                    and asset["kind"] == "video"
                    and bool((clip.get("audio") or {}).get("enabled"))
                )
                if not derived_audio:
                    raise DomainError("TIMELINE_INVALID", "Clip 素材类型不一致")
            track = tracks_by_id[clip["track_id"]]
            expected_track_kind = "audio" if clip.get("asset_kind") == "audio" else "video"
            if track.get("kind") != expected_track_kind:
                raise DomainError("TIMELINE_INVALID", "Clip 与轨道类型不匹配")
            counter = order_counters.setdefault(clip["track_id"], 0)
            if clip.get("order_index") != counter:
                raise DomainError("TIMELINE_INVALID", "Clip 顺序不合法")
            order_counters[clip["track_id"]] = counter + 1
            _enum(clip.get("layout"), LAYOUTS, "布局不合法")
            audio = clip.get("audio")
            if not isinstance(audio, dict) or not isinstance(audio.get("enabled"), bool):
                raise DomainError("TIMELINE_INVALID", "Clip 音频设置不合法")
            _exact_keys(
                audio,
                {"enabled", "gain_db", "fade_in_us", "fade_out_us"},
                optional={"fade_in_us", "fade_out_us"},
            )
            gain = _float_value(audio.get("gain_db"), "Clip 音频增益不合法")
            if not -60 <= gain <= 12:
                raise DomainError("TIMELINE_INVALID", "Clip 音频增益不合法")
            # 可选淡入/淡出：出现时必须合法；缺省保持（老文档无此键仍通过校验）。
            for field in ("fade_in_us", "fade_out_us"):
                if field in audio:
                    _fade_value(audio[field], "Clip 音频淡入淡出时长不合法")
            speed = clip.get("speed_milli", 1000)
            if (
                isinstance(speed, bool)
                or not isinstance(speed, int)
                or not MIN_SPEED_MILLI <= speed <= MAX_SPEED_MILLI
            ):
                raise DomainError("TIMELINE_INVALID", "Clip 速度不合法")
            reversed_flag = clip.get("reverse_playback", False)
            if not isinstance(reversed_flag, bool):
                raise DomainError("TIMELINE_INVALID", "Clip 倒放状态不合法")
            duration = timeline_end - timeline_start
            keyframes = clip.get("keyframes")
            if keyframes is not None:
                if (
                    not isinstance(keyframes, dict)
                    or not keyframes
                    or set(keyframes) - set(KEYFRAME_PROPERTIES)
                ):
                    raise DomainError("TIMELINE_INVALID", "Clip 关键帧结构不合法")
                for property_name, track in keyframes.items():
                    frames = track.get("frames") if isinstance(track, dict) else None
                    _validate_keyframe_track(frames, property_name, duration)
            transform = clip.get("transform")
            if transform is not None:
                _exact_keys(
                    transform,
                    {"x", "y", "scale", "rotate", "opacity"},
                    optional={"x", "y", "scale", "rotate", "opacity"},
                )
                tx = transform.get("x")
                ty = transform.get("y")
                if tx is not None and not (isinstance(tx, (int, float)) and not isinstance(tx, bool) and 0 <= tx <= 1):
                    raise DomainError("TIMELINE_INVALID", "Clip 静态 X 位置不合法")
                if ty is not None and not (isinstance(ty, (int, float)) and not isinstance(ty, bool) and 0 <= ty <= 1):
                    raise DomainError("TIMELINE_INVALID", "Clip 静态 Y 位置不合法")
                for field_name, low, high in (("scale", 0.05, 5.0), ("rotate", -180.0, 180.0), ("opacity", 0.0, 1.0)):
                    value = transform.get(field_name)
                    if value is not None and not (isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high):
                        raise DomainError("TIMELINE_INVALID", f"Clip 静态 {field_name} 不合法")
            mask = clip.get("mask")
            if mask is not None:
                _exact_keys(
                    mask,
                    {"kind", "x", "y", "width", "height", "rotation", "feather", "invert"},
                    optional={"x", "y", "width", "height", "rotation", "feather", "invert"},
                )
                if mask.get("kind") not in ("linear", "rect", "ellipse"):
                    raise DomainError("TIMELINE_INVALID", "Clip 蒙版类型不合法")
                if "invert" in mask and not isinstance(mask.get("invert"), bool):
                    raise DomainError("TIMELINE_INVALID", "Clip 蒙版反选不合法")
                for field_name in ("x", "y", "feather"):
                    value = mask.get(field_name)
                    if value is not None and not (isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1):
                        raise DomainError("TIMELINE_INVALID", f"Clip 蒙版 {field_name} 不合法")
                for field_name in ("width", "height"):
                    value = mask.get(field_name)
                    if value is not None and not (isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= 1):
                        raise DomainError("TIMELINE_INVALID", f"Clip 蒙版 {field_name} 不合法")
                value = mask.get("rotation")
                if value is not None and not (isinstance(value, (int, float)) and not isinstance(value, bool) and -180 <= value <= 180):
                    raise DomainError("TIMELINE_INVALID", "Clip 蒙版旋转不合法")
            keying = clip.get("keying")
            if keying is not None:
                _exact_keys(keying, {"color", "similarity", "blend", "invert"}, optional={"color", "similarity", "blend", "invert"})
                if "color" in keying and not (
                    isinstance(keying.get("color"), str)
                    and len(keying["color"]) == 6
                    and all(ch in "0123456789abcdefABCDEF" for ch in keying["color"])
                ):
                    raise DomainError("TIMELINE_INVALID", "Clip 抠像颜色需为 6 位十六进制")
                for field_name in ("similarity", "blend"):
                    value = keying.get(field_name)
                    if value is not None and not (isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1):
                        raise DomainError("TIMELINE_INVALID", f"Clip 抠像 {field_name} 不合法")
                if "invert" in keying and not isinstance(keying.get("invert"), bool):
                    raise DomainError("TIMELINE_INVALID", "Clip 抠像反选不合法")
            if clip["asset_kind"] == "video":
                media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
                asset_duration = media.get("duration_us")
                duration_known = asset_duration is not None and asset_duration != 0
                start, end = clip.get("source_start_us"), clip.get("source_end_us")
                if (
                    isinstance(start, bool) or not isinstance(start, int)
                    or isinstance(end, bool) or not isinstance(end, int)
                    or isinstance(asset_duration, bool)
                    or (asset_duration is not None and not isinstance(asset_duration, int))
                    or (duration_known and asset_duration < MIN_VIDEO_US)
                    or start < 0
                    or end > MAX_IMAGE_US
                    or (duration_known and end > asset_duration)
                    or end - start < MIN_VIDEO_US
                    or duration != _clip_timeline_duration_us(start, end, speed)
                ):
                    raise DomainError("TIMELINE_INVALID", "视频 Clip 范围不合法")
            elif clip["asset_kind"] == "audio":
                media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
                asset_duration = media.get("duration_us")
                duration_known = asset_duration is not None and asset_duration != 0
                start, end = clip.get("source_start_us"), clip.get("source_end_us")
                if (
                    isinstance(start, bool) or not isinstance(start, int)
                    or isinstance(end, bool) or not isinstance(end, int)
                    or isinstance(asset_duration, bool)
                    or (asset_duration is not None and not isinstance(asset_duration, int))
                    or (duration_known and asset_duration < MIN_VIDEO_US)
                    or start < 0
                    or end > MAX_IMAGE_US
                    or (duration_known and end > asset_duration)
                    or end - start < MIN_VIDEO_US
                    or duration != _clip_timeline_duration_us(start, end, speed)
                    or not audio["enabled"]
                ):
                    raise DomainError("TIMELINE_INVALID", "音频 Clip 范围不合法")
            elif (
                clip["asset_kind"] != "image"
                or clip.get("source_start_us") is not None
                or clip.get("source_end_us") is not None
                or not MIN_IMAGE_US <= duration <= MAX_IMAGE_US
                or audio["enabled"]
            ):
                raise DomainError("TIMELINE_INVALID", "图片 Clip 不合法")
        # 每条视频轨道内，片段时间区间不得重叠（允许同轨空隙；跨轨叠加允许）。
        for track in tracks:
            if track.get("kind") != "video":
                continue
            track_clips_sorted = sorted(
                (c for c in clips if c["track_id"] == track["id"]),
                key=lambda c: c["timeline_start_us"],
            )
            for left, right in zip(track_clips_sorted, track_clips_sorted[1:]):
                if right["timeline_start_us"] < left["timeline_end_us"]:
                    raise DomainError("TIMELINE_INVALID", "视频片段时间区间重叠")
        total_duration = max((c["timeline_end_us"] for c in clips), default=0)
        previous_end = 0
        caption_ids: set[str] = set()
        for caption in captions:
            if not isinstance(caption, dict) or caption.get("track_id") != "C1":
                raise DomainError("TIMELINE_INVALID", "字幕轨数据不合法")
            _exact_keys(
                caption,
                {
                    "caption_id",
                    "track_id",
                    "source_clip_id",
                    "start_us",
                    "end_us",
                    "text",
                    "preset_id",
                    "origin",
                    "edited",
                    "source_segment_ids",
                    "style_override",
                },
                optional={"style_override"},
            )
            caption_id = _identifier(caption.get("caption_id"), "Caption ID 不合法")
            if caption_id in caption_ids:
                raise DomainError("TIMELINE_INVALID", "Caption ID 重复")
            caption_ids.add(caption_id)
            start = _integer(caption.get("start_us"), "字幕开始时间不合法")
            end = _integer(caption.get("end_us"), "字幕结束时间不合法")
            if start < 0 or end > MAX_IMAGE_US:
                raise DomainError("TIMELINE_INVALID", "字幕时间超出安全整数范围")
            # 手工/导入字幕（origin=user）允许超出素材总时长（剪映式：文本可
            # 先于素材存在，靠预览画布显示）；转录字幕仍约束在素材范围内。
            duration_limit = total_duration if caption.get("origin") == "transcript" else None
            if start < previous_end or end - start < MIN_CAPTION_US or (
                duration_limit is not None and end > duration_limit
            ):
                raise DomainError("TIMELINE_INVALID", "字幕时间范围重叠或越界")
            previous_end = end
            _caption_text(caption.get("text"))
            _enum(caption.get("preset_id"), CAPTION_PRESETS, "字幕预设不合法")
            style_override = caption.get("style_override")
            if style_override is not None:
                _validate_caption_style(style_override)
            if caption.get("origin") not in {"transcript", "user"} or not isinstance(
                caption.get("edited"), bool
            ):
                raise DomainError("TIMELINE_INVALID", "字幕来源不合法")
            segment_ids = caption.get("source_segment_ids")
            source_clip_id = caption.get("source_clip_id")
            if caption["origin"] == "transcript":
                if (
                    source_clip_id not in clip_ids
                    or not isinstance(segment_ids, list)
                    or not segment_ids
                ):
                    raise DomainError("TIMELINE_INVALID", "转录字幕来源不完整")
                count = db.execute(
                    f"SELECT COUNT(*) FROM transcript_segments WHERE id IN "
                    f"({','.join('?' for _ in segment_ids)})",
                    segment_ids,
                ).fetchone()[0]
                if count != len(set(segment_ids)):
                    raise DomainError("TIMELINE_INVALID", "转录字幕 Segment 引用无效")
            elif source_clip_id is not None or segment_ids != []:
                raise DomainError("TIMELINE_INVALID", "手工字幕来源字段不合法")
        provenance = document.get("provenance")
        if (
            not isinstance(provenance, dict)
            or provenance.get("created_by") not in CREATED_BY
            or not isinstance(provenance.get("source_transcript_ids"), list)
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline provenance 不合法")
        _exact_keys(provenance, {"created_by", "source_transcript_ids"})
        locked_elements = document.get("locked_elements")
        if (
            not isinstance(locked_elements, list)
            or any(not isinstance(value, str) for value in locked_elements)
            or len(set(locked_elements)) != len(locked_elements)
            or any(value not in clip_ids for value in locked_elements)
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline 锁定集合不合法")
        document["locked_elements"] = [
            clip["clip_id"] for clip in clips if clip["clip_id"] in set(locked_elements)
        ]
        transitions = document.get("transitions")
        if not isinstance(transitions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline 转场列表不合法")
        transition_ids: set[str] = set()
        transition_anchors: set[str] = set()
        for transition in transitions:
            if not isinstance(transition, dict):
                raise DomainError("TIMELINE_INVALID", "Timeline 转场不合法")
            _exact_keys(
                transition,
                {"transition_id", "after_clip_id", "incoming_clip_id", "kind", "duration_us"},
                optional={"incoming_clip_id"},
            )
            transition_id = _identifier(transition.get("transition_id"), "转场 ID 不合法")
            if transition_id in transition_ids:
                raise DomainError("TIMELINE_INVALID", "转场 ID 重复")
            transition_ids.add(transition_id)
            anchor_id = transition.get("after_clip_id")
            if (
                not isinstance(anchor_id, str)
                or anchor_id not in clip_ids
                or anchor_id in transition_anchors
            ):
                raise DomainError("TIMELINE_INVALID", "转场锚点片段不合法或重复")
            transition_anchors.add(anchor_id)
            incoming_id = transition.get("incoming_clip_id")
            if incoming_id is not None and (
                not isinstance(incoming_id, str)
                or incoming_id not in clip_ids
                or incoming_id == anchor_id
            ):
                raise DomainError("TIMELINE_INVALID", "转场后继片段身份不合法")
            _enum(transition.get("kind"), TRANSITION_KINDS, "转场类型不合法")
            duration = _integer(transition.get("duration_us"), "转场时长不合法")
            if not MIN_TRANSITION_US <= duration <= MAX_TRANSITION_US:
                raise DomainError("TIMELINE_INVALID", "转场时长需为 0.1-2 秒")
            clip_by_id = {clip["clip_id"]: clip for clip in clips}
            anchor = clip_by_id.get(anchor_id)
            incoming = clip_by_id.get(incoming_id) if incoming_id is not None else None
            if anchor is None or anchor.get("asset_kind") not in TRANSITIONABLE_KINDS:
                raise DomainError("TIMELINE_INVALID", "转场来源片段必须是视频/图片")
            if incoming is not None and incoming.get("asset_kind") not in TRANSITIONABLE_KINDS:
                raise DomainError("TIMELINE_INVALID", "转场后继片段必须是视频/图片")
        # Compute exactly once from the normalized final layout. Inactive source-derived
        # pairs remain dormant; compatibility effects are validated by fixed identity only.
        _project_active_transitions(document)

    def _normalize_timing(self, document: dict[str, Any], old_starts: dict[str, int]) -> None:
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline clips/captions 不合法")

        valid_clips = [
            c
            for c in clips
            if isinstance(c, dict) and isinstance(c.get("track_id"), str)
        ]
        # 按轨道分组：时间位置是权威数据（自由定位：允许空隙、不允许重叠）。
        # normalize 只按列表顺序重排 order_index；仅当片段缺少合法时间
        # （例如外部构造的文档）时，把它安置到**所在轨道**当前内容最大终点之后。
        track_clips: dict[str, list[dict[str, Any]]] = {}
        for clip in valid_clips:
            track_clips.setdefault(clip["track_id"], []).append(clip)
        fill_starts: dict[str, int] = {}
        for track_id, group in track_clips.items():
            fill_starts[track_id] = max(
                (
                    clip["timeline_end_us"]
                    for clip in group
                    if isinstance(clip.get("timeline_start_us"), int)
                    and isinstance(clip.get("timeline_end_us"), int)
                    and clip["timeline_end_us"] > clip["timeline_start_us"]
                ),
                default=0,
            )
        for track_id, group in track_clips.items():
            for index, clip in enumerate(group):
                clip["order_index"] = index
                start = clip.get("timeline_start_us")
                end = clip.get("timeline_end_us")
                if isinstance(start, int) and isinstance(end, int) and end > start:
                    continue
                if clip.get("asset_kind") == "image":
                    duration = (
                        end - start if isinstance(start, int) and isinstance(end, int) else -1
                    )
                else:
                    src_start = clip.get("source_start_us")
                    src_end = clip.get("source_end_us")
                    duration = (
                        _clip_timeline_duration_us(src_start, src_end, _clip_speed(clip))
                        if isinstance(src_start, int) and isinstance(src_end, int)
                        else -1
                    )
                clip["timeline_start_us"] = fill_starts[track_id]
                clip["timeline_end_us"] = fill_starts[track_id] + duration
                fill_starts[track_id] = clip["timeline_end_us"]

        # A1 clips keep their existing timeline_start_us / timeline_end_us
        # (they can be freely positioned, not forced contiguous)

        captions.sort(
            key=lambda item: (
                item.get("start_us", -1),
                item.get("end_us", -1),
                item.get("caption_id", ""),
            )
        )

    def _trim_bound_captions(
        self,
        document: dict[str, Any],
        clip_id: str,
        retained_start: int,
        retained_end: int,
        shift: int,
    ) -> None:
        kept = []
        for caption in document["captions"]:
            if caption["source_clip_id"] != clip_id:
                kept.append(caption)
                continue
            start = max(caption["start_us"], retained_start)
            end = min(caption["end_us"], retained_end)
            if end - start >= MIN_CAPTION_US:
                caption["start_us"] = start + shift
                caption["end_us"] = end + shift
                kept.append(caption)
        document["captions"] = kept

    def _split_bound_captions(
        self, document: dict[str, Any], left_id: str, right_id: str, split_time: int
    ) -> None:
        result = []
        for caption in document["captions"]:
            if caption["source_clip_id"] != left_id:
                result.append(caption)
                continue
            if caption["end_us"] <= split_time:
                result.append(caption)
            elif caption["start_us"] >= split_time:
                caption["source_clip_id"] = right_id
                result.append(caption)
            else:
                left_duration = split_time - caption["start_us"]
                right_duration = caption["end_us"] - split_time
                if left_duration >= MIN_CAPTION_US:
                    left = copy.deepcopy(caption)
                    left["end_us"] = split_time
                    result.append(left)
                if right_duration >= MIN_CAPTION_US:
                    right = copy.deepcopy(caption)
                    right["caption_id"] = f"caption_{new_id()}"
                    right["source_clip_id"] = right_id
                    right["start_us"] = split_time
                    result.append(right)
        document["captions"] = result

    def _insert_revision(
        self,
        db: sqlite3.Connection,
        project_id: str,
        parent_revision_id: str | None,
        document: dict[str, Any],
        summary: str,
        created_by: str,
    ) -> dict[str, Any]:
        document_json = json_dumps(document)
        revision_id = f"revision_{new_id()}"
        created_at = utc_now()
        digest = f"sha256:{hashlib.sha256(document_json.encode('utf-8')).hexdigest()}"
        db.execute(
            "INSERT INTO timeline_revisions(id,project_id,parent_revision_id,schema_version,"
            "document_json,document_sha256,summary,created_by,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                revision_id,
                project_id,
                parent_revision_id,
                1,
                document_json,
                digest,
                summary,
                created_by,
                created_at,
            ),
        )
        return {
            "timeline_revision_id": revision_id,
            "project_id": project_id,
            "parent_revision_id": parent_revision_id,
            "schema_version": 1,
            "document": document,
            "document_sha256": digest,
            "summary": summary,
            "created_by": created_by,
            "created_at": created_at,
        }

    def _revision(self, db: sqlite3.Connection, revision_id: str) -> dict[str, Any]:
        row = db.execute("SELECT * FROM timeline_revisions WHERE id=?", (revision_id,)).fetchone()
        if row is None:
            raise DomainError("TIMELINE_NOT_FOUND", "Timeline Revision 不存在")
        document = json_loads(row["document_json"])
        document.setdefault("locked_elements", [])
        return {
            "timeline_revision_id": row["id"],
            "project_id": row["project_id"],
            "parent_revision_id": row["parent_revision_id"],
            "schema_version": row["schema_version"],
            "document": document,
            "document_sha256": row["document_sha256"],
            "summary": row["summary"],
            "created_by": row["created_by"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _empty_document(project_id: str, canvas_json: str) -> dict[str, Any]:
        canvas = json_loads(canvas_json)
        return {
            "schema_version": 1,
            "project_id": project_id,
            "canvas": {
                "width": 1080,
                "height": 1920,
                "fps_num": 30,
                "fps_den": 1,
                "background_color": canvas.get("background_color", "#000000"),
            },
            "tracks": [
                _empty_track(CAPTION_TRACK_ID, "text"),
                _empty_track(MAIN_TRACK_ID, "video"),
                _empty_track(AUDIO_TRACK_ID, "audio"),
            ],
            "clips": [],
            "captions": [],
            "locked_elements": [],
            "transitions": [],
            "provenance": {"created_by": "user", "source_transcript_ids": []},
        }

    @staticmethod
    def _draft_dto(row: sqlite3.Row, current_revision_id: str) -> dict[str, Any]:
        return {
            "project_id": row["project_id"],
            "base_revision_id": row["base_revision_id"],
            "document": json_loads(row["document_json"]),
            "updated_at": row["updated_at"],
            "conflict": row["base_revision_id"] != current_revision_id,
        }

    @staticmethod
    def _require_schema(request: dict[str, Any]) -> None:
        if request.get("schema_version") != 1:
            raise DomainError("TIMELINE_INVALID", "schema_version 必须为 1")

    @staticmethod
    def _require_base(project: sqlite3.Row, base_revision_id: str) -> None:
        current = project["current_timeline_revision_id"]
        if current is None:
            raise DomainError("TIMELINE_NOT_FOUND", "项目尚未创建时间线")
        if current != base_revision_id:
            raise DomainError("TIMELINE_CONFLICT", "时间线已被其他操作修改")

    @staticmethod
    def _project(db: sqlite3.Connection, project_id: str) -> sqlite3.Row:
        project_id = _identifier(project_id, "项目 ID 不合法")
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
        return row

    @staticmethod
    def _asset(
        db: sqlite3.Connection,
        project_id: str,
        asset_id: Any,
        *,
        allow_unavailable: bool = False,
    ) -> sqlite3.Row:
        """取素材行并校验可用于 Timeline。

        allow_unavailable：仅在调用方已证明该 clip 的引用是**基线里原样保留**的
        既有引用时为 True。此时跳过 availability 门槛（类型/归属仍校验）——
        否则素材文件一缺失，连「删掉这个坏片段」都会被拒，项目永久不可操作。
        新引用（新片段、或改过 asset_id）永远走严格分支。
        """
        asset_id = _identifier(asset_id, "素材 ID 不合法")
        row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise DomainError("TIMELINE_SOURCE_INVALID", "素材不存在")
        if row["project_id"] != project_id:
            raise DomainError("TIMELINE_SOURCE_INVALID", "素材不属于当前项目")
        if row["kind"] not in {"video", "image", "audio"}:
            raise DomainError(
                "TIMELINE_SOURCE_INVALID",
                f"素材「{row['display_name']}」（{asset_id}）"
                f"的类型 {row['kind']} 不能用于 Timeline",
            )
        if row["availability"] != "available" and not allow_unavailable:
            # 必须点名是哪一条素材：项目里通常有多个素材，笼统一句「素材不可用」
            # 让用户无法定位该恢复哪个文件（2026-10 事故实证的痛点）。
            raise DomainError(
                "TIMELINE_SOURCE_INVALID",
                f"素材「{row['display_name']}」（{asset_id}）不可用于 Timeline："
                f"当前状态为 {row['availability']}",
            )
        return row


def _mapping(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DomainError("TIMELINE_INVALID", message)
    return value


def _identifier(value: Any, message: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 128
        or any(not (char.isascii() and (char.isalnum() or char in "_-")) for char in value)
    ):
        raise DomainError("TIMELINE_INVALID", message)
    return value


def _integer(value: Any, message: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise DomainError("TIMELINE_INVALID", message)
    return value


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _float_value(value: Any, message: str) -> float:
    if not _number(value):
        raise DomainError("TIMELINE_INVALID", message)
    return float(value)


def _split_fade_pair(left: dict[str, Any], right: dict[str, Any]) -> None:
    """Keep incoming edge facts on the left half and outgoing facts on the right.

    A split must not synthesize fades at the internal cut. Motion-in is incoming;
    motion-out is outgoing, matching the fade ownership.
    """
    audio_left = left.get("audio")
    if isinstance(audio_left, dict):
        audio_left.pop("fade_out_us", None)
    audio_right = right.get("audio")
    if isinstance(audio_right, dict):
        audio_right.pop("fade_in_us", None)
    left.pop("picture_fade_out_us", None)
    right.pop("picture_fade_in_us", None)
    left.pop("move_out", None)
    right.pop("move_in", None)


def _remap_transition_outgoing_after_split(
    document: dict[str, Any], old_clip_id: str, right_clip_id: str
) -> None:
    """The outgoing edge belongs to the right half; incoming identity stays left."""
    for transition in document.get("transitions", []):
        if isinstance(transition, dict) and transition.get("after_clip_id") == old_clip_id:
            transition["after_clip_id"] = right_clip_id


def _fade_carried(
    base: dict[str, Any], source: dict[str, Any], side: str
) -> dict[str, Any]:
    """拆剪辑派生 A1 段时，淡入只留在前半段、淡出只留在后半段。

    两段都带齐会把一次淡变变成中间两次突兀的渐变（切点处各淡一半）。
    """
    keep = "fade_in_us" if side == "in" else "fade_out_us"
    if keep in source:
        base[keep] = source[keep]
    return base


def _fade_value(value: Any, message: str) -> int:
    """音频淡入/淡出时长：非负整数微秒（bool 是 int 子类，必须排除）。"""
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise DomainError("TIMELINE_INVALID", message)
    return value


def _enum(value: Any, allowed: set[str], message: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise DomainError("TIMELINE_INVALID", message)
    return value


def _padding(value: Any) -> int:
    value = _integer(value, "保护边界不合法")
    if not 0 <= value <= MAX_PADDING_US:
        raise DomainError("TIMELINE_SOURCE_INVALID", "保护边界需为 0-300ms")
    return value


def _summary(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DomainError("TIMELINE_INVALID", "Revision 摘要不能为空")
    return value


def _caption_text(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 200 or not value.strip():
        raise DomainError("TIMELINE_INVALID", "字幕文本需为 1-200 个字符")
    if any(unicodedata.category(char) in {"Cc", "Cs"} for char in value):
        raise DomainError("TIMELINE_INVALID", "字幕文本包含非法控制字符")
    return value


def _validate_duplicate_clip_snapshot(snapshot: Any, source_id: str) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise DomainError("TIMELINE_INVALID", "Clip 剪贴板快照必须是对象")
    optional = {
        "speed_milli", "reverse_playback", "keyframes", "transform", "mask", "keying",
        "link_group_id",
    }
    _exact_keys(
        snapshot,
        {
            "clip_id", "track_id", "order_index", "asset_id", "asset_kind",
            "source_start_us", "source_end_us", "timeline_start_us", "timeline_end_us",
            "layout", "audio",
        } | optional,
        optional=optional,
    )
    if _identifier(snapshot.get("clip_id"), "Clip 快照 ID 不合法") != source_id:
        raise DomainError("TIMELINE_INVALID", "Clip 快照 ID 与来源不匹配")
    _identifier(snapshot.get("track_id"), "Clip 快照轨道 ID 不合法")
    _identifier(snapshot.get("asset_id"), "Clip 快照素材 ID 不合法")
    order_index = snapshot.get("order_index")
    if isinstance(order_index, bool) or not isinstance(order_index, int) or order_index < 0:
        raise DomainError("TIMELINE_INVALID", "Clip 快照顺序不合法")
    asset_kind = _enum(snapshot.get("asset_kind"), {"video", "audio", "image"}, "Clip 快照素材类型不合法")
    timeline_start = _integer(snapshot.get("timeline_start_us"), "Clip 快照时间不合法")
    timeline_end = _integer(snapshot.get("timeline_end_us"), "Clip 快照时间不合法")
    if timeline_start < 0 or not timeline_start < timeline_end <= MAX_IMAGE_US:
        raise DomainError("TIMELINE_INVALID", "Clip 快照时间范围不合法")
    duration = timeline_end - timeline_start
    source_start, source_end = snapshot.get("source_start_us"), snapshot.get("source_end_us")
    if asset_kind == "image":
        if source_start is not None or source_end is not None or duration < MIN_IMAGE_US:
            raise DomainError("TIMELINE_INVALID", "图片 Clip 快照源区间不合法")
    else:
        if (
            isinstance(source_start, bool) or not isinstance(source_start, int)
            or isinstance(source_end, bool) or not isinstance(source_end, int)
            or not 0 <= source_start < source_end <= MAX_IMAGE_US
            or source_end - source_start < MIN_VIDEO_US
        ):
            raise DomainError("TIMELINE_INVALID", "视频/音频 Clip 快照源区间不合法")
    _enum(snapshot.get("layout"), LAYOUTS, "Clip 快照布局不合法")
    audio = snapshot.get("audio")
    if not isinstance(audio, dict):
        raise DomainError("TIMELINE_INVALID", "Clip 快照音频设置不合法")
    _exact_keys(audio, {"enabled", "gain_db", "fade_in_us", "fade_out_us"}, optional={"fade_in_us", "fade_out_us"})
    if not isinstance(audio.get("enabled"), bool):
        raise DomainError("TIMELINE_INVALID", "Clip 快照音频状态不合法")
    gain = _float_value(audio.get("gain_db"), "Clip 快照音量不合法")
    if not -60 <= gain <= 12:
        raise DomainError("TIMELINE_INVALID", "Clip 快照音量不合法")
    for field in ("fade_in_us", "fade_out_us"):
        if field in audio:
            _fade_value(audio[field], "Clip 快照淡变时长不合法")
    speed = _clip_speed(snapshot)
    if not MIN_SPEED_MILLI <= speed <= MAX_SPEED_MILLI:
        raise DomainError("TIMELINE_INVALID", "Clip 快照速度不合法")
    reverse = snapshot.get("reverse_playback", False)
    if not isinstance(reverse, bool) or (reverse and asset_kind != "video"):
        raise DomainError("TIMELINE_INVALID", "Clip 快照倒放状态不合法")
    if asset_kind in ("video", "audio"):
        if duration != _clip_timeline_duration_us(source_start, source_end, speed):
            raise DomainError("TIMELINE_INVALID", "Clip 快照源范围与时间线时长不匹配")
        if asset_kind == "audio" and not audio["enabled"]:
            raise DomainError("TIMELINE_INVALID", "音频 Clip 快照必须启用音频")
    elif audio["enabled"] or "speed_milli" in snapshot and speed != 1000 or reverse:
        raise DomainError("TIMELINE_INVALID", "图片 Clip 快照包含不支持的音频或速度状态")
    if "keyframes" in snapshot:
        keyframes = snapshot["keyframes"]
        if not isinstance(keyframes, dict) or not keyframes or set(keyframes) - set(KEYFRAME_PROPERTIES):
            raise DomainError("TIMELINE_INVALID", "Clip 快照关键帧结构不合法")
        for property_name, track in keyframes.items():
            if not isinstance(track, dict):
                raise DomainError("TIMELINE_INVALID", "Clip 快照关键帧结构不合法")
            _validate_keyframe_track(track.get("frames"), property_name, duration)
    for field in ("transform", "mask", "keying"):
        if field in snapshot and not isinstance(snapshot[field], dict):
            raise DomainError("TIMELINE_INVALID", f"Clip 快照 {field} 字段不合法")
    if "link_group_id" in snapshot:
        link_id = snapshot["link_group_id"]
        if not isinstance(link_id, str) or not link_id:
            raise DomainError("TIMELINE_INVALID", "Clip 快照链接组 ID 不合法")
    return snapshot


def _validate_duplicate_caption_snapshot(snapshot: Any, source_id: str) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise DomainError("TIMELINE_INVALID", "字幕剪贴板快照必须是对象")
    _exact_keys(
        snapshot,
        {
            "caption_id", "track_id", "source_clip_id", "start_us", "end_us", "text",
            "preset_id", "origin", "edited", "source_segment_ids", "style_override",
        },
        optional={"style_override"},
    )
    if _identifier(snapshot.get("caption_id"), "字幕快照 ID 不合法") != source_id:
        raise DomainError("TIMELINE_INVALID", "字幕快照 ID 与来源不匹配")
    if snapshot.get("track_id") != CAPTION_TRACK_ID:
        raise DomainError("TIMELINE_INVALID", "字幕快照轨道不合法")
    source_clip_id = snapshot.get("source_clip_id")
    if source_clip_id is not None:
        _identifier(source_clip_id, "字幕快照来源 Clip ID 不合法")
    start = _integer(snapshot.get("start_us"), "字幕快照时间不合法")
    end = _integer(snapshot.get("end_us"), "字幕快照时间不合法")
    if start < 0 or not start < end <= MAX_IMAGE_US or end - start < MIN_CAPTION_US:
        raise DomainError("TIMELINE_INVALID", "字幕快照时间范围不合法")
    _caption_text(snapshot.get("text"))
    _enum(snapshot.get("preset_id"), CAPTION_PRESETS, "字幕快照预设不合法")
    origin = snapshot.get("origin")
    if (
        not isinstance(origin, str)
        or origin not in {"transcript", "user"}
        or not isinstance(snapshot.get("edited"), bool)
    ):
        raise DomainError("TIMELINE_INVALID", "字幕快照来源不合法")
    segment_ids = snapshot.get("source_segment_ids")
    if (
        not isinstance(segment_ids, list)
        or any(not isinstance(value, str) for value in segment_ids)
        or len(set(segment_ids)) != len(segment_ids)
        or origin == "transcript" and (source_clip_id is None or not segment_ids)
        or origin == "user" and (source_clip_id is not None or segment_ids)
    ):
        raise DomainError("TIMELINE_INVALID", "字幕快照来源引用不合法")
    for segment_id in segment_ids:
        _identifier(segment_id, "字幕快照 Segment ID 不合法")
    if "style_override" in snapshot:
        _validate_caption_style(snapshot["style_override"])
    return snapshot


def _clip(document: dict[str, Any], clip_id: Any) -> dict[str, Any]:
    clip_id = _identifier(clip_id, "Clip ID 不合法")
    for clip in document["clips"]:
        if clip["clip_id"] == clip_id:
            return clip
    raise DomainError("TIMELINE_CLIP_NOT_FOUND", "Timeline Clip 不存在")


def _transition(document: dict[str, Any], transition_id: Any) -> dict[str, Any]:
    transition_id = _identifier(transition_id, "转场 ID 不合法")
    for transition in document.get("transitions", []):
        if transition["transition_id"] == transition_id:
            return transition
    raise DomainError("TIMELINE_TRANSITION_INVALID", "转场不存在")


def _transition_successor(
    clips: list[dict[str, Any]], anchor: dict[str, Any]
) -> dict[str, Any]:
    """同轨时间序中 anchor 的直接后继；转场要求其为同轨可转场片段。

    P231：转场锚定从「V1 邻接」放宽为「同轨邻接」——每条视觉轨内部独立
    判定时间序后继（V1 轨 = 同轨特例，行为不变）。自由定位下列表顺序不再
    等于时间顺序，后继按 timeline_start_us 排序取。
    """
    track_id = anchor.get("track_id")
    same_track = sorted(
        (c for c in clips if c.get("track_id") == track_id),
        key=lambda c: c["timeline_start_us"],
    )
    index = same_track.index(anchor)
    if index + 1 >= len(same_track):
        raise DomainError("TIMELINE_TRANSITION_INVALID", "转场需要一个后继片段")
    return same_track[index + 1]


def _validate_keyframe_track(
    frames: Any, property_name: str, clip_duration_us: int
) -> list[dict[str, Any]]:
    """校验单属性关键帧帧列表并返回规范化副本（见设计 §1.1/§1.3）。"""
    if not isinstance(frames, list) or not frames:
        raise DomainError("TIMELINE_INVALID", "关键帧帧列表不能为空")
    if len(frames) > KEYFRAME_MAX_FRAMES:
        raise DomainError("TIMELINE_INVALID", f"关键帧最多 {KEYFRAME_MAX_FRAMES} 帧")
    result: list[dict[str, Any]] = []
    previous_t = -1
    for frame in frames:
        if not isinstance(frame, dict):
            raise DomainError("TIMELINE_INVALID", "关键帧不合法")
        allowed = {"t_us", "x", "y", "v"}
        if set(frame) - allowed or not frame:
            raise DomainError("TIMELINE_INVALID", "关键帧字段不合法")
        t_us = frame.get("t_us")
        if isinstance(t_us, bool) or not isinstance(t_us, int):
            raise DomainError("TIMELINE_INVALID", "关键帧时间不合法")
        if t_us <= previous_t:
            raise DomainError("TIMELINE_INVALID", "关键帧时间必须严格递增")
        if t_us > clip_duration_us:
            raise DomainError("TIMELINE_INVALID", "关键帧时间超出片段时长")
        previous_t = t_us
        entry: dict[str, Any] = {"t_us": t_us}
        if property_name == "position":
            x_value, y_value = frame.get("x"), frame.get("y")
            for value in (x_value, y_value):
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    raise DomainError("TIMELINE_INVALID", "位置关键帧坐标不合法")
                if not -0.5 <= value <= 0.5:
                    raise DomainError("TIMELINE_INVALID", "位置坐标需在画布半径 ±0.5 内")
            entry["x"], entry["y"] = float(x_value), float(y_value)
        else:
            v_value = frame.get("v")
            if not isinstance(v_value, (int, float)) or isinstance(v_value, bool):
                raise DomainError("TIMELINE_INVALID", "关键帧数值不合法")
            if "x" in frame or "y" in frame:
                raise DomainError("TIMELINE_INVALID", "该属性关键帧不含坐标字段")
            low, high = KEYFRAME_RANGES[property_name]
            if not low <= v_value <= high:
                raise DomainError("TIMELINE_INVALID", f"关键帧数值需在 {low}-{high} 内")
            entry["v"] = float(v_value)
        result.append(entry)
    return result


def _remap_clip_keyframes(
    clip: dict[str, Any], old_duration_us: int, new_duration_us: int
) -> None:
    """片段时长变化时按比例重映射全部关键帧时间（保持相对位置）。"""
    keyframes = clip.get("keyframes")
    if not keyframes or old_duration_us <= 0:
        return
    for track in keyframes.values():
        for frame in track["frames"]:
            frame["t_us"] = round(frame["t_us"] * new_duration_us / old_duration_us)


def _split_clip_keyframes(
    clip: dict[str, Any], right: dict[str, Any], split_t_us: int
) -> None:
    """拆分时把关键帧按拆分点切分归两侧（边界帧克隆到右段归零时间轴）。"""
    keyframes = clip.get("keyframes")
    if not keyframes:
        return
    right_keyframes: dict[str, Any] = {}
    for property_name, track in keyframes.items():
        left_frames = []
        right_frames = []
        for frame in track["frames"]:
            if frame["t_us"] <= split_t_us:
                left_frames.append(frame)
            else:
                shifted = dict(frame)
                shifted["t_us"] = frame["t_us"] - split_t_us
                right_frames.append(shifted)
        if not left_frames:
            # 全部在右侧：整属性移到右段。
            right_keyframes[property_name] = {"frames": right_frames}
            track["frames"] = []
        elif not right_frames:
            left_frames = left_frames
        else:
            track["frames"] = left_frames
            right_keyframes[property_name] = {"frames": right_frames}
    # 清理空轨道。
    for property_name in [name for name, track in keyframes.items() if not track["frames"]]:
        del keyframes[property_name]
    if right_keyframes:
        right["keyframes"] = right_keyframes
    if not keyframes:
        del clip["keyframes"]


def _caption(document: dict[str, Any], caption_id: Any) -> dict[str, Any]:
    caption_id = _identifier(caption_id, "Caption ID 不合法")
    for caption in document["captions"]:
        if caption["caption_id"] == caption_id:
            return caption
    raise DomainError("TIMELINE_CAPTION_NOT_FOUND", "Timeline Caption 不存在")


def _insert_index(value: Any, length: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= length:
        raise DomainError("TIMELINE_INVALID", "插入位置不合法")
    return value


def _cursor(value: str | None) -> int:
    if value is None:
        return 0
    if not value.isdigit():
        raise DomainError("TIMELINE_INVALID", "cursor 参数不合法")
    return int(value)


def _exact_keys(
    value: dict[str, Any], allowed: set[str], *, optional: set[str] | None = None
) -> None:
    optional = optional or set()
    required = allowed - optional
    if set(value) - allowed or not required <= set(value):
        raise DomainError("TIMELINE_INVALID", "请求字段不符合 Timeline v1 契约")


def timeline_diff(base: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    base_doc, target_doc = base["document"], target["document"]
    base_clips = {item["clip_id"]: item for item in base_doc["clips"]}
    target_clips = {item["clip_id"]: item for item in target_doc["clips"]}
    clip_changes: list[dict[str, Any]] = []
    removed = sorted(set(base_clips) - set(target_clips))
    added = sorted(set(target_clips) - set(base_clips))
    split_added: set[str] = set()
    split_base: set[str] = set()
    for clip_id in sorted(set(base_clips) & set(target_clips)):
        old, left = base_clips[clip_id], target_clips[clip_id]
        if (
            old["asset_kind"] != "video"
            or old["source_start_us"] != left["source_start_us"]
            or old["source_end_us"] == left["source_end_us"]
        ):
            continue
        matches = [
            added_id
            for added_id in added
            if target_clips[added_id]["asset_id"] == old["asset_id"]
            and target_clips[added_id]["source_start_us"] == left["source_end_us"]
            and target_clips[added_id]["source_end_us"] == old["source_end_us"]
            and target_clips[added_id]["order_index"] == left["order_index"] + 1
        ]
        if len(matches) == 1:
            split_base.add(clip_id)
            split_added.add(matches[0])
            clip_changes.append({"type": "split", "clip_id": clip_id, "created_clip_ids": matches})
    for clip_id in removed:
        clip_changes.append({"type": "removed", "clip_id": clip_id})
    for clip_id in added:
        if clip_id not in split_added:
            clip_changes.append({"type": "added", "clip_id": clip_id})
    for clip_id in sorted(set(base_clips) & set(target_clips)):
        old, new = base_clips[clip_id], target_clips[clip_id]
        changes: list[str] = []
        if old["order_index"] != new["order_index"]:
            changes.append("moved")
        if clip_id not in split_base and (old["source_start_us"], old["source_end_us"]) != (
            new["source_start_us"],
            new["source_end_us"],
        ):
            changes.append("trimmed")
        if (
            old["track_id"] == "A1"
            and old["timeline_start_us"] != new["timeline_start_us"]
        ):
            changes.append("moved")
        if old["layout"] != new["layout"]:
            changes.append("layout_changed")
        if old["audio"] != new["audio"]:
            changes.append("audio_changed")
        if old.get("speed_milli", 1000) != new.get("speed_milli", 1000):
            changes.append("speed_changed")
        if old.get("reverse_playback", False) != new.get("reverse_playback", False):
            changes.append("reverse_toggled")
        if old.get("keyframes") != new.get("keyframes"):
            changes.append("keyframes_changed")
        if old.get("transform") != new.get("transform"):
            changes.append("transform_changed")
        if old.get("mask") != new.get("mask"):
            changes.append("mask_changed")
        if old.get("keying") != new.get("keying"):
            changes.append("keying_changed")
        old_duration = old["timeline_end_us"] - old["timeline_start_us"]
        new_duration = new["timeline_end_us"] - new["timeline_start_us"]
        if old_duration != new_duration and "trimmed" not in changes:
            changes.append("duration_changed")
        for change_type in changes:
            clip_changes.append({"type": change_type, "clip_id": clip_id})

    base_captions = {item["caption_id"]: item for item in base_doc["captions"]}
    target_captions = {item["caption_id"]: item for item in target_doc["captions"]}
    caption_changes: list[dict[str, Any]] = []
    for caption_id in sorted(set(base_captions) - set(target_captions)):
        caption_changes.append({"type": "removed", "caption_id": caption_id})
    for caption_id in sorted(set(target_captions) - set(base_captions)):
        caption_changes.append({"type": "added", "caption_id": caption_id})
    for caption_id in sorted(set(base_captions) & set(target_captions)):
        old, new = base_captions[caption_id], target_captions[caption_id]
        for changed, change_type in (
            (old["text"] != new["text"], "text_changed"),
            (
                (old["start_us"], old["end_us"]) != (new["start_us"], new["end_us"]),
                "timing_changed",
            ),
            (old["preset_id"] != new["preset_id"], "preset_changed"),
            (old.get("style_override") != new.get("style_override"), "style_changed"),
        ):
            if changed:
                caption_changes.append({"type": change_type, "caption_id": caption_id})

    base_locked = set(base_doc.get("locked_elements", []))
    target_locked = set(target_doc.get("locked_elements", []))
    lock_changes = [
        *({"type": "unlocked", "clip_id": value} for value in sorted(base_locked - target_locked)),
        *({"type": "locked", "clip_id": value} for value in sorted(target_locked - base_locked)),
    ]
    indirect = []
    for clip_id in sorted(base_locked & target_locked & set(base_clips) & set(target_clips)):
        old, new = base_clips[clip_id], target_clips[clip_id]
        content_keys = {
            "asset_id",
            "asset_kind",
            "source_start_us",
            "source_end_us",
            "layout",
            "audio",
        }
        if (old["timeline_start_us"], old["timeline_end_us"]) != (
            new["timeline_start_us"],
            new["timeline_end_us"],
        ) and all(old[key] == new[key] for key in content_keys):
            indirect.append(
                {
                    "clip_id": clip_id,
                    "from_start_us": old["timeline_start_us"],
                    "from_end_us": old["timeline_end_us"],
                    "to_start_us": new["timeline_start_us"],
                    "to_end_us": new["timeline_end_us"],
                }
            )
    base_duration = base_doc["clips"][-1]["timeline_end_us"] if base_doc["clips"] else 0
    target_duration = target_doc["clips"][-1]["timeline_end_us"] if target_doc["clips"] else 0
    # 转场 diff：按 transition_id 对比增删改。
    base_transitions = {item["transition_id"]: item for item in base_doc.get("transitions", [])}
    target_transitions = {item["transition_id"]: item for item in target_doc.get("transitions", [])}
    transition_changes: list[dict[str, Any]] = []
    for transition_id in sorted(set(base_transitions) - set(target_transitions)):
        transition_changes.append(
            {
                "type": "removed",
                "transition_id": transition_id,
                "after_clip_id": base_transitions[transition_id]["after_clip_id"],
            }
        )
    for transition_id in sorted(set(target_transitions) - set(base_transitions)):
        transition_changes.append(
            {
                "type": "added",
                "transition_id": transition_id,
                "after_clip_id": target_transitions[transition_id]["after_clip_id"],
            }
        )
    for transition_id in sorted(set(base_transitions) & set(target_transitions)):
        old_item, new_item = base_transitions[transition_id], target_transitions[transition_id]
        if old_item != new_item:
            transition_changes.append(
                {
                    "type": "updated",
                    "transition_id": transition_id,
                    "after_clip_id": new_item["after_clip_id"],
                }
            )
    return {
        "schema_version": 1,
        "project_id": base["project_id"],
        "base_revision_id": base["timeline_revision_id"],
        "target_revision_id": target.get("timeline_revision_id"),
        "base_document_sha256": base["document_sha256"],
        "target_document_sha256": target["document_sha256"],
        "summary": {
            "clip_changes": len(clip_changes),
            "caption_changes": len(caption_changes),
            "lock_changes": len(lock_changes),
            "transition_changes": len(transition_changes),
        },
        "duration_delta_us": target_duration - base_duration,
        "clip_changes": clip_changes,
        "caption_changes": caption_changes,
        "lock_changes": lock_changes,
        "indirect_locked_timing_shifts": indirect,
        "transition_changes": transition_changes,
    }
