"""两个精确核查（不改判据）：

A. `DER_T == oracle` 逐位相等的 11 场：是 bug 还是预期？
   预期解释：oracle 与生产解在**窗级分配完全相同**时，经 `windows_to_turns` 后的
   hyp 逐帧相同 ⇒ DER 必然逐位相等。若该解释成立，则相等场次应满足
   「生产解 ≈ 完美（DER 很小）」这一特征；反之若在大 DER 场也大量相等，则可疑。

B. 决定性失败场 `tucrg`（K_true=3 / K̂=2 / DER 0.8010 / 26 s）的性质：
   其 oracle 也有 0.5306 ⇒ 说明该场**本身极难**（可能重度重叠）。
   量化其重叠占比，判断这是"素材固有难度"还是"链路缺陷"。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
rows = json.loads((HERE / "result.json").read_text(encoding="utf-8"))
RTTM = HERE.parents[1] / ".tmp/voxconverse/rttm"

print("=== A. 相等场次的特征（检验'预期解释'）===")
eq = [r for r in rows if r["der_oracle"] is not None and abs(r["der_T"] - r["der_oracle"]) < 1e-9]
ne = [r for r in rows if r["der_oracle"] is not None and abs(r["der_T"] - r["der_oracle"]) >= 1e-9]
print(f"  相等 n={len(eq)}  DER 中位={np.median([r['der_T'] for r in eq]):.4f} "
      f"最差={max(r['der_T'] for r in eq):.4f}")
print(f"  不等 n={len(ne)}  DER 中位={np.median([r['der_T'] for r in ne]):.4f} "
      f"最差={max(r['der_T'] for r in ne):.4f}")
big_eq = [r for r in eq if r["der_T"] >= 0.10]
print(f"  ⇒ 相等场中 DER>=0.10 的: {len(big_eq)}/{len(eq)} "
      f"{[ (r['meeting'], r['der_T']) for r in big_eq ]}")
print("  ⇒ 解读：若相等场几乎全是低 DER（生产解≈完美），则'预期解释'成立、非 bug")


def overlap_stats(meeting: str) -> tuple[float, float, int]:
    """RTTM 的重叠占比：任一时长内 >=2 个说话人同时说话的时长占总覆盖时长比例。"""
    p = RTTM / f"{meeting}.rttm"
    segs = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        f = line.split()
        if len(f) >= 8 and f[0] == "SPEAKER":
            s, d = float(f[3]), float(f[4])
            segs.append((s, s + d))
    if not segs:
        return (0.0, 0.0, 0)
    events = []
    for s, e in segs:
        events.append((s, 1))
        events.append((e, -1))
    events.sort()
    cur = 0
    overlap = 0.0
    covered = 0.0
    prev = events[0][0]
    for t, delta in events:
        if cur >= 1:
            covered += t - prev
            if cur >= 2:
                overlap += t - prev
        cur += delta
        prev = t
    return (overlap, covered, len({f.split()[7] for f in p.read_text(encoding='utf-8', errors='replace').splitlines() if len(f.split()) >= 8 and f.split()[0] == 'SPEAKER'}))


print("\n=== B. 失败场与短场的重叠占比 ===")
focus = ["tucrg", "hqyok", "tfvyr", "bwzyf", "jyirt", "mevkw", "qrzjk", "pqmho"]
print(f"  {'meeting':<8} {'重叠s':>8} {'覆盖s':>8} {'重叠占比':>8} {'说话人':>6} {'DER_T':>8} {'oracle':>8}")
for m in focus:
    ov, cov, nspk = overlap_stats(m)
    r = next((x for x in rows if x["meeting"] == m), None)
    frac = ov / cov if cov > 0 else 0.0
    print(f"  {m:<8} {ov:>8.1f} {cov:>8.1f} {frac:>8.1%} {nspk:>6} "
          f"{r['der_T']:>8.4f} {r['der_oracle']:>8.4f}")

print("\n=== C. 全体重叠占比 vs DER ===")
fr, de = [], []
for r in rows:
    ov, cov, _ = overlap_stats(r["meeting"])
    if cov > 0:
        fr.append(ov / cov)
        de.append(r["der_T"])
fr, de = np.array(fr), np.array(de)
print(f"  n={len(fr)}  重叠占比: 中位={np.median(fr):.1%} 最大={fr.max():.1%}")
print(f"  r(重叠占比, DER) = {np.corrcoef(fr, de)[0,1]:+.4f}")
