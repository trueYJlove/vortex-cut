from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.projects import DomainError
from aivs_core.rendering.service import DirectoryGrantStore
from aivs_core.renditions.batch import ExportBatchService


class _Snapshots:
    def __init__(self, snapshot: dict[str, object]) -> None:
        self.snapshot = snapshot
        self.presets = type(
            "Presets",
            (),
            {
                "platforms": {"generic": {"filename_tag": "generic"}},
                "renditions": {"portrait-9x16-v1": {"filename_tag": "portrait"}},
            },
        )()

    def get(self, snapshot_id: str) -> dict[str, object]:
        assert snapshot_id == self.snapshot["rendition_snapshot_id"]
        return self.snapshot

    def summary(self, _: str) -> dict[str, object]:
        return {
            "rendition_snapshot_id": self.snapshot["rendition_snapshot_id"],
            "project_id": "project_1",
            "timeline_revision_id": "revision_1",
            "platform_preset_id": "generic",
            "rendition_preset_id": "portrait-9x16-v1",
            "layout_policy": "fit_all",
            "snapshot_sha256": "a" * 64,
            "warnings": [],
            "created_at": "2026-08-15T00:00:00.000Z",
        }


class _Jobs:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create_batch_render_in_transaction(
        self, db, project_id, revision_id, item_id, encoder, input_data
    ):
        job_id = f"job_{item_id}"
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_requested,encoder_used,timeline_revision_id,export_batch_item_id,"
            "resource_class,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
            (
                job_id,
                project_id,
                "final_export",
                "final_export",
                "queued",
                "queued",
                0,
                json.dumps(input_data),
                encoder,
                encoder,
                revision_id,
                item_id,
                "render",
                1,
                "2026-08-15T00:00:00.000Z",
                "2026-08-15T00:00:00.000Z",
            ),
        )
        return {"job_id": job_id}

    def get(self, job_id: str):
        with self.database.connection() as db:
            row = db.execute("SELECT status,updated_at FROM jobs WHERE id=?", (job_id,)).fetchone()
        return {"job_id": job_id, "status": row["status"], "updated_at": row["updated_at"]}


class _Renders:
    async def select_encoder(self, mode: str):
        assert mode == "software"
        return "libopenh264", {"encoder": "libopenh264", "fallback_reason": None}


class _Compiler:
    def compile_rendition(self, *_args):
        return {"content_fingerprint": "sha256:" + "b" * 64}


@pytest.mark.asyncio
async def test_software_batch_uses_concrete_ffmpeg_encoder_before_job_insert(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    snapshot_id = "rendition_snapshot_1"
    snapshot = {
        "rendition_snapshot_id": snapshot_id,
        "project_id": "project_1",
        "timeline_revision_id": "revision_1",
        "timeline_document_sha256": "timeline-hash",
        "platform_preset_id": "generic",
        "rendition_preset_id": "portrait-9x16-v1",
        "preview_profile": {"profile_id": "preview-portrait-9x16-v1"},
    }
    toolchain = {"encoder": "libopenh264", "fallback_reason": None}
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                "project_1",
                "Project",
                "active",
                "{}",
                "revision_1",
                "root",
                "root",
                "now",
                "now",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            (
                "revision_1",
                "project_1",
                None,
                1,
                "{}",
                "timeline-hash",
                "summary",
                "user",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO rendition_snapshots(id,project_id,timeline_revision_id,timeline_document_sha256,"  # noqa: E501
            "platform_preset_id,platform_preset_version,platform_preset_sha256,rendition_preset_id,"
            "rendition_preset_version,rendition_preset_sha256,layout_policy,snapshot_json,snapshot_sha256,"
            "warnings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                snapshot_id,
                "project_1",
                "revision_1",
                "timeline-hash",
                "generic",
                1,
                "p",
                "portrait-9x16-v1",
                1,
                "r",
                "fit_all",
                json.dumps(snapshot),
                "a" * 64,
                "[]",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO jobs(id,type,status,progress,input_json,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",  # noqa: E501
            (
                "preview_job",
                "authoritative_preview",
                "succeeded",
                1,
                "{}",
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
                str(tmp_path / "preview.mp4"),
                1,
                "sha256:" + "c" * 64,
                "{}",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO render_artifacts(artifact_id,project_id,timeline_revision_id,kind,render_plan_json,content_fingerprint,profile_id,toolchain_json,rendition_snapshot_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
            (
                "preview_artifact",
                "project_1",
                "revision_1",
                "authoritative_preview",
                "{}",
                "fp",
                "preview-portrait-9x16-v1",
                json.dumps(toolchain),
                snapshot_id,
                "now",
            ),
        )
    grants = DirectoryGrantStore()
    grant = grants.create(str(tmp_path))
    service = ExportBatchService(
        database, _Snapshots(snapshot), grants, _Jobs(database), _Compiler(), _Renders()
    )
    result = await service.create(
        "project_1",
        "revision_1",
        grant["directory_grant_id"],
        [
            {
                "rendition_snapshot_id": snapshot_id,
                "preview_artifact_id": "preview_artifact",
                "encoder_mode": "software",
            }
        ],
    )
    assert result["batch"]["status"] == "queued"
    with database.connection() as db:
        assert (
            db.execute("SELECT encoder_requested FROM jobs WHERE kind='final_export'").fetchone()[0]
            == "libopenh264"
        )
        db.execute("UPDATE jobs SET status='failed' WHERE kind='final_export'")
    failed = service.get(result["batch"]["export_batch_id"])
    assert failed["status"] == "failed"
    retry_grant = grants.create(str(tmp_path))
    retried = await service.retry(
        failed["export_batch_id"],
        retry_grant["directory_grant_id"],
        [failed["items"][0]["export_batch_item_id"]],
    )
    assert retried["batch"]["export_batch_id"] != failed["export_batch_id"]
    assert retried["batch"]["retry_of_batch_id"] == failed["export_batch_id"]
    assert service.get(failed["export_batch_id"])["status"] == "failed"


def test_directory_grant_rejects_selected_symbolic_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    selected_link = tmp_path / "selected-link"
    selected_link.mkdir()
    original_is_symlink = Path.is_symlink
    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: path == selected_link or original_is_symlink(path),
    )

    with pytest.raises(DomainError, match="导出目录不可用") as error:
        DirectoryGrantStore().create(str(selected_link))

    assert error.value.code == "EXPORT_DIRECTORY_GRANT_INVALID"


def test_directory_grant_rejects_relative_path() -> None:
    with pytest.raises(DomainError, match="导出目录不可用") as error:
        DirectoryGrantStore().create("relative-output")

    assert error.value.code == "EXPORT_DIRECTORY_GRANT_INVALID"
