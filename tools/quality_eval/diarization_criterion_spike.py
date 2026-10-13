"""W2.2 准则 spike：方向敏感准则的对照评测（**按 PRE_REGISTRATION.md 执行**）。

候选（预登记 §2，**不再增补**）：
  A0  现行 silhouette+capK（K ∈ [2,8]）
  G1 K 上限改为 min(8, K_hat_dm)
  G2 distance_mixture（不用 silhouette）
  G3 方向守卫：silhouette 曲线单调不减 ⇒ 改用 K_hat_dm

判定口径见同目录 PRE_REGISTRATION.md §3（**看数之前写死**）。
本工具只出读数与对照；是否落 Core 属设计裁决。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_HERE = Path(__file__).resolve().parent
for _p in (ROOT / "services" / "core" / "src", _HERE, ROOT / "tools" / "quality_eval"):
    sys.path.insert(0, str(_p))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

CAP = 8


def _dmat(vecs: np.ndarray) -> np.ndarray:
    x = np.asarray(vecs, dtype=np.float64)
    x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    return 1.0 - x @ x.T


def k_hat_dm(vecs: np.ndarray) -> int:
    """预登记 §2 写死的定义：clip(round(1/w_same), 1, 8)。拟合失败退化为 2。"""
    fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
    if not fit.get("ok"):
        return 2
    w_same = max(float(fit["weight"][0]), 1e-6)
    return int(max(1, min(round(1.0 / w_same), CAP)))


def _curve(den, dmat, wins, ref, total_s) -> list[dict]:
    """整条 tau 网格一次算完（K 与 silhouette 一并落盘）。"""
    out = []
    for tau in sp.TAU_GRID:
        labels = sp.labels_at(den, tau)
        k = int(np.unique(labels).size)
        sil = sp.silhouette(dmat, labels) if 2 <= k <= sp.MAX_SILHOUETTE_CLUSTERS else None
        turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, "spk%d" % t["speaker"]) for t in turns]
        out.append({"tau": round(float(tau), 2), "k": k, "sil": sil,
                    "der": float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)})
    return out


def _pick_in_window(curve: list[dict], lo: int, hi: int) -> dict | None:
    # **结构性回退（预登记未覆盖，此处显式声明）**：K_hat_dm 可能等于 1，
    # 此时窗口 [2,1] 为空。silhouette 在 K=1 无定义 ⇒ 下界 2 不可再降，
    # 故唯一的确定性解法是**把上限抬到下界**（窗口退化为 [2,2]）。
    # 这是"空窗口"的唯一自洽解，不是看了数字之后的调参。
    hi = max(hi, lo)
    cand = [c for c in curve if c["sil"] is not None and lo <= c["k"] <= hi]
    if not cand:
        return None
    # 同 K 多 tau 时，silhouette 取最大（与产品实现一致）
    best_by_k: dict[int, dict] = {}
    for c in cand:
        cur = best_by_k.get(c["k"])
        if cur is None or c["sil"] > cur["sil"]:
            best_by_k[c["k"]] = c
    return max(best_by_k.values(), key=lambda c: c["sil"])


def _pick_tau(curve: list[dict], tau: float) -> dict:
    return min(curve, key=lambda c: abs(c["tau"] - tau))


def evaluate(corpus: str, diag_path: str, rttm_dir: str, audio_dir: str, audio_ext: str,
             cache_dir: str, condition: str, channel: int | None) -> dict:
    diag = json.loads(Path(diag_path).read_text(encoding="utf-8"))
    cache = EmbeddingCache(cache_dir)
    rttm_of: dict = {}
    for p in Path(rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    class _Args:
        pass

    args = _Args()
    args.audio_dir = audio_dir
    args.audio_ext = audio_ext
    args.channel = channel
    args.cache_dir = cache_dir
    args.condition = condition
    # `_windows_for` 在"重建 silero 窗集合"分支上需要 `args.silero` 与 `args.meeting`
    # （后者按会话在循环里赋值）。二者缺一即 AttributeError——AMI 走缓存命中没触发，
    # AISHELL-4 需要重建，才暴露出来。
    args.silero = str(
        ROOT / ".venv" / "Lib" / "site-packages" / "faster_whisper" / "assets"
        / "silero_vad_v6.onnx"
    )

    per = {}
    skipped: dict[str, str] = {}
    for name in sorted(diag.get("meetings", {})):
        e = diag["meetings"][name]
        # A3：该会话自身 VAD 失败（只有 error 字段）⇒ 跳过并**登记**，不静默剔除
        cond = e.get("conditions", {}).get(condition)
        if not cond or "cache_key" not in cond or name not in rttm_of:
            skipped[name] = str(cond.get("error", "no-condition")) if cond else "no-condition"
            continue
        ref = load_rttm(rttm_of[name])
        args.meeting = name
        wins = _windows_for(e, condition, e["total_s"], ref, args)
        if wins is None:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None or hit[0].shape[0] != len(wins):
            continue
        vecs = np.asarray(hit[0], dtype=np.float64)
        den = sp.build_dendrogram(vecs)
        dmat = _dmat(vecs)
        curve = _curve(den, dmat, wins, ref, e["total_s"])
        if not curve:
            continue
        kh = k_hat_dm(vecs)

        a0 = _pick_in_window(curve, 2, CAP)
        # A1：K_hat 可能为 1 ⇒ 窗口为空；A2：某些会话根本不存在 K=2 的 tau
        # ⇒ 两种空窗都回退到 A0 的选择，并**显式标记**（不假装准则有效）。
        g1 = _pick_in_window(curve, 2, min(CAP, kh))
        g1_fallback = g1 is None
        if g1_fallback:
            g1 = a0
        # G2：distance_mixture 的 tau（不选 K）
        tau_dm, strat_dm = sp.choose_threshold(den, vecs, k_max=CAP, strategy="distance_mixture")
        g2 = _pick_tau(curve, tau_dm)
        # G3：方向守卫
        sil_seq = [(c["k"], c["sil"]) for c in curve if c["sil"] is not None and 2 <= c["k"] <= CAP]
        by_k: dict[int, float] = {}
        for k, s in sil_seq:
            by_k[k] = max(by_k.get(k, -2.0), s)
        ks = sorted(by_k)
        monotone = len(ks) >= 2 and all(by_k[ks[i]] <= by_k[ks[i + 1]] for i in range(len(ks) - 1))
        if monotone:
            g3 = _pick_in_window(curve, 2, min(CAP, kh))
            if g3 is None:
                g3 = a0
                g3_src = "guard->fallback(A0)"
            else:
                g3_src = "guard->K_hat"
        else:
            g3 = a0
            g3_src = "silhouette"

        per[name] = {
            "k_true": int(e["ref_speakers"]), "total_s": float(e["total_s"]),
            "k_hat_dm": kh, "sil_monotone": bool(monotone), "g3_src": g3_src,
            "g1_fallback": bool(g1_fallback),
            "tau_dm": float(tau_dm), "strategy_dm": strat_dm,
            "A0": a0, "G1": g1, "G2": g2, "G3": g3,
            # 落盘完整曲线：后续分析可离线做，不必重算（重算成本 = 建树 + DER）
            "curve": curve,
        }
        print("[%s] k_true=%d K_hat=%d mono=%s | A0 K=%s DER=%.4f | G1 K=%s DER=%.4f | G2 K=%s DER=%.4f | G3 K=%s DER=%.4f"
              % (name, per[name]["k_true"], kh, monotone,
                 a0["k"] if a0 else "-", a0["der"] if a0 else float("nan"),
                 g1["k"] if g1 else "-", g1["der"] if g1 else float("nan"),
                 g2["k"], g2["der"], g3["k"] if g3 else "-", g3["der"] if g3 else float("nan")),
              flush=True)
    return {"corpus": corpus, "condition": condition, "meetings": per, "skipped": skipped}


def summarise(rep: dict, label: str) -> dict:
    per = rep["meetings"]
    rows = [v for v in per.values() if v["A0"] and v["G1"] and v["G2"] and v["G3"]]
    out = {"label": label, "n": len(rows)}
    print()
    print("=== %s  n=%d ===" % (label, len(rows)))
    print("  %-4s %10s %10s %10s" % ("rule", "mean", "worst", "n_best"))
    der_store = {}
    for rule in ("A0", "G1", "G2", "G3"):
        d = np.array([r[rule]["der"] for r in rows])
        der_store[rule] = d
        out[rule] = {"mean": float(d.mean()), "worst": float(d.max())}
        best = sum(1 for r in rows if r[rule]["der"] == min(r[x]["der"] for x in ("A0", "G1", "G2", "G3")))
        out[rule]["n_best"] = best
        print("  %-4s %10.4f %10.4f %10d" % (rule, d.mean(), d.max(), best))
    out["k_hat_median"] = float(np.median([r["k_hat_dm"] for r in rows]))
    out["sil_monotone_frac"] = float(np.mean([r["sil_monotone"] for r in rows]))
    out["g3_used_guard_frac"] = float(np.mean([r["g3_src"] == "guard->K_hat" for r in rows]))
    print("  K_hat_dm median=%.1f   silhouette 单调不减占比=%.0f%%   G3 触发守卫占比=%.0f%%"
          % (out["k_hat_median"], 100 * out["sil_monotone_frac"], 100 * out["g3_used_guard_frac"]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True, help="JSON: [{corpus, diag, rttm, audio, ext, channel, label}]")
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    specs = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    report = {"condition": args.condition, "corpora": {}}
    for spc in specs:
        rep = evaluate(spc["corpus"], spc["diag"], spc["rttm"], spc["audio"],
                       spc.get("ext", ".wav"), args.cache_dir, args.condition,
                       spc.get("channel"))
        report["corpora"][spc["corpus"]] = {
            "summary": summarise(rep, spc.get("label", spc["corpus"])),
            "meetings": rep["meetings"],
            "skipped": rep["skipped"],
        }
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
