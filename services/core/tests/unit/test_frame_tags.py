"""W3.3 S5a：逐帧标签读取（只读端点，不发网络）。

写侧属 S4（需真实网关），但读侧语义可以现在完整验收——
v40 的 asset_frame_tags 表已存在，测试直接写行来验证：
  1. stale 在读侧算（指纹变化 ⇒ stale，不删不假装 ready）
  2. 标签过滤是精确匹配，且**绝不跨项目**
  3. by_label 不看 stale 行（标签描述的是旧内容）
  4. 空标签拒绝，不退化成「返回全部」
"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.frame_tags import FRAME_TAGS_ALGORITHM_VERSION, FrameTagService, validate_label
from aivs_core.projects import DomainError


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "t.db")
    db.initialize()
    now = utc_now()
    with db.connection() as conn:
        for pid, name in (("proj_1", "P1"), ("proj_2", "P2")):
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
                "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pid, name, "active", "{}", None, "C:/t", "t", now, now, now),
            )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("a1", "proj_1", "video", "external", "x.mp4", "fp_1", 1, "available", now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("a2", "proj_2", "video", "external", "y.mp4", "fp_2", 1, "available", now, now),
        )
    yield db, FrameTagService(db), now


def _row(db: Database, asset_id: str, fingerprint: str, frame_index: int,
         labels: list[str], *, notes: str | None = None, status: str = "ready",
         now: str = "2026-10-21T00:00:00.000Z") -> None:
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO asset_frame_tags (id,asset_id,source_fingerprint,"
            "algorithm_version,vocabulary_id,vocabulary_version,status,reason,"
            "frame_index,timestamp_us,labels_json,notes,provider_config_id,"
            "generation_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"t_{asset_id}_{frame_index}", asset_id, fingerprint,
             FRAME_TAGS_ALGORITHM_VERSION, "keyframe-v1", 1, status, None,
             frame_index, frame_index * 1_000_000, json_dumps(labels), notes,
             None, None, now, now),
        )


def _asset(asset_id: str, fingerprint: str) -> dict:
    return {"id": asset_id, "fingerprint": fingerprint}


# ── 基本读取 ──


def test_no_rows_yields_empty_summary(env) -> None:
    _db, svc, _now = env
    summary = svc.summary(_asset("a1", "fp_1"))
    assert summary["status"] is None
    assert summary["tags"] == []
    assert summary["vocabulary_violations"] == 0


def test_summary_returns_ready_tags(env) -> None:
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物", "室内"], now=now)
    _row(db, "a1", "fp_1", 1, ["动物"], now=now)
    summary = svc.summary(_asset("a1", "fp_1"))
    assert summary["status"] == "ready"
    assert [t["frame_index"] for t in summary["tags"]] == [0, 1]
    assert summary["tags"][0]["labels"] == ["人物", "室内"]
    assert summary["vocabulary_version"] == 1


def test_label_filter_within_asset(env) -> None:
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    _row(db, "a1", "fp_1", 1, ["动物"], now=now)
    summary = svc.summary(_asset("a1", "fp_1"), label="动物")
    assert [t["frame_index"] for t in summary["tags"]] == [1]


def test_notes_count_as_vocabulary_violations(env) -> None:
    """规划门 §3.4：词表外标签一律改道 notes ⇒ 有 notes 即违规帧。

    这是可算的实测值，不引入额外的 violations 列（同一事实两处存必漂移）。
    """
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    _row(db, "a1", "fp_1", 1, ["人物"], notes="一只橘猫在窗台", now=now)
    summary = svc.summary(_asset("a1", "fp_1"))
    assert summary["vocabulary_violations"] == 1


# ── stale 在读侧计算 ──


def test_fingerprint_change_makes_summary_stale(env) -> None:
    """素材变了 ⇒ 旧标签按 stale 呈现，不删、也不假装 ready。"""
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    assert svc.summary(_asset("a1", "fp_1"))["status"] == "ready"
    assert svc.summary(_asset("a1", "fp_NEW"))["status"] == "stale"


def test_stale_summary_still_returns_tags(env) -> None:
    """stale 不是「没有数据」：标签仍可读，只是被标记为过期。"""
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    summary = svc.summary(_asset("a1", "fp_NEW"))
    assert summary["status"] == "stale"
    assert len(summary["tags"]) == 1


def test_non_ready_rows_are_not_returned_as_tags(env) -> None:
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], status="failed", now=now)
    summary = svc.summary(_asset("a1", "fp_1"))
    assert summary["status"] == "failed"
    assert summary["tags"] == []


# ── 项目内按标签过滤 ──


def test_by_label_finds_matching_frames(env) -> None:
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    _row(db, "a1", "fp_1", 1, ["动物"], now=now)
    hits = svc.by_label("proj_1", "动物")
    assert len(hits) == 1
    assert hits[0]["frame_index"] == 1
    assert hits[0]["asset_id"] == "a1"


def test_by_label_is_project_scoped(env) -> None:
    """绝不跨项目——这是所有检索类端点的硬约束。"""
    db, svc, now = env
    _row(db, "a2", "fp_2", 0, ["动物"], now=now)
    assert svc.by_label("proj_1", "动物") == []
    assert len(svc.by_label("proj_2", "动物")) == 1


def test_by_label_excludes_stale_rows(env) -> None:
    """stale 行的标签描述的是旧内容，不参与过滤（与检索侧同款纪律）。"""
    db, svc, now = env
    _row(db, "a1", "fp_OLD", 0, ["动物"], now=now)
    with db.connection() as conn:
        conn.execute("UPDATE assets SET fingerprint=? WHERE id=?", ("fp_NEW", "a1"))
    assert svc.by_label("proj_1", "动物") == []


def test_by_label_is_exact_match(env) -> None:
    """精确匹配，不是子串模糊搜索（否则「人」会命中「人物」）。"""
    db, svc, now = env
    _row(db, "a1", "fp_1", 0, ["人物"], now=now)
    assert svc.by_label("proj_1", "人") == []
    assert len(svc.by_label("proj_1", "人物")) == 1


# ── 入参校验 ──


def test_empty_label_rejected() -> None:
    """空标签必须拒绝，不能退化成「返回全部」。"""
    with pytest.raises(DomainError):
        validate_label("   ")


def test_overlong_label_rejected() -> None:
    with pytest.raises(DomainError):
        validate_label("x" * 65)


def test_label_is_trimmed() -> None:
    assert validate_label("  动物  ") == "动物"
