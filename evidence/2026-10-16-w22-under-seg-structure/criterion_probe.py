"""决定性测量：欠分割场里，生产准则（silhouette+capK）为何停在 K=2？

候选若要作用在「准则」上，必须先分清两种机制：
  (i)  **方向反了**：silhouette 把 K=2 判得比 K_true 更优（准则可修）
  (ii) **可达性**：正确答案不在候选集里（准则修不了）

方法：从生产 probe 库读回落库的**真实 CAM++ 窗向量**（`embeddings_blob`），
用生产纯函数 `build_dendrogram` / `labels_at` / `silhouette` / `pairwise_distances`
在 τ 网格上重放**与生产同口径**的选择过程，分别报：
  - 准则在 K=2 与 K=K_true 处的 silhouette 值；
  - 每场的 silhouette 曲线最优 K（准则想选的）与配对的 DER 口径无关（只报准则侧）。
零生产代码改动（只读 + 调用纯函数）。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services" / "core" / "src"))

import numpy as np  # noqa: E402

from aivs_core.database import Database  # noqa: E402
from aivs_core.media import speaker as sp  # noqa: E402
from aivs_core.media.speaker_service import decode_embeddings  # noqa: E402

PROBE = REPO / ".tmp" / "_share_probe_all"
S3 = REPO / "evidence/2026-10-14-w22-s3-production-gate/result.json"

TAU_GRID = [round(0.20 + 0.02 * i, 2) for i in range(31)]  # 0.20..0.80


def main() -> int:
    s3 = json.loads(S3.read_text(encoding="utf-8"))
    pm = s3["corpora"]["ami"]["per_meeting"]
    targets = [m for m, v in sorted(pm.items()) if v["speaker_count"] <= v["k_true"] - 2]
    print(f"AMI 欠分割场: {len(targets)}\n")

    hdr = (f"{'meeting':<10} {'Khat':>4} {'Ktru':>5} {'sil@2':>8} {'sil@Kt':>8} "
           f"{'argmaxK':>8} {'dom':>7} {'bigCluD':>8}")
    print(hdr)
    print("-" * len(hdr))

    rows = []
    for m in targets:
        dbp = PROBE / f"_db_{m}.db"
        if not dbp.is_file():
            print(f"{m:<10} (无 probe 库)")
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,threshold,windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None or row[0] is None:
            print(f"{m:<10} (无 embedding blob)")
            continue
        n_windows = len(json.loads(row[2] or "[]"))
        flat = decode_embeddings(row[0])          # 扁平 float64
        dim = flat.size // n_windows if n_windows else 0
        if dim <= 0:
            print(f"{m:<10} (blob 与窗数不匹配)")
            continue
        vecs = flat.reshape(n_windows, dim)       # 与生产 _matrix 同口径
        k_hat = pm[m]["speaker_count"]
        k_true = pm[m]["k_true"]

        # 生产口径：构建树 → 在 τ 网格上取割 → 算 silhouette
        dendro = sp.build_dendrogram(vecs)
        best_k, best_sil, curve = None, -2.0, {}
        for tau in TAU_GRID:
            labels = sp.labels_at(dendro, tau)
            k = int(len(np.unique(labels)))
            if not (2 <= k <= sp.DEFAULT_K_MAX):
                continue
            # 同一 k 对应 τ 网格上多个点（阈值区间），取 silhouette 最大者
            dmat = sp.pairwise_distances_2d(vecs) if hasattr(sp, "pairwise_distances_2d") \
                else None
            if dmat is None:
                d = sp.pairwise_distances(vecs)
                n = vecs.shape[0]
                dmat = np.zeros((n, n))
                iu = np.triu_indices(n, k=1)
                dmat[iu] = d
                dmat[(iu[1], iu[0])] = d
            s = sp.silhouette(dmat, labels)
            if s > curve.get(k, -2.0):
                curve[k] = s
            if s > best_sil:
                best_sil, best_k = s, k

        # 巨簇份额与簇内平均距离（K=2 解）
        lab2 = sp.labels_at(dendro, float(row[1]))
        cnt = Counter(lab2.tolist())
        big = max(cnt, key=cnt.get)
        idx = np.where(lab2 == big)[0]
        dom = cnt[big] / len(lab2)
        d_in = sp.pairwise_distances(vecs[idx])
        bigd = float(np.mean(d_in)) if d_in.size else float("nan")

        print(f"{m:<10} {k_hat:>4} {k_true:>5} {curve.get(2, float('nan')):>8.4f} "
              f"{curve.get(k_true, float('nan')):>8.4f} {str(best_k):>8} "
              f"{dom:>7.4f} {bigd:>8.4f}")
        rows.append({"meeting": m, "k_hat": k_hat, "k_true": k_true,
                     "sil_curve": {str(k): round(v, 4) for k, v in sorted(curve.items())},
                     "argmax_k": best_k, "dom_share": round(dom, 4),
                     "big_cluster_mean_dist": round(bigd, 4)})

    out = Path(__file__).resolve().parent / "criterion_probe.json"
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n落盘 {len(rows)} 行 -> {out}")

    # 汇总判据：准则是否在 K=2 处给出比 K_true 更高的 silhouette
    bad = [r for r in rows if r["sil_curve"].get("2", -9) > r["sil_curve"].get(str(r["k_true"]), -9)]
    print(f"\n准则方向检查：sil(2) > sil(K_true) 的场次 = {len(bad)}/{len(rows)}")
    for r in bad:
        print(f"   {r['meeting']}: sil(2)={r['sil_curve']['2']} > "
              f"sil(K_true={r['k_true']})={r['sil_curve'].get(str(r['k_true']))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
