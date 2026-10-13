"""W2.2 S2：真实素材端到端（真实 ffmpeg + 真实 ONNX：Silero VAD + CAM++）。

对应门 §7 的 `speaker_real_test.py` 的**机制半边**：
真实链路跑通、真实语音上不凭空过分割、oracle τ 可控、确定性、性能门、BLOB 量级。

**边界（不得含混引用）**：
- 本套件用的是**单说话人真实语音**（faster-whisper 自带 jfk 样本，公开 CC0 素材）。
  它证明的是**链路机制与真实 embedding 行为**，**不是**对话精度；
- **精度门（两语料 DER）属 S3**，需要全场语料 + 评测仪器，不在本套件；
- 多说话人分离的**真实**证据在 S3 用 AMI/AISHELL-4 出 DER（门 §5）；本套件
  只用 oracle τ 锁"τ ⇒ 簇数"的**单调契约**，不宣称分离精度。

## 一个被本套件当场抓出的实现缺陷（已修）

`analyze_pcm` 首版把入参 `threshold` 当累加器复用 ⇒ 外部传入的 oracle τ 被静默丢弃，
τ 扫描给出"所有 τ 同结果"的**假结论**（正是 oracle 方法论最不能容忍的失效模式）。
现在外部 τ 走独立变量 + 策略名标注 `oracle:external`，并由
`test_oracle_threshold_actually_changes_clustering` 钉死。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database
from aivs_core.media.speaker_embedding import EMBEDDING_MODEL_FILE, EMBEDDING_MODEL_ID
from aivs_core.media.speaker_service import SpeakerDiarizationService
from aivs_core.media.speaker_vad import silero_asset_path
from aivs_core.model_registry import ModelManager, ModelRegistry

REPO_ROOT = Path(__file__).resolve().parents[4]
FFMPEG = REPO_ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe"
FFPROBE = FFMPEG.parent / "ffprobe.exe"
MANIFESTS = REPO_ROOT / "resources" / "model-manifests"
# **独立子目录**：`ModelManager.seed_external` 只登记**第一个**文件齐全的清单并返回，
# 把 CAM++ 与 YuNet 混在同一目录会让后者永远登记不上（实测：`test_cv_faces_real` 变红）。
CACHE = REPO_ROOT / "resources" / ".test-model-cache" / "speaker"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
)
MODEL_SHA256 = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11"
SPEECH_URL = (
    "https://raw.githubusercontent.com/SYSTRAN/faster-whisper/"
    "master/tests/data/jfk.flac"
)
SPEECH_SHA256 = "63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715"


def _require_toolchain() -> None:
    if not FFMPEG.is_file() or not FFPROBE.is_file():
        pytest.skip("bundled ffmpeg/ffprobe unavailable")
    if silero_asset_path() is None:
        pytest.skip("随包 Silero 资产不可用")
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        pytest.skip("onnxruntime unavailable")


def _fetch(url: str, dest: Path) -> bool:
    """直连优先，失败退到本地 forward proxy（AIVS_TEST_PROXY），再失败返回 False。

    **不把测试写成"必须能出网"**——取不到素材就 skip，而不是伪造结论。
    """
    if dest.is_file() and dest.stat().st_size > 0:
        return True
    for proxy in (None, os.environ.get("AIVS_TEST_PROXY", "http://127.0.0.1:10809")):
        try:
            if proxy:
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
                stream = opener.open(url, timeout=120)
            else:
                stream = urllib.request.urlopen(url, timeout=60)  # noqa: S310
            dest.write_bytes(stream.read())
            if dest.stat().st_size > 0:
                return True
        except Exception:
            dest.unlink(missing_ok=True)
    return False


@pytest.fixture(scope="module")
def campplus_dir() -> Path:
    """CAM++（或复用缓存）——哈希必须与清单登记的完全一致。"""
    _require_toolchain()
    CACHE.mkdir(parents=True, exist_ok=True)
    model = CACHE / EMBEDDING_MODEL_FILE
    if not _fetch(MODEL_URL, model):
        pytest.skip("CAM++ 模型不可获取（离线环境）")
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    assert digest == MODEL_SHA256, "CAM++ 模型哈希与清单不符"
    return model.parent


@pytest.fixture(scope="module")
def speech_flac() -> Path:
    """单说话人真实语音（faster-whisper 测试样本）。"""
    _require_toolchain()
    CACHE.mkdir(parents=True, exist_ok=True)
    flac = CACHE / "jfk.flac"
    if not _fetch(SPEECH_URL, flac):
        pytest.skip("真实语音样本不可获取（离线环境）")
    assert hashlib.sha256(flac.read_bytes()).hexdigest() == SPEECH_SHA256
    return flac


def _to_wav(source: Path, out: Path) -> Path:
    subprocess.run(
        [str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(source),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)],
        check=True, capture_output=True,
    )
    return out


def _repeat(wav: Path, times: int, out: Path) -> Path:
    listing = out.parent / f"{out.stem}.txt"
    listing.write_text(
        "".join(f"file '{wav.as_posix()}'\n" for _ in range(times)), encoding="utf-8")
    subprocess.run(
        [str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(out)],
        check=True, capture_output=True,
    )
    return out


@pytest.fixture()
def service(tmp_path: Path, campplus_dir: Path) -> SpeakerDiarizationService:
    db = Database(tmp_path / "app.db")
    db.initialize()
    with db.connection() as con:
        con.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','root','root','t','t','t')")
        con.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES ('a1','p1','audio','external','素材','fp1',1,'0','available',"
            "'{\"duration_us\": 60000000, \"audio_streams\": []}',"
            "'t','t')")
    manager = ModelManager(db, tmp_path, ModelRegistry(MANIFESTS))
    manager.seed_external(campplus_dir)
    return SpeakerDiarizationService(
        db, FFMPEG, lambda asset_id: {"path": str(tmp_path / f"{asset_id}.wav")},
        model_manager=manager)


class TestRealPipeline:
    def test_single_speaker_material_stays_one_speaker(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        """真实单说话人语音：链路跑通且**不过分割**（spike 的过分割轴）。"""
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        result = asyncio.run(service.analyze_path(
            "a1", "fp1", media, strategy="distance_mixture"))
        assert result["status"] == "ready", result
        assert result["window_count"] >= 12
        assert result["speaker_count"] == 1, result

    def test_silhouette_route_also_runs(self, tmp_path: Path, service, speech_flac: Path) -> None:
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        result = asyncio.run(service.analyze_path(
            "a1", "fp1", media, strategy="silhouette_capk"))
        assert result["status"] == "ready"
        assert result["threshold_strategy"].startswith("silhouette")

    def test_oracle_threshold_actually_changes_clustering(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        """**回归锁**：外部传入的 τ 必须真的生效（首版的遮蔽缺陷使 τ 被静默丢弃）。

        真实单说话人素材上：低 τ 会把一个人切成多簇、高 τ 合成一簇——
        这同时钉死"τ 生效"与"τ 方向正确"两件事。
        """
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        low = asyncio.run(service.analyze_path("a1", "fp-low", media, strategy="silhouette_capk"))
        with service.db.connection() as con:
            row = con.execute(
                "SELECT embeddings_blob,windows_json,sample_rate FROM speaker_diarizations "
                "WHERE id=?", (low["speaker_diarization_id"],)).fetchone()
        from aivs_core.media.speaker_service import decode_embeddings

        flat = decode_embeddings(row["embeddings_blob"])
        windows = json.loads(row["windows_json"])
        vectors = flat.reshape(len(windows), -1)

        pcm = np.frombuffer(subprocess.run(
            [str(FFMPEG), "-hide_banner", "-nostdin", "-i", str(media), "-vn", "-ac", "1",
             "-ar", "16000", "-f", "s16le", "pipe:1"],
            check=True, capture_output=True).stdout, dtype="<i2").astype(np.float64) / 32768.0
        voiced = service._vad_session().voiced_10ms(pcm)  # noqa: SLF001

        counts = {}
        for tau in (0.30, 0.40, 0.50):
            result = service.analyze_pcm(
                "a1", f"fp-oracle-{tau}", pcm, voiced=voiced, threshold=tau,
                embedder=service._embedder_session())  # noqa: SLF001
            counts[tau] = result["speaker_count"]
            assert result["threshold"] == tau
            assert result["threshold_strategy"] == "oracle:external"
        assert counts[0.30] > counts[0.50], counts
        assert counts[0.50] == 1, counts
        assert vectors.shape[0] == len(windows)

    def test_determinism_on_real_media(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        first = asyncio.run(service.analyze_path(
            "a1", "fp-a", media, strategy="distance_mixture"))
        second = asyncio.run(service.analyze_path(
            "a1", "fp-b", media, strategy="distance_mixture"))
        assert first["speaker_count"] == second["speaker_count"]
        assert first["threshold"] == second["threshold"]
        assert first["turn_count"] == second["turn_count"]
        assert first["window_count"] == second["window_count"]

    def test_recluster_on_real_embeddings_does_not_rerun_inference(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        from aivs_core.media import speaker_service as svc

        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        asyncio.run(service.analyze_path("a1", "fp1", media))
        before = svc.EMBEDDER_SESSION_COUNT
        result = service.recluster("a1", strategy="distance_mixture")
        assert svc.EMBEDDER_SESSION_COUNT == before
        assert result["status"] == "ready"
        assert result["threshold_strategy"].startswith("recluster:")

    def test_performance_gate_seconds_per_minute(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        """门 §5 资源门：**≤10 s/分钟源**（解码 + VAD + fbank + ONNX + 聚类全环节）。"""
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 12, tmp_path / "long.wav")
        started = time.perf_counter()
        result = asyncio.run(service.analyze_path("a1", "fp1", media))
        elapsed = time.perf_counter() - started
        assert result["status"] == "ready", result
        source_s = 11.04 * 12
        per_minute = elapsed / (source_s / 60.0)
        assert per_minute <= 10.0, f"{per_minute:.2f} s/min（{elapsed:.2f}s / {source_s:.1f}s）"

    def test_embeddings_blob_size_matches_windows(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        """门 §3 量级：BLOB = n_windows × dim × 4 B（会话上限约 1.3 MB/场）。"""
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 4, tmp_path / "rep.wav")
        result = asyncio.run(service.analyze_path("a1", "fp1", media))
        with service.db.connection() as con:
            row = con.execute(
                "SELECT length(embeddings_blob) AS size, windows_json "
                "FROM speaker_diarizations WHERE id=?",
                (result["speaker_diarization_id"],)).fetchone()
        windows = json.loads(row["windows_json"])
        assert row["size"] == len(windows) * 192 * 4
        assert row["size"] < 1_400_000

    def test_model_revision_is_recorded(
        self, tmp_path: Path, service: SpeakerDiarizationService, speech_flac: Path
    ) -> None:
        media = _repeat(_to_wav(speech_flac, tmp_path / "one.wav"), 2, tmp_path / "rep.wav")
        result = asyncio.run(service.analyze_path("a1", "fp1", media))
        with service.db.connection() as con:
            row = con.execute(
                "SELECT embedding_model,model_revision,vad_model FROM "
                "speaker_diarizations WHERE id=?",
                (result["speaker_diarization_id"],)).fetchone()
        assert row["embedding_model"] == EMBEDDING_MODEL_ID
        assert row["model_revision"] == "campplus-zh-cn-16k-common"
        assert row["vad_model"] == "silero_vad_v6"


class TestSilenceGuard:
    def test_digital_silence_is_unavailable_not_ready(
        self, tmp_path: Path, service: SpeakerDiarizationService
    ) -> None:
        """纯数字静音：Silero 零误报 ⇒ 无窗 ⇒ unavailable(no_speech)。

        这是 R2/P90 的直接回归锁：**能量 VAD 会在这里凭空产出说话人**。
        """
        media = tmp_path / "silence.wav"
        subprocess.run(
            [str(FFMPEG), "-hide_banner", "-nostdin", "-y",
             "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "10",
             "-c:a", "pcm_s16le", str(media)],
            check=True, capture_output=True,
        )
        result = asyncio.run(service.analyze_path("a1", "fp1", media))
        assert result["status"] == "unavailable"
        assert result["reason"] == "no_speech"
        assert result["speaker_count"] is None


class TestFbankFrontend:
    def test_frontend_shape_and_finiteness(self) -> None:
        """前端口径锁（纯 numpy，snip_edges=False；与 spike 的等价性结论同实现）。"""
        from aivs_core.media.speaker_embedding import compute_fbank

        rng = np.random.default_rng(3)
        fbank = compute_fbank(rng.normal(0.0, 0.1, 16000), snip_edges=False)
        assert fbank.shape == (100, 80)
        assert np.isfinite(fbank).all()
        assert -30.0 < fbank.min() and fbank.max() < 30.0

    def test_frontend_is_deterministic(self) -> None:
        from aivs_core.media.speaker_embedding import compute_fbank

        rng = np.random.default_rng(11)
        samples = rng.normal(0.0, 0.05, 8000)
        assert np.array_equal(compute_fbank(samples), compute_fbank(samples))
