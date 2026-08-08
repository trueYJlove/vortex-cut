from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from . import __version__


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

    def prepare(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "jobs").mkdir(exist_ok=True)
        if self.runtime_dir:
            self.runtime_dir.mkdir(parents=True, exist_ok=True)

    @property
    def database_path(self) -> Path:
        return self.data_dir / "stage0.db"

    @classmethod
    def from_args(cls, args: object) -> "Settings":
        return cls(
            host=getattr(args, "host"), port=getattr(args, "port"),
            data_dir=Path(getattr(args, "data_dir")), ffmpeg=Path(getattr(args, "ffmpeg")),
            ffprobe=Path(getattr(args, "ffprobe")), parent_pid=getattr(args, "parent_pid"),
            runtime_dir=Path(getattr(args, "runtime_dir")) if getattr(args, "runtime_dir", None) else None,
            log_level=getattr(args, "log_level"),
        )


def admin_token_from_environment() -> str:
    token = os.environ.get("AIVS_ADMIN_TOKEN", "")
    if not token:
        raise RuntimeError("AIVS_ADMIN_TOKEN is required")
    return token
