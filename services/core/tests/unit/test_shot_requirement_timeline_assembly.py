# ruff: noqa: E501
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.projects import DomainError
from aivs_core.shot_requirement_timeline_assembly import ShotRequirementTimelineAssemblyService
from aivs_core.timeline import TimelineService


def _service(
    tmp_path: Path,
) -> tuple[Database, ShotRequirementTimelineAssemblyService, dict[str, str]]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    timeline = TimelineService(db)
    with db.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES ('p','P','active','{}',NULL,?,'P','now','now','now')",
            (str(tmp_path / "project"),),
        )
        sql.execute("INSERT INTO shot_lists VALUES ('sl','p',NULL,NULL,'now','now')")
        sql.execute(
            "INSERT INTO shot_list_revisions VALUES ('shot-rev','sl','p',NULL,1,'Shots','','sha256:shots','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirements VALUES ('req','shot-rev',0,'Shot','PRIVATE_REQUIREMENT',2000000,'image',NULL,NULL,NULL)"
        )
        sql.execute(
            "UPDATE shot_lists SET current_revision_id='shot-rev',confirmed_revision_id='shot-rev' WHERE id='sl'"
        )
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES ('image','p','image','managed','Generated','sha256:image',4,NULL,'available',?,'now','now')",
            (json_dumps({"width": 1024, "height": 1024}),),
        )
        # Seed a valid immutable Stage 4D/4E lineage without any Provider dispatch.
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('config','p','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','Local fixture','gpt-image-2',1,0.1,0.15,'CNY','now','now')"
        )
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) "
            "VALUES ('request','p','image','provider_image_v1','sha256:prompt','[]','{}','sha256:request','now')"
        )
        sql.execute(
            "INSERT INTO provider_image_request_profiles VALUES "
            "('request','config','apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image','1','gpt-image-2','apikey_fun_images_generations','1024x1024','png','sha256:profile','sha256:payload','now','now')"
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at) "
            "VALUES ('job','p','media_generation','media_generation','succeeded','completed',1,'{}',1,'now','now')"
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
            "VALUES ('task','request','job',1,'succeeded','completed','image','sha256:image','{}','now','now','now')"
        )
        sql.execute(
            "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,provider_call_count,provider_may_have_processed,estimated_cost,estimated_cost_currency,price_tier,validated_format,validated_width,validated_height,validated_size_bytes,output_sha256,cleanup_required,created_at,finished_at,updated_at) "
            "VALUES ('invocation','task','config','succeeded',1,1,0.1,'CNY','1K','png',1024,1024,4,'sha256:image',0,'now','now','now')"
        )
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES "
            "('provenance','image','request','task','invocation','sha256:prompt','apikey_fun_images','apikey_fun_images_sse_v1','1','gpt-image-2','sha256:profile','sha256:response','sha256:image','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_generation_links VALUES "
            "('link','p','shot-rev','req','request','sha256:requirement','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('adopt','p','shot-rev','req','link','task','image',1,NULL,'now')"
        )
    timeline.create(
        "p",
        {
            "schema_version": 1,
            "source": {"kind": "empty"},
            "default_layout": "fit",
            "caption_preset_id": "default-bottom",
        },
    )
    state = timeline.get_state("p")
    return (
        db,
        ShotRequirementTimelineAssemblyService(db, timeline),
        {
            "revision": state["current_revision"]["timeline_revision_id"],
            "adoption": "adopt",
        },
    )


def _prepare(
    service: ShotRequirementTimelineAssemblyService, ids: dict[str, str], **overrides: Any
) -> dict[str, Any]:
    request = {
        "expected_adoption_id": ids["adoption"],
        "base_timeline_revision_id": ids["revision"],
        "at_index": 0,
        "duration_us": None,
        "layout": "fit",
    }
    request.update(overrides)
    return service.prepare("p", "req", request)


def test_prepare_apply_replay_and_privacy(tmp_path: Path) -> None:
    db, service, ids = _service(tmp_path)
    with db.connection() as sql:
        provider_calls_before = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]
    prepared = _prepare(service, ids)
    assert prepared["duration_us"] == 2_000_000
    assert prepared["shifted_clip_count"] == 0
    assert "document" not in prepared
    applied = service.apply(
        "p",
        "req",
        {
            "assembly_preview_id": prepared["preview_id"],
            "proposed_document_sha256": prepared["proposed_document_sha256"],
            "confirmed": True,
        },
    )
    assert applied["reused"] is False
    replay = service.apply(
        "p",
        "req",
        {
            "assembly_preview_id": prepared["preview_id"],
            "proposed_document_sha256": prepared["proposed_document_sha256"],
            "confirmed": True,
        },
    )
    assert replay["reused"] is True
    assert replay["assembly"]["assembly_id"] == applied["assembly"]["assembly_id"]
    with db.connection() as sql:
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assemblies").fetchone()[0]
            == 1
        )
        assert sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == 2
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        provider_calls_after = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]
    assert provider_calls_after == provider_calls_before
    # Requirement belongs to upstream Stage 4C storage, but Stage 5 rows and DTOs do not copy it.
    assert "PRIVATE_REQUIREMENT" not in repr(prepared) + repr(applied)
    with db.connection() as sql:
        stage5_schema = "\n".join(
            row[0]
            for row in sql.execute(
                "SELECT sql FROM sqlite_master WHERE name LIKE 'shot_requirement_timeline_%'"
            )
        )
    assert "PRIVATE_REQUIREMENT" not in stage5_schema


def test_prepare_rejects_draft_locked_shift_stale_and_unavailable(tmp_path: Path) -> None:
    db, service, ids = _service(tmp_path)
    with db.connection() as sql:
        revision = sql.execute(
            "SELECT document_json FROM timeline_revisions WHERE id=?", (ids["revision"],)
        ).fetchone()[0]
        sql.execute(
            "INSERT INTO timeline_drafts VALUES ('p',?,?,?)", (ids["revision"], revision, utc_now())
        )
    with pytest.raises(DomainError) as draft:
        _prepare(service, ids)
    assert draft.value.code == "STAGE5_TIMELINE_DRAFT_EXISTS"
    with db.connection() as sql:
        sql.execute("DELETE FROM timeline_drafts WHERE project_id='p'")
        sql.execute("UPDATE assets SET availability='missing' WHERE id='image'")
    with pytest.raises(DomainError) as unavailable:
        _prepare(service, ids)
    assert unavailable.value.code == "STAGE5_ASSET_UNAVAILABLE"
    with db.connection() as sql:
        sql.execute("UPDATE assets SET availability='available' WHERE id='image'")
    with pytest.raises(DomainError) as stale:
        _prepare(service, ids, expected_adoption_id="stale")
    assert stale.value.code == "STAGE5_ADOPTION_CONFLICT"


def test_apply_conflict_rolls_back_revision_and_assembly(tmp_path: Path) -> None:
    db, service, ids = _service(tmp_path)
    prepared = _prepare(service, ids)
    with db.connection() as sql:
        sql.execute("UPDATE projects SET current_timeline_revision_id=NULL WHERE id='p'")
        before_revisions = sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
    with pytest.raises(DomainError) as conflict:
        service.apply(
            "p",
            "req",
            {
                "assembly_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
    assert conflict.value.code == "STAGE5_TIMELINE_REQUIRED"
    with db.connection() as sql:
        assert (
            sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == before_revisions
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assemblies").fetchone()[0]
            == 0
        )
