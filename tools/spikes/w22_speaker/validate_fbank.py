"""前端对拍：纯 numpy fbank vs kaldi-native-fbank（sherpa-onnx 使用的同一实现）。

用法（在 spike 隔离环境内）：
    .tmp/spike-venv/Scripts/python.exe \\
        tools/spikes/w22_speaker/validate_fbank.py <audio-or-video> [--seconds 20]

判定：逐值等价（max |Δ| 小到可归因于 float32 舍入）。
这是"纯 numpy 前端是否可替代 C++ 扩展依赖"的取证点。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import kaldi_native_fbank as knf  # noqa: E402
from spikes.w22_speaker.audio import decode_mono16k  # noqa: E402
from spikes.w22_speaker.fbank import compute_fbank  # noqa: E402


def knf_fbank(samples: np.ndarray, *, num_bins: int = 80, snip_edges: bool = False) -> np.ndarray:
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = 16000
    opts.frame_opts.frame_length_ms = 25.0
    opts.frame_opts.frame_shift_ms = 10.0
    opts.frame_opts.dither = 0.0
    opts.frame_opts.snip_edges = snip_edges
    opts.frame_opts.remove_dc_offset = True
    opts.frame_opts.preemph_coeff = 0.97
    opts.frame_opts.window_type = "povey"
    opts.mel_opts.num_bins = num_bins
    opts.mel_opts.low_freq = 20.0
    opts.mel_opts.high_freq = 0.0
    opts.use_energy = False
    opts.use_log_fbank = True
    fb = knf.OnlineFbank(opts)
    fb.accept_waveform(16000, np.asarray(samples, dtype=np.float32))
    fb.input_finished()
    frames = [fb.get_frame(i) for i in range(fb.num_frames_ready)]
    if not frames:
        return np.zeros((0, num_bins), dtype=np.float64)
    return np.asarray(frames, dtype=np.float64)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--start", type=float, default=0.0)
    args = ap.parse_args()

    samples = decode_mono16k(args.media, args.start, args.seconds)
    report: dict = {"media": Path(args.media).name, "samples": int(samples.shape[0])}

    for snip in (False, True):
        mine = compute_fbank(samples, snip_edges=snip)
        ref = knf_fbank(samples, snip_edges=snip)
        n = min(mine.shape[0], ref.shape[0])
        if n == 0:
            report[f"snip_edges={snip}"] = {"frames": 0, "note": "no frames"}
            continue
        delta = np.abs(mine[:n] - ref[:n])
        report[f"snip_edges={snip}"] = {
            "frames_mine": int(mine.shape[0]),
            "frames_ref": int(ref.shape[0]),
            "shape_match": mine.shape == ref.shape,
            "max_abs_delta": float(delta.max()),
            "mean_abs_delta": float(delta.mean()),
            "p99_abs_delta": float(np.percentile(delta, 99)),
            "ref_abs_mean": float(np.abs(ref[:n]).mean()),
        }

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
