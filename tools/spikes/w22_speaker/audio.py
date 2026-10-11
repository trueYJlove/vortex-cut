"""音频解码（spike 用）：走仓库自带 ffmpeg，输出 16k 单声道 float32。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"


def decode_mono16k(
    path: str | Path,
    start_s: float | None = None,
    duration_s: float | None = None,
    channel: int | None = None,
) -> np.ndarray:
    """解成 16k 单声道。

    `channel=None` 时用 `-ac 1`（下混）。**多通道阵列素材不要用下混**——
    环形阵列各通道有相位差，下混会梳状干涉；此时传 `channel=N` 取单通道
    （`pan=mono|c0=cN`）。
    """
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error"]
    if start_s is not None:
        cmd += ["-ss", f"{start_s:.6f}"]
    cmd += ["-i", str(path)]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s:.6f}"]
    if channel is None:
        cmd += ["-vn", "-ac", "1"]
    else:
        cmd += ["-vn", "-af", f"pan=mono|c0=c{channel}"]
    cmd += ["-ar", "16000", "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)
