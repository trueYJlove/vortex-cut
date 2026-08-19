from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.provider_images import FailOnCallImageProvider

PROMPT_SENTINEL = "PROMPT_SENTINEL_STAGE4D_API_PRIVATE"
SECRET_SENTINEL = "SECRET_SENTINEL_STAGE4D_API_PRIVATE"
RESOURCES = Path(__file__).resolve().parents[4] / "resources"


def _wait_task(client: TestClient, headers: dict[str, str], request_id: str) -> dict:
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        response = client.get(
            f"/api/v1/provider-image-generations/{request_id}/tasks", headers=headers
        )
        assert response.status_code == 200
        task = response.json()["items"][-1]
        if task["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return task
        time.sleep(0.02)
    raise AssertionError("provider image task did not finish")


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
        manifest_dir=RESOURCES / "model-manifests",
        font_dir=RESOURCES / "fonts",
        recipe_dir=RESOURCES / "recipes",
    )


def test_provider_image_api_is_strict_safe_admin_scoped_and_network_disabled(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4d-admin")
    app = create_app(_settings(tmp_path))
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage4d-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 4D"}).json()[
            "project_id"
        ]
        configs_url = f"/api/v1/projects/{project_id}/image-provider-configs"
        unknown = client.post(
            configs_url,
            headers=ui,
            json={
                "display_name": "Images",
                "enabled": True,
                "price_per_image": None,
                "unknown": True,
            },
        )
        assert unknown.status_code == 400
        created_config = client.post(
            configs_url,
            headers=ui,
            json={"display_name": "Images", "enabled": True},
        )
        assert created_config.status_code == 200
        config = created_config.json()
        config_id = config["provider_config_id"]
        secret_url = f"/api/v1/internal/image-provider-configs/{config_id}/secret"
        assert (
            client.put(secret_url, headers=ui, json={"secret": SECRET_SENTINEL}).status_code == 401
        )
        secret_response = client.put(secret_url, headers=admin, json={"secret": SECRET_SENTINEL})
        assert secret_response.status_code == 200
        assert SECRET_SENTINEL not in secret_response.text
        assert (
            client.get(configs_url, headers=ui).json()["items"][0]["credential_status"]
            == "configured"
        )

        command = {"provider_config_id": config_id, "prompt": PROMPT_SENTINEL, "size": "1024x1024"}
        prepare_url = f"/api/v1/projects/{project_id}/provider-image-generations/prepare"
        prepared_response = client.post(prepare_url, headers=ui, json={**command, "unknown": True})
        assert prepared_response.status_code == 400
        prepared_response = client.post(prepare_url, headers=ui, json=command)
        assert prepared_response.status_code == 200
        assert PROMPT_SENTINEL not in prepared_response.text
        prepared = prepared_response.json()
        create_response = client.post(
            f"/api/v1/projects/{project_id}/provider-image-generations",
            headers=ui,
            json={
                "preview_id": prepared["preview_id"],
                "payload_sha256": prepared["payload_sha256"],
                "confirmed": True,
            },
        )
        assert create_response.status_code == 200
        assert PROMPT_SENTINEL not in create_response.text
        created = create_response.json()
        assert isinstance(
            app.state.core.provider_image_generation.provider, FailOnCallImageProvider
        )
        task = _wait_task(client, ui, created["request"]["request_id"])
        assert task["status"] == "failed"
        assert task["provider_call_count"] == 0
        assert task["provider_may_have_processed"] is False
        assert task["error"] == {
            "code": "IMAGE_PROVIDER_CALL_DISABLED",
            "message": "当前环境未启用真实图片调用",
        }
        get_response = client.get(
            f"/api/v1/provider-image-generations/{created['request']['request_id']}",
            headers=ui,
        )
        assert get_response.status_code == 200
        assert set(get_response.json()) == {
            "request_id",
            "project_id",
            "generation_kind",
            "execution_mode",
            "prompt_sha256",
            "parameters",
            "request_sha256",
            "created_at",
        }
        assert PROMPT_SENTINEL not in get_response.text
        assert (
            client.get(
                f"/api/v1/projects/{project_id}/provider-image-generations", headers=ui
            ).json()["items"][0]["execution_mode"]
            == "provider_image_v1"
        )
        assert (
            client.get(
                f"/api/v1/projects/{project_id}/media-generation-requests", headers=ui
            ).json()["items"]
            == []
        )
        assert client.request("DELETE", secret_url, headers=admin, json={}).status_code == 200
        assert (
            SECRET_SENTINEL not in client.request("DELETE", secret_url, headers=admin, json={}).text
        )

    with app.state.core.db.connection() as sql:
        dump = "\n".join(sql.iterdump())
    assert PROMPT_SENTINEL not in dump
    assert SECRET_SENTINEL not in dump
    assert str(tmp_path.resolve()) not in create_response.text


def test_provider_image_api_retry_pagination_and_stage4a_isolation(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4d-isolation-admin")
    app = create_app(_settings(tmp_path))
    stage4a_prompt = "STAGE4A_PROMPT_ISOLATION_PRIVATE"
    stage4d_prompt = "STAGE4D_PROMPT_ISOLATION_PRIVATE"
    secret = "STAGE4D_SECRET_ISOLATION_PRIVATE"
    responses: list[str] = []

    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage4d-isolation-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "Stage 4A 4D isolation"}
        ).json()["project_id"]

        assert client.portal is not None
        client.portal.call(app.state.core.jobs.stop)

        config = client.post(
            f"/api/v1/projects/{project_id}/image-provider-configs",
            headers=ui,
            json={
                "display_name": "Images",
                "enabled": True,
            },
        ).json()
        config_id = config["provider_config_id"]
        secret_response = client.put(
            f"/api/v1/internal/image-provider-configs/{config_id}/secret",
            headers=admin,
            json={"secret": secret},
        )
        assert secret_response.status_code == 200
        responses.append(secret_response.text)

        stage4d_command = {
            "provider_config_id": config_id,
            "prompt": stage4d_prompt,
            "size": "1024x1024",
        }
        stage4d_prepared_response = client.post(
            f"/api/v1/projects/{project_id}/provider-image-generations/prepare",
            headers=ui,
            json=stage4d_command,
        )
        responses.append(stage4d_prepared_response.text)
        stage4d_prepared = stage4d_prepared_response.json()
        stage4d_created_response = client.post(
            f"/api/v1/projects/{project_id}/provider-image-generations",
            headers=ui,
            json={
                "preview_id": stage4d_prepared["preview_id"],
                "payload_sha256": stage4d_prepared["payload_sha256"],
                "confirmed": True,
            },
        )
        responses.append(stage4d_created_response.text)
        stage4d_created = stage4d_created_response.json()
        stage4d_request_id = stage4d_created["request"]["request_id"]
        stage4d_task_id = stage4d_created["task"]["task_id"]

        cancelled_response = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/cancel",
            headers=ui,
            json={},
        )
        assert cancelled_response.status_code == 200
        responses.append(cancelled_response.text)

        wrong_prompt = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/retry/prepare",
            headers=ui,
            json={"prompt": "different private prompt"},
        )
        assert wrong_prompt.status_code == 409
        assert wrong_prompt.json()["error"]["code"] == "GENERATION_PROMPT_HASH_MISMATCH"
        responses.append(wrong_prompt.text)

        retry_prepared_response = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/retry/prepare",
            headers=ui,
            json={"prompt": stage4d_prompt},
        )
        assert retry_prepared_response.status_code == 200
        responses.append(retry_prepared_response.text)
        retry_prepared = retry_prepared_response.json()
        invalid_retry = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/retry",
            headers=ui,
            json={
                "preview_id": retry_prepared["preview_id"],
                "payload_sha256": "sha256:" + "0" * 64,
                "confirmed": True,
            },
        )
        assert invalid_retry.status_code == 409
        assert invalid_retry.json()["error"]["code"] == "IMAGE_GENERATION_CONFIRMATION_INVALID"
        responses.append(invalid_retry.text)
        retried_response = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/retry",
            headers=ui,
            json={
                "preview_id": retry_prepared["preview_id"],
                "payload_sha256": retry_prepared["payload_sha256"],
                "confirmed": True,
            },
        )
        assert retried_response.status_code == 200
        assert retried_response.json()["retry_of_task_id"] == stage4d_task_id
        responses.append(retried_response.text)
        duplicate_retry = client.post(
            f"/api/v1/provider-image-generation-tasks/{stage4d_task_id}/retry/prepare",
            headers=ui,
            json={"prompt": stage4d_prompt},
        )
        assert duplicate_retry.status_code == 409
        assert duplicate_retry.json()["error"]["code"] == "GENERATION_RETRY_NOT_ALLOWED"
        responses.append(duplicate_retry.text)

        for suffix in ("?limit=0", "?limit=101", "?limit=1&cursor=-1", "?cursor=1.0"):
            request_page = client.get(
                f"/api/v1/projects/{project_id}/provider-image-generations{suffix}",
                headers=ui,
            )
            task_page = client.get(
                f"/api/v1/provider-image-generations/{stage4d_request_id}/tasks{suffix}",
                headers=ui,
            )
            assert request_page.status_code == 400
            assert task_page.status_code == 400
            responses.extend((request_page.text, task_page.text))

        stage4a_command = {
            "generation_kind": "image",
            "prompt": stage4a_prompt,
            "input_refs": ["asset_ref_isolation"],
            "parameters": {"width": 512, "height": 512},
        }
        stage4a_base = f"/api/v1/projects/{project_id}/media-generation-requests"
        stage4a_prepared_response = client.post(
            f"{stage4a_base}/prepare", headers=ui, json=stage4a_command
        )
        responses.append(stage4a_prepared_response.text)
        stage4a_prepared = stage4a_prepared_response.json()
        stage4a_created_response = client.post(
            stage4a_base,
            headers=ui,
            json={**stage4a_command, "request_sha256": stage4a_prepared["request_sha256"]},
        )
        responses.append(stage4a_created_response.text)
        stage4a_created = stage4a_created_response.json()
        stage4a_request_id = stage4a_created["request"]["request_id"]
        stage4a_task_id = stage4a_created["task"]["task_id"]

        cross_request_responses = (
            client.get(f"/api/v1/media-generation-requests/{stage4d_request_id}", headers=ui),
            client.get(f"/api/v1/provider-image-generations/{stage4a_request_id}", headers=ui),
            client.get(
                f"/api/v1/media-generation-requests/{stage4d_request_id}/tasks",
                headers=ui,
            ),
            client.get(
                f"/api/v1/provider-image-generations/{stage4a_request_id}/tasks",
                headers=ui,
            ),
        )
        for response in cross_request_responses:
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "GENERATION_REQUEST_INVALID"
            responses.append(response.text)

        cross_task_responses = (
            client.post(
                f"/api/v1/media-generation-tasks/{stage4d_task_id}/retry",
                headers=ui,
                json={},
            ),
            client.post(
                f"/api/v1/media-generation-tasks/{stage4d_task_id}/cancel",
                headers=ui,
                json={},
            ),
            client.post(
                f"/api/v1/provider-image-generation-tasks/{stage4a_task_id}/retry/prepare",
                headers=ui,
                json={"prompt": stage4d_prompt},
            ),
            client.post(
                f"/api/v1/provider-image-generation-tasks/{stage4a_task_id}/cancel",
                headers=ui,
                json={},
            ),
        )
        for response in cross_task_responses:
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "GENERATION_TASK_NOT_FOUND"
            responses.append(response.text)

    with app.state.core.db.connection() as sql:
        dump = "\n".join(sql.iterdump())
    for sensitive in (stage4a_prompt, stage4d_prompt, secret):
        assert sensitive not in dump
        assert all(sensitive not in response for response in responses)
    assert all(str(tmp_path.resolve()) not in response for response in responses)
