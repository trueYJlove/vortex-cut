"""Probe overhead A/B analysis from B00 G0 evidence (off vs on, same workload).

Reads results-<Fxx>.json (schema_version 2) from a run directory and compares
diagnostics-off vs diagnostics-on measured runs on workload-neutral indicators:

- seek action wall time (median per run, includes the fixed 300ms load interval)
- per-process CPU percent and working set medians during the playback loop
  (Tab/GPU/Utility; sampling cadence identical in both modes)

The probe records events/counters only when enabled; off runs assert empty
events, so any systematic off/on difference on these indicators is probe cost.
Writes a markdown table; reporting aid only, never a gate decision.
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

PROCESSES = ("Tab", "GPU", "Utility")


def run_series(sample, ptype):
    cpus, mems = [], []
    for group in sample.get("process_samples", []):
        for proc in group:
            if proc["type"] == ptype:
                cpus.append(proc["cpu"].get("percentCPUUsage")
                            or proc["cpu"].get("cumulativeCPUUsage"))
                mems.append(proc["memory"]["workingSetSize"])
    return (statistics.median(cpus) if cpus else None,
            statistics.median(mems) / 1024 if mems else None)


def collect(samples, ptype):
    cpus, mems = [], []
    for sample in samples:
        cpu, mem = run_series(sample, ptype)
        if cpu is not None:
            cpus.append(cpu)
        if mem is not None:
            mems.append(mem)
    return (statistics.median(cpus) if cpus else None,
            statistics.median(mems) if mems else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", required=True, type=Path)
    args = parser.parse_args()
    lines = [
        "# Probe overhead A/B (diagnostics off vs on, measured runs only)",
        "",
        "Same workload both modes; the probe only records when enabled. "
        "CPU is per-process percent median over playback-loop samples; "
        "WS = working set median. seek wall includes the fixed 300ms interval.",
        "",
        "| scenario | seek wall off→on (ms) | Tab cpu off→on | Tab WS off→on (MB) |"
        " GPU cpu off→on | GPU WS off→on (MB) | Util cpu off→on |",
        "|---|---|---|---|---|---|---|",
    ]
    for path in sorted(args.results.glob("results-*.json")):
        scene = path.stem.removeprefix("results-")
        samples = json.loads(path.read_text(encoding="utf-8"))
        runs = {}
        for mode in ("off", "on"):
            runs[mode] = [s for s in samples
                          if s["enabled"] is (mode == "on") and s["run"] >= 0]
        if not runs["off"] or not runs["on"]:
            continue
        wall = {}
        cpu = {p: {} for p in PROCESSES}
        for mode in ("off", "on"):
            wall[mode] = statistics.median(
                statistics.median(s["seek_action_wall_ms_including_300ms_wait"])
                for s in runs[mode])
            for ptype in PROCESSES:
                cpu[ptype][mode] = collect(runs[mode], ptype)
        wall_delta = wall["on"] / wall["off"] - 1 if wall["off"] else 0
        cells = [f"{scene}",
                 f"{wall['off']:.0f}→{wall['on']:.0f} ({wall_delta:+.1%})"]
        for ptype in PROCESSES:
            off_c, off_m = cpu[ptype]["off"]
            on_c, on_m = cpu[ptype]["on"]
            cells.append(f"{off_c:.2f}→{on_c:.2f}")
            if ptype != "Utility":
                cells.append(f"{off_m:.0f}→{on_m:.0f}")
        lines.append("| " + " | ".join(cells) + " |")
    lines += ["", "Median overhead across scenes: see G0 report section on probe gates."]
    sys.stdout.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
