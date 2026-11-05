from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path
from typing import Any

from ..performance import measured
from .process import run_process


def parse_fraction(value: str | None) -> tuple[int, int]:
    if not value or value in {"0/0", "0:0", "N/A"}:
        return 0, 1
    try:
        fraction = Fraction(value.replace(":", "/"))
        return fraction.numerator, fraction.denominator
    except (ValueError, ZeroDivisionError):
        return 0, 1


def duration_us(value: str | int | float | None) -> int:
    if value is None:
        return 0
    fraction = Fraction(str(value))
    return (fraction.numerator * 1_000_000 + fraction.denominator // 2) // fraction.denominator


def _rotation(stream: dict[str, Any]) -> int:
    """显示矩阵旋转（度，0..359）。

    **必须在整个 side_data_list 里找，不能只看 [0]**（2026-11-03 实测）：
    iPhone 素材的 side_data_list[0] 是 **Dolby Vision configuration record**，
    displaymatrix 排在它后面。旧实现只读 [0] ⇒ 取到 None ⇒ 返回 0 ⇒
    竖拍素材被当成横版（代理按 1920x1080 生成、画面被 scale 拉变形）。
    """
    tags = stream.get("tags") or {}
    raw = tags.get("rotate")
    if raw is None:
        for entry in stream.get("side_data_list") or []:
            if not isinstance(entry, dict):
                continue
            if entry.get("rotation") is not None:
                raw = entry["rotation"]
                break
    try:
        return int(raw or 0) % 360
    except (TypeError, ValueError):
        return 0


def normalize_probe(payload: dict[str, Any], path: Path) -> dict[str, Any]:
    video: list[dict[str, Any]] = []
    audio: list[dict[str, Any]] = []
    for stream in payload.get("streams") or []:
        if stream.get("codec_type") == "video":
            num, den = parse_fraction(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
            sar_num, sar_den = parse_fraction(stream.get("sample_aspect_ratio") or "1/1")
            video.append(
                {
                    "index": stream.get("index", 0),
                    "codec": stream.get("codec_name"),
                    "width": int(stream.get("width") or 0),
                    "height": int(stream.get("height") or 0),
                    "sample_aspect_ratio_num": sar_num,
                    "sample_aspect_ratio_den": sar_den,
                    "avg_frame_rate_num": num,
                    "avg_frame_rate_den": den,
                    "rotation": _rotation(stream),
                    "pixel_format": stream.get("pix_fmt"),
                    # HDR 判定用（P203）：ffprobe 的 color_transfer 是字符串
                    # （"bt709"/"arib-std-b67"/"smpte2084"…）。前端据此在
                    # 「素材是 HDR 且当前环境解不了」时提示用户。
                    "color_transfer": stream.get("color_transfer"),
                    "color_primaries": stream.get("color_primaries"),
                    "color_space": stream.get("color_space"),
                }
            )
        elif stream.get("codec_type") == "audio":
            audio.append(
                {
                    "index": stream.get("index", 0),
                    "codec": stream.get("codec_name"),
                    "sample_rate": int(stream.get("sample_rate") or 0),
                    "channels": int(stream.get("channels") or 0),
                }
            )
    stat = path.stat()
    return {
        "display_name": path.name,
        "format_name": (payload.get("format") or {}).get("format_name"),
        "duration_us": duration_us((payload.get("format") or {}).get("duration")),
        "size_bytes": stat.st_size,
        "video_streams": video,
        "audio_streams": audio,
        "warnings": [],
    }


class FFprobe:
    def __init__(self, executable: Path, timeout: float = 15) -> None:
        self.executable = executable
        self.timeout = timeout

    @measured("probe")
    async def probe(self, path: Path, require_video: bool = True) -> dict[str, Any]:
        try:
            result = await run_process(
                self.executable,
                [
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    str(path),
                ],
                self.timeout,
            )
        except TimeoutError as exc:
            raise RuntimeError("MEDIA_PROBE_TIMEOUT") from exc
        except FileNotFoundError as exc:
            raise RuntimeError("FFMPEG_NOT_FOUND") from exc
        if result.returncode != 0:
            raise RuntimeError("MEDIA_UNSUPPORTED")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("MEDIA_UNSUPPORTED") from exc
        normalized = normalize_probe(payload, path)
        if require_video and not normalized["video_streams"]:
            raise RuntimeError("MEDIA_HAS_NO_VIDEO")
        return normalized
