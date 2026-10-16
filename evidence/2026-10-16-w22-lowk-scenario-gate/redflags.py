"""红旗核查（不改判据，只诊断）——结果"太好"时必须先自证不是假象。

怀疑 1：VoxConverse 低人数档素材是否过易（句间静音多、单人长段落）？
        与 AMI（4 人会议）的 DER 直接对比虽不可比大小，但可看**分布形态**。
怀疑 2：K̂<=2 判据是否被"过分割"混淆——K_true=2 报 K̂=2 才是对的；
        K_true=1 报 K̂=2 是**错**的（(a) 表达能力欠账），检查它是否被算作"达标"。
怀疑 3：DER 是否被"忽略重叠"口径美化——须同报严格口径（ignore_overlap=False）。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))

print("=== 怀疑 2：K_true=1 场次是否被达标结论掩盖 ===")
k1 = [r for r in rows if r["k_true"] == 1]
k2 = [r for r in rows if r["k_true"] == 2]
print(f"K_true=1: n={len(k1)}  K̂={[r['k_hat'] for r in k1]}  "
      f"DER={[r['der_production'] for r in k1]}")
print(f"  ⇒ K̂=1 的场次: {sum(1 for r in k1 if r['k_hat'] == 1)}/{len(k1)} "
      f"(结构性无法输出 K=1 ⇒ 预期 0)")
print(f"K_true=2: n={len(k2)}  K̂=2 的占 {sum(1 for r in k2 if r['k_hat'] == 2)}/{len(k2)}")
print()
print("  关键：K_true=2 且 K̂=2 = 完全正确；K_true=2 且 K̂=3/4 = 过分割（但 DER 仍可能低）")
for r in sorted(rows, key=lambda x: -x["der_production"])[:6]:
    print(f"    {r['meeting']:<8} K_true={r['k_true']} K̂={r['k_hat']} "
          f"DER={r['der_production']:.4f} oracle={r['der_oracle']:.4f}")

print("\n=== 怀疑 3：DER 是否被口径美化（需严格口径对照）===")
print("  本 result.json 只含 ignore_overlap=True 口径；严格口径需重跑评分（见 README）")

print("\n=== 与 AMI 的形态对比（不可比大小，只看数量级与最差场）===")
ami = json.loads((HERE.parent / "2026-10-14-w22-s3-production-gate/result.json")
                 .read_text(encoding="utf-8"))
a = ami["corpora"]["ami"]["per_meeting"]
av = np.array([v["der_T"] for v in a.values()])
bv = np.array([r["der_production"] for r in rows])
print(f"  AMI(4 人会议, n={len(av)}): 均值={av.mean():.4f} 最差={av.max():.4f}")
print(f"  本轮(1-2 人对话, n={len(bv)}): 均值={bv.mean():.4f} 最差={bv.max():.4f}")
print(f"  ⇒ 差 {av.mean()-bv.mean():+.4f}（**不得**据此比较语料难度，仅记形态）")

print("\n=== 素材特征（是否过易）===")
for r in sorted(rows, key=lambda x: x["duration_s"])[:4]:
    print(f"  {r['meeting']:<8} dur={r['duration_s']:>7.1f}s win={r['n_windows']:>4} "
          f"K̂={r['k_hat']} DER={r['der_production']:.4f}")
print(f"  时长: 中位={np.median([r['duration_s'] for r in rows]):.0f}s  "
      f"最短={min(r['duration_s'] for r in rows):.0f}s 最长={max(r['duration_s'] for r in rows):.0f}s")

print("\n=== DER 分布形态 ===")
print(f"  >=0.05 的场次: {sum(1 for r in rows if r['der_production'] >= 0.05)}/{len(rows)}")
print(f"  >=0.20 的场次: {sum(1 for r in rows if r['der_production'] >= 0.20)}/{len(rows)}")
print(f"  >=0.40 的场次: {sum(1 for r in rows if r['der_production'] >= 0.40)}/{len(rows)}")
