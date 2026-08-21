from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps
from aivs_core.provider_images import FailOnCallImageProvider

RESOURCES = Path(__file__).resolve().parents[4] / "resources"
PRIVATE_REQUIREMENT = "STAGE6R_API_REQUIREMENT_PRIVATE"
PRIVATE_PATH = "C:/private/stage6r/image.png"
SENSITIVE_KEYS = {
    "path",
    "uri",
    "absolute_path",
    "prompt",
    "visual_direction",
    "narration_text",
    "transcript",
    "caption",
    "authorization",
    "api_key",
    "secret",
    "payload",
    "raw_exception",
    "raw_response",
    "sse",
    "base64",
    "stderr",
    "command",
    "traceback",
    "document",
}


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
        manifest_dir=RESOURCES / "model-manifests",
        font_dir=RESOURCES / "fonts",
        recipe_dir=RESOURCES / "recipes",
    )


def _contains_sensitive_key(value: object) -> bool:
    if isinstance(value, list):
        return any(_contains_sensitive_key(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        str(key).lower() in SENSITIVE_KEYS or _contains_sensitive_key(item)
        for key, item in value.items()
    )


def _shot_document() -> dict[str, object]:
    return {
        "schema_version": 1,
        "base_revision_id": None,
        "title": "Stage 6-R",
        "summary": "",
        "requirements": [
            {
                "title": f"Adopted image {index}",
                "visual_direction": f"{PRIVATE_REQUIREMENT}-{index}",
                "target_duration_us": 2_000_000,
                "visual": {"requirement_kind": "image", "source_asset_id": None},
                "narration": None,
            }
            for index in range(24)
        ],
    }


def _seed_lineage(
    sql, project_id: str, revision_id: str, index: int, requirement_id: str
) -> None:
    asset_id = f"stage6r-image-{index}"
    fingerprint = f"sha256:stage6r-image-{index}"
    sql.execute(
        "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
        "modified_at,availability,media_info_json,created_at,updated_at) VALUES "
        "(?,?,'image','managed','Generated',?,4,NULL,'available',?,'now','now')",
        (asset_id, project_id, fingerprint, json_dumps({"width": 1024, "height": 768})),
    )
    sql.execute(
        "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,'now')",
        (asset_id, f"{PRIVATE_PATH}-{index}"),
    )
    sql.execute(
        "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,"
        "prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) VALUES "
        "(?,?,'image','provider_image_v1','sha256:prompt','[]','{}',?,'now')",
        (f"stage6r-request-{index}", project_id, f"sha256:stage6r-request-{index}"),
    )
    sql.execute(
        "INSERT INTO provider_image_request_profiles(request_id,provider_config_id,provider_kind,"
        "adapter_id,capability,protocol_version,model,endpoint_identity,size,output_format,"
        "provider_profile_sha256,payload_sha256,confirmed_at,created_at) VALUES "
        "(?,'stage6r-config','apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image',"
        "'1','gpt-image-2','apikey_fun_images_generations','1024x1024','png','sha256:profile',"
        "'sha256:payload','now','now')",
        (f"stage6r-request-{index}",),
    )
    sql.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
        "created_at,updated_at) VALUES (?,?,'media_generation','media_generation','succeeded',"
        "'completed',1,'{}',1,'now','now')",
        (f"stage6r-job-{index}", project_id),
    )
    sql.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
        "output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
        "VALUES (?,?,?,1,'succeeded','completed',?,?,'{}','now','now','now')",
        (
            f"stage6r-task-{index}",
            f"stage6r-request-{index}",
            f"stage6r-job-{index}",
            asset_id,
            fingerprint,
        ),
    )
    sql.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,"
        "provider_call_count,provider_may_have_processed,estimated_cost,estimated_cost_currency,"
        "price_tier,validated_format,validated_width,validated_height,validated_size_bytes,"
        "output_sha256,cleanup_required,created_at,finished_at,updated_at) VALUES "
        "(?,?,'stage6r-config','succeeded',1,1,0.1,'CNY','1K','png',1024,768,4,?,0,"
        "'now','now','now')",
        (f"stage6r-invocation-{index}", f"stage6r-task-{index}", fingerprint),
    )
    sql.execute(
        "INSERT INTO generated_asset_provenance VALUES "
        "(?,?,?,?,?,'sha256:prompt','apikey_fun_images','apikey_fun_images_sse_v1','1',"
        "'gpt-image-2','sha256:profile','sha256:response',?,'now')",
        (
            f"stage6r-provenance-{index}",
            asset_id,
            f"stage6r-request-{index}",
            f"stage6r-task-{index}",
            f"stage6r-invocation-{index}",
            fingerprint,
        ),
    )
    sql.execute(
        "INSERT INTO shot_requirement_image_generation_links VALUES "
        "(?,?,?,?,?,'sha256:requirement','now')",
        (
            f"stage6r-link-{index}",
            project_id,
            revision_id,
            requirement_id,
            f"stage6r-request-{index}",
        ),
    )
    sql.execute(
        "INSERT INTO shot_requirement_image_adoptions VALUES "
        "(?,?,?,?,?,?,?,1,NULL,'now')",
        (
            f"stage6r-adoption-{index}",
            project_id,
            revision_id,
            requirement_id,
            f"stage6r-link-{index}",
            f"stage6r-task-{index}",
            asset_id,
        ),
    )


def _seed_adoptions(app, project_id: str, revision_id: str, requirement_ids: list[str]) -> None:
    with app.state.core.db.connection() as sql:
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('stage6r-config',?,'apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','Fixture','gpt-image-2',1,0.1,0.15,'CNY','now','now')",
            (project_id,),
        )
        for index, requirement_id in enumerate(requirement_ids):
            _seed_lineage(sql, project_id, revision_id, index, requirement_id)


def _items(count: int, requirement_ids: list[str]) -> list[dict[str, object]]:

    ids = requirement_ids if count <= len(requirement_ids) else requirement_ids * 2
    return [
        {
            "requirement_id": ids[index],
            "expected_adoption_id": f"stage6r-adoption-{index}",
            "duration_us": 1_000_000,
            "layout": "fit",
        }
        for index in range(count)
    ]


def _provider_calls(app) -> int:
    with app.state.core.db.connection() as sql:
        return sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]


def test_stage6r_timeline_batch_assembly_api_is_strict_atomic_private_and_local(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage6r-admin")
    app = create_app(_settings(tmp_path))
    responses: list[object] = []
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage6r-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "Stage 6-R API"}
        ).json()["project_id"]
        revision = client.post(
            f"/api/v1/projects/{project_id}/shot-list/revisions",
            headers=ui,
            json=_shot_document(),
        ).json()["revision"]
        revision_id = revision["shot_list_revision_id"]
        client.post(
            f"/api/v1/projects/{project_id}/shot-list/confirm",
            headers=ui,
            json={"revision_id": revision_id, "expected_current_revision_id": revision_id},
        ).raise_for_status()
        timeline = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {"kind": "empty"},
                "default_layout": "fit",
                "caption_preset_id": "default-bottom",
            },
        ).json()
        timeline_revision_id = timeline["current_revision"]["timeline_revision_id"]
        requirement_ids = [
            requirement["shot_requirement_id"] for requirement in revision["requirements"]
        ]
        _seed_adoptions(app, project_id, revision_id, requirement_ids)
        calls_before = _provider_calls(app)
        assert isinstance(
            app.state.core.provider_image_generation.provider, FailOnCallImageProvider
        )

        base = f"/api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies"
        assert client.get(base).status_code == 401

        def prepare(count: int, **overrides: object) -> object:
            request = {
                "base_timeline_revision_id": timeline_revision_id,
                "at_index": 0,
                "items": _items(count, requirement_ids),
            }
            request.update(overrides)
            return client.post(f"{base}/prepare", headers=ui, json=request)

        unknown = prepare(2, unknown=True)
        assert unknown.status_code == 400
        assert unknown.json()["error"]["code"] == "VALIDATION_ERROR"
        responses.append(unknown.json())
        for count in (1, 25):
            invalid_size = prepare(count)
            assert invalid_size.status_code == 409
            assert invalid_size.json()["error"]["code"] == "STAGE6_BATCH_SIZE_INVALID"
            responses.append(invalid_size.json())

        prepared_two_response = prepare(2)
        assert prepared_two_response.status_code == 200
        prepared_two = prepared_two_response.json()
        assert prepared_two["item_count"] == 2
        assert [item["item_index"] for item in prepared_two["items"]] == [0, 1]
        assert prepared_two["clip_count_before"] == 0
        assert prepared_two["clip_count_after"] == 2
        assert "document" not in prepared_two
        assert not _contains_sensitive_key(prepared_two)
        responses.append(prepared_two)

        prepared_response = prepare(24)
        assert prepared_response.status_code == 200
        prepared = prepared_response.json()
        assert prepared["item_count"] == 24
        assert [item["item_index"] for item in prepared["items"]] == list(range(24))
        assert prepared["clip_count_before"] == 0
        assert prepared["clip_count_after"] == 24
        assert prepared["duration_after_us"] == 24_000_000
        assert "document" not in prepared
        assert not _contains_sensitive_key(prepared)
        responses.append(prepared)

        preview_response = client.get(
            f"/api/v1/shot-requirement-timeline-batch-assembly-previews/"
            f"{prepared['preview_id']}",
            headers=ui,
        )
        assert preview_response.status_code == 200
        assert preview_response.json() == prepared
        responses.append(preview_response.json())

        not_confirmed = client.post(
            base,
            headers=ui,
            json={
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": False,
            },
        )
        assert not_confirmed.status_code == 422
        assert not_confirmed.json()["error"]["code"] == "STAGE6_BATCH_CONFIRMATION_REQUIRED"
        responses.append(not_confirmed.json())
        mismatch = client.post(
            base,
            headers=ui,
            json={
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": "sha256:stale",
                "confirmed": True,
            },
        )
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "STAGE6_BATCH_PREVIEW_MISMATCH"
        responses.append(mismatch.json())

        applied_response = client.post(
            base,
            headers=ui,
            json={
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
        assert applied_response.status_code == 200
        applied = applied_response.json()
        responses.append(applied)
        assert applied["reused"] is False

        replay = client.post(
            base,
            headers=ui,
            json={
                "batch_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
        assert replay.status_code == 200
        replay_json = replay.json()
        assert replay_json["reused"] is True
        assert (
            replay_json["assembly"]["batch_assembly_id"]
            == applied["assembly"]["batch_assembly_id"]
        )
        responses.append(replay_json)

        batch_id = applied["assembly"]["batch_assembly_id"]
        get_batch = client.get(
            f"/api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}", headers=ui
        )
        assert get_batch.status_code == 200
        assert get_batch.json() == applied["assembly"]
        responses.append(get_batch.json())

        listed = client.get(f"{base}?limit=20", headers=ui)
        assert listed.status_code == 200
        assert listed.json() == {"items": [applied["assembly"]], "next_cursor": None}
        responses.append(listed.json())

        listed_items = client.get(
            f"/api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}/items?limit=100",
            headers=ui,
        )
        assert listed_items.status_code == 200
        assert len(listed_items.json()["items"]) == len(prepared["items"])
        for actual, expected in zip(
            listed_items.json()["items"], prepared["items"], strict=True
        ):
            assert actual == {
                "item_index": expected["item_index"],
                "shot_requirement_id": expected["shot_requirement_id"],
                "adoption_id": expected["adoption_id"],
                "asset_id": expected["asset"]["asset_id"],
                "proposed_clip_id": expected["proposed_clip_id"],
                "duration_us": expected["duration_us"],
                "layout": expected["layout"],
                "created_at": actual["created_at"],
            }
        assert listed_items.json()["next_cursor"] is None
        responses.append(listed_items.json())

        missing = client.get(
            "/api/v1/shot-requirement-timeline-batch-assemblies/missing", headers=ui
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "STAGE6_BATCH_NOT_FOUND"
        responses.append(missing.json())

    with app.state.core.db.connection() as sql:
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
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
            == 24
        )
        assert "document" not in applied
        assert _provider_calls(app) == calls_before
        for response in responses:
            assert "document" not in response
            assert not _contains_sensitive_key(response)

        stage6_rows = sql.execute(
            "SELECT * FROM shot_requirement_timeline_batch_assembly_previews"
        ).fetchall()
        stage6_rows += sql.execute(
            "SELECT * FROM shot_requirement_timeline_batch_assembly_preview_items"
        ).fetchall()
        stage6_rows += sql.execute(
            "SELECT * FROM shot_requirement_timeline_batch_assemblies"
        ).fetchall()
        stage6_rows += sql.execute(
            "SELECT * FROM shot_requirement_timeline_batch_assembly_items"
        ).fetchall()
        assert PRIVATE_REQUIREMENT not in repr(stage6_rows)
        assert PRIVATE_PATH not in repr(stage6_rows)
