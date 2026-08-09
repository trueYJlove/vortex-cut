from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from aivs_core.app import create_app
from aivs_core.config import Settings


def test_core_api_auth_grant_probe_job_and_websocket(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-test")
    settings = Settings(
        data_dir=tmp_path, ffmpeg=Path("missing-ffmpeg"), ffprobe=Path("missing-ffprobe")
    )
    media = tmp_path / "sample.mp4"
    media.write_bytes(b"fake media")
    app = create_app(settings)
    fake_probe = {
        "display_name": media.name,
        "format_name": "mp4",
        "duration_us": 2_000_000,
        "size_bytes": media.stat().st_size,
        "video_streams": [
            {
                "index": 0,
                "codec": "h264",
                "width": 640,
                "height": 360,
                "avg_frame_rate_num": 30,
                "avg_frame_rate_den": 1,
                "rotation": 0,
                "pixel_format": "yuv420p",
            }
        ],
        "audio_streams": [],
        "warnings": [],
    }

    async def probe(_path):
        return fake_probe

    app.state.core.ffprobe.probe = probe

    async def capabilities():
        return {
            "available_encoders": ["libopenh264"],
            "default_encoder": "libopenh264",
            "fallback_reason": None,
        }

    app.state.core.encoders.capabilities = capabilities
    with TestClient(app) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/api/v1/internal/health").status_code == 401
        admin = {"Authorization": "Bearer admin-test"}
        session = client.post("/api/v1/internal/sessions", headers=admin)
        assert session.status_code == 200
        ui_token = session.json()["token"]
        ui = {"Authorization": f"Bearer {ui_token}"}
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(media)}
        )
        assert grant.status_code == 200
        grant_id = grant.json()["grant_id"]
        probed = client.post("/api/v1/media/probe", headers=ui, json={"grant_id": grant_id})
        assert probed.status_code == 200
        media_id = probed.json()["media_id"]
        created = client.post(
            "/api/v1/jobs/vertical-sample",
            headers=ui,
            json={"media_id": media_id, "duration_us": 1_000_000},
        )
        assert created.status_code == 200
        proxy = client.post(
            "/api/v1/jobs/proxy",
            headers=ui,
            json={"media_id": media_id, "encoder_mode": "software"},
        )
        assert proxy.status_code == 200
        assert proxy.json()["job_id"]
        job_id = created.json()["job_id"]
        assert client.get("/api/v1/jobs", headers=ui).status_code == 200
        assert client.get(f"/api/v1/jobs/{job_id}", headers=ui).status_code == 200
        assert client.post(f"/api/v1/jobs/{job_id}/cancel", headers=ui).status_code == 200
        assert client.get("/api/v1/system/capabilities", headers=ui).status_code in {200, 500}
        with client.websocket_connect("/api/v1/events") as websocket:
            websocket.send_json({"type": "authenticate", "token": ui_token})
            event = websocket.receive_json()
            assert event["type"] == "system.ready"
            assert event["payload"]["protocol_version"] == 1


def test_core_api_error_paths_and_websocket_rejection(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-test")
    settings = Settings(
        data_dir=tmp_path, ffmpeg=Path("missing-ffmpeg"), ffprobe=Path("missing-ffprobe")
    )
    media = tmp_path / "sample.mp4"
    media.write_bytes(b"fake media")
    app = create_app(settings)

    async def failed_probe(_path):
        raise RuntimeError("MEDIA_UNSUPPORTED")

    app.state.core.ffprobe.probe = failed_probe
    with TestClient(app) as client:
        admin = {"Authorization": "Bearer admin-test"}
        assert client.get("/api/v1/internal/health", headers=admin).status_code == 200
        assert client.post("/api/v1/internal/sessions").status_code == 401
        assert client.get("/api/v1/system/capabilities").status_code == 401
        session = client.post("/api/v1/internal/sessions", headers=admin).json()
        ui = {"Authorization": f"Bearer {session['token']}"}

        missing = client.post(
            "/api/v1/internal/file-grants",
            headers=admin,
            json={"path": str(tmp_path / "missing.mp4")},
        )
        assert missing.status_code == 400
        assert missing.json()["error"]["code"] == "MEDIA_NOT_FOUND"
        directory = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(tmp_path)}
        )
        assert directory.status_code == 400
        assert directory.json()["error"]["code"] == "MEDIA_UNSUPPORTED"
        assert (
            client.post("/api/v1/media/probe", headers=ui, json={"grant_id": "unknown"}).status_code
            == 404
        )
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(media)}
        ).json()
        probe = client.post("/api/v1/media/probe", headers=ui, json={"grant_id": grant["grant_id"]})
        assert probe.status_code == 400
        assert probe.json()["error"]["code"] == "MEDIA_UNSUPPORTED"
        assert client.get("/api/v1/jobs/unknown", headers=ui).status_code == 404
        assert client.post("/api/v1/jobs/unknown/cancel", headers=ui).status_code == 404
        assert (
            client.get("/api/v1/internal/artifacts/unknown/resolve", headers=admin).status_code
            == 404
        )
        shutdown = client.post("/api/v1/internal/shutdown", headers=admin).json()
        assert shutdown["status"] == "shutting_down"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/v1/events") as websocket:
                websocket.send_json({"type": "authenticate", "token": "invalid"})
                websocket.receive_text()


@pytest.mark.asyncio
async def test_core_emit_removes_dead_websocket(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-test")
    app = create_app(Settings(data_dir=tmp_path))

    class DeadSocket:
        async def send_json(self, _message):
            raise RuntimeError("closed")

    dead = DeadSocket()
    app.state.core.connections.add(dead)
    await app.state.core.emit({"type": "test"})
    assert dead not in app.state.core.connections
