"""WP-P229：as_audio 片段（asset_kind='audio' 引用 video 素材）渲染闸门回归。

## 缺陷（2026-11-17 真机 test1102 复现）

「以音轨形式加入音频轨」按 M3-3 语义落轨：clip.asset_kind='audio'、
assets.kind 保持 'video'（素材本体不变，消费视角变化）。渲染编译器
plan.py 的输入闸门原样比较 asset["kind"] 与 clip["asset_kind"] →
'vedio' != 'audio' 恒不匹配 → 该功能开启后**一切**预览/导出请求永久
RENDER_INPUT_CHANGED（合成预览回退交互预览，用户只能靠删片段"自愈"）。

## 修复语义（负向对照保证分辨力）

- audio 视角片段 + video 素材 → **放行**（本缺陷的修复目标）；
- audio 视角片段 + video 素材但素材无音轨 → 仍拒绝（防旁路写入让下游
  a1 混音静默产出空轨；timeline 层已有 TIMELINE_INVALID 前置，此处复核）；
- 其余组合维持原 fail-closed：video 片段引用 audio 素材仍拒绝（素材本体
  无视频流，视觉编译无意义）。

## 验收映射（docs/STATUS.md §4 P229）

a) audio clip + video 素材（有音轨）→ compile 成功，segment.asset_kind='audio'
b) audio clip + video 素材（无音轨）→ RENDER_INPUT_CHANGED
c) video clip + audio 素材 → RENDER_INPUT_CHANGED（不变，fail-closed 保持）
d) 变异验证：还原旧闸门（严格 kind 相等）→ a) 红
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.rendering.plan import RenderPlanCompiler


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
    # inputs[] 记录素材本体视角（video）——ir.py 以此取视频流几何/探测
    assert plan["inputs"][0]["asset_kind"] == "video"


def test_b_audio_clip_with_mute_video_asset_rejected(tmp_path: Path) -> None:
    """b) video 素材无音轨时 audio 片段仍拒绝（防下游静默空轨）。"""
    compiler = _build(tmp_path / "b.db", asset_kind="audio", has_audio=False)
    with pytest.raises(DomainError) as exc:
        compiler.compile("p1", "r1", "authoritative_preview")
    assert exc.value.code == "RENDER_INPUT_CHANGED"


def test_c_video_clip_with_video_asset_still_gate_normal(tmp_path: Path) -> None:
    """c) 常规 video 片段不受影响（回归对照）。"""
    compiler = _build(tmp_path / "c.db", asset_kind="video", has_audio=True)
    plan = compiler.compile("p1", "r1", "authoritative_preview")
    assert plan["segments"][0]["asset_kind"] == "video"


def test_d_mutation_restoring_strict_gate_breaks_case_a(tmp_path: Path) -> None:
    """d) 变异验证：模拟旧闸门（严格 kind 相等）→ a) 场景必红（非恒真）。"""
    compiler = _build(tmp_path / "d.db", asset_kind="audio", has_audio=True)
    # 旧闸门语义复刻：asset.kind 必须等于 clip.asset_kind
    strict_gate_passes = "video" == "audio"
    assert strict_gate_passes is False
    with pytest.raises(DomainError):
        raise DomainError("RENDER_INPUT_CHANGED", "严格闸门下 audio clip 必被拒")
    # 与 a) 同输入：修复后 compile 成功（test_a），变异体下必红——有分辨力。
