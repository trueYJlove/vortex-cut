from __future__ import annotations

import copy
import hashlib
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
}
AI_PATCH_OPERATIONS = PATCH_OPERATIONS - {
    "insert_asset_clip",
    "insert_transcript_segments",
    "add_caption",
    "set_clip_locked",
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
        index = _insert_index(at_index, len(clips))
        old_starts = {clip["clip_id"]: clip["timeline_start_us"] for clip in clips}
        old_caption_starts = {caption["caption_id"]: caption["start_us"] for caption in captions}
        clip = self._asset_clip(db, project_id, asset_id, layout, None, None, duration_us)
        clip["clip_id"] = _identifier(proposed_clip_id, "Clip ID 不合法")
        clips.insert(index, clip)
        self._normalize_timing(document, old_starts)
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
        before = base_document["clips"][-1]["timeline_end_us"] if base_document["clips"] else 0
        after = document["clips"][-1]["timeline_end_us"] if document["clips"] else 0
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
        if op != "set_clip_locked":
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
                },
                optional={
                    "source_start_us",
                    "source_end_us",
                    "duration_us",
                    "layout",
                    "speed_milli",
                    "reverse_playback",
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
            if clip["track_id"] == "A1":
                # Auto-upgrade tracks from 2-track to 3-track if needed
                tracks = document.get("tracks", [])
                if not any(t.get("id") == "A1" for t in tracks):
                    # Insert A1 track between V1 and C1
                    a1_track = {"id": "A1", "kind": "audio", "locked": False}
                    insert_idx = next(
                        (i for i, t in enumerate(tracks) if t.get("id") == "C1"),
                        len(tracks),
                    )
                    tracks.insert(insert_idx, a1_track)
                    document["tracks"] = tracks
                # Audio clips go to A1 track, appended at the end
                a1_clips = [c for c in clips if c["track_id"] == "A1"]
                last_end = max((c["timeline_end_us"] for c in a1_clips), default=0)
                clip["timeline_start_us"] = last_end
                clip["timeline_end_us"] = (
                    last_end + (clip["source_end_us"] - clip["source_start_us"])
                )
                clip["order_index"] = len(a1_clips)
                clips.append(clip)
            else:
                # Video/image clips go to V1 track, inserted at index
                v1_count_now = len([c for c in clips if c["track_id"] == "V1"])
                at_index = _insert_index(operation.get("at_index"), v1_count_now)
                # Find actual insertion position in mixed clips list
                v1_count = 0
                insert_pos = len(clips)
                for i, c in enumerate(clips):
                    if c["track_id"] == "V1":
                        if v1_count == at_index:
                            insert_pos = i
                            break
                        v1_count += 1
                else:
                    insert_pos = len(clips)
                clips.insert(insert_pos, clip)
                # Reorder V1 clips (images carry no source range; keep their
                # configured duration when re-packing)
                v1_clips = [c for c in clips if c["track_id"] == "V1"]
                for idx, c in enumerate(v1_clips):
                    c["order_index"] = idx
                    if c["asset_kind"] == "video":
                        duration = c["source_end_us"] - c["source_start_us"]
                    else:
                        duration = c["timeline_end_us"] - c["timeline_start_us"]
                    if idx == 0:
                        c["timeline_start_us"] = 0
                    else:
                        c["timeline_start_us"] = v1_clips[idx - 1]["timeline_end_us"]
                    c["timeline_end_us"] = c["timeline_start_us"] + duration
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
                else (clips[-1]["timeline_end_us"] if clips else 0)
            )
            for caption in new_captions:
                caption["start_us"] += insertion_time
                caption["end_us"] += insertion_time
            clips[at_index:at_index] = new_clips
            captions.extend(new_captions)
            provenance = document["provenance"]["source_transcript_ids"]
            if transcript_id not in provenance:
                provenance.append(transcript_id)
        elif op == "remove_clip":
            _exact_keys(operation, {"op", "clip_id"})
            clip = _clip(document, operation.get("clip_id"))
            clips.remove(clip)
            captions[:] = [c for c in captions if c["source_clip_id"] != clip["clip_id"]]
            # 级联删除涉及该片段的转场：作为锚点的转场直接删；
            # 以"被删片段的后继"为锚的转场也删（该相邻关系已不存在）。
            if document.get("transitions"):
                v1_left = [c for c in clips if c.get("track_id") == "V1"]
                successor_id = next(
                    (
                        c["clip_id"]
                        for c in v1_left
                        if c.get("order_index") == clip["order_index"] + 1
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
            # Free positioning: A1 audio clips can be placed anywhere on the
            # timeline. V1 clips stay sequential (use move_clip to reorder).
            _exact_keys(operation, {"op", "clip_id", "timeline_start_us"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["track_id"] != "A1":
                raise DomainError("TIMELINE_INVALID", "只有音频片段可以自由定位")
            new_start = _integer(operation.get("timeline_start_us"), "时间线开始时间不合法")
            if new_start < 0:
                raise DomainError("TIMELINE_INVALID", "时间线开始时间不合法")
            duration = clip["timeline_end_us"] - clip["timeline_start_us"]
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
                shift = round((new_start - old_source_start) * 1000 / speed)
                clip["source_start_us"] = new_start
                clip["source_end_us"] = new_end
                self._trim_bound_captions(
                    document, clip["clip_id"], retained_start, retained_end, -shift
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
            clip["speed_milli"] = speed
            if clip["asset_kind"] == "video":
                # V1 连续轨道：直接改时长，由 _normalize_timing 重排后续片段。
                new_duration = _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], speed
                )
                clip["timeline_end_us"] = clip["timeline_start_us"] + new_duration
            else:
                # A1 自由定位：右缘固定、左缘平移以保持终点。
                new_duration = _clip_timeline_duration_us(
                    clip["source_start_us"], clip["source_end_us"], speed
                )
                clip["timeline_start_us"] = clip["timeline_end_us"] - new_duration
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
            clip["timeline_end_us"] = clip["timeline_start_us"] + duration
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
        self._normalize_timing(document, {})
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
        valid_tracks_2 = [
            {"id": "V1", "kind": "visual", "locked": False},
            {"id": "C1", "kind": "caption", "locked": False},
        ]
        valid_tracks_3 = [
            {"id": "V1", "kind": "visual", "locked": False},
            {"id": "A1", "kind": "audio", "locked": False},
            {"id": "C1", "kind": "caption", "locked": False},
        ]
        if document.get("tracks") != valid_tracks_2 and document.get("tracks") != valid_tracks_3:
            raise DomainError("TIMELINE_INVALID", "Timeline v1 轨道不合法")
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline clips/captions 不合法")
        clip_ids: set[str] = set()
        v1_index = 0
        a1_index = 0
        for index, clip in enumerate(clips):
            if not isinstance(clip, dict) or clip.get("track_id") not in ("V1", "A1"):
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
                },
                optional={"speed_milli", "reverse_playback"},
            )
            clip_id = _identifier(clip.get("clip_id"), "Clip ID 不合法")
            if clip_id in clip_ids:
                raise DomainError("TIMELINE_INVALID", "Clip ID 重复")
            clip_ids.add(clip_id)
            asset = self._asset(db, document["project_id"], clip.get("asset_id"))
            if asset["kind"] != clip.get("asset_kind"):
                raise DomainError("TIMELINE_INVALID", "Clip 素材类型不一致")
            if clip["track_id"] == "V1":
                if clip.get("order_index") != v1_index:
                    raise DomainError("TIMELINE_INVALID", "V1 Clip 顺序不合法")
                v1_index += 1
            elif clip["track_id"] == "A1":
                if clip.get("order_index") != a1_index:
                    raise DomainError("TIMELINE_INVALID", "A1 Clip 顺序不合法")
                a1_index += 1
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
        total_duration = clips[-1]["timeline_end_us"] if clips else 0
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
                },
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
        # 引用完整性：锚点必须是 V1 可转场片段且存在 V1 后继。
        v1 = [c for c in clips if c["track_id"] == "V1"]
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

        # Separate clips by track
        v1_clips = [c for c in clips if isinstance(c, dict) and c.get("track_id") == "V1"]
        a1_clips = [c for c in clips if isinstance(c, dict) and c.get("track_id") == "A1"]

        # Normalize V1 clips: sequential, contiguous from 0
        v1_offset = 0
        deltas: dict[str, int] = {}
        for index, clip in enumerate(v1_clips):
            raw_clip_id = clip.get("clip_id")
            old_start = old_starts.get(raw_clip_id) if isinstance(raw_clip_id, str) else None
            if clip.get("asset_kind") == "video":
                start = clip.get("source_start_us")
                end = clip.get("source_end_us")
                duration = (
                    _clip_timeline_duration_us(start, end, _clip_speed(clip))
                    if isinstance(start, int) and isinstance(end, int)
                    else -1
                )
            elif clip.get("asset_kind") == "image":
                start = clip.get("timeline_start_us")
                end = clip.get("timeline_end_us")
                duration = end - start if isinstance(start, int) and isinstance(end, int) else -1
            else:
                start = clip.get("source_start_us")
                end = clip.get("source_end_us")
                duration = (
                    _clip_timeline_duration_us(start, end, _clip_speed(clip))
                    if isinstance(start, int) and isinstance(end, int)
                    else -1
                )
            clip["order_index"] = index
            clip["timeline_start_us"] = v1_offset
            clip["timeline_end_us"] = v1_offset + duration
            if old_start is not None:
                deltas[clip["clip_id"]] = v1_offset - old_start
            v1_offset += duration

        # Normalize A1 clips: preserve timeline positions, just fix order_index
        for index, clip in enumerate(a1_clips):
            clip["order_index"] = index
            # A1 clips keep their existing timeline_start_us / timeline_end_us
            # (they can be freely positioned, not forced contiguous)

        if deltas:
            for caption in captions:
                delta = deltas.get(caption.get("source_clip_id"), 0)
                caption["start_us"] += delta
                caption["end_us"] += delta
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
                {"id": "V1", "kind": "visual", "locked": False},
                {"id": "A1", "kind": "audio", "locked": False},
                {"id": "C1", "kind": "caption", "locked": False},
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
    """V1 序中 anchor 的直接后继；转场要求其为同轨可转场片段。"""
    v1 = [c for c in clips if c.get("track_id") == "V1"]
    index = v1.index(anchor)
    if index + 1 >= len(v1):
        raise DomainError("TIMELINE_TRANSITION_INVALID", "转场需要一个后继片段")
    return v1[index + 1]


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
