from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.jobs import JobService


class _Probe:
    pass


class _Encoders:
    pass


def _service(tmp_path: Path) -> tuple[JobService, Database]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "p", "active", "{}", "r", "r", "n", "n", "n"),
        )
    return JobService(db, tmp_path, Path("ffmpeg"), _Probe(), _Encoders(), lambda _: None), db


def _job(db: Database, job_id: str, status: str) -> None:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (job_id, "p1", "transcription", "transcription", status, status, 0,
             json_dumps({}), "n", "n"),
        )


def _artifact(db: Database, artifact_id: str, job_id: str) -> None:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
            (artifact_id, job_id, "proxy", "C:\\tmp\\x.mp4", 1, "sha256:" + "a" * 64, "{}", "n"),
        )


@pytest.mark.parametrize("status", ["succeeded", "failed", "cancelled", "interrupted"])
def test_delete_finished_removes_terminal_job(tmp_path: Path, status: str) -> None:
    service, db = _service(tmp_path)
    _job(db, "j1", status)
    service.delete_finished("j1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("status", ["queued", "running", "cancelling"])
def test_delete_refuses_active_job(tmp_path: Path, status: str) -> None:
    """运行中/排队中拒绝删除——必须先取消，避免与调度租约竞争。"""
    service, db = _service(tmp_path)
    _job(db, "j1", status)
    with pytest.raises(ValueError, match="JOB_INVALID_STATE"):
        service.delete_finished("j1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_delete_removes_job_artifacts_too(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    _job(db, "j1", "succeeded")
    _artifact(db, "art1", "j1")
    service.delete_finished("j1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 0


def test_delete_unknown_job_reports_not_found(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    with pytest.raises(ValueError, match="JOB_NOT_FOUND"):
        service.delete_finished("missing")


def test_delete_refuses_job_referenced_by_render_artifact(tmp_path: Path) -> None:
    """render_artifacts 引用任务时由外键拒绝，保护渲染历史。"""
    service, db = _service(tmp_path)
    _job(db, "j1", "succeeded")
    _artifact(db, "ra1", "j1")  # render_artifacts.artifact_id 指向 artifacts(id)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,"
            "document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
            ("rev_x", "p1", 1, "{}", "sha256:" + "b" * 64, "", "test", "n"),
        )
        conn.execute(
            "INSERT INTO render_artifacts(artifact_id,project_id,timeline_revision_id,kind,"
            "render_plan_json,content_fingerprint,profile_id,toolchain_json,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            ("ra1", "p1", "rev_x", "authoritative_preview", "{}", "fp", "profile", "{}", "n"),
        )
    with pytest.raises(ValueError, match="JOB_REFERENCED"):
        service.delete_finished("j1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
