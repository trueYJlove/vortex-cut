"""Synthetic CPU/serialization benchmark for preview IR projection.

Migrated from evidence/performance-2026-09-08/benchmark_ir.py so reruns never
overwrite historical evidence; output path is always explicit.

Scope: pure project_preview_ir + compact JSON only; excludes compilation,
probing, IPC, JS parsing and GPU. No database, media, provider or network.
"""
from __future__ import annotations

import argparse
import gc
import json
import platform
import runpy
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
US = 1_000_000

CASES = {
    "60s-1seg": (60, 1, 0),
    "900s-1seg": (900, 1, 0),
    "300s-300": (300, 300, 300),
    "900s-900": (900, 900, 900),
}


def _toolchain_fingerprint() -> str:
    try:
        import aivs_core  # noqa: F401

        version = getattr(aivs_core, "__version__", "unknown")
    except Exception:
        version = "unknown"
    return f"python={platform.python_version()};aivs_core={version}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="result JSON path (must not exist already)")
    parser.add_argument("--cases", default=",".join(CASES),
                        help="comma-separated case keys (default: all)")
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()

    selected = [k.strip() for k in args.cases.split(",") if k.strip()]
    unknown = [k for k in selected if k not in CASES]
    if unknown:
        parser.error(f"unknown cases: {unknown}; available: {sorted(CASES)}")
    if args.repeats < 1:
        parser.error("--repeats must be >= 1")
    output = args.output
    if output.exists():
        parser.error(f"refusing to overwrite existing output: {output}")

    helpers = runpy.run_path(str(ROOT / "services/core/tests/unit/test_render_ir.py"))
    project = helpers["project_preview_ir"]
    results = []
    for key in selected:
        duration, count, captions_count = CASES[key]
        step = duration * US // count
        segments = [helpers["_segment"](f"clip{i}", 0, step, i * step, (i + 1) * step)
                    for i in range(count)]
        captions = []
        if captions_count:
            captions = [{"caption_id": f"caption{i}",
                         "start_us": i * duration * US // captions_count,
                         "end_us": (i + 1) * duration * US // captions_count,
                         "text": "synthetic caption", "preset_id": "default-bottom"}
                        for i in range(captions_count)]
        plan = helpers["_plan"](segments, captions=captions)
        plan["inputs"][0]["duration_us"] = duration * US
        timings = []
        serialization = []
        for _ in range(args.repeats):
            gc.collect()
            start = time.perf_counter()
            ir = project(plan, helpers["_probe"](plan))
            timings.append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            encoded = json.dumps(ir, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            serialization.append((time.perf_counter() - start) * 1000)
        results.append({
            "case": key,
            "duration_s": duration, "segments": count, "captions": captions_count,
            "frames": len(ir["frames"]),
            "project_ms_samples": timings,
            "project_ms_median": statistics.median(timings),
            "json_ms_median": statistics.median(serialization),
            "json_bytes": len(encoded),
        })

    result = {
        "scope": ("Pure project_preview_ir + compact JSON only; excludes compilation, "
                  "probing, IPC, JS parsing and GPU."),
        "toolchain": _toolchain_fingerprint(),
        "repeats": args.repeats,
        "cases": results,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
