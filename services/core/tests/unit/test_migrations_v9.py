from __future__ import annotations

import hashlib

import pytest

from aivs_core.database import MIGRATIONS, Database, MigrationError


def test_v9_new_schema_is_idempotent_and_preserves_earlier_checksums(tmp_path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    database.initialize()
    with database.connection() as db:
        applied = dict(db.execute("SELECT version,checksum FROM schema_migrations"))
        assert set(applied) == set(MIGRATIONS)
        assert all(
            applied[key] == hashlib.sha256(value.encode("utf-8")).hexdigest()
            for key, value in MIGRATIONS.items()
        )
        assert "export_batch_item_id" in {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        assert "rendition_snapshot_id" in {
            row[1] for row in db.execute("PRAGMA table_info(render_artifacts)")
        }


def test_v9_rejects_unknown_applied_version(tmp_path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO schema_migrations(version,applied_at,checksum) VALUES ('v12','now','x')"
        )
    with pytest.raises(MigrationError, match="未知数据库版本"):
        database.initialize()
