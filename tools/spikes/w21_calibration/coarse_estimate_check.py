"""拒答时算法内部的粗估是否正确？（coarse_us 在 unavailable 时也会返回）"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from aivs_core.media.angle_sync import SAMPLE_RATE, measure_offset  # noqa: E402

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"


def decode(ch: str, start_s: float, dur_s: float) -> np.ndarray:
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error",
           "-ss", f"{start_s:.6f}", "-i", str(AUDIO / f"ES2004a.{ch}.wav"),
           "-t", f"{dur_s:.6f}", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                         dtype=np.float32).astype(np.float64)


BASE, DUR = 300.0, 60.0
cases = [
    ("不同阵列 对齐（真值 0）", "Array2-01", "Array1-01", 0.0, 0.0),
    ("不同阵列 成员晚 83ms（真值 -83000）", "Array2-01", "Array1-01", 0.0, 0.083),
    ("不同阵列 成员晚 400ms（真值 -400000）", "Array2-01", "Array1-01", 0.0, 0.400),
    ("同阵列相邻 对齐（真值 0）", "Array1-02", "Array1-01", 0.0, 0.0),
]
for name, ref_ch, mem_ch, ref_off, mem_off in cases:
    ref = decode(ref_ch, BASE + ref_off, DUR)
    mem = decode(mem_ch, BASE + mem_off, DUR)
    r = measure_offset(ref, mem)
    print(json.dumps({"case": name, "status": r["status"], "reason": r["reason"],
                      "coarse_us": r["coarse_us"], "offset_us": r["offset_us"],
                      "confidence": round(r["confidence"], 4),
                      "dual_delta_us": None if r["dual_delta_us"] is None else round(r["dual_delta_us"], 1)},
                     ensure_ascii=False))
