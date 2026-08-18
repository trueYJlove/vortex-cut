from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database
from aivs_core.media_generation import MediaGenerationService
from aivs_core.projects import DomainError

PROMPT_SENTINEL = "PROMPT_SENTINEL_4A"
SECRET_SENTINEL = "SECRET_SENTINEL_4A"


def _service(tmp_path: Path) -> tuple[Database, MediaGenerationService]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project_1", "P", "active", "{}", None, "root", "root", "now", "now", "now"),
        )
    return database, MediaGenerationService(database)


def _image(service: MediaGenerationService) -> dict[str, Any]:
    return service.prepare(
        "project_1",
        "image",
        PROMPT_SENTINEL,
        ["asset_b", "asset_a"],
        {"width": 1024, "height": 1024, "style_preset_id": "clean", "seed": 7},
    )


def _create(service: MediaGenerationService) -> dict[str, Any]:
    prepared = _image(service)
    return service.create(
        "project_1",
        "image",
        PROMPT_SENTINEL,
        ["asset_b", "asset_a"],
        {"width": 1024, "height": 1024, "style_preset_id": "clean", "seed": 7},
        prepared["request_sha256"],
    )


def test_prepare_canonicalizes_image_and_tts_without_echoing_prompt(tmp_path: Path) -> None:
    _, service = _service(tmp_path)
    image = _image(service)
    tts = service.prepare(
        "project_1",
        "tts",
        "speak safely",
        ["text_1"],
        {"voice_preset_id": "voice_1", "language": "zh-CN", "speed_milli": 1000},
    )
    assert image["input_refs"] == ["asset_a", "asset_b"]
    assert image["prompt_sha256"].startswith("sha256:")
    assert image["request_sha256"].startswith("sha256:")
    assert tts["generation_kind"] == "tts"
    assert PROMPT_SENTINEL not in str(image)


@pytest.mark.parametrize(
    ("kind", "parameters", "code"),
    [
        ("video", {"width": 512, "height": 512}, "GENERATION_KIND_UNSUPPORTED"),
        ("image", {"width": 63, "height": 512}, "GENERATION_REQUEST_INVALID"),
        ("image", {"width": 512, "height": 512, "path": "x"}, "GENERATION_REQUEST_INVALID"),
        (
            "tts",
            {"voice_preset_id": "v", "language": "fr-FR", "speed_milli": 1000},
            "GENERATION_REQUEST_INVALID",
        ),
    ],
)
def test_prepare_rejects_unsupported_or_invalid_inputs(
    tmp_path: Path, kind: str, parameters: dict[str, object], code: str
) -> None:
    _, service = _service(tmp_path)
    with pytest.raises(DomainError) as caught:
        service.prepare("project_1", kind, "safe", ["ref"], parameters)
    assert caught.value.code == code


def test_create_is_idempotent_and_atomically_creates_safe_task_job(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    first = _create(service)
    second = _create(service)
    assert first["request"] == second["request"]
    assert first["task"] == second["task"]
    assert first["reused"] is False
    assert second["reused"] is True
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM media_generation_requests").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM media_generation_tasks").fetchone()[0] == 1
        job_input = db.execute("SELECT input_json FROM jobs").fetchone()[0]
        dump = "\n".join(db.iterdump())
    assert set(service.get(first["request"]["request_id"])) >= {"prompt_sha256", "request_sha256"}
    assert PROMPT_SENTINEL not in job_input
    assert PROMPT_SENTINEL not in dump
    assert SECRET_SENTINEL not in dump
    assert str(tmp_path.resolve()) not in dump


def test_create_rejects_hash_mismatch_and_sensitive_nested_input(tmp_path: Path) -> None:
    _, service = _service(tmp_path)
    with pytest.raises(DomainError) as mismatch:
        service.create(
            "project_1",
            "image",
            "safe",
            ["ref"],
            {"width": 512, "height": 512},
            "sha256:" + "0" * 64,
        )
    assert mismatch.value.code == "GENERATION_HASH_MISMATCH"
    with pytest.raises(DomainError) as sensitive:
        service.prepare(
            "project_1",
            "image",
            "safe",
            ["ref"],
            {"width": 512, "height": 512, "metadata": {"secret": SECRET_SENTINEL}},
        )
    assert sensitive.value.code == "GENERATION_REQUEST_INVALID"


def test_queued_cancel_and_retry_create_new_lineage(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    created = _create(service)
    task = created["task"]
    cancelled = service.cancel(task["task_id"])
    assert cancelled["status"] == "cancelled"
    retry = service.retry(task["task_id"])
    assert retry["attempt"] == 2
    assert retry["retry_of_task_id"] == task["task_id"]
    assert retry["job_id"] != task["job_id"]
    with pytest.raises(DomainError) as duplicate:
        service.retry(task["task_id"])
    assert duplicate.value.code == "GENERATION_RETRY_NOT_ALLOWED"
    with pytest.raises(DomainError) as non_terminal:
        service.retry(retry["task_id"])
    assert non_terminal.value.code == "GENERATION_RETRY_NOT_ALLOWED"
    with database.connection() as db:
        statuses = {
            row["id"]: row["status"]
            for row in db.execute("SELECT id,status FROM jobs ORDER BY created_at")
        }
    assert statuses[task["job_id"]] == "cancelled"
    assert statuses[retry["job_id"]] == "queued"


def test_running_cancel_rejected_and_success_is_atomic(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    service.start_job(task["job_id"])
    with pytest.raises(DomainError) as caught:
        service.cancel(task["task_id"])
    assert caught.value.code == "JOB_INVALID_STATE"
    result = asyncio.run(service.run_simulation(None, asyncio.Event(), None, None))
    assert result["provider_call_count"] == 0
    service.finish_job(task["job_id"], "succeeded", result)
    with database.connection() as db:
        job = db.execute(
            "SELECT status,stage,result_json FROM jobs WHERE id=?", (task["job_id"],)
        ).fetchone()
        domain_task = db.execute(
            "SELECT status,stage,result_summary_json FROM media_generation_tasks WHERE id=?",
            (task["task_id"],),
        ).fetchone()
    assert tuple(job[:2]) == ("succeeded", "completed")
    assert tuple(domain_task[:2]) == ("succeeded", "completed")
    assert '"provider_call_count":0' in job[2]
    assert job[2] == domain_task[2]


def test_recovery_interrupts_both_records_without_replay(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    service.start_job(task["job_id"])
    assert service.recover_interrupted_tasks() == 1
    assert service.recover_interrupted_tasks() == 0
    recovered = service.list_tasks(task["request_id"])[0]
    assert recovered["status"] == "interrupted"
    assert recovered["error"]["code"] == "GENERATION_INTERRUPTED"
    with database.connection() as db:
        job = db.execute(
            "SELECT status,error_code FROM jobs WHERE id=?", (task["job_id"],)
        ).fetchone()
        queued = db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0]
    assert tuple(job) == ("interrupted", "GENERATION_INTERRUPTED")
    assert queued == 0


def test_finish_rolls_back_when_task_job_pair_is_inconsistent(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    service.start_job(task["job_id"])
    with database.connection() as db:
        db.execute(
            "UPDATE media_generation_tasks SET status='failed' WHERE id=?", (task["task_id"],)
        )
    with pytest.raises(RuntimeError, match="GENERATION_OUTPUT_INVALID"):
        service.finish_job(task["job_id"], "succeeded", {"provider_call_count": 0})
    with database.connection() as db:
        assert (
            db.execute("SELECT status FROM jobs WHERE id=?", (task["job_id"],)).fetchone()[0]
            == "running"
        )


@pytest.mark.parametrize(
    ("task_status", "job_status"),
    [("queued", "running"), ("running", "queued"), ("running", "cancelling")],
)
def test_recovery_converges_unfinished_task_job_drift(
    tmp_path: Path, task_status: str, job_status: str
) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    with database.connection() as db:
        db.execute(
            "UPDATE media_generation_tasks SET status=?,stage=? WHERE id=?",
            (task_status, task_status, task["task_id"]),
        )
        db.execute(
            "UPDATE jobs SET status=?,stage=? WHERE id=?",
            (job_status, job_status, task["job_id"]),
        )
    assert service.recover_interrupted_tasks() == 1
    with database.connection() as db:
        domain_task = db.execute(
            "SELECT status,error_code FROM media_generation_tasks WHERE id=?",
            (task["task_id"],),
        ).fetchone()
        job = db.execute(
            "SELECT status,error_code FROM jobs WHERE id=?", (task["job_id"],)
        ).fetchone()
    assert tuple(domain_task) == ("interrupted", "GENERATION_INTERRUPTED")
    assert tuple(job) == ("interrupted", "GENERATION_INTERRUPTED")


def test_recovery_rolls_back_both_records_when_pair_update_fails(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    service.start_job(task["job_id"])
    with database.connection() as db:
        db.execute(
            "CREATE TRIGGER reject_generation_task_recovery BEFORE UPDATE OF status "
            "ON media_generation_tasks "
            "BEGIN SELECT RAISE(ABORT,'recovery rejected'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="recovery rejected"):
        service.recover_interrupted_tasks()
    with database.connection() as db:
        domain_status = db.execute(
            "SELECT status FROM media_generation_tasks WHERE id=?", (task["task_id"],)
        ).fetchone()[0]
        job_status = db.execute("SELECT status FROM jobs WHERE id=?", (task["job_id"],)).fetchone()[
            0
        ]
    assert (domain_status, job_status) == ("running", "running")


def test_recovery_fails_closed_for_terminal_active_pair_drift(tmp_path: Path) -> None:
    database, service = _service(tmp_path)
    task = _create(service)["task"]
    with database.connection() as db:
        db.execute(
            "UPDATE media_generation_tasks SET "
            "status='succeeded',stage='completed',finished_at='now' WHERE id=?",
            (task["task_id"],),
        )
        db.execute("UPDATE jobs SET status='running',stage='running' WHERE id=?", (task["job_id"],))
    with pytest.raises(RuntimeError, match="GENERATION_OUTPUT_INVALID"):
        service.recover_interrupted_tasks()
    with database.connection() as db:
        domain_status = db.execute(
            "SELECT status FROM media_generation_tasks WHERE id=?", (task["task_id"],)
        ).fetchone()[0]
        job_status = db.execute("SELECT status FROM jobs WHERE id=?", (task["job_id"],)).fetchone()[
            0
        ]
    assert (domain_status, job_status) == ("succeeded", "running")
