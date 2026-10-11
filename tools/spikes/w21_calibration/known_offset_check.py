"""W2.1 机位同步在 AMI 真实多设备音频上的取证（spike 用）。

背景：W2.1 验收 9 原阻塞于"用户提供真实多机位素材"。AMI 的同会议多路阵列通道
**就是真实多设备捕获同一场景**，可作替代素材。

三组对照（同一场 ES2004a，基准起点 300s，窗长 60s）：
- A 对齐：ref=Array2[300:360], mem=Array1[300:360]            → 期望 ≈ 0
- B 成员晚 0.687s：ref=Array2[300:360], mem=Array1[300.687:360.687]  → 期望 ≈ −687 ms
- C 成员早 0.687s：ref=Array2[300.687:360.687], mem=Array1[300:360]  → 期望 ≈ +687 ms
（B/C 互为反号 ⇒ 同时钉死**符号约定**与**量值**，而不是只看绝对值。）
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]  # 仓库根（按 __file__ 推导，勿硬编码）
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

from aivs_core.media.angle_sync import SAMPLE_RATE, measure_offset  # noqa: E402

FFMPEG = ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
AUDIO = ROOT / ".tmp" / "ami" / "audio"


def decode(path: Path, start_s: float, dur_s: float) -> np.ndarray:
    cmd = [str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error",
           "-ss", f"{start_s:.6f}", "-i", str(path), "-t", f"{dur_s:.6f}",
           "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).astype(np.float64)


BASE = 300.0
DUR = 60.0
SHIFT = 0.687

cases = [
    ("A_aligned", 0.0, 0.0, 0.0),
    ("B_member_later_687ms", 0.0, SHIFT, -SHIFT * 1e6),
    ("C_member_earlier_687ms", SHIFT, 0.0, +SHIFT * 1e6),
]

results = []
for name, ref_off, mem_off, expect in cases:
    ref = decode(AUDIO / "ES2004a.Array2-01.wav", BASE + ref_off, DUR)
    mem = decode(AUDIO / "ES2004a.Array1-01.wav", BASE + mem_off, DUR)
    t0 = time.perf_counter()
    res = measure_offset(ref, mem)
    elapsed = time.perf_counter() - t0
    row = {"case": name, "expect_us": int(expect), "status": res["status"],
           "reason": res["reason"], "offset_us": res["offset_us"],
           "confidence": round(res["confidence"], 4),
           "dual_delta_us": res["dual_delta_us"], "drift_us": res["drift_us"],
           "elapsed_s": round(elapsed, 3)}
    if res["offset_us"] is not None:
        row["error_vs_expect_us"] = res["offset_us"] - int(expect)
    results.append(row)
    print(json.dumps(row, ensure_ascii=False))

print("\n--- 判读 ---")
ok = True
for row in results:
    if row["status"] != "ready":
        print(f"{row['case']}: 非 ready（{row['reason']}）")
        ok = False
        continue
    err = row["error_vs_expect_us"]
    verdict = "✅" if abs(err) <= 10_000 else "❌"
    if abs(err) > 10_000:
        ok = False
    print(f"{row['case']}: offset {row['offset_us']/1000:.1f} ms  期望 {row['expect_us']/1000:.1f} ms  "
          f"误差 {err/1000:.2f} ms  {verdict}")
print("\n总体:", "通过 ✅" if ok else "未通过 ❌")
Path(".tmp/w21-ami-report.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
