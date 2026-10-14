r"""W2.2 (a) spike 的**补充报告**：门 §4.3 K5 要求的两项（预登记 §4.3）。

K5 要求"**必须报告**"三件事，其中：
  ① **估计器双向偏离行为**（门 §5.11 判定五）
  ② **方向相反会话行为**（门 §5.10 判定五）
  ③ 假阳性代价（主脚本已直接给）

本脚本从主 spike 的输出（含逐场 `grid`：tau / k / der / sil）**离线**计算 ①②，
不重跑任何聚类（**不重跑推理、不重跑评测**）。

定义（先于计算写定）：
  · **方向相反会话**：`rho = Spearman(silhouette(K), -DER(K)) < 0`，K 走候选窗内可用档位
    （与 §5.10 的判据逐字一致）。
  · **双向偏离**：对"是否单人"这一二元判定——
      **高估方向（FP）** = 判单人（触发分支）而 K_true > 1；
      **低估方向（FN）** = 未触发而 K_true == 1。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def spearman(a, b) -> float:
    """秩相关（无 scipy 依赖）：平均秩处理并列。"""

    def rank(x):
        x = np.asarray(x, float)
        order = np.argsort(x, kind="mergesort")
        r = np.empty(len(x), float)
        r[order] = np.arange(len(x), dtype=float)
        # 平均秩处理并列
        i = 0
        while i < len(x):
            j = i
            while j + 1 < len(x) and x[order[j + 1]] == x[order[i]]:
                j += 1
            if j > i:
                r[order[i:j + 1]] = np.mean(r[order[i:j + 1]])
            i = j + 1
        return r

    ra, rb = rank(a), rank(b)
    ra = ra - ra.mean()
    rb = rb - rb.mean()
    den = np.sqrt((ra @ ra) * (rb @ rb))
    return float((ra @ rb) / den) if den > 0 else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spike", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rep = json.loads(Path(args.spike).read_text(encoding="utf-8"))
    out: dict = {"K5_required_reports": {}}
    grids = rep.get("grids", {})

    # ---------- ② 方向相反会话 ----------
    dirrep: dict = {}
    for cname in rep["corpora"]:
        rows = rep["corpora"][cname]["per_meeting"]
        reversed_sessions, normal_sessions = [], []
        for r in rows:
            m = r["meeting"]
            grid = grids.get(cname, {}).get(m, {}).get("grid")
            if grid is None:
                continue
            pts = [(g["k"], g["sil"], g["der"]) for g in grid
                   if g.get("sil") is not None and 2 <= g["k"] <= 8]
            if len(pts) < 3:
                continue
            k = [p[0] for p in pts]
            s = [p[1] for p in pts]
            d = [p[2] for p in pts]
            rho = spearman(s, [-x for x in d])
            rec = {"meeting": m, "k_true": r["k_true"], "rho": round(rho, 4),
                   "base_der": r["base_der"], "cand_der": r["cand_der"],
                   "triggered": r["triggered"], "separation": r["separation"]}
            (reversed_sessions if rho < 0 else normal_sessions).append(rec)

        def agg(rs):
            if not rs:
                return {"n": 0}
            return {
                "n": len(rs),
                "base_mean": round(float(np.mean([x["base_der"] for x in rs])), 4),
                "base_worst": round(float(np.max([x["base_der"] for x in rs])), 4),
                "cand_mean": round(float(np.mean([x["cand_der"] for x in rs])), 4),
                "cand_worst": round(float(np.max([x["cand_der"] for x in rs])), 4),
                "trigger_rate": round(float(np.mean([x["triggered"] for x in rs])), 4),
            }

        dirrep[cname] = {
            "reversed": agg(reversed_sessions),
            "normal": agg(normal_sessions),
            "reversed_sessions": reversed_sessions,
            "criterion": "rho = Spearman(silhouette(K), -DER(K)) < 0（与 §5.10 判据逐字一致）",
        }

    out["K5_required_reports"]["direction_reversed_sessions"] = dirrep

    # ---------- ① 双向偏离 ----------
    dev = {}
    for cname in rep["corpora"]:
        c = rep["corpora"][cname]
        n1 = c["k1_fields"]
        caught = c["k1_caught"]
        fp = c["false_positives"]
        dev[cname] = {
            "k1_fields": n1,
            "true_positive_says_single": caught,
            "false_positive_says_single_but_multi": fp,
            "false_negative_missed_single": n1 - caught,
            "fn_rate": round((n1 - caught) / n1, 4) if n1 else None,
            "fp_rate": round(fp / max(c["n"] - n1, 1), 4),
            "note": "FP=高估方向、FN=低估方向；两方向都必须报（§5.11 判定五）",
        }
    out["K5_required_reports"]["bidirectional_deviation"] = dev

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
