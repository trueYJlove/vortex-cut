from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps
from aivs_core.provider_images import FailOnCallImageProvider

RESOURCES = Path(__file__).resolve().parents[4] / "resources"
PRIVATE_REQUIREMENT = "STAGE5_API_REQUIREMENT_PRIVATE"
PRIVATE_PATH = "C:/private/stage5/image.png"
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
        "title": "Stage 5",
        "summary": "",
        "requirements": [
            {
                "title": "Adopted image",
                "visual_direction": PRIVATE_REQUIREMENT,
                "target_duration_us": 2_000_000,
                "visual": {"requirement_kind": "image", "source_asset_id": None},
                "narration": None,
            }
        ],
    }


def _seed_adoption(app, project_id: str, revision_id: str, requirement_id: str) -> None:
    with app.state.core.db.connection() as sql:
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) VALUES "
            "('stage5-image',?,'image','managed','Generated','sha256:stage5-image',4,NULL,"
            "'available',?,'now','now')",
            (project_id, json_dumps({"width": 1024, "height": 1024})),
        )
        sql.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES "
            "('stage5-image',?,'now')",
            (PRIVATE_PATH,),
        )
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('stage5-config',?,'apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','Fixture','gpt-image-2',1,0.1,0.15,'CNY','now','now')",
            (project_id,),
        )
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,"
            "prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) VALUES "
            "('stage5-request',?,'image','provider_image_v1','sha256:prompt','[]','{}',"
            "'sha256:request','now')",
            (project_id,),
        )
        sql.execute(
            "INSERT INTO provider_image_request_profiles VALUES "
            "('stage5-request','stage5-config','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','gpt-image-2','apikey_fun_images_generations','1024x1024',"
            "'png','sha256:profile','sha256:payload','now','now')"
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
            "created_at,updated_at) VALUES ('stage5-job',?,'media_generation','media_generation',"
            "'succeeded','completed',1,'{}',1,'now','now')",
            (project_id,),
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
            "VALUES ('stage5-task','stage5-request','stage5-job',1,'succeeded','completed',"
            "'stage5-image','sha256:stage5-image','{}','now','now','now')"
        )
        sql.execute(
            "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,"
            "provider_call_count,provider_may_have_processed,estimated_cost,estimated_cost_currency,"
            "price_tier,validated_format,validated_width,validated_height,validated_size_bytes,"
            "output_sha256,cleanup_required,created_at,finished_at,updated_at) VALUES "
            "('stage5-invocation','stage5-task','stage5-config','succeeded',1,1,0.1,'CNY',"
            "'1K','png',1024,1024,4,'sha256:stage5-image',0,'now','now','now')"
        )
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES "
            "('stage5-provenance','stage5-image','stage5-request','stage5-task',"
            "'stage5-invocation','sha256:prompt','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'1','gpt-image-2','sha256:profile','sha256:response','sha256:stage5-image','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_generation_links VALUES "
            "('stage5-link',?,?,?,'stage5-request','sha256:requirement','now')",
            (project_id, revision_id, requirement_id),
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('stage5-adoption',?,?,?,'stage5-link','stage5-task','stage5-image',1,NULL,'now')",
            (project_id, revision_id, requirement_id),
        )


def _provider_calls(app) -> int:
    with app.state.core.db.connection() as sql:
        return sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]


def test_stage5_timeline_assembly_api_is_strict_atomic_private_and_local(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage5-admin")
    app = create_app(_settings(tmp_path))
    responses: list[object] = []
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage5-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "Stage 5 API"}
        ).json()["project_id"]
        revision = client.post(
            f"/api/v1/projects/{project_id}/shot-list/revisions",
            headers=ui,
            json=_shot_document(),
        ).json()["revision"]
        revision_id = revision["shot_list_revision_id"]
        requirement_id = revision["requirements"][0]["shot_requirement_id"]
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
        _seed_adoption(app, project_id, revision_id, requirement_id)
        calls_before = _provider_calls(app)
        assert isinstance(
            app.state.core.provider_image_generation.provider, FailOnCallImageProvider
        )

        base = (
            f"/api/v1/projects/{project_id}/shot-requirements/{requirement_id}"
            "/timeline-assemblies"
        )
        assert client.get(base).status_code == 401
        unknown = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "expected_adoption_id": "stage5-adoption",
                "base_timeline_revision_id": timeline_revision_id,
                "at_index": 0,
                "duration_us": 2_000_000,
                "layout": "fit",
                "unknown": True,
            },
        )
        assert unknown.status_code == 400
        invalid_position = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "expected_adoption_id": "stage5-adoption",
                "base_timeline_revision_id": timeline_revision_id,
                "at_index": 1,
                "duration_us": 2_000_000,
                "layout": "fit",
            },
        )
        assert invalid_position.status_code == 422
        assert invalid_position.json()["error"]["code"] == "STAGE5_POSITION_INVALID"

        prepared_response = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "expected_adoption_id": "stage5-adoption",
                "base_timeline_revision_id": timeline_revision_id,
                "at_index": 0,
                "duration_us": None,
                "layout": "fit",
            },
        )
        assert prepared_response.status_code == 200
        prepared = prepared_response.json()
        responses.append(prepared)
        assert prepared["asset"] == {
            "asset_id": "stage5-image",
            "kind": "image",
            "availability": "available",
            "fingerprint": "sha256:stage5-image",
            "width": 1024,
            "height": 1024,
        }
        assert not _contains_sensitive_key(prepared)

        preview_response = client.get(
            f"/api/v1/shot-requirement-timeline-assembly-previews/{prepared['preview_id']}",
            headers=ui,
        )
        assert preview_response.status_code == 200
        assert preview_response.json() == prepared
        responses.append(preview_response.json())
        not_confirmed = client.post(
            base,
            headers=ui,
            json={
                "assembly_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": False,
            },
        )
        assert not_confirmed.status_code == 422
        assert not_confirmed.json()["error"]["code"] == "STAGE5_CONFIRMATION_REQUIRED"

        applied_response = client.post(
            base,
            headers=ui,
            json={
                "assembly_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
        assert applied_response.status_code == 200
        applied = applied_response.json()
        responses.append(applied)
        assert applied["reused"] is False
        assert "document" not in applied
        assert "document" not in applied["assembly"]
        replay = client.post(
            base,
            headers=ui,
            json={
                "assembly_preview_id": prepared["preview_id"],
                "proposed_document_sha256": prepared["proposed_document_sha256"],
                "confirmed": True,
            },
        )
        assert replay.status_code == 200
        assert replay.json()["reused"] is True
        assert replay.json()["assembly"]["assembly_id"] == applied["assembly"]["assembly_id"]
        responses.append(replay.json())

        assembly_id = applied["assembly"]["assembly_id"]
        get_assembly = client.get(
            f"/api/v1/shot-requirement-timeline-assemblies/{assembly_id}", headers=ui
        )
        listed = client.get(f"{base}?limit=20", headers=ui)
        assert get_assembly.status_code == listed.status_code == 200
        assert get_assembly.json() == applied["assembly"]
        assert listed.json() == {"items": [applied["assembly"]], "next_cursor": None}
        responses.extend([get_assembly.json(), listed.json()])
        missing = client.get(
            "/api/v1/shot-requirement-timeline-assemblies/missing", headers=ui
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "STAGE5_ASSEMBLY_NOT_FOUND"

    with app.state.core.db.connection() as sql:
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        stage5_dump = "\n".join(
            sql.iterdump()
        )
        stage5_rows = repr(
            sql.execute(
                "SELECT * FROM shot_requirement_timeline_assembly_previews"
            ).fetchall()
            + sql.execute("SELECT * FROM shot_requirement_timeline_assemblies").fetchall()
        )
    assert _provider_calls(app) == calls_before
    assert PRIVATE_REQUIREMENT not in repr(responses)
    assert PRIVATE_PATH not in repr(responses)
    assert PRIVATE_REQUIREMENT not in stage5_rows
    assert PRIVATE_PATH not in stage5_rows
    assert not any(_contains_sensitive_key(item) for item in responses)
    # The source tables intentionally contain upstream private facts; Stage 5 must not copy them.
    assert PRIVATE_REQUIREMENT in stage5_dump
    assert PRIVATE_PATH in stage5_dump
