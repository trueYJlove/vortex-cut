"""CV 采样性能测量（W0.2 evidence 工具，不入 CI）。

用途：对真实素材测量 `cv_video_args` 两条路径（skip_frame 快路径 / 全量兜底路径）
的解码+采样墙钟，产出性能门证据。

**保真性**：直接 import 生产代码 `aivs_core.media.cv_signals.cv_video_args`，
不复制 FFmpeg 参数——测的就是产品实际执行的命令。

用法（仓库根）：
  .venv\\Scripts\\python.exe tools/validation/measure_cv_sampling.py [--asset PATH]...

不带参数时使用内置三段真实素材（与 run_validation.py 同源）。`--asset` 可重复指定，
用于补测新素材（如 4K60）。

输出：控制台表格 + `evidence/cv_sampling/<timestamp>.json`。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services/core/src"))

from aivs_core.media.cv_signals import (  # noqa: E402
    THUMB_HEIGHT,
    THUMB_WIDTH,
    cv_video_args,
)

FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
FRAME_BYTES = THUMB_WIDTH * THUMB_HEIGHT
PERF_GATE_PER_MINUTE_S = 10.0

DEFAULT_ASSETS = [
    ("dance", r"C:\Users\trueY\Desktop\刘可艾 小花猫舞蹈视频.mp4"),
    ("science", r"C:\Users\trueY\Downloads\给三年级学生讲解倒春寒的科普视频.mp4"),
    ("lichun", r"C:\Users\trueY\Downloads\立春视频.mp4"),
]


def probe_duration_s(path: Path) -> float:
    out = subprocess.run(
        [
            str(FFPROBE), "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True,
        check=True,
    )
    return float(json.loads(out.stdout)["format"]["duration"])


def probe_max_gop_s(path: Path) -> float | None:
    """最大关键帧间隔（秒）——判定是否触发长 GOP 回退。

    用 ffprobe 读关键帧时间戳取最大间隔；读不到（无关键帧标记）返回 None。
    """
    out = subprocess.run(
        [
            str(FFPROBE), "-v", "error",
            "-select_streams", "v:0",
            "-skip_frame", "nokey",
            "-show_entries", "frame=pts_time",
            "-of", "json", str(path),
        ],
        capture_output=True,
    )
    if out.returncode != 0:
        return None
    try:
        frames = json.loads(out.stdout).get("frames", [])
        times = sorted(float(f["pts_time"]) for f in frames if "pts_time" in f)
    except (ValueError, KeyError):
        return None
    if len(times) < 2:
        return None
    return max(b - a for a, b in zip(times, times[1:]))


def measure(path: Path, *, skip_frame: bool) -> tuple[float, int]:
    """返回（墙钟秒, 采样帧数）。stdout 边读边丢，只计解码成本。"""
    args = [str(FFMPEG), *cv_video_args(str(path), skip_frame=skip_frame)]
    started = time.perf_counter()
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    assert proc.stdout is not None
    total_bytes = 0
    while True:
        chunk = proc.stdout.read(1 << 20)
        if not chunk:
            break
        total_bytes += len(chunk)
    proc.wait()
    elapsed = time.perf_counter() - started
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 退出码 {proc.returncode}：{path.name}")
    return elapsed, total_bytes // FRAME_BYTES


def measure_asset(label: str, path: Path) -> dict:
    if not path.is_file():
        return {"label": label, "path": str(path), "error": "missing"}

    duration_s = probe_duration_s(path)
    duration_min = duration_s / 60.0
    max_gop_s = probe_max_gop_s(path)

    fast_s, fast_frames = measure(path, skip_frame=True)
    full_s, full_frames = measure(path, skip_frame=False)

    # 生产逻辑：快路径采样点最大间隔 > 4s 即回退全量（两遍遍历）。
    fast_max_gap_s = (fast_frames and duration_s / fast_frames) or 0.0
    falls_back = bool(max_gop_s is not None and max_gop_s > 4.0)
    effective_s = fast_s + full_s if falls_back else fast_s

    return {
        "label": label,
        "path": str(path),
        "size_mb": round(path.stat().st_size / 1024 / 1024, 1),
        "duration_s": round(duration_s, 1),
        "max_gop_s": round(max_gop_s, 2) if max_gop_s is not None else None,
        "fast_path": {
            "wall_clock_s": round(fast_s, 1),
            "frames": fast_frames,
            "per_minute_s": round(fast_s / duration_min, 1) if duration_min else None,
        },
        "full_path": {
            "wall_clock_s": round(full_s, 1),
            "frames": full_frames,
            "per_minute_s": round(full_s / duration_min, 1) if duration_min else None,
        },
        "speedup": round(full_s / fast_s, 1) if fast_s else None,
        "falls_back_to_full": falls_back,
        "effective_per_minute_s": (
            round(effective_s / duration_min, 1) if duration_min else None
        ),
        "meets_gate": (
            effective_s / duration_min <= PERF_GATE_PER_MINUTE_S
            if duration_min
            else None
        ),
        "note": (
            "生产路径为快路径 + 全量回退两遍遍历（长 GOP 触发）；"
            "effective 即两遍之和。"
            if falls_back
            else "生产路径仅快路径一遍遍历。"
        ),
        "avg_sample_interval_s": (
            round(duration_s / fast_frames, 2) if fast_frames else None
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--asset", action="append", default=None,
        help="自定义素材路径（可重复）；缺省用内置三段真实素材",
    )
    parser.add_argument("--label", default=None, help="配合单个 --asset 的标签")
    args = parser.parse_args()

    if args.asset:
        assets = [
            (args.label or f"custom{index}", p)
            for index, p in enumerate(args.asset, start=1)
        ]
    else:
        assets = DEFAULT_ASSETS

    results = []
    for label, raw in assets:
        print(f"测量 {label} …", flush=True)
        row = measure_asset(label, Path(raw))
        results.append(row)
        if "error" in row:
            print(f"  {label}: {row['error']}")
            continue
        print(
            f"  {label}: 时长 {row['duration_s']}s | 最大 GOP {row['max_gop_s']}s | "
            f"快路径 {row['fast_path']['wall_clock_s']}s "
            f"({row['fast_path']['per_minute_s']}s/分, {row['fast_path']['frames']} 帧) | "
            f"全量 {row['full_path']['wall_clock_s']}s "
            f"({row['full_path']['per_minute_s']}s/分, {row['full_path']['frames']} 帧) | "
            f"加速 {row['speedup']}x | 回退 {row['falls_back_to_full']} | "
            f"有效 {row['effective_per_minute_s']}s/分 | "
            f"门 {'PASS' if row['meets_gate'] else 'FAIL'}"
        )

    measured = [r for r in results if "error" not in r]
    summary = {
        "perf_gate_per_minute_s": PERF_GATE_PER_MINUTE_S,
        "assets_measured": len(measured),
        "all_meet_gate": all(r["meets_gate"] for r in measured) if measured else None,
        "max_effective_per_minute_s": (
            max(r["effective_per_minute_s"] for r in measured) if measured else None
        ),
    }

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = REPO / "evidence/cv_sampling"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{stamp}.json"
    out_path.write_text(
        json.dumps(
            {
                "measured_at": datetime.now(timezone.utc).isoformat(),
                "algorithm_version": _algorithm_version(),
                "ffmpeg": str(FFMPEG),
                "summary": summary,
                "assets": results,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print("\n摘要：", json.dumps(summary, ensure_ascii=False))
    print(f"证据：{out_path.relative_to(REPO)}")


def _algorithm_version() -> int:
    from aivs_core.media.cv_signals import CV_ALGORITHM_VERSION

    return CV_ALGORITHM_VERSION


if __name__ == "__main__":
    main()
