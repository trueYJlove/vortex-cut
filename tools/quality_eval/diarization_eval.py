"""W2.2 语料驱动评测 harness（S0 ④ 基线 + S1 两路线对照）。

**这是本包的验收入口**：Design Gate §5 的精度门（自动 τ 下两语料 DER 均值 ≤40%、
最差 ≤55%）由本脚本产出数字。

与 spike 脚本的关系：spike 的 `ami_eval.py` / `aishell_eval.py` 是**取证用一次性脚本**，
算法内联在脚本里；本脚本改为调用**生产 Core 模块** `aivs_core.media.speaker`
（S2 将落地的同一份实现）⇒ 测的就是要发布的代码路径。

## 两条路线（Design Gate §6 S1：对照 + 专门设计并行）

| 路线 | 策略名 | 说明 |
|---|---|---|
| 对照 | `silhouette+capK` | silhouette 最大，簇数 ∈ [2, k_max] |
| 专门设计 | `distance_mixture` | **逐录音**两两距离的 1 维两成分混合 EM，取后验相等处 |

另报 `fixed0.45`（现基线）与 `oracle`（每场用真值调 τ，**仅作上界对照，不可产品化**）。

## 缓存

窗 embedding 经 `diarization_cache.EmbeddingCache`（键 = 素材指纹+模型 id+算法版本+参数）。
**重跑策略不重跑 ONNX**——这是"换 τ 只重聚类"的基础，也是 S1 能快速迭代两路线的前提。
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


def _selection_fingerprint(windows: list[tuple[float, float]]) -> str:
    """窗选取的内容指纹：把窗时间栅格哈希进缓存键。

    **为什么必须**：缓存键若只含 window_s/hop_s/min_speech_fraction，则"用 silero 选的窗"
    与"用参考标注选的窗"（oracle_vad）会算出同一个键 ⇒ 后者静默复用前者的向量。
    实测确认过该同键（2026-10-12），故改为对**实际窗集合**取指纹。
    """
    import hashlib

    payload = ";".join(f"{a:.4f}-{b:.4f}" for a, b in windows)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def evaluate_meeting(
    *,
    meeting: str,
    audio: Path,
    rttm: Path,
    channel: int | None,
    silero_model: Path,
    speaker_model: Path,
    model_id: str,
    cache: EmbeddingCache,
    k_max: int,
    tau_grid,
    vad_threshold: float,
    window_s: float,
    hop_s: float,
    min_speech_fraction: float,
    min_turn_s: float,
) -> dict:
    ref = load_rttm(rttm)
    samples = _decode(audio, channel)
    total_s = samples.shape[0] / SR
    voiced = _silero(samples, silero_model, vad_threshold)
    grid = sp.window_grid(total_s, window_s, hop_s)
    sel = sp.select_windows(grid, voiced, min_speech_fraction=min_speech_fraction)

    entry: dict = {
        "total_s": round(total_s, 2),
        "ref_speakers": len({t[2] for t in ref}),
        "grid_windows": len(grid),
        "selected_windows": len(sel),
    }
    if len(sel) < 4:
        entry["error"] = f"too few windows ({len(sel)})"
        return entry

    fp = file_fingerprint(audio)
    # **窗选取指纹（缺陷修复 2026-10-12）**：键必须包含"选了哪些窗"，否则换 VAD 条件
    # （silero vs oracle_vad）会得到**同一个键**、静默复用另一条件的向量 —— 那会让
    # "分离 VAD 与聚类"的诊断得出错误结论。本实现首版就漏了这一项，已修。
    # 用窗时间栅格的 sha256 而非"选择规则名"：规则名无法覆盖"参考标注决定选择"的情形。
    sel_fingerprint = _selection_fingerprint([grid[i] for i in sel])
    params = {
        "window_s": window_s, "hop_s": hop_s,
        "min_speech_fraction": min_speech_fraction,
        "vad_threshold": vad_threshold,
        "vad_model": Path(silero_model).name,
        "channel": channel,
        "frontend": "kaldi80_fbank_numpy",
        "selection": sel_fingerprint,
    }
    key = embedding_cache_key(fp, model_id, DEFAULT_ALGORITHM_VERSION, params)
    t0 = time.perf_counter()
    vecs, was_cached = cache.get_or_compute(
        key,
        lambda: _embed_windows(samples, grid, sel, speaker_model),
        asset_fingerprint=fp, model_id=model_id,
        algorithm_version=DEFAULT_ALGORITHM_VERSION, params=params,
    )
    entry["embed_s"] = round(time.perf_counter() - t0, 2)
    entry["embed_cached"] = was_cached
    entry["cache_key"] = key

    wins = [grid[i] for i in sel]
    t0 = time.perf_counter()
    dendro = sp.build_dendrogram(vecs)
    entry["dendrogram_s"] = round(time.perf_counter() - t0, 2)

    # τ 曲线（真值只用于 oracle 上界与事后归因，不参与自动策略）
    def der_at(tau: float) -> float:
        turns = sp.windows_to_turns(wins, sp.labels_at(dendro, tau), total_s, min_turn_s=min_turn_s)
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
        return float(score(ref, hyp, total_s=total_s).der)

    curve = {f"{t:.2f}": round(der_at(t), 4) for t in tau_grid}
    best_tau = min(curve, key=lambda k: curve[k])
    strategies: dict[str, dict] = {}
    for name, strat in (("silhouette_capK", "silhouette_capk"),
                        ("distance_mixture", "distance_mixture")):
        tau, sname = sp.choose_threshold(dendro, vecs, k_max=k_max, strategy=strat,
                                        tau_grid=tau_grid)
        nearest = min(tau_grid, key=lambda x: abs(x - tau))
        strategies[name] = {
            "tau": round(float(tau), 4), "tau_on_grid": round(float(nearest), 4),
            "der": curve[f"{nearest:.2f}"], "strategy_name": sname,
            "n_speakers": int(np.unique(sp.labels_at(dendro, nearest)).size),
        }
    fixed = min(tau_grid, key=lambda x: abs(x - 0.45))
    strategies["fixed0.45"] = {
        "tau": 0.45, "tau_on_grid": round(float(fixed), 4),
        "der": curve[f"{fixed:.2f}"], "strategy_name": "fixed",
        "n_speakers": int(np.unique(sp.labels_at(dendro, fixed)).size),
    }
    strategies["oracle"] = {
        "tau": float(best_tau), "tau_on_grid": float(best_tau),
        "der": curve[best_tau], "strategy_name": "oracle(uses_truth)",
        "n_speakers": int(np.unique(sp.labels_at(dendro, float(best_tau))).size),
    }
    entry["strategies"] = strategies
    entry["curve"] = curve
    return entry


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", choices=["ami", "aishell4"], required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--rttm-dir", default=None, help="AMI 用 setup 目录（含 only_words/rttms）")
    ap.add_argument("--meetings", nargs="+", required=True)
    ap.add_argument("--channel", type=int, default=None)
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
    cache = EmbeddingCache(args.cache_dir)

    rttm_of: dict[str, Path] = {}
    if args.corpus == "ami":
        default_setup = Path(".tmp/ami/AMI-diarization-setup-main")
        setup = Path(args.rttm_dir) if args.rttm_dir else default_setup
        for part in ("test", "dev", "train"):
            for p in (setup / "only_words" / "rttms" / part).glob("*.rttm"):
                rttm_of.setdefault(p.stem, p)
    else:
        for p in Path(args.rttm_dir or ".tmp/aishell4/rttm").glob("*.rttm"):
            rttm_of.setdefault(p.stem, p)

    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": args.corpus,
        "model_id": args.model_id,
        "channel": args.channel,
        "config": {
            "window_s": args.window_s, "hop_s": args.hop_s,
            "min_speech_fraction": args.min_speech_fraction,
            "min_turn_s": args.min_turn_s, "k_max": args.k_max,
            "vad_threshold": args.vad_threshold,
            "tau_grid": list(sp.TAU_GRID),
            "scoring": {"frame_s": 0.01, "collar_s": 0.25, "ignore_overlap": True},
        },
        "meetings": {},
    }
    for m in args.meetings:
        ext = ".Mix-Headset.wav" if args.corpus == "ami" else ".flac"
        audio = audio_dir / f"{m}{ext}"
        rttm = rttm_of.get(m)
        if not audio.exists() or rttm is None:
            report["meetings"][m] = {"error": "missing audio or rttm"}
            print(f"[{m}] MISSING (audio={audio.exists()} rttm={rttm is not None})", flush=True)
            continue
        try:
            e = evaluate_meeting(
                meeting=m, audio=audio, rttm=rttm, channel=args.channel,
                silero_model=Path(args.silero), speaker_model=speaker_model,
                model_id=args.model_id, cache=cache, k_max=args.k_max,
                tau_grid=sp.TAU_GRID, vad_threshold=args.vad_threshold,
                window_s=args.window_s, hop_s=args.hop_s,
                min_speech_fraction=args.min_speech_fraction, min_turn_s=args.min_turn_s,
            )
        except Exception as exc:  # noqa: BLE001
            report["meetings"][m] = {"error": f"{type(exc).__name__}: {exc}"[:200]}
            print(f"[{m}] FAIL {exc}", flush=True)
            continue
        report["meetings"][m] = e
        if "error" in e:
            print(f"[{m}] {e['error']}", flush=True)
        else:
            s = e["strategies"]
            print(
                f"[{m}] ref={e['ref_speakers']}p win={e['selected_windows']} "
                f"| silhouette={s['silhouette_capK']['der']:.3f} "
                f"mixture={s['distance_mixture']['der']:.3f} "
                f"fixed={s['fixed0.45']['der']:.3f} oracle={s['oracle']['der']:.3f} "
                f"| cached={e['embed_cached']}",
                flush=True,
            )
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # 汇总（门限判定按 Design Gate §5：均值 ≤40%、最差 ≤55%）
    summary: dict = {"n_meetings": 0, "strategies": {}}
    ok = [e for e in report["meetings"].values() if "strategies" in e]
    summary["n_meetings"] = len(ok)
    for name in ("silhouette_capK", "distance_mixture", "fixed0.45", "oracle"):
        ders = [e["strategies"][name]["der"] for e in ok]
        if not ders:
            continue
        summary["strategies"][name] = {
            "mean_der": round(float(np.mean(ders)), 4),
            "worst_der": round(float(np.max(ders)), 4),
            "mean_pass_40": bool(np.mean(ders) <= 0.40),
            "worst_pass_55": bool(np.max(ders) <= 0.55),
        }
    report["summary"] = summary
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== SUMMARY (" + args.corpus + ") ===")
    for name, s in summary["strategies"].items():
        print(f"  {name:20s} mean={s['mean_der']:.4f} worst={s['worst_der']:.4f} "
              f"pass40={s['mean_pass_40']} pass55={s['worst_pass_55']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
