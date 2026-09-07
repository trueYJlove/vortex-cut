"""构造 2x 变速复现 IR：取 m3p5 证据 IR 的画布/输入与首段素材（I0 主轨 5.9s），
投影为单段 2x 时间线（输出 ~2.95s = 89 帧，src_n 每输出帧前进 2）。

用法：python make_ir_2x.py <源 ir.json> <输出 ir.json>
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

FPS = 30


def main() -> None:
    src_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    src = json.loads(src_path.read_text(encoding="utf-8"))

    first = next(s for s in src["segments"] if s["input_id"] == "I0")
    source_start = int(first["source_start_us"])
    source_end = int(first["source_end_us"])
    speed = 2000
    timeline_start = 0
    timeline_end = timeline_start + (source_end - source_start) * 1000 // speed
    total_frames = math.ceil(timeline_end * FPS / 1_000_000)

    # fit 内容盒：1920x1080 → 540x960 画布（等比 contain 居中）
    width, height = src["canvas"]["width"], src["canvas"]["height"]
    disp_w = 1920.0
    scale = min(width / disp_w, height / 1080.0)
    content_w = int(round(disp_w * scale / 2) * 2)
    content_h = int(round(1080 * scale / 2) * 2)
    content = {"x": (width - content_w) // 2, "y": (height - content_h) // 2,
               "w": content_w, "h": content_h}

    clip_id = first["clip_id"]
    max_src_n = max(int((source_end - 1_000_000 // FPS) * FPS / 1_000_000), 0)
    frames = []
    for n in range(total_frames):
        t_exact_us = n * 1_000_000 / FPS
        position = source_start + (t_exact_us - timeline_start) * speed / 1000.0
        position = min(max(position, source_start), max(source_start, source_end - 1_000_000 // FPS))
        src_n = max(int(position * FPS / 1_000_000 + 1e-6), 0)
        src_n = min(src_n, max_src_n)
        frames.append({
            "n": n, "t_us": n * 1_000_000 // FPS,
            "main": {"kind": "segment", "clip_id": clip_id, "input_id": "I0",
                     "src_n": src_n, "src_t_us": int(src_n * 1_000_000 / FPS),
                     "content": content, "shift": {"dx": 0.0, "dy": 0.0},
                     "alpha": 1.0, "rotation_deg": 0.0, "layout": "fit"},
            "overlays": [], "captions": [],
        })

    ir = {
        "schema": src["schema"],
        "projector_version": src.get("projector_version", 1),
        "generated_from": src.get("generated_from", {"compiler_version": "repro", "content_fingerprint": "repro-2x", "mode": "probe"}),
        "canvas": {**src["canvas"], "duration_frames": total_frames, "duration_us": timeline_end},
        "inputs": [i for i in src["inputs"] if i["input_id"] == "I0"],
        "segments": [{
            "clip_id": clip_id, "track_id": "V1", "input_id": "I0",
            "source_start_us": source_start, "source_end_us": source_end,
            "timeline_start_us": timeline_start, "timeline_end_us": timeline_end,
            "output_start_us": timeline_start, "output_end_us": timeline_end,
            "layout": "fit", "speed_milli": speed,
        }],
        "captions": [], "caption_styles": {}, "transition_windows": [],
        "known_approximations": ["2x repro IR（验收复现夹具，非生产投影产物）"],
        "frames": frames,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
    print(f"[ok] {out_path}: frames={total_frames} timeline={timeline_end}us src_n: 0..{frames[-1]['main']['src_n']}")


if __name__ == "__main__":
    main()
