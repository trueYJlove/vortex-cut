"""W2.2 溯源工具：现行选择准则在低人数档上**失败在哪里**？

回答门 §5.9 判定一留下的问题：VoxConverse test 的 K_true=1 素材被切成 7-8 簇，
而门 §5.6② 记录的机制（"最优解卡在候选下界 K=2"）**解释不了**它。

## 三个相互独立的读数（都不需要真值）

1. **cap 归因**：argmax 是否落在候选窗上沿（pinned），以及放开 cap 后会怎样。
   ⇒ 把"上限问题"与"准则问题"分开（两者处方相反，§5.5/§5.6 已记录一次这样的反转）。
2. **VAD 归因**：silero 窗数 / oracle_vad 窗数。
   ⇒ 排除"窗集合太小导致聚类不稳"。
3. **准则方向**：`rho = Spearman(silhouette(K), -DER(K))`。
   **rho < 0 意味着准则的排序方向与精度相反**——argmax 会落在更差的解上。
   这是本工具的核心读数，也是 §5.6② 未覆盖的失效模式。

## 为什么要与"K_true"分组

K_true=1 的素材在 silhouette 上**结构性无解**（K=1 时 silhouette 无定义），
所以"准则方向反了"在单人与多人素材上**是不同的问题**，不能混算。

⚠️ 本工具只做读数与归因，**不开处方**（改准则属设计裁决，见门 §5.6④）。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT / "services" / "core" / "src", Path(__file__).resolve().parent):
    sys.path.insert(0, str(_p))

from diarization_cap_trace import silhouette_by_k  # noqa: E402

CAP = 8
SIL_DEFINED_MAX = 40


def spearman(a: list[float], b: list[float]) -> float | None:
    """Spearman ρ（纯 numpy，平均秩处理并列）。n < 3 时无意义，返回 None。"""
    n = len(a)
    if n < 3:
        return None

    def ranks(values: list[float]) -> np.ndarray:
        order = np.argsort(values, kind="stable")
        out = np.empty(n, dtype=np.float64)
        i = 0
        while i < n:
            j = i
            while j + 1 < n and values[order[j + 1]] == values[order[i]]:
                j += 1
            out[order[i : j + 1]] = (i + j) / 2.0 + 1.0
            i = j + 1
        return out

    ra, rb = ranks(a), ranks(b)
    ra = ra - ra.mean()
    rb = rb - rb.mean()
    da, db = math.sqrt(float((ra**2).sum())), math.sqrt(float((rb**2).sum()))
    if da == 0 or db == 0:
        return None
    return float((ra * rb).sum() / (da * db))


def der_best_by_k(entry: dict, k_max: int) -> dict[int, float]:
    out: dict[int, float] = {}
    for cell in entry["grid"]:
        k = int(cell["k"])
        if 2 <= k <= k_max:
            out[k] = min(out.get(k, 9.0), float(cell["der"]))
    return out


def trace_meeting(name: str, entry: dict, ceiling: int = CAP) -> dict | None:
    curve = silhouette_by_k(entry, ceiling)
    ks = sorted(k for k in curve if curve[k] is not None)
    if len(ks) < 2:
        return None
    sils = [float(curve[k]) for k in ks]  # type: ignore[arg-type]
    ders = der_best_by_k(entry, ceiling)
    dseq = [ders[k] for k in ks]
    rho = spearman(sils, [-d for d in dseq])
    wide = silhouette_by_k(entry, SIL_DEFINED_MAX)
    wide_ks = [k for k in wide if wide[k] is not None]
    wide_pick = max(wide_ks, key=lambda k: wide[k]) if wide_ks else None
    # ⚠️ wide_der 必须来自**同一放宽区间**：用 ceiling 段算出来的表查不到 K>8，
    # 会静默给出 NaN（本工具首版即踩，被回归用例当场抓出）。
    wide_ders = der_best_by_k(entry, SIL_DEFINED_MAX)
    pick_i = max(range(len(ks)), key=lambda i: sils[i])
    return {
        "name": name,
        "k_true": int(entry["k_true"]),
        "der": float(entry["silhouette"]),
        "k_pick": int(ks[pick_i]),
        "k_ceiling": int(ks[-1]),
        "pinned": int(ks[pick_i]) == int(ks[-1]),
        "rho_sil_vs_der": rho,
        "direction_reversed": (rho is not None and rho < 0),
        "sil_monotone_up": all(sils[i] <= sils[i + 1] for i in range(len(sils) - 1)),
        "der_monotone_up": all(dseq[i] <= dseq[i + 1] for i in range(len(dseq) - 1)),
        "wide_pick": int(wide_pick) if wide_pick else None,
        "wide_der": float(wide_ders.get(wide_pick, float("nan"))) if wide_pick else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="diarization_lowk_eval 的 per_meeting")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    per_meeting = json.loads(Path(args.report).read_text(encoding="utf-8"))["per_meeting"]
    rows = [r for r in (trace_meeting(n, v) for n, v in per_meeting.items()) if r]
    print("n = %d" % len(rows))
    for lo, hi, tag in ((1, 1, "K_true=1"), (2, 3, "K_true=2..3"), (4, 99, "K_true>=4"), (0, 99, "全体")):
        sub = [r for r in rows if lo <= r["k_true"] <= hi]
        if not sub:
            continue
        d = np.array([r["der"] for r in sub])
        rev = [r for r in sub if r["direction_reversed"]]
        pin = [r for r in sub if r["pinned"]]
        print()
        print("=== %s  n=%d ===" % (tag, len(sub)))
        print("  DER mean=%.4f worst=%.4f" % (d.mean(), d.max()))
        print("  **方向反了（rho<0）**: %d/%d   其 DER mean=%.4f worst=%.4f"
              % (len(rev), len(sub),
                 np.mean([r["der"] for r in rev]) if rev else float("nan"),
                 max((r["der"] for r in rev), default=float("nan"))))
        normal = [r for r in sub if not r["direction_reversed"]]
        if normal:
            print("  方向正常           : %d/%d   其 DER mean=%.4f worst=%.4f"
                  % (len(normal), len(sub),
                     np.mean([r["der"] for r in normal]),
                     max(r["der"] for r in normal)))
        print("  钉在上沿（pinned）  : %d/%d = %.0f%%" % (len(pin), len(sub), 100.0 * len(pin) / len(sub)))
    if args.out:
        Path(args.out).write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
        print()
        print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
