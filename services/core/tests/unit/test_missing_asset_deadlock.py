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


def _add_cache_ref(database: Database, cache_key: str, asset_id: str, project_id: str = "p1",
                   size_bytes: int = 1024, kind: str = "waveform") -> None:
    """登记一条派生缓存实体 + 该素材对它的引用行（真实结构：refs -> cache_key 外键）。"""
    with database.connection() as db:
        # 实体按 cache_key 唯一：多素材共享同一实体 ⇒ OR IGNORE（这正是要锁的语义）
        db.execute(
            "INSERT OR IGNORE INTO derived_media_cache(cache_key,asset_fingerprint,kind,"
            "params_json,schema_version,toolchain_fingerprint,relative_path,size_bytes,status,"
            "created_at,last_accessed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (cache_key, "sha256:" + cache_key, kind, "{}", 1, "tc", "p/" + cache_key,
             size_bytes, "ready", "now", "now"),
        )
        db.execute(
            "INSERT INTO derived_media_cache_refs(cache_key,project_id,asset_id,"
            "created_at,last_accessed_at) VALUES (?,?,?,?,?)",
            (cache_key, project_id, asset_id, "now", "now"),
        )


def test_delete_missing_asset_with_derived_cache_refs(tmp_path: Path) -> None:
    """本任务动因原样：源文件缺失 + 属于某项目 + 无 jobs 行 + 有派生缓存引用。

    derived_media_cache_refs.asset_id 对 assets 是 ON DELETE NO ACTION
    （database_v18.py:27）⇒ 不清引用就撞 FK，被 delete_asset 的通用 except 报成
    「素材被镜头需求或生成记录引用」——原因错且无出路。用户真实库里 15/18 个素材
    都挂着引用行，这不是边缘情况。
    """
    database, timelines, assets, _ = _harness(tmp_path)
    _mark_missing(database, ["v2"])
    for index in range(3):
        _add_cache_ref(database, f"sha256:v2-chunk-{index}", "v2")

    with database.connection() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM derived_media_cache_refs WHERE asset_id='v2'"
        ).fetchone()[0] == 3

    counts = assets.delete_asset("v2", remove_timeline_clips=True)

    assert counts["removed_clips"] == 2
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v2'").fetchone()[0] == 0
        assert db.execute(
            "SELECT COUNT(*) FROM derived_media_cache_refs WHERE asset_id='v2'"
        ).fetchone()[0] == 0
    assert _clip_ids(timelines.get_state("p1")) == ["v1", "v3"]


def test_delete_asset_keeps_derived_cache_entities_and_other_assets_refs(tmp_path: Path) -> None:
    """只删该素材的引用行：缓存实体行与别的素材的引用必须原样保留。

    实体按资产指纹寻址、可被多素材/多项目共享；本任务只清引用（可重算的授权行），
    不回收实体行及其磁盘文件。若谁把删除写成清空 derived_media_cache，本用例立刻变红。
    """
    database, _, assets, _ = _harness(tmp_path)
    _mark_missing(database, ["v2"])
    _add_cache_ref(database, "sha256:shared", "v2")
    _add_cache_ref(database, "sha256:shared", "v1")
    _add_cache_ref(database, "sha256:v2-only", "v2")

    assets.delete_asset("v2", remove_timeline_clips=True)

    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM derived_media_cache_refs WHERE asset_id='v2'"
                          ).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM derived_media_cache_refs WHERE asset_id='v1'"
                          ).fetchone()[0] == 1
        keys = {r[0] for r in db.execute("SELECT cache_key FROM derived_media_cache")}
        assert keys == {"sha256:shared", "sha256:v2-only"}


def test_derived_cache_refs_do_not_bypass_business_record_protection(tmp_path: Path) -> None:
    """清引用不得顺带放宽业务保护：有非 proxy 作业行时仍须拒绝删除。

    与 test_non_proxy_job_still_blocks_asset_delete 的区别是同时存在派生缓存引用
    ——锁住「清了引用就以为能删」这个新引入的误判。
    """
    database, _, assets, _ = _harness(tmp_path)
    _add_cache_ref(database, "sha256:v2-chunk", "v2")
    _add_job(database, "job-export", "v2", "final_export")

    with pytest.raises(DomainError) as exc:
        assets.delete_asset("v2", remove_timeline_clips=True)

    assert exc.value.code == "ASSET_IN_USE"
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM assets WHERE id='v2'").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM jobs WHERE id='job-export'").fetchone()[0] == 1


def test_delete_asset_rolls_back_cache_refs_when_business_record_blocks(tmp_path: Path) -> None:
    """拒绝删除时必须整体回滚：引用行不能被先删掉一半而留下半删状态。"""
    database, _, assets, _ = _harness(tmp_path)
    _add_cache_ref(database, "sha256:v2-chunk", "v2")
    _add_job(database, "job-export", "v2", "final_export")

    with pytest.raises(DomainError):
        assets.delete_asset("v2", remove_timeline_clips=True)

    with database.connection() as db:
        assert db.execute(
            "SELECT COUNT(*) FROM derived_media_cache_refs WHERE asset_id='v2'"
        ).fetchone()[0] == 1, "被业务记录拒绝后引用行必须回滚"

