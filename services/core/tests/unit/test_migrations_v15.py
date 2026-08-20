# ruff: noqa: E501
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V15_SQL, Database, MigrationError


def _seed_v14(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {key: value for key, value in original.items() if key != "v15"},
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def _insert_project(sql: sqlite3.Connection, project_id: str) -> None:
    sql.execute(
        "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
        "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
        "VALUES (?,?, 'active','{}',NULL,?,?, 'now','now','now')",
        (project_id, project_id, f"root-{project_id}", project_id),
    )


def _insert_shot_list(
    sql: sqlite3.Connection, project_id: str, suffix: str, *, confirmed: bool = True
) -> tuple[str, str]:
    list_id, revision_id = f"sl-{suffix}", f"rev-{suffix}"
    sql.execute(
        "INSERT INTO shot_lists(id,project_id,current_revision_id,confirmed_revision_id,created_at,updated_at) "
        "VALUES (?,?,NULL,NULL,'now','now')",
        (list_id, project_id),
    )
    sql.execute(
        "INSERT INTO shot_list_revisions(id,shot_list_id,project_id,parent_revision_id,schema_version,"
        "title,summary,document_sha256,created_at) VALUES (?,?,?,NULL,1,?,'',?,'now')",
        (revision_id, list_id, project_id, suffix, f"sha256:document-{suffix}"),
    )
    sql.execute(
        "UPDATE shot_lists SET current_revision_id=?,confirmed_revision_id=?,updated_at='now' WHERE id=?",
        (revision_id, revision_id if confirmed else None, list_id),
    )
    return list_id, revision_id


def _insert_requirement(
    sql: sqlite3.Connection, requirement_id: str, revision_id: str, *, visual_kind: str = "image"
) -> None:
    source_asset_id = None
    if visual_kind == "existing_media":
        project_id = sql.execute(
            "SELECT project_id FROM shot_list_revisions WHERE id=?", (revision_id,)
        ).fetchone()[0]
        source_asset_id = f"source-{requirement_id}"
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
            "modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?, 'image','managed',?,?,1,NULL,'available','{}','now','now')",
            (source_asset_id, project_id, source_asset_id, f"sha256:{source_asset_id}"),
        )
    ordinal = sql.execute(
        "SELECT COUNT(*) FROM shot_requirements WHERE shot_list_revision_id=?", (revision_id,)
    ).fetchone()[0]
    sql.execute(
        "INSERT INTO shot_requirements(id,shot_list_revision_id,ordinal,title,visual_direction,"
        "target_duration_us,visual_kind,visual_source_asset_id,narration_kind,narration_text) "
        "VALUES (?,?,?,?,?,NULL,?,?,NULL,NULL)",
        (
            requirement_id,
            revision_id,
            ordinal,
            requirement_id,
            "direction",
            visual_kind,
            source_asset_id,
        ),
    )


def _insert_provider_request(
    sql: sqlite3.Connection,
    project_id: str,
    request_id: str,
    config_id: str,
    *,
    provider_kind: str = "apikey_fun_images",
) -> None:
    if (
        sql.execute("SELECT 1 FROM image_provider_configs WHERE id=?", (config_id,)).fetchone()
        is None
    ):
        if provider_kind == "apikey_fun_images":
            sql.execute(
                "INSERT INTO image_provider_configs(id,project_id,provider_kind,adapter_id,capability,"
                "protocol_version,display_name,model,enabled,price_per_image,price_2k_per_image,"
                "price_currency,created_at,updated_at) VALUES "
                "(?,?,?,'apikey_fun_images_sse_v1','image_text_to_image','1','APIKEY.FUN',"
                "'gpt-image-2',1,0.1,0.15,'CNY','now','now')",
                (config_id, project_id, provider_kind),
            )
        else:
            sql.execute(
                "INSERT INTO image_provider_configs(id,project_id,provider_kind,adapter_id,capability,"
                "protocol_version,display_name,model,enabled,price_per_image,price_2k_per_image,"
                "price_currency,created_at,updated_at) VALUES "
                "(?,?,?,'openai_images_generations_v1','image_text_to_image','1','OpenAI',"
                "'gpt-image-1',1,0.1,NULL,NULL,'now','now')",
                (config_id, project_id, provider_kind),
            )
    sql.execute(
        "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,prompt_sha256,"
        "input_refs_json,parameters_json,request_sha256,created_at) "
        "VALUES (?,?,'image','provider_image_v1','sha256:prompt','[]','{}',?,'now')",
        (request_id, project_id, f"sha256:{request_id}"),
    )
    if provider_kind == "apikey_fun_images":
        profile = (
            request_id,
            config_id,
            provider_kind,
            "apikey_fun_images_sse_v1",
            "image_text_to_image",
            "1",
            "gpt-image-2",
            "apikey_fun_images_generations",
            "1024x1024",
            "png",
            "sha256:profile",
            f"sha256:payload-{request_id}",
            "now",
            "now",
        )
    else:
        profile = (
            request_id,
            config_id,
            provider_kind,
            "openai_images_generations_v1",
            "image_text_to_image",
            "1",
            "gpt-image-1",
            "openai_images_generations",
            "1024x1024",
            "png",
            "sha256:profile",
            f"sha256:payload-{request_id}",
            "now",
            "now",
        )
    sql.execute(
        "INSERT INTO provider_image_request_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", profile
    )


def _insert_succeeded_output(
    sql: sqlite3.Connection,
    project_id: str,
    request_id: str,
    config_id: str,
    suffix: str,
    *,
    availability: str = "available",
) -> tuple[str, str]:
    job_id, task_id, asset_id, invocation_id = (
        f"job-{suffix}",
        f"task-{suffix}",
        f"asset-{suffix}",
        f"inv-{suffix}",
    )
    attempt = sql.execute(
        "SELECT COALESCE(MAX(attempt),0)+1 FROM media_generation_tasks WHERE request_id=?",
        (request_id,),
    ).fetchone()[0]
    sql.execute(
        "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,created_at,updated_at) "
        "VALUES (?,?,'media_generation','media_generation','succeeded','completed',1,'{}',?,'now','now')",
        (job_id, project_id, attempt),
    )
    sql.execute(
        "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,modified_at,"
        "availability,media_info_json,created_at,updated_at) VALUES "
        "(?,?,'image','managed',?,?,4,NULL,?,'{}','now','now')",
        (asset_id, project_id, asset_id, f"sha256:output-{suffix}", availability),
    )
    sql.execute(
        "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,output_asset_id,"
        "output_sha256,result_summary_json,created_at,updated_at,finished_at) "
        "VALUES (?,?,?,?,'succeeded','completed',? ,?,'{}','now','now','now')",
        (task_id, request_id, job_id, attempt, asset_id, f"sha256:output-{suffix}"),
    )
    sql.execute(
        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,provider_call_count,"
        "provider_may_have_processed,estimated_cost,estimated_cost_currency,price_tier,validated_format,"
        "validated_width,validated_height,validated_size_bytes,output_sha256,cleanup_required,created_at,"
        "finished_at,updated_at) VALUES "
        "(?,?,?,'succeeded',1,1,0.1,'CNY','1K','png',1024,1024,4,?,0,'now','now','now')",
        (invocation_id, task_id, config_id, f"sha256:output-{suffix}"),
    )
    sql.execute(
        "INSERT INTO generated_asset_provenance(id,asset_id,request_id,task_id,invocation_id,prompt_sha256,"
        "provider_kind,adapter_id,protocol_version,model,provider_profile_sha256,provider_response_sha256,"
        "output_sha256,created_at) VALUES (?,?,?,?,?,'sha256:prompt','apikey_fun_images',"
        "'apikey_fun_images_sse_v1','1','gpt-image-2','sha256:profile','sha256:response',?,'now')",
        (
            f"provenance-{suffix}",
            asset_id,
            request_id,
            task_id,
            invocation_id,
            f"sha256:output-{suffix}",
        ),
    )
    return task_id, asset_id


def _domain(sql: sqlite3.Connection) -> dict[str, str]:
    _insert_project(sql, "p")
    _insert_project(sql, "p2")
    list_id, revision_id = _insert_shot_list(sql, "p", "current")
    historical_revision_id = "rev-historical"
    sql.execute(
        "INSERT INTO shot_list_revisions(id,shot_list_id,project_id,parent_revision_id,schema_version,"
        "title,summary,document_sha256,created_at) VALUES (?,?,?,NULL,1,'historical','',"
        "'sha256:document-historical','now')",
        (historical_revision_id, list_id, "p"),
    )
    _, other_revision_id = _insert_shot_list(sql, "p2", "other")
    _insert_requirement(sql, "req", revision_id)
    _insert_requirement(sql, "req-historical", historical_revision_id)
    _insert_requirement(sql, "req-existing", revision_id, visual_kind="existing_media")
    _insert_requirement(sql, "req-other", other_revision_id)
    _insert_provider_request(sql, "p", "request", "config")
    _insert_provider_request(
        sql, "p", "request-openai", "config-openai", provider_kind="openai_images"
    )
    _insert_provider_request(sql, "p2", "request-other", "config-other")
    return {
        "revision": revision_id,
        "historical_revision": historical_revision_id,
        "other_revision": other_revision_id,
    }


def _insert_link(
    sql: sqlite3.Connection,
    link_id: str,
    project_id: str,
    revision_id: str,
    requirement_id: str,
    request_id: str,
) -> None:
    sql.execute(
        "INSERT INTO shot_requirement_image_generation_links(id,project_id,shot_list_revision_id,"
        "shot_requirement_id,request_id,requirement_sha256,created_at) VALUES (?,?,?,?,?,?,'now')",
        (link_id, project_id, revision_id, requirement_id, request_id, "sha256:requirement"),
    )


def test_fresh_database_has_all_versions_schema_and_integrity(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        assert {row[0] for row in sql.execute("SELECT version FROM schema_migrations")} == {
            f"v{i}" for i in range(1, 17)
        }
        objects = {row[0] for row in sql.execute("SELECT name FROM sqlite_master")}
        assert {
            "shot_requirement_image_generation_links",
            "shot_requirement_image_adoptions",
            "shot_requirement_image_links_validate_insert",
            "shot_requirement_image_adoptions_validate_insert",
            "shot_requirement_image_links_no_update",
            "shot_requirement_image_links_no_delete",
            "shot_requirement_image_adoptions_no_update",
            "shot_requirement_image_adoptions_no_delete",
        } <= objects
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[
                0
            ]
            == 0
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0] == 0
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 17)}


def test_v14_to_v15_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old_checksums = _seed_v14(path, monkeypatch)
    database = Database(path)
    database.initialize()
    assert database.last_backup is not None and database.last_backup.exists()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v15'")
        )
        assert history == old_checksums
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v15'").fetchone()[0]
            == hashlib.sha256(V15_SQL.encode()).hexdigest()
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[
                0
            ]
            == 0
        )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0] == 0
        )


def test_v15_link_validation_and_immutability(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        domain = _domain(sql)
        _insert_link(sql, "link", "p", domain["revision"], "req", "request")
        with pytest.raises(sqlite3.IntegrityError):
            _insert_link(
                sql, "bad-history", "p", domain["historical_revision"], "req-historical", "request"
            )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_link(sql, "bad-kind", "p", domain["revision"], "req-existing", "request")
        with pytest.raises(sqlite3.IntegrityError):
            _insert_link(sql, "bad-profile", "p", domain["revision"], "req", "request-openai")
        with pytest.raises(sqlite3.IntegrityError):
            _insert_link(sql, "bad-project", "p", domain["revision"], "req", "request-other")
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "UPDATE shot_requirement_image_generation_links SET created_at='later' WHERE id='link'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("DELETE FROM shot_requirement_image_generation_links WHERE id='link'")
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_generation_links").fetchone()[
                0
            ]
            == 1
        )


def test_v15_adoption_validation_chain_and_immutability(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        domain = _domain(sql)
        _insert_link(sql, "link", "p", domain["revision"], "req", "request")
        task1, asset1 = _insert_succeeded_output(sql, "p", "request", "config", "one")
        task2, asset2 = _insert_succeeded_output(sql, "p", "request", "config", "two")
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('adopt-1','p',?,'req','link',?,?,1,NULL,'now')",
            (domain["revision"], task1, asset1),
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES "
                "('bad-gap','p',?,'req','link',?,?,3,'adopt-1','now')",
                (domain["revision"], task2, asset2),
            )
        sql.execute(
            "INSERT INTO shot_requirement_image_adoptions VALUES "
            "('adopt-2','p',?,'req','link',?,?,2,'adopt-1','now')",
            (domain["revision"], task2, asset2),
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "UPDATE shot_requirement_image_adoptions SET created_at='later' WHERE id='adopt-2'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("DELETE FROM shot_requirement_image_adoptions WHERE id='adopt-2'")
        assert [
            tuple(row)
            for row in sql.execute(
                "SELECT id,adoption_ordinal,previous_adoption_id FROM shot_requirement_image_adoptions ORDER BY adoption_ordinal"
            )
        ] == [("adopt-1", 1, None), ("adopt-2", 2, "adopt-1")]


def test_v15_adoption_rejects_historical_revision(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        domain = _domain(sql)
        _insert_link(sql, "link", "p", domain["revision"], "req", "request")
        task_id, asset_id = _insert_succeeded_output(sql, "p", "request", "config", "historical")
        sql.execute(
            "UPDATE shot_lists SET confirmed_revision_id=? WHERE id='sl-current'",
            (domain["historical_revision"],),
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES "
                "('bad-history','p',?,'req','link',?,?,1,NULL,'now')",
                (domain["revision"], task_id, asset_id),
            )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0] == 0
        )


def test_v15_adoption_rejects_unavailable_or_cross_request_output(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        domain = _domain(sql)
        _insert_link(sql, "link", "p", domain["revision"], "req", "request")
        _, unavailable_asset = _insert_succeeded_output(
            sql, "p", "request", "config", "unavailable", availability="missing"
        )
        unavailable_task = "task-unavailable"
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES "
                "('bad-unavailable','p',?,'req','link',?,?,1,NULL,'now')",
                (domain["revision"], unavailable_task, unavailable_asset),
            )
        other_task, other_asset = _insert_succeeded_output(
            sql, "p2", "request-other", "config-other", "other"
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO shot_requirement_image_adoptions VALUES "
                "('bad-cross','p',?,'req','link',?,?,1,NULL,'now')",
                (domain["revision"], other_task, other_asset),
            )
        assert (
            sql.execute("SELECT COUNT(*) FROM shot_requirement_image_adoptions").fetchone()[0] == 0
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_v15_failure_rolls_back_append_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    _seed_v14(path, monkeypatch)
    broken = V15_SQL.replace(
        "CREATE TABLE shot_requirement_image_generation_links (",
        "CREATE TABLE shot_requirement_image_generation_links ( broken TEXT CHECK(,",
        1,
    )
    monkeypatch.setitem(database_module.MIGRATIONS, "v15", broken)
    with pytest.raises(MigrationError):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute("SELECT 1 FROM schema_migrations WHERE version='v15'").fetchone() is None
        assert (
            sql.execute(
                "SELECT 1 FROM sqlite_master WHERE name='shot_requirement_image_generation_links'"
            ).fetchone()
            is None
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
