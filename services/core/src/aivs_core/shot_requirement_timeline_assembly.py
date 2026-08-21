from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .projects import DomainError
from .timeline import LAYOUTS, TimelineService

MIN_ASSEMBLY_US = 500_000
MAX_ASSEMBLY_US = 30_000_000
DEFAULT_ASSEMBLY_US = 3_000_000
PREVIEW_TTL = timedelta(minutes=15)


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical(value)).hexdigest()}"


def _document_sha256(document: dict[str, Any]) -> str:
    value = json_dumps(document)
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ShotRequirementTimelineAssemblyService:
    """Local-only explicit Timeline assembly for the currently adopted image."""

    def __init__(self, db: Database, timelines: TimelineService) -> None:
        self.db = db
        self.timelines = timelines

    @staticmethod
    def _resolve_duration(target: Any, explicit: Any) -> int:
        if explicit is not None:
            if (
                isinstance(explicit, bool)
                or not isinstance(explicit, int)
                or not MIN_ASSEMBLY_US <= explicit <= MAX_ASSEMBLY_US
            ):
                raise DomainError("STAGE5_DURATION_INVALID", "图片装配时长需为 0.5-30 秒")
            return explicit
        if target is None:
            return DEFAULT_ASSEMBLY_US
        if (
            isinstance(target, bool)
            or not isinstance(target, int)
            or not MIN_ASSEMBLY_US <= target <= MAX_ASSEMBLY_US
        ):
            raise DomainError(
                "STAGE5_DURATION_CONFIRMATION_REQUIRED", "镜头目标时长需确认后使用"
            )
        return target

    @staticmethod
    def _context(sql: sqlite3.Connection, project_id: str, requirement_id: str) -> dict[str, Any]:
        row = sql.execute(
            "SELECT project.status project_status, "
            "project.current_timeline_revision_id, "
            "shot_list.confirmed_revision_id, "
            "requirement.target_duration_us, requirement.visual_kind, "
            "requirement.visual_source_asset_id, "
            "requirement.shot_list_revision_id, "
            "adoption.id adoption_id, adoption.generation_link_id, adoption.task_id, "
            "adoption.asset_id, task.status task_status, asset.kind asset_kind, "
            "asset.storage_mode, asset.availability, asset.fingerprint, asset.media_info_json "
            "FROM shot_requirements requirement "
            "JOIN shot_list_revisions revision "
            "ON revision.id=requirement.shot_list_revision_id "
            "JOIN shot_lists shot_list ON shot_list.id=revision.shot_list_id "
            "JOIN projects project ON project.id=revision.project_id "
            "JOIN shot_requirement_image_adoptions adoption "
            "ON adoption.id=(SELECT current.id "
            "FROM shot_requirement_image_adoptions current "
            "WHERE current.shot_requirement_id=requirement.id "
            "ORDER BY current.adoption_ordinal DESC, current.created_at DESC, "
            "current.id DESC LIMIT 1) "
            "JOIN shot_requirement_image_generation_links link "
            "ON link.id=adoption.generation_link_id "
            "JOIN media_generation_tasks task ON task.id=adoption.task_id "
            "JOIN generated_asset_provenance provenance "
            "ON provenance.asset_id=adoption.asset_id "
            "AND provenance.request_id=link.request_id "
            "AND provenance.task_id=task.id "
            "JOIN assets asset ON asset.id=adoption.asset_id "
            "WHERE requirement.id=? AND revision.project_id=? "
            "AND adoption.project_id=? AND link.project_id=? "
            "AND link.shot_requirement_id=requirement.id "
            "AND link.shot_list_revision_id=revision.id",
            (requirement_id, project_id, project_id, project_id),
        ).fetchone()
        if row is None:
            requirement = sql.execute(
                "SELECT 1 FROM shot_requirements requirement "
                "JOIN shot_list_revisions revision "
                "ON revision.id=requirement.shot_list_revision_id "
                "WHERE requirement.id=? AND revision.project_id=?",
                (requirement_id, project_id),
            ).fetchone()
            if requirement is None:
                raise DomainError("SHOT_REQUIREMENT_NOT_FOUND", "图片镜头需求不存在")
            raise DomainError("STAGE5_ADOPTION_CONFLICT", "当前采用结果不存在或不可用")
        if row["project_status"] != "active":
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在或不可写")
        if (
            row["confirmed_revision_id"] != row["shot_list_revision_id"]
            or row["visual_kind"] != "image"
            or row["visual_source_asset_id"] is not None
            or row["task_status"] != "succeeded"
        ):
            raise DomainError("STAGE5_REQUIREMENT_NOT_ELIGIBLE", "镜头需求当前不可装配")
        if (
            row["asset_kind"] != "image"
            or row["storage_mode"] != "managed"
            or row["availability"] != "available"
        ):
            raise DomainError("STAGE5_ASSET_UNAVAILABLE", "装配素材不可用")
        if row["current_timeline_revision_id"] is None:
            raise DomainError("STAGE5_TIMELINE_REQUIRED", "项目尚未创建时间线")
        if sql.execute(
            "SELECT 1 FROM timeline_drafts WHERE project_id=?", (project_id,)
        ).fetchone():
            raise DomainError("STAGE5_TIMELINE_DRAFT_EXISTS", "时间线 Draft 未保存")
        return {"row": row, "project_id": project_id, "requirement_id": requirement_id}

    @staticmethod
    def _timeline(sql: sqlite3.Connection, context: dict[str, Any]) -> sqlite3.Row:
        revision = sql.execute(
            "SELECT * FROM timeline_revisions WHERE id=? AND project_id=?",
            (
                context["row"]["current_timeline_revision_id"],
                context["project_id"],
            ),
        ).fetchone()
        if revision is None:
            raise DomainError("STAGE5_TIMELINE_REQUIRED", "项目尚未创建时间线")
        return revision

    @staticmethod
    def _require_not_assembled(
        sql: sqlite3.Connection, context: dict[str, Any], document: dict[str, Any]
    ) -> None:
        clip_ids = {clip["clip_id"] for clip in document.get("clips", [])}
        assembled = sql.execute(
            "SELECT proposed_clip_id FROM shot_requirement_timeline_assemblies "
            "WHERE project_id=? AND shot_requirement_id=?",
            (context["project_id"], context["requirement_id"]),
        ).fetchall()
        if any(row[0] in clip_ids for row in assembled):
            raise DomainError("STAGE5_ALREADY_ASSEMBLED", "镜头需求已装配到当前时间线")

    @staticmethod
    def _reject_locked_shift(document: dict[str, Any], at_index: int) -> None:
        locked = set(document.get("locked_elements", []))
        clips = document.get("clips")
        if not isinstance(clips, list) or not 0 <= at_index <= len(clips):
            raise DomainError("STAGE5_POSITION_INVALID", "装配位置不合法")
        if any(
            isinstance(clip, dict) and clip.get("clip_id") in locked
            for clip in clips[at_index:]
        ):
            raise DomainError("STAGE5_LOCKED_SHIFT", "装配会移动锁定 Clip")

    def _build(
        self,
        sql: sqlite3.Connection,
        context: dict[str, Any],
        revision: sqlite3.Row,
        *,
        asset_id: str,
        proposed_clip_id: str,
        at_index: int,
        duration_us: int,
        layout: str,
    ) -> tuple[dict[str, Any], dict[str, int], str]:
        base_document = json_loads(revision["document_json"])
        base_document.setdefault("locked_elements", [])
        clips = base_document.get("clips")
        if not isinstance(clips, list) or not 0 <= at_index <= len(clips):
            raise DomainError("STAGE5_POSITION_INVALID", "装配位置不合法")
        if layout not in LAYOUTS:
            raise DomainError("STAGE5_PREVIEW_MISMATCH", "装配预览参数不匹配")
        self._require_not_assembled(sql, context, base_document)
        self._reject_locked_shift(base_document, at_index)
        document, impact = self.timelines.build_asset_insert_document(
            sql,
            project_id=context["project_id"],
            base_document=base_document,
            asset_id=asset_id,
            proposed_clip_id=proposed_clip_id,
            at_index=at_index,
            duration_us=duration_us,
            layout=layout,
        )
        return document, impact, _document_sha256(document)

    def _insert_preview(
        self,
        sql: sqlite3.Connection,
        context: dict[str, Any],
        revision: sqlite3.Row,
        request: dict[str, Any],
    ) -> sqlite3.Row:
        row = context["row"]
        duration_us = self._resolve_duration(row["target_duration_us"], request["duration_us"])
        now = _now()
        preview_id, proposed_clip_id = f"stage5_preview_{new_id()}", f"clip_{new_id()}"
        _, impact, proposed_sha256 = self._build(
            sql,
            context,
            revision,
            asset_id=row["asset_id"],
            proposed_clip_id=proposed_clip_id,
            at_index=request["at_index"],
            duration_us=duration_us,
            layout=request["layout"],
        )
        facts = {
            "schema_version": 1,
            "project_id": context["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": context["requirement_id"],
            "adoption_id": row["adoption_id"],
            "asset_id": row["asset_id"],
            "base_timeline_revision_id": revision["id"],
            "base_document_sha256": revision["document_sha256"],
            "proposed_clip_id": proposed_clip_id,
            "at_index": request["at_index"],
            "duration_us": duration_us,
            "layout": request["layout"],
            "proposed_document_sha256": proposed_sha256,
        }
        facts["preview_sha256"] = _sha256(facts)
        sql.execute(
            "INSERT INTO shot_requirement_timeline_assembly_previews("
            "id,project_id,shot_list_revision_id,shot_requirement_id,adoption_id,asset_id,"
            "base_timeline_revision_id,base_document_sha256,proposed_clip_id,at_index,"
            "duration_us,layout,proposed_document_sha256,preview_sha256,clip_count_before,"
            "shifted_clip_count,shifted_caption_count,duration_before_us,duration_after_us,"
            "expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                preview_id,
                context["project_id"],
                row["shot_list_revision_id"],
                context["requirement_id"],
                row["adoption_id"],
                row["asset_id"],
                revision["id"],
                revision["document_sha256"],
                proposed_clip_id,
                request["at_index"],
                duration_us,
                request["layout"],
                proposed_sha256,
                facts["preview_sha256"],
                impact["clip_count_before"],
                impact["shifted_clip_count"],
                impact["shifted_caption_count"],
                impact["duration_before_us"],
                impact["duration_after_us"],
                _iso(now + PREVIEW_TTL),
                _iso(now),
            ),
        )
        return sql.execute(
            "SELECT preview.*,asset.kind asset_kind,asset.availability,asset.fingerprint,"
            "asset.media_info_json FROM shot_requirement_timeline_assembly_previews preview "
            "JOIN assets asset ON asset.id=preview.asset_id WHERE preview.id=?",
            (preview_id,),
        ).fetchone()

    @staticmethod
    def _preview(row: sqlite3.Row) -> dict[str, Any]:
        media_info = json_loads(row["media_info_json"]) if row["media_info_json"] else {}
        return {
            "preview_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": row["shot_requirement_id"],
            "adoption_id": row["adoption_id"],
            "asset": {
                "asset_id": row["asset_id"],
                "kind": row["asset_kind"],
                "availability": row["availability"],
                "fingerprint": row["fingerprint"],
                "width": media_info.get("width"),
                "height": media_info.get("height"),
            },
            "base_timeline_revision_id": row["base_timeline_revision_id"],
            "base_document_sha256": row["base_document_sha256"],
            "proposed_clip_id": row["proposed_clip_id"],
            "at_index": row["at_index"],
            "duration_us": row["duration_us"],
            "layout": row["layout"],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "preview_sha256": row["preview_sha256"],
            "clip_count_before": row["clip_count_before"],
            "shifted_clip_count": row["shifted_clip_count"],
            "shifted_caption_count": row["shifted_caption_count"],
            "duration_before_us": row["duration_before_us"],
            "duration_after_us": row["duration_after_us"],
            "expires_at": row["expires_at"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _assembly(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "assembly_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": row["shot_requirement_id"],
            "adoption_id": row["adoption_id"],
            "asset_id": row["asset_id"],
            "assembly_preview_id": row["assembly_preview_id"],
            "base_timeline_revision_id": row["base_timeline_revision_id"],
            "output_timeline_revision_id": row["output_timeline_revision_id"],
            "proposed_clip_id": row["proposed_clip_id"],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "created_at": row["created_at"],
        }

    def prepare(
        self, project_id: str, requirement_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        if set(request) != {
            "expected_adoption_id",
            "base_timeline_revision_id",
            "at_index",
            "duration_us",
            "layout",
        }:
            raise DomainError("STAGE5_REQUEST_INVALID", "装配请求不合法")
        if (
            isinstance(request["at_index"], bool)
            or not isinstance(request["at_index"], int)
            or request["at_index"] < 0
        ):
            raise DomainError("STAGE5_POSITION_INVALID", "装配位置不合法")
        if request["layout"] not in LAYOUTS:
            raise DomainError("STAGE5_PREVIEW_MISMATCH", "装配预览参数不匹配")
        with self.db.connection() as sql:
            try:
                sql.execute("BEGIN IMMEDIATE")
                context = self._context(sql, project_id, requirement_id)
                if request["expected_adoption_id"] != context["row"]["adoption_id"]:
                    raise DomainError("STAGE5_ADOPTION_CONFLICT", "当前采用结果已变化")
                if (
                    request["base_timeline_revision_id"]
                    != context["row"]["current_timeline_revision_id"]
                ):
                    raise DomainError("STAGE5_TIMELINE_CONFLICT", "时间线基线已变化")
                revision = self._timeline(sql, context)
                row = self._insert_preview(sql, context, revision, request)
                sql.execute("COMMIT")
                return self._preview(row)
            except Exception:
                if sql.in_transaction:
                    sql.execute("ROLLBACK")
                raise

    def apply(
        self, project_id: str, requirement_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        if set(request) != {
            "assembly_preview_id",
            "proposed_document_sha256",
            "confirmed",
        }:
            raise DomainError("STAGE5_REQUEST_INVALID", "装配请求不合法")
        if request["confirmed"] is not True:
            raise DomainError("STAGE5_CONFIRMATION_REQUIRED", "装配必须显式确认")
        with self.db.connection() as sql:
            try:
                sql.execute("BEGIN IMMEDIATE")
                preview = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_assembly_previews WHERE id=? "
                    "AND project_id=? AND shot_requirement_id=?",
                    (request["assembly_preview_id"], project_id, requirement_id),
                ).fetchone()
                if preview is None:
                    raise DomainError("STAGE5_ASSEMBLY_NOT_FOUND", "装配预览不存在")
                if preview["proposed_document_sha256"] != request["proposed_document_sha256"]:
                    raise DomainError("STAGE5_PREVIEW_MISMATCH", "装配预览不匹配")
                existing = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_assemblies "
                    "WHERE assembly_preview_id=?",
                    (preview["id"],),
                ).fetchone()
                if existing is not None:
                    sql.execute("COMMIT")
                    return {"assembly": self._assembly(existing), "reused": True}
                if preview["expires_at"] <= utc_now():
                    raise DomainError("STAGE5_PREVIEW_EXPIRED", "装配预览已过期")
                context = self._context(sql, project_id, requirement_id)
                if context["row"]["adoption_id"] != preview["adoption_id"]:
                    raise DomainError("STAGE5_ADOPTION_CONFLICT", "当前采用结果已变化")
                if (
                    context["row"]["current_timeline_revision_id"]
                    != preview["base_timeline_revision_id"]
                ):
                    raise DomainError("STAGE5_TIMELINE_CONFLICT", "时间线基线已变化")
                revision = self._timeline(sql, context)
                if revision["document_sha256"] != preview["base_document_sha256"]:
                    raise DomainError("STAGE5_TIMELINE_CONFLICT", "时间线基线已变化")
                document, _, proposed_sha256 = self._build(
                    sql,
                    context,
                    revision,
                    asset_id=preview["asset_id"],
                    proposed_clip_id=preview["proposed_clip_id"],
                    at_index=preview["at_index"],
                    duration_us=preview["duration_us"],
                    layout=preview["layout"],
                )
                if proposed_sha256 != preview["proposed_document_sha256"]:
                    raise DomainError("STAGE5_PREVIEW_MISMATCH", "装配预览不匹配")
                revision_dto = self.timelines.create_revision_from_document(
                    sql,
                    context["project_id"],
                    preview["base_timeline_revision_id"],
                    document,
                    "Stage 5 已采用图片装配",
                )
                assembly_id = f"stage5_assembly_{new_id()}"
                sql.execute(
                    "INSERT INTO shot_requirement_timeline_assemblies("
                    "id,project_id,shot_list_revision_id,shot_requirement_id,adoption_id,"
                    "asset_id,assembly_preview_id,base_timeline_revision_id,"
                    "output_timeline_revision_id,proposed_clip_id,proposed_document_sha256,"
                    "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        assembly_id,
                        context["project_id"],
                        context["row"]["shot_list_revision_id"],
                        requirement_id,
                        preview["adoption_id"],
                        preview["asset_id"],
                        preview["id"],
                        preview["base_timeline_revision_id"],
                        revision_dto["timeline_revision_id"],
                        preview["proposed_clip_id"],
                        preview["proposed_document_sha256"],
                        utc_now(),
                    ),
                )
                row = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_assemblies WHERE id=?",
                    (assembly_id,),
                ).fetchone()
                sql.execute("COMMIT")
                return {"assembly": self._assembly(row), "reused": False}
            except Exception:
                if sql.in_transaction:
                    sql.execute("ROLLBACK")
                raise

    def get_preview(self, preview_id: str) -> dict[str, Any]:
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT preview.*,asset.kind asset_kind,asset.availability,asset.fingerprint,"
                "asset.media_info_json FROM shot_requirement_timeline_assembly_previews preview "
                "JOIN assets asset ON asset.id=preview.asset_id WHERE preview.id=?",
                (preview_id,),
            ).fetchone()
            if row is None:
                raise DomainError("STAGE5_ASSEMBLY_NOT_FOUND", "装配预览不存在")
            return self._preview(row)

    def get_assembly(self, assembly_id: str) -> dict[str, Any]:
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM shot_requirement_timeline_assemblies WHERE id=?",
                (assembly_id,),
            ).fetchone()
            if row is None:
                raise DomainError("STAGE5_ASSEMBLY_NOT_FOUND", "装配不存在")
            return self._assembly(row)

    def list(
        self,
        project_id: str,
        requirement_id: str,
        limit: int = 20,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise DomainError("STAGE5_REQUEST_INVALID", "分页参数无效")
        try:
            offset = int(cursor) if cursor is not None else 0
        except ValueError as exc:
            raise DomainError("STAGE5_REQUEST_INVALID", "分页参数无效") from exc
        if offset < 0 or (cursor is not None and cursor != str(offset)):
            raise DomainError("STAGE5_REQUEST_INVALID", "分页参数无效")
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT * FROM shot_requirement_timeline_assemblies "
                "WHERE project_id=? AND shot_requirement_id=? "
                "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                (project_id, requirement_id, limit, offset),
            ).fetchall()
        return (
            [self._assembly(row) for row in rows],
            str(offset + len(rows)) if len(rows) == limit else None,
        )


