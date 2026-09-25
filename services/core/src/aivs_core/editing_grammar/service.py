"""语法提案三段式：prepare（干跑）/ propose（落盘）/ apply（既有采纳链）。

P-A 路径：**零 egress、无 provider、无 consent**（总纲 §5.2）。
"""

from __future__ import annotations

import copy
import hashlib
from typing import Any

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..planning import sha256
from ..projects import DomainError
from ..timeline import TimelineService, timeline_diff
from .registry import PlannerRegistry, default_registry


def _proposed_document_sha256(document: dict[str, Any]) -> str:
    return f"sha256:{hashlib.sha256(json_dumps(document).encode()).hexdigest()}"


class EditingGrammarService:
    def __init__(
        self,
        db: Database,
        timelines: TimelineService,
        registry: PlannerRegistry | None = None,
    ) -> None:
        self.db = db
        self.timelines = timelines
        self.registry = registry or default_registry()

    def list_planners(self) -> dict[str, Any]:
        return {"items": self.registry.list_tools()}

    def _load_base(self, project_id: str, base_revision_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != base_revision_id:
                raise DomainError("EDITING_GRAMMAR_BASE_CONFLICT", "Timeline 基线已变化")
            return self.timelines._revision(db, base_revision_id)

    def _signals_for(
        self,
        document: dict[str, Any],
        params: dict[str, Any],
        planner: str,
    ) -> dict[str, Any]:
        """按规划器注入本地信号（零 egress）。

        - remove_pauses：CV 音频能量样本
        - beat_sync：beat_grids 的 beats_us/downbeats_us
        - lj_cut：transcript_words（params.words 为空时）
        """
        signals: dict[str, Any] = {}
        if planner == "remove_pauses":
            clip_id = params.get("clip_id")
            if not isinstance(clip_id, str):
                return signals
            clip = next(
                (c for c in document.get("clips") or [] if c.get("clip_id") == clip_id),
                None,
            )
            if not clip or clip.get("asset_kind") != "video":
                return signals
            start_us, end_us = clip.get("source_start_us"), clip.get("source_end_us")
            if start_us is None or end_us is None:
                return signals
            with self.db.connection() as db:
                analysis = db.execute(
                    "SELECT id FROM cv_analyses WHERE asset_id=? AND status='ready' "
                    "ORDER BY created_at DESC LIMIT 1",
                    (clip.get("asset_id"),),
                ).fetchone()
                if not analysis:
                    signals["samples"] = []
                    return signals
                rows = db.execute(
                    "SELECT timestamp_us,audio_energy FROM cv_samples "
                    "WHERE analysis_id=? AND timestamp_us>=? AND timestamp_us<? "
                    "ORDER BY timestamp_us",
                    (analysis["id"], start_us, end_us),
                ).fetchall()
            signals["samples"] = [
                {"timestamp_us": row["timestamp_us"], "audio_energy": row["audio_energy"]}
                for row in rows
            ]
            return signals

        if planner == "beat_sync":
            bgm_asset_id = params.get("bgm_asset_id")
            if not isinstance(bgm_asset_id, str) or not bgm_asset_id:
                first = (params.get("segments") or [{}])[0]
                bgm_asset_id = first.get("asset_id") if isinstance(first, dict) else None
            if not isinstance(bgm_asset_id, str):
                return signals
            with self.db.connection() as db:
                row = db.execute(
                    "SELECT beats_json,downbeats_json FROM beat_grids "
                    "WHERE asset_id=? AND status='ready' "
                    "ORDER BY created_at DESC LIMIT 1",
                    (bgm_asset_id,),
                ).fetchone()
            if row:
                signals["beats_us"] = json_loads(row["beats_json"] or "[]")
                signals["downbeats_us"] = json_loads(row["downbeats_json"] or "[]")
            return signals

        if planner == "lj_cut":
            explicit = params.get("words")
            if isinstance(explicit, list) and explicit:
                return signals
            clip_id = params.get("clip_id")
            if not isinstance(clip_id, str):
                return signals
            clip = next(
                (c for c in document.get("clips") or [] if c.get("clip_id") == clip_id),
                None,
            )
            if not clip:
                return signals
            with self.db.connection() as db:
                rows = db.execute(
                    "SELECT w.start_us,w.end_us,w.text FROM transcript_words w "
                    "JOIN transcript_segments s ON w.segment_id=s.id "
                    "JOIN transcripts t ON s.transcript_id=t.id "
                    "WHERE t.asset_id=? AND t.status='ready' "
                    "ORDER BY w.start_us,w.ordinal",
                    (clip.get("asset_id"),),
                ).fetchall()
            signals["words"] = [
                {"start_us": row["start_us"], "end_us": row["end_us"], "text": row["text"]}
                for row in rows
            ]
            return signals

        return signals

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "planner", "params"}:
            raise DomainError("EDITING_GRAMMAR_REQUEST_INVALID", "准备请求无效")
        planner = self.registry.get(request["planner"])
        params = request["params"]
        if not isinstance(params, dict):
            raise DomainError("EDITING_GRAMMAR_PARAMS_INVALID", "规划器参数不合法")
        revision = self._load_base(project_id, request["base_revision_id"])
        signals = self._signals_for(revision["document"], params, planner.tool.name)
        result = planner.plan(revision["document"], params, signals=signals)
        return {
            "planner": planner.tool.name,
            "params": params,
            "summary": result.summary,
            "operations": [dict(op) for op in result.operations],
            "operations_count": len(result.operations),
            "noop": result.noop,
            "rationale": result.rationale,
            "base_revision_id": revision["timeline_revision_id"],
            "base_document_sha256": revision["document_sha256"],
        }

    def propose(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        preview = self.prepare(project_id, request)
        revision = self._load_base(project_id, request["base_revision_id"])
        patch = {
            "summary": preview["summary"],
            "operations": preview["operations"],
        }
        patch_sha = sha256(patch)
        with self.db.connection() as db:
            if preview["noop"]:
                proposed = copy.deepcopy(revision["document"])
            else:
                proposed = self.timelines.apply_in_memory(
                    db,
                    project_id,
                    revision["document"],
                    patch["operations"],
                    ai=False,
                    require_non_empty=False,
                )
            proposed_hash = _proposed_document_sha256(proposed)
            # diff 用内存对象对：临时包装成 revision 形状供 timeline_diff
            diff = timeline_diff(
                {
                    "project_id": project_id,
                    "timeline_revision_id": revision["timeline_revision_id"],
                    "document": revision["document"],
                    "document_sha256": revision["document_sha256"],
                },
                {
                    "project_id": project_id,
                    "timeline_revision_id": None,
                    "document": proposed,
                    "document_sha256": proposed_hash,
                },
            )
            proposal_id = f"editing_grammar_proposal_{new_id()}"
            now = utc_now()
            db.execute(
                "INSERT INTO editing_grammar_proposals("
                "id,project_id,planner,params_json,base_revision_id,base_document_sha256,"
                "patch_json,patch_sha256,proposed_document_sha256,rationale_json,diff_json,"
                "created_at,proposed_document_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    proposal_id,
                    project_id,
                    preview["planner"],
                    json_dumps(preview["params"]),
                    revision["timeline_revision_id"],
                    revision["document_sha256"],
                    json_dumps(patch),
                    patch_sha,
                    proposed_hash,
                    json_dumps(preview["rationale"]),
                    json_dumps(diff),
                    now,
                    json_dumps(proposed),
                ),
            )
        return self.get_proposal(project_id, proposal_id)

    def list_proposals(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id,planner,base_revision_id,proposed_document_sha256,created_at,"
                "patch_sha256 FROM editing_grammar_proposals WHERE project_id=? "
                "ORDER BY created_at DESC,id DESC",
                (project_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_proposal(self, project_id: str, proposal_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM editing_grammar_proposals WHERE id=? AND project_id=?",
                (proposal_id, project_id),
            ).fetchone()
            if not row:
                raise DomainError("EDITING_GRAMMAR_PROPOSAL_NOT_FOUND", "语法提案不存在")
            application = db.execute(
                "SELECT timeline_revision_id FROM editing_grammar_applications "
                "WHERE proposal_id=?",
                (proposal_id,),
            ).fetchone()
        return {
            "editing_grammar_proposal_id": row["id"],
            "project_id": row["project_id"],
            "planner": row["planner"],
            "params": json_loads(row["params_json"]),
            "base_revision_id": row["base_revision_id"],
            "base_document_sha256": row["base_document_sha256"],
            "patch": json_loads(row["patch_json"]),
            "patch_sha256": row["patch_sha256"],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "rationale": json_loads(row["rationale_json"]),
            "diff": json_loads(row["diff_json"]),
            "created_at": row["created_at"],
            "applied_revision_id": (
                application["timeline_revision_id"] if application else None
            ),
        }

    def apply(
        self, project_id: str, proposal_id: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "proposed_document_sha256"}:
            raise DomainError("EDITING_GRAMMAR_PROPOSAL_INVALID", "应用请求无效")
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                row = db.execute(
                    "SELECT * FROM editing_grammar_proposals WHERE id=? AND project_id=?",
                    (proposal_id, project_id),
                ).fetchone()
                if not row:
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_NOT_FOUND", "语法提案不存在"
                    )
                if db.execute(
                    "SELECT 1 FROM editing_grammar_applications WHERE proposal_id=?",
                    (proposal_id,),
                ).fetchone():
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_APPLIED", "语法提案已应用"
                    )
                if (
                    request["base_revision_id"] != row["base_revision_id"]
                    or request["proposed_document_sha256"]
                    != row["proposed_document_sha256"]
                ):
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_CONFLICT", "语法提案哈希不匹配"
                    )
                patch = json_loads(row["patch_json"])
                if sha256(patch) != row["patch_sha256"]:
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_INVALID", "Patch 内容哈希无效"
                    )
                if not patch.get("operations"):
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_INVALID", "空操作提案不可应用"
                    )
                base = self.timelines._revision(db, row["base_revision_id"])
                if base["document_sha256"] != row["base_document_sha256"]:
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_CONFLICT", "Timeline 基线哈希已变化"
                    )
                proposed = json_loads(row["proposed_document_json"])
                if _proposed_document_sha256(proposed) != row["proposed_document_sha256"]:
                    raise DomainError(
                        "EDITING_GRAMMAR_PROPOSAL_CONFLICT", "拟议文档哈希不一致"
                    )
                revision = self.timelines.create_revision_from_document(
                    db,
                    project_id,
                    row["base_revision_id"],
                    proposed,
                    patch["summary"],
                )
                db.execute("DELETE FROM timeline_drafts WHERE project_id=?", (project_id,))
                db.execute(
                    "INSERT INTO editing_grammar_applications("
                    "id,proposal_id,project_id,timeline_revision_id,created_at) "
                    "VALUES (?,?,?,?,?)",
                    (
                        f"editing_grammar_application_{new_id()}",
                        proposal_id,
                        project_id,
                        revision["timeline_revision_id"],
                        utc_now(),
                    ),
                )
                db.execute("COMMIT")
                return revision
            except Exception:
                db.execute("ROLLBACK")
                raise
