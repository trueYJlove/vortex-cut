"""Synthetic CPU/serialization benchmark. No database, media, provider or network access."""
from __future__ import annotations
import gc
import json
import platform
import runpy
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
helpers = runpy.run_path(str(ROOT / "services/core/tests/unit/test_render_ir.py"))
project = helpers["project_preview_ir"]
US = 1_000_000
results = []
for duration, count, captions_count in [(60, 1, 0), (900, 1, 0), (300, 300, 300), (900, 900, 900)]:
    step = duration * US // count
    segments = [helpers["_segment"](f"clip{i}", 0, step, i * step, (i + 1) * step) for i in range(count)]
    captions = [{"caption_id": f"caption{i}", "start_us": i * duration * US // captions_count,
                 "end_us": (i + 1) * duration * US // captions_count,
                 "text": "synthetic caption", "preset_id": "default-bottom"} for i in range(captions_count)]
    plan = helpers["_plan"](segments, captions=captions)
    plan["inputs"][0]["duration_us"] = duration * US
    timings = []
    serialization = []
    for _ in range(3):
        gc.collect()
        start = time.perf_counter()
        ir = project(plan, helpers["_probe"](plan))
        timings.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        encoded = json.dumps(ir, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        serialization.append((time.perf_counter() - start) * 1000)
    results.append({"duration_s": duration, "segments": count, "captions": captions_count,
                    "frames": len(ir["frames"]), "project_ms_samples": timings,
                    "project_ms_median": statistics.median(timings),
                    "json_ms_median": statistics.median(serialization), "json_bytes": len(encoded)})
result = {"scope": "Pure project_preview_ir + compact JSON only; excludes compilation, probing, IPC, JS parsing and GPU.",
          "python": platform.python_version(), "repeats": 3, "cases": results}
output = Path(__file__).with_name("ir-benchmark.json")
output.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
