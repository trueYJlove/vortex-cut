from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

from .database import Database, utc_now

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
# os.path.expandvars 只认名字、不认未定义变量，残留的两种写法同为"未设置"。
_UNEXPANDED_VAR = re.compile(
    r"[$]{([A-Za-z_][A-Za-z0-9_]*)}|[$]([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%"
)

_HTTP_USER_AGENT = (
    "Mozilla/5.0 (aivideo-core model download; "
    "https://github.com/aivideo-studio)"
)


class ModelError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# AI-2：受信 provider 白名单（曾硬编码 faster-whisper）。新增 provider 须
# 同时登记安装根目录与运行时探测模块——三表一处维护。
MODEL_PROVIDERS = ("faster-whisper", "onnx-cv", "onnx-speaker", "onnx-clip")
MODEL_PROVIDER_DIRECTORIES = {
    "faster-whisper": "asr",
    "onnx-cv": "cv",
    # W2.2 说话人 embedding（CAM++）——独立目录，与 CV 模型不混装
    "onnx-speaker": "speaker",
    # W3.1 语义检索双塔（CLIP vision + text）——独立目录
    "onnx-clip": "clip",
}
MODEL_PROVIDER_RUNTIME_MODULES = {
    "faster-whisper": "faster_whisper",
    "onnx-cv": "onnxruntime",
    "onnx-speaker": "onnxruntime",
    "onnx-clip": "onnxruntime",
}


@dataclass(frozen=True)
class LicenseInfo:
    id: str
    name: str
    url: str | None
    attribution: str | None
    acceptance_required: bool


@dataclass(frozen=True)
class ModelFile:
    path: str
    size_bytes: int
    sha256: str
    url: str | None = None


@dataclass(frozen=True)
class ModelManifest:
    model_id: str
    provider: str
    revision: str
    display_name: str
    purpose: str
    download_url: str | None
    trusted_source_id: str | None
    size_bytes: int
    installed_size_bytes: int
    sha256: str
    license: LicenseInfo
    supported_languages: tuple[str, ...]
    supports_word_timestamps: bool
    runtime_version: str
    runtime_requirements: dict[str, Any]
    files: tuple[ModelFile, ...]
    created_at: str
    source_file: Path
    manifest_sha256: str


class ModelRegistry:
    def __init__(self, manifest_dir: Path) -> None:
        self.manifest_dir = manifest_dir
        self._manifests: dict[str, ModelManifest] = {}
        self._loaded = False

    def reload(self) -> None:
        manifests: dict[str, ModelManifest] = {}
        if self.manifest_dir.is_dir():
            for path in sorted(self.manifest_dir.glob("*.json")):
                manifest = self._load(path)
                if manifest.model_id in manifests:
                    raise ModelError("INTERNAL_ERROR", "重复的模型 manifest")
                manifests[manifest.model_id] = manifest
        self._manifests = manifests
        self._loaded = True

    def list(self) -> list[ModelManifest]:
        if not self._loaded:
            self.reload()
        return list(self._manifests.values())

    def get(self, model_id: str) -> ModelManifest:
        if not self._loaded:
            self.reload()
        manifest = self._manifests.get(model_id)
        if not manifest:
            raise ModelError("MODEL_NOT_FOUND", "模型不存在")
        return manifest

    @staticmethod
    def _load(path: Path) -> ModelManifest:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            license_raw = raw["license"]
            license_info = LicenseInfo(
                id=_required_text(license_raw, "id"),
                name=_required_text(license_raw, "name"),
                url=license_raw.get("url"),
                attribution=license_raw.get("attribution"),
                acceptance_required=bool(license_raw.get("acceptance_required", False)),
            )
            files = tuple(
                ModelFile(
                    path=_relative_path(item["path"]),
                    size_bytes=_positive_int(item["size_bytes"]),
                    sha256=_sha256(item["sha256"]),
                    url=item.get("url"),
                )
                for item in raw["files"]
            )
            if not files:
                raise ValueError("manifest files are required")
            manifest = ModelManifest(
                model_id=_required_text(raw, "model_id"),
                provider=_required_text(raw, "provider"),
                revision=_required_text(raw, "revision"),
                display_name=_required_text(raw, "display_name"),
                purpose=_required_text(raw, "purpose"),
                download_url=raw.get("download_url"),
                trusted_source_id=raw.get("trusted_source_id"),
                size_bytes=_positive_int(raw["size_bytes"]),
                installed_size_bytes=_positive_int(raw["installed_size_bytes"]),
                sha256=_sha256(raw["sha256"]),
                license=license_info,
                supported_languages=tuple(_language(value) for value in raw["supported_languages"]),
                supports_word_timestamps=bool(raw["supports_word_timestamps"]),
                runtime_version=_required_text(raw, "runtime_version"),
                runtime_requirements=dict(raw.get("runtime_requirements", {})),
                files=files,
                created_at=_required_text(raw, "created_at"),
                source_file=path,
                manifest_sha256=_file_sha256(path),
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            if isinstance(exc, ModelError):
                raise
            raise ModelError("INTERNAL_ERROR", f"invalid manifest: {path.name}") from exc
        _validate_manifest(manifest)
        return manifest


class ModelManager:
    def __init__(self, db: Database, data_dir: Path, registry: ModelRegistry) -> None:
        self.db = db
        self.registry = registry
        # AI-2：按 provider 分目录（faster-whisper → models/asr 保持旧路径；
        # onnx-cv → models/cv）。_install_root 依据清单 provider 分派。
        self.root = data_dir / "models" / "asr"
        self.root.mkdir(parents=True, exist_ok=True)

    def _install_root(self, provider: str) -> Path:
        subdirectory = MODEL_PROVIDER_DIRECTORIES.get(provider, "other")
        root = self.root.parent / subdirectory
        root.mkdir(parents=True, exist_ok=True)
        return root

    def detail(self, model_id: str) -> dict[str, Any]:
        manifest = self.registry.get(model_id)
        installation = self._installation(model_id)
        status = self._status(manifest, installation)
        progress = None
        if installation:
            expected = max(1, int(installation["expected_bytes"]))
            progress = min(1.0, max(0.0, int(installation["installed_bytes"]) / expected))
        try:
            available_disk_bytes = shutil.disk_usage(self.root).free
        except OSError:
            available_disk_bytes = None
        return self._dto(manifest, status, progress, available_disk_bytes)

    def list_details(self) -> list[dict[str, Any]]:
        return [self.detail(manifest.model_id) for manifest in self.registry.list()]

    def queue(self, manifest: ModelManifest) -> None:
        installation = self._installation(manifest.model_id)
        if (
            installation
            and installation["status"] == "ready"
            and installation["revision"] == manifest.revision
        ):
            return
        partial_dir = (
            self._install_root(manifest.provider) / ".partial"
            / manifest.model_id / manifest.revision
        )
        self._set_installation(manifest, "queued", _directory_size(partial_dir), None)

    def ready_path(self, model_id: str) -> Path:
        manifest = self.registry.get(model_id)
        installation = self._installation(model_id)
        if not installation or installation["status"] != "ready":
            raise ModelError("MODEL_NOT_INSTALLED", "模型尚未安装")
        ready_dir = Path(installation["install_dir"])
        if not self._is_ready(manifest, ready_dir):
            self._set_installation(manifest, "corrupt", 0, "模型文件已损坏")
            raise ModelError("MODEL_NOT_INSTALLED", "模型尚未安装")
        return ready_dir

    def seed_external(self, external_dir: Path) -> None:
        """Register an externally supplied model installation (test seeding).

        Activated only via the ``AIVS_E2E_MODEL_DIR`` environment variable. When
        the directory matches a shipped manifest's files, a ``.ready`` marker is
        written (if absent) and a ready installation row is recorded pointing at
        it, so the model reports ready without a download. No-op when the
        directory does not match any shipped manifest.
        """
        if not external_dir.is_dir():
            return
        for manifest in self.registry.list():
            if not all(
                (external_dir / model_file.path).is_file()
                for model_file in manifest.files
            ):
                continue
            # Overwrite the marker unconditionally: the directory may carry a
            # marker from a different manifest snapshot (e.g. a download-time
            # URL swap), whose manifest_sha256 would fail _is_ready.
            (external_dir / ".ready").write_text(
                json.dumps(
                    {
                        "model_id": manifest.model_id,
                        "revision": manifest.revision,
                        "manifest_sha256": manifest.manifest_sha256,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            self._set_installation(
                manifest,
                "ready",
                _directory_size(external_dir),
                None,
                install_dir=external_dir,
            )
            return

    async def download(
        self,
        manifest: ModelManifest,
        cancel_event: asyncio.Event,
        progress: Callable[[float], None],
        stage: Callable[[str], None],
    ) -> dict[str, Any]:
        required = math.ceil(manifest.installed_size_bytes * 1.2)
        install_root = self._install_root(manifest.provider)
        partial_dir = install_root / ".partial" / manifest.model_id / manifest.revision
        ready_dir = install_root / manifest.model_id / manifest.revision
        partial_dir.mkdir(parents=True, exist_ok=True)
        try:
            free = shutil.disk_usage(install_root).free
        except OSError as exc:
            self._set_installation(
                manifest, "failed", _directory_size(partial_dir), "无法确认模型磁盘空间"
            )
            raise ModelError(
                "MODEL_DISK_SPACE_INSUFFICIENT", "无法确认模型磁盘空间"
            ) from exc
        if free < required:
            self._set_installation(
                manifest, "failed", _directory_size(partial_dir), "模型安装所需磁盘空间不足"
            )
            raise ModelError("MODEL_DISK_SPACE_INSUFFICIENT", "磁盘空间不足，无法安装模型")
        self._set_installation(manifest, "downloading", _directory_size(partial_dir), None)
        completed = _directory_size(partial_dir)
        total = max(manifest.size_bytes, 1)
        progress(min(1.0, completed / total))
        try:
            for model_file in manifest.files:
                if cancel_event.is_set():
                    raise ModelError("MODEL_DOWNLOAD_CANCELLED", "模型下载已取消")
                stage("downloading")
                destination = partial_dir / Path(model_file.path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                url = self._file_url(manifest, model_file)
                await asyncio.to_thread(
                    _download_with_retry,
                    url,
                    destination,
                    model_file.size_bytes,
                    model_file.sha256,
                    cancel_event,
                    lambda size: progress(min(1.0, (completed + size) / total)),
                )
                completed = _directory_size(partial_dir)
                progress(min(1.0, completed / total))
            stage("verifying")
            self._set_installation(manifest, "verifying", completed, None)
            if _directory_size(partial_dir) != manifest.size_bytes:
                raise ModelError("MODEL_HASH_MISMATCH", "模型文件校验失败，请重试下载")
            for model_file in manifest.files:
                path = partial_dir / Path(model_file.path)
                if (
                    _file_size(path) != model_file.size_bytes
                    or _file_sha256(path) != model_file.sha256
                ):
                    raise ModelError("MODEL_HASH_MISMATCH", "模型文件校验失败，请重试下载")
            if _manifest_files_sha256(partial_dir, manifest.files) != manifest.sha256:
                raise ModelError("MODEL_HASH_MISMATCH", "模型文件校验失败，请重试下载")
            marker = partial_dir / ".ready"
            marker.write_text(
                json.dumps(
                    {
                        "model_id": manifest.model_id,
                        "revision": manifest.revision,
                        "manifest_sha256": manifest.manifest_sha256,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
            ready_dir.parent.mkdir(parents=True, exist_ok=True)
            if ready_dir.exists():
                shutil.rmtree(ready_dir)
            partial_dir.replace(ready_dir)
            self._set_installation(manifest, "ready", manifest.size_bytes, None, ready_dir)
            progress(1.0)
            return {"installed_bytes": manifest.size_bytes}
        except ModelError as exc:
            status = "cancelled" if exc.code == "MODEL_DOWNLOAD_CANCELLED" else "failed"
            self._set_installation(manifest, status, _directory_size(partial_dir), exc.message)
            raise
        except Exception as exc:
            self._set_installation(
                manifest, "failed", _directory_size(partial_dir), "model download failed"
            )
            raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败") from exc

    def _file_url(self, manifest: ModelManifest, model_file: ModelFile) -> str:
        if model_file.url:
            url = model_file.url
        elif manifest.download_url and len(manifest.files) == 1:
            url = manifest.download_url
        elif manifest.download_url:
            url = manifest.download_url.rstrip("/") + "/" + model_file.path
        else:
            raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败")
        # 本地来源按机器可配置：清单写
        #   file:///${AIVS_MODEL_SOURCE_ROOT}/chinese-clip-vit-base-patch16/vision_model.onnx
        # 由环境变量指出产物在本机的落点（754MB 导出产物不入库，见
        # tools/model_export/）。展开必须在 urlparse 之前做，否则变量名会被
        # 当成 netloc；展开后仍残留的变量引用正是"变量未设置"，交给
        # _local_source_url 转成可操作的报错并返回规范化 URL。
        url = os.path.expanduser(os.path.expandvars(url))
        parsed = urlparse(url)
        if parsed.scheme != "https" and parsed.scheme not in {"file", "http"}:
            raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败")
        if parsed.scheme == "file":
            return _local_source_url(parsed, model_file)
        return url

    def _installation(self, model_id: str) -> Any:
        with self.db.connection() as db:
            return db.execute(
                "SELECT * FROM model_installations WHERE model_id=?", (model_id,)
            ).fetchone()

    def _set_installation(
        self,
        manifest: ModelManifest,
        status: str,
        installed_bytes: int,
        error: str | None,
        install_dir: Path | None = None,
    ) -> None:
        directory = install_dir or (self._install_root(manifest.provider) / manifest.model_id / manifest.revision)
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO model_installations "
                "(model_id,provider,revision,status,install_dir,expected_bytes,installed_bytes,"
                "manifest_sha256,license_id,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(model_id) DO UPDATE SET provider=excluded.provider,"
                "revision=excluded.revision,status=excluded.status,install_dir=excluded.install_dir,"
                "expected_bytes=excluded.expected_bytes,installed_bytes=excluded.installed_bytes,"
                "manifest_sha256=excluded.manifest_sha256,license_id=excluded.license_id,"
                "last_error=excluded.last_error,updated_at=excluded.updated_at",
                (
                    manifest.model_id,
                    manifest.provider,
                    manifest.revision,
                    status,
                    str(directory),
                    manifest.size_bytes,
                    installed_bytes,
                    manifest.manifest_sha256,
                    manifest.license.id,
                    error,
                    utc_now(),
                ),
            )

    @staticmethod
    def _status(manifest: ModelManifest, installation: Any) -> str:
        if not installation:
            return "unavailable"
        if installation["revision"] != manifest.revision:
            return "unavailable"
        if installation["status"] == "ready" and not ModelManager._is_ready(
            manifest, Path(installation["install_dir"])
        ):
            return "corrupt"
        return str(installation["status"])

    @staticmethod
    def _is_ready(manifest: ModelManifest, directory: Path) -> bool:
        marker = directory / ".ready"
        if not directory.is_dir() or not marker.is_file():
            return False
        try:
            raw = json.loads(marker.read_text(encoding="utf-8"))
            if raw.get("model_id") != manifest.model_id or raw.get("revision") != manifest.revision:
                return False
            if raw.get("manifest_sha256") != manifest.manifest_sha256:
                return False
            return all(
                _file_size(directory / model_file.path) == model_file.size_bytes
                and _file_sha256(directory / model_file.path) == model_file.sha256
                for model_file in manifest.files
            ) and _manifest_files_sha256(directory, manifest.files) == manifest.sha256
        except (OSError, ValueError, TypeError):
            return False

    @staticmethod
    def _dto(
        manifest: ModelManifest,
        status: str,
        progress: float | None,
        available_disk_bytes: int | None,
    ) -> dict[str, Any]:
        provider_status = _provider_status(status, manifest.provider)
        return {
            "model_id": manifest.model_id,
            "display_name": manifest.display_name,
            "purpose": manifest.purpose,
            "provider": manifest.provider,
            "revision": manifest.revision,
            "supported_languages": list(manifest.supported_languages),
            "supports_word_timestamps": manifest.supports_word_timestamps,
            "runtime_version": manifest.runtime_version,
            "model_size_bytes": manifest.size_bytes,
            "installed_size_bytes": manifest.installed_size_bytes,
            "model_sha256": manifest.sha256,
            "license": {
                "id": manifest.license.id,
                "name": manifest.license.name,
                "url": manifest.license.url,
                "attribution": manifest.license.attribution,
                "acceptance_required": manifest.license.acceptance_required,
            },
            "source": {
                "kind": "trusted_manifest" if manifest.trusted_source_id else "https",
                "display_name": manifest.trusted_source_id or "HTTPS source",
                "host": urlparse(manifest.download_url).hostname
                if manifest.download_url
                else None,
                "url": manifest.download_url,
            },
            "requires_network": bool(manifest.download_url),
            "local_only": True,
            "status": status,
            "provider_status": provider_status,
            "progress": progress,
            "required_disk_bytes": math.ceil(manifest.installed_size_bytes * 1.2),
            "runtime_requirements": dict(manifest.runtime_requirements),
            "files": [
                {
                    "relative_path": model_file.path,
                    "size_bytes": model_file.size_bytes,
                    "sha256": model_file.sha256,
                }
                for model_file in manifest.files
            ],
            "available_disk_bytes": available_disk_bytes,
        }


def _download_with_retry(
    url: str,
    destination: Path,
    expected_size: int,
    expected_sha256: str,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
) -> None:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            _download_file(
                url, destination, expected_size, cancel_event, progress
            )
            if (
                _file_size(destination) != expected_size
                or _file_sha256(destination) != expected_sha256
            ):
                destination.unlink(missing_ok=True)
                raise ModelError("MODEL_HASH_MISMATCH", "模型文件校验失败，请重试下载")
            return
        except ModelError:
            raise
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = exc
            if cancel_event.is_set():
                raise ModelError("MODEL_DOWNLOAD_CANCELLED", "模型下载已取消") from exc
            if attempt < 2:
                continue
    raise ModelError("MODEL_DOWNLOAD_FAILED", "模型下载失败") from last_error


def _download_file(
    url: str,
    destination: Path,
    expected_size: int,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
) -> None:
    parsed = urlparse(url)
    if parsed.scheme == "file":
        source = Path(urllib.request.url2pathname(parsed.path))
        if not source.is_file():
            raise OSError("source missing")
        offset = destination.stat().st_size if destination.exists() else 0
        if offset > expected_size or offset > source.stat().st_size:
            offset = 0
            destination.unlink(missing_ok=True)
        with source.open("rb") as reader, destination.open("ab" if offset else "wb") as writer:
            reader.seek(offset)
            copied = offset
            while chunk := reader.read(1024 * 1024):
                if cancel_event.is_set():
                    raise ModelError("MODEL_DOWNLOAD_CANCELLED", "模型下载已取消")
                writer.write(chunk)
                copied += len(chunk)
                progress(copied)
        return
    offset = destination.stat().st_size if destination.exists() else 0
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": _HTTP_USER_AGENT,
            "Accept": "application/octet-stream,*/*",
        },
    )
    if offset:
        request.add_header("Range", f"bytes={offset}-")
    with urllib.request.urlopen(request, timeout=30) as response:
        status = getattr(response, "status", 200)
        if offset and status != 206:
            offset = 0
            destination.unlink(missing_ok=True)
        mode = "ab" if offset else "wb"
        copied = offset
        with destination.open(mode) as writer:
            while chunk := response.read(1024 * 1024):
                if cancel_event.is_set():
                    raise ModelError("MODEL_DOWNLOAD_CANCELLED", "模型下载已取消")
                writer.write(chunk)
                copied += len(chunk)
                progress(copied)
    if copied != expected_size:
        raise OSError("unexpected response size")


def _validate_manifest(manifest: ModelManifest) -> None:
    if manifest.provider not in MODEL_PROVIDERS:
        raise ModelError("INTERNAL_ERROR", "内部错误")
    if sum(model_file.size_bytes for model_file in manifest.files) != manifest.size_bytes:
        raise ModelError("INTERNAL_ERROR", "内部错误")
    if manifest.download_url:
        parsed = urlparse(manifest.download_url)
        if parsed.scheme != "https" and parsed.scheme not in {"file", "http"}:
            raise ModelError("INTERNAL_ERROR", "内部错误")
    if not manifest.supported_languages:
        raise ModelError("INTERNAL_ERROR", "内部错误")


def _provider_status(install_status: str, provider: str = "faster-whisper") -> str:
    runtime_module = MODEL_PROVIDER_RUNTIME_MODULES.get(provider)
    if runtime_module and importlib.util.find_spec(runtime_module) is None:
        return "runtime_unavailable"
    if install_status == "ready":
        return "installed"
    if install_status == "corrupt":
        return "corrupt"
    return "unavailable"


def _required_text(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ValueError(f"{key} is required")
    return result


def _positive_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("数值必须为正整数")
    return value


def _sha256(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 64 or value != value.lower():
        raise ValueError("SHA-256 格式不合法")
    int(value, 16)
    return value


def _language(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 16:
        raise ValueError("语言标识不合法")
    return value


def _relative_path(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("路径必须是相对路径")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value:
        raise ValueError("manifest path must be relative")
    return str(path)


def _local_source_url(parsed: Any, model_file: ModelFile) -> str:
    """校验本地来源，并返回规范化的 file:// URL。

    为什么返回重写后的 URL 而不是原串：`_download_file` 会自己再
    `urlparse` 一次并只取 `parsed.path`。清单写成
    `file://${VAR}/...` 时，展开后盘符落进了 netloc（Windows），原串透传
    会让 `parsed.path` 变成 `/vision_model.onnx`——悄悄读错文件。
    改成 `Path.as_uri()` 产出的 `file:///C:/...` 形式两边都认，顺带把空格/中文正确转义。

    为什么复用 MODEL_DOWNLOAD_FAILED 而不新增错误码：MODEL_* 是
    docs/STAGE1B_CONTRACT_FREEZE.md:283-291 冻结的稳定码集合，
    packages/contracts/src/index.ts:116-118 同步维护同一集合；
    app.py:1148 只按 code 选 HTTP 状态、message 原样透出。对调用方而言
    "本地来源没准备好"与"下载失败"是同一件事（都要先备好来源再重试），
    因此只把 message 写成本机可执行的指引。
    """
    path = _local_source_path(parsed)
    if path is None:
        raise ModelError(
            "MODEL_DOWNLOAD_FAILED",
            f"模型下载失败：本地来源路径无法解析（{model_file.path}）。"
            "请确认清单里的 file:// 来源是绝对路径。",
        )
    missing = _unexpanded_vars(str(path))
    if missing:
        raise ModelError(
            "MODEL_DOWNLOAD_FAILED",
            "模型下载失败：环境变量 "
            + "、".join(missing)
            + " 未设置，无法定位本地模型产物。请先运行 "
            "tools/model_export/export_chinese_clip_onnx.py 导出产物，"
            "再把它设为产物所在目录后重试。",
        )
    if not path.is_file():
        raise ModelError(
            "MODEL_DOWNLOAD_FAILED",
            f"模型下载失败：本地来源不存在文件 {path}。请先运行 "
            "tools/model_export/export_chinese_clip_onnx.py 导出产物，"
            "并确认 AIVS_MODEL_SOURCE_ROOT 指向该产物目录"
            f"（当前解析为 {path.parent}）。",
        )
    return path.resolve().as_uri()


def _local_source_path(parsed: Any) -> Path | None:
    """把已展开的 file:// URL 还原成本机路径（盘符 / UNC / POSIX）。

    urlparse 对 file://C:/dir/x 把盘符归到 netloc，对 file:///C:/dir/x
    把前导斜杠并进 path——两种写法都要能还原，否则 Windows 上清单写成
    file:// + 变量（展开后 netloc 带盘符）会被拼成相对路径，悄悄读不到文件。
    """
    netloc, path = parsed.netloc, parsed.path
    if not path:
        return None
    if netloc:
        joined = netloc + path if _WINDOWS_DRIVE.match(netloc) else "//" + netloc + path
    else:
        joined = path
    resolved = urllib.request.url2pathname(joined)
    if not resolved:
        return None
    return Path(resolved)


def _unexpanded_vars(value: str) -> list[str]:
    """列出 expandvars 之后仍残留的变量名（环境里没设的那些）。"""
    found: list[str] = []
    for match in _UNEXPANDED_VAR.finditer(value):
        found.extend(group for group in match.groups() if group)
    return sorted(set(found))


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return -1


def _manifest_files_sha256(directory: Path, files: tuple[ModelFile, ...]) -> str:
    """Hash the manifest-defined file stream in stable manifest order."""
    digest = hashlib.sha256()
    for model_file in files:
        path = directory / Path(model_file.path)
        try:
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            return ""
    return digest.hexdigest()


def _directory_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())
