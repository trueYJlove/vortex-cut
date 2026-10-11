"""NLCC 诊断（修正版）。

前一版有**标签错误**：三个标为"同阵列"的对照，实际第二个输入都写成了 Array2-01
（即都是跨阵列）。本版按 (channel_a, channel_b) 显式配对，并复算 measure_offset
实际使用的两个 2s 窗（offset 0 与 1s），核对 min() 是否与返回的 confidence 一致。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from aivs_core.media.angle_sync import SAMPLE_RATE, _xcorr, measure_offset  # noqa: E402

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"


def decode(ch: str, start_s: float, dur_s: float) -> np.ndarray:
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error",
           "-ss", f"{start_s:.6f}", "-i", str(AUDIO / f"ES2004a.{ch}.wav"),
           "-t", f"{dur_s:.6f}", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                         dtype=np.float32).astype(np.float64)


def peak_nlcc(a: np.ndarray, b: np.ndarray) -> float:
    corr, _ = _xcorr(a, b)          # 与 measure_offset 内部同一实现
    return float(abs(corr[int(np.argmax(np.abs(corr)))])) 


BASE, DUR = 300.0, 60.0
PAIRS = [
    ("Array1-01", "Array1-02", "同阵列 相邻（物理近）"),
    ("Array1-01", "Array1-05", "同阵列 对角（物理中）"),
    ("Array1-01", "Array2-01", "**不同阵列**（物理远 ≈ 两机位）"),
    ("Mix-Headset", "Array2-01", "不同设备类型（头戴混合 vs 阵列）"),
]
print(f"窗 {DUR:.0f}s @ {BASE}s；置信度 = min(两窗 NLCC)，2s 窗，off=0 / +1s\n")
print(f"{'配对':36s} {'NLCC@0s':>8s} {'NLCC@1s':>8s} {'min':>7s} | measure_offset")
out = {}
for ca, cb, label in PAIRS:
    a = decode(ca, BASE, DUR)
    b = decode(cb, BASE, DUR)
    w = int(2.0 * SAMPLE_RATE)
    n0 = peak_nlcc(a[:w], b[:w])
    n1 = peak_nlcc(a[w:2 * w], b[w:2 * w])
    r = measure_offset(a, b)
    print(f"{label:36s} {n0:8.3f} {n1:8.3f} {min(n0,n1):7.3f} | {r['status']}({r.get('reason') or '-'}) conf={r['confidence']:.3f}")
    out[label] = {"a": ca, "b": cb, "nlcc_off0": round(n0, 4), "nlcc_off1": round(n1, 4),
                  "min": round(min(n0, n1), 4), "status": r["status"],
                  "confidence": round(r["confidence"], 4), "offset_us": r["offset_us"],
                  "coarse_us": r["coarse_us"]}

# 负向对照：不同会议（内容无关）
import itertools
print("\n--- 负向对照：跨会议（内容无关）---")
for m1, m2 in itertools.combinations(["ES2004a", "IS1009a", "IS1009c", "EN2002b"], 2):
    a = decode_mix = None
    def dec(m, ch):
        cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{BASE:.6f}",
               "-i", str(AUDIO / f"{m}.{ch}.wav" if ch != "Mix-Headset" else AUDIO / f"{m}.Mix-Headset.wav"),
               "-t", f"{DUR:.6f}", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                             dtype=np.float32).astype(np.float64)
    x, y = dec(m1, "Mix-Headset"), dec(m2, "Mix-Headset")
    w = int(2.0 * SAMPLE_RATE)
    n0 = peak_nlcc(x[:w], y[:w]); n1 = peak_nlcc(x[w:2*w], y[w:2*w])
    r = measure_offset(x, y)
    print(f"{m1} vs {m2:10s} NLCC {n0:6.3f}/{n1:6.3f} min {min(n0,n1):6.3f} | conf={r['confidence']:.3f} {r['status']}")
    out[f"{m1}~{m2}"] = {"nlcc_off0": round(n0,4), "nlcc_off1": round(n1,4), "min": round(min(n0,n1),4),
                          "status": r["status"], "confidence": round(r["confidence"],4)}
Path(".tmp/w21-diag2.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
