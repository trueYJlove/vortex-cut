"""W1.5 跳切/去停顿——静音检测与 remove_pauses（规划门 §3）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.editing_grammar import EditingGrammarService, RemovePausesPlanner
from aivs_core.editing_grammar.silence import (
    compute_keep_intervals,
    detect_silence_intervals,
)
from aivs_core.projects import DomainError
from aivs_core.timeline import MIN_VIDEO_US
from test_timeline import _create, _patch, _service


def _samples_for_ranges(silent: list[tuple[int, int]], *, start: int, end: int, step: int = 100_000):
    samples = []
    ts = start
    while ts < end:
        is_silent = any(s <= ts < e for s, e in silent)
        samples.append(
            {
                "timestamp_us": ts,
                "audio_energy": 0.01 if is_silent else 0.4,
            }
        )
        ts += step
    return samples


class TestDetectSilence:
    def test_two_silence_runs(self):
        samples = _samples_for_ranges(
            [(2_000_000, 3_000_000), (5_000_000, 7_000_000)],
            start=0,
            end=8_000_000,
            step=200_000,
        )
        got = detect_silence_intervals(samples, energy_threshold=0.05, min_silence_us=400_000)
        assert len(got) == 2
        assert got[0][0] == 2_000_000
        assert got[1][0] == 5_000_000

    def test_short_silence_ignored(self):
        samples = _samples_for_ranges(
            [(1_000_000, 1_300_000)], start=0, end=2_000_000, step=100_000
        )
        got = detect_silence_intervals(samples, energy_threshold=0.05, min_silence_us=400_000)
        assert got == []

    def test_all_silent(self):
        samples = _samples_for_ranges([], start=0, end=1_000_000, step=100_000)
        for s in samples:
            s["audio_energy"] = 0.0
        got = detect_silence_intervals(samples, energy_threshold=0.05, min_silence_us=200_000)
        assert got and got[0][0] == 0


class TestKeepIntervals:
    def test_pad_shrinks_silence(self):
        keeps = compute_keep_intervals(
            [(2_000_000, 3_000_000)],
            start_us=0,
            end_us=5_000_000,
            pad_us=100_000,
        )
        assert keeps == [(0, 2_100_000), (2_900_000, 5_000_000)]

    def test_tiny_fragments_merged(self):
        keeps = compute_keep_intervals(
            [(100_000, 2_000_000)],
            start_us=0,
            end_us=2_100_000,
            pad_us=0,
        )
        assert keeps == [(0, 2_100_000)] or all(e - s >= MIN_VIDEO_US for s, e in keeps)


def _video_clip(service, state, *, end_us: int = 5_000_000):
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": 0,
                "source_start_us": 0,
                "source_end_us": end_us,
            }
        ],
    )
    return state, state["current_revision"]["document"]["clips"][0]["clip_id"]


def test_remove_pauses_ops_deterministic(tmp_path: Path) -> None:
    planner = RemovePausesPlanner()
    service, _ = _service(tmp_path)
    state = _create(service)
    state, clip_id = _video_clip(service, state)
    doc = state["current_revision"]["document"]
    params = {
        "clip_id": clip_id,
        "min_silence_us": 300_000,
        "energy_threshold": 0.05,
        "pad_us": 50_000,
        "silence_intervals_us": [[1_000_000, 1_500_000], [3_000_000, 4_000_000]],
    }
    a = planner.plan(doc, params)
    b = planner.plan(doc, params)
    assert a.operations == b.operations
    assert a.noop is False
    keeps = a.rationale["keep_intervals_us"]
    assert len(keeps) == 3
    assert all(e - s >= MIN_VIDEO_US for s, e in keeps)


def test_remove_pauses_e2e_closes_gaps(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state, clip_id = _video_clip(service, state)
    grammar = EditingGrammarService(db, service)
    req = {
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "planner": "remove_pauses",
        "params": {
            "clip_id": clip_id,
            "silence_intervals_us": [[1_000_000, 1_500_000], [3_000_000, 4_000_000]],
            "pad_us": 0,
            "min_silence_us": 300_000,
        },
    }
    proposal = grammar.propose("p1", req)
    revision = grammar.apply(
        "p1",
        proposal["editing_grammar_proposal_id"],
        {
            "base_revision_id": req["base_revision_id"],
            "proposed_document_sha256": proposal["proposed_document_sha256"],
        },
    )
    clips = sorted(
        revision["document"]["clips"], key=lambda c: c["timeline_start_us"]
    )
    assert len(clips) == 3
    assert all(c["asset_kind"] == "video" for c in clips)
    # 连续拼接：无空隙
    for left, right in zip(clips, clips[1:]):
        assert left["timeline_end_us"] == right["timeline_start_us"]
    # 保留源区间精确（pad=0）
    ranges = [(c["source_start_us"], c["source_end_us"]) for c in clips]
    assert ranges == [(0, 1_000_000), (1_500_000, 3_000_000), (4_000_000, 5_000_000)]
    # 无过短碎片
    assert all(c["timeline_end_us"] - c["timeline_start_us"] >= MIN_VIDEO_US for c in clips)


def test_all_zero_energy_rejected(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state, clip_id = _video_clip(service, state)
    grammar = EditingGrammarService(db, service)
    req = {
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "planner": "remove_pauses",
        "params": {"clip_id": clip_id},
    }
    with pytest.raises(DomainError) as exc:
        grammar.prepare("p1", req)
    assert exc.value.code == "EDITING_GRAMMAR_NO_SPEECH"


def test_no_silence_is_noop(tmp_path: Path) -> None:
    planner = RemovePausesPlanner()
    service, _ = _service(tmp_path)
    state = _create(service)
    state, clip_id = _video_clip(service, state)
    result = planner.plan(
        state["current_revision"]["document"],
        {"clip_id": clip_id, "silence_intervals_us": []},
    )
    assert result.noop is True
    assert result.operations == ()


def test_tool_registered() -> None:
    from aivs_core.editing_grammar.registry import default_registry

    names = {t["name"] for t in default_registry().list_tools()}
    assert "remove_pauses" in names
    assert "drop_short_clips" in names
