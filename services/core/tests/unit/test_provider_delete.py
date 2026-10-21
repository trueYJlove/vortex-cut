"""Provider 配置删除（P67，2026-10-09 用户实测缺陷）。

废弃 Provider 条目此前全链路无删除能力：Core 无 DELETE 路由、UI 无入口，
条目一旦创建便永久留在所有 Provider 下拉里。本文件锁定删除语义：
- 未被历史引用 → 硬删（行 + 内存库密钥）；
- 被任一外发/生成/调用审计表引用 → fail-closed PROVIDER_IN_USE
  （审计链不可静默断链，对齐 P51 转录删除语义；出路是删密钥 + 停用）。
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


def test_delete_fails_closed_when_referenced(tmp_path: Path) -> None:
    """被审计表（以 provider_invocations 为代表）引用 → PROVIDER_IN_USE。

    行与密钥都保持原样；各引用表的行为由同一段循环保证，清单覆盖面
    由下方 schema 推导回归锁独立钉死。
    """
    repo, db, vault = _repo(tmp_path)
    provider_id = _seed(repo, vault)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO provider_invocations"
            "(id,provider_config_id,capability,provider_name,model,"
            "prompt_template_version,output_schema_version,input_sha256,status,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,'n')",
            ("inv_1", provider_id, "cap", "p", "m", "1", "1", "sha256:" + "a" * 64, "succeeded"),
        )

    with pytest.raises(DomainError) as raised:
        repo.delete(provider_id)
    assert raised.value.code == "PROVIDER_IN_USE"
    assert repo.get(provider_id)["provider_config_id"] == provider_id
    assert vault.status(provider_id) == "configured"


def test_referencing_tables_cover_schema(tmp_path: Path) -> None:
    """回归锁：schema 中所有含 provider_config_id 列的表必须在删除检查清单里。

    从 sqlite_master 推导而非硬编码对拍（P45 教训：硬编码清单会腐烂）——
    未来迁移新增引用表而漏更 _REFERENCING_TABLES → 删除检查出现旁路 → 红。
    """
    repo, db, _vault = _repo(tmp_path)
    with db.connection() as conn:
        tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        referencing = {
            name for name in tables
            if "provider_config_id" in {row[1] for row in conn.execute(f"PRAGMA table_info({name})")}
        }
    missing = referencing - set(repo._REFERENCING_TABLES)
    assert not missing, f"这些表含 provider_config_id 但不在删除检查清单：{sorted(missing)}"


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


def test_delete_rejects_provider_referenced_by_keyframe_preview(tmp_path: Path) -> None:
    """行为级：**关键帧外传预览**引用时必须是 PROVIDER_IN_USE，而不是裸 FK 错误。

    与 test_delete_fails_closed_when_referenced 同族，但覆盖 v40 新加的表。
    schema 推导回归锁只证明「名字在清单里」，本用例证明「名字在清单里
    **确实产生正确的失败形态**」。二者不可互相替代：清单对了但 delete()
    的循环没查它，锁仍然绿。
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

    with pytest.raises(DomainError) as raised:
        repo.delete(provider_id)
    assert raised.value.code == "PROVIDER_IN_USE"
    assert repo.get(provider_id)["provider_config_id"] == provider_id
    assert vault.status(provider_id) == "configured"


def test_delete_rejects_provider_referenced_only_by_keyframe_generation(
    tmp_path: Path,
) -> None:
    """行为级：**只有生成记录**引用时也必须 PROVIDER_IN_USE。

    构造上让 preview 行属于**另一个** Provider，于是「被查到」的唯一来源
    就是 keyframe_generations——否则本用例会被 previews 那条路径顺带满足，
    测不出 generations 这一条是否真的在清单里（"只登记了 previews 也算过"
    的假绿）。
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

    with pytest.raises(DomainError) as raised:
        repo.delete(target_id)
    assert raised.value.code == "PROVIDER_IN_USE"

    # 反证 1：owner 被 kp_2 引用，删它也必须是 PROVIDER_IN_USE——
    # 证明 target 的红不是「查询把两行串了」的偶然结果，而是各行按其引用判定。
    with pytest.raises(DomainError) as owner_raised:
        repo.delete(owner_id)
    assert owner_raised.value.code == "PROVIDER_IN_USE"

    # 反证 2：真正无引用的 Provider 仍可删除——证明上面两条红不是
    # 「凡是带关键帧行的库全拒」这种过度拒绝。
    free_id = _seed(repo, vault, "free")
    repo.delete(free_id)
