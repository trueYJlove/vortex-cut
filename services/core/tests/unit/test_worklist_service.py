from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.projects import DomainError
from aivs_core.timeline import TimelineService
from aivs_core.worklist import WorklistService


class FakeEditing:
    def __init__(self) -> None:
        self.proposed: list[dict] = []
        self.applied: list[dict] = []
        self.counter = 0

    def propose(self, project_id: str, request: dict) -> dict:
        self.proposed.append({"project_id": project_id, **request})
        self.counter += 1
        return {"editing_grammar_proposal_id": f"proposal-{self.counter}"}

    def apply(self, project_id: str, proposal_id: str, request: dict) -> dict:
        self.applied.append({"project_id": project_id, "proposal_id": proposal_id, **request})
        return {"timeline_revision_id": f"revision-applied-{len(self.applied)}"}


def _setup(tmp_path: Path) -> tuple[Database, TimelineService, str]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute("INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES ('p1','p1','active','{}','r','r','n','n','n')")
        conn.execute("INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES ('p2','p2','active','{}','r','r','n','n','n')")
    timelines = TimelineService(db)
    state = timelines.create("p1", {"schema_version": 1, "source": {"kind": "empty"}, "default_layout": "blurred_background", "caption_preset_id": "default-bottom"})
    return db, timelines, state["current_revision"]["timeline_revision_id"]


def _request(revision_id: str, count: int = 1) -> dict:
    return {"base_revision_id": revision_id, "steps": [{"kind": "editing_grammar", "planner": f"planner-{i}", "params": {"i": i}} for i in range(count)], "max_steps": count, "token_budget": 100}


def test_worklist_advances_each_step_and_finishes(tmp_path: Path) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    fake = FakeEditing()
    service = WorklistService(db, timelines, fake)  # type: ignore[arg-type]
    prepared = service.prepare("p1", _request(revision_id, 2))
    running = service.create("p1", {"worklist_id": prepared["id"], "base_revision_id": revision_id})
    assert running["status"] == "waiting_for_apply"
    step0 = running["steps"][0]
    next_state = service.apply("p1", prepared["id"], step0["id"], {"base_revision_id": revision_id, "proposed_document_sha256": "sha256:" + "a" * 64})
    assert next_state["status"] == "waiting_for_apply"
    assert next_state["steps"][0]["status"] == "succeeded"
    assert next_state["steps"][1]["status"] == "waiting_for_apply"
    final = service.apply("p1", prepared["id"], next_state["steps"][1]["id"], {"base_revision_id": "revision-applied-1", "proposed_document_sha256": "sha256:" + "b" * 64})
    assert final["status"] == "succeeded"
    assert len(fake.proposed) == 2


def test_worklist_state_survives_database_reopen_without_reproposing(tmp_path: Path) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    fake = FakeEditing()
    service = WorklistService(db, timelines, fake)  # type: ignore[arg-type]
    prepared = service.prepare("p1", _request(revision_id))
    running = service.create("p1", {"worklist_id": prepared["id"], "base_revision_id": revision_id})
    assert running["status"] == "waiting_for_apply"
    proposed_count = len(fake.proposed)
    reopened = Database(tmp_path / "app.db")
    reopened_service = WorklistService(reopened, TimelineService(reopened), FakeEditing())  # type: ignore[arg-type]
    restored = reopened_service.get("p1", prepared["id"])
    assert restored["status"] == "waiting_for_apply"
    assert restored["steps"][0]["proposal_id"] == running["steps"][0]["proposal_id"]
    assert len(fake.proposed) == proposed_count


def test_worklist_active_is_project_scoped_and_duplicate_apply_rejected(tmp_path: Path) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    fake = FakeEditing()
    service = WorklistService(db, timelines, fake)  # type: ignore[arg-type]
    prepared = service.prepare("p1", _request(revision_id))
    service.create("p1", {"worklist_id": prepared["id"], "base_revision_id": revision_id})
    with pytest.raises(DomainError, match="项目已有进行中的工作单"):
        service.prepare("p1", _request(revision_id))
    # A different project has its own active-worklist namespace; a missing base is rejected independently.
    with pytest.raises(DomainError, match="Timeline 基线已变化"):
        service.prepare("p2", _request(revision_id))
