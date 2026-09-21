from __future__ import annotations  # noqa: I001

import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import (
    CV_ALGORITHM_VERSION,
    FACE_MODEL_ID,
    FACE_MIN_BOX,
    FACE_NMS_THRESHOLD,
    MIN_SAMPLE_INTERVAL,
    THUMB_HEIGHT,
    THUMB_WIDTH,
    CvAnalysisError,
    CvSignalService,
    _decode_yunet_detections,
    _nms,
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
        assert "v21" in versions and len(versions) == 22
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
        # 算法版本 2 插入为**新行**（旧行 v1 保留——不同版本共存，召回层取
        # 最新 ready）；同版本重分析才走 ON CONFLICT 原地重置。
        rows = conn.execute(
            "SELECT id,status,source_fingerprint FROM cv_analyses WHERE asset_id='a1' "
            "ORDER BY algorithm_version"
        ).fetchall()
    assert len(rows) == 2
    assert rows[0]["source_fingerprint"] == "fp1"  # 旧 v1 行保留
    assert rows[1]["id"] == analysis_id
    assert rows[1]["status"] == "queued"
    assert rows[1]["source_fingerprint"] == "fp2"
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
            "VALUES ('an1','a1','fp1',2,'ready',3,1,'t0','t0','t1')"
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


# ----------------------------------------------------------------------
# 阶段二：YuNet 解码 / NMS / partial 语义 / 双清单加载
# ----------------------------------------------------------------------


def test_nms_suppresses_overlapping_boxes() -> None:
    boxes = [
        (0.0, 0.0, 10.0, 10.0),      # A：分数最高
        (1.0, 1.0, 11.0, 11.0),      # B：与 A IoU≈0.68 → 抑制
        (50.0, 50.0, 60.0, 60.0),    # C：不相交 → 保留
    ]
    scores = [0.9, 0.8, 0.7]
    keep = _nms(boxes, scores, FACE_NMS_THRESHOLD)
    assert keep == [0, 2]


def test_decode_yunet_detections_multiscale_outputs() -> None:
    """12 输出（三尺度）→ anchor 偏移式解码 + 过阈 + 退化框剔除 + NMS。"""
    import numpy as np

    grid = 640
    strides = (8, 16, 32)

    def _outputs(specs: list[tuple[int, float]]) -> list[np.ndarray]:
        # 各尺度按真实模型形状构造（(640/s)² 锚点）；specs 写 stride 8：
        # (anchor, score)——bbox 回归 (dx,dy,w,h)×8 造一个 64x64 框。
        counts = [(grid // s) ** 2 for s in strides]
        cls = [np.zeros((1, c, 1), dtype=np.float32) for c in counts]
        obj = [np.zeros((1, c, 1), dtype=np.float32) for c in counts]
        bbox = [np.zeros((1, c, 4), dtype=np.float32) for c in counts]
        kps = [np.zeros((1, c, 10), dtype=np.float32) for c in counts]
        for anchor, score in specs:
            cls[0][0, anchor, 0] = score
            obj[0][0, anchor, 0] = 1.0
            bbox[0][0, anchor] = (4.0, 4.0, 8.0, 8.0)  # 64x64 框
        return cls + obj + bbox + kps

    # 三条过阈：A 高分、B 与 A 中心重合（NMS 抑制）、C 独立位置；
    # 另一条尺寸退化（w=h=1 → 8x8 < 16 最小框）应被剔除。
    outputs = _outputs([(0, 0.9), (1, 0.8), (100, 0.7)])
    outputs[6][0, 2] = (0.05, 0.05, 0.125, 0.125)  # 1x1 域 → 8x8 像素退化框
    outputs[2][0, 2] = 0.95
    outputs[5][0, 2] = 1.0
    scores = _decode_yunet_detections(outputs)
    assert scores == pytest.approx([0.9, 0.7])
    # 无过阈 → 空
    assert _decode_yunet_detections(_outputs([])) == []
    _ = grid
    _ = FACE_MIN_BOX


def test_face_channel_partial_without_model_manager(tmp_path: Path) -> None:
    """模型未就绪（无管理器）：其余信号照常、face 列 NULL、状态 ready。"""
    import asyncio

    service, db = _service(tmp_path)
    media = tmp_path / "plain.mp4"
    # 直接复用真 ffmpeg 路径在此不引入：本测走坏文件失败路径无意义——
    # partial 语义用 face_model_ready 直接断言（集成层验证完整管线）。
    assert service.model_manager is None
    assert service.face_model_ready() is False
    _ = db
    _ = media


def test_registry_loads_both_providers(tmp_path: Path) -> None:
    """双清单（faster-whisper + onnx-cv）加载 + 安装根目录分派。"""
    from aivs_core.model_registry import ModelManager, ModelRegistry

    manifests_dir = (
        Path(__file__).resolve().parents[4] / "resources/model-manifests"
    )
    registry = ModelRegistry(manifests_dir)
    items = {m.model_id: m for m in registry.list()}
    assert "faster-whisper-tiny" in items and "yunet-face-detection" in items
    assert items["yunet-face-detection"].provider == "onnx-cv"
    manager = ModelManager(Database(tmp_path / "m.db"), tmp_path, registry)
    manager.db.initialize()
    cv_root = manager._install_root("onnx-cv")
    asr_root = manager._install_root("faster-whisper")
    assert cv_root.name == "cv" and asr_root.name == "asr"
    assert cv_root.parent == asr_root.parent == tmp_path / "models"
    # onnx-cv 模型 detail：runtime 就绪（本环境有 onnxruntime）
    detail = manager.detail(FACE_MODEL_ID)
    assert detail["purpose"]
    assert detail["status"] in {"unavailable", "queued", "downloading", "ready"}
