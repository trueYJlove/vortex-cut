"""溯源工具：为什么现行 silhouette+capK 会选到接近上限的 K？

**只做读数与归因，不开处方。**

读数（都在**候选窗 K in [2, k_max]** 内算，与产品口径一致）：
1. **argmax 是否落在窗口上沿**：pinned = 选中的 K 等于窗口内最大可用 K。
2. **上界对照**：把 cap 抬到 40（silhouette 可定义域）后它会选什么——
   用来回答"上限是在**保护**还是在**限制**"。

第 2 条是**诊断读数**，不是产品建议（放开上限会同时引入过分割，见门 §5.5/§5.6）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

K_SIL_DEFINED_MAX = 40  # 与 speaker.MAX_SILHOUETTE_CLUSTERS 同口径


def silhouette_by_k(entry: dict, k_max: int) -> dict[int, float]:
    """该场在 K in [2, k_max] 内，每个 K 能达到的最优 silhouette（多 tau 取 max）。"""
    out: dict[int, float] = {}
    for cell in entry["grid"]:
        k, sil = int(cell["k"]), cell["sil"]
        if sil is None or not (2 <= k <= k_max):
            continue
        out[k] = max(out.get(k, -2.0), float(sil))
    return out


def der_best_by_k(entry: dict, k_max: int) -> dict[int, float]:
    out: dict[int, float] = {}
    for cell in entry["grid"]:
        k = int(cell["k"])
        if not (2 <= k <= k_max):
            continue
        out[k] = min(out.get(k, 9.0), float(cell["der"]))
    return out


def analyse(per_meeting: dict, k_max: int) -> dict:
    rows = []
    for name, v in per_meeting.items():
        within = silhouette_by_k(v, k_max)
        if not within:
            continue
        ceiling = max(within)
        pick = int(v["silhouette_k"])
        full = silhouette_by_k(v, K_SIL_DEFINED_MAX)
        wide_pick = max(full, key=lambda k: full[k]) if full else None
        ordered = sorted(within)
        seq = [within[k] for k in ordered]
        rises = sum(1 for a, b in zip(seq, seq[1:]) if b >= a)
        der_wide = der_best_by_k(v, K_SIL_DEFINED_MAX).get(wide_pick) if wide_pick else None
        rows.append({
            "name": name, "k_true": int(v["k_true"]), "k_pick": pick,
            "der": float(v["silhouette"]), "oracle": float(v["oracle"]),
            "ceiling": ceiling, "pinned": pick == ceiling,
            "wide_pick": wide_pick, "wide_der": der_wide,
            "rises_frac": rises / max(len(seq) - 1, 1),
        })
    return {"k_max": k_max, "rows": rows}


def report(res: dict, label: str) -> None:
    rows = res["rows"]
    n = len(rows)
    pinned = [r for r in rows if r["pinned"]]
    der = np.array([r["der"] for r in rows])
    print("=== %s  n=%d  k_max=%d ===" % (label, n, res["k_max"]))
    print("  DER mean=%.4f worst=%.4f" % (der.mean(), der.max()))
    print("  argmax 落在窗口上沿（pinned）: %d/%d = %.0f%%" % (len(pinned), n, 100.0 * len(pinned) / n))
    if pinned:
        p = np.array([r["der"] for r in pinned])
        rest = np.array([r["der"] for r in rows if not r["pinned"]])
        print("    pinned   DER mean=%.4f worst=%.4f" % (p.mean(), p.max()))
        print("    unpinned DER mean=%.4f worst=%.4f" % (rest.mean(), rest.max()))
    wider = [r for r in rows if r["wide_pick"] and r["wide_pick"] > r["k_pick"]]
    print("  放开 cap 会选更大 K 的场次: %d/%d" % (len(wider), n))
    if wider:
        d_now = np.array([r["der"] for r in wider])
        d_wide = np.array([r["wide_der"] for r in wider], dtype=float)
        better = d_wide.mean() < d_now.mean()
        print("    这些场：现行 DER mean=%.4f / 放开后 mean=%.4f" % (d_now.mean(), d_wide.mean()))
        print("    => 上限在这些场上是 %s（放开后 DER %s）"
              % ("限制" if better else "保护", "变好" if better else "变差"))
    for lo, hi, tag in ((1, 1, "K_true=1"), (2, 3, "K_true=2..3"), (4, 99, "K_true>=4")):
        sub = [r for r in rows if lo <= r["k_true"] <= hi]
        if not sub:
            continue
        pin = [r for r in sub if r["pinned"]]
        d = np.array([r["der"] for r in sub])
        print("  %s: n=%d pinned=%d/%d DER mean=%.4f worst=%.4f"
              % (tag, len(sub), len(pin), len(sub), d.mean(), d.max()))
    print()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--k-max", type=int, default=8)
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    per_meeting = json.loads(Path(args.report).read_text(encoding="utf-8"))["per_meeting"]
    res = analyse(per_meeting, args.k_max)
    report(res, args.label or Path(args.report).name)
    if args.out:
        Path(args.out).write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
