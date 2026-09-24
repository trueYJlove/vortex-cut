from __future__ import annotations  # noqa: I001

import asyncio
import hashlib
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import (
    CV_SAMPLE_GAP_FALLBACK_US,
    CvSignalService,
    analyze_video,
    cv_video_args,
)

FFMPEG = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe")
FFPROBE = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffprobe.exe")


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


def _synthetic_two_scene_video(path: Path) -> None:
    """3 秒 30fps 合成视频：前 1.5s 灰场、后 1.5s 亮场（强制 I 帧）。"""
    args = [
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", "color=c=0x202020:s=320x180:r=30:d=1.5",
        "-f", "lavfi",
        "-i", "color=c=0xd0d0d0:s=320x180:r=30:d=1.5",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map", "[v]",
        "-g", "15",  # GOP 15（0.5s）：保证两场内各有 I 帧
        "-c:v", "mpeg4",  # 打包 ffmpeg 无 libx264；mpeg4 同样支持 GOP/关键帧
        "-pix_fmt", "yuv420p",
        str(path),
    ]
    subprocess.run(args, check=True, capture_output=True)


def _synthetic_long_gop_video(path: Path, *, duration_s: int = 12, gop_s: int = 6) -> None:
    """长 GOP 合成视频：单色场（无场景切换 → 无额外关键帧），强制 I 帧间隔 = gop_s。

    默认 12s / GOP 6s：I 帧落在 t=0 与 t=6，最大采样间隔 6s > 回退阈值（4s）。
    """
    args = [
        str(FFMPEG), "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", f"color=c=0x303030:s=320x180:r=30:d={duration_s}",
        "-g", str(gop_s * 30),
        "-c:v", "mpeg4",
        "-pix_fmt", "yuv420p",
        str(path),
    ]
    subprocess.run(args, check=True, capture_output=True)


def _sample_output_bytes(media: Path, *, skip_frame: bool) -> bytes:
    """按生产参数跑一遍采样遍历，返回 rawvideo stdout 原始字节。"""
    args = [str(FFMPEG), *cv_video_args(str(media), skip_frame=skip_frame)]
    proc = subprocess.run(args, capture_output=True, check=True)
    return proc.stdout


def _max_gap_us(samples: list[dict[str, Any]]) -> int:
    return max(
        (b["timestamp_us"] - a["timestamp_us"]
         for a, b in zip(samples, samples[1:])),
        default=0,
    )


def _ffprobe_stub() -> Any:
    class _Probe:
        async def probe(self, path: Path) -> dict[str, Any]:
            return {"video_streams": [{}], "audio_streams": []}

    return _Probe()


def _service(tmp_path: Path) -> tuple[CvSignalService, Database]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available',"
            "'{}','now','now')"
        )
    return CvSignalService(db, FFMPEG, _ffprobe_stub()), db


def test_real_cv_analysis_detects_scene_cut_and_timestamps(tmp_path: Path) -> None:
    _require_ffmpeg()
    service, db = _service(tmp_path)
    media = tmp_path / "two-scene.mp4"
    _synthetic_two_scene_video(media)
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event()
    ))
    assert result["status"] == "ready"
    assert result["sample_count"] >= 3  # 3s + GOP 0.5s：至少 3-4 个 I 帧采样
    # 两场交界（~1.5s）必有一个 scene_cut 采样；亮度序列前暗后亮。
    with db.connection() as conn:
        samples = conn.execute(
            "SELECT timestamp_us,scene_cut,motion_energy,sharpness,brightness "
            "FROM cv_samples WHERE analysis_id=? ORDER BY timestamp_us",
            (analysis_id,),
        ).fetchall()
    brightness = [s["brightness"] for s in samples]
    assert any(s["scene_cut"] for s in samples)
    first_half = brightness[: len(brightness) // 2]
    second_half = brightness[len(brightness) // 2:]
    assert sum(second_half) / len(second_half) > sum(first_half) / len(first_half) + 0.2
    # 时间戳单调且落在源时长内。
    timestamps = [s["timestamp_us"] for s in samples]
    assert timestamps == sorted(timestamps)
    assert 0 <= timestamps[0] and timestamps[-1] <= 3_100_000


def test_real_cv_analysis_failure_marks_row_failed(tmp_path: Path) -> None:
    _require_ffmpeg()
    service, db = _service(tmp_path)
    # 非视频文件：ffmpeg 解码失败 → 行落 failed（不冒充 ready）。
    media = tmp_path / "fake.mp4"
    media.write_bytes(b"not-a-video")
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    with pytest.raises(Exception):
        asyncio.run(service.run_analysis_job(
            {"input_json": row["input_json"]}, asyncio.Event()
        ))
    with db.connection() as conn:
        status = conn.execute(
            "SELECT status FROM cv_analyses WHERE id=?", (analysis_id,)
        ).fetchone()[0]
    assert status == "failed"
    _ = json_dumps


# ---- 规划门验收 §3.1 / §3.2 的回归锁（STATUS.md §4 承诺 P1 / P2）----
# 背景：`CV_SKIP_FRAME_PLANNING_GATE_2026-09-20` §3.1 要求"sha256 对拍锁"、
# §3.2 要求"合成长 GOP fixture 的回退触发测试"，交付时只做了人工实测、无自动化
# 用例。ADR-0005 阶段 2 将改动 `run_analysis_job` 的采样决策，故先补护栏。


def test_short_gop_fast_and_full_paths_are_byte_identical(tmp_path: Path) -> None:
    """**P1**：GOP < 采样间隔下限时，快路径与全量路径输出逐字节一致。

    成立条件：I 帧间隔（本 fixture 为 0.5s）< `MIN_SAMPLE_INTERVAL`（1.0s）——
    此时全量路径的"≥1s 兜底"子句永不额外选中帧，两条路径选出的帧集合相同。

    该锁保护的是"非回退素材上双路径等价"这一性质：任何改动若让快路径多选/少选帧
    （例如改 `select` 表达式、误让 skip_frame 影响 `scale`/像素格式），本测试红。
    """
    _require_ffmpeg()
    media = tmp_path / "short-gop.mp4"
    _synthetic_two_scene_video(media)

    fast = _sample_output_bytes(media, skip_frame=True)
    full = _sample_output_bytes(media, skip_frame=False)

    assert fast, "快路径未产出任何采样帧"
    assert hashlib.sha256(fast).hexdigest() == hashlib.sha256(full).hexdigest(), (
        "短 GOP 素材上快路径与全量路径输出不一致——双路径等价性被破坏"
    )

    # 反向对照：长 GOP 素材上两条路径**必然不同**（I 帧稀疏 vs 兜底加密）。
    # 这一条证明上面的相等断言具有区分力，而不是恒真。
    control = tmp_path / "long-gop-control.mp4"
    _synthetic_long_gop_video(control)
    control_fast = _sample_output_bytes(control, skip_frame=True)
    control_full = _sample_output_bytes(control, skip_frame=False)
    assert len(control_fast) < len(control_full), "对照素材上快路径未比全量路径稀疏"
    assert hashlib.sha256(control_fast).hexdigest() != hashlib.sha256(
        control_full
    ).hexdigest(), "长 GOP 素材上双路径输出相同——相等断言缺乏区分力"


def test_long_gop_triggers_full_decode_fallback(tmp_path: Path) -> None:
    """**P2**：长 GOP 素材触发全量解码回退，且兜底采样恢复密度。

    断言链（三者缺一即说明回退机制被破坏）：
    ① 快路径确实稀疏（最大采样间隔 > `CV_SAMPLE_GAP_FALLBACK_US`）——触发条件成立；
    ② 作业编排确实进入 `cv:video-full` 阶段——回退真的发生了；
    ③ 落库样本的最大间隔回落到达标量级——兜底采样确实恢复了密度。
    """
    _require_ffmpeg()
    media = tmp_path / "long-gop.mp4"
    _synthetic_long_gop_video(media)

    # ① 快路径（仅 I 帧）确实稀疏。
    fast_samples = asyncio.run(
        analyze_video(FFMPEG, media, asyncio.Event(), None, skip_frame=True)
    )
    assert len(fast_samples) >= 2, "长 GOP 素材应至少有 2 个 I 帧采样点"
    assert _max_gap_us(fast_samples) > CV_SAMPLE_GAP_FALLBACK_US, (
        "fixture 未构成长 GOP 条件（最大间隔未超阈值）——需调整生成参数"
    )

    # ② 作业编排进入回退阶段。
    service, db = _service(tmp_path)
    stages: list[str] = []
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event(), None, stages.append
    ))
    assert result["status"] == "ready"
    assert "cv:video-full" in stages, "长 GOP 素材未触发全量解码回退"

    # ③ 兜底采样恢复密度：最大间隔回落到采样下限量级（1s + 一帧容差）。
    with db.connection() as conn:
        samples = conn.execute(
            "SELECT timestamp_us FROM cv_samples WHERE analysis_id=? ORDER BY timestamp_us",
            (analysis_id,),
        ).fetchall()
    gaps = [b["timestamp_us"] - a["timestamp_us"] for a, b in zip(samples, samples[1:])]
    assert gaps, "回退后应产出多个采样点"
    assert max(gaps) <= 1_500_000, (
        f"回退后采样密度未恢复：最大间隔 {max(gaps) / 1e6:.2f}s"
    )
