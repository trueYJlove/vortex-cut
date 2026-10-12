"""方案 A 的复算脚本（可重跑）：产出 ceiling / kmeans / separability 三份 JSON。

对应证据 `evidence/2026-10-12-w22-a-diagnosis/`。**只读缓存与 RTTM，不重跑 ONNX**
（embedding 命中 `.tmp/w22-embedding-cache`；未命中会重算，故首次运行较慢）。

三个实验：
1. `ceiling`：完美聚类天花板（每窗给主导参考说话人）—— 检验窗栅格+轮次化是否是瓶颈
2. `kmeans`：同 embedding 下 AHC(最优τ) vs k-means(真值 K) —— 分离聚类算法 vs embedding
3. `separability`：同人/异人窗距离分布 —— 量化 embedding 可分性
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

from diarization import FRAME_S, load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402


def ref_frames(ref, total_s: float):
    """每帧的 (参考说话人数, 参考说话人 id 或 -1)。"""
    n = int(total_s / FRAME_S)
    cnt = np.zeros(n, dtype=np.int32)
    own = np.full(n, -1, dtype=np.int32)
    spk = {s: i for i, s in enumerate(sorted({r[2] for r in ref}))}
    for a, b, s in ref:
        ia, ib = max(0, int(a / FRAME_S)), min(n, int(b / FRAME_S))
        cnt[ia:ib] += 1
        cur = own[ia:ib]
        own[ia:ib] = np.where(cur == -1, spk[s], cur)
    return cnt, own


def oracle_regions(ref, gap_s: float = 0.5):
    if not ref:
        return []
    spans = sorted((a, b) for a, b, _ in ref)
    out = [list(spans[0])]
    for a, b in spans[1:]:
        if a - out[-1][1] <= gap_s:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def oracle_select(grid, regions, min_speech_fraction: float):
    sel = []
    for i, (a, b) in enumerate(grid):
        cov = sum(max(0.0, min(b, e) - max(a, s)) for s, e in regions)
        if cov / (b - a) >= min_speech_fraction:
            sel.append(i)
    return sel


def kmeans_cosine(vecs: np.ndarray, k: int, *, iters: int = 300, restarts: int = 20,
                  seed: int = 0) -> np.ndarray:
    """余弦空间 k-means（确定性多起点 + k-means++ 初始化）。**对照用，非调优实现**。"""
    x = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    n = x.shape[0]
    rng = np.random.default_rng(seed)
    best_lab, best_inertia = None, np.inf
    for _ in range(restarts):
        idx = [int(rng.integers(n))]
        for _ in range(1, k):
            d = np.min(1.0 - x @ x[idx].T, axis=1)
            p = np.maximum(d, 0) ** 2
            p = p / p.sum() if p.sum() > 0 else np.ones(n) / n
            idx.append(int(rng.choice(n, p=p)))
        centers = x[idx].copy()
        lab = None
        for _ in range(iters):
            new = (x @ centers.T).argmax(axis=1)
            if lab is not None and (new == lab).all():
                break
            lab = new
            for kk in range(k):
                m = lab == kk
                if m.sum() > 0:
                    centers[kk] = x[m].mean(axis=0)
        inertia = float((1.0 - (x * centers[lab]).sum(axis=1)).sum())
        if inertia < best_inertia:
            best_inertia, best_lab = inertia, lab
    return best_lab


def turns_of(wins, labels, total_s, min_turn_s):
    t = sp.windows_to_turns(wins, labels, total_s, min_turn_s=min_turn_s)
    return [(x["start_us"] / 1e6, x["end_us"] / 1e6, f"spk{x['speaker']}") for x in t]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", choices=["ami", "aishell4"], required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--diag-json", default=None,
                    help="diag 报告（含 oracle_vad 缓存键）；缺则只跑 ceiling/separability")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cache = EmbeddingCache(args.cache_dir)
    rttm_of = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)
    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8")) if args.diag_json else {}

    report = {"corpus": args.corpus, "ceiling": {}, "kmeans": {}, "separability": {}}
    for m in args.meetings:
        rttm = rttm_of.get(m)
        if rttm is None:
            continue
        ref = load_rttm(rttm)
        total_s = 0.0
        if args.diag_json:
            total_s = diag.get("meetings", {}).get(m, {}).get("total_s", 0.0)
        if not total_s:
            continue
        cnt, own = ref_frames(ref, total_s)
        grid = sp.window_grid(total_s, sp.WINDOW_S, sp.HOP_S)
        regions = oracle_regions(ref)
        sel = oracle_select(grid, regions, sp.MIN_SPEECH_FRACTION)
        wins = [grid[i] for i in sel]
        k_true = len({r[2] for r in ref})

        # --- 1) 完美聚类天花板 ---
        labels = []
        for a, b in wins:
            seg = own[int(a / FRAME_S):int(b / FRAME_S)]
            v, c = np.unique(seg[seg >= 0], return_counts=True)
            labels.append(int(v[np.argmax(c)]) if v.size else -1)
        r = score(ref, turns_of(wins, np.array(labels), total_s, sp.MIN_TURN_S), total_s=total_s)
        report["ceiling"][m] = {"der": round(r.der, 4), "miss": round(r.miss, 4),
                                "spkerr": round(r.speaker_error, 4),
                                "ref_speakers": k_true, "windows": len(wins)}

        # --- 2) k-means vs AHC（需缓存键） ---
        key = (diag.get("meetings", {}).get(m, {}).get("conditions", {})
               .get("oracle_vad", {}).get("cache_key"))
        if key:
            hit = cache.get(key)
            if hit is not None and hit[0].shape[0] == len(wins):
                vecs = hit[0]
                den = sp.build_dendrogram(vecs)
                best_ahc = min(
                    score(ref, turns_of(wins, sp.labels_at(den, t), total_s, sp.MIN_TURN_S),
                          total_s=total_s).der
                    for t in sp.TAU_GRID
                )
                km = kmeans_cosine(vecs, k_true)
                der_km = score(ref, turns_of(wins, km, total_s, sp.MIN_TURN_S),
                               total_s=total_s).der
                report["kmeans"][m] = {"k_true": k_true, "ahc_best_tau": round(best_ahc, 4),
                                       "kmeans_true_k": round(der_km, 4)}
                # --- 3) 可分性（仅纯单人窗） ---
                keep, lab = [], []
                for k, (a, b) in enumerate(wins):
                    seg = own[int(a / FRAME_S):int(b / FRAME_S)]
                    if seg.size == 0 or (seg >= 0).mean() < 0.80:
                        continue
                    v, c = np.unique(seg[seg >= 0], return_counts=True)
                    if v.size == 0:
                        continue
                    keep.append(k)
                    lab.append(int(v[np.argmax(c)]))
                if len(keep) >= 8:
                    v = vecs[keep]
                    v = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
                    dm = 1.0 - v @ v.T
                    lab = np.array(lab)
                    same, diff = [], []
                    for i in range(len(lab)):
                        for j in range(i + 1, len(lab)):
                            (same if lab[i] == lab[j] else diff).append(dm[i, j])
                    if same and diff:
                        same, diff = np.array(same), np.array(diff)
                        thr = np.percentile(same, 90)
                        report["separability"][m] = {
                            "pure_windows": len(keep), "same_mean": round(float(same.mean()), 4),
                            "diff_mean": round(float(diff.mean()), 4),
                            "overlap": round(float((diff < thr).mean()), 4)}
        print(f"[{m}] done", flush=True)

    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
