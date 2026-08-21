# ruff: noqa: E501
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.shot_requirement_timeline_batch_assembly import (
    ShotRequirementTimelineBatchAssemblyService,
)
from aivs_core.timeline import TimelineService


def _seed_lineage(sql, project_id: str, revision_id: str, index: int) -> None:
    requirement_id = f"req-{index}"
    asset_id = f"asset-{index}"
    sql.execute(
        "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
        "VALUES (?,?,'image','managed','Generated',?,4,NULL,'available',?,'now','now')",
        (asset_id, project_id, f"sha256:asset-{index}", json_dumps({"width": 1024, "height": 768})),
    )
    sql.execute(
        "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,'now')",
        (asset_id, f"file:///private/{asset_id}.png"),
    )
    if index == 0:
        sql.execute(
            "INSERT INTO image_provider_configs VALUES (?,?, 'apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image','1','Local fixture','gpt-image-2',1,0.1,0.15,'CNY','now','now')",
            (f"config-{index}", project_id),
        )
    sql.execute(
        "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) "
        "VALUES (?,?, 'image','provider_image_v1','sha256:prompt','[]','{}',?,'now')",
        (f"request-{index}", project_id, f"sha256:request-{index}"),
    )
    sql.execute(
        "INSERT INTO provider_image_request_profiles(request_id,provider_config_id,provider_kind,adapter_id,capability,protocol_version,model,endpoint_identity,size,output_format,provider_profile_sha256,payload_sha256,confirmed_at,created_at) VALUES "
        "(?,?, 'apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image','1','gpt-image-2','apikey_fun_images_generations','1024x1024','png','sha256:profile','sha256:payload','now','now')",
        (f"request-{index}", "config-0"),
    )
    sql.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at) "
        "VALUES (?,?, 'media_generation','media_generation','succeeded','completed',1,'{}',1,'now','now')",
        (f"job-{index}", project_id),
    )
    sql.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
        "VALUES (?,?,?,1,'succeeded','completed',?,?,'{}','now','now','now')",
        (f"task-{index}", f"request-{index}", f"job-{index}", asset_id, f"sha256:asset-{index}"),
    )
    sql.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,provider_call_count,provider_may_have_processed,estimated_cost,estimated_cost_currency,price_tier,validated_format,validated_width,validated_height,validated_size_bytes,output_sha256,cleanup_required,created_at,finished_at,updated_at) "
        "VALUES (?,?,?,'succeeded',1,1,0.1,'CNY','1K','png',1024,768,4,?,0,'now','now','now')",
        (f"invocation-{index}", f"task-{index}", "config-0", f"sha256:asset-{index}"),
    )
    sql.execute(
        "INSERT INTO generated_asset_provenance VALUES "
        "(?,?,?,?,?,'sha256:prompt','apikey_fun_images','apikey_fun_images_sse_v1','1','gpt-image-2','sha256:profile','sha256:response',?,'now')",
        (
            f"provenance-{index}",
            asset_id,
            f"request-{index}",
            f"task-{index}",
            f"invocation-{index}",
            f"sha256:asset-{index}",
        ),
    )
    sql.execute(
        "INSERT INTO shot_requirement_image_generation_links VALUES "
        "(?,?,?,?,?,'sha256:requirement','now')",
        (f"link-{index}", project_id, revision_id, requirement_id, f"request-{index}"),
    )
    sql.execute(
        "INSERT INTO shot_requirement_image_adoptions VALUES "
        "(?,?,?,?,?,?,?,1,NULL,'now')",
        (f"adopt-{index}", project_id, revision_id, requirement_id, f"link-{index}", f"task-{index}", asset_id),
    )


def _service(
    tmp_path: Path, count: int = 24
) -> tuple[Database, ShotRequirementTimelineBatchAssemblyService, dict[str, Any]]:
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
            "INSERT INTO shot_list_revisions VALUES "
            "('shot-rev','sl','p',NULL,1,'Shots','','sha256:shots','now')"
        )
        for index in range(count):
            sql.execute(
                "INSERT INTO shot_requirements VALUES "
                "(?,'shot-rev',?, 'PRIVATE_TITLE','PRIVATE_REQUIREMENT',2000000,'image',NULL,NULL,NULL)",
                (f"req-{index}", index),
            )
        sql.execute(
            "UPDATE shot_lists SET current_revision_id='shot-rev',confirmed_revision_id='shot-rev' WHERE id='sl'"
        )
        for index in range(count):
            _seed_lineage(sql, "p", "shot-rev", index)
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
        ShotRequirementTimelineBatchAssemblyService(db, timeline),
        {"revision": state["current_revision"]["timeline_revision_id"]},
    )


def _items(count: int) -> list[dict[str, Any]]:
    return [
        {
            "requirement_id": f"req-{index}",
            "expected_adoption_id": f"adopt-{index}",
            "duration_us": 1_000_000,
            "layout": "fit",
        }
        for index in range(count)
    ]


def _request(db: Database, count: int, **overrides: Any) -> dict[str, Any]:
    revision_id = db and overrides.pop("revision_id", None)
    with db.connection() as sql:
        if revision_id is None:
            revision_id = sql.execute(
                "SELECT current_timeline_revision_id FROM projects WHERE id='p'"
            ).fetchone()[0]
    request = {
        "base_timeline_revision_id": revision_id,
        "at_index": 0,
        "items": _items(count),
    }
    request.update(overrides)
    return request


def test_prepare_apply_replay_and_order(tmp_path: Path) -> None:
    db, service, ids = _service(tmp_path)
    prepared = service.prepare("p", _request(db, 3))
    assert prepared["item_count"] == 3
    assert [item["item_index"] for item in prepared["items"]] == [0, 1, 2]
    assert prepared["clip_count_before"] == 0
    assert prepared["clip_count_after"] == 3
    assert prepared["duration_after_us"] == 3_000_000
    assert "document" not in prepared
    applied = service.apply(
        "p",
        {
            "batch_preview_id": prepared["preview_id"],
            "proposed_document_sha256": prepared["proposed_document_sha256"],
            "confirmed": True,
        },
    )
    assert applied["reused"] is False
    replay = service.apply(
        "p",
        {
            "batch_preview_id": prepared["preview_id"],
            "proposed_document_sha256": prepared["proposed_document_sha256"],
            "confirmed": True,
        },
    )
    assert replay["reused"] is True
    assert replay["assembly"]["batch_assembly_id"] == applied["assembly"]["batch_assembly_id"]
    with db.connection() as sql:
        document = json.loads(
            sql.execute(
                "SELECT document_json FROM timeline_revisions WHERE id=?",
                (applied["assembly"]["output_timeline_revision_id"],),
            ).fetchone()[0]
        )
        assert [clip["asset_id"] for clip in document["clips"]] == ["asset-0", "asset-1", "asset-2"]
        assert sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == 2
        assert (
            sql.execute(
                "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assemblies"
            ).fetchone()[0]
            == 1
        )
        assert (
            sql.execute(
                "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_items"
            ).fetchone()[0]
            == 3
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_batch_boundaries_and_duplicates(tmp_path: Path) -> None:
    db, service, _ = _service(tmp_path)
    for count, code in [(1, "STAGE6_BATCH_SIZE_INVALID"), (25, "STAGE6_BATCH_SIZE_INVALID")]:
        with pytest.raises(DomainError) as error:
            service.prepare("p", _request(db, count))
        assert error.value.code == code
    request = _request(db, 2)
    request["items"][1]["requirement_id"] = request["items"][0]["requirement_id"]
    with pytest.raises(DomainError) as duplicate:
        service.prepare("p", request)
    assert duplicate.value.code == "STAGE6_BATCH_REQUIREMENT_DUPLICATED"


def test_prepare_rejects_invalid_position_duration_and_layout(tmp_path: Path) -> None:
    db, service, _ = _service(tmp_path)
    with pytest.raises(DomainError) as position:
        service.prepare("p", _request(db, 2, at_index=1))
    assert position.value.code == "STAGE6_BATCH_POSITION_INVALID"
    request = _request(db, 2)
    request["items"][0]["duration_us"] = 499_999
    with pytest.raises(DomainError) as duration:
        service.prepare("p", request)
    assert duration.value.code == "STAGE6_BATCH_DURATION_INVALID"
    request = _request(db, 2)
    request["items"][0]["layout"] = "invalid"
    with pytest.raises(DomainError) as layout:
        service.prepare("p", request)
    assert layout.value.code == "STAGE6_BATCH_REQUEST_INVALID"


def test_apply_conflicts_and_atomic_rollback(tmp_path: Path) -> None:
    db, service, _ = _service(tmp_path)
    prepared = service.prepare("p", _request(db, 3))
    with db.connection() as sql:
        before_revisions = sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
        sql.execute("UPDATE assets SET availability='missing' WHERE id='asset-1'")
    with pytest.raises(DomainError) as unavailable:
        service.apply(
            "p",
            {
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
    assert unavailable.value.code == "STAGE6_BATCH_ASSET_UNAVAILABLE"
    with db.connection() as sql:
        assert (
            sql.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == before_revisions
        )
        assert (
            sql.execute(
                "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assemblies"
            ).fetchone()[0]
            == 0
        )
        assert (
            sql.execute(
                "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_items"
            ).fetchone()[0]
            == 0
        )
        sql.execute("UPDATE assets SET availability='available' WHERE id='asset-1'")
    with pytest.raises(DomainError) as mismatch:
        service.apply(
            "p",
            {
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": "sha256:stale",
                "confirmed": True,
            },
        )
    assert mismatch.value.code == "STAGE6_BATCH_PREVIEW_MISMATCH"


def test_apply_requires_confirmation_and_missing_preview(tmp_path: Path) -> None:
    db, service, _ = _service(tmp_path)
    prepared = service.prepare("p", _request(db, 2))
    with pytest.raises(DomainError) as confirmation:
        service.apply(
            "p",
            {
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": False,
            },
        )
    assert confirmation.value.code == "STAGE6_BATCH_CONFIRMATION_REQUIRED"
    with pytest.raises(DomainError) as missing:
        service.apply(
            "p",
            {
                "batch_preview_id": "missing",
                "proposed_document_sha256": "sha256:x",
                "confirmed": True,
            },
        )
    assert missing.value.code == "STAGE6_BATCH_NOT_FOUND"


def test_provider_calls_and_privacy_are_zero(tmp_path: Path) -> None:
    db, service, _ = _service(tmp_path)
    with db.connection() as sql:
        before = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]
    prepared = service.prepare("p", _request(db, 2))
    payload = repr(prepared) + repr(
        service.apply(
            "p",
            {
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
    )
    assert "PRIVATE_REQUIREMENT" not in payload
    assert "file:///private" not in payload
    assert "document" not in prepared
    with db.connection() as sql:
        after = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]
    assert after == before
