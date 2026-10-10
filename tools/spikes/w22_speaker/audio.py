"""音频解码（spike 用）：走仓库自带 ffmpeg，输出 16k 单声道 float32。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"


def decode_mono16k(
    path: str | Path, start_s: float | None = None, duration_s: float | None = None
) -> np.ndarray:
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error"]
    if start_s is not None:
        cmd += ["-ss", f"{start_s:.6f}"]
    cmd += ["-i", str(path)]
    if duration_s is not None:
        cmd += ["-t", f"{duration_s:.6f}"]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    return np.frombuffer(proc.stdout, dtype=np.float32).astype(np.float64)
