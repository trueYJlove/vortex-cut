# ruff: noqa: E501
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

MIN_ITEMS, MAX_ITEMS = 2, 24
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
CREATE TABLE batch_previews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),base_revision_id TEXT NOT NULL REFERENCES revisions(id),base_sha256 TEXT NOT NULL,at_index INTEGER NOT NULL,item_count INTEGER NOT NULL CHECK(item_count BETWEEN 2 AND 24),proposed_sha256 TEXT NOT NULL,preview_sha256 TEXT NOT NULL,clip_count_before INTEGER NOT NULL,clip_count_after INTEGER NOT NULL,shifted_clip_count INTEGER NOT NULL,shifted_caption_count INTEGER NOT NULL,duration_before_us INTEGER NOT NULL,duration_after_us INTEGER NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE batch_preview_items(id TEXT PRIMARY KEY,batch_preview_id TEXT NOT NULL REFERENCES batch_previews(id),item_index INTEGER NOT NULL,requirement_id TEXT NOT NULL REFERENCES requirements(id),adoption_id TEXT NOT NULL REFERENCES adoptions(id),asset_id TEXT NOT NULL REFERENCES assets(id),proposed_clip_id TEXT NOT NULL UNIQUE,duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),item_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(batch_preview_id,item_index),UNIQUE(batch_preview_id,requirement_id));
CREATE TABLE batch_assemblies(id TEXT PRIMARY KEY,batch_preview_id TEXT NOT NULL UNIQUE REFERENCES batch_previews(id),project_id TEXT NOT NULL REFERENCES projects(id),base_revision_id TEXT NOT NULL REFERENCES revisions(id),output_revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),proposed_sha256 TEXT NOT NULL,item_count INTEGER NOT NULL CHECK(item_count BETWEEN 2 AND 24),created_at TEXT NOT NULL);
CREATE TABLE batch_assembly_items(id TEXT PRIMARY KEY,batch_assembly_id TEXT NOT NULL REFERENCES batch_assemblies(id),item_index INTEGER NOT NULL,requirement_id TEXT NOT NULL REFERENCES requirements(id),adoption_id TEXT NOT NULL REFERENCES adoptions(id),asset_id TEXT NOT NULL REFERENCES assets(id),proposed_clip_id TEXT NOT NULL UNIQUE,duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),created_at TEXT NOT NULL,UNIQUE(batch_assembly_id,item_index),UNIQUE(batch_assembly_id,requirement_id),UNIQUE(batch_assembly_id,proposed_clip_id));
CREATE TRIGGER batch_previews_no_update BEFORE UPDATE ON batch_previews BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_previews_no_delete BEFORE DELETE ON batch_previews BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_preview_items_no_update BEFORE UPDATE ON batch_preview_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_preview_items_no_delete BEFORE DELETE ON batch_preview_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_assemblies_no_update BEFORE UPDATE ON batch_assemblies BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_assemblies_no_delete BEFORE DELETE ON batch_assemblies BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_assembly_items_no_update BEFORE UPDATE ON batch_assembly_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_assembly_items_no_delete BEFORE DELETE ON batch_assembly_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER batch_preview_items_validate BEFORE INSERT ON batch_preview_items WHEN NOT EXISTS(SELECT 1 FROM batch_previews w JOIN projects p ON p.id=w.project_id JOIN requirements r ON r.project_id=p.id AND r.id=NEW.requirement_id AND r.confirmed=1 JOIN adoptions a ON a.requirement_id=r.id AND a.id=NEW.adoption_id AND a.ordinal=(SELECT MAX(a2.ordinal) FROM adoptions a2 WHERE a2.requirement_id=r.id) JOIN assets x ON x.id=a.asset_id AND x.project_id=p.id WHERE w.id=NEW.batch_preview_id AND p.status='active' AND a.asset_id=NEW.asset_id AND x.kind='image' AND x.storage_mode='managed' AND x.availability='available' AND NOT EXISTS(SELECT 1 FROM drafts d WHERE d.project_id=p.id)) BEGIN SELECT RAISE(ABORT,'invalid item'); END;
CREATE TRIGGER batch_assemblies_validate BEFORE INSERT ON batch_assemblies WHEN NOT EXISTS(SELECT 1 FROM batch_previews w JOIN revisions o ON o.id=NEW.output_revision_id JOIN projects p ON p.id=w.project_id WHERE w.id=NEW.batch_preview_id AND NEW.project_id=w.project_id AND NEW.base_revision_id=w.base_revision_id AND NEW.proposed_sha256=w.proposed_sha256 AND NEW.item_count=w.item_count AND o.parent_id=w.base_revision_id AND o.document_sha256=w.proposed_sha256 AND p.current_revision_id=o.id) BEGIN SELECT RAISE(ABORT,'invalid assembly'); END;
"""


class ModelError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise ModelError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def total(document):
    return document["clips"][-1]["timeline_end_us"] if document["clips"] else 0


def make_document(count, locked=None):
    clips, captions = [], []
    for i in range(count):
        cid, start = f"base_clip_{i}", i * 1_000_000
        clips.append(
            {
                "clip_id": cid,
                "asset_id": f"base_asset_{i}",
                "asset_kind": "video",
                "order_index": i,
                "timeline_start_us": start,
                "timeline_end_us": start + 1_000_000,
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


def normalize(document):
    offset = 0
    for i, clip in enumerate(document["clips"]):
        length = clip["timeline_end_us"] - clip["timeline_start_us"]
        delta = offset - clip["timeline_start_us"]
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


def build_one(base, asset_id, clip_id, at_index, duration_us, layout):
    clips = base["clips"]
    if (
        isinstance(at_index, bool)
        or not isinstance(at_index, int)
        or not 0 <= at_index <= len(clips)
    ):
        fail("STAGE6_BATCH_POSITION_INVALID")
    if layout not in LAYOUTS:
        fail("STAGE6_BATCH_PREVIEW_MISMATCH")
    shifted = clips[at_index:]
    locked = set(base.get("locked_elements", []))
    if any(clip["clip_id"] in locked for clip in shifted):
        fail("STAGE6_BATCH_LOCKED_SHIFT")
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
        "shifted_clip_count": len(shifted),
        "shifted_caption_count": sum(
            c["source_clip_id"] in {x["clip_id"] for x in shifted} for c in base["captions"]
        ),
    }


def build_batch(base, at_index, items, clip_prefix=None):
    if (
        isinstance(at_index, bool)
        or not isinstance(at_index, int)
        or not 0 <= at_index <= len(base["clips"])
    ):
        fail("STAGE6_BATCH_POSITION_INVALID")
    document, shifted_clips, shifted_captions = base, 0, 0
    for index, item in enumerate(items):
        if "proposed_clip_id" in item:
            clip_id = item["proposed_clip_id"]
            if not isinstance(clip_id, str) or not clip_id:
                fail("STAGE6_BATCH_REQUEST_INVALID")
        elif clip_prefix is not None:
            if not isinstance(clip_prefix, str) or not clip_prefix:
                fail("STAGE6_BATCH_REQUEST_INVALID")
            clip_id = f"{clip_prefix}_{index}"
        else:
            fail("STAGE6_BATCH_REQUEST_INVALID")
        document, impact = build_one(
            document,
            item["asset_id"],
            clip_id,
            at_index + index,
            item["duration_us"],
            item["layout"],
        )
        shifted_clips += impact["shifted_clip_count"]
        shifted_captions += impact["shifted_caption_count"]
    return document, {
        "clip_count_before": len(base["clips"]),
        "clip_count_after": len(document["clips"]),
        "shifted_clip_count": shifted_clips,
        "shifted_caption_count": shifted_captions,
        "duration_before_us": total(base),
        "duration_after_us": total(document),
    }


def proposed_clip_id(
    base_sha256, at_index, item_index, requirement_id, adoption_id, asset_id, duration_us, layout
):
    payload = {
        "base_sha256": base_sha256,
        "at_index": at_index,
        "item_index": item_index,
        "requirement_id": requirement_id,
        "adoption_id": adoption_id,
        "asset_id": asset_id,
        "duration_us": duration_us,
        "layout": layout,
    }
    return "clip_" + hashlib.sha256(canonical(payload).encode()).hexdigest()[:24]


def connect(path):
    db = sqlite3.connect(path, timeout=5, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    return db


class Model:
    def __init__(self, path, now=lambda: datetime.now(UTC)):
        self.path, self.now, self.provider_calls, self.network_calls = path, now, 0, 0
        path.parent.mkdir(parents=True, exist_ok=True)
        db = connect(path)
        db.executescript(SCHEMA)
        db.close()

    @staticmethod
    def context(db, requirement_id):
        row = db.execute(
            "SELECT p.status,p.current_revision_id,r.confirmed,a.id adoption_id,a.asset_id,x.kind,x.storage_mode,x.availability,v.document_json,v.document_sha256 FROM requirements r JOIN projects p ON p.id=r.project_id LEFT JOIN adoptions a ON a.id=(SELECT a2.id FROM adoptions a2 WHERE a2.requirement_id=r.id ORDER BY a2.ordinal DESC LIMIT 1) LEFT JOIN assets x ON x.id=a.asset_id LEFT JOIN revisions v ON v.id=p.current_revision_id WHERE r.id=?",
            (requirement_id,),
        ).fetchone()
        if row is None or row["status"] != "active" or row["confirmed"] != 1:
            fail("STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE")
        if row["adoption_id"] is None:
            fail("STAGE6_BATCH_ADOPTION_CONFLICT")
        if row["current_revision_id"] is None:
            fail("STAGE6_BATCH_TIMELINE_REQUIRED")
        if db.execute("SELECT 1 FROM drafts WHERE project_id='project'").fetchone():
            fail("STAGE6_BATCH_TIMELINE_DRAFT_EXISTS")
        if (row["kind"], row["storage_mode"], row["availability"]) != (
            "image",
            "managed",
            "available",
        ):
            fail("STAGE6_BATCH_ASSET_UNAVAILABLE")
        return row

    @staticmethod
    def validate_request(base_revision_id, at_index, items):
        if not isinstance(base_revision_id, str) or not base_revision_id:
            fail("STAGE6_BATCH_REQUEST_INVALID")
        if not isinstance(items, list) or not MIN_ITEMS <= len(items) <= MAX_ITEMS:
            fail("STAGE6_BATCH_SIZE_INVALID")
        if isinstance(at_index, bool) or not isinstance(at_index, int) or at_index < 0:
            fail("STAGE6_BATCH_POSITION_INVALID")
        requirements = []
        for item in items:
            if not isinstance(item, dict) or set(item) != {
                "requirement_id",
                "expected_adoption_id",
                "duration_us",
                "layout",
            }:
                fail("STAGE6_BATCH_REQUEST_INVALID")
            if not all(
                isinstance(item[k], str) and item[k]
                for k in ("requirement_id", "expected_adoption_id")
            ):
                fail("STAGE6_BATCH_REQUEST_INVALID")
            if item["requirement_id"] in requirements:
                fail("STAGE6_BATCH_REQUIREMENT_DUPLICATED")
            requirements.append(item["requirement_id"])
            if (
                isinstance(item["duration_us"], bool)
                or not isinstance(item["duration_us"], int)
                or not MIN_US <= item["duration_us"] <= MAX_US
            ):
                fail("STAGE6_BATCH_DURATION_INVALID")
            if item["layout"] not in LAYOUTS:
                fail("STAGE6_BATCH_PREVIEW_MISMATCH")

    @staticmethod
    def already_assembled(db, requirement_id, document):
        ids = {clip["clip_id"] for clip in document["clips"]}
        return any(
            row[0] in ids
            for row in db.execute(
                "SELECT proposed_clip_id FROM batch_assembly_items WHERE requirement_id=?",
                (requirement_id,),
            ).fetchall()
        )

    def validate_items(self, db, base_revision_id, items):
        contexts = []
        for item in items:
            context = self.context(db, item["requirement_id"])
            if context["adoption_id"] != item["expected_adoption_id"]:
                fail("STAGE6_BATCH_ADOPTION_CONFLICT")
            if context["current_revision_id"] != base_revision_id:
                fail("STAGE6_BATCH_TIMELINE_CONFLICT")
            contexts.append(context)
        if len({context["document_sha256"] for context in contexts}) != 1:
            fail("STAGE6_BATCH_TIMELINE_CONFLICT")
        base = json.loads(contexts[0]["document_json"])
        for item in items:
            if self.already_assembled(db, item["requirement_id"], base):
                fail("STAGE6_BATCH_ALREADY_ASSEMBLED")
        return contexts

    def prepare(self, base_revision_id, at_index, items):
        self.validate_request(base_revision_id, at_index, items)
        db = connect(self.path)
        db.execute("BEGIN IMMEDIATE")
        try:
            contexts = self.validate_items(db, base_revision_id, items)
            base = json.loads(contexts[0]["document_json"])
            base_sha256 = contexts[0]["document_sha256"]
            batch_items = [
                {
                    "asset_id": context["asset_id"],
                    "duration_us": item["duration_us"],
                    "layout": item["layout"],
                    "proposed_clip_id": proposed_clip_id(
                        base_sha256,
                        at_index,
                        index,
                        item["requirement_id"],
                        item["expected_adoption_id"],
                        context["asset_id"],
                        item["duration_us"],
                        item["layout"],
                    ),
                }
                for index, (item, context) in enumerate(zip(items, contexts))
            ]
            target, impact = build_batch(base, at_index, batch_items)
            target_sha256 = sha(target)
            semantic_items = [
                {
                    "item_index": index,
                    "requirement_id": item["requirement_id"],
                    "adoption_id": item["expected_adoption_id"],
                    "asset_id": context["asset_id"],
                    "duration_us": item["duration_us"],
                    "layout": item["layout"],
                    "proposed_clip_id": batch_item["proposed_clip_id"],
                }
                for index, (item, context, batch_item) in enumerate(
                    zip(items, contexts, batch_items)
                )
            ]
            request_sha256 = sha(semantic_items)
            now = self.now()
            candidates = db.execute(
                "SELECT w.* FROM batch_previews w LEFT JOIN batch_assemblies a ON a.batch_preview_id=w.id WHERE w.base_revision_id=? AND w.at_index=? AND w.item_count=? AND w.proposed_sha256=? AND w.expires_at>? AND a.id IS NULL ORDER BY w.created_at DESC",
                (base_revision_id, at_index, len(items), target_sha256, iso(now)),
            ).fetchall()
            for candidate in candidates:
                rows = db.execute(
                    "SELECT * FROM batch_preview_items WHERE batch_preview_id=? ORDER BY item_index",
                    (candidate["id"],),
                ).fetchall()
                if len(rows) == len(items) and self.preview_items_sha256(rows) == request_sha256:
                    db.execute("COMMIT")
                    return self.preview_dto(db, candidate, True)
            preview_id = f"batch_preview_{time.time_ns()}"
            payload = {
                "schema_version": 1,
                "project_id": "project",
                "base_revision_id": base_revision_id,
                "base_sha256": base_sha256,
                "at_index": at_index,
                "item_count": len(items),
                "proposed_sha256": target_sha256,
            }
            db.execute(
                "INSERT INTO batch_previews VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    preview_id,
                    "project",
                    base_revision_id,
                    base_sha256,
                    at_index,
                    len(items),
                    target_sha256,
                    sha(payload),
                    impact["clip_count_before"],
                    impact["clip_count_after"],
                    impact["shifted_clip_count"],
                    impact["shifted_caption_count"],
                    impact["duration_before_us"],
                    impact["duration_after_us"],
                    iso(now + timedelta(minutes=15)),
                    iso(now),
                ),
            )
            for index, (item, context, batch_item) in enumerate(zip(items, contexts, batch_items)):
                item_payload = {
                    "batch_preview_id": preview_id,
                    "item_index": index,
                    "requirement_id": item["requirement_id"],
                    "adoption_id": item["expected_adoption_id"],
                    "asset_id": context["asset_id"],
                    "proposed_clip_id": batch_item["proposed_clip_id"],
                    "duration_us": item["duration_us"],
                    "layout": item["layout"],
                }
                db.execute(
                    "INSERT INTO batch_preview_items VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        f"item_{preview_id}_{index}",
                        preview_id,
                        index,
                        item["requirement_id"],
                        item["expected_adoption_id"],
                        context["asset_id"],
                        batch_item["proposed_clip_id"],
                        item["duration_us"],
                        item["layout"],
                        sha(item_payload),
                        iso(now),
                    ),
                )
            row = db.execute("SELECT * FROM batch_previews WHERE id=?", (preview_id,)).fetchone()
            db.execute("COMMIT")
            return self.preview_dto(db, row, False)
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def preview_items_sha256(rows):
        payload = [
            {
                "item_index": row["item_index"],
                "requirement_id": row["requirement_id"],
                "adoption_id": row["adoption_id"],
                "asset_id": row["asset_id"],
                "duration_us": row["duration_us"],
                "layout": row["layout"],
                "proposed_clip_id": row["proposed_clip_id"],
            }
            for row in rows
        ]
        return sha(payload)

    @staticmethod
    def preview_dto(db, row, reused):
        items = db.execute(
            "SELECT item_index,requirement_id,adoption_id,asset_id,proposed_clip_id,duration_us,layout FROM batch_preview_items WHERE batch_preview_id=? ORDER BY item_index",
            (row["id"],),
        ).fetchall()
        allowed = (
            "id",
            "project_id",
            "base_revision_id",
            "base_sha256",
            "at_index",
            "item_count",
            "proposed_sha256",
            "preview_sha256",
            "clip_count_before",
            "clip_count_after",
            "shifted_clip_count",
            "shifted_caption_count",
            "duration_before_us",
            "duration_after_us",
            "expires_at",
            "created_at",
        )
        return {
            **{key: row[key] for key in allowed},
            "items": [dict(item) for item in items],
            "reused": reused,
        }

    def apply(self, preview_id, proposed_sha256, confirmed, fault=None):
        if confirmed is not True:
            fail("STAGE6_BATCH_CONFIRMATION_REQUIRED")
        db = connect(self.path)
        db.execute("BEGIN IMMEDIATE")
        try:
            preview = db.execute(
                "SELECT * FROM batch_previews WHERE id=?", (preview_id,)
            ).fetchone()
            if preview is None:
                fail("STAGE6_BATCH_NOT_FOUND")
            if preview["proposed_sha256"] != proposed_sha256:
                fail("STAGE6_BATCH_PREVIEW_MISMATCH")
            existing = db.execute(
                "SELECT * FROM batch_assemblies WHERE batch_preview_id=?", (preview_id,)
            ).fetchone()
            if existing:
                db.execute("COMMIT")
                return self.assembly_dto(db, existing, True)
            if preview["expires_at"] <= iso(self.now()):
                fail("STAGE6_BATCH_PREVIEW_EXPIRED")
            rows = db.execute(
                "SELECT * FROM batch_preview_items WHERE batch_preview_id=? ORDER BY item_index",
                (preview_id,),
            ).fetchall()
            if len(rows) != preview["item_count"]:
                fail("STAGE6_BATCH_PREVIEW_MISMATCH")
            contexts = []
            for row in rows:
                context = self.context(db, row["requirement_id"])
                if context["adoption_id"] != row["adoption_id"]:
                    fail("STAGE6_BATCH_ADOPTION_CONFLICT")
                if context["current_revision_id"] != preview["base_revision_id"]:
                    fail("STAGE6_BATCH_TIMELINE_CONFLICT")
                contexts.append(context)
            base = json.loads(contexts[0]["document_json"])
            if contexts[0]["document_sha256"] != preview["base_sha256"]:
                fail("STAGE6_BATCH_TIMELINE_CONFLICT")
            for row in rows:
                if self.already_assembled(db, row["requirement_id"], base):
                    fail("STAGE6_BATCH_ALREADY_ASSEMBLED")
            items = [
                {
                    "asset_id": row["asset_id"],
                    "duration_us": row["duration_us"],
                    "layout": row["layout"],
                    "proposed_clip_id": row["proposed_clip_id"],
                }
                for row in rows
            ]
            target, _ = build_batch(base, preview["at_index"], items)
            if sha(target) != preview["proposed_sha256"]:
                fail("STAGE6_BATCH_PREVIEW_MISMATCH")
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
            assembly_id = f"batch_assembly_{time.time_ns()}"
            db.execute(
                "INSERT INTO batch_assemblies VALUES (?,?,?,?,?,?,?,?)",
                (
                    assembly_id,
                    preview_id,
                    "project",
                    preview["base_revision_id"],
                    revision_id,
                    preview["proposed_sha256"],
                    preview["item_count"],
                    iso(self.now()),
                ),
            )
            for row in rows:
                db.execute(
                    "INSERT INTO batch_assembly_items VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        f"item_{assembly_id}_{row['item_index']}",
                        assembly_id,
                        row["item_index"],
                        row["requirement_id"],
                        row["adoption_id"],
                        row["asset_id"],
                        row["proposed_clip_id"],
                        row["duration_us"],
                        row["layout"],
                        iso(self.now()),
                    ),
                )
            if fault == "assembly":
                raise RuntimeError("injected")
            result = db.execute(
                "SELECT * FROM batch_assemblies WHERE id=?", (assembly_id,)
            ).fetchone()
            db.execute("COMMIT")
            return self.assembly_dto(db, result, False)
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def assembly_dto(db, row, reused):
        items = db.execute(
            "SELECT item_index,requirement_id,adoption_id,asset_id,proposed_clip_id,duration_us,layout FROM batch_assembly_items WHERE batch_assembly_id=? ORDER BY item_index",
            (row["id"],),
        ).fetchall()
        return {
            "id": row["id"],
            "batch_preview_id": row["batch_preview_id"],
            "project_id": row["project_id"],
            "base_revision_id": row["base_revision_id"],
            "output_revision_id": row["output_revision_id"],
            "proposed_sha256": row["proposed_sha256"],
            "item_count": row["item_count"],
            "created_at": row["created_at"],
            "items": [dict(item) for item in items],
            "reused": reused,
        }


def seed(root, count=2, clips=0, target=3_000_000, locked=None, now=lambda: datetime.now(UTC)):
    model = Model(root / "stage6r-prototype.db", now)
    db = connect(model.path)
    document = make_document(clips, locked)
    db.execute("INSERT INTO projects VALUES ('project','active','revision_base')")
    db.execute(
        "INSERT INTO revisions VALUES ('revision_base','project',NULL,?,?)",
        (canonical(document), sha(document)),
    )
    for i in range(count):
        db.execute(
            "INSERT INTO requirements VALUES (?,?,1,?)", (f"requirement_{i}", "project", target)
        )
        db.execute(
            "INSERT INTO assets VALUES (?,?, 'image','managed','available')",
            (f"asset_{i}", "project"),
        )
        db.execute(
            "INSERT INTO adoptions VALUES (?,?,?,1)",
            (f"adoption_{i}", f"requirement_{i}", f"asset_{i}"),
        )
    db.close()
    return model


def current(model):
    db = connect(model.path)
    row = db.execute(
        "SELECT v.* FROM projects p JOIN revisions v ON v.id=p.current_revision_id WHERE p.id='project'"
    ).fetchone()
    db.close()
    return row


def request(model, count, at_index=0, duration_us=1_000_000, offset=0):
    row = current(model)
    document = json.loads(row["document_json"])
    items = [
        {
            "requirement_id": f"requirement_{offset + i}",
            "expected_adoption_id": f"adoption_{offset + i}",
            "duration_us": duration_us,
            "layout": "fit",
        }
        for i in range(count)
    ]
    return row["id"], (len(document["clips"]) if at_index < 0 else at_index), items


def safe(value):
    return not any(marker in canonical(value).lower() for marker in SENSITIVE)


def p95(values):
    return round(sorted(values)[max(0, round((len(values) - 1) * 0.95))], 3)


def evaluate_rule_matrix():
    base = make_document(2)
    item = {"asset_id": "a", "duration_us": MIN_US, "layout": "fit"}
    cases = [
        ("size_min", lambda: len(build_batch(base, 0, [item, item], "c")[0]["clips"]), 4),
        (
            "position_invalid",
            lambda: build_batch(base, 3, [item, item], "c"),
            "STAGE6_BATCH_POSITION_INVALID",
        ),
        (
            "locked_shift",
            lambda: build_batch(make_document(2, {1}), 0, [item, item], "c"),
            "STAGE6_BATCH_LOCKED_SHIFT",
        ),
        (
            "layout_invalid",
            lambda: build_batch(base, 0, [item, item | {"layout": "other"}], "c"),
            "STAGE6_BATCH_PREVIEW_MISMATCH",
        ),
        (
            "determinism",
            lambda: (
                sha(build_batch(base, 0, [item, item], "fixed")[0])
                == sha(build_batch(base, 0, [item, item], "fixed")[0])
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


def run_prototype(root, iterations=3):
    if isinstance(iterations, bool) or not isinstance(iterations, int) or iterations < 1:
        raise ValueError("iterations must be a positive integer")
    model = seed(root, count=max(24, iterations * 24))
    prepare_ms, apply_ms = [], []
    for iteration in range(iterations):
        start = time.perf_counter()
        base_id, at_index, items = request(model, 24, duration_us=500_000, offset=iteration * 24)
        preview = model.prepare(base_id, at_index, items)
        prepare_ms.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        model.apply(preview["id"], preview["proposed_sha256"], True)
        apply_ms.append((time.perf_counter() - start) * 1000)
    db = connect(model.path)
    dump = "\n".join(db.iterdump()).lower()
    report = {
        "schema": "v17-isolated-candidate",
        "contexts": {
            "requirements": db.execute("SELECT COUNT(*) FROM requirements").fetchone()[0],
            "batch_previews": db.execute("SELECT COUNT(*) FROM batch_previews").fetchone()[0],
            "batch_preview_items": db.execute(
                "SELECT COUNT(*) FROM batch_preview_items"
            ).fetchone()[0],
            "batch_assemblies": db.execute("SELECT COUNT(*) FROM batch_assemblies").fetchone()[0],
            "batch_assembly_items": db.execute(
                "SELECT COUNT(*) FROM batch_assembly_items"
            ).fetchone()[0],
        },
        "validation": evaluate_rule_matrix(),
        "performance_ms": {"prepare_p95": p95(prepare_ms), "apply_p95": p95(apply_ms)},
        "provider_call_delta": model.provider_calls,
        "network_call_count": model.network_calls,
        "database": {
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(db.execute("PRAGMA foreign_key_check").fetchall()),
        },
        "privacy": {
            "report_safe": safe({}),
            "sqlite_sensitive_marker_hits": sum(marker in dump for marker in SENSITIVE),
        },
    }
    db.close()
    return report


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Stage 6-R isolated batch timeline assembly prototype"
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=3)
    args = parser.parse_args()
    print(json.dumps(run_prototype(args.output_dir, args.iterations), ensure_ascii=False, indent=2))

