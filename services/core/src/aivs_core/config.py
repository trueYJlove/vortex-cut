from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import __version__


def _resource_path(name: str) -> Path:
    configured_root = os.environ.get("AIVS_RESOURCE_ROOT")
    bundle_root = getattr(sys, "_MEIPASS", None)
    executable_root = Path(sys.executable).resolve().parent
    candidates = [
        Path(configured_root).expanduser() if configured_root else None,
        Path(bundle_root) if bundle_root else None,
        executable_root / "_internal",
        executable_root,
        Path.cwd().resolve() / "resources",
        Path.cwd().resolve(),
    ]
    roots = [candidate.resolve() for candidate in candidates if candidate is not None]
    for root in roots:
        path = root / name
        if path.exists():
            return path
    return roots[0] / name


DEFAULT_MANIFEST_DIR = _resource_path("model-manifests")
DEFAULT_FONT_DIR = _resource_path("fonts")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 0
    data_dir: Path = Path(".aivideo")
    ffmpeg: Path = Path("ffmpeg")
    ffprobe: Path = Path("ffprobe")
    parent_pid: int | None = None
    runtime_dir: Path | None = None
    build_version: str = __version__
    log_level: str = "info"
    ready_file: Path | None = None
    manifest_dir: Path = field(default_factory=lambda: _resource_path("model-manifests"))
    font_dir: Path = field(default_factory=lambda: _resource_path("fonts"))

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "jobs").mkdir(exist_ok=True)
        (self.data_dir / "backups").mkdir(exist_ok=True)
        (self.data_dir / "projects").mkdir(exist_ok=True)
        if self.runtime_dir:
            self.runtime_dir.mkdir(parents=True, exist_ok=True)

    @property
    def database_path(self) -> Path:
        return self.data_dir / "app.db"

    @classmethod
    def from_args(cls, args: object) -> Settings:
        manifest_dir = getattr(args, "manifest_dir", None)
        return cls(
            host=getattr(args, "host"),
            port=getattr(args, "port"),
            data_dir=Path(getattr(args, "data_dir")),
            ffmpeg=Path(getattr(args, "ffmpeg")),
            ffprobe=Path(getattr(args, "ffprobe")),
            parent_pid=getattr(args, "parent_pid"),
            runtime_dir=Path(getattr(args, "runtime_dir"))
            if getattr(args, "runtime_dir", None)
            else None,
            log_level=getattr(args, "log_level"),
            ready_file=Path(getattr(args, "ready_file"))
            if getattr(args, "ready_file", None)
            else None,
            manifest_dir=(
                Path(manifest_dir) if manifest_dir else _resource_path("model-manifests")
            ),
        )


def admin_token_from_environment() -> str:
    token = os.environ.get("AIVS_ADMIN_TOKEN", "")
    if not token:
        raise RuntimeError("AIVS_ADMIN_TOKEN is required")
    return token
