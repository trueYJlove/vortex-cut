"""判定（判据见 PRE_REGISTRATION.md，未做任何事后调整）。

P0: K̂<=2 场次数 >=5
P1: K̂<=2 组 DER 均值   <=0.40
P2: K̂<=2 组 DER 最差场 <=0.60
D1: K_true<=2 组 DER 均值<=0.40 且最差场<=0.60（诊断口径）
D2: P1/P2 与 D1 的差（必报）
R1: 若 P1/P2 达标，K̂<=2 组至少 1 场 DER>=0.05（反平凡性）
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))

der = {r["meeting"]: r["der_production"] for r in rows}
khat = {r["meeting"]: r["k_hat"] for r in rows}
ktrue = {r["meeting"]: r["k_true"] for r in rows}

grp_hat = [m for m in der if khat[m] <= 2]
grp_true = [m for m in der if ktrue[m] <= 2]


def stats(ms):
    v = np.array([der[m] for m in ms], dtype=float)
    return (len(v), round(float(v.mean()), 4), round(float(v.max()), 4)) if len(v) else (0, None, None)


n_hat, mean_hat, worst_hat = stats(grp_hat)
n_true, mean_true, worst_true = stats(grp_true)

P0 = n_hat >= 5
P1 = (mean_hat is not None) and mean_hat <= 0.40
P2 = (worst_hat is not None) and worst_hat <= 0.60
D1 = (mean_true is not None) and mean_true <= 0.40 and worst_true <= 0.60
R1 = any(der[m] >= 0.05 for m in grp_hat) if grp_hat else None

print(f"=== 判定集：VoxConverse 未读 {len(rows)} 场（K_true<=2, >=120s，首次读取）===")
print(f"K_hat 分布: {dict(sorted(__import__('collections').Counter(khat.values()).items()))}")
print(f"K_true 分布: {dict(sorted(__import__('collections').Counter(ktrue.values()).items()))}")
print()
print(f"P0 K̂<=2 场次数 = {n_hat}  (>=5) -> {'PASS' if P0 else 'INCONCLUSIVE'}")
print(f"P1 K̂<=2 组 DER 均值   = {mean_hat}  (<=0.40) -> {'PASS' if P1 else 'FAIL'}")
print(f"P2 K̂<=2 组 DER 最差场 = {worst_hat}  (<=0.60) -> {'PASS' if P2 else 'FAIL'}")
print(f"D1 K_true<=2 组 均值={mean_true} 最差={worst_true}  (<=0.40 / <=0.60) -> "
      f"{'PASS' if D1 else 'FAIL'}")
print(f"R1 反平凡性（K̂<=2 组至少 1 场 >=0.05）= {R1}")
print()
print(f"D2 分档差：K̂<=2 均值 {mean_hat} vs K_true<=2 均值 {mean_true} "
      f"(差 {None if None in (mean_hat, mean_true) else round(mean_hat - mean_true, 4)})")
print(f"    样本：K̂<=2 n={n_hat}/{len(rows)}；K_true<=2 n={n_true}/{len(rows)}"
      f" => 产品{'能' if n_hat >= n_true * 0.8 else '难以'}识别该档")

if not P0:
    verdict = "inconclusive（K̂<=2 样本不足）=> 「分档不可产品化」成立，该路径关闭"
elif P1 and P2:
    verdict = "主场景达标（可产品化）"
else:
    verdict = "主场景不达标 => 多机位线在主场景亦无可用路径，建议冻结"

print(f"\n判定（预登记 §1.5）= {verdict}")

# 分组细分
print("\n=== 细分（K_true x K̂）===")
for kt in sorted(set(ktrue.values())):
    ms = [m for m in der if ktrue[m] == kt]
    nh = sum(1 for m in ms if khat[m] <= 2)
    n, mn, ws = stats(ms)
    print(f"  K_true={kt}: n={n}  K̂<=2 的占 {nh}/{n}  DER 均值={mn} 最差={ws}")

out = {
    "n_total": len(rows), "n_khat_le2": n_hat, "n_ktrue_le2": n_true,
    "P0_pass": P0, "P1_pass": P1, "P2_pass": P2, "D1_pass": D1, "R1": R1,
    "khat_le2_mean": mean_hat, "khat_le2_worst": worst_hat,
    "ktrue_le2_mean": mean_true, "ktrue_le2_worst": worst_true,
    "D2_mean_gap": None if None in (mean_hat, mean_true) else round(mean_hat - mean_true, 4),
    "khat_dist": dict(sorted(__import__("collections").Counter(khat.values()).items())),
    "ktrue_dist": dict(sorted(__import__("collections").Counter(ktrue.values()).items())),
    "verdict": verdict,
}
(HERE / "verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
print("\n落盘 -> verdict.json")
