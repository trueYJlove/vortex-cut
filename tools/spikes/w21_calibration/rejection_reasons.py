from __future__ import annotations
import subprocess, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from aivs_core.media.angle_sync import (  # noqa: E402
    CONFIDENCE_THRESHOLD, DRIFT_TOLERANCE_US, DUAL_WINDOW_TOLERANCE_US, SAMPLE_RATE, measure_offset,
)

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"
DUR = 30.0
cache: dict = {}


def dec(ch: str, t: float) -> np.ndarray:
    k = (ch, t)
    if k not in cache:
        cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{t:.6f}",
               "-i", str(AUDIO / f"ES2004a.{ch}.wav"), "-t", f"{DUR:.6f}", "-vn",
               "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        cache[k] = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                                 dtype=np.float32).astype(np.float64)
    return cache[k]


print(f"CONF={CONFIDENCE_THRESHOLD} DUAL={DUAL_WINDOW_TOLERANCE_US} DRIFT={DRIFT_TOLERANCE_US}\n")
print(f"{'win':>5s} {'conf':>6s} {'dual_us':>9s} {'drift_us':>10s} {'status':>12s} reason")
for t in (60, 140, 220, 300, 380, 460, 540, 620, 700, 780, 860, 940):
    r = measure_offset(dec("Array1-01", t), dec("Array2-01", t))
    d = r["dual_delta_us"]; dr = r["drift_us"]
    print(f"{t:5d} {r['confidence']:6.3f} {(d if d is not None else -1):9.1f} "
          f"{(dr if dr is not None else float('nan')):10.1f} {r['status']:>12s} {r['reason']}")
