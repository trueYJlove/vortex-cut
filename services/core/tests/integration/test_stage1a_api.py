import json
import sqlite3
from os import replace
from pathlib import Path
from shutil import copyfile

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings


def test_stage1a_project_asset_lifecycle_and_redaction(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-stage1a")
    files = {
        "video": tmp_path / "clip.mp4",
        "audio": tmp_path / "sound.wav",
        "image": tmp_path / "cover.png",
        "text": tmp_path / "notes.txt",
    }
    for path in files.values():
        path.write_bytes(path.name.encode("utf-8"))
    app = create_app(Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing")))

    async def fake_probe(path: Path, require_video: bool = True):
        return {
            "display_name": path.name,
            "format_name": path.suffix[1:],
            "duration_us": 1_000_000,
            "size_bytes": path.stat().st_size,
            "video_streams": [{}] if require_video else [],
            "audio_streams": [],
        }

    app.state.core.ffprobe.probe = fake_probe
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-stage1a"}
        session = client.post("/api/v1/internal/sessions", headers=admin)
        ui = {"Authorization": f"Bearer {session.json()['token']}"}
        created = client.post("/api/v1/projects", headers=ui, json={"name": "First"})
        assert created.status_code == 201
        project_id = created.json()["project_id"]
        assert (
            client.patch(
                f"/api/v1/projects/{project_id}", headers=ui, json={"name": "Renamed"}
            ).json()["name"]
            == "Renamed"
        )
        archived = client.post(f"/api/v1/projects/{project_id}/archive", headers=ui)
        assert archived.json()["status"] == "archived"
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(files["video"])}
        ).json()
        rejected = client.post(
            f"/api/v1/projects/{project_id}/assets",
            headers=ui,
            json={"grant_id": grant["grant_id"]},
        )
        assert rejected.status_code == 409
        assert rejected.json()["error"]["code"] == "PROJECT_ARCHIVED"
        reopened = client.post(f"/api/v1/projects/{project_id}/reopen", headers=ui)
        assert reopened.json()["status"] == "active"

        assets = []
        for kind, path in files.items():
            grant = client.post(
                "/api/v1/internal/file-grants", headers=admin, json={"path": str(path)}
            ).json()
            response = client.post(
                f"/api/v1/projects/{project_id}/assets",
                headers=ui,
                json={"grant_id": grant["grant_id"], "kind": kind},
            )
            assert response.status_code == 201
            assets.append((response.json()["asset_id"], path, response.json()["fingerprint"]))

        video_grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(files["video"])}
        ).json()
        probed = client.post(
            "/api/v1/media/probe",
            headers=ui,
            json={"grant_id": video_grant["grant_id"]},
        )
        assert probed.status_code == 200
        created_job = client.post(
            "/api/v1/jobs/proxy",
            headers=ui,
            json={"media_id": probed.json()["media_id"], "duration_us": 500_000},
        )
        assert created_job.status_code == 200
        job = created_job.json()
        assert job["project_id"] == project_id
        with client.app.state.core.db.connection() as db:
            stored_project_id = db.execute(
                "SELECT project_id FROM jobs WHERE id=?", (job["job_id"],)
            ).fetchone()[0]
        assert stored_project_id == project_id
        project_jobs = client.get(f"/api/v1/projects/{project_id}/jobs", headers=ui)
        assert project_jobs.status_code == 200
        assert any(item["job_id"] == job["job_id"] for item in project_jobs.json()["items"])
        with client.app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "job_cancel_project",
                    project_id,
                    "asset_probe",
                    "asset_probe",
                    "running",
                    "running",
                    0,
                    "{}",
                    1,
                    "2026-08-09T00:00:00.000Z",
                    "2026-08-09T00:00:00.000Z",
                ),
            )
        cancelled = client.post("/api/v1/jobs/job_cancel_project/cancel", headers=ui)
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelling"

        duplicate_grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(files["video"])}
        ).json()
        duplicate = client.post(
            f"/api/v1/projects/{project_id}/assets",
            headers=ui,
            json={"grant_id": duplicate_grant["grant_id"]},
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "ASSET_DUPLICATE"

        video_id, video_path, original_fingerprint = assets[0]
        video_path.write_bytes(b"changed")
        refreshed = client.post(f"/api/v1/assets/{video_id}/refresh", headers=ui)
        assert refreshed.json()["availability"] == "changed"
        video_path.unlink()
        refreshed = client.post(f"/api/v1/assets/{video_id}/refresh", headers=ui)
        assert refreshed.json()["availability"] == "missing"
        relocated = tmp_path / "relocated.mp4"
        relocated.write_bytes(b"clip.mp4")
        relocate_grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(relocated)}
        ).json()
        relocated_asset = client.post(
            f"/api/v1/assets/{video_id}/relocate",
            headers=ui,
            json={"grant_id": relocate_grant["grant_id"]},
        )
        assert relocated_asset.status_code == 200
        assert relocated_asset.json()["fingerprint"] == original_fingerprint

        project_list = client.get("/api/v1/projects", headers=ui).json()
        asset_list = client.get(f"/api/v1/projects/{project_id}/assets", headers=ui).json()
        assert len(project_list["items"]) == 1
        assert len(asset_list["items"]) == 4
        serialized = json.dumps({"project": project_list, "assets": asset_list})
        assert str(tmp_path) not in serialized
        assert "admin-stage1a" not in serialized

    with sqlite3.connect(tmp_path / "app.db") as db:
        # Later stages only append migrations; the 1A lifecycle must still migrate cleanly.
        assert db.execute(
            "SELECT version FROM schema_migrations ORDER BY CAST(SUBSTR(version,2) AS INTEGER)"
        ).fetchall() == [
            ("v1",),
            ("v2",),
            ("v3",),
            ("v4",),
            ("v5",),
            ("v6",),
            ("v7",),
            ("v8",),
            ("v9",),
            ("v10",),
            ("v11",),
            ("v12",),
            ("v13",),
            ("v14",),
            ("v15",),
        ]
    assert list((tmp_path / "backups").glob("app-*.db"))


def test_core_restart_recovers_running_job(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-restart")
    settings = Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing"))
    with TestClient(create_app(settings)) as first:
        admin = {"Authorization": "Bearer admin-restart"}
        token = first.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        project = first.post("/api/v1/projects", headers=ui, json={"name": "Restart"}).json()
        now = "2026-08-09T00:00:00.000Z"
        with first.app.state.core.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "job_restart",
                    project["project_id"],
                    "asset_probe",
                    "asset_probe",
                    "running",
                    "running",
                    0,
                    "{}",
                    1,
                    now,
                    now,
                ),
            )

    with TestClient(create_app(settings)) as second:
        admin = {"Authorization": "Bearer admin-restart"}
        token = second.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        ui = {"Authorization": f"Bearer {token}"}
        recovered = second.get("/api/v1/jobs/job_restart", headers=ui)
        assert recovered.status_code == 200
        assert recovered.json()["status"] == "interrupted"
        assert recovered.json()["error"]["code"] == "JOB_INTERRUPTED"
        project_jobs = second.get(f"/api/v1/projects/{project['project_id']}/jobs", headers=ui)
        assert project_jobs.status_code == 200
        assert any(item["job_id"] == "job_restart" for item in project_jobs.json()["items"])


def test_refresh_detects_real_video_replacement_and_missing_file(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-refresh")
    root = Path.cwd()
    original = root / "test-assets" / "generated" / "cfr-landscape-av.mp4"
    replacement = root / "test-assets" / "generated" / "short-odd-size.mp4"
    assert original.is_file() and replacement.is_file()
    target = tmp_path / "clip.mp4"
    copyfile(original, target)
    settings = Settings(
        data_dir=tmp_path / "data",
        ffmpeg=root / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe",
        ffprobe=root / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe",
    )
    with TestClient(create_app(settings)) as client:
        admin = {"Authorization": "Bearer admin-refresh"}
        ui = {
            "Authorization": (
                f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"
            )
        }
        project_id = client.post(
            "/api/v1/projects", headers=ui, json={"name": "real refresh"}
        ).json()["project_id"]
        grant_id = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(target)}
        ).json()["grant_id"]
        imported = client.post(
            f"/api/v1/projects/{project_id}/assets",
            headers=ui,
            json={"grant_id": grant_id, "kind": "video"},
        )
        assert imported.status_code == 201, imported.text
        original_asset = imported.json()
        original_stat = target.stat()
        replacement_staging = tmp_path / "replacement.mp4"
        copyfile(replacement, replacement_staging)
        replace(replacement_staging, target)
        replacement_stat = target.stat()
        assert replacement_stat.st_size != original_stat.st_size
        refreshed = client.post(f"/api/v1/assets/{original_asset['asset_id']}/refresh", headers=ui)
        assert refreshed.status_code == 200, refreshed.text
        changed = refreshed.json()
        assert changed["availability"] == "changed"
        assert changed["fingerprint"] != original_asset["fingerprint"]
        assert changed["size_bytes"] == replacement_stat.st_size
        target.unlink()
        missing = client.post(f"/api/v1/assets/{original_asset['asset_id']}/refresh", headers=ui)
        assert missing.status_code == 200
        assert missing.json()["availability"] == "missing"


def test_sidecar_restart_auth_isolates_ui_tokens_and_allows_new_project(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-auth-restart")
    settings = Settings(data_dir=tmp_path, ffmpeg=Path("missing"), ffprobe=Path("missing"))
    admin = {"Authorization": "Bearer admin-auth-restart"}
    with TestClient(create_app(settings)) as first:
        first_ui_token = first.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        first_ui = {"Authorization": f"Bearer {first_ui_token}"}
        before = first.post("/api/v1/projects", headers=first_ui, json={"name": "before"})
        wrong_scope = first.post("/api/v1/projects", headers=admin, json={"name": "wrong scope"})
        assert before.status_code == 201
        assert wrong_scope.status_code == 401
    with TestClient(create_app(settings)) as restarted:
        old_ui = {"Authorization": f"Bearer {first_ui_token}"}
        stale = restarted.post("/api/v1/projects", headers=old_ui, json={"name": "stale"})
        assert stale.status_code == 401
        fresh_ui_token = restarted.post("/api/v1/internal/sessions", headers=admin).json()["token"]
        fresh_ui = {"Authorization": f"Bearer {fresh_ui_token}"}
        created = restarted.post("/api/v1/projects", headers=fresh_ui, json={"name": "after"})
        assert created.status_code == 201, created.text
