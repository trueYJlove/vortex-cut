"""Deterministic fault harness for the Stage 1B model installer.

This tool exercises the real ``ModelManager`` implementation with small local
fixtures.  It deliberately injects faults at the harness boundary; production
validation and download code are not relaxed or replaced.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import socket
import sys
import tempfile
import threading
from dataclasses import replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CORE_SRC = ROOT / "services" / "core" / "src"
if str(CORE_SRC) not in sys.path:
    sys.path.insert(0, str(CORE_SRC))

from aivs_core.database import Database  # noqa: E402
from aivs_core.model_registry import (  # noqa: E402
    ModelError,
    ModelManager,
    ModelManifest,
    ModelRegistry,
)

EXECUTION_KIND = "deterministic_fault_harness"
ALLOWED_CHECK_STATUSES = {"passed", "failed", "unverified"}


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _checkpoint(report: dict[str, Any]) -> None:
    report["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_json(Path(report["report_path"]), report)


def _add_check(
    report: dict[str, Any],
    name: str,
    status: str,
    *,
    evidence: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    if status not in ALLOWED_CHECK_STATUSES:
        raise ValueError(f"invalid check status: {status}")
    item: dict[str, Any] = {
        "name": name,
        "status": status,
        "execution_kind": EXECUTION_KIND,
    }
    if evidence is not None:
        item["evidence"] = evidence
    if error is not None:
        item["error"] = error
    report.setdefault("checks", []).append(item)
    _checkpoint(report)


def _assert_model_error(action: Callable[[], Any], code: str) -> ModelError:
    try:
        action()
    except ModelError as exc:
        if exc.code != code:
            raise AssertionError(f"expected {code}, got {exc.code}") from exc
        return exc
    raise AssertionError(f"expected ModelError({code})")


def _download(manager: ModelManager, manifest: ModelManifest, cancel: asyncio.Event | None = None) -> Any:
    async def run() -> Any:
        return await manager.download(
            manifest,
            cancel or asyncio.Event(),
            lambda _progress: None,
            lambda _stage: None,
        )

    return asyncio.run(run())


def _case(root: Path) -> tuple[ModelManager, ModelManifest, dict[str, Path]]:
    """Create a fresh manager, manifest, and source files in a temporary case."""
    source = root / "source"
    manifests = root / "manifests"
    source.mkdir(parents=True)
    manifests.mkdir(parents=True)
    contents = {"config.json": b'{"version":1}\n', "model.bin": b"stage1b-model-payload\n"}
    file_rows: list[dict[str, Any]] = []
    paths: dict[str, Path] = {}
    for name, content in contents.items():
        path = source / name
        path.write_bytes(content)
        paths[name] = path
        file_rows.append(
            {"path": name, "size_bytes": len(content), "sha256": _sha256(content), "url": path.as_uri()}
        )
    aggregate = hashlib.sha256()
    for name in contents:
        aggregate.update(contents[name])
    total = sum(row["size_bytes"] for row in file_rows)
    raw_manifest = {
        "model_id": "stage1b-resilience-model",
        "provider": "faster-whisper",
        "revision": "resilience-rev1",
        "display_name": "Stage 1B resilience fixture",
        "purpose": "asr",
        "download_url": None,
        "trusted_source_id": "deterministic-fault-harness",
        "size_bytes": total,
        "installed_size_bytes": total,
        "sha256": aggregate.hexdigest(),
        "license": {"id": "test", "name": "Test", "acceptance_required": False},
        "supported_languages": ["auto", "en"],
        "supports_word_timestamps": False,
        "runtime_version": "test",
        "runtime_requirements": {},
        "files": file_rows,
        "created_at": "2026-08-11T00:00:00.000Z",
    }
    manifest_path = manifests / "stage1b-resilience-model.json"
    _write_json(manifest_path, raw_manifest)
    registry = ModelRegistry(manifests)
    registry.reload()
    manifest = registry.get(raw_manifest["model_id"])
    db = Database(root / "app.db")
    db.initialize()
    manager = ModelManager(db, root / "data", registry)
    return manager, manifest, paths


def _expect_status(manager: ModelManager, model_id: str, expected: str) -> dict[str, Any]:
    detail = manager.detail(model_id)
    if detail["status"] != expected:
        raise AssertionError(f"expected status {expected}, got {detail['status']}: {detail}")
    return detail


def _cancel_case(root: Path) -> dict[str, Any]:
    manager, manifest, _paths = _case(root)
    cancel = asyncio.Event()
    cancel.set()
    error = _assert_model_error(lambda: _download(manager, manifest, cancel), "MODEL_DOWNLOAD_CANCELLED")
    partial = manager.root / ".partial" / manifest.model_id / manifest.revision
    detail = _expect_status(manager, manifest.model_id, "cancelled")
    if not partial.is_dir():
        raise AssertionError("cancel did not preserve the partial directory")
    return {"error_code": error.code, "status": detail["status"], "partial_dir": str(partial)}


def _unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class _ErrorSourceHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = b"harness-controlled source failure"
        self.send_response(503)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def _http_manifest(manifest: ModelManifest, url: str) -> ModelManifest:
    return replace(
        manifest,
        files=tuple(replace(model_file, url=url) for model_file in manifest.files),
    )


def _network_case(root: Path) -> dict[str, Any]:
    manager, manifest, _paths = _case(root)
    unreachable = f"http://127.0.0.1:{_unused_local_port()}/missing-model.bin"
    unreachable_manifest = _http_manifest(manifest, unreachable)
    unreachable_error = _assert_model_error(
        lambda: _download(manager, unreachable_manifest), "MODEL_DOWNLOAD_FAILED"
    )
    unreachable_status = _expect_status(manager, manifest.model_id, "failed")["status"]

    manager_503, manifest_503, _paths_503 = _case(root / "http-503")
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ErrorSourceHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        error_url = f"http://127.0.0.1:{server.server_port}/error-source"
        error_manifest = _http_manifest(manifest_503, error_url)
        source_error = _assert_model_error(
            lambda: _download(manager_503, error_manifest), "MODEL_DOWNLOAD_FAILED"
        )
        error_status = _expect_status(manager_503, manifest_503.model_id, "failed")["status"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return {
        "harness_controlled": True,
        "unreachable_localhost": {"url": unreachable, "error_code": unreachable_error.code, "status": unreachable_status},
        "http_error_source": {"url": error_url, "http_status": 503, "error_code": source_error.code, "status": error_status},
    }


def _retry_case(root: Path) -> dict[str, Any]:
    manager, manifest, paths = _case(root)
    broken = paths["model.bin"]
    expected = broken.read_bytes()
    broken.write_bytes(b"broken-source\n")
    first_error = _assert_model_error(
        lambda: _download(manager, manifest), "MODEL_HASH_MISMATCH"
    )
    failed = _expect_status(manager, manifest.model_id, "failed")
    manager.queue(manifest)
    queued = _expect_status(manager, manifest.model_id, "queued")
    broken.write_bytes(expected)
    _download(manager, manifest)
    ready = _expect_status(manager, manifest.model_id, "ready")
    return {
        "first_error_code": first_error.code,
        "status_after_failure": failed["status"],
        "status_after_explicit_queue_retry": queued["status"],
        "status_after_reexecution": ready["status"],
    }


def _sha_mismatch_case(root: Path) -> dict[str, Any]:
    manager, manifest, paths = _case(root)
    paths["model.bin"].write_bytes(b"tampered-model-payload\n")
    error = _assert_model_error(lambda: _download(manager, manifest), "MODEL_HASH_MISMATCH")
    detail = _expect_status(manager, manifest.model_id, "failed")
    ready_dir = manager.root / manifest.model_id / manifest.revision
    if ready_dir.exists():
        raise AssertionError("hash mismatch promoted a ready directory")
    return {"error_code": error.code, "status": detail["status"], "ready_dir_exists": False}


def _disk_space_case(root: Path) -> dict[str, Any]:
    manager, manifest, _paths = _case(root)

    class _NoSpace:
        total = 1
        used = 1
        free = 0

    with patch("aivs_core.model_registry.shutil.disk_usage", lambda _path: _NoSpace()):
        error = _assert_model_error(
            lambda: _download(manager, manifest), "MODEL_DISK_SPACE_INSUFFICIENT"
        )
    detail = _expect_status(manager, manifest.model_id, "failed")
    return {"monkeypatch": "shutil.disk_usage.free=0", "error_code": error.code, "status": detail["status"]}


def _resume_case(root: Path) -> dict[str, Any]:
    manager, manifest, paths = _case(root)
    partial = manager.root / ".partial" / manifest.model_id / manifest.revision
    partial.mkdir(parents=True)
    first = manifest.files[0]
    source_bytes = paths[first.path].read_bytes()
    prefix = source_bytes[:3]
    (partial / first.path).write_bytes(prefix)
    initial_size = sum(path.stat().st_size for path in partial.rglob("*"))
    _download(manager, manifest)
    ready = manager.ready_path(manifest.model_id)
    if (ready / first.path).read_bytes() != source_bytes:
        raise AssertionError("resume did not produce the complete source file")
    return {
        "partial_prefix_bytes": len(prefix),
        "partial_initial_size": initial_size,
        "status": _expect_status(manager, manifest.model_id, "ready")["status"],
        "ready_dir": str(ready),
    }


def _ready_corruption_case(root: Path) -> dict[str, Any]:
    manager, manifest, _paths = _case(root)
    _download(manager, manifest)
    ready = manager.ready_path(manifest.model_id)
    marker = ready / ".ready"
    marker.write_text("{ corrupted", encoding="utf-8")
    detail = _expect_status(manager, manifest.model_id, "corrupt")
    error = _assert_model_error(lambda: manager.ready_path(manifest.model_id), "MODEL_NOT_INSTALLED")
    if not ready.is_dir() or not marker.is_file():
        raise AssertionError("corrupt ready directory was unexpectedly removed")
    return {
        "status": detail["status"],
        "ready_path_error_code": error.code,
        "ready_dir_preserved_but_isolated": True,
    }


def _run_one(report: dict[str, Any], name: str, function: Callable[[Path], dict[str, Any]]) -> None:
    try:
        with tempfile.TemporaryDirectory(prefix=f"stage1b-resilience-{name}-") as temporary:
            evidence = function(Path(temporary))
    except Exception as exc:
        _add_check(report, name, "failed", error=f"{type(exc).__name__}: {exc}")
    else:
        _add_check(report, name, "passed", evidence=evidence)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_report = ROOT / "test-results" / (
        f"stage1b-resilience-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    ) / "report.json"
    parser.add_argument("--report", type=Path, default=default_report)
    args = parser.parse_args(argv)
    report_path = args.report.resolve()
    report: dict[str, Any] = {
        "schema": "stage1b-resilience-v1",
        "status": "running",
        "execution_kind": EXECUTION_KIND,
        "report_path": str(report_path),
        "python": sys.version,
        "pid": os.getpid(),
        "checks": [],
    }
    try:
        _checkpoint(report)
        checks: list[tuple[str, Callable[[Path], dict[str, Any]]]] = [
            ("cancel", _cancel_case),
            ("http_network_failure", _network_case),
            ("explicit_retry_after_failure", _retry_case),
            ("sha256_mismatch", _sha_mismatch_case),
            ("disk_space_insufficient", _disk_space_case),
            ("partial_resume", _resume_case),
            ("ready_directory_corruption_isolation", _ready_corruption_case),
        ]
        for name, function in checks:
            _run_one(report, name, function)
    except Exception as exc:
        _add_check(report, "harness_execution", "failed", error=f"{type(exc).__name__}: {exc}")

    statuses = [check["status"] for check in report["checks"]]
    report["status"] = (
        "failed" if "failed" in statuses else "unverified" if "unverified" in statuses else "passed"
    )
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    _checkpoint(report)
    return 1 if report["status"] == "failed" else 2 if report["status"] == "unverified" else 0


if __name__ == "__main__":
    raise SystemExit(main())
