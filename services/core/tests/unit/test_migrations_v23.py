# ruff: noqa: E501
"""v23 迁移测试（ADR-0005 阶段 1）：cv_analyses 追加采样密度列。

要求（`CV_SAMPLING_BUDGET_PLANNING_GATE_2026-09-24` §1.1 第 4 项）：
- **追加式**：v22 → v23 只 ADD COLUMN，不改不删旧结构；旧校验和不变。
- **存量行回填 `full` 必须准确**（§2.5）：存量行全部产生于"无条件回退"旧行为——
  凡 `max_gap > 4s` 者必已回退至 ≤4s，故所有存量行都满足 achieved ≤ threshold。
  本测试用**代表性存量数据**（密集采样）验证该默认值与样本实际间隔自洽。
- `gap_threshold_us` 为可空列无自动默认，由迁移显式回填为当时的常量值 4s。
"""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS, V23_SQL, Database

LEGACY_THRESHOLD_US = 4_000_000


def _seed_v22(path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    import aivs_core.database as database_module

    original = database_module.MIGRATIONS
    monkeypatch.setattr(
        database_module, "MIGRATIONS", {k: v for k, v in original.items() if k != "v23"}
    )
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        checksums = dict(sql.execute("SELECT version,checksum FROM schema_migrations"))
    monkeypatch.setattr(database_module, "MIGRATIONS", original)
    return checksums


def _insert_legacy_analysis(path: Path, *, sample_step_us: int) -> None:
    """写入一条"旧行为产物"分析：密集采样（模拟无条件回退后的结果）。"""
    with sqlite3.connect(path) as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available','{}','now','now')"
        )
        sql.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,sample_count,scene_cut_count,created_at,updated_at,finished_at) "
            "VALUES ('an1','a1','fp1',2,'ready',5,0,'now','now','now')"
        )
        for index in range(5):
            sql.execute(
                "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
                "motion_energy,sharpness,brightness,audio_energy) "
                "VALUES (?,?,?,?,0,0.1,0.2,0.5,0.0)",
                (f"s{index}", "an1", index, index * sample_step_us),
            )


def test_v22_to_v23_is_append_only_and_preserves_checksums(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "app.db"
    old = _seed_v22(path, monkeypatch)
    _insert_legacy_analysis(path, sample_step_us=1_000_000)

    database = Database(path)
    database.initialize()
    with database.connection() as sql:
        history = dict(
            sql.execute("SELECT version,checksum FROM schema_migrations WHERE version<>'v23'")
        )
        assert history == old
        assert (
            sql.execute("SELECT checksum FROM schema_migrations WHERE version='v23'").fetchone()[0]
            == hashlib.sha256(V23_SQL.encode()).hexdigest()
        )
        assert sql.execute("PRAGMA foreign_key_check").fetchall() == []
        assert sql.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_v23_backfills_legacy_rows_consistently_with_their_samples(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """存量行回填 `full` 必须与其**样本实际间隔**自洽（规划门 §2.5 的断言）。"""
    path = tmp_path / "app.db"
    _seed_v22(path, monkeypatch)
    # 密集采样（相邻 1s）——旧行为下凡超 4s 者必已回退，故存量行应为密集。
    _insert_legacy_analysis(path, sample_step_us=1_000_000)
    Database(path).initialize()

    with sqlite3.connect(path) as sql:
        sql.row_factory = sqlite3.Row
        row = sql.execute(
            "SELECT density_status,gap_threshold_us FROM cv_analyses WHERE id='an1'"
        ).fetchone()
        timestamps = [
            r[0] for r in sql.execute(
                "SELECT timestamp_us FROM cv_samples WHERE analysis_id='an1' ORDER BY timestamp_us"
            )
        ]
    # 回填值。
    assert row["density_status"] == "full"
    assert row["gap_threshold_us"] == LEGACY_THRESHOLD_US
    # 自洽性：由样本反推的最大间隔确实不超过回填的阈值快照。
    achieved = max(b - a for a, b in zip(timestamps, timestamps[1:]))
    assert achieved <= row["gap_threshold_us"], (
        "回填 full 与样本实际间隔不自洽——§2.5 的回填依据被破坏"
    )


def test_v23_enforces_density_status_whitelist(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as sql:
        columns = {r[1] for r in sql.execute("PRAGMA table_info(cv_analyses)")}
        assert {
            "density_status", "gap_threshold_us", "achieved_max_gap_us", "wall_clock_ms",
        } <= columns
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        sql.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available','{}','now','now')"
        )
        sql.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,created_at,updated_at) VALUES ('an1','a1','fp1',2,'queued','now','now')"
        )
        # 新建行默认 full（尚未运行）。
        assert sql.execute(
            "SELECT density_status FROM cv_analyses WHERE id='an1'"
        ).fetchone()[0] == "full"
        # 约束：密度值白名单。
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("UPDATE cv_analyses SET density_status='bogus' WHERE id='an1'")
        # 约束：阈值快照必须为正；实际间隔不得为负。
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("UPDATE cv_analyses SET gap_threshold_us=0 WHERE id='an1'")
        with pytest.raises(sqlite3.IntegrityError):
            sql.execute("UPDATE cv_analyses SET achieved_max_gap_us=-1 WHERE id='an1'")


def test_v23_reregistration_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """列已存在时 ALTER 被过滤、回填 UPDATE 保留（对齐 v9/v10 先例）。"""
    path = tmp_path / "app.db"
    _seed_v22(path, monkeypatch)
    # 模拟"列已被部分添加"的库：先手工加一列，再跑迁移。
    with sqlite3.connect(path) as sql:
        sql.execute(
            "ALTER TABLE cv_analyses ADD COLUMN density_status TEXT NOT NULL DEFAULT 'full'"
        )
    _insert_legacy_analysis(path, sample_step_us=2_000_000)
    Database(path).initialize()
    with sqlite3.connect(path) as sql:
        row = sql.execute(
            "SELECT density_status,gap_threshold_us FROM cv_analyses WHERE id='an1'"
        ).fetchone()
    assert row == ("full", LEGACY_THRESHOLD_US)
    assert set(MIGRATIONS)  # 迁移注册表仍完整


def test_v23_version_is_registered() -> None:
    assert "v23" in MIGRATIONS
