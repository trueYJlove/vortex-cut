"""W2.2 阈值策略 spike：**不靠真值**怎么给每段录音选 τ？

背景（AMI 4 场实测）：每场最优 τ 在 0.45–0.65，用真值调参平均 DER 30.1%，
但**固定 τ=0.45 时 58.8%、最差 94.5%** ⇒ 阈值策略是当前第一位的不可用点。
本脚本比较若干**无监督**选 τ 策略，看谁能逼近 oracle。

候选策略（都只看假设侧，不看参考标注）：
  fixed           固定 τ（基线）
  oracle          每场最优 τ（上界，用真值，仅作对照）
  gap_mid         合并距离序列**最大间隙**的中点
  gap_ratio       合并距离**相邻比值最大**处
  silhouette      轮廓系数最大（余弦距离）
  capK            "说话人数 ≤ K" 前提下取最大 τ（K=4/6/8）
  dist_pct        取两两窗距离的某个分位数
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from spikes.w22_speaker.audio import decode_mono16k  # noqa: E402
from spikes.w22_speaker.cluster import build_dendrogram, labels_at  # noqa: E402
from spikes.w22_speaker.der import FRAME_S, load_rttm, score  # noqa: E402
from spikes.w22_speaker.embedding import OnnxSpeakerEmbedder  # noqa: E402
from spikes.w22_speaker.silero_vad import SileroVad  # noqa: E402

SR = 16000
FINE_TAU = [round(0.20 + 0.02 * i, 2) for i in range(31)]  # 0.20 .. 0.80


def windows_to_turns(windows, labels, total_s, min_turn_s=0.40):
    n = int(round(total_s / FRAME_S))
    owner = np.full(n, -1, dtype=np.int64)
    best = np.full(n, np.inf)
    for (a, b), lab in zip(windows, labels):
        ia, ib = max(0, int(a / FRAME_S)), min(n, int(b / FRAME_S))
        if ib <= ia:
            continue
        t = (np.arange(ia, ib) + 0.5) * FRAME_S
        d = np.abs(t - (a + b) / 2.0)
        sel = d < best[ia:ib]
        idx = np.arange(ia, ib)[sel]
        best[idx] = d[sel]
        owner[idx] = lab
    runs = []
    start = 0
    for i in range(1, n + 1):
        if i == n or owner[i] != owner[start]:
            runs.append([start, i, int(owner[start])])
            start = i
    min_frames = int(min_turn_s / FRAME_S)
    for k, run in enumerate(runs):
        if run[1] - run[0] >= min_frames or run[2] == -1:
            continue
        run[2] = runs[k - 1][2] if k > 0 else (runs[k + 1][2] if k + 1 < len(runs) else -1)
    merged = []
    for run in runs:
        if merged and merged[-1][2] == run[2]:
            merged[-1][1] = run[1]
        else:
            merged.append(list(run))
    return [(a * FRAME_S, b * FRAME_S, f"spk{lab}") for a, b, lab in merged if lab != -1]


MAX_SILHOUETTE_CLUSTERS = 40


def silhouette(dmat: np.ndarray, labels: np.ndarray) -> float:
    """按**簇块**算轮廓系数（块内/块间均值各一次矩阵运算）。

    首版逐样本循环、内层还对每个簇做一次布尔索引 ⇒ 低阈值下簇数上百时退化为
    O(簇数 × 样本数) 次 numpy 调用，4 场会议直接跑不完。块矩阵版把每个 τ 降到
    O(簇数²) 次运算。
    """
    uniq = np.unique(labels)
    if uniq.size < 2 or uniq.size > MAX_SILHOUETTE_CLUSTERS:
        return -1.0
    masks = [labels == u for u in uniq]
    mean_to = np.empty((uniq.size, labels.size))
    for ci, mi in enumerate(masks):
        block = dmat[mi]
        for cj, mj in enumerate(masks):
            mean_to[cj, mi] = block[:, mj].mean(axis=1)
    own = np.empty(labels.size)
    other = np.full(labels.size, np.inf)
    for ci, mi in enumerate(masks):
        sub = mean_to[:, mi]
        own[mi] = sub[ci]
        for cj in range(uniq.size):
            if cj != ci:
                other[mi] = np.minimum(other[mi], sub[cj])
    denom = np.maximum(own, other)
    scores = np.where(denom > 0, (other - own) / np.maximum(denom, 1e-12), 0.0)
    return float(scores.mean())


def pick_strategies(dendro, vecs, tau_grid):
    merges = np.array([d for _, _, d in dendro.merges])
    out = {}
    if merges.size >= 3:
        gaps = np.diff(merges)
        i = int(np.argmax(gaps))
        out["gap_mid"] = float((merges[i] + merges[i + 1]) / 2)
        ratios = merges[1:] / np.maximum(merges[:-1], 1e-9)
        j = int(np.argmax(ratios))
        out["gap_ratio"] = float(merges[j + 1])
    v = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    dmat = 1.0 - v @ v.T
    best_sil, best_tau = -2.0, tau_grid[0]
    for tau in tau_grid:
        s = silhouette(dmat, labels_at(dendro, tau))
        if s > best_sil:
            best_sil, best_tau = s, tau
    out["silhouette"] = float(best_tau)
    # capK：取"簇数首次降到 ≤K"的**交叉 τ**（假设 K 位说话人）。
    # 首版取"≤K 的最大 τ"，在主网格（起点 0.20）上因簇数早已 ≤K 而退化到网格下界，
    # 结果全是 0.20（DER ~100%）——是策略实现错误，不是策略本身差。
    # 这里在更宽的网格上找交叉点；找不到（整段都 ≤K）则回退到网格上界。
    wide = [round(0.02 + 0.02 * i, 2) for i in range(45)]  # 0.02 .. 0.90
    for k in (4, 6, 8):
        crossing = None
        for tau in wide:
            if np.unique(labels_at(dendro, tau)).size <= k:
                crossing = tau
                break
        out[f"capK{k}"] = float(crossing if crossing is not None else wide[-1])
    dd = dmat[np.triu_indices(dmat.shape[0], k=1)]
    for p in (30, 50, 70):
        out[f"dist_pct{p}"] = float(np.percentile(dd, p))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup-dir", help="AMI diarization setup 目录（与 --rttm-dir 二选一）")
    ap.add_argument("--rttm-dir", help="扁平 RTTM 目录（AISHELL-4 等）")
    ap.add_argument("--audio-ext", default=None, help="音频扩展名；默认试 Mix-Headset.wav 与 .flac")
    ap.add_argument(
        "--channel", type=int, default=None,
        help="取单通道（多通道阵列必须给，避免下混梳状干涉）",
    )
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--models-dir", default=".tmp/spike-models")
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--models", nargs="+", default=["campplus"])
    ap.add_argument("--window-s", type=float, default=2.0)
    ap.add_argument("--hop-s", type=float, default=1.0)
    ap.add_argument("--min-speech-fraction", type=float, default=0.60)
    ap.add_argument("--out", default=".tmp/threshold-strategies.json")
    args = ap.parse_args()

    setup = Path(args.setup_dir) if args.setup_dir else Path(".")
    audio_dir = Path(args.audio_dir)
    models_dir = Path(args.models_dir)
    rttm_of = {}
    if args.rttm_dir:
        for p in Path(args.rttm_dir).glob("*.rttm"):
            rttm_of.setdefault(p.stem, p)
    else:
        for part in ("test", "dev", "train"):
            for p in (setup / "only_words" / "rttms" / part).glob("*.rttm"):
                rttm_of.setdefault(p.stem, p)

    report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "tau_grid": FINE_TAU, "meetings": {}, "models": args.models}
    windows_dump: dict[str, list] = {}
    sv = SileroVad(".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")

    exts = [args.audio_ext] if args.audio_ext else [".Mix-Headset.wav", ".flac", ".wav"]
    for meeting in args.meetings:
        wav = next((audio_dir / f"{meeting}{e}" for e in exts
                    if (audio_dir / f"{meeting}{e}").exists()), None)
        rttm = rttm_of.get(meeting)
        if rttm is None or wav is None:
            report["meetings"][meeting] = {"error": "missing rttm or audio"}
            continue
        ref = load_rttm(rttm)
        samples = decode_mono16k(wav, 0.0, None, channel=args.channel)
        total_s = samples.shape[0] / SR
        voiced = sv.voiced_10ms(samples, hop_ms=10.0)
        hop_s = 0.01
        grid = []
        t = 0.0
        while t + args.window_s <= total_s:
            grid.append((t, t + args.window_s))
            t += args.hop_s
        sel = [
            i
            for i, (a, b) in enumerate(grid)
            if voiced[int(a / hop_s) : int(b / hop_s)].mean() >= args.min_speech_fraction
        ]
        entry = {"total_s": round(total_s, 2), "windows": len(sel),
                 "ref_speakers": len({r[2] for r in ref})}
        windows_dump[meeting] = [[round(grid[i][0], 4), round(grid[i][1], 4)] for i in sel]

        for name in args.models:
            files = {"campplus": "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
                     "resnet34": "wespeaker_zh_cnceleb_resnet34.onnx"}
            cache = Path(f".tmp/strat-cache/{meeting}-{name}-w{args.window_s}.npz")
            if cache.exists():
                vecs = np.load(cache)["vecs"]
            else:
                emb = OnnxSpeakerEmbedder(models_dir / files[name])
                vecs = np.zeros((len(sel), emb.dim))
                for j, i in enumerate(sel):
                    a, b = grid[i]
                    vecs[j] = emb.embed_samples(samples[int(a * SR):int(b * SR)])
                cache.parent.mkdir(parents=True, exist_ok=True)
                np.savez_compressed(cache, vecs=vecs)
            dendo = build_dendrogram(vecs)
            wins = [grid[i] for i in sel]
            curve = {}
            for tau in FINE_TAU:
                hyp = windows_to_turns(wins, labels_at(dendo, tau), total_s)
                curve[f"{tau:.2f}"] = round(score(ref, hyp, total_s=total_s).der, 4)
            strats = pick_strategies(dendo, vecs, FINE_TAU)
            strats["fixed"] = 0.45
            oracle_tau = min(curve, key=lambda k: curve[k])
            strats["oracle"] = float(oracle_tau)
            def der_at(tau: float) -> float:
                nearest = min(FINE_TAU, key=lambda x: abs(x - tau))
                return curve[f"{nearest:.2f}"]

            picked = {k: {"tau": round(v, 3), "der": der_at(v)} for k, v in strats.items()}
            entry[name] = {"curve": curve, "strategies": picked}
            summary = " ".join(f"{k}={v['der']:.3f}" for k, v in picked.items())
            print(
                f"[{meeting}/{name}] oracle tau={oracle_tau} der={curve[oracle_tau]:.3f}"
                f" | {summary}"
            )
        report["meetings"][meeting] = entry

    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    Path(".tmp/strat-windows.json").write_text(
        json.dumps(windows_dump, ensure_ascii=False), encoding="utf-8"
    )
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
