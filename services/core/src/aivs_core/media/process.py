from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str


async def run_process(
    executable: Path, args: list[str], timeout: float, *, max_output: int = 10 * 1024 * 1024
) -> ProcessResult:
    process = await asyncio.create_subprocess_exec(
        str(executable), *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    return ProcessResult(
        process.returncode or 0,
        stdout[:max_output].decode("utf-8", errors="replace"),
        stderr[-32768:].decode("utf-8", errors="replace"),
    )


def terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        if os.name == "nt":
            process.kill()
        else:
            process.terminate()
