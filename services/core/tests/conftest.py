from __future__ import annotations

import contextlib
import shutil
import sqlite3
from pathlib import Path

import pytest

import aivs_core.database as database_module
from aivs_core.database import Database

_CURRENT_TEST_ITEM: pytest.Item | None = None
_TEMPLATE_DB_PATH: Path | None = None
_ORIG_INITIALIZE = Database.initialize
_CANONICAL_MIGRATIONS = dict(database_module.MIGRATIONS)


def _requires_real_db_init(item: pytest.Item | None) -> bool:
    if item is None:
        return True
    if item.get_closest_marker("real_db_init") is not None:
        return True
    test_file = Path(str(getattr(item, "path", item.fspath))).name.lower()
    return "migration" in test_file or "stage1a_api" in test_file


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item: pytest.Item) -> None:
    global _CURRENT_TEST_ITEM
    _CURRENT_TEST_ITEM = item


@pytest.hookimpl(trylast=True)
def pytest_runtest_teardown(item: pytest.Item) -> None:
    del item
    global _CURRENT_TEST_ITEM
    _CURRENT_TEST_ITEM = None


@pytest.fixture(scope="session", autouse=True)
def _template_db_cache(tmp_path_factory: pytest.TempPathFactory):
    """Build one clean pre-migrated SQLite template DB for fast test cloning."""
    global _TEMPLATE_DB_PATH
    template_dir = tmp_path_factory.mktemp("aivs_db_template")
    template_path = template_dir / "template.db"
    db = Database(template_path)
    _ORIG_INITIALIZE(db)
    with contextlib.closing(sqlite3.connect(template_path)) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    _TEMPLATE_DB_PATH = template_path

    def _fast_initialize(self: Database) -> None:
        can_clone = (
            not _requires_real_db_init(_CURRENT_TEST_ITEM)
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
