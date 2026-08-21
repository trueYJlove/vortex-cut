from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "stage6r_model",
    ROOT / "tools" / "prototypes" / "stage6r_timeline_batch_assembly_model.py",
)
assert SPEC and SPEC.loader
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


def code(expected, action):
    with pytest.raises(M.ModelError) as error:
        action()
    assert error.value.code == expected


def make_items(count, at_index=0, duration_us=1_000_000, layout="fit", offset=0):
    return [
        {
            "requirement_id": f"requirement_{offset + i}",
            "expected_adoption_id": f"adoption_{offset + i}",
            "duration_us": duration_us,
            "layout": layout,
        }
        for i in range(count)
    ]


def prepare(model, items=None, at_index=0):
    revision = M.current(model)
    return model.prepare(revision["id"], at_index, items if items is not None else make_items(2))


def test_request_size_duplicate_position_duration_and_layout(tmp_path):
    model = M.seed(tmp_path, count=3)
    revision = M.current(model)
    for count, expected in ((1, "STAGE6_BATCH_SIZE_INVALID"), (51, "STAGE6_BATCH_SIZE_INVALID")):
        code(expected, lambda count=count: model.prepare(revision["id"], 0, make_items(count)))
    duplicated = make_items(2)
    duplicated[1]["requirement_id"] = duplicated[0]["requirement_id"]
    code(
        "STAGE6_BATCH_REQUIREMENT_DUPLICATED", lambda: model.prepare(revision["id"], 0, duplicated)
    )
    code("STAGE6_BATCH_POSITION_INVALID", lambda: model.prepare(revision["id"], 1, make_items(2)))
    for duration, expected in (
        (499_999, "STAGE6_BATCH_DURATION_INVALID"),
        (30_000_001, "STAGE6_BATCH_DURATION_INVALID"),
    ):
        items = make_items(2, duration_us=duration)
        code(expected, lambda items=items: model.prepare(revision["id"], 0, items))
    code(
        "STAGE6_BATCH_PREVIEW_MISMATCH",
        lambda: model.prepare(revision["id"], 0, make_items(2, layout="other")),
    )


def test_deterministic_order_and_continuous_positions(tmp_path):
    model = M.seed(tmp_path, count=3, clips=2)
    revision = M.current(model)
    preview = model.prepare(revision["id"], 1, make_items(3))
    applied = model.apply(preview["id"], preview["proposed_sha256"], True)
    document = json.loads(M.current(model)["document_json"])
    assert [item["requirement_id"] for item in applied["items"]] == [
        "requirement_0",
        "requirement_1",
        "requirement_2",
    ]
    assert [clip["clip_id"] for clip in document["clips"][1:4]] == [
        item["proposed_clip_id"] for item in applied["items"]
    ]
    assert all(clip["order_index"] == index for index, clip in enumerate(document["clips"]))
    assert preview["clip_count_after"] == preview["clip_count_before"] + 3
    assert preview["duration_after_us"] == preview["duration_before_us"] + 3_000_000


def test_prepare_reuses_semantically_identical_request(tmp_path):
    model = M.seed(tmp_path, count=2, clips=2)
    first = prepare(model, make_items(2), at_index=1)
    second = prepare(model, make_items(2), at_index=1)
    assert second["reused"] is True and second["id"] == first["id"]
    changed = make_items(2)
    changed.reverse()
    third = prepare(model, changed, at_index=1)
    assert third["reused"] is False and third["id"] != first["id"]


def test_apply_atomic_and_one_revision_one_batch(tmp_path):
    model = M.seed(tmp_path, count=2, clips=1)
    preview = prepare(model)
    db = M.connect(model.path)
    before = db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
    db.close()
    for fault in ("revision", "assembly"):
        with pytest.raises(RuntimeError, match="injected"):
            model.apply(preview["id"], preview["proposed_sha256"], True, fault=fault)
        db = M.connect(model.path)
        assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == before
        assert db.execute("SELECT COUNT(*) FROM batch_assemblies").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM batch_assembly_items").fetchone()[0] == 0
        db.close()
    applied = model.apply(preview["id"], preview["proposed_sha256"], True)
    replay = model.apply(preview["id"], preview["proposed_sha256"], True)
    assert replay["reused"] is True and replay["id"] == applied["id"]
    db = M.connect(model.path)
    assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == before + 1
    assert db.execute("SELECT COUNT(*) FROM batch_assemblies").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM batch_assembly_items").fetchone()[0] == 2
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    for table in (
        "batch_previews",
        "batch_preview_items",
        "batch_assemblies",
        "batch_assembly_items",
    ):
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(f"UPDATE {table} SET created_at='2020-01-01T00:00:00Z'")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(f"DELETE FROM {table}")
    db.close()


def test_apply_rechecks_conflicts_expiry_and_confirmation(tmp_path):
    cases = {
        "adoption": "STAGE6_BATCH_ADOPTION_CONFLICT",
        "timeline": "STAGE6_BATCH_TIMELINE_CONFLICT",
        "draft": "STAGE6_BATCH_TIMELINE_DRAFT_EXISTS",
        "asset": "STAGE6_BATCH_ASSET_UNAVAILABLE",
    }
    for case, expected in cases.items():
        model = M.seed(tmp_path / case, count=2)
        preview = prepare(model)
        db = M.connect(model.path)
        if case == "adoption":
            db.execute("INSERT INTO adoptions VALUES ('new','requirement_0','asset_0',2)")
        elif case == "timeline":
            document = M.make_document(1)
            db.execute(
                "INSERT INTO revisions VALUES ('new','project','revision_base',?,?)",
                (M.canonical(document), M.sha(document)),
            )
            db.execute("UPDATE projects SET current_revision_id='new'")
        elif case == "draft":
            db.execute("INSERT INTO drafts VALUES ('project','revision_base')")
        else:
            db.execute("UPDATE assets SET availability='missing'")
        db.close()
        code(
            expected,
            lambda model=model, preview=preview: model.apply(
                preview["id"], preview["proposed_sha256"], True
            ),
        )

    hash_model = M.seed(tmp_path / "hash", count=2)
    hash_preview = prepare(hash_model)
    code(
        "STAGE6_BATCH_PREVIEW_MISMATCH",
        lambda: hash_model.apply(hash_preview["id"], "sha256:wrong", True),
    )
    code(
        "STAGE6_BATCH_CONFIRMATION_REQUIRED",
        lambda: hash_model.apply(hash_preview["id"], hash_preview["proposed_sha256"], False),
    )
    clock = [datetime(2026, 8, 20, tzinfo=UTC)]
    expired_model = M.seed(tmp_path / "expired", count=2, now=lambda: clock[0])
    expired_preview = prepare(expired_model)
    clock[0] += timedelta(minutes=16)
    code(
        "STAGE6_BATCH_PREVIEW_EXPIRED",
        lambda: expired_model.apply(
            expired_preview["id"], expired_preview["proposed_sha256"], True
        ),
    )


def test_concurrent_apply_creates_one_fact(tmp_path):
    model = M.seed(tmp_path, count=2)
    preview = prepare(model)

    def apply(_):
        return model.apply(preview["id"], preview["proposed_sha256"], True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(apply, range(2)))
    assert len({result["id"] for result in results}) == 1
    assert sorted(result["reused"] for result in results) == [False, True]
    db = M.connect(model.path)
    assert db.execute("SELECT COUNT(*) FROM batch_assemblies").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM batch_assembly_items").fetchone()[0] == 2
    db.close()


def test_run_prototype_zero_provider_network_and_privacy(tmp_path):
    report = M.run_prototype(tmp_path, iterations=3)
    assert report["contexts"] == {
        "requirements": 72,
        "batch_previews": 3,
        "batch_preview_items": 72,
        "batch_assemblies": 3,
        "batch_assembly_items": 72,
    }
    assert report["validation"] == {"rule_cases": 5, "matched": 5, "accuracy_percent": 100.0}
    assert report["provider_call_delta"] == 0
    assert report["network_call_count"] == 0
    assert report["database"] == {"integrity": "ok", "foreign_key_violations": 0}
    assert report["privacy"] == {"report_safe": True, "sqlite_sensitive_marker_hits": 0}

