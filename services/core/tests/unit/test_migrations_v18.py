# ruff: noqa: E501
"""B10 v18 迁移测试：derived_media_cache 表与引用映射（计划第 6 节 B10）。

要求（PERFORMANCE_IMPLEMENTATION_PLAN B10）：
- 追加式：v17 → v18 只新增对象，不改不删旧结构；旧校验和不变。
- 派生项类别受 CHECK 枚举约束（video_proxy/waveform/audio_pcm_chunk/reverse_chunk）。
- 引用映射（cache_key, project_id, asset_id）授权由"asset 属于该 project 且
  project active"触发器强制——知道 cache_key 不能凭空获得引用。
- building 残留在启动恢复时处理（服务层测试覆盖），迁移本身只建表。
"""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V18_SQL, Database

TABLES = {
    "derived_media_cache",
    "derived_media_cache_refs",
}
TRIGGERS = {
    "derived_media_cache_refs_validate_insert",
}


def _seed_v17(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module, "MIGRATIONS", {k: v for k, v in original.items() if k != "v18"}
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def _seed_project_asset(path: Path) -> None:
    """最小 project + asset 行，供引用映射触发器验证归属。"""
    database = Database(path)
    with database.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','n','active','{}',"
            "'/tmp','t','now','now','now')"
        )
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','m.mp4','sha256:aa',1,NULL,"
            "'available','now','now')"
        )


def _insert_cache_entry(path: Path, cache_key: str = "sha256:" + "b" * 64,
                        status: str = "ready") -> None:
    database = Database(path)
    with database.connection() as sql:
        sql.execute(
            "INSERT INTO derived_media_cache(cache_key,asset_fingerprint,kind,params_json,"
            "schema_version,toolchain_fingerprint,relative_path,size_bytes,status,"
            "created_at,last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (cache_key, "sha256:" + "a" * 64, "video_proxy", "{}", 1, "ffmpeg-n8",
             "cache/derived/video_proxy/bb/key", 1024, status, "now", "now"),
        )


def test_v17_to_v18_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old = _seed_v17(path, monkeypatch)
    database = Database(path)
    database.initialize()
    assert database.last_backup is not None and database.last_backup.exists()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v18'")
        )
        assert history == old
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v18'").fetchone()[0]
            == hashlib.sha256(V18_SQL.encode()).hexdigest()
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert set(MIGRATIONS) == {f"v{i}" for i in range(1, 27)}


def test_v18_objects_exist(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        objects = {row[0] for row in sql.execute("SELECT name FROM sqlite_master")}
    assert TABLES <= objects
    assert TRIGGERS <= objects


def test_v18_rejects_unknown_derived_kind_and_bad_key_format(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO derived_media_cache(cache_key,asset_fingerprint,kind,params_json,"
                "schema_version,toolchain_fingerprint,relative_path,size_bytes,status,"
                "created_at,last_accessed_at) VALUES ('not-a-key','sha256:aa','bogus_kind',"
                "'{}',1,'tc','p',1,'ready','now','now')"
            )
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO derived_media_cache(cache_key,asset_fingerprint,kind,params_json,"
                "schema_version,toolchain_fingerprint,relative_path,size_bytes,status,"
                "created_at,last_accessed_at) VALUES ('no-prefix','sha256:aa','waveform',"
                "'{}',1,'tc','p',1,'ready','now','now')"
            )


def test_v18_ref_requires_asset_in_active_project(tmp_path: Path) -> None:
    path = tmp_path / "app.db"
    Database(path).initialize()
    _seed_project_asset(path)
    _insert_cache_entry(path)
    database = Database(path)
    with database.connection() as sql:
        # 合法引用：asset a1 属于 project p1
        sql.execute(
            "INSERT INTO derived_media_cache_refs(cache_key,project_id,asset_id,"
            "created_at,last_accessed_at) VALUES ((SELECT cache_key FROM derived_media_cache),"
            "'p1','a1','now','now')"
        )
        # 越权：asset 不在该 project（伪造 project_id）
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute(
                "INSERT INTO derived_media_cache_refs(cache_key,project_id,asset_id,"
                "created_at,last_accessed_at) VALUES ((SELECT cache_key FROM derived_media_cache),"
                "'p1','missing-asset','now','now')"
            )
        # 引用行级联删除：删除 cache 行时引用随之消失（授权不残留）
        sql.execute("DELETE FROM derived_media_cache WHERE 1")
        assert sql.execute("SELECT COUNT(*) FROM derived_media_cache_refs").fetchone()[0] == 0


def test_v18_failure_rolls_back_append_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import aivs_core.database as database_module

    path = tmp_path / "app.db"
    _seed_v17(path, monkeypatch)
    broken = dict(database_module.MIGRATIONS)
    broken["v18"] = V18_SQL + "\nCREATE TABLE broken("
    monkeypatch.setattr(database_module, "MIGRATIONS", broken)
    with pytest.raises(Exception):
        Database(path).initialize()
    with sqlite3.connect(path) as sql:
        assert sql.execute("SELECT 1 FROM schema_migrations WHERE version='v18'").fetchone() is None
        assert (
            sql.execute(
                "SELECT 1 FROM sqlite_master WHERE name='derived_media_cache'"
            ).fetchone()
            is None
        )
