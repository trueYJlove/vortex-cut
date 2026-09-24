"""W1.2 节拍网格——合成 click BPM/相位与服务落库（规划门 §3）。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database
from aivs_core.media.beat_grid import (
    analyze_pcm,
    downbeats_from_beats,
    estimate_tempo_bpm,
    spectral_flux_onset_envelope,
    synthesize_click_pcm,
    track_beats,
)
from aivs_core.media.beat_service import BeatGridService, parse_grid_payload


def _hit_rate(pred: list[int], truth: list[int], tol_us: int = 40_000) -> float:
    if not truth:
        return 1.0
    hit = 0
    for t in truth:
        if any(abs(p - t) <= tol_us for p in pred):
            hit += 1
    return hit / len(truth)


class TestClickTrack:
    def test_120bpm_bpm_and_beats(self):
        pcm, truth = synthesize_click_pcm(bpm=120.0, duration_s=8.0, phase_s=0.05)
        result = analyze_pcm(pcm)
        assert result["status"] == "ready"
        assert result["bpm"] == pytest.approx(120.0, rel=0.02)
        assert _hit_rate(result["beats_us"], truth, tol_us=40_000) >= 0.9

    def test_phase_offset_tracked(self):
        pcm, truth = synthesize_click_pcm(bpm=100.0, duration_s=6.0, phase_s=0.12)
        result = analyze_pcm(pcm)
        assert result["status"] == "ready"
        assert result["bpm"] == pytest.approx(100.0, rel=0.02)
        assert _hit_rate(result["beats_us"], truth) >= 0.85

    def test_deterministic(self):
        pcm, _ = synthesize_click_pcm(bpm=128.0, duration_s=5.0)
        a = analyze_pcm(pcm)
        b = analyze_pcm(pcm)
        assert a["beats_us"] == b["beats_us"]
        assert a["bpm"] == b["bpm"]

    def test_downbeat_every_four(self):
        beats = list(range(0, 8_000_000, 500_000))
        down = downbeats_from_beats(beats, phase=0)
        assert down == beats[::4]


class TestUnavailable:
    def test_empty_pcm(self):
        result = analyze_pcm(np.zeros(0))
        assert result["status"] == "unavailable"
        assert result["reason"] == "no_audio_or_silent"

    def test_silent_pcm(self):
        result = analyze_pcm(np.zeros(22050 * 2))
        assert result["status"] == "unavailable"

    def test_service_no_audio_does_not_raise(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
                "created_at,updated_at,last_opened_at) "
                "VALUES ('p1','P','active','{}','r','r','now','now','now')"
            )
            conn.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES ('a1','p1','audio','external','A','fp1',1,'available','{}','now','now')"
            )
        service = BeatGridService(db, ffmpeg=Path("ffmpeg"))
        out = service.analyze_samples("a1", "fp1", np.zeros(0))
        assert out["status"] == "unavailable"
        latest = service.latest_beat_grid("a1")
        assert latest is not None
        parsed = parse_grid_payload(latest)
        assert parsed["beats_us"] == []


class TestTempoHelpers:
    def test_estimate_on_click_envelope(self):
        pcm, _ = synthesize_click_pcm(bpm=140.0, duration_s=6.0)
        onset, fr = spectral_flux_onset_envelope(pcm)
        tempo = estimate_tempo_bpm(onset, fr)
        assert tempo["bpm"] == pytest.approx(140.0, rel=0.03)
        beats = track_beats(onset, fr, tempo["lag_s"])
        assert len(beats) >= 8
