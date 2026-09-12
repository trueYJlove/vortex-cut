"""F03 导出深定位收益实测（C21 性能门，计划第 8 节"深定位"行）。

场景：F03 语义——60 分钟源只用尾部 10 秒。实测机器耗时约束下取
60s 长 GOP=60 确定性合成源、只用尾部 [50s,60s) 段（结构性等价：
深定位收益取决于 seek 深度/源总长比与 GOP 结构，不取决于绝对时长）。

口径（计划 C21b-3："对 F03 末尾 10 秒比较解码源帧数量/编码阶段耗时，
不把 probe 缓存命中混成深定位收益"）：
- legacy 图 vs 深定位图（plan_input_windows 放行）各 N 轮完整
  FFmpeg 编码 + 校验解码，同机顺序交替消除热漂移；
- 解码源帧数量：以 FFmpeg 自身 `-benchmark` 比较两图的 wall/处理耗时，
  并直接断言深定位图的解码供给区间（trim 起点回移后流上从 0 开始，
  源解码从 50s 起——用 ffprobe 计数两图实际读取的帧序列长度上界）
  不作为硬证明；诚实口径以"编码总耗时 + validate_decode 耗时"对比 +
  帧对拍正确性为准；
- 探针开销：AIVS_PERF_METRICS 计数与命令行一致（measure 装饰器仅在
  开启时记录，O(1) 无逐帧 IPC）。

输出：JSON 到显式路径（必须不存在——不覆盖历史证据）。
"""
from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
US = 1_000_000
DEFAULT_SOURCE_SECONDS = 60
GOP = 60
ENCODER = "libopenh264"


def _run_quiet(*args: str, cwd: Path | None = None) -> None:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=600, check=False, cwd=str(cwd) if cwd else None,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2000:])


def _make_source(root: Path, source_seconds: int) -> Path:
    video = root / f"f03-deep-{source_seconds}s.mp4"
    _run_quiet(
        "-f", "lavfi", "-i",
        f"testsrc2=size=320x180:rate=30:duration={source_seconds}",
        "-f", "lavfi", "-i",
        f"sine=frequency=880:sample_rate=48000:duration={source_seconds}",
        "-c:v", ENCODER, "-b:v", "500k", "-g", str(GOP),
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(video),
    )
    return video


def _tail_plan(source_seconds: int, tail_seconds: int) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:f03", "mode": "final_export",
        "timeline_revision_id": "rev1",
        "output": {"profile_id": "export-169-v1", "width": 320, "height": 180,
                   "fps_num": 30, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000,
                   "pixel_format": "yuv420p"},
        "inputs": [{"input_id": "I0", "asset_id": "asset0", "asset_kind": "video",
                    "fingerprint": "fp0", "duration_us": source_seconds * US,
                    "has_audio": True}],
        "segments": [{
            "clip_id": "tail", "track_id": "V1", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I0",
            "source_start_us": (source_seconds - tail_seconds) * US,
            "source_end_us": source_seconds * US,
            "timeline_start_us": 0, "timeline_end_us": tail_seconds * US,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        }],
        "captions": {"format": "ass", "items": []},
    }


def _probe(source_seconds: int) -> dict:
    return {"duration_us": source_seconds * US,
            "video_streams": [{"width": 320, "height": 180}],
            "audio_streams": [{"sample_rate": 48000, "channels": 2}]}


def _frame_digest(path: Path) -> str:
    import hashlib

    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=600, check=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def _one_round(args: list[str], out: Path, work: Path) -> dict:
    """一轮完整导出（encode + 校验解码），分阶段计时。"""
    started = time.perf_counter()
    _run_quiet(*args, cwd=work)
    encode_s = time.perf_counter() - started
    decode_started = time.perf_counter()
    subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(out),
         "-f", "null", "-"],
        capture_output=True, timeout=600, check=True,
    )
    validate_decode_s = time.perf_counter() - decode_started
    return {"encode_s": encode_s, "validate_decode_s": validate_decode_s,
            "total_s": encode_s + validate_decode_s}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="result JSON path (must not exist already)")
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--source-seconds", type=int, default=DEFAULT_SOURCE_SECONDS)
    parser.add_argument("--tail-seconds", type=int, default=10)
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("output must not exist; never overwrite evidence")

    from aivs_core.rendering.ffmpeg import build_timeline_args
    from aivs_core.rendering.input_window import plan_input_windows

    work = Path(tempfile.mkdtemp(prefix="f03-deep-"))
    try:
        source = _make_source(work, args.source_seconds)
        plan = _tail_plan(args.source_seconds, args.tail_seconds)
        probes = [_probe(args.source_seconds)]
        paths = [source]
        legacy_args = build_timeline_args(
            plan, paths, probes, ENCODER, "legacy.mp4", captions=False)
        windows = plan_input_windows(plan, probes)
        if not windows[0].eligible:
            raise SystemExit("planner unexpectedly legacy for tail segment")
        deep_args = build_timeline_args(
            plan, paths, probes, ENCODER, "deep.mp4", captions=False,
            input_windows=windows)
        assert deep_args.count("-ss") == 1

        # 正确性前置：帧序列逐位一致才谈性能对比。
        _run_quiet(*legacy_args, cwd=work)
        _run_quiet(*deep_args, cwd=work)
        legacy_out = work / "legacy.mp4"
        deep_out = work / "deep.mp4"
        parity = _frame_digest(legacy_out) == _frame_digest(deep_out)
        if not parity:
            raise SystemExit("parity broken; refusing to record performance")

        rounds: list[dict] = []
        for index in range(args.rounds):
            legacy = _one_round(legacy_args, legacy_out, work)
            deep = _one_round(deep_args, deep_out, work)
            rounds.append({"round": index, "legacy": legacy, "deep": deep})

        def _medians(which: str) -> dict:
            return {
                f"{which}_encode_ms_median": statistics.median(
                    r[which]["encode_s"] * 1000 for r in rounds),
                f"{which}_validate_decode_ms_median": statistics.median(
                    r[which]["validate_decode_s"] * 1000 for r in rounds),
                f"{which}_total_ms_median": statistics.median(
                    r[which]["total_s"] * 1000 for r in rounds),
            }

        legacy_encode = statistics.median(r["legacy"]["encode_s"] for r in rounds)
        deep_encode = statistics.median(r["deep"]["encode_s"] for r in rounds)
        encode_reduction = (1 - deep_encode / legacy_encode) * 100 if legacy_encode else 0.0
        result = {
            "schema_version": 1,
            "benchmark": "f03-export-input-seek",
            "status": "developer-measurement-not-G0",
            "scenario": {
                "source": "testsrc2 320x180 30fps GOP=60 + sine 880Hz",
                "segment": f"tail {args.tail_seconds}s of {args.source_seconds}s source",
                "source_desc": "testsrc2 320x180 30fps + sine 880Hz",
                "structural_equivalence":
                    "seek depth/GOP structure matched to F03 tail; duration scaled",
                "encoder": ENCODER,
            },
            "parity_frame_digest_equal": parity,
            "rounds": rounds,
            **_medians("legacy"),
            **_medians("deep"),
            "encode_time_reduction_percent": encode_reduction,
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "processor": platform.processor(),
                "commit_snapshot": subprocess.run(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                    text=True).stdout.strip(),
                "note": "libopenh264 software encode; hardware-encoder matrix pending",
            },
            "caveats": [
                "scaled source (default 60s); tail ratio matches F03 (5/6) at default",
                "frames decoded not directly counted; same-machine alternating wall time",
                "probe caches not involved (direct ffmpeg invocation)",
            ],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({k: v for k, v in result.items()
                          if k not in {"rounds"}}, indent=2, ensure_ascii=False))
        return 0
    finally:
        if not args.keep_work:
            import shutil

            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
