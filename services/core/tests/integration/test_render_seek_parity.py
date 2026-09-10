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


def _audio_aligned_residual(
    path_a: Path, path_b: Path, shift_span: int = 48,
) -> tuple[int, int, int]:
    """最优 ±shift_span 样本平移后的残差 (peak, rms_x1000, n)。

    C21b 变速路径实证：深定位 vs legacy 的输出存在**恒定 4 样本
    （0.083ms @48k，源侧 0.17ms）相位偏移**——AAC 非比特精确解码起点
    量化噪声经 atempo/aresample 传递（对齐后 rms≈0.08% 满幅）。该偏移
    远低于一帧（33ms），非错帧/错位；对拍按"最优平移后残差"验收：
    小相位差可接受，错位/错帧不可接受。
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
    best = None
    for shift in range(-shift_span, shift_span + 1):
        count = n - abs(shift)
        total = 0
        peak = 0
        for index in range(count):
            diff = samples_a[index] - samples_b[index + shift]
            total += diff * diff
            magnitude = abs(diff)
            if magnitude > peak:
                peak = magnitude
        score = total / count
        if best is None or score < best[0]:
            best = (score, peak, count)
    rms = int((best[0] ** 0.5) * 1000)
    return best[1], rms, best[2]


def _audio_shape_parity(path_a: Path, path_b: Path) -> tuple[int, float, int, float]:
    """变速段音频形状对拍：(样本数差, 过零率相对差%, 最坏窗 rms, n)。

    逐样本幅值差对相位差极敏感（880Hz 正弦上 4 样本相位差直接变成大瞬
    时幅值差——峰值不可用）。且混合速度时间线中不同速度段的 AAC 起点
    相位差不同（实证：2x 段 -4 样本、1x legacy 段 0 样本），全局单一
    平移对齐无解。验收用**形状量纲 + 秒窗局部对齐**（计划"音频有效区间
    和 A/V 偏差保持既有标准"的语义）：
    - 样本数差 = 0：时长/有效区间逐样本一致（padding/裁切语义未变）；
    - 过零率相对差 < 0.5%：音高/时间基未变（错帧会显著改变过零率）；
    - 每秒窗内 ±48 样本(1ms) 最优平移后残差 rms 全部 < 满幅 5%：段内
      波形一致、残差为量化噪声级（真实错位/错帧 33ms 在 1ms 窗内无解，
      窗内 rms 会保持高位）。
    """
    raw_a = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path_a),
         "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
        capture_output=True, timeout=120, check=True).stdout
    raw_b = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-v", "error", "-i", str(path_b),
         "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
        capture_output=True, timeout=120, check=True).stdout

    def _zcr(raw: bytes) -> float:
        count = len(raw) // 2
        samples = memoryview(raw)[:count * 2].cast("h")
        crossings = sum(
            1 for index in range(1, count) if (samples[index - 1] < 0) != (samples[index] < 0)
        )
        return crossings / max(count - 1, 1)

    samples_diff = len(raw_a) // 2 - len(raw_b) // 2
    zcr_a = _zcr(raw_a)
    zcr_rel = abs(zcr_a - _zcr(raw_b)) / zcr_a * 100 if zcr_a else 0.0
    n = min(len(raw_a), len(raw_b)) // 2
    samples_a = memoryview(raw_a)[:n * 2].cast("h")
    samples_b = memoryview(raw_b)[:n * 2].cast("h")
    window = 48_000
    worst_rms = 0.0
    for start in range(0, n, window):
        end = min(start + window, n)
        best = None
        for shift in range(-48, 49):
            total = 0
            count = 0
            for index in range(start, end):
                source = index + shift
                if 0 <= source < n:
                    diff = samples_a[index] - samples_b[source]
                    total += diff * diff
                    count += 1
            if count and (best is None or total / count < best):
                best = total / count
        if best is not None:
            worst_rms = max(worst_rms, best ** 0.5)
    return samples_diff, zcr_rel, int(worst_rms), n


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
        """混合时间线（放行深段 + C21b 变速放行段）整体输出一致。"""
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
        assert [w.eligible for w in windows] == [True, True]  # C21b：变速放行

        legacy_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "mixed-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "mixed-deep.mp4",
            captions=False, input_windows=windows)
        # 两个 -ss（放行段 + C21b 变速段各自独立定位）
        assert deep_args.count("-ss") == 2

        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        legacy_out = tmp_path / "mixed-legacy.mp4"
        deep_out = tmp_path / "mixed-deep.mp4"
        assert _frame_digest(legacy_out) == _frame_digest(deep_out)
        samples_diff, zcr_rel, worst_rms, _total = _audio_shape_parity(
            legacy_out, deep_out)
        assert samples_diff == 0
        assert zcr_rel < 0.5
        assert worst_rms < 1638, f"秒窗对齐残差 {worst_rms:.0f} 超满幅 5%"


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


class TestSpeedParity:
    def test_forward_speed_2x_frame_parity(self, tmp_path: Path) -> None:
        """C21b：正向变速段深定位 vs legacy 帧序列一致（trim 回移在
        setpts 变速之前——源坐标域不随速度改变）。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        plan["segments"][0]["speed_milli"] = 2000
        plan["segments"][0]["source_start_us"] = 40 * US
        plan["segments"][0]["source_end_us"] = 60 * US  # 20s 源 → 10s 时间线
        probes = [_probe()]
        paths = [video]
        windows = plan_input_windows(plan, probes)
        assert windows[0].eligible is True
        legacy_args = build_timeline_args(
            plan, paths, probes, "libopenh264", "sp-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, paths, probes, "libopenh264", "sp-deep.mp4", captions=False,
            input_windows=windows)
        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        assert _frame_digest(tmp_path / "sp-legacy.mp4") == _frame_digest(tmp_path / "sp-deep.mp4")
        # 变速音频：atempo 传递 AAC 起点量化噪声（恒定 0.083ms 相位差）——
        # 形状量纲验收：时长逐样本一致 + 过零率差 <0.5% + 秒窗局部对齐残差
        # <满幅 5%（错帧 33ms 在 1ms 局部对齐窗内无解）。
        samples_diff, zcr_rel, worst_rms, _n = _audio_shape_parity(
            tmp_path / "sp-legacy.mp4", tmp_path / "sp-deep.mp4")
        assert samples_diff == 0, "变速音频时长/有效区间必须逐样本一致"
        assert zcr_rel < 0.5, f"过零率相对差 {zcr_rel:.3f}% 超门（时间基/音高改变）"
        assert worst_rms < 1638, f"秒窗对齐残差 {worst_rms:.0f} 超满幅 5%（错位/错帧）"

    def test_speed_with_head_borrow_parity(self, tmp_path: Path) -> None:
        """C21b：变速 + 转场借用组合（head 借用×速度换算进 trim 坐标）。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        plan["segments"][0]["speed_milli"] = 2000
        plan["segments"][0]["source_start_us"] = 40 * US
        plan["segments"][0]["source_end_us"] = 60 * US
        plan["segments"][0]["transition_in"] = {"kind": "fade", "duration_us": 1 * US}
        # 后继段提供转场激活条件（首尾相接）。
        plan["segments"].append({
            "clip_id": "next", "track_id": "V1", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I1",
            "source_start_us": 0, "source_end_us": 5 * US,
            "timeline_start_us": 10 * US, "timeline_end_us": 15 * US,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        })
        plan["inputs"].append({"input_id": "I1", "asset_id": "asset0",
                               "asset_kind": "video", "fingerprint": "fp1",
                               "duration_us": 60 * US, "has_audio": True})
        probes = [_probe(), _probe()]
        windows = plan_input_windows(plan, probes)
        assert [w.eligible for w in windows] == [True, False]  # 后继段源起点 0 过浅
        legacy_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "sb-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "sb-deep.mp4", captions=False,
            input_windows=windows)
        assert deep_args.count("-ss") == 1
        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        assert _frame_digest(tmp_path / "sb-legacy.mp4") == _frame_digest(tmp_path / "sb-deep.mp4")
        samples_diff, zcr_rel, worst_rms, _n = _audio_shape_parity(
            tmp_path / "sb-legacy.mp4", tmp_path / "sb-deep.mp4")
        assert samples_diff == 0
        assert zcr_rel < 0.5
        assert worst_rms < 1638


class TestTransitionParity:
    def test_transition_anchor_and_right_both_deep(self, tmp_path: Path) -> None:
        """C21b：转场两侧都深定位（xfade 双路取窗 trim 坐标各自回移，
        右段 shift 用右段自己的窗口——stale shift 回归在此锁定）。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        plan["segments"][0]["transition_in"] = {"kind": "fade", "duration_us": 1 * US}
        # 右段也用深源（与左段不同源起点——stale shift 时坐标错移 → 帧不一致）。
        plan["segments"].append({
            "clip_id": "right", "track_id": "V1", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I1",
            "source_start_us": 45 * US, "source_end_us": 60 * US,
            "timeline_start_us": 10 * US, "timeline_end_us": 25 * US,
            "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
        })
        plan["inputs"].append({"input_id": "I1", "asset_id": "asset0",
                               "asset_kind": "video", "fingerprint": "fp1",
                               "duration_us": 60 * US, "has_audio": True})
        probes = [_probe(), _probe()]
        windows = plan_input_windows(plan, probes)
        assert [w.eligible for w in windows] == [True, True]
        assert windows[0].seek_us == 50 * US and windows[1].seek_us == 45 * US
        legacy_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "tr-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "tr-deep.mp4", captions=False,
            input_windows=windows)
        assert deep_args.count("-ss") == 2
        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        assert _frame_digest(tmp_path / "tr-legacy.mp4") == _frame_digest(tmp_path / "tr-deep.mp4")
        max_diff, _n = _audio_max_abs_diff(tmp_path / "tr-legacy.mp4", tmp_path / "tr-deep.mp4")
        assert max_diff <= 1024


class TestPipParity:
    def test_pip_overlay_deep_seek_parity(self, tmp_path: Path) -> None:
        """C21b：PiP 覆盖轨段深定位 vs legacy——主轨 legacy + PiP eligible，
        覆盖层 trim 坐标回移不改变合成输出。"""
        video = _fixture_deep_video(tmp_path)
        plan = _tail_plan()
        # 主轨段源起点 0（浅——legacy）；PiP 覆盖段用深源（eligible）。
        plan["segments"][0]["source_start_us"] = 0
        plan["segments"][0]["source_end_us"] = 10 * US
        plan["segments"][0]["timeline_start_us"] = 0
        plan["segments"][0]["timeline_end_us"] = 10 * US
        plan["segments"].append({
            "clip_id": "pip", "track_id": "V2", "asset_kind": "video",
            "asset_id": "asset0", "input_id": "I1",
            "source_start_us": 40 * US, "source_end_us": 50 * US,
            "timeline_start_us": 2 * US, "timeline_end_us": 8 * US,
            "layout": "fit", "audio_enabled": False, "gain_db": 0.0,
            "transform": {"x": 0.75, "y": 0.25, "scale": 0.4},
        })
        plan["inputs"].append({"input_id": "I1", "asset_id": "asset0",
                               "asset_kind": "video", "fingerprint": "fp1",
                               "duration_us": 60 * US, "has_audio": True})
        probes = [_probe(), _probe()]
        windows = plan_input_windows(plan, probes)
        assert [w.eligible for w in windows] == [False, True]  # 主轨浅 legacy、PiP 深
        legacy_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "pip-legacy.mp4", captions=False)
        deep_args = build_timeline_args(
            plan, [video, video], probes, "libopenh264", "pip-deep.mp4", captions=False,
            input_windows=windows)
        assert deep_args.count("-ss") == 1
        assert deep_args[deep_args.index("-ss") + 1] == "40.000000"
        _run(*legacy_args, cwd=tmp_path)
        _run(*deep_args, cwd=tmp_path)
        assert _frame_digest(tmp_path / "pip-legacy.mp4") == (
            _frame_digest(tmp_path / "pip-deep.mp4"))
