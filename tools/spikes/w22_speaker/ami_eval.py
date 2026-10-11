"""AMI 会议语料上的端到端评测（spike 用）——**这是 W2.2 精度轴的取证入口**。

语料：AMI Meeting Corpus（CC BY 4.0 等，见 setup 仓库 LICENSE=Apache-2.0 的分区/标注派生，
音频来自 Edinburgh 官方镜像）。参考标注来自 pyannote/AMI-diarization-setup（源自 AMI 官方
manual annotations 1.6.2），是学术界通用的 AMI diarization setup。

**为什么这比"等用户给素材"更好**：公开语料带**官方参考标注**，能算出真正的 DER；
用户随手给的一段没标注的素材反而只能看"像不像"。

两个条件（把误差来源拆开）：
- `energy_vad`：用本 spike 的能量 VAD 取窗 —— 端到端（含 VAD 误差）
- `oracle_vad`：用**参考标注**决定哪些窗纳入 —— 隔离出"纯聚类"的能力
两者之差 = VAD 造成的损失。这个分解比单个 DER 数字有用得多。

口径：DER 见 `der.py`（10ms 帧、0.25s collar、**忽略重叠语音**、最优映射）。
**忽略重叠 ⇒ 本分数不能与"含重叠"的公开 DER 直接比大小**，必须同口径读。
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
from spikes.w22_speaker.light import LightStatsEmbedder  # noqa: E402
from spikes.w22_speaker.resources import peak_rss_mb  # noqa: E402
from spikes.w22_speaker.silero_vad import SileroVad  # noqa: E402
from spikes.w22_speaker.vad import voiced_mask  # noqa: E402

SR = 16000
THRESHOLDS = [round(0.20 + 0.05 * i, 2) for i in range(11)]  # 0.20 .. 0.70


def dense_windows(total_s: float, window_s: float, hop_s: float):
    out = []
    t = 0.0
    while t + window_s <= total_s:
        out.append((t, t + window_s))
        t += hop_s
    return out


def speech_fraction(
    samples: np.ndarray, a: float, b: float, voiced: np.ndarray, hop_s: float
) -> float:
    i, j = int(a / hop_s), int(b / hop_s)
    if j <= i:
        return 0.0
    return float(voiced[i:j].mean())


def windows_to_turns(windows, labels, total_s: float, min_turn_s: float = 0.40):
    """窗标签 → 帧标签 → 轮次。重叠窗按"最近中心"裁决；过短段并入邻段。"""
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

    # 合并连续同标签帧；过短段并入前一段（首段则并入后一段）
    runs: list[list[int]] = []
    start = 0
    for i in range(1, n + 1):
        if i == n or owner[i] != owner[start]:
            runs.append([start, i, int(owner[start])])
            start = i
    min_frames = int(min_turn_s / FRAME_S)
    for k, run in enumerate(runs):
        if run[1] - run[0] >= min_frames or run[2] == -1:
            continue
        donor = runs[k - 1][2] if k > 0 else (runs[k + 1][2] if k + 1 < len(runs) else -1)
        run[2] = donor
    merged: list[list[int]] = []
    for run in runs:
        if merged and merged[-1][2] == run[2]:
            merged[-1][1] = run[1]
        else:
            merged.append(list(run))
    return [
        (a * FRAME_S, b * FRAME_S, f"spk{lab}")
        for a, b, lab in merged
        if lab != -1
    ]


def ref_speech_regions(ref_turns, gap_s: float = 0.5):
    """把参考轮次并成语音区段（含重叠），用于 oracle 取窗。"""
    if not ref_turns:
        return []
    spans = sorted((a, b) for a, b, _ in ref_turns)
    out = [list(spans[0])]
    for a, b in spans[1:]:
        if a - out[-1][1] <= gap_s:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def make_embedder(name: str, models_dir: Path, snip_edges: bool = False):
    if name == "light_mfcc":
        return LightStatsEmbedder(snip_edges=snip_edges, num_bins=80)
    files = {
        "campplus": "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
        "resnet34": "wespeaker_zh_cnceleb_resnet34.onnx",
    }
    return OnnxSpeakerEmbedder(models_dir / files[name], snip_edges=snip_edges)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup-dir", required=True, help="AMI-diarization-setup 解包目录")
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--models-dir", default=".tmp/spike-models")
    ap.add_argument(
        "--silero",
        default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx",
        help="项目已随包分发的 Silero VAD onnx",
    )
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--models", nargs="+", default=["campplus", "resnet34"])
    ap.add_argument("--window-s", type=float, default=2.0)
    ap.add_argument("--hop-s", type=float, default=1.0)
    ap.add_argument("--min-speech-fraction", type=float, default=0.60)
    ap.add_argument("--out", default=".tmp/ami-report.json")
    args = ap.parse_args()

    setup = Path(args.setup_dir)
    audio_dir = Path(args.audio_dir)
    models_dir = Path(args.models_dir)
    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "config": {
            "window_s": args.window_s,
            "hop_s": args.hop_s,
            "min_speech_fraction": args.min_speech_fraction,
            "thresholds": THRESHOLDS,
            "scoring": {
                "frame_s": FRAME_S,
                "collar_s": 0.25,
                "ignore_overlap": True,
                "note": "自实现评分器（参考 dscore 仓库已不存在）；口径见 der.py",
            },
        },
        "meetings": {},
    }
    rttm_dir = setup / "only_words" / "rttms"
    rttm_of = {}
    for part in ("test", "dev", "train"):
        for p in (rttm_dir / part).glob("*.rttm"):
            rttm_of.setdefault(p.stem, p)

    for meeting in args.meetings:
        rttm_path = rttm_of.get(meeting)
        if rttm_path is None:
            report["meetings"][meeting] = {"error": "rttm not found"}
            continue
        wav = audio_dir / f"{meeting}.Mix-Headset.wav"
        if not wav.exists():
            report["meetings"][meeting] = {"error": f"audio not found: {wav.name}"}
            continue

        ref = load_rttm(rttm_path)
        samples = decode_mono16k(wav)
        total_s = samples.shape[0] / SR
        hop_ms = 10.0
        _, voiced = voiced_mask(samples, SR, hop_ms=hop_ms)
        hop_s = hop_ms / 1000.0

        grid = dense_windows(total_s, args.window_s, args.hop_s)
        entry: dict = {
            "total_s": round(total_s, 2),
            "ref_speakers": len({t[2] for t in ref}),
            "ref_speech_s": round(sum(b - a for a, b, _ in ref), 1),
            "grid_windows": len(grid),
        }

        energy_sel = [
            i
            for i, (a, b) in enumerate(grid)
            if speech_fraction(samples, a, b, voiced, hop_s) >= args.min_speech_fraction
        ]
        silero_sel: list[int] = []
        try:
            sv = SileroVad(args.silero)
            t_sv = time.perf_counter()
            voiced_sv = sv.voiced_10ms(samples, hop_ms=hop_ms)
            for i, (a, b) in enumerate(grid):
                if speech_fraction(samples, a, b, voiced_sv, hop_s) >= args.min_speech_fraction:
                    silero_sel.append(i)
            entry["silero_vad_s"] = round(time.perf_counter() - t_sv, 2)
        except Exception as exc:  # 缺模型时如实记录，不静默降级
            entry["silero_error"] = str(exc)[:200]
        regions = ref_speech_regions(ref)
        oracle_sel = []
        for i, (a, b) in enumerate(grid):
            cov = sum(max(0.0, min(b, e) - max(a, s)) for s, e in regions)
            if cov / (b - a) >= args.min_speech_fraction:
                oracle_sel.append(i)
        entry["energy_windows"] = len(energy_sel)
        entry["silero_windows"] = len(silero_sel)
        entry["oracle_windows"] = len(oracle_sel)

        for name in args.models:
            emb = make_embedder(name, models_dir)
            t0 = time.perf_counter()
            vecs = np.zeros((len(grid), emb.dim), dtype=np.float64)
            for i, (a, b) in enumerate(grid):
                seg = samples[int(a * SR) : int(b * SR)]
                if seg.shape[0] >= int(0.30 * SR):
                    vecs[i] = emb.embed_samples(seg)
            embed_s = time.perf_counter() - t0

            model_entry: dict = {
                "dim": emb.dim,
                "embed_all_grid_s": round(embed_s, 2),
                "conditions": {},
            }
            conditions = [("energy_vad", energy_sel), ("oracle_vad", oracle_sel)]
            if silero_sel:
                conditions.insert(1, ("silero_vad", silero_sel))
            for cond, sel in conditions:
                if len(sel) < 4:
                    model_entry["conditions"][cond] = {"error": f"too few windows ({len(sel)})"}
                    continue
                sub = vecs[sel]
                dendo = build_dendrogram(sub)
                curve = {}
                for tau in THRESHOLDS:
                    labs = labels_at(dendo, tau)
                    wins = [grid[i] for i in sel]
                    hyp = windows_to_turns(wins, labs, total_s)
                    res = score(ref, hyp, total_s=total_s)
                    curve[f"{tau:.2f}"] = {
                        "der": round(res.der, 4),
                        "hyp_speakers": res.hyp_speakers,
                        "miss": round(res.miss, 4),
                        "false_alarm": round(res.false_alarm, 4),
                        "speaker_error": round(res.speaker_error, 4),
                    }
                best_tau = min(curve, key=lambda k: curve[k]["der"])
                model_entry["conditions"][cond] = {
                    "windows": len(sel),
                    "curve": curve,
                    "best_tau": best_tau,
                    "best": curve[best_tau],
                }
            model_entry["infer_s"] = round(emb.infer_s, 2)
            entry[name] = model_entry
        entry["peak_rss_mb"] = round(peak_rss_mb(), 1)
        report["meetings"][meeting] = entry
        print(
            f"[{meeting}] done: grid={len(grid)} energy={len(energy_sel)}"
            f" oracle={len(oracle_sel)}"
        )

    report["environment"] = {
        "python": sys.version.split()[0],
        "peak_rss_mb_end": round(peak_rss_mb(), 1),
    }
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
