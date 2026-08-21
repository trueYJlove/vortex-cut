# ruff: noqa: E501
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import statistics
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

MIN_US, MAX_US = 500_000, 30_000_000
LAYOUTS = {"blurred_background", "crop_fill", "fit"}
SENSITIVE = (
    "private_prompt",
    "private_secret",
    "authorization",
    "bearer ",
    "file://",
    "data:image",
    "traceback",
    "c:\\",
)
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE projects(id TEXT PRIMARY KEY,status TEXT NOT NULL,current_revision_id TEXT);
CREATE TABLE requirements(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),confirmed INTEGER NOT NULL,target_duration_us INTEGER);
CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,storage_mode TEXT NOT NULL,availability TEXT NOT NULL);
CREATE TABLE adoptions(id TEXT PRIMARY KEY,requirement_id TEXT NOT NULL REFERENCES requirements(id),asset_id TEXT NOT NULL REFERENCES assets(id),ordinal INTEGER NOT NULL,UNIQUE(requirement_id,ordinal));
CREATE TABLE revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT,document_json TEXT NOT NULL,document_sha256 TEXT NOT NULL);
CREATE TABLE drafts(project_id TEXT PRIMARY KEY REFERENCES projects(id),base_revision_id TEXT NOT NULL);
CREATE TABLE previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),requirement_id TEXT NOT NULL REFERENCES requirements(id),adoption_id TEXT NOT NULL REFERENCES adoptions(id),asset_id TEXT NOT NULL REFERENCES assets(id),base_revision_id TEXT NOT NULL REFERENCES revisions(id),base_sha256 TEXT NOT NULL,proposed_clip_id TEXT NOT NULL UNIQUE,at_index INTEGER NOT NULL,duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),layout TEXT NOT NULL,proposed_sha256 TEXT NOT NULL,preview_sha256 TEXT NOT NULL,clip_count_before INTEGER NOT NULL,shifted_clip_count INTEGER NOT NULL,shifted_caption_count INTEGER NOT NULL,duration_before_us INTEGER NOT NULL,duration_after_us INTEGER NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE assemblies(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE REFERENCES previews(id),project_id TEXT NOT NULL REFERENCES projects(id),requirement_id TEXT NOT NULL REFERENCES requirements(id),adoption_id TEXT NOT NULL REFERENCES adoptions(id),asset_id TEXT NOT NULL REFERENCES assets(id),base_revision_id TEXT NOT NULL REFERENCES revisions(id),output_revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),proposed_clip_id TEXT NOT NULL UNIQUE,proposed_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX idx_previews_requirement_created ON previews(requirement_id,created_at DESC,id DESC);
CREATE INDEX idx_assemblies_requirement_created ON assemblies(requirement_id,created_at DESC,id DESC);
CREATE TRIGGER previews_no_update BEFORE UPDATE ON previews BEGIN SELECT RAISE(ABORT,'previews immutable'); END;
CREATE TRIGGER previews_no_delete BEFORE DELETE ON previews BEGIN SELECT RAISE(ABORT,'previews immutable'); END;
CREATE TRIGGER assemblies_no_update BEFORE UPDATE ON assemblies BEGIN SELECT RAISE(ABORT,'assemblies immutable'); END;
CREATE TRIGGER assemblies_no_delete BEFORE DELETE ON assemblies BEGIN SELECT RAISE(ABORT,'assemblies immutable'); END;
CREATE TRIGGER previews_validate BEFORE INSERT ON previews WHEN NOT EXISTS(
 SELECT 1 FROM projects p JOIN requirements r ON r.project_id=p.id JOIN adoptions a ON a.requirement_id=r.id JOIN assets x ON x.id=a.asset_id JOIN revisions v ON v.id=NEW.base_revision_id
 WHERE p.id=NEW.project_id AND p.status='active' AND p.current_revision_id=v.id AND r.id=NEW.requirement_id AND r.confirmed=1 AND a.id=NEW.adoption_id AND a.asset_id=NEW.asset_id AND a.ordinal=(SELECT MAX(a2.ordinal) FROM adoptions a2 WHERE a2.requirement_id=r.id) AND x.project_id=p.id AND x.kind='image' AND x.storage_mode='managed' AND x.availability='available' AND v.project_id=p.id AND v.document_sha256=NEW.base_sha256 AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.project_id=p.id)
) BEGIN SELECT RAISE(ABORT,'invalid preview'); END;
CREATE TRIGGER assemblies_validate BEFORE INSERT ON assemblies WHEN NOT EXISTS(
 SELECT 1 FROM previews w JOIN revisions v ON v.id=NEW.output_revision_id JOIN projects p ON p.id=w.project_id
 WHERE w.id=NEW.preview_id AND NEW.project_id=w.project_id AND NEW.requirement_id=w.requirement_id AND NEW.adoption_id=w.adoption_id AND NEW.asset_id=w.asset_id AND NEW.base_revision_id=w.base_revision_id AND NEW.proposed_clip_id=w.proposed_clip_id AND NEW.proposed_sha256=w.proposed_sha256 AND v.parent_id=w.base_revision_id AND v.document_sha256=w.proposed_sha256 AND p.current_revision_id=v.id
) BEGIN SELECT RAISE(ABORT,'invalid assembly'); END;
"""


class ModelError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise ModelError(code)


def iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def total(document: dict[str, Any]) -> int:
    return document["clips"][-1]["timeline_end_us"] if document["clips"] else 0


def make_document(count: int, locked: set[int] | None = None) -> dict[str, Any]:
    clips, captions = [], []
    for i in range(count):
        start = i * 500_000
        cid = f"base_clip_{i}"
        clips.append(
            {
                "clip_id": cid,
                "asset_id": "base_asset",
                "asset_kind": "image",
                "order_index": i,
                "timeline_start_us": start,
                "timeline_end_us": start + 500_000,
                "layout": "fit",
                "audio": {"enabled": False, "gain_db": 0.0},
            }
        )
        captions.append(
            {
                "caption_id": f"caption_{i}",
                "source_clip_id": cid,
                "start_us": start,
                "end_us": start + 200_000,
            }
        )
    return {
        "schema_version": 1,
        "project_id": "project",
        "clips": clips,
        "captions": captions,
        "locked_elements": [f"base_clip_{i}" for i in sorted(locked or set())],
    }


def normalize(document: dict[str, Any]) -> None:
    offset = 0
    for i, clip in enumerate(document["clips"]):
        old = clip["timeline_start_us"]
        length = clip["timeline_end_us"] - old
        delta = offset - old
        clip["order_index"], clip["timeline_start_us"], clip["timeline_end_us"] = (
            i,
            offset,
            offset + length,
        )
        for caption in document["captions"]:
            if caption["source_clip_id"] == clip["clip_id"]:
                caption["start_us"] += delta
                caption["end_us"] += delta
        offset += length


def build(
    base: dict[str, Any], asset_id: str, clip_id: str, at_index: int, duration_us: int, layout: str
) -> tuple[dict[str, Any], dict[str, int]]:
    clips = base["clips"]
    if (
        isinstance(at_index, bool)
        or not isinstance(at_index, int)
        or not 0 <= at_index <= len(clips)
    ):
        fail("STAGE5_POSITION_INVALID")
    if layout not in LAYOUTS:
        fail("STAGE5_PREVIEW_MISMATCH")
    shifted = clips[at_index:]
    locked = set(base.get("locked_elements", []))
    if any(c["clip_id"] in locked for c in shifted):
        fail("STAGE5_LOCKED_SHIFT")
    shifted_ids = {c["clip_id"] for c in shifted}
    target = copy.deepcopy(base)
    target["clips"].insert(
        at_index,
        {
            "clip_id": clip_id,
            "asset_id": asset_id,
            "asset_kind": "image",
            "order_index": at_index,
            "timeline_start_us": 0,
            "timeline_end_us": duration_us,
            "layout": layout,
            "audio": {"enabled": False, "gain_db": 0.0},
        },
    )
    normalize(target)
    return target, {
        "clip_count_before": len(clips),
        "shifted_clip_count": len(shifted),
        "shifted_caption_count": sum(c["source_clip_id"] in shifted_ids for c in base["captions"]),
        "duration_before_us": total(base),
        "duration_after_us": total(target),
    }


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path, timeout=5, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    return db


class Model:
    def __init__(self, path: Path, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.path, self.now, self.provider_calls, self.network_calls = path, now, 0, 0
        path.parent.mkdir(parents=True, exist_ok=True)
        db = connect(path)
        db.executescript(SCHEMA)
        db.close()

    @staticmethod
    def resolve_duration(target: int | None, explicit: int | None) -> int:
        if explicit is not None:
            if (
                isinstance(explicit, bool)
                or not isinstance(explicit, int)
                or not MIN_US <= explicit <= MAX_US
            ):
                fail("STAGE5_DURATION_INVALID")
            return explicit
        if target is None:
            return 3_000_000
        if not MIN_US <= target <= MAX_US:
            fail("STAGE5_DURATION_CONFIRMATION_REQUIRED")
        return target

    @staticmethod
    def context(db: sqlite3.Connection, requirement_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT p.status,p.current_revision_id,r.confirmed,r.target_duration_us,a.id adoption_id,a.asset_id,x.kind,x.storage_mode,x.availability,v.document_json,v.document_sha256 FROM requirements r JOIN projects p ON p.id=r.project_id LEFT JOIN adoptions a ON a.id=(SELECT a2.id FROM adoptions a2 WHERE a2.requirement_id=r.id ORDER BY a2.ordinal DESC LIMIT 1) LEFT JOIN assets x ON x.id=a.asset_id LEFT JOIN revisions v ON v.id=p.current_revision_id WHERE r.id=?",
            (requirement_id,),
        ).fetchone()
        if row is None or row["status"] != "active" or row["confirmed"] != 1:
            fail("STAGE5_REQUIREMENT_NOT_ELIGIBLE")
        if row["adoption_id"] is None:
            fail("STAGE5_ADOPTION_CONFLICT")
        if row["current_revision_id"] is None:
            fail("STAGE5_TIMELINE_REQUIRED")
        if db.execute("SELECT 1 FROM drafts WHERE project_id='project'").fetchone():
            fail("STAGE5_TIMELINE_DRAFT_EXISTS")
        if (row["kind"], row["storage_mode"], row["availability"]) != (
            "image",
            "managed",
            "available",
        ):
            fail("STAGE5_ASSET_UNAVAILABLE")
        return row

    @staticmethod
    def already(db: sqlite3.Connection, requirement_id: str, document: dict[str, Any]) -> bool:
        ids = {c["clip_id"] for c in document["clips"]}
        rows = db.execute(
            "SELECT proposed_clip_id FROM assemblies WHERE requirement_id=?", (requirement_id,)
        ).fetchall()
        return any(r[0] in ids for r in rows)

    def prepare(
        self,
        requirement_id: str,
        expected_adoption_id: str,
        base_revision_id: str,
        at_index: int,
        duration_us: int | None,
        layout: str,
    ) -> dict[str, Any]:
        db = connect(self.path)
        db.execute("BEGIN IMMEDIATE")
        try:
            ctx = self.context(db, requirement_id)
            if ctx["adoption_id"] != expected_adoption_id:
                fail("STAGE5_ADOPTION_CONFLICT")
            if ctx["current_revision_id"] != base_revision_id:
                fail("STAGE5_TIMELINE_CONFLICT")
            base = json.loads(ctx["document_json"])
            if self.already(db, requirement_id, base):
                fail("STAGE5_ALREADY_ASSEMBLED")
            resolved = self.resolve_duration(ctx["target_duration_us"], duration_us)
            now = self.now()
            existing = db.execute(
                "SELECT w.* FROM previews w LEFT JOIN assemblies a ON a.preview_id=w.id WHERE w.requirement_id=? AND w.adoption_id=? AND w.base_revision_id=? AND w.at_index=? AND w.duration_us=? AND w.layout=? AND w.expires_at>? AND a.id IS NULL ORDER BY w.created_at DESC LIMIT 1",
                (
                    requirement_id,
                    expected_adoption_id,
                    base_revision_id,
                    at_index,
                    resolved,
                    layout,
                    iso(now),
                ),
            ).fetchone()
            if existing:
                db.execute("COMMIT")
                return self.preview_dto(existing, True)
            preview_id = f"preview_{time.time_ns()}"
            clip_id = f"clip_{time.time_ns()}"
            target, impact = build(base, ctx["asset_id"], clip_id, at_index, resolved, layout)
            target_sha = sha(target)
            payload = {
                "schema_version": 1,
                "project_id": "project",
                "requirement_id": requirement_id,
                "adoption_id": expected_adoption_id,
                "asset_id": ctx["asset_id"],
                "base_revision_id": base_revision_id,
                "base_sha256": ctx["document_sha256"],
                "proposed_clip_id": clip_id,
                "at_index": at_index,
                "duration_us": resolved,
                "layout": layout,
                "proposed_sha256": target_sha,
            }
            values = (
                preview_id,
                "project",
                requirement_id,
                expected_adoption_id,
                ctx["asset_id"],
                base_revision_id,
                ctx["document_sha256"],
                clip_id,
                at_index,
                resolved,
                layout,
                target_sha,
                sha(payload),
                impact["clip_count_before"],
                impact["shifted_clip_count"],
                impact["shifted_caption_count"],
                impact["duration_before_us"],
                impact["duration_after_us"],
                iso(now + timedelta(minutes=15)),
                iso(now),
            )
            db.execute(
                "INSERT INTO previews VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values
            )
            row = db.execute("SELECT * FROM previews WHERE id=?", (preview_id,)).fetchone()
            db.execute("COMMIT")
            return self.preview_dto(row, False)
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def preview_dto(row: sqlite3.Row, reused: bool) -> dict[str, Any]:
        allowed = (
            "id",
            "project_id",
            "requirement_id",
            "adoption_id",
            "asset_id",
            "base_revision_id",
            "base_sha256",
            "proposed_clip_id",
            "at_index",
            "duration_us",
            "layout",
            "proposed_sha256",
            "preview_sha256",
            "clip_count_before",
            "shifted_clip_count",
            "shifted_caption_count",
            "duration_before_us",
            "duration_after_us",
            "expires_at",
            "created_at",
        )
        return {**{k: row[k] for k in allowed}, "reused": reused}

    @staticmethod
    def assembly_dto(row: sqlite3.Row, reused: bool) -> dict[str, Any]:
        return {**dict(row), "reused": reused}

    def apply(
        self,
        requirement_id: str,
        preview_id: str,
        proposed_sha256: str,
        confirmed: bool,
        fault: str | None = None,
    ) -> dict[str, Any]:
        if confirmed is not True:
            fail("STAGE5_CONFIRMATION_REQUIRED")
        db = connect(self.path)
        db.execute("BEGIN IMMEDIATE")
        try:
            preview = db.execute(
                "SELECT * FROM previews WHERE id=? AND requirement_id=?",
                (preview_id, requirement_id),
            ).fetchone()
            if preview is None:
                fail("STAGE5_ASSEMBLY_NOT_FOUND")
            if preview["proposed_sha256"] != proposed_sha256:
                fail("STAGE5_PREVIEW_MISMATCH")
            existing = db.execute(
                "SELECT * FROM assemblies WHERE preview_id=?", (preview_id,)
            ).fetchone()
            if existing:
                db.execute("COMMIT")
                return self.assembly_dto(existing, True)
            if preview["expires_at"] <= iso(self.now()):
                fail("STAGE5_PREVIEW_EXPIRED")
            ctx = self.context(db, requirement_id)
            if ctx["adoption_id"] != preview["adoption_id"]:
                fail("STAGE5_ADOPTION_CONFLICT")
            if ctx["current_revision_id"] != preview["base_revision_id"]:
                fail("STAGE5_TIMELINE_CONFLICT")
            base = json.loads(ctx["document_json"])
            target, _ = build(
                base,
                preview["asset_id"],
                preview["proposed_clip_id"],
                preview["at_index"],
                preview["duration_us"],
                preview["layout"],
            )
            if sha(target) != preview["proposed_sha256"]:
                fail("STAGE5_PREVIEW_MISMATCH")
            revision_id = f"revision_{time.time_ns()}"
            db.execute(
                "INSERT INTO revisions VALUES (?,?,?,?,?)",
                (
                    revision_id,
                    "project",
                    preview["base_revision_id"],
                    canonical(target),
                    sha(target),
                ),
            )
            db.execute(
                "UPDATE projects SET current_revision_id=? WHERE id='project'", (revision_id,)
            )
            if fault == "revision":
                raise RuntimeError("injected")
            assembly_id = f"assembly_{time.time_ns()}"
            values = (
                assembly_id,
                preview_id,
                "project",
                requirement_id,
                preview["adoption_id"],
                preview["asset_id"],
                preview["base_revision_id"],
                revision_id,
                preview["proposed_clip_id"],
                preview["proposed_sha256"],
                iso(self.now()),
            )
            db.execute("INSERT INTO assemblies VALUES (?,?,?,?,?,?,?,?,?,?,?)", values)
            if fault == "assembly":
                raise RuntimeError("injected")
            row = db.execute("SELECT * FROM assemblies WHERE id=?", (assembly_id,)).fetchone()
            db.execute("COMMIT")
            return self.assembly_dto(row, False)
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()


def seed(
    root: Path,
    count: int = 1,
    clips: int = 0,
    target: int | None = 3_000_000,
    locked: set[int] | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Model:
    model = Model(root / "stage5-prototype.db", now)
    db = connect(model.path)
    document = make_document(clips, locked)
    revision_id = "revision_base"
    db.execute("INSERT INTO projects VALUES ('project','active',?)", (revision_id,))
    db.execute("INSERT INTO assets VALUES ('asset','project','image','managed','available')")
    db.execute(
        "INSERT INTO revisions VALUES (?,?,?,?,?)",
        (revision_id, "project", None, canonical(document), sha(document)),
    )
    for i in range(count):
        db.execute(
            "INSERT INTO requirements VALUES (?,?,1,?)", (f"requirement_{i}", "project", target)
        )
        db.execute(
            "INSERT INTO adoptions VALUES (?,?,?,1)", (f"adoption_{i}", f"requirement_{i}", "asset")
        )
    db.close()
    return model


def current(model: Model) -> sqlite3.Row:
    db = connect(model.path)
    row = db.execute(
        "SELECT v.* FROM projects p JOIN revisions v ON v.id=p.current_revision_id WHERE p.id='project'"
    ).fetchone()
    db.close()
    return row


def prepare_current(
    model: Model,
    index: int = 0,
    at_index: int | None = None,
    duration_us: int | None = None,
    layout: str = "fit",
) -> dict[str, Any]:
    row = current(model)
    document = json.loads(row["document_json"])
    return model.prepare(
        f"requirement_{index}",
        f"adoption_{index}",
        row["id"],
        len(document["clips"]) if at_index is None else at_index,
        duration_us,
        layout,
    )


def safe(value: Any) -> bool:
    return not any(marker in canonical(value).lower() for marker in SENSITIVE)


def p95(values: list[float]) -> float:
    return round(sorted(values)[max(0, round((len(values) - 1) * 0.95))], 3)


def run_prototype(root: Path, iterations: int = 20) -> dict[str, Any]:
    model = seed(root, count=max(24, iterations))
    prepare_ms, apply_ms = [], []
    for i in range(iterations):
        start = time.perf_counter()
        preview = prepare_current(
            model, i, duration_us=500_000 + (i % 10) * 100_000, layout=tuple(LAYOUTS)[i % 3]
        )
        prepare_ms.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        model.apply(f"requirement_{i}", preview["id"], preview["proposed_sha256"], True)
        apply_ms.append((time.perf_counter() - start) * 1000)
    db = connect(model.path)
    dump = "\n".join(db.iterdump()).lower()
    report = {
        "schema": "v16-isolated-candidate",
        "contexts": {
            "requirements": db.execute("SELECT COUNT(*) FROM requirements").fetchone()[0],
            "previews": db.execute("SELECT COUNT(*) FROM previews").fetchone()[0],
            "assemblies": db.execute("SELECT COUNT(*) FROM assemblies").fetchone()[0],
        },
        "validation": evaluate_rule_matrix(),
        "performance_ms": {
            "prepare_p95": p95(prepare_ms),
            "apply_p95": p95(apply_ms),
            "prepare_median": round(statistics.median(prepare_ms), 3),
            "apply_median": round(statistics.median(apply_ms), 3),
        },
        "database": {
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(db.execute("PRAGMA foreign_key_check").fetchall()),
        },
        "provider_call_delta": model.provider_calls,
        "network_call_count": model.network_calls,
        "privacy": {
            "report_safe": True,
            "sqlite_sensitive_marker_hits": sum(m in dump for m in SENSITIVE),
        },
    }
    db.close()
    report["privacy"]["report_safe"] = safe(report)
    return report


def evaluate_rule_matrix() -> dict[str, Any]:
    cases: list[tuple[str, Callable[[], Any], str | int]] = [
        ("duration_default", lambda: Model.resolve_duration(None, None), 3_000_000),
        ("duration_target_min", lambda: Model.resolve_duration(MIN_US, None), MIN_US),
        ("duration_target_max", lambda: Model.resolve_duration(MAX_US, None), MAX_US),
        ("duration_override", lambda: Model.resolve_duration(40_000_000, 2_000_000), 2_000_000),
        ("duration_explicit_min", lambda: Model.resolve_duration(None, MIN_US), MIN_US),
        ("duration_explicit_max", lambda: Model.resolve_duration(None, MAX_US), MAX_US),
        (
            "duration_target_low",
            lambda: Model.resolve_duration(MIN_US - 1, None),
            "STAGE5_DURATION_CONFIRMATION_REQUIRED",
        ),
        (
            "duration_target_high",
            lambda: Model.resolve_duration(MAX_US + 1, None),
            "STAGE5_DURATION_CONFIRMATION_REQUIRED",
        ),
        (
            "duration_explicit_low",
            lambda: Model.resolve_duration(None, MIN_US - 1),
            "STAGE5_DURATION_INVALID",
        ),
        (
            "duration_explicit_high",
            lambda: Model.resolve_duration(None, MAX_US + 1),
            "STAGE5_DURATION_INVALID",
        ),
        (
            "position_empty",
            lambda: len(build(make_document(0), "asset", "c0", 0, MIN_US, "fit")[0]["clips"]),
            1,
        ),
        (
            "position_first",
            lambda: build(make_document(2), "asset", "c1", 0, MIN_US, "fit")[1][
                "shifted_clip_count"
            ],
            2,
        ),
        (
            "position_middle",
            lambda: build(make_document(2), "asset", "c2", 1, MIN_US, "fit")[1][
                "shifted_clip_count"
            ],
            1,
        ),
        (
            "position_end",
            lambda: build(make_document(2), "asset", "c3", 2, MIN_US, "fit")[1][
                "shifted_clip_count"
            ],
            0,
        ),
        (
            "position_negative",
            lambda: build(make_document(1), "asset", "c4", -1, MIN_US, "fit"),
            "STAGE5_POSITION_INVALID",
        ),
        (
            "position_overflow",
            lambda: build(make_document(1), "asset", "c5", 2, MIN_US, "fit"),
            "STAGE5_POSITION_INVALID",
        ),
        (
            "layout_fit",
            lambda: build(make_document(0), "asset", "c6", 0, MIN_US, "fit")[0]["clips"][0][
                "layout"
            ],
            "fit",
        ),
        (
            "layout_crop",
            lambda: build(make_document(0), "asset", "c7", 0, MIN_US, "crop_fill")[0]["clips"][0][
                "layout"
            ],
            "crop_fill",
        ),
        (
            "layout_blur",
            lambda: build(make_document(0), "asset", "c8", 0, MIN_US, "blurred_background")[0][
                "clips"
            ][0]["layout"],
            "blurred_background",
        ),
        (
            "layout_invalid",
            lambda: build(make_document(0), "asset", "c9", 0, MIN_US, "other"),
            "STAGE5_PREVIEW_MISMATCH",
        ),
        (
            "locked_upstream",
            lambda: build(make_document(2, {0}), "asset", "c10", 1, MIN_US, "fit")[1][
                "shifted_clip_count"
            ],
            1,
        ),
        (
            "locked_downstream",
            lambda: build(make_document(2, {1}), "asset", "c11", 1, MIN_US, "fit"),
            "STAGE5_LOCKED_SHIFT",
        ),
        (
            "caption_shift",
            lambda: build(make_document(2), "asset", "c12", 0, MIN_US, "fit")[1][
                "shifted_caption_count"
            ],
            2,
        ),
        (
            "hash_determinism",
            lambda: (
                sha(build(make_document(2), "asset", "fixed", 1, 1_000_000, "fit")[0])
                == sha(build(make_document(2), "asset", "fixed", 1, 1_000_000, "fit")[0])
            ),
            True,
        ),
    ]
    matched = 0
    for _, action, expected in cases:
        try:
            actual = action()
        except ModelError as error:
            actual = error.code
        matched += actual == expected
    return {
        "rule_cases": len(cases),
        "matched": matched,
        "accuracy_percent": round(matched * 100 / len(cases), 1),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Stage 5 isolated timeline assembly prototype")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=20)
    arguments = parser.parse_args()
    print(
        json.dumps(
            run_prototype(arguments.output_dir, arguments.iterations),
            ensure_ascii=False,
            indent=2,
        )
    )
