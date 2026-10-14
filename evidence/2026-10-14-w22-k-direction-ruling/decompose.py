#!/usr/bin/env python
"""W2.2 方向裁决 —— 失败**拆因**的可复现分析（纯读取，不训练/不解码/不跑模型）。

回答一个问题（架构裁决书 ADR-0006 的证据基础）：

    低人数档最差场，是**一件事**还是**两件事**？

拆成两条互不代替的欠账：
    (a) 表达能力 —— 准则**结构上**无法输出 K=1（候选窗 [2, k_max]，silhouette 在 K=1 无定义）；
    (b) 判别能力 —— 正确答案**在**候选集里，但没被选中。

**本脚本全部输入均为已归档证据**（见 INPUTS），不依赖 .tmp 工作副本，
故任何人在任何机器上都能复算出 ADR-0006 引用的每一个数字。

⚠️ 本分析**未预登记**：它是**探索性**读数，用途仅限"判断下一轮该设计什么实验"。
按本项目纪律，**不得**作为"某规则更优"的证据，也**不得**替代 S3 的精度门。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
EV = ROOT / "evidence"

# ---- 已归档输入（全部 committed）----
LOWK_GRID = EV / "2026-10-13-w22-g-voxconverse-test-lowk/lowk-test-report.json"
LOWK_COND = EV / "2026-10-13-w22-g-voxconverse-test-lowk/conditions.json"
KEST_VC = EV / "2026-10-13-w22-j-k-estimator/e0-vc-test-lowk.json"
KEST_AMI = EV / "2026-10-13-w22-j-k-estimator/e0-ami.json"
SPIKE_G = EV / "2026-10-13-w22-i-criterion-spike/spike-vc-ami.json"
AMI_DIAG = EV / "2026-10-12-w22-d-planA-recheck/diag-ami-fixed.json"
AMI_BASE = EV / "2026-10-12-w22-d-planA-recheck/baseline-routes-ami.json"

K_MAX = 8  # 门 §4 冻结值 DEFAULT_K_MAX
K_LOW = 3  # 门 §10 O6 低人数档上界


def _load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def pearson(a, b) -> float:
    a = np.asarray(a, float) - np.mean(a)
    b = np.asarray(b, float) - np.mean(b)
    den = np.sqrt((a @ a) * (b @ b))
    return float((a @ b) / den) if den > 0 else 0.0


def auc_low_predicts_pos(score, pos) -> float:
    """AUC = P(score_neg > score_pos) + 0.5*P(相等)，即"低分 => 正类"的区分力。"""
    score = np.asarray(score, float)
    pos = np.asarray(pos, bool)
    p, q = score[pos], score[~pos]
    if len(p) == 0 or len(q) == 0:
        return float("nan")
    return float((q[:, None] > p[None, :]).mean() + 0.5 * (q[:, None] == p[None, :]).mean())


def partial_corr(x, y, z) -> float:
    """corr(x, y | z)：对 z 线性回归取残差后再算相关。"""
    z = np.asarray(z, float)
    B = np.c_[np.ones_like(z), z]

    def resid(v):
        v = np.asarray(v, float)
        c, *_ = np.linalg.lstsq(B, v, rcond=None)
        return v - B @ c

    return pearson(resid(x), resid(y))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    grid = _load(LOWK_GRID)["per_meeting"]
    cond = _load(LOWK_COND)
    kest_vc = {r["name"]: r for r in _load(KEST_VC)["rows"]}
    kest_ami = {r["name"]: r for r in _load(KEST_AMI)["rows"]}
    spike_g = _load(SPIKE_G)["corpora"]["vc-test-lowk"]["meetings"]
    ami_diag = _load(AMI_DIAG)["meetings"]
    ami_base = _load(AMI_BASE)["meetings"]

    names = sorted(grid)
    kt = np.array([grid[m]["k_true"] for m in names])
    rep: dict = {"inputs": {k: str(v.relative_to(ROOT)) for k, v in {
        "lowk_grid": LOWK_GRID, "conditions": LOWK_COND, "kest_vc": KEST_VC,
        "kest_ami": KEST_AMI, "spike_g": SPIKE_G, "ami_diag": AMI_DIAG,
        "ami_base": AMI_BASE}.items()}}

    def ders(m, lo, hi):
        return [x["der"] for x in grid[m]["grid"] if lo <= x["k"] <= hi]

    def d_best(m, lo, hi):
        v = ders(m, lo, hi)
        return min(v) if v else None

    def mean(x):
        return round(float(np.mean(x)), 4)

    def worst(x):
        return round(float(np.max(x)), 4)

    cur = [grid[m]["silhouette"] for m in names]
    fix_a = [(d_best(m, 1, 1) if grid[m]["k_true"] == 1 and d_best(m, 1, 1) is not None
              else grid[m]["silhouette"]) for m in names]
    fix_b = [d_best(m, 2, K_MAX) for m in names]          # == 门的"oracle"候选窗
    fix_both = [min(x["der"] for x in grid[m]["grid"]) for m in names]

    rep["A_decomposition"] = {
        "n": len(names),
        "baseline_current": {"mean": mean(cur), "worst": worst(cur)},
        "fix_a_only_expressiveness": {"mean": mean(fix_a), "worst": worst(fix_a)},
        "fix_b_only_discrimination": {"mean": mean(fix_b), "worst": worst(fix_b)},
        "fix_both": {"mean": mean(fix_both), "worst": worst(fix_both)},
        "gate_lines": {"mean_max": 0.40, "worst_max": 0.55},
        "note": "fix_b 与门 §5.9 的 oracle 候选窗逐值同源（[2, k_max]）；三者为上界，非可达精度",
    }

    # ---- B. 门自身的 oracle 也带 (a) 缺陷 ----
    rep["B_gate_oracle_blind_to_k1"] = {
        "gate_oracle_min_k2": {"mean": mean(fix_b), "worst": worst(fix_b)},
        "true_oracle_any_k": {"mean": mean(fix_both), "worst": worst(fix_both)},
        "fields_where_gate_oracle_is_not_true_best": int(
            sum(1 for a, b in zip(fix_b, fix_both) if b < a - 1e-9)),
        "fields_whose_grid_contains_a_k1_point": int(
            sum(1 for m in names if d_best(m, 1, 1) is not None)),
        "note": "worst 不变 => 门 §5.5「oracle 过双门」仍成立且保守；但 mean 被虚高",
    }

    # ---- C. 按真值 K 分组 ----
    by_k = {}
    for k in sorted(set(kt.tolist())):
        sub = [i for i, m in enumerate(names) if kt[i] == k]
        k1d = [d_best(names[i], 1, 1) for i in sub]
        by_k[str(k)] = {
            "n": len(sub),
            "current_mean": mean([cur[i] for i in sub]),
            "current_worst": worst([cur[i] for i in sub]),
            "chosen_k_hat": sorted({int(grid[names[i]]["silhouette_k"]) for i in sub}),
            "at_k1_mean": mean([v for v in k1d if v is not None]) if any(v is not None for v in k1d) else None,
            "at_k1_worst": worst([v for v in k1d if v is not None]) if any(v is not None for v in k1d) else None,
        }
    rep["C_by_true_k"] = by_k

    # ---- D. K_true=1 的现状 ----
    k1_names = [m for m in names if grid[m]["k_true"] == 1]
    from collections import Counter
    hist = Counter(grid[m]["silhouette_k"] for m in k1_names)
    rep["D_single_speaker_fields"] = {
        "n": len(k1_names),
        "current_mean": mean([grid[m]["silhouette"] for m in k1_names]),
        "current_worst": worst([grid[m]["silhouette"] for m in k1_names]),
        "at_k1_mean": mean([d_best(m, 1, 1) for m in k1_names]),
        "at_k1_worst": worst([d_best(m, 1, 1) for m in k1_names]),
        "chosen_k_hat_histogram": {str(k): int(v) for k, v in sorted(hist.items())},
        "fields_choosing_k_hat_gt_2": int(sum(v for k, v in hist.items() if k > 2)),
        "k1_der_unique_per_field": int(sum(
            1 for m in names
            if len({round(x["der"], 6) for x in grid[m]["grid"] if x["k"] == 1}) <= 1)),
        "note": "K=1 时全部窗并入单轮次，DER 只由分段决定、与 tau 无关 => (a) 一旦修好是确定的",
    }

    # ---- E. (b) 残差：多人素材 ----
    resid = sorted(((grid[m]["silhouette"], m) for m in names if grid[m]["k_true"] != 1), reverse=True)
    rep["E_residual_multi_speaker"] = [
        {"meeting": m, "der": round(d, 4), "k_true": int(grid[m]["k_true"]),
         "k_hat": int(grid[m]["silhouette_k"]),
         "best_in_2_8": round(d_best(m, 2, K_MAX), 4),
         "gap_to_oracle": round(d - d_best(m, 2, K_MAX), 4)}
        for d, m in resid[:5]
    ]

    # ---- F. 与 §5.11 G1 的收敛 ----
    g1 = [spike_g[m]["G1"]["der"] for m in names]
    a0 = [spike_g[m]["A0"]["der"] for m in names]
    rep["F_g1_convergence"] = {
        "A0": {"mean": mean(a0), "worst": worst(a0)},
        "G1_cap_by_k_hat_dm": {"mean": mean(g1), "worst": worst(g1)},
        "G1_worst_field": max(names, key=lambda m: spike_g[m]["G1"]["der"]),
        "fix_a_worst_field": max(names, key=lambda m: fix_a[names.index(m)]),
        "same_worst_value": abs(worst(g1) - worst(fix_a)) < 5e-4,
        "catastrophic_fields": {
            m: {"k_true": int(spike_g[m]["k_true"]), "k_hat_dm": int(spike_g[m]["k_hat_dm"]),
                "A0_der": round(spike_g[m]["A0"]["der"], 4), "G1_der": round(spike_g[m]["G1"]["der"], 4)}
            for m in ["euqef", "zztbo", "neiye"]},
        "note": "两条独立路线（按 K_hat_dm 封顶 / 修表达能力）落在同一 worst 值 => 残差同源，均为 (b)",
    }

    # ---- G. separation 统计（判"是否单人"，非"估计 K"）----
    sep = np.array([kest_vc[m]["separation"] for m in names], float)
    single = kt == 1
    dur = np.array([cond[m]["total_s"] for m in names], float)
    rep["G_separation_statistic"] = {
        "definition": "fit_distance_mixture 的 separation=(mu_diff-mu_same)/pooled；现役只取 weight[0] 反推 k_hat",
        "corr_separation_k_true": round(pearson(sep, kt), 4),
        "auc_single_vs_multi": round(auc_low_predicts_pos(sep, single), 4),
        "median_sep_single": round(float(np.median(sep[single])), 4),
        "median_sep_multi": round(float(np.median(sep[~single])), 4),
        "corr_duration_k_true": round(pearson(dur, kt), 4),
        "corr_duration_separation": round(pearson(dur, sep), 4),
        "partial_corr_separation_k_true_given_duration": round(partial_corr(sep, kt, dur), 4),
        "note": "回归口径无信息（与 §5.12 P1 一致）；二元口径有信息；偏相关排除时长伪信号",
    }

    # ---- H. 阈值化的代价（假阳性）----
    ami_sep = np.array([kest_ami[m]["separation"] for m in ami_base], float)
    ami_cur = [ami_base[m]["strategies"]["silhouette_capK"]["der"] for m in ami_base]
    ami_k1 = {m: min((v["der"] for v in ami_diag[m]["conditions"]["silero_vad"]["curve"].values()
                      if v["hyp_speakers"] == 1), default=None) for m in ami_base}
    scan = {}
    for T in (0.75, 1.0, 1.25, 1.5, 2.0):
        out = []
        for i, m in enumerate(names):
            if sep[i] < T:
                v = d_best(m, 1, 1)
                out.append(v if v is not None else cur[i])
            else:
                out.append(cur[i])
        aout = [ami_k1[m] if (kest_ami[m]["separation"] < T and ami_k1[m] is not None)
                else ami_cur[i] for i, m in enumerate(ami_base)]
        scan[str(T)] = {
            "vc": {"mean": mean(out), "worst": worst(out),
                   "caught_single_fields": int(sum(1 for i, m in enumerate(names) if sep[i] < T and single[i])),
                   "false_positive_multi_fields": int(sum(1 for i, m in enumerate(names) if sep[i] < T and not single[i]))},
            "ami": {"mean": mean(aout), "worst": worst(aout),
                    "triggers_all_false_positive": int(sum(1 for m in ami_base if kest_ami[m]["separation"] < T))},
        }
    rep["H_threshold_cost"] = {
        "baseline_vc": {"mean": mean(cur), "worst": worst(cur)},
        "baseline_ami": {"mean": mean(ami_cur), "worst": worst(ami_cur)},
        "ami_if_all_forced_to_k1": {
            "mean": mean([v for v in ami_k1.values() if v is not None]),
            "worst": worst([v for v in ami_k1.values() if v is not None]),
            "n": sum(1 for v in ami_k1.values() if v is not None),
        },
        "scan": scan,
        "note": "AMI 16 场全为 3-4 人 => 每一次触发都是假阳性；"
                "T=1.5 处 AMI 代价近乎为零属阈值落点运气，不是安全保证——见 all_forced 一行",
    }

    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
