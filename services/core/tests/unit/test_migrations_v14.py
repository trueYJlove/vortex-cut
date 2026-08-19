from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V13_SQL, V14_SQL, Database, MigrationError


def _seed_v13(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        {key: value for key, value in original.items() if key != "v14"},
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        sql.executescript(
            """
            INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,
              root_dir,root_dir_name,created_at,updated_at,last_opened_at)
            VALUES ('p','P','active','{}',NULL,'root','root','n','n','n');
            INSERT INTO media_generation_requests VALUES
              ('r','p','image','provider_image_v1','sha256:prompt','[]','{}','sha256:request','n');
            INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,attempt,
              created_at,updated_at) VALUES
              ('j','p','media_generation','media_generation','succeeded','completed',1,'{}',1,'n','n');
            INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,
              output_asset_id,output_sha256,result_summary_json,created_at,updated_at,finished_at)
            VALUES ('t','r','j',1,'succeeded','completed','a','sha256:output','{}','n','n','n');
            INSERT INTO assets VALUES
              ('a','p','image','managed','Generated','sha256:output',4,NULL,'available','{}','n','n');
            INSERT INTO image_provider_configs VALUES
              ('c','p','openai_images','openai_images_generations_v1','image_text_to_image','1',
               'Historical OpenAI','gpt-image-1',1,0.25,'n','n');
            INSERT INTO provider_image_request_profiles VALUES
              ('r','c','openai_images','openai_images_generations_v1','image_text_to_image','1',
               'gpt-image-1','openai_images_generations','1024x1024','png','sha256:profile',
               'sha256:payload','n','n');
            INSERT INTO provider_image_invocations VALUES
              ('i','t','c','succeeded',1,1,'safe-request','{}',0.25,'sha256:response','png',
               1024,1024,4,'sha256:output',NULL,NULL,0,NULL,'n','n','n','n');
            INSERT INTO generated_asset_provenance VALUES
              ('gp','a','r','t','i','sha256:prompt','openai_images',
               'openai_images_generations_v1','1','gpt-image-1','sha256:profile',
               'sha256:response','sha256:output','n');
            """
        )
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def test_v14_fresh_database_has_all_versions_and_integrity(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        versions = [row[0] for row in sql.execute("SELECT version FROM schema_migrations")]
        assert set(versions) == {f"v{i}" for i in range(1, 15)}
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        config_columns = {
            row[1] for row in sql.execute("PRAGMA table_info(image_provider_configs)")
        }
        invocation_columns = {
            row[1] for row in sql.execute("PRAGMA table_info(provider_image_invocations)")
        }
        assert {"price_2k_per_image", "price_currency"} <= config_columns
        assert {"estimated_cost_currency", "price_tier"} <= invocation_columns
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 15)}


def test_v13_to_v14_preserves_official_history_checksums_and_adds_strict_third_party(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old_checksums = _seed_v13(path, monkeypatch)
    upgraded = Database(path)
    upgraded.initialize()
    assert upgraded.last_backup is not None and upgraded.last_backup.exists()

    with upgraded.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v14'")
        )
        assert history == old_checksums
        assert history["v13"] == hashlib.sha256(V13_SQL.encode()).hexdigest()
        assert sql.execute(
            "SELECT checksum FROM schema_migrations WHERE version='v14'"
        ).fetchone()[0] == hashlib.sha256(V14_SQL.encode()).hexdigest()
        config = sql.execute("SELECT * FROM image_provider_configs WHERE id='c'").fetchone()
        assert (config["provider_kind"], config["model"], config["price_per_image"]) == (
            "openai_images",
            "gpt-image-1",
            0.25,
        )
        assert config["price_2k_per_image"] is None and config["price_currency"] is None
        invocation = sql.execute(
            "SELECT estimated_cost,estimated_cost_currency,price_tier "
            "FROM provider_image_invocations"
        ).fetchone()
        assert tuple(invocation) == (0.25, None, None)
        provenance = sql.execute(
            "SELECT provider_kind,adapter_id,model FROM generated_asset_provenance"
        ).fetchone()
        assert tuple(provenance) == (
            "openai_images",
            "openai_images_generations_v1",
            "gpt-image-1",
        )
        sql.execute(
            "INSERT INTO image_provider_configs VALUES "
            "('c2','p','apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image',"
            "'1','APIKEY.FUN','gpt-image-2',1,0.1,0.15,'CNY','n','n')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO image_provider_configs VALUES "
                "('bad','p','apikey_fun_images','apikey_fun_images_sse_v1','image_text_to_image',"
                "'1','Bad','gpt-image-2',1,0.2,0.15,'CNY','n','n')"
            )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO provider_image_request_profiles VALUES "
                "('bad-request','c2','apikey_fun_images','apikey_fun_images_sse_v1',"
                "'image_text_to_image','1','gpt-image-2','apikey_fun_images_generations',"
                "'1024x1536','png','sha256:p','sha256:x','n','n')"
            )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_v14_failure_rolls_back_rebuild(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    _seed_v13(path, monkeypatch)
    original = database_module.V14_SQL
    broken = original.replace(
        "CREATE TABLE image_provider_configs_v14 (",
        "CREATE TABLE image_provider_configs_v14 (\n  broken TEXT CHECK(,",
    )
    monkeypatch.setitem(database_module.MIGRATIONS, "v14", broken)
    with pytest.raises(MigrationError):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute(
            "SELECT 1 FROM schema_migrations WHERE version='v14'"
        ).fetchone() is None
        assert sql.execute("SELECT provider_kind FROM image_provider_configs").fetchone()[0] == (
            "openai_images"
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
