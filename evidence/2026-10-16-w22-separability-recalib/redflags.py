"""红旗核查（不修改任何冻结判据，只做诊断）。

红旗 1：T1/T2 通过，但**不拆的基线是否也通过**？若也通过 ⇒ 判据无区分力（P127 NC4 同型）。
红旗 2：NC2（打乱后 ARI）最大 0.1321 > 0.05 ⇒ ARI 在该集上不干净，需定位是哪几场、为什么。
红旗 3：判定集是"K_true>=3 且 >=120s"的**全部未读场**，未按"欠分割"选 ⇒ 可能大多是本就不差的场。
本脚本只**报告**，不改判据、不挑选样本。
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))
valid = [r for r in rows if r.get("ari_giant") is not None]

now = np.array([r["der_not_split"] for r in valid], dtype=float)
split = np.array([r["der_split"] for r in valid], dtype=float)

print("=== 红旗 1：判据是否有区分力 ===")
print(f"  不拆(现行) 均值={now.mean():.4f} 最差={now.max():.4f}")
print(f"  拆分后      均值={split.mean():.4f} 最差={split.max():.4f}")
print(f"  门槛: 均值<=0.40 / 最差<=0.60")
print(f"  ⇒ 不拆也满足两条门槛: {bool(now.mean() <= 0.40 and now.max() <= 0.60)}")
print("  ⇒ 若为 True，则 T1/T2 PASS 不构成'拆分有效'的证据（判据无区分力）")

print("\n=== 红旗 2：NC2 打乱后 ARI 超限的场次 ===")
bad = [(r["meeting"], r["ari_shuffled"], r["ari_giant"], r["giant_windows"], r["k_giant"])
       for r in valid if r["ari_shuffled"] > 0.05]
print(f"  >0.05 的场次: {len(bad)}/{len(valid)}")
for m, sh, ag, gw, kg in sorted(bad, key=lambda x: -x[1])[:8]:
    print(f"    {m:<8} ARI_shuf={sh:+.4f} ARI_giant={ag:+.4f} giant_win={gw:>4} K_giant={kg}")

print("\n=== 红旗 3：判定集中'欠分割'子集（探索性，非预登记） ===")
under = [r for r in valid if r["k_now"] <= r["k_true"] - 2]
print(f"  欠分割场次: {len(under)}/{len(valid)}")
if under:
    un = np.array([r["der_not_split"] for r in under])
    us = np.array([r["der_split"] for r in under])
    uo = np.array([r["der_oracle"] for r in under])
    print(f"    DER 不拆 均值={un.mean():.4f} 最差={un.max():.4f}")
    print(f"    DER 拆分 均值={us.mean():.4f} 最差={us.max():.4f}")
    print(f"    DER oracle 均值={uo.mean():.4f} 最差={uo.max():.4f}")
    d = un - us
    print(f"    逐场: 改善 {(d > 1e-9).sum()} / 退化 {(d < -1e-9).sum()}  中位 {np.median(d):+.4f}")

print("\n=== 全部 39 场 DER 分布（看是否本就不差） ===")
print(f"  不拆: min={now.min():.4f} p25={np.percentile(now,25):.4f} "
      f"中位={np.median(now):.4f} p75={np.percentile(now,75):.4f} max={now.max():.4f}")
print(f"  >=0.40 的场次: {(now >= 0.40).sum()}/{len(now)}")
print(f"  >=0.60 的场次: {(now >= 0.60).sum()}/{len(now)}")
print(f"  K_true 分布: {dict(sorted(Counter(r['k_true'] for r in valid).items()))}")
