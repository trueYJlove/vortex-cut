"""v42 迁移：Provider 可删（2026-11-09 用户裁决）。

背景：用户实测「停用之后依然无法删除」，并指出「我用的所有软件添加的 provider
都是可以删除的」。真实库确诊根因**不是**业务拦截，而是表结构：

    DELETE FROM provider_configs ->
      sqlite3.IntegrityError: NOT NULL constraint failed:
        provider_invocations.provider_config_id

即 ProviderRepository.delete() 里的 PROVIDER_IN_USE 只是第二道拦截，
第一道是 13 张审计表的 provider_config_id 全为 NOT NULL + NO ACTION。

v42 把它们改为可空 + ON DELETE SET NULL，删除只把指针置空、审计行原样保留。
审计行自带身份（provider_invocations 的 provider_name/model；
*_egress_previews 的 provider_snapshot_json），故追溯能力不受影响。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database, V42_SQL

# 迁移必须覆盖到的 13 张表：删 Provider 时靠它们把指针置空。
EXPECTED_TABLES = [
    "agent_session_egress_previews",
    "agent_sessions",
    "asset_frame_tags",
    "candidate_generations",
    "captions_provider_egress_previews",
    "captions_provider_generations",
    "egress_previews",
    "keyframe_egress_previews",
    "keyframe_generations",
    "provider_invocations",
    "timeline_patch_egress_previews",
    "timeline_patch_generations",
    "timeline_patch_proposals",
]


def _db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "app.db")
    db.initialize()
    return db


def test_v42_covers_every_provider_referencing_table(tmp_path: Path) -> None:
    """schema 推导：任何引用 provider_configs 的表都必须是 SET NULL。

    从 sqlite_master/PRAGMA 推导而非硬编码对拍（P45 教训：硬编码会腐烂）。
    未来迁移新增引用表却忘了 ON DELETE SET NULL → 删除在运行期撞裸 FK，
    失败形态变成 500 / 误导文案（P67 / P102 同族）→ 本用例变红。
    """
    db = _db(tmp_path)
    with db.connection() as conn:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )]
        offenders = {}
        checked = []
        for name in tables:
            fks = [r for r in conn.execute(f"PRAGMA foreign_key_list({name})")
                   if r[2] == "provider_configs"]
            if not fks:
                continue
            checked.append(name)
            if fks[0][6] != "SET NULL":
                offenders[name] = fks[0][6]
    assert not offenders, f"这些表未改为 ON DELETE SET NULL：{offenders}"
    missing = set(EXPECTED_TABLES) - set(checked)
    assert not missing, f"预期覆盖的表在 schema 中不存在：{sorted(missing)}"


def test_v42_columns_are_nullable(tmp_path: Path) -> None:
    """ON DELETE SET NULL 要求列可空；NOT NULL 会让 SET NULL 直接失败。"""
    db = _db(tmp_path)
    with db.connection() as conn:
        for table in EXPECTED_TABLES:
            cols = [r for r in conn.execute(f"PRAGMA table_info({table})")
                    if r[1] == "provider_config_id"]
            assert cols, f"{table} 缺 provider_config_id 列"
            assert cols[0][3] == 0, f"{table}.provider_config_id 仍是 NOT NULL"


def test_v42_preserves_rows_and_triggers(tmp_path: Path) -> None:
    """重建表不得丢行、不得丢不可变触发器。

    不可变触发器保护的是「审计行不可改写」——这正是不能用「删除引用行」
    换取「配置行可删」的原因。重建若不慎丢掉它们，等于悄悄开后门。
    """
    db = _db(tmp_path)
    with db.connection() as conn:
        # 逐表插最小行，确认列对齐没有错位（SELECT * 搬迁最易错位的地方）
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','p','active','{}','r','r','n','n','n')"
        )
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "input_price_per_million,output_price_per_million,created_at,updated_at)"
            " VALUES ('pc1','openai_compatible_text','p','https://x/v1','m',1,NULL,NULL,'n','n')"
        )
        conn.execute(
            "INSERT INTO provider_invocations"
            "(id,provider_config_id,capability,provider_name,model,prompt_template_version,"
            "output_schema_version,input_sha256,status,created_at)"
            " VALUES ('i1','pc1','cap','p','m','1','1',?,'succeeded','n')",
            ("sha256:" + "a" * 64,),
        )
        # 行数未变（重建用 SELECT 搬迁，列序错位就会在这里或下面的读回暴露）
        assert conn.execute(
            "SELECT COUNT(*) FROM provider_invocations"
        ).fetchone()[0] == 1
        # 有触发器的表：重建后必须仍有同样多的触发器。
        # 期望值从**迁移文本**推导（V42_SQL 里每张表应重建几条 CREATE TRIGGER），
        # 而不是另写一份硬编码清单——本用例第一版就是靠手写清单，结果连
        # timeline_patch_generations 有没有触发器都记错了。清单会腐烂，推导不会。
        for table in EXPECTED_TABLES:
            actual = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
                (table,),
            ).fetchone()[0]
            # 迁移文本中，该表重建段落里出现的 CREATE TRIGGER 数量
            block_start = V42_SQL.index(f"CREATE TABLE {table}_v42")
            next_table = V42_SQL.find("CREATE TABLE ", block_start + 10)
            segment = V42_SQL[block_start: next_table if next_table != -1 else len(V42_SQL)]
            expected = segment.count("CREATE TRIGGER")
            assert actual == expected, (
                f"{table} 重建后触发器 {actual} 条，迁移文本声明 {expected} 条——"
                "不可变触发器若在重建中丢失，等于悄悄给审计行开后门"
            )
        # 抽查一张带触发器的表：改它必须被拒（证明触发的是真实规则，不是空壳）
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p2','p2','active','{}','r','r','n','n','n')"
        )
        conn.execute(
            "INSERT INTO recipe_snapshots(id,recipe_id,document_json,document_sha256,created_at)"
            " VALUES ('rs1','r1','{}','s','n')"
        )
        conn.execute(
            "INSERT INTO egress_previews(id,project_id,provider_config_id,brief_snapshot_json,"
            "brief_sha256,recipe_snapshot_id,provider_snapshot_json,provider_config_sha256,"
            "transcript_refs_json,segment_whitelist_json,payload_sha256,payload_json,stats_json,"
            "expires_at,created_at) VALUES ('e1','p2','pc1','{}','s','rs1','{}','s','[]','[]','s','{}','{}','x','n')",
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE egress_previews SET payload_sha256='tampered' WHERE id='e1'")


def test_v42_delete_nullifies_pointer_but_keeps_audit_row(tmp_path: Path) -> None:
    """端到端：删 Provider 后审计行仍在、指针为空、身份快照可读。"""
    db = _db(tmp_path)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES ('p1','p','active','{}','r','r','n','n','n')"
        )
        conn.execute(
            "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,"
            "input_price_per_million,output_price_per_million,created_at,updated_at)"
            " VALUES ('pc1','openai_compatible_text','出问题的那个','https://x/v1','m',1,NULL,NULL,'n','n')"
        )
        conn.execute(
            "INSERT INTO provider_invocations"
            "(id,provider_config_id,capability,provider_name,model,prompt_template_version,"
            "output_schema_version,input_sha256,status,created_at)"
            " VALUES ('i1','pc1','cap','快照里的名字','快照里的模型','1','1',?,'failed','n')",
            ("sha256:" + "a" * 64,),
        )
        conn.execute("DELETE FROM provider_configs WHERE id='pc1'")
        row = conn.execute(
            "SELECT provider_config_id,provider_name,model FROM provider_invocations WHERE id='i1'"
        ).fetchone()
    assert row is not None, "删除 Provider 不得连带删除审计行"
    assert row["provider_config_id"] is None
    assert row["provider_name"] == "快照里的名字"
    assert row["model"] == "快照里的模型"


def test_v42_sql_declares_set_null_for_all_tables() -> None:
    """纯文本锁：V42_SQL 里每张表都必须出现 SET NULL。

    与 schema 推导锁互补——那条验的是「跑完迁移后的状态」，
    这条验的是「迁移文本本身」（防止有人改了迁移却因库已迁移而测试仍绿）。
    """
    for table in EXPECTED_TABLES:
        assert f"CREATE TABLE {table}_v42" in V42_SQL, f"{table} 缺少重建语句"
    assert V42_SQL.count("ON DELETE SET NULL") == len(EXPECTED_TABLES)
