"""v43 迁移：让「配置行可删」与「审计行不可改写」共存（2026-11-09）。

**v42 的漏洞**：v42 把 13 张表改成 ON DELETE SET NULL，却没注意 5 张表上还有
`*_no_update` 不可变触发器。SET NULL 本身是一次 UPDATE，于是删除在运行期撞上：

    sqlite3.IntegrityError: egress previews are immutable

用户实测后果：xkiro 删得掉（只被 provider_invocations 引用，无触发器），
xkiro2 删不掉（被 egress_previews / captions_provider_egress_previews 引用）。
删除变成「看有没有被带触发器的表引用」的运气问题。

**v43 的做法**：把 no_update 触发器改写为「除非（provider_config_id 置空
且其余每列与 OLD 全等）否则拒绝」——窄到只放行删除外键时 SQLite 自己发出的
那一次 UPDATE。列清单逐列写出 `NEW.x IS OLD.x`（用 IS 而非 =，因为 NULL IS NULL
为真、NULL = NULL 为假）。

本文件锁三件事：
1. 每张「引用 provider_configs 且 SET NULL」的表，其 no_update 触发器必须带这个例外；
2. 篡改审计内容仍被拒（防线不能因为开例外而失效）；
3. 只允许置空，不允许把指针改指到另一个非 NULL 值。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database

PROVIDER_ID = "provider_under_test"


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "app.db")
    db.initialize()
    return db


def _referencing_tables_with_no_update(db: Database) -> list[str]:
    """schema 推导：引用 provider_configs 且 ON DELETE SET NULL、且带 no_update 触发器的表。"""
    out: list[str] = []
    with db.connection() as conn:
        for (table,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ):
            fks = [r for r in conn.execute(f"PRAGMA foreign_key_list({table})")
                   if r[2] == "provider_configs"]
            if not fks or fks[0][6] != "SET NULL":
                continue
            has_no_update = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master "
                "WHERE type='trigger' AND tbl_name=? AND name LIKE '%no_update%'",
                (table,),
            ).fetchone()[0]
            if has_no_update:
                out.append(table)
    return out


def test_every_immutable_preview_trigger_allows_only_null_pointer(tmp_path: Path) -> None:
    """回归锁：所有「SET NULL + no_update」的表都必须带置空例外。

    推导而非硬编码——将来若新增一张带 no_update 的引用表而忘了开例外，
    删除会在运行期撞「immutable」，且失败形态是脱敏的 “Core request failed”
    （Electron 侧看不到真实原因，本次排障就卡在这里）→ 本用例变红。
    """
    db = _db(tmp_path)
    tables = _referencing_tables_with_no_update(db)
    assert tables, "schema 中应至少有一张 SET NULL + no_update 的表"
    offenders: list[str] = []
    with db.connection() as conn:
        for table in tables:
            rows = list(conn.execute(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='trigger' AND tbl_name=? AND name LIKE '%no_update%'", (table,)))
            for name, sql in rows:
                normalized = " ".join((sql or "").split())
                # 例外必须同时出现「置空」与「逐列比对」两个特征
                if "NEW.provider_config_id IS NULL" not in normalized:
                    offenders.append(f"{table}.{name}: 缺少置空例外")
                elif "IS OLD." not in normalized:
                    offenders.append(f"{table}.{name}: 缺少逐列 IS OLD 比对")
    assert not offenders, f"这些不可变触发器没开置空例外：{offenders}"


def test_immutable_guards_still_reject_tampering(tmp_path: Path) -> None:
    """防线仍有效：开例外后，改写审计内容必须依然被拒。

    这条与上一条是一对——上一条防止「开得不够」，这条防止「开得过头」。
    """
    db = _db(tmp_path)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','p','active','{}','r','r','n','n','n')"
        )
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "input_price_per_million,output_price_per_million,created_at,updated_at)"
            " VALUES (?,'openai_compatible_text','p','https://x/v1','m',1,NULL,NULL,'n','n')",
            (PROVIDER_ID,),
        )
        conn.execute(
            "INSERT INTO recipe_snapshots(id,recipe_id,document_json,document_sha256,created_at)"
            " VALUES ('rs1','r1','{}','s','n')"
        )
        conn.execute(
            "INSERT INTO egress_previews(id,project_id,provider_config_id,brief_snapshot_json,"
            "brief_sha256,recipe_snapshot_id,provider_snapshot_json,provider_config_sha256,"
            "transcript_refs_json,segment_whitelist_json,payload_sha256,payload_json,stats_json,"
            "expires_at,created_at) VALUES ('e1','p1',?,'{}','s','rs1','{}','s','[]','[]',"
            "'sha256:orig','{}','{}','x','n')",
            (PROVIDER_ID,),
        )

        # 1) 改内容 -> 拒
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE egress_previews SET payload_sha256='hacked' WHERE id='e1'")
        # 2) 改指向到另一个非 NULL -> 拒（只允许置空，不允许改指）
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE egress_previews SET provider_config_id='provider_other' WHERE id='e1'")
        # 3) 置空的同时夹带篡改 -> 拒
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE egress_previews SET provider_config_id=NULL,payload_sha256='x' WHERE id='e1'")
        # 4) 只置空 -> 允许
        conn.execute("UPDATE egress_previews SET provider_config_id=NULL WHERE id='e1'")
        row = conn.execute(
            "SELECT provider_config_id,payload_sha256 FROM egress_previews WHERE id='e1'"
        ).fetchone()
    assert row["provider_config_id"] is None
    assert row["payload_sha256"] == "sha256:orig", "置空不得顺带改动其它列"


def test_delete_succeeds_when_immutable_tables_reference_provider(tmp_path: Path) -> None:
    """端到端：被「不可变审计表」引用时也能删——这正是用户遇到的 xkiro2 场景。

    v42 时代这条会抛 IntegrationError('egress previews are immutable')，
    在 Electron 里被脱敏成 “Core request failed”，用户只看到一个红条。
    """
    from aivs_core.planning import ProviderRepository
    from aivs_core.providers import ProviderSecretVault

    db = _db(tmp_path)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','p','active','{}','r','r','n','n','n')"
        )
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "input_price_per_million,output_price_per_million,created_at,updated_at)"
            " VALUES (?,'openai_compatible_text','要删的','https://x/v1','m',1,NULL,NULL,'n','n')",
            (PROVIDER_ID,),
        )
        conn.execute(
            "INSERT INTO recipe_snapshots(id,recipe_id,document_json,document_sha256,created_at)"
            " VALUES ('rs1','r1','{}','s','n')"
        )
        conn.execute(
            "INSERT INTO egress_previews(id,project_id,provider_config_id,brief_snapshot_json,"
            "brief_sha256,recipe_snapshot_id,provider_snapshot_json,provider_config_sha256,"
            "transcript_refs_json,segment_whitelist_json,payload_sha256,payload_json,stats_json,"
            "expires_at,created_at) VALUES ('e1','p1',?,'{}','s','rs1','{\"display_name\":\"要删的\"}',"
            "'s','[]','[]','sha256:x','{}','{}','x','n')",
            (PROVIDER_ID,),
        )

    repo = ProviderRepository(db, ProviderSecretVault())
    repo.delete(PROVIDER_ID)   # v42 时代这里抛 egress previews are immutable

    with db.connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM provider_configs WHERE id=?", (PROVIDER_ID,)
        ).fetchone()[0] == 0
        row = conn.execute(
            "SELECT provider_config_id,provider_snapshot_json FROM egress_previews WHERE id='e1'"
        ).fetchone()
    assert row is not None, "审计行必须保留"
    assert row["provider_config_id"] is None
    assert "要删的" in row["provider_snapshot_json"], "行内快照仍可追溯被删的 Provider"
