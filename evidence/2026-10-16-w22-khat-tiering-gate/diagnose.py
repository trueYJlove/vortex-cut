"""机制诊断（不改判据，只解释为什么失败）。

1. 失败场定位：K̂<=2 档的越线场（tucrg DER 0.801）
2. **可疑信号核查**：多场 `DER_T == oracle` **逐位相等** —— 是否 oracle 计算退化了？
   （若 oracle 与生产输出完全相同，则 oracle 不是"上界"而是"同一个解"）
3. K_true=1 的灾难性过分割（K̂=7/8）
4. 时长与 DER 的关系（tucrg 仅 26 s）
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))

print("=== 1. 失败场（K̂<=2 档）===")
lo = [r for r in rows if r["k_hat"] <= 2]
for r in sorted(lo, key=lambda x: -x["der_T"]):
    flag = "  <== 越线" if r["der_T"] > 0.60 else ""
    print(f"  {r['meeting']:<8} K_true={r['k_true']} K̂={r['k_hat']} "
          f"DER_T={r['der_T']:.4f} DER_F={r['der_F']:.4f} "
          f"oracle={r['der_oracle']} dur={r['duration_s']:.0f}s{flag}")

print("\n=== 2. 可疑信号：DER_T == oracle 逐位相等的场次 ===")
eq = [r for r in rows if r["der_oracle"] is not None
      and abs(r["der_T"] - r["der_oracle"]) < 1e-9]
print(f"  相等场次 = {len(eq)}/{len(rows)}")
for r in eq:
    print(f"    {r['meeting']:<8} K_true={r['k_true']} K̂={r['k_hat']} "
          f"DER={r['der_T']:.4f} dur={r['duration_s']:.0f}s")
print("  ⇒ 若 oracle 与生产输出逐位相等，说明该场生产解**恰好等于**每窗主导说话人解")
print("     （可能：该场窗级真值恰好干净 ⇒ 不是 bug，但 oracle 失去上界意义）")

print("\n=== 3. K_true=1 的过分割（(a) 表达能力欠账）===")
k1 = [r for r in rows if r["k_true"] == 1]
print(f"  K_true=1 场次 n={len(k1)}")
for r in sorted(k1, key=lambda x: -x["k_hat"]):
    print(f"    {r['meeting']:<8} K̂={r['k_hat']} DER_T={r['der_T']:.4f} "
          f"oracle={r['der_oracle']} dur={r['duration_s']:.0f}s")
print(f"  ⇒ K̂>=7 的场次: {sum(1 for r in k1 if r['k_hat'] >= 7)}/{len(k1)}")

print("\n=== 4. 时长 vs DER ===")
d = np.array([r["duration_s"] for r in rows])
x = np.array([r["der_T"] for r in rows])
short = [(r["meeting"], r["duration_s"], r["der_T"]) for r in rows if r["duration_s"] < 60]
print(f"  <60s 的场次 n={len(short)}")
for m, du, de in sorted(short, key=lambda t: -t[2]):
    print(f"    {m:<8} dur={du:>6.1f}s DER={de:.4f}")
if len(d) > 2:
    print(f"  相关系数 r(时长, DER) = {np.corrcoef(d, x)[0,1]:+.4f}")
    print(f"  >=60s 组: n={int((d>=60).sum())} DER 均值={x[d>=60].mean():.4f} 最差={x[d>=60].max():.4f}")
    print(f"  <60s  组: n={int((d<60).sum())} DER 均值={x[d<60].mean():.4f} 最差={x[d<60].max():.4f}")

print("\n=== 5. 若按预登记的'偏保守'预期：剔除 <60s 后是否改变判定？（探索性，非预登记）===")
r60 = [r for r in rows if r["duration_s"] >= 60]
lo60 = [r for r in r60 if r["k_hat"] <= 2]
if lo60:
    v = np.array([r["der_T"] for r in lo60])
    vf = np.array([r["der_F"] for r in lo60])
    print(f"  K̂<=2 且 >=60s: n={len(lo60)} 均值={v.mean():.4f} 最差={v.max():.4f}")
    print(f"    严格口径: 均值={vf.mean():.4f} 最差={vf.max():.4f}")
    print(f"    仍越线? 最差<=0.60: {bool(v.max() <= 0.60)}")
