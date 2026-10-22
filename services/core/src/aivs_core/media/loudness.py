"""E8 响度测量：随包 ffmpeg 的 EBU R128 实测（纯本地、零 egress）。

口径（可复算）——`LOUDNESS_ALGORITHM_VERSION` 变更即口径换代：

- 滤镜链 `ebur128=metadata=1:framelog=quiet,ametadata=mode=print:key=lavfi.r128.I:file=-`，
  从 **stdout** 读最后一帧的 `lavfi.r128.I` = 被测区间的 integrated loudness
  （EBU R128 / ITU-R BS.1770-4：400ms 门控块 + -70 LUFS 绝对门限）。
- 直接用 `ebur128` 而非 `loudnorm`：`loudnorm` 是**归一化器**，单遍测量态下
  把 JSON 写在 stderr 与其他日志混流，且对 <400ms / 静音输入同样只给 `-inf`
  （实测 0.2s 440Hz → `input_i=-inf`），换不来额外信息；`ebur128` 的 metadata
  通道是纯测量输出，与 `-v error` 共存不丢数据（实测 3s 单音用例）。
- 不用 `-af loudnorm` 两遍法反推：那会引入「测量 + 归一」耦合，测出来的
  数字不再是源素材事实。

诚实的失败语义（不静默当 0）：
- 素材无音轨 → `no_audio`；
- ffmpeg 非零退出 / 无任何帧输出 → `failed`（带 stderr 末段原因）；
- 结果 <= `MEASURABLE_FLOOR_LUFS` → `unmeasurable`：ebur128 在无门控块超限时
  恒夹到 -70（绝对门限），静音与「太短（<400ms）」在数值上不可分，因此
  一律不当作「实测 -70 LUFS」上报。
"""
from __future__ import annotations

import re
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

LOUDNESS_ALGORITHM_VERSION = "ebu-r128-ebur128-v1"
# EBU R128 绝对门限；ebur128 无门控块超限时把 I 夹到该值。
ABSOLUTE_GATE_LUFS = -70.0
# 留 0.5 LU 余量区分「真的测到极轻」与「夹到门限」。
MEASURABLE_FLOOR_LUFS = -69.5
DEFAULT_TIMEOUT_S = 120.0

_R128_FILTER = (
    "ebur128=metadata=1:framelog=quiet,"
    "ametadata=mode=print:key=lavfi.r128.I:file=-"
)
_R128_LINE = re.compile(r"^lavfi\.r128\.I=(-?\d+(?:\.\d+)?)$", re.MULTILINE)


def measurement_args(
    path: str | Path,
    *,
    start_us: int | None = None,
    end_us: int | None = None,
) -> list[str]:
    """测量用 ffmpeg 参数（白名单式组装，纯函数）。

    区间用**输入侧** seek（`-ss`/`-t` 在 `-i` 之前）：音频帧全部是
    关键帧，输入 seek 对音频即精确，且长素材不必从头解码。
    """
    args = ["-hide_banner", "-nostdin", "-nostats", "-v", "error"]
    if start_us is not None and start_us > 0:
        args += ["-ss", f"{start_us / 1_000_000:.6f}"]
    if start_us is not None and end_us is not None and end_us > start_us:
        args += ["-t", f"{(end_us - start_us) / 1_000_000:.6f}"]
    args += [
        "-i", str(path),
        "-vn",
        "-map", "0:a:0",
        "-af", _R128_FILTER,
        "-f", "null", "-",
    ]
    return args


def parse_integrated_lufs(stdout: str) -> float | None:
    """取最后一帧的 `lavfi.r128.I`（整段积分值）；无输出行返回 None。"""
    matches = _R128_LINE.findall(stdout)
    if not matches:
        return None
    return float(matches[-1])


def _classify(
    *,
    returncode: int,
    stderr: str,
    stdout: str,
    args: list[str],
) -> dict[str, Any]:
    """ffmpeg 结果 → 可复算测量记录（含失败原因，绝不返回 0）。"""
    base: dict[str, Any] = {
        "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
        "args": list(args),
    }
    if returncode != 0:
        if "matches no streams" in stderr:
            return {**base, "status": "no_audio", "integrated_lufs": None,
                    "reason": "MEDIA_NO_AUDIO"}
        tail = " ".join(stderr.strip().splitlines()[-2:])[:300]
        return {**base, "status": "failed", "integrated_lufs": None,
                "reason": "LOUDNESS_FFMPEG_FAILED" + (f": {tail}" if tail else "")}
    value = parse_integrated_lufs(stdout)
    if value is None:
        return {**base, "status": "failed", "integrated_lufs": None,
                "reason": "LOUDNESS_NO_FRAMES"}
    if value <= MEASURABLE_FLOOR_LUFS:
        # 静音 / 短于 400ms 门控块：ebur128 夹在绝对门限，如实标注不可测。
        return {**base, "status": "unmeasurable", "integrated_lufs": None,
                "reason": "LOUDNESS_BELOW_ABSOLUTE_GATE",
                "raw_integrated_lufs": value}
    return {**base, "status": "measured", "integrated_lufs": value, "reason": None}


def measure_range(
    ffmpeg: Path,
    path: str | Path,
    *,
    start_us: int | None = None,
    end_us: int | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> dict[str, Any]:
    """同步测量一个源区间（在调用方线程执行；Core 侧经 to_thread 走线程池）。"""
    args = measurement_args(path, start_us=start_us, end_us=end_us)
    command = [str(ffmpeg), *args]
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "failed",
            "integrated_lufs": None,
            "reason": "LOUDNESS_TIMEOUT",
            "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
            "args": args,
        }
    except FileNotFoundError:
        return {
            "status": "failed",
            "integrated_lufs": None,
            "reason": "FFMPEG_NOT_FOUND",
            "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
            "args": args,
        }
    return _classify(
        returncode=completed.returncode,
        stderr=completed.stderr.decode("utf-8", errors="replace")[-2000:],
        stdout=completed.stdout.decode("utf-8", errors="replace"),
        args=args,
    )


class LoudnessProbe:
    """按片段实测响度：asset_id → 文件路径（注入 ProjectsService.resolve_asset_path）。

    不落库、不缓存：响度测量每次现测（素材或区间改动即新事实）。
    """

    def __init__(
        self,
        ffmpeg: Path,
        resolve_asset_path: Callable[[str], dict[str, Any]],
        *,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.ffmpeg = ffmpeg
        self.resolve_asset_path = resolve_asset_path
        self.timeout = timeout

    def measure_clip(self, clip: dict[str, Any]) -> dict[str, Any]:
        clip_id = str(clip.get("clip_id") or "")
        asset_id = clip.get("asset_id")
        start_us = clip.get("source_start_us")
        end_us = clip.get("source_end_us")
        if not isinstance(asset_id, str) or not asset_id:
            return {
                "clip_id": clip_id,
                "status": "failed",
                "integrated_lufs": None,
                "reason": "CLIP_HAS_NO_ASSET",
                "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
                "args": [],
            }
        try:
            resolved = self.resolve_asset_path(asset_id)
        except Exception as exc:  # DomainError(ASSET_MISSING/ASSET_CHANGED) 等
            code = getattr(exc, "code", type(exc).__name__)
            return {
                "clip_id": clip_id,
                "status": "failed",
                "integrated_lufs": None,
                "reason": f"ASSET_UNRESOLVED: {code}",
                "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
                "args": [],
            }
        path = resolved.get("path") if isinstance(resolved, dict) else None
        if not isinstance(path, str) or not path:
            return {
                "clip_id": clip_id,
                "status": "failed",
                "integrated_lufs": None,
                "reason": "ASSET_UNRESOLVED: no path",
                "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
                "args": [],
            }
        sample = measure_range(
            self.ffmpeg,
            path,
            start_us=int(start_us) if isinstance(start_us, int) else None,
            end_us=int(end_us) if isinstance(end_us, int) else None,
            timeout=self.timeout,
        )
        return {
            "clip_id": clip_id,
            "asset_id": asset_id,
            "source_start_us": start_us,
            "source_end_us": end_us,
            **sample,
        }

    def measure_clips(self, clips: list[dict[str, Any]]) -> dict[str, Any]:
        """{`algorithm_version`, `items`: 每片段一条实测记录}（顺序同入参）。"""
        return {
            "algorithm_version": LOUDNESS_ALGORITHM_VERSION,
            "items": [self.measure_clip(clip) for clip in clips],
        }
