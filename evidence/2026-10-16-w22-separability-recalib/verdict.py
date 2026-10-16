"""判定集结论（判据见 PRE_REGISTRATION.md §2.2/§2.4，未做任何事后调整）。

T1: 拆分版 DER 最差场 <= 0.60
T2: 拆分版 DER 均值   <= 0.40
并报负向对照 NC1（不拆）/ NC2（打乱）/ oracle 天花板，以及**适用性口径**：
本实验只对"巨簇含 >=2 真说话人"的场次有定义（其余场 k_giant=1，拆分无意义）⇒ 必须分列。
"""
from __future__ import annotations

import json
import statistics as st
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))

valid = [r for r in rows if r.get("ari_giant") is not None]
skipped = [r for r in rows if r.get("ari_giant") is None]

split = np.array([r["der_split"] for r in valid], dtype=float)
now = np.array([r["der_not_split"] for r in valid], dtype=float)
oracle = np.array([r["der_oracle"] for r in valid], dtype=float)

T1 = bool(split.max() <= 0.60)
T2 = bool(split.mean() <= 0.40)

print(f"=== 判定集（VoxConverse 未读，**首次读取**）===")
print(f"跑通 {len(rows)} 场；可判定（巨簇含 >=2 真说话人）{len(valid)} 场；"
      f"跳过 {len(skipped)} 场（k_giant=1）")
print()
print(f"T1 拆分版 DER 最差场 = {split.max():.4f}  (<=0.60) -> {'PASS' if T1 else 'FAIL'}")
print(f"T2 拆分版 DER 均值   = {split.mean():.4f}  (<=0.40) -> {'PASS' if T2 else 'FAIL'}")
print()
print(f"[NC1] 不拆（现行） 均值={now.mean():.4f} 最差={now.max():.4f}")
print(f"[对照] oracle 天花板 均值={oracle.mean():.4f} 最差={oracle.max():.4f}")
print(f"[NC2] 打乱后 ARI 最大 = "
      f"{max(r['ari_shuffled'] for r in valid):.4f}  (<=0.05) -> "
      f"{'PASS' if max(r['ari_shuffled'] for r in valid) <= 0.05 else 'FAIL'}")
print()
d = now - split
print(f"逐场改善: 改善 {(d > 1e-9).sum()} / 持平 {(np.abs(d) <= 1e-9).sum()} / "
      f"退化 {(d < -1e-9).sum()}   （中位 {np.median(d):+.4f}）")

# 天花板：拆分已收回多少可达缺口
gap_now = now.mean() - oracle.mean()
gap_split = split.mean() - oracle.mean()
print(f"可达缺口：现行 {gap_now:.4f} -> 拆分后 {gap_split:.4f} "
      f"(收回 {100*(1-gap_split/gap_now):.0f}%)")

verdict = ("可分且可产品化" if (T1 and T2) else
           "以产品口径不可分 => B 线（改准则方向）否决")
print(f"\n判定（预登记 §2.4）= T1{'✅' if T1 else '❌'} T2{'✅' if T2 else '❌'} => {verdict}")

out = {
    "n_total": len(rows), "n_valid": len(valid), "n_skipped_k_giant_1": len(skipped),
    "skipped": [r["meeting"] for r in skipped],
    "T1_worst_split": round(float(split.max()), 4), "T1_threshold": 0.60, "T1_pass": T1,
    "T2_mean_split": round(float(split.mean()), 4), "T2_threshold": 0.40, "T2_pass": T2,
    "nc1_mean_not_split": round(float(now.mean()), 4),
    "nc1_worst_not_split": round(float(now.max()), 4),
    "oracle_mean": round(float(oracle.mean()), 4),
    "oracle_worst": round(float(oracle.max()), 4),
    "improved": int((d > 1e-9).sum()), "equal": int((np.abs(d) <= 1e-9).sum()),
    "worse": int((d < -1e-9).sum()),
    "median_improvement": round(float(np.median(d)), 4),
    "verdict": verdict,
}
(HERE / "verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
print("\n落盘 -> verdict.json")
