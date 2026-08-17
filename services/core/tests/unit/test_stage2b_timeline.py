from __future__ import annotations

import copy
import hashlib
from pathlib import Path

import pytest
from test_timeline import _create, _patch, _service

import aivs_core.database as database_module
from aivs_core.database import Database, MigrationError, json_dumps
from aivs_core.projects import DomainError
from aivs_core.timeline import timeline_diff


def test_historical_document_reads_default_lock_without_rehash(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    revision = state["current_revision"]
    historical = copy.deepcopy(revision["document"])
    historical.pop("locked_elements")
    raw = json_dumps(historical)
    digest = f"sha256:{hashlib.sha256(raw.encode()).hexdigest()}"
    with database.connection() as db:
        db.execute("DROP TRIGGER timeline_revisions_no_update")
        db.execute(
            "UPDATE timeline_revisions SET document_json=?,document_sha256=? WHERE id=?",
            (raw, digest, revision["timeline_revision_id"]),
        )
    loaded = service.get_revision(revision["timeline_revision_id"])
    assert loaded["document"]["locked_elements"] == []
    assert loaded["document_sha256"] == digest
    updated = _patch(
        service,
        {**state, "current_revision": loaded},
        [{"op": "set_clip_locked", "clip_id": historical["clips"][0]["clip_id"], "locked": True}],
    )
    assert updated["current_revision"]["document"]["locked_elements"]


def test_lock_protection_caption_and_operation_order_are_atomic(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    state = _create(
        service,
        {
            "kind": "transcript_selection",
            "transcript_id": "t1",
            "segment_ids": ["s1"],
            "padding_before_us": 0,
            "padding_after_us": 0,
            "create_captions": True,
        },
    )
    document = state["current_revision"]["document"]
    clip_id = document["clips"][0]["clip_id"]
    caption_id = document["captions"][0]["caption_id"]
    locked = _patch(
        service,
        state,
        [{"op": "set_clip_locked", "clip_id": clip_id, "locked": True}],
    )
    for operation in (
        {"op": "remove_clip", "clip_id": clip_id},
        {"op": "set_layout", "clip_id": clip_id, "layout": "fit"},
        {"op": "update_caption", "caption_id": caption_id, "text": "blocked"},
    ):
        with pytest.raises(DomainError) as error:
            _patch(service, locked, [operation])
        assert error.value.code == "TIMELINE_LOCKED"
    revision_count = None
    with database.connection() as db:
        revision_count = db.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0]
    with pytest.raises(DomainError) as wrong_order:
        _patch(
            service,
            locked,
            [
                {"op": "set_layout", "clip_id": clip_id, "layout": "fit"},
                {"op": "set_clip_locked", "clip_id": clip_id, "locked": False},
            ],
        )
    assert wrong_order.value.code == "TIMELINE_LOCKED"
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == revision_count
    unlocked = _patch(
        service,
        locked,
        [
            {"op": "set_clip_locked", "clip_id": clip_id, "locked": False},
            {"op": "set_layout", "clip_id": clip_id, "layout": "fit"},
        ],
    )
    assert unlocked["current_revision"]["document"]["locked_elements"] == []


def test_diff_is_stable_and_reports_indirect_locked_shift(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    base_state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    base_clip = base_state["current_revision"]["document"]["clips"][0]["clip_id"]
    locked_state = _patch(
        service,
        base_state,
        [{"op": "set_clip_locked", "clip_id": base_clip, "locked": True}],
    )
    target_state = _patch(
        service,
        locked_state,
        [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 0, "duration_us": 1_000_000}],
    )
    base = locked_state["current_revision"]
    target = target_state["current_revision"]
    first = timeline_diff(base, target)
    second = timeline_diff(base, target)
    assert first == second
    assert first["duration_delta_us"] == 1_000_000
    assert first["clip_changes"][0]["type"] == "added"
    assert first["indirect_locked_timing_shifts"] == [
        {
            "clip_id": base_clip,
            "from_start_us": 0,
            "from_end_us": 5_000_000,
            "to_start_us": 1_000_000,
            "to_end_us": 6_000_000,
        }
    ]
    with database.connection() as db:
        before = db.execute(
            "SELECT current_timeline_revision_id FROM projects WHERE id='p1'"
        ).fetchone()[0]
    assert (
        service.compare_revisions(
            "p1", base["timeline_revision_id"], target["timeline_revision_id"]
        )
        == first
    )
    with database.connection() as db:
        assert (
            db.execute(
                "SELECT current_timeline_revision_id FROM projects WHERE id='p1'"
            ).fetchone()[0]
            == before
        )


def test_v7_schema_and_immutable_records(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        assert (
            db.execute("SELECT version FROM schema_migrations ORDER BY version DESC").fetchone()[0]
            == "v9"
        )
        assert {row[1] for row in db.execute("PRAGMA table_info(jobs)")} >= {
            "timeline_patch_generation_id"
        }
        assert {row[1] for row in db.execute("PRAGMA table_info(provider_invocations)")} >= {
            "timeline_patch_generation_id"
        }
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {
            "timeline_patch_egress_previews",
            "timeline_patch_egress_consents",
            "timeline_patch_generations",
            "timeline_patch_proposals",
            "timeline_patch_applications",
        } <= tables
        preview_columns = {
            row[1] for row in db.execute("PRAGMA table_info(timeline_patch_egress_previews)")
        }
        assert (
            not {
                "payload_json",
                "payload",
                "instruction",
                "content",
                "caption_text",
                "timeline_json",
                "prompt",
                "http_body",
            }
            & preview_columns
        )


def test_v5_provider_upgrades_to_untested_v6_and_v7_capability(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute("DELETE FROM schema_migrations WHERE version IN ('v6','v7')")
        db.execute("DROP TRIGGER provider_timeline_patch_capability_valid_insert")
        db.execute("DROP TRIGGER provider_timeline_patch_capability_valid_update")
        db.execute("DROP TRIGGER provider_timeline_patch_capability_reset_on_config_change")
        db.execute(
            "INSERT INTO provider_configs("
            "id,kind,display_name,base_url,model,enabled,created_at,updated_at"
            ") VALUES ('p1','openai_compatible_text','P','https://provider.example',"
            "'m',1,'now','now')"
        )
        db.execute("ALTER TABLE provider_configs DROP COLUMN timeline_patch_capability_status")
        db.execute("ALTER TABLE provider_configs DROP COLUMN timeline_patch_response_adapter_id")
        db.execute("ALTER TABLE provider_configs DROP COLUMN timeline_patch_probe_protocol_version")
        db.execute("ALTER TABLE provider_configs DROP COLUMN timeline_patch_capability_tested_at")
        db.execute(
            "ALTER TABLE provider_configs DROP COLUMN timeline_patch_capability_failure_code"
        )
        db.execute(
            "ALTER TABLE provider_configs DROP COLUMN timeline_patch_capability_probe_sha256"
        )
    database.initialize()
    with database.connection() as db:
        assert db.execute("SELECT version FROM schema_migrations WHERE version='v6'").fetchone()
        assert db.execute("SELECT version FROM schema_migrations WHERE version='v7'").fetchone()
        assert (
            db.execute(
                "SELECT timeline_patch_capability_status FROM provider_configs WHERE id='p1'"
            ).fetchone()[0]
            == "untested"
        )


def test_v7_capability_triggers_enforce_all_metadata_combinations(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    base = (
        "openai_compatible_text",
        "P",
        "https://provider.example",
        "m",
        1,
        "now",
        "now",
    )
    insert = (
        "INSERT INTO provider_configs("
        "id,kind,display_name,base_url,model,enabled,created_at,updated_at,"
        "timeline_patch_capability_status,timeline_patch_response_adapter_id,"
        "timeline_patch_probe_protocol_version,timeline_patch_capability_tested_at,"
        "timeline_patch_capability_failure_code,timeline_patch_capability_probe_sha256) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    with database.connection() as db:
        db.execute(
            insert,
            ("p1", *base, "untested", None, None, None, None, None),
        )
        supported = (
            "supported",
            "openai_chat_completions_json_schema_v1",
            "1",
            "2026-08-13T00:00:00.000Z",
            None,
            "sha256:" + "a" * 64,
        )
        db.execute(
            insert,
            ("p2", *base, *supported),
        )
        for index, adapter in enumerate(
            (
                "openai_responses_json_schema_v1",
                "openai_responses_patchscript_v1",
                "openai_chat_completions_patchscript_v1",
            ),
            start=20,
        ):
            metadata = (
                "supported",
                adapter,
                "1",
                "now",
                None,
                "sha256:" + "d" * 64,
            )
            db.execute(insert, (f"p{index}", *base, *metadata))
        unsupported = (
            "unsupported",
            None,
            None,
            "2026-08-13T00:00:00.000Z",
            "PROVIDER_CAPABILITY_UNSUPPORTED",
            "sha256:" + "b" * 64,
        )
        db.execute(
            insert,
            ("p3", *base, *unsupported),
        )
        invalid = [
            ("untested", None, None, "now", None, None),
            ("supported", None, "1", "now", None, "sha256:" + "c" * 64),
            (
                "supported",
                "openai_chat_completions_json_schema_v1",
                "2",
                "now",
                None,
                "sha256:" + "c" * 64,
            ),
            (
                "supported",
                "openai_chat_completions_json_schema_v1",
                "1",
                None,
                None,
                "sha256:" + "c" * 64,
            ),
            (
                "unsupported",
                "openai_chat_completions_json_schema_v1",
                None,
                "now",
                "CODE",
                "sha256:" + "c" * 64,
            ),
            ("unsupported", None, None, "now", "CODE", None),
        ]
        for index, metadata in enumerate(invalid, start=4):
            with pytest.raises(Exception):
                db.execute(insert, (f"p{index}", *base, *metadata))
        with pytest.raises(Exception):
            db.execute(
                "UPDATE provider_configs SET timeline_patch_capability_status='unsupported',"
                "timeline_patch_capability_tested_at='now',"
                "timeline_patch_capability_failure_code='CODE',"
                "timeline_patch_capability_probe_sha256=NULL WHERE id='p1'"
            )
        db.execute("UPDATE provider_configs SET model='changed' WHERE id='p2'")
        row = db.execute(
            "SELECT timeline_patch_capability_status,timeline_patch_response_adapter_id,"
            "timeline_patch_probe_protocol_version,timeline_patch_capability_tested_at,"
            "timeline_patch_capability_failure_code,timeline_patch_capability_probe_sha256 "
            "FROM provider_configs WHERE id='p2'"
        ).fetchone()
        assert tuple(row) == ("untested", None, None, None, None, None)


def test_real_v6_to_v7_preserves_chat_structured_supported_and_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    full = database_module.MIGRATIONS
    monkeypatch.setattr(database_module, "MIGRATIONS", dict(list(full.items())[:-1]))
    Database(path).initialize()
    monkeypatch.setattr(database_module, "MIGRATIONS", full)
    with Database(path).connection() as db:
        db.execute(
            "INSERT INTO provider_configs("
            "id,kind,display_name,base_url,model,enabled,created_at,updated_at,"
            "timeline_patch_capability_status,timeline_patch_response_adapter_id,"
            "timeline_patch_probe_protocol_version,timeline_patch_capability_tested_at,"
            "timeline_patch_capability_failure_code,timeline_patch_capability_probe_sha256) "
            "VALUES ('p6','openai_compatible_text','P','https://provider.example','m',1,"
            "'now','now','supported','openai_chat_completions_json_schema_v1','1',"
            "'now',NULL,'sha256:" + "a" * 64 + "')"
        )
    database = Database(path)
    database.initialize()
    database.initialize()
    with database.connection() as db:
        row = db.execute(
            "SELECT timeline_patch_capability_status,timeline_patch_response_adapter_id,"
            "timeline_patch_probe_protocol_version,timeline_patch_capability_failure_code "
            "FROM provider_configs WHERE id='p6'"
        ).fetchone()
        assert tuple(row) == (
            "supported",
            "openai_chat_completions_json_schema_v1",
            "1",
            None,
        )
        count = db.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='v7'").fetchone()[
            0
        ]
        assert count == 1


def test_v7_failure_rolls_back_to_v6(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "app.db"
    full = database_module.MIGRATIONS
    v6_only = {
        version: sql
        for version, sql in full.items()
        if version
        in {
            "v1",
            "v2",
            "v3",
            "v4",
            "v5",
            "v6",
        }
    }
    monkeypatch.setattr(database_module, "MIGRATIONS", v6_only)
    Database(path).initialize()
    broken = {**v6_only, "v7": "CREATE TABLE broken ("}
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(MigrationError, match="v7"):
        Database(path).initialize()
    with Database(path).connection() as db:
        versions = [row[0] for row in db.execute("SELECT version FROM schema_migrations")]
        assert versions == ["v1", "v2", "v3", "v4", "v5", "v6"]
        assert db.execute("SELECT name FROM sqlite_master WHERE name='broken'").fetchone() is None
    monkeypatch.setattr(database_module, "MIGRATIONS", full)


def test_diff_recognizes_reliable_split(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    target = _patch(
        service,
        state,
        [{"op": "split_clip", "clip_id": clip_id, "source_time_us": 2_000_000}],
    )
    diff = timeline_diff(state["current_revision"], target["current_revision"])
    split = [change for change in diff["clip_changes"] if change["type"] == "split"]
    assert split == [
        {
            "type": "split",
            "clip_id": clip_id,
            "created_clip_ids": [target["current_revision"]["document"]["clips"][1]["clip_id"]],
        }
    ]
    assert not any(change["type"] == "added" for change in diff["clip_changes"])
