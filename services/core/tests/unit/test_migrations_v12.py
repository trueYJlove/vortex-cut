from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from aivs_core.database import MIGRATIONS, V12_SQL, Database


def test_v12_is_append_only_and_enforces_aggregate_ownership(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    db = Database(path)
    db.initialize()
    with db.connection() as sql:
        versions = [
            row[0] for row in sql.execute("SELECT version FROM schema_migrations ORDER BY rowid")
        ]
        assert versions == [f"v{i}" for i in range(1, 13)]
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v12'").fetchone()[0]
            == hashlib.sha256(V12_SQL.encode("utf-8")).hexdigest()
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        tables = {
            row[0] for row in sql.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {"shot_lists", "shot_list_revisions", "shot_requirements"} <= tables
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 13)}


def test_v11_upgrade_keeps_history_and_creates_backup(tmp_path: Path, monkeypatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    original = database_module.MIGRATIONS
    v1_v11 = {
        version: sql
        for version, sql in original.items()
        if int(version.removeprefix("v")) <= 11
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", v1_v11)
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        sql.execute(
            "INSERT INTO projects("
            "id,name,status,canvas_json,current_timeline_revision_id,root_dir,"
            "root_dir_name,created_at,updated_at,last_opened_at"
            ") VALUES ('p','P','active','{}',NULL,'r','r','n','n','n')"
        )
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    upgraded = Database(path)
    upgraded.initialize()
    assert upgraded.last_backup is not None and upgraded.last_backup.exists()
    with upgraded.connection() as sql:
        assert sql.execute("SELECT name FROM projects WHERE id='p'").fetchone()[0] == "P"
        assert (
            sql.execute(
                "SELECT version FROM schema_migrations ORDER BY rowid DESC LIMIT 1"
            ).fetchone()[0]
            == "v12"
        )
