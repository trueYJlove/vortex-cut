from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import pytest

from aivs_core.asr_jobs import AsrCoordinator
from aivs_core.database import Database
from aivs_core.model_registry import (
    LicenseInfo,
    ModelFile,
    ModelManager,
    ModelManifest,
    ModelRegistry,
)
from aivs_core.transcription import (
    TranscriptionError,
    TranscriptRepository,
    TranscriptResult,
    TranscriptSegmentResult,
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


AUDIO_DATA = b"audio data"
AUDIO_FINGERPRINT = f"sha256:{sha256_bytes(AUDIO_DATA)}"


def make_manifest(tmp_path: Path, model_id: str = "test-model") -> ModelManifest:
    source_dir = tmp_path / "model-src"
    source_dir.mkdir(exist_ok=True)
    files = {"config.json": b"{}", "model.bin": b"\x00" * 128}
    entries: list[ModelFile] = []
    for name, content in files.items():
        (source_dir / name).write_bytes(content)
        entries.append(
            ModelFile(
                path=name,
                size_bytes=len(content),
                sha256=sha256_bytes(content),
                url=(source_dir / name).as_uri(),
            )
        )
    total = sum(item.size_bytes for item in entries)
    return ModelManifest(
        model_id=model_id,
        provider="faster-whisper",
        revision="rev1",
        display_name="Test Model",
        purpose="test",
        download_url=None,
        trusted_source_id="test-source",
        size_bytes=total,
        installed_size_bytes=total,
        sha256=sha256_bytes(b"".join((source_dir / f.path).read_bytes() for f in entries)),
        license=LicenseInfo("mit", "MIT", None, None, False),
        supported_languages=("auto", "zh"),
        supports_word_timestamps=True,
        runtime_version="faster-whisper>=1.0",
        runtime_requirements={"python": ">=3.12"},
        files=tuple(entries),
        created_at="2026-08-10T00:00:00.000Z",
        source_file=tmp_path / "manifests" / f"{model_id}.json",
        manifest_sha256=sha256_bytes(b"manifest"),
    )


class FakeProvider:
    def __init__(self, result: TranscriptResult | None = None):
        self.result = result or TranscriptResult(
            language="zh",
            duration_us=1_000_000,
            segments=(
                TranscriptSegmentResult(0, 1_000_000, "你好", 0.9, ()),
            ),
        )
        self.calls: list[tuple] = []

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
        self.calls.append((audio_uri, language, model_id, model_dir, word_timestamps))
        if cancel_token.is_set():
            raise TranscriptionError("TRANSCRIPTION_CANCELLED", "转录已取消")
        return self.result


def make_coordinator(
    tmp_path: Path,
    *,
    provider: FakeProvider | None = None,
) -> tuple[AsrCoordinator, Database, ModelManager, ModelManifest]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    audio_path = tmp_path / "audio.wav"
    audio_path.write_bytes(AUDIO_DATA)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('proj_1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) "
            "VALUES ('asset_1','proj_1','video','external','a.mp4',?,10,'available','now','now')",
            (AUDIO_FINGERPRINT,),
        )
        conn.execute(
            "INSERT INTO asset_locations (asset_id,uri,last_verified_at) "
            "VALUES ('asset_1',?, 'now')",
            (audio_path.as_uri(),),
        )
    registry = ModelRegistry(tmp_path / "manifests")
    manifest = make_manifest(tmp_path)
    registry._manifests = {manifest.model_id: manifest}
    registry._loaded = True
    manager = ModelManager(db, tmp_path / "data", registry)
    coordinator = AsrCoordinator(
        db,
        registry,
        manager,
        TranscriptRepository(db),
        provider=provider or FakeProvider(),
    )
    return coordinator, db, manager, manifest


async def _install(manager: ModelManager, manifest: ModelManifest) -> None:
    await manager.download(manifest, asyncio.Event(), lambda _p: None, lambda _s: None)


def _job_row(**kwargs: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "kind": "transcription",
        "model_id": "test-model",
        "model_revision": "rev1",
        "asset_id": "asset_1",
        "input_fingerprint": AUDIO_FINGERPRINT,
        "input_json": '{"language":"auto","word_timestamps":true}',
    }
    row.update(kwargs)
    return row


class TestAsrCoordinatorDownload:
    @pytest.mark.asyncio
    async def test_download_job_succeeds(self, tmp_path: Path):
        coordinator, _, _, manifest = make_coordinator(tmp_path)
        result = await coordinator.run(
            _job_row(kind="model_download", asset_id=None, input_json="{}"),
            asyncio.Event(),
            lambda _p: None,
            lambda _s: None,
        )
        assert result["model_id"] == manifest.model_id
        assert result["model_revision"] == manifest.revision
        assert result["installed_bytes"] == manifest.size_bytes

    @pytest.mark.asyncio
    async def test_download_job_revision_mismatch(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(Exception) as exc:
            await coordinator.run(
                _job_row(
                    kind="model_download",
                    asset_id=None,
                    model_revision="old",
                    input_json="{}"
                ),
                asyncio.Event(),
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "INTERNAL_ERROR"

    @pytest.mark.asyncio
    async def test_unknown_kind_rejected(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(TranscriptionError) as exc:
            await coordinator.run(
                _job_row(kind="weird"),
                asyncio.Event(),
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "INTERNAL_ERROR"


class TestAsrCoordinatorTranscription:
    @pytest.mark.asyncio
    async def test_transcription_succeeds_and_saves(self, tmp_path: Path):
        coordinator, _, manager, manifest = make_coordinator(tmp_path)
        await _install(manager, manifest)
        result = await coordinator.run(
            _job_row(),
            asyncio.Event(),
            lambda _p: None,
            lambda _s: None,
        )
        assert result["transcript_id"].startswith("transcript_")
        transcript = coordinator.transcripts.get(result["transcript_id"])
        assert transcript is not None
        assert transcript["status"] == "ready"
        assert transcript["segments"][0]["text"] == "你好"

    @pytest.mark.asyncio
    async def test_transcription_model_not_installed(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(TranscriptionError) as exc:
            await coordinator.run(
                _job_row(),
                asyncio.Event(),
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "MODEL_NOT_INSTALLED"

    @pytest.mark.asyncio
    async def test_transcription_input_changed_fingerprint(self, tmp_path: Path):
        coordinator, _, manager, manifest = make_coordinator(tmp_path)
        await _install(manager, manifest)
        with pytest.raises(TranscriptionError) as exc:
            await coordinator.run(
                _job_row(input_fingerprint="fp_old"),
                asyncio.Event(),
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "TRANSCRIPTION_INPUT_CHANGED"

    @pytest.mark.asyncio
    async def test_transcription_cancelled(self, tmp_path: Path):
        coordinator, _, manager, manifest = make_coordinator(tmp_path)
        await _install(manager, manifest)
        cancel = asyncio.Event()
        cancel.set()
        with pytest.raises(TranscriptionError) as exc:
            await coordinator.run(
                _job_row(),
                cancel,
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "TRANSCRIPTION_CANCELLED"

    @pytest.mark.asyncio
    async def test_transcription_missing_asset(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(TranscriptionError) as exc:
            await coordinator.run(
                _job_row(asset_id=None),
                asyncio.Event(),
                lambda _p: None,
                lambda _s: None,
            )
        assert exc.value.code == "TRANSCRIPTION_FAILED"


class TestAsrCoordinatorRetry:
    @pytest.mark.asyncio
    async def test_validate_retry_model_download_ok(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        coordinator.validate_retry(_job_row(kind="model_download", asset_id=None, input_json="{}"))

    @pytest.mark.asyncio
    async def test_validate_retry_transcription_revision_changed(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(Exception) as exc:
            coordinator.validate_retry(
                _job_row(
                    kind="model_download",
                    asset_id=None,
                    model_revision="old",
                    input_json="{}"
                )
            )
        assert exc.value.code == "MODEL_DOWNLOAD_FAILED"

    @pytest.mark.asyncio
    async def test_validate_retry_transcription_fingerprint_changed(self, tmp_path: Path):
        coordinator, _, _, _ = make_coordinator(tmp_path)
        with pytest.raises(TranscriptionError) as exc:
            coordinator.validate_retry(_job_row(input_fingerprint="fp_old"))
        assert exc.value.code == "TRANSCRIPTION_INPUT_CHANGED"
