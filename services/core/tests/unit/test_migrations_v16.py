# ruff: noqa: E501
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V16_SQL, Database


def _seed_v15(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {key: value for key, value in original.items() if key != "v16"},
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def test_v15_to_v16_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old = _seed_v15(path, monkeypatch)
    database = Database(path)
    database.initialize()
    assert database.last_backup is not None and database.last_backup.exists()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v16'")
        )
        assert history == old
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v16'").fetchone()[0]
            == hashlib.sha256(V16_SQL.encode()).hexdigest()
        )
        assert (
            sql.execute(
                "SELECT COUNT(*) FROM shot_requirement_timeline_assembly_previews"
            ).fetchone()[0]
            == 0
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assemblies").fetchone()[0]
            == 0
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 18)}


def test_v16_objects_and_immutable_triggers_exist(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        objects = {row[0] for row in sql.execute("SELECT name FROM sqlite_master")}
    assert {
        "shot_requirement_timeline_assembly_previews",
        "shot_requirement_timeline_assemblies",
        "stage5_previews_validate_insert",
        "stage5_previews_no_update",
        "stage5_previews_no_delete",
        "stage5_assemblies_validate_insert",
        "stage5_assemblies_no_update",
        "stage5_assemblies_no_delete",
    } <= objects


def test_v16_failure_rolls_back_append_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    _seed_v15(path, monkeypatch)
    broken = dict(database_module.MIGRATIONS)
    broken["v16"] = V16_SQL + "\nCREATE TABLE broken("
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(Exception):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute("SELECT 1 FROM schema_migrations WHERE version='v16'").fetchone() is None
        assert (
            sql.execute(
                "SELECT 1 FROM sqlite_master WHERE name='shot_requirement_timeline_assembly_previews'"
            ).fetchone()
            is None
        )
