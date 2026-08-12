from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class MigrationError(RuntimeError):
    """Raised when the database cannot be safely opened or migrated."""


V1_VERSION = "v1"
V2_VERSION = "v2"
V3_VERSION = "v3"
V1_SQL = """
CREATE TABLE IF NOT EXISTS media_inputs (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, display_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, probe_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived','missing')),
  canvas_json TEXT NOT NULL,
  current_timeline_revision_id TEXT,
  root_dir TEXT NOT NULL,
  root_dir_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN ('video','audio','image','text')),
  storage_mode TEXT NOT NULL CHECK(storage_mode IN ('external','managed')),
  display_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at TEXT,
  availability TEXT NOT NULL CHECK(availability IN ('available','missing','changed','unsupported')),
  media_info_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS asset_locations (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  previous_uri TEXT,
  previous_fingerprint TEXT,
  relocated_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'proxy',
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','succeeded','failed','cancelling','cancelled','interrupted'
  )),
  stage TEXT,
  progress REAL NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  encoder_requested TEXT,
  encoder_used TEXT,
  fallback_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  worker_pid INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  media_info_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, created_at);
"""
V2_SQL = """
CREATE TABLE IF NOT EXISTS model_installations (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  install_dir TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  installed_bytes INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  license_id TEXT NOT NULL,
  last_error TEXT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL,
  language TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  duration_us INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NULL
);
CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_asset ON transcripts(asset_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_transcript
  ON transcript_segments(transcript_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_transcript_words_segment
  ON transcript_words(segment_id, ordinal);
"""
V3_SQL = """
CREATE TABLE IF NOT EXISTS timeline_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_revision_id TEXT NULL REFERENCES timeline_revisions(id),
  schema_version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  document_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_navigation (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  redo_stack_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_artifacts (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  kind TEXT NOT NULL,
  render_plan_json TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  toolchain_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  artifact_id TEXT NOT NULL REFERENCES render_artifacts(artifact_id),
  profile_id TEXT NOT NULL,
  destination_uri TEXT NOT NULL,
  destination_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_revisions_project
  ON timeline_revisions(project_id, created_at DESC, id DESC);
CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_update
BEFORE UPDATE ON timeline_revisions
BEGIN
  SELECT RAISE(ABORT, 'timeline revisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_delete
BEFORE DELETE ON timeline_revisions
BEGIN
  SELECT RAISE(ABORT, 'timeline revisions are immutable');
END;
"""
MIGRATIONS: dict[str, str] = {
    V1_VERSION: V1_SQL,
    V2_VERSION: V2_SQL,
    V3_VERSION: V3_SQL,
}


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.last_backup: Path | None = None

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._adopt_stage0_database()
        with self.connection() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)"
            )
            applied = {
                row[0]: row[2]
                for row in db.execute("SELECT version, applied_at, checksum FROM schema_migrations")
            }
            unknown = set(applied) - set(MIGRATIONS)
            if unknown:
                raise MigrationError(f"未知数据库版本: {sorted(unknown)}")
            for version, sql in MIGRATIONS.items():
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise MigrationError(f"迁移校验和不匹配: {version}")
                    continue
                self.last_backup = self._backup()
                try:
                    db.execute("BEGIN")
                    self._apply_v1_compatibility(db)
                    self._apply_v2_compatibility(db)
                    self._apply_v3_compatibility(db)
                    for statement in _statements(sql):
                        db.execute(statement)
                    db.execute(
                        "INSERT INTO schema_migrations(version, applied_at, checksum) "
                        "VALUES (?,?,?)",
                        (version, utc_now(), checksum),
                    )
                    db.execute("COMMIT")
                except Exception as exc:
                    db.execute("ROLLBACK")
                    raise MigrationError(f"迁移 {version} 失败") from exc

            self._ensure_v1_columns(db)

    def _backup(self) -> Path:
        backup_dir = self.path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        target = backup_dir / f"app-{timestamp}.db"
        source = sqlite3.connect(self.path) if self.path.exists() else None
        destination = sqlite3.connect(target)
        try:
            if source is not None:
                source.backup(destination)
        finally:
            destination.close()
            if source is not None:
                source.close()
        return target

    def _adopt_stage0_database(self) -> None:
        legacy = self.path.with_name("stage0.db")
        if self.path.name == "app.db" and not self.path.exists() and legacy.exists():
            shutil.copy2(legacy, self.path)

    @staticmethod
    def _apply_v1_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" in tables:
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            additions = {
                "project_id": "TEXT REFERENCES projects(id)",
                "kind": "TEXT",
            }
            for name, definition in additions.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
            if "type" in columns:
                db.execute("UPDATE jobs SET kind=COALESCE(kind,type) WHERE kind IS NULL")

    @staticmethod
    def _ensure_v1_columns(db: sqlite3.Connection) -> None:
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        if "kind" in columns:
            db.execute("UPDATE jobs SET kind=COALESCE(kind,type)")

    @staticmethod
    def _apply_v2_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" not in tables:
            return
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        additions = {
            "asset_id": "TEXT REFERENCES assets(id)",
            "model_id": "TEXT",
            "model_revision": "TEXT",
            "input_fingerprint": "TEXT",
            "resource_class": "TEXT",
            "result_json": "TEXT",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")

    @staticmethod
    def _apply_v3_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" not in tables:
            return
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        additions = {
            "timeline_revision_id": "TEXT REFERENCES timeline_revisions(id)",
            "idempotency_key": "TEXT",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")

    def recover_interrupted(self) -> int:
        now = utc_now()
        with self.connection() as db:
            cursor = db.execute(
                "UPDATE jobs SET status='interrupted', worker_pid=NULL, "
                "stage='interrupted', error_code='JOB_INTERRUPTED', "
                "error_message='Core 重启前任务未完成', "
                "finished_at=?, updated_at=? "
                "WHERE status IN ('running','cancelling')",
                (now, now),
            )
            return cursor.rowcount


def _statements(sql: str) -> list[str]:
    statements: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise sqlite3.OperationalError("incomplete migration statement")
    return statements


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str) -> Any:
    return json.loads(value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"
