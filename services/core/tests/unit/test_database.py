import pytest

import aivs_core.database as database_module
from aivs_core.database import Database, MigrationError

pytestmark = pytest.mark.real_db_init


def test_sqlite_is_wal_and_running_jobs_are_interrupted(tmp_path) -> None:
    db = Database(tmp_path / "stage0.db")
    db.initialize()
    with db.connection() as connection:
        connection.execute(
            "INSERT INTO jobs (id,type,status,input_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            ("job", "proxy", "running", "{}", "now", "now"),
        )
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert db.recover_interrupted() == 1
    with db.connection() as connection:
        assert (
            connection.execute("SELECT status FROM jobs WHERE id='job'").fetchone()[0]
            == "interrupted"
        )


def test_settings_and_admin_token_paths(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from aivs_core.config import Settings, admin_token_from_environment

    settings = Settings.from_args(
        SimpleNamespace(
            host="0.0.0.0",
            port=1234,
            data_dir=str(tmp_path / "data"),
            ffmpeg="ffmpeg.exe",
            ffprobe="ffprobe.exe",
            parent_pid=3,
            runtime_dir=str(tmp_path / "runtime"),
            log_level="debug",
            ready_file=str(tmp_path / "ready.json"),
        )
    )
    settings.prepare()
    assert settings.database_path == tmp_path / "data" / "app.db"
    monkeypatch.delenv("AIVS_ADMIN_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="AIVS_ADMIN_TOKEN"):
        admin_token_from_environment()
    monkeypatch.setenv("AIVS_ADMIN_TOKEN", "token")
    assert admin_token_from_environment() == "token"


def test_reinitialize_skips_rewriting_non_null_job_kind(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    db = Database(db_path)
    db.initialize()
    with db.connection() as connection:
        connection.execute(
            "INSERT INTO jobs (id,type,kind,status,input_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            ("job_set", "proxy", "proxy", "queued", "{}", "now", "now"),
        )
        connection.execute("CREATE TABLE job_updates (id TEXT NOT NULL)")
        connection.execute(
            "CREATE TRIGGER track_job_updates AFTER UPDATE ON jobs "
            "BEGIN INSERT INTO job_updates VALUES (NEW.id); END;"
        )

    Database(db_path).initialize()

    with db.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM job_updates").fetchone()[0] == 0


def test_ensure_v1_columns_only_backfills_null_kind(tmp_path) -> None:
    import contextlib
    import sqlite3

    with contextlib.closing(sqlite3.connect(tmp_path / "legacy.db")) as connection:
        connection.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, kind TEXT)"
        )
        connection.execute("INSERT INTO jobs VALUES ('job_set', 'proxy', 'render')")
        connection.execute("INSERT INTO jobs VALUES ('job_null', 'proxy', NULL)")
        connection.execute("CREATE TABLE job_updates (id TEXT NOT NULL)")
        connection.execute(
            "CREATE TRIGGER track_job_updates AFTER UPDATE ON jobs "
            "BEGIN INSERT INTO job_updates VALUES (NEW.id); END;"
        )
        Database._ensure_v1_columns(connection)
        updated_ids = [
            row[0] for row in connection.execute("SELECT id FROM job_updates").fetchall()
        ]
        assert updated_ids == ["job_null"]
        set_kind = connection.execute("SELECT kind FROM jobs WHERE id='job_set'").fetchone()[0]
        null_kind = connection.execute("SELECT kind FROM jobs WHERE id='job_null'").fetchone()[0]
        assert set_kind == "render"
        assert null_kind == "proxy"


def test_monkeypatched_migrations_detect_checksum_mismatch(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "app.db"
    Database(db_path).initialize()
    modified = dict(database_module.MIGRATIONS)
    modified["v1"] = modified["v1"] + "\n-- altered"
    monkeypatch.setattr(database_module, "MIGRATIONS", modified)
    with pytest.raises(MigrationError, match="迁移校验和不匹配"):
        Database(db_path).initialize()
