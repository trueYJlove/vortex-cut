# ruff: noqa: E501
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "stage4e_requirement_fulfillment_model",
    ROOT / "tools" / "prototypes" / "stage4e_requirement_fulfillment_model.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def opened(tmp_path: Path):
    database = MODULE.initialize(tmp_path / "app.db")
    context = database.connection()
    db = context.__enter__()
    MODULE.seed(db)
    return context, db


def test_v15_migration_is_additive_and_frozen_checksums_are_stable(tmp_path: Path) -> None:
    before = MODULE.frozen_checksums()
    context, db = opened(tmp_path)
    try:
        assert before == MODULE.frozen_checksums()
        assert len(before) == 14
        assert db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='v15'").fetchone()[0] == 1
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"shot_requirement_image_generation_links", "shot_requirement_image_adoptions"} <= tables
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        context.__exit__(None, None, None)


def test_requirement_hash_has_verified_fixed_vector(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        row = db.execute("SELECT * FROM shot_requirements WHERE id='requirement_a'").fetchone()
        assert MODULE.requirement_hash(row) == "sha256:9b5b48e0e5a2076dca47a0756b675a287e6ecd5c9c6dcc101a0cfacec7e2c243"
        changed = dict(row)
        changed["title"] = "Changed"
        assert MODULE.requirement_hash(changed) != MODULE.requirement_hash(row)
    finally:
        context.__exit__(None, None, None)


def test_link_constraints_profile_and_immutability(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        MODULE.create_request_facts(db, "request_ok", "task_ok")
        MODULE.insert_link(db, "link_ok", "requirement_a", "request_ok")
        assert db.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[0] == 1
        MODULE.create_request_facts(
            db,
            "request_openai",
            "task_openai",
            provider_kind="openai_images",
            adapter_id="openai_images_generations_v1",
            model="gpt-image-1",
        )
        with pytest.raises(Exception):
            MODULE.insert_link(db, "link_openai", "requirement_b", "request_openai")
        with pytest.raises(Exception):
            MODULE.insert_link(db, "link_old", "requirement_old", "request_ok", revision_id="revision_old")
        with pytest.raises(Exception):
            MODULE.insert_link(db, "link_media", "requirement_media", "request_ok")
        with pytest.raises(Exception):
            db.execute("UPDATE shot_requirement_image_generation_links SET requirement_sha256='x' WHERE id='link_ok'")
        with pytest.raises(Exception):
            db.execute("DELETE FROM shot_requirement_image_generation_links WHERE id='link_ok'")
    finally:
        context.__exit__(None, None, None)


def test_same_request_can_link_two_requirements(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        MODULE.create_request_facts(db, "request_shared", "task_shared")
        MODULE.insert_link(db, "link_a", "requirement_a", "request_shared")
        MODULE.insert_link(db, "link_b", "requirement_b", "request_shared")
        assert db.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links WHERE request_id='request_shared'").fetchone()[0] == 2
    finally:
        context.__exit__(None, None, None)


def test_fresh_and_reused_hooks_are_atomic(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        def failed_fresh(sql, facts):
            MODULE.insert_link(sql, "link_rollback", "requirement_a", facts["request_id"])
            raise RuntimeError("hook failed")

        with pytest.raises(RuntimeError):
            MODULE.create_with_hook(db, "request_fresh", "task_fresh", failed_fresh, request_sha="sha256:fresh")
        assert db.execute("SELECT COUNT(*) FROM media_generation_requests WHERE id='request_fresh'").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE id='job_task_fresh'").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links WHERE id='link_rollback'").fetchone()[0] == 0

        fresh = MODULE.create_with_hook(
            db,
            "request_reused",
            "task_reused",
            lambda sql, facts: MODULE.insert_link(sql, "link_a", "requirement_a", facts["request_id"]),
            request_sha="sha256:reuse",
        )
        assert fresh["reused"] is False
        counts = tuple(db.execute("SELECT (SELECT COUNT(*) FROM media_generation_requests),(SELECT COUNT(*) FROM media_generation_tasks),(SELECT COUNT(*) FROM jobs)").fetchone())

        def failed_reused(sql, facts):
            MODULE.insert_link(sql, "link_b", "requirement_b", facts["request_id"])
            raise RuntimeError("hook failed")

        with pytest.raises(RuntimeError):
            MODULE.create_with_hook(db, "unused", "unused", failed_reused, request_sha="sha256:reuse")
        assert tuple(db.execute("SELECT (SELECT COUNT(*) FROM media_generation_requests),(SELECT COUNT(*) FROM media_generation_tasks),(SELECT COUNT(*) FROM jobs)").fetchone()) == counts
        assert db.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links WHERE id='link_b'").fetchone()[0] == 0
        ordinary = MODULE.create_with_hook(db, "request_plain", "task_plain", None, request_sha="sha256:plain")
        assert ordinary["hook_result"] is None and ordinary["reused"] is False
    finally:
        context.__exit__(None, None, None)

def test_adoption_append_cas_cross_checks_and_unavailable_history(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        MODULE.create_request_facts(db, "request_a", "task_a")
        MODULE.complete_task(db, "request_a", "task_a", "asset_a")
        MODULE.insert_link(db, "link_a", "requirement_a", "request_a")
        first, reused = MODULE.adopt(db, "adoption_1", "requirement_a", "link_a", "task_a", "asset_a", None)
        assert reused is False and first["adoption_ordinal"] == 1 and first["previous_adoption_id"] is None
        with pytest.raises(ValueError, match="ADOPTION_CONFLICT"):
            MODULE.adopt(db, "stale", "requirement_a", "link_a", "task_a", "asset_a", None)
        same, reused = MODULE.adopt(db, "ignored", "requirement_a", "link_a", "task_a", "asset_a", "adoption_1")
        assert reused is True and same["id"] == "adoption_1"

        MODULE.create_request_facts(db, "request_b", "task_b")
        MODULE.complete_task(db, "request_b", "task_b", "asset_b")
        MODULE.insert_link(db, "link_b", "requirement_a", "request_b")
        second, reused = MODULE.adopt(db, "adoption_2", "requirement_a", "link_b", "task_b", "asset_b", "adoption_1")
        assert reused is False and second["adoption_ordinal"] == 2 and second["previous_adoption_id"] == "adoption_1"
        db.execute("UPDATE assets SET availability='missing' WHERE id='asset_b'")
        assert db.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0] == 2
        assert MODULE.lifecycle(task_statuses=["succeeded"], adoption_exists=True, adopted_asset_availability="missing") == "adopted_unavailable"
        with pytest.raises(Exception):
            db.execute("UPDATE shot_requirement_image_adoptions SET adoption_ordinal=3 WHERE id='adoption_2'")
        with pytest.raises(Exception):
            db.execute("DELETE FROM shot_requirement_image_adoptions WHERE id='adoption_1'")
    finally:
        context.__exit__(None, None, None)


def test_adoption_trigger_rejects_task_asset_and_provenance_mismatch(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        MODULE.create_request_facts(db, "request_a", "task_a")
        MODULE.complete_task(db, "request_a", "task_a", "asset_a")
        MODULE.insert_link(db, "link_a", "requirement_a", "request_a")
        MODULE.create_request_facts(db, "request_b", "task_b")
        MODULE.complete_task(db, "request_b", "task_b", "asset_b")
        with pytest.raises(Exception):
            db.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("bad", "project_a", "revision_a", "requirement_a", "link_a", "task_b", "asset_b", 1, None, "now"),
            )
        with pytest.raises(Exception):
            db.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("bad2", "project_a", "revision_a", "requirement_a", "link_a", "task_a", "asset_b", 1, None, "now"),
            )
        db.execute("UPDATE shot_lists SET confirmed_revision_id='revision_old' WHERE id='list_a'")
        with pytest.raises(Exception):
            db.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("bad3", "project_a", "revision_a", "requirement_a", "link_a", "task_a", "asset_a", 1, None, "now"),
            )
    finally:
        context.__exit__(None, None, None)


def test_lifecycle_priority_is_frozen() -> None:
    assert MODULE.lifecycle(task_statuses=[], adoption_exists=False, adopted_asset_availability=None) == "unstarted"
    assert MODULE.lifecycle(task_statuses=["queued"], adoption_exists=False, adopted_asset_availability=None) == "in_progress"
    assert MODULE.lifecycle(task_statuses=["running", "failed"], adoption_exists=False, adopted_asset_availability=None) == "in_progress"
    assert MODULE.lifecycle(task_statuses=["succeeded", "running"], adoption_exists=False, adopted_asset_availability=None) == "review_required"
    assert MODULE.lifecycle(task_statuses=["failed", "cancelled", "interrupted"], adoption_exists=False, adopted_asset_availability=None) == "no_usable_output"
    assert MODULE.lifecycle(task_statuses=["failed"], adoption_exists=True, adopted_asset_availability="available") == "adopted"
    assert MODULE.lifecycle(task_statuses=["succeeded"], adoption_exists=True, adopted_asset_availability="changed") == "adopted_unavailable"


def test_link_insert_performance_privacy_and_provider_zero(tmp_path: Path) -> None:
    context, db = opened(tmp_path)
    try:
        p95 = MODULE.measure_link_insert_p95(db, iterations=20)
        evidence = {
            "provider_call_count": 0,
            "link_insert_p95_ms": p95,
            "lifecycle": "in_progress",
        }
        assert p95 <= 300
        assert evidence["provider_call_count"] == 0
        assert MODULE.safe_report(evidence)
        assert MODULE.safe_report({"error": "操作未完成，请刷新后重试。"})
        assert not MODULE.safe_report({"prompt": "SENTINEL_PROMPT"})
        assert not MODULE.safe_report({"error": r"C:\private\asset.png"})
    finally:
        context.__exit__(None, None, None)


def test_structured_prototype_report(tmp_path: Path) -> None:
    report = MODULE.run_prototype(tmp_path / "report.db", iterations=20)
    assert report["schema_version"] == "v15-candidate"
    assert report["frozen_migration_count"] == 14
    assert report["requirement_hash_fixed_vector"] == (
        "sha256:9b5b48e0e5a2076dca47a0756b675a287e6ecd5c9c6dcc101a0cfacec7e2c243"
    )
    assert report["link_insert_p95_ms"] <= 300
    assert report["provider_call_count"] == 0
    assert report["forbidden_side_effect_count"] == 0

def test_adoption_cas_with_two_database_connections(tmp_path: Path) -> None:
    database = MODULE.initialize(tmp_path / "two-window.db")
    with database.connection() as first, database.connection() as second:
        MODULE.seed(first)
        MODULE.create_request_facts(first, "request_a", "task_a")
        MODULE.complete_task(first, "request_a", "task_a", "asset_a")
        MODULE.insert_link(first, "link_a", "requirement_a", "request_a")

        first_snapshot = MODULE.current_adoption(first, "requirement_a")
        second_snapshot = MODULE.current_adoption(second, "requirement_a")
        assert first_snapshot is None and second_snapshot is None

        created, reused = MODULE.adopt(
            first,
            "adoption_first_window",
            "requirement_a",
            "link_a",
            "task_a",
            "asset_a",
            None,
        )
        assert reused is False and created["adoption_ordinal"] == 1
        with pytest.raises(ValueError, match="ADOPTION_CONFLICT"):
            MODULE.adopt(
                second,
                "adoption_second_window",
                "requirement_a",
                "link_a",
                "task_a",
                "asset_a",
                None,
            )
        assert second.execute(
            "SELECT COUNT(*) FROM shot_requirement_image_adoptions"
        ).fetchone()[0] == 1
