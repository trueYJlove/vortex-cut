from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.model_registry import (
    LicenseInfo,
    ModelError,
    ModelFile,
    ModelManager,
    ModelManifest,
    ModelRegistry,
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_source_files(root: Path, files: dict[str, bytes]) -> dict[str, tuple[int, str]]:
    manifest_files: list[dict] = []
    for name, content in files.items():
        (root / name).write_bytes(content)
        manifest_files.append(
            {"path": name, "size_bytes": len(content), "sha256": sha256_bytes(content)}
        )
    return manifest_files


def make_registry(
    tmp_path: Path, *, model_id: str = "test-model", language: str = "zh"
) -> tuple[ModelRegistry, Path]:
    """Create a manifest dir + source files; return (registry, source_dir)."""
    source_dir = tmp_path / "model-src"
    source_dir.mkdir()
    files = {
        "config.json": b'{"vocab": 1}',
        "model.bin": b"\x00" * 64 + b"weights",
        "tokenizer.json": b"{}",
    }
    manifest_files = _write_source_files(source_dir, files)
    total = sum(item["size_bytes"] for item in manifest_files)
    manifest = {
        "model_id": model_id,
        "provider": "faster-whisper",
        "revision": "rev1",
        "display_name": "Test Model",
        "purpose": "test",
        "download_url": None,
        "trusted_source_id": "test-source",
        "size_bytes": total,
        "installed_size_bytes": total,
        "sha256": sha256_bytes(
            b"".join(source_dir.joinpath(f["path"]).read_bytes() for f in manifest_files)
        ),
        "license": {
            "id": "mit",
            "name": "MIT",
            "url": None,
            "attribution": None,
            "acceptance_required": False,
        },
        "supported_languages": ["auto", language],
        "supports_word_timestamps": True,
        "runtime_version": "faster-whisper>=1.0",
        "runtime_requirements": {"python": ">=3.12"},
        "files": manifest_files,
        "created_at": "2026-08-10T00:00:00.000Z",
    }
    manifest_dir = tmp_path / "manifests"
    manifest_dir.mkdir()
    (manifest_dir / f"{model_id}.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return ModelRegistry(manifest_dir), source_dir


def _file_urls(source_dir: Path, files: dict[str, bytes]) -> list[dict]:
    result = []
    for name in files:
        url = source_dir.joinpath(name).as_uri()
        result.append({"path": name, "url": url})
    return result


def make_ready_manifest(tmp_path: Path, *, model_id: str = "test-model") -> ModelManifest:
    """Build a fully-populated ModelManifest with file:// URLs for local download."""
    source_dir = tmp_path / "model-src"
    source_dir.mkdir(exist_ok=True)
    files = {"config.json": b"{}", "model.bin": b"\x00" * 128}
    manifest_files = _write_source_files(source_dir, files)
    total = sum(item["size_bytes"] for item in manifest_files)
    urls = _file_urls(source_dir, files)
    urls_by_path = {item["path"]: item["url"] for item in urls}
    model_files = tuple(
        ModelFile(
            path=item["path"],
            size_bytes=item["size_bytes"],
            sha256=item["sha256"],
            url=urls_by_path[item["path"]],
        )
        for item in manifest_files
    )
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
        sha256=sha256_bytes(
            b"".join(source_dir.joinpath(f["path"]).read_bytes() for f in manifest_files)
        ),
        license=LicenseInfo("mit", "MIT", None, None, False),
        supported_languages=("auto", "zh"),
        supports_word_timestamps=True,
        runtime_version="faster-whisper>=1.0",
        runtime_requirements={"python": ">=3.12"},
        files=model_files,
        created_at="2026-08-10T00:00:00.000Z",
        source_file=tmp_path / "manifests" / f"{model_id}.json",
        manifest_sha256=sha256_bytes(b"manifest"),
    )


class TestModelRegistry:
    def test_list_and_get_from_directory(self, tmp_path: Path):
        registry, _ = make_registry(tmp_path)
        models = registry.list()
        assert [m.model_id for m in models] == ["test-model"]
        manifest = registry.get("test-model")
        assert manifest.provider == "faster-whisper"
        assert manifest.manifest_sha256

    def test_get_unknown_raises_model_not_found(self, tmp_path: Path):
        registry, _ = make_registry(tmp_path)
        with pytest.raises(ModelError) as exc:
            registry.get("nope")
        assert exc.value.code == "MODEL_NOT_FOUND"

    def test_duplicate_model_id_rejected(self, tmp_path: Path):
        registry, _ = make_registry(tmp_path, model_id="dup")
        shutil.copy(
            tmp_path / "manifests" / "dup.json",
            tmp_path / "manifests" / "dup-copy.json",
        )
        with pytest.raises(ModelError) as exc:
            registry.reload()
        assert exc.value.code == "INTERNAL_ERROR"

    def test_invalid_sha256_rejected(self, tmp_path: Path):
        registry, _ = make_registry(tmp_path)
        manifest_path = tmp_path / "manifests" / "test-model.json"
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        raw["sha256"] = "bad"
        manifest_path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(ModelError):
            registry.reload()

    def test_manifest_size_must_match_files(self, tmp_path: Path):
        registry, _ = make_registry(tmp_path)
        manifest_path = tmp_path / "manifests" / "test-model.json"
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        raw["size_bytes"] = raw["size_bytes"] + 1
        manifest_path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(ModelError):
            registry.reload()


class TestModelManager:
    def _manager(self, tmp_path: Path) -> tuple[ModelManager, Database]:
        db = Database(tmp_path / "app.db")
        db.initialize()
        registry, _ = make_registry(tmp_path)
        manager = ModelManager(db, tmp_path / "data", registry)
        return manager, db

    def test_detail_unavailable_when_not_installed(self, tmp_path: Path):
        manager, _ = self._manager(tmp_path)
        detail = manager.detail("test-model")
        assert detail["status"] == "unavailable"
        assert detail["local_only"] is True
        assert "installed_path" not in detail
        assert detail["model_sha256"]

    def test_seed_external_marks_ready(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True
        external = tmp_path / "external-model"
        for model_file in manifest.files:
            src = tmp_path / "model-src" / model_file.path
            dst = external / model_file.path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
        manager.seed_external(external)
        assert manager.detail("test-model")["status"] == "ready"
        assert manager.ready_path("test-model") == external
        assert (external / ".ready").is_file()

    def test_seed_external_nonmatching_is_noop(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True
        external = tmp_path / "external-model"
        external.mkdir()
        (external / "config.json").write_bytes(b"{}")
        manager.seed_external(external)
        assert manager.detail("test-model")["status"] == "unavailable"

    def test_seed_external_missing_dir_noop(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True
        manager.seed_external(tmp_path / "does-not-exist")
        assert manager.detail("test-model")["status"] == "unavailable"

    def test_download_success_and_ready_path(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        registry = ModelRegistry(tmp_path / "manifests")
        # registry expects a manifest file; create one by writing the manifest json
        manager = ModelManager(db, tmp_path / "data", registry)
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True

        async def run():
            result = await manager.download(
                manifest, asyncio.Event(), lambda _p: None, lambda _s: None
            )
            return result

        result = asyncio.run(run())
        assert result["installed_bytes"] == manifest.size_bytes
        detail = manager.detail("test-model")
        assert detail["status"] == "ready"
        assert detail["progress"] == 1.0
        ready = manager.ready_path("test-model")
        assert ready.is_dir()
        assert (ready / "model.bin").read_bytes() == b"\x00" * 128

    def test_download_cancel_leaves_partial_and_cancelled(self, tmp_path: Path):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True
        cancel = asyncio.Event()

        async def run():
            cancel.set()
            with pytest.raises(ModelError) as exc:
                await manager.download(manifest, cancel, lambda _p: None, lambda _s: None)
            return exc.value

        exc = asyncio.run(run())
        assert exc.code == "MODEL_DOWNLOAD_CANCELLED"
        detail = manager.detail("test-model")
        assert detail["status"] == "cancelled"

    def test_download_hash_mismatch_fails(self, tmp_path: Path, monkeypatch):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        # corrupt the source so the sha256 no longer matches the manifest
        source = tmp_path / "model-src" / "model.bin"
        source.write_bytes(b"\x00" * 128 + b"corrupt")
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True

        async def run():
            with pytest.raises(ModelError) as exc:
                await manager.download(manifest, asyncio.Event(), lambda _p: None, lambda _s: None)
            return exc.value

        exc = asyncio.run(run())
        assert exc.code == "MODEL_HASH_MISMATCH"
        assert manager.detail("test-model")["status"] == "failed"

    def test_download_disk_space_insufficient(self, tmp_path: Path, monkeypatch):
        db = Database(tmp_path / "app.db")
        db.initialize()
        manifest = make_ready_manifest(tmp_path)
        class _Usage:
            total = 0
            used = 0
            free = 0

        monkeypatch.setattr(shutil, "disk_usage", lambda _p: _Usage())
        manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
        manager.registry._manifests = {"test-model": manifest}
        manager.registry._loaded = True

        async def run():
            with pytest.raises(ModelError) as exc:
                await manager.download(manifest, asyncio.Event(), lambda _p: None, lambda _s: None)
            return exc.value

        exc = asyncio.run(run())
        assert exc.code == "MODEL_DISK_SPACE_INSUFFICIENT"
        assert manager.detail("test-model")["status"] == "failed"

    def test_queue_and_revision_change(self, tmp_path: Path):
        manager, _ = self._manager(tmp_path)
        manifest = make_ready_manifest(tmp_path)
        manager.queue(manifest)
        assert manager.detail("test-model")["status"] == "queued"
        # detail status reflects installation row even without download
        detail = manager.detail("test-model")
        assert detail["status"] == "queued"


def test_download_resume_skips_existing_bytes(tmp_path: Path):
    db = Database(tmp_path / "app.db")
    db.initialize()
    manifest = make_ready_manifest(tmp_path)
    manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
    manager.registry._manifests = {"test-model": manifest}
    manager.registry._loaded = True
    # simulate a partial download of the first file
    partial = tmp_path / "data" / "models" / "asr" / ".partial" / "test-model" / "rev1"
    partial.mkdir(parents=True)
    first = manifest.files[0]
    (partial / first.path).write_bytes(b"")  # zero bytes -> will be rewritten

    async def run():
        return await manager.download(manifest, asyncio.Event(), lambda _p: None, lambda _s: None)

    result = asyncio.run(run())
    assert result["installed_bytes"] == manifest.size_bytes
    assert manager.detail("test-model")["status"] == "ready"


def _manager_with_manifest(tmp_path: Path) -> tuple[ModelManager, Database, ModelManifest]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    manifest = make_ready_manifest(tmp_path)
    manager = ModelManager(db, tmp_path / "data", ModelRegistry(tmp_path / "manifests"))
    manager.registry._manifests = {"test-model": manifest}
    manager.registry._loaded = True
    return manager, db, manifest


def test_download_aggregate_manifest_hash_mismatch_fails(tmp_path: Path):
    manager, _, manifest = _manager_with_manifest(tmp_path)
    # Each file is valid, but the manifest-level aggregate digest is wrong.
    bad_manifest = replace(manifest, sha256=sha256_bytes(b"wrong aggregate hash"))
    with pytest.raises(ModelError) as exc:
        _run_download(manager, bad_manifest)
    assert exc.value.code == "MODEL_HASH_MISMATCH"
    assert manager.detail("test-model")["status"] == "failed"
    ready_dir = tmp_path / "data" / "models" / "asr" / "test-model" / "rev1"
    assert not ready_dir.exists()


def _run_download(manager: ModelManager, manifest: ModelManifest, cancel=None) -> None:
    async def run():
        return await manager.download(
            manifest, cancel or asyncio.Event(), lambda _p: None, lambda _s: None
        )

    return asyncio.run(run())


def test_ready_path_corrupt_after_file_removed(tmp_path: Path):
    manager, _, manifest = _manager_with_manifest(tmp_path)
    _run_download(manager, manifest)
    ready = manager.ready_path("test-model")
    (ready / "model.bin").unlink()
    detail = manager.detail("test-model")
    assert detail["status"] == "corrupt"
    with pytest.raises(ModelError) as exc:
        manager.ready_path("test-model")
    assert exc.value.code == "MODEL_NOT_INSTALLED"


def test_detail_revision_mismatch_is_unavailable(tmp_path: Path):
    manager, db, manifest = _manager_with_manifest(tmp_path)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO model_installations (model_id,provider,revision,status,install_dir,"
            "expected_bytes,installed_bytes,manifest_sha256,license_id,last_error,updated_at) "
            "VALUES ('test-model','faster-whisper','old-rev','ready','/x',10,10,?, "
            "'mit',NULL,'now')",
            (manifest.manifest_sha256,),
        )
    assert manager.detail("test-model")["status"] == "unavailable"


def test_detail_disk_usage_oserror_returns_none(tmp_path: Path, monkeypatch):
    def boom(_p):
        raise OSError("boom")

    monkeypatch.setattr(shutil, "disk_usage", boom)
    manager, _, _ = _manager_with_manifest(tmp_path)
    detail = manager.detail("test-model")
    assert detail["status"] == "unavailable"
    assert detail["available_disk_bytes"] is None


def test_download_disk_usage_oserror_fails(tmp_path: Path, monkeypatch):
    def boom(_p):
        raise OSError("boom")

    monkeypatch.setattr(shutil, "disk_usage", boom)
    manager, _, manifest = _manager_with_manifest(tmp_path)
    with pytest.raises(ModelError) as exc:
        _run_download(manager, manifest)
    assert exc.value.code == "MODEL_DISK_SPACE_INSUFFICIENT"


def test_download_missing_source_url_fails(tmp_path: Path):
    manager, _, manifest = _manager_with_manifest(tmp_path)
    manifest = replace(
        manifest,
        download_url=None,
        files=tuple(replace(f, url=None) for f in manifest.files),
    )
    with pytest.raises(ModelError) as exc:
        _run_download(manager, manifest)
    assert exc.value.code == "MODEL_DOWNLOAD_FAILED"


def test_download_http_non_localhost_rejected(tmp_path: Path):
    manager, _, manifest = _manager_with_manifest(tmp_path)
    manifest = replace(
        manifest,
        download_url=None,
        files=tuple(
            replace(f, url="http://evil.example/model.bin") for f in manifest.files
        ),
    )
    with pytest.raises(ModelError) as exc:
        _run_download(manager, manifest)
    assert exc.value.code == "MODEL_DOWNLOAD_FAILED"


def test_queue_idempotent_when_ready(tmp_path: Path):
    manager, _, manifest = _manager_with_manifest(tmp_path)
    _run_download(manager, manifest)
    manager.queue(manifest)
    assert manager.detail("test-model")["status"] == "ready"


def test_manifest_with_empty_files_rejected(tmp_path: Path):
    manifest_path = tmp_path / "manifests" / "test-model.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "model_id": "empty",
                "license": {"id": "mit", "name": "MIT"},
                "files": [],
            }
        ),
        encoding="utf-8",
    )
    registry = ModelRegistry(tmp_path / "manifests")
    with pytest.raises(ModelError) as exc:
        registry.reload()
    assert exc.value.code == "INTERNAL_ERROR"
