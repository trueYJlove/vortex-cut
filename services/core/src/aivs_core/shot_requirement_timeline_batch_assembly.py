from __future__ import annotations

import hashlib
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .hashing import sha256_canonical as _sha256
from .ids import new_id
from .projects import DomainError
from .timeline import LAYOUTS, TimelineService

MIN_BATCH_ITEMS = 2
MAX_BATCH_ITEMS = 24
MIN_ASSEMBLY_US = 500_000
MAX_ASSEMBLY_US = 30_000_000
PREVIEW_TTL = timedelta(minutes=15)
_PREPARE_KEYS = {"base_timeline_revision_id", "at_index", "items"}
_ITEM_KEYS = {"requirement_id", "expected_adoption_id", "duration_us", "layout"}
_APPLY_KEYS = {"batch_preview_id", "proposed_document_sha256", "confirmed"}


def _document_sha256(document: dict[str, Any]) -> str:
    value = json_dumps(document)
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _media_info(value: str | None) -> dict[str, Any]:
    info = json_loads(value) if value else {}
    return info if isinstance(info, dict) else {}


class ShotRequirementTimelineBatchAssemblyService:
    """Local-only explicit Timeline batch assembly for currently adopted images."""

    def __init__(self, db: Database, timelines: TimelineService) -> None:
        self.db = db
        self.timelines = timelines

    @staticmethod
    def _request(request: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request) != _PREPARE_KEYS:
            raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "批量装配请求不合法")
        at_index = request["at_index"]
        if isinstance(at_index, bool) or not isinstance(at_index, int) or at_index < 0:
            raise DomainError("STAGE6_BATCH_POSITION_INVALID", "批量装配位置不合法")
        items = request["items"]
        if not isinstance(items, list) or not MIN_BATCH_ITEMS <= len(items) <= MAX_BATCH_ITEMS:
            raise DomainError("STAGE6_BATCH_SIZE_INVALID", "批量装配数量需为 2-24")
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict) or set(item) != _ITEM_KEYS:
                raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "批量装配条目不合法")
            requirement_id = item["requirement_id"]
            adoption_id = item["expected_adoption_id"]
            duration_us = item["duration_us"]
            layout = item["layout"]
            if not isinstance(requirement_id, str) or not requirement_id:
                raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "批量装配条目不合法")
            if requirement_id in seen:
                raise DomainError("STAGE6_BATCH_REQUIREMENT_DUPLICATED", "批量装配条目不能重复")
            seen.add(requirement_id)
            if not isinstance(adoption_id, str) or not adoption_id:
                raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "批量装配条目不合法")
            if (
                isinstance(duration_us, bool)
                or not isinstance(duration_us, int)
                or not MIN_ASSEMBLY_US <= duration_us <= MAX_ASSEMBLY_US
            ):
                raise DomainError("STAGE6_BATCH_DURATION_INVALID", "图片装配时长需为 0.5-30 秒")
            if layout not in LAYOUTS:
                raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "图片装配布局不合法")
            normalized.append(
                {
                    "requirement_id": requirement_id,
                    "expected_adoption_id": adoption_id,
                    "duration_us": duration_us,
                    "layout": layout,
                }
            )
        return {
            "base_timeline_revision_id": request["base_timeline_revision_id"],
            "at_index": at_index,
            "items": normalized,
        }

    @staticmethod
    def _contexts(
        sql: sqlite3.Connection, project_id: str, requirements: list[dict[str, Any]]
    ) -> dict[str, Any]:
        requirement_ids = [item["requirement_id"] for item in requirements]
        placeholders = ",".join("?" for _ in requirement_ids)
        rows = sql.execute(
            "SELECT project.status project_status,project.current_timeline_revision_id,"
            "shot_list.confirmed_revision_id,requirement.id requirement_id,"
            "requirement.shot_list_revision_id,requirement.visual_kind,"
            "requirement.visual_source_asset_id,adoption.id adoption_id,"
            "adoption.asset_id,task.status task_status,asset.kind asset_kind,"
            "asset.storage_mode,asset.availability,asset.fingerprint,asset.media_info_json "
            "FROM shot_requirements requirement "
            "JOIN shot_list_revisions revision ON revision.id=requirement.shot_list_revision_id "
            "JOIN shot_lists shot_list ON shot_list.id=revision.shot_list_id "
            "JOIN projects project ON project.id=revision.project_id "
            "JOIN shot_requirement_image_adoptions adoption "
            "ON adoption.id=(SELECT current.id FROM shot_requirement_image_adoptions current "
            "WHERE current.shot_requirement_id=requirement.id "
            "ORDER BY current.adoption_ordinal DESC,current.created_at DESC,"
            "current.id DESC LIMIT 1) "
            "JOIN shot_requirement_image_generation_links link "
            "ON link.id=adoption.generation_link_id "
            "JOIN media_generation_tasks task ON task.id=adoption.task_id "
            "JOIN generated_asset_provenance provenance "
            "ON provenance.asset_id=adoption.asset_id "
            "AND provenance.request_id=link.request_id AND provenance.task_id=task.id "
            "JOIN assets asset ON asset.id=adoption.asset_id "
            f"WHERE requirement.id IN ({placeholders}) "
            "AND revision.project_id=? AND adoption.project_id=? AND link.project_id=? "
            "AND link.shot_requirement_id=requirement.id "
            "AND link.shot_list_revision_id=revision.id",
            (*requirement_ids, project_id, project_id, project_id),
        ).fetchall()
        if len(rows) != len(requirements):
            raise DomainError(
                "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE", "批量镜头需求不存在或不可装配"
            )
        by_requirement = {row["requirement_id"]: row for row in rows}
        if len({row["shot_list_revision_id"] for row in rows}) != 1:
            raise DomainError(
                "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE", "批量镜头需求不属于同一确认版本"
            )
        first = rows[0]
        if first["project_status"] != "active":
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在或不可写")
        if first["confirmed_revision_id"] != first["shot_list_revision_id"]:
            raise DomainError(
                "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE", "批量镜头需求不属于当前确认版本"
            )
        for item in requirements:
            row = by_requirement[item["requirement_id"]]
            if (
                row["visual_kind"] != "image"
                or row["visual_source_asset_id"] is not None
                or row["task_status"] != "succeeded"
            ):
                raise DomainError(
                    "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE", "批量镜头需求当前不可装配"
                )
            if row["adoption_id"] != item["expected_adoption_id"]:
                raise DomainError("STAGE6_BATCH_ADOPTION_CONFLICT", "当前采用结果已变化")
            if (
                row["asset_kind"] != "image"
                or row["storage_mode"] != "managed"
                or row["availability"] != "available"
            ):
                raise DomainError("STAGE6_BATCH_ASSET_UNAVAILABLE", "批量装配素材不可用")
        if first["current_timeline_revision_id"] is None:
            raise DomainError("STAGE6_BATCH_TIMELINE_REQUIRED", "项目尚未创建时间线")
        if sql.execute(
            "SELECT 1 FROM timeline_drafts WHERE project_id=?", (project_id,)
        ).fetchone():
            raise DomainError("STAGE6_BATCH_TIMELINE_DRAFT_EXISTS", "时间线 Draft 未保存")
        revision = sql.execute(
            "SELECT * FROM timeline_revisions WHERE id=? AND project_id=?",
            (first["current_timeline_revision_id"], project_id),
        ).fetchone()
        if revision is None:
            raise DomainError("STAGE6_BATCH_TIMELINE_REQUIRED", "项目尚未创建时间线")
        clip_ids = {
            clip["clip_id"] for clip in json_loads(revision["document_json"]).get("clips", [])
        }
        assembled = sql.execute(
            "SELECT proposed_clip_id FROM shot_requirement_timeline_assemblies "
            f"WHERE project_id=? AND shot_requirement_id IN ({placeholders}) "
            "UNION ALL "
            "SELECT item.proposed_clip_id FROM shot_requirement_timeline_batch_assembly_items item "
            "JOIN shot_requirement_timeline_batch_assemblies batch "
            "ON batch.id=item.batch_assembly_id "
            f"WHERE batch.project_id=? AND item.shot_requirement_id IN ({placeholders})",
            (project_id, *requirement_ids, project_id, *requirement_ids),
        ).fetchall()
        if any(row[0] in clip_ids for row in assembled):
            raise DomainError("STAGE6_BATCH_ALREADY_ASSEMBLED", "批量镜头需求已装配到当前时间线")
        return {"rows": by_requirement, "revision": revision, "project_id": project_id}

    def _build(
        self,
        sql: sqlite3.Connection,
        context: dict[str, Any],
        items: list[dict[str, Any]],
        rows: list[dict[str, Any]],
        clip_ids: list[str],
        at_index: int,
    ) -> tuple[dict[str, Any], dict[str, int], list[dict[str, int]]]:
        document = json_loads(context["revision"]["document_json"])
        document.setdefault("locked_elements", [])
        impacts: list[dict[str, int]] = []
        position = at_index
        for item, row, clip_id in zip(items, rows, clip_ids, strict=True):
            clips = document.get("clips")
            if not isinstance(clips, list) or not 0 <= position <= len(clips):
                raise DomainError("STAGE6_BATCH_POSITION_INVALID", "批量装配位置不合法")
            locked = set(document.get("locked_elements", []))
            if any(clip.get("clip_id") in locked for clip in clips[position:]):
                raise DomainError("STAGE6_BATCH_POSITION_INVALID", "批量装配会移动锁定 Clip")
            document, impact = self.timelines.build_asset_insert_document(
                sql,
                project_id=context["project_id"],
                base_document=document,
                asset_id=row["asset_id"],
                proposed_clip_id=clip_id,
                at_index=position,
                duration_us=item["duration_us"],
                layout=item["layout"],
            )
            impacts.append(impact)
            position += 1
        summary = {
            "clip_count_before": impacts[0]["clip_count_before"],
            "clip_count_after": impacts[0]["clip_count_before"] + len(items),
            "shifted_clip_count": impacts[-1]["shifted_clip_count"],
            "shifted_caption_count": impacts[-1]["shifted_caption_count"],
            "duration_before_us": impacts[0]["duration_before_us"],
            "duration_after_us": impacts[-1]["duration_after_us"],
        }
        return document, summary, impacts

    @staticmethod
    def _preview_facts(
        project_id: str,
        shot_list_revision_id: str,
        base_timeline_revision_id: str,
        base_document_sha256: str,
        at_index: int,
        item_count: int,
        proposed_document_sha256: str,
        summary: dict[str, int],
    ) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "project_id": project_id,
            "shot_list_revision_id": shot_list_revision_id,
            "base_timeline_revision_id": base_timeline_revision_id,
            "base_document_sha256": base_document_sha256,
            "at_index": at_index,
            "item_count": item_count,
            "proposed_document_sha256": proposed_document_sha256,
            **summary,
        }

    @staticmethod
    def _preview(row: sqlite3.Row, items: list[sqlite3.Row]) -> dict[str, Any]:
        return {
            "preview_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "base_timeline_revision_id": row["base_timeline_revision_id"],
            "base_document_sha256": row["base_document_sha256"],
            "at_index": row["at_index"],
            "item_count": row["item_count"],
            "items": [
                ShotRequirementTimelineBatchAssemblyService._preview_item(item) for item in items
            ],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "preview_sha256": row["preview_sha256"],
            "clip_count_before": row["clip_count_before"],
            "clip_count_after": row["clip_count_after"],
            "shifted_clip_count": row["shifted_clip_count"],
            "shifted_caption_count": row["shifted_caption_count"],
            "duration_before_us": row["duration_before_us"],
            "duration_after_us": row["duration_after_us"],
            "expires_at": row["expires_at"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _preview_item(row: sqlite3.Row) -> dict[str, Any]:
        media_info = _media_info(row["media_info_json"]) if "media_info_json" in row.keys() else {}
        return {
            "item_index": row["item_index"],
            "shot_requirement_id": row["shot_requirement_id"],
            "adoption_id": row["adoption_id"],
            "asset": {
                "asset_id": row["asset_id"],
                "kind": row["asset_kind"] if "asset_kind" in row.keys() else "image",
                "availability": row["availability"]
                if "availability" in row.keys()
                else "available",
                "fingerprint": row["fingerprint"] if "fingerprint" in row.keys() else None,
                "width": media_info.get("width"),
                "height": media_info.get("height"),
            },
            "proposed_clip_id": row["proposed_clip_id"],
            "duration_us": row["duration_us"],
            "layout": row["layout"],
            "item_sha256": row["item_sha256"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _assembly(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "batch_assembly_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "batch_preview_id": row["batch_preview_id"],
            "base_timeline_revision_id": row["base_timeline_revision_id"],
            "output_timeline_revision_id": row["output_timeline_revision_id"],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "item_count": row["item_count"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _assembly_item(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "item_index": row["item_index"],
            "shot_requirement_id": row["shot_requirement_id"],
            "adoption_id": row["adoption_id"],
            "asset_id": row["asset_id"],
            "proposed_clip_id": row["proposed_clip_id"],
            "duration_us": row["duration_us"],
            "layout": row["layout"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _pagination(limit: int, cursor: str | None) -> int:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "分页参数无效")
        try:
            offset = int(cursor) if cursor is not None else 0
        except ValueError as exc:
            raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "分页参数无效") from exc
        if offset < 0 or (cursor is not None and cursor != str(offset)):
            raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "分页参数无效")
        return offset

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        request = self._request(request)
        with self.db.connection() as sql:
            try:
                sql.execute("BEGIN IMMEDIATE")
                context = self._contexts(sql, project_id, request["items"])
                if context["revision"]["id"] != request["base_timeline_revision_id"]:
                    raise DomainError("STAGE6_BATCH_TIMELINE_CONFLICT", "时间线基线已变化")
                rows = [context["rows"][item["requirement_id"]] for item in request["items"]]
                clip_ids = [f"clip_{new_id()}" for _ in request["items"]]
                document, summary, _ = self._build(
                    sql, context, request["items"], rows, clip_ids, request["at_index"]
                )
                proposed_sha256 = _document_sha256(document)
                now = _now()
                preview_id = f"stage6_batch_preview_{new_id()}"
                facts = self._preview_facts(
                    project_id,
                    rows[0]["shot_list_revision_id"],
                    context["revision"]["id"],
                    context["revision"]["document_sha256"],
                    request["at_index"],
                    len(request["items"]),
                    proposed_sha256,
                    summary,
                )
                preview_sha256 = _sha256(facts)
                sql.execute(
                    "INSERT INTO shot_requirement_timeline_batch_assembly_previews("
                    "id,project_id,shot_list_revision_id,base_timeline_revision_id,"
                    "base_document_sha256,at_index,item_count,proposed_document_sha256,"
                    "preview_sha256,clip_count_before,clip_count_after,shifted_clip_count,"
                    "shifted_caption_count,duration_before_us,duration_after_us,expires_at,created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        preview_id,
                        project_id,
                        rows[0]["shot_list_revision_id"],
                        context["revision"]["id"],
                        context["revision"]["document_sha256"],
                        request["at_index"],
                        len(request["items"]),
                        proposed_sha256,
                        preview_sha256,
                        summary["clip_count_before"],
                        summary["clip_count_after"],
                        summary["shifted_clip_count"],
                        summary["shifted_caption_count"],
                        summary["duration_before_us"],
                        summary["duration_after_us"],
                        _iso(now + PREVIEW_TTL),
                        _iso(now),
                    ),
                )
                item_ids = [f"stage6_batch_preview_item_{new_id()}" for _ in request["items"]]
                for index, (item, row, clip_id) in enumerate(
                    zip(request["items"], rows, clip_ids, strict=True)
                ):
                    item_facts = {
                        "schema_version": 1,
                        "batch_preview_id": preview_id,
                        "item_index": index,
                        "shot_requirement_id": item["requirement_id"],
                        "adoption_id": row["adoption_id"],
                        "asset_id": row["asset_id"],
                        "proposed_clip_id": clip_id,
                        "duration_us": item["duration_us"],
                        "layout": item["layout"],
                    }
                    sql.execute(
                        "INSERT INTO shot_requirement_timeline_batch_assembly_preview_items("
                        "id,batch_preview_id,item_index,shot_requirement_id,adoption_id,asset_id,"
                        "proposed_clip_id,duration_us,layout,item_sha256,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            item_ids[index],
                            preview_id,
                            index,
                            item["requirement_id"],
                            row["adoption_id"],
                            row["asset_id"],
                            clip_id,
                            item["duration_us"],
                            item["layout"],
                            _sha256(item_facts),
                            _iso(now),
                        ),
                    )
                row = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_batch_assembly_previews WHERE id=?",
                    (preview_id,),
                ).fetchone()
                items = sql.execute(
                    "SELECT item.*,asset.kind asset_kind,asset.availability,asset.fingerprint,"
                    "asset.media_info_json "
                    "FROM shot_requirement_timeline_batch_assembly_preview_items item "
                    "JOIN assets asset ON asset.id=item.asset_id "
                    "WHERE item.batch_preview_id=? ORDER BY item.item_index",
                    (preview_id,),
                ).fetchall()
                result = self._preview(row, items)
                sql.execute("COMMIT")
                return result
            except Exception:
                if sql.in_transaction:
                    sql.execute("ROLLBACK")
                raise

    def apply(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request) != _APPLY_KEYS:
            raise DomainError("STAGE6_BATCH_REQUEST_INVALID", "批量装配请求不合法")
        if request["confirmed"] is not True:
            raise DomainError("STAGE6_BATCH_CONFIRMATION_REQUIRED", "批量装配必须显式确认")
        with self.db.connection() as sql:
            try:
                sql.execute("BEGIN IMMEDIATE")
                preview = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_batch_assembly_previews "
                    "WHERE id=? AND project_id=?",
                    (request["batch_preview_id"], project_id),
                ).fetchone()
                if preview is None:
                    raise DomainError("STAGE6_BATCH_NOT_FOUND", "批量装配预览不存在")
                if preview["proposed_document_sha256"] != request["proposed_document_sha256"]:
                    raise DomainError("STAGE6_BATCH_PREVIEW_MISMATCH", "批量装配预览不匹配")
                existing = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_batch_assemblies "
                    "WHERE batch_preview_id=?",
                    (preview["id"],),
                ).fetchone()
                if existing is not None:
                    sql.execute("COMMIT")
                    return {"assembly": self._assembly(existing), "reused": True}
                if preview["expires_at"] <= utc_now():
                    raise DomainError("STAGE6_BATCH_PREVIEW_EXPIRED", "批量装配预览已过期")
                preview_items = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_batch_assembly_preview_items "
                    "WHERE batch_preview_id=? ORDER BY item_index",
                    (preview["id"],),
                ).fetchall()
                if len(preview_items) != preview["item_count"]:
                    raise DomainError("STAGE6_BATCH_PREVIEW_MISMATCH", "批量装配预览不匹配")
                requirements = [
                    {
                        "requirement_id": item["shot_requirement_id"],
                        "expected_adoption_id": item["adoption_id"],
                        "duration_us": item["duration_us"],
                        "layout": item["layout"],
                    }
                    for item in preview_items
                ]
                context = self._contexts(sql, project_id, requirements)
                if (
                    context["revision"]["id"] != preview["base_timeline_revision_id"]
                    or context["revision"]["document_sha256"] != preview["base_document_sha256"]
                ):
                    raise DomainError("STAGE6_BATCH_TIMELINE_CONFLICT", "时间线基线已变化")
                rows = [context["rows"][item["requirement_id"]] for item in requirements]
                document, _, _ = self._build(
                    sql,
                    context,
                    requirements,
                    rows,
                    [item["proposed_clip_id"] for item in preview_items],
                    preview["at_index"],
                )
                if _document_sha256(document) != preview["proposed_document_sha256"]:
                    raise DomainError("STAGE6_BATCH_PREVIEW_MISMATCH", "批量装配预览不匹配")
                revision_dto = self.timelines.create_revision_from_document(
                    sql,
                    project_id,
                    preview["base_timeline_revision_id"],
                    document,
                    "Stage 6-R 批量已采用图片装配",
                )
                batch_id = f"stage6_batch_assembly_{new_id()}"
                now = utc_now()
                sql.execute(
                    "INSERT INTO shot_requirement_timeline_batch_assemblies("
                    "id,project_id,shot_list_revision_id,batch_preview_id,base_timeline_revision_id,"
                    "output_timeline_revision_id,proposed_document_sha256,item_count,created_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        batch_id,
                        project_id,
                        preview["shot_list_revision_id"],
                        preview["id"],
                        preview["base_timeline_revision_id"],
                        revision_dto["timeline_revision_id"],
                        preview["proposed_document_sha256"],
                        preview["item_count"],
                        now,
                    ),
                )
                for item in preview_items:
                    sql.execute(
                        "INSERT INTO shot_requirement_timeline_batch_assembly_items("
                        "id,batch_assembly_id,item_index,shot_requirement_id,adoption_id,asset_id,"
                        "proposed_clip_id,duration_us,layout,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            f"stage6_batch_assembly_item_{new_id()}",
                            batch_id,
                            item["item_index"],
                            item["shot_requirement_id"],
                            item["adoption_id"],
                            item["asset_id"],
                            item["proposed_clip_id"],
                            item["duration_us"],
                            item["layout"],
                            now,
                        ),
                    )
                row = sql.execute(
                    "SELECT * FROM shot_requirement_timeline_batch_assemblies WHERE id=?",
                    (batch_id,),
                ).fetchone()
                result = {"assembly": self._assembly(row), "reused": False}
                sql.execute("COMMIT")
                return result
            except Exception:
                if sql.in_transaction:
                    sql.execute("ROLLBACK")
                raise

    def get_preview(self, preview_id: str) -> dict[str, Any]:
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM shot_requirement_timeline_batch_assembly_previews WHERE id=?",
                (preview_id,),
            ).fetchone()
            if row is None:
                raise DomainError("STAGE6_BATCH_NOT_FOUND", "批量装配预览不存在")
            items = sql.execute(
                "SELECT item.*,asset.kind asset_kind,asset.availability,asset.fingerprint,"
                "asset.media_info_json "
                "FROM shot_requirement_timeline_batch_assembly_preview_items item "
                "JOIN assets asset ON asset.id=item.asset_id "
                "WHERE item.batch_preview_id=? ORDER BY item.item_index",
                (preview_id,),
            ).fetchall()
            return self._preview(row, items)

    def get_batch(self, batch_id: str) -> dict[str, Any]:
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM shot_requirement_timeline_batch_assemblies WHERE id=?",
                (batch_id,),
            ).fetchone()
            if row is None:
                raise DomainError("STAGE6_BATCH_NOT_FOUND", "批量装配不存在")
            return self._assembly(row)

    def list(
        self, project_id: str, limit: int = 20, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        offset = self._pagination(limit, cursor)
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT * FROM shot_requirement_timeline_batch_assemblies WHERE project_id=? "
                "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                (project_id, limit, offset),
            ).fetchall()
        return (
            [self._assembly(row) for row in rows],
            str(offset + len(rows)) if len(rows) == limit else None,
        )

    def list_items(
        self, batch_id: str, limit: int = 20, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        offset = self._pagination(limit, cursor)
        with self.db.connection() as sql:
            if not sql.execute(
                "SELECT 1 FROM shot_requirement_timeline_batch_assemblies WHERE id=?", (batch_id,)
            ).fetchone():
                raise DomainError("STAGE6_BATCH_NOT_FOUND", "批量装配不存在")
            rows = sql.execute(
                "SELECT * FROM shot_requirement_timeline_batch_assembly_items "
                "WHERE batch_assembly_id=? ORDER BY item_index LIMIT ? OFFSET ?",
                (batch_id, limit, offset),
            ).fetchall()
        return (
            [self._assembly_item(row) for row in rows],
            str(offset + len(rows)) if len(rows) == limit else None,
        )
