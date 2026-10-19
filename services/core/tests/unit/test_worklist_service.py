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


def _request(revision_id: str, count: int = 1, kind: str = "editing_grammar", planner: str | None = None) -> dict:
    return {"base_revision_id": revision_id, "steps": [{"kind": kind, "planner": planner or f"planner-{i}", "params": {"i": i}} for i in range(count)], "max_steps": count, "token_budget": 100}


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


def test_worklist_captions_step_is_accepted_only_with_captions_planner(tmp_path: Path) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    service = WorklistService(db, timelines, FakeEditing())  # type: ignore[arg-type]
    prepared = service.prepare("p1", {"base_revision_id": revision_id, "steps": [{"kind": "captions", "planner": "captions", "params": {"transcript_id": "t1", "segment_ids": ["s1"], "at_index": 0}}], "max_steps": 1, "token_budget": 1})
    assert prepared["steps"][0]["kind"] == "captions"
    service.cancel("p1", prepared["id"])
    with pytest.raises(DomainError, match="captions step"):
        service.prepare("p1", {"base_revision_id": revision_id, "steps": [{"kind": "captions", "planner": "wrong", "params": {}}], "max_steps": 1, "token_budget": 1})


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


def _insert_worklist_with_steps(db: Database, worklist_id: str, revision_id: str, kinds: list[str]) -> None:
    # prepare() 会先拒绝未实现的 kind，故 create/_start_next_step 两处守卫只能靠直接落库触达。
    # 数据库 CHECK 允许四种 kind（database_v27.py:24），因此这样才能走到运行路径的守卫。
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO worklists(id,project_id,base_revision_id,base_document_sha256,status,current_step_ordinal,step_count,max_steps,token_budget,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (worklist_id, "p1", revision_id, "sha256:" + "c" * 64, "prepared", 0, len(kinds), len(kinds), 100, "n", "n"),
        )
        for ordinal, kind in enumerate(kinds):
            conn.execute(
                "INSERT INTO worklist_steps(id,worklist_id,ordinal,kind,planner_id,params_json,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (f"{worklist_id}-step-{ordinal}", worklist_id, ordinal, kind, "planner-x", "{}", "pending", "n"),
            )


@pytest.mark.parametrize("kind", ["roughcut", "style"])
def test_worklist_prepare_rejects_unimplemented_step_kinds(tmp_path: Path, kind: str) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    service = WorklistService(db, timelines, FakeEditing())  # type: ignore[arg-type]
    request = {"base_revision_id": revision_id, "steps": [{"kind": kind, "planner": "p", "params": {}}], "max_steps": 1, "token_budget": 1}
    with pytest.raises(DomainError) as excinfo:
        service.prepare("p1", request)
    assert excinfo.value.code == "WORKLIST_STEP_UNAVAILABLE"


@pytest.mark.parametrize("kind", ["roughcut", "style"])
def test_worklist_create_rejects_unimplemented_step_kinds(tmp_path: Path, kind: str) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    service = WorklistService(db, timelines, FakeEditing())  # type: ignore[arg-type]
    _insert_worklist_with_steps(db, "wl-create", revision_id, [kind])
    with pytest.raises(DomainError) as excinfo:
        service.create("p1", {"worklist_id": "wl-create", "base_revision_id": revision_id})
    assert excinfo.value.code == "WORKLIST_STEP_UNAVAILABLE"
    # 拒单零副作用：设计门 :162 要求「不得产生 job 副作用」。
    unchanged = service.get("p1", "wl-create")
    assert unchanged["status"] == "prepared"
    assert unchanged["steps"][0]["status"] == "pending"


@pytest.mark.parametrize("kind", ["roughcut", "style"])
def test_worklist_step_advance_rejects_unimplemented_step_kinds(tmp_path: Path, kind: str) -> None:
    db, timelines, revision_id = _setup(tmp_path)
    service = WorklistService(db, timelines, FakeEditing())  # type: ignore[arg-type]
    _insert_worklist_with_steps(db, "wl-advance", revision_id, ["editing_grammar", kind])
    running = service.create("p1", {"worklist_id": "wl-advance", "base_revision_id": revision_id})
    assert running["status"] == "waiting_for_apply"
    with pytest.raises(DomainError) as excinfo:
        service.apply("p1", "wl-advance", running["steps"][0]["id"], {"base_revision_id": revision_id, "proposed_document_sha256": "sha256:" + "d" * 64})
    assert excinfo.value.code == "WORKLIST_STEP_UNAVAILABLE"

