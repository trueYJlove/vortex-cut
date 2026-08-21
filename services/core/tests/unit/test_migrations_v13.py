from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V13_SQL, Database, MigrationError


def _seed_v12(path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {
            key: value
            for key, value in original.items()
            if key not in {"v13", "v14", "v15", "v16", "v17"}
        },
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES ('p','P','active','{}',NULL,'root','root','n','n','n')"
        )
        sql.execute(
            "INSERT INTO media_generation_requests VALUES "
            "('r','p','image','simulation_only','sha256:p','[]','{}','sha256:r','n')"
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
            "created_at,updated_at) VALUES "
            "('j','p','media_generation','media_generation','succeeded','completed',1,'{}',1,'n','n')"
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "created_at,updated_at,finished_at) VALUES "
            "('t','r','j',1,'succeeded','completed','n','n','n')"
        )
        request_rows = sql.execute("SELECT * FROM media_generation_requests").fetchall()
        request_values = [tuple(row) for row in request_rows]
        request_hash = hashlib.sha256(repr(request_values).encode()).hexdigest()
        task_rows = sql.execute("SELECT * FROM media_generation_tasks").fetchall()
        task_values = [tuple(row) for row in task_rows]
        task_hash = hashlib.sha256(repr(task_values).encode()).hexdigest()
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return request_hash, task_hash


def test_v13_rebuild_preserves_history_checksums_and_constraints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    request_hash, task_hash = _seed_v12(path, monkeypatch)
    old_checksums: dict[str, str]
    with sqlite3.connect(path) as sql:
        old_checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    upgraded = Database(path)
    upgraded.initialize()
    assert upgraded.last_backup is not None and upgraded.last_backup.exists()
    with upgraded.connection() as sql:
        history = dict(
            sql.execute(
                "SELECT version,checksum FROM schema_migrations "
                "WHERE version NOT IN ('v13','v14','v15','v16','v17')"
            )
        )
        assert history == old_checksums
        v13_checksum = sql.execute(
            "SELECT checksum FROM schema_migrations WHERE version='v13'"
        ).fetchone()[0]
        assert v13_checksum == hashlib.sha256(V13_SQL.encode()).hexdigest()
        request_rows = sql.execute(
            "SELECT * FROM media_generation_requests WHERE id='r'"
        ).fetchall()
        request_values = [tuple(row) for row in request_rows]
        assert hashlib.sha256(repr(request_values).encode()).hexdigest() == request_hash
        task_rows = sql.execute(
            "SELECT * FROM media_generation_tasks WHERE id='t'"
        ).fetchall()
        task_values = [tuple(row) for row in task_rows]
        assert hashlib.sha256(repr(task_values).encode()).hexdigest() == task_hash
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        sql.execute(
            "INSERT INTO media_generation_requests VALUES "
            "('r2','p','image','provider_image_v1','sha256:p2','[]','{}','sha256:r2','n')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("UPDATE media_generation_requests SET prompt_sha256='x' WHERE id='r'")
        columns = {row[1]: (row[3], row[4]) for row in sql.execute(
            "PRAGMA table_info(provider_image_invocations)"
        )}
        assert columns["cleanup_required"] == (1, "0")
        assert columns["output_relative_path"] == (0, None)
    assert "v13" in MIGRATIONS


def test_v13_failure_rolls_back_rebuild(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    request_hash, task_hash = _seed_v12(path, monkeypatch)
    original = database_module.V13_SQL
    broken = original.replace(
        "CREATE TABLE image_provider_configs (",
        "CREATE TABLE image_provider_configs (\n  broken_column TEXT CHECK(,",
    )
    monkeypatch.setitem(database_module.MIGRATIONS, "v13", broken)
    with pytest.raises(MigrationError):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute("SELECT 1 FROM schema_migrations WHERE version='v13'").fetchone() is None
        request_rows = sql.execute(
            "SELECT * FROM media_generation_requests WHERE id='r'"
        ).fetchall()
        request_values = [tuple(row) for row in request_rows]
        assert hashlib.sha256(repr(request_values).encode()).hexdigest() == request_hash
        task_rows = sql.execute(
            "SELECT * FROM media_generation_tasks WHERE id='t'"
        ).fetchall()
        task_values = [tuple(row) for row in task_rows]
        assert hashlib.sha256(repr(task_values).encode()).hexdigest() == task_hash
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
