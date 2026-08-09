from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

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
        with self.connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS media_inputs (
                  id TEXT PRIMARY KEY, path TEXT NOT NULL, display_name TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, probe_json TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, stage TEXT,
                  progress REAL NOT NULL DEFAULT 0, input_json TEXT NOT NULL,
                  encoder_requested TEXT, encoder_used TEXT, fallback_reason TEXT,
                  error_code TEXT, error_message TEXT, worker_pid INTEGER,
                  cancel_requested INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL,
                  path TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
                  media_info_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at);
                """
            )

    def recover_interrupted(self) -> int:
        now = utc_now()
        with self.connection() as db:
            cursor = db.execute(
                "UPDATE jobs SET status='interrupted', worker_pid=NULL, "
                "error_code='INTERNAL_ERROR', "
                "error_message='Core 在任务执行期间退出', updated_at=? "
                "WHERE status IN ('running','cancelling')",
                (now,),
            )
            return cursor.rowcount


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str) -> Any:
    return json.loads(value)
