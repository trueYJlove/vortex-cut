"""Provider 配置删除（P67 2026-10-09 → v42 2026-11-09 语义变更）。

**v42 起删除不再被历史引用拦截。** 用户裁决（2026-11-09）：

    不能删除无论如何都是有问题的，我用的所有软件添加的 provider 都是可以删除的。

旧语义（本文件曾锁定）：被任一外发/生成/调用审计表引用 → fail-closed
PROVIDER_IN_USE，出路是「删密钥 + 停用」。该语义被**推翻**，因为它把
「审计行不可改写」误当成「配置行不可删除」，而审计行其实自带身份：

  * provider_invocations 自带 provider_name / model；
  * *_egress_previews 自带 provider_snapshot_json / provider_config_sha256。

真实库实测 28 条历史行 **0 行缺身份**。v42 把 13 张表的 provider_config_id
改为可空 + ON DELETE SET NULL，删除只把指针置空、行内字段一个不动，
故「谁在何时把什么发给了哪个模型、花了多少钱」依然可查。

**本文件现在的职责**：
1. 锁住新语义——有引用也能删，且删完审计行仍在、身份快照仍可读；
2. 锁住 v42 迁移的覆盖面——schema 里每张含 provider_config_id 的表都必须
   是 ON DELETE SET NULL，否则删除会在运行期撞裸 FK（本仓 P67/P102 同族）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.planning import ProviderRepository
from aivs_core.projects import DomainError
from aivs_core.providers import ProviderSecretVault


def _repo(tmp_path: Path) -> tuple[ProviderRepository, Database, ProviderSecretVault]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "p", "active", "{}", "r", "r", "n", "n", "n"),
        )
    vault = ProviderSecretVault()
    repo = ProviderRepository(db, vault)
    return repo, db, vault


def _seed(repo: ProviderRepository, vault: ProviderSecretVault, name: str = "p") -> str:
    provider = repo.create(
        {
            "kind": "openai_compatible_text",
            "display_name": name,
            "base_url": "https://provider.example/v1",
            "model": "m",
            "enabled": True,
        }
    )
    provider_id = provider["provider_config_id"]
    vault.set(provider_id, "SECRET")
    return provider_id


def test_delete_removes_row_and_vault_entry(tmp_path: Path) -> None:
    repo, db, vault = _repo(tmp_path)
    provider_id = _seed(repo, vault)
    assert vault.status(provider_id) == "configured"

    repo.delete(provider_id)

    assert vault.status(provider_id) == "missing"
    with db.connection() as conn:
        row = conn.execute(
            "SELECT id FROM provider_configs WHERE id=?", (provider_id,)
        ).fetchone()
    assert row is None
    with pytest.raises(DomainError) as raised:
        repo.get(provider_id)
    assert raised.value.code == "PROVIDER_NOT_FOUND"


def test_delete_succeeds_when_referenced_by_invocation(tmp_path: Path) -> None:
    """被 provider_invocations 引用**仍可删除**，且审计行原样保留。

    这是 v42 推翻的核心行为。用例三重断言，缺一不可：
      · 删除本身成功（用户诉求）；
      · 审计行数不变（一条都不能少）；
      · 指针置空后 identity 快照仍可读（审计链未断）。
    """
    repo, db, vault = _repo(tmp_path)
    provider_id = _seed(repo, vault)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO provider_invocations"
            "(id,provider_config_id,capability,provider_name,model,"
            "prompt_template_version,output_schema_version,input_sha256,status,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,'n')",
            ("inv_1", provider_id, "cap", "审计用名称", "audit-model", "1", "1",
             "sha256:" + "a" * 64, "succeeded"),
        )
        before = conn.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0]

    repo.delete(provider_id)

    with db.connection() as conn:
        after = conn.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[0]
        row = conn.execute(
            "SELECT provider_config_id,provider_name,model FROM provider_invocations WHERE id='inv_1'"
        ).fetchone()
    assert after == before, "删除 Provider 不得连带删除审计行"
    assert row["provider_config_id"] is None, "外键应被 ON DELETE SET NULL 置空"
    assert row["provider_name"] == "审计用名称"
    assert row["model"] == "audit-model"
    assert vault.status(provider_id) == "missing"


def test_all_provider_referencing_tables_use_set_null(tmp_path: Path) -> None:
    """回归锁：schema 中每张含 provider_config_id 且外键指向 provider_configs 的表，
    都必须是 ON DELETE SET NULL。

    从 sqlite_master / PRAGMA 推导而非硬编码对拍（P45 教训：硬编码清单会腐烂）。
    未来迁移若新增引用表却忘了 SET NULL → 删除时会在运行期撞裸 FK，
    失败形态变成 500 / 误导文案（P67 / P102 同族）→ 本用例变红。

    **方向已反转**：v42 之前它检查「表在拦截清单里」，现在检查「表已放行」。
    只改断言不改推导——推导本身是这条锁的价值所在。
    """
    repo, db, _vault = _repo(tmp_path)
    with db.connection() as conn:
        tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        offenders: dict[str, str] = {}
        checked = 0
        for name in tables:
            fks = [r for r in conn.execute(f"PRAGMA foreign_key_list({name})")
                   if r[2] == "provider_configs"]
            if not fks:
                continue
            checked += 1
            rule = fks[0][6]
            if rule != "SET NULL":
                offenders[name] = rule
    assert checked >= 13, f"应至少有 13 张表引用 provider_configs，实际 {checked}"
    assert not offenders, (
        "这些表引用 provider_configs 但不是 ON DELETE SET NULL，"
        f"删除会在运行期撞裸 FK：{offenders}"
    )


def test_delete_unknown_provider_is_not_found(tmp_path: Path) -> None:
    repo, _db, _vault = _repo(tmp_path)
    with pytest.raises(DomainError) as raised:
        repo.delete("provider_missing")
    assert raised.value.code == "PROVIDER_NOT_FOUND"


def test_delete_keeps_other_providers_intact(tmp_path: Path) -> None:
    repo, _db, vault = _repo(tmp_path)
    keep_id = _seed(repo, vault, "keep")
    drop_id = _seed(repo, vault, "drop")

    repo.delete(drop_id)

    assert repo.get(keep_id)["provider_config_id"] == keep_id
    assert vault.status(keep_id) == "configured"


def test_delete_succeeds_when_referenced_by_keyframe_preview(tmp_path: Path) -> None:
    """行为级：**关键帧外传预览**引用时同样可删，且预览行保留、指针置空。

    覆盖 v40 新增的表——证明 SET NULL 不只对老表生效。
    """
    repo, db, vault = _repo(tmp_path)
    provider_id = _seed(repo, vault)
    now = "2026-10-21T00:00:00.000Z"
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO keyframe_egress_previews"
            "(id,project_id,asset_id,provider_config_id,source_fingerprint,"
            "payload_sha256,frames_json,excluded_frames_json,sampling_mode,"
            "covered_scene_cuts,total_frame_bytes,expires_at,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("kp_1", "p1", None, provider_id, "fp_1", "sha256:" + "a" * 64,
             "[]", "[]", "interval_only", 0, 0, now, now, now),
        )

    repo.delete(provider_id)

    with db.connection() as conn:
        row = conn.execute(
            "SELECT provider_config_id,payload_sha256 FROM keyframe_egress_previews WHERE id='kp_1'"
        ).fetchone()
    assert row is not None, "外发预览行必须保留"
    assert row["provider_config_id"] is None
    assert row["payload_sha256"] == "sha256:" + "a" * 64


def test_delete_succeeds_when_only_generation_references(tmp_path: Path) -> None:
    """行为级：**只有生成记录**引用时也可删。

    构造上让 preview 行属于**另一个** Provider，于是「被置空」的唯一来源
    就是 keyframe_generations——否则本用例会被 previews 那条路径顺带满足，
    测不出 generations 这一条是否真的也已 SET NULL（假绿）。
    """
    repo, db, vault = _repo(tmp_path)
    target_id = _seed(repo, vault, "target")
    owner_id = _seed(repo, vault, "owner")
    now = "2026-10-21T00:00:00.000Z"
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO keyframe_egress_previews"
            "(id,project_id,asset_id,provider_config_id,source_fingerprint,"
            "payload_sha256,frames_json,excluded_frames_json,sampling_mode,"
            "covered_scene_cuts,total_frame_bytes,expires_at,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("kp_2", "p1", None, owner_id, "fp_2", "sha256:" + "b" * 64,
             "[]", "[]", "interval_only", 0, 0, now, now, now),
        )
        conn.execute(
            "INSERT INTO keyframe_egress_consents"
            "(id,egress_preview_id,payload_sha256,created_at) VALUES (?,?,?,?)",
            ("kc_2", "kp_2", "sha256:" + "b" * 64, now),
        )
        conn.execute(
            "INSERT INTO keyframe_generations"
            "(id,project_id,egress_preview_id,egress_consent_id,provider_config_id,"
            "source_fingerprint,status,payload_sha256,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            ("kg_2", "p1", "kp_2", "kc_2", target_id, "fp_2", "queued",
             "sha256:" + "b" * 64, now),
        )

    repo.delete(target_id)

    with db.connection() as conn:
        gen = conn.execute(
            "SELECT provider_config_id FROM keyframe_generations WHERE id='kg_2'"
        ).fetchone()
        preview = conn.execute(
            "SELECT provider_config_id FROM keyframe_egress_previews WHERE id='kp_2'"
        ).fetchone()
    assert gen is not None and gen["provider_config_id"] is None
    # 反证：没有删到别的 Provider 的引用行
    assert preview is not None and preview["provider_config_id"] == owner_id


def test_legacy_blocking_list_no_longer_gates_delete(tmp_path: Path) -> None:
    """回归锁：delete() 不再读那份旧的拦截清单。

    v42 之前 _REFERENCING_TABLES 是删除的判据；现在它只剩历史记录价值。
    若有人把拦截逻辑加回去，本用例立刻变红——而「加回去」正是这次变更
    最可能被无意回滚的方式（它看起来像一道安全防线）。
    """
    repo, db, vault = _repo(tmp_path)
    provider_id = _seed(repo, vault)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO provider_invocations"
            "(id,provider_config_id,capability,provider_name,model,"
            "prompt_template_version,output_schema_version,input_sha256,status,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,'n')",
            ("inv_2", provider_id, "cap", "p", "m", "1", "1", "sha256:" + "a" * 64, "failed"),
        )
    # 该表确实在旧清单里（证明构造有效）
    assert "provider_invocations" in repo._LEGACY_REFERENCING_TABLES

    repo.delete(provider_id)

    with db.connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM provider_invocations WHERE id='inv_2'"
        ).fetchone()[0] == 1
