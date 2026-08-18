from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from ..database import Database, sha256_file, utc_now
from ..ids import new_id
from ..jobs import JobService
from ..projects import DomainError
from ..rendering.plan import RenderPlanCompiler
from ..rendering.service import DirectoryGrantStore
from .reframe import RenditionReframeSnapshotService

_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def safe_export_filename(
    project_name: str, platform_tag: str, rendition_tag: str, item_id: str
) -> str:
    cleaned = unicodedata.normalize("NFKC", project_name)
    cleaned = "".join("-" if ord(char) < 32 or char in '<>:"/\\|?*' else char for char in cleaned)
    cleaned = re.sub(r"[-\s]+", "-", cleaned).strip(" .-")[:80] or "project"
    if cleaned.upper() in _RESERVED:
        cleaned = f"project-{cleaned}"
    name = f"{cleaned}-{platform_tag}-{rendition_tag}-reframe-{item_id[-8:]}.mp4"
    return name[: 240 - 4] + ".mp4" if len(name) > 240 else name


class ReframeExportBatchService:
    def __init__(
        self,
        database: Database,
        snapshots: RenditionReframeSnapshotService,
        grants: DirectoryGrantStore,
        jobs: JobService,
        compiler: RenderPlanCompiler,
        renders: Any,
    ) -> None:
        self.database = database
        self.snapshots = snapshots
        self.grants = grants
        self.jobs = jobs
        self.compiler = compiler
        self.renders = renders

    async def create(
        self,
        project_id: str,
        directory_grant_id: str,
        items: list[dict[str, Any]],
        *,
        retry_of_batch_id: str | None = None,
        retry_of_item_ids: list[str | None] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(items, list) or not 1 <= len(items) <= 8:
            raise DomainError("REFRAME_BATCH_INVALID", "批量导出目标数量必须为 1-8")
        timeline_revision_id = self._timeline_revision_id(project_id, items)
        grant = self.grants.inspect(directory_grant_id)
        prepared = await self._preflight(project_id, timeline_revision_id, items, grant)
        batch_id, now = f"reframe_export_batch_{new_id()}", utc_now()
        try:
            with self.database.connection() as db:
                db.execute("BEGIN")
                revision = db.execute(
                    "SELECT document_sha256 FROM timeline_revisions WHERE id=?",
                    (timeline_revision_id,),
                ).fetchone()
                db.execute(
                    "INSERT INTO reframe_export_batches(id,project_id,timeline_revision_id,timeline_document_sha256,directory_display_name,retry_of_batch_id,created_at) VALUES (?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        batch_id,
                        project_id,
                        timeline_revision_id,
                        revision["document_sha256"],
                        grant["display_name"],
                        retry_of_batch_id,
                        now,
                    ),
                )
                for ordinal, item in enumerate(prepared):
                    item_id = f"reframe_export_batch_item_{new_id()}"
                    filename = safe_export_filename(
                        item["project_name"], item["platform_tag"], item["rendition_tag"], item_id
                    )
                    target = Path(grant["path"]) / filename
                    if (
                        target.exists()
                        or target.parent.resolve() != Path(grant["path"]).resolve()
                        or target.is_symlink()
                    ):
                        raise DomainError("EXPORT_DESTINATION_EXISTS", "导出目标已存在")
                    retry_of_item_id = retry_of_item_ids[ordinal] if retry_of_item_ids else None
                    db.execute(
                        "INSERT INTO reframe_export_batch_items(id,reframe_export_batch_id,ordinal,project_id,timeline_revision_id,rendition_reframe_snapshot_id,preview_artifact_id,platform_preset_id,rendition_preset_id,destination_display_name,retry_of_item_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                        (
                            item_id,
                            batch_id,
                            ordinal,
                            project_id,
                            timeline_revision_id,
                            item["snapshot_id"],
                            item["preview_id"],
                            item["platform_id"],
                            item["rendition_id"],
                            filename,
                            retry_of_item_id,
                            now,
                        ),
                    )
                    self.jobs.create_reframe_batch_render_in_transaction(
                        db,
                        project_id,
                        timeline_revision_id,
                        item_id,
                        item["encoder"],
                        {
                            "content_fingerprint": item["export_fingerprint"],
                            "toolchain": item["toolchain"],
                            "directory_grant_id": directory_grant_id,
                            "reframe_export_batch_id": batch_id,
                            "destination_display_name": filename,
                            "rendition_reframe_snapshot_id": item["snapshot_id"],
                        },
                    )
                db.execute("COMMIT")
        except Exception:
            # The grant remains unclaimed when preflight/transaction fails.
            raise
        self.grants.claim(directory_grant_id, batch_id)
        batch = self.get(batch_id)
        return {
            "batch": batch,
            "jobs": [self.jobs.get(item["job_id"]) for item in batch["items"] if item["job_id"]],
        }

    def _timeline_revision_id(self, project_id: str, items: list[dict[str, Any]]) -> str:
        revision_ids: set[str] = set()
        for item in items:
            if not isinstance(item, dict):
                raise DomainError("REFRAME_BATCH_INVALID", "批量导出项不合法")
            snapshot_id = item.get("rendition_reframe_snapshot_id")
            if not isinstance(snapshot_id, str):
                raise DomainError("REFRAME_BATCH_INVALID", "批量导出项不完整")
            snapshot = self.snapshots.get(snapshot_id)
            if snapshot["project_id"] != project_id:
                raise DomainError("REFRAME_BATCH_INVALID", "重构图快照不属于当前项目")
            revision_ids.add(snapshot["timeline_revision_id"])
        if len(revision_ids) != 1:
            raise DomainError("REFRAME_BATCH_INVALID", "批量导出项必须属于同一 Timeline")
        return revision_ids.pop()

    async def _preflight(
        self,
        project_id: str,
        timeline_revision_id: str,
        items: list[dict[str, Any]],
        grant: dict[str, Any],
    ) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        keys: set[tuple[str, str]] = set()
        with self.database.connection() as db:
            project = db.execute(
                "SELECT name,status FROM projects WHERE id=?", (project_id,)
            ).fetchone()
            revision = db.execute(
                "SELECT document_sha256 FROM timeline_revisions WHERE id=? AND project_id=?",
                (timeline_revision_id, project_id),
            ).fetchone()
            if project is None or revision is None or project["status"] == "archived":
                raise DomainError("REFRAME_BATCH_INVALID", "项目或 Timeline 不可导出")
            for item in items:
                if not isinstance(item, dict) or set(item) - {
                    "rendition_reframe_snapshot_id",
                    "preview_artifact_id",
                    "encoder_mode",
                }:
                    raise DomainError("REFRAME_BATCH_INVALID", "批量导出项不合法")
                snapshot_id, preview_id = (
                    item.get("rendition_reframe_snapshot_id"),
                    item.get("preview_artifact_id"),
                )
                if not isinstance(snapshot_id, str) or not isinstance(preview_id, str):
                    raise DomainError("REFRAME_BATCH_INVALID", "批量导出项不完整")
                snapshot = self.snapshots.get(snapshot_id)
                if (
                    snapshot["project_id"] != project_id
                    or snapshot["timeline_revision_id"] != timeline_revision_id
                    or snapshot["timeline_document_sha256"] != revision["document_sha256"]
                ):
                    raise DomainError("REFRAME_PREVIEW_STALE", "权威预览已过期")
                key = (snapshot["platform_preset_id"], snapshot["rendition_preset_id"])
                if key in keys:
                    raise DomainError("REFRAME_BATCH_ITEM_DUPLICATE", "批量导出目标重复")
                keys.add(key)
                preview_plan = self.compiler.compile_reframe(
                    project_id, timeline_revision_id, snapshot_id, "authoritative_preview"
                )
                artifact = db.execute(
                    "SELECT ra.*,a.path,a.sha256,j.status FROM render_artifacts ra "
                    "JOIN artifacts a ON a.id=ra.artifact_id "
                    "JOIN jobs j ON j.id=a.job_id WHERE ra.artifact_id=?",
                    (preview_id,),
                ).fetchone()
                if (
                    artifact is None
                    or artifact["kind"] != "authoritative_preview"
                    or artifact["status"] != "succeeded"
                    or artifact["rendition_reframe_snapshot_id"] != snapshot_id
                    or artifact["profile_id"] != preview_plan["output"]["profile_id"]
                    or not Path(artifact["path"]).is_file()
                    or sha256_file(Path(artifact["path"])) != artifact["sha256"]
                ):
                    raise DomainError("REFRAME_PREVIEW_REQUIRED", "缺少匹配的权威预览")
                requested_mode = item.get("encoder_mode", "auto")
                if not isinstance(requested_mode, str):
                    raise DomainError("REFRAME_BATCH_INVALID", "编码器模式不合法")
                try:
                    encoder, toolchain = await self.renders.select_reframe_encoder(requested_mode)
                except RuntimeError as exc:
                    raise DomainError("REFRAME_BATCH_INVALID", "编码器不可用") from exc
                try:
                    artifact_toolchain = json.loads(artifact["toolchain_json"])
                except (TypeError, json.JSONDecodeError) as exc:
                    raise DomainError("REFRAME_PREVIEW_STALE", "权威预览工具链不合法") from exc
                if artifact_toolchain != toolchain:
                    raise DomainError("REFRAME_PREVIEW_STALE", "权威预览工具链不匹配")
                if artifact["content_fingerprint"] != preview_plan["content_fingerprint"]:
                    raise DomainError("REFRAME_PREVIEW_STALE", "权威预览内容已过期")
                plan = self.compiler.compile_reframe(
                    project_id, timeline_revision_id, snapshot_id, "final_export"
                )
                output.append(
                    {
                        "snapshot_id": snapshot_id,
                        "preview_id": preview_id,
                        "platform_id": key[0],
                        "rendition_id": key[1],
                        "platform_tag": self.snapshots.presets.platforms[key[0]]["filename_tag"],
                        "rendition_tag": self.snapshots.presets.renditions[key[1]]["filename_tag"],
                        "project_name": project["name"],
                        "encoder": encoder,
                        "toolchain": toolchain,
                        "export_fingerprint": plan["content_fingerprint"],
                    }
                )
        return output

    def get(self, batch_id: str) -> dict[str, Any]:
        with self.database.connection() as db:
            batch = db.execute(
                "SELECT * FROM reframe_export_batches WHERE id=?", (batch_id,)
            ).fetchone()
            if batch is None:
                raise DomainError("REFRAME_BATCH_INVALID", "批量导出不存在")
            rows = db.execute(
                "SELECT i.*,j.id AS job_id,j.status,j.progress,j.error_code FROM reframe_export_batch_items i LEFT JOIN jobs j ON j.reframe_export_batch_item_id=i.id WHERE i.reframe_export_batch_id=? ORDER BY i.ordinal",  # noqa: E501
                (batch_id,),
            ).fetchall()
        items = []
        updated_at = batch["created_at"]
        for row in rows:
            snapshot = self.snapshots.safe_summary(row["rendition_reframe_snapshot_id"])
            export = self._export_record_id(row["id"])
            items.append(
                {
                    "reframe_export_batch_item_id": row["id"],
                    "ordinal": row["ordinal"],
                    "rendition_reframe_snapshot": snapshot,
                    "preview_artifact_id": row["preview_artifact_id"],
                    "destination_display_name": row["destination_display_name"],
                    "job_id": row["job_id"],
                    "status": self._item_status(row["status"]),
                    "progress": row["progress"],
                    "error_code": row["error_code"],
                    "export_record_id": export,
                    "retry_of_item_id": row["retry_of_item_id"],
                }
            )
            if row["job_id"]:
                job = self.jobs.get(row["job_id"])
                if job and job["updated_at"] > updated_at:
                    updated_at = job["updated_at"]
        return {
            "reframe_export_batch_id": batch["id"],
            "project_id": batch["project_id"],
            "timeline_revision_id": batch["timeline_revision_id"],
            "directory_display_name": batch["directory_display_name"],
            "retry_of_batch_id": batch["retry_of_batch_id"],
            "created_at": batch["created_at"],
            "updated_at": updated_at,
            "status": self._batch_status([item["status"] for item in items]),
            "items": items,
        }

    def _export_record_id(self, item_id: str) -> str | None:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT id FROM export_records WHERE reframe_export_batch_item_id=?", (item_id,)
            ).fetchone()
        return row["id"] if row else None

    def list(self, project_id: str) -> list[dict[str, Any]]:
        with self.database.connection() as db:
            ids = [
                row[0]
                for row in db.execute(
                    "SELECT id FROM reframe_export_batches WHERE project_id=? "
                    "ORDER BY created_at DESC",
                    (project_id,),
                )
            ]
        return [self.get(batch_id) for batch_id in ids]

    async def cancel(self, batch_id: str) -> dict[str, Any]:
        result = self.get(batch_id)
        for item in result["items"]:
            if item["status"] in {"queued", "running"} and item["job_id"]:
                await self.jobs.cancel(item["job_id"])
        return self.get(batch_id)

    async def retry(
        self, batch_id: str, directory_grant_id: str, item_ids: list[str]
    ) -> dict[str, Any]:
        if not item_ids or len(item_ids) > 8 or len(item_ids) != len(set(item_ids)):
            raise DomainError("REFRAME_RETRY_NOT_ALLOWED", "重试目标不合法")
        original = self.get(batch_id)
        selected = [
            item
            for item in original["items"]
            if item["reframe_export_batch_item_id"] in set(item_ids)
        ]
        if len(selected) != len(item_ids) or any(
            item["status"] not in {"failed", "cancelled", "interrupted"} for item in selected
        ):
            raise DomainError("REFRAME_RETRY_NOT_ALLOWED", "只能重试失败、取消或中断目标")
        # Reuse the immutable snapshot and ready preview, but always create a fresh batch and jobs.
        return await self.create(
            original["project_id"],
            directory_grant_id,
            [
                {
                    "rendition_reframe_snapshot_id": item["rendition_reframe_snapshot"][
                        "rendition_reframe_snapshot_id"
                    ],
                    "preview_artifact_id": item["preview_artifact_id"],
                    "encoder_mode": self._retry_encoder_mode(item["preview_artifact_id"]),
                }
                for item in selected
            ],
            retry_of_batch_id=batch_id,
            retry_of_item_ids=[item["reframe_export_batch_item_id"] for item in selected],
        )

    def _retry_encoder_mode(self, preview_artifact_id: str) -> str:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT toolchain_json FROM render_artifacts WHERE artifact_id=?",
                (preview_artifact_id,),
            ).fetchone()
        if row is None:
            raise DomainError("REFRAME_PREVIEW_REQUIRED", "权威预览不存在")
        try:
            encoder = json.loads(row["toolchain_json"])["encoder"]
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise DomainError("REFRAME_PREVIEW_STALE", "权威预览工具链不合法") from exc
        return "software" if encoder in {"libopenh264", "libx264"} else "auto"

    @staticmethod
    def _item_status(status: str | None) -> str:
        return "running" if status == "cancelling" else status or "interrupted"

    @classmethod
    def _batch_status(cls, states: list[str]) -> str:
        if states and all(state == "queued" for state in states):
            return "queued"
        if any(state in {"queued", "running"} for state in states):
            return "running"
        if states and all(state == "succeeded" for state in states):
            return "succeeded"
        if any(state == "succeeded" for state in states):
            return "partial"
        if states and all(state == "cancelled" for state in states):
            return "cancelled"
        if "interrupted" in states:
            return "interrupted"
        return "failed"
