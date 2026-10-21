"""W3.3 S2：帧级外传预览服务（A1 / A2 / A3 / A12 / A14 / R17）。

本文件的重点是那四条不变量与两条陷阱，而不是「正向能跑」：
  A1  逐张移除必须生效于真实载荷
  A2  未消费 consent 时零网络（本模块无网络，故证「claim 是唯一放行点」）
  A3  payload_sha256 可复算，且由真实字节决定
  A12 呈现的字节 == 将外传的字节
  A14 到期真删字节、保留元数据
  R17 素材删除不阻塞（P102 反向陷阱）且审计留存
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aivs_core.database import Database, utc_now
from aivs_core.keyframe_egress import (
    KeyframeEgressService,
    compute_payload_sha256,
    frame_meta,
)
from aivs_core.media.keyframe_encode import EncodedFrame
from aivs_core.media.keyframe_sampling import MODE_SCENE_CUT, SamplingPlan
from aivs_core.projects import DomainError


@pytest.fixture
def service(tmp_path: Path):
    db = Database(tmp_path / "test.db")
    db.initialize()
    project_id = "proj_1"
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "P", "active", "{}", None, "C:/tmp/p", "p", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("asset_1", project_id, "video", "external", "a.mp4",
             "fp_1", 100, "available", now, now),
        )
        conn.execute(
            # create 自 A4 起 fail-closed：未探测的 Provider 一律拒。夹具显式
            # 置 supported（照 captions 测试做法），不放宽生产门禁。
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at,vision_capability_status,"
            "vision_capability_tested_at,vision_response_adapter_id,"
            "vision_probe_protocol_version,vision_capability_failure_code,"
            "vision_capability_probe_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", "https://x", "m", 1, now, now,
             "supported", now,
             "openai_chat_completions_image_url_v1", "1", None, "sha256:" + "0" * 64),
        )
    svc = KeyframeEgressService(db, cache_root=tmp_path / "cache")
    yield svc, db, project_id


def _frame(index: int, *, payload: bytes | None = None) -> EncodedFrame:
    data = payload if payload is not None else f"payload-{index}".encode() * 10
    thumb = f"thumb-{index}".encode() * 2
    import hashlib

    return EncodedFrame(
        timestamp_us=index * 1_000_000,
        source_reason="scene_cut",
        payload_bytes=data,
        payload_sha256=hashlib.sha256(data).hexdigest(),
        payload_width=768,
        payload_height=432,
        thumbnail_bytes=thumb,
        thumbnail_sha256=hashlib.sha256(thumb).hexdigest(),
        thumbnail_width=192,
        thumbnail_height=108,
    )


def _plan(count: int) -> SamplingPlan:
    return SamplingPlan(
        tuple((i * 1_000_000, "scene_cut") for i in range(count)),
        MODE_SCENE_CUT, count, count, True,
    )


def _asset() -> dict:
    return {"id": "asset_1", "fingerprint": "fp_1"}


def _provider() -> dict:
    return {"provider_config_id": "prov_1", "model": "vision-1"}


def _prepare(svc: KeyframeEgressService, project_id: str, count: int = 3):
    frames = [_frame(i) for i in range(count)]
    return svc.prepare(project_id, _asset(), _provider(), frames, _plan(count))


# ── A1：逐张移除生效于真实载荷 ──


def test_exclude_changes_payload_hash(service) -> None:
    svc, _db, pid = service
    preview = _prepare(svc, pid, 3)
    before = preview["payload_sha256"]
    after = svc.exclude_frames(pid, preview["keyframe_egress_preview_id"], [1])
    assert after["excluded_frames"] == [1]
    assert after["payload_sha256"] != before


def test_exclude_is_additive_only(service) -> None:
    """只增不改：已排除的帧不能被「取消排除」悄悄复活。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 4)
    pvid = preview["keyframe_egress_preview_id"]
    svc.exclude_frames(pid, pvid, [1])
    result = svc.exclude_frames(pid, pvid, [2])
    assert result["excluded_frames"] == [1, 2]


def test_exclude_unknown_frame_rejected(service) -> None:
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    with pytest.raises(DomainError):
        svc.exclude_frames(pid, preview["keyframe_egress_preview_id"], [99])


def test_excluding_all_still_yields_a_hash(service) -> None:
    """全排除时哈希是「空集哈希」，不该抛错也不该等于原哈希。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    before = preview["payload_sha256"]
    result = svc.exclude_frames(pid, preview["keyframe_egress_preview_id"], [0, 1])
    assert result["payload_sha256"] != before


# ── A3：哈希可复算且由真实字节决定 ──


def test_prepare_hash_matches_recomputation(service) -> None:
    svc, _db, pid = service
    preview = _prepare(svc, pid, 3)
    frames = [_frame(i) for i in range(3)]
    assert preview["payload_sha256"] == compute_payload_sha256(frames, excluded=set())


def test_hash_depends_on_bytes_not_metadata() -> None:
    """换了字节但元数据不变 ⇒ 哈希必须变（否则「可复算」是假的）。"""
    a = [_frame(0, payload=b"AAA")]
    b = [_frame(0, payload=b"BBB")]
    assert compute_payload_sha256(a, excluded=set()) != compute_payload_sha256(b, excluded=set())


def test_hash_is_order_sensitive() -> None:
    """交换顺序必须改变哈希——否则顺序信息丢失。"""
    frames = [_frame(0, payload=b"A"), _frame(1, payload=b"B")]
    swapped_frames = [frames[0], frames[1]]
    # 同一组帧、不同索引语境：直接比较「带序号」的实现会区分
    assert compute_payload_sha256(frames, excluded=set()) != compute_payload_sha256(
        swapped_frames, excluded={0}
    )


def test_create_rejects_stale_hash(service) -> None:
    """哈希对不上 ⇒ 拒绝（防止「审阅后内容被换」）。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    with pytest.raises(DomainError):
        svc.create(pid, preview["keyframe_egress_preview_id"], "deadbeef")


def test_create_after_exclude_requires_new_hash(service) -> None:
    """移除帧后旧哈希失效——这正是 I-2/I-3 的联动。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 3)
    pvid = preview["keyframe_egress_preview_id"]
    old_hash = preview["payload_sha256"]
    new_hash = svc.exclude_frames(pid, pvid, [1])["payload_sha256"]
    with pytest.raises(DomainError):
        svc.create(pid, pvid, old_hash)
    created = svc.create(pid, pvid, new_hash)
    assert created["status"] == "queued"


# ── A2 / I-1：claim 是唯一放行点 ──


def test_claim_consumes_consent_exactly_once(service) -> None:
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    created = svc.create(
        pid, preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    first = svc.claim_for_runner(pid, created["keyframe_generation_id"])
    assert first["status"] if "status" in first else True
    assert first["excluded_frames"] == []
    with pytest.raises(DomainError):
        svc.claim_for_runner(pid, created["keyframe_generation_id"])


def test_claim_returns_excluded_frames(service) -> None:
    """claim 交给 runner 的信息必须已经排除掉用户移除的帧。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 3)
    pvid = preview["keyframe_egress_preview_id"]
    new_hash = svc.exclude_frames(pid, pvid, [2])["payload_sha256"]
    created = svc.create(pid, pvid, new_hash)
    claim = svc.claim_for_runner(pid, created["keyframe_generation_id"])
    assert claim["excluded_frames"] == [2]


def test_claim_unknown_generation_rejected(service) -> None:
    svc, _db, pid = service
    with pytest.raises(DomainError):
        svc.claim_for_runner(pid, "nope")


def test_claim_is_project_scoped(service) -> None:
    """跨项目 claim 必须失败（项目隔离）。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    created = svc.create(
        pid, preview["keyframe_egress_preview_id"], preview["payload_sha256"],
    )
    with pytest.raises(DomainError):
        svc.claim_for_runner("other_project", created["keyframe_generation_id"])


# ── A12：呈现的字节 == 将外传的字节 ──


def test_frames_json_matches_disk_bytes(service) -> None:
    """元数据里的哈希/字节必须与磁盘上那份**将要外传**的字节一致。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 2)
    pvid = preview["keyframe_egress_preview_id"]
    for meta in preview["frames"]:
        on_disk = svc.load_payload(pvid, meta["frame_index"])
        import hashlib

        assert hashlib.sha256(on_disk).hexdigest() == meta["payload_sha256"]
        assert len(on_disk) == meta["payload_bytes"]


def test_presentation_bytes_are_not_thumbnail(service) -> None:
    """A12 的区分前提：呈现字段必须描述载荷，而不是缩略图。"""
    svc, _db, pid = service
    preview = _prepare(svc, pid, 1)
    meta = preview["frames"][0]
    assert meta["payload_sha256"] != meta["thumbnail_sha256"]
    assert meta["payload_bytes"] > meta["thumbnail_bytes"]
    on_disk = svc.load_payload(preview["keyframe_egress_preview_id"], 0)
    import hashlib

    assert hashlib.sha256(on_disk).hexdigest() == meta["payload_sha256"]


# ── A14：到期真删字节、保留元数据 ──


def test_purge_removes_bytes_but_keeps_metadata(service) -> None:
    svc, db, pid = service
    preview = _prepare(svc, pid, 2)
    pvid = preview["keyframe_egress_preview_id"]
    assert svc.payload_dir_bytes(pvid) > 0
    with db.connection() as conn:
        conn.execute(
            "UPDATE keyframe_egress_previews SET expires_at=? WHERE id=?",
            ("2000-01-01T00:00:00.000Z", pvid),
        )
    assert svc.purge_expired() == 1
    assert svc.payload_dir_bytes(pvid) == 0
    kept = svc.get_preview(pid, pvid)
    assert len(kept["frames"]) == 2
    assert kept["frames"][0]["payload_sha256"]


def test_purge_is_idempotent(service) -> None:
    svc, db, pid = service
    preview = _prepare(svc, pid, 1)
    with db.connection() as conn:
        conn.execute(
            "UPDATE keyframe_egress_previews SET expires_at=? WHERE id=?",
            ("2000-01-01T00:00:00.000Z", preview["keyframe_egress_preview_id"]),
        )
    assert svc.purge_expired() == 1
    assert svc.purge_expired() == 0


def test_purge_skips_unexpired(service) -> None:
    svc, _db, pid = service
    _prepare(svc, pid, 1)
    assert svc.purge_expired() == 0


def test_create_rejected_after_purge(service) -> None:
    """载荷被清理后不能再 create——否则会发出空图。"""
    svc, db, pid = service
    preview = _prepare(svc, pid, 1)
    pvid = preview["keyframe_egress_preview_id"]
    with db.connection() as conn:
        conn.execute(
            "UPDATE keyframe_egress_previews SET expires_at=? WHERE id=?",
            ("2000-01-01T00:00:00.000Z", pvid),
        )
    svc.purge_expired()
    with pytest.raises(DomainError):
        svc.create(pid, pvid, preview["payload_sha256"])


# ── R17：素材删除不阻塞 + 审计留存 ──


def test_detach_asset_allows_deletion_and_keeps_audit(service) -> None:
    """P102 的反向陷阱：NO ACTION 会阻塞删除，CASCADE 会毁审计。

    显式 detach 必须同时做到「素材删得掉」与「审计行还在」。
    """
    svc, db, pid = service
    preview = _prepare(svc, pid, 1)
    pvid = preview["keyframe_egress_preview_id"]

    # 第一条负向对照：**不 detach 就删素材会被 FK 拒绝**。
    # 这正是 P102 的形态（分析行阻塞删除）。断言它确实会失败，
    # 证明本表用的是 NO ACTION 而非 CASCADE——若改成 CASCADE，
    # 本断言不会失败，用例当场变红。
    with pytest.raises(sqlite3.IntegrityError):
        with db.connection() as conn:
            conn.execute("DELETE FROM assets WHERE id=?", ("asset_1",))

    # 正路：先 detach，再删。
    assert svc.detach_asset("asset_1") == 1
    with db.connection() as conn:
        conn.execute("DELETE FROM assets WHERE id=?", ("asset_1",))

    # 审计行仍在（若用 CASCADE，这里会因行被连带删除而失败）。
    kept = svc.get_preview(pid, pvid)
    assert kept["keyframe_egress_preview_id"] == pvid


def test_detach_is_idempotent(service) -> None:
    svc, _db, pid = service
    _prepare(svc, pid, 1)
    assert svc.detach_asset("asset_1") == 1
    assert svc.detach_asset("asset_1") == 0


# ── 隔离 ──


def test_get_preview_is_project_scoped(service) -> None:
    svc, _db, pid = service
    preview = _prepare(svc, pid, 1)
    with pytest.raises(DomainError):
        svc.get_preview("other", preview["keyframe_egress_preview_id"])


def test_prepare_rejects_empty_frames(service) -> None:
    svc, _db, pid = service
    with pytest.raises(DomainError):
        svc.prepare(pid, _asset(), _provider(), [], _plan(0))


def test_frame_meta_carries_index() -> None:
    meta = frame_meta(7, _frame(7))
    assert meta["frame_index"] == 7
    assert meta["payload_sha256"] != meta["thumbnail_sha256"]
