"""W1.3 卡点 beat_sync——切点吸附 beat、强拍放重镜头（规划门 §3）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.editing_grammar import BeatSyncPlanner, EditingGrammarService
from aivs_core.projects import DomainError
from test_timeline import _create, _service


def _beats(period_us: int, count: int, start: int = 0) -> list[int]:
    return [start + i * period_us for i in range(count)]


def _params(n_segments: int = 3) -> dict:
    segs = []
    for i in range(n_segments):
        segs.append(
            {
                "asset_id": "v1",
                "source_start_us": i * 2_000_000,
                "source_end_us": i * 2_000_000 + 2_000_000,
                "face": 3.0 if i == 0 else 0.0,
                "motion": 1.0 if i == 0 else 0.1,
                "sharpness": 1.0 if i == 0 else 0.2,
            }
        )
    return {
        "target_duration_us": 4_000_000,
        "beats_per_shot": 2,
        "bgm_asset_id": "a1",
        "beats_us": _beats(500_000, 12),
        "downbeats_us": [0, 2_000_000, 4_000_000, 6_000_000, 8_000_000, 10_000_000],
        "segments": segs,
    }


def test_cuts_snap_to_beats(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    planner = BeatSyncPlanner()
    result = planner.plan(state["current_revision"]["document"], _params())
    assert result.noop is False
    for rule in result.rationale["rules"]:
        # 镜头起点为 beat
        assert rule["beat_start_us"] % 500_000 == 0
        # 时间线起点/终点落在 beat 相对网格
        assert rule["timeline_start_us"] % 500_000 == 0
        assert rule["timeline_end_us"] % 500_000 == 0
    # 切点集合 ⊆ beat 相对时间
    beats_rel = set(range(0, 12 * 500_000, 500_000))
    for rule in result.rationale["rules"]:
        assert rule["timeline_start_us"] in beats_rel
        assert rule["timeline_end_us"] in beats_rel


def test_strong_beat_gets_heavy_segment(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    planner = BeatSyncPlanner()
    result = planner.plan(state["current_revision"]["document"], _params())
    heavy = result.rationale["rules"][0]
    # 最高分段（motion 0.9）应落第一槽；第一槽 beat 0 为 downbeat
    assert heavy["strong"] is True
    assert heavy["features"]["face"] == pytest.approx(3.0)
    assert heavy["score"] == max(r["score"] for r in result.rationale["rules"])


def test_reuse_when_short_on_segments(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    planner = BeatSyncPlanner()
    params = _params(n_segments=1)
    params["target_duration_us"] = 4_000_000
    result = planner.plan(state["current_revision"]["document"], params)
    assert len(result.rationale["rules"]) >= 2
    assert any(r["reused"] for r in result.rationale["rules"])


def test_deterministic(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    planner = BeatSyncPlanner()
    a = planner.plan(state["current_revision"]["document"], _params())
    b = planner.plan(state["current_revision"]["document"], _params())
    assert a.operations == b.operations
    assert a.rationale["rules"] == b.rationale["rules"]


def test_e2e_apply_on_beat_grid(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    grammar = EditingGrammarService(db, service)
    req = {
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "planner": "beat_sync",
        "params": _params(n_segments=2),
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
    clips = sorted(revision["document"]["clips"], key=lambda c: c["timeline_start_us"])
    rules = sorted(proposal["rationale"]["rules"], key=lambda r: r["timeline_start_us"])
    assert len(clips) == len(rules)
    for clip, rule in zip(clips, rules):
        assert clip["timeline_start_us"] == rule["timeline_start_us"]
        assert clip["timeline_end_us"] == rule["timeline_end_us"]


def test_requires_beats(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    planner = BeatSyncPlanner()
    params = _params()
    params["beats_us"] = [0]
    with pytest.raises(DomainError) as exc:
        planner.plan(state["current_revision"]["document"], params)
    assert exc.value.code == "EDITING_GRAMMAR_PARAMS_INVALID"


def test_beats_injected_from_beat_grids(tmp_path: Path) -> None:
    """params 不带 beats_us 时，由 beat_grids 信号注入（Desktop 一键路径）。"""
    service, db = _service(tmp_path)
    state = _create(service)
    grammar = EditingGrammarService(db, service)
    params = _params(n_segments=1)
    params.pop("beats_us", None)
    params.pop("downbeats_us", None)
    params["bgm_asset_id"] = "v1"
    beats = [i * 500_000 for i in range(20)]
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,"
            "status,bpm,lag_s,confidence,beats_json,downbeats_json,candidates_json,"
            "reason,model_revision,sample_rate,created_at,updated_at,finished_at) "
            "VALUES ('bg1','v1','fp',1,'ready',120,0.5,0.9,?,?,'[]',NULL,NULL,22050,'t0','t0','t0')",
            (__import__("aivs_core.database", fromlist=["json_dumps"]).json_dumps(beats),
             __import__("aivs_core.database", fromlist=["json_dumps"]).json_dumps(beats[::4])),
        )
    req = {
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "planner": "beat_sync",
        "params": params,
    }
    preview = grammar.prepare("p1", req)
    assert preview["operations_count"] >= 1
