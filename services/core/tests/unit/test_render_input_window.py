"""C21a：导出输入深定位规划器单元测试。

覆盖（计划 C21a）：
- eligibility 最小放行集：普通主轨 1x 正向视频段（源起点足够深）放行；
  变速/倒放/转场借用/关键帧/PiP/图片/音频/浅起点/probe 缺失 各自 legacy；
- seek/shift 值 = 段源起点（µs）；legacy 窗口 0；
- append_input_seek_args 只为 eligible 输入插 -ss（legacy 输入零改动）。
"""
from __future__ import annotations

import pytest

from aivs_core.rendering.input_window import (
    InputWindow,
    MIN_SEEK_US,
    append_input_seek_args,
    plan_input_windows,
)

US = 1_000_000


def _segment(clip_id: str, **extra) -> dict:
    base = {
        "clip_id": clip_id, "track_id": "V1", "asset_kind": "video",
        "asset_id": "asset0", "input_id": "I0",
        "source_start_us": 30 * US, "source_end_us": 40 * US,
        "timeline_start_us": 0, "timeline_end_us": 10 * US,
        "layout": "fit", "audio_enabled": True, "gain_db": 0.0,
    }
    base.update(extra)
    return base


def _plan(segments: list[dict]) -> dict:
    return {
        "schema_version": 1, "compiler_version": "render-plan-v1",
        "content_fingerprint": "sha256:test", "mode": "final_export",
        "timeline_revision_id": "rev1",
        "output": {"profile_id": "export-169-v1", "width": 1920, "height": 1080},
        "inputs": [{"input_id": f"I{i}", "asset_id": f"asset{i}", "asset_kind": "video",
                    "fingerprint": f"fp{i}", "duration_us": 60 * US, "has_audio": True}
                   for i in range(len(segments))],
        "segments": segments,
        "captions": {"format": "ass", "items": []},
    }


def _probe() -> dict:
    return {"duration_us": 60 * US,
            "video_streams": [{"width": 1920, "height": 1080}],
            "audio_streams": [{"sample_rate": 48000, "channels": 2}]}


class TestEligibility:
    def test_plain_main_track_video_eligible(self) -> None:
        plan = _plan([_segment("a")])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is True
        assert windows[0].seek_us == 30 * US
        assert windows[0].shift_us == 30 * US
        assert windows[0].reason == ""

    def test_speed_not_1x_legacy(self) -> None:
        plan = _plan([_segment("a", speed_milli=2000)])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "变速" in windows[0].reason

    def test_reverse_legacy(self) -> None:
        plan = _plan([_segment("a", reverse_playback=True)])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "倒放" in windows[0].reason

    def test_transition_in_legacy(self) -> None:
        plan = _plan([_segment("a", transition_in={"kind": "fade", "duration_us": 500_000})])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "转场" in windows[0].reason

    def test_keyframes_legacy(self) -> None:
        plan = _plan([_segment("a", keyframes={"position": {"frames": [{"t_us": 0, "x": 0.1, "y": 0}]}})])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "关键帧" in windows[0].reason

    def test_transform_legacy_conservative(self) -> None:
        plan = _plan([_segment("a", transform={"scale": 0.5})])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "变换" in windows[0].reason

    def test_pip_track_legacy(self) -> None:
        plan = _plan([_segment("a", track_id="V2")])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "覆盖轨" in windows[0].reason

    def test_image_and_audio_legacy(self) -> None:
        plan = _plan([_segment("a", asset_kind="image"), _segment("b", asset_kind="audio")])
        windows = plan_input_windows(plan, [_probe(), _probe()])
        assert all(w.eligible is False for w in windows)

    def test_shallow_source_start_legacy(self) -> None:
        plan = _plan([_segment("a", source_start_us=500_000, source_end_us=2 * US)])
        windows = plan_input_windows(plan, [_probe()])
        assert windows[0].eligible is False
        assert "过浅" in windows[0].reason
        # 恰好达到阈值（≥ MIN_SEEK_US）放行
        plan2 = _plan([_segment("a", source_start_us=MIN_SEEK_US, source_end_us=2 * MIN_SEEK_US)])
        windows2 = plan_input_windows(plan2, [_probe()])
        assert windows2[0].eligible is True

    def test_missing_probe_legacy(self) -> None:
        plan = _plan([_segment("a")])
        windows = plan_input_windows(plan, [None])
        assert windows[0].eligible is False
        assert "视频流" in windows[0].reason or "时长" in windows[0].reason

    def test_uninterpretable_duration_legacy(self) -> None:
        plan = _plan([_segment("a")])
        probe = _probe() | {"duration_us": 0}
        windows = plan_input_windows(plan, [probe])
        assert windows[0].eligible is False
        assert "时长" in windows[0].reason

    def test_mixed_plan_windows_per_segment(self) -> None:
        """混合时间线：放行/legacy 并存，各自独立判定。"""
        plan = _plan([
            _segment("plain"),                                # eligible
            _segment("fast", speed_milli=1500),               # legacy（变速）
            _segment("pip", track_id="V2"),                   # legacy（PiP）
            _segment("deep2", source_start_us=20 * US),       # eligible
        ])
        windows = plan_input_windows(plan, [_probe() for _ in range(4)])
        assert [w.eligible for w in windows] == [True, False, False, True]
        assert windows[3].seek_us == 20 * US


class TestSeekArgs:
    def test_append_input_seek_args_only_eligible(self) -> None:
        windows = [
            InputWindow(input_index=0, eligible=True, reason="", seek_us=30 * US, shift_us=30 * US),
            InputWindow(input_index=1, eligible=False, reason="变速段（C21b 扩展）"),
        ]
        args: list[str] = []
        append_input_seek_args(args, windows, ["a.mp4", "b.mp4"])
        assert args == ["-ss", "30.000000", "-i", "a.mp4", "-i", "b.mp4"]

    def test_append_input_seek_args_legacy_untouched(self) -> None:
        windows = [InputWindow(input_index=0, eligible=False, reason="x")]
        args: list[str] = []
        append_input_seek_args(args, windows, ["a.mp4"])
        assert args == ["-i", "a.mp4"]

    def test_append_input_seek_args_image_loop(self) -> None:
        """image 输入不走 -ss（build_timeline_args 对 image 分支跳过定位；
        规划器对 image 段本就 legacy——双保险）。"""
        windows = [InputWindow(input_index=0, eligible=False, reason="非视频段")]
        args: list[str] = []
        append_input_seek_args(args, windows, ["img.png"])
        assert args == ["-i", "img.png"]
