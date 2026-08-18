# ruff: noqa: E501
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import statistics
import sys
import tempfile
import time
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

ROOT = Path(__file__).resolve().parents[2]
CORE_SRC = ROOT / "services" / "core" / "src"
if str(CORE_SRC) not in sys.path:
    sys.path.insert(0, str(CORE_SRC))
from aivs_core.database import MIGRATIONS, Database, _statements, utc_now  # noqa: E402
from aivs_core.ids import new_id  # noqa: E402

Mode = Literal["composite_fk", "trigger"]
FROZEN = tuple(f"v{i}" for i in range(1, 12))
SENSITIVE = {
    "path",
    "uri",
    "absolute_path",
    "prompt",
    "transcript",
    "caption",
    "authorization",
    "api_key",
    "secret",
    "payload",
    "raw_exception",
    "raw_response",
    "stderr",
    "command",
    "traceback",
}
ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


class PrototypeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def canonical(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(v: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(v).encode()).hexdigest()


def reject_sensitive(v: Any) -> None:
    if isinstance(v, list):
        for x in v:
            reject_sensitive(x)
    elif isinstance(v, dict):
        for k, x in v.items():
            if not isinstance(k, str) or k.lower() in SENSITIVE:
                raise PrototypeError("SHOT_LIST_INVALID", "包含敏感字段")
            reject_sensitive(x)


def exact(v: Any, keys: set[str], code="SHOT_LIST_INVALID") -> dict[str, Any]:
    if not isinstance(v, dict) or set(v) != keys:
        raise PrototypeError(code, "字段无效")
    reject_sensitive(v)
    return v


def valid_id(v: Any) -> str:
    if not isinstance(v, str) or not 1 <= len(v) <= 128 or any(c not in ID_CHARS for c in v):
        raise PrototypeError("SHOT_LIST_INVALID", "ID 无效")
    return v


def controls(t: str) -> None:
    if any(unicodedata.category(c) in {"Cc", "Cs"} and c not in "\n\t" for c in t):
        raise PrototypeError("SHOT_LIST_INVALID", "控制字符无效")


def inline(v: Any, lo: int, hi: int) -> str:
    if not isinstance(v, str):
        raise PrototypeError("SHOT_LIST_INVALID", "文本无效")
    t = unicodedata.normalize("NFC", v)
    controls(t)
    t = re.sub(r"\s+", " ", t.strip())
    if not lo <= len(t) <= hi:
        raise PrototypeError("SHOT_LIST_INVALID", "长度无效")
    return t


def block(v: Any, lo: int, hi: int) -> str:
    if not isinstance(v, str):
        raise PrototypeError("SHOT_LIST_INVALID", "文本无效")
    t = unicodedata.normalize("NFC", v).replace("\r\n", "\n").replace("\r", "\n")
    controls(t)
    t = "\n".join(x.rstrip(" \t") for x in t.split("\n")).strip(" \t\n")
    if not lo <= len(t) <= hi:
        raise PrototypeError("SHOT_LIST_INVALID", "长度无效")
    return t


def normalize(v: Any) -> dict[str, Any]:
    s = exact(v, {"schema_version", "base_revision_id", "title", "summary", "requirements"})
    if s["schema_version"] != 1:
        raise PrototypeError("SHOT_LIST_INVALID", "schema 无效")
    base = s["base_revision_id"]
    base = valid_id(base) if base is not None else None
    items = s["requirements"]
    if not isinstance(items, list) or not 1 <= len(items) <= 24:
        raise PrototypeError("SHOT_REQUIREMENT_INVALID", "镜头数量无效")
    out = []
    for ordinal, raw in enumerate(items):
        item = exact(
            raw,
            {"title", "visual_direction", "target_duration_us", "visual", "narration"},
            "SHOT_REQUIREMENT_INVALID",
        )
        duration = item["target_duration_us"]
        if duration is not None and (
            not isinstance(duration, int)
            or isinstance(duration, bool)
            or not 100_000 <= duration <= 600_000_000
        ):
            raise PrototypeError("SHOT_REQUIREMENT_INVALID", "时长无效")
        visual = exact(
            item["visual"], {"requirement_kind", "source_asset_id"}, "SHOT_REQUIREMENT_INVALID"
        )
        if visual["requirement_kind"] == "existing_media":
            visual = {
                "requirement_kind": "existing_media",
                "source_asset_id": valid_id(visual["source_asset_id"]),
            }
        elif visual["requirement_kind"] == "image" and visual["source_asset_id"] is None:
            visual = {"requirement_kind": "image", "source_asset_id": None}
        else:
            raise PrototypeError("SHOT_REQUIREMENT_INVALID", "视觉需求无效")
        narration = item["narration"]
        if narration is not None:
            narration = exact(narration, {"requirement_kind", "text"}, "SHOT_REQUIREMENT_INVALID")
            if narration["requirement_kind"] != "tts":
                raise PrototypeError("SHOT_REQUIREMENT_INVALID", "旁白需求无效")
            narration = {"requirement_kind": "tts", "text": block(narration["text"], 1, 2000)}
        out.append(
            {
                "ordinal": ordinal,
                "title": inline(item["title"], 1, 120),
                "visual_direction": block(item["visual_direction"], 1, 2000),
                "target_duration_us": duration,
                "visual": visual,
                "narration": narration,
            }
        )
    content = {
        "schema_version": 1,
        "title": inline(s["title"], 1, 120),
        "summary": block(s["summary"], 0, 4000),
        "requirements": out,
    }
    return {"base_revision_id": base, "content": content, "document_sha256": digest(content)}


def v12_sql(mode: Mode = "composite_fk") -> str:
    if mode == "composite_fk":
        pointer = """  FOREIGN KEY(current_revision_id,id) REFERENCES shot_list_revisions(id,shot_list_id),
  FOREIGN KEY(confirmed_revision_id,id) REFERENCES shot_list_revisions(id,shot_list_id),
"""
        pointer_triggers = ""
    else:
        pointer = ""
        pointer_triggers = """
CREATE TRIGGER shot_lists_current_owner BEFORE UPDATE OF current_revision_id ON shot_lists
WHEN NEW.current_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shot_list_revisions r WHERE r.id=NEW.current_revision_id AND r.shot_list_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'current revision ownership mismatch'); END;
CREATE TRIGGER shot_lists_confirmed_owner BEFORE UPDATE OF confirmed_revision_id ON shot_lists
WHEN NEW.confirmed_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shot_list_revisions r WHERE r.id=NEW.confirmed_revision_id AND r.shot_list_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'confirmed revision ownership mismatch'); END;
"""
    return f"""
CREATE TABLE shot_lists(id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),current_revision_id TEXT NULL,confirmed_revision_id TEXT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,{pointer}UNIQUE(id,project_id));
CREATE TABLE shot_list_revisions(id TEXT PRIMARY KEY,shot_list_id TEXT NOT NULL,project_id TEXT NOT NULL,parent_revision_id TEXT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),summary TEXT NOT NULL CHECK(length(summary)<=4000),document_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(id,shot_list_id),UNIQUE(shot_list_id,document_sha256),FOREIGN KEY(shot_list_id,project_id) REFERENCES shot_lists(id,project_id),FOREIGN KEY(parent_revision_id,shot_list_id) REFERENCES shot_list_revisions(id,shot_list_id));
CREATE TABLE shot_requirements(id TEXT PRIMARY KEY,shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 23),title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),visual_direction TEXT NOT NULL CHECK(length(visual_direction) BETWEEN 1 AND 2000),target_duration_us INTEGER NULL CHECK(target_duration_us IS NULL OR target_duration_us BETWEEN 100000 AND 600000000),visual_kind TEXT NOT NULL CHECK(visual_kind IN ('existing_media','image')),visual_source_asset_id TEXT NULL REFERENCES assets(id),narration_kind TEXT NULL CHECK(narration_kind IS NULL OR narration_kind='tts'),narration_text TEXT NULL CHECK(narration_text IS NULL OR length(narration_text) BETWEEN 1 AND 2000),CHECK((visual_kind='existing_media' AND visual_source_asset_id IS NOT NULL) OR (visual_kind='image' AND visual_source_asset_id IS NULL)),CHECK((narration_kind IS NULL AND narration_text IS NULL) OR (narration_kind='tts' AND narration_text IS NOT NULL)),UNIQUE(shot_list_revision_id,ordinal));
CREATE INDEX shot_list_revisions_by_list_created ON shot_list_revisions(shot_list_id,created_at DESC,id DESC);
CREATE INDEX shot_requirements_by_visual_asset ON shot_requirements(visual_source_asset_id);
CREATE TRIGGER shot_list_revisions_no_update BEFORE UPDATE ON shot_list_revisions BEGIN SELECT RAISE(ABORT,'shot list revisions immutable'); END;
CREATE TRIGGER shot_list_revisions_no_delete BEFORE DELETE ON shot_list_revisions BEGIN SELECT RAISE(ABORT,'shot list revisions immutable'); END;
CREATE TRIGGER shot_requirements_no_update BEFORE UPDATE ON shot_requirements BEGIN SELECT RAISE(ABORT,'shot requirements immutable'); END;
CREATE TRIGGER shot_requirements_no_delete BEFORE DELETE ON shot_requirements BEGIN SELECT RAISE(ABORT,'shot requirements immutable'); END;
CREATE TRIGGER shot_lists_identity_no_update BEFORE UPDATE OF id,project_id,created_at ON shot_lists BEGIN SELECT RAISE(ABORT,'shot list identity immutable'); END;
CREATE TRIGGER shot_requirements_asset_owner BEFORE INSERT ON shot_requirements WHEN NEW.visual_kind='existing_media' AND NOT EXISTS(SELECT 1 FROM assets a JOIN shot_list_revisions r ON r.id=NEW.shot_list_revision_id WHERE a.id=NEW.visual_source_asset_id AND a.project_id=r.project_id) BEGIN SELECT RAISE(ABORT,'asset project mismatch'); END;
{pointer_triggers}"""


def initialize_v11(db: Database) -> None:
    """Initialize an isolated v11 fixture before applying the candidate v12 schema."""
    import aivs_core.database as database_module

    full_migrations = database_module.MIGRATIONS
    try:
        database_module.MIGRATIONS = {
            version: sql
            for version, sql in full_migrations.items()
            if int(version.removeprefix("v")) <= 11
        }
        db.initialize()
    finally:
        database_module.MIGRATIONS = full_migrations


def apply_v12(db: Database, mode: Mode = "composite_fk") -> str:
    script = v12_sql(mode)
    checksum = hashlib.sha256(script.encode()).hexdigest()
    with db.connection() as sql:
        applied = {
            r[0]: r[2]
            for r in sql.execute("SELECT version,applied_at,checksum FROM schema_migrations")
        }
        for version in FROZEN:
            if applied.get(version) != hashlib.sha256(MIGRATIONS[version].encode()).hexdigest():
                raise RuntimeError(f"{version} checksum mismatch")
        sql.execute("BEGIN")
        try:
            for statement in _statements(script):
                sql.execute(statement)
            sql.execute("INSERT INTO schema_migrations VALUES ('v12',?,?)", (utc_now(), checksum))
            sql.execute("COMMIT")
        except Exception:
            sql.execute("ROLLBACK")
            raise
    return checksum


def seed(db: Database) -> dict[str, str]:
    now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    ids = {
        "pa": "project_stage4c_a",
        "pb": "project_stage4c_b",
        "aa": "asset_stage4c_a",
        "ab": "asset_stage4c_b",
    }
    with db.connection() as sql:
        for pid in (ids["pa"], ids["pb"]):
            sql.execute(
                "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pid, "Stage4C", "active", "{}", None, "internal", "internal", now, now, now),
            )
        for aid, pid in ((ids["aa"], ids["pa"]), (ids["ab"], ids["pb"])):
            sql.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,availability,media_info_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    aid,
                    pid,
                    "image",
                    "external",
                    "synthetic.png",
                    f"sha256:{aid}",
                    100,
                    now,
                    "available",
                    "{}",
                    now,
                    now,
                ),
            )
    return ids


def sample(asset_id: str | None = None, count: int = 2) -> dict[str, Any]:
    items = []
    for i in range(count):
        existing = i == 0 and asset_id is not None
        items.append(
            {
                "title": f"Shot {i + 1}",
                "visual_direction": f"Synthetic visual {i + 1}",
                "target_duration_us": 3_000_000,
                "visual": {
                    "requirement_kind": "existing_media" if existing else "image",
                    "source_asset_id": asset_id if existing else None,
                },
                "narration": {"requirement_kind": "tts", "text": f"synthetic narration {i + 1}"}
                if i == 0
                else None,
            }
        )
    return {
        "schema_version": 1,
        "base_revision_id": None,
        "title": "Synthetic shot list",
        "summary": "Synthetic prototype only.",
        "requirements": items,
    }


def create_revision(db: Database, project_id: str, value: dict[str, Any]) -> tuple[str, bool]:
    n = normalize(value)
    content = n["content"]
    now = utc_now()
    with db.connection() as sql:
        sql.execute("BEGIN IMMEDIATE")
        try:
            project = sql.execute(
                "SELECT status FROM projects WHERE id=?", (project_id,)
            ).fetchone()
            if project is None or project["status"] != "active":
                raise PrototypeError("SHOT_LIST_INVALID", "项目不可编辑")
            row = sql.execute(
                "SELECT * FROM shot_lists WHERE project_id=?", (project_id,)
            ).fetchone()
            if row is None:
                if n["base_revision_id"] is not None:
                    raise PrototypeError("SHOT_LIST_CONFLICT", "版本冲突")
                list_id = new_id()
                current = None
                sql.execute(
                    "INSERT INTO shot_lists VALUES (?,?,?,?,?,?)",
                    (list_id, project_id, None, None, now, now),
                )
            else:
                list_id = row["id"]
                current = row["current_revision_id"]
                if n["base_revision_id"] != current:
                    raise PrototypeError("SHOT_LIST_CONFLICT", "版本冲突")
            if (
                current is not None
                and sql.execute(
                    "SELECT document_sha256 FROM shot_list_revisions WHERE id=?", (current,)
                ).fetchone()[0]
                == n["document_sha256"]
            ):
                sql.execute("COMMIT")
                return current, True
            rid = new_id()
            sql.execute(
                "INSERT INTO shot_list_revisions VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    list_id,
                    project_id,
                    current,
                    1,
                    content["title"],
                    content["summary"],
                    n["document_sha256"],
                    now,
                ),
            )
            for item in content["requirements"]:
                nar = item["narration"]
                sql.execute(
                    "INSERT INTO shot_requirements VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        new_id(),
                        rid,
                        item["ordinal"],
                        item["title"],
                        item["visual_direction"],
                        item["target_duration_us"],
                        item["visual"]["requirement_kind"],
                        item["visual"]["source_asset_id"],
                        nar["requirement_kind"] if nar else None,
                        nar["text"] if nar else None,
                    ),
                )
            sql.execute(
                "UPDATE shot_lists SET current_revision_id=?,updated_at=? WHERE id=?",
                (rid, now, list_id),
            )
            sql.execute("COMMIT")
            return rid, False
        except Exception:
            sql.execute("ROLLBACK")
            raise


def confirm(db: Database, pid: str, rid: str, expected: str) -> bool:
    with db.connection() as sql:
        sql.execute("BEGIN IMMEDIATE")
        try:
            row = sql.execute(
                "SELECT l.* FROM shot_lists l JOIN projects p ON p.id=l.project_id WHERE l.project_id=? AND p.status='active'",
                (pid,),
            ).fetchone()
            if row is None or row["current_revision_id"] != expected or rid != expected:
                raise PrototypeError("SHOT_LIST_CONFIRMATION_CONFLICT", "确认冲突")
            reused = row["confirmed_revision_id"] == rid
            if not reused:
                sql.execute(
                    "UPDATE shot_lists SET confirmed_revision_id=?,updated_at=? WHERE id=?",
                    (rid, utc_now(), row["id"]),
                )
            sql.execute("COMMIT")
            return reused
        except Exception:
            sql.execute("ROLLBACK")
            raise


def fails(action: Any, expected: type[BaseException]) -> bool:
    try:
        action()
    except expected:
        return True
    raise AssertionError("expected failure")


def execute(db: Database, statement: str, params: tuple[Any, ...]) -> None:
    with db.connection() as sql:
        sql.execute(statement, params)


def sqlite_ok(db: Database) -> bool:
    with db.connection() as sql:
        return (
            not list(sql.execute("PRAGMA foreign_key_check"))
            and sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        )


def pointer_report(root: Path, mode: Mode) -> dict[str, bool]:
    db = Database(root / f"pointer_{mode}.db")
    initialize_v11(db)
    apply_v12(db, mode)
    ids = seed(db)
    ra, _ = create_revision(db, ids["pa"], sample(ids["aa"]))
    rb, _ = create_revision(db, ids["pb"], sample(ids["ab"]))
    with db.connection() as sql:
        list_a = sql.execute(
            "SELECT id FROM shot_lists WHERE project_id=?", (ids["pa"],)
        ).fetchone()[0]
    cross = fails(
        lambda: execute(db, "UPDATE shot_lists SET current_revision_id=? WHERE id=?", (rb, list_a)),
        sqlite3.IntegrityError,
    )
    return {
        "revision_created": bool(ra),
        "cross_list_pointer_rejected": cross,
        "foreign_key_and_integrity_ok": sqlite_ok(db),
    }


def constraint_report(root: Path) -> dict[str, bool]:
    db = Database(root / "constraints.db")
    initialize_v11(db)
    apply_v12(db)
    ids = seed(db)
    doc = sample(ids["aa"])
    rid, first = create_revision(db, ids["pa"], doc)
    same, second = create_revision(db, ids["pa"], {**doc, "base_revision_id": rid})
    cf = confirm(db, ids["pa"], rid, rid)
    cs = confirm(db, ids["pa"], rid, rid)
    zero = {**sample(), "requirements": []}
    many = sample(count=25)
    bad = sample()
    bad["requirements"][0]["target_duration_us"] = 1
    na = normalize({**sample(), "title": "  Cafe\u0301   List  ", "summary": "a\r\n"})
    nb = normalize({**sample(), "title": "Caf\u00e9 List", "summary": "a\n"})
    with db.connection() as sql:
        counts = [
            sql.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in (
                "provider_invocations",
                "media_generation_requests",
                "media_generation_tasks",
                "jobs",
                "timeline_revisions",
                "assets",
            )
        ]
    return {
        "created_and_idempotent": bool(rid) and not first and second and same == rid,
        "confirmation_idempotent": not cf and cs,
        "base_conflict_rejected": fails(
            lambda: create_revision(db, ids["pa"], doc), PrototypeError
        ),
        "zero_rejected": fails(lambda: create_revision(db, ids["pb"], zero), PrototypeError),
        "twenty_five_rejected": fails(lambda: create_revision(db, ids["pb"], many), PrototypeError),
        "cross_project_asset_rejected": fails(
            lambda: create_revision(db, ids["pb"], sample(ids["aa"])), sqlite3.IntegrityError
        ),
        "bad_duration_rejected": fails(lambda: normalize(bad), PrototypeError),
        "sensitive_key_rejected": fails(
            lambda: normalize({**sample(), "payload": "sentinel"}), PrototypeError
        ),
        "canonical_hash_stable": na["document_sha256"] == nb["document_sha256"],
        "revision_update_rejected": fails(
            lambda: execute(db, "UPDATE shot_list_revisions SET title='x' WHERE id=?", (rid,)),
            sqlite3.IntegrityError,
        ),
        "requirement_delete_rejected": fails(
            lambda: execute(
                db, "DELETE FROM shot_requirements WHERE shot_list_revision_id=?", (rid,)
            ),
            sqlite3.IntegrityError,
        ),
        "zero_side_effects": counts == [0, 0, 0, 0, 0, 2],
        "foreign_key_and_integrity_ok": sqlite_ok(db),
    }


def rollback_report(root: Path) -> dict[str, bool]:
    db = Database(root / "rollback.db")
    initialize_v11(db)
    backup = db._backup()
    with db.connection() as sql:
        sql.execute("BEGIN")
        failed = fails(
            lambda: [
                sql.execute(s)
                for s in _statements(
                    "CREATE TABLE stage4c_partial(id TEXT); CREATE TABLE stage4c_partial(id TEXT);"
                )
            ],
            sqlite3.Error,
        )
        sql.execute("ROLLBACK")
        no_table = (
            sql.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='stage4c_partial'"
            ).fetchone()[0]
            == 0
        )
        no_v12 = (
            sql.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='v12'").fetchone()[0]
            == 0
        )
    return {
        "failure_detected": failed,
        "transaction_rolled_back": no_table and no_v12,
        "pre_migration_backup_created": backup.exists(),
    }


def performance_report(root: Path, iterations: int) -> dict[str, float]:
    values = []
    for i in range(iterations):
        db = Database(root / f"perf_{i}.db")
        initialize_v11(db)
        apply_v12(db)
        ids = seed(db)
        start = time.perf_counter()
        create_revision(db, ids["pa"], sample(ids["aa"], 24 if i % 5 == 0 else 3))
        values.append((time.perf_counter() - start) * 1000)
    ordered = sorted(values)
    idx = min(round((len(ordered) - 1) * 0.95), len(ordered) - 1)
    return {
        "create_revision_p50": round(statistics.median(values), 3),
        "create_revision_p95": round(ordered[idx], 3),
    }


def run_prototype(base_dir: Path | None = None, iterations: int = 20) -> dict[str, Any]:
    if base_dir is None:
        with tempfile.TemporaryDirectory() as directory:
            return run_prototype(Path(directory), iterations)
    base_dir.mkdir(parents=True, exist_ok=True)
    composite = pointer_report(base_dir, "composite_fk")
    trigger = pointer_report(base_dir, "trigger")
    constraints = constraint_report(base_dir)
    rollback = rollback_report(base_dir)
    performance = performance_report(base_dir, iterations)
    return {
        "provider_call_count": 0,
        "recommended_pointer_mode": "composite_fk",
        "migration": {
            "frozen_versions_verified": len(FROZEN),
            "composite_fk_passed": all(composite.values()),
            "trigger_pointer_passed": all(trigger.values()),
            "rollback_and_backup": all(rollback.values()),
        },
        "pointer_modes": {"composite_fk": composite, "trigger": trigger},
        "constraints": constraints,
        "rollback": rollback,
        "performance_ms": performance,
    }


if __name__ == "__main__":
    print(canonical(run_prototype()))
