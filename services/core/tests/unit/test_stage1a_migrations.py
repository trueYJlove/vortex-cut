import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database, MigrationError


def test_stage0_database_is_adopted_and_preserved(tmp_path: Path):
    legacy = tmp_path / "stage0.db"
    with sqlite3.connect(legacy) as db:
        db.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY,type TEXT NOT NULL,status TEXT NOT NULL,"
            "input_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
        )
        db.execute("INSERT INTO jobs VALUES ('old','proxy','queued','{}','now','now')")
    db = Database(tmp_path / "app.db")
    db.initialize()
    assert legacy.exists()
    with db.connection() as connection:
        assert connection.execute("SELECT kind FROM jobs WHERE id='old'").fetchone()[0] == "proxy"
        assert connection.execute("SELECT version FROM schema_migrations").fetchone()[0] == "v1"
    assert list((tmp_path / "backups").glob("app-*.db"))


def test_unknown_schema_version_is_rejected(tmp_path: Path):
    path = tmp_path / "app.db"
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, "
            "applied_at TEXT NOT NULL, checksum TEXT NOT NULL)"
        )
        db.execute("INSERT INTO schema_migrations VALUES ('v99','now','checksum')")
    with pytest.raises(MigrationError):
        Database(path).initialize()


def test_migration_failure_rolls_back_and_keeps_backup(tmp_path: Path, monkeypatch):
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    monkeypatch.setattr(database_module, "MIGRATIONS", {"v1": "CREATE TABLE broken ("})
    with pytest.raises(MigrationError):
        Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='broken'"
        ).fetchone() is None
    assert list((tmp_path / "backups").glob("app-*.db"))
