r"""W2.2 (b) 判别能力 spike：选到 K*（窗口内 DER 最优的 K）（ADR-0006 D5 之后续）。

预登记：`evidence/2026-10-14-w22-m-b-discrimination/PRE_REGISTRATION.md`
（**本脚本严格按其 §1–§4 执行**；任何偏离必须在报告中显式登记）。

候选（**无自由参数**，按预登记 §1）：
  A0  基线：现役 `silhouette+capK`（**直接调用生产 choose_threshold**）
  B1  秩融合：rank(silhouette(K)) + rank(|K − k_raw|)，取均值和最小的 K
  B2  `crossing` 当 τ：用距离混合的 crossing 作为阈值切树

**不修改任何生产代码**；分离/混合统计一律读缓存或归档。
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

MIX_CACHE = ROOT / ".tmp/w22-mixture-cache.json"
ARCH_MIX = {
    "vc_test_lowk": ROOT / "evidence/2026-10-13-w22-j-k-estimator/e0-vc-test-lowk.json",
    "ami": ROOT / "evidence/2026-10-13-w22-j-k-estimator/e0-ami.json",
}


def der_of(wins, labels, ref, total_s: float) -> float:
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
    return float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)


def pick_b1(grid, k_raw):
    """秩融合：rank(sil 降序) + rank(|K-k_raw| 升序)，取均值和最小的 K（**无自由参数**）。

    并列时取**更小的 K**（确定性；方向与"保守优先"一致）。
    """
    cand = [g for g in grid if 2 <= g["k"] <= 8 and g.get("sil") is not None]
    if not cand:
        return None
    order_sil = sorted(range(len(cand)), key=lambda i: -cand[i]["sil"])
    r_sil = {i: r for r, i in enumerate(order_sil)}
    order_kd = sorted(range(len(cand)), key=lambda i: abs(cand[i]["k"] - k_raw))
    r_kd = {i: r for r, i in enumerate(order_kd)}
    best = min(range(len(cand)), key=lambda i: (r_sil[i] + r_kd[i], cand[i]["k"]))
    return cand[best]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--k-max", type=int, default=8)
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if not Path(args.silero).is_file():
        raise SystemExit(f"silero asset missing: {args.silero}  (AISHELL-4 需重建窗集合)")

    cache = EmbeddingCache(args.cache_dir)
    mix = json.loads(MIX_CACHE.read_text(encoding="utf-8")) if MIX_CACHE.is_file() else {}
    archmix: dict[str, dict] = {}
    for tag, p in ARCH_MIX.items():
        if p.is_file():
            for r in json.loads(p.read_text(encoding="utf-8"))["rows"]:
                archmix.setdefault(tag, {})[r["name"]] = {
                    "separation": r["separation"], "w_same": r["w_same"],
                    "k_raw": r["k_raw"], "crossing": None,
                }

    corpora = {
        "dev": dict(diag=".tmp/w22-diag-vc.json", rttm=".tmp/voxconverse/rttm", channel=None),
        "vc_test_lowk": dict(diag=".tmp/w22-diag-vc-test-lowk.json",
                             rttm=".tmp/voxconverse/rttm", channel=None),
        "ami": dict(diag=".tmp/w22-diag-ami-fixed.json",
                    rttm=".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test",
                    channel=None),
        "aishell4": dict(diag=".tmp/w22-diag-cn.json", rttm=".tmp/aishell4/rttm",
                         channel=0, audio_dir=".tmp/aishell4/audio", audio_ext=".flac"),
    }

    rep: dict = {
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "config": {"k_max": args.k_max, "condition": args.condition},
        "corpora": {},
    }

    k_max = args.k_max
    tau_grid = sp.TAU_GRID
    for cname, cfg in corpora.items():
        data, _skip = _load(cfg, cache, args, cname)
        pm = {}
        for m, d in data.items():
            dendro = sp.build_dendrogram(d["vecs"])
            v = _l2(d["vecs"])
            dmat = 1.0 - v @ v.T
            grid = []
            for tau in tau_grid:
                labels = sp.labels_at(dendro, tau)
                k = int(np.unique(labels).size)
                sil = sp.silhouette(dmat, labels) if 2 <= k <= k_max else None
                grid.append({"tau": float(tau), "k": k, "sil": sil,
                             "der": der_of(d["wins"], labels, d["ref"], d["total_s"])})

            # A0：直接调用生产
            base_tau, base_name = sp.choose_threshold(
                dendro, d["vecs"], k_max=k_max, strategy="silhouette_capk", tau_grid=tau_grid)
            lab_b = sp.labels_at(dendro, base_tau)
            a0 = {"k": int(np.unique(lab_b).size), "tau": float(base_tau),
                  "der": der_of(d["wins"], lab_b, d["ref"], d["total_s"]), "name": base_name}

            # k_raw = 1/w_same（**已对归档 63 行逐值核验**：0 处不符）。
            # 缓存里只存 w_same（原始量），k_raw 由它导出，避免存冗余字段。
            mx = mix.get(d["cache_key"]) or archmix.get(cname, {}).get(m)
            if mx:
                w_same = float(mx["w_same"])
                k_raw = (1.0 / w_same) if w_same > 0 else None
            else:
                k_raw = None
            crossing = float(mx["crossing"]) if mx and mx.get("crossing") is not None else None

            # B1
            b1 = None
            if k_raw is not None:
                g1 = pick_b1(grid, k_raw)
                if g1 is not None:
                    lab = sp.labels_at(dendro, g1["tau"])
                    b1 = {"k": int(np.unique(lab).size), "tau": g1["tau"],
                          "der": der_of(d["wins"], lab, d["ref"], d["total_s"])}

            # B2
            b2 = None
            if crossing is not None:
                lab = sp.labels_at(dendro, float(crossing))
                kk = int(np.unique(lab).size)
                if kk <= k_max:
                    b2 = {"k": kk, "tau": float(crossing),
                          "der": der_of(d["wins"], lab, d["ref"], d["total_s"])}

            # K*（窗口内 DER 最优）—— **目标，不可产品化**
            cand = [g for g in grid if 2 <= g["k"] <= k_max]
            kstar = min(cand, key=lambda g: g["der"]) if cand else None

            pm[m] = {"k_true": d["k_true"], "k_raw": k_raw, "crossing": crossing,
                     "A0": a0, "B1": b1, "B2": b2,
                     "Kstar": {"k": kstar["k"], "der": kstar["der"]} if kstar else None,
                     "grid": [{"tau": round(g["tau"], 2), "k": g["k"], "sil": g["sil"],
                               "der": round(g["der"], 4)} for g in grid]}
        rep["corpora"][cname] = pm
        print(f"[eval] {cname}: n={len(pm)}", flush=True)

    _summarize(rep)
    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep["verdict"], ensure_ascii=False), flush=True)
    return 0


def _load(cfg, cache, args, cname):
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
        # ⚠️ diag 里有场次缺 `cache_key`（(a) 实验同款：VC test 有 1 场如此）
        # ⇒ 必须用 .get()，否则整轮崩在 KeyError 而不是跳过该场。
        ckey = cond.get("cache_key") if cond else None
        if not cond or not ckey or m not in rttm_of:
            skip[m] = "no-cond/rttm/key"
            continue
        ref = load_rttm(rttm_of[m])
        a.meeting = m
        wins = _windows_for(e, args.condition, e["total_s"], ref, a)
        if wins is None:
            skip[m] = "no-wins"
            continue
        hit = cache.get(ckey)
        if hit is None or hit[0].shape[0] != len(wins):
            skip[m] = "cache"
            continue
        out[m] = {"vecs": hit[0], "wins": wins, "ref": ref,
                  "total_s": float(e["total_s"]), "k_true": int(e["ref_speakers"]),
                  "cache_key": ckey}
    return out, skip


def _stats(rows, key):
    v = [r[key]["der"] for r in rows if r.get(key)]
    if not v:
        return None
    return {"n": len(v), "mean": round(float(np.mean(v)), 4), "worst": round(float(np.max(v)), 4)}


def _summarize(rep) -> None:
    out = {}
    for cname, pm in rep["corpora"].items():
        rows = [dict(m=m, **v) for m, v in pm.items()]
        d = {k: _stats(rows, k) for k in ("A0", "B1", "B2", "Kstar")}
        # ⚠️ **K0 必须按候选各自算**：公共子集是"该候选 **与常数 K=3** 都有解"的场次，
        # 而不是"B1 与 B2 都有解"。首版把两者混为一谈 ⇒ 当候选覆盖不同场次时
        # 判据根本算不出来（K0 返回 null）——**执行期发现的判据实现缺陷**。
        d["K0_basis"] = {}
        for name in ("B1", "B2"):
            pairs = []
            for r in rows:
                if not r.get(name):
                    continue
                g3 = [x for x in pm[r["m"]]["grid"] if x["k"] == 3]
                if not g3:
                    continue
                pairs.append((r[name]["der"], min(x["der"] for x in g3)))
            if not pairs:
                d["K0_basis"][name] = None
                continue
            cm = float(np.mean([p[0] for p in pairs]))
            cw = float(np.max([p[0] for p in pairs]))
            km = float(np.mean([p[1] for p in pairs]))
            kw = float(np.max([p[1] for p in pairs]))
            d["K0_basis"][name] = {
                "n": len(pairs),
                "cand_mean": round(cm, 4), "cand_worst": round(cw, 4),
                "constK3_mean": round(km, 4), "constK3_worst": round(kw, 4),
                "K0": bool(cm < km and cw < kw),
            }
        out[cname] = d
    rep["summary"] = out
    rep["verdict"] = _verdict(rep)


def _verdict(rep) -> dict:
    s = rep["summary"]
    vc, ami, asr = s.get("vc_test_lowk"), s.get("ami"), s.get("aishell4")
    v: dict = {}
    for name in ("B1", "B2"):
        if not vc or not vc.get(name) or not vc.get("A0"):
            v[name] = {"ran": False}
            continue
        cand, base = vc[name], vc["A0"]
        k1a = (cand["worst"] - base["worst"]) <= -0.10
        k1b = (cand["mean"] - base["mean"]) <= 0.005
        b = (vc.get("K0_basis") or {}).get(name)
        k0 = b["K0"] if b else None
        k2a = k2b = None
        if ami and ami.get(name) and ami.get("A0"):
            k2a = ((ami[name]["mean"] - ami["A0"]["mean"]) <= 0.02
                   and (ami[name]["worst"] - ami["A0"]["worst"]) <= 0.02)
        if asr and asr.get(name) and asr.get("A0"):
            k2b = ((asr[name]["mean"] - asr["A0"]["mean"]) <= 0.02
                   and (asr[name]["worst"] - asr["A0"]["worst"]) <= 0.02)
        v[name] = {"ran": True, "K0": k0, "K1a": k1a, "K1b": k1b, "K2a": k2a, "K2b": k2b,
                   "ADOPT": bool(k0 and k1a and k1b and k2a and k2b)}
    return v


if __name__ == "__main__":
    raise SystemExit(main())
