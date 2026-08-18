from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from test_stage3b_reframe import _item, _setup

from aivs_core.database import Database, json_dumps, sha256_file
from aivs_core.projects import DomainError
from aivs_core.rendering.plan import REFRAME_COMPILER_VERSION, RenderPlanCompiler
from aivs_core.rendering.service import DirectoryGrantStore
from aivs_core.renditions.reframe import RenditionReframeSnapshotService
from aivs_core.renditions.reframe_batch import ReframeExportBatchService


class _Jobs:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create_reframe_batch_render_in_transaction(
        self,
        db: Any,
        project_id: str,
        revision_id: str,
        item_id: str,
        encoder: str,
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        job_id = f"job_{item_id}"
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_requested,encoder_used,timeline_revision_id,reframe_export_batch_item_id,"
            "resource_class,attempt,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                job_id,
                project_id,
                "final_export",
                "final_export",
                "queued",
                "queued",
                0,
                json_dumps(input_data),
                encoder,
                encoder,
                revision_id,
                item_id,
                "render",
                1,
                "2026-08-18T00:00:00.000Z",
                "2026-08-18T00:00:00.000Z",
            ),
        )
        return {"job_id": job_id}

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT status,updated_at,input_json FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        if row is None:
            return None
        safe_input = json.loads(row["input_json"])
        assert "path" not in safe_input and "destination_path" not in safe_input
        return {
            "job_id": job_id,
            "status": row["status"],
            "updated_at": row["updated_at"],
            "input": safe_input,
        }

    async def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self.database.connection() as db:
            db.execute(
                "UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?",
                ("2026-08-18T00:01:00.000Z", job_id),
            )
        return self.get(job_id)


class _Renders:
    toolchain = {
        "compiler_version": REFRAME_COMPILER_VERSION,
        "preset_version": 1,
        "font_bundle_version": 1,
        "ffmpeg_version": "ffmpeg test",
        "encoder": "libopenh264",
        "fallback_reason": None,
    }

    async def select_reframe_encoder(self, mode: str) -> tuple[str, dict[str, Any]]:
        assert mode in {"auto", "software"}
        return "libopenh264", self.toolchain


def _service(tmp_path: Path) -> tuple[ReframeExportBatchService, str, str]:
    database, presets = _setup(tmp_path)
    snapshots = RenditionReframeSnapshotService(database, presets)
    summary = snapshots.create_or_reuse("project_1", "rendition_snapshot_1", [_item()])
    snapshot_id = summary["rendition_reframe_snapshot_id"]
    compiler = RenderPlanCompiler(database)
    plan = compiler.compile_reframe("project_1", "revision_1", snapshot_id, "authoritative_preview")
    preview = tmp_path / "preview.mp4"
    preview.write_bytes(b"stage3b-preview")
    with database.connection() as db:
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_used,timeline_revision_id,attempt,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "preview_job",
                "project_1",
                "authoritative_preview",
                "authoritative_preview",
                "succeeded",
                "completed",
                1,
                "{}",
                "libopenh264",
                "revision_1",
                1,
                "now",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
            (
                "preview_artifact",
                "preview_job",
                "authoritative_preview",
                str(preview),
                preview.stat().st_size,
                sha256_file(preview),
                json_dumps({"duration_us": 2_000_000}),
                "now",
            ),
        )
        db.execute(
            "INSERT INTO render_artifacts(artifact_id,project_id,timeline_revision_id,kind,"
            "render_plan_json,content_fingerprint,profile_id,toolchain_json,"
            "rendition_reframe_snapshot_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "preview_artifact",
                "project_1",
                "revision_1",
                "authoritative_preview",
                json_dumps(plan),
                plan["content_fingerprint"],
                plan["output"]["profile_id"],
                json_dumps(_Renders.toolchain),
                snapshot_id,
                "now",
            ),
        )
    grants = DirectoryGrantStore()
    grant = grants.create(str(tmp_path / "exports"))
    service = ReframeExportBatchService(
        database, snapshots, grants, _Jobs(database), compiler, _Renders()
    )
    return service, snapshot_id, grant["directory_grant_id"]


@pytest.mark.asyncio
async def test_reframe_batch_is_independent_atomic_and_retryable(tmp_path: Path) -> None:
    (tmp_path / "exports").mkdir()
    service, snapshot_id, grant_id = _service(tmp_path)
    created = await service.create(
        "project_1",
        grant_id,
        [
            {
                "rendition_reframe_snapshot_id": snapshot_id,
                "preview_artifact_id": "preview_artifact",
                "encoder_mode": "software",
            }
        ],
    )
    batch = created["batch"]
    assert batch["timeline_revision_id"] == "revision_1"
    assert batch["status"] == "queued"
    assert "-reframe-" in batch["items"][0]["destination_display_name"]
    assert "resolved_adjustments" not in batch["items"][0]["rendition_reframe_snapshot"]
    with service.database.connection() as db:
        job = db.execute(
            "SELECT export_batch_item_id,reframe_export_batch_item_id,input_json FROM jobs "
            "WHERE kind='final_export'"
        ).fetchone()
        assert job["export_batch_item_id"] is None
        assert (
            job["reframe_export_batch_item_id"] == batch["items"][0]["reframe_export_batch_item_id"]
        )
        assert "destination_path" not in job["input_json"]
        db.execute("UPDATE jobs SET status='failed' WHERE kind='final_export'")
    failed = service.get(batch["reframe_export_batch_id"])
    retry_dir = tmp_path / "retry"
    retry_dir.mkdir()
    retry_grant = service.grants.create(str(retry_dir))
    retried = await service.retry(
        failed["reframe_export_batch_id"],
        retry_grant["directory_grant_id"],
        [failed["items"][0]["reframe_export_batch_item_id"]],
    )
    assert retried["batch"]["retry_of_batch_id"] == failed["reframe_export_batch_id"]
    assert retried["batch"]["reframe_export_batch_id"] != failed["reframe_export_batch_id"]
    assert (
        retried["batch"]["items"][0]["retry_of_item_id"]
        == failed["items"][0]["reframe_export_batch_item_id"]
    )


@pytest.mark.asyncio
async def test_reframe_batch_rejects_stale_preview_before_any_write(tmp_path: Path) -> None:
    (tmp_path / "exports").mkdir()
    service, snapshot_id, grant_id = _service(tmp_path)
    with service.database.connection() as db:
        db.execute("UPDATE render_artifacts SET toolchain_json='{}'")
    with pytest.raises(DomainError) as error:
        await service.create(
            "project_1",
            grant_id,
            [
                {
                    "rendition_reframe_snapshot_id": snapshot_id,
                    "preview_artifact_id": "preview_artifact",
                }
            ],
        )
    assert error.value.code == "REFRAME_PREVIEW_STALE"
    with service.database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM reframe_export_batches").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM reframe_export_batch_items").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE kind='final_export'").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_stage3a_preview_cannot_authorize_reframe_batch(tmp_path: Path) -> None:
    (tmp_path / "exports").mkdir()
    service, snapshot_id, grant_id = _service(tmp_path)
    with service.database.connection() as db:
        db.execute(
            "UPDATE render_artifacts SET rendition_reframe_snapshot_id=NULL,"
            "rendition_snapshot_id='rendition_snapshot_1'"
        )
    with pytest.raises(DomainError) as error:
        await service.create(
            "project_1",
            grant_id,
            [
                {
                    "rendition_reframe_snapshot_id": snapshot_id,
                    "preview_artifact_id": "preview_artifact",
                }
            ],
        )
    assert error.value.code == "REFRAME_PREVIEW_REQUIRED"
