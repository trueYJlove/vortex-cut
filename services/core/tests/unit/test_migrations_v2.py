from __future__ import annotations

import sqlite3
from pathlib import Path

from aivs_core.database import Database

V2_TABLES = {"model_installations", "transcripts", "transcript_segments", "transcript_words"}
V2_INDEXES = {
    "idx_transcripts_asset",
    "idx_transcript_segments_transcript",
    "idx_transcript_words_segment",
}

MODEL_INSTALLATIONS_COLUMNS = {
    "model_id": "TEXT",
    "provider": "TEXT",
    "revision": "TEXT",
    "status": "TEXT",
    "install_dir": "TEXT",
    "expected_bytes": "INTEGER",
    "installed_bytes": "INTEGER",
    "manifest_sha256": "TEXT",
    "license_id": "TEXT",
    "last_error": "TEXT",
    "updated_at": "TEXT",
}

TRANSCRIPTS_COLUMNS = {
    "id": "TEXT",
    "asset_id": "TEXT",
    "status": "TEXT",
    "language": "TEXT",
    "provider": "TEXT",
    "model_id": "TEXT",
    "model_revision": "TEXT",
    "source_fingerprint": "TEXT",
    "duration_us": "INTEGER",
    "created_at": "TEXT",
    "updated_at": "TEXT",
}

SEGMENTS_COLUMNS = {
    "id": "TEXT",
    "transcript_id": "TEXT",
    "ordinal": "INTEGER",
    "start_us": "INTEGER",
    "end_us": "INTEGER",
    "text": "TEXT",
    "confidence": "REAL",
}

WORDS_COLUMNS = {
    "id": "TEXT",
    "segment_id": "TEXT",
    "ordinal": "INTEGER",
    "start_us": "INTEGER",
    "end_us": "INTEGER",
    "text": "TEXT",
    "confidence": "REAL",
}


def _init(tmp_path: Path) -> Path:
    db_path = tmp_path / "app.db"
    Database(db_path).initialize()
    return db_path


def _tables(db: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def _indexes(db: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
        )
    }


def _columns(db: sqlite3.Connection, table: str) -> dict[str, str]:
    return {row[1]: row[2] for row in db.execute(f"PRAGMA table_info({table})")}


class TestMigrationV2:
    def test_fresh_database_applies_v1_then_v2(self, tmp_path: Path):
        db_path = _init(tmp_path)
        with sqlite3.connect(db_path) as db:
            versions = [
                row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY rowid")
            ]
        assert versions == [f"v{i}" for i in range(1, 17)]
        # each migration writes a pre-flight backup
        assert len(list((tmp_path / "backups").glob("app-*.db"))) >= 2

    def test_v2_tables_and_indexes_exist(self, tmp_path: Path):
        db_path = _init(tmp_path)
        with sqlite3.connect(db_path) as db:
            assert V2_TABLES <= _tables(db)
            assert V2_INDEXES <= _indexes(db)

    def test_v2_table_columns(self, tmp_path: Path):
        db_path = _init(tmp_path)
        with sqlite3.connect(db_path) as db:
            assert _columns(db, "model_installations") == MODEL_INSTALLATIONS_COLUMNS
            assert _columns(db, "transcripts") == TRANSCRIPTS_COLUMNS
            assert _columns(db, "transcript_segments") == SEGMENTS_COLUMNS
            assert _columns(db, "transcript_words") == WORDS_COLUMNS

    def test_v2_schema_idempotent_reinit(self, tmp_path: Path):
        db_path = _init(tmp_path)
        Database(db_path).initialize()
        Database(db_path).initialize()
        with sqlite3.connect(db_path) as db:
            versions = [
                row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY rowid")
            ]
        assert versions == [f"v{i}" for i in range(1, 17)]

    def test_transcript_foreign_keys_and_cascade_delete(self, tmp_path: Path):
        db_path = _init(tmp_path)
        with sqlite3.connect(db_path) as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute(
                "INSERT INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
                "created_at,updated_at,last_opened_at) "
                "VALUES ('p1','P','active','{}','root','root','now','now','now')"
            )
            db.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,created_at,updated_at) "
                "VALUES ('a1','p1','video','external','a.mp4','fp',1,'available','now','now')"
            )
            db.execute(
                "INSERT INTO transcripts (id,asset_id,status,language,provider,model_id,"
                "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
                "VALUES ('t1','a1','ready','zh','p','m','r','fp',1000,'now','now')"
            )
            db.execute(
                "INSERT INTO transcript_segments (id,transcript_id,ordinal,start_us,end_us,"
                "text,confidence) VALUES ('s1','t1',0,0,500,'hi',0.9)"
            )
            db.execute(
                "INSERT INTO transcript_words (id,segment_id,ordinal,start_us,end_us,text,"
                "confidence) VALUES ('w1','s1',0,0,100,'hi',0.9)"
            )
            # FK enforced: deleting the parent asset without cascading transcripts is rejected
            db.execute("DELETE FROM transcripts WHERE id='t1'")
            assert db.execute("SELECT COUNT(*) FROM transcript_segments").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM transcript_words").fetchone()[0] == 0

    def test_transcript_fk_rejects_orphan_asset(self, tmp_path: Path):
        db_path = _init(tmp_path)
        with sqlite3.connect(db_path) as db:
            db.execute("PRAGMA foreign_keys=ON")
            try:
                db.execute(
                    "INSERT INTO transcripts (id,asset_id,status,language,provider,model_id,"
                    "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
                    "VALUES ('t_bad','missing_asset','ready','zh','p','m','r','fp',1,'now','now')"
                )
            except sqlite3.IntegrityError:
                return
            raise AssertionError("transcripts.asset_id FK should reject a missing asset")
