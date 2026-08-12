from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.jobs import JobService


class FakeProbe:
    async def probe(self, path: Path):
        return {"audio_streams": [], "duration_us": 1_000_000}


class FakeEncoders:
    async def choose(self, mode: str):
        return "libopenh264", None


def make_basic_service(tmp_path: Path) -> tuple[Database, JobService, Path]:
    db = Database(tmp_path / "stage0.db")
    db.initialize()
    source = tmp_path / "input.mp4"
    source.write_bytes(b"input")

    async def emit(_event):
        return None

    service = JobService(db, tmp_path, Path("ffmpeg"), FakeProbe(), FakeEncoders(), emit)
    return db, service, source


async def make_service(tmp_path, monkeypatch, error):
    db = Database(tmp_path / "stage0.db")
    db.initialize()
    source = tmp_path / "input.mp4"
    source.write_bytes(b"input")

    async def emit(_event):
        return None

    service = JobService(db, tmp_path, Path("ffmpeg"), FakeProbe(), FakeEncoders(), emit)
    created = service.create(
        "proxy",
        "media-1",
        {
            "path": str(source),
            "size_bytes": source.stat().st_size,
            "modified_at": source.stat().st_mtime_ns,
        },
        "software",
        duration_us=1_000_000,
    )

    async def fake_render(*_args, **_kwargs):
        with db.connection() as connection:
            connection.execute(
                "UPDATE jobs SET status='cancelling' WHERE id=?", (created["job_id"],)
            )
        raise RuntimeError(error)

    monkeypatch.setattr("aivs_core.jobs.render_media", fake_render)
    await service._run(created["job_id"])
    return service.get(created["job_id"])


@pytest.mark.asyncio
async def test_cancelling_job_cancelled_error_transitions_to_cancelled(tmp_path, monkeypatch):
    job = await make_service(tmp_path, monkeypatch, "JOB_CANCELLED")
    assert job and job["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancelling_job_unexpected_error_transitions_to_interrupted(tmp_path, monkeypatch):
    job = await make_service(tmp_path, monkeypatch, "FFMPEG_FAILED")
    assert job and job["status"] == "interrupted"


def test_job_serialization_hides_input_path(tmp_path):
    db = Database(tmp_path / "stage0.db")
    db.initialize()
    service = JobService(db, tmp_path, Path("ffmpeg"), FakeProbe(), FakeEncoders(), lambda _: None)
    job = service.create(
        "proxy",
        "media-1",
        {"path": "C:/secret/input.mp4", "size_bytes": 1, "modified_at": 1},
        "software",
    )
    detail = service.get(job["job_id"])
    assert detail and "path" not in detail["input"]


def test_candidate_generation_retry_is_rejected_and_restart_interrupts(tmp_path: Path) -> None:
    db, service, _ = make_basic_service(tmp_path)
    now = "2026-08-12T00:00:00.000Z"
    with db.connection() as connection:
        for job_id, status in (
            ("candidate_failed", "failed"),
            ("candidate_running", "running"),
            ("candidate_cancelling", "cancelling"),
        ):
            connection.execute(
                    "INSERT INTO jobs(id,kind,type,status,stage,progress,input_json,resource_class,attempt,created_at,updated_at) "  # noqa: E501
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    "candidate_generation",
                    "candidate_generation",
                    status,
                    status,
                    0,
                    '{"candidate_generation_id":"g1","egress_payload_sha256":"sha256:x"}',
                        "network",
                    1,
                    now,
                    now,
                ),
            )
    with pytest.raises(ValueError, match="CANDIDATE_GENERATION_RECONFIRM_REQUIRED"):
        service.retry("candidate_failed")
    assert db.recover_interrupted() == 2
    for job_id in ("candidate_running", "candidate_cancelling"):
        detail = service.get(job_id)
        assert detail and detail["status"] == "interrupted"


@pytest.mark.asyncio
async def test_job_cancel_paths_and_lifecycle(tmp_path: Path):
    db, service, source = make_basic_service(tmp_path)
    payload = {
        "path": str(source),
        "size_bytes": 5,
        "modified_at": source.stat().st_mtime_ns,
    }
    job = service.create("proxy", "media-1", payload, "software")
    cancelled = await service.cancel(job["job_id"])
    assert cancelled and cancelled["status"] == "cancelled"
    assert await service.cancel("missing") is None

    running = service.create("proxy", "media-2", payload, "software")
    service._transition_job(running["job_id"], "queued", "running")
    cancelling = await service.cancel(running["job_id"])
    assert cancelling and cancelling["status"] == "cancelling"
    assert service.cancel_events[running["job_id"]].is_set()
    again = await service.cancel(running["job_id"])
    assert again and again["status"] == "cancelling"

    await service.start()
    await service.stop()


@pytest.mark.asyncio
async def test_job_stop_recovers_running_and_cancelling_jobs(tmp_path: Path):
    db, service, source = make_basic_service(tmp_path)
    payload = {
        "path": str(source),
        "size_bytes": source.stat().st_size,
        "modified_at": source.stat().st_mtime_ns,
    }
    running = service.create("proxy", "running", payload, "software")
    cancelling = service.create("proxy", "cancelling", payload, "software")
    service._transition_job(running["job_id"], "queued", "running", stage="rendering")
    service._transition_job(cancelling["job_id"], "queued", "running", stage="rendering")
    service._transition_job(cancelling["job_id"], "running", "cancelling")

    await service.stop()

    running_after = service.get(running["job_id"])
    cancelling_after = service.get(cancelling["job_id"])
    assert running_after and running_after["status"] == "interrupted"
    assert running_after["stage"] == "interrupted"
    assert running_after["error"]["code"] == "JOB_INTERRUPTED"
    assert cancelling_after and cancelling_after["status"] == "interrupted"
    assert cancelling_after["stage"] == "interrupted"
    assert cancelling_after["error"]["code"] == "JOB_INTERRUPTED"
    assert db.recover_interrupted() == 0


@pytest.mark.asyncio
async def test_job_run_success_and_input_change(tmp_path: Path, monkeypatch):
    db, service, source = make_basic_service(tmp_path)
    payload = {
        "path": str(source),
        "size_bytes": 5,
        "modified_at": source.stat().st_mtime_ns,
    }
    success = service.create("proxy", "media-1", payload, "software")

    async def fake_render(_ffmpeg, _ffprobe, _args, output, *_rest):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"rendered")
        return {
            "media_info": {"video_streams": [{}], "audio_streams": []},
            "sha256": "hash",
            "size_bytes": 8,
        }

    monkeypatch.setattr("aivs_core.jobs.render_media", fake_render)
    await service._run(success["job_id"])
    detail = service.get(success["job_id"])
    assert detail and detail["status"] == "succeeded" and detail["artifacts"]
    assert (tmp_path / "jobs" / success["job_id"] / "artifacts" / "proxy.mp4").is_file()

    changed = service.create(
        "proxy",
        "media-2",
        {**payload, "size_bytes": 999},
        "software",
    )
    await service._run(changed["job_id"])
    changed_detail = service.get(changed["job_id"])
    assert changed_detail and changed_detail["error"]["code"] == "MEDIA_CHANGED"


@pytest.mark.asyncio
async def test_job_run_internal_error_and_missing_job(tmp_path: Path, monkeypatch):
    _db, service, source = make_basic_service(tmp_path)
    assert await service._run("missing") is None
    payload = {
        "path": str(source),
        "size_bytes": 5,
        "modified_at": source.stat().st_mtime_ns,
    }
    job = service.create("proxy", "media-1", payload, "software")

    async def broken_render(*_args, **_kwargs):
        raise ValueError("unexpected")

    monkeypatch.setattr("aivs_core.jobs.render_media", broken_render)
    await service._run(job["job_id"])
    detail = service.get(job["job_id"])
    assert detail and detail["error"]["code"] == "INTERNAL_ERROR"
