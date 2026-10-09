from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest

from aivs_core.captions_provider_egress import CaptionsProviderEgressService
from aivs_core.database import Database, json_dumps
from aivs_core.planning import sha256
from aivs_core.providers import ProviderSecretVault
from aivs_core.projects import DomainError
from aivs_core.timeline import TimelineService

# v34 起 captions capability 有状态不变量：supported 必须携带已选适配器、
# probe 协议版本、测试时间与 probe 哈希（失败码必须为空）。测试 seed 必须
# 满足该不变量，否则触发器 ABORT——这正是 A4 验收项要保护的行为。
CAPABLE_SQL = (
    "UPDATE provider_configs SET captions_provider_capability_status='supported',"
    "captions_provider_response_adapter_id='openai_chat_completions_json_schema_v1',"
    "captions_provider_probe_protocol_version='1',"
    "captions_provider_capability_tested_at='n',"
    "captions_provider_capability_failure_code=NULL,"
    "captions_provider_capability_probe_sha256='sha256:" + "c" * 64 + "' WHERE id=?"
)
CAPABLE_FIELDS = {
    "captions_provider_capability_status": "supported",
    "captions_provider_response_adapter_id": "openai_chat_completions_json_schema_v1",
    "captions_provider_probe_protocol_version": "1",
    "captions_provider_capability_tested_at": "n",
    "captions_provider_capability_failure_code": None,
    "captions_provider_capability_probe_sha256": "sha256:" + "c" * 64,
}


def test_v30_captions_provider_egress_schema_is_present(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"captions_provider_egress_previews", "captions_provider_egress_consents", "captions_provider_generations", "captions_provider_results", "captions_provider_proposals"} <= names
        assert conn.execute("SELECT version FROM schema_migrations WHERE version='v32'").fetchone() is not None
        columns = {row[1] for row in conn.execute("PRAGMA table_info(captions_provider_egress_previews)")}
        assert "payload_json" in columns
        provider_columns = {row[1] for row in conn.execute("PRAGMA table_info(provider_configs)")}
        assert {"captions_provider_capability_status", "captions_provider_capability_tested_at"} <= provider_columns
        # v34：适配器阶梯持久化四列（ADAPTER_DESIGN_GATE 2026-10-05）
        assert {
            "captions_provider_response_adapter_id",
            "captions_provider_probe_protocol_version",
            "captions_provider_capability_failure_code",
            "captions_provider_capability_probe_sha256",
        } <= provider_columns
        assert conn.execute("SELECT version FROM schema_migrations WHERE version='v34'").fetchone() is not None


def test_claim_for_runner_consumes_consent_once_and_returns_durable_payload(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    provider_id, project_id, revision_id = "provider_1", "project_1", "revision_1"
    snapshot = {"provider_config_id": provider_id, "display_name": "P", "base_url": "https://provider.test", "model": "m", "enabled": True, "credential_status": "configured"}
    payload = {"schema_version": 1, "recipe_id": "captions_provider_v1", "language": "en", "preset_id": "default-bottom", "max_chars_per_caption": 24, "segments": [{"segment_id": "s1", "ordinal": 0, "text": "hello", "duration_bucket": "short"}]}
    with db.connection() as conn:
        conn.execute("INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at,current_timeline_revision_id) VALUES (?,?,?,?,?,?,?,?,?,?)", (project_id, "p", "active", "{}", "r", "r", "n", "n", "n", revision_id))
        conn.execute("INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)", (revision_id, project_id, 1, "{}", "sha256:" + "b" * 64, "", "test", "n"))
        conn.execute("INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", (provider_id, "openai_compatible_text", "P", "https://provider.test", "m", 1, "n", "n"))
        conn.execute(CAPABLE_SQL, (provider_id,))
        preview_id, consent_id, generation_id = "cp_1", "cc_1", "cg_1"
        conn.execute("INSERT INTO captions_provider_egress_previews(id,project_id,provider_config_id,base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,payload_sha256,stats_json,expires_at,created_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (preview_id, project_id, provider_id, revision_id, "sha256:" + "b" * 64, json_dumps(snapshot), sha256(snapshot), sha256(payload), "{}", "2999-01-01T00:00:00Z", "n", json_dumps(payload)))
        conn.execute("INSERT INTO captions_provider_egress_consents VALUES (?,?,?,?,?)", (consent_id, preview_id, sha256(payload), "n", None))
        conn.execute("INSERT INTO captions_provider_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (generation_id, project_id, preview_id, consent_id, provider_id, revision_id, "sha256:" + "b" * 64, "queued", sha256(payload), "n", "n", None))
    class FakeProviders:
        def get(self, _id: str) -> dict:
            return {**snapshot, **CAPABLE_FIELDS}
    service = CaptionsProviderEgressService(db, FakeProviders(), ProviderSecretVault(), TimelineService(db), object())  # type: ignore[arg-type]
    claimed = service.claim_for_runner(project_id, generation_id)
    assert claimed["payload"] == payload
    with db.connection() as conn:
        assert conn.execute("SELECT status FROM captions_provider_generations WHERE id=?", (generation_id,)).fetchone()[0] == "running"
        assert conn.execute("SELECT consumed_at FROM captions_provider_egress_consents WHERE id=?", (consent_id,)).fetchone()[0] is not None
    with pytest.raises(Exception, match="不可领取"):
        service.claim_for_runner(project_id, generation_id)


def _seed_generation(db: Database, project_id: str = "project_1", generation_id: str = "generation_1", proposal: bool = False) -> None:
    suffix = project_id
    provider_id, revision_id, preview_id, consent_id = (f"provider_{suffix}", f"revision_{suffix}", f"preview_{suffix}", f"consent_{suffix}")
    with db.connection() as conn:
        conn.execute("INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at,current_timeline_revision_id) VALUES (?,?,?,?,?,?,?,?,?,?)", (project_id, "p", "active", "{}", "r", "r", "n", "n", "n", revision_id))
        conn.execute("INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)", (revision_id, project_id, 1, "{}", "sha256:" + "b" * 64, "", "test", "n"))
        conn.execute("INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", (provider_id, "openai_compatible_text", "P", "https://provider.test", "m", 1, "n", "n"))
        conn.execute(CAPABLE_SQL, (provider_id,))
        payload = {"schema_version": 1, "segments": []}
        conn.execute("INSERT INTO captions_provider_egress_previews(id,project_id,provider_config_id,base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,payload_sha256,stats_json,expires_at,created_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (preview_id, project_id, provider_id, revision_id, "sha256:" + "b" * 64, "{}", sha256({}), sha256(payload), "{}", "2999-01-01T00:00:00Z", "n", json_dumps(payload)))
        conn.execute("INSERT INTO captions_provider_egress_consents VALUES (?,?,?,?,?)", (consent_id, preview_id, sha256(payload), "n", None))
        conn.execute("INSERT INTO captions_provider_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (generation_id, project_id, preview_id, consent_id, provider_id, revision_id, "sha256:" + "b" * 64, "succeeded", sha256(payload), "n", "n", "n"))
        if proposal:
            conn.execute("INSERT INTO captions_provider_proposals VALUES (?,?,?,?,?,?,?,?,?,?)", (f"proposal_{project_id}", generation_id, project_id, revision_id, "sha256:" + "b" * 64, json_dumps({"operations": []}), sha256({"operations": []}), "{}", sha256({}), "n"))


def _service(db: Database) -> CaptionsProviderEgressService:
    return CaptionsProviderEgressService(db, object(), ProviderSecretVault(), TimelineService(db), object())  # type: ignore[arg-type]


def test_generation_dto_uses_contract_key(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db"); db.initialize(); _seed_generation(db)
    result = _service(db).get("project_1", "generation_1")
    assert result["captions_provider_generation_id"] == "generation_1"
    assert "id" not in result


def test_get_proposal_for_generation_is_read_only_and_cross_project_safe(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db"); db.initialize(); _seed_generation(db)
    service = _service(db)
    with db.connection() as conn:
        before = conn.execute("SELECT COUNT(*) FROM captions_provider_proposals").fetchone()[0]
        revisions_before = conn.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
    with pytest.raises(DomainError, match="提案不存在"):
        service.get_proposal_for_generation("project_1", "generation_1")
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM captions_provider_proposals").fetchone()[0] == before
    _seed_generation(db, "project_2", "generation_2", proposal=True)
    with db.connection() as conn:
        revisions_before = conn.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
    with pytest.raises(DomainError, match="提案不存在"):
        service.get_proposal_for_generation("project_1", "generation_2")
    result = service.get_proposal_for_generation("project_2", "generation_2")
    assert result["captions_provider_proposal_id"] == "proposal_project_2"
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == revisions_before


def test_proposal_immutable_trigger_rejects_actual_update(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db"); db.initialize(); _seed_generation(db, proposal=True)
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with db.connection() as conn:
            conn.execute("UPDATE captions_provider_proposals SET patch_json=? WHERE id=?", ("{}", "proposal_project_1"))


def test_captions_provider_immutability_triggers_are_registered(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        triggers = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
        assert "captions_provider_previews_no_update" in triggers
        assert "captions_provider_consents_only_consume" in triggers


# ---------------------------------------------------------------------------
# ADAPTER_DESIGN_GATE 2026-10-05：适配器阶梯、失败码落库与状态不变量
# ---------------------------------------------------------------------------


class _ScriptedProvider:
    """Returns a canned outcome per adapter id; records the adapter order tried."""

    def __init__(self, outcomes: dict[str, list[str]], calls: list[str]) -> None:
        self.outcomes, self.calls = outcomes, calls

    async def generate(self, request, cancel_event):  # type: ignore[no-untyped-def]
        adapter = request.response_adapter_id
        self.calls.append(adapter)
        queue = self.outcomes.get(adapter, [])
        outcome = queue.pop(0) if queue else "PROVIDER_CONTENT_REJECTED"
        from aivs_core.providers import ProviderError, StructuredTextResult

        if outcome == "ok":
            return StructuredTextResult(
                {
                    "items": [
                        {"segment_refs": ["probe_segment"], "text": "probe", "confidence": None}
                    ],
                    "warnings": [],
                },
                None,
                None,
            )
        if outcome == "schema_invalid":
            # HTTP 200 + 合法 envelope，但内容不合 schema：validator 抛 ValueError
            return StructuredTextResult({"items": [], "warnings": []}, None, None)
        raise ProviderError(outcome, outcome)


def _probe_service(db: Database, outcomes: dict[str, list[str]], calls: list[str]):
    provider = {"provider_config_id": "provider_1", "enabled": True, "base_url": "https://p.test", "model": "m"}
    vault = ProviderSecretVault()
    vault.set("provider_1", "secret")
    service = CaptionsProviderEgressService(
        db, object(), vault, TimelineService(db), object(),
        provider_factory=lambda: _ScriptedProvider(outcomes, calls),
    )
    service.providers = type("P", (), {"get": staticmethod(lambda _id: provider)})()  # type: ignore[assignment]
    return service


def _seed_provider(db: Database, provider_id: str = "provider_1") -> None:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (provider_id, "openai_compatible_text", "P", "https://p.test", "m", 1, "n", "n"),
        )


def test_capability_probe_walks_ladder_and_persists_chosen_adapter(tmp_path: Path) -> None:
    """A1/A2：首档确定性失败 → 次档成功 → 落库为次档，失败码清空、哈希非空。"""
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_provider(db)
    calls: list[str] = []
    service = _probe_service(
        db,
        {
            "openai_chat_completions_json_schema_v1": ["PROVIDER_CONTENT_REJECTED"],
            "openai_chat_completions_captionscript_v1": ["ok"],
        },
        calls,
    )
    result = asyncio.run(service.test_capability("provider_1"))
    assert calls == [
        "openai_chat_completions_json_schema_v1",
        "openai_chat_completions_captionscript_v1",
    ]
    assert result["captions_provider_capability_status"] == "supported"
    assert result["captions_provider_response_adapter_id"] == "openai_chat_completions_captionscript_v1"
    with db.connection() as conn:
        row = conn.execute(
            "SELECT captions_provider_response_adapter_id,captions_provider_probe_protocol_version,"
            "captions_provider_capability_failure_code,captions_provider_capability_probe_sha256"
            " FROM provider_configs WHERE id='provider_1'"
        ).fetchone()
    assert row[0] == "openai_chat_completions_captionscript_v1"
    assert row[1] == "1"
    assert row[2] is None
    assert row[3]


def test_capability_probe_retries_retryable_but_not_schema_failures(tmp_path: Path) -> None:
    """A3：网络类错误重试 3 次；schema 类确定性失败立即换档，不重试。"""
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_provider(db)
    calls: list[str] = []
    service = _probe_service(
        db,
        {
            # 网络类：两次失败后第三次成功 → 证明重试生效
            "openai_chat_completions_json_schema_v1": [
                "PROVIDER_NETWORK_ERROR",
                "PROVIDER_NETWORK_ERROR",
                "ok",
            ],
        },
        calls,
    )
    result = asyncio.run(service.test_capability("provider_1"))
    assert calls == ["openai_chat_completions_json_schema_v1"] * 3
    assert result["captions_provider_capability_status"] == "supported"

    db2 = Database(tmp_path / "b.db")
    db2.initialize()
    _seed_provider(db2)
    calls2: list[str] = []
    service2 = _probe_service(
        db2,
        {
            "openai_chat_completions_json_schema_v1": ["PROVIDER_CONTENT_REJECTED"],
            "openai_chat_completions_captionscript_v1": ["PROVIDER_INVALID_RESPONSE"],
        },
        calls2,
    )
    result2 = asyncio.run(service2.test_capability("provider_1"))
    # 每档只调用一次：确定性失败不重试
    assert calls2 == [
        "openai_chat_completions_json_schema_v1",
        "openai_chat_completions_captionscript_v1",
    ]
    assert result2["captions_provider_capability_status"] == "unsupported"
    assert result2["captions_provider_response_adapter_id"] is None
    assert result2["captions_provider_capability_failure_code"] == "PROVIDER_INVALID_RESPONSE"
    assert result2["captions_provider_capability_probe_sha256"]


def test_capability_probe_treats_token_exhaustion_as_deterministic(tmp_path: Path) -> None:
    """P43/R1：token 预算耗尽码不重试（每档恰 1 次即换档），失败码原样落库。

    若该码被误归网络类：两档各重试 3 次 = 6 次往返全部耗尽，且落库码
    退化为 PROVIDER_INVALID_RESPONSE，诊断面消失。
    """
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_provider(db)
    calls: list[str] = []
    service = _probe_service(
        db,
        {
            "openai_chat_completions_json_schema_v1": ["PROVIDER_TOKEN_BUDGET_EXHAUSTED"],
            "openai_chat_completions_captionscript_v1": ["PROVIDER_TOKEN_BUDGET_EXHAUSTED"],
        },
        calls,
    )
    result = asyncio.run(service.test_capability("provider_1"))
    # 每档只调用一次：确定性失败立即换档，不重试
    assert calls == [
        "openai_chat_completions_json_schema_v1",
        "openai_chat_completions_captionscript_v1",
    ]
    assert result["captions_provider_capability_status"] == "unsupported"
    assert (
        result["captions_provider_capability_failure_code"]
        == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"
    )
    with db.connection() as conn:
        row = conn.execute(
            "SELECT captions_provider_capability_failure_code FROM provider_configs WHERE id='provider_1'"
        ).fetchone()
    assert row[0] == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"


def test_capability_probe_advances_ladder_on_schema_invalid_output(tmp_path: Path) -> None:
    """首档 HTTP 200 但内容不合 schema（validator 抛 ValueError）也必须换档。

    回归防护：内层循环若只捕获 ProviderError，ValueError 会穿透整个阶梯，
    使第二档永远得不到尝试机会。
    """
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_provider(db)
    calls: list[str] = []
    service = _probe_service(
        db,
        {
            "openai_chat_completions_json_schema_v1": ["schema_invalid"],
            "openai_chat_completions_captionscript_v1": ["ok"],
        },
        calls,
    )
    result = asyncio.run(service.test_capability("provider_1"))
    assert calls == [
        "openai_chat_completions_json_schema_v1",
        "openai_chat_completions_captionscript_v1",
    ], "首档 schema 失败后必须继续尝试第二档"
    assert result["captions_provider_capability_status"] == "supported"
    assert result["captions_provider_response_adapter_id"] == "openai_chat_completions_captionscript_v1"


@pytest.mark.parametrize(
    "sql",
    [
        # supported 但缺适配器
        "UPDATE provider_configs SET captions_provider_capability_status='supported',"
        "captions_provider_probe_protocol_version='1',captions_provider_capability_tested_at='n',"
        "captions_provider_capability_probe_sha256='sha256:x' WHERE id='provider_1'",
        # supported 但适配器不在白名单
        "UPDATE provider_configs SET captions_provider_capability_status='supported',"
        "captions_provider_response_adapter_id='openai_responses_json_schema_v1',"
        "captions_provider_probe_protocol_version='1',captions_provider_capability_tested_at='n',"
        "captions_provider_capability_probe_sha256='sha256:x' WHERE id='provider_1'",
        # supported 但失败码非空
        "UPDATE provider_configs SET captions_provider_capability_status='supported',"
        "captions_provider_response_adapter_id='openai_chat_completions_json_schema_v1',"
        "captions_provider_probe_protocol_version='1',captions_provider_capability_tested_at='n',"
        "captions_provider_capability_failure_code='X',"
        "captions_provider_capability_probe_sha256='sha256:x' WHERE id='provider_1'",
        # unsupported 但携带适配器
        "UPDATE provider_configs SET captions_provider_capability_status='unsupported',"
        "captions_provider_response_adapter_id='openai_chat_completions_json_schema_v1',"
        "captions_provider_capability_tested_at='n',captions_provider_capability_failure_code='X',"
        "captions_provider_capability_probe_sha256='sha256:x' WHERE id='provider_1'",
        # unsupported 但缺失败码
        "UPDATE provider_configs SET captions_provider_capability_status='unsupported',"
        "captions_provider_capability_tested_at='n',"
        "captions_provider_capability_probe_sha256='sha256:x' WHERE id='provider_1'",
        # untested 但残留探测元数据
        "UPDATE provider_configs SET captions_provider_capability_tested_at='n' WHERE id='provider_1'",
    ],
)
def test_captions_capability_invariant_trigger_rejects_invalid_states(
    tmp_path: Path, sql: str
) -> None:
    """A4：数据库触发器强制状态不变量，非法组合一律 ABORT。"""
    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_provider(db)
    with pytest.raises(sqlite3.IntegrityError, match="invalid captions capability state"):
        with db.connection() as conn:
            conn.execute(sql)


@pytest.mark.parametrize("legacy_status", ["supported", "unsupported", "untested"])
def test_v34_resets_legacy_captions_capability_rows(
    tmp_path: Path, legacy_status: str
) -> None:
    """R4：改造前的 supported/unsupported 语义不可信 → 迁移重置为 untested。

    实际执行 V34_SQL（而非仅匹配文本），断言旧行被重置且新列可写。
    """
    import sqlite3 as _sqlite3

    from aivs_core.database import MIGRATIONS, V34_SQL, _statements

    db_path = tmp_path / f"{legacy_status}.db"
    conn = _sqlite3.connect(db_path)
    # v30 形状：status + tested_at 已存在（改造前的列集合）
    conn.executescript(V1_MINIMAL)
    conn.execute(
        "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,created_at,updated_at)"
        " VALUES ('provider_1','openai_compatible_text','P','https://p.test','m',1,'n','n')"
    )
    conn.execute(
        "UPDATE provider_configs SET captions_provider_capability_status=?,"
        "captions_provider_capability_tested_at=? WHERE id='provider_1'",
        (legacy_status, "n" if legacy_status != "untested" else None),
    )
    # 执行真实的 v34 迁移语句（加列、触发器与重置 UPDATE）
    for statement in _statements(V34_SQL):
        conn.execute(statement)
    row = conn.execute(
        "SELECT captions_provider_capability_status,"
        "captions_provider_capability_tested_at,"
        "captions_provider_response_adapter_id,"
        "captions_provider_probe_protocol_version,"
        "captions_provider_capability_failure_code,"
        "captions_provider_capability_probe_sha256"
        " FROM provider_configs WHERE id='provider_1'"
    ).fetchone()
    conn.commit()
    conn.close()
    assert row == ("untested", None, None, None, None, None), (
        f"旧语义 {legacy_status!r} 必须被重置为 untested 且元数据清空"
    )
    assert max(int(v[1:]) for v in MIGRATIONS) >= 34


V1_MINIMAL = """
CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
  base_url TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  captions_provider_capability_status TEXT NOT NULL DEFAULT 'untested',
  captions_provider_capability_tested_at TEXT NULL
);
"""


# ---------------------------------------------------------------------------
# 真实 runner 接线（Slice 4）：create 必须产出可执行 job + invocation
# ---------------------------------------------------------------------------


def _seed_ready_generation(
    db: Database,
    *,
    project_id: str = "project_1",
    generation_id: str = "generation_1",
    status: str = "queued",
    adapter: str | None = "openai_chat_completions_json_schema_v1",
) -> None:
    """Seed a project/revision/provider/preview/consent/generation ready to run."""
    provider_id, revision_id = f"provider_{project_id}", f"revision_{project_id}"
    preview_id, consent_id = f"preview_{project_id}", f"consent_{project_id}"
    payload = {
        "schema_version": 1,
        "recipe_id": "captions_provider_v1",
        "language": "en",
        "preset_id": "default-bottom",
        "max_chars_per_caption": 24,
        "segments": [{"segment_id": "s1", "ordinal": 0, "text": "hello", "duration_bucket": "short"}],
    }
    snapshot = {
        "provider_config_id": provider_id,
        "display_name": "P",
        "base_url": "https://provider.test",
        "model": "m",
        "enabled": True,
        "credential_status": "configured",
    }
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at,current_timeline_revision_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "p", "active", "{}", "r", "r", "n", "n", "n", revision_id),
        )
        conn.execute(
            "INSERT INTO timeline_revisions(id,project_id,schema_version,document_json,"
            "document_sha256,summary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (revision_id, project_id, 1, "{}", "sha256:" + "b" * 64, "", "test", "n"),
        )
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (provider_id, "openai_compatible_text", "P", "https://provider.test", "m", 1, "n", "n"),
        )
        conn.execute(
            "UPDATE provider_configs SET captions_provider_capability_status='supported',"
            "captions_provider_response_adapter_id=?,"
            "captions_provider_probe_protocol_version='1',"
            "captions_provider_capability_tested_at='n',"
            "captions_provider_capability_failure_code=NULL,"
            "captions_provider_capability_probe_sha256='sha256:" + "c" * 64 + "'"
            " WHERE id=?",
            (adapter, provider_id),
        )
        conn.execute(
            "INSERT INTO captions_provider_egress_previews(id,project_id,provider_config_id,"
            "base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,"
            "payload_sha256,stats_json,expires_at,created_at,payload_json)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (preview_id, project_id, provider_id, revision_id, "sha256:" + "b" * 64,
             json_dumps(snapshot), sha256(snapshot), sha256(payload), "{}",
             "2999-01-01T00:00:00Z", "n", json_dumps(payload)),
        )
        conn.execute(
            "INSERT INTO captions_provider_egress_consents VALUES (?,?,?,?,?)",
            (consent_id, preview_id, sha256(payload), "n", None),
        )
        conn.execute(
            "INSERT INTO captions_provider_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (generation_id, project_id, preview_id, consent_id, provider_id, revision_id,
             "sha256:" + "b" * 64, status, sha256(payload), "n", "n", None),
        )


class _FakeJobs:
    """Minimal stand-in for JobService.insert_captions_provider_job."""

    def __init__(self) -> None:
        self.inserted: list[dict[str, Any]] = []

    def insert_captions_provider_job(self, db, job_id, now, project_id, generation_id, invocation_id, payload_sha256):  # type: ignore[no-untyped-def]
        self.inserted.append(
            {
                "job_id": job_id,
                "project_id": project_id,
                "generation_id": generation_id,
                "invocation_id": invocation_id,
            }
        )
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "captions_provider_generation_id,provider_invocation_id,resource_class,attempt,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, project_id, "captions_provider_generation", "captions_provider_generation",
             "queued", "queued", 0, "{}", generation_id, invocation_id, "network", 1, now, now),
        )


def test_create_wires_invocation_and_job_so_generation_is_actually_executable(
    tmp_path: Path,
) -> None:
    """回归防护：create 之后必须有可被 JobService 拾取的 job（否则永远 queued）。

    Slice 2/3 的缺口正是"create 之后无人执行"——run_mock 是唯一执行者且无引用。
    """
    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_ready_generation(db, status="queued")
    jobs = _FakeJobs()
    service = _service(db)
    service.providers = _Repo(db, "provider_project_1")  # type: ignore[assignment]
    service.vault.set("provider_project_1", "secret")
    with db.connection() as conn:
        payload_sha = conn.execute(
            "SELECT payload_sha256 FROM captions_provider_egress_previews WHERE id='preview_project_1'"
        ).fetchone()[0]
    result = service.create("project_1", "preview_project_1", payload_sha, jobs)
    assert result["status"] == "queued"
    assert len(jobs.inserted) == 1
    with db.connection() as conn:
        job = conn.execute(
            "SELECT kind,status,captions_provider_generation_id,provider_invocation_id"
            " FROM jobs WHERE captions_provider_generation_id=?",
            (result["captions_provider_generation_id"],),
        ).fetchone()
        invocation = conn.execute(
            "SELECT capability,status FROM provider_invocations"
            " WHERE captions_provider_generation_id=?",
            (result["captions_provider_generation_id"],),
        ).fetchone()
    assert job is not None and job["kind"] == "captions_provider_generation"
    assert job["status"] == "queued"
    assert invocation is not None
    assert invocation["capability"] == "captions_provider_generation"
    assert invocation["status"] == "queued"


class _Repo:
    def __init__(self, db: Database, provider_id: str) -> None:
        self.db, self.provider_id = db, provider_id

    def get(self, _id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            row = conn.execute(
                "SELECT * FROM provider_configs WHERE id=?", (self.provider_id,)
            ).fetchone()
        return {**dict(row), "provider_config_id": row["id"], "credential_status": "configured"}


class _RunnerProvider:
    """Returns a canned captionscript/JSON value or raises a given error code."""

    def __init__(self, value: Any = None, code: str | None = None) -> None:
        self.value, self.code = value, code
        self.seen: list[Any] = []

    async def generate(self, request, cancel_event):  # type: ignore[no-untyped-def]
        self.seen.append(request)
        from aivs_core.providers import ProviderError, StructuredTextResult

        if self.code:
            raise ProviderError(self.code, self.code)
        return StructuredTextResult(self.value, {"total_tokens": 7}, "req-1")


def _runner_service(db: Database, provider: Any) -> CaptionsProviderEgressService:
    service = CaptionsProviderEgressService(
        db, _Repo(db, "provider_project_1"), ProviderSecretVault(), TimelineService(db),
        object(), provider_factory=lambda: provider,
    )
    service.vault.set("provider_project_1", "secret")
    return service


def _job_row(db: Database, generation_id: str) -> Any:
    with db.connection() as conn:
        return conn.execute(
            "SELECT * FROM jobs WHERE captions_provider_generation_id=?", (generation_id,)
        ).fetchone()


def test_run_generation_persists_normalized_result_and_invocation(tmp_path: Path) -> None:
    """真实 runner：成功路径落库规范化结果、置 succeeded、写 invocation 审计。"""
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_ready_generation(db, status="queued")
    jobs = _FakeJobs()
    svc = _runner_service(db, None)
    svc.providers = _Repo(db, "provider_project_1")  # type: ignore[assignment]
    with db.connection() as conn:
        payload_sha = conn.execute(
            "SELECT payload_sha256 FROM captions_provider_egress_previews WHERE id='preview_project_1'"
        ).fetchone()[0]
    created = svc.create("project_1", "preview_project_1", payload_sha, jobs)
    gid = created["captions_provider_generation_id"]
    provider = _RunnerProvider(
        {"items": [{"segment_refs": ["s1"], "text": "hi", "confidence": None}], "warnings": []}
    )
    svc.provider_factory = lambda: provider
    row = _job_row(db, gid)
    result = asyncio.run(svc.run_generation(row, asyncio.Event(), lambda _: None, lambda _: None))
    assert result["status"] == "succeeded"
    assert provider.seen[0].response_adapter_id == "openai_chat_completions_json_schema_v1"
    with db.connection() as conn:
        gen = conn.execute(
            "SELECT status FROM captions_provider_generations WHERE id=?", (gid,)
        ).fetchone()[0]
        stored = conn.execute(
            "SELECT output_json FROM captions_provider_results WHERE generation_id=?", (gid,)
        ).fetchone()[0]
        inv = conn.execute(
            "SELECT status,provider_may_have_processed FROM provider_invocations"
            " WHERE captions_provider_generation_id=?", (gid,)
        ).fetchone()
    assert gen == "succeeded"
    assert json.loads(stored)["items"][0]["text"] == "hi"
    assert inv["status"] == "succeeded"


def test_run_generation_fails_closed_without_leaking_raw_provider_output(
    tmp_path: Path,
) -> None:
    """失败路径：generation/invocation 归档 failed，且不持久化 raw Provider 正文。"""
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_ready_generation(db, status="queued")
    jobs = _FakeJobs()
    svc = _runner_service(db, None)
    svc.providers = _Repo(db, "provider_project_1")  # type: ignore[assignment]
    with db.connection() as conn:
        payload_sha = conn.execute(
            "SELECT payload_sha256 FROM captions_provider_egress_previews WHERE id='preview_project_1'"
        ).fetchone()[0]
    gid = svc.create("project_1", "preview_project_1", payload_sha, jobs)[
        "captions_provider_generation_id"
    ]
    sentinel = "RAW_PROVIDER_TEXT_SENTINEL"
    svc.provider_factory = lambda: _RunnerProvider(
        {"items": [{"segment_refs": ["s1"], "text": sentinel * 100, "confidence": None}], "warnings": []}
    )
    row = _job_row(db, gid)
    with pytest.raises(Exception):
        asyncio.run(svc.run_generation(row, asyncio.Event(), lambda _: None, lambda _: None))
    with db.connection() as conn:
        gen = conn.execute(
            "SELECT status FROM captions_provider_generations WHERE id=?", (gid,)
        ).fetchone()[0]
        inv = conn.execute(
            "SELECT status,provider_may_have_processed,error_code FROM provider_invocations"
            " WHERE captions_provider_generation_id=?", (gid,)
        ).fetchone()
        results = conn.execute(
            "SELECT COUNT(*) FROM captions_provider_results WHERE generation_id=?", (gid,)
        ).fetchone()[0]
        everything = " ".join(
            str(r[0]) for r in conn.execute(
                "SELECT output_json FROM captions_provider_results"
            ).fetchall()
        )
    assert gen == "failed"
    assert inv["status"] == "failed"
    assert inv["provider_may_have_processed"] == 1
    assert results == 0, "失败时不得写入结果行"
    assert sentinel not in everything


def test_run_generation_refuses_unprobed_adapter(tmp_path: Path) -> None:
    """fail-closed：能力表里的适配器不合法时绝不发起调用。"""
    import asyncio

    db = Database(tmp_path / "app.db")
    db.initialize()
    # adapter 置空 → 触发 supported 不变量，故用 unsupported 语义的库
    _seed_ready_generation(db, status="queued")
    jobs = _FakeJobs()
    svc = _runner_service(db, None)
    svc.providers = _Repo(db, "provider_project_1")  # type: ignore[assignment]
    with db.connection() as conn:
        payload_sha = conn.execute(
            "SELECT payload_sha256 FROM captions_provider_egress_previews WHERE id='preview_project_1'"
        ).fetchone()[0]
    gid = svc.create("project_1", "preview_project_1", payload_sha, jobs)[
        "captions_provider_generation_id"
    ]
    provider = _RunnerProvider(
        {"items": [{"segment_refs": ["s1"], "text": "hi", "confidence": None}], "warnings": []}
    )
    svc.provider_factory = lambda: provider
    # 模拟探测结果被清空/篡改：直接改 provider 仓库返回
    svc.providers = type(  # type: ignore[assignment]
        "P", (), {"get": staticmethod(lambda _id: {**_Repo(db, "provider_project_1").get(_id), "captions_provider_response_adapter_id": None})}
    )()
    row = _job_row(db, gid)
    with pytest.raises(Exception):
        asyncio.run(svc.run_generation(row, asyncio.Event(), lambda _: None, lambda _: None))
    assert provider.seen == [], "未探测适配器时不得调用 Provider"


@pytest.mark.asyncio
async def test_job_service_dispatches_captions_generation_end_to_end(tmp_path: Path) -> None:
    """真实 JobService 分派：证明 create 产出的 job 确实会被执行并置 succeeded。

    这是"接线是否真的通了"的端到端证据——不经过任何 fake job 层。
    """
    from aivs_core.jobs import JobService

    db = Database(tmp_path / "app.db")
    db.initialize()
    _seed_ready_generation(db, status="queued")
    svc = _runner_service(db, None)
    svc.providers = _Repo(db, "provider_project_1")  # type: ignore[assignment]
    provider = _RunnerProvider(
        {"items": [{"segment_refs": ["s1"], "text": "hi", "confidence": None}], "warnings": []}
    )
    svc.provider_factory = lambda: provider

    jobs = JobService(
        db,
        tmp_path,
        Path("missing-ffmpeg"),
        object(),
        object(),
        lambda _: asyncio.sleep(0),
        captions_provider_runner=svc.run_generation,
    )
    with db.connection() as conn:
        payload_sha = conn.execute(
            "SELECT payload_sha256 FROM captions_provider_egress_previews WHERE id='preview_project_1'"
        ).fetchone()[0]
    gid = svc.create("project_1", "preview_project_1", payload_sha, jobs)[
        "captions_provider_generation_id"
    ]
    with db.connection() as conn:
        job_id = conn.execute(
            "SELECT id FROM jobs WHERE captions_provider_generation_id=?", (gid,)
        ).fetchone()[0]
    await jobs._run(job_id)
    with db.connection() as conn:
        job = conn.execute(
            "SELECT status,result_json FROM jobs WHERE id=?", (job_id,)
        ).fetchone()
        gen = conn.execute(
            "SELECT status FROM captions_provider_generations WHERE id=?", (gid,)
        ).fetchone()[0]
    assert job["status"] == "succeeded", f"job 未被真实分派执行: {job['status']}"
    assert gen == "succeeded"
    assert provider.seen, "Provider 必须被真实调用"
    assert json.loads(job["result_json"])["status"] == "succeeded"
