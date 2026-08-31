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
    "trim_clip",
    "split_clip",
    "set_layout",
    "set_audio",
    "set_speed",
    "set_reverse_playback",
    "set_image_duration",
    "add_caption",
    "remove_caption",
    "update_caption",
    "set_caption_timing",
    "set_caption_preset",
    "set_clip_locked",
    "add_transition",
    "update_transition",
    "remove_transition",
    "set_clip_keyframes",
    "clear_clip_keyframes",
    "set_caption_style",
    "clear_caption_style",
    "add_track",
    "remove_track",
    "move_track",
    "set_track_flags",
}
AI_PATCH_OPERATIONS = PATCH_OPERATIONS - {
    "insert_asset_clip",
    "insert_transcript_segments",
    "add_caption",
    "set_clip_locked",
    "add_track",
    "remove_track",
    "move_track",
    "set_track_flags",
}
MIN_VIDEO_US = 100_000
MIN_IMAGE_US = 500_000
MAX_IMAGE_US = 30_000_000
MIN_CAPTION_US = 200_000
MAX_PADDING_US = 300_000
MIN_SPEED_MILLI = 250
MAX_SPEED_MILLI = 4000
MIN_TRANSITION_US = 100_000
MAX_TRANSITION_US = 2_000_000
# 转场只作用于 V1 相邻的这两类片段。
TRANSITIONABLE_KINDS = ("video", "image")
TRANSITION_KINDS = {
    "fade", "fadeblack", "dissolve", "wipeleft", "wiperight",
    "slideleft", "slideup", "zoomin",
}
MAX_TRANSITIONS = 50
# 多轨道结构（剪映式）：tracks 数组顺序 = 自上而下
# [动态视频/文本轨道...] → C1(字幕轨) → V1(主视频轨) → A1(音频轨)。
# C1/V1/A1 恒存在且相对位置固定；动态轨道（V2+ 视频轨 / T1+ 文本轨）只能在
# C1 之上的区域自由添加、删除与交换位置。
MAIN_TRACK_ID = "V1"
CAPTION_TRACK_ID = "C1"
AUDIO_TRACK_ID = "A1"
TRACK_KINDS = ("video", "text", "audio")


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
CAPTION_STYLE_ALIGNMENT = {2, 5, 8}
CAPTION_STYLE_MARGIN_RANGE = (0, 600)


def _validate_caption_style(style: Any) -> dict[str, Any]:
    """校验字幕样式覆盖并返回规范化副本（部分字段；见设计 §1.1）。"""
    if not isinstance(style, dict) or not style:
        raise DomainError("TIMELINE_INVALID", "字幕样式覆盖不能为空")
    allowed = {"font_size", "primary_color", "outline_color", "outline", "alignment", "margin_v", "pos_x", "pos_y"}
    if set(style) - allowed:
        raise DomainError("TIMELINE_INVALID", "字幕样式字段不合法")
    result: dict[str, Any] = {}
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
            raise DomainError("TIMELINE_INVALID", "字幕对齐仅支持 底部(2)/居中(5)/顶部(8)")
        result["alignment"] = alignment
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


class TimelineService:
    def __init__(self, db: Database) -> None:
        self.db = db

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
            self._normalize_and_validate(db, document)
            db.execute("BEGIN")
            try:
                latest = db.execute(
                    "SELECT current_timeline_revision_id FROM projects WHERE id=?", (project_id,)
                ).fetchone()
                if latest is None or latest[0] != base_revision_id:
                    raise DomainError("TIMELINE_CONFLICT", "时间线已被其他操作修改")
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
    ) -> dict[str, Any]:
        if not 1 <= len(operations) <= 100:
            raise DomainError("TIMELINE_INVALID", "Patch 操作数量需为 1-100")
        result = copy.deepcopy(document)
        result.setdefault("locked_elements", [])
        for raw_operation in operations:
            operation = _mapping(raw_operation, "Patch 操作不合法")
            if ai and operation.get("op") not in AI_PATCH_OPERATIONS:
                raise DomainError("TIMELINE_PATCH_PROPOSAL_INVALID", "AI Patch 包含禁止操作")
            self._apply_operation(db, project_id, result, operation)
        self._normalize_and_validate(db, result)
        if not result["clips"]:
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
                },
                optional={
                    "source_start_us",
                    "source_end_us",
                    "duration_us",
                    "layout",
                    "speed_milli",
                    "reverse_playback",
                    "track_id",
                },
            )
            speed_milli = operation.get("speed_milli")
            if speed_milli is not None and (
                isinstance(speed_milli, bool)
                or not isinstance(speed_milli, int)
                or not MIN_SPEED_MILLI <= speed_milli <= MAX_SPEED_MILLI
            ):
                raise DomainError("TIMELINE_INVALID", "速度需在 0.25x-4x 之间")
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
            if clip["track_id"] == AUDIO_TRACK_ID:
                # 音频片段固定落到 A1 轨道末尾（不支持音频覆盖轨）。
                if op_track_id is not None and op_track_id != AUDIO_TRACK_ID:
                    raise DomainError("TIMELINE_INVALID", "音频片段只能放到音频轨道")
                a1_clips = [c for c in clips if c["track_id"] == AUDIO_TRACK_ID]
                last_end = max((c["timeline_end_us"] for c in a1_clips), default=0)
                clip["timeline_start_us"] = last_end
                clip["timeline_end_us"] = (
                    last_end + (clip["source_end_us"] - clip["source_start_us"])
                )
                clip["order_index"] = len(a1_clips)
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
                self._place_clip_on_track(
                    clips, captions, clip, operation.get("at_index"), target_track_id
                )
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
            _exact_keys(operation, {"op", "clip_id"})
            clip = _clip(document, operation.get("clip_id"))
            clips.remove(clip)
            captions[:] = [c for c in captions if c["source_clip_id"] != clip["clip_id"]]
            # 级联删除涉及该片段的转场：作为锚点的转场直接删；时间序中
            # "被删片段的直接后继"为锚的转场也删（该相邻关系已不存在）。
            if document.get("transitions"):
                v1_left = sorted(
                    (
                        c
                        for c in clips
                        if c.get("track_id") == "V1" and c is not clip
                    ),
                    key=lambda c: c["timeline_start_us"],
                )
                successor_id = next(
                    (
                        c["clip_id"]
                        for c in v1_left
                        if c["timeline_start_us"] >= clip["timeline_start_us"]
                    ),
                    None,
                )
                document["transitions"] = [
                    item
                    for item in document["transitions"]
                    if item["after_clip_id"] != clip["clip_id"]
                    and item["after_clip_id"] != successor_id
                ]
        elif op == "move_clip":
            _exact_keys(operation, {"op", "clip_id", "to_index"})
            clip = _clip(document, operation.get("clip_id"))
            to_index = operation.get("to_index")
            if (
                not isinstance(to_index, int)
                or isinstance(to_index, bool)
                or not 0 <= to_index < len(clips)
            ):
                raise DomainError("TIMELINE_INVALID", "目标片段位置不合法")
            clips.remove(clip)
            clips.insert(to_index, clip)
        elif op == "position_clip":
            # 自由定位：视频与音频片段都可以放在任意时间位置（同轨允许空隙）。
            # 可选 track_id：跨轨道移动（仅限同类型轨道；视频片段在视频轨之间
            # 移动，音频片段固定 A1）。同轨禁止重叠——前端负责钳制，这里兜底拒绝。
            _exact_keys(
                operation,
                {"op", "clip_id", "timeline_start_us", "track_id"},
                optional={"track_id"},
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
            clip["timeline_start_us"] = new_start
            clip["timeline_end_us"] = new_start + duration
        elif op == "trim_clip":
            _exact_keys(operation, {"op", "clip_id", "source_start_us", "source_end_us"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] not in ("video", "audio"):
                raise DomainError("TIMELINE_INVALID", "只有视频/音频片段可以修剪")
            new_start = _integer(operation.get("source_start_us"), "源开始时间不合法")
            new_end = _integer(operation.get("source_end_us"), "源结束时间不合法")
            old_source_start = clip["source_start_us"]
            old_source_end = clip["source_end_us"]
            if new_start < old_source_start or new_end > old_source_end:
                raise DomainError("TIMELINE_INVALID", "修剪范围必须位于当前片段内")
            if clip["asset_kind"] == "audio":
                # Audio clips are freely positioned: trimming the left edge
                # keeps the right edge fixed (timeline_start shifts right by
                # the trim amount); trimming the right edge keeps the left
                # edge fixed (timeline_end shifts left).
                old_timeline_start = clip["timeline_start_us"]
                shift = new_start - old_source_start
                clip["source_start_us"] = new_start
                clip["source_end_us"] = new_end
                clip["timeline_start_us"] = old_timeline_start + shift
                clip["timeline_end_us"] = clip["timeline_start_us"] + (
                    new_end - new_start
                )
            else:
                speed = _clip_speed(clip)
                retained_start = clip["timeline_start_us"] + round(
                    (new_start - old_source_start) * 1000 / speed
                )
                retained_end = clip["timeline_start_us"] + round(
                    (new_end - old_source_start) * 1000 / speed
                )
                clip["source_start_us"] = new_start
                clip["source_end_us"] = new_end
                # 自由定位：显式落位——左缘随内容右移、右缘收缩
                # （normalize 不再重排 V1 时间）。
                clip["timeline_start_us"] = retained_start
                clip["timeline_end_us"] = retained_end
                # 绑定字幕直接钳制进新窗口（不再按"重打包回零"的位移回移）。
                self._trim_bound_captions(
                    document, clip["clip_id"], retained_start, retained_end, 0
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
            # 拆分点若落在锚定于该片段的转场区间内（距尾部 < T），拒绝。
            transition_here = next(
                (
                    item
                    for item in document.get("transitions", [])
                    if item["after_clip_id"] == clip["clip_id"]
                ),
                None,
            )
            if transition_here is not None:
                tail_timeline = clip["timeline_end_us"] - transition_here["duration_us"]
                split_timeline_check = clip["timeline_start_us"] + round(
                    (split_source - clip["source_start_us"]) * 1000 / _clip_speed(clip)
                )
                if split_timeline_check > tail_timeline:
                    raise DomainError(
                        "TIMELINE_TRANSITION_INVALID",
                        "拆分点位于转场区间内；请先删除或缩短该转场",
                    )
            split_timeline = clip["timeline_start_us"] + round(
                (split_source - clip["source_start_us"]) * 1000 / _clip_speed(clip)
            )
            right = copy.deepcopy(clip)
            right["clip_id"] = f"clip_{new_id()}"
            right["source_start_us"] = split_source
            clip["source_end_us"] = split_source
            index = clips.index(clip)
            clips.insert(index + 1, right)
            # 自由定位模型：显式落位（左段止于拆分点、右段从拆分点起），
            # normalize 不再重排 V1 时间。
            old_timeline_end = clip["timeline_end_us"]
            clip["timeline_end_us"] = split_timeline
            right["timeline_start_us"] = split_timeline
            right["timeline_end_us"] = old_timeline_end
            # B3：关键帧按拆分点切分归两侧。
            split_t_us = split_timeline - clip["timeline_start_us"]
            _split_clip_keyframes(clip, right, split_t_us)
            self._split_bound_captions(document, clip["clip_id"], right["clip_id"], split_timeline)
        elif op == "set_layout":
            _exact_keys(operation, {"op", "clip_id", "layout"})
            _clip(document, operation.get("clip_id"))["layout"] = _enum(
                operation.get("layout"), LAYOUTS, "布局不合法"
            )
        elif op == "set_audio":
            _exact_keys(operation, {"op", "clip_id", "enabled", "gain_db"})
            clip = _clip(document, operation.get("clip_id"))
            enabled = operation.get("enabled")
            gain_db = _float_value(operation.get("gain_db"), "音频增益不合法")
            if not isinstance(enabled, bool) or not -60 <= gain_db <= 12:
                raise DomainError("TIMELINE_INVALID", "音频设置不合法")
            if clip["asset_kind"] == "image" and enabled:
                raise DomainError("TIMELINE_INVALID", "图片片段不能启用音频")
            clip["audio"] = {"enabled": enabled, "gain_db": gain_db}
        elif op == "set_speed":
            _exact_keys(operation, {"op", "clip_id", "speed_milli"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] not in ("video", "audio"):
                raise DomainError("TIMELINE_INVALID", "只有视频/音频片段可以变速")
            speed = operation.get("speed_milli")
            if (
                isinstance(speed, bool)
                or not isinstance(speed, int)
                or not MIN_SPEED_MILLI <= speed <= MAX_SPEED_MILLI
            ):
                raise DomainError("TIMELINE_INVALID", "速度需在 0.25x-4x 之间")
            old_duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            clip["speed_milli"] = speed
            if clip["asset_kind"] == "video":
                # V1 自由定位：起点不动、终点随速度变化；变长时把撞上的
                # 后续片段涟漪右推（变短则留出空隙）。
                new_duration = _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], speed
                )
                clip["timeline_end_us"] = clip["timeline_start_us"] + new_duration
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
                raise DomainError("TIMELINE_INVALID", "图片时长需为 0.5-30 秒")
            old_duration = clip["timeline_end_us"] - clip["timeline_start_us"]
            clip["timeline_end_us"] = clip["timeline_start_us"] + duration
            if clip["track_id"] == "V1":
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
            style = _validate_caption_style(operation.get("style"))
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
            # 新增动态轨道：视频轨（V2+）或文本轨（T1+），插入到 C1 之上
            # （动态区域底部，紧贴字幕轨）。
            _exact_keys(operation, {"op", "kind"})
            kind = _enum(operation.get("kind"), ("video", "text"), "轨道类型不合法")
            tracks_list = document["tracks"]
            prefix = "V" if kind == "video" else "T"
            existing_ids = {track.get("id") for track in tracks_list}
            number = 2 if kind == "video" else 1
            while f"{prefix}{number}" in existing_ids:
                number += 1
            caption_index = next(
                (
                    index
                    for index, track in enumerate(tracks_list)
                    if track.get("id") == CAPTION_TRACK_ID
                ),
                len(tracks_list),
            )
            tracks_list.insert(caption_index, _empty_track(f"{prefix}{number}", kind))
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
            # 动态轨道换位：to_index 为动态区域内自上而下 0 起的目标位置。
            # 仅主视频轨与音频轨固定；文本轨与其他动态轨一致可移动。
            _exact_keys(operation, {"op", "track_id", "to_index"})
            track_id = operation.get("track_id")
            to_index = operation.get("to_index")
            if track_id in {MAIN_TRACK_ID, AUDIO_TRACK_ID}:
                raise DomainError("TIMELINE_INVALID", "固定轨道不能移动")
            tracks_list = document["tracks"]
            track = next((t for t in tracks_list if t.get("id") == track_id), None)
            if track is None:
                raise DomainError("TIMELINE_INVALID", "轨道不存在")
            dynamic_count = sum(
                1
                for item in tracks_list
                if item.get("id") not in {MAIN_TRACK_ID, AUDIO_TRACK_ID}
            )
            if (
                not isinstance(to_index, int)
                or isinstance(to_index, bool)
                or not 0 <= to_index < dynamic_count
            ):
                raise DomainError("TIMELINE_INVALID", "目标轨道位置不合法")
            tracks_list.remove(track)
            tracks_list.insert(to_index, track)
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
        elif op == "add_transition":
            _exact_keys(operation, {"op", "after_clip_id", "kind", "duration_us"})
            document.setdefault("transitions", [])
            anchor, successor = self._transition_neighbors(clips, operation.get("after_clip_id"))
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
        # 转场操作：锚点或后继任一被锁定即拒绝。
        after_clip_id = operation.get("after_clip_id")
        if isinstance(after_clip_id, str) and after_clip_id in locked:
            raise DomainError("TIMELINE_LOCKED", "转场锚点片段已锁定")
        transition_id = operation.get("transition_id")
        if isinstance(transition_id, str):
            for transition in document.get("transitions", []):
                if transition["transition_id"] == transition_id and (
                    transition["after_clip_id"] in locked
                ):
                    raise DomainError("TIMELINE_LOCKED", "转场关联片段已锁定")

    def _transition_neighbors(
        self, clips: list[dict[str, Any]], after_clip_id: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        anchor = _clip({"clips": clips}, after_clip_id)
        if anchor.get("track_id") != "V1" or anchor.get("asset_kind") not in TRANSITIONABLE_KINDS:
            raise DomainError("TIMELINE_TRANSITION_INVALID", "转场只能加在 V1 视频/图片片段之后")
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
            raise DomainError("TIMELINE_SOURCE_INVALID", "图片时长需为 0.5-30 秒")
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
        fixed: dict[str, dict[str, Any]] = {}
        defaults = {
            CAPTION_TRACK_ID: "text",
            MAIN_TRACK_ID: "video",
            AUDIO_TRACK_ID: "audio",
        }
        for track_id, kind in defaults.items():
            existing = next((t for t in normalized if t.get("id") == track_id), None)
            if existing is None:
                existing = _empty_track(track_id, kind)
            existing["kind"] = kind
            fixed[track_id] = existing
        dynamic = [
            track
            for track in normalized
            if track.get("id") not in defaults
        ]
        document["tracks"] = [
            *dynamic,
            fixed[CAPTION_TRACK_ID],
            fixed[MAIN_TRACK_ID],
            fixed[AUDIO_TRACK_ID],
        ]

    def _gc_unreachable_transitions(self, document: dict[str, Any]) -> None:
        """清理失去时间序后继的转场。

        自由定位下片段可以被移动/删除：锚点不再是 V1 可转场片段、或在 V1
        时间序中不再存在后继的转场会被移除。仅留有空隙的转场保留（休眠，
        不参与渲染与 UI，片段重新相接后自动恢复）。
        """
        transitions = document.get("transitions")
        clips = document.get("clips")
        if not transitions or not isinstance(clips, list):
            return
        v1 = sorted(
            (
                clip
                for clip in clips
                if isinstance(clip, dict) and clip.get("track_id") == "V1"
            ),
            key=lambda clip: clip.get("timeline_start_us") or 0,
        )
        valid_anchors = {
            clip["clip_id"]
            for index, clip in enumerate(v1)
            if clip.get("asset_kind") in TRANSITIONABLE_KINDS
            and index + 1 < len(v1)
            and v1[index + 1].get("asset_kind") in TRANSITIONABLE_KINDS
        }
        document["transitions"] = [
            item
            for item in transitions
            if isinstance(item, dict) and item.get("after_clip_id") in valid_anchors
        ]

    def _normalize_and_validate(self, db: sqlite3.Connection, document: dict[str, Any]) -> None:
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
        if (
            not isinstance(tracks, list)
            or len(tracks) < 3
            or [track.get("id") for track in tracks[-3:]]
            != [CAPTION_TRACK_ID, MAIN_TRACK_ID, AUDIO_TRACK_ID]
            or [track.get("kind") for track in tracks[-3:]] != ["text", "video", "audio"]
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        track_ids = [track.get("id") for track in tracks]
        if (
            len(set(track_ids)) != len(track_ids)
            or any(not isinstance(track_id, str) or not track_id for track_id in track_ids)
            or any(
                track_id in {CAPTION_TRACK_ID, MAIN_TRACK_ID, AUDIO_TRACK_ID}
                for track_id in track_ids[:-3]
            )
        ):
            raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
        for track in tracks:
            if not isinstance(track, dict):
                raise DomainError("TIMELINE_INVALID", "Timeline 轨道结构不合法")
            for flag in ("locked", "hidden", "muted", "solo"):
                if not isinstance(track.get(flag), bool):
                    raise DomainError("TIMELINE_INVALID", "Timeline 轨道标志不合法")
        for track in tracks[:-3]:
            track_id = track.get("id")
            expected_kind = (
                "video"
                if isinstance(track_id, str) and track_id.startswith("V")
                else "text"
                if isinstance(track_id, str) and track_id.startswith("T")
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
                    "speed_milli",
                    "reverse_playback",
                    "keyframes",
                },
                optional={"speed_milli", "reverse_playback", "keyframes"},
            )
            clip_id = _identifier(clip.get("clip_id"), "Clip ID 不合法")
            if clip_id in clip_ids:
                raise DomainError("TIMELINE_INVALID", "Clip ID 重复")
            clip_ids.add(clip_id)
            asset = self._asset(db, document["project_id"], clip.get("asset_id"))
            if asset["kind"] != clip.get("asset_kind"):
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
            _exact_keys(audio, {"enabled", "gain_db"})
            gain = _float_value(audio.get("gain_db"), "Clip 音频增益不合法")
            if not -60 <= gain <= 12:
                raise DomainError("TIMELINE_INVALID", "Clip 音频增益不合法")
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
            duration = clip["timeline_end_us"] - clip["timeline_start_us"]
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
            if clip["asset_kind"] == "video":
                media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
                asset_duration = media.get("duration_us")
                start, end = clip.get("source_start_us"), clip.get("source_end_us")
                if (
                    not isinstance(start, int)
                    or not isinstance(end, int)
                    or not isinstance(asset_duration, int)
                    or start < 0
                    or end > asset_duration
                    or end - start < MIN_VIDEO_US
                    or duration != _clip_timeline_duration_us(start, end, speed)
                ):
                    raise DomainError("TIMELINE_INVALID", "视频 Clip 范围不合法")
            elif clip["asset_kind"] == "audio":
                media = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
                asset_duration = media.get("duration_us")
                start, end = clip.get("source_start_us"), clip.get("source_end_us")
                if (
                    not isinstance(start, int)
                    or not isinstance(end, int)
                    or not isinstance(asset_duration, int)
                    or start < 0
                    or end > asset_duration
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
            if start < previous_end or end - start < MIN_CAPTION_US or end > total_duration:
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
                {"transition_id", "after_clip_id", "kind", "duration_us"},
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
            _enum(transition.get("kind"), TRANSITION_KINDS, "转场类型不合法")
            duration = _integer(transition.get("duration_us"), "转场时长不合法")
            if not MIN_TRANSITION_US <= duration <= MAX_TRANSITION_US:
                raise DomainError("TIMELINE_INVALID", "转场时长需为 0.1-2 秒")
        # 引用完整性：锚点必须是 V1 可转场片段且时间序中存在 V1 后继。
        # 不要求首尾相接：留有空隙的转场休眠（渲染/UI 跳过），重新相接后恢复。
        v1 = sorted(
            (c for c in clips if c["track_id"] == "V1"),
            key=lambda c: c["timeline_start_us"],
        )
        for transition in transitions:
            anchor = next((c for c in v1 if c["clip_id"] == transition["after_clip_id"]), None)
            if anchor is None or anchor["asset_kind"] not in TRANSITIONABLE_KINDS:
                raise DomainError("TIMELINE_INVALID", "转场锚点必须是 V1 视频/图片片段")
            index = v1.index(anchor)
            if index + 1 >= len(v1) or v1[index + 1]["asset_kind"] not in TRANSITIONABLE_KINDS:
                raise DomainError("TIMELINE_INVALID", "转场后继必须是 V1 视频/图片片段")

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
    def _asset(db: sqlite3.Connection, project_id: str, asset_id: Any) -> sqlite3.Row:
        asset_id = _identifier(asset_id, "素材 ID 不合法")
        row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise DomainError("TIMELINE_SOURCE_INVALID", "素材不存在")
        if row["project_id"] != project_id:
            raise DomainError("TIMELINE_SOURCE_INVALID", "素材不属于当前项目")
        if row["kind"] not in {"video", "image", "audio"} or row["availability"] != "available":
            raise DomainError("TIMELINE_SOURCE_INVALID", "素材不可用于 Timeline")
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
    """V1 时间序中 anchor 的直接后继；转场要求其为同轨可转场片段。

    自由定位下列表顺序不再等于时间顺序，后继按 timeline_start_us 排序取。
    """
    v1 = sorted(
        (c for c in clips if c.get("track_id") == "V1"),
        key=lambda c: c["timeline_start_us"],
    )
    index = v1.index(anchor)
    if index + 1 >= len(v1):
        raise DomainError("TIMELINE_TRANSITION_INVALID", "转场需要一个后继片段")
    return v1[index + 1]


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
