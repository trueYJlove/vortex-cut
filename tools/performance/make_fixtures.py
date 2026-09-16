"""Generate selected, deterministic benchmark media. No network or user database access."""

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Single-file scenarios: one av source per scenario. Scene assembly (which clips,
# tracks, captions a runner builds from it) is declared by the benchmark spec.
SINGLES = {
    "F01": (12, "640x360", 30),
    "F02": (900, "640x360", 30),
    # B11-D1 spike：320x180 代理档解码输入（同 F02 时长/装配；帧字节 4x 减小）。
    "F02P": (900, "320x180", 30),
    "F03": (3600, "640x360", 30),
    "F05": (12, "3840x2160", 60),
}
SINGLE_RECIPE = "testsrc2-av-cfr-v1"


def _multi_files(scenario: str, seed: int) -> list[dict]:
    if scenario == "F04":
        # 100 distinct short assets: duration and tone vary per index so every
        # file has a unique fingerprint (project import rejects duplicates).
        # 2026-09-15 GAP-LIST-ASSETS-PAGING 修复后升到 100（旧 48 上限是
        # editor 只装载 list_assets 第一页的产品分页缺口；现在翻页装载，
        # 复测口径恢复计划原设的 100 素材）。
        return [
            {"file": f"F04-{index:03d}.mp4", "duration": 12 + index * 0.05, "audio_freq": 440 + index}
            for index in range(100)
        ]
    if scenario == "F07":
        # Speed matrix needs an audible av source plus a video-only source
        # (the "no audio track" fixture; clip audio defaults to disabled).
        return [
            {"file": "F07.mp4", "duration": 12, "audio_freq": 440 + seed % 7},
            {"file": "F07-mute.mp4", "duration": 12, "audio_freq": None},
        ]
    raise ValueError(scenario)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scenarios", default="F01")
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--allow-large", action="store_true")
    args = parser.parse_args()
    scenarios = args.scenarios.split(",")
    supported = sorted(set(SINGLES) | {"F04", "F07"})
    if any(s not in supported for s in scenarios):
        parser.error(
            "supported media recipes: " + ",".join(supported)
            + "; F06 requires an explicit local workload"
        )
    if not args.allow_large and any(s in {"F02", "F02P", "F03", "F05"} for s in scenarios):
        parser.error("long/4K generation requires --allow-large and free disk space")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error("output must be empty: existing evidence is never overwritten")
    ffmpeg = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
    if not ffmpeg.is_file():
        parser.error("bundled FFmpeg missing")
    output.mkdir(parents=True, exist_ok=True)
    estimates = {s: SINGLES[s][0] * 250_000 for s in scenarios if s in SINGLES}
    for scenario in ("F04", "F07"):
        if scenario in scenarios:
            estimates[scenario] = sum(int(f["duration"] * 250_000) for f in _multi_files(scenario, args.seed))
    required = 2 * 1024**3 + sum(estimates.values())
    if shutil.disk_usage(output).free < required:
        parser.error("insufficient free disk space (2GiB reserve + estimated media)")
    version = subprocess.run(
        [str(ffmpeg), "-version"], capture_output=True, check=True, text=True
    ).stdout.splitlines()[0]
    manifest = {"schema_version": 2, "seed": args.seed, "toolchain": version, "fixtures": {}}
    for scenario in scenarios:
        if scenario in SINGLES:
            duration, size, fps = SINGLES[scenario]
            recipe_files = [{"file": f"{scenario}.mp4", "duration": duration, "audio_freq": 440 + args.seed % 7}]
        else:
            recipe_files = _multi_files(scenario, args.seed)
        entries = []
        # 多文件场景（F04/F07）固定 640x360@30（与既有 manifest 的族级
        # size/fps 字段一致）；单文件场景取 SINGLES。
        if scenario in SINGLES:
            size, fps = SINGLES[scenario][1], SINGLES[scenario][2]
        else:
            size, fps = "640x360", 30
        for spec in recipe_files:
            target = output / spec["file"]
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
                f"sine=frequency={spec['audio_freq']}:sample_rate=48000" if spec["audio_freq"] else "anullsrc=r=48000:cl=stereo",
                "-t",
                str(spec["duration"]),
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
            ]
            if not spec["audio_freq"]:
                # Video-only fixture: no audio stream must survive encoding.
                command += ["-an"]
            command += [str(target)]
            with (output / f"{spec['file']}.generation.log").open("w") as log:
                subprocess.run(
                    command, stdout=log, stderr=log, check=True, timeout=max(300, int(spec["duration"] * 5))
                )
            with target.open("rb") as media:
                digest = hashlib.file_digest(media, "sha256").hexdigest()
            entries.append({
                "file": spec["file"],
                "sha256": digest,
                "duration_s": spec["duration"],
                "bytes": target.stat().st_size,
                **({"audio": "none"} if not spec["audio_freq"] else {}),
            })
        if scenario in SINGLES:
            single = entries[0]
            manifest["fixtures"][scenario] = {
                "file": single["file"],
                "sha256": single["sha256"],
                "duration_s": SINGLES[scenario][0],
                "size": SINGLES[scenario][1],
                "fps": SINGLES[scenario][2],
                "recipe": SINGLE_RECIPE,
                "bytes": single["bytes"],
                "coverage_note": (
                    "Media only; not historical PiP, VFR/B-frame, multilayer or audio-failure coverage."
                ),
            }
        else:
            manifest["fixtures"][scenario] = {
                "files": entries,
                "size": "640x360",
                "fps": 30,
                "recipe": "testsrc2-av-cfr-multiv1",
                "bytes": sum(entry["bytes"] for entry in entries),
                "coverage_note": (
                    "Distinct short media family; scene assembly (tracks/transforms/captions)"
                    " is declared by the benchmark spec, not by media generation."
                ),
            }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
