r"""W2.2 §5.3 后续 —— 「把自动 K 做稳」的诊断与候选规则评测。

门 `W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md` §5.3 把方向从「是否上 VBx」改为
**「先把自动 K 做稳」**，针对两个已识别机制：

  ① **自动 K 系统性欠分割**（AMI 9/16、AISHELL-4 8/20 场的 K̂ < 真值 K）；
  ② **过门对 k-means 初值敏感**（8 个确定性初值中 2 个中文最差场越线）。

本脚本把这件事拆成**两个必须分别回答的问题**（混在一起会得出错误结论）：

  **A. 「K 选得更接近真值」是否等于「DER 更低」？**
     这是**解耦检验**。§5.3 的三条反证里，第 3 条（自动 K 均值更差、最差更好）已经
     暗示答案可能是否定的——若更好的 K 并不带来更低的 DER，那么「把自动 K 做稳」
     这个方向**本身就不成立**，必须先知道这一点再投入。
     判据：比较同一批 embedding 下 \`argmin_K DER\`（上界）与 \`K=真值\` 的 DER。

  **B. 有没有跨初值稳定、且严格优于现行 silhouette 的规则？**
     候选规则只做**选择**，聚类一律是同一个 k-means。

## 为什么分两个阶段

**聚类与 DER 是昂贵的一次性成本，规则只是选择**。故：

    --mode sweep     : 对每个 (会议, 初值, K) 算 DER + silhouette + inertia，落盘 ladder
    --mode evaluate  : 只读 ladder，套用候选规则，**零重算**

这样**反复试规则不需要重跑聚类**，也让归档的 ladder 成为唯一的数字来源
（规则改动不可能悄悄改变 DER——DER 在 ladder 里是冻结的）。
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
from diarization_cluster_routes import kmeans_cosine  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

K_RANGE: tuple[int, ...] = (2, 3, 4, 5, 6, 7, 8)
GATE_MEAN = 0.40
GATE_WORST = 0.55


# ------------------------------------------------------------------ 统计量


def silhouette_of(vecs: np.ndarray, labels: np.ndarray) -> float:
    """余弦距离上的轮廓系数（复用 Core 的块矩阵实现，防两份漂移）。"""
    x = np.asarray(vecs, dtype=np.float64)
    x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    dmat = 1.0 - x @ x.T
    return sp.silhouette(dmat, labels)


def total_scatter(vecs: np.ndarray) -> float:
    r"""余弦空间的**总散布** T = Σ_i (1 − cos(x_i, 全局中心))。

    k-means 的 W（簇内散布）由 `kmeans_cosine` 的 inertia 给出，且 T 与 K 无关
    ⇒ **Calinski-Harabasz 可完全由 ladder 里的 W 推出**，无需重跑聚类：
        CH(K) = (B/(K−1)) / (W/(n−K)),  B = T − W
    这是「规则只做选择、不重算聚类」能在本脚本成立的关键。
    """
    x = np.asarray(vecs, dtype=np.float64)
    x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    g = x.mean(axis=0)
    ng = float(np.linalg.norm(g))
    g = g / ng if ng > 0 else g
    return float((1.0 - x @ g).sum())


def calinski_harabasz(t: float, w: float, k: int, n: int) -> float:
    """由 (T, W, K, n) 直接算 CH。退化情形返回 -inf（规则会绕开）。"""
    if k < 2 or n - k <= 0:
        return float("-inf")
    w = max(float(w), 1e-12)
    b = max(float(t) - float(w), 0.0)
    return float((b / (k - 1)) / (w / (n - k)))


# ------------------------------------------------------------------ 阶段一：ladder


def sweep_meeting(
    vecs: np.ndarray, wins, ref, total_s: float, *, seeds: int, k_range=K_RANGE
) -> dict:
    """对一场会议跑 (初值 × K) 网格，返回 ladder（DER + silhouette + inertia）。"""
    n = int(vecs.shape[0])
    t_scatter = total_scatter(vecs)
    ladder: dict = {"n_windows": n, "total_scatter": round(t_scatter, 4), "seeds": {}}

    def der_pair(labels) -> tuple[float, float]:
        turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
        hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
        return (
            float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der),
            float(score(ref, hyp, total_s=total_s, ignore_overlap=False).der),
        )

    for s in range(seeds):
        per_k: dict[str, dict] = {}
        for k in k_range:
            if k > n:
                break
            lab, inertia = kmeans_cosine(vecs, k, seed=s)
            if np.unique(lab).size < 2:
                continue
            d_ign, d_cnt = der_pair(lab)
            per_k[str(k)] = {
                "der_ignore": round(d_ign, 4),
                "der_count": round(d_cnt, 4),
                "silhouette": round(silhouette_of(vecs, lab), 5),
                "inertia": round(float(inertia), 4),
            }
        ladder["seeds"][str(s)] = per_k
    return ladder


def run_sweep(args) -> int:
    diag = json.loads(Path(args.diag_json).read_text(encoding="utf-8"))
    cache = EmbeddingCache(args.cache_dir)
    rttm_of: dict = {}
    for p in Path(args.rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)

    ladder: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": args.corpus,
        "condition": args.condition,
        "seeds": args.seeds,
        "k_range": list(K_RANGE),
        "config": {
            "diag_json": args.diag_json,
            "audio_ext": args.audio_ext,
            "channel": args.channel,
        },
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
        t0 = time.time()
        lad = sweep_meeting(hit[0], wins, ref, e["total_s"], seeds=args.seeds)
        lad["k_true"] = int(e["ref_speakers"])
        lad["total_s"] = float(e["total_s"])
        ladder["meetings"][m] = lad
        best = min((v["der_ignore"], int(k)) for k, v in lad["seeds"]["0"].items())
        print(
            f"[{m}] n={lad['n_windows']} k_true={lad['k_true']} "
            f"best(K={best[1]},der={best[0]:.4f}) {time.time() - t0:.1f}s",
            flush=True,
        )
        Path(args.out).write_text(
            json.dumps(ladder, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    Path(args.out).write_text(json.dumps(ladder, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {args.out}  meetings={len(ladder['meetings'])}")
    return 0


# ------------------------------------------------------------------ 候选规则（纯函数）

# 规则签名：rule(per_k: dict[str, dict], meta: dict) -> int | None
#   per_k: {"2": {der_ignore, der_count, silhouette, inertia}, ...}
#   meta : {"k_true": int, "n_windows": int, "total_scatter": float, "k_max": int}


def rule_oracle_k(per_k, meta):
    """参照（**不可产品化**）：真值 K。"""
    k = int(meta["k_true"])
    return k if str(k) in per_k else None


def rule_best_der(per_k, meta):
    """上界参照（**不可产品化**）：该场 DER 最低的 K。用于回答「K 还有多少余量」。"""
    return int(min(per_k, key=lambda k: per_k[k]["der_ignore"]))


def rule_silhouette(per_k, meta):
    """**现行路线**（§5.3 的 kmeans_silhouette）：silhouette 最大的 K。"""
    return int(max(per_k, key=lambda k: per_k[k]["silhouette"]))


def rule_silhouette_maxk(per_k, meta, *, delta: float = 0.02):
    """反欠分割变体：silhouette 距最优不超过 delta 者中，取**最大** K。

    动机：§5.3 已证 silhouette 系统性偏好小 K。若多个 K 的 silhouette 接近，
    现行规则按「最大 silhouette」打破平局，方向恰好偏向欠分割；本规则反向打破平局。
    """
    best = max(per_k[k]["silhouette"] for k in per_k)
    ok = [int(k) for k in per_k if per_k[k]["silhouette"] >= best - delta]
    return max(ok) if ok else None


def rule_ch(per_k, meta):
    """Calinski-Harabasz 最大（另一种「簇紧致 vs 簇数」的权衡，不偏好粗分）。"""
    n, t = int(meta["n_windows"]), float(meta["total_scatter"])
    return int(max(per_k, key=lambda k: calinski_harabasz(t, per_k[k]["inertia"], int(k), n)))


def rule_kmax(per_k, meta):
    """稻草人对照：**永远取最大 K**（「绝不欠分割」的极端）。用于证明
    「把 K 做大」本身不是解药——过分割会把 spkerr 推上去。"""
    return int(max(int(k) for k in per_k))


def rule_silhouette_median_k(per_seed: dict, meta):
    """**跨初值聚合**：每初值各选一次 silhouette 最优 K，取**中位数**。

    这是"把自动 K 做稳"最直接的实现——现行实现每个初值独立选 K，
    于是"结论随初值变"。聚合掉初值噪声后，**决策**（选哪个 K）变得与初值无关。
    """
    picks = []
    for per_k in per_seed.values():
        k = rule_silhouette(per_k, meta)
        if k is not None:
            picks.append(int(k))
    return int(np.median(picks)) if picks else None


def rule_silhouette_pooled(per_seed: dict, meta):
    """**跨初值聚合（更强）**：先对每个 K 把 silhouette 在初值间取中位数，再取最优 K。

    与 `rule_silhouette_median_k` 的区别：后者聚合的是**决策**（各初值选出的 K），
    本规则聚合的是**分数**（各 K 的 silhouette）。当某些初值给出退化聚类时，
    分数层面的聚合更不容易被单个坏初值带跑。
    """
    ks = sorted({k for per_k in per_seed.values() for k in per_k}, key=int)
    if not ks:
        return None
    med = {
        k: float(np.median([per_k[k]["silhouette"] for per_k in per_seed.values() if k in per_k]))
        for k in ks
    }
    return int(max(ks, key=lambda k: med[k]))


def rule_silhouette_worstcase(per_seed: dict, meta):
    """**跨初值聚合（保守）**：取各初值选出的 K 中**最小**者。

    动机：DER(K) 是 U 形的（实测 128/128 与 160/160 场非单调），且 §5.3 已证
    自动 K 系统性偏小。故"最坏情形"取最小 K —— 若小 K 反而更稳，本规则会胜出；
    若它明显更差，则"欠分割有害"被证伪，方向需要改写。
    """
    picks = [
        int(rule_silhouette(per_k, meta))
        for per_k in per_seed.values()
        if rule_silhouette(per_k, meta) is not None
    ]
    return min(picks) if picks else None


# --- 逐初值规则（输入：单初值的 K 字典）---
RULES = {
    "silhouette": rule_silhouette,
    "silhouette_maxk": rule_silhouette_maxk,
    "calinski_harabasz": rule_ch,
    "kmax_strawman": rule_kmax,
    "oracle_k_true": rule_oracle_k,
    "oracle_best_der": rule_best_der,
}

# --- 会议级（跨初值）规则（输入：{seed: K 字典}）---
MEETING_RULES = {
    "silhouette_median_k": rule_silhouette_median_k,
    "silhouette_pooled": rule_silhouette_pooled,
    "silhouette_worstcase": rule_silhouette_worstcase,
}

NON_PRODUCTIZABLE = {"oracle_k_true", "oracle_best_der"}


# ------------------------------------------------------------------ 阶段二：evaluate


def _pair(d, key):
    return d[key]["der_ignore"]


def evaluate(
    ladder: dict,
    rules: dict,
    *,
    k_max_filter: int | None = None,
    meeting_rules: dict | None = None,
) -> dict:
    """把候选规则套在 ladder 上。零聚类重算。

    `rules`        逐初值规则：`fn(per_k, meta) -> K`，每个初值各报一行。
    `meeting_rules` 会议级规则：`fn({seed: per_k}, meta) -> K`，**一场只出一个 K**
                    （结果天然与初值无关——这正是"做稳"要检验的性质）。
    """
    meeting_rules = meeting_rules if meeting_rules is not None else {}
    out: dict = {"per_rule": {}, "per_meeting": {}}
    meetings = ladder["meetings"]
    for rname, fn in rules.items():
        per_seed_rows: dict[str, list] = {}
        khat_rows: dict[str, list] = {}
        for m, lad in meetings.items():
            for s, per_k in lad["seeds"].items():
                if k_max_filter is not None:
                    per_k = {k: v for k, v in per_k.items() if int(k) <= k_max_filter}
                    if not per_k:
                        continue
                meta = {
                    "k_true": lad["k_true"],
                    "n_windows": lad["n_windows"],
                    "total_scatter": lad["total_scatter"],
                }
                k = fn(per_k, meta)
                if k is None or str(k) not in per_k:
                    continue
                per_seed_rows.setdefault(s, []).append((m, _pair(per_k, str(k))))
                khat_rows.setdefault(s, []).append((m, int(k), lad["k_true"]))
        seeds_out = {}
        for s in sorted(per_seed_rows, key=int):
            ds = np.array([d for _, d in per_seed_rows[s]])
            if ds.size == 0:
                continue
            worst_m = max(per_seed_rows[s], key=lambda t: t[1])[0]
            seeds_out[s] = {
                "n": int(ds.size),
                "mean": round(float(ds.mean()), 4),
                "worst": round(float(ds.max()), 4),
                "worst_meeting": worst_m,
                "mean_pass": bool(ds.mean() <= GATE_MEAN),
                "worst_pass": bool(ds.max() <= GATE_WORST),
                "both_pass": bool(ds.mean() <= GATE_MEAN and ds.max() <= GATE_WORST),
            }
        if not seeds_out:
            continue
        means = [v["mean"] for v in seeds_out.values()]
        worsts = [v["worst"] for v in seeds_out.values()]
        bias = [k - kt for s in khat_rows for _, k, kt in khat_rows[s]]
        out["per_rule"][rname] = {
            "productizable": rname not in NON_PRODUCTIZABLE,
            "seeds": seeds_out,
            "mean_range": [round(min(means), 4), round(max(means), 4)],
            "worst_range": [round(min(worsts), 4), round(max(worsts), 4)],
            "all_seeds_pass": bool(all(v["both_pass"] for v in seeds_out.values())),
            "failing_seeds": sorted(
                [s for s, v in seeds_out.items() if not v["both_pass"]], key=int
            ),
            "k_bias_mean": round(float(np.mean(bias)), 3) if bias else None,
            "k_under": f"{sum(1 for x in bias if x < 0)}/{len(bias)}",
            "k_over": f"{sum(1 for x in bias if x > 0)}/{len(bias)}",
        }
    # 逐场明细（seed 0）；**与 per_rule 用同一份候选集**（截断必须处处一致，
    # 否则"逐场明细"与"汇总"会描述两个不同的实验）
    for m, lad in meetings.items():
        pk = lad["seeds"].get("0", {})
        if k_max_filter is not None:
            pk = {k: v for k, v in pk.items() if int(k) <= k_max_filter}
        if not pk:
            continue
        meta = {
            "k_true": lad["k_true"],
            "n_windows": lad["n_windows"],
            "total_scatter": lad["total_scatter"],
        }
        out["per_meeting"][m] = {
            "k_true": lad["k_true"],
            "n_windows": lad["n_windows"],
            "der_by_k": {k: pk[k]["der_ignore"] for k in sorted(pk, key=int)},
            "k_hat": {r: fn(pk, meta) for r, fn in rules.items()},
        }
    # 会议级（跨初值）规则：**输入是整场会议的 {seed: K 字典}**，
    # 故结果天然与初值无关（这正是"做稳"的含义），只报一个数。
    for rname, fn in meeting_rules.items():
        rows: list[tuple[str, float]] = []
        khat: list[tuple[int, int]] = []
        for m, lad in meetings.items():
            per_seed = {}
            for s, per_k in lad["seeds"].items():
                if k_max_filter is not None:
                    per_k = {k: v for k, v in per_k.items() if int(k) <= k_max_filter}
                if per_k:
                    per_seed[s] = per_k
            if not per_seed:
                continue
            meta = {
                "k_true": lad["k_true"],
                "n_windows": lad["n_windows"],
                "total_scatter": lad["total_scatter"],
            }
            k = fn(per_seed, meta)
            if k is None:
                continue
            k = int(k)
            # **聚合的是 K 的"决策"，不是聚类的"结果"**：K 定下来之后，
            # 每个初值仍会给出不同的聚类（初值敏感并未消失）。
            # 故本规则在**每个初值上**都用这个统一的 K 记一次分——
            # 只取一个初值会把"最差场"报得过于乐观（那正是 §5.3 反证 2 的形态）。
            ders = [_pair(per_k, str(k)) for per_k in per_seed.values() if str(k) in per_k]
            if not ders:
                continue
            rows.append((m, float(max(ders)), float(np.mean(ders))))  # (场, 最差初值, 均值)
            khat.append((k, lad["k_true"]))
        if not rows:
            continue
        # 均值按**场**先聚合（与 per_rule 的其余部分同口径：mean of meeting means），
        # 最差场取所有 (场, 初值) 组合中的最大值——即"跨初值最坏情形"。
        per_meeting_mean = np.array([mm for _, _, mm in rows])
        worst_d = max(d for _, d, _ in rows)
        worst_m = max(rows, key=lambda t: t[1])[0]
        bias = [k - kt for k, kt in khat]
        agg = {
            "n": int(per_meeting_mean.size),
            "mean": round(float(per_meeting_mean.mean()), 4),
            "worst": round(float(worst_d), 4),
            "worst_meeting": worst_m,
            "mean_pass": bool(per_meeting_mean.mean() <= GATE_MEAN),
            "worst_pass": bool(worst_d <= GATE_WORST),
            "both_pass": bool(per_meeting_mean.mean() <= GATE_MEAN and worst_d <= GATE_WORST),
        }
        out["per_rule"][rname] = {
            "productizable": rname not in NON_PRODUCTIZABLE,
            "meeting_level": True,
            "seeds": {"aggregate": agg},
            "mean_range": [agg["mean"]] * 2,
            "worst_range": [agg["worst"]] * 2,
            "all_seeds_pass": bool(agg["both_pass"]),
            "failing_seeds": [],
            "k_bias_mean": round(float(np.mean(bias)), 3) if bias else None,
            "k_under": f"{sum(1 for x in bias if x < 0)}/{len(bias)}",
            "k_over": f"{sum(1 for x in bias if x > 0)}/{len(bias)}",
        }
    out["decouple"] = decouple_analysis(meetings, k_max_filter=k_max_filter)
    out["decouple_summary"] = out["decouple"]["summary"]
    return out


def decouple_analysis(meetings: dict, *, k_max_filter: int | None = None) -> dict:
    """**解耦检验**：更好的 K 是否等于更低的 DER？

    §5.3 的整个方向建议建立在「自动 K 偏小 ⇒ 修 K 就降 DER」这个前提上。
    本函数把它摆到台面上：对每场比较三条线（seed 0）

        der_true_k      真值 K 的 DER        —— 「K 选对了」的参照
        der_best_k      候选中最低 DER 的 K  —— 「K 还有多少余量」的上界
        der_silhouette_k 现行规则选的 K 的 DER

    若 `der_best_k` 与 `der_true_k` 都明显低于 `der_silhouette_k`，说明余量在 K；
    若 `der_best_k` 与 `der_silhouette_k` 几乎相同，说明**余量不在 K**，
    那么「把自动 K 做稳」这个方向本身就需要重新审视。
    """
    per_meeting: dict = {}
    for m, lad in meetings.items():
        pk = lad["seeds"].get("0", {})
        if not pk:
            continue
        if k_max_filter is not None:
            pk = {k: v for k, v in pk.items() if int(k) <= k_max_filter}
            if not pk:
                continue
        meta = {
            "k_true": lad["k_true"],
            "n_windows": lad["n_windows"],
            "total_scatter": lad["total_scatter"],
        }
        d_true = _pair(pk, str(lad["k_true"])) if str(lad["k_true"]) in pk else None
        d_best_k = int(min(pk, key=lambda k: pk[k]["der_ignore"]))
        k_sil = rule_silhouette(pk, meta)
        per_meeting[m] = {
            "k_true": lad["k_true"],
            "der_true_k": None if d_true is None else round(d_true, 4),
            "der_best_k": round(_pair(pk, str(d_best_k)), 4),
            "k_best": d_best_k,
            "der_silhouette_k": round(_pair(pk, str(k_sil)), 4),
            "k_silhouette": k_sil,
        }
    dts = [v["der_true_k"] for v in per_meeting.values() if v["der_true_k"] is not None]
    dbs = [v["der_best_k"] for v in per_meeting.values()]
    dss = [v["der_silhouette_k"] for v in per_meeting.values()]
    summary: dict = {
        "n": len(per_meeting),
        "best_k_mean": round(float(np.mean(dbs)), 4) if dbs else None,
        "best_k_worst": round(float(np.max(dbs)), 4) if dbs else None,
        "silhouette_k_mean": round(float(np.mean(dss)), 4) if dss else None,
        "silhouette_k_worst": round(float(np.max(dss)), 4) if dss else None,
    }
    if dts:
        summary["true_k_mean"] = round(float(np.mean(dts)), 4)
        summary["true_k_worst"] = round(float(np.max(dts)), 4)
    else:
        summary["true_k_mean"] = None
        summary["true_k_worst"] = None
    return {"per_meeting": per_meeting, "summary": summary}


def run_evaluate(args) -> int:
    ladder = json.loads(Path(args.ladder).read_text(encoding="utf-8"))
    res = evaluate(ladder, RULES, k_max_filter=args.k_max, meeting_rules=MEETING_RULES)
    res["corpus"] = ladder.get("corpus")
    res["condition"] = ladder.get("condition")
    res["seeds"] = ladder.get("seeds")
    res["gate"] = {"mean_max": GATE_MEAN, "worst_max": GATE_WORST}

    res["decouple_seed0"] = res["decouple"]["per_meeting"]
    res["decouple_summary"] = res["decouple"]["summary"]
    Path(args.out).write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"=== {res['corpus']} / {res['condition']} ===")
    for r, v in res["per_rule"].items():
        print(
            f"  {r:20s} mean={v['mean_range']} worst={v['worst_range']} "
            f"allpass={v['all_seeds_pass']} Kbias={v['k_bias_mean']} "
            f"under={v['k_under']}"
        )
    s = res["decouple_summary"]
    print(
        f"  DECOUPLE mean: best-K={s['best_k_mean']} true-K={s['true_k_mean']} "
        f"silhouette-K={s['silhouette_k_mean']}"
    )
    print(
        f"  DECOUPLE worst: best-K={s['best_k_worst']} true-K={s['true_k_worst']} "
        f"silhouette-K={s['silhouette_k_worst']}"
    )
    print(f"wrote {args.out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("sweep", "evaluate"), required=True)
    ap.add_argument("--corpus", default="ami")
    ap.add_argument("--diag-json")
    ap.add_argument("--ladder")
    ap.add_argument("--rttm-dir")
    ap.add_argument("--audio-dir", default=None)
    ap.add_argument("--audio-ext", default=".Mix-Headset.wav")
    ap.add_argument("--channel", type=int, default=None)
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument(
        "--silero", default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx"
    )
    ap.add_argument("--seeds", type=int, default=8)
    ap.add_argument("--k-max", type=int, default=None, help="评测时截断候选 K 的上限")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    if args.mode == "sweep":
        for req in ("diag_json", "rttm_dir"):
            if not getattr(args, req):
                ap.error(f"--{req.replace('_', '-')} is required for sweep")
        return run_sweep(args)
    if not args.ladder:
        ap.error("--ladder is required for evaluate")
    return run_evaluate(args)


if __name__ == "__main__":
    raise SystemExit(main())
