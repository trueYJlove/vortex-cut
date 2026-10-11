"""W2.2 阈值策略 spike 之二：**逐录音归一化**能否替代"猜阈值"？

动机：固定的全局 τ 之所以不可用，是因为**距离分布逐录音漂移**。
若把每个录音的距离分布归一化掉，一个全局阈值就可能重新成立。

两个变体（都用已缓存的 embedding，不重跑推理）：
  A. 均值中心化：v ← (v − mean(v)) / ‖·‖（说话人验证里的标准做法）
  B. 距离秩归一化：把两两余弦距离映射到 [0,1] 的秩空间，再聚类

对照：原始嵌入 + 同样的策略（即上一轮结果）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from spikes.w22_speaker.cluster import build_dendrogram, labels_at  # noqa: E402
from spikes.w22_speaker.der import load_rttm, score  # noqa: E402
from spikes.w22_speaker.threshold_strategies import FINE_TAU, windows_to_turns  # noqa: E402

SR = 16000


def centroised(v: np.ndarray) -> np.ndarray:
    c = v - v.mean(axis=0, keepdims=True)
    return c / np.maximum(np.linalg.norm(c, axis=1, keepdims=True), 1e-12)


def rank_normalised_dendro(v: np.ndarray):
    """把两两距离换成秩（[0,1]），用"秩距离"建树——等价于自适应尺度。"""
    x = v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)
    d = 1.0 - x @ x.T
    iu = np.triu_indices(d.shape[0], k=1)
    order = np.argsort(np.argsort(d[iu]))
    ranks = order / max(1, (iu[0].size - 1))
    full = np.zeros_like(d)
    full[iu] = ranks
    d = full + full.T
    np.fill_diagonal(d, np.inf)
    n = d.shape[0]
    active = np.ones(n, dtype=bool)
    sizes = np.ones(n, dtype=np.int64)
    merges: list[tuple[int, int, float]] = []
    for _ in range(n - 1):
        flat = int(np.argmin(d))
        i, j = divmod(flat, n)
        val = float(d[i, j])
        if not np.isfinite(val):
            break
        merges.append((i, j, val))
        si, sj = int(sizes[i]), int(sizes[j])
        for k in range(n):
            if not active[k] or k in (i, j):
                continue
            new = (d[i, k] * si + d[j, k] * sj) / (si + sj)
            d[i, k] = d[k, i] = new
        sizes[i] = si + sj
        active[j] = False
        d[j, :] = np.inf
        d[:, j] = np.inf
        d[i, i] = np.inf
    from spikes.w22_speaker.cluster import Dendrogram  # noqa: E402

    return Dendrogram(n, merges)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup-dir", required=True)
    ap.add_argument("--out", default=".tmp/normalization-experiment.json")
    args = ap.parse_args()
    setup = Path(args.setup_dir)
    rttm_of = {}
    for part in ("test", "dev", "train"):
        for p in (setup / "only_words" / "rttms" / part).glob("*.rttm"):
            rttm_of.setdefault(p.stem, p)

    report: dict = {"variants": {}}
    cache_dir = Path(".tmp/strat-cache")
    for variant in ("raw", "centred", "rank"):
        per: dict = {}
        for cache in sorted(cache_dir.glob("*.npz")):
            meeting, model = cache.stem.split("-")[0], cache.stem.split("-")[1]
            rttm = rttm_of.get(meeting)
            if rttm is None:
                continue
            vecs = np.load(cache)["vecs"]
            ref = load_rttm(rttm)
            info = json.loads((Path(".tmp") / "ami-report.json").read_text(encoding="utf-8"))
            total_s = info["meetings"][meeting]["total_s"]
            # 窗口需与缓存一致：重建同一组 silero 窗（用缓存长度校验）
            wins_file = Path(".tmp") / "strat-windows.json"
            windows = json.loads(wins_file.read_text(encoding="utf-8"))[meeting]
            wins = [(w[0], w[1]) for w in windows]
            assert len(wins) == vecs.shape[0], (meeting, len(wins), vecs.shape[0])

            if variant == "raw":
                dendo = build_dendrogram(vecs)
            elif variant == "centred":
                dendo = build_dendrogram(centroised(vecs))
            else:
                dendo = rank_normalised_dendro(vecs)

            curve = {}
            for tau in FINE_TAU:
                hyp = windows_to_turns(wins, labels_at(dendo, tau), total_s)
                curve[f"{tau:.2f}"] = round(score(ref, hyp, total_s=total_s).der, 4)
            best = min(curve, key=lambda k: curve[k])
            per[f"{meeting}/{model}"] = {
                "oracle_tau": float(best), "oracle_der": curve[best],
                "fixed_0.45": curve["0.46"] if variant == "rank" else curve["0.46"],
                "curve": curve,
            }
            print(f"[{variant}] {meeting}/{model}: oracle {curve[best]*100:.1f}% @tau={best}")
        report["variants"][variant] = per
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
