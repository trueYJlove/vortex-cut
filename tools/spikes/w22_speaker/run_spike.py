"""W2.2 说话人层 spike 主控（**非生产代码**）。

产出（JSON）：
  1) 资源轴：模型体积/加载耗时、解码/fbank/推理耗时、峰值内存、实时比
  2) 过分割轴（真实素材）：单说话人素材上的 n_speakers(τ) 曲线——轻方案**主要的现实风险**
  3) 区分轴：同素材跨静音（真值恰 1 人）与跨素材拼接（两独立模型一致判定为异身份）
  4) 前端口径 A/B：snip_edges 对区分裕度的影响（经验判定模型训练口径）

**未取证**：真实多说话人单麦对话的 DER —— 本机无该素材，禁止以合成分数顶替。
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
from spikes.w22_speaker.cluster import build_dendrogram, count_at, count_curve  # noqa: E402
from spikes.w22_speaker.embedding import OnnxSpeakerEmbedder  # noqa: E402
from spikes.w22_speaker.light import LightStatsEmbedder  # noqa: E402
from spikes.w22_speaker.resources import peak_rss_mb  # noqa: E402
from spikes.w22_speaker.vad import sliding_windows, speech_regions  # noqa: E402

SR = 16000
THRESHOLDS = [round(0.05 + 0.05 * i, 2) for i in range(14)]  # 0.05 .. 0.70
WINDOW_S = 2.0
HOP_S = 1.0
MIN_SPEECH_FRACTION = 0.60


def harness_digest() -> dict:
    """计算本 harness 全部 .py 的自指纹，写进报告。

    动机（2026-10-10 评审发现）：人工维护的 `harness.sha256` 会与"证据实际由哪版代码生成"脱节
    ——本次就出现过 vad.py 在证据生成之后又被改动（虽仅 docstring）的情况。
    让**报告自带指纹**，证据即可自证，不依赖外部台账的时序。
    """
    import hashlib

    files = sorted(Path(__file__).resolve().parent.glob("*.py"))
    per_file = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    combined = hashlib.sha256(
        "\n".join(f"{k}:{v}" for k, v in per_file.items()).encode("utf-8")
    ).hexdigest()
    return {"combined": combined, "files": per_file}


def embed_windows(embedder, samples, wins):
    mat = []
    for w in wins:
        seg = samples[int(w.start_s * SR) : int(w.end_s * SR)]
        if seg.shape[0] < int(0.40 * SR):
            continue
        mat.append(embedder.embed_samples(seg))
    return np.asarray(mat, dtype=np.float64) if mat else np.zeros((0, embedder.dim))


def analyse(embedder, samples, *, cap=400, window_s=None, hop_s=None, min_speech_fraction=None):
    t0 = time.perf_counter()
    regions = speech_regions(samples)
    wins = sliding_windows(
        samples,
        SR,
        window_s=WINDOW_S if window_s is None else window_s,
        hop_s=HOP_S if hop_s is None else hop_s,
        min_speech_fraction=(
            MIN_SPEECH_FRACTION if min_speech_fraction is None else min_speech_fraction
        ),
    )
    vecs = embed_windows(embedder, samples, wins)
    wall = time.perf_counter() - t0
    used = vecs
    if vecs.shape[0] > cap:
        step = int(np.ceil(vecs.shape[0] / cap))
        used = vecs[::step]
    dendro = build_dendrogram(used)
    height = max((d for _, _, d in dendro.merges), default=None)
    summary = {
        "regions": len(regions),
        "speech_s": round(sum(r.duration_s for r in regions), 2),
        "windows": int(vecs.shape[0]),
        "windows_clustered": int(used.shape[0]),
        "count_curve": count_curve(dendro, THRESHOLDS),
        "count_at_0.50": count_at(dendro, 0.50),
        "merge_height": round(height, 4) if height is not None else None,
        "wall_s": round(wall, 3),
    }
    return summary, vecs, used


def similarity_stats(vecs, *, adjacent_only=True):
    if vecs.shape[0] < 2:
        return None
    v = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    if adjacent_only:
        sims = np.sum(v[:-1] * v[1:], axis=1)
    else:
        sim = v @ v.T
        iu = np.triu_indices(v.shape[0], k=1)
        sims = sim[iu]
    return {
        "n": int(sims.size),
        "mean": round(float(sims.mean()), 4),
        "p05": round(float(np.percentile(sims, 5)), 4),
        "p50": round(float(np.percentile(sims, 50)), 4),
        "p95": round(float(np.percentile(sims, 95)), 4),
        "min": round(float(sims.min()), 4),
    }


def cross_similarity(a, b):
    if a.shape[0] == 0 or b.shape[0] == 0:
        return None
    an = a / np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-12)
    bn = b / np.maximum(np.linalg.norm(b, axis=1, keepdims=True), 1e-12)
    sim = an @ bn.T
    return {
        "mean": round(float(sim.mean()), 4),
        "p50": round(float(np.median(sim)), 4),
        "p95": round(float(np.percentile(sim, 95)), 4),
        "max": round(float(sim.max()), 4),
    }


def build_construction(kind: str, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    gap = np.zeros(int(0.5 * SR), dtype=np.float64)
    if kind == "same_across_gap":
        return np.concatenate([a[: 8 * SR], gap, a[-8 * SR :]])
    return np.concatenate([a[: 8 * SR], gap, b[: 8 * SR]])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--materials", required=True, help="role → path 的 JSON")
    ap.add_argument("--models-dir", default=".tmp/spike-models")
    ap.add_argument("--out", default=".tmp/spike-report.json")
    ap.add_argument("--snip-edges-ab", action="store_true")
    ap.add_argument("--window-s", type=float, default=WINDOW_S)
    ap.add_argument("--hop-s", type=float, default=HOP_S)
    ap.add_argument("--min-speech-fraction", type=float, default=MIN_SPEECH_FRACTION)
    ap.add_argument(
        "--excerpt-seconds",
        type=float,
        default=180.0,
        help="每个素材只分析前 N 秒（<=0 表示整条）；长素材按摘录测速率再换算每分钟成本",
    )
    args = ap.parse_args()

    roles = json.loads(Path(args.materials).read_text(encoding="utf-8"))
    model_paths = {
        "campplus": Path(args.models_dir) / "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
        "resnet34": Path(args.models_dir) / "wespeaker_zh_cnceleb_resnet34.onnx",
    }

    def make_embedder(name: str, *, snip_edges: bool = False):
        """C-轻（无模型）与 C-折中（ONNX）统一构造入口。"""
        if name == "light_mfcc":
            return LightStatsEmbedder(snip_edges=snip_edges, num_bins=80)
        return OnnxSpeakerEmbedder(model_paths[name], snip_edges=snip_edges)

    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "window": {
            "window_s": WINDOW_S,
            "hop_s": HOP_S,
            "min_speech_fraction": MIN_SPEECH_FRACTION,
        },
        "thresholds": THRESHOLDS,
        "models": {},
        "materials": {},
        "cross_similarity": {},
        "constructed": {},
        "snip_edges_ab": {},
        "environment": {"python": sys.version.split()[0], "harness": harness_digest()},
    }

    # 素材规格：允许字符串（路径）或 {"path":…, "single_speaker": bool}
    # `single_speaker` 决定了"同素材首尾拼接"夹具的真值是否成立——
    # 只有**确认单说话人**的素材，"首 8s + 静音 + 末 8s ⇒ 真值恰 1 人"才成立。
    paths: dict[str, str] = {}
    single_flags: dict[str, bool] = {}
    for role, spec in roles.items():
        if isinstance(spec, str):
            paths[role], single_flags[role] = spec, False
        else:
            paths[role] = spec["path"]
            single_flags[role] = bool(spec.get("single_speaker", False))

    decoded: dict[str, np.ndarray] = {}
    for role, path in paths.items():
        t0 = time.perf_counter()
        take = None if args.excerpt_seconds <= 0 else args.excerpt_seconds
        samples = decode_mono16k(path, 0.0, take)
        dt = time.perf_counter() - t0
        decoded[role] = samples
        report["materials"][role] = {
            "single_speaker": single_flags[role],
            "analyzed_s": round(samples.shape[0] / SR, 2),
            "excerpt_seconds": args.excerpt_seconds,
            "decode_s": round(dt, 3),
            "rms_dbfs": round(float(20 * np.log10(np.sqrt(np.mean(samples**2)) + 1e-12)), 2),
            "peak": round(float(np.max(np.abs(samples))) if samples.size else 0.0, 4),
        }

    vectors: dict[tuple[str, str], np.ndarray] = {}
    active: list[str] = []

    candidates = ["campplus", "resnet34", "light_mfcc"]
    for name in candidates:
        if name != "light_mfcc":
            path = model_paths[name]
            if not path.exists():
                report["models"][name] = {"error": "model missing"}
                continue
        else:
            path = None
        active.append(name)
        embedder = make_embedder(name)
        report["models"][name] = {
            "file": path.name if path is not None else "(no model: numpy MFCC statistics)",
            "size_bytes": path.stat().st_size if path is not None else 0,
            "dim": embedder.dim,
            "load_s": round(embedder.load_s, 3),
        }
        for role, samples in decoded.items():
            summary, vecs, used = analyse(
                embedder,
                samples,
                window_s=args.window_s,
                hop_s=args.hop_s,
                min_speech_fraction=args.min_speech_fraction,
            )
            summary["adjacent_self_sim"] = similarity_stats(vecs)
            summary["all_pairs_self_sim"] = similarity_stats(used, adjacent_only=False)
            report["materials"][role][name] = summary
            vectors[(name, role)] = vecs
        report["models"][name]["infer_s"] = round(embedder.infer_s, 3)
        report["models"][name]["fbank_s"] = round(embedder.fbank_s, 3)
        report["models"][name]["peak_rss_mb"] = round(peak_rss_mb(), 1)

    role_names = list(roles.keys())
    for m in active:
        for i, ra in enumerate(role_names):
            for rb in role_names[i + 1 :]:
                report["cross_similarity"][f"{m}:{ra}~{rb}"] = cross_similarity(
                    vectors[(m, ra)], vectors[(m, rb)]
                )

    constructions: list[tuple[str, str, str, str]] = []
    for role, samples in decoded.items():
        if samples.shape[0] >= 20 * SR:
            constructions.append((f"same_across_gap:{role}", "same_across_gap", role, role))
    if "oral_a" in decoded and "scene" in decoded:
        constructions.append(("cross_identity:oral_a+scene", "cross", "oral_a", "scene"))

    for label, kind, ra, rb in constructions:
        for m in active:
            embedder = make_embedder(m)
            built = build_construction(kind, decoded[ra], decoded[rb])
            summary, vecs, used = analyse(
                embedder,
                built,
                window_s=args.window_s,
                hop_s=args.hop_s,
                min_speech_fraction=args.min_speech_fraction,
            )
            summary["adjacent_self_sim"] = similarity_stats(vecs)
            summary["all_pairs_self_sim"] = similarity_stats(used, adjacent_only=False)
            if kind == "same_across_gap":
                known_single = single_flags.get(ra, False)
                summary["ground_truth_speakers"] = 1 if known_single else None
                summary["truth_note"] = (
                    "同一素材首 8s + 0.5s 静音 + 末 8s；该素材**已声明单说话人**，故真值恰 1 位"
                    if known_single
                    else (
                        "同一素材首 8s + 0.5s 静音 + 末 8s，但该素材**人数未核实**——"
                        "首尾可能本就是不同说话人，**本夹具无真值**，只作观测"
                    )
                )
            else:
                summary["ground_truth_speakers"] = 2
                summary["truth_note"] = (
                    "跨录音拼接（两素材分属不同录音设备，两独立模型一致判定为异身份）"
                    "——**易化用例**，非单麦对话真值"
                )
            report["constructed"].setdefault(label, {})[m] = summary

    if args.snip_edges_ab and role_names:
        for m in active:
            for snip in (False, True):
                embedder = make_embedder(m, snip_edges=snip)
                row: dict = {}
                vs: dict[str, np.ndarray] = {}
                for role in role_names[:2]:
                    summary, vecs, used = analyse(embedder, decoded[role])
                    row[f"{role}:count_curve"] = summary["count_curve"]
                    row[f"{role}:adjacent_self_sim"] = similarity_stats(vecs)
                    row[f"{role}:merge_height"] = summary["merge_height"]
                    vs[role] = vecs
                if len(role_names) >= 2:
                    row["cross_sim"] = cross_similarity(vs[role_names[0]], vs[role_names[1]])
                report["snip_edges_ab"][f"{m}:snip={snip}"] = row

    report["environment"]["peak_rss_mb_end"] = round(peak_rss_mb(), 1)
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
