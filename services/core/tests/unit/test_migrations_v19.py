# ruff: noqa: E501
"""C22 v19 迁移测试：jobs.phase / jobs.phase_progress 追加列。

要求（PERFORMANCE_IMPLEMENTATION_PLAN C22-6/7）：
- 追加式：v18 → v19 只 ADD COLUMN，不改不删旧结构；旧校验和不变。
- 可空列：旧版本/旧客户端不认识 phase 时忽略即可；终态行由服务层清空。
- 无默认回填：存量 running 行重启即被 recover_interrupted 置终态，
  phase 语义只对迁移后新任务生效。
"""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V19_SQL, Database


def _seed_v18(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module, "MIGRATIONS", {k: v for k, v in original.items() if k != "v19"}
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def test_v18_to_v19_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old = _seed_v18(path, monkeypatch)
    database = Database(path)
    database.initialize()
    assert database.last_backup is not None and database.last_backup.exists()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v19'")
        )
        assert history == old
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v19'").fetchone()[0]
            == hashlib.sha256(V19_SQL.encode()).hexdigest()
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 26)}


def test_v19_columns_exist_and_nullable(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        columns = {row[1]: row for row in sql.execute("PRAGMA table_info(jobs)")}
        assert "phase" in columns
        assert "phase_progress" in columns
        # 可空：NOT NULL 约束位（row[3]）为 0。
        assert columns["phase"][3] == 0
        assert columns["phase_progress"][3] == 0


def test_v19_implicit_rows_keep_phase_null(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        sql.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("p", "P", "active", "{}", "r", "root", "root", "now", "now", "now"),
        )
        sql.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("r", "p", None, 1, "{}", "doc", "s", "user", "now"),
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "created_at,updated_at) VALUES ('j1','p','final_export','final_export',"
            "'queued','queued',0,'{}','now','now')"
        )
        row = tuple(
            sql.execute("SELECT phase,phase_progress FROM jobs WHERE id='j1'").fetchone()
        )
    assert row == (None, None)
