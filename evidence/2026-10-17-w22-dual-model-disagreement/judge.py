"""判定：双模型分歧能否区分单/多说话人（判据见 PRE_REGISTRATION.md，未做调整）。"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
rows = json.loads((REPO/"evidence/2026-10-17-w22-embedding-swap/result.json").read_text(encoding="utf-8"))
ok = [r for r in rows if r["campplus"]["der"] is not None and r["resnet34"]["der"] is not None]

def sig(r, kind):
    kc, kr = r["campplus"]["k"], r["resnet34"]["k"]
    if kind == "gap": return abs(kc - kr)
    if kind == "flip": return 1.0 if (kc <= 2) != (kr <= 2) else 0.0
    if kind == "gap_norm": return abs(kc - kr) / max(kc, kr, 1)
    raise ValueError(kind)

def auc(pos, neg):
    """Mann-Whitney AUC：P(pos > neg) + 0.5*P(tie)。无 scipy。"""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if not len(pos) or not len(neg): return float("nan")
    gt = (pos[:, None] > neg[None, :]).sum()
    eq = (pos[:, None] == neg[None, :]).sum()
    return float((gt + 0.5 * eq) / (len(pos) * len(neg)))

pos = [r for r in ok if r["k_true"] == 1]
neg = [r for r in ok if r["k_true"] >= 2]
print(f"正类(K_true=1) n={len(pos)}   负类(K_true>=2) n={len(neg)}\n")

res = {}
for kind in ("gap", "flip", "gap_norm"):
    p = [sig(r, kind) for r in pos]
    n = [sig(r, kind) for r in neg]
    a = auc(p, n)
    # D2/D3：全阈值切片上取最好（阈值必须显式报出，且不依赖真值）
    cand = sorted({sig(r, kind) for r in ok})
    best = None
    for t in cand:
        tp = sum(1 for v in p if v >= t)
        fp = sum(1 for v in n if v >= t)
        rec = tp / len(p)
        fpr = fp / len(n)
        # 在满足 D3 的前提下最大化召回
        if fpr <= 0.15 and (best is None or rec > best[1]):
            best = (t, rec, fpr, fp)
    res[kind] = {"auc": round(a, 4), "best": best}
    print(f"[{kind}] AUC={a:.4f}  " + (f"可用阈值={best[0]} 召回={best[1]:.3f} 假阳率={best[2]:.3f}" if best else "无满足假阳约束的阈值"))

# D4 基线：恒取 K_cam<=2 判单人
base_tp = sum(1 for r in pos if r["campplus"]["k"] <= 2)
base_fp = sum(1 for r in neg if r["campplus"]["k"] <= 2)
base_rec, base_fpr = base_tp/len(pos), base_fp/len(neg)
print(f"\n[D4 基线] 恒取 K_cam<=2 判单人: 召回={base_rec:.3f} 假阳率={base_fpr:.3f}")

main = "gap"
D1 = res[main]["auc"] >= 0.75
b = res[main]["best"]
D2 = b is not None and b[1] >= 0.70
D3 = b is not None and b[2] <= 0.15
D4 = b is not None and (b[1] > base_rec) and (b[2] <= base_fpr)
print(f"\n=== 判据（主判据 = gap）===")
print(f"  D1 AUC>=0.75 : {res[main]['auc']:.4f} -> {'PASS' if D1 else 'FAIL'}")
print(f"  D2 召回>=0.70: {(b[1] if b else float('nan')):.3f} -> {'PASS' if D2 else 'FAIL'}")
print(f"  D3 假阳<=0.15: {(b[2] if b else float('nan')):.3f} -> {'PASS' if D3 else 'FAIL'}")
print(f"  D4 优于基线  : {'PASS' if D4 else 'FAIL'} (基线 召回={base_rec:.3f} 假阳={base_fpr:.3f})")
allp = D1 and D2 and D3 and D4
print(f"\n判定（预登记 §4）= {'分歧可作单/多判别信号' if allp else '否决 —— 该方向关闭'}")

out = {"n_pos": len(pos), "n_neg": len(neg),
       "signals": {k: {"auc": v["auc"],
                        "best_threshold": (v["best"][0] if v["best"] else None),
                        "best_recall": (v["best"][1] if v["best"] else None),
                        "best_fpr": (v["best"][2] if v["best"] else None)} for k, v in res.items()},
       "baseline_kcam_le2": {"recall": round(base_rec,4), "fpr": round(base_fpr,4)},
       "D1": D1, "D2": D2, "D3": D3, "D4": D4,
       "verdict": "PASS" if allp else "VETO"}
(HERE/"verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n落盘 -> verdict.json")
