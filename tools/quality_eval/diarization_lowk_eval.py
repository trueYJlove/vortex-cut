r"""O6 定案实验：在 **低人数档（K=1..3）** 上验证候选选择规则。

**要回答的唯一问题**（门 §10 O6）：
    在语料真值覆盖 1–3 人（产品主场景）时，
    「过闸门的最优规则」是否仍优于现行 silhouette？

**判定口径（先于跑数定死，避免事后挑口径）**：
  · 主读数：K<=3 子集的 **mean / worst**（门限沿用 40% / 55%）
  · 对照读数：K=4..6 子集（与既有语料重叠档，用于确认实现一致）
  · 取参一律**自动**（不偷看真值）：τ 来自各规则

本脚本只跑**现行 silhouette** 与其**上界 oracle**（同候选集），
因为"候选规则"的对比在 low-K 上需要先有 K̂ 来源（见 §5.6 的 B1 规则）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tools"))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402


def der_at(wins, labels, ref, total_s: float) -> float:
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
    return float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diag-json", required=True)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--audio-ext", default=".wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--k-low-max", type=int, default=3)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rttm_of: dict = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    rep: dict = {"per_meeting": {}}
    for m in sorted(diag.get("meetings", {})):
        e = diag["meetings"][m]
        cond = e.get("conditions", {}).get(args.condition)
        if not cond or "best" not in cond or m not in rttm_of:
            continue
        ref = load_rttm(rttm_of[m])
        args.meeting = m
        wins = _windows_for(e, args.condition, e["total_s"], ref, args)
        if wins is None:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None or hit[0].shape[0] != len(wins):
            print(f"[{m}] SKIP mismatch", flush=True)
            continue
        vecs = hit[0]
        den = sp.build_dendrogram(vecs)
        x = np.asarray(vecs, dtype=np.float64)
        x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
        dmat = 1.0 - x @ x.T

        grid = []
        for tau in sp.TAU_GRID:
            labels = sp.labels_at(den, tau)
            k = int(np.unique(labels).size)
            # silhouette 无定义（>40 簇）**显式排除**，不让 -1 哨兵参与排序
            sil = sp.silhouette(dmat, labels) if 2 <= k <= sp.MAX_SILHOUETTE_CLUSTERS else None
            grid.append(
                {
                    "tau": round(float(tau), 2),
                    "k": k,
                    "der": der_at(wins, labels, ref, e["total_s"]),
                    "sil": sil,
                }
            )
        kt = int(e["ref_speakers"])
        cand = [g for g in grid if 2 <= g["k"] <= sp.DEFAULT_K_MAX]
        best = min(cand, key=lambda g: g["der"])
        sup = max((g for g in cand if g["sil"] is not None), key=lambda g: g["sil"])
        rep["per_meeting"][m] = {
            "k_true": kt,
            "oracle": round(best["der"], 4),
            "oracle_k": best["k"],
            "silhouette": round(sup["der"], 4),
            "silhouette_k": sup["k"],
            "grid": grid,
        }
        print(
            f"[{m}] k_true={kt} sil(K={sup['k']})={sup['der']:.4f} "
            f"oracle(K={best['k']})={best['der']:.4f}",
            flush=True,
        )
        Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")

    for lo, hi, tag in (
        (1, args.k_low_max, f"K<={args.k_low_max}(O6缺口)"),
        (args.k_low_max + 1, 99, f"K>{args.k_low_max}(对照)"),
    ):
        sub = [v for v in rep["per_meeting"].values() if lo <= v["k_true"] <= hi]
        if not sub:
            continue
        s = np.array([v["silhouette"] for v in sub])
        o = np.array([v["oracle"] for v in sub])
        ks = [v["k_true"] for v in sub]
        print(f"\n[{tag}] n={len(sub)}  K 分布={sorted(set(ks))}")
        print(
            f"   silhouette(现行): mean={s.mean():.4f} worst={s.max():.4f} "
            f"mean<=40%={s.mean() <= 0.40} worst<=55%={s.max() <= 0.55}"
        )
        print(f"   oracle(上界)    : mean={o.mean():.4f} worst={o.max():.4f}")
        rep.setdefault("summary", {})[tag] = {
            "n": len(sub),
            "k_values": sorted(set(ks)),
            "silhouette_mean": round(float(s.mean()), 4),
            "silhouette_worst": round(float(s.max()), 4),
            "oracle_mean": round(float(o.mean()), 4),
            "oracle_worst": round(float(o.max()), 4),
        }
    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
