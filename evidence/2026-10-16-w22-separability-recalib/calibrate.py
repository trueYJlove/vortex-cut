"""校准判据 C1/C2（在 P133 已读参数集上）——诚实声明：非盲测，底层数字已存在。

C1: Spearman ρ(ARI_giant, DER_split) 的 |ρ| >= 0.60
C2: ARI>=0.50 组 DER 均值严格优于 ARI<0.50 组（任一组 <3 场则 inconclusive）
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "evidence/2026-10-16-w22-giant-separability-prereg/result.json"


def rank(x: np.ndarray) -> np.ndarray:
    return np.argsort(np.argsort(x))


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.corrcoef(rank(a), rank(b))[0, 1])


def main() -> int:
    rows = json.loads(SRC.read_text(encoding="utf-8"))
    ari = np.array([r["ari_median"] for r in rows], dtype=float)
    der_split = np.array([r["der_split"] for r in rows], dtype=float)
    der_now = np.array([r["der_current"] for r in rows], dtype=float)

    rho_split = spearman(ari, der_split)
    rho_now = spearman(ari, der_now)

    hi, lo = der_split[ari >= 0.5], der_split[ari < 0.5]
    c2_ok = len(hi) >= 3 and len(lo) >= 3
    c2 = (float(hi.mean()) < float(lo.mean())) if c2_ok else None

    out = {
        "n": len(rows),
        "ari": [round(v, 4) for v in ari.tolist()],
        "der_split": [round(v, 4) for v in der_split.tolist()],
        "der_now": [round(v, 4) for v in der_now.tolist()],
        "C1_spearman_ari_vs_der_split": round(rho_split, 4),
        "C1_spearman_ari_vs_der_now": round(rho_now, 4),
        "C1_threshold": 0.60,
        "C1_pass": bool(abs(rho_split) >= 0.60),
        "C2_group_hi_n": int(len(hi)),
        "C2_group_hi_mean": round(float(hi.mean()), 4) if len(hi) else None,
        "C2_group_lo_n": int(len(lo)),
        "C2_group_lo_mean": round(float(lo.mean()), 4) if len(lo) else None,
        "C2_pass": c2,
        "C2_note": "inconclusive（任一组 <3 场）" if not c2_ok else "",
    }
    (Path(__file__).resolve().parent / "calibration.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"n={out['n']}")
    print(f"C1 Spearman rho(ARI, DER_split) = {rho_split:+.4f}  "
          f"(|rho|>=0.60) -> {'PASS' if out['C1_pass'] else 'FAIL'}")
    print(f"   [参考] rho(ARI, DER_now) = {rho_now:+.4f}")
    print(f"C2 hi n={out['C2_group_hi_n']} mean={out['C2_group_hi_mean']}  "
          f"lo n={out['C2_group_lo_n']} mean={out['C2_group_lo_mean']}  "
          f"-> {'PASS' if c2 else out['C2_note'] or 'FAIL'}")
    print("\n落盘 -> calibration.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
