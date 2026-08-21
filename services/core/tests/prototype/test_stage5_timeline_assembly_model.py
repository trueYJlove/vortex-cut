# ruff: noqa: E501
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "stage5_model", ROOT / "tools" / "prototypes" / "stage5_timeline_assembly_model.py"
)
assert SPEC and SPEC.loader
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)


def code(expected, action):
    with pytest.raises(M.ModelError) as error:
        action()
    assert error.value.code == expected


def test_schema_constraints_immutability_and_consistency(tmp_path):
    model = M.seed(tmp_path)
    preview = M.prepare_current(model)
    db = M.connect(model.path)
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE previews SET duration_us=1000000 WHERE id=?", (preview["id"],))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM previews WHERE id=?", (preview["id"],))
    db.close()


def test_deterministic_builder_for_zero_one_hundred_and_positions(tmp_path):
    for count in (0, 1, 100):
        base = M.make_document(count)
        a, impact_a = M.build(base, "asset", "clip_fixed", count // 2, 1_500_000, "crop_fill")
        b, impact_b = M.build(base, "asset", "clip_fixed", count // 2, 1_500_000, "crop_fill")
        assert (
            M.sha(a) == M.sha(b)
            and impact_a == impact_b
            and len(a["clips"]) == count + 1
            and a["clips"][count // 2]["clip_id"] == "clip_fixed"
        )
        assert impact_a["shifted_clip_count"] == count - count // 2
    code(
        "STAGE5_POSITION_INVALID",
        lambda: M.build(M.make_document(1), "asset", "c", 2, 1_000_000, "fit"),
    )


def test_duration_preview_reuse_lock_and_draft(tmp_path):
    model = M.seed(tmp_path, target=None, clips=1)
    assert M.prepare_current(model, at_index=0)["duration_us"] == 3_000_000
    first = M.prepare_current(model, at_index=1, duration_us=500_000)
    second = M.prepare_current(model, at_index=1, duration_us=500_000)
    assert second["reused"] and first["id"] == second["id"]
    code("STAGE5_DURATION_INVALID", lambda: M.prepare_current(model, duration_us=499_999))
    outside = M.seed(tmp_path / "outside", target=40_000_000)
    code("STAGE5_DURATION_CONFIRMATION_REQUIRED", lambda: M.prepare_current(outside))
    assert M.prepare_current(outside, duration_us=2_000_000)["duration_us"] == 2_000_000
    locked = M.seed(tmp_path / "locked", clips=1, locked={0})
    code("STAGE5_LOCKED_SHIFT", lambda: M.prepare_current(locked, at_index=0))
    assert M.prepare_current(locked, at_index=1)["shifted_clip_count"] == 0
    draft = M.seed(tmp_path / "draft")
    db = M.connect(draft.path)
    db.execute("INSERT INTO drafts VALUES ('project','revision_base')")
    db.close()
    code("STAGE5_TIMELINE_DRAFT_EXISTS", lambda: M.prepare_current(draft))


def test_stale_adoption_timeline_unavailable_and_expiry(tmp_path):
    model = M.seed(tmp_path)
    db = M.connect(model.path)
    db.execute("INSERT INTO adoptions VALUES ('adoption_new','requirement_0','asset',2)")
    db.close()
    base = M.current(model)
    code(
        "STAGE5_ADOPTION_CONFLICT",
        lambda: model.prepare("requirement_0", "adoption_0", base["id"], 0, 1_000_000, "fit"),
    )
    stale = M.seed(tmp_path / "stale")
    db = M.connect(stale.path)
    doc = M.make_document(1)
    db.execute(
        "INSERT INTO revisions VALUES ('revision_new','project','revision_base',?,?)",
        (M.canonical(doc), M.sha(doc)),
    )
    db.execute("UPDATE projects SET current_revision_id='revision_new'")
    db.close()
    code(
        "STAGE5_TIMELINE_CONFLICT",
        lambda: stale.prepare("requirement_0", "adoption_0", "revision_base", 0, 1_000_000, "fit"),
    )
    unavailable = M.seed(tmp_path / "unavailable")
    db = M.connect(unavailable.path)
    db.execute("UPDATE assets SET availability='missing'")
    db.close()
    code("STAGE5_ASSET_UNAVAILABLE", lambda: M.prepare_current(unavailable))
    clock = [datetime(2026, 8, 20, tzinfo=UTC)]
    expired = M.seed(tmp_path / "expired", now=lambda: clock[0])
    preview = M.prepare_current(expired)
    clock[0] += timedelta(minutes=16)
    code(
        "STAGE5_PREVIEW_EXPIRED",
        lambda: expired.apply("requirement_0", preview["id"], preview["proposed_sha256"], True),
    )


def test_atomic_idempotent_already_assembled_and_history(tmp_path):
    model = M.seed(tmp_path)
    preview = M.prepare_current(model)
    db = M.connect(model.path)
    before = db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
    db.close()
    for fault in ("revision", "assembly"):
        with pytest.raises(RuntimeError, match="injected"):
            model.apply("requirement_0", preview["id"], preview["proposed_sha256"], True, fault)
        db = M.connect(model.path)
        assert db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == before
        assert db.execute("SELECT COUNT(*) FROM assemblies").fetchone()[0] == 0
        db.close()
    applied = model.apply("requirement_0", preview["id"], preview["proposed_sha256"], True)
    replay = model.apply("requirement_0", preview["id"], preview["proposed_sha256"], True)
    assert replay["reused"] and replay["id"] == applied["id"]
    code("STAGE5_ALREADY_ASSEMBLED", lambda: M.prepare_current(model))
    db = M.connect(model.path)
    db.execute("UPDATE projects SET current_revision_id=?", (applied["base_revision_id"],))
    assert db.execute("SELECT COUNT(*) FROM assemblies").fetchone()[0] == 1
    db.close()
    assert M.prepare_current(model)["requirement_id"] == "requirement_0"


def test_concurrent_apply_creates_one_fact(tmp_path):
    model = M.seed(tmp_path)
    preview = M.prepare_current(model)

    def apply(_):
        return model.apply("requirement_0", preview["id"], preview["proposed_sha256"], True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(apply, range(2)))
    assert len({r["id"] for r in results}) == 1 and sorted(r["reused"] for r in results) == [
        False,
        True,
    ]
    db = M.connect(model.path)
    assert (
        db.execute("SELECT COUNT(*) FROM assemblies").fetchone()[0] == 1
        and db.execute("SELECT COUNT(*) FROM revisions").fetchone()[0] == 2
    )
    db.close()


def test_performance_zero_provider_network_and_privacy(tmp_path):
    report = M.run_prototype(tmp_path, 20)
    assert report["contexts"] == {"requirements": 24, "previews": 20, "assemblies": 20}
    assert report["validation"] == {"rule_cases": 24, "matched": 24, "accuracy_percent": 100.0}
    assert (
        report["performance_ms"]["prepare_p95"] <= 300
        and report["performance_ms"]["apply_p95"] <= 300
    )
    assert report["provider_call_delta"] == 0 and report["network_call_count"] == 0
    assert report["database"] == {"integrity": "ok", "foreign_key_violations": 0}
    assert report["privacy"] == {"report_safe": True, "sqlite_sensitive_marker_hits": 0}


def test_zero_one_twenty_four_contexts_and_first_middle_end_positions(tmp_path):
    empty = M.seed(tmp_path / "empty", count=0)
    db = M.connect(empty.path)
    assert db.execute("SELECT COUNT(*) FROM requirements").fetchone()[0] == 0
    db.close()

    many = M.seed(tmp_path / "many", count=24, clips=2)
    db = M.connect(many.path)
    assert db.execute("SELECT COUNT(*) FROM requirements").fetchone()[0] == 24
    db.close()
    for index, position in enumerate((0, 1, 2)):
        preview = M.prepare_current(many, index=index, at_index=position, duration_us=1_000_000)
        assert preview["at_index"] == position


def test_apply_rechecks_adoption_timeline_draft_asset_and_hash(tmp_path):
    cases = ("adoption", "timeline", "draft", "asset")
    expected = {
        "adoption": "STAGE5_ADOPTION_CONFLICT",
        "timeline": "STAGE5_TIMELINE_CONFLICT",
        "draft": "STAGE5_TIMELINE_DRAFT_EXISTS",
        "asset": "STAGE5_ASSET_UNAVAILABLE",
    }
    for case in cases:
        model = M.seed(tmp_path / case)
        preview = M.prepare_current(model)
        db = M.connect(model.path)
        if case == "adoption":
            db.execute("INSERT INTO adoptions VALUES ('new_adoption','requirement_0','asset',2)")
        elif case == "timeline":
            document = M.make_document(1)
            db.execute(
                "INSERT INTO revisions VALUES ('new_revision','project','revision_base',?,?)",
                (M.canonical(document), M.sha(document)),
            )
            db.execute("UPDATE projects SET current_revision_id='new_revision'")
        elif case == "draft":
            db.execute("INSERT INTO drafts VALUES ('project','revision_base')")
        else:
            db.execute("UPDATE assets SET availability='missing'")
        db.close()
        code(
            expected[case],
            lambda model=model, preview=preview: model.apply(
                "requirement_0", preview["id"], preview["proposed_sha256"], True
            ),
        )

    model = M.seed(tmp_path / "hash")
    preview = M.prepare_current(model)
    code(
        "STAGE5_PREVIEW_MISMATCH",
        lambda: model.apply("requirement_0", preview["id"], "sha256:wrong", True),
    )
    code(
        "STAGE5_CONFIRMATION_REQUIRED",
        lambda: model.apply("requirement_0", preview["id"], preview["proposed_sha256"], False),
    )
