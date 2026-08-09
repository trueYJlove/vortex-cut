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
