from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..background_work import BackgroundExecutor
from ..media.ffprobe import FFprobe
from ..projects import DomainError
from .ffmpeg import decode_validate

MAX_DURATION_ERROR_US = 83_334

# C22 渲染产物校验细分阶段（计划 C22-6/7）：probe → 完整 decode → 哈希。
# 编码/发布由 service.run 的既有 stage 语义承接，这里只上报校验三段。
ValidationPhase = str  # "validating_probe" | "validating_decode" | "hashing"


async def validate_rendered_media(
    ffmpeg: Path,
    ffprobe: FFprobe,
    path: Path,
    profile: dict[str, Any],
    expected_duration_us: int,
    *,
    cancel_event: asyncio.Event | None = None,
    on_phase: Callable[[ValidationPhase, float | None], None] | None = None,
) -> tuple[dict[str, Any], int, str]:
    """渲染产物校验：编码规格 → 时长 → 完整 decode → SHA-256。

    C22 增量（不改变校验语义，保留全部环节——非抽帧冒充完整性验证）：
    - cancel_event：probe/decode/哈希各阶段可取消；哈希为合作式（A05
      线程在分块边界观察令牌），decode 为进程树终止。
    - on_phase(phase, progress)：细分阶段回调；解码进度按 out_time_us
      映射，哈希进度按已读字节映射，probe 无进度（None = 不定）。
    - 哈希走 A05 受限线程池（不阻塞事件循环），分块边界检查取消令牌。
    """
    if not path.is_file() or path.stat().st_size <= 0:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物不存在或为空")

    def _cancelled() -> bool:
        return cancel_event is not None and cancel_event.is_set()

    if on_phase is not None:
        on_phase("validating_probe", None)
    try:
        probe = await ffprobe.probe(path)
    except RuntimeError as exc:
        raise DomainError("RENDER_VALIDATION_FAILED", "FFprobe 产物校验失败") from exc
    if _cancelled():
        raise RuntimeError("JOB_CANCELLED")
    videos = probe.get("video_streams") or []
    audios = probe.get("audio_streams") or []
    if len(videos) != 1 or not audios:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物音视频流数量不合法")
    video = videos[0]
    audio = audios[0]
    if (
        video.get("codec") != "h264"
        or video.get("width") != profile["width"]
        or video.get("height") != profile["height"]
        or video.get("pixel_format") != "yuv420p"
        or video.get("avg_frame_rate_num") != 30
        or video.get("avg_frame_rate_den") != 1
        or audio.get("codec") != "aac"
        or audio.get("sample_rate") != 48000
    ):
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物编码规格不符合 Profile")
    duration_us = int(probe.get("duration_us") or 0)
    if abs(duration_us - expected_duration_us) > MAX_DURATION_ERROR_US:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物时长超出允许误差")

    if on_phase is not None:
        on_phase("validating_decode", 0.0)
    await decode_validate(
        ffmpeg,
        path,
        cancel_event=cancel_event,
        on_progress=(lambda value: on_phase("validating_decode", value))
        if on_phase is not None
        else None,
        media_duration_us=duration_us,
    )
    if _cancelled():
        # decode_validate 已在取消时抛 JOB_CANCELLED；此检查防御 fake 注入路径。
        raise RuntimeError("JOB_CANCELLED")

    if on_phase is not None:
        on_phase("hashing", 0.0)
    digest = await _hash_cancellable(path, cancel_event, on_phase)
    media_info = {
        "duration_us": duration_us,
        "format_name": str(probe.get("format_name") or ""),
        "video": {
            "codec": str(video["codec"]),
            "width": int(video["width"]),
            "height": int(video["height"]),
            "pixel_format": str(video["pixel_format"]),
            "fps_num": int(video["avg_frame_rate_num"]),
            "fps_den": int(video["avg_frame_rate_den"]),
        },
        "audio": {
            "codec": str(audio["codec"]),
            "sample_rate": int(audio["sample_rate"]),
            "channels": int(audio["channels"]),
        },
    }
    return media_info, path.stat().st_size, digest


async def _hash_cancellable(
    path: Path,
    cancel_event: asyncio.Event | None,
    on_phase: Callable[[ValidationPhase, float | None], None] | None,
) -> str:
    """A05 线程池内分块 SHA-256；分块边界检查取消令牌（合作式——已进入
    的 read 系统调用不可中断，诚实口径与 background_work 一致）。哈希前
    后比对 stat：变化即产物被外部改动 → 校验失败（不能发布无主哈希）。"""
    import hashlib

    before_stat = path.stat()
    total = max(before_stat.st_size, 1)
    cancelled = threading.Event()
    if cancel_event is not None:
        cancel_event_wait_task = asyncio.ensure_future(_watch_cancel(cancel_event, cancelled))

    def _work() -> str:
        digest = hashlib.sha256()
        read_total = 0
        with path.open("rb") as source:
            while True:
                if cancelled.is_set():
                    raise asyncio.CancelledError()
                chunk = source.read(4 * 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                read_total += len(chunk)
                if on_phase is not None:
                    on_phase("hashing", min(read_total / total, 0.99))
        after_stat = path.stat()
        if (after_stat.st_size, after_stat.st_mtime_ns) != (
            before_stat.st_size,
            before_stat.st_mtime_ns,
        ):
            raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物在校验期间被修改")
        return f"sha256:{digest.hexdigest()}"

    try:
        return await BackgroundExecutor.instance().run(_work)
    finally:
        cancelled.set()  # 等待方已完成/取消：线程在下一分块边界退出，不悬挂
        if cancel_event is not None:
            cancel_event_wait_task.cancel()


async def _watch_cancel(cancel_event: asyncio.Event, cancelled: threading.Event) -> None:
    await cancel_event.wait()
    cancelled.set()
