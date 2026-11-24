"""P229 as_audio 素材类型回归，扩展覆盖 P235 audio-only video。

P229 修复了 audio-role TimelineClip 引用 video asset 时 RenderPlan 对比素材类型
导致的错误拒绝。P235 进一步要求无音轨视频也可被 Replace 到音轨：保留时间段、
`audio_enabled=true`，但 `audio_required=false`、`has_audio=false`，由静音占位输出；
这种 audio-only video 不触发视觉几何、预览解码或 original-resolution 选源。
普通 video-role clip 引用 audio asset 仍 fail-closed。
"""
from __future__ import annotations

import json
from pathlib import Path

from aivs_core.database import Database, json_dumps
from aivs_core.rendering.plan import RenderPlanCompiler
from aivs_core.rendering.ir import project_preview_ir


def _build(db_path: Path, asset_kind: str, has_audio: bool) -> RenderPlanCompiler:
    database = Database(db_path)
    database.initialize()
    document = {
        "schema_version": 1,
        "project_id": "p1",
        "canvas": {"width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1,
                   "background_color": "#000000"},
        "tracks": [
            {"id": "V1", "kind": "visual", "locked": False},
            {"id": "A1", "kind": "audio", "locked": False},
        ],
        "clips": [{
            "clip_id": "c1", "track_id": "A1", "order_index": 0, "asset_id": "v1",
            "asset_kind": asset_kind, "source_start_us": 0, "source_end_us": 2_000_000,
            "timeline_start_us": 0, "timeline_end_us": 2_000_000, "layout": "fit",
            "audio": {"enabled": True, "gain_db": 0.0},
        }],
        "captions": [],
        "provenance": {"created_by": "user", "source_transcript_ids": []},
    }
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','r1','root','root','now','now','now')"
        )
        # 素材行 = video（as_audio 语义下素材本体不变）
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("v1", "p1", "video", "external", "v1", "sha256:v1", 1, "available",
             json_dumps({
                 "duration_us": 2_000_000,
                 "video_streams": [{}],
                 "audio_streams": [{}] if has_audio else [],
             }), "now", "now"),
        )
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("r1", "p1", None, 1, json_dumps(document), "sha256:rev", "s", "user", "now"),
        )
    return RenderPlanCompiler(database)


def test_a_audio_clip_with_video_asset_compiles(tmp_path: Path) -> None:
    """a) audio 视角片段 + video 素材（有音轨）→ 成功；segment kind 保持 audio。"""
    compiler = _build(tmp_path / "a.db", asset_kind="audio", has_audio=True)
    plan = compiler.compile("p1", "r1", "authoritative_preview")
    segment = plan["segments"][0]
    assert segment["asset_kind"] == "audio"  # 片段消费视角不变（下游 A1 分支依赖）
    # audio-role input 保留素材本体信息，但不需要视觉解码或视频几何。
    assert plan["inputs"][0]["asset_kind"] == "video"
    assert plan["inputs"][0]["video_required"] is False
    assert plan["inputs"][0]["audio_required"] is True
    ir = project_preview_ir(plan, {"v1": {"video_streams": [], "audio_streams": [{}]}})
    assert ir["inputs"][0]["video_required"] is False
    assert ir["inputs"][0]["audio_required"] is True
    assert ir["inputs"][0]["geometry"] == {"width": 0, "height": 0, "sar": 1.0}


def test_b_audio_clip_with_mute_video_asset_compiles_to_silence(tmp_path: Path) -> None:
    """b) video 素材无音轨时保留 A1 时间范围并标记无需源音频解码。"""
    compiler = _build(tmp_path / "b.db", asset_kind="audio", has_audio=False)
    plan = compiler.compile("p1", "r1", "authoritative_preview")
    assert plan["segments"][0]["asset_kind"] == "audio"
    assert plan["segments"][0]["audio_enabled"] is True
    assert plan["segments"][0]["audio_required"] is False
    assert plan["inputs"][0]["video_required"] is False
    assert plan["inputs"][0]["audio_required"] is False
    assert plan["inputs"][0]["has_audio"] is False


def test_c_video_clip_with_video_asset_still_gate_normal(tmp_path: Path) -> None:
    """c) 常规 video 片段不受影响（回归对照）。"""
    compiler = _build(tmp_path / "c.db", asset_kind="video", has_audio=True)
    plan = compiler.compile("p1", "r1", "authoritative_preview")
    assert plan["segments"][0]["asset_kind"] == "video"


def test_d_audio_only_video_does_not_raise_original_resolution(tmp_path: Path) -> None:
    """d) audio-only video source dimensions do not affect original resolution."""
    compiler = _build(tmp_path / "d.db", asset_kind="audio", has_audio=True)
    with compiler.database.connection() as db:
        db.execute(
            "UPDATE assets SET media_info_json=? WHERE id='v1'",
            (json_dumps({
                "duration_us": 2_000_000,
                "video_streams": [{"width": 7680, "height": 4320}],
                "audio_streams": [{}],
            }),),
        )
    plan = compiler.compile("p1", "r1", "final_export", resolution="original")
    assert (plan["output"]["width"], plan["output"]["height"]) == (1080, 1920)
    assert plan["inputs"][0]["video_required"] is False
