from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings

PROMPT_SENTINEL = "PROMPT_SENTINEL_API_4A"
RESOURCES = Path(__file__).resolve().parents[4] / "resources"


def _wait_task(client: TestClient, headers: dict[str, str], request_id: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        page = client.get(
            f"/api/v1/media-generation-requests/{request_id}/tasks", headers=headers
        ).json()
        task = page["items"][-1]
        if task["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return task
        time.sleep(0.02)
    raise AssertionError("generation task did not finish")


def test_media_generation_api_lifecycle_is_safe_and_provider_free(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4a-admin")
    app = create_app(
        Settings(
            data_dir=tmp_path,
            ffmpeg=Path("missing"),
            ffprobe=Path("missing"),
            manifest_dir=RESOURCES / "model-manifests",
            font_dir=RESOURCES / "fonts",
            recipe_dir=RESOURCES / "recipes",
        )
    )
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer stage4a-admin"}
        token = client.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 4A"}).json()
        project_id = project["project_id"]
        command = {
            "generation_kind": "image",
            "prompt": PROMPT_SENTINEL,
            "input_refs": ["asset_ref_1"],
            "parameters": {"width": 512, "height": 512, "seed": 1},
        }
        prepared_response = client.post(
            f"/api/v1/projects/{project_id}/media-generation-requests/prepare",
            headers=ui,
            json=command,
        )
        assert prepared_response.status_code == 200
        prepared = prepared_response.json()
        assert PROMPT_SENTINEL not in prepared_response.text
        created_response = client.post(
            f"/api/v1/projects/{project_id}/media-generation-requests",
            headers=ui,
            json={**command, "request_sha256": prepared["request_sha256"]},
        )
        assert created_response.status_code == 200
        assert PROMPT_SENTINEL not in created_response.text
        created = created_response.json()
        request_id = created["request"]["request_id"]
        task = _wait_task(client, ui, request_id)
        assert task["status"] == "succeeded"
        assert task["result_summary"] == {
            "execution_mode": "simulation_only",
            "outcome": "validated_without_media",
            "provider_call_count": 0,
        }
        assert (
            client.get(
                f"/api/v1/projects/{project_id}/media-generation-requests", headers=ui
            ).json()["items"][0]["request_id"]
            == request_id
        )
        assert (
            client.get(f"/api/v1/media-generation-requests/{request_id}", headers=ui).status_code
            == 200
        )
        generic_cancel = client.post(f"/api/v1/jobs/{task['job_id']}/cancel", headers=ui)
        assert generic_cancel.status_code == 409
        assert generic_cancel.json()["error"]["code"] == "JOB_INVALID_STATE"
    with app.state.core.db.connection() as db:
        generation_rows = [
            *db.execute("SELECT * FROM media_generation_requests"),
            *db.execute("SELECT * FROM media_generation_tasks"),
            *db.execute("SELECT input_json,result_json FROM jobs WHERE kind='media_generation'"),
        ]
    generation_dump = repr([tuple(row) for row in generation_rows])
    assert PROMPT_SENTINEL not in generation_dump
    assert str(tmp_path.resolve()) not in generation_dump


def test_media_generation_api_validation_cancel_retry_and_errors(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage4a-admin")
    app = create_app(
        Settings(
            data_dir=tmp_path,
            ffmpeg=Path("x"),
            ffprobe=Path("x"),
            manifest_dir=RESOURCES / "model-manifests",
            font_dir=RESOURCES / "fonts",
            recipe_dir=RESOURCES / "recipes",
        )
    )
    with TestClient(app) as client:
        token = client.post(
            "/api/v1/internal/sessions",
            headers={"Authorization": "Bearer stage4a-admin"},
        ).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project_id = client.post("/api/v1/projects", headers=ui, json={"name": "Stage 4A"}).json()[
            "project_id"
        ]
        base = f"/api/v1/projects/{project_id}/media-generation-requests"
        unsupported = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "generation_kind": "video",
                "prompt": "safe",
                "input_refs": ["ref"],
                "parameters": {},
            },
        )
        assert unsupported.status_code == 400
        assert unsupported.json()["error"]["code"] == "GENERATION_KIND_UNSUPPORTED"
        unknown = client.post(
            f"{base}/prepare",
            headers=ui,
            json={
                "generation_kind": "image",
                "prompt": "safe",
                "input_refs": ["ref"],
                "parameters": {"width": 512, "height": 512},
                "unknown": True,
            },
        )
        assert unknown.status_code == 400
        command = {
            "generation_kind": "image",
            "prompt": "safe",
            "input_refs": ["ref"],
            "parameters": {"width": 512, "height": 512},
        }
        prepared = client.post(f"{base}/prepare", headers=ui, json=command).json()
        mismatch = client.post(
            base,
            headers=ui,
            json={**command, "request_sha256": "sha256:" + "0" * 64},
        )
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "GENERATION_HASH_MISMATCH"
        # Pause the scheduler so queued-only cancel has deterministic API coverage.
        assert client.portal is not None
        client.portal.call(app.state.core.jobs.stop)
        created = app.state.core.media_generation.create(
            project_id,
            command["generation_kind"],
            command["prompt"],
            command["input_refs"],
            command["parameters"],
            prepared["request_sha256"],
        )
        task_id = created["task"]["task_id"]
        cancelled = client.post(
            f"/api/v1/media-generation-tasks/{task_id}/cancel", headers=ui, json={}
        )
        assert cancelled.status_code == 200
        retried = client.post(
            f"/api/v1/media-generation-tasks/{task_id}/retry", headers=ui, json={}
        )
        assert retried.status_code == 200
        assert retried.json()["retry_of_task_id"] == task_id
        duplicate = client.post(
            f"/api/v1/media-generation-tasks/{task_id}/retry", headers=ui, json={}
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "GENERATION_RETRY_NOT_ALLOWED"
        missing = client.post(
            "/api/v1/media-generation-tasks/missing_task/retry", headers=ui, json={}
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "GENERATION_TASK_NOT_FOUND"
