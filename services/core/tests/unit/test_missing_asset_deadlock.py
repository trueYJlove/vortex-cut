"""缺失素材死锁（2026-10 事故）回归锁。

TIMELINE_SOURCE_INVALID 素材不可用于 Timeline

本文件锁三件事：
1. 素材缺失时，删除既有片段必须成功——这是唯一能自救的操作；
2. 素材缺失时，级联删素材必须成功；
3. 新增引用不可用素材必须仍被拒（fail-closed 安全属性，不可放松）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError, ProjectAssetService
from aivs_core.timeline import TimelineService


def _patch(timelines: TimelineService, state: dict, operations: list[dict]) -> dict:
    return timelines.patch(
        "p1",
        {
            "schema_version": 1,
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "operations": operations,
            "summary": "修改",
        },
    )


def _harness(tmp_path: Path):
    asset_ids = ("v1", "v2", "v3")
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "缺失素材", "active", "{}", str(tmp_path), "r", "now", "now", "now"),
        )
        for asset_id in asset_ids:
            media = {"duration_us": 5000000, "video_streams": [{}], "audio_streams": []}
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (asset_id, "p1", "video", "external", "显示名-" + asset_id, "fp-" + asset_id,
                 1, "available", json_dumps(media), "now", "now"),
            )
    timelines = TimelineService(database)
    state = timelines.create(
        "p1",
        {
            "schema_version": 1,
            "source": {"kind": "empty"},
            "default_layout": "blurred_background",
            "caption_preset_id": "default-bottom",
        },
    )
    for index, asset_id in enumerate(asset_ids):
        state = _patch(
            timelines, state, [{"op": "insert_asset_clip", "asset_id": asset_id, "at_index": index}]
        )
    assets = ProjectAssetService(database, tmp_path, lambda *args, **kwargs: None)
    assets.purge_asset_clips = timelines.purge_asset_clips
    return database, timelines, assets, state


def _mark_missing(database, asset_ids):
    with database.connection() as db:
        for asset_id in asset_ids:
            db.execute("UPDATE assets SET availability=? WHERE id=?", ("missing", asset_id))


def _clip_ids(state):
    return [clip["asset_id"] for clip in state["current_revision"]["document"]["clips"]]


def test_remove_healthy_clip_while_another_asset_is_missing(tmp_path: Path) -> None:
    """删一个**可用**素材的片段时，另一个缺失素材仍被引用也不得挡路。

    这条才有区分力：删缺失素材**自己**的片段在修复前就能过（删掉后文档里已无
    该引用）。真正被卡死的是「文档里还有别处引用着缺失素材，我想删的却是另一条
    片段」——校验遍历全部 clip，撞上缺失素材就整体拒绝。
    """
    database, timelines, _, state = _harness(tmp_path)
    _mark_missing(database, ["v3"])
    clips = state["current_revision"]["document"]["clips"]

    # 删 v1 的片段（v1 可用），而 v3 的片段仍然留在文档里。
    next_state = _patch(timelines, state, [{"op": "remove_clip", "clip_id": clips[0]["clip_id"]}])

    assert _clip_ids(next_state) == ["v2", "v3"]


def test_remove_healthy_clips_with_two_missing_assets(tmp_path: Path) -> None:
    """两个素材同时缺失（本次事故原样）：删可用素材的片段，逐次都不得被拒。"""
    database, timelines, _, state = _harness(tmp_path)
    _mark_missing(database, ["v2", "v3"])
    clips = state["current_revision"]["document"]["clips"]

    state = _patch(timelines, state, [{"op": "remove_clip", "clip_id": clips[0]["clip_id"]}])
    state = _patch(timelines, state, [{"op": "remove_clip", "clip_id": clips[1]["clip_id"]}])

    assert _clip_ids(state) == ["v3"]


def test_delete_asset_cascade_succeeds_when_asset_file_missing(tmp_path: Path) -> None:
    """级联删素材：素材文件已缺失时，带 remove_timeline_clips=true 必须能删掉。"""
    database, timelines, assets, _ = _harness(tmp_path)
    _mark_missing(database, ["v2"])

    counts = assets.delete_asset("v2", remove_timeline_clips=True)

    # removed_clips 统计的是**所有 Revision 历史**中被清掉的片段：v2 出现在
    # 「加入 v2」与「v2 之后」两个 Revision 里，故为 2。
    assert counts["removed_clips"] == 2
    with database.connection() as db:
        left = db.execute("SELECT COUNT(*) FROM assets WHERE id=?", ("v2",)).fetchone()[0]
    assert left == 0
    assert _clip_ids(timelines.get_state("p1")) == ["v1", "v3"]


def test_new_reference_to_unavailable_asset_still_rejected(tmp_path: Path) -> None:
    """fail-closed 未放松：新增 clip 引用不可用素材必须仍被拒绝。"""
    database, timelines, _, state = _harness(tmp_path)
    _mark_missing(database, ["v3"])
    clips = state["current_revision"]["document"]["clips"]

    with pytest.raises(DomainError) as exc:
        _patch(
            timelines,
            state,
            [
                {"op": "remove_clip", "clip_id": clips[2]["clip_id"]},
                {"op": "insert_asset_clip", "asset_id": "v3", "at_index": 2},
            ],
        )

    assert exc.value.code == "TIMELINE_SOURCE_INVALID"
    # 报错必须点名是哪条素材：多个素材时用户才知道该恢复哪个文件。
    assert "v3" in exc.value.message
    assert "显示名-v3" in exc.value.message


def test_draft_save_stays_strict_without_base_document(tmp_path: Path) -> None:
    """收窄而非关掉：没有基线文档的路径（save_draft）保持原有严格行为。

    放行条件需要「该 clip 在基线里已存在且 asset_id 未变」这一事实；save_draft
    不提供基线，因此素材不可用时仍必须拒绝——否则就是整条校验被关掉。
    """
    database, timelines, _, state = _harness(tmp_path)
    _mark_missing(database, ["v3"])

    with pytest.raises(DomainError) as exc:
        timelines.save_draft(
            "p1",
            {
                "schema_version": 1,
                "base_revision_id": state["current_revision"]["timeline_revision_id"],
                "document": state["current_revision"]["document"],
            },
        )

    assert exc.value.code == "TIMELINE_SOURCE_INVALID"
    assert "显示名-v3" in exc.value.message


def _add_job(database: Database, job_id: str, asset_id: str, kind: str) -> None:
    with database.connection() as db:
        db.execute(
            "INSERT INTO jobs(id,project_id,asset_id,kind,type,status,input_json,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (job_id, "p1", asset_id, kind, kind, "succeeded", "{}", "now", "now"),
        )


def test_delete_asset_clears_derived_proxy_job_rows(tmp_path: Path) -> None:
    """导入视频会自动登记 kind='proxy' 作业行；它撞 assets 的 NO ACTION 外键，

    不清就删不掉素材（2026-10 事故的第二条死锁）。代理是可重算派生数据，
    与 beat_grids / cv_analyses 同口径清理。
    """
    database, timelines, assets, _ = _harness(tmp_path)
    _mark_missing(database, ["v2"])
    _add_job(database, "job-proxy", "v2", "proxy")

    counts = assets.delete_asset("v2", remove_timeline_clips=True)

    assert counts["removed_clips"] == 2
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v2'").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE id='job-proxy'").fetchone()[0] == 0
    assert _clip_ids(timelines.get_state("p1")) == ["v1", "v3"]


def test_non_proxy_job_still_blocks_asset_delete(tmp_path: Path) -> None:
    """防线（改动前后都必须绿）：非 proxy 作业是业务记录，删素材仍须被拒。

    若谁把清理放宽成「删掉该素材的所有 jobs 行」，本用例立刻变红。
    """
    database, _, assets, _ = _harness(tmp_path)
    _add_job(database, "job-export", "v2", "final_export")

    with pytest.raises(DomainError) as exc:
        assets.delete_asset("v2", remove_timeline_clips=True)

    assert exc.value.code == "ASSET_IN_USE"
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v2'").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE id='job-export'").fetchone()[0] == 1

def _insert_job(database, asset_id: str, kind: str) -> None:
    with database.connection() as db:
        db.execute(
            "INSERT INTO jobs(id,project_id,asset_id,kind,type,status,progress,"
            "input_json,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("job-" + kind + "-" + asset_id, "p1", asset_id, kind, kind, "succeeded", 1,
             "{}", 1, "now", "now"),
        )


def test_delete_asset_succeeds_with_derived_proxy_job(tmp_path: Path) -> None:
    """每次视频导入都会自动登记一条 kind='proxy' 作业（preview_source.create_proxy_job）。

    jobs.asset_id 由 v2 兼容迁移 ALTER 补列，对 assets 是 NO ACTION ⇒ 不清就撞 FK，
    被通用 except 报成「素材被镜头需求或生成记录引用」——原因错且无出路。
    代理是可重算派生数据，与 beat_grids/cv_analyses 同口径清理。
    """
    database, _timelines, assets, state = _harness(tmp_path)
    _insert_job(database, "v3", "proxy")
    _mark_missing(database, ["v3"])
    counts = assets.delete_asset("v3", remove_timeline_clips=True)
    assert counts["removed_clips"] == 1
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v3'").fetchone()[0] == 0
        # 派生 proxy 作业随素材一并清理，不留孤儿行。
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE asset_id='v3'").fetchone()[0] == 0


def test_business_job_still_blocks_asset_delete(tmp_path: Path) -> None:
    """非 proxy 的作业是业务记录（生成/导出），删素材时必须仍被拒绝。

    这条不是回归锁而是防线：它用来证明上面那条 proxy 清理没有放宽到全部 kind。
    """
    database, _timelines, assets, state = _harness(tmp_path)
    _insert_job(database, "v3", "final_export")
    _mark_missing(database, ["v3"])
    with pytest.raises(DomainError) as excinfo:
        assets.delete_asset("v3", remove_timeline_clips=True)
    assert excinfo.value.code == "ASSET_IN_USE"
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v3'").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE asset_id='v3'").fetchone()[0] == 1
