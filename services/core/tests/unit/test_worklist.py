from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database


def test_v27_worklist_schema_is_present_and_constrained(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"worklists", "worklist_steps", "worklist_step_audits"} <= names
        columns = {row[1] for row in conn.execute("PRAGMA table_info(worklist_steps)")}
        assert {"planner_id", "params_json", "proposal_id", "applied_revision_id"} <= columns
        assert conn.execute("SELECT version FROM schema_migrations ORDER BY rowid DESC LIMIT 1").fetchone()[0] == "v27"


def test_v27_worklist_kind_check_rejects_unknown_value(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute("INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES ('p','p','active','{}','r','r','n','n','n')")
        conn.execute("INSERT INTO worklists(id,project_id,base_revision_id,base_document_sha256,status,step_count,max_steps,token_budget,created_at,updated_at) VALUES ('w','p','r','sha256:x','prepared',1,1,1,'n','n')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO worklist_steps(id,worklist_id,ordinal,kind,planner_id,params_json,status,created_at) VALUES ('s','w',0,'unknown','x','{}','pending','n')")
