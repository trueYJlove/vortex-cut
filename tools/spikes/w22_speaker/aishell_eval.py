"""AISHELL-4（中文会议）上的端到端 DER 评测 —— **补中文面 + 补人数多样性**。

为什么值得单跑（而不是再堆英文 AMI）：

1. **候选模型都是中文训练的**（`campplus_sv_zh-cn`、`wespeaker_zh_cnceleb`），
   而 AMI 是**英文**——所以 AMI 的数字对本产品（中文素材）很可能是**下界**，
   "跨语言"在这条线上不是"中文模型测英文"的风险，而是反过来。
2. **AMI 人数恒为 4**（test 15/16、dev 18/18、train 129/136），导致 P97 的 `capK`
   策略"偷看答案区间"而不可采信。AISHELL-4 测试集是 **6 人**，正好能正面检验。

口径与 AMI 一致的延续说明：
- **只用第 0 通道**（8 通道环形阵列）——环形阵列各通道有相位差，**下混会梳状干涉**，
  故取单通道而非 `-ac 1`。这是与 AMI Mix-Headset 不同的采集条件，**不可与 AMI 数字直接比大小**。
- DER 口径同 `der.py`：10 ms 帧、0.25 s collar、**忽略重叠**、穷举最优映射。
- 语料许可：**Apache-2.0**（AISHELL-4，OpenSLR 111 / HF mirror）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from spikes.w22_speaker.ami_eval import (  # noqa: E402
    THRESHOLDS,
    dense_windows,
    make_embedder,
    ref_speech_regions,
    speech_fraction,
    windows_to_turns,
)
from spikes.w22_speaker.audio import decode_mono16k  # noqa: E402
from spikes.w22_speaker.cluster import build_dendrogram, labels_at  # noqa: E402
from spikes.w22_speaker.der import load_rttm, score  # noqa: E402
from spikes.w22_speaker.resources import peak_rss_mb  # noqa: E402
from spikes.w22_speaker.silero_vad import SileroVad  # noqa: E402
from spikes.w22_speaker.vad import voiced_mask  # noqa: E402

SR = 16000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--models-dir", default=".tmp/spike-models")
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--models", nargs="+", default=["campplus", "resnet34"])
    ap.add_argument("--channel", type=int, default=0)
    ap.add_argument("--window-s", type=float, default=2.0)
    ap.add_argument("--hop-s", type=float, default=1.0)
    ap.add_argument("--min-speech-fraction", type=float, default=0.60)
    ap.add_argument(
        "--silero",
        default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx",
    )
    ap.add_argument("--out", default=".tmp/aishell-report.json")
    args = ap.parse_args()

    rttm_dir = Path(args.rttm_dir)
    audio_dir = Path(args.audio_dir)
    models_dir = Path(args.models_dir)
    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": "AISHELL-4 (Apache-2.0)",
        "channel": args.channel,
        "config": {
            "window_s": args.window_s, "hop_s": args.hop_s,
            "min_speech_fraction": args.min_speech_fraction, "thresholds": THRESHOLDS,
            "scoring": {"frame_s": 0.01, "collar_s": 0.25, "ignore_overlap": True,
                        "note": "自实现评分器，口径见 der.py；与 AMI 同一套"},
        },
        "meetings": {},
    }
    sv = SileroVad(args.silero)

    for meeting in args.meetings:
        rttm = rttm_dir / f"{meeting}.rttm"
        audio = audio_dir / f"{meeting}.flac"
        if not rttm.exists() or not audio.exists():
            report["meetings"][meeting] = {"error": "missing rttm or audio"}
            continue
        ref = load_rttm(rttm)
        samples = decode_mono16k(audio, 0.0, None, channel=args.channel)
        total_s = samples.shape[0] / SR
        hop_ms, hop_s = 10.0, 0.01
        _, voiced = voiced_mask(samples, SR, hop_ms=hop_ms)
        grid = dense_windows(total_s, args.window_s, args.hop_s)

        energy_sel = [i for i, (a, b) in enumerate(grid)
                      if speech_fraction(samples, a, b, voiced, hop_s) >= args.min_speech_fraction]
        t_sv = time.perf_counter()
        voiced_sv = sv.voiced_10ms(samples, hop_ms=hop_ms)
        silero_sel = [
            i
            for i, (a, b) in enumerate(grid)
            if speech_fraction(samples, a, b, voiced_sv, hop_s) >= args.min_speech_fraction
        ]
        regions = ref_speech_regions(ref)
        oracle_sel = []
        for i, (a, b) in enumerate(grid):
            cov = sum(max(0.0, min(b, e) - max(a, s)) for s, e in regions)
            if cov / (b - a) >= args.min_speech_fraction:
                oracle_sel.append(i)

        entry: dict = {
            "total_s": round(total_s, 2), "ref_speakers": len({t[2] for t in ref}),
            "ref_speech_s": round(sum(b - a for a, b, _ in ref), 1),
            "grid_windows": len(grid), "energy_windows": len(energy_sel),
            "silero_windows": len(silero_sel), "oracle_windows": len(oracle_sel),
            "silero_vad_s": round(time.perf_counter() - t_sv, 2),
        }
        conditions = [("energy_vad", energy_sel), ("silero_vad", silero_sel),
                      ("oracle_vad", oracle_sel)]
        for name in args.models:
            emb = make_embedder(name, models_dir)
            t0 = time.perf_counter()
            vecs = np.zeros((len(grid), emb.dim), dtype=np.float64)
            for i, (a, b) in enumerate(grid):
                seg = samples[int(a * SR):int(b * SR)]
                if seg.shape[0] >= int(0.30 * SR):
                    vecs[i] = emb.embed_samples(seg)
            embed_s = time.perf_counter() - t0
            model_entry: dict = {"dim": emb.dim, "embed_all_grid_s": round(embed_s, 2),
                                 "conditions": {}}
            for cond, sel in conditions:
                if len(sel) < 4:
                    model_entry["conditions"][cond] = {"error": f"too few windows ({len(sel)})"}
                    continue
                sub = vecs[sel]
                dendo = build_dendrogram(sub)
                wins = [grid[i] for i in sel]
                curve = {}
                for tau in THRESHOLDS:
                    hyp = windows_to_turns(wins, labels_at(dendo, tau), total_s)
                    res = score(ref, hyp, total_s=total_s)
                    curve[f"{tau:.2f}"] = {"der": round(res.der, 4),
                                           "hyp_speakers": res.hyp_speakers,
                                           "miss": round(res.miss, 4),
                                           "false_alarm": round(res.false_alarm, 4),
                                           "speaker_error": round(res.speaker_error, 4)}
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
            f"[{meeting}] {total_s:.0f}s 参考 {entry['ref_speakers']} 人 grid={len(grid)}"
            f" energy={len(energy_sel)} silero={len(silero_sel)} oracle={len(oracle_sel)}"
        )

    report["environment"] = {"python": sys.version.split()[0],
                             "peak_rss_mb_end": round(peak_rss_mb(), 1)}
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
