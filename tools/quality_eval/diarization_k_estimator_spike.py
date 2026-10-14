"""W2.2 K 估计器评测：按 PRE_REGISTRATION.md §3 的判据出结论。

只读 diag + 缓存，不重算 DER。**不判**"估计器好是否等于 DER 好"（那是 S3）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_HERE = Path(__file__).resolve().parent
for _p in (ROOT / "services" / "core" / "src", _HERE):
    sys.path.insert(0, str(_p))

from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_k_estimators import estimate_all  # noqa: E402


def pearson(a: np.ndarray, b: np.ndarray) -> float | None:
    if a.size < 2 or b.size < 2:
        return None
    if np.std(a) == 0 or np.std(b) == 0:
        return None  # 常数估计器：相关系数无定义（**不报 0**，避免误导）
    return float(np.corrcoef(a, b)[0, 1])


def evaluate(diag_path: str, cache_dir: str, condition: str) -> dict:
    diag = json.loads(Path(diag_path).read_text(encoding="utf-8"))
    cache = EmbeddingCache(cache_dir)
    rows = []
    for name, e in sorted(diag.get("meetings", {}).items()):
        cond = e.get("conditions", {}).get(condition)
        if not cond or "cache_key" not in cond:
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None:
            continue
        est = estimate_all(np.asarray(hit[0], dtype=np.float64))
        est = {k: v for k, v in est.items() if not k.endswith("_error")}
        est["name"] = name
        est["k_true"] = int(e["ref_speakers"])
        rows.append(est)
    return {"rows": rows}


def summarise(rep: dict, label: str) -> dict:
    rows = rep["rows"]
    names = [k for k in rows[0] if k not in ("name", "k_true")] if rows else []
    kt = np.array([r["k_true"] for r in rows], dtype=float)
    out: dict = {"label": label, "n": len(rows), "estimators": {}}
    print("=== %s  n=%d ===" % (label, len(rows)))
    print("  %-22s %6s %6s %6s %7s %7s %8s" % ("estimator", "hit%", "over%", "under%", "|err|", "err", "r"))
    for nm in names:
        kk = np.array([r[nm] for r in rows], dtype=float)
        err = kk - kt
        hit = float((err == 0).mean())
        over = float((err > 0).mean())
        under = float((err < 0).mean())
        r = pearson(kk, kt)
        out["estimators"][nm] = {
            "hit": hit, "over": over, "under": under,
            "abs_err": float(np.abs(err).mean()), "err_mean": float(err.mean()),
            "pearson": r,
        }
        print("  %-22s %5.0f%% %5.0f%% %5.0f%% %7.2f %+7.2f %8s"
              % (nm, 100 * hit, 100 * over, 100 * under,
                 float(np.abs(err).mean()), float(err.mean()),
                 "n/a" if r is None else "%.3f" % r))
    # 反平凡性：恒取中位数
    if rows:
        med = int(np.median(kt))
        const = np.full_like(kt, med)
        cerr = const - kt
        print("  %-22s %5.0f%% %5.0f%% %5.0f%% %7.2f %+7.2f %8s"
              % ("恒取常数 K=%d" % med, 100 * float((cerr == 0).mean()),
                 100 * float((cerr > 0).mean()), 100 * float((cerr < 0).mean()),
                 float(np.abs(cerr).mean()), float(cerr.mean()), "无定义"))
        out["constant_baseline"] = {"k": med, "hit": float((cerr == 0).mean())}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True, help="JSON: [{key, diag, label}]")
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    specs = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    report: dict = {"corpora": {}}
    for spc in specs:
        rep = evaluate(spc["diag"], args.cache_dir, args.condition)
        report["corpora"][spc["key"]] = {
            "summary": summarise(rep, spc.get("label", spc["key"])),
            "rows": rep["rows"],
        }
        print()
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
