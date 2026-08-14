from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import aivs_core.database as database_module
from aivs_core.database import Database, MigrationError


def _v7_database(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    full = database_module.MIGRATIONS
    monkeypatch.setattr(database_module, "MIGRATIONS", dict(list(full.items())[:-1]))
    Database(path).initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full)
    return full


def _insert_provider(db: sqlite3.Connection, provider_id: str = "provider-v7") -> None:
    db.execute(
        "INSERT INTO provider_configs("
        "id,kind,display_name,base_url,model,enabled,created_at,updated_at) "
        "VALUES (?,?,?,'https://provider.invalid','model-a',1,'now','now')",
        (provider_id, "openai_compatible_text", "Provider"),
    )


def test_v8_upgrades_real_v7_backup_preserves_data_and_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v7_database(path, monkeypatch)
    with sqlite3.connect(path) as db:
        _insert_provider(db)

    database = Database(path)
    database.initialize()
    assert database.last_backup is not None
    assert database.last_backup.exists()
    with database.connection() as db:
        row = db.execute(
            "SELECT display_name,candidate_capability_status,"
            "candidate_response_adapter_id,candidate_probe_protocol_version,"
            "candidate_capability_tested_at,candidate_capability_failure_code,"
            "candidate_capability_probe_sha256 FROM provider_configs WHERE id=?",
            ("provider-v7",),
        ).fetchone()
        assert tuple(row) == ("Provider", "untested", None, None, None, None, None)
        checksum = db.execute(
            "SELECT checksum FROM schema_migrations WHERE version='v8'"
        ).fetchone()[0]
    database.initialize()
    with database.connection() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='v8'").fetchone()[0]
            == 1
        )
        assert (
            db.execute("SELECT checksum FROM schema_migrations WHERE version='v8'").fetchone()[0]
            == checksum
        )


def test_v8_candidate_capability_states_and_config_change_reset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v7_database(path, monkeypatch)
    database = Database(path)
    database.initialize()
    with database.connection() as db:
        _insert_provider(db)
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "UPDATE provider_configs SET candidate_capability_status='supported' "
                "WHERE id='provider-v7'"
            )
        db.execute(
            "UPDATE provider_configs SET candidate_capability_status='supported',"
            "candidate_response_adapter_id='openai_responses_candidatescript_v1',"
            "candidate_probe_protocol_version='1',candidate_capability_tested_at='now',"
            "candidate_capability_failure_code=NULL,"
            "candidate_capability_probe_sha256='sha256:probe' WHERE id='provider-v7'"
        )
        db.execute(
            "UPDATE provider_configs SET base_url='https://changed.invalid' WHERE id='provider-v7'"
        )
        row = db.execute(
            "SELECT candidate_capability_status,candidate_response_adapter_id,"
            "candidate_probe_protocol_version,candidate_capability_tested_at,"
            "candidate_capability_failure_code,candidate_capability_probe_sha256 "
            "FROM provider_configs WHERE id='provider-v7'"
        ).fetchone()
        assert tuple(row) == ("untested", None, None, None, None, None)
        db.execute(
            "UPDATE provider_configs SET candidate_capability_status='unsupported',"
            "candidate_capability_tested_at='now',"
            "candidate_capability_failure_code='PROBE_FAILED',"
            "candidate_capability_probe_sha256='sha256:failure' WHERE id='provider-v7'"
        )
        db.execute("UPDATE provider_configs SET model='model-b' WHERE id='provider-v7'")
        assert (
            db.execute(
                "SELECT candidate_capability_status FROM provider_configs WHERE id='provider-v7'"
            ).fetchone()[0]
            == "untested"
        )


def test_v8_rejects_invalid_candidate_state_combination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    _v7_database(path, monkeypatch)
    database = Database(path)
    database.initialize()
    with database.connection() as db:
        _insert_provider(db)
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "UPDATE provider_configs SET candidate_capability_status='unsupported',"
                "candidate_capability_tested_at='now',"
                "candidate_capability_failure_code='PROBE_FAILED' WHERE id='provider-v7'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "UPDATE provider_configs SET candidate_capability_tested_at='now' "
                "WHERE id='provider-v7'"
            )


def test_v8_failure_rolls_back_to_v7(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "app.db"
    full = _v7_database(path, monkeypatch)
    broken = {**dict(list(full.items())[:-1]), "v8": "CREATE TABLE broken ("}
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(MigrationError, match="v8"):
        Database(path).initialize()
    with Database(path).connection() as db:
        versions = [row[0] for row in db.execute("SELECT version FROM schema_migrations")]
        assert versions == ["v1", "v2", "v3", "v4", "v5", "v6", "v7"]
        assert db.execute("SELECT name FROM sqlite_master WHERE name='broken'").fetchone() is None


def test_v8_rejects_unknown_applied_version(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    database = Database(path)
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO schema_migrations(version,applied_at,checksum) VALUES ('v9','now','x')"
        )
    with pytest.raises(MigrationError, match="未知数据库版本"):
        Database(path).initialize()
