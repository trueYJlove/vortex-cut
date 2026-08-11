from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from aivs_core.app import create_app
from aivs_core.config import Settings
from aivs_core.transcription import TranscriptResult, TranscriptSegmentResult, TranscriptWordResult


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest_dir(tmp_path: Path) -> Path:
    """Build a tiny local model manifest whose files are downloadable via file:// URLs."""
    source = tmp_path / "model-src"
    source.mkdir()
    files = {"config.json": b"{}", "model.bin": b"\x00" * 64}
    manifest_files = []
    for name, content in files.items():
        (source / name).write_bytes(content)
        manifest_files.append(
            {
                "path": name,
                "size_bytes": len(content),
                "sha256": sha256_bytes(content),
                "url": (source / name).as_uri(),
            }
        )
    total = sum(item["size_bytes"] for item in manifest_files)
    manifest = {
        "model_id": "whisper-tiny",
        "provider": "faster-whisper",
        "revision": "rev1",
        "display_name": "Whisper Tiny",
        "purpose": "asr",
        "download_url": None,
        "trusted_source_id": "test-source",
        "size_bytes": total,
        "installed_size_bytes": total,
        "sha256": sha256_bytes(
            b"".join(source.joinpath(name).read_bytes() for name in files)
        ),
        "license": {
            "id": "mit",
            "name": "MIT",
            "url": None,
            "attribution": None,
            "acceptance_required": False,
        },
        "supported_languages": ["auto", "zh", "en"],
        "supports_word_timestamps": True,
        "runtime_version": "faster-whisper>=1.0",
        "runtime_requirements": {"python": ">=3.12"},
        "files": manifest_files,
        "created_at": "2026-08-10T00:00:00.000Z",
    }
    manifest_dir = tmp_path / "manifests"
    manifest_dir.mkdir()
    (manifest_dir / "whisper-tiny.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return manifest_dir


class FakeAsrProvider:
    async def transcribe(
        self,
        audio_uri,
        language,
        model_id,
        model_dir,
        word_timestamps,
        cancel_token,
        progress_callback,
    ):
        progress_callback(1.0)
        words = (
            (
                TranscriptWordResult(0, 500_000, "你好", 0.95),
                TranscriptWordResult(500_000, 1_000_000, "世界", 0.9),
            )
            if word_timestamps
            else ()
        )
        return TranscriptResult(
            language="zh",
            duration_us=1_000_000,
            segments=(
                TranscriptSegmentResult(0, 1_000_000, "你好世界", 0.9, words),
            ),
        )


def _setup_client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "admin-stage1b")
    settings = Settings(
        data_dir=tmp_path,
        manifest_dir=_manifest_dir(tmp_path),
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
    )
    app = create_app(settings)

    async def fake_probe(path: Path, require_video: bool = True):
        return {
            "display_name": path.name,
            "format_name": path.suffix[1:],
            "duration_us": 1_000_000,
            "size_bytes": path.stat().st_size,
            "video_streams": [],
            "audio_streams": [{}],
        }

    app.state.core.ffprobe.probe = fake_probe
    app.state.core.asr.provider = FakeAsrProvider()
    return TestClient(app)


def _wait_until(predicate, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError("condition not met within timeout")


def test_stage1b_model_and_transcription_api(tmp_path: Path, monkeypatch):
    with _setup_client(tmp_path, monkeypatch) as client:
        admin = {"Authorization": "Bearer admin-stage1b"}
        ui = {
            "Authorization": (
                f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"
            )
        }

        # --- model list + detail ---
        models = client.get("/api/v1/models", headers=ui).json()
        assert any(item["model_id"] == "whisper-tiny" for item in models["items"])
        detail = client.get("/api/v1/models/whisper-tiny", headers=ui).json()
        assert detail["status"] == "unavailable"
        assert detail["local_only"] is True

        # --- download -> ready via the async job worker ---
        downloaded = client.post("/api/v1/models/whisper-tiny/download", headers=ui, json={})
        assert downloaded.status_code == 200
        job = downloaded.json()["job"]
        assert job["kind"] == "model_download"
        _wait_until(
            lambda: client.get("/api/v1/models/whisper-tiny/download", headers=ui).json()["model"][
                "status"
            ]
            == "ready"
        )
        ready = client.get("/api/v1/models/whisper-tiny/download", headers=ui).json()
        assert ready["job"]["status"] == "succeeded"
        assert ready["model"]["status"] == "ready"
        install_dir = client.app.state.core.model_manager.ready_path("whisper-tiny")
        assert (install_dir / "model.bin").read_bytes() == b"\x00" * 64

        # --- import audio asset ---
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"audio data")
        project = client.post("/api/v1/projects", headers=ui, json={"name": "1B"}).json()
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(audio)}
        ).json()
        asset = client.post(
            f"/api/v1/projects/{project['project_id']}/assets",
            headers=ui,
            json={"grant_id": grant["grant_id"], "kind": "audio"},
        )
        assert asset.status_code == 201
        assert asset.json()["availability"] == "available"
        asset_id = asset.json()["asset_id"]

        # --- create transcription job ---
        created = client.post(
            f"/api/v1/assets/{asset_id}/transcription",
            headers=ui,
            json={"model_id": "whisper-tiny", "language": "auto", "word_timestamps": True},
        )
        assert created.status_code == 200
        job = created.json()["job"]
        assert job["kind"] == "transcription"
        assert job["status"] == "queued"

        # --- wait for ready transcript ---
        def transcription_items() -> list:
            return client.get(
                f"/api/v1/assets/{asset_id}/transcription", headers=ui
            ).json()["items"]

        _wait_until(
            lambda: transcription_items()
            and transcription_items()[0]["status"] == "ready"
        )
        items = transcription_items()
        assert len(items) == 1
        transcript_id = items[0]["transcript_id"]
        assert items[0]["status"] == "ready"
        assert items[0]["language"] == "zh"

        transcript = client.get(f"/api/v1/transcriptions/{transcript_id}", headers=ui)
        assert transcript.status_code == 200
        body = transcript.json()
        assert body["segments"][0]["text"] == "你好世界"
        assert body["words"] is not None
        assert body["source_media_fingerprint"] == asset.json()["fingerprint"]

        # re-requesting an identical transcription reuses the ready result
        again = client.post(
            f"/api/v1/assets/{asset_id}/transcription",
            headers=ui,
            json={"model_id": "whisper-tiny", "language": "auto", "word_timestamps": True},
        )
        assert again.status_code == 200
        assert again.json()["transcript"]["transcript_id"] == transcript_id

        original_audio = audio.read_bytes()
        audio.write_bytes(original_audio + b" changed")
        refreshed = client.post(f"/api/v1/assets/{asset_id}/refresh", headers=ui)
        assert refreshed.status_code == 200
        refreshed_asset = refreshed.json()
        assert refreshed_asset["fingerprint"] != asset.json()["fingerprint"]
        assert refreshed_asset["availability"] == "changed"

        stale_items = client.get(
            f"/api/v1/assets/{asset_id}/transcription", headers=ui
        ).json()["items"]
        stale = next(item for item in stale_items if item["transcript_id"] == transcript_id)
        assert stale["status"] == "stale"

        changed_request = client.post(
            f"/api/v1/assets/{asset_id}/transcription",
            headers=ui,
            json={"model_id": "whisper-tiny", "language": "auto", "word_timestamps": True},
        )
        assert changed_request.status_code == 409
        assert changed_request.json()["error"]["code"] == "TRANSCRIPTION_INPUT_CHANGED"


def test_stage1b_transcription_requires_installed_model(tmp_path: Path, monkeypatch):
    with _setup_client(tmp_path, monkeypatch) as client:
        admin = {"Authorization": "Bearer admin-stage1b"}
        ui = {
            "Authorization": (
                f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"
            )
        }
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"audio data")
        project = client.post("/api/v1/projects", headers=ui, json={"name": "NoModel"}).json()
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(audio)}
        ).json()
        asset = client.post(
            f"/api/v1/projects/{project['project_id']}/assets",
            headers=ui,
            json={"grant_id": grant["grant_id"], "kind": "audio"},
        ).json()
        response = client.post(
            f"/api/v1/assets/{asset['asset_id']}/transcription",
            headers=ui,
            json={"model_id": "whisper-tiny", "language": "auto"},
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MODEL_NOT_INSTALLED"


def test_stage1b_unsupported_language_rejected(tmp_path: Path, monkeypatch):
    with _setup_client(tmp_path, monkeypatch) as client:
        admin = {"Authorization": "Bearer admin-stage1b"}
        ui = {
            "Authorization": (
                f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"
            )
        }
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"audio data")
        project = client.post("/api/v1/projects", headers=ui, json={"name": "Lang"}).json()
        grant = client.post(
            "/api/v1/internal/file-grants", headers=admin, json={"path": str(audio)}
        ).json()
        asset = client.post(
            f"/api/v1/projects/{project['project_id']}/assets",
            headers=ui,
            json={"grant_id": grant["grant_id"], "kind": "audio"},
        ).json()
        client.post("/api/v1/models/whisper-tiny/download", headers=ui, json={})
        _wait_until(
            lambda: client.get("/api/v1/models/whisper-tiny/download", headers=ui).json()["model"][
                "status"
            ]
            == "ready"
        )
        response = client.post(
            f"/api/v1/assets/{asset['asset_id']}/transcription",
            headers=ui,
            json={"model_id": "whisper-tiny", "language": "fr"},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "TRANSCRIPTION_UNSUPPORTED_LANGUAGE"


def test_stage1b_unknown_model_404(tmp_path: Path, monkeypatch):
    with _setup_client(tmp_path, monkeypatch) as client:
        admin = {"Authorization": "Bearer admin-stage1b"}
        ui = {
            "Authorization": (
                f"Bearer {client.post('/api/v1/internal/sessions', headers=admin).json()['token']}"
            )
        }
        response = client.get("/api/v1/models/does-not-exist", headers=ui)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "MODEL_NOT_FOUND"
