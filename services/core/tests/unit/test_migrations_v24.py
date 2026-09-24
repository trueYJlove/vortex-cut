"""v24 迁移测试（W1.1）：editing_grammar 提案/采纳不可变落盘。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database


def test_v24_creates_tables_and_immutable_triggers(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        tables = {
            row[0]
            for row in sql.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert "editing_grammar_proposals" in tables
        assert "editing_grammar_applications" in tables
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        sql.execute(
            "INSERT INTO timeline_revisions(id,project_id,parent_revision_id,schema_version,"
            "document_json,document_sha256,summary,created_by,created_at) "
            "VALUES ('r1','p1',NULL,1,'{}','sha256:x','s','user','now')"
        )
        sql.execute(
            "INSERT INTO editing_grammar_proposals(id,project_id,planner,params_json,"
            "base_revision_id,base_document_sha256,patch_json,patch_sha256,"
            "proposed_document_sha256,rationale_json,diff_json,created_at) "
            "VALUES ('g1','p1','drop_short_clips','{}','r1','sha256:x','{}','sha256:y',"
            "'sha256:z','{}','{}','now')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "UPDATE editing_grammar_proposals SET planner='x' WHERE id='g1'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("DELETE FROM editing_grammar_proposals WHERE id='g1'")


def test_v24_append_only_checksums_preserved(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "legacy.db"
    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {k: v for k, v in original.items() if k not in {"v24", "v25"}},
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        before = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        after = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    for version, checksum in before.items():
        assert after[version] == checksum
    assert "v24" in after
