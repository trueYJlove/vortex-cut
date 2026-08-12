from __future__ import annotations

from pathlib import Path
from typing import Any

from ..database import sha256_file
from ..media.ffprobe import FFprobe
from ..projects import DomainError
from .ffmpeg import decode_validate

MAX_DURATION_ERROR_US = 83_334


async def validate_rendered_media(
    ffmpeg: Path,
    ffprobe: FFprobe,
    path: Path,
    profile: dict[str, Any],
    expected_duration_us: int,
) -> tuple[dict[str, Any], int, str]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise DomainError("RENDER_VALIDATION_FAILED", "渲染产物不存在或为空")
    try:
        probe = await ffprobe.probe(path)
    except RuntimeError as exc:
        raise DomainError("RENDER_VALIDATION_FAILED", "FFprobe 产物校验失败") from exc
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
    await decode_validate(ffmpeg, path)
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
    return media_info, path.stat().st_size, sha256_file(path)
