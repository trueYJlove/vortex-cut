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
