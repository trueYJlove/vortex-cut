"""Summarize B00-B complete-editor results (schema_version 2) into a G0 table.

Reads results-<Fxx>.json from one run directory, validates the measured shape
(every scenario: warmup + N measured off/on pairs; on-runs have seek events
except F05, which records the registered 4K60 seek defect as-is), and prints
one table per scenario with per-run and median-of-runs p95 latency for
seek/decode/upload/submitted, plus playback throughput and process memory.

This is a reporting aid only: it never declares a G0 pass or a performance
gate decision (that is the plan section 4 acceptance + independent review).
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

KINDS = ("seek", "decode", "upload", "submitted")
PHASES = ("seek", "playback")


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int((len(values) - 1) * q))]


def fmt(value, digits=1):
    return "-" if value is None else f"{value:.{digits}f}"


def summarize_sample(sample):
    """Per-run metric row: p95 ms per phase/kind + counts + memory peak."""
    row = {"run": sample["run"], "enabled": sample["enabled"]}
    for phase in PHASES:
        events = sample[phase]["events"]
        counts = sample[phase]["counts"]
        for kind in KINDS:
            row[f"{phase}.{kind}.p95"] = percentile(
                [e["duration"] for e in events if e["kind"] == kind], 0.95)
            row[f"{phase}.{kind}.count"] = counts.get(kind, 0)
    # compose is not a latency kind of interest for the G0 table but counts feed
    # decode/s below; keep the row flat instead of nested dicts for easy diffing.
    row["ready_ms"] = sample.get("ready_ms")
    row["setup_recovery"] = sample.get("setup_recovery_count", 0)
    peaks = {}
    for group in sample.get("process_samples", []):
        for proc in group:
            peaks[proc["type"]] = max(peaks.get(proc["type"], 0),
                                      proc["memory"]["workingSetSize"])
    row["mem_peak_mb"] = {k: round(v / 1024) for k, v in peaks.items()}
    extra = sample.get("scene_extra") or {}
    if "export_status" in extra:
        row["export_status"] = extra["export_status"]
    return row


def median_row(rows_on):
    """Median p95 across measured on-runs (off-runs assert events empty)."""
    rows = [summarize_sample(s) for s in rows_on]
    out = {}
    for phase in PHASES:
        for kind in KINDS:
            values = [r[f"{phase}.{kind}.p95"] for r in rows
                      if r[f"{phase}.{kind}.p95"] is not None]
            out[f"{phase}.{kind}.p95"] = statistics.median(values) if values else None
    out["ready_ms"] = statistics.median([r["ready_ms"] for r in rows])
    return out


def render_scenario(name, samples, status):
    runs_off = sorted((s for s in samples if s["enabled"] is False), key=lambda s: s["run"])
    runs_on = sorted((s for s in samples if s["enabled"] is True and s["run"] >= 0),
                     key=lambda s: s["run"])
    warmup = [s for s in samples if s["run"] < 0]
    if len(runs_on) != len(runs_off) or not runs_on:
        return (f"## {name}\n\nINCOMPLETE: on={len(runs_on)} off={len(runs_off)}"
                f" (warmup={len(warmup)})\n")
    lines = [
        f"## {name}",
        "",
        f"status={status} measured-runs={len(runs_on)} (off/on pairs, run 0..{runs_on[-1]['run']})",
        "All event-derived p95 values cover the last 4096 retained events per phase/kind"
        " (ring window); playback-phase windows may be truncated when decode/upload"
        " outpace compose (overwritten>0 in evidence). submitted is NOT presentation.",
        "",
        "| run | ready_ms | seek p95 | decode p95 (seek) | upload p95 | submitted p95 (seek)"
        " | submitted p95 (playback) | decode/s (playback) | mem peak MB (Tab/GPU) | notes |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for sample in runs_on:
        row = summarize_sample(sample)
        seek_count = row["seek.seek.count"]
        decode_per_s = (row["playback.decode.count"]
                        / (samples[0]["playback_seconds"] if samples else 1))
        notes = []
        if row.get("setup_recovery"):
            notes.append(f"recovery={row['setup_recovery']}")
        if row.get("export_status"):
            notes.append(f"export={row['export_status']}")
        if name.startswith("F05") and seek_count == 0:
            notes.append("DEFECT-4K60-SEEK recorded")
        lines.append(
            f"| {row['run']} | {fmt(row['ready_ms'], 0)} "
            f"| {fmt(row['seek.seek.p95'])} | {fmt(row['seek.decode.p95'])} "
            f"| {fmt(row['seek.upload.p95'])} | {fmt(row['seek.submitted.p95'])} "
            f"| {fmt(row['playback.submitted.p95'])} "
            f"| {decode_per_s:.1f} "
            f"| {row['mem_peak_mb'].get('Tab', '-')}/{row['mem_peak_mb'].get('GPU', '-')} "
            f"| {', '.join(notes) or '-'} |")
    med = median_row(runs_on)
    lines.append(
        f"| **median** | {fmt(med['ready_ms'], 0)} "
        f"| {fmt(med['seek.seek.p95'])} | {fmt(med['seek.decode.p95'])} "
        f"| {fmt(med['seek.upload.p95'])} | {fmt(med['seek.submitted.p95'])} "
        f"| {fmt(med['playback.submitted.p95'])} | - | - | - |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", required=True, type=Path,
                        help="run output directory containing results-<Fxx>.json")
    args = parser.parse_args()
    config = json.loads((args.results / "run-config.json").read_text(encoding="utf-8"))
    status = config.get("baseline_status", "unknown")
    sections = []
    failures = []
    for path in sorted(args.results.glob("results-*.json")):
        samples = json.loads(path.read_text(encoding="utf-8"))
        scenario = path.stem.removeprefix("results-")
        for sample in samples:
            if sample["enabled"] is False and sample["run"] >= 0:
                for phase in PHASES:
                    if sample[phase]["events"]:
                        failures.append(
                            f"{scenario} run {sample['run']} off: {phase} events not empty")
        sections.append(render_scenario(scenario, samples, status))
    header = [
        f"# G0 results summary: {args.results.name}",
        "",
        f"baseline_status: {status}  (reporting aid only - NOT a G0 pass/fail decision)",
        "",
    ]
    if failures:
        header.append("**VALIDATION FAILURES:**")
        header.extend(f"- {f}" for f in failures)
        header.append("")
    sys.stdout.write("\n".join(header) + "\n".join(sections))


if __name__ == "__main__":
    main()
