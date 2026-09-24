"""对比两份质量基线快照；指标回退超过容差则非零退出（规划门 §3.5）。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _iter_numeric_metrics(report: dict[str, Any]) -> dict[str, float]:
    """展平可比较的标量：ok/insufficient 的数值主指标。"""
    out: dict[str, float] = {}
    buckets = report.get("buckets") or {}
    for bucket, block in buckets.items():
        metrics = (block or {}).get("metrics") or {}
        for name, metric in metrics.items():
            if not isinstance(metric, dict):
                continue
            status = metric.get("status")
            if status not in ("ok", "insufficient"):
                continue
            value = metric.get("value")
            if isinstance(value, (int, float)):
                out[f"{bucket}.{name}"] = float(value)
            elif isinstance(value, dict):
                for key in ("f1", "ndcg", "precision", "recall"):
                    if isinstance(value.get(key), (int, float)):
                        out[f"{bucket}.{name}.{key}"] = float(value[key])
    return out


def compare(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    tolerance: float | None = None,
) -> dict[str, Any]:
    tol = (
        tolerance
        if tolerance is not None
        else float(
            (baseline.get("params") or {}).get("regression_tolerance")
            or (candidate.get("params") or {}).get("regression_tolerance")
            or 0.0
        )
    )
    old = _iter_numeric_metrics(baseline)
    new = _iter_numeric_metrics(candidate)
    regressions: list[dict[str, Any]] = []
    improvements: list[dict[str, Any]] = []
    missing: list[str] = []
    for key, old_v in sorted(old.items()):
        if key not in new:
            missing.append(key)
            continue
        delta = new[key] - old_v
        if delta < -tol:
            regressions.append({"metric": key, "baseline": old_v, "candidate": new[key], "delta": delta})
        elif delta > tol:
            improvements.append({"metric": key, "baseline": old_v, "candidate": new[key], "delta": delta})
    return {
        "tolerance": tol,
        "regressions": regressions,
        "improvements": improvements,
        "missing_in_candidate": missing,
        "ok": not regressions and not missing,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="对比质量基线快照")
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--tolerance", type=float, default=None)
    args = parser.parse_args(argv)
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))
    result = compare(baseline, candidate, args.tolerance)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
