from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.provider_images import FailOnCallImageProvider

RESOURCES = Path(__file__).resolve().parents[4] / "resources"
PROMPT_SENTINEL = "STAGE4E_API_PROMPT_PRIVATE"
SECRET_SENTINEL = "STAGE4E_API_SECRET_PRIVATE"
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
        "title": "Stage 4E",
        "summary": "",
        "requirements": [
            {
                "title": "Generated image",
                "visual_direction": "private visual direction",
                "target_duration_us": 2_000_000,
                "visual": {"requirement_kind": "image", "source_asset_id": None},
                "narration": None,
            }
        ],
    }


def test_stage4e_fulfillment_api_is_strict_safe_and_provider_disabled(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4e-admin")
    app = create_app(_settings(tmp_path))
    responses: list[object] = []
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage4e-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "Stage 4E API"}
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
            json={
                "revision_id": revision_id,
                "expected_current_revision_id": revision_id,
            },
        ).raise_for_status()
        config = client.post(
            f"/api/v1/projects/{project_id}/image-provider-configs",
            headers=ui,
            json={"display_name": "Stage 4E", "enabled": True},
        ).json()
        config_id = config["provider_config_id"]
        secret_response = client.put(
            f"/api/v1/internal/image-provider-configs/{config_id}/secret",
            headers=admin,
            json={"secret": SECRET_SENTINEL},
        )
        assert secret_response.status_code == 200

        base = f"/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment"
        assert client.get(base).status_code == 401
        unknown = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "expected_confirmed_revision_id": revision_id,
                "provider_config_id": config_id,
                "prompt": PROMPT_SENTINEL,
                "unknown": True,
            },
        )
        assert unknown.status_code == 400
        prepared_response = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "expected_confirmed_revision_id": revision_id,
                "provider_config_id": config_id,
                "prompt": PROMPT_SENTINEL,
            },
        )
        assert prepared_response.status_code == 200
        prepared = prepared_response.json()
        responses.append(prepared)
        assert not _contains_sensitive_key(prepared)
        assert isinstance(
            app.state.core.provider_image_generation.provider, FailOnCallImageProvider
        )

        create_unknown = client.post(
            f"{base}/create",
            headers=ui,
            json={
                "preview_id": prepared["preview_id"],
                "fulfillment_payload_sha256": prepared["fulfillment_payload_sha256"],
                "expected_confirmed_revision_id": revision_id,
                "confirmed": True,
                "unknown": True,
            },
        )
        assert create_unknown.status_code == 400
        created_response = client.post(
            f"{base}/create",
            headers=ui,
            json={
                "preview_id": prepared["preview_id"],
                "fulfillment_payload_sha256": prepared["fulfillment_payload_sha256"],
                "expected_confirmed_revision_id": revision_id,
                "confirmed": True,
            },
        )
        assert created_response.status_code == 200
        created = created_response.json()
        responses.append(created)
        assert not _contains_sensitive_key(created)

        state_response = client.get(base, headers=ui)
        links_response = client.get(f"{base}/links?limit=20", headers=ui)
        adoptions_response = client.get(f"{base}/adoptions?limit=20", headers=ui)
        for response in (state_response, links_response, adoptions_response):
            assert response.status_code == 200
            responses.append(response.json())
            assert not _contains_sensitive_key(response.json())
        assert links_response.json()["items"][0]["link_id"] == created["link"]["link_id"]
        assert adoptions_response.json() == {"items": [], "next_cursor": None}

        invalid_adopt = client.post(
            f"{base}/adopt",
            headers=ui,
            json={
                "generation_link_id": created["link"]["link_id"],
                "task_id": created["task"]["task_id"],
                "asset_id": "not-adoptable",
                "expected_current_adoption_id": None,
                "confirmed": True,
            },
        )
        assert invalid_adopt.status_code == 400
        assert invalid_adopt.json()["error"]["code"] == "SHOT_REQUIREMENT_IMAGE_ADOPTION_INVALID"
        responses.append(invalid_adopt.json())

    with app.state.core.db.connection() as sql:
        dump = "\n".join(sql.iterdump())
        provider_calls = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) FROM provider_image_invocations"
        ).fetchone()[0]
    serialized = repr(responses)
    assert PROMPT_SENTINEL not in serialized
    assert SECRET_SENTINEL not in serialized
    assert PROMPT_SENTINEL not in dump
    assert SECRET_SENTINEL not in dump
    assert provider_calls == 0
