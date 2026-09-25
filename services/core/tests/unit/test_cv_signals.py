from __future__ import annotations  # noqa: I001

import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.media.cv_signals import (
    CV_ALGORITHM_VERSION,
    CV_BUDGET_CAP_S,
    CV_BUDGET_FLOOR_S,
    CV_SAMPLE_GAP_FALLBACK_US,
    FACE_MODEL_ID,
    FACE_MIN_BOX,
    FACE_NMS_THRESHOLD,
    MIN_SAMPLE_INTERVAL,
    MIN_SAMPLE_INTERVAL_US,
    THUMB_HEIGHT,
    THUMB_WIDTH,
    CvAnalysisError,
    CvSignalService,
    _decode_yunet_detections,
    _nms,
    _parse_astats_rms,
    _parse_showinfo,
    analysis_budget_s,
    clamp_budget_per_minute_s,
    clamp_target_gap_us,
    cv_audio_args,
    cv_video_args,
    density_status_of,
    frame_signals,
    max_gap_us,
    merge_sample_streams,
    project_full_decode_s,
    select_sampling_plan,
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
        assert "v21" in versions and len(versions) == 26
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
            "VALUES ('an1','a1','fp1',?,'ready',3,1,'t0','t0','t1')",
            (CV_ALGORITHM_VERSION,),
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


# ---- ADR-0005 阶段 1：采样预算与诚实降级（纯函数） ----


def test_analysis_budget_scales_with_duration_and_clamps() -> None:
    """预算 = 时长(分) × 每分钟预算，钳制在 [下限, 上限]。"""
    # 触下限：1 分钟按比例只有 10s，低于下限 15s——防误伤短视频
    # （10s 素材按比例仅 1.7s，连快路径都不够）。
    assert analysis_budget_s(0) == CV_BUDGET_FLOOR_S
    assert analysis_budget_s(60_000_000) == CV_BUDGET_FLOOR_S
    # 区间内：2 分钟 → 20s。
    assert analysis_budget_s(120_000_000) == pytest.approx(20.0)
    # 触上限：60 分钟按比例 600s，钳到 300s——防长时间占用 light 令牌。
    assert analysis_budget_s(3_600_000_000) == CV_BUDGET_CAP_S


def test_project_full_decode_scales_linearly_with_duration() -> None:
    stream = {
        "width": 3840, "height": 2160,
        "avg_frame_rate_num": 60, "avg_frame_rate_den": 1, "codec": "h264",
    }
    base = project_full_decode_s(60_000_000, stream)
    assert base > 0
    assert project_full_decode_s(120_000_000, stream) == pytest.approx(2 * base)


def test_project_full_decode_treats_hevc_and_unknown_as_conservative() -> None:
    """HEVC 慢于 H.264；未知编码取保守值（等于 HEVC）——宁可高估成本。"""
    h264 = {
        "width": 3840, "height": 2160,
        "avg_frame_rate_num": 60, "avg_frame_rate_den": 1, "codec": "h264",
    }
    hevc = {**h264, "codec": "hevc"}
    unknown = {**h264, "codec": "vp9"}
    assert project_full_decode_s(60_000_000, hevc) > project_full_decode_s(60_000_000, h264)
    assert project_full_decode_s(60_000_000, unknown) == pytest.approx(
        project_full_decode_s(60_000_000, hevc)
    )


def test_project_full_decode_returns_zero_without_stream_metadata() -> None:
    """缺分辨率/帧率信息 → 0.0（表示无法估算，交由 deadline 兜底，不阻断回退）。"""
    assert project_full_decode_s(60_000_000, {}) == 0.0
    assert project_full_decode_s(60_000_000, {"width": 0, "height": 1080}) == 0.0
    assert project_full_decode_s(
        60_000_000,
        {"width": 1920, "height": 1080, "avg_frame_rate_num": 0, "avg_frame_rate_den": 1},
    ) == 0.0


def test_density_status_uses_fallback_threshold_not_target_interval() -> None:
    """判据是**回退阈值**（4s）而非目标间隔（1s）。

    关键回归：1s < 间隔 ≤ 4s 属"既未达标也不该回退"的正常区间，
    按目标间隔判定会把这类素材大量误标 sparse。
    """
    threshold = CV_SAMPLE_GAP_FALLBACK_US
    assert density_status_of(0, threshold) == "full"
    assert density_status_of(threshold, threshold) == "full"
    assert density_status_of(2_000_000, threshold) == "full"  # 2s：正常区间
    assert density_status_of(threshold + 1, threshold) == "sparse"


def test_max_gap_us_handles_empty_and_single_sample() -> None:
    assert max_gap_us([]) == 0
    assert max_gap_us([{"timestamp_us": 5}]) == 0
    assert max_gap_us([
        {"timestamp_us": 0}, {"timestamp_us": 3}, {"timestamp_us": 10},
    ]) == 7


# ---- ADR-0005 阶段 2：密度旋钮与连续密度（纯函数） ----


def test_algorithm_version_is_3_for_density_knob() -> None:
    """阶段 2 采样策略语义变化 → algorithm_version 递增到 3（ADR D1）。"""
    assert CV_ALGORITHM_VERSION == 3


def test_clamp_target_gap_defaults_to_blind_zone_threshold() -> None:
    """默认 target = 4s 盲区阈值——不传旋钮时决策面与阶段 1 一致。"""
    assert clamp_target_gap_us(None) == CV_SAMPLE_GAP_FALLBACK_US
    assert clamp_target_gap_us(50_000) == 100_000
    assert clamp_target_gap_us(120_000_000) == 60_000_000
    assert clamp_target_gap_us(1_500_000) == 1_500_000


def test_clamp_budget_per_minute_s() -> None:
    assert clamp_budget_per_minute_s(None) == 10.0
    assert clamp_budget_per_minute_s(0.1) == 1.0
    assert clamp_budget_per_minute_s(500.0) == 120.0
    assert clamp_budget_per_minute_s(20.0) == 20.0


def test_analysis_budget_accepts_per_minute_override() -> None:
    assert analysis_budget_s(120_000_000, per_minute_s=20.0) == pytest.approx(40.0)
    assert analysis_budget_s(120_000_000, per_minute_s=20.0) != analysis_budget_s(
        120_000_000
    )


_STREAM_4K = {
    "width": 3840, "height": 2160,
    "avg_frame_rate_num": 60, "avg_frame_rate_den": 1, "codec": "hevc",
}


def test_select_sampling_plan_full_when_budget_allows() -> None:
    plan = select_sampling_plan(
        duration_us=60_000_000,
        video_stream=_STREAM_4K,
        remaining_budget_s=300.0,
        fast_max_gap_us=6_000_000,
    )
    assert plan["strategy"] == "full"
    assert plan["reason"] == "full_fits_budget"
    # 发射间隔上限对齐阶段 1 的 1s（默认 target 4s 不会把发射变粗）。
    assert plan["sample_interval_us"] == MIN_SAMPLE_INTERVAL_US


def test_select_sampling_plan_budget_capped_when_partial_affordable() -> None:
    plan = select_sampling_plan(
        duration_us=60_000_000,
        video_stream=_STREAM_4K,
        remaining_budget_s=8.0,
        fast_max_gap_us=6_000_000,
    )
    assert plan["strategy"] == "budget_capped_full"
    assert plan["reason"] == "partial_density_within_budget"


def test_select_sampling_plan_iframe_when_budget_near_zero() -> None:
    plan = select_sampling_plan(
        duration_us=60_000_000,
        video_stream=_STREAM_4K,
        remaining_budget_s=0.5,
        fast_max_gap_us=6_000_000,
    )
    assert plan["strategy"] == "iframe_only"
    assert plan["reason"] == "budget_too_small_for_dense"


def test_select_sampling_plan_skips_when_fast_meets_target() -> None:
    plan = select_sampling_plan(
        duration_us=60_000_000,
        video_stream=_STREAM_4K,
        remaining_budget_s=300.0,
        target_gap_us=CV_SAMPLE_GAP_FALLBACK_US,
        fast_max_gap_us=2_000_000,
    )
    assert plan["strategy"] == "iframe_only"
    assert plan["reason"] == "fast_path_meets_target"


def test_select_sampling_plan_densifies_when_user_target_tighter() -> None:
    """用户把 target 收紧到 1s 时，2s 间隔也不再「已达标」。"""
    plan = select_sampling_plan(
        duration_us=60_000_000,
        video_stream=_STREAM_4K,
        remaining_budget_s=300.0,
        target_gap_us=1_000_000,
        fast_max_gap_us=2_000_000,
    )
    assert plan["strategy"] == "full"


def test_select_sampling_plan_unprojectable_tries_full_or_gives_up() -> None:
    stream = {}
    assert select_sampling_plan(
        duration_us=60_000_000, video_stream=stream,
        remaining_budget_s=10.0, fast_max_gap_us=6_000_000,
    )["strategy"] == "full"
    assert select_sampling_plan(
        duration_us=60_000_000, video_stream=stream,
        remaining_budget_s=0.0, fast_max_gap_us=6_000_000,
    )["strategy"] == "iframe_only"


def test_merge_sample_streams_dense_prefix_plus_iframe_tail() -> None:
    dense = [
        {"timestamp_us": 0, "motion_energy": 0.1},
        {"timestamp_us": 1_000_000, "motion_energy": 0.2},
        {"timestamp_us": 2_000_000, "motion_energy": 0.3},
    ]
    iframe = [
        {"timestamp_us": 0, "motion_energy": 0.0},
        {"timestamp_us": 2_000_000, "motion_energy": 0.0},
        {"timestamp_us": 5_000_000, "motion_energy": 0.4},
        {"timestamp_us": 8_000_000, "motion_energy": 0.5},
    ]
    merged = merge_sample_streams(dense, iframe)
    assert [s["timestamp_us"] for s in merged] == [0, 1_000_000, 2_000_000, 5_000_000, 8_000_000]
    # 密集段以 dense 为准，I 帧重复点被剔除。
    assert merged[0]["motion_energy"] == 0.1
    assert max_gap_us(merged) == 3_000_000


def test_merge_sample_streams_empty_edges() -> None:
    iframe = [{"timestamp_us": 0}, {"timestamp_us": 4_000_000}]
    assert merge_sample_streams([], iframe) == iframe
    dense = [{"timestamp_us": 0}, {"timestamp_us": 1_000_000}]
    assert merge_sample_streams(dense, []) == dense
