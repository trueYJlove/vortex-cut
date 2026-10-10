"""W2.1 机位同步：存储层与服务层回归（含评审 C1 的「指纹入唯一键」回归锁）。

覆盖 Planning Gate §3 验收 3（幂等/重试）、4（stale 4 变体）、8（人工偏移并列）。
负向对照：把 idx_angle_syncs_ready 的指纹列去掉 ⇒
test_rerun_after_fingerprint_change_writes_new_row 必红（重算与旧行撞唯一键）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.media.angle_sync import ANGLE_SYNC_ALGORITHM_VERSION, AngleSyncService
from aivs_core.projects import DomainError


def _service(tmp_path: Path, *, fingerprints: tuple[str, str] = ("sha256:aaa", "sha256:bbb")) -> tuple[Database, AngleSyncService]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    now = utc_now()
    with db.connection() as con:
        con.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "机位测试", "active", "{}", str(tmp_path), "r", now, now, now),
        )
        for index, fingerprint in enumerate(fingerprints):
            con.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"a{index + 1}", "p1", "video", "external", f"素材{index + 1}", fingerprint,
                 1, "0", "available",
                 json_dumps({"duration_us": 30_000_000,
                             "audio_streams": [{"index": 1, "codec": "aac"}],
                             "video_streams": [{"index": 0, "codec": "h264"}]}),
                 now, now),
            )
    service = AngleSyncService(db, Path("ffmpeg-missing"), lambda asset_id: {"path": str(tmp_path / asset_id)})
    return db, service


def _set_fingerprint(db: Database, asset_id: str, fingerprint: str) -> None:
    with db.connection() as con:
        con.execute("UPDATE assets SET fingerprint=? WHERE id=?", (fingerprint, asset_id))


def _insert_row(db: Database, service_row: dict) -> None:
    with db.connection() as con:
        con.execute(
            "INSERT INTO angle_syncs(id,group_id,asset_id,is_reference,offset_us,confidence,"
            "status,reason,source,reference_fingerprint,asset_fingerprint,algorithm_version,"
            "created_at,updated_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (service_row["id"], service_row["group_id"], service_row["asset_id"],
             0, service_row.get("offset_us"), service_row.get("confidence"),
             service_row["status"], service_row.get("reason"), service_row["source"],
             service_row["reference_fingerprint"], service_row["asset_fingerprint"],
             ANGLE_SYNC_ALGORITHM_VERSION, service_row["created_at"], service_row["created_at"],
             service_row["created_at"]),
        )


def _entry(summary: dict, asset_id: str) -> dict:
    return next(entry for entry in summary["angles"] if entry["asset_id"] == asset_id)


def test_create_group_starts_missing(tmp_path: Path) -> None:
    _, service = _service(tmp_path)
    summary = service.create_group("p1", "双机位", "a1", ["a1", "a2"])
    assert summary["reference_asset_id"] == "a1"
    assert [entry["status"] for entry in summary["angles"]] == ["missing", "missing"]
    assert _entry(summary, "a1")["is_reference"] is True
    # DTO 契约形状锁（P74 教训：algorithm_version 必须是 string，不是 int）
    assert isinstance(summary["algorithm_version"], str)
    per_angle = {"asset_id", "is_reference", "status", "reason", "offset_us",
                 "confidence", "source", "stale", "recorded_at"}
    assert per_angle <= set(_entry(summary, "a1"))


def test_reference_row_is_persisted_with_is_reference_flag(tmp_path: Path) -> None:
    """复核 M-c：is_reference 必须**落库**为 1（此前恒传 0，使
    CHECK(is_reference=0 OR offset_us=0) 形同虚设）。"""
    import asyncio

    db, service = _service(tmp_path)
    group_id = service.create_group("p1", "双机位", "a1", ["a1", "a2"])["group_id"]
    # 直接写一条参考行（绕开解码：run_sync_job 的参考行分支需要真实解码，这里验的是落库语义）
    service._insert_row(group_id, "a1", 0, 1.0, "ready", None, "auto",
                        "sha256:aaa", "sha256:aaa")
    service._insert_row(group_id, "a2", 1234, 0.9, "ready", None, "auto",
                        "sha256:aaa", "sha256:bbb")
    with db.connection() as con:
        flags = {row["asset_id"]: row["is_reference"] for row in con.execute(
            "SELECT asset_id, is_reference FROM angle_syncs WHERE group_id=?", (group_id,)).fetchall()}
    assert flags == {"a1": 1, "a2": 0}, flags


def test_group_requires_video_assets(tmp_path: Path) -> None:
    db, service = _service(tmp_path)
    with db.connection() as con:
        con.execute("UPDATE assets SET kind='audio' WHERE id='a2'")
    with pytest.raises(DomainError) as excinfo:
        service.create_group("p1", "双机位", "a1", ["a1", "a2"])
    assert excinfo.value.code == "ANGLE_GROUP_UNSUPPORTED"


def test_rerun_after_fingerprint_change_writes_new_row(tmp_path: Path) -> None:
    """C1 回归锁：指纹变化后重算必须能写新行（唯一键含指纹）。"""
    db, service = _service(tmp_path)
    summary = service.create_group("p1", "双机位", "a1", ["a1", "a2"])
    group_id = summary["group_id"]
    now = utc_now()
    _insert_row(db, {"id": "s1", "group_id": group_id, "asset_id": "a2", "offset_us": 1_000,
                     "confidence": 0.9, "status": "ready", "reason": None, "source": "auto",
                     "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:bbb",
                     "created_at": now})
    assert _entry(service.group_summary("p1", group_id), "a2")["status"] == "ready"

    _set_fingerprint(db, "a2", "sha256:ccc")
    assert _entry(service.group_summary("p1", group_id), "a2")["status"] == "stale"

    # 重算：新指纹 ⇒ 新行（旧行保留）
    _insert_row(db, {"id": "s2", "group_id": group_id, "asset_id": "a2", "offset_us": 2_000,
                     "confidence": 0.95, "status": "ready", "reason": None, "source": "auto",
                     "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:ccc",
                     "created_at": utc_now()})
    entry = _entry(service.group_summary("p1", group_id), "a2")
    assert entry["status"] == "ready" and entry["offset_us"] == 2_000 and entry["stale"] is False

    # 同指纹重复 ready 行必须被拒绝（部分唯一索引仍然生效）
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        _insert_row(db, {"id": "s3", "group_id": group_id, "asset_id": "a2", "offset_us": 3_000,
                         "confidence": 0.9, "status": "ready", "reason": None, "source": "auto",
                         "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:ccc",
                         "created_at": utc_now()})


def test_stale_matrix(tmp_path: Path) -> None:
    """验收 4：参考侧变 / 成员侧变 / 回退 / availability 四变体。"""
    db, service = _service(tmp_path)
    group_id = service.create_group("p1", "双机位", "a1", ["a1", "a2"])["group_id"]
    now = utc_now()
    _insert_row(db, {"id": "r1", "group_id": group_id, "asset_id": "a1", "offset_us": 0,
                     "confidence": 1.0, "status": "ready", "reason": None, "source": "auto",
                     "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:aaa",
                     "created_at": now})
    _insert_row(db, {"id": "r2", "group_id": group_id, "asset_id": "a2", "offset_us": 500,
                     "confidence": 0.9, "status": "ready", "reason": None, "source": "auto",
                     "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:bbb",
                     "created_at": now})

    # ① 只改成员侧 ⇒ 仅该成员 stale
    _set_fingerprint(db, "a2", "sha256:bbb2")
    summary = service.group_summary("p1", group_id)
    assert _entry(summary, "a2")["status"] == "stale"
    assert _entry(summary, "a1")["status"] == "ready"

    # ③ 回退到原指纹 ⇒ 自动恢复有效（与 P79 回退语义一致）
    _set_fingerprint(db, "a2", "sha256:bbb")
    assert _entry(service.group_summary("p1", group_id), "a2")["status"] == "ready"

    # ② 只改参考侧 ⇒ 全组 stale
    _set_fingerprint(db, "a1", "sha256:aaa2")
    summary = service.group_summary("p1", group_id)
    assert _entry(summary, "a1")["status"] == "stale"
    assert _entry(summary, "a2")["status"] == "stale"

    # ④ availability != available ⇒ unavailable(asset_not_available)
    with db.connection() as con:
        con.execute("UPDATE assets SET availability='changed' WHERE id='a2'")
    entry = _entry(service.group_summary("p1", group_id), "a2")
    assert entry["status"] == "unavailable" and entry["reason"] == "asset_not_available"


def test_manual_offset_preferred_and_timestamped(tmp_path: Path) -> None:
    """验收 8：人工偏移与 auto 并列、manual 优先、带时间戳、不覆盖 auto。"""
    db, service = _service(tmp_path)
    group_id = service.create_group("p1", "双机位", "a1", ["a1", "a2"])["group_id"]
    now = utc_now()
    _insert_row(db, {"id": "auto1", "group_id": group_id, "asset_id": "a2", "offset_us": 1_000,
                     "confidence": 0.9, "status": "ready", "reason": None, "source": "auto",
                     "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:bbb",
                     "created_at": now})
    summary = service.write_manual_offset("p1", group_id, "a2", 2_500)
    entry = _entry(summary, "a2")
    assert entry["source"] == "manual" and entry["offset_us"] == 2_500
    assert entry["recorded_at"] is not None
    with db.connection() as con:
        sources = [row["source"] for row in con.execute(
            "SELECT source FROM angle_syncs WHERE asset_id='a2' ORDER BY created_at").fetchall()]
    assert sources == ["auto", "manual"], "auto 行必须保留（不覆盖）"

    with pytest.raises(DomainError) as reference_error:
        service.write_manual_offset("p1", group_id, "a1", 100)      # 参考机位必须 0
    assert reference_error.value.code == "ANGLE_OFFSET_REFERENCE_FIXED"
    with pytest.raises(DomainError) as range_error:
        service.write_manual_offset("p1", group_id, "a2", 10_000_000_000)  # 越界
    assert range_error.value.code == "ANGLE_OFFSET_OUT_OF_RANGE"


def test_schema_checks_reject_invalid_rows(tmp_path: Path) -> None:
    """迁移约束锁：status/source 取值受限；参考行 offset 必须为 0（评审 C2）。"""
    import sqlite3
    db, service = _service(tmp_path)
    group_id = service.create_group("p1", "双机位", "a1", ["a1", "a2"])["group_id"]
    now = utc_now()

    def raw(row: dict) -> None:
        with db.connection() as con:
            con.execute(
                "INSERT INTO angle_syncs(id,group_id,asset_id,is_reference,offset_us,confidence,"
                "status,reason,source,reference_fingerprint,asset_fingerprint,algorithm_version,"
                "created_at,updated_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (row["id"], group_id, row.get("asset_id", "a2"), row.get("is_reference", 0),
                 row.get("offset_us"), None, row["status"], None, row.get("source", "auto"),
                 "sha256:aaa", "sha256:bbb", ANGLE_SYNC_ALGORITHM_VERSION, now, now, now),
            )

    with pytest.raises(sqlite3.IntegrityError):
        raw({"id": "bad_status", "status": "weird"})
    with pytest.raises(sqlite3.IntegrityError):
        raw({"id": "bad_source", "status": "ready", "source": "guess"})
    with pytest.raises(sqlite3.IntegrityError):
        raw({"id": "bad_reference", "status": "ready", "is_reference": 1, "offset_us": 999})




def test_sync_job_idempotent_and_retryable(tmp_path: Path) -> None:
    """验收 3：全 ready ⇒ 幂等短路；stale/缺失 ⇒ 建作业；failed 行不得永久锁死；
    且在飞作业期间「连点重算」不得入队第二个作业（复核 M-a 的生产同源路径）。"""
    db, service = _service(tmp_path)
    group_id = service.create_group("p1", "双机位", "a1", ["a1", "a2"])["group_id"]
    first_job = service.create_sync_job("p1", group_id)           # missing ⇒ 建作业
    assert first_job is not None
    # 在飞短路：作业仍 queued/running 期间再点一次 ⇒ 不重复入队（否则两个 worker 并发跑同组）
    assert service.create_sync_job("p1", group_id) is None

    now = utc_now()
    for row in (
        {"id": "k1", "group_id": group_id, "asset_id": "a1", "offset_us": 0, "confidence": 1.0,
         "status": "ready", "reason": None, "source": "auto",
         "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:aaa", "created_at": now},
        {"id": "k2", "group_id": group_id, "asset_id": "a2", "offset_us": 700, "confidence": 0.9,
         "status": "ready", "reason": None, "source": "auto",
         "reference_fingerprint": "sha256:aaa", "asset_fingerprint": "sha256:bbb", "created_at": now},
    ):
        _insert_row(db, row)
    # 让首个作业收尾（模拟 worker 完成），否则在飞短路会一直生效
    with db.connection() as con:
        con.execute("UPDATE jobs SET status='succeeded' WHERE id=?", (first_job,))
    assert service.create_sync_job("p1", group_id) is None        # 全可用 ⇒ 短路

    _set_fingerprint(db, "a2", "sha256:bbb9")
    retry = service.create_sync_job("p1", group_id)               # 指纹变化 ⇒ 建新作业
    assert retry is not None
    with db.connection() as con:
        con.execute("UPDATE jobs SET status='succeeded' WHERE id=?", (retry,))

    _set_fingerprint(db, "a2", "sha256:bbb")
    _set_fingerprint(db, "a1", "sha256:aaaX")
    now2 = utc_now()
    _insert_row(db, {"id": "f1", "group_id": group_id, "asset_id": "a2", "offset_us": None,
                     "confidence": None, "status": "failed", "reason": "ANGLE_SYNC_NO_AUDIO",
                     "source": "auto", "reference_fingerprint": "sha256:aaaX",
                     "asset_fingerprint": "sha256:bbb", "created_at": now2})
    assert service.create_sync_job("p1", group_id) is not None    # failed ⇒ 允许重试
