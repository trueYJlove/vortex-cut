from __future__ import annotations  # noqa: I001

import asyncio
import hashlib
import json
import subprocess
import urllib.request
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.media.cv_signals import (
    FACE_MODEL_ID,
    CvSignalService,
)
from aivs_core.model_registry import ModelManager, ModelRegistry

REPO_ROOT = Path(__file__).resolve().parents[4]
FFMPEG = REPO_ROOT / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO_ROOT / "resources/ffmpeg/win-x64/ffprobe.exe"
MANIFESTS = REPO_ROOT / "resources/model-manifests"
MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


def _require_toolchain() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        pytest.skip("onnxruntime unavailable")


@pytest.fixture(scope="module")
def yunet_model_path(tmp_path_factory: Path) -> Path:
    """下载（或复用缓存）YuNet 模型并经 sha256 校验。"""
    _require_toolchain()
    cache = REPO_ROOT / "resources" / ".test-model-cache"
    cache.mkdir(exist_ok=True)
    model = cache / "face_detection_yunet_2023mar.onnx"
    if not model.is_file():
        urllib.request.urlretrieve(MODEL_URL, model)
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    assert digest == MODEL_SHA256, "YuNet 模型哈希与清单不符"
    return model


class _Probe:
    async def probe(self, _path: Path) -> dict:
        return {"video_streams": [{}], "audio_streams": []}


def _manager(tmp_path: Path, model_path: Path) -> ModelManager:
    registry = ModelRegistry(MANIFESTS)
    manager = ModelManager(Database(tmp_path / "m.db"), tmp_path, registry)
    manager.db.initialize()
    # seed_external：模型文件齐全的目录 → ready 安装行 + .ready marker。
    manager.seed_external(model_path.parent)
    return manager


FACE_IMAGE_URL = (
    "https://raw.githubusercontent.com/scikit-image/scikit-image/"
    "v0.19.0/skimage/data/astronaut.png"
)


@pytest.fixture(scope="module")
def face_video_path(tmp_path_factory: Path) -> Path:
    """下载 astronaut（CC0 真人脸）并经 ffmpeg 合成 3s 视频（I 帧间隔 0.5s）。"""
    _require_toolchain()
    work = tmp_path_factory.mktemp("face-video")
    image = work / "astronaut.png"
    urllib.request.urlretrieve(FACE_IMAGE_URL, image)
    video = work / "face-scene.mp4"
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-nostdin", "-y",
            "-loop", "1", "-i", str(image),
            "-t", "3", "-vf", "scale=640:640",
            "-r", "30", "-g", "15",
            "-c:v", "mpeg4", "-pix_fmt", "yuv420p", str(video),
        ],
        check=True, capture_output=True,
    )
    return video


def test_real_face_channel_detects_real_face(
    tmp_path: Path, yunet_model_path: Path, face_video_path: Path
) -> None:
    """模型就绪 + 真人脸视频：人脸通道真执行且检出非空（端到端）。"""
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
    manager = _manager(tmp_path, yunet_model_path)
    service = CvSignalService(db, FFMPEG, _Probe(), model_manager=manager)
    assert service.face_model_ready() is True
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(face_video_path))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event()
    ))
    assert result["status"] == "ready"
    assert result["faces"] == "merged"
    assert result["face_sample_count"] >= 1  # 真人脸视频每个采样帧都应检出
    with db.connection() as conn:
        faces = conn.execute(
            "SELECT face_count,face_score FROM cv_samples WHERE analysis_id=?",
            (analysis_id,),
        ).fetchall()
        revision = conn.execute(
            "SELECT model_revision FROM cv_analyses WHERE id=?", (analysis_id,)
        ).fetchone()
    detected = [row for row in faces if row["face_count"] and row["face_count"] > 0]
    assert detected, "真人脸视频应至少一个采样帧检出人脸"
    assert all(row["face_score"] > 0.5 for row in detected)
    assert revision["model_revision"] == "2023mar"


def test_real_face_channel_partial_when_model_missing(tmp_path: Path) -> None:
    """模型未就绪：人脸通道跳过（faces=partial），其余信号照常 ready。"""
    _require_toolchain()
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
    # 管理器存在但模型未安装 → face_model_ready False → partial。
    manager = ModelManager(Database(tmp_path / "m.db"), tmp_path, ModelRegistry(MANIFESTS))
    manager.db.initialize()
    service = CvSignalService(db, FFMPEG, _Probe(), model_manager=manager)
    assert service.face_model_ready() is False
    media = tmp_path / "scene.mp4"
    subprocess.run(
        [
            str(FFMPEG), "-hide_banner", "-nostdin", "-y",
            "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=2",
            "-g", "15", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", str(media),
        ],
        check=True, capture_output=True,
    )
    asset_row = {"id": "a1", "fingerprint": "fp1", "kind": "video"}
    job_id, analysis_id = service.create_analysis_job("p1", asset_row, str(media))
    with db.connection() as conn:
        row = conn.execute("SELECT input_json FROM jobs WHERE id=?", (job_id,)).fetchone()
    result = asyncio.run(service.run_analysis_job(
        {"input_json": row["input_json"]}, asyncio.Event()
    ))
    assert result["status"] == "ready"
    assert result["faces"] == "partial"
    assert result["face_sample_count"] == 0
    with db.connection() as conn:
        faces = conn.execute(
            "SELECT face_count FROM cv_samples WHERE analysis_id=?",
            (analysis_id,),
        ).fetchall()
        revision = conn.execute(
            "SELECT model_revision FROM cv_analyses WHERE id=?", (analysis_id,)
        ).fetchone()
    assert all(row["face_count"] is None for row in faces)
    assert revision["model_revision"] is None
    _ = json.dumps
