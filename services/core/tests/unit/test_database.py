import pytest

from aivs_core.database import Database


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
