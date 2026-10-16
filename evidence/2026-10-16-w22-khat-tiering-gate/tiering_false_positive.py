"""分档假阳性率 —— 用已归档的 P134 数据直接算（不改判据、不跑新数）。

P134 判定集 = **全部 K_true>=3 的未读场**（45 场）⇒ 可用来度量：
"若按 K̂<=2 分档准入，会把多少真·多人素材误放进对谈档"。

这是「按 K̂ 分档」立门前**最关键的一个风险数**：分档若假阳性高，
则"对谈达标"的档会把多人素材放进来，而该档的达标结论对多人素材并不成立。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[2]   # 仓库根（脚本在 evidence/<dir>/ 下）
EV = HERE / "evidence"
rows = json.loads(
    (EV / "2026-10-16-w22-separability-recalib/result.json")
    .read_text(encoding="utf-8"))

multi = [r for r in rows if r["k_true"] >= 3]
fp = [r for r in multi if r["k_now"] <= 2]
ok = [r for r in multi if r["k_now"] >= 3]

print("=== 分档假阳性率（数据来源：P134 判定集，全部 K_true>=3）===")
print(f"多人素材总数 = {len(multi)}")
print(f"其中生产报 K̂<=2（**会被误放进对谈档**）= {len(fp)}/{len(multi)} "
      f"= {len(fp)/len(multi):.1%}")
print()

if fp:
    d = np.array([r["der_not_split"] for r in fp], dtype=float)
    print(f"这些被误放场次的 DER（用生产输出自评）：")
    print(f"  均值={d.mean():.4f}  中位={np.median(d):.4f}  最差={d.max():.4f}")
    print(f"  >=0.40: {(d >= 0.40).sum()}/{len(d)}    >=0.60: {(d >= 0.60).sum()}/{len(d)}")
    print("\n  最差 8 场：")
    for r in sorted(fp, key=lambda x: -x["der_not_split"])[:8]:
        print(f"    {r['meeting']:<8} K_true={r['k_true']} K̂={r['k_now']} "
              f"DER={r['der_not_split']:.4f}")

if ok:
    d2 = np.array([r["der_not_split"] for r in ok], dtype=float)
    print(f"\n报成 K̂>=3 的多人场 n={len(ok)}: DER 均值={d2.mean():.4f} 最差={d2.max():.4f}")

# 与 P135 低人数档对比：同口径
print("\n=== 对比：P135 低人数档（K_true<=2）的 DER ===")
lo = json.loads((EV / "2026-10-16-w22-lowk-scenario-gate/result.json")
                .read_text(encoding="utf-8"))
dl = np.array([r["der_production"] for r in lo], dtype=float)
print(f"  K_true<=2 档 n={len(dl)}: 均值={dl.mean():.4f} 最差={dl.max():.4f}")
if fp:
    print(f"  误放入该档的多人场 n={len(d)}: 均值={d.mean():.4f} 最差={d.max():.4f}")
    print(f"  ⇒ 若合并计：均值={(np.concatenate([dl,d])).mean():.4f} "
          f"最差={max(dl.max(), d.max()):.4f}")
