"""P94 标定：真实多设备素材上的置信度分布（正样本 vs 负样本）。

单点定阈值不成立——必须看分布。用 ES2004a 的多个时间窗（30s，均落在有声区），
对每对通道算 measure_offset 的 confidence（拒答时也会返回），再统计分位数。
"""
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


def decode(meeting: str, ch: str, start_s: float, dur_s: float) -> np.ndarray:
    name = f"{meeting}.{ch}.wav"
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{start_s:.6f}",
           "-i", str(AUDIO / name), "-t", f"{dur_s:.6f}", "-vn", "-ac", "1",
           "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                         dtype=np.float32).astype(np.float64)


# 有声区（ES2004a 参考语音从 50s 起；选 12 个 30s 窗均匀铺开）
WINDOWS = [60, 140, 220, 300, 380, 460, 540, 620, 700, 780, 860, 940]
DUR = 30.0

PAIRS = [
    ("same-near", "ES2004a", "Array1-02", "ES2004a", "Array1-01"),
    ("same-mid", "ES2004a", "Array1-05", "ES2004a", "Array1-01"),
    ("far-arrays", "ES2004a", "Array1-01", "ES2004a", "Array2-01"),
    ("diff-device", "ES2004a", "Mix-Headset", "ES2004a", "Array2-01"),
    ("unrelated-1", "ES2004a", "Mix-Headset", "IS1009a", "Mix-Headset"),
    ("unrelated-2", "ES2004a", "Mix-Headset", "IS1009c", "Mix-Headset"),
]
cache: dict[tuple, np.ndarray] = {}


def get(meeting: str, ch: str, t: float) -> np.ndarray:
    key = (meeting, ch, t)
    if key not in cache:
        cache[key] = decode(meeting, ch, t, DUR)
    return cache[key]


results: dict[str, list] = {}
print(f"{'组':14s} {'n':>3s} {'min':>6s} {'p25':>6s} {'p50':>6s} {'p75':>6s} {'max':>6s}  判定分布")
for name, m1, c1, m2, c2 in PAIRS:
    confs, oks = [], 0
    for t in WINDOWS:
        a, b = get(m1, c1, t), get(m2, c2, t)
        r = measure_offset(a, b)
        confs.append(r["confidence"])
        oks += r["status"] == "ready"
    arr = np.array(confs)
    results[name] = {"confidences": [round(c, 4) for c in confs],
                     "min": round(float(arr.min()), 4), "p25": round(float(np.percentile(arr, 25)), 4),
                     "p50": round(float(np.median(arr)), 4), "p75": round(float(np.percentile(arr, 75)), 4),
                     "max": round(float(arr.max()), 4), "ready_count": oks, "n": len(confs)}
    print(f"{name:14s} {len(confs):3d} {arr.min():6.3f} {np.percentile(arr,25):6.3f} "
          f"{np.median(arr):6.3f} {np.percentile(arr,75):6.3f} {arr.max():6.3f}  ready {oks}/{len(confs)}")

pos = [c for k in ("same-near", "same-mid", "far-arrays") for c in results[k]["confidences"]]
neg = [c for k in ("unrelated-1", "unrelated-2") for c in results[k]["confidences"]]
print(f"\n正样本（真实多设备同场景，n={len(pos)}）: min={min(pos):.3f}  p05={np.percentile(pos,5):.3f}")
print(f"负样本（无关内容，      n={len(neg)}）: max={max(neg):.3f}  p95={np.percentile(neg,95):.3f}")
if min(pos) > max(neg):
    lo, hi = max(neg), min(pos)
    import math
    geo = math.sqrt(lo * hi)
    print(f"\n可分：负 max {lo:.3f} < 正 min {hi:.3f}")
    print(f"  几何中值（等倍余量）: {geo:.3f}  ⇒ 正余量 {hi/geo:.2f}x / 负余量 {geo/lo:.2f}x")
    for t in (0.15, 0.20, 0.25, 0.30, 0.35, 0.40):
        print(f"  τ={t:.2f}: 正接受 {sum(c>=t for c in pos)}/{len(pos)}  负误收 {sum(c>=t for c in neg)}/{len(neg)}")
Path(".tmp/w21-calib.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
