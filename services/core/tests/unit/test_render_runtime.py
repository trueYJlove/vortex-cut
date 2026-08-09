import asyncio
import hashlib
from pathlib import Path

import pytest

from aivs_core.media import render


class FakeStream:
    def __init__(self, lines=()):
        self.lines = lines

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.lines:
            return self.lines.pop(0).encode()
        raise StopAsyncIteration

    async def read(self):
        return b""


class FakeRenderProcess:
    def __init__(self, returncode=0, lines=None):
        self.returncode = returncode
        self.stdout = FakeStream(lines or ["out_time_us=500000\n"])
        self.stderr = FakeStream()

    async def wait(self):
        return self.returncode

    def kill(self):
        self.returncode = -9

    def terminate(self):
        self.returncode = -15


@pytest.mark.asyncio
async def test_sha256_file(tmp_path: Path):
    path = tmp_path / "data.bin"
    path.write_bytes(b"abc")
    assert await render.sha256_file(path) == hashlib.sha256(b"abc").hexdigest()


@pytest.mark.asyncio
async def test_render_media_success_and_progress(monkeypatch, tmp_path: Path):
    output = tmp_path / "out.mp4"
    output.write_bytes(b"rendered")
    process = FakeRenderProcess()

    async def fake_exec(*args, **kwargs):
        return process

    class Probe:
        async def probe(self, path):
            return {"duration_us": 500000, "video_streams": [], "audio_streams": []}

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", fake_exec)
    progress = []
    result = await render.render_media(
        Path("ffmpeg"), Probe(), [], output, 1_000_000, asyncio.Event(), progress.append
    )
    assert result["sha256"] == hashlib.sha256(b"rendered").hexdigest()
    assert progress == [0.5]


@pytest.mark.asyncio
async def test_render_media_cancel_and_failure(monkeypatch, tmp_path: Path):
    process = FakeRenderProcess(returncode=0, lines=[])

    async def fake_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", fake_exec)
    event = asyncio.Event()
    event.set()
    with pytest.raises(RuntimeError, match="JOB_CANCELLED"):
        await render.render_media(
            Path("ffmpeg"), object(), [], tmp_path / "missing.mp4", 1, event, lambda _: None
        )

    failed = FakeRenderProcess(returncode=1, lines=[])

    async def fake_failed(*args, **kwargs):
        return failed

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", fake_failed)
    with pytest.raises(RuntimeError, match="FFMPEG_FAILED"):
        await render.render_media(
            Path("ffmpeg"),
            object(),
            [],
            tmp_path / "missing.mp4",
            1,
            asyncio.Event(),
            lambda _: None,
        )
