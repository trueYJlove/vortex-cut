"""W2.2 方案 A 诊断：AMI 在阈值 τ **之前**的瓶颈定位。

**要回答的问题**：AMI 上连 oracle（每场用真值调 τ）都过不了最差场门限 ⇒ 失败不在 τ 选择。
那到底在哪一环？本脚本用**条件对照**把误差来源逐层剥开：

| 条件 | 窗选取依据 | 隔离出的环节 |
|---|---|---|
| `silero_vad` | 随包 Silero VAD | **端到端**（含 VAD 误差） |
| `oracle_vad` | **参考标注**（哪些窗真的有语音） | **纯聚类**能力（VAD 误差=0） |

两者之差 = **VAD 造成的损失**。再把 DER 拆成三个分量：

- `miss`：参考在说话、假设没输出 ⇒ **切分/漏检**（含 VAD 漏检）
- `fa`：参考静音、假设输出 ⇒ **虚报**
- `spkerr`：两边都在说话但**人判错** ⇒ **聚类/串号**

**关键约束（本脚本存在的原因）**：embedding 缓存键必须包含"选了哪些窗"，
否则 oracle_vad 会静默复用 silero 的向量、诊断结论全错。该缺陷已于 2026-10-12 修复并上锁
（`test_diarization_cache.py::TestSelectionFingerprintRegression`）。
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

from diarization import FRAME_S, load_rttm, score  # noqa: E402
from diarization_cache import (  # noqa: E402
    DEFAULT_ALGORITHM_VERSION,
    EmbeddingCache,
    embedding_cache_key,
    file_fingerprint,
)

from aivs_core.media import speaker as sp  # noqa: E402

SR = 16000


def _decode(path: Path, channel: int | None) -> np.ndarray:
    from spikes.w22_speaker.audio import decode_mono16k

    return decode_mono16k(path, 0.0, None, channel=channel)


def _silero(samples: np.ndarray, model: Path, threshold: float = 0.5) -> np.ndarray:
    from spikes.w22_speaker.silero_vad import SileroVad

    return SileroVad(model).voiced_10ms(samples, hop_ms=10.0, threshold=threshold)


def _embed_windows(samples: np.ndarray, grid, sel, model_path: Path):
    from spikes.w22_speaker.embedding import OnnxSpeakerEmbedder

    emb = OnnxSpeakerEmbedder(model_path)
    vecs = np.zeros((len(sel), emb.dim), dtype=np.float32)
    for j, i in enumerate(sel):
        a, b = grid[i]
        vecs[j] = emb.embed_samples(samples[int(a * SR):int(b * SR)])
    return vecs


def _selection_fingerprint(windows) -> str:
    import hashlib

    payload = ";".join(f"{a:.4f}-{b:.4f}" for a, b in windows)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


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


def oracle_select(grid, regions, min_speech_fraction: float) -> list[int]:
    """按参考语音区段的覆盖率选窗（VAD 误差=0 的条件）。"""
    out = []
    for i, (a, b) in enumerate(grid):
        cov = sum(max(0.0, min(b, e) - max(a, s)) for s, e in regions)
        if cov / (b - a) >= min_speech_fraction:
            out.append(i)
    return out


def _turns_of(wins, labels, total_s, min_turn_s):
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=min_turn_s)
    return [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]


def run_condition(
    *, label: str, samples, total_s, grid, sel, ref, speaker_model, model_id, cache,
    fp, vad_model_name, channel, vad_threshold, window_s, hop_s, min_speech_fraction,
    min_turn_s, tau_grid, k_max,
) -> dict:
    if len(sel) < 4:
        return {"label": label, "error": f"too few windows ({len(sel)})"}
    wins = [grid[i] for i in sel]
    params = {
        "window_s": window_s, "hop_s": hop_s,
        "min_speech_fraction": min_speech_fraction,
        "vad_threshold": vad_threshold,
        "vad_model": vad_model_name,
        "channel": channel,
        "frontend": "kaldi80_fbank_numpy",
        "selection": _selection_fingerprint(wins),
        "condition": label,
    }
    key = embedding_cache_key(fp, model_id, DEFAULT_ALGORITHM_VERSION, params)
    t0 = time.perf_counter()
    vecs, cached = cache.get_or_compute(
        key, lambda: _embed_windows(samples, grid, sel, speaker_model),
        asset_fingerprint=fp, model_id=model_id,
        algorithm_version=DEFAULT_ALGORITHM_VERSION, params=params,
    )
    embed_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    dendro = sp.build_dendrogram(vecs)
    dendro_s = time.perf_counter() - t0

    def detail_at(tau: float):
        turns = _turns_of(wins, sp.labels_at(dendro, tau), total_s, min_turn_s)
        r = score(ref, turns, total_s=total_s)
        return r

    curve = {}
    for t in tau_grid:
        r = detail_at(t)
        curve[f"{t:.2f}"] = {
            "der": round(r.der, 4), "miss": round(r.miss, 4),
            "fa": round(r.false_alarm, 4), "spkerr": round(r.speaker_error, 4),
            "hyp_speakers": r.hyp_speakers,
        }
    best_tau = min(curve, key=lambda k: curve[k]["der"])
    return {
        "label": label,
        "windows": len(sel),
        "embed_s": round(embed_s, 2),
        "cached": cached,
        "cache_key": key,
        "dendrogram_s": round(dendro_s, 2),
        "curve": curve,
        "best_tau": best_tau,
        "best": curve[best_tau],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--setup-dir", default=".tmp/ami/AMI-diarization-setup-main")
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--models-dir", default=".tmp/spike-models")
    ap.add_argument("--model-id", default="campplus")
    ap.add_argument(
        "--silero",
        default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx",
    )
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--k-max", type=int, default=sp.DEFAULT_K_MAX)
    ap.add_argument("--vad-threshold", type=float, default=0.5)
    ap.add_argument("--window-s", type=float, default=sp.WINDOW_S)
    ap.add_argument("--hop-s", type=float, default=sp.HOP_S)
    ap.add_argument("--min-speech-fraction", type=float, default=sp.MIN_SPEECH_FRACTION)
    ap.add_argument("--min-turn-s", type=float, default=sp.MIN_TURN_S)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    audio_dir = Path(args.audio_dir)
    models = {"campplus": "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
              "resnet34": "wespeaker_zh_cnceleb_resnet34.onnx"}
    speaker_model = Path(args.models_dir) / models[args.model_id]
    silero_model = Path(args.silero)
    cache = EmbeddingCache(args.cache_dir)

    setup = Path(args.setup_dir)
    rttm_of = {}
    for part in ("test", "dev", "train"):
        for p in (setup / "only_words" / "rttms" / part).glob("*.rttm"):
            rttm_of.setdefault(p.stem, p)

    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "purpose": "方案 A：定位 AMI 在 τ 之前的瓶颈（条件对照 + DER 分量分解）",
        "config": {
            "model_id": args.model_id, "window_s": args.window_s, "hop_s": args.hop_s,
            "min_speech_fraction": args.min_speech_fraction, "min_turn_s": args.min_turn_s,
            "vad_threshold": args.vad_threshold, "k_max": args.k_max,
            "tau_grid": list(sp.TAU_GRID),
            "scoring": {"frame_s": FRAME_S, "collar_s": 0.25, "ignore_overlap": True},
        },
        "meetings": {},
    }
    for m in args.meetings:
        audio = audio_dir / f"{m}.Mix-Headset.wav"
        rttm = rttm_of.get(m)
        if not audio.exists() or rttm is None:
            report["meetings"][m] = {"error": "missing audio or rttm"}
            print(f"[{m}] MISSING", flush=True)
            continue
        ref = load_rttm(rttm)
        samples = _decode(audio, None)
        total_s = samples.shape[0] / SR
        grid = sp.window_grid(total_s, args.window_s, args.hop_s)
        voiced = _silero(samples, silero_model, args.vad_threshold)
        silero_sel = sp.select_windows(grid, voiced, min_speech_fraction=args.min_speech_fraction)
        regions = ref_speech_regions(ref)
        oracle_sel = oracle_select(grid, regions, args.min_speech_fraction)

        entry: dict = {
            "total_s": round(total_s, 2),
            "ref_speakers": len({t[2] for t in ref}),
            "grid_windows": len(grid),
            "silero_windows": len(silero_sel),
            "oracle_windows": len(oracle_sel),
            "conditions": {},
        }
        fp = file_fingerprint(audio)
        for label, sel in (("silero_vad", silero_sel), ("oracle_vad", oracle_sel)):
            c = run_condition(
                label=label, samples=samples, total_s=total_s, grid=grid, sel=sel, ref=ref,
                speaker_model=speaker_model, model_id=args.model_id, cache=cache, fp=fp,
                vad_model_name=silero_model.name, channel=None,
                vad_threshold=args.vad_threshold, window_s=args.window_s, hop_s=args.hop_s,
                min_speech_fraction=args.min_speech_fraction, min_turn_s=args.min_turn_s,
                tau_grid=sp.TAU_GRID, k_max=args.k_max,
            )
            entry["conditions"][label] = c
        report["meetings"][m] = entry
        s = entry["conditions"].get("silero_vad", {})
        o = entry["conditions"].get("oracle_vad", {})
        def fmt(x):
            if "best" not in x:
                return "n/a"
            b = x["best"]
            return (f"win={x['windows']} tau={x['best_tau']} der={b['der']:.3f} "
                    f"(miss={b['miss']:.3f} fa={b['fa']:.3f} spk={b['spkerr']:.3f})")
        print(f"[{m}] silero: {fmt(s)}", flush=True)
        print(f"[{m}] oracle: {fmt(o)}", flush=True)
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
