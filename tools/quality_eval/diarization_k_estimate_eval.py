"""W2.2：K 估计器**首次单独验证** —— 直接测量 `K_hat_dm = round(1/w_same)` 的质量。

背景：门 §5.6④ 三条不批准理由之一是"它依赖的说话人数估计器**从未被单独验证质量**"。
本工具补上这一课：**不经过任何聚类/选 τ**，只测估计器本身。

报三个读数（预登记 §3 会引用）：
  1. **偏差方向**：高估 / 命中 / 低估 各占多少（门 §5.11 判定五要求双向报告）
  2. **误差量级**：|K̂ - K_true| 的分布，以及 K̂ 与真值的相关性
  3. **危险象限**：低估（会把真值挡在上限之外）与高估（会在下限约束下挡路）分别多少

**只读数，不开处方。**
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_HERE = Path(__file__).resolve().parent
for _p in (ROOT / "services" / "core" / "src", _HERE):
    sys.path.insert(0, str(_p))

from diarization_cache import EmbeddingCache  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

CAP = 8


def estimates(vecs: np.ndarray) -> dict:
    """一个会话上估计器的全部读数（不改任何生产代码）。"""
    d = sp.pairwise_distances(vecs)
    fit = sp.fit_distance_mixture(d)
    if not fit.get("ok"):
        return {"ok": False, "reason": fit.get("reason")}
    w_same = max(float(fit["weight"][0]), 1e-6)
    raw = 1.0 / w_same
    k_hat = int(max(1, min(round(raw), CAP)))
    # 备选读数：不加 cap、不取整的连续量（供"软约束"路线参考）
    return {
        "ok": True,
        "w_same": w_same,
        "k_raw": float(raw),
        "k_hat": k_hat,
        "separation": float(fit["separation"]),
        "mu_same": float(fit["mu"][0]),
        "mu_diff": float(fit["mu"][1]),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diag", required=True)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    diag = json.loads(Path(args.diag).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rows = []
    for name, e in sorted(diag.get("meetings", {}).items()):
        cond = e.get("conditions", {}).get(args.condition)
        if not cond or "cache_key" not in cond:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None:
            continue
        est = estimates(np.asarray(hit[0], dtype=np.float64))
        if not est.get("ok"):
            continue
        est["name"] = name
        est["k_true"] = int(e["ref_speakers"])
        est["err"] = est["k_hat"] - est["k_true"]
        rows.append(est)

    label = args.label or args.diag
    n = len(rows)
    print("=== %s  n=%d ===" % (label, n))
    if not rows:
        return 0
    err = np.array([r["err"] for r in rows])
    hit = int((err == 0).sum())
    over = int((err > 0).sum())
    under = int((err < 0).sum())
    print("  命中 %d/%d (%.0f%%)   高估 %d (%.0f%%)   低估 %d (%.0f%%)"
          % (hit, n, 100 * hit / n, over, 100 * over / n, under, 100 * under / n))
    print("  偏差 err=K_hat-K_true: mean=%+.2f median=%+.2f  |err| mean=%.2f p90=%.1f max=%.1f"
          % (err.mean(), float(np.median(err)), np.abs(err).mean(),
             float(np.percentile(np.abs(err), 90)), float(np.abs(err).max())))
    kt = np.array([r["k_true"] for r in rows], dtype=float)
    kh = np.array([r["k_hat"] for r in rows], dtype=float)
    if len(set(kt.tolist())) > 1 and len(set(kh.tolist())) > 1:
        print("  Pearson r(K_hat, K_true) = %.3f" % float(np.corrcoef(kt, kh)[0, 1]))
    print()
    print("  按 K_true 分组:")
    for k in sorted(set(r["k_true"] for r in rows)):
        sub = [r for r in rows if r["k_true"] == k]
        e2 = np.array([r["err"] for r in sub])
        h = int((e2 == 0).sum())
        print("    K_true=%2d  n=%3d  命中 %2d  高估 %2d  低估 %2d   median K_hat=%.1f"
              % (k, len(sub), h, int((e2 > 0).sum()), int((e2 < 0).sum()),
                 float(np.median([r["k_hat"] for r in sub]))))
    print()
    print("  危险象限（门 §5.11 判定五要求双向报告）:")
    low = [r for r in rows if r["k_hat"] < r["k_true"]]
    high = [r for r in rows if r["k_hat"] > r["k_true"]]
    print("    低估（真值会被**上限**挡在候选外）: %d/%d = %.0f%%" % (len(low), n, 100 * len(low) / n))
    print("    高估（真值会被**下限**挡在候选外）: %d/%d = %.0f%%" % (len(high), n, 100 * len(high) / n))
    if args.out:
        Path(args.out).write_text(json.dumps({"label": label, "rows": rows},
                                             ensure_ascii=False, indent=2), encoding="utf-8")
        print()
        print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
