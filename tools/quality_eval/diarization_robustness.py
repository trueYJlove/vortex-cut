"""W2.2 后续步骤② 的**稳健性复核**：三条反证的可复现脚本。

**为什么单独一个脚本**：`diarization_cluster_routes.py` 给出"两语料都过双门"的表面结论，
但该结论**不稳健**。三条反证是"不要贸然上 VBx"这一建议的**决策依据**，
故必须可复现，而不是散落在临时脚本里。

| 检查 | 回答 |
|---|---|
| `seeds` | 同一数据/算法只换确定性初值，结论会不会翻？ |
| `overlap_rule` | 换成**含重叠**计分（更严格）后还过门吗？ |
| `auto_k` | 自动 K 是否系统性小于真值 K（欠分割偏置）？ |

输出 JSON 供归档；**数字必须与 README 一致**。
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
from diarization_cluster_routes import kmeans_cosine, pick_k_silhouette  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402


def _windows_for(entry: dict, cond: str, total_s: float, ref, args):
    """窗集合来源：**优先 diag 落盘**；缺失时按条件重建。

    - `oracle_vad`：按参考语音区段选窗（无需音频）。
    - `silero_vad`：重跑 VAD（需音频；与产生缓存时同模型/门限）。
    """
    saved = entry.get("window_grids", {}).get(cond)
    if saved:
        return [(float(a), float(b)) for a, b in saved]
    grid = sp.window_grid(total_s, sp.WINDOW_S, sp.HOP_S)
    if cond == "oracle_vad":
        from diarization_diagnose import oracle_select, ref_speech_regions

        return [grid[i] for i in oracle_select(
            grid, ref_speech_regions(ref), sp.MIN_SPEECH_FRACTION)]
    if not args.audio_dir:
        return None
    import diarization_cluster_routes as _routes
    from diarization_cluster_routes import _silero_voiced

    # **必须把 channel 传进去**：多通道阵列（AISHELL-4）若按 None 解码，
    # 窗集合会与缓存向量（channel=0 产生）不一致 ⇒ 几乎全场被跳过（实测 n=1）。
    _routes._CHANNEL = args.channel
    return [grid[i] for i in sp.select_windows(
        grid, _silero_voiced(Path(args.audio_dir) / f"{args.meeting}{args.audio_ext}",
                             args.silero),
        min_speech_fraction=sp.MIN_SPEECH_FRACTION)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--diag-json", required=True)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--audio-dir", default=None, help="重建 silero 窗集合时需要")
    ap.add_argument("--audio-ext", default=".Mix-Headset.wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rttm_of = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    per_seed: dict[int, list[float]] = {s: [] for s in range(args.seeds)}
    per_seed_k: dict[int, list[int]] = {s: [] for s in range(args.seeds)}
    ignore_ders: list[float] = []
    keep_ders: list[float] = []
    auto_lt_true = 0
    n_used = 0

    for m in sorted(diag.get("meetings", {})):
        e = diag["meetings"][m]
        cond = e.get("conditions", {}).get(args.condition)
        if not cond or "best" not in cond or m not in rttm_of:
            continue
        ref = load_rttm(rttm_of[m])
        args.meeting = m
        wins = _windows_for(e, args.condition, e["total_s"], ref, args)
        if wins is None:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None or hit[0].shape[0] != len(wins):
            continue
        vecs = hit[0]
        total_s = e["total_s"]
        n_used += 1

        def der(labels, ignore_overlap: bool) -> float:
            turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
            hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}")
                   for t in turns]
            return float(score(ref, hyp, total_s=total_s,
                               ignore_overlap=ignore_overlap).der)

        for s in range(args.seeds):
            k, _ = pick_k_silhouette(vecs, seed=s)
            lab, _ = kmeans_cosine(vecs, k, seed=s)
            per_seed[s].append(der(lab, True))
            per_seed_k[s].append(k)

        k0, _ = pick_k_silhouette(vecs, seed=0)
        lab0, _ = kmeans_cosine(vecs, k0, seed=0)
        ignore_ders.append(der(lab0, True))
        keep_ders.append(der(lab0, False))
        if k0 < e["ref_speakers"]:
            auto_lt_true += 1

    seeds_out = {}
    for s in sorted(per_seed):
        a = np.array(per_seed[s])
        if a.size == 0:
            continue
        seeds_out[str(s)] = {
            "mean": round(float(a.mean()), 4), "worst": round(float(a.max()), 4),
            "mean_pass_40": bool(a.mean() <= 0.40), "worst_pass_55": bool(a.max() <= 0.55),
            "auto_k": sorted({int(x) for x in per_seed_k[s]}),
        }
    means = [v["mean"] for v in seeds_out.values()]
    worsts = [v["worst"] for v in seeds_out.values()]
    ig = np.array(ignore_ders)
    kp = np.array(keep_ders)

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "purpose": "kmeans_silhouette 的稳健性复核：种子稳定性 / 评分口径敏感性 / 自动 K 欠分割",
        "config": {"diag_json": args.diag_json, "condition": args.condition,
                   "seeds": args.seeds, "n_meetings_used": n_used},
        "seeds": {
            "per_seed": seeds_out,
            "mean_range": [round(min(means), 4), round(max(means), 4)],
            "worst_range": [round(min(worsts), 4), round(max(worsts), 4)],
            "all_pass_both": bool(all(v["mean_pass_40"] and v["worst_pass_55"]
                                      for v in seeds_out.values())),
            "failing_seeds": [f"{s}:worst={v['worst']}" for s, v in seeds_out.items()
                              if not v["worst_pass_55"]],
        },
        "overlap_rule": {
            "ignore": {"mean": round(float(ig.mean()), 4), "worst": round(float(ig.max()), 4),
                       "worst_pass_55": bool(ig.max() <= 0.55)},
            "count_overlap": {"mean": round(float(kp.mean()), 4),
                              "worst": round(float(kp.max()), 4),
                              "worst_pass_55": bool(kp.max() <= 0.55)},
        },
        "auto_k": {"auto_lt_true": f"{auto_lt_true}/{n_used}"},
    }
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"n={n_used} seeds all_pass={report['seeds']['all_pass_both']} "
          f"worst_range={report['seeds']['worst_range']} "
          f"overlap_worst={report['overlap_rule']['count_overlap']['worst']} "
          f"auto_k<true={report['auto_k']['auto_lt_true']}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
