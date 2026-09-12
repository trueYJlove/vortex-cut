"""Compare compatible complete-editor numeric evidence; never infer a G0 pass."""

import argparse
import json
import statistics
from pathlib import Path


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int((len(values) - 1) * q))]


def signature(sample):
    result = {
        k: sample[k]
        for k in ("scenario", "environment", "viewport", "fixture_sha256", "playback_seconds")
    }
    result["workload"] = {
        k: v for k, v in sample.get("workload", {}).items() if k != "code_fingerprint"
    }
    result["setup_recovery_count"] = sample.get("setup_recovery_count", 0)
    return result


def compare(baseline, candidate):
    old = [s for s in baseline if s["run"] >= 0 and s["enabled"]]
    new = [s for s in candidate if s["run"] >= 0 and s["enabled"]]
    if not old or not new:
        raise ValueError("No measured diagnostics-on runs; warmup/off are not baseline samples")
    for sample in old + new:
        if any(sample[phase].get("enabled") is not True for phase in ("seek", "playback")):
            raise ValueError("Invalid evidence: diagnostics were disabled after reload")
    if any(signature(s) != signature(old[0]) for s in old + new):
        raise ValueError(
            "Incompatible hardware/runtime/fixture/viewport/scenario/duration: "
            "refusing percentage comparison"
        )
    rows = []
    for phase, kind in [
        ("seek", "seek"),
        ("seek", "submitted"),
        ("playback", "decode"),
        ("playback", "upload"),
        ("playback", "submitted"),
    ]:

        def collect(samples):
            return [
                percentile([e["duration"] for e in s[phase]["events"] if e["kind"] == kind], 0.95)
                for s in samples
            ]

        a, b = collect(old), collect(new)
        if any(v is None for v in a + b):
            rows.append(f"| {phase}/{kind} p95 | unavailable | unavailable | not comparable |")
            continue
        before, after = statistics.median(a), statistics.median(b)
        change = f"{(after / before - 1) * 100:+.1f}%" if before else "zero baseline"
        rows.append(f"| {phase}/{kind} p95 | {before:.3f} | {after:.3f} | {change} |")
    return "\n".join(
        [
            "# Complete-editor comparison",
            "",
            "Status: partial evidence; NOT a G0 approval.",
            "All event distributions cover retained bounded windows, not necessarily the full run. "
            "submitted is NOT presentation.",
            "",
            "| Metric | Before ms | After ms | Change |",
            "|---|---:|---:|---:|",
            *rows,
        ]
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--scenario", default=None,
        help="compare results-<Fxx>.json instead of the legacy single-scene results.json")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("refusing to overwrite existing evidence")
    try:
        if args.scenario:
            baseline_name = f"results-{args.scenario}.json"
            candidate_name = baseline_name
        else:
            baseline_name = candidate_name = "results.json"
        baseline = json.loads((args.baseline / baseline_name).read_text(encoding="utf-8"))
        candidate = json.loads((args.candidate / candidate_name).read_text(encoding="utf-8"))
        report = compare(baseline, candidate)
        if args.scenario:
            report = report.replace(
                "# Complete-editor comparison",
                f"# Complete-editor comparison: {args.scenario}")
    except (ValueError, KeyError, OSError) as exc:
        parser.error(str(exc))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
