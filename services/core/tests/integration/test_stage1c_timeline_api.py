from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.database import json_dumps


def _app(tmp_path: Path, monkeypatch) -> tuple[TestClient, Settings]:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-stage1c")
    manifest_dir = tmp_path / "manifests"
    manifest_dir.mkdir(exist_ok=True)
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=manifest_dir,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
    )
    return TestClient(create_app(settings)), settings


def _ui(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/internal/sessions",
        headers={"Authorization": "Bearer admin-stage1c"},
    )
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _seed(client: TestClient, project_id: str) -> None:
    database = client.app.state.core.db
    with database.connection() as db:
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('video-api',?,'video','external','video.mp4','fp-api',1,'available',"
            "?,'now','now')",
            (
                project_id,
                json_dumps(
                    {
                        "duration_us": 2_000_000,
                        "video_streams": [{}],
                        "audio_streams": [{}],
                    }
                ),
            ),
        )
        db.execute(
            "INSERT INTO transcripts(id,asset_id,status,language,provider,model_id,"
            "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
            "VALUES ('transcript-api','video-api','ready','zh','test','m','r','fp-api',"
            "2000000,'now','now')"
        )
        db.execute(
            "INSERT INTO transcript_segments(id,transcript_id,ordinal,start_us,end_us,text,"
            "confidence) VALUES "
            "('segment-api','transcript-api',0,200000,1200000,'原始文本',0.9)"
        )


def test_all_timeline_routes_errors_and_restart_persistence(tmp_path: Path, monkeypatch) -> None:
    client, settings = _app(tmp_path, monkeypatch)
    with client:
        ui = _ui(client)
        project = client.post(
            "/api/v1/projects", json={"name": "阶段 1C"}, headers=ui
        ).json()
        project_id = project["project_id"]
        missing = client.get(f"/api/v1/projects/{project_id}/timeline", headers=ui)
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "TIMELINE_NOT_FOUND"
        _seed(client, project_id)
        created = client.post(
            f"/api/v1/projects/{project_id}/timelines",
            headers=ui,
            json={
                "schema_version": 1,
                "source": {
                    "kind": "transcript_selection",
                    "transcript_id": "transcript-api",
                    "segment_ids": ["segment-api"],
                    "padding_before_us": 100_000,
                    "padding_after_us": 100_000,
                    "create_captions": True,
                },
                "default_layout": "blurred_background",
                "caption_preset_id": "default-bottom",
            },
        )
        assert created.status_code == 201
        state = created.json()
        revision_id = state["current_revision"]["timeline_revision_id"]
        caption_id = state["current_revision"]["document"]["captions"][0]["caption_id"]
        draft = client.put(
            f"/api/v1/projects/{project_id}/timeline/draft",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": revision_id,
                "document": state["current_revision"]["document"],
            },
        )
        assert draft.status_code == 200
        patched = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": revision_id,
                "operations": [
                    {
                        "op": "update_caption",
                        "caption_id": caption_id,
                        "text": "仅修改 Timeline 字幕",
                    }
                ],
                "summary": "修改字幕",
            },
        )
        assert patched.status_code == 200
        patched_state = patched.json()
        patched_id = patched_state["current_revision"]["timeline_revision_id"]
        assert patched_state["draft"]["conflict"] is True
        conflict = client.post(
            f"/api/v1/projects/{project_id}/timeline/patches",
            headers=ui,
            json={
                "schema_version": 1,
                "base_revision_id": revision_id,
                "operations": [{"op": "remove_caption", "caption_id": caption_id}],
                "summary": "冲突修改",
            },
        )
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "TIMELINE_CONFLICT"
        undo = client.post(
            f"/api/v1/projects/{project_id}/timeline/undo",
            headers=ui,
            json={"base_revision_id": patched_id},
        )
        assert undo.status_code == 200
        redo = client.post(
            f"/api/v1/projects/{project_id}/timeline/redo",
            headers=ui,
            json={"base_revision_id": revision_id},
        )
        assert redo.status_code == 200
        revisions = client.get(
            f"/api/v1/projects/{project_id}/timeline/revisions?limit=1", headers=ui
        )
        assert revisions.status_code == 200
        assert len(revisions.json()["items"]) == 1
        revision = client.get(f"/api/v1/timeline-revisions/{patched_id}", headers=ui)
        assert revision.status_code == 200
        assert revision.json()["document"]["captions"][0]["text"] == "仅修改 Timeline 字幕"
        with client.app.state.core.db.connection() as db:
            assert db.execute(
                "SELECT text FROM transcript_segments WHERE id='segment-api'"
            ).fetchone()[0] == "原始文本"
        deleted = client.delete(
            f"/api/v1/projects/{project_id}/timeline/draft", headers=ui
        )
        assert deleted.status_code == 204

    restarted = TestClient(create_app(settings))
    with restarted:
        restarted_ui = _ui(restarted)
        state = restarted.get(
            f"/api/v1/projects/{project_id}/timeline", headers=restarted_ui
        )
        assert state.status_code == 200
        assert state.json()["current_revision"]["timeline_revision_id"] == patched_id
        assert state.json()["draft"] is None


def test_internal_asset_resolve_is_admin_only_and_persistent(tmp_path: Path, monkeypatch) -> None:
    media = tmp_path / "播放素材.mp4"
    media.write_bytes(b"stable-media")
    client, settings = _app(tmp_path, monkeypatch)

    async def fake_probe(path: Path, require_video: bool = True):
        return {
            "display_name": path.name,
            "format_name": "mp4",
            "duration_us": 1_000_000,
            "size_bytes": path.stat().st_size,
            "video_streams": [{}],
            "audio_streams": [],
        }

    client.app.state.core.ffprobe.probe = fake_probe
    admin = {"Authorization": "Bearer admin-stage1c"}
    with client:
        ui = _ui(client)
        project_id = client.post(
            "/api/v1/projects", json={"name": "Resolve"}, headers=ui
        ).json()["project_id"]
        grant = client.post(
            "/api/v1/internal/file-grants", json={"path": str(media)}, headers=admin
        ).json()
        asset = client.post(
            f"/api/v1/projects/{project_id}/assets",
            json={"grant_id": grant["grant_id"], "kind": "video"},
            headers=ui,
        ).json()
        asset_id = asset["asset_id"]
        endpoint = f"/api/v1/internal/assets/{asset_id}/resolve"
        assert client.get(endpoint).status_code == 401
        assert client.get(endpoint, headers=ui).status_code == 401
        resolved = client.get(endpoint, headers=admin)
        assert resolved.status_code == 200
        assert resolved.json() == {"asset_id": asset_id, "path": str(media.resolve())}
        serialized = str(client.get(f"/api/v1/assets/{asset_id}", headers=ui).json())
        assert str(media.resolve()) not in serialized

    restarted = TestClient(create_app(settings))
    with restarted:
        resolved = restarted.get(endpoint, headers=admin)
        assert resolved.status_code == 200
        assert resolved.json()["path"] == str(media.resolve())
        media.write_bytes(b"changed-media")
        changed = restarted.get(endpoint, headers=admin)
        assert changed.status_code == 409
        assert changed.json()["error"]["code"] == "ASSET_CHANGED"
        missing = restarted.get(
            "/api/v1/internal/assets/missing/resolve", headers=admin
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "ASSET_NOT_FOUND"
