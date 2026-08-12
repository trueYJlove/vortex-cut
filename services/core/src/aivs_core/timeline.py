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
    "trim_clip",
    "split_clip",
    "set_layout",
    "set_audio",
    "set_image_duration",
    "add_caption",
    "remove_caption",
    "update_caption",
    "set_caption_timing",
    "set_caption_preset",
}
MIN_VIDEO_US = 100_000
MIN_IMAGE_US = 500_000
MAX_IMAGE_US = 30_000_000
MIN_CAPTION_US = 200_000
MAX_PADDING_US = 300_000


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
        caption_preset = _enum(
            request.get("caption_preset_id"), CAPTION_PRESETS, "字幕预设不合法"
        )
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
                revision = self._insert_revision(
                    db, project_id, None, document, summary, "user"
                )
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

    def _navigate(
        self, project_id: str, base_revision_id: str, *, redo: bool
    ) -> dict[str, Any]:
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
                },
                optional={"source_start_us", "source_end_us", "duration_us", "layout"},
            )
            at_index = _insert_index(operation.get("at_index"), len(clips))
            clip = self._asset_clip(
                db,
                project_id,
                operation.get("asset_id"),
                operation.get("layout", "blurred_background"),
                operation.get("source_start_us"),
                operation.get("source_end_us"),
                operation.get("duration_us"),
            )
            clips.insert(at_index, clip)
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
        elif op == "trim_clip":
            _exact_keys(operation, {"op", "clip_id", "source_start_us", "source_end_us"})
            clip = _clip(document, operation.get("clip_id"))
            if clip["asset_kind"] != "video":
                raise DomainError("TIMELINE_INVALID", "只有视频片段可以修剪")
            new_start = _integer(operation.get("source_start_us"), "源开始时间不合法")
            new_end = _integer(operation.get("source_end_us"), "源结束时间不合法")
            old_source_start = clip["source_start_us"]
            old_source_end = clip["source_end_us"]
            if new_start < old_source_start or new_end > old_source_end:
                raise DomainError("TIMELINE_INVALID", "修剪范围必须位于当前片段内")
            retained_start = clip["timeline_start_us"] + new_start - old_source_start
            retained_end = clip["timeline_start_us"] + new_end - old_source_start
            shift = new_start - old_source_start
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
            split_timeline = clip["timeline_start_us"] + split_source - clip["source_start_us"]
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
        self._normalize_timing(document, old_starts)

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
            end = asset_duration if source_end_us is None else _integer(
                source_end_us, "源结束时间不合法"
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
                        "preset_id": _enum(
                            caption_preset, CAPTION_PRESETS, "字幕预设不合法"
                        ),
                        "origin": "transcript",
                        "edited": False,
                        "source_segment_ids": [segment["id"]],
                    }
                )
            timeline_offset += end - start
        return clips, captions, transcript_id

    def _normalize_and_validate(
        self, db: sqlite3.Connection, document: dict[str, Any]
    ) -> None:
        _exact_keys(
            document,
            {"schema_version", "project_id", "canvas", "tracks", "clips", "captions", "provenance"},
        )
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
        if document.get("tracks") != [
            {"id": "V1", "kind": "visual", "locked": False},
            {"id": "C1", "kind": "caption", "locked": False},
        ]:
            raise DomainError("TIMELINE_INVALID", "Timeline v1 轨道不合法")
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline clips/captions 不合法")
        clip_ids: set[str] = set()
        for index, clip in enumerate(clips):
            if not isinstance(clip, dict) or clip.get("track_id") != "V1":
                raise DomainError("TIMELINE_INVALID", "视频轨片段不合法")
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
                },
            )
            clip_id = _identifier(clip.get("clip_id"), "Clip ID 不合法")
            if clip_id in clip_ids or clip.get("order_index") != index:
                raise DomainError("TIMELINE_INVALID", "Clip 顺序或 ID 不合法")
            clip_ids.add(clip_id)
            asset = self._asset(db, document["project_id"], clip.get("asset_id"))
            if asset["kind"] != clip.get("asset_kind"):
                raise DomainError("TIMELINE_INVALID", "Clip 素材类型不一致")
            _enum(clip.get("layout"), LAYOUTS, "布局不合法")
            audio = clip.get("audio")
            if not isinstance(audio, dict) or not isinstance(audio.get("enabled"), bool):
                raise DomainError("TIMELINE_INVALID", "Clip 音频设置不合法")
            _exact_keys(audio, {"enabled", "gain_db"})
            gain = _float_value(audio.get("gain_db"), "Clip 音频增益不合法")
            if not -60 <= gain <= 12:
                raise DomainError("TIMELINE_INVALID", "Clip 音频增益不合法")
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
                    or duration != end - start
                ):
                    raise DomainError("TIMELINE_INVALID", "视频 Clip 范围不合法")
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

    def _normalize_timing(
        self, document: dict[str, Any], old_starts: dict[str, int]
    ) -> None:
        clips = document.get("clips")
        captions = document.get("captions")
        if not isinstance(clips, list) or not isinstance(captions, list):
            raise DomainError("TIMELINE_INVALID", "Timeline clips/captions 不合法")
        offset = 0
        deltas: dict[str, int] = {}
        for index, clip in enumerate(clips):
            if not isinstance(clip, dict):
                raise DomainError("TIMELINE_INVALID", "Clip 不合法")
            raw_clip_id = clip.get("clip_id")
            old_start = old_starts.get(raw_clip_id) if isinstance(raw_clip_id, str) else None
            if clip.get("asset_kind") == "video":
                start = clip.get("source_start_us")
                end = clip.get("source_end_us")
                duration = end - start if isinstance(start, int) and isinstance(end, int) else -1
            else:
                start = clip.get("timeline_start_us")
                end = clip.get("timeline_end_us")
                duration = end - start if isinstance(start, int) and isinstance(end, int) else -1
            clip["order_index"] = index
            clip["timeline_start_us"] = offset
            clip["timeline_end_us"] = offset + duration
            if old_start is not None:
                deltas[clip["clip_id"]] = offset - old_start
            offset += duration
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
        return {
            "timeline_revision_id": row["id"],
            "project_id": row["project_id"],
            "parent_revision_id": row["parent_revision_id"],
            "schema_version": row["schema_version"],
            "document": json_loads(row["document_json"]),
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
                {"id": "C1", "kind": "caption", "locked": False},
            ],
            "clips": [],
            "captions": [],
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
        if row["kind"] not in {"video", "image"} or row["availability"] != "available":
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
