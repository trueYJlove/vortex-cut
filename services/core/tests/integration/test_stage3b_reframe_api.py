from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


class _Snapshots:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, list[dict[str, Any]]]] = []

    def create_or_reuse(
        self, project_id: str, base_snapshot_id: str, adjustments: list[dict[str, Any]]
    ) -> dict[str, Any]:
        self.calls.append((project_id, base_snapshot_id, adjustments))
        return {
            "timeline_revision_id": "revision_1",
            "rendition_reframe_snapshot_id": "rendition_reframe_snapshot_1",
        }


class _Renders:
    async def create_reframe_preview(
        self,
        project_id: str,
        revision_id: str,
        snapshot_id: str,
        encoder_mode: str,
    ) -> dict[str, Any]:
        assert (project_id, revision_id, snapshot_id, encoder_mode) == (
            "project_1",
            "revision_1",
            "rendition_reframe_snapshot_1",
            "software",
        )
        return {
            "job": {"job_id": "job_1", "status": "queued"},
            "preview": None,
            "reused": False,
        }

    def list_reframe_previews(
        self, project_id: str, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        assert (project_id, limit, cursor) == ("project_1", 20, None)
        return [], None


class _Batches:
    def __init__(self) -> None:
        self.created: tuple[str, str, list[dict[str, Any]]] | None = None

    async def create(
        self, project_id: str, grant_id: str, items: list[dict[str, Any]]
    ) -> dict[str, Any]:
        self.created = (project_id, grant_id, items)
        return {"batch": {"reframe_export_batch_id": "reframe_export_batch_1"}, "jobs": []}

    def list(self, project_id: str) -> list[dict[str, Any]]:
        assert project_id == "project_1"
        return []

    def get(self, batch_id: str) -> dict[str, Any]:
        return {"reframe_export_batch_id": batch_id}

    async def cancel(self, batch_id: str) -> dict[str, Any]:
        return {"reframe_export_batch_id": batch_id, "status": "cancelled"}

    async def retry(self, batch_id: str, grant_id: str, item_ids: list[str]) -> dict[str, Any]:
        return {
            "batch": {
                "reframe_export_batch_id": "reframe_export_batch_retry",
                "retry_of_batch_id": batch_id,
                "grant": grant_id,
                "items": item_ids,
            },
            "jobs": [],
        }


def _ui(client: TestClient) -> dict[str, str]:
    session = client.post(
        "/api/v1/internal/sessions",
        headers={"Authorization": "Bearer stage3b-admin"},
    )
    assert session.status_code == 200
    return {"Authorization": f"Bearer {session.json()['token']}"}


def test_stage3b_api_is_independent_strict_and_has_no_revision_input(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "stage3b-admin")
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))
    snapshots, batches = _Snapshots(), _Batches()
    app.state.core.rendition_reframe_snapshots = snapshots
    app.state.core.renders = _Renders()
    app.state.core.reframe_export_batches = batches
    with TestClient(app) as client:
        ui = _ui(client)
        preview = client.post(
            "/api/v1/projects/project_1/rendition-reframe-previews",
            headers=ui,
            json={
                "base_rendition_snapshot_id": "rendition_snapshot_1",
                "adjustments": [
                    {
                        "clip_id": "clip_1",
                        "horizontal_anchor": "right",
                        "vertical_anchor": "top",
                    }
                ],
                "encoder_mode": "software",
            },
        )
        assert preview.status_code == 200
        assert preview.json()["reused"] is False
        assert snapshots.calls[0][1] == "rendition_snapshot_1"
        assert client.get(
            "/api/v1/projects/project_1/rendition-reframe-previews?limit=20",
            headers=ui,
        ).json() == {"items": [], "next_cursor": None}
        batch_input = {
            "directory_grant_id": "directory_grant_1",
            "items": [
                {
                    "rendition_reframe_snapshot_id": "rendition_reframe_snapshot_1",
                    "preview_artifact_id": "artifact_1",
                }
            ],
        }
        created = client.post(
            "/api/v1/projects/project_1/reframe-export-batches",
            headers=ui,
            json=batch_input,
        )
        assert created.status_code == 200
        assert batches.created == (
            "project_1",
            "directory_grant_1",
            [
                {
                    "rendition_reframe_snapshot_id": "rendition_reframe_snapshot_1",
                    "preview_artifact_id": "artifact_1",
                    "encoder_mode": "auto",
                }
            ],
        )
        assert (
            client.get(
                "/api/v1/reframe-export-batches/reframe_export_batch_1", headers=ui
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/reframe-export-batches/reframe_export_batch_1/cancel", headers=ui
            ).json()["status"]
            == "cancelled"
        )
        retry = client.post(
            "/api/v1/reframe-export-batches/reframe_export_batch_1/retry",
            headers=ui,
            json={
                "directory_grant_id": "directory_grant_2",
                "reframe_export_batch_item_ids": ["reframe_export_batch_item_1"],
            },
        )
        assert retry.status_code == 200
        assert retry.json()["batch"]["retry_of_batch_id"] == "reframe_export_batch_1"
        forbidden = client.post(
            "/api/v1/projects/project_1/reframe-export-batches",
            headers=ui,
            json=batch_input | {"timeline_revision_id": "revision_injected"},
        )
        assert forbidden.status_code == 400
        assert forbidden.json()["error"]["code"] == "VALIDATION_ERROR"
        unknown = client.post(
            "/api/v1/projects/project_1/rendition-reframe-previews",
            headers=ui,
            json={
                "base_rendition_snapshot_id": "rendition_snapshot_1",
                "adjustments": [],
                "absolute_path": str(tmp_path),
            },
        )
        assert unknown.status_code == 400
        assert str(tmp_path) not in str(unknown.json())
        with app.state.core.db.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0] == 0
