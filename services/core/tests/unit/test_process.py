import asyncio
from pathlib import Path

import pytest

from aivs_core.media import process


class FakeProcess:
    returncode = 0

    async def communicate(self):
        return b"out", b"err"

    async def wait(self):
        return self.returncode


@pytest.mark.asyncio
async def test_run_process_uses_exec_and_decodes_output(monkeypatch):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess()

    monkeypatch.setattr(process.asyncio, "create_subprocess_exec", fake_exec)
    result = await process.run_process(Path("tool.exe"), ["-v"], 1)
    assert result.returncode == 0
    assert result.stdout == "out"
    assert calls[0][0] == ("tool.exe", "-v")
    assert calls[0][1]["stdin"] is asyncio.subprocess.DEVNULL


@pytest.mark.asyncio
async def test_run_process_timeout_kills_process(monkeypatch):
    class HangingProcess(FakeProcess):
        async def communicate(self):
            await asyncio.sleep(1)

        def kill(self):
            self.returncode = -9

    process_instance = HangingProcess()

    async def fake_exec(*args, **kwargs):
        return process_instance

    monkeypatch.setattr(process.asyncio, "create_subprocess_exec", fake_exec)
    with pytest.raises(TimeoutError):
        await process.run_process(Path("tool.exe"), [], 0.001)
    assert process_instance.returncode == -9
