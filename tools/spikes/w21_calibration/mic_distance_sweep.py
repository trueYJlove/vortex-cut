"""W2.1 在真实多设备音频上的边界刻画：通道间距 x 窗长 对置信度的影响。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from aivs_core.media.angle_sync import (  # noqa: E402
    CONFIDENCE_THRESHOLD,
    SAMPLE_RATE,
    _xcorr,
    envelope,
    measure_offset,
)

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"


def decode(ch: str, start_s: float, dur_s: float) -> np.ndarray:
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error",
           "-ss", f"{start_s:.6f}", "-i", str(AUDIO / f"ES2004a.{ch}.wav"),
           "-t", f"{dur_s:.6f}", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                         dtype=np.float32).astype(np.float64)


def coarse_conf(a: np.ndarray, b: np.ndarray) -> float:
    ea, eb = envelope(a), envelope(b)
    corr, _zero = _xcorr(ea, eb)
    peak = int(np.argmax(np.abs(corr)))
    denom = float(np.linalg.norm(ea) * np.linalg.norm(eb))
    return float(abs(corr[peak]) / denom) if denom > 0 else 0.0


PAIRS = [
    ("Array1-01", "Array2-01", "different-arrays(far)"),
    ("Array1-01", "Array1-02", "same-array-adjacent(near)"),
    ("Array1-01", "Array1-05", "same-array-opposite(mid)"),
]
BASE = 300.0
rows = []
print(f"CONFIDENCE_THRESHOLD = {CONFIDENCE_THRESHOLD}")
print(f"{'pair':34s} {'win_s':>6s} {'coarse':>8s}  measure_offset")
for ref_ch, mem_ch, label in PAIRS:
    for dur in (60.0, 180.0, 420.0):
        ref = decode(ref_ch, BASE, dur)
        mem = decode(mem_ch, BASE, dur)
        cc = coarse_conf(ref, mem)
        res = measure_offset(ref, mem)
        if res["status"] != "ready":
            detail = f"{res['status']}({res.get('reason') or '-'}) conf={res['confidence']:.3f}"
        else:
            detail = f"ready offset={res['offset_us']}us conf={res['confidence']:.3f}"
        print(f"{label:34s} {dur:6.0f} {cc:8.3f}  {detail}")
        rows.append({"ref": ref_ch, "mem": mem_ch, "label": label, "window_s": dur,
                     "coarse_peak": round(cc, 4), "status": res["status"],
                     "reason": res["reason"], "confidence": round(res["confidence"], 4),
                     "offset_us": res["offset_us"]})
Path(".tmp/w21-sweep.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
