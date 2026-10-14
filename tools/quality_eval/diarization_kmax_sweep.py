r"""门 §10 O2 裁决实验：`k_max` 与"最小簇份额"能否使 AMI 最差场达标。

预登记：`evidence/2026-10-14-w22-o-o2a-kmax/PRE_REGISTRATION.md`
（**本脚本严格按其 §1–§3 执行**；任何偏离必须在报告中显式登记）。

两个**分开**被检验的机制（预登记 §1）：
  O2-a1  放宽 k_max：{8, 12, 16, 24, 32}，其余不变（仍是 silhouette argmax）
  O2-a2  最小簇份额：k_max 固定 8，剔除份额 < s 的簇并并入最近大簇，s ∈ {0, .005, .01, .02, .05}

**不修改任何生产代码**；只用已缓存窗 embedding。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tools"))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402
from diarization_param_sweep import structural_safety  # noqa: E402
import diarization_structural_safety_k1 as safety_k1  # noqa: E402
from diarization_single_branch_spike import _A, _l2  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

KMAX_GRID = (8, 12, 16, 24, 32)          # O2-a1
SHARE_GRID = (0.0, 0.005, 0.01, 0.02, 0.05)  # O2-a2


def der_of(wins, labels, ref, total_s: float) -> float:
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
    return float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)


def merge_small(labels: np.ndarray, vecs: np.ndarray, min_share: float):
    """把份额 < `min_share` 的簇并入**最近的**大簇（按归一化质心余弦）。

    返回 (新标签, 被并入的帧占比, 剩余簇数)。`min_share <= 0` 时原样返回。
    """
    if min_share <= 0:
        u = np.unique(labels)
        return labels, 0.0, int(u.size)
    u, cnt = np.unique(labels, return_counts=True)
    share = cnt / labels.size
    big = [u[i] for i in range(len(u)) if share[i] >= min_share]
    if not big or len(big) == len(u):
        return labels, 0.0, int(u.size)
    v = _l2(vecs)
    cent = {}
    for c in u:
        m = labels == c
        x = v[m].mean(axis=0)
        n = float(np.linalg.norm(x))
        cent[c] = x / n if n > 0 else x
    out = labels.copy()
    moved = 0
    for c in u:
        if c in big:
            continue
        m = labels == c
        moved += int(m.sum())
        out[m] = max((float(cent[c] @ cent[b]), b) for b in big)[1]
    return out, moved / labels.size, len(set(out.tolist()))


def silhouette_argmax(dendro, vecs, k_max, tau_grid):
    """现役形态：候选窗 [2, k_max] 内取 silhouette 最大者的 τ。"""
    v = _l2(vecs)
    dmat = 1.0 - v @ v.T
    best_sil, best_tau = -2.0, None
    for tau in tau_grid:
        lab = sp.labels_at(dendro, tau)
        k = int(np.unique(lab).size)
        if k < 2 or k > k_max:
            continue
        s = sp.silhouette(dmat, lab)
        if s > best_sil:
            best_sil, best_tau = s, tau
    if best_tau is None:  # 安全界语义（与生产 fallback 一致）
        for tau in tau_grid:
            if sp.count_at(dendro, tau) <= k_max:
                return float(tau)
        return float(tau_grid[-1])
    return float(best_tau)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cache = EmbeddingCache(args.cache_dir)
    corpora = {
        "ami": dict(diag=".tmp/w22-diag-ami-fixed.json",
                    rttm=".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test",
                    channel=None),
        "aishell4": dict(diag=".tmp/w22-diag-cn.json", rttm=".tmp/aishell4/rttm",
                         channel=0, audio_dir=".tmp/aishell4/audio", audio_ext=".flac"),
        "vc_test_lowk": dict(diag=".tmp/w22-diag-vc-test-lowk.json",
                             rttm=".tmp/voxconverse/rttm", channel=None),
    }

    rep: dict = {
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "config": {"kmax_grid": list(KMAX_GRID), "share_grid": list(SHARE_GRID),
                   "condition": args.condition,
                   "tau_grid": [round(float(t), 2) for t in sp.TAU_GRID]},
        "corpora": {},
    }

    for cname, cfg in corpora.items():
        data, skipped = _load(cfg, cache, args)
        pm: dict = {}
        for m, d in data.items():
            dendro = sp.build_dendrogram(d["vecs"])
            rec: dict = {"k_true": d["k_true"], "n_windows": len(d["wins"]),
                         "skipped": skipped.get(m)}
            # ---- O2-a1: k_max 扫描（不做 share 剔除）----
            rec["kmax"] = {}
            for km in KMAX_GRID:
                tau = silhouette_argmax(dendro, d["vecs"], km, sp.TAU_GRID)
                lab = sp.labels_at(dendro, tau)
                rec["kmax"][str(km)] = {
                    "tau": round(tau, 4), "k": int(np.unique(lab).size),
                    "der": round(der_of(d["wins"], lab, d["ref"], d["total_s"]), 4)}
            # ---- O2-a2: 固定 k_max=8，扫 share ----
            rec["share"] = {}
            tau8 = silhouette_argmax(dendro, d["vecs"], 8, sp.TAU_GRID)
            lab8 = sp.labels_at(dendro, tau8)
            for s in SHARE_GRID:
                lab_s, moved, k_after = merge_small(lab8, d["vecs"], s)
                rec["share"][str(s)] = {
                    "k_before": int(np.unique(lab8).size), "k_after": k_after,
                    "merged_frac": round(moved, 4),
                    "der": round(der_of(d["wins"], lab_s, d["ref"], d["total_s"]), 4)}
            pm[m] = rec
            print(f"  [{cname}] {m}", flush=True)
        rep["corpora"][cname] = pm

    _summarize(rep)
    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep["verdict"], ensure_ascii=False), flush=True)
    return 0


def _load(cfg, cache, args):
    diag = json.loads(Path(cfg["diag"]).read_text(encoding="utf-8"))
    rttm_of: dict = {}
    for p in Path(cfg["rttm"]).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)
    out, skip = {}, {}
    a = _A(audio_dir=cfg.get("audio_dir"), channel=cfg["channel"], silero=args.silero,
           audio_ext=cfg.get("audio_ext", ".wav"))
    for m in sorted(diag.get("meetings", {})):
        e = diag["meetings"][m]
        cond = (e.get("conditions") or {}).get(args.condition)
        ck = cond.get("cache_key") if cond else None
        if not ck or m not in rttm_of:
            skip[m] = "no-cond/rttm/key"
            continue
        ref = load_rttm(rttm_of[m])
        a.meeting = m
        wins = _windows_for(e, args.condition, e["total_s"], ref, a)
        if wins is None:
            skip[m] = "no-wins"
            continue
        hit = cache.get(ck)
        if hit is None or hit[0].shape[0] != len(wins):
            skip[m] = "cache"
            continue
        out[m] = {"vecs": hit[0], "wins": wins, "ref": ref,
                  "total_s": float(e["total_s"]), "k_true": int(e["ref_speakers"])}
    return out, skip


def _agg(rows, getter):
    v = [getter(r) for r in rows]
    v = [x for x in v if x is not None]
    if not v:
        return None
    return {"n": len(v), "mean": round(float(np.mean(v)), 4),
            "worst": round(float(np.max(v)), 4)}


def _summarize(rep) -> None:
    s: dict = {}
    for cname, pm in rep["corpora"].items():
        rows = list(pm.values())
        d: dict = {"n": len(rows)}
        d["kmax"] = {str(km): _agg(rows, lambda r, k=str(km): r["kmax"][k]["der"])
                     for km in KMAX_GRID}
        d["kmax_chosen_k"] = {str(km): sorted({r["kmax"][str(km)]["k"] for r in rows})
                              for km in KMAX_GRID}
        d["share"] = {str(x): _agg(rows, lambda r, k=str(x): r["share"][k]["der"])
                      for x in SHARE_GRID}
        d["share_merged_frac"] = {str(x): round(float(np.mean(
            [r["share"][str(x)]["merged_frac"] for r in rows])), 4) for x in SHARE_GRID}
        s[cname] = d
    rep["summary"] = s
    rep["verdict"] = _verdict(rep)


def _verdict(rep) -> dict:
    s = rep["summary"]
    ami, asr, vc = s.get("ami"), s.get("aishell4"), s.get("vc_test_lowk")
    out: dict = {}

    def ev(tag, getter):
        a = _agg(list(rep["corpora"]["ami"].values()), getter) if "ami" in rep["corpora"] else None
        if a is None:
            return {"ran": False}
        k1a = a["mean"] <= 0.40
        k1b = a["worst"] <= 0.60
        res = {"ran": True, "ami": a, "K1a": k1a, "K1b": k1b}
        for cname, key in (("aishell4", "K2a"), ("vc_test_lowk", "K2b")):
            if cname not in rep["corpora"]:
                res[key] = None
                continue
            b = _agg(list(rep["corpora"][cname].values()), getter)
            base = _agg(list(rep["corpora"][cname].values()),
                        lambda r: r["kmax"]["8"]["der"])
            res[key] = bool(b and base and b["mean"] <= base["mean"] + 0.02
                            and b["worst"] <= base["worst"] + 0.02)
            res[cname] = b
        res["ADOPT"] = bool(res["K1a"] and res["K1b"] and res.get("K2a") and res.get("K2b"))
        return res

    for km in KMAX_GRID:
        out[f"kmax={km}"] = ev(str(km), lambda r, k=str(km): r["kmax"][k]["der"])
    for x in SHARE_GRID:
        out[f"share={x}"] = ev(str(x), lambda r, k=str(x): r["share"][k]["der"])
    return out


if __name__ == "__main__":
    raise SystemExit(main())
