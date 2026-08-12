from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..media.process import run_process
from ..media.windows_job import WindowsKillJob
from ..projects import DomainError


def build_timeline_args(
    plan: dict[str, Any],
    segment_paths: list[Path],
    segment_probes: list[dict[str, Any]],
    encoder: str,
    output_name: str,
    *,
    captions: bool,
) -> list[str]:
    segments = plan["segments"]
    if len(segments) != len(segment_paths) or len(segments) != len(segment_probes):
        raise DomainError("RENDER_PLAN_INVALID", "渲染输入数量不一致")
    args = ["-hide_banner", "-nostdin", "-y"]
    for segment, path in zip(segments, segment_paths, strict=True):
        if segment["asset_kind"] == "image":
            args += ["-loop", "1", "-framerate", "30"]
        args += ["-i", str(path)]
    width = int(plan["output"]["width"])
    height = int(plan["output"]["height"])
    filters: list[str] = []
    concat_inputs = []
    for index, (segment, probe) in enumerate(
        zip(segments, segment_probes, strict=True)
    ):
        duration_us = segment["timeline_end_us"] - segment["timeline_start_us"]
        duration = _seconds(duration_us)
        if segment["asset_kind"] == "video":
            start = _seconds(segment["source_start_us"])
            end = _seconds(segment["source_end_us"])
            source = f"[{index}:v:0]trim=start={start}:end={end},setpts=PTS-STARTPTS"
        else:
            source = f"[{index}:v:0]trim=duration={duration},setpts=PTS-STARTPTS"
        visual = _visual_filter(segment["layout"], width, height, index)
        filters.append(
            f"{source},{_square_pixel_filter()},{visual},"
            f"setsar=1,fps=30,format=yuv420p[v{index}]"
        )
        has_audio = bool(probe.get("audio_streams"))
        if segment["asset_kind"] == "video" and has_audio and segment["audio_enabled"]:
            start = _seconds(segment["source_start_us"])
            end = _seconds(segment["source_end_us"])
            gain = float(segment["gain_db"])
            filters.append(
                f"[{index}:a:0]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
                "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"volume={gain:.3f}dB,apad,atrim=duration={duration}[a{index}]"
            )
        else:
            filters.append(
                "anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={duration},asetpts=PTS-STARTPTS[a{index}]"
            )
        concat_inputs.append(f"[v{index}][a{index}]")
    filters.append(
        f"{''.join(concat_inputs)}concat=n={len(segments)}:v=1:a=1[vcat][aout]"
    )
    video_label = "vcat"
    if captions:
        filters.append("[vcat]ass=filename=captions.ass:fontsdir=fonts[vout]")
        video_label = "vout"
    args += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        f"[{video_label}]",
        "-map",
        "[aout]",
        "-c:v",
        encoder,
    ]
    if encoder == "libopenh264":
        args += ["-b:v", "3M" if width == 540 else "10M"]
    elif encoder in {"h264_nvenc", "h264_qsv", "h264_amf"}:
        args += ["-b:v", "4M" if width == 540 else "12M"]
    args += [
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-fps_mode",
        "cfr",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        output_name,
    ]
    return args


def _visual_filter(layout: str, width: int, height: int, index: int) -> str:
    if layout == "crop_fill":
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}"
        )
    if layout == "fit":
        return (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:"
            "force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    if layout == "blurred_background":
        return (
            f"split=2[bg{index}][fg{index}];"
            f"[bg{index}]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=20[blur{index}];"
            f"[fg{index}]scale={width}:{height}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2[front{index}];"
            f"[blur{index}][front{index}]overlay=(W-w)/2:(H-h)/2"
        )
    raise DomainError("RENDER_PLAN_INVALID", "不支持的布局")


def _square_pixel_filter() -> str:
    return "scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1"


async def run_timeline_render(
    ffmpeg: Path,
    args: list[str],
    cwd: Path,
    expected_us: int,
    cancel_event: asyncio.Event,
    progress: Callable[[float], None],
    worker_pid: Callable[[int | None], None],
) -> None:
    creationflags = getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0)
    creationflags |= getattr(asyncio.subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = await asyncio.create_subprocess_exec(
        str(ffmpeg),
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=creationflags,
    )
    try:
        kill_job = WindowsKillJob.attach(process.pid)
    except OSError as exc:
        await terminate_process_tree(process)
        raise RuntimeError(f"RENDER_FAILED: unable to isolate FFmpeg: {exc}") from exc
    worker_pid(process.pid)

    async def read_progress() -> None:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if line.startswith("out_time_us="):
                try:
                    value = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                progress(min(max(value / expected_us, 0), 0.99) if expected_us else 0)

    progress_task = asyncio.create_task(read_progress())
    assert process.stderr is not None
    stderr_task = asyncio.create_task(process.stderr.read())
    try:
        while process.returncode is None:
            if cancel_event.is_set():
                await terminate_process_tree(process)
                raise RuntimeError("JOB_CANCELLED")
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
            except TimeoutError:
                pass
        await progress_task
        stderr = (await stderr_task).decode("utf-8", errors="replace")[-32768:]
    finally:
        worker_pid(None)
        if kill_job is not None:
            kill_job.close()
        if not progress_task.done():
            progress_task.cancel()
        if not stderr_task.done():
            stderr_task.cancel()
    if cancel_event.is_set():
        raise RuntimeError("JOB_CANCELLED")
    if process.returncode != 0:
        raise RuntimeError(f"RENDER_FAILED: {stderr[-1000:]}")


async def terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
        )
        await killer.wait()
    else:
        process.kill()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()


async def decode_validate(ffmpeg: Path, path: Path) -> None:
    result = await run_process(
        ffmpeg,
        ["-hide_banner", "-v", "error", "-i", str(path), "-f", "null", "-"],
        120,
    )
    if result.returncode != 0:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物无法完整解码")


def _seconds(value_us: int) -> str:
    return f"{int(value_us) / 1_000_000:.6f}"
