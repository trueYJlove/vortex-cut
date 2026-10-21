"""W3.3 R17：素材删除 × 关键帧外传预览（P102 反向陷阱的真实路径回归）。

背景（实测复现，2026-10-21）：`keyframe_egress_previews.asset_id` 对 `assets`
是 ON DELETE **NO ACTION**，而 `KeyframeEgressService.detach_asset()` 全仓零调用方。
结果：做过一次关键帧预览的素材，`delete_asset` 返回
`ASSET_IN_USE | 素材被镜头需求或生成记录引用，无法删除`——原因错（真正的原因是外传预览行），
且**没有出路**（用户没有任何界面能断开这条引用）。这是 P102 原样重演。

为什么既有用例没有抓住它：`test_keyframe_egress.py::
test_detach_asset_allows_deletion_and_keeps_audit` **直接调用** `svc.detach_asset()`
再手工 `DELETE FROM assets`，绕过了 `delete_asset`——被测的是 detach 自己，
而不是「删除素材时会不会有人调 detach」。那是假绿。

本文件只走真实 `ProjectAssetService.delete_asset` 路径。

负向对照：把 `delete_asset` 里的 `detach_keyframe_previews` 调用去掉（或把
`_wire_projects` 的注入置 None）⇒
`test_delete_asset_detaches_keyframe_preview` 红，报
`DomainError: ASSET_IN_USE | 素材被镜头需求或生成记录引用，无法删除`。
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from aivs_core.database import Database, utc_now
from aivs_core.keyframe_egress import KeyframeEgressService
from aivs_core.media.keyframe_encode import EncodedFrame
from aivs_core.media.keyframe_sampling import MODE_SCENE_CUT, SamplingPlan
from aivs_core.projects import ProjectAssetService

PROJECT_ID = "p_detach"
ASSET_ID = "a_detach"


async def _stub_probe(*args, **kwargs) -> dict:  # pragma: no cover - 本用例不探测
    return {}


def _frame(index: int) -> EncodedFrame:
    data = f"payload-{index}".encode() * 10
    thumb = f"thumb-{index}".encode() * 2
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


def _seed(tmp_path: Path) -> tuple[Database, KeyframeEgressService]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    now = utc_now()
    with db.connection() as con:
        con.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (PROJECT_ID, "删除测试", "active", "{}", str(tmp_path), "r", now, now, now),
        )
        con.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ASSET_ID, PROJECT_ID, "video", "external", "a.mp4", "fp_x", 100,
             "available", now, now),
        )
        con.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("prov_x", "openai_compatible_text", "P", "https://x", "m", 1, now, now),
        )
    return db, KeyframeEgressService(db, cache_root=tmp_path / "cache")


def _make_preview(egress: KeyframeEgressService, tmp_path: Path) -> str:
    frames = [_frame(0), _frame(1)]
    plan = SamplingPlan(
        tuple((i * 1_000_000, "scene_cut") for i in range(2)),
        MODE_SCENE_CUT, 2, 2, True,
    )
    preview = egress.prepare(
        PROJECT_ID, {"id": ASSET_ID, "fingerprint": "fp_x"},
        {"provider_config_id": "prov_x", "model": "vision-1"}, frames, plan,
    )
    return preview["keyframe_egress_preview_id"]


def _wired_service(db: Database, egress: KeyframeEgressService, tmp_path: Path,
                   *, with_detach: bool = True,) -> ProjectAssetService:
    """按 `_wire_projects` 的真实形状装配（同一注入点、同一回调）。"""
    return ProjectAssetService(
        db, tmp_path, _stub_probe,
        detach_keyframe_previews=(
            (lambda conn, asset_id: egress.detach_asset(asset_id, conn))
            if with_detach else None
        ),
    )


def test_delete_asset_detaches_keyframe_preview(tmp_path: Path) -> None:
    """素材删得掉，外传审计行留着，且 detach 有审计时刻。"""
    db, egress = _seed(tmp_path)
    preview_id = _make_preview(egress, tmp_path)
    service = _wired_service(db, egress, tmp_path)

    service.delete_asset(ASSET_ID)

    with db.connection() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM assets WHERE id=?", (ASSET_ID,)
        ).fetchone()[0] == 0, "素材行必须真的删掉"
        row = con.execute(
            "SELECT asset_id, detached_at FROM keyframe_egress_previews WHERE id=?",
            (preview_id,),
        ).fetchone()
    assert row is not None, "外传审计行不得随素材消失（CASCADE 会毁审计）"
    assert row["asset_id"] is None, "引用必须断开，否则 FK 应已拒绝删除"
    assert row["detached_at"], "detach 必须留时刻，否则审计无法回答何时断开"


def test_delete_asset_without_detach_wiring_is_refused(tmp_path: Path) -> None:
    """负向对照的**常驻版本**：不注入 detach 回调 ⇒ 删除被 FK 拒绝。

    它锁住的是这条推论：本用例绿，说明上一条用例的绿**只可能**来自 detach；
    否则「删得掉」这件事就无法与「这张表本来是 NO ACTION」区分开。
    """
    db, egress = _seed(tmp_path)
    _make_preview(egress, tmp_path)
    service = _wired_service(db, egress, tmp_path, with_detach=False)

    with pytest.raises(Exception) as raised:
        service.delete_asset(ASSET_ID)
    assert getattr(raised.value, "code", None) == "ASSET_IN_USE"
    with db.connection() as con:
        assert con.execute(
            "SELECT COUNT(*) FROM assets WHERE id=?", (ASSET_ID,)
        ).fetchone()[0] == 1, "被拒时素材行必须保留（半删状态不可接受）"


def test_detach_is_idempotent(tmp_path: Path) -> None:
    db, egress = _seed(tmp_path)
    _make_preview(egress, tmp_path)
    assert egress.detach_asset(ASSET_ID) == 1
    assert egress.detach_asset(ASSET_ID) == 0


def test_detach_leaves_other_assets_untouched(tmp_path: Path) -> None:
    """只断开该素材的引用：detach 的 WHERE 若不限定 asset_id，会波及全局。"""
    db, egress = _seed(tmp_path)
    preview_id = _make_preview(egress, tmp_path)
    now = utc_now()
    with db.connection() as con:
        con.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("a_other", PROJECT_ID, "video", "external", "b.mp4", "fp_y", 100,
             "available", now, now),
        )

    egress.detach_asset("a_other")

    with db.connection() as con:
        row = con.execute(
            "SELECT asset_id FROM keyframe_egress_previews WHERE id=?", (preview_id,),
        ).fetchone()
    assert row["asset_id"] == ASSET_ID