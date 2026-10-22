"""E8 响度测量：真实随包 ffmpeg 的 EBU R128 实测（不是常数、不是推算）。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from aivs_core.media.loudness import (
    LOUDNESS_ALGORITHM_VERSION,
    MEASURABLE_FLOOR_LUFS,
    LoudnessProbe,
    measure_range,
    measurement_args,
    parse_integrated_lufs,
)

FFMPEG = Path(__file__).resolve().parents[4] / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file():
        pytest.skip("bundled ffmpeg unavailable")


def _sine(path: Path, amplitude: float, *, seconds: float = 3.0) -> Path:
    """合成 440Hz 正弦，**振幅显式可算**（aevalsrc 的 a*sin(...)）。

    不用 lavfi 的 sine 源：它的默认幅度不是 1.0（实测 peak -18.1 dBFS），
    振幅到 dBFS 的换算不可直接推算。aevalsrc 的幅度就是字面值。
    """
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-nostdin", "-y",
            "-f", "lavfi", "-i",
            f"aevalsrc={amplitude}*sin(2*PI*440*t):s=48000:d={seconds}",
            "-ac", "1", "-c:a", "pcm_s16le", str(path),
        ],
        check=True, capture_output=True,
    )
    return path


class TestPureParts:
    """参数/解析：不需要 ffmpeg，也必须能区分对错。"""

    def test_args_use_input_side_seek_and_ebur128(self) -> None:
        args = measurement_args("a.mp4", start_us=2_000_000, end_us=3_500_000)
        assert args.index("-ss") < args.index("-i")
        assert args[args.index("-ss") + 1] == "2.000000"
        assert args[args.index("-t") + 1] == "1.500000"
        assert any(arg.startswith("ebur128=metadata=1") for arg in args)
        assert "-map" in args and args[args.index("-map") + 1] == "0:a:0"

    def test_args_omit_seek_when_range_absent(self) -> None:
        args = measurement_args("a.mp4")
        assert "-ss" not in args
        assert "-t" not in args

    def test_parse_takes_last_frame(self) -> None:
        stdout = "frame:0\nlavfi.r128.I=-70.000\nframe:9\nlavfi.r128.I=-31.500\n"
        assert parse_integrated_lufs(stdout) == -31.5

    def test_parse_returns_none_without_frames(self) -> None:
        assert parse_integrated_lufs("") is None
        assert parse_integrated_lufs("some unrelated log line") is None


class TestRealMeasurement:
    def test_lufs_tracks_amplitude_monotonically(self, tmp_path: Path) -> None:
        """负向对照 2：测量改成返回常数 ⇒ 本条红（差值恒为 0，单调性断言失败）。

        四档振幅各差 10 dB 左右；实测值必须严格单调递增且跨度足够大，
        才能证明「真的在测」而不是返回某个固定值。
        """
        _require_ffmpeg()
        amplitudes = [0.01, 0.05, 0.3, 0.9]
        results = []
        for index, amplitude in enumerate(amplitudes):
            source = _sine(tmp_path / f"sine_{index}.wav", amplitude)
            record = measure_range(FFMPEG, source)
            assert record["status"] == "measured", record
            results.append(record["integrated_lufs"])

        assert results == sorted(results), f"非单调: {results}"
        assert len(set(results)) == len(results), f"出现重复值（疑似常数）: {results}"
        for lower, higher in zip(results, results[1:]):
            assert higher - lower > 5.0, f"相邻档位差过小，区分力不足: {results}"
        # 跨度必须覆盖 ~40 dB（0.01 → 0.9 是 -40 dBFS 到 -1 dBFS 的振幅比）
        assert results[-1] - results[0] > 30.0, results

    def test_measured_value_is_absolute_lufs(self, tmp_path: Path) -> None:
        """口径锚定：绝对值 LUFS，不是 0/100 之类的相对量。

        440Hz 单声道正弦 amplitude=0.125（-18.06 dBFS 峰值）：K 加权后应落在
        ≈ -21.8 LUFS（实测 -21.76）。同时验证振幅每减半 ≈ -6.02 dB —— 这条
        关系只对真的做了 K 加权的积分测量成立。
        """
        _require_ffmpeg()
        reference = measure_range(FFMPEG, _sine(tmp_path / "anchor.wav", 0.125))
        assert reference["status"] == "measured"
        assert reference["integrated_lufs"] == pytest.approx(-21.76, abs=0.5)

        halved = measure_range(FFMPEG, _sine(tmp_path / "halved.wav", 0.0625))
        assert halved["status"] == "measured"
        assert reference["integrated_lufs"] - halved["integrated_lufs"] == pytest.approx(
            6.02, abs=0.3
        )

    def test_range_seek_measures_only_that_span(self, tmp_path: Path) -> None:
        """同一素材前段响后段静 ⇒ 区间测量必须只反映区间内的内容。"""
        _require_ffmpeg()
        loud = _sine(tmp_path / "loud.wav", 0.5, seconds=2.0)
        quiet = _sine(tmp_path / "quiet.wav", 0.005, seconds=2.0)
        combined = tmp_path / "combined.wav"
        subprocess.run(
            [
                str(FFMPEG), "-hide_banner", "-nostdin", "-y",
                "-i", str(loud), "-i", str(quiet),
                "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
                "-map", "[out]", "-c:a", "pcm_s16le", str(combined),
            ],
            check=True, capture_output=True,
        )
        head = measure_range(FFMPEG, combined, start_us=0, end_us=2_000_000)
        tail = measure_range(FFMPEG, combined, start_us=2_000_000, end_us=4_000_000)
        assert head["status"] == "measured"
        assert tail["status"] == "measured"
        assert head["integrated_lufs"] - tail["integrated_lufs"] > 20.0

    def test_record_carries_reproducible_args(self, tmp_path: Path) -> None:
        """可复算：记录必须带算法版本 + 完整 ffmpeg 参数。"""
        _require_ffmpeg()
        source = _sine(tmp_path / "repro.wav", 0.3)
        record = measure_range(FFMPEG, source)
        assert record["algorithm_version"] == LOUDNESS_ALGORITHM_VERSION
        assert record["args"][0] == "-hide_banner"
        assert any(arg.startswith("ebur128=metadata=1") for arg in record["args"])

    def test_silence_is_unmeasurable_not_zero(self, tmp_path: Path) -> None:
        """静音：ebur128 夹在绝对门限 -70 ⇒ 如实标 unmeasurable，绝不当 0。"""
        _require_ffmpeg()
        silent = tmp_path / "silent.wav"
        subprocess.run(
            [
                str(FFMPEG), "-hide_banner", "-nostdin", "-y",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2",
                "-c:a", "pcm_s16le", str(silent),
            ],
            check=True, capture_output=True,
        )
        record = measure_range(FFMPEG, silent)
        assert record["status"] == "unmeasurable"
        assert record["integrated_lufs"] is None
        assert record["reason"] == "LOUDNESS_BELOW_ABSOLUTE_GATE"
        assert record["raw_integrated_lufs"] <= MEASURABLE_FLOOR_LUFS

    def test_short_clip_is_unmeasurable_not_zero(self, tmp_path: Path) -> None:
        """短于 400ms 门控块：同样不可测，不给数字。"""
        _require_ffmpeg()
        source = _sine(tmp_path / "short.wav", 0.3, seconds=0.2)
        record = measure_range(FFMPEG, source)
        assert record["status"] == "unmeasurable"
        assert record["integrated_lufs"] is None

    def test_video_without_audio_reports_no_audio(self, tmp_path: Path) -> None:
        _require_ffmpeg()
        video = tmp_path / "silent_video.mp4"
        subprocess.run(
            [
                str(FFMPEG), "-hide_banner", "-nostdin", "-y",
                "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=2",
                "-c:v", "mpeg4", str(video),
            ],
            check=True, capture_output=True,
        )
        record = measure_range(FFMPEG, video)
        assert record["status"] == "no_audio"
        assert record["integrated_lufs"] is None
        assert record["reason"] == "MEDIA_NO_AUDIO"

    def test_missing_file_reports_failure_with_reason(self, tmp_path: Path) -> None:
        _require_ffmpeg()
        record = measure_range(FFMPEG, tmp_path / "does_not_exist.mp4")
        assert record["status"] == "failed"
        assert record["integrated_lufs"] is None
        assert record["reason"].startswith("LOUDNESS_FFMPEG_FAILED")

    def test_seek_past_end_reports_failure_not_zero(self, tmp_path: Path) -> None:
        """区间完全落在素材之外：没有帧 ⇒ failed（不是 0，也不是 -70）。"""
        _require_ffmpeg()
        source = _sine(tmp_path / "two.wav", 0.3, seconds=1.0)
        record = measure_range(FFMPEG, source, start_us=30_000_000, end_us=32_000_000)
        assert record["status"] == "failed"
        assert record["integrated_lufs"] is None
        assert record["reason"] == "LOUDNESS_NO_FRAMES"


class TestLoudnessProbe:
    def test_probe_uses_source_range_and_asset_path(self, tmp_path: Path) -> None:
        _require_ffmpeg()
        source = _sine(tmp_path / "probe.wav", 0.3, seconds=4.0)
        probe = LoudnessProbe(FFMPEG, lambda asset_id: {"asset_id": asset_id, "path": str(source)})
        record = probe.measure_clip(
            {"clip_id": "c1", "asset_id": "a1", "source_start_us": 0,
             "source_end_us": 2_000_000}
        )
        assert record["clip_id"] == "c1"
        assert record["status"] == "measured"
        assert record["algorithm_version"] == LOUDNESS_ALGORITHM_VERSION
        assert (record["source_start_us"], record["source_end_us"]) == (0, 2_000_000)

    def test_probe_reports_unresolvable_asset(self) -> None:
        class _Missing(Exception):
            code = "ASSET_MISSING"

        def _resolve(asset_id: str) -> dict:
            raise _Missing("missing")

        record = LoudnessProbe(FFMPEG, _resolve).measure_clip(
            {"clip_id": "c1", "asset_id": "a1", "source_start_us": 0,
             "source_end_us": 1_000_000}
        )
        assert record["status"] == "failed"
        assert record["integrated_lufs"] is None
        assert "ASSET_MISSING" in record["reason"]

    def test_probe_measure_clips_keeps_order(self, tmp_path: Path) -> None:
        _require_ffmpeg()
        loud = _sine(tmp_path / "loud.wav", 0.5)
        quiet = _sine(tmp_path / "quiet.wav", 0.02)
        paths = {"a_loud": loud, "a_quiet": quiet}
        probe = LoudnessProbe(
            FFMPEG, lambda asset_id: {"asset_id": asset_id, "path": str(paths[asset_id])}
        )
        batch = probe.measure_clips(
            [
                {"clip_id": "c1", "asset_id": "a_loud"},
                {"clip_id": "c2", "asset_id": "a_quiet"},
            ]
        )
        assert [item["clip_id"] for item in batch["items"]] == ["c1", "c2"]
        assert batch["algorithm_version"] == LOUDNESS_ALGORITHM_VERSION
        assert batch["items"][0]["integrated_lufs"] > batch["items"][1]["integrated_lufs"]
