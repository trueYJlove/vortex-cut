"""素材删除 × **派生分析数据**（2026-10-11 缺陷修复回归）。

背景（实测复现）：`beat_grids` / `cv_analyses` 对 `assets` 是 ON DELETE **NO ACTION**
（`PRAGMA foreign_key_list` 实证），一旦存在分析行，`delete_asset` 的
`DELETE FROM assets` 直接被 FK 拒绝，并被通用 `except` 报成
"素材被镜头需求或生成记录引用"——**原因错、且没有出路**：
用户跑过一次节拍分析或 CV 分析之后，素材就永久删不掉。

本用例锁定修复后的语义：**派生分析数据（可重算）随素材一并清理**，且
`cv_samples` 必须**自下而上先清**（它对 `cv_analyses` 同为 NO ACTION——
只清父表会撞子表，这条是写测试时才暴露的）。

**业务记录仍拒绝删除**的保护未变，由 `test_stage1a_api.py` 的时间线引用用例覆盖。

负向对照：去掉 `delete_asset` 里那三条 DELETE（beat_grids / cv_samples / cv_analyses）
⇒ 本用例红（`DomainError: ASSET_IN_USE`）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.projects import DomainError, ProjectAssetService


async def _stub_probe(*args, **kwargs) -> dict:  # pragma: no cover - 本用例不触发探测
    return {}


def _seed(tmp_path: Path) -> tuple[Database, ProjectAssetService, str]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    now = utc_now()
    with db.connection() as con:
        con.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "派生删除测试", "active", "{}", str(tmp_path), "r", now, now, now),
        )
        con.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("a1", "p1", "video", "external", "素材", "sha256:x", 1, "0", "available",
             json_dumps({"duration_us": 30_000_000}), now, now),
        )
        # 派生分析数据：节拍网格 + CV 分析 + 其子表样本
        con.execute(
            "INSERT INTO beat_grids(id,asset_id,source_fingerprint,algorithm_version,status,"
            "created_at,updated_at) VALUES ('bg1','a1','sha256:x',1,'ready',?,?)",
            (now, now),
        )
        con.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,status,"
            "created_at,updated_at) VALUES ('cv1','a1','sha256:x',1,'ready',?,?)",
            (now, now),
        )
        con.execute(
            "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
            "motion_energy,sharpness,brightness) VALUES ('s1','cv1',0,0,0,0.1,0.1,0.1)",
        )
    return db, ProjectAssetService(db, tmp_path, _stub_probe), "a1"


def test_delete_asset_clears_derived_analysis_rows(tmp_path: Path) -> None:
    """派生分析行不阻塞素材删除，且随素材一并清掉。"""
    db, service, asset_id = _seed(tmp_path)

    service.delete_asset(asset_id)

    with db.connection() as con:
        for table, where in (
            ("assets", "id='a1'"),
            ("beat_grids", "asset_id='a1'"),
            ("cv_analyses", "asset_id='a1'"),
            ("cv_samples", "analysis_id='cv1'"),
        ):
            left = con.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}").fetchone()[0]
            assert left == 0, f"{table} 仍有 {left} 行未清"


def test_business_record_still_blocks_asset_delete(tmp_path: Path) -> None:
    """**收窄而非关掉**保护：真实业务记录（作业历史）仍必须拒绝删除。

    若哪天有人把 `delete_asset` 的清理写成"先删所有引用行"，本用例会红。
    """
    db, service, asset_id = _seed(tmp_path)
    with db.connection() as con:
        now = utc_now()
        con.execute(
            "INSERT INTO jobs(id,project_id,asset_id,kind,type,status,input_json,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("j1", "p1", asset_id, "cv_analysis", "cv_analysis", "succeeded", "{}", now, now),
        )

    with pytest.raises(DomainError) as exc:
        service.delete_asset(asset_id)
    assert exc.value.code == "ASSET_IN_USE"
    with db.connection() as con:
        left = con.execute("SELECT COUNT(*) FROM assets WHERE id=?", (asset_id,)).fetchone()[0]
    assert left == 1, "被业务记录引用时素材行必须保留"