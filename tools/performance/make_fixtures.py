"""Generate selected, deterministic benchmark media. No network or user database access."""

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPECS = {
    "F01": (12, "640x360", 30),
    "F02": (900, "640x360", 30),
    "F03": (3600, "640x360", 30),
    "F04": (12, "640x360", 30),
    "F05": (12, "3840x2160", 60),
    "F07": (12, "640x360", 30),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scenarios", default="F01")
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--allow-large", action="store_true")
    args = parser.parse_args()
    scenarios = args.scenarios.split(",")
    if any(s not in SPECS for s in scenarios):
        parser.error(
            "supported media recipes: "
            + ",".join(SPECS)
            + "; F06 requires an explicit local workload"
        )
    if not args.allow_large and any(s in {"F02", "F03", "F05"} for s in scenarios):
        parser.error("long/4K generation requires --allow-large and free disk space")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("output must be empty: existing evidence is never overwritten")
    ffmpeg = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
    if not ffmpeg.is_file():
        parser.error("bundled FFmpeg missing")
    output.mkdir(parents=True, exist_ok=True)
    required = 2 * 1024**3 + sum(SPECS[s][0] * 2_000_000 // 8 for s in scenarios)
    if shutil.disk_usage(output).free < required:
        parser.error("insufficient free disk space (2GiB reserve + estimated media)")
    version = subprocess.run(
        [str(ffmpeg), "-version"], capture_output=True, check=True, text=True
    ).stdout.splitlines()[0]
    manifest = {"schema_version": 1, "seed": args.seed, "toolchain": version, "fixtures": {}}
    for scenario in scenarios:
        duration, size, fps = SPECS[scenario]
        target = output / f"{scenario}.mp4"
        # Simple deterministic source; scene assembly is separately declared by runner.
        command = [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size}:rate={fps}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={440 + args.seed % 7}:sample_rate=48000",
            "-t",
            str(duration),
            "-c:v",
            "libopenh264",
            "-b:v",
            "2M",
            "-g",
            str(fps * 2),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(target),
        ]
        with (output / f"{scenario}.generation.log").open("w") as log:
            subprocess.run(
                command, stdout=log, stderr=log, check=True, timeout=max(300, duration * 5)
            )
        with target.open("rb") as media:
            digest = hashlib.file_digest(media, "sha256").hexdigest()
        manifest["fixtures"][scenario] = {
            "file": target.name,
            "sha256": digest,
            "duration_s": duration,
            "size": size,
            "fps": fps,
            "recipe": "testsrc2-av-cfr-v1",
            "bytes": target.stat().st_size,
            "coverage_note": (
                "Media only; not historical PiP, VFR/B-frame, multilayer or audio-failure coverage."
            ),
        }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
