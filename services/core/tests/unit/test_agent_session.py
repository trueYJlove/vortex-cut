from __future__ import annotations  # noqa: I001

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from test_timeline import _create, _service

from aivs_core.agent_session import (
    SESSION_TOKEN_BUDGET,
    AgentSessionService,
    _structured_failure,
)
from aivs_core.database import Database, json_dumps
from aivs_core.planning import ProviderRepository, sha256
from aivs_core.projects import DomainError
from aivs_core.providers import ProviderSecretVault, StructuredTextResult
from aivs_core.timeline import TimelineService


class _Jobs:
    """最小 JobService 替身（create_session 后可 get 到真实 job 行）。"""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.job_id: str | None = None

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.db.connection() as conn:
            row = conn.execute(
                "SELECT id,status,progress,created_at FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        if not row:
            return None
        return {"job_id": row["id"], "status": row["status"], "progress": row["progress"]}

    def row_for(self, session_id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            row = conn.execute(
                "SELECT id,input_json FROM jobs WHERE kind='agent_session' AND "
                "input_json LIKE ? ORDER BY created_at DESC LIMIT 1",
                (f'%"{session_id}"%',),
            ).fetchone()
        assert row is not None
        return {"id": row["id"], "kind": "agent_session", "input": {"agent_session_id": session_id}}


def _patch_result(operations: list[dict[str, Any]], summary: str = "step") -> dict[str, Any]:
    return {"summary": summary, "operations": operations}


def _first_clip_id(timelines: TimelineService) -> str:
    """fixture 时间线首段 clip_id（随机生成，动态取）。"""
    with timelines.db.connection() as conn:
        project = conn.execute(
            "SELECT current_timeline_revision_id FROM projects WHERE id='p1'"
        ).fetchone()
        revision = timelines._revision(conn, project["current_timeline_revision_id"])
    return revision["document"]["clips"][0]["clip_id"]


# Factory 闭包取当前测试时间线首段 clip_id（各测试 seed 后写入）。
_CLIP: dict[str, str | None] = {"id": None}


def _usage(total_tokens: int) -> dict[str, Any]:
    return {"total_tokens": total_tokens}


def _agent_service(
    tmp_path: Path,
    provider_factory: Any,
) -> tuple[Database, AgentSessionService, TimelineService]:
    timelines, db = _service(tmp_path)
    vault = ProviderSecretVault()
    providers = ProviderRepository(db, vault)
    providers.create(
        {
            "kind": "openai_compatible_text",
            "display_name": "provider",
            "base_url": "https://provider.example/v1",
            "model": "m",
            "input_price_per_million": 2.0,
            "output_price_per_million": 4.0,
        }
    )
    with db.connection() as conn:
        conn.execute(
            "UPDATE provider_configs SET timeline_patch_capability_status='supported',"
            "timeline_patch_response_adapter_id='openai_chat_completions_json_schema_v1',"
            "timeline_patch_probe_protocol_version='2',"
            "timeline_patch_capability_tested_at='now',"
            "timeline_patch_capability_probe_sha256='sha256:probe'"
        )
    vault.set(providers.list()[0]["provider_config_id"], "TEST_API_KEY")
    service = AgentSessionService(
        db, providers, vault, timelines, provider_factory=provider_factory
    )
    return db, service, timelines


def _seed_timeline(timelines: TimelineService) -> dict[str, Any]:
    state = _create(timelines, {"kind": "full_asset", "asset_id": "v1"})
    _CLIP["id"] = state["current_revision"]["document"]["clips"][0]["clip_id"]
    return state


def _start_session(
    db: Database, service: AgentSessionService, state: dict[str, Any]
) -> tuple[str, _Jobs]:
    provider = service.providers.list()[0]
    preview = service.prepare(
        "p1",
        {
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "provider_config_id": provider["provider_config_id"],
            "instruction": "把第一个片段布局改为 fit",
        },
    )
    jobs = _Jobs(db)
    created = service.create_session(
        "p1",
        preview["agent_session_egress_preview_id"],
        preview["payload_sha256"],
        jobs,
    )
    session_id = created["agent_session_id"]
    jobs.job_id = created["job"]["job_id"]
    return session_id, jobs


async def _run(db: Database, service: AgentSessionService, jobs: _Jobs) -> dict[str, Any]:
    row = jobs.row_for(_session_id_of(jobs))
    return await service.run_session(
        row, asyncio.Event(), lambda _v: None, lambda _s: None
    )


def _session_id_of(jobs: _Jobs) -> str:
    with jobs.db.connection() as conn:
        row = conn.execute(
            "SELECT input_json FROM jobs WHERE id=?", (jobs.job_id,)
        ).fetchone()
    import json

    return json.loads(row["input_json"])["agent_session_id"]


def _steps(db: Database, session_id: str) -> list[sqlite3.Row]:
    with db.connection() as conn:
        return conn.execute(
            "SELECT * FROM agent_steps WHERE session_id=? ORDER BY ordinal",
            (session_id,),
        ).fetchall()


def _session_row(db: Database, session_id: str) -> sqlite3.Row:
    with db.connection() as conn:
        return conn.execute(
            "SELECT * FROM agent_sessions WHERE id=?", (session_id,)
        ).fetchone()


def _revision_count(db: Database) -> int:
    with db.connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]


# ----------------------------------------------------------------------
# 收敛：步 1 校验失败（结构化反馈）→ 步 2 成功 → succeeded，Revision +1
# ----------------------------------------------------------------------


async def test_session_converges_after_structured_feedback(tmp_path: Path) -> None:
    calls: list[dict[str, Any]] = []

    class Factory:
        async def generate(self, request: Any, _cancel: Any) -> StructuredTextResult:
            calls.append(request.payload)
            if len(calls) == 1:
                # 引用不存在的 clip → 域校验失败（结构化反馈进入步 2 payload）。
                return StructuredTextResult(
                    _patch_result([{"op": "remove_clip", "clip_id": "missing"}], "bad"),
                    _usage(100), None,
                )
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(100), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    before = _revision_count(db)
    session_id, jobs = _start_session(db, service, state)
    result = await _run(db, service, jobs)
    assert result["steps_completed"] == 2
    assert _session_row(db, session_id)["status"] == "succeeded"
    assert _revision_count(db) == before + 1  # 失败步不落 Revision
    steps = _steps(db, session_id)
    assert [step["status"] for step in steps] == ["failed", "succeeded"]
    # 步 2 payload 携带步 1 的结构化失败反馈。
    assert "feedback" in calls[1]
    failure = calls[1]["feedback"]["previous_failures"][0]
    assert failure["code"] == "TIMELINE_CLIP_NOT_FOUND"
    assert failure["failure"]["operation_index"] == 1
    assert failure["failure"]["op"] == "remove_clip"


# ----------------------------------------------------------------------
# 步数上限：持续失败 → 恰在 max_steps 后中止
# ----------------------------------------------------------------------


async def test_session_stops_at_step_limit(tmp_path: Path) -> None:
    count = {"n": 0}

    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            count["n"] += 1
            return StructuredTextResult(
                _patch_result([{"op": "remove_clip", "clip_id": "missing"}], "bad"),
                _usage(10), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    session_id, jobs = _start_session(db, service, state)
    with pytest.raises(DomainError) as exc:
        await _run(db, service, jobs)
    assert exc.value.code == "AGENT_SESSION_STEP_LIMIT"
    assert count["n"] == 6
    assert _session_row(db, session_id)["status"] == "failed"
    assert len(_steps(db, session_id)) == 6
    assert _revision_count(db) == 1  # 仅 seed——全部失败步不落 Revision


# ----------------------------------------------------------------------
# token 预算：超限中止
# ----------------------------------------------------------------------


async def test_session_budget_exceeded(tmp_path: Path) -> None:
    import aivs_core.agent_session as module

    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(SESSION_TOKEN_BUDGET), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    session_id, jobs = _start_session(db, service, state)
    original = module.SESSION_TOKEN_BUDGET
    module.SESSION_TOKEN_BUDGET = 10  # 首步即超
    try:
        with pytest.raises(DomainError) as exc:
            await _run(db, service, jobs)
    finally:
        module.SESSION_TOKEN_BUDGET = original
    assert exc.value.code == "AGENT_SESSION_BUDGET_EXCEEDED"
    assert _session_row(db, session_id)["status"] == "failed"


# ----------------------------------------------------------------------
# 取消：步 1 成功、步 2 前取消 → cancelled，已落 Revision 保留
# ----------------------------------------------------------------------


async def test_session_cancel_midway(tmp_path: Path) -> None:
    cancel = asyncio.Event()
    calls = {"n": 0}

    class Factory:
        async def generate(self, _request: Any, cancel_event: Any) -> StructuredTextResult:
            calls["n"] += 1
            if calls["n"] == 1:
                # 步 1 校验失败 → 反馈重试留在循环内，取消路径可被穿过。
                return StructuredTextResult(
                    _patch_result([{"op": "remove_clip", "clip_id": "missing"}], "bad"),
                    _usage(10), None,
                )
            cancel_event.set()
            raise asyncio.CancelledError()

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    before = _revision_count(db)
    session_id, jobs = _start_session(db, service, state)
    with pytest.raises(asyncio.CancelledError):
        await service.run_session(
            jobs.row_for(_session_id_of(jobs)), cancel, lambda _v: None, lambda _s: None
        )
    assert _session_row(db, session_id)["status"] == "cancelled"
    assert _revision_count(db) == before  # 取消于步 2 前沿：无步成果落盘


# ----------------------------------------------------------------------
# consent 单次消费：同 preview 二次创建会话失败
# ----------------------------------------------------------------------


async def test_session_consent_single_use(tmp_path: Path) -> None:
    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(10), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    provider = service.providers.list()[0]
    preview = service.prepare(
        "p1",
        {
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "provider_config_id": provider["provider_config_id"],
            "instruction": "改布局",
        },
    )
    jobs = _Jobs(db)
    created = service.create_session(
        "p1", preview["agent_session_egress_preview_id"], preview["payload_sha256"], jobs
    )
    session_id = created["agent_session_id"]
    jobs.job_id = created["job"]["job_id"]
    # 先跑到终态（腾出 active 槽位），验证 consent 的单次性不受会话状态影响。
    await _run(db, service, jobs)
    assert _session_row(db, session_id)["status"] == "succeeded"
    # pending_store 已弹出：同 preview 再来 = 正文失效（consent 单次消费语义）。
    with pytest.raises(DomainError) as exc:
        service.create_session(
            "p1",
            preview["agent_session_egress_preview_id"],
            preview["payload_sha256"],
            _Jobs(db),
        )
    assert exc.value.code == "AGENT_SESSION_EGRESS_EXPIRED"


# ----------------------------------------------------------------------
# 一项目同时仅一个 active 会话
# ----------------------------------------------------------------------


async def test_session_rejects_second_active(tmp_path: Path) -> None:
    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(10), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    _start_session(db, service, state)
    provider = service.providers.list()[0]
    preview2 = service.prepare(
        "p1",
        {
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "provider_config_id": provider["provider_config_id"],
            "instruction": "另一个指令",
        },
    )
    with pytest.raises(DomainError) as exc:
        service.create_session(
            "p1",
            preview2["agent_session_egress_preview_id"],
            preview2["payload_sha256"],
            _Jobs(db),
        )
    assert exc.value.code == "AGENT_SESSION_ALREADY_ACTIVE"


# ----------------------------------------------------------------------
# 基线漂移：会话执行中外部并发修改 → 中止
# ----------------------------------------------------------------------


async def test_session_aborts_on_external_base_drift(tmp_path: Path) -> None:
    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(10), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    session_id, jobs = _start_session(db, service, state)
    # 模拟外部并发修改：用户在会话启动后手动改时间线。
    with db.connection() as conn:
        conn.execute("BEGIN")
        timelines.create_revision_from_document(
            conn,
            "p1",
            state["current_revision"]["timeline_revision_id"],
            state["current_revision"]["document"],
            "external user edit",
        )
        conn.execute("COMMIT")
    with pytest.raises(DomainError) as exc:
        await _run(db, service, jobs)
    assert exc.value.code == "AGENT_SESSION_BASE_DRIFT"
    assert _session_row(db, session_id)["status"] == "failed"


# ----------------------------------------------------------------------
# v20 schema：表齐 + 不可变触发器 + consent 单次消费触发器
# ----------------------------------------------------------------------


def test_v20_schema_tables_and_triggers(tmp_path: Path) -> None:
    timelines, db = _service(tmp_path)
    state = _create(timelines, {"kind": "full_asset", "asset_id": "v1"})
    revision_id = state["current_revision"]["timeline_revision_id"]
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "created_at,updated_at) VALUES ('pc','openai_compatible_text','P',"
            "'https://provider.example','m',1,'now','now')"
        )
        versions = [
            row[0]
            for row in conn.execute("SELECT version FROM schema_migrations")
        ]
        assert "v20" in versions and len(versions) == 25
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {
            "agent_sessions",
            "agent_steps",
            "agent_session_egress_previews",
            "agent_session_egress_consents",
        } <= tables
        conn.execute(
            "INSERT INTO agent_session_egress_previews(id,project_id,provider_config_id,"
            "base_revision_id,base_document_sha256,provider_snapshot_json,"
            "provider_config_sha256,payload_sha256,stats_json,expires_at,created_at) "
            "VALUES ('pv','p1','pc',?,'sha256:d','{}','sha256:s','sha256:x','{}','2999-01-01T00:00:00Z','now')",
            (revision_id,),
        )
        conn.execute(
            "INSERT INTO agent_session_egress_consents(id,egress_preview_id,payload_sha256,created_at) "
            "VALUES ('c1','pv','sha256:x','now')"
        )
        conn.execute(
            "UPDATE agent_session_egress_consents SET consumed_at='now' WHERE id='c1'"
        )
        # consent 只允许消费一次：二次 UPDATE 被触发器拒绝。
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE agent_session_egress_consents SET consumed_at='now2' WHERE id='c1'"
            )
        # steps 不可变。
        conn.execute(
            "INSERT INTO agent_sessions(id,project_id,egress_preview_id,egress_consent_id,"
            "provider_config_id,base_revision_id,base_document_sha256,instruction,max_steps,"
            "status,payload_sha256,created_at,updated_at) VALUES "
            "('as1','p1','pv','c1','pc',?,'sha256:d','i',1,'queued','sha256:x','now','now')",
            (revision_id,),
        )
        conn.execute(
            "INSERT INTO agent_steps(id,session_id,ordinal,status,stage,input_sha256,created_at) "
            "VALUES ('st1','as1',1,'succeeded','persisting_step','sha256:x','now')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE agent_steps SET summary='x' WHERE id='st1'")


# ----------------------------------------------------------------------
# 结构化失败提取（AI-1-2 单元级）
# ----------------------------------------------------------------------


def test_structured_failure_extraction(tmp_path: Path) -> None:
    timelines, db = _service(tmp_path)
    state = _create(timelines, {"kind": "full_asset", "asset_id": "v1"})
    document = state["current_revision"]["document"]
    with db.connection() as conn:
        with pytest.raises(DomainError) as exc:
            timelines.apply_in_memory(
                conn, "p1", document,
                [{"op": "remove_clip", "clip_id": "missing"}], ai=True,
            )
    failure = _structured_failure(exc.value)
    assert failure == {
        "reason": "TIMELINE_CLIP_NOT_FOUND",
        "operation_index": 1,
        "op": "remove_clip",
        "field": "operation",
    }


# ----------------------------------------------------------------------
# 阶段 B：会话费用聚合（get_session.token_usage）
# ----------------------------------------------------------------------


async def test_session_reports_token_usage_aggregate(tmp_path: Path) -> None:
    # 两步会话（失败反馈 + 成功）各一次 provider 调用，usage 100+100；
    # get_session 聚合 = total_tokens 200、provider_calls 2。
    class Factory:
        async def generate(self, request: Any, _cancel: Any) -> StructuredTextResult:
            if not hasattr(Factory, "_n"):
                Factory._n = 0
            Factory._n += 1
            if Factory._n == 1:
                return StructuredTextResult(
                    _patch_result([{"op": "remove_clip", "clip_id": "missing"}], "bad"),
                    _usage(100), None,
                )
            return StructuredTextResult(
                _patch_result(
                    [{"op": "set_layout", "clip_id": _CLIP["id"], "layout": "fit"}], "ok"
                ),
                _usage(100), None,
            )

    db, service, timelines = _agent_service(tmp_path, Factory)
    state = _seed_timeline(timelines)
    session_id, jobs = _start_session(db, service, state)
    await _run(db, service, jobs)
    detail = service.get_session(session_id)
    usage = detail["token_usage"]
    assert usage["total_tokens"] == 200
    assert usage["provider_calls"] == 2
    # 配置单价缺省（0）→ 估算成本 0；字段恒存在（数值型聚合）。
    assert usage["estimated_cost"] == 0.0


