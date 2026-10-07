from __future__ import annotations

from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .editing_grammar.service import EditingGrammarService
from .captions_provider_egress import CaptionsProviderEgressService
from .ids import new_id
from .planning import sha256
from .projects import DomainError
from .timeline import TimelineService

KINDS = {"roughcut", "editing_grammar", "captions", "style"}
ACTIVE = ("prepared", "confirmed", "running", "waiting_for_apply")


class WorklistService:
    def __init__(self, db: Database, timelines: TimelineService, editing: EditingGrammarService, captions_provider: CaptionsProviderEgressService | None = None) -> None:
        self.db, self.timelines, self.editing, self.captions_provider = db, timelines, editing, captions_provider

    def _row(self, project_id: str, worklist_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM worklists WHERE id=? AND project_id=?", (worklist_id, project_id)).fetchone()
            if not row:
                raise DomainError("WORKLIST_NOT_FOUND", "工作单不存在")
            steps = db.execute("SELECT * FROM worklist_steps WHERE worklist_id=? ORDER BY ordinal", (worklist_id,)).fetchall()
        return {**dict(row), "steps": [dict(step) for step in steps]}

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "steps", "max_steps", "token_budget"}:
            raise DomainError("WORKLIST_REQUEST_INVALID", "工作单准备请求无效")
        steps = request["steps"]
        if not isinstance(steps, list) or not 1 <= len(steps) <= 6:
            raise DomainError("WORKLIST_STEP_INVALID", "工作单步骤数量无效")
        if not isinstance(request["max_steps"], int) or request["max_steps"] != len(steps):
            raise DomainError("WORKLIST_STEP_INVALID", "max_steps 必须等于步骤数")
        if not isinstance(request["token_budget"], int) or not 1 <= request["token_budget"] <= 200_000:
            raise DomainError("WORKLIST_BUDGET_INVALID", "工作单预算无效")
        with self.db.connection() as db:
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != request["base_revision_id"]:
                raise DomainError("WORKLIST_BASE_DRIFT", "Timeline 基线已变化")
            revision = self.timelines._revision(db, request["base_revision_id"])
            active = db.execute("SELECT 1 FROM worklists WHERE project_id=? AND status IN ('prepared','confirmed','running','waiting_for_apply') LIMIT 1", (project_id,)).fetchone()
            if active:
                raise DomainError("WORKLIST_ALREADY_ACTIVE", "项目已有进行中的工作单")
        normalized: list[dict[str, Any]] = []
        for item in steps:
            if not isinstance(item, dict) or set(item) != {"kind", "planner", "params"} or item["kind"] not in KINDS or not isinstance(item["params"], dict):
                raise DomainError("WORKLIST_STEP_INVALID", "工作单步骤格式或类型无效")
            if item["kind"] == "captions" and item["planner"] not in {"captions", "captions_provider"}:
                raise DomainError("WORKLIST_CAPTIONS_PARAMS_INVALID", "captions step planner 不合法")
            if item["planner"] == "captions_provider" and (set(item["params"]) != {"generation_id"} or not isinstance(item["params"].get("generation_id"), str) or not item["params"]["generation_id"]):
                raise DomainError("WORKLIST_CAPTIONS_PARAMS_INVALID", "Provider 字幕步骤必须指定 generation_id")
            if item["kind"] not in {"editing_grammar", "captions"}:
                raise DomainError("WORKLIST_STEP_UNAVAILABLE", "当前切片仅支持 editing_grammar/captions")
            normalized.append(item)
        worklist_id = f"worklist_{new_id()}"
        now = utc_now()
        with self.db.connection() as db:
            db.execute("INSERT INTO worklists(id,project_id,base_revision_id,base_document_sha256,status,current_step_ordinal,step_count,max_steps,token_budget,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (worklist_id, project_id, revision["timeline_revision_id"], revision["document_sha256"], "prepared", 0, len(normalized), request["max_steps"], request["token_budget"], now, now))
            for ordinal, item in enumerate(normalized):
                db.execute("INSERT INTO worklist_steps(id,worklist_id,ordinal,kind,planner_id,params_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)", (f"worklist_step_{new_id()}", worklist_id, ordinal, item["kind"], item["planner"], json_dumps(item["params"]), "pending", now))
        return self._row(project_id, worklist_id)

    def _start_next_step(self, project_id: str, worklist_id: str, base_revision_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM worklists WHERE id=? AND project_id=?", (worklist_id, project_id)).fetchone()
            step = db.execute("SELECT * FROM worklist_steps WHERE worklist_id=? AND status='pending' ORDER BY ordinal LIMIT 1", (worklist_id,)).fetchone()
            if not row or not step:
                raise DomainError("WORKLIST_NOT_FOUND", "工作单步骤不存在")
            if step["kind"] not in {"editing_grammar", "captions"}:
                raise DomainError("WORKLIST_STEP_UNAVAILABLE", "当前切片仅支持 editing_grammar/captions")
            now = utc_now()
            db.execute("UPDATE worklists SET status='running',current_step_ordinal=?,updated_at=? WHERE id=?", (step["ordinal"], now, worklist_id))
            db.execute("UPDATE worklist_steps SET status='running',base_revision_id=?,started_at=? WHERE id=?", (base_revision_id, now, step["id"]))
        try:
            params = json_loads(step["params_json"])
            if step["planner_id"] == "captions_provider":
                if self.captions_provider is None:
                    raise DomainError("WORKLIST_STEP_UNAVAILABLE", "Provider 字幕服务不可用")
                proposal = self.captions_provider.create_proposal(project_id, params["generation_id"])
                proposal = {"captions_provider_proposal_id": proposal["captions_provider_proposal_id"]}
            else:
                proposal = self.editing.propose(project_id, {"base_revision_id": base_revision_id, "planner": step["planner_id"], "params": params})
        except Exception as exc:
            now = utc_now()
            with self.db.connection() as db:
                db.execute("UPDATE worklists SET status='failed',updated_at=?,finished_at=? WHERE id=?", (now, now, worklist_id))
                db.execute("UPDATE worklist_steps SET status='failed',error_json=?,finished_at=? WHERE id=?", (json_dumps({"message": str(exc)}), now, step["id"]))
            raise
        now = utc_now()
        with self.db.connection() as db:
            db.execute("UPDATE worklists SET status='waiting_for_apply',updated_at=? WHERE id=?", (now, worklist_id))
            proposal_id = proposal.get("captions_provider_proposal_id", proposal.get("editing_grammar_proposal_id"))
            db.execute("UPDATE worklist_steps SET status='waiting_for_apply',proposal_id=?,input_sha256=? WHERE id=?", (proposal_id, sha256(params), step["id"]))
        return self._row(project_id, worklist_id)

    def create(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"worklist_id", "base_revision_id"}:
            raise DomainError("WORKLIST_REQUEST_INVALID", "工作单创建请求无效")
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM worklists WHERE id=? AND project_id=?", (request["worklist_id"], project_id)).fetchone()
            if not row or row["status"] != "prepared":
                raise DomainError("WORKLIST_INVALID_STATE", "工作单不可启动")
            if row["base_revision_id"] != request["base_revision_id"]:
                raise DomainError("WORKLIST_BASE_DRIFT", "工作单基线已变化")
            step = db.execute("SELECT * FROM worklist_steps WHERE worklist_id=? AND ordinal=0", (row["id"],)).fetchone()
        if step["kind"] not in {"editing_grammar", "captions"}:
            raise DomainError("WORKLIST_STEP_UNAVAILABLE", "当前切片仅支持 editing_grammar/captions")
        now = utc_now()
        return self._start_next_step(project_id, row["id"], row["base_revision_id"])

    def apply(self, project_id: str, worklist_id: str, step_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "proposed_document_sha256"}:
            raise DomainError("WORKLIST_REQUEST_INVALID", "应用请求无效")
        with self.db.connection() as db:
            step = db.execute("SELECT * FROM worklist_steps WHERE id=? AND worklist_id=?", (step_id, worklist_id)).fetchone()
            row = db.execute("SELECT * FROM worklists WHERE id=? AND project_id=?", (worklist_id, project_id)).fetchone()
            if not row or not step: raise DomainError("WORKLIST_NOT_FOUND", "工作单步骤不存在")
            if row["status"] != "waiting_for_apply" or step["status"] != "waiting_for_apply": raise DomainError("WORKLIST_INVALID_STATE", "工作单当前不可应用")
            proposal_id = step["proposal_id"]
        if step["planner_id"] == "captions_provider":
            if self.captions_provider is None:
                raise DomainError("WORKLIST_STEP_UNAVAILABLE", "Provider 字幕服务不可用")
            revision = self.captions_provider.apply_proposal(project_id, proposal_id, request)
        else:
            revision = self.editing.apply(project_id, proposal_id, request)
        now = utc_now()
        with self.db.connection() as db:
            db.execute("UPDATE worklist_steps SET status='succeeded',applied_revision_id=?,finished_at=? WHERE id=?", (revision["timeline_revision_id"], now, step_id))
            remaining = db.execute("SELECT 1 FROM worklist_steps WHERE worklist_id=? AND status='pending' LIMIT 1", (worklist_id,)).fetchone()
            if not remaining:
                db.execute("UPDATE worklists SET status='succeeded',current_step_ordinal=step_count,updated_at=?,finished_at=? WHERE id=?", (now, now, worklist_id))
                return self._row(project_id, worklist_id)
        return self._start_next_step(project_id, worklist_id, revision["timeline_revision_id"])

    def cancel(self, project_id: str, worklist_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM worklists WHERE id=? AND project_id=?", (worklist_id, project_id)).fetchone()
            if not row: raise DomainError("WORKLIST_NOT_FOUND", "工作单不存在")
            if row["status"] in ("succeeded", "failed", "cancelled", "expired"): return self._row(project_id, worklist_id)
            now = utc_now(); db.execute("UPDATE worklists SET status='cancelled',updated_at=?,finished_at=? WHERE id=?", (now, now, worklist_id)); db.execute("UPDATE worklist_steps SET status='cancelled',finished_at=? WHERE worklist_id=? AND status IN ('pending','running','waiting_for_apply')", (now, worklist_id))
        return self._row(project_id, worklist_id)

    def get(self, project_id: str, worklist_id: str) -> dict[str, Any]: return self._row(project_id, worklist_id)
    def list(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db: ids = [r["id"] for r in db.execute("SELECT id FROM worklists WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()]
        return [self._row(project_id, worklist_id) for worklist_id in ids]
