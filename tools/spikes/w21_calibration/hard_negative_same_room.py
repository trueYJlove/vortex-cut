"""最硬负向对照：**同会议/同房间/同说话人，但时间不同**。

跨会议负样本（≤0.122）不能代表最坏情况——同房间的房间声、同一批说话人会让
"错位配对"也带上相关性。若这类样本超过候选阈值，阈值就不能定在那里。
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
DUR = 30.0
cache: dict = {}


def decode(ch: str, t: float) -> np.ndarray:
    key = (ch, t)
    if key not in cache:
        cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{t:.6f}",
               "-i", str(AUDIO / f"ES2004a.{ch}.wav"), "-t", f"{DUR:.6f}", "-vn",
               "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
        cache[key] = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout,
                                   dtype=np.float32).astype(np.float64)
    return cache[key]


GROUPS = {
    "同会议 不同时间 不同设备(远)": [("Array1-01", 300, "Array2-01", 900),
                                     ("Array1-01", 600, "Array2-01", 120),
                                     ("Array2-01", 420, "Array1-01", 840),
                                     ("Array1-01", 180, "Array2-01", 720)],
    "同会议 不同时间 同设备": [("Array1-01", 300, "Array1-01", 900),
                               ("Array1-01", 600, "Array1-01", 120)],
    "同会议 不同时间 近距设备": [("Array1-01", 300, "Array1-02", 900),
                                 ("Array1-01", 600, "Array1-02", 120)],
}
out = {}
for name, cases in GROUPS.items():
    confs, details = [], []
    for ca, ta, cb, tb in cases:
        a, b = decode(ca, ta), decode(cb, tb)
        r = measure_offset(a, b)
        confs.append(r["confidence"])
        details.append({"a": f"{ca}@{ta}", "b": f"{cb}@{tb}",
                        "confidence": round(r["confidence"], 4), "status": r["status"],
                        "reason": r["reason"], "offset_us": r["offset_us"]})
    arr = np.array(confs)
    out[name] = {"confidences": [round(c, 4) for c in confs], "max": round(float(arr.max()), 4),
                 "details": details}
    print(f"{name:32s} n={len(confs)} max={arr.max():.3f}  值={[round(c,3) for c in confs]}")

print("\n--- 逐样本 ---")
for name, v in out.items():
    for dd in v["details"]:
        print(f"  {name[:16]:16s} {dd['a']} vs {dd['b']:14s} conf={dd['confidence']:.3f} {dd['status']}({dd['reason'] or '-'}) offset={dd['offset_us']}")

allmax = max(v["max"] for v in out.values())
print(f"\n最硬负样本的全局最大置信度: {allmax:.3f}")
Path(".tmp/w21-hard-neg.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
