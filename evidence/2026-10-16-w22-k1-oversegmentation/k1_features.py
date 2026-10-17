"""区分力探测（诊断，不立规则）：K_true=1 vs K_true=2 能否用廉价信号分开？

候选信号（全部可从现有窗向量算出、无自由参数）：
  Sa  silhouette(K=2)          —— 单人素材的两簇本该更"不该分"
  Sb  K=2 两簇质心余弦距离
  Sc  K=2 两簇份额比 min/max
  Sd  窗数 n_windows
判读：若两组**分布重叠**，则"没有廉价信号可分" —— 这是有价值的负结果。
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


def l2(v):
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def split_k2(vecs):
    """在 K=2 处取一个**与准则无关**的确定性分割：按第一主成分符号。"""
    x = l2(vecs)
    xc = x - x.mean(axis=0, keepdims=True)
    u, s, vt = np.linalg.svd(xc, full_matrices=False)
    proj = xc @ vt[0]
    return (proj > 0).astype(int)


def main() -> int:
    rows = json.loads(RES.read_text(encoding="utf-8"))
    feats = []
    for r in rows:
        m = r["meeting"]
        dbp = WORK / f"_db_{m}.db"
        if not dbp.is_file():
            continue
        db = Database(dbp)
        with db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,windows_json FROM speaker_diarizations "
                "ORDER BY created_at DESC LIMIT 1").fetchone()
        if row is None or row[0] is None:
            continue
        windows = json.loads(row[1] or "[]")
        n = len(windows)
        flat = decode_embeddings(row[0])
        dim = flat.size // n if n else 0
        if dim <= 0 or n < 4:
            continue
        vecs = flat.reshape(n, dim)
        lab = split_k2(vecs)
        if len(set(lab.tolist())) < 2:
            continue
        x = l2(vecs)
        d = 1.0 - x @ x.T
        sil = sp.silhouette(d, lab)
        c0 = l2(vecs[lab == 0].mean(axis=0, keepdims=True))[0]
        c1 = l2(vecs[lab == 1].mean(axis=0, keepdims=True))[0]
        cent = float(1.0 - c0 @ c1)
        cnt = Counter(lab.tolist())
        share_ratio = min(cnt.values()) / max(cnt.values())
        feats.append({"meeting": m, "k_true": r["k_true"], "k_hat": r["k_hat"],
                      "der": r["der_T"], "Sa_silhouette_k2": round(sil, 4),
                      "Sb_centroid_dist": round(cent, 4),
                      "Sc_share_ratio": round(share_ratio, 4),
                      "Sd_n_windows": n})

    s1 = [f for f in feats if f["k_true"] == 1]
    s2 = [f for f in feats if f["k_true"] == 2]
    print(f"K_true=1: n={len(s1)}   K_true=2: n={len(s2)}\n")

    print("=== 各信号在两组上的分布（看是否重叠）===")
    for key in ("Sa_silhouette_k2", "Sb_centroid_dist", "Sc_share_ratio", "Sd_n_windows"):
        a = np.array([f[key] for f in s1], dtype=float)
        b = np.array([f[key] for f in s2], dtype=float)
        print(f"\n  {key}")
        print(f"    Kt=1: min={a.min():>8.4f} 中位={np.median(a):>8.4f} max={a.max():>8.4f}")
        print(f"    Kt=2: min={b.min():>8.4f} 中位={np.median(b):>8.4f} max={b.max():>8.4f}")
        overlap = not (a.max() < b.min() or b.max() < a.min())
        print(f"    分布重叠: {overlap}")

    # 最简单的可用判据：取某阈值看最佳命中
    print("\n=== 若硬取单一阈值，最佳可能的区分（仍会重叠）===")
    for key, direction in (("Sa_silhouette_k2", "low"), ("Sc_share_ratio", "high")):
        vals = sorted({f[key] for f in feats})
        best = None
        for t in vals:
            if direction == "low":
                pred1 = {f["meeting"] for f in feats if f[key] <= t and f["k_true"] == 1}
                tot1 = len(s1)
                fp = sum(1 for f in feats if f[key] <= t and f["k_true"] >= 2)
            else:
                pred1 = {f["meeting"] for f in feats if f[key] >= t and f["k_true"] == 1}
                tot1 = len(s1)
                fp = sum(1 for f in feats if f[key] >= t and f["k_true"] >= 2)
            hit = len(pred1)
            if best is None or (hit - fp) > (best[0] - best[1]):
                best = (hit, fp, t)
        print(f"  {key}: 最佳 = 命中 {best[0]}/{tot1}, 假阳 {best[1]}, 阈值={best[2]:.4f}")

    (Path(__file__).resolve().parent / "k1_features.json").write_text(
        json.dumps(feats, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n落盘 -> k1_features.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
