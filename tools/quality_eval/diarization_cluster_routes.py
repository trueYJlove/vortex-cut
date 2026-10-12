"""W2.2 后续步骤② —— **不偷看真值 K** 的聚类族替换试验（双语料）。

**要回答的两个决策问题**（用户 2026-10-12 同意）：
1. 中文侧最差场能否靠换聚类族救回来？
2. VBx 级方案（B）是否值得上？

**为什么必须"不偷看真值 K"**：方案 A 测出的"12.9 点余量"用的是**真值 K**
（`k-means(真值 K)`），而**产品拿不到 K**。本脚本把 K 的估计也交给算法，
才是可产品化的口径。若自动 K 版本拿不到余量，则 B 的价值主张不成立。

对照的三条路线（都在**同一批 embedding** 上，只换聚类）：

| 路线 | K 的来源 | 说明 |
|---|---|---|
| `ahc_silhouette_capk` | 隐式（τ 网格 + silhouette + 簇数上限） | **现行对照**（S1 路线①） |
| `kmeans_silhouette` | **自动**：K=2..k_max 上取 silhouette 最大 | 换聚类族 + 自动 K |
| `kmeans_elbow` | **自动**：簇内距离平方和的"最大拐点" | 另一种自动 K 判据（与上者互为对照） |
| `kmeans_oracle_k` | **真值 K**（**仅上界参照，不可产品化**） | 复现方案 A 的 12.9 点，作为天花板 |

**口径**：每个条件（silero / oracle 窗）分别报，且**均值与最差场分开报**
（门 §5.2 已钉死：B 的验收不得只看均值）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tools"))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

K_RANGE = (2, 3, 4, 5, 6, 7, 8)
MIN_SF = sp.MIN_SPEECH_FRACTION


def _silero_voiced(audio: Path, model: str) -> np.ndarray:
    """重建 silero 的 10ms voiced 布尔（与产生缓存时同一模型/门限）。"""
    from spikes.w22_speaker.audio import decode_mono16k
    from spikes.w22_speaker.silero_vad import SileroVad

    samples = decode_mono16k(audio, 0.0, None, channel=_CHANNEL)
    return SileroVad(model).voiced_10ms(samples, hop_ms=10.0)


_CHANNEL: int | None = None


def _l2(mat: np.ndarray) -> np.ndarray:
    return mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)


def kmeans_cosine(vecs: np.ndarray, k: int, *, iters: int = 300, restarts: int = 10,
                  seed: int = 0) -> tuple[np.ndarray, float]:
    """余弦空间 k-means（确定性多起点 + k-means++）。返回 (标签, 簇内距离平方和)。"""
    x = _l2(vecs)
    n = x.shape[0]
    k = max(1, min(k, n))
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
    return best_lab, best_inertia


def silhouette_of(vecs: np.ndarray, labels: np.ndarray) -> float:
    """余弦距离上的轮廓系数（复用 Core 的块矩阵实现）。"""
    x = _l2(vecs)
    dmat = 1.0 - x @ x.T
    return sp.silhouette(dmat, labels)


def pick_k_silhouette(vecs: np.ndarray, *, k_range=K_RANGE, seed: int = 0) -> tuple[int, float]:
    """自动 K：在 k_range 上取 silhouette 最大者。"""
    best_k, best_s = k_range[0], -2.0
    for k in k_range:
        if k > vecs.shape[0]:
            break
        lab, _ = kmeans_cosine(vecs, k, seed=seed)
        if np.unique(lab).size < 2:
            continue
        s = silhouette_of(vecs, lab)
        if s > best_s:
            best_s, best_k = s, k
    return best_k, best_s


def pick_k_elbow(vecs: np.ndarray, *, k_range=K_RANGE, seed: int = 0) -> int:
    """自动 K：簇内距离平方和曲线的**最大拐点**（相邻下降量比值最大处）。"""
    ks, inertias = [], []
    for k in k_range:
        if k > vecs.shape[0]:
            break
        _, inertia = kmeans_cosine(vecs, k, seed=seed)
        ks.append(k)
        inertias.append(inertia)
    if len(ks) < 3:
        return ks[-1] if ks else K_RANGE[0]
    drops = np.array([inertias[i] - inertias[i + 1] for i in range(len(inertias) - 1)])
    # 最大拐点 = 下降量比值最大处（下一段相对上一段跌得最狠）
    ratios = drops[:-1] / np.maximum(drops[1:], 1e-12)
    return ks[int(np.argmax(ratios)) + 1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diag-json", required=True, help="含 oracle_vad 条件的诊断报告")
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", required=True, help="重建 silero 窗集合需要音频")
    ap.add_argument("--audio-ext", default=".Mix-Headset.wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--conditions", nargs="+", default=["silero_vad", "oracle_vad"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    global _CHANNEL
    _CHANNEL = args.channel
    cache = EmbeddingCache(args.cache_dir)
    rttm_of = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    report: dict = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "k_range": list(K_RANGE), "meetings": {}}

    for m in sorted(diag.get("meetings", {})):
        de = diag["meetings"][m]
        if "conditions" not in de or m not in rttm_of:
            continue
        ref = load_rttm(rttm_of[m])
        total_s = de["total_s"]
        k_true = de["ref_speakers"]
        audio = Path(args.audio_dir) / f"{m}{args.audio_ext}"
        entry: dict = {"k_true": k_true, "total_s": total_s, "conditions": {}}
        if not audio.exists():
            entry["error"] = f"audio missing: {audio.name}"
            report["meetings"][m] = entry
            continue
        for cond in args.conditions:
            dc = de["conditions"].get(cond)
            if not dc or "best" not in dc:
                continue
            key = dc["cache_key"]
            hit = cache.get(key)
            if hit is None:
                entry["conditions"][cond] = {"error": "cache miss"}
                continue
            vecs = hit[0]
            grid = sp.window_grid(total_s, sp.WINDOW_S, sp.HOP_S)
            # **优先用诊断报告落盘的窗集合**（精确且零成本）；
            # 仅当缺失时才回退到重建（oracle 用参考区段 / silero 重跑 VAD）。
            saved = de.get("window_grids", {}).get(cond)
            if saved:
                wins = [(float(a), float(b)) for a, b in saved]
            elif cond == "oracle_vad":
                from diarization_diagnose import oracle_select, ref_speech_regions
                wins = [grid[i] for i in oracle_select(
                    grid, ref_speech_regions(ref), sp.MIN_SPEECH_FRACTION)]
            else:
                # silero：**重新跑 VAD 重建窗集合**（诊断报告未落盘窗索引，而缓存只存向量）。
                # 这与产生该缓存时的选窗规则完全一致（同一 silero 模型、同一门限）。
                wins = [grid[i] for i in sp.select_windows(
                    grid, _silero_voiced(audio, args.silero), min_speech_fraction=MIN_SF)]
            if wins is None or len(wins) != vecs.shape[0]:
                entry["conditions"][cond] = {"error": "window grid mismatch",
                                             "rebuilt": len(wins) if wins else None,
                                             "cached": int(vecs.shape[0])}
                continue

            def der_of(labels):
                turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
                hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}")
                       for t in turns]
                return float(score(ref, hyp, total_s=total_s).der)

            # 路线1：AHC + silhouette + capK（现行对照）
            den = sp.build_dendrogram(vecs)
            tau, sname = sp.choose_threshold(den, vecs, k_max=sp.DEFAULT_K_MAX,
                                             strategy="silhouette_capk")
            r_ahc = der_of(sp.labels_at(den, tau))

            # 路线2：k-means + 自动 K（silhouette）
            k_sil, sil = pick_k_silhouette(vecs)
            lab_sil, _ = kmeans_cosine(vecs, k_sil)
            r_ksil = der_of(lab_sil)

            # 路线3：k-means + 自动 K（elbow）
            k_elb = pick_k_elbow(vecs)
            lab_elb, _ = kmeans_cosine(vecs, k_elb)
            r_kelb = der_of(lab_elb)

            # 路线4：k-means + 真值 K（上界参照）
            lab_or, _ = kmeans_cosine(vecs, k_true)
            r_kor = der_of(lab_or)

            entry["conditions"][cond] = {
                "windows": int(vecs.shape[0]),
                "ahc_silhouette_capk": {"der": round(r_ahc, 4), "tau": round(float(tau), 3)},
                "kmeans_silhouette": {"der": round(r_ksil, 4), "k": int(k_sil),
                                      "silhouette": round(float(sil), 4)},
                "kmeans_elbow": {"der": round(r_kelb, 4), "k": int(k_elb)},
                "kmeans_oracle_k": {"der": round(r_kor, 4), "k": int(k_true)},
            }
        report["meetings"][m] = entry
        c = entry["conditions"].get("oracle_vad", {})
        if "ahc_silhouette_capk" in c:
            print(f"[{m}] K真值={k_true} ahc={c['ahc_silhouette_capk']['der']:.3f} "
                  f"ksil(k={c['kmeans_silhouette']['k']})={c['kmeans_silhouette']['der']:.3f} "
                  f"kelb(k={c['kmeans_elbow']['k']})={c['kmeans_elbow']['der']:.3f} "
                  f"kor={c['kmeans_oracle_k']['der']:.3f}", flush=True)
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                  encoding="utf-8")

    # 汇总：均值与最差**分开**
    summary: dict = {}
    for cond in args.conditions:
        rows = [(m, e["conditions"][cond]) for m, e in report["meetings"].items()
                if cond in e["conditions"] and "ahc_silhouette_capk" in e["conditions"][cond]]
        if not rows:
            continue
        summary[cond] = {"n": len(rows), "routes": {}}
        for route in ("ahc_silhouette_capk", "kmeans_silhouette", "kmeans_elbow",
                      "kmeans_oracle_k"):
            ds = np.array([c[route]["der"] for _, c in rows])
            summary[cond]["routes"][route] = {
                "mean_der": round(float(ds.mean()), 4),
                "worst_der": round(float(ds.max()), 4),
                "mean_pass_40": bool(ds.mean() <= 0.40),
                "worst_pass_55": bool(ds.max() <= 0.55),
            }
    report["summary"] = summary
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== SUMMARY ===")
    for cond, s in summary.items():
        print(f"[{cond}] n={s['n']}")
        for route, v in s["routes"].items():
            print(f"  {route:24s} mean={v['mean_der']:.4f} worst={v['worst_der']:.4f} "
                  f"pass40={v['mean_pass_40']} pass55={v['worst_pass_55']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
