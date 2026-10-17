"""机制诊断：K_true=1 的素材为何被切成 K_hat=7/8？（不开处方，只测量）

用已落库的真实窗向量，检查三个候选机制：
  M1 窗数太少 -> 聚类无约束（对比 n_windows 与 K_hat 的关系）
  M2 阈值区间 -> tau 处其实有大簇可并（比较 tau 与更高 tau 的 K 曲线）
  M3 单说话人素材本身异质（音频内噪声/音乐段）
同时报：把 tau 提高到某个值能否自然收敛到 K=1。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))

import numpy as np

from aivs_core.database import Database
from aivs_core.media import speaker as sp
from aivs_core.media.speaker_service import decode_embeddings

WORK = REPO / ".tmp" / "_khat_tier"
RES = REPO / "evidence/2026-10-16-w22-khat-tiering-gate/result.json"

TAUS = [round(0.2 + 0.05 * i, 2) for i in range(13)]  # 0.20..0.80


def main() -> int:
    rows = json.loads(RES.read_text(encoding="utf-8"))
    k1 = [r for r in rows if r["k_true"] == 1]
    print(f"K_true=1 共 {len(k1)} 场\n")
    print(f"{'meeting':<8} {'nWin':>5} {'Khat':>5} {'tau':>5} | "
          f"{'K@tau':>6} {'K@0.60':>7} {'K@0.70':>7} {'K@0.80':>7} | {'巨簇份额':>8}")
    print("-" * 78)

    out = []
    for r in k1:
        m = r["meeting"]
        db = Database(WORK / f"_db_{m}.db")
        with db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,threshold,windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None or row[0] is None:
            print(f"{m:<8} (no blob)")
            continue
        windows = json.loads(row[2] or "[]")
        n = len(windows)
        flat = decode_embeddings(row[0])
        dim = flat.size // n if n else 0
        vecs = flat.reshape(n, dim)
        tau = float(row[1])
        dendro = sp.build_dendrogram(vecs)

        def k_at(t: float) -> int:
            return int(np.unique(sp.labels_at(dendro, t)).size)

        lab = sp.labels_at(dendro, tau)
        cnt = Counter(lab.tolist())
        dom = max(cnt.values()) / len(lab)

        print(f"{m:<8} {n:>5} {r['k_hat']:>5} {tau:>5.2f} | "
              f"{k_at(tau):>6} {k_at(0.60):>7} {k_at(0.70):>7} {k_at(0.80):>7} | {dom:>8.3f}")
        out.append({"meeting": m, "n_windows": n, "k_hat": r["k_hat"], "tau": tau,
                    "k_curve": {f"{t:.2f}": k_at(t) for t in TAUS},
                    "dominant_share": round(dom, 4), "der": r["der_T"],
                    "oracle": r["der_oracle"], "duration_s": r["duration_s"]})

    # 汇总
    print("\n=== M1：窗数与 K_hat 的关系 ===")
    ns = [o["n_windows"] for o in out]
    ks = [o["k_hat"] for o in out]
    print(f"  n_windows: {sorted(ns)}")
    print(f"  K_hat    : {sorted(ks)}")

    print("\n=== M2：tau 曲线上是否存在更低 K 的可行点 ===")
    for o in out:
        ks_curve = o["k_curve"]
        minimal = min(ks_curve.values())
        print(f"  {o['meeting']:<8} K@tau={o['k_hat']:<2} "
              f"曲线最小值={minimal:<2} 能否自然降到 K=1: "
              f"{'是' if minimal == 1 else '否'}")

    print("\n=== M3：巨簇份额（是否已接近单一说话人）===")
    for o in sorted(out, key=lambda x: x["dominant_share"]):
        print(f"  {o['meeting']:<8} 巨簇={o['dominant_share']:.3f} DER={o['der']:.4f}")

    (Path(__file__).resolve().parent / "k1_mechanism.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n落盘 -> k1_mechanism.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
