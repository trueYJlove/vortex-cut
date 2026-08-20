from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

import aivs_core.database as database_module
from aivs_core.database import Database, MigrationError

V3_TABLES = {
    "timeline_revisions",
    "timeline_drafts",
    "timeline_navigation",
    "render_artifacts",
    "export_records",
}


def _v2_database(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    full = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {"v1": database_module.V1_SQL, "v2": database_module.V2_SQL},
    )
    Database(path).initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full)


def _v3_database(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    full = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {
            "v1": database_module.V1_SQL,
            "v2": database_module.V2_SQL,
            "v3": database_module.V3_SQL,
        },
    )
    Database(path).initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full)


def test_v2_upgrade_creates_v3_backup_and_preserves_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v2_database(path, monkeypatch)
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','root','root','now','now','now')"
        )
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) VALUES "
            "('a1','p1','video','external','v.mp4','fp',1,'available',"
            "'{\"duration_us\":1000000}','now','now')"
        )
        db.execute(
            "INSERT INTO transcripts(id,asset_id,status,language,provider,model_id,"
            "model_revision,source_fingerprint,duration_us,created_at,updated_at) VALUES "
            "('t1','a1','ready','zh','p','m','r','fp',1000000,'now','now')"
        )
    before = set((tmp_path / "backups").glob("app-*.db"))
    database = Database(path)
    database.initialize()
    after = set((tmp_path / "backups").glob("app-*.db"))
    with sqlite3.connect(path) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert V3_TABLES <= tables
        assert db.execute("SELECT name FROM projects WHERE id='p1'").fetchone()[0] == "P"
        assert db.execute("SELECT fingerprint FROM assets WHERE id='a1'").fetchone()[0] == "fp"
        assert db.execute("SELECT status FROM transcripts WHERE id='t1'").fetchone()[0] == "ready"
        job_columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        assert {
            "timeline_revision_id",
            "idempotency_key",
            "resource_class",
            "result_json",
        } <= job_columns
    assert after - before


def test_real_v3_copy_upgrades_to_v4_and_preserves_all_stage1_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v3_database(path, monkeypatch)
    with sqlite3.connect(path) as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) "  # noqa: E501
            "VALUES ('p1','project','active','{}','root','root','now','now','now')"
        )
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,availability,created_at,updated_at) "  # noqa: E501
            "VALUES ('a1','p1','video','external','source.mp4','fp',1,'available','now','now')"
        )
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,input_json,created_at,updated_at) "
            "VALUES ('j1','p1','proxy','proxy','succeeded','{}','now','now')"
        )
        db.execute(
            "INSERT INTO model_installations VALUES ('m1','local','r1','ready','dir',1,1,'sha','license',NULL,'now')"  # noqa: E501
        )
        db.execute(
            "INSERT INTO transcripts VALUES ('t1','a1','ready','zh','local','m1','r1','fp',1000000,'now','now')"  # noqa: E501
        )
        db.execute("INSERT INTO transcript_segments VALUES ('s1','t1',0,0,1000000,'保留片段',0.9)")
    before = set((tmp_path / "backups").glob("app-*.db"))
    Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert [
            x[0]
            for x in db.execute(
                "SELECT version FROM schema_migrations ORDER BY CAST(SUBSTR(version,2) AS INTEGER)"
            )
        ] == [
            "v1",
            "v2",
            "v3",
            "v4",
            "v5",
            "v6",
            "v7",
            "v8",
            "v9",
            "v10",
            "v11",
            "v12",
            "v13",
            "v14",
            "v15",
            "v16",
        ]
        assert db.execute("SELECT name FROM projects WHERE id='p1'").fetchone() == ("project",)
        assert db.execute("SELECT fingerprint FROM assets WHERE id='a1'").fetchone() == ("fp",)
        assert db.execute("SELECT status FROM jobs WHERE id='j1'").fetchone() == ("succeeded",)
        assert db.execute(
            "SELECT status FROM model_installations WHERE model_id='m1'"
        ).fetchone() == ("ready",)
        assert db.execute("SELECT text FROM transcript_segments WHERE id='s1'").fetchone() == (
            "保留片段",
        )
        assert {x[1] for x in db.execute("PRAGMA table_info(jobs)")} >= {
            "provider_invocation_id",
            "candidate_generation_id",
        }
    assert set((tmp_path / "backups").glob("app-*.db")) - before


def test_v3_checksum_mismatch_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    Database(path).initialize()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE schema_migrations SET checksum='bad' WHERE version='v3'")
    with pytest.raises(MigrationError, match="v3"):
        Database(path).initialize()


def test_v3_failure_rolls_back_and_preserves_v2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v2_database(path, monkeypatch)
    broken = {
        "v1": database_module.V1_SQL,
        "v2": database_module.V2_SQL,
        "v3": "CREATE TABLE timeline_revisions(id TEXT PRIMARY KEY); CREATE TABLE broken (",
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(MigrationError):
        Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert (
            db.execute("SELECT name FROM sqlite_master WHERE name='timeline_revisions'").fetchone()
            is None
        )
        versions = [row[0] for row in db.execute("SELECT version FROM schema_migrations")]
        assert versions == ["v1", "v2"]


def test_published_v1_v2_checksums_are_unchanged() -> None:
    assert hashlib.sha256(database_module.V1_SQL.encode()).hexdigest() == (
        "c2011a2ce8e9c7b7b4d3fb810d662869a03b27658f013ba86aa7b91b4aeb2482"
    )
    assert hashlib.sha256(database_module.V2_SQL.encode()).hexdigest() == (
        "f0b42cbf9d2461fbd6391fdeae961afb097f1a2f56a90ab9e78965188bdb69c1"
    )


def test_timeline_revisions_are_database_immutable(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    Database(path).initialize()
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','root','root','now','now','now')"
        )
        db.execute(
            "INSERT INTO timeline_revisions VALUES "
            "('r1','p1',NULL,1,'{}','sha256:x','summary','user','now')"
        )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("UPDATE timeline_revisions SET summary='changed' WHERE id='r1'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("DELETE FROM timeline_revisions WHERE id='r1'")
