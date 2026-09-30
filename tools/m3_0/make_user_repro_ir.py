"""Build a probe IR + assets manifest for a single-asset full-length 1x fit preview.

Replicates the production projector's single-segment semantics
(`aivs_core.rendering.ir`: layout=fit, no captions/transitions/overlays) so the probe
consumes a *real* frame table for the user's own media.

Usage:
  python tools/m3_0/make_user_repro_ir.py --asset <media path> --entity <entity_id> \
      --width 960 --height 540 --fps 30 --duration-us 41378005 --geom 3440x1440 \
      --out-ir <ir.json> --out-manifest <manifest.json>
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FFPROBE = REPO / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe"


def probe_media(path: Path) -> dict:
    out = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,codec_name,has_b_frames",
         "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    num, den = (stream.get("avg_frame_rate") or "30/1").split("/")
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": float(num) / float(den),
        "duration_us": int(round(float(data["format"]["duration"]) * 1_000_000)),
        "codec": stream.get("codec_name"),
        "has_b_frames": int(stream.get("has_b_frames") or 0),
    }


def fit_content_box(geom_w: int, geom_h: int, width: int, height: int) -> tuple[int, int, int, int]:
    """Mirror of aivs_core.rendering.ir._fit_content_box."""
    scale = min(width / geom_w, height / geom_h)
    content_w = int(round(geom_w * scale / 2) * 2)
    content_h = int(round(geom_h * scale / 2) * 2)
    return (width - content_w) // 2, (height - content_h) // 2, content_w, content_h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", required=True)
    parser.add_argument("--entity", required=True)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=540)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--duration-us", type=int, default=None)
    parser.add_argument("--out-ir", required=True)
    parser.add_argument("--out-manifest", required=True)
    parser.add_argument("--has-audio", action="store_true")
    parser.add_argument("--note", default="")
    args = parser.parse_args()

    asset = Path(args.asset)
    info = probe_media(asset)
    duration_us = args.duration_us or info["duration_us"]
    fps = args.fps
    duration_frames = int(round(duration_us / 1_000_000 * fps))
    geom_w, geom_h = info["width"], info["height"]
    cx, cy, cw, ch = fit_content_box(geom_w, geom_h, args.width, args.height)

    frames = []
    for n in range(duration_frames):
        t_us = int(round(n * 1_000_000 / fps))
        src_n = int(round(t_us / 1_000_000 * info["fps"]))
        src_t_us = int(round(src_n * 1_000_000 / info["fps"]))
        frames.append({
            "n": n,
            "t_us": t_us,
            "main": {
                "kind": "segment",
                "clip_id": "clip_repro",
                "input_id": "I0",
                "src_n": src_n,
                "src_t_us": src_t_us,
                "content": {"x": cx, "y": cy, "w": cw, "h": ch},
                "shift": {"dx": 0.0, "dy": 0.0},
                "alpha": 1.0,
                "rotation_deg": 0.0,
                "layout": "fit",
            },
            "overlays": [],
            "captions": [],
        })

    ir = {
        "schema": "preview-ir-v1",
        "projector_version": 1,
        "canvas": {
            "width": args.width,
            "height": args.height,
            "fps": int(fps),
            "duration_frames": duration_frames,
            "duration_us": int(duration_us),
            "background": "#000000",
        },
        "inputs": [{
            "input_id": "I0",
            "asset_id": args.entity,
            "asset_kind": "video",
            "duration_us": int(duration_us),
            "has_audio": bool(args.has_audio),
            "geometry": {"width": geom_w, "height": geom_h, "sar": 1},
        }],
        "segments": [{
            "clip_id": "clip_repro",
            "track_id": "V1",
            "input_id": "I0",
            "source_start_us": 0,
            "source_end_us": int(duration_us),
            "timeline_start_us": 0,
            "timeline_end_us": int(duration_us),
            "output_start_us": 0,
            "output_end_us": int(duration_us),
            "layout": "fit",
            "speed_milli": 1000,
        }],
        "captions": [],
        "caption_styles": {},
        "transition_windows": [],
        "known_approximations": [
            args.note or f"用户原素材复现 IR（单段 1x 顺播 fit；源 {geom_w}x{geom_h} {info['codec']} "
                         f"has_b_frames={info['has_b_frames']} {duration_us / 1e6:.3f}s）"
        ],
        "frames": frames,
    }

    ir_path = Path(args.out_ir)
    ir_path.parent.mkdir(parents=True, exist_ok=True)
    ir_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
    manifest_path = Path(args.out_manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps({
        "assets": [{"entity_id": args.entity, "path": str(asset).replace("\\", "/"),
                    "display_name": asset.stem}]
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[ok] ir={ir_path} frames={duration_frames} canvas={args.width}x{args.height} "
          f"content={cw}x{ch}@{cx},{cy} src={geom_w}x{geom_h}@{info['fps']} codec={info['codec']} "
          f"b_frames={info['has_b_frames']}")
    print(f"[ok] manifest={manifest_path}")


if __name__ == "__main__":
    sys.exit(main())
