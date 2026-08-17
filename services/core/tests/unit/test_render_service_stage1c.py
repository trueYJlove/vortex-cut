from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps, sha256_file
from aivs_core.projects import DomainError
from aivs_core.rendering.service import (
    DestinationGrantStore,
    RenderCoordinator,
    RenderService,
    _page,
)


def test_destination_grant_is_safe_explicit_and_single_use(tmp_path: Path) -> None:
    store = DestinationGrantStore()
    target = tmp_path / "中文结果.mp4"
    grant = store.create(str(target), False)
    assert set(grant) == {
        "destination_grant_id",
        "display_name",
        "extension",
        "overwrite_authorized",
        "expires_at",
    }
    assert str(tmp_path) not in str(grant)
    store.claim(grant["destination_grant_id"], "job1")
    assert store.resolve(grant["destination_grant_id"], "job1")["path"] == target
    with pytest.raises(DomainError) as reused:
        store.claim(grant["destination_grant_id"], "job2")
    assert reused.value.code == "EXPORT_DESTINATION_EXPIRED"
    target.write_bytes(b"old")
    with pytest.raises(DomainError) as exists:
        store.create(str(target), False)
    assert exists.value.code == "EXPORT_DESTINATION_EXISTS"
    assert store.create(str(target), True)["overwrite_authorized"] is True
    with pytest.raises(DomainError):
        store.create(str(tmp_path / "bad.mov"), False)


def test_destination_grant_expiry_release_and_invalid_claim(tmp_path: Path) -> None:
    store = DestinationGrantStore()
    grant = store.create(str(tmp_path / "result.mp4"), False)
    grant_id = grant["destination_grant_id"]
    store.claim(grant_id, "job1")
    store.release(grant_id, "other-job")
    with pytest.raises(DomainError) as wrong_job:
        store.resolve(grant_id, "other-job")
    assert wrong_job.value.code == "EXPORT_DESTINATION_EXPIRED"
    store.release(grant_id, "job1")
    store.claim(grant_id, "job2")
    assert store.resolve(grant_id, "job2")["claimed_by"] == "job2"

    expired = store.create(str(tmp_path / "expired.mp4"), False)
    expired_id = expired["destination_grant_id"]
    store._grants[expired_id]["expires_at"] = "2000-01-01T00:00:00.000Z"
    with pytest.raises(DomainError) as expiry:
        store.inspect(expired_id)
    assert expiry.value.code == "EXPORT_DESTINATION_EXPIRED"
    assert expired_id not in store._grants


class _Unused:
    pass


def test_render_and_export_dtos_redact_private_fields_and_stale(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    artifact_path = tmp_path / "preview.mp4"
    artifact_path.write_bytes(b"artifact")
    media = {
        "duration_us": 1_000_000,
        "format_name": "mp4",
        "video": {
            "codec": "h264",
            "width": 540,
            "height": 960,
            "pixel_format": "yuv420p",
            "fps_num": 30,
            "fps_den": 1,
        },
        "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2},
    }
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','r2','root','root','now','now','now')"
        )
        for revision in ("r1", "r2"):
            db.execute(
                "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
                (revision, "p1", None, 1, "{}", "sha256:x", "s", "user", "now"),
            )
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_used,fallback_reason,attempt,created_at,updated_at) VALUES "
            "('j1','p1','authoritative_preview','authoritative_preview','succeeded',"
            "'completed',1,'{}','libopenh264',NULL,1,'now','now')"
        )
        db.execute(
            "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
            (
                "a1",
                "j1",
                "authoritative_preview",
                str(artifact_path),
                artifact_path.stat().st_size,
                sha256_file(artifact_path),
                json_dumps(media),
                "now",
            ),
        )
        db.execute(
            "INSERT INTO render_artifacts(artifact_id,project_id,timeline_revision_id,kind,"
            "render_plan_json,content_fingerprint,profile_id,toolchain_json,rendition_snapshot_id,"
            "created_at) VALUES "
            "('a1','p1','r1','authoritative_preview','{}','sha256:content',"
            "'preview-portrait-v1','{}',NULL,'now')"
        )
        db.execute(
            "INSERT INTO export_records(id,project_id,timeline_revision_id,artifact_id,profile_id,"
            "destination_uri,destination_display_name,export_batch_item_id,created_at) VALUES "
            "('e1','p1','r1','a1','export-portrait-v1',?,'结果.mp4',NULL,'now')",
            (artifact_path.as_uri(),),
        )
    service = RenderService(  # type: ignore[arg-type]
        database,
        Path("ffmpeg"),
        _Unused(),
        _Unused(),
        _Unused(),
        _Unused(),
    )
    assert service.current_preview("p1") is None
    artifact = service.artifact_dto("a1")
    assert artifact["status"] == "stale"
    assert artifact["display_name"] == "preview.mp4"
    assert not {"path", "uri", "render_plan_json", "toolchain_json"} & set(artifact)
    exported = service.export_dto("e1")
    assert exported["status"] == "succeeded"
    assert "destination_uri" not in exported
    with database.connection() as db:
        db.execute("UPDATE projects SET current_timeline_revision_id='r1' WHERE id='p1'")
    assert service.current_preview("p1") == service.artifact_dto("a1")
    assert service.resolve_artifact("a1")["path"] == str(artifact_path.resolve())
    artifact_path.unlink()
    assert service.export_dto("e1")["status"] == "missing"
    with pytest.raises(DomainError) as missing:
        service.resolve_artifact("a1")
    assert missing.value.code == "ARTIFACT_NOT_FOUND"
    with pytest.raises(DomainError) as missing_artifact:
        service.artifact_dto("missing")
    assert missing_artifact.value.code == "ARTIFACT_NOT_FOUND"
    with pytest.raises(DomainError) as missing_export:
        service.export_dto("missing")
    assert missing_export.value.code == "EXPORT_NOT_FOUND"


@pytest.mark.parametrize("limit,cursor", [(0, None), (101, None), (10, "-1"), (10, "x")])
def test_render_page_rejects_invalid_values(limit: int, cursor: str | None) -> None:
    with pytest.raises(DomainError) as invalid:
        _page(limit, cursor)
    assert invalid.value.code == "RENDER_PLAN_INVALID"


def test_cleanup_orphans_only_removes_failed_export_temporary_files(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    destination = tmp_path / "result.mp4"
    failed_temp = tmp_path / ".result.failed-job.aivs-tmp.mp4"
    succeeded_temp = tmp_path / ".result.succeeded-job.aivs-tmp.mp4"
    unrelated = tmp_path / ".result.unknown-job.aivs-tmp.mp4"
    for path in (failed_temp, succeeded_temp, unrelated):
        path.write_bytes(b"temporary")
    failed_work = tmp_path / "jobs" / "failed-job" / "work"
    failed_work.mkdir(parents=True)
    (failed_work / "partial.bin").write_bytes(b"partial")
    with database.connection() as db:
        for job_id, status in (("failed-job", "interrupted"), ("succeeded-job", "succeeded")):
            db.execute(
                "INSERT INTO jobs(id,kind,type,status,progress,input_json,created_at,updated_at) "
                "VALUES (?, 'final_export', 'final_export', ?, 0, ?, 'now', 'now')",
                (job_id, status, json_dumps({"destination_path": str(destination)})),
            )

    coordinator = object.__new__(RenderCoordinator)
    coordinator.database = database
    coordinator.data_dir = tmp_path
    coordinator.cleanup_orphans()

    assert not failed_temp.exists()
    assert not failed_work.exists()
    assert succeeded_temp.exists()
    assert unrelated.exists()


def test_locked_orphan_cleanup_is_retried_without_failing_startup(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    path = tmp_path / ".locked.job.aivs-tmp.mp4"
    path.write_bytes(b"locked")
    attempts = 0

    def locked_unlink(self: Path, missing_ok: bool = False) -> None:
        nonlocal attempts
        assert self == path
        assert missing_ok is True
        attempts += 1
        raise PermissionError(32, "locked", str(self))

    monkeypatch.setattr(Path, "unlink", locked_unlink)
    monkeypatch.setattr("aivs_core.rendering.service.time.sleep", lambda _: None)

    RenderCoordinator._unlink_orphan(path, "job")

    assert attempts == 4
    assert "Deferred locked render cleanup" in caplog.text
