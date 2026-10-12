r"""W2.2 门 §5.5 后续 —— **参数化选择**的分因实验：损失来自「簇数上限」还是「选择准则」？

§5.5 判定五指出：现行 `silhouette+capK` 把簇数**限定在 [2, 8]**，而最优 τ 常对应**远大于 8** 的 K，
⇒ 「余量在参数化」。但那只证明**上界够得着**，**没有回答**：

    是「上限挡住了好解」（**天花板**问题），
    还是「silhouette 就算放开上限也挑不对」（**准则**问题）？

**两者的处方完全不同**——前者只需放开上限（极便宜），后者要换/修选择准则（贵得多）。
混为一谈会开错药方，故本工具把二者**分开测量**。

## 分因方法：对每个上限分别测两条线

    capped_best(c)   = min over {tau : 2 <= K(tau) <= c} of DER(tau)   —— 该上限下**最好能拿到多少**
    capped_pick(c)   = DER(argmax over 同上 of silhouette)     —— 该上限下 silhouette 实际选到多少

于是两个缺口可以分别读出：

    天花板损失 = capped_best(c) − capped_best(inf)    「上限挡掉了多少」
    准则损失   = capped_pick(c) − capped_best(c)      「在可选集合内，准则挑错了多少」

## ⚠️ 一个必须显式处理的陷阱

`Core.silhouette` 对**簇数 > MAX_SILHOUETTE_CLUSTERS(40)** 的划分返回 **-1.0**（"无定义"），
不是"分数很低"。若把 -1 当分数参与比较，一个**未定义**的 τ 会**压过**初始值 -2.0 而被选中。
故本工具把「无定义」**显式排除**在候选之外（而不是让它参与排序），
并把被排除的 τ 数量报出来——否则会得出"放开上限后 silhouette 选了 71 个簇"这种假结论。
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
from diarization_robustness import _windows_for  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

# 上限档位：现行 = 8；往上一路放开到"实际不受限"
CAPS: tuple[int, ...] = (2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 40, 10_000)
UNLIMITED = 10_000


def silhouette_at(dmat: np.ndarray, labels: np.ndarray) -> float | None:
    """带**无定义显式判定**的 silhouette：簇数越界返回 None（不是 -1）。

    Core 的实现对 >40 簇返回 -1（哨兵）。本函数把它翻成 None，
    强制调用方**显式决定**怎么处置，而不是让 -1 混进排序。
    """
    k = int(np.unique(labels).size)
    if k < 2 or k > sp.MAX_SILHOUETTE_CLUSTERS:
        return None
    return sp.silhouette(dmat, labels)


# ---------------------------------------------------------------- 规则集合 + 结构安全性闸门


def rule_silhouette_max(grid: list[dict], k_hint: int) -> list[dict]:
    """**现行路线**：silhouette 最大（候选集由调用方给定）。"""
    return [g for g in grid if g["sil"] is not None]


def rule_k_floor_from_hint(grid: list[dict], k_hint: int) -> list[dict]:
    """数据驱动下限：K >= k_hint（k_hint 由**同一素材**的其他估计给出，非常数）。"""
    return [g for g in grid if g["sil"] is not None and g["k"] >= k_hint]


def rule_k_neighbourhood(grid: list[dict], k_hint: int) -> list[dict]:
    """邻域约束：|K - k_hint| <= 1（比单侧下限更紧，但仍不排除 2 人档）。"""
    return [g for g in grid if g["sil"] is not None and abs(g["k"] - k_hint) <= 1]


def rule_k_floor_loose(grid: list[dict], k_hint: int) -> list[dict]:
    """宽松下限：K >= k_hint - 1（给估计误差留一档余量）。"""
    return [g for g in grid if g["sil"] is not None and g["k"] >= k_hint - 1]


RULES: dict = {
    "A0_silhouette_max": rule_silhouette_max,
    "B1_k_ge_hint": rule_k_floor_from_hint,
    "E1_k_neighbourhood": rule_k_neighbourhood,
    "E2_k_ge_hint_minus_1": rule_k_floor_loose,
}

# 反过拟合闸门：**故意**登记一个已知不安全的规则，用于证明闸门有区分力
UNSAFE_REGRESSION_RULE = (
    "B3_k_ge_4_blanket",
    lambda grid, k_hint: [g for g in grid if g["sil"] is not None and g["k"] >= 4],
)

SAFE_K_RANGE: tuple[int, ...] = (2, 3, 4, 5, 6, 7)


def structural_safety(pred, *, k_range: tuple[int, ...] = SAFE_K_RANGE) -> dict:
    r"""规则的**结构安全性**：它是否把某些素材的正确答案**排除在候选之外**？

    **为什么必须有这道闸门**：本包的验收语料真值 K 只覆盖 3–7（AMI 15/16 场是 K=4，
    AISHELL-4 是 5–7）。于是**任何"在这 36 场上更优"的规则都可能只是拟合了这个偏差**——
    实测确实如此：一个朴素的 "k >= 4" 下限在两个语料上**都**优于更讲究的规则，
    但对 **2 人素材**（口播、对谈——产品的主场景）会把**正确答案直接排除**。

    故本函数对每个 K 档构造一个**理想候选集**（正确答案的 silhouette 最高），
    检查规则是否仍能**有可能**选中它。

    这是**必要条件**，不是充分条件：通过它只说明"没把答案关在门外"，
    是否真的选对**仍需**在覆盖各 K 档的语料上验证
    （本包当前语料**不覆盖 K<=2**，见门 §10 O6）。
    """
    per_k: dict[str, bool] = {}
    for k_true in k_range:
        grid = [
            {
                "tau": round(0.10 + 0.05 * i, 2),
                "k": k,
                "der": 0.20,
                "sil": 0.50 if k == k_true else 0.30,
                "min_cluster_share": 0.5 if k == k_true else 0.01,
                "max_cluster_share": 0.5,
                "n_small_clusters": 0,
            }
            for i, k in enumerate(range(2, 9))
        ]
        cands = pred(grid, k_true)  # 假设说话人数估计恰好正确
        per_k[str(k_true)] = any(g["k"] == k_true for g in cands)
    return {"per_k": per_k, "safe": all(per_k.values())}


def sweep_meeting(wins, vecs: np.ndarray, ref, total_s: float) -> dict:
    """一场会议在全部上限档位下的 (capped_best, capped_pick)。"""
    den = sp.build_dendrogram(vecs)
    x = np.asarray(vecs, dtype=np.float64)
    x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    dmat = 1.0 - x @ x.T

    # 整条 τ 网格一次算完 ⇒ 之后每个 cap 只是筛选，零重算
    grid: list[dict] = []
    for tau in sp.TAU_GRID:
        labels = sp.labels_at(den, tau)
        turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
        # 簇规模分布：用于诊断"silhouette 是否偏好退化划分"（一大簇 + 极小的簇）。
        # 这是本工具的核心读数之一——**必须落盘**，否则无法离线检验"拒绝退化划分"类规则。
        _, counts = np.unique(labels, return_counts=True)
        share = counts / counts.sum()
        grid.append(
            {
                "tau": round(float(tau), 2),
                "k": int(np.unique(labels).size),
                "der": float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der),
                "sil": silhouette_at(dmat, labels),
                "min_cluster_share": round(float(share.min()), 5),
                "max_cluster_share": round(float(share.max()), 5),
                "n_small_clusters": int((share < 0.05).sum()),
            }
        )

    out: dict = {"grid": grid, "caps": {}}
    for cap in CAPS:
        cands = [g for g in grid if 2 <= g["k"] <= cap]
        if not cands:
            out["caps"][str(cap)] = {"error": "no tau with 2<=k<=cap"}
            continue
        best = min(cands, key=lambda g: g["der"])
        # 只在与 silhouette 有定义的交集上选；无定义的 τ 不参与（见模块 docstring）
        defined = [g for g in cands if g["sil"] is not None]
        undefined = len(cands) - len(defined)
        pick = max(defined, key=lambda g: g["sil"]) if defined else None
        out["caps"][str(cap)] = {
            "n_candidates": len(cands),
            "n_silhouette_undefined": undefined,
            "capped_best": {"der": round(best["der"], 4), "tau": best["tau"], "k": best["k"]},
            "capped_pick": None
            if pick is None
            else {
                "der": round(pick["der"], 4),
                "tau": pick["tau"],
                "k": pick["k"],
                "sil": round(float(pick["sil"]), 4),
            },
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--diag-json", required=True)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", default=None, help="diag 未落盘窗集合时需要重建")
    ap.add_argument("--audio-ext", default=".Mix-Headset.wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument(
        "--silero", default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx"
    )
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rttm_of: dict = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    report: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": args.corpus,
        "condition": args.condition,
        "caps": [c for c in CAPS if c != UNLIMITED] + ["unlimited"],
        "silhouette_defined_max_clusters": sp.MAX_SILHOUETTE_CLUSTERS,
        "meetings": {},
    }
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
            print(f"[{m}] SKIP (cache/window mismatch)", flush=True)
            continue
        r = sweep_meeting(wins, hit[0], ref, e["total_s"])
        r["k_true"] = int(e["ref_speakers"])
        r["total_s"] = float(e["total_s"])
        report["meetings"][m] = r
        c8 = r["caps"].get("8", {})
        cu = r["caps"].get(str(UNLIMITED), {})
        print(
            f"[{m}] k_true={r['k_true']} | cap8 pick={c8.get('capped_pick')} "
            f"best={c8.get('capped_best')} || unlimited pick="
            f"{cu.get('capped_pick')} best={cu.get('capped_best')}",
            flush=True,
        )
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    summary: dict = {}
    for cap in report["caps"]:
        key = str(UNLIMITED) if cap == "unlimited" else str(cap)
        picks, bests, ks, ndef = [], [], [], 0
        for r in report["meetings"].values():
            c = r["caps"].get(key)
            if not c or "capped_best" not in c:
                continue
            bests.append(c["capped_best"]["der"])
            ndef += c.get("n_silhouette_undefined", 0)
            if c["capped_pick"]:
                picks.append(c["capped_pick"]["der"])
                ks.append(c["capped_pick"]["k"])
        if not bests:
            continue
        pa, ba = np.array(picks), np.array(bests)
        summary[cap] = {
            "n": len(bests),
            "pick_mean": round(float(pa.mean()), 4) if pa.size else None,
            "pick_worst": round(float(pa.max()), 4) if pa.size else None,
            "best_mean": round(float(ba.mean()), 4),
            "best_worst": round(float(ba.max()), 4),
            "criterion_gap_mean": round(float(pa.mean() - ba.mean()), 4) if pa.size else None,
            "picked_k_median": int(np.median(ks)) if ks else None,
            "picked_k_max": int(np.max(ks)) if ks else None,
            "silhouette_undefined_total": ndef,
        }
    report["summary"] = summary
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== SUMMARY (" + args.corpus + ") ===")
    print(
        f"{'cap':>9s} {'pick_mean':>9s} {'pick_worst':>10s} {'best_mean':>9s} "
        f"{'best_worst':>10s} {'crit_gap':>8s} {'K_med':>5s} {'K_max':>5s} {'sil_undef':>9s}"
    )
    for cap, s in summary.items():
        pm = "-" if s["pick_mean"] is None else f"{s['pick_mean']:.4f}"
        pw = "-" if s["pick_worst"] is None else f"{s['pick_worst']:.4f}"
        cg = "-" if s["criterion_gap_mean"] is None else f"{s['criterion_gap_mean']:+.4f}"
        km = "-" if s["picked_k_median"] is None else str(s["picked_k_median"])
        kx = "-" if s["picked_k_max"] is None else str(s["picked_k_max"])
        print(
            f"{str(cap):>9s} {pm:>9s} {pw:>10s} {s['best_mean']:9.4f} "
            f"{s['best_worst']:10.4f} {cg:>8s} {km:>5s} {kx:>5s} "
            f"{s['silhouette_undefined_total']:>9d}"
        )
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
