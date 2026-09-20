from __future__ import annotations  # noqa: I001

import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import (
    CV_ALGORITHM_VERSION,
    MIN_SAMPLE_INTERVAL,
    THUMB_HEIGHT,
    THUMB_WIDTH,
    CvAnalysisError,
    CvSignalService,
    _parse_astats_rms,
    _parse_showinfo,
    cv_audio_args,
    cv_video_args,
    frame_signals,
)


def _flat(value: float) -> np.ndarray:
    return np.full((THUMB_HEIGHT, THUMB_WIDTH), value, dtype=np.float32)


def _textured(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.random((THUMB_HEIGHT, THUMB_WIDTH)).astype(np.float32)


# ----------------------------------------------------------------------
# 纯函数：信号计算
# ----------------------------------------------------------------------


def test_first_frame_signals_zero_motion_no_cut() -> None:
    signals = frame_signals(_flat(0.5), None)
    assert signals["brightness"] == pytest.approx(0.5)
    assert signals["motion_energy"] == 0.0
    assert signals["scene_cut"] is False
    assert signals["sharpness"] >= 0.0


def test_uniform_sequence_low_motion_no_cut() -> None:
    previous = _textured(1)
    current = _textured(1) + 0.01
    current = np.clip(current, 0.0, 1.0).astype(np.float32)
    signals = frame_signals(current, previous)
    assert signals["motion_energy"] < 0.05
    assert signals["scene_cut"] is False


def test_scene_cut_detected_on_abrupt_change() -> None:
    # 静止场景 → 全亮场景：直方图完全分离 → 距离超阈值。
    signals = frame_signals(_flat(0.95), _flat(0.1))
    assert signals["scene_cut"] is True
    assert signals["motion_energy"] == pytest.approx(0.85, abs=0.01)


def test_sharpness_orders_texture_above_flat() -> None:
    flat = frame_signals(_flat(0.5), None)
    textured = frame_signals(_textured(7), None)
    assert textured["sharpness"] > flat["sharpness"] * 50


def test_brightness_mean() -> None:
    half = np.zeros((THUMB_HEIGHT, THUMB_WIDTH), dtype=np.float32)
    half[:, THUMB_WIDTH // 2:] = 1.0
    signals = frame_signals(half, None)
    assert signals["brightness"] == pytest.approx(0.5, abs=0.001)


# ----------------------------------------------------------------------
# stderr 解析
# ----------------------------------------------------------------------


def test_parse_showinfo_timestamps() -> None:
    stderr = (
        "[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       "
        "pos: ... \n"
        "[Parsed_showinfo_1 @ 0x1] n:   1 pts:   5120 pts_time:1.70667  "
        "pos: ... \n"
        "some unrelated line\n"
        "[Parsed_showinfo_1 @ 0x1] n:   2 pts:  10240 pts_time:3.41333  "
        "pos: ...\n"
    )
    assert _parse_showinfo(stderr) == [0, 1_706_670, 3_413_330]


def test_parse_showinfo_ignores_malformed() -> None:
    stderr = "pts_time:not-a-number\n[Parsed_showinfo_1 @ 0x1] pts_time:2.0\n"
    assert _parse_showinfo(stderr) == [2_000_000]


def test_parse_astats_rms_clamps_and_scales() -> None:
    stderr = (
        "[Parsed_astats_0 @ 0x1] Overall\n"
        "  RMS level dB:  -20.0\n"
        "  RMS level dB:  -3.0\n"
        "  RMS level dB:  -inf\n"
        "  RMS level dB:  -75.0\n"
    )
    values = _parse_astats_rms(stderr)
    assert values[0] == pytest.approx(10 ** (-20 / 20))
    assert values[1] == pytest.approx(10 ** (-3 / 20))
    assert values[2] == 0.0  # -inf 走 dB 比较被钳 0
    assert values[3] == 0.0  # ≤ -60dB 钳 0
    assert len(values) == 4


# ----------------------------------------------------------------------
# FFmpeg 参数组装
# ----------------------------------------------------------------------


def test_cv_video_args_whitelist_shape() -> None:
    args = cv_video_args("C:/media/a.mp4")
    assert args[args.index("-vf") + 1].startswith("select='eq(pict_type")
    assert f"scale={THUMB_WIDTH}:{THUMB_HEIGHT}" in args[args.index("-vf") + 1]
    assert "showinfo" in args[args.index("-vf") + 1]
    assert args[args.index("-pix_fmt") + 1] == "gray"
    assert args[-1] == "pipe:1"
    assert "-an" in args


def test_cv_audio_args_window_reset() -> None:
    args = cv_audio_args("C:/media/a.mp4", window=1.0)
    assert "astats=metadata=1:reset=48000" in args[args.index("-af") + 1]


# ----------------------------------------------------------------------
# v21 迁移：表结构 + 约束
# ----------------------------------------------------------------------


def test_v21_schema_tables_and_constraints(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as conn:
        versions = [row[0] for row in conn.execute("SELECT version FROM schema_migrations")]
        assert "v21" in versions and len(versions) == 21
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
        conn.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','video','external','A','fp1',1,'available','{}','now','now')"
        )
        conn.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,created_at,updated_at) VALUES ('an1','a1','fp1',1,'queued','now','now')"
        )
        # 约束：算法版本 ≥1、状态白名单、UNIQUE(asset, version)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
                "status,created_at,updated_at) VALUES ('an2','a1','fp1',1,'queued','now','now')"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
                "status,created_at,updated_at) VALUES ('an3','a1','fp1',0,'queued','now','now')"
            )
        conn.execute(
            "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
            "motion_energy,sharpness,brightness,audio_energy) "
            "VALUES ('s1','an1',0,0,0,0.1,0.2,0.5,0.0)"
        )
        # 约束：负 motion / scene_cut 非 0/1 拒绝
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
                "motion_energy,sharpness,brightness,audio_energy) "
                "VALUES ('s2','an1',1,1000,0,-0.1,0.2,0.5,0.0)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
                "motion_energy,sharpness,brightness,audio_energy) "
                "VALUES ('s3','an1',2,2000,2,0.1,0.2,0.5,0.0)"
            )


# ----------------------------------------------------------------------
# 服务层：登记幂等 / stale 让位 / 失败落库
# ----------------------------------------------------------------------


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
    service = CvSignalService(db, Path("ffmpeg-missing"), None)
    return service, db


def _fake_media(tmp_path: Path) -> Path:
    media = tmp_path / "a.mp4"
    media.write_bytes(b"fake-video-bytes")
    return media


def test_create_analysis_job_registers_and_shortcircuits(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    media = _fake_media(tmp_path)
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        analysis = conn.execute(
            "SELECT * FROM cv_analyses WHERE id=?", (analysis_id,)
        ).fetchone()
    assert job["kind"] == "cv_analysis" and job["status"] == "queued"
    assert analysis["status"] == "queued"
    assert analysis["algorithm_version"] == CV_ALGORITHM_VERSION
    # 幂等短路：running 中重复登记拒绝。
    with pytest.raises(CvAnalysisError) as exc:
        service.create_analysis_job("p1", asset_row, str(media))
    assert exc.value.code == "CV_ANALYSIS_IN_PROGRESS"


def test_stale_row_yields_to_new_analysis(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    media = _fake_media(tmp_path)
    asset_row = {"id": "a1", "fingerprint": "fp2", "kind": "video"}
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,created_at,updated_at) VALUES ('old','a1','fp1',1,'ready','t0','t0')"
        )
    summary = service.analysis_summary({"id": "a1", "fingerprint": "fp2", "kind": "video"})
    assert summary["status"] == "stale"
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        # 单版本单行：旧行被原地重置（新行 id），旧样本明细清空。
        rows = conn.execute(
            "SELECT id,status,source_fingerprint FROM cv_analyses WHERE asset_id='a1'"
        ).fetchall()
        samples = conn.execute("SELECT COUNT(*) FROM cv_samples").fetchone()[0]
    assert len(rows) == 1
    assert rows[0]["id"] == analysis_id
    assert rows[0]["status"] == "queued"
    assert rows[0]["source_fingerprint"] == "fp2"
    assert samples == 0
    _ = job_id


def test_run_analysis_job_stat_guard(tmp_path: Path) -> None:
    service, _db = _service(tmp_path)
    media = _fake_media(tmp_path)
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    # 篡改素材（stat 漂移）→ 执行期拒绝。
    media.write_bytes(b"different-bytes-now")
    row = {"input_json": json_dumps({
        "analysis_id": analysis_id,
        "path": str(media),
        "size_bytes": len(b"fake-video-bytes"),
        "modified_at": media.stat().st_mtime_ns + 1,
    })}
    import asyncio

    with pytest.raises(CvAnalysisError) as exc:
        asyncio.run(service.run_analysis_job(row, asyncio.Event()))
    assert exc.value.code == "MEDIA_CHANGED"


def test_samples_for_range_and_summary(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO cv_analyses(id,asset_id,source_fingerprint,algorithm_version,"
            "status,sample_count,scene_cut_count,created_at,updated_at,finished_at) "
            "VALUES ('an1','a1','fp1',1,'ready',3,1,'t0','t0','t1')"
        )
        for index, (ts, cut) in enumerate([(0, 0), (1_000_000, 1), (2_000_000, 0)]):
            conn.execute(
                "INSERT INTO cv_samples(id,analysis_id,sample_index,timestamp_us,scene_cut,"
                "motion_energy,sharpness,brightness,audio_energy) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (f"s{index}", "an1", index, ts, cut, 0.1 * index, 0.5, 0.4, 0.2),
            )
    samples = service.samples_for_range("a1", 500_000, 2_000_000)
    assert [s["timestamp_us"] for s in samples] == [1_000_000]
    summary = service.analysis_summary({"id": "a1", "fingerprint": "fp1", "kind": "video"})
    assert summary["status"] == "ready"
    assert summary["sample_count"] == 3
    assert summary["scene_cut_count"] == 1
    # 指纹不匹配 → stale。
    stale = service.analysis_summary({"id": "a1", "fingerprint": "changed", "kind": "video"})
    assert stale["status"] == "stale"
    _ = MIN_SAMPLE_INTERVAL
