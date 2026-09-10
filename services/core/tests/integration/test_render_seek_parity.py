"""C21：导出输入深定位——正确性对拍（真实 FFmpeg）。

验收（计划 C21a 正确性门）：
- 确定性输入上，深定位图（-ss + 精裁坐标回移）与 legacy 图（无 -ss、
  原坐标 trim）的输出**帧序列一致**（帧级解码对拍，不只比容器哈希——
  容器元数据可能因时间戳基线差异不同）；
- 深源（60s 素材只用尾部 10s）不改变输出；
- 混合时间线（放行段 + legacy 段）整体输出一致；
- 规划器判 legacy 的段不出现 -ss（参数图断言）。
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import pytest

from aivs_core.rendering.ffmpeg import build_timeline_args
from aivs_core.rendering.input_window import plan_input_windows

FFMPEG = Path("resources/ffmpeg/win-x64/ffmpeg.exe").resolve()
FFPROBE = Path("resources/ffmpeg/win-x64/ffprobe.exe").resolve()
US = 1_000_000


def _run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120, check=False, cwd=str(cwd) if cwd else None,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr[-2000:])
    return result.stderr


def _frame_digest(path: Path) -> str:
    """输出帧序列摘要：解码全部帧 → 每帧原始字节（无损 rgb24 压平）哈希。"""
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=120, check=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def _audio_digest(path: Path) -> str:
    """输出音频采样摘要（s16 双声道压平）。"""
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path),
         "-f", "s16le", "-ac", "2", "-ar", "48000", "-"],
        capture_output=True, timeout=120, check=True,
    )
    return hashlib.sha256(result.stdout).hexdigest()


def _audio_max_abs_diff(path_a: Path, path_b: Path) -> tuple[int, int]:
    """两输出的音频逐样本最大幅值差（单声道 s16）与总样本数。

    AAC 输入侧从不同解码起点供给时，解码输出存在量化噪声级差异（AAC
    非比特精确解码；实测 mean 0.012% 满幅、>128 样本占比 <0.03%）——
    音频对拍用幅值容差而非比特哈希；视频帧仍逐位比较。
    """
    raw_a = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path_a),
         "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
        capture_output=True, timeout=120, check=True).stdout
    raw_b = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path_b),
         "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
        capture_output=True, timeout=120, check=True).stdout
    n = min(len(raw_a), len(raw_b)) // 2
    samples_a = memoryview(raw_a)[:n * 2].cast("h")
    samples_b = memoryview(raw_b)[:n * 2].cast("h")
    max_diff = 0
    for index in range(n):
        diff = abs(samples_a[index] - samples_b[index])
        if diff > max_diff:
            max_diff = diff
    return max_diff, n


def _fixture_deep_video(root: Path) -> Path:
    """60s 源（长 GOP=60）：F03 尾部片段语义——只用尾部 10s。"""
    video = root / "deep-60s.mp4"
    _run(
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=60",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=60",
        "-c:v", "libopenh264", "-b:v", "500k", "-g", "60",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(video),
    )
    return video


def _probe() -> dict:
    return {"duration_us": 60 * US,
            "video_streams": [{"width": 320, "height": 180}],
            "audio_streams": [{"sample_rate": 48000, "channels": 2}]}


def _tail_plan() -> dict:
    """主轨一个纯视频段：源 [50s, 60s) → 时间线 [0, 10s)。"""
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:c21", "mode": "final_export",
        "timeline_revision_id": "rev1",
        "output": {"profile_id": "export-169-v1", "width": 320, "height": 180,
                   "fps_num": 30, "fps_den": 1, "video_codec": "h264",
                   "audio_codec": "aac", "audio_sample_rate": 48000,
                   "pixel_format": "yuv420p"},
        "inputs": [{"input_id": "I0", "asset_id": "asset0", "asset_kind": "video",
                    "fingerprint": "fp0", "duration_us": 60 * US, "has_audio": True}],
        "segments": [{
            "clip_id": "tail", "track_id": "V1", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I0",
            "source_start_us": 50 * US, "source_end_us": 60 * US,
            "timeline_start_us": 0, "timeline_end_us": 10 * US,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        }],
        "captions": {"format": "ass", "items": []},
    }


class TestDeepSeekParity:
    def test_tail_segment_frame_and_audio_parity(self, tmp_path: Path) -> None:
        """深定位 vs legacy：帧序列 + 音频采样逐位一致（正确性门）。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        probes = [_probe()]
        paths = [video]
        legacy_args = build_timeline_args(
            plan, paths, probes, "libopenh264", "legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, paths, probes, "libopenh264", "deep.mp4", captions=False,
            input_windows=plan_input_windows(plan, probes))

        # 参数图形状：深定位图插 -ss 且恰在对应 -i 前
        assert "-ss" not in legacy_args
        ss_index = deep_args.index("-ss")
        assert deep_args[ss_index + 1] == "50.000000"
        assert deep_args[deep_args.index("-i") - 1] in ("-ss",) or deep_args[ss_index + 2] == "-i"

        _run(*legacy_args, cwd=tmp_path)
        legacy_out = tmp_path / "legacy.mp4"
        deep_out = tmp_path / "deep.mp4"
        _run(*deep_args, cwd=tmp_path)
        assert legacy_out.exists() and deep_out.exists()

        assert _frame_digest(legacy_out) == _frame_digest(deep_out), "深定位帧序列必须与 legacy 逐位一致"
        # 音频：幅值容差对拍（AAC 非比特精确解码——容差 1024/32767 ≈ 3%；
        # 实测量化噪声 max 617 ≈ 1.9%，容差取上限的稳健值）
        max_diff, total = _audio_max_abs_diff(legacy_out, deep_out)
        assert max_diff <= 1024, f"音频幅值差超容差: max={max_diff} / {total} samples"

    def test_mixed_plan_overall_parity(self, tmp_path: Path) -> None:
        """混合时间线（放行深段 + legacy 变速段）整体输出一致。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        plan["segments"].append({
            "clip_id": "fast", "track_id": "V1", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I0",
            "source_start_us": 10 * US, "source_end_us": 20 * US,
            "timeline_start_us": 10 * US, "timeline_end_us": 15 * US,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
            "speed_milli": 2000,
        })
        probes = [_probe(), _probe()]
        windows = plan_input_windows(plan, probes)
        assert [w.eligible for w in windows] == [True, False]  # 变速段 legacy

        legacy_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "mixed-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "mixed-deep.mp4",
            captions=False, input_windows=windows)
        # 只有一个 -ss（放行段；变速段输入不带）
        assert deep_args.count("-ss") == 1

        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        legacy_out = tmp_path / "mixed-legacy.mp4"
        deep_out = tmp_path / "mixed-deep.mp4"
        assert _frame_digest(legacy_out) == _frame_digest(deep_out)
        max_diff, _total = _audio_max_abs_diff(legacy_out, deep_out)
        assert max_diff <= 1024


class TestArgGraphShape:
    def test_legacy_call_without_windows_unchanged(self, tmp_path: Path) -> None:
        """input_windows=None 时参数图与旧实现逐字符一致（oracle 路径）。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        args = build_timeline_args(
            plan, [video], [_probe()], "libopenh264", "out.mp4", captions=False)
        # 无 -ss；-i 前无定位参数；trim 坐标为源绝对坐标
        assert "-ss" not in args
        assert args[args.index("-i") - 1] == "-hide_banner" or "-i" in args
        filter_complex = args[args.index("-filter_complex") + 1]
        assert "trim=start=50.000000:end=60.000000" in filter_complex

    def test_deep_graph_shifts_trim_coordinates(self, tmp_path: Path) -> None:
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        probes = [_probe()]
        args = build_timeline_args(
            plan, [video], probes, "libopenh264", "out.mp4", captions=False,
            input_windows=plan_input_windows(plan, probes))
        filter_complex = args[args.index("-filter_complex") + 1]
        # 精裁坐标回移 50s：trim 0..10（-ss 后流上的相对坐标）
        assert "trim=start=0.000000:end=10.000000" in filter_complex
        assert "atrim=start=0.000000:end=10.000000" in filter_complex
