from __future__ import annotations  # noqa: I001

import asyncio
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.planning import PlanningService, ProviderRepository, RecipeRegistry, sha256
from aivs_core.projects import DomainError
from aivs_core.providers import ProviderSecretVault
from aivs_core.providers import StructuredTextResult
from aivs_core.timeline import TimelineService


class Jobs:
    def __init__(self) -> None:
        self.created = 0

    def create_candidate_generation(self, *_: object) -> dict[str, str]:
        self.created += 1
        return {"job_id": "candidate-job", "status": "queued"}


def _service(tmp_path: Path) -> tuple[Database, PlanningService, Jobs]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    recipes = RecipeRegistry(Path("resources/recipes"))
    vault = ProviderSecretVault()
    providers = ProviderRepository(db, vault)
    planning = PlanningService(db, recipes, providers, vault, TimelineService(db))
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) "  # noqa: E501
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        for index in (1, 2):
            conn.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,availability,media_info_json,created_at,updated_at) "  # noqa: E501
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"a{index}",
                    "p1",
                    "video",
                    "external",
                    f"hidden-{index}.mp4",
                    f"fp{index}",
                    1,
                    "available",
                    '{"duration_us":30000000}',
                    "now",
                    "now",
                ),
            )
            conn.execute(
                "INSERT INTO transcripts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"t{index}",
                    f"a{index}",
                    "ready",
                    "zh",
                    "local",
                    "m",
                    "r",
                    f"fp{index}",
                    30_000_000,
                    "now",
                    "now",
                ),
            )
            for segment in range(2):
                conn.execute(
                    "INSERT INTO transcript_segments VALUES (?,?,?,?,?,?,?)",
                    (
                        f"s{index}{segment}",
                        f"t{index}",
                        segment,
                        segment * 15_000_000,
                        (segment + 1) * 15_000_000,
                        f"主题 片段 {index}-{segment}",
                        0.9,
                    ),
                )
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
    planning.put_brief(
        "p1",
        {
            "schema_version": 1,
            "topic": "主题",
            "audience": "受众",
            "target_platform": "generic_vertical",
            "target_duration_us": 60_000_000,
            "narrative_goal": "叙事目标",
            "style_notes": "",
            "must_keep": [],
            "forbidden": [],
            "original_audio_policy": "preserve",
            "caption_policy": "auto_from_transcript",
            "caption_preset_id": "default-bottom",
            "default_layout": "fit",
        },
    )
    return db, planning, Jobs()


def _prepare(planning: PlanningService) -> dict:
    provider = planning.providers.list()[0]
    return planning.prepare(
        "p1",
        {
            "provider_config_id": provider["provider_config_id"],
            "recipe_id": "balanced-narrative-v1",
            "transcript_ids": ["t1", "t2"],
        },
    )


def test_prepare_is_local_canonical_and_keeps_actual_transcript_refs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, planning, _ = _service(tmp_path)
    monkeypatch.setattr(
        "aivs_core.providers.OpenAICompatibleTextProvider.generate",
        lambda *_: (_ for _ in ()).throw(AssertionError("network")),
    )
    first = _prepare(planning)
    second = _prepare(planning)
    assert first["payload_sha256"] == second["payload_sha256"] == sha256(first["payload"])
    assert {segment["transcript_ref"] for segment in first["payload"]["segments"]} == {"t1", "t2"}
    serialized = json_dumps(first)
    assert "hidden-" not in serialized and "fp1" not in serialized


@pytest.mark.parametrize("mutation", ["brief", "provider", "transcript", "asset"])
def test_generation_rechecks_every_egress_input(tmp_path: Path, mutation: str) -> None:
    db, planning, jobs = _service(tmp_path)
    planning.timelines.create(
        "p1",
        {
            "schema_version": 1,
            "source": {"kind": "full_asset", "asset_id": "a1"},
            "default_layout": "fit",
            "caption_preset_id": "default-bottom",
        },
    )
    baseline_id = planning.timelines.get_state("p1")["current_revision"]["timeline_revision_id"]  # noqa: F841
    preview = _prepare(planning)
    with db.connection() as conn:
        if mutation == "brief":
            conn.execute(
                "UPDATE project_briefs SET document_json=replace(document_json,'叙事目标','已改变目标') "  # noqa: E501
                "WHERE project_id='p1'"
            )
        elif mutation == "provider":
            conn.execute(
                "UPDATE provider_configs SET model='different' WHERE id=?",
                (planning.providers.list()[0]["provider_config_id"],),
            )
        elif mutation == "transcript":
            conn.execute("UPDATE transcripts SET status='stale' WHERE id='t1'")
        else:
            conn.execute("UPDATE assets SET availability='changed' WHERE id='a1'")
    with pytest.raises(DomainError):
        planning.create_generation(
            "p1", preview["egress_preview_id"], preview["payload_sha256"], jobs
        )
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM egress_consents").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM candidate_generations").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0] == 0
    assert jobs.created == 0


def test_preview_expiry_and_immutable_tables(tmp_path: Path) -> None:
    db, planning, jobs = _service(tmp_path)
    preview = _prepare(planning)
    with db.connection() as conn:
        conn.execute("DROP TRIGGER egress_previews_no_update")
        conn.execute(
            "UPDATE egress_previews SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
            (preview["egress_preview_id"],),
        )
    with pytest.raises(DomainError, match="过期"):
        planning.create_generation(
            "p1", preview["egress_preview_id"], preview["payload_sha256"], jobs
        )
    with db.connection() as conn:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("UPDATE recipe_snapshots SET recipe_id='changed'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("DELETE FROM egress_previews")


def _valid_provider_result() -> dict:
    clips = [
        {"segment_ids": ["s1", "s3"], "reason": "保留完整主题叙事", "model_score": 0.5},
        {"segment_ids": ["s2", "s4"], "reason": "补充另一来源内容", "model_score": None},
    ]
    return {
        "candidates": [
            {
                "variant": variant,
                "title_suggestion": f"{variant} 标题",
                "summary": "满足时长和引用约束的候选方案",
                "clips": clips,
            }
            for variant in ("balanced", "compact", "bold")
        ]
    }


@pytest.mark.asyncio
async def test_generation_is_atomic_and_adoption_uses_timeline_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db, planning, jobs = _service(tmp_path)
    planning.timelines.create(
        "p1",
        {
            "schema_version": 1,
            "source": {"kind": "full_asset", "asset_id": "a1"},
            "default_layout": "fit",
            "caption_preset_id": "default-bottom",
        },
    )
    baseline_id = planning.timelines.get_state("p1")["current_revision"]["timeline_revision_id"]
    provider_id = planning.providers.list()[0]["provider_config_id"]
    planning.vault.set(provider_id, "SENTINEL_API_KEY")
    preview = _prepare(planning)
    created = planning.create_generation(
        "p1", preview["egress_preview_id"], preview["payload_sha256"], jobs
    )
    generation_id = created["candidate_generation_id"]
    with db.connection() as conn:
        generation = conn.execute(  # noqa: F841
            "SELECT * FROM candidate_generations WHERE id=?", (generation_id,)
        ).fetchone()
        invocation = conn.execute(
            "SELECT id FROM provider_invocations WHERE candidate_generation_id=?", (generation_id,)
        ).fetchone()
    row = {
        "candidate_generation_id": generation_id,
        "provider_invocation_id": invocation["id"],
        "input_json": json_dumps(
            {
                "candidate_generation_id": generation_id,
                "egress_payload_sha256": preview["payload_sha256"],
            }
        ),
    }

    async def successful(*_: object) -> StructuredTextResult:
        return StructuredTextResult(
            _valid_provider_result(),
            {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "request-id",
        )

    monkeypatch.setattr("aivs_core.planning.OpenAICompatibleTextProvider.generate", successful)
    await planning.run_generation(row, asyncio.Event(), lambda _: None, lambda _: None)
    plans = planning.list_candidates("p1")
    assert len(plans) == 3
    assert [plan["variant"] for plan in plans] == ["balanced", "compact", "bold"]
    with db.connection() as conn:
        assert conn.execute("SELECT consumed_at FROM egress_consents").fetchone()[0] is not None
        invocation_audit = conn.execute(
            "SELECT usage_json,estimated_cost,actual_cost,output_sha256,duration_ms "
            "FROM provider_invocations WHERE id=?",
            (invocation["id"],),
        ).fetchone()
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("UPDATE egress_consents SET payload_sha256='changed'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("UPDATE egress_consents SET consumed_at='again'")
        database_text = "\n".join(
            str(row)
            for table in ("provider_configs", "provider_invocations", "candidate_generations")
            for row in conn.execute(f"SELECT * FROM {table}")
        )
    assert "SENTINEL_API_KEY" not in database_text
    assert "SENTINEL_API_KEY" not in json_dumps(planning.providers.list())
    expected_usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    assert json_dumps(expected_usage) == invocation_audit[0]
    assert invocation_audit[1] == pytest.approx(0.00004)
    assert invocation_audit[2] is None
    assert invocation_audit[3].startswith("sha256:")
    assert invocation_audit[4] is not None
    with pytest.raises(DomainError, match="基线"):
        planning.adopt(
            "p1",
            plans[0]["candidate_plan_id"],
            {
                "schema_version": 1,
                "candidate_document_sha256": plans[0]["document_sha256"],
                "base_revision_id": None,
            },
        )
    planning.timelines.save_draft(
        "p1",
        {
            "schema_version": 1,
            "base_revision_id": baseline_id,
            "document": planning.timelines.get_state("p1")["current_revision"]["document"],
        },
    )
    with pytest.raises(DomainError, match="草稿"):
        planning.adopt(
            "p1",
            plans[0]["candidate_plan_id"],
            {
                "schema_version": 1,
                "candidate_document_sha256": plans[0]["document_sha256"],
                "base_revision_id": baseline_id,
            },
        )
    planning.timelines.delete_draft("p1")
    with db.connection() as conn:
        conn.execute("UPDATE assets SET availability='changed' WHERE id='a1'")
    with pytest.raises(DomainError, match="素材"):
        planning.adopt(
            "p1",
            plans[0]["candidate_plan_id"],
            {
                "schema_version": 1,
                "candidate_document_sha256": plans[0]["document_sha256"],
                "base_revision_id": baseline_id,
            },
        )
    with db.connection() as conn:
        conn.execute("UPDATE assets SET availability='available' WHERE id='a1'")
    adopted = planning.adopt(
        "p1",
        plans[0]["candidate_plan_id"],
        {
            "schema_version": 1,
            "candidate_document_sha256": plans[0]["document_sha256"],
            "base_revision_id": baseline_id,
        },
    )
    revision_id = adopted["timeline_revision"]["timeline_revision_id"]
    state = planning.timelines.get_state("p1")
    assert state["current_revision"]["timeline_revision_id"] == revision_id
    undone = planning.timelines.undo("p1", revision_id)
    assert undone["current_revision"]["timeline_revision_id"] == baseline_id
    with pytest.raises(DomainError, match="已被采用"):
        planning.adopt(
            "p1",
            plans[0]["candidate_plan_id"],
            {
                "schema_version": 1,
                "candidate_document_sha256": plans[0]["document_sha256"],
                "base_revision_id": baseline_id,
            },
        )


@pytest.mark.asyncio
async def test_invalid_one_candidate_leaves_no_partial_plans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db, planning, jobs = _service(tmp_path)
    provider_id = planning.providers.list()[0]["provider_config_id"]
    planning.vault.set(provider_id, "SENTINEL_API_KEY")
    preview = _prepare(planning)
    created = planning.create_generation(
        "p1", preview["egress_preview_id"], preview["payload_sha256"], jobs
    )
    generation_id = created["candidate_generation_id"]
    with db.connection() as conn:
        invocation_id = conn.execute(
            "SELECT id FROM provider_invocations WHERE candidate_generation_id=?", (generation_id,)
        ).fetchone()[0]
    broken = _valid_provider_result()
    broken["candidates"][2]["variant"] = "balanced"

    async def invalid(*_: object) -> StructuredTextResult:
        return StructuredTextResult(broken, None, None)

    monkeypatch.setattr("aivs_core.planning.OpenAICompatibleTextProvider.generate", invalid)
    with pytest.raises(Exception):
        await planning.run_generation(
            {
                "candidate_generation_id": generation_id,
                "provider_invocation_id": invocation_id,
                "input_json": json_dumps({"egress_payload_sha256": preview["payload_sha256"]}),
            },
            asyncio.Event(),
            lambda _: None,
            lambda _: None,
        )
    with db.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM candidate_plans").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_cancelled_generation_records_possible_provider_processing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db, planning, jobs = _service(tmp_path)
    provider_id = planning.providers.list()[0]["provider_config_id"]
    planning.vault.set(provider_id, "SENTINEL_API_KEY")
    preview = _prepare(planning)
    created = planning.create_generation(
        "p1", preview["egress_preview_id"], preview["payload_sha256"], jobs
    )
    generation_id = created["candidate_generation_id"]
    with db.connection() as conn:
        invocation_id = conn.execute(
            "SELECT id FROM provider_invocations WHERE candidate_generation_id=?", (generation_id,)
        ).fetchone()[0]

    async def cancelled(*_: object) -> StructuredTextResult:
        from aivs_core.providers import ProviderError

        raise ProviderError("PROVIDER_CANCELLED", "已取消")

    monkeypatch.setattr("aivs_core.planning.OpenAICompatibleTextProvider.generate", cancelled)
    with pytest.raises(Exception):
        await planning.run_generation(
            {
                "candidate_generation_id": generation_id,
                "provider_invocation_id": invocation_id,
                "input_json": json_dumps({"egress_payload_sha256": preview["payload_sha256"]}),
            },
            asyncio.Event(),
            lambda _: None,
            lambda _: None,
        )
    with db.connection() as conn:
        generation_status = conn.execute(
            "SELECT status FROM candidate_generations WHERE id=?", (generation_id,)
        ).fetchone()[0]
        invocation_status, may_process = conn.execute(
            "SELECT status,provider_may_have_processed FROM provider_invocations WHERE id=?",
            (invocation_id,),
        ).fetchone()
    assert generation_status == "cancelled"
    assert (invocation_status, may_process) == ("cancelled", 1)


@pytest.mark.asyncio
async def test_connection_test_persists_invocation_without_project_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db, planning, _ = _service(tmp_path)
    provider_id = planning.providers.list()[0]["provider_config_id"]
    planning.vault.set(provider_id, "SENTINEL_API_KEY")
    captured: list[dict] = []

    async def test_result(_: object, request: object, *__: object) -> StructuredTextResult:
        captured.append(request.payload)  # type: ignore[union-attr]
        return StructuredTextResult({"candidates": []}, None, "request-id")

    monkeypatch.setattr("aivs_core.planning.OpenAICompatibleTextProvider.generate", test_result)
    result = await planning.test_provider(provider_id)
    assert captured == [
        {
            "capability": "connection_test",
            "instruction": "Return exactly three empty candidate variants for capability verification.",  # noqa: E501
        }
    ]
    with db.connection() as conn:
        row = conn.execute(
            "SELECT candidate_generation_id,capability,status FROM provider_invocations WHERE id=?",
            (result["provider_invocation_id"],),
        ).fetchone()
    assert tuple(row) == (None, "connection_test", "succeeded")
