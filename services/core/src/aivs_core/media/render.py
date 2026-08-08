from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Any

from .ffprobe import FFprobe


def vertical_filter() -> str:
    return (
        "split=2[bg][fg];"
        "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
        "boxblur=luma_radius=20:luma_power=2[blur];"
        "[fg]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[fit];"
        "[blur][fit]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p"
    )


def proxy_filter() -> str:
    return "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p"


def build_render_args(input_path: Path, output_path: Path, kind: str, encoder: str,
                      start_us: int = 0, duration_us_value: int = 10_000_000,
                      has_audio: bool = True) -> list[str]:
    args = ["-hide_banner", "-nostdin", "-y"]
    if start_us:
        args += ["-ss", f"{start_us / 1_000_000:.6f}"]
    args += ["-i", str(input_path)]
    args += ["-t", f"{duration_us_value / 1_000_000:.6f}", "-vf",
             vertical_filter() if kind == "vertical_sample" else proxy_filter(),
             "-c:v", encoder, "-preset", "veryfast", "-pix_fmt", "yuv420p",
             "-r", "30", "-movflags", "+faststart"]
    if encoder == "libx264":
        args += ["-crf", "28"]
    if has_audio:
        args += ["-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac",
                 "-ar", "48000", "-b:a", "192k" if kind == "vertical_sample" else "128k"]
    else:
        args += ["-an"]
    args += ["-progress", "pipe:1", "-nostats", str(output_path)]
    return args


async def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


async def render_media(ffmpeg: Path, ffprobe: FFprobe, args: list[str], output: Path,
                       expected_us: int, cancel_event: asyncio.Event,
                       progress: Any) -> dict[str, Any]:
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg), *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
    )

    async def read_progress() -> None:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if line.startswith("out_time_us="):
                try:
                    value = int(line.split("=", 1)[1])
                    progress(min(max(value / expected_us, 0), 0.99) if expected_us else 0.0)
                except ValueError:
                    pass

    progress_task = asyncio.create_task(read_progress())
    stderr_task = asyncio.create_task(process.stderr.read())
    try:
        while process.returncode is None:
            if cancel_event.is_set():
                process.kill()
                await process.wait()
                raise RuntimeError("JOB_CANCELLED")
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
            except TimeoutError:
                pass
        await progress_task
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-32768:]
    finally:
        if not progress_task.done():
            progress_task.cancel()
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise RuntimeError("JOB_CANCELLED")
    if process.returncode != 0:
        raise RuntimeError("FFMPEG_FAILED: " + stderr[-500:])
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("OUTPUT_VALIDATION_FAILED")
    media_info = await ffprobe.probe(output)
    return {"media_info": media_info, "sha256": await sha256_file(output), "size_bytes": output.stat().st_size}
