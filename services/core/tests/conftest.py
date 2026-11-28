from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

import aivs_core.database as database_module
from aivs_core.database import Database

_CURRENT_TEST_FILE: Path | None = None
_TEMPLATE_DB_PATH: Path | None = None
_ORIG_INITIALIZE = Database.initialize
_CANONICAL_MIGRATIONS = dict(database_module.MIGRATIONS)


@pytest.fixture(autouse=True)
def _track_current_test_file(request: pytest.FixtureRequest) -> None:
    global _CURRENT_TEST_FILE
    _CURRENT_TEST_FILE = Path(str(request.node.fspath))


@pytest.fixture(scope="session", autouse=True)
def _template_db_cache(tmp_path_factory: pytest.TempPathFactory):
    """Build one clean pre-migrated SQLite template DB for fast test cloning."""
    global _TEMPLATE_DB_PATH
    template_dir = tmp_path_factory.mktemp("aivs_db_template")
    template_path = template_dir / "template.db"
    db = Database(template_path)
    _ORIG_INITIALIZE(db)
    with sqlite3.connect(template_path) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    _TEMPLATE_DB_PATH = template_path

    def _fast_initialize(self: Database) -> None:
        current = _CURRENT_TEST_FILE
        is_migration_or_backup_test = (
            current is None
            or "migration" in current.name.lower()
            or "stage1a_api" in current.name.lower()
        )
        can_clone = (
            not is_migration_or_backup_test
            and _TEMPLATE_DB_PATH is not None
            and _TEMPLATE_DB_PATH.exists()
            and not self.path.exists()
            and not (self.path.name == "app.db" and self.path.with_name("stage0.db").exists())
            and database_module.MIGRATIONS == _CANONICAL_MIGRATIONS
        )
        if can_clone:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_TEMPLATE_DB_PATH, self.path)
            return
        _ORIG_INITIALIZE(self)

    Database.initialize = _fast_initialize  # type: ignore[method-assign]
    try:
        yield
    finally:
        Database.initialize = _ORIG_INITIALIZE  # type: ignore[method-assign]
        _TEMPLATE_DB_PATH = None


@pytest.fixture
def tmp_media(tmp_path: Path) -> Path:
    media = tmp_path / "sample 中文 file.mp4"
    media.write_bytes(b"test media")
    return media
