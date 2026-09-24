# ruff: noqa: E501
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V17_SQL, Database
from aivs_core.shot_requirement_timeline_assembly import ShotRequirementTimelineAssemblyService
from aivs_core.timeline import TimelineService

TABLES = {
    "shot_requirement_timeline_batch_assembly_previews",
    "shot_requirement_timeline_batch_assembly_preview_items",
    "shot_requirement_timeline_batch_assemblies",
    "shot_requirement_timeline_batch_assembly_items",
}
TRIGGERS = {
    "stage6r_previews_validate_insert",
    "stage6r_previews_no_update",
    "stage6r_previews_no_delete",
    "stage6r_preview_items_validate_insert",
    "stage6r_preview_items_no_update",
    "stage6r_preview_items_no_delete",
    "stage6r_assemblies_validate_insert",
    "stage6r_assemblies_no_update",
    "stage6r_assemblies_no_delete",
    "stage6r_assembly_items_validate_insert",
    "stage6r_assembly_items_no_update",
    "stage6r_assembly_items_no_delete",
}


def _seed_v16(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module, "MIGRATIONS", {k: v for k, v in original.items() if k != "v17"}
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums



def test_v16_to_v17_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old = _seed_v16(path, monkeypatch)
    database = Database(path)
    database.initialize()
    assert database.last_backup is not None and database.last_backup.exists()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v17'")
        )
        assert history == old
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v17'").fetchone()[0]
            == hashlib.sha256(V17_SQL.encode()).hexdigest()
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_timeline_assemblies").fetchone()[0]
            == 0
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 24)}


def test_v17_objects_and_immutable_triggers_exist(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        objects = {row[0] for row in sql.execute("SELECT name FROM sqlite_master")}
    assert TABLES <= objects
    assert TRIGGERS <= objects


def test_v17_failure_rolls_back_append_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    _seed_v16(path, monkeypatch)
    broken = dict(database_module.MIGRATIONS)
    broken["v17"] = V17_SQL + "\nCREATE TABLE broken("
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(Exception):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute("SELECT 1 FROM schema_migrations WHERE version='v17'").fetchone() is None
        assert (
            sql.execute(
                "SELECT 1 FROM sqlite_master WHERE name=:name",
                {"name": "shot_requirement_timeline_batch_assembly_previews"},
            ).fetchone()
            is None
        )


def _seed_stage5_data(path: Path) -> dict[str, str]:
    database = Database(path)
    with database.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p','P','active','{}',NULL,?,'P','now','now','now')",
            (str(path.parent / "project"),),
        )
        sql.execute("INSERT INTO shot_lists VALUES ('sl','p',NULL,NULL,'now','now')")
        sql.execute(
            "INSERT INTO shot_list_revisions VALUES "
            "('shot-rev','sl','p',NULL,1,'Shot','PRIVATE_REQUIREMENT','sha256:shots','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirements VALUES "
            "('req','shot-rev',0,'Shot','PRIVATE_REQUIREMENT',2000000,'image',NULL,NULL,NULL)"
        )
        sql.execute(
            "UPDATE shot_lists SET current_revision_id='shot-rev',"
            "confirmed_revision_id='shot-rev' WHERE id='sl'"
        )
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) VALUES "
            "('image','p','image','managed','Generated','sha256:image',4,NULL,'available',"
            "'{\"width\": 1024, \"height\": 1024}','now','now')"
        )
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('config','p','apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image',"
            "'1','Local fixture','gpt-image-2',1,0.1,0.15,'CNY','now','now')"
        )
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,"
            "prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) VALUES "
            "('request','p','image','provider_image_v1','sha256:prompt','[]','{}',"
            "'sha256:request','now')"
        )
        sql.execute(
            "INSERT INTO provider_image_request_profiles VALUES "
            "('request','config','apikey_fun_images','apikey_fun_images_sse_v1',"
            "'image_text_to_image','1','gpt-image-2','apikey_fun_images_generations',"
            "'1024x1024','png','sha256:profile','sha256:payload','now','now')"
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,"
            "created_at,updated_at) VALUES "
            "('job','p','media_generation','media_generation','succeeded','completed',1,'{}',1,"
            "'now','now')"
        )
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at) "
            "VALUES ('task','request','job',1,'succeeded','completed','image','sha256:image','{}',"
            "'now','now','now')"
        )
        sql.execute(
            "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,"
            "provider_call_count,provider_may_have_processed,estimated_cost,"
            "estimated_cost_currency,price_tier,validated_format,validated_width,"
            "validated_height,validated_size_bytes,output_sha256,cleanup_required,created_at,"
            "finished_at,updated_at) VALUES "
            "('invocation','task','config','succeeded',1,1,0,'CNY','1K','png',1024,1024,4,"
            "'sha256:image',0,'now','now','now')"
        )
        sql.execute(
            "INSERT INTO generated_asset_provenance VALUES "
            "('provenance','image','request','task','invocation','sha256:prompt',"
            "'apikey_fun_images','apikey_fun_images_sse_v1','1','gpt-image-2','sha256:profile',"
            "'sha256:response','sha256:image','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_generation_links VALUES "
            "('link','p','shot-rev','req','request','sha256:requirement','now')"
        )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('adopt','p','shot-rev','req','link','task','image',1,NULL,'now')"
        )
    timeline = TimelineService(database)
    timeline.create(
        "p",
        {
            "schema_version": 1,
            "source": {"kind": "empty"},
            "default_layout": "fit",
            "caption_preset_id": "default-bottom",
        },
    )
    revision_id = timeline.get_state("p")["current_revision"]["timeline_revision_id"]
    service = ShotRequirementTimelineAssemblyService(database, timeline)
    prepared = service.prepare(
        "p",
        "req",
        {
            "expected_adoption_id": "adopt",
            "base_timeline_revision_id": revision_id,
            "at_index": 0,
            "duration_us": None,
            "layout": "fit",
        },
    )
    service.apply(
        "p",
        "req",
        {
            "assembly_preview_id": prepared["preview_id"],
            "proposed_document_sha256": prepared["proposed_document_sha256"],
            "confirmed": True,
        },
    )
    return {"preview_id": prepared["preview_id"]}


def test_v17_upgrade_preserves_existing_stage5_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "app.db"
    _seed_v16(path, monkeypatch)
    stage5 = _seed_stage5_data(path)
    with sqlite3.connect(path) as sql:
        previews_before = [
            tuple(row)
            for row in sql.execute(
                "SELECT * FROM shot_requirement_timeline_assembly_previews"
            )
        ]
        assemblies_before = [
            tuple(row)
            for row in sql.execute(
                "SELECT * FROM shot_requirement_timeline_assemblies"
            )
        ]
        timeline_revisions_before = [
            tuple(row)
            for row in sql.execute("SELECT * FROM timeline_revisions ORDER BY id")
        ]
        provider_calls_before = sql.execute(
            "SELECT COALESCE(SUM(provider_call_count),0) "
            "FROM provider_image_invocations"
        ).fetchone()[0]

    database = Database(path)
    database.initialize()

    with database.connection() as sql:
        assert [
            tuple(row)
            for row in sql.execute(
                "SELECT * FROM shot_requirement_timeline_assembly_previews"
            )
        ] == previews_before
        assert [
            tuple(row)
            for row in sql.execute("SELECT * FROM shot_requirement_timeline_assemblies")
        ] == assemblies_before
        assert [
            tuple(row)
            for row in sql.execute("SELECT * FROM timeline_revisions ORDER BY id")
        ] == timeline_revisions_before
        assert sql.execute(
            "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_previews"
        ).fetchone()[0] == 0
        assert sql.execute(
            "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_preview_items"
        ).fetchone()[0] == 0
        assert sql.execute(
            "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assemblies"
        ).fetchone()[0] == 0
        assert sql.execute(
            "SELECT COUNT(*) FROM shot_requirement_timeline_batch_assembly_items"
        ).fetchone()[0] == 0
        assert sql.execute(
            "SELECT provider_call_count FROM provider_image_invocations WHERE id='invocation'"
        ).fetchone()[0] == provider_calls_before
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v17'").fetchone()[0]
            == hashlib.sha256(V17_SQL.encode()).hexdigest()
        )
        assert stage5["preview_id"] == previews_before[0][0]