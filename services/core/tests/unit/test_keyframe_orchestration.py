"""W3.3 S2b：编排层（读切点 / 可用性判定 / 全链路 prepare）。

覆盖点：
  1. `None`（无 CV 分析）与 `[]`（分析过无切点）的区分必须一路传到抽样
  2. 无视频流 ⇒ 拒绝，不登记必然失败的作业（P76）
  3. 从计划 → 编码 → 落预览的端到端链路（真实 ffmpeg，真机素材）
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from aivs_core.database import Database, utc_now
from aivs_core.keyframe_egress import KeyframeEgressService
from aivs_core.keyframe_orchestration import (
    KeyframeOrchestrator,
    ensure_video_asset,
    plan_for_asset,
    scene_cut_timestamps,
)
from aivs_core.media.cv_signals import CV_ALGORITHM_VERSION
from aivs_core.media.keyframe_sampling import MODE_INTERVAL_ONLY, MODE_SCENE_CUT
from aivs_core.projects import DomainError

FFMPEG = Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe"


@pytest.fixture
def env(tmp_path: Path):
    db = Database(tmp_path / "test.db")
    db.initialize()
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("proj_1", "P", "active", "{}", None, "C:/tmp/p", "p", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,"
            "fingerprint,size_bytes,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("asset_1", "proj_1", "video", "external", "a.mp4",
             "fp_1", 100, "available", now, now),
        )
        conn.execute(
            "INSERT INTO provider_configs (id,kind,display_name,base_url,model,"
            "enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            ("prov_1", "openai_compatible_text", "P", "https://x", "m", 1, now, now),
        )
    svc = KeyframeEgressService(db, cache_root=tmp_path / "cache")
    yield db, svc, tmp_path


def _insert_analysis(db: Database, cut_times: list[int], *, status: str = "ready") -> None:
    now = utc_now()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO cv_analyses (id,asset_id,source_fingerprint,algorithm_version,"
            "status,model_revision,sample_count,scene_cut_count,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("cva_1", "asset_1", "fp_1", CV_ALGORITHM_VERSION, status,
             None, len(cut_times), len(cut_times), now, now),
        )
        for index, ts in enumerate(cut_times):
            conn.execute(
                "INSERT INTO cv_samples (id,analysis_id,sample_index,timestamp_us,"
                "scene_cut,motion_energy,sharpness,brightness) VALUES (?,?,?,?,?,?,?,?)",
                (f"s{index}", "cva_1", index, ts, 1, 0.5, 0.5, 0.5),
            )


# ── 切点读取的三种语义 ──


def test_no_analysis_returns_none(env) -> None:
    """没分析过 ⇒ None（不是空列表）。这个区分是全包降级诚实性的根。"""
    db, _svc, _tmp = env
    assert scene_cut_timestamps(db, "asset_1") is None


def test_analysis_without_cuts_returns_empty_list(env) -> None:
    """分析过但无切点 ⇒ []（与 None 必须是两种状态）。"""
    db, _svc, _tmp = env
    _insert_analysis(db, [])
    assert scene_cut_timestamps(db, "asset_1") == []


def test_analysis_with_cuts_returns_sorted_times(env) -> None:
    db, _svc, _tmp = env
    _insert_analysis(db, [5_000_000, 1_000_000])
    assert scene_cut_timestamps(db, "asset_1") == [1_000_000, 5_000_000]


def test_non_ready_analysis_is_ignored(env) -> None:
    """running/failed 的分析不算数 ⇒ 降级为 None。"""
    db, _svc, _tmp = env
    _insert_analysis(db, [1_000_000], status="running")
    assert scene_cut_timestamps(db, "asset_1") is None


# ── 计划层把语义透传下去 ──


def test_plan_mode_interval_only_without_analysis(env) -> None:
    db, _svc, _tmp = env
    plan, cuts = plan_for_asset(db, "asset_1", 10_000_000)
    assert cuts is None
    assert plan.sampling_mode == MODE_INTERVAL_ONLY


def test_plan_mode_scene_cut_when_analysed_without_cuts(env) -> None:
    """分析过无切点 ⇒ 仍是 scene_cut 模式（不得伪装成 interval_only）。"""
    db, _svc, _tmp = env
    _insert_analysis(db, [])
    plan, cuts = plan_for_asset(db, "asset_1", 10_000_000)
    assert cuts == []
    assert plan.sampling_mode == MODE_SCENE_CUT
    assert plan.covered_scene_cuts == 0


def test_plan_covers_cuts(env) -> None:
    db, _svc, _tmp = env
    _insert_analysis(db, [1_000_000, 3_000_000, 5_000_000])
    plan, _cuts = plan_for_asset(db, "asset_1", 10_000_000)
    assert plan.covered_scene_cuts == 3
    cut_frames = [t for t, r in plan.frames if r == "scene_cut"]
    assert cut_frames == [1_000_000, 3_000_000, 5_000_000]


# ── 可用性判定（P76：不登记必然失败的作业）──


def test_ensure_rejects_audio_asset() -> None:
    """纯音频素材不得进入抽帧链路（P76 的同类：路由只看有音轨就放行过）。"""
    with pytest.raises(DomainError):
        ensure_video_asset({"kind": "audio", "availability": "available"})


def test_ensure_rejects_unavailable_asset() -> None:
    with pytest.raises(DomainError):
        ensure_video_asset({"kind": "video", "availability": "missing"})


def test_ensure_accepts_available_video() -> None:
    ensure_video_asset({"kind": "video", "availability": "available"})


# ── 端到端（真实 ffmpeg）──


@pytest.mark.skipif(not FFMPEG.exists(), reason="随包 ffmpeg 不在预期位置")
@pytest.mark.asyncio
async def test_full_prepare_chain_end_to_end(env) -> None:
    """读切点 → 计划 → 真实编码 → 落预览，整条零网络链路。"""
    db, egress, tmp = env
    _insert_analysis(db, [1_000_000, 2_000_000])
    video = tmp / "src.mp4"
    process = await asyncio.create_subprocess_exec(
        str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=640x360:duration=4:rate=4",
        "-c:v", "libopenh264", "-pix_fmt", "yuv420p", str(video),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await process.communicate()
    assert video.exists()

    orchestrator = KeyframeOrchestrator(db, egress, FFMPEG)
    preview = await orchestrator.prepare_preview(
        "proj_1",
        {"id": "asset_1", "fingerprint": "fp_1", "kind": "video", "availability": "available"},
        {"provider_config_id": "prov_1", "model": "vision-1"},
        video,
        4_000_000,
    )
    assert preview["sampling_mode"] == MODE_SCENE_CUT
    assert preview["covered_scene_cuts"] == 2
    assert len(preview["frames"]) > 0
    assert preview["total_frame_bytes"] > 0
    # 每帧都有两套字节，且载荷大于缩略图
    for meta in preview["frames"]:
        assert meta["payload_bytes"] > meta["thumbnail_bytes"]
        assert meta["payload_sha256"] != meta["thumbnail_sha256"]
    # 载荷真的落盘了
    pvid = preview["keyframe_egress_preview_id"]
    assert egress.payload_dir_bytes(pvid) > 0


@pytest.mark.asyncio
async def test_prepare_rejects_zero_duration(env) -> None:
    db, egress, _tmp = env
    orchestrator = KeyframeOrchestrator(db, egress, FFMPEG)
    with pytest.raises(DomainError):
        await orchestrator.prepare_preview(
            "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
            {"provider_config_id": "prov_1"}, Path("x.mp4"), 0,
        )


@pytest.mark.asyncio
async def test_prepare_rejects_missing_provider(env) -> None:
    db, egress, _tmp = env
    orchestrator = KeyframeOrchestrator(db, egress, FFMPEG)
    with pytest.raises(DomainError):
        await orchestrator.prepare_preview(
            "proj_1", {"id": "asset_1", "fingerprint": "fp_1"},
            {}, Path("x.mp4"), 1_000_000,
        )
