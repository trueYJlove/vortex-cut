"""W1.1 剪辑语法层骨架——确定性 / 零 egress / 采纳链（规划门 §3）。"""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest

from aivs_core.editing_grammar import EditingGrammarService
from aivs_core.projects import DomainError
from test_timeline import _create, _patch, _service


def _insert_clips(service, state, count: int, duration_us: int):
    ops = []
    for i in range(count):
        ops.append(
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": i,
                "source_start_us": i * 1_000_000,
                "source_end_us": i * 1_000_000 + duration_us,
            }
        )
    return _patch(service, state, ops)


def _request(state: dict, params: dict | None = None) -> dict:
    return {
        "base_revision_id": state["current_revision"]["timeline_revision_id"],
        "planner": "drop_short_clips",
        "params": params or {"min_duration_us": 1_500_000},
    }


def test_plan_is_deterministic(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state = _insert_clips(service, state, 3, 500_000)
    grammar = EditingGrammarService(db, service)
    req = _request(state)
    a = grammar.prepare("p1", req)
    b = grammar.prepare("p1", req)
    assert a["operations"] == b["operations"]
    assert json.dumps(a["operations"], sort_keys=True) == json.dumps(
        b["operations"], sort_keys=True
    )
    assert a["rationale"]["planner"] == "drop_short_clips"
    assert a["noop"] is False
    assert a["operations_count"] == 3


def test_zero_egress_plan_propose_apply(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def _blocked(*_args, **_kwargs):
        raise AssertionError("editing_grammar must not use the network")

    monkeypatch.setattr(socket, "socket", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)

    service, db = _service(tmp_path)
    state = _create(service)
    state = _insert_clips(service, state, 2, 500_000)
    grammar = EditingGrammarService(db, service)
    req = _request(state)
    prepared = grammar.prepare("p1", req)
    proposal = grammar.propose("p1", req)
    assert proposal["planner"] == "drop_short_clips"
    assert proposal["rationale"]["rules"]
    assert proposal["applied_revision_id"] is None

    revision = grammar.apply(
        "p1",
        proposal["editing_grammar_proposal_id"],
        {
            "base_revision_id": req["base_revision_id"],
            "proposed_document_sha256": proposal["proposed_document_sha256"],
        },
    )
    assert revision["document"]["clips"] == []
    with pytest.raises(DomainError) as again:
        grammar.apply(
            "p1",
            proposal["editing_grammar_proposal_id"],
            {
                "base_revision_id": req["base_revision_id"],
                "proposed_document_sha256": proposal["proposed_document_sha256"],
            },
        )
    assert again.value.code == "EDITING_GRAMMAR_PROPOSAL_APPLIED"
    assert prepared["operations_count"] == len(proposal["patch"]["operations"])


def test_propose_does_not_write_timeline_until_apply(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state = _insert_clips(service, state, 2, 400_000)
    base_rev = state["current_revision"]["timeline_revision_id"]
    grammar = EditingGrammarService(db, service)
    proposal = grammar.propose("p1", _request(state))
    after = service.get_state("p1")
    assert after["current_revision"]["timeline_revision_id"] == base_rev
    assert len(after["current_revision"]["document"]["clips"]) == 2
    assert proposal["diff"]["clip_changes"]


def test_noop_proposal_rejects_apply(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state = _insert_clips(service, state, 2, 3_000_000)
    grammar = EditingGrammarService(db, service)
    req = _request(state, {"min_duration_us": 100_000})
    prepared = grammar.prepare("p1", req)
    assert prepared["noop"] is True
    proposal = grammar.propose("p1", req)
    with pytest.raises(DomainError) as exc:
        grammar.apply(
            "p1",
            proposal["editing_grammar_proposal_id"],
            {
                "base_revision_id": req["base_revision_id"],
                "proposed_document_sha256": proposal["proposed_document_sha256"],
            },
        )
    assert exc.value.code == "EDITING_GRAMMAR_PROPOSAL_INVALID"


def test_tool_catalog_shape(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    grammar = EditingGrammarService(db, service)
    tools = grammar.list_planners()["items"]
    by_name = {t["name"]: t for t in tools}
    assert "drop_short_clips" in by_name
    assert "parameters_schema" in by_name["drop_short_clips"]
    assert by_name["drop_short_clips"]["preconditions"]


def test_same_proposal_patch_sha(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    state = _create(service)
    state = _insert_clips(service, state, 2, 500_000)
    grammar = EditingGrammarService(db, service)
    req = _request(state)
    p1 = grammar.propose("p1", req)
    p2 = grammar.propose("p1", req)
    assert p1["patch_sha256"] == p2["patch_sha256"]
    assert p1["patch"] == p2["patch"]
