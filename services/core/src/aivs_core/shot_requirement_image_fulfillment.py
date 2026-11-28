from __future__ import annotations

import hmac
import sqlite3
from typing import Any

from .database import Database, utc_now
from .hashing import sha256_canonical as _hash
from .ids import new_id, validate_id
from .projects import DomainError
from .provider_image_generation import ProviderImageGenerationService
from .provider_images import PromptVault

_TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def _id(value: Any, field: str) -> str:
    return validate_id(value, "SHOT_REQUIREMENT_IMAGE_FULFILLMENT_INVALID", f"{field} 无效")


class ShotRequirementImageFulfillmentService:
    """Requirement-scoped orchestration over immutable Stage 4C/4D facts."""

    def __init__(
        self,
        db: Database,
        generations: ProviderImageGenerationService,
        vault: PromptVault | None = None,
    ) -> None:
        self.db = db
        self.generations = generations
        self.vault = vault or PromptVault(ttl_seconds=300, capacity=32)

    @staticmethod
    def _requirement_hash(row: Any) -> str:
        return _hash(
            {
                "schema_version": 1,
                "shot_list_revision_id": row["shot_list_revision_id"],
                "shot_requirement_id": row["id"],
                "ordinal": int(row["ordinal"]),
                "title": row["title"],
                "visual_direction": row["visual_direction"],
                "target_duration_us": row["target_duration_us"],
                "visual_kind": row["visual_kind"],
                "visual_source_asset_id": row["visual_source_asset_id"],
                "narration_kind": row["narration_kind"],
                "narration_text": row["narration_text"],
            }
        )

    @staticmethod
    def _context(sql: sqlite3.Connection, project_id: str, requirement_id: str) -> dict[str, Any]:
        row = sql.execute(
            "SELECT req.*,sr.project_id,sl.current_revision_id,sl.confirmed_revision_id,p.status "
            "FROM shot_requirements req JOIN shot_list_revisions sr "
            "ON sr.id=req.shot_list_revision_id JOIN shot_lists sl ON sl.id=sr.shot_list_id "
            "JOIN projects p ON p.id=sr.project_id WHERE req.id=? AND sr.project_id=?",
            (requirement_id, project_id),
        ).fetchone()
        if row is None:
            raise DomainError("SHOT_REQUIREMENT_NOT_FOUND", "图片镜头需求不存在")
        return {
            "row": row,
            "project_id": project_id,
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": row["id"],
            "requirement_sha256": ShotRequirementImageFulfillmentService._requirement_hash(row),
            "currently_confirmed": row["confirmed_revision_id"] == row["shot_list_revision_id"],
        }

    @staticmethod
    def _require_writable(context: dict[str, Any], expected_revision_id: str | None = None) -> None:
        row = context["row"]
        if row["status"] != "active":
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在或不可写")
        if not context["currently_confirmed"] or (
            expected_revision_id is not None
            and expected_revision_id != context["shot_list_revision_id"]
        ):
            raise DomainError(
                "SHOT_REQUIREMENT_REVISION_CONFLICT", "已确认镜头版本已变化，请重新载入"
            )
        if row["visual_kind"] != "image" or row["visual_source_asset_id"] is not None:
            raise DomainError("SHOT_REQUIREMENT_IMAGE_INELIGIBLE", "镜头需求不支持图片生成履约")

    def prepare(
        self,
        project_id: Any,
        requirement_id: Any,
        expected_confirmed_revision_id: Any,
        provider_config_id: Any,
        prompt: Any,
    ) -> dict[str, Any]:
        project = _id(project_id, "project_id")
        requirement = _id(requirement_id, "requirement_id")
        expected = _id(expected_confirmed_revision_id, "expected_confirmed_revision_id")
        with self.db.connection() as sql:
            context = self._context(sql, project, requirement)
            self._require_writable(context, expected)
        prepared = self.generations.prepare(project, provider_config_id, prompt, "1024x1024")
        facts = {
            "schema_version": 1,
            "project_id": project,
            "shot_list_revision_id": context["shot_list_revision_id"],
            "shot_requirement_id": requirement,
            "requirement_sha256": context["requirement_sha256"],
            "provider_image_preview_id": prepared["preview_id"],
            "provider_image_payload_sha256": prepared["payload_sha256"],
            "provider_config_id": prepared["provider"]["provider_config_id"],
            "provider_kind": prepared["provider"]["provider_kind"],
            "adapter_id": prepared["provider"]["adapter_id"],
            "model": prepared["provider"]["model"],
            "size": prepared["size"],
        }
        facts["fulfillment_payload_sha256"] = _hash(facts)
        preview_id = new_id()
        expires_at = prepared["expires_at"]
        try:
            self.vault.put(preview_id, "", facts, expires_at)
        except Exception:
            self.generations.vault.discard(prepared["preview_id"])
            raise
        return {
            "preview_id": preview_id,
            "project_id": project,
            "shot_list_revision_id": context["shot_list_revision_id"],
            "shot_requirement_id": requirement,
            "requirement_sha256": context["requirement_sha256"],
            "fulfillment_payload_sha256": facts["fulfillment_payload_sha256"],
            "execution_mode": prepared["execution_mode"],
            "prompt_sha256": prepared["prompt_sha256"],
            "size": prepared["size"],
            "output_format": prepared["output_format"],
            "image_count": prepared["image_count"],
            "provider": prepared["provider"],
            "estimated_cost": prepared["estimated_cost"],
            "estimated_cost_currency": prepared["estimated_cost_currency"],
            "price_tier": prepared["price_tier"],
            "expires_at": expires_at,
        }

    def create(
        self,
        project_id: Any,
        requirement_id: Any,
        preview_id: Any,
        payload_sha256: Any,
        expected_confirmed_revision_id: Any,
        confirmed: Any,
    ) -> dict[str, Any]:
        project = _id(project_id, "project_id")
        requirement = _id(requirement_id, "requirement_id")
        preview = _id(preview_id, "preview_id")
        expected = _id(expected_confirmed_revision_id, "expected_confirmed_revision_id")
        if confirmed is not True or not isinstance(payload_sha256, str):
            raise DomainError("SHOT_REQUIREMENT_IMAGE_CONFIRMATION_INVALID", "图片履约确认无效")
        reservation = self.vault.reserve(preview)
        facts = reservation.facts
        if (
            facts["project_id"] != project
            or facts["shot_requirement_id"] != requirement
            or facts["shot_list_revision_id"] != expected
            or not hmac.compare_digest(facts["fulfillment_payload_sha256"], payload_sha256)
        ):
            self.vault.release(preview)
            raise DomainError("SHOT_REQUIREMENT_IMAGE_CONFIRMATION_INVALID", "图片履约确认不匹配")
        outcome: dict[str, Any] = {}

        def link_hook(sql: sqlite3.Connection, request_id: str, _: str, __: bool) -> None:
            context = self._context(sql, project, requirement)
            self._require_writable(context, expected)
            if not hmac.compare_digest(context["requirement_sha256"], facts["requirement_sha256"]):
                raise DomainError(
                    "SHOT_REQUIREMENT_REVISION_CONFLICT", "镜头需求事实已变化，请重新载入"
                )
            existing = sql.execute(
                "SELECT * FROM shot_requirement_image_generation_links "
                "WHERE shot_requirement_id=? AND request_id=?",
                (requirement, request_id),
            ).fetchone()
            if existing is not None:
                outcome.update({"link": self._link(existing), "link_reused": True})
                return
            link_id, now = new_id(), utc_now()
            sql.execute(
                "INSERT INTO shot_requirement_image_generation_links("
                "id,project_id,shot_list_revision_id,shot_requirement_id,request_id,"
                "requirement_sha256,created_at) VALUES (?,?,?,?,?,?,?)",
                (
                    link_id,
                    project,
                    expected,
                    requirement,
                    request_id,
                    facts["requirement_sha256"],
                    now,
                ),
            )
            row = sql.execute(
                "SELECT * FROM shot_requirement_image_generation_links WHERE id=?", (link_id,)
            ).fetchone()
            outcome.update({"link": self._link(row), "link_reused": False})

        try:
            generated = self.generations.create_from_reserved_preview(
                project,
                facts["provider_image_preview_id"],
                facts["provider_image_payload_sha256"],
                True,
                link_hook,
            )
        except Exception:
            self.vault.release(preview)
            raise
        self.vault.commit(preview)
        return {
            "link": outcome["link"],
            "request": generated["request"],
            "task": generated["task"],
            "generation_reused": generated["reused"],
            "link_reused": outcome["link_reused"],
        }

    def get(self, project_id: Any, requirement_id: Any) -> dict[str, Any]:
        project, requirement = _id(project_id, "project_id"), _id(requirement_id, "requirement_id")
        with self.db.connection() as sql:
            context = self._context(sql, project, requirement)
            links = sql.execute(
                "SELECT request_id FROM shot_requirement_image_generation_links "
                "WHERE shot_requirement_id=?",
                (requirement,),
            ).fetchall()
            adoption = sql.execute(
                "SELECT a.*,asset.availability FROM shot_requirement_image_adoptions a "
                "JOIN assets asset ON asset.id=a.asset_id WHERE a.shot_requirement_id=? "
                "ORDER BY a.adoption_ordinal DESC LIMIT 1",
                (requirement,),
            ).fetchone()
            statuses: list[str] = []
            usable = False
            for link in links:
                tasks = sql.execute(
                    "SELECT t.status,t.output_asset_id,asset.availability "
                    "FROM media_generation_tasks t "
                    "LEFT JOIN assets asset ON asset.id=t.output_asset_id WHERE t.request_id=?",
                    (link["request_id"],),
                ).fetchall()
                statuses.extend(row["status"] for row in tasks)
                usable = usable or any(
                    row["status"] == "succeeded" and row["availability"] == "available"
                    for row in tasks
                )
        if adoption is not None:
            lifecycle = (
                "adopted" if adoption["availability"] == "available" else "adopted_unavailable"
            )
        elif usable:
            lifecycle = "review_required"
        elif any(status in {"queued", "running"} for status in statuses):
            lifecycle = "in_progress"
        elif links and statuses and all(status in _TERMINAL for status in statuses):
            lifecycle = "no_usable_output"
        elif links:
            lifecycle = "in_progress"
        else:
            lifecycle = "unstarted"
        return {
            "project_id": project,
            "shot_list_revision_id": context["shot_list_revision_id"],
            "shot_requirement_id": requirement,
            "requirement_sha256": context["requirement_sha256"],
            "currently_confirmed": context["currently_confirmed"],
            "lifecycle": lifecycle,
            "link_count": len(links),
            "current_adoption": self._adoption(adoption) if adoption is not None else None,
            "current_asset_availability": adoption["availability"]
            if adoption is not None
            else None,
        }

    def list_links(
        self, project_id: Any, requirement_id: Any, limit: int = 20, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        return self._page(
            project_id,
            requirement_id,
            "SELECT * FROM shot_requirement_image_generation_links ",
            self._link,
            limit,
            cursor,
        )

    def list_adoptions(
        self, project_id: Any, requirement_id: Any, limit: int = 20, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        return self._page(
            project_id,
            requirement_id,
            "SELECT * FROM shot_requirement_image_adoptions ",
            self._adoption,
            limit,
            cursor,
        )

    def _page(
        self,
        project_id: Any,
        requirement_id: Any,
        select_sql: str,
        projector: Any,
        limit: int,
        cursor: str | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        project, requirement = _id(project_id, "project_id"), _id(requirement_id, "requirement_id")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise DomainError("SHOT_REQUIREMENT_IMAGE_FULFILLMENT_INVALID", "分页参数无效")
        if cursor is not None and (not cursor.isdigit() or int(cursor) < 0):
            raise DomainError("SHOT_REQUIREMENT_IMAGE_FULFILLMENT_INVALID", "分页参数无效")
        offset = int(cursor or 0)
        with self.db.connection() as sql:
            self._context(sql, project, requirement)
            rows = sql.execute(
                select_sql + "WHERE shot_requirement_id=? "
                "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                (requirement, limit, offset),
            ).fetchall()
        return [projector(row) for row in rows], str(offset + len(rows)) if len(
            rows
        ) == limit else None

    def adopt(self, project_id: Any, requirement_id: Any, value: dict[str, Any]) -> dict[str, Any]:
        project, requirement = _id(project_id, "project_id"), _id(requirement_id, "requirement_id")
        if (
            set(value)
            != {
                "generation_link_id",
                "task_id",
                "asset_id",
                "expected_current_adoption_id",
                "confirmed",
            }
            or value["confirmed"] is not True
        ):
            raise DomainError("SHOT_REQUIREMENT_IMAGE_ADOPTION_INVALID", "图片采用确认无效")
        link_id, task_id, asset_id = (
            _id(value[name], name) for name in ("generation_link_id", "task_id", "asset_id")
        )
        expected = value["expected_current_adoption_id"]
        if expected is not None:
            expected = _id(expected, "expected_current_adoption_id")
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                context = self._context(sql, project, requirement)
                self._require_writable(context)
                current = sql.execute(
                    "SELECT * FROM shot_requirement_image_adoptions WHERE shot_requirement_id=? "
                    "ORDER BY adoption_ordinal DESC LIMIT 1",
                    (requirement,),
                ).fetchone()
                current_id = current["id"] if current is not None else None
                if current_id != expected:
                    raise DomainError(
                        "SHOT_REQUIREMENT_IMAGE_ADOPTION_CONFLICT", "当前采用结果已变化，请重新载入"
                    )
                if current is not None and (
                    current["generation_link_id"],
                    current["task_id"],
                    current["asset_id"],
                ) == (link_id, task_id, asset_id):
                    sql.execute("COMMIT")
                    return {"adoption": self._adoption(current), "reused": True}
                adoptable = sql.execute(
                    "SELECT 1 FROM shot_requirement_image_generation_links link "
                    "JOIN media_generation_tasks task ON task.id=? "
                    "AND task.request_id=link.request_id "
                    "JOIN assets asset ON asset.id=? AND asset.id=task.output_asset_id "
                    "JOIN generated_asset_provenance provenance ON provenance.asset_id=asset.id "
                    "AND provenance.request_id=link.request_id AND provenance.task_id=task.id "
                    "WHERE link.id=? AND link.project_id=? AND link.shot_list_revision_id=? "
                    "AND link.shot_requirement_id=? AND task.status='succeeded' "
                    "AND asset.project_id=? AND asset.kind='image' "
                    "AND asset.storage_mode='managed' AND asset.availability='available'",
                    (
                        task_id,
                        asset_id,
                        link_id,
                        project,
                        context["shot_list_revision_id"],
                        requirement,
                        project,
                    ),
                ).fetchone()
                if adoptable is None:
                    raise DomainError(
                        "SHOT_REQUIREMENT_IMAGE_ADOPTION_INVALID",
                        "图片结果不可采用",
                    )
                adoption_id, now = new_id(), utc_now()
                ordinal = int(current["adoption_ordinal"]) + 1 if current is not None else 1
                sql.execute(
                    "INSERT INTO shot_requirement_image_adoptions("
                    "id,project_id,shot_list_revision_id,shot_requirement_id,"
                    "generation_link_id,task_id,asset_id,adoption_ordinal,"
                    "previous_adoption_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        adoption_id,
                        project,
                        context["shot_list_revision_id"],
                        requirement,
                        link_id,
                        task_id,
                        asset_id,
                        ordinal,
                        current_id,
                        now,
                    ),
                )
                row = sql.execute(
                    "SELECT * FROM shot_requirement_image_adoptions WHERE id=?", (adoption_id,)
                ).fetchone()
                sql.execute("COMMIT")
                return {"adoption": self._adoption(row), "reused": False}
            except DomainError:
                sql.execute("ROLLBACK")
                raise
            except sqlite3.IntegrityError as exc:
                sql.execute("ROLLBACK")
                raise DomainError(
                    "SHOT_REQUIREMENT_IMAGE_ADOPTION_INVALID", "图片结果不可采用"
                ) from exc
            except Exception:
                sql.execute("ROLLBACK")
                raise

    @staticmethod
    def _link(row: Any) -> dict[str, Any]:
        return {
            "link_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": row["shot_requirement_id"],
            "request_id": row["request_id"],
            "requirement_sha256": row["requirement_sha256"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _adoption(row: Any) -> dict[str, Any]:
        return {
            "adoption_id": row["id"],
            "project_id": row["project_id"],
            "shot_list_revision_id": row["shot_list_revision_id"],
            "shot_requirement_id": row["shot_requirement_id"],
            "generation_link_id": row["generation_link_id"],
            "task_id": row["task_id"],
            "asset_id": row["asset_id"],
            "adoption_ordinal": int(row["adoption_ordinal"]),
            "previous_adoption_id": row["previous_adoption_id"],
            "created_at": row["created_at"],
        }
