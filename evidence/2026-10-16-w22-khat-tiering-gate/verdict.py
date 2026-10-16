"""判定（判据见 PRE_REGISTRATION.md §2，未做任何事后调整）。

V1/V2: K̂<=2 档 DER 均值<=0.40 / 最差<=0.60（ignore_overlap=True）
V3/V4: 同上但严格口径（ignore_overlap=False）
N1: 档内真多人（K_true>=3）占比 —— 必须报
N2: 该人群中 DER_T>0.60 的场次数 —— 必须 = 0
N3: K̂<=2 档合并后最差场 —— 必须 <=0.60（双口径）
NC2: K̂>=3 档 DER —— 必须报
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))


def st(vals):
    v = np.array(vals, dtype=float)
    return (len(v), round(float(v.mean()), 4), round(float(v.max()), 4)) if len(v) else (0, None, None)


lo = [r for r in rows if r["k_hat"] <= 2]
hi = [r for r in rows if r["k_hat"] >= 3]

n_lo, m_lo_T, w_lo_T = st([r["der_T"] for r in lo])
_, m_lo_F, w_lo_F = st([r["der_F"] for r in lo])
n_hi, m_hi_T, w_hi_T = st([r["der_T"] for r in hi])

V1 = m_lo_T is not None and m_lo_T <= 0.40
V2 = w_lo_T is not None and w_lo_T <= 0.60
V3 = m_lo_F is not None and m_lo_F <= 0.40
V4 = w_lo_F is not None and w_lo_F <= 0.60

# N1：K̂<=2 档内真多人
in_lo_multi = [r for r in lo if r["k_true"] >= 3]
N1 = len(in_lo_multi) / len(lo) if lo else None
# N2：该人群中 DER_T > 0.60 的场次
over = [r for r in in_lo_multi if r["der_T"] > 0.60]
N2 = len(over) == 0
# N3：合并后最差场
N3 = (w_lo_T is not None and w_lo_T <= 0.60) and (w_lo_F is not None and w_lo_F <= 0.60)

print(f"=== 验证集：VoxConverse 剩余未读 {len(rows)} 场（首次读取）===")
print(f"K̂<=2 档 n={n_lo}；K̂>=3 档 n={n_hi}")
print()
print(f"V1 K̂<=2 组 DER 均值   (宽松口径) = {m_lo_T}  (<=0.40) -> {'PASS' if V1 else 'FAIL'}")
print(f"V2 K̂<=2 组 DER 最差场 (宽松口径) = {w_lo_T}  (<=0.60) -> {'PASS' if V2 else 'FAIL'}")
print(f"V3 K̂<=2 组 DER 均值   (严格口径) = {m_lo_F}  (<=0.40) -> {'PASS' if V3 else 'FAIL'}")
print(f"V4 K̂<=2 组 DER 最差场 (严格口径) = {w_lo_F}  (<=0.60) -> {'PASS' if V4 else 'FAIL'}")
print()
print(f"N1 K̂<=2 档内真多人(K_true>=3)占比 = {len(in_lo_multi)}/{len(lo)} = "
      f"{N1:.1%}" if N1 is not None else "N1 n/a")
print(f"   明细: {[(r['meeting'], r['k_true'], r['der_T']) for r in in_lo_multi]}")
print(f"N2 该人群中 DER_T>0.60 的场次 = {len(over)} -> {'PASS(0 场)' if N2 else 'FAIL ' + str([(r['meeting'], r['der_T']) for r in over])}")
print(f"N3 合并后最差场（宽松/严格） = {w_lo_T} / {w_lo_F} -> {'PASS' if N3 else 'FAIL'}")
print()
print(f"NC2 K̂>=3 档 (n={n_hi}): DER 均值={m_hi_T} 最差={w_hi_T}")

allpass = V1 and V2 and V3 and V4 and N2 and N3
verdict = ("分档可立门（档内达标且无越线素材）" if allpass
           else "分档不可立门")
print(f"\n判定（预登记 §2.3）= {verdict}")

# 混淆矩阵
print("\n=== NC1 混淆矩阵（K_true × K̂）===")
kt = sorted({r["k_true"] for r in rows})
kh = sorted({r["k_hat"] for r in rows})
print("      " + "".join(f"K̂={k:<4}" for k in kh))
for k in kt:
    line = f"Kt={k:<3}"
    for h in kh:
        c = sum(1 for r in rows if r["k_true"] == k and r["k_hat"] == h)
        line += f"{c:<6}"
    print(line)

out = {
    "n": len(rows), "n_khat_le2": n_lo, "n_khat_ge3": n_hi,
    "V1": V1, "V2": V2, "V3": V3, "V4": V4, "N2": N2, "N3": N3,
    "mean_T_lo": m_lo_T, "worst_T_lo": w_lo_T,
    "mean_F_lo": m_lo_F, "worst_F_lo": w_lo_F,
    "mean_T_hi": m_hi_T, "worst_T_hi": w_hi_T,
    "N1_multi_share_in_lowk": None if N1 is None else round(N1, 4),
    "N1_detail": [{"meeting": r["meeting"], "k_true": r["k_true"], "der_T": r["der_T"],
                   "der_F": r["der_F"]} for r in in_lo_multi],
    "N2_over_0.60_count": len(over),
    "verdict": verdict,
}
(HERE / "verdict.json").write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
print("\n落盘 -> verdict.json")
