"""溯源（决定性实验）：把 **K=1** 放进候选集后会发生什么？

**发现**：`speaker.choose_threshold_silhouette_capk` 的候选窗是 K ∈ [2, k_max]
（`if k < 2 or k > k_max: continue`）⇒ **单人素材在结构上永远报不出 1 个说话人**。
而 `count_at()` 本身返回 `max(1, ...)`，即 K=1 是**可算的**，只是被候选集排除了。

本实验只改候选窗（K ∈ [1, k_max]），其余（同一 τ 网格、同一 silhouette 定义、
同一评分）全部不变，看：
1. K_true=1 的 15 场会选什么 K；
2. 全体 DER mean/worst 怎么变；
3. **有无副作用**（K_true≥2 的场是否被拉到 K=1）。

只读，不开处方——是否改产品口径属设计裁决。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT / "services" / "core" / "src", ROOT / "tools" / "quality_eval"):
    sys.path.insert(0, str(_p))

from diarization_cap_trace import silhouette_by_k  # noqa: E402


def pick(entry: dict, k_lo: int, k_hi: int) -> tuple[int, float] | None:
    """在 K ∈ [k_lo, k_hi] 内取 silhouette 最大的 K，返回 (K, 该 K 的 DER)。"""
    curve = silhouette_by_k(entry, k_hi)
    cand = {k: v for k, v in curve.items() if k >= k_lo}
    if not cand:
        return None
    k = max(cand, key=lambda kk: cand[kk])
    der = min(float(c["der"]) for c in entry["grid"] if int(c["k"]) == k
              and (c["sil"] is None or abs(float(c["sil"]) - cand[k]) < 1e-9))
    return k, der


def run(report: str) -> int:
    per_meeting = json.loads(Path(report).read_text(encoding="utf-8"))["per_meeting"]
    rows = []
    for name, v in per_meeting.items():
        now = pick(v, 2, 8)
        new = pick(v, 1, 8)
        if now is None or new is None:
            continue
        rows.append({
            "name": name, "k_true": int(v["k_true"]),
            "k_now": now[0], "der_now": now[1],
            "k_new": new[0], "der_new": new[1],
            "oracle": float(v["oracle"]),
        })
    print("n =", len(rows))
    for lo, hi, tag in ((1, 1, "K_true=1"), (2, 3, "K_true=2..3"), (4, 99, "K_true>=4")):
        sub = [r for r in rows if lo <= r["k_true"] <= hi]
        if not sub:
            continue
        dn = np.array([r["der_now"] for r in sub])
        dw = np.array([r["der_new"] for r in sub])
        kn = np.array([r["k_now"] for r in sub])
        kw = np.array([r["k_new"] for r in sub])
        print()
        print("=== %s (n=%d) ===" % (tag, len(sub)))
        print("  现行候选窗 [2,8]:  DER mean=%.4f worst=%.4f   K 中位=%d" % (dn.mean(), dn.max(), int(np.median(kn))))
        print("  含 K=1 候选窗 [1,8]: DER mean=%.4f worst=%.4f   K 中位=%d" % (dw.mean(), dw.max(), int(np.median(kw))))
        changed = [r for r in sub if r["k_now"] != r["k_new"]]
        print("  K 选择发生变化的场次: %d/%d" % (len(changed), len(sub)))
        if changed:
            worse = [r for r in changed if r["der_new"] > r["der_now"] + 1e-9]
            better = [r for r in changed if r["der_new"] < r["der_now"] - 1e-9]
            print("    变好 %d / 变差 %d" % (len(better), len(worse)))
    print()
    dn = np.array([r["der_now"] for r in rows])
    dw = np.array([r["der_new"] for r in rows])
    print("=== 全体 (n=%d) ===" % len(rows))
    print("  现行: mean=%.4f worst=%.4f" % (dn.mean(), dn.max()))
    print("  含 K=1: mean=%.4f worst=%.4f" % (dw.mean(), dw.max()))
    print("  K 变化场次: %d" % sum(1 for r in rows if r["k_now"] != r["k_new"]))
    k1 = [r for r in rows if r["k_true"] == 1]
    print()
    print("K_true=1 的 15 场逐场（现行 vs 含 K=1）:")
    print("  %-8s %6s %8s %9s %8s %9s" % ("name", "k_now", "der_now", "k_with_K1", "der_new", "oracle"))
    for r in sorted(k1, key=lambda r: -r["der_now"]):
        print("  %-8s %6d %8.4f %9d %8.4f %9.4f"
              % (r["name"], r["k_now"], r["der_now"], r["k_new"], r["der_new"], r["oracle"]))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    raise SystemExit(run(ap.parse_args().report))
