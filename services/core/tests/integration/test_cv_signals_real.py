from __future__ import annotations  # noqa: I001

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import CvSignalService

FFMPEG = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffmpeg.exe")
FFPROBE = (Path(__file__).resolve().parents[4] / "resources/ffmpeg/win-x64/ffprobe.exe")


def _require_ffmpeg() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")


def _synthetic_two_scene_video(path: Path) -> None:
    """3 秒 30fps 合成视频：前 1.5s 灰场、后 1.5s 亮场（强制 I 帧）。"""
    FFMPEG and None
    import subprocess

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
