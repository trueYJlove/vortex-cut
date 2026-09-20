from __future__ import annotations  # noqa: I001

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.ids import new_id
from aivs_core.planning import PlanningService, ProviderRepository, RecipeRegistry
from aivs_core.projects import DomainError
from aivs_core.providers import ProviderSecretVault, StructuredTextResult
from aivs_core.timeline import TimelineService


def _service(tmp_path: Path) -> tuple[PlanningService, Database, TimelineService]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    recipes = RecipeRegistry(Path("resources/recipes"))
    vault = ProviderSecretVault()
    providers = ProviderRepository(db, vault)
    timelines = TimelineService(db)
    planning = PlanningService(db, recipes, providers, vault, timelines, cv_signals=_FakeCvSignals())
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available',?, 'now','now')",
            (json_dumps({"duration_us": 30_000_000, "video_streams": [{}], "audio_streams": [{}]}),),
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
    with db.connection() as conn:
        conn.execute(
            "UPDATE provider_configs SET candidate_capability_status='supported',"
            "candidate_response_adapter_id='openai_chat_completions_json_schema_v1',"
            "candidate_probe_protocol_version='1',candidate_capability_tested_at='now',"
            "candidate_capability_probe_sha256='sha256:probe'"
        )
        conn.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,sample_count,scene_cut_count,created_at,updated_at,finished_at) "
            "VALUES ('an1','a1','fp1',1,'ready',6,2,'now','now','now')"
        )
        samples = [
            ("s0", 0, 0), ("s1", 5_000_000, 0), ("s2", 10_000_000, 1),
            ("s3", 15_000_000, 0), ("s4", 20_000_000, 1), ("s5", 25_000_000, 0),
        ]
        for index, (sid, ts, cut) in enumerate(samples):
            face = 2 if index in (1, 2, 3) else 0
            conn.execute(
                "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
                "motion_energy,sharpness,brightness,audio_energy,face_count,face_score) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (sid, "an1", index, ts, cut, 0.2 + 0.1 * index, 0.5, 0.4, 0.0, face, 0.8 if face else None),
            )
    return planning, db, timelines


class _FakeCvSignals:
    """单元级替身：samples_for_range 透传（真实服务在集成测试覆盖）。"""

    def samples_for_range(self, asset_id: str, start_us: int, end_us: int) -> list[dict[str, Any]]:
        with _SHARED_DB[0].connection() as conn:
            analysis = conn.execute(
                "SELECT id FROM cv_analyses WHERE asset_id=? AND status='ready' "
                "ORDER BY created_at DESC LIMIT 1",
                (asset_id,),
            ).fetchone()
            if not analysis:
                return []
            rows = conn.execute(
                "SELECT timestamp_us,scene_cut,motion_energy,sharpness,brightness,"
                "audio_energy,face_count,face_score FROM cv_samples "
                "WHERE analysis_id=? AND timestamp_us>=? AND timestamp_us<? ORDER BY timestamp_us",
                (analysis["id"], start_us, end_us),
            ).fetchall()
        return [dict(r) for r in rows]


_SHARED_DB: list[Database] = [None]  # type: ignore[list-item]


def _brief(planning: PlanningService) -> None:
    planning.put_brief(
        "p1",
        {
            "schema_version": 1,
            "topic": "主题",
            "audience": "受众",
            "target_platform": "generic_vertical",
            "target_duration_us": 15_000_000,
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


def _prepare_cv(planning: PlanningService) -> dict[str, Any]:
    provider = planning.providers.list()[0]
    return planning.prepare(
        "p1",
        {
            "provider_config_id": provider["provider_config_id"],
            "recipe_id": "balanced-narrative-v1",
            "transcript_ids": [],
            "candidate_source": "cv",
        },
    )


def _candidate_value() -> dict[str, Any]:
    """三候选：各 2 个场景段拼一个 clip（时长落在 0.8-1.2×15s 预算）。"""

    def clips(a: str, b: str) -> list[dict[str, Any]]:
        return [
            {"segment_ids": [a], "reason": "开场", "model_score": 0.9},
            {"segment_ids": [b], "reason": "收尾", "model_score": 0.8},
        ]

    return {
        "candidates": [
            {"variant": "balanced", "title_suggestion": "t", "summary": "s", "clips": clips("s1", "s3")},
            {"variant": "compact", "title_suggestion": "t", "summary": "s", "clips": clips("s1", "s3")},
            {"variant": "bold", "title_suggestion": "t", "summary": "s", "clips": clips("s2", "s3")},
        ]
    }


def test_cv_only_prepare_builds_cv_segments(tmp_path: Path) -> None:
    planning, db, _timelines = _service(tmp_path)
    _SHARED_DB[0] = db
    _brief(planning)
    preview = _prepare_cv(planning)
    segments = preview["payload"]["segments"]
    assert len(segments) == 3  # 三个 ≥2s 场景段（0-5,10-15,20-25）
    assert all(s["text"] == "" and s["transcript_ref"] is None for s in segments)
    assert all("cv_features" in s for s in segments)
    # 排序：含人脸段优先（s1/s2/s3 → 场景 10-15 与 5-10 段在前）
    stats = preview["stats"]
    assert stats["cv_scene_count"] == 3
    assert stats["candidate_source"] == "cv"
    assert "segments.cv_features" in preview["sent_fields"]


def test_cv_only_prepare_requires_analysis(tmp_path: Path) -> None:
    planning, db, _timelines = _service(tmp_path)
    _SHARED_DB[0] = db
    _brief(planning)
    with db.connection() as conn:
        conn.execute("DELETE FROM cv_samples")
        conn.execute("DELETE FROM cv_analyses")
    with pytest.raises(DomainError) as exc:
        _prepare_cv(planning)
    assert exc.value.code == "PLANNING_NO_SEGMENTS"


def test_auto_without_transcripts_falls_back_to_cv(tmp_path: Path) -> None:
    planning, db, _timelines = _service(tmp_path)
    _SHARED_DB[0] = db
    _brief(planning)
    provider = planning.providers.list()[0]
    preview = planning.prepare(
        "p1",
        {
            "provider_config_id": provider["provider_config_id"],
            "recipe_id": "balanced-narrative-v1",
            "transcript_ids": [],
            # 不传 candidate_source = auto → 无转录回退 CV
        },
    )
    assert preview["stats"]["candidate_source"] == "auto"
    assert preview["stats"]["cv_scene_count"] == 3


async def test_cv_candidates_validate_and_adopt_without_transcripts(tmp_path: Path) -> None:
    planning, db, timelines = _service(tmp_path)
    _SHARED_DB[0] = db
    _brief(planning)
    preview = _prepare_cv(planning)

    class Factory:
        async def generate(self, _request: Any, _cancel: Any) -> StructuredTextResult:
            return StructuredTextResult(_candidate_value(), {"total_tokens": 100}, None)

    planning.provider_factory = Factory
    planning.vault.set(planning.providers.list()[0]["provider_config_id"], "TEST_API_KEY")
    created = planning.create_generation(
        "p1", preview["egress_preview_id"], preview["payload_sha256"], _Jobs(db)
    )
    state = _create_timeline(db, timelines)
    with db.connection() as conn:
        conn.execute(
            "UPDATE candidate_generations SET timeline_baseline_revision_id=? WHERE id=?",
            (state["current_revision"]["timeline_revision_id"], created["candidate_generation_id"]),
        )
        job_row = conn.execute(
            "SELECT * FROM jobs WHERE candidate_generation_id=? ORDER BY created_at DESC LIMIT 1",
            (created["candidate_generation_id"],),
        ).fetchone()
    assert job_row is not None
    result = await planning.run_generation(job_row, asyncio.Event(), lambda _v: None, lambda _s: None)
    plans = planning.list_candidates("p1")
    assert len(plans) == 3
    candidate = planning.get_candidate(plans[0]["candidate_plan_id"])
    clips = candidate["clips"]
    assert all(c["source_kind"] == "cv" for c in clips)
    assert all(c["transcript_id"] is None for c in clips)
    # adopt：无转录建剪辑 + 无字幕
    revision = planning.adopt(
        "p1",
        candidate["candidate_plan_id"],
        {
            "schema_version": 1,
            "candidate_document_sha256": candidate["document_sha256"],
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
        },
    )
    document = revision["timeline_revision"]["document"]
    assert len(document["clips"]) == 2
    assert document["captions"] == []
    assert document["provenance"]["source_transcript_ids"] == []
    for clip in document["clips"]:
        assert clip["asset_id"] == "a1"
        assert clip["asset_kind"] == "video"


class _Jobs:
    """替身：对齐 JobService.create_candidate_generation 的落库语义。"""

    def __init__(self, db: Database) -> None:
        self.db = db

    def create_candidate_generation(
        self, project_id: str, generation_id: str, invocation_id: str, payload_sha256: str
    ) -> dict[str, Any]:
        job_id, now = new_id(), "now"
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                "candidate_generation_id,provider_invocation_id,resource_class,attempt,created_at,updated_at) "  # noqa: E501
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    "candidate_generation",
                    "candidate_generation",
                    "queued",
                    "queued",
                    0,
                    json_dumps(
                        {
                            "candidate_generation_id": generation_id,
                            "egress_payload_sha256": payload_sha256,
                        }
                    ),
                    generation_id,
                    invocation_id,
                    "network",
                    1,
                    now,
                    now,
                ),
            )
        return {"job_id": job_id, "status": "queued"}


def _create_timeline(db: Database, timelines: TimelineService) -> dict[str, Any]:
    with db.connection() as conn:
        pass
    return timelines.create(
        "p1",
        {
            "schema_version": 1,
            "source": {"kind": "empty"},
            "default_layout": "fit",
            "caption_preset_id": "default-bottom",
        },
    )


def test_transcript_source_rejects_empty_ids(tmp_path: Path) -> None:
    """显式 source=transcript 且空 transcript_ids → 校验拒绝。"""
    planning, db, _timelines = _service(tmp_path)
    _SHARED_DB[0] = db
    _brief(planning)
    provider = planning.providers.list()[0]
    with pytest.raises(DomainError) as exc:
        planning.prepare(
            "p1",
            {
                "provider_config_id": provider["provider_config_id"],
                "recipe_id": "balanced-narrative-v1",
                "transcript_ids": [],
                "candidate_source": "transcript",
            },
        )
    assert exc.value.code == "PLANNING_INVALID"

