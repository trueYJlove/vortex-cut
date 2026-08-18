from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, Database, MigrationError

_FROZEN_V1_V9 = {
    "v1": "c2011a2ce8e9c7b7b4d3fb810d662869a03b27658f013ba86aa7b91b4aeb2482",
    "v2": "f0b42cbf9d2461fbd6391fdeae961afb097f1a2f56a90ab9e78965188bdb69c1",
    "v3": "cbb2468c07fbebb1e1827cece7a0c3be3763923983557a3398f5547a50e94975",
    "v4": "a3a5bea51c6e2dc5c2e8eda1fa66718eadeb5df6454d3fb84ae04662fa2f990d",
    "v5": "3507d16a8748795fe90d3de9c70c001e0359cbf912f16d464163df16c4adbe48",
    "v6": "32a95f3bfd135c5ec856379c6bc664d35828e4b71c97898d386f808a43581eea",
    "v7": "7b914bc57ba852b9367803ab98e629024735c09a2794482f7b466b4a9a49277f",
    "v8": "3c15d263cc69aab4e48afd534188a11eb5ccf7a0a98b9a44d0847dc7000e1f88",
    "v9": "416aa55b15e8b1e78e76b59dc276f397e481f0574b5af46fe7e600de6f94f172",
}


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}


def test_v10_new_schema_is_idempotent_append_only_and_frozen(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    database.initialize()
    with database.connection() as db:
        applied = dict(db.execute("SELECT version,checksum FROM schema_migrations"))
        assert set(applied) == set(MIGRATIONS)
        assert applied == {
            version: hashlib.sha256(sql.encode("utf-8")).hexdigest()
            for version, sql in MIGRATIONS.items()
        }
        assert {
            "rendition_reframe_snapshots",
            "reframe_export_batches",
            "reframe_export_batch_items",
        } <= {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "reframe_export_batch_item_id" in _columns(db, "jobs")
        assert "rendition_reframe_snapshot_id" in _columns(db, "render_artifacts")
        assert "reframe_export_batch_item_id" in _columns(db, "export_records")
    assert {
        version: hashlib.sha256(MIGRATIONS[version].encode("utf-8")).hexdigest()
        for version in _FROZEN_V1_V9
    } == _FROZEN_V1_V9


def test_v10_upgrades_real_v9_without_backfill(tmp_path: Path, monkeypatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    database = Database(path)
    full_migrations = database_module.MIGRATIONS
    v1_v9 = {
        version: sql
        for version, sql in full_migrations.items()
        if int(version.removeprefix("v")) <= 9
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", v1_v9)
    database.initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full_migrations)
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project_1", "Project", "active", "{}", None, "root", "root", "now", "now", "now"),
        )
        assert "reframe_export_batch_item_id" not in _columns(db, "jobs")
    database.initialize()
    with database.connection() as db:
        assert (
            db.execute("SELECT name FROM projects WHERE id='project_1'").fetchone()[0] == "Project"
        )
        assert "reframe_export_batch_item_id" in _columns(db, "jobs")
        assert db.execute("SELECT COUNT(*) FROM rendition_reframe_snapshots").fetchone()[0] == 0


def test_v10_immutable_tables_and_stage3_ownership_are_enforced(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p", "P", "active", "{}", "r", "root", "root", "now", "now", "now"),
        )
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("r", "p", None, 1, "{}", "doc", "s", "user", "now"),
        )
        db.execute(
            "INSERT INTO rendition_snapshots("
            "id,project_id,timeline_revision_id,timeline_document_sha256,platform_preset_id,"
            "platform_preset_version,platform_preset_sha256,rendition_preset_id,"
            "rendition_preset_version,rendition_preset_sha256,layout_policy,snapshot_json,"
            "snapshot_sha256,warnings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "s",
                "p",
                "r",
                "doc",
                "generic",
                1,
                "ph",
                "portrait-9x16-v1",
                1,
                "rh",
                "crop_fill_all",
                "{}",
                "base",
                "[]",
                "now",
            ),
        )
        db.execute(
            "INSERT INTO rendition_reframe_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "rs",
                "p",
                "r",
                "doc",
                "s",
                "base",
                "generic",
                "portrait-9x16-v1",
                1,
                "{}",
                "reframe",
                1,
                "[]",
                "now",
            ),
        )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("UPDATE rendition_reframe_snapshots SET warnings_json='[1]' WHERE id='rs'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("DELETE FROM rendition_reframe_snapshots WHERE id='rs'")
        with pytest.raises(sqlite3.IntegrityError, match="mutually exclusive"):
            db.execute(
                "INSERT INTO jobs(id,kind,type,status,progress,input_json,"
                "export_batch_item_id,reframe_export_batch_item_id,attempt,created_at,updated_at) "
                "VALUES ('j','final_export','final_export','queued',0,'{}','a','b',1,'now','now')"
            )


def test_v10_rejects_unknown_version_and_checksum_damage(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute("INSERT INTO schema_migrations VALUES ('v99','now','x')")
    with pytest.raises(MigrationError, match="未知数据库版本"):
        database.initialize()
    with database.connection() as db:
        db.execute("DELETE FROM schema_migrations WHERE version='v99'")
        db.execute("UPDATE schema_migrations SET checksum='x' WHERE version='v9'")
    with pytest.raises(MigrationError, match="迁移校验和不匹配: v9"):
        database.initialize()
