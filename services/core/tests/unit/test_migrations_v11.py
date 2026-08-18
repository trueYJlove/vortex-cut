from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, Database, MigrationError

_FROZEN_V1_V10 = {
    "v1": "c2011a2ce8e9c7b7b4d3fb810d662869a03b27658f013ba86aa7b91b4aeb2482",
    "v2": "f0b42cbf9d2461fbd6391fdeae961afb097f1a2f56a90ab9e78965188bdb69c1",
    "v3": "cbb2468c07fbebb1e1827cece7a0c3be3763923983557a3398f5547a50e94975",
    "v4": "a3a5bea51c6e2dc5c2e8eda1fa66718eadeb5df6454d3fb84ae04662fa2f990d",
    "v5": "3507d16a8748795fe90d3de9c70c001e0359cbf912f16d464163df16c4adbe48",
    "v6": "32a95f3bfd135c5ec856379c6bc664d35828e4b71c97898d386f808a43581eea",
    "v7": "7b914bc57ba852b9367803ab98e629024735c09a2794482f7b466b4a9a49277f",
    "v8": "3c15d263cc69aab4e48afd534188a11eb5ccf7a0a98b9a44d0847dc7000e1f88",
    "v9": "416aa55b15e8b1e78e76b59dc276f397e481f0574b5af46fe7e600de6f94f172",
    "v10": "9f8408019c76220b708033d1e9c5c5374fa56a49ebd37d8b33148bce64a3628b",
}


def _project(db: sqlite3.Connection, project_id: str = "project_1") -> None:
    db.execute(
        "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
        (project_id, "P", "active", "{}", None, "root", "root", "now", "now", "now"),
    )


def test_v11_is_append_only_idempotent_and_preserves_frozen_checksums(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    database.initialize()
    with database.connection() as db:
        applied = dict(db.execute("SELECT version,checksum FROM schema_migrations"))
        objects = {
            (row[0], row[1])
            for row in db.execute(
                "SELECT name,type FROM sqlite_master WHERE name LIKE 'media_generation_%'"
            )
        }
    assert applied == {
        version: hashlib.sha256(sql.encode("utf-8")).hexdigest()
        for version, sql in MIGRATIONS.items()
    }
    assert {name for name, kind in objects if kind == "table"} == {
        "media_generation_requests",
        "media_generation_tasks",
    }
    assert {
        "media_generation_requests_no_update",
        "media_generation_requests_no_delete",
    } <= {name for name, kind in objects if kind == "trigger"}
    assert {
        version: hashlib.sha256(MIGRATIONS[version].encode("utf-8")).hexdigest()
        for version in _FROZEN_V1_V10
    } == _FROZEN_V1_V10


def test_v11_upgrades_v10_and_enforces_request_immutability(tmp_path: Path, monkeypatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    database = Database(path)
    full_migrations = database_module.MIGRATIONS
    v1_v10 = {
        version: sql
        for version, sql in full_migrations.items()
        if int(version.removeprefix("v")) <= 10
    }
    v1_v11 = {
        version: sql
        for version, sql in full_migrations.items()
        if int(version.removeprefix("v")) <= 11
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", v1_v10)
    database.initialize()
    with database.connection() as db:
        _project(db)
        assert (
            db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='media_generation_requests'"
            ).fetchone()
            is None
        )
    monkeypatch.setattr(database_module, "MIGRATIONS", v1_v11)
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)",
            ("r", "project_1", "image", "simulation_only", "ph", "[]", "{}", "rh", "now"),
        )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("UPDATE media_generation_requests SET prompt_sha256='x' WHERE id='r'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("DELETE FROM media_generation_requests WHERE id='r'")


def test_v11_enforces_idempotency_attempt_and_retry_lineage(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        _project(db)
        request = ("r", "project_1", "image", "simulation_only", "ph", "[]", "{}", "rh", "now")
        db.execute("INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)", request)
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            db.execute(
                "INSERT INTO media_generation_requests VALUES (?,?,?,?,?,?,?,?,?)",
                ("r2", *request[1:]),
            )
        for job_id in ("j1", "j2", "j3"):
            db.execute(
                "INSERT INTO jobs(id,kind,type,status,stage,progress,input_json,"
                "attempt,created_at,updated_at) VALUES (?, 'media_generation',"
                "'media_generation','failed','failed',0,'{}',1,'now','now')",
                (job_id,),
            )
        task = ("t1", "r", "j1", 1, "failed", "failed", None, "now", "now")
        db.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "retry_of_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            task,
        )
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            db.execute(
                "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
                "retry_of_task_id,created_at,updated_at) VALUES "
                "('duplicate','r','j2',1,'failed','failed',NULL,'now','now')"
            )
        db.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "retry_of_task_id,created_at,updated_at) VALUES "
            "('t2','r','j2',2,'failed','failed','t1','now','now')"
        )
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            db.execute(
                "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
                "retry_of_task_id,created_at,updated_at) VALUES "
                "('t3','r','j3',3,'failed','failed','t1','now','now')"
            )


def test_v11_still_rejects_unknown_version_and_checksum_damage(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute("INSERT INTO schema_migrations VALUES ('v999','now','x')")
    with pytest.raises(MigrationError, match="未知数据库版本"):
        database.initialize()
    with database.connection() as db:
        db.execute("DELETE FROM schema_migrations WHERE version='v999'")
        db.execute("UPDATE schema_migrations SET checksum='x' WHERE version='v10'")
    with pytest.raises(MigrationError, match="迁移校验和不匹配: v10"):
        database.initialize()
