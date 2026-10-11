"""P94 修复验证：真实多设备素材上阈值改 0.20 后，正样本应收、负样本应拒、偏移应正确。

AMI 阵列各通道出厂同步 ⇒ 正样本的真值偏移 = 0，可直接断言 |offset| 小于精门。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
from aivs_core.media.angle_sync import (  # noqa: E402
    CONFIDENCE_THRESHOLD, SAMPLE_RATE, measure_offset,
)

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"
DUR = 30.0
WINDOWS = [60, 140, 220, 300, 380, 460, 540, 620, 700, 780, 860, 940]
cache: dict = {}


def decode(meeting: str, ch: str, t: float) -> np.ndarray:
    key = (meeting, ch, t)
    if key not in cache:
        cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{t:.6f}",
               "-i", str(AUDIO / f"{meeting}.{ch}.wav"), "-t", f"{DUR:.6f}", "-vn",
               "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        cache[key] = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                                   dtype=np.float32).astype(np.float64)
    return cache[key]


print(f"CONFIDENCE_THRESHOLD = {CONFIDENCE_THRESHOLD}\n")
report = {"threshold": CONFIDENCE_THRESHOLD, "groups": {}}

def run_group(name, cases, expect_ready):
    ready, offsets, confs, rows = 0, [], [], []
    for (m1, c1, t1, m2, c2, t2) in cases:
        a, b = decode(m1, c1, t1), decode(m2, c2, t2)
        r = measure_offset(a, b)
        is_ready = r["status"] == "ready"
        ready += is_ready
        if is_ready:
            offsets.append(r["offset_us"])
        confs.append(r["confidence"])
        rows.append({"a": f"{m1}.{c1}@{t1}", "b": f"{m2}.{c2}@{t2}",
                     "status": r["status"], "reason": r["reason"],
                     "confidence": round(r["confidence"], 4), "offset_us": r["offset_us"]})
    report["groups"][name] = {"n": len(cases), "ready": ready, "expect_ready": expect_ready,
                              "min_conf": round(min(confs), 4), "max_conf": round(max(confs), 4),
                              "max_abs_offset_us": max((abs(o) for o in offsets), default=None),
                              "rows": rows}
    verdict = "✅" if (ready if expect_ready else ready == 0) else "❌"
    extra = f" max|offset|={max((abs(o) for o in offsets), default=0)}us" if offsets else ""
    print(f"{name:34s} ready {ready}/{len(cases)}  conf[{min(confs):.3f},{max(confs):.3f}]{extra}  {verdict}")
    return rows


print("=== 正样本：应接受（AMI 阵列出厂同步 ⇒ 真值偏移 0）===")
run_group("far-arrays 不同阵列(≈两机位)",
          [("ES2004a", "Array1-01", t, "ES2004a", "Array2-01", t) for t in WINDOWS], True)
run_group("same-near 同阵列相邻",
          [("ES2004a", "Array1-02", t, "ES2004a", "Array1-01", t) for t in WINDOWS], True)
run_group("same-mid 同阵列对角",
          [("ES2004a", "Array1-05", t, "ES2004a", "Array1-01", t) for t in WINDOWS], True)

print("\n=== 负样本：应拒绝 ===")
run_group("unrelated 跨会议",
          [("ES2004a", "Mix-Headset", t, "IS1009a", "Mix-Headset", t) for t in WINDOWS[:6]] +
          [("ES2004a", "Mix-Headset", t, "IS1009c", "Mix-Headset", t) for t in WINDOWS[:6]], False)
run_group("同会议 不同时间 远设备",
          [("ES2004a", "Array1-01", 300, "ES2004a", "Array2-01", 900),
           ("ES2004a", "Array1-01", 600, "ES2004a", "Array2-01", 120),
           ("ES2004a", "Array2-01", 420, "ES2004a", "Array1-01", 840),
           ("ES2004a", "Array1-01", 180, "ES2004a", "Array2-01", 720)], False)
run_group("同会议 不同时间 同设备",
          [("ES2004a", "Array1-01", 300, "ES2004a", "Array1-01", 900),
           ("ES2004a", "Array1-01", 600, "ES2004a", "Array1-01", 120)], False)

Path(".tmp/w21-fix-verify.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
print("\n注：正样本 max|offset| 若远小于 DUAL/FINE 门（1ms）即说明偏移估计正确。")
