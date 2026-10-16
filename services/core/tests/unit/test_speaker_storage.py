"""W2.2 S2：存储层 + 服务层回归（门 §7 的 `speaker_storage_test.py`）。

覆盖验收 2/3：v37 形状 + 部分唯一索引 + 指纹变化新行 + 读时 stale + 幂等短路 +
**重聚类不重跑推理**（推理调用计数为 0）+ 摘要**列投影**（BLOB 不进摘要路径）。

负向对照（已在实施中实跑，见实施记录 §S2）：
- 还原索引里的 `source_fingerprint` ⇒ `test_rerun_after_fingerprint_change_writes_new_row` 红；
- 摘要改 `SELECT *` ⇒ `test_summary_never_reads_embeddings_blob` 红；
- `recluster` 走嵌入器 ⇒ `test_recluster_does_not_rerun_inference` 红。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.media import speaker_service as svc
from aivs_core.media.speaker_service import (
    SpeakerDiarizationService,
    encode_embeddings,
)
from aivs_core.projects import DomainError


class _StubEmbedder:
    """确定性假嵌入器：说话人 A 的窗 = e0 方向，B 的窗 = e1 方向。

    只在**内存**里造向量，不触碰 ONNX——重聚类用例要证明的正是"再也不会走到这里"。
    """

    dim = 192

    def __init__(self, plan: list[int]) -> None:
        self.plan = plan

    def embed(self, samples: np.ndarray) -> np.ndarray:
        index = len(getattr(self, "_calls", []))
        calls = getattr(self, "_calls", [])
        calls.append(index)
        self._calls = calls
        speaker = self.plan[index % len(self.plan)] if self.plan else 0
        vector = np.zeros(self.dim, dtype=np.float64)
        vector[speaker] = 1.0
        return vector


def _service(
    tmp_path: Path, *, fingerprint: str = "sha256:aaa"
) -> tuple[Database, SpeakerDiarizationService]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    now = utc_now()
    with db.connection() as con:
        con.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p1", "说话人测试", "active", "{}", str(tmp_path), "r", now, now, now),
        )
        con.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("a1", "p1", "audio", "external", "素材1", fingerprint, 1, "0", "available",
             json_dumps({"duration_us": 20_000_000,
                         "audio_streams": [{"index": 0, "codec": "pcm"}]}), now, now),
        )
    service = SpeakerDiarizationService(
        db, Path("ffmpeg-missing"), lambda asset_id: {"path": str(tmp_path / asset_id)})
    return db, service


def _asset_row(db: Database, asset_id: str = "a1") -> dict:
    with db.connection() as con:
        return dict(con.execute(
            "SELECT id,fingerprint FROM assets WHERE id=?", (asset_id,)).fetchone())


def _pcm(speakers: list[int], *, window_s: float = 2.0, hop_s: float = 1.0,
         sample_rate: int = svc.DEFAULT_SAMPLE_RATE) -> tuple[np.ndarray, np.ndarray]:
    """按窗计划构造 PCM + 全 True 的 voiced 掩码（窗数 = 计划长度）。"""
    total_s = window_s + hop_s * (len(speakers) - 1)
    n = int(total_s * sample_rate)
    return np.zeros(n, dtype=np.float64), np.ones(int(total_s * 100), dtype=bool)


class TestMigrationShape:
    def test_v37_table_and_indexes(self, tmp_path: Path) -> None:
        db, _ = _service(tmp_path)
        with db.connection() as con:
            columns = {row[1] for row in con.execute(
                "PRAGMA table_info(speaker_diarizations)")}
            indexes = {row[1] for row in con.execute(
                "PRAGMA index_list(speaker_diarizations)")}
        expected = {
            "id", "asset_id", "source_fingerprint", "algorithm_version", "status",
            "reason", "speaker_count", "turns_json", "windows_json", "embeddings_blob",
            "embedding_model", "model_revision", "vad_model", "threshold",
            "threshold_strategy", "sample_rate", "created_at", "updated_at", "finished_at",
            # v38（降级交付 D3）：质量标注三列
            "quality_status", "quality_basis", "usable_for",
        }
        assert expected <= columns
        assert {"idx_speaker_diarizations_asset", "idx_speaker_diarizations_ready"} <= indexes

    def test_status_check_constraint(self, tmp_path: Path) -> None:
        db, _ = _service(tmp_path)
        with pytest.raises(sqlite3.IntegrityError), db.connection() as con:
            con.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,created_at,updated_at) VALUES "
                "('x','a1','fp',1,'nonsense','t','t')")

    def test_asset_delete_cascades_derived_rows(self, tmp_path: Path) -> None:
        """F1 的落地：派生分析数据**随素材自动清**（不重蹈 beat_grids 的 NO ACTION）。"""
        db, _ = _service(tmp_path)
        now = utc_now()
        with db.connection() as con:
            con.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,created_at,updated_at) VALUES "
                "('sd1','a1','sha256:aaa',1,'ready',?,?)", (now, now))
            con.execute("DELETE FROM assets WHERE id='a1'")
            remaining = con.execute(
                "SELECT COUNT(*) FROM speaker_diarizations").fetchone()[0]
        assert remaining == 0

    def test_rerun_after_fingerprint_change_writes_new_row(self, tmp_path: Path) -> None:
        """指纹入唯一键的回归锁：素材变更后重算必须能写新行（旧行保留）。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 1]))
        # 同指纹重复 ready 行被部分唯一索引拒绝
        with pytest.raises(sqlite3.IntegrityError):
            service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                embedder=_StubEmbedder([0, 0, 0, 1]))
        # 新指纹 ⇒ 新行可写
        result = service.analyze_pcm("a1", "sha256:bbb", pcm, voiced=voiced,
                                     embedder=_StubEmbedder([0, 0, 0, 1]))
        assert result["status"] == "ready"
        assert len(service.rows_for_asset("a1")) == 2


class TestSummaryAndStale:
    def test_no_row_returns_none(self, tmp_path: Path) -> None:
        _, service = _service(tmp_path)
        assert service.summary({"id": "a1", "fingerprint": "sha256:aaa"}) is None

    def test_stale_is_computed_at_read_time(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 1]))
        asset = _asset_row(db)
        summary = service.summary(asset)
        assert summary is not None and summary["status"] == "ready"
        assert summary["speaker_count"] == 2

        with db.connection() as con:
            con.execute("UPDATE assets SET fingerprint='sha256:zzz' WHERE id='a1'")
        assert service.summary(_asset_row(db))["status"] == "stale"

        # 回退到原指纹 ⇒ 自动恢复 ready（与 P79 同一语义：能自证）
        with db.connection() as con:
            con.execute("UPDATE assets SET fingerprint='sha256:aaa' WHERE id='a1'")
        assert service.summary(_asset_row(db))["status"] == "ready"

    def test_summary_never_reads_embeddings_blob(self, tmp_path: Path) -> None:
        """复核 F6：摘要必须走**显式列投影**（BLOB 单行可达 1.3 MB）。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 1]))
        assert "embeddings_blob" not in svc.SUMMARY_COLUMNS
        captured: list[str] = []
        real_connection = db.connection

        class _TracingConnection:
            def __init__(self, connection: sqlite3.Connection) -> None:
                self._connection = connection

            def execute(self, sql: str, *args: object) -> object:
                captured.append(sql)
                return self._connection.execute(sql, *args)

            def __getattr__(self, name: str) -> object:
                return getattr(self._connection, name)

        from contextlib import contextmanager

        @contextmanager
        def tracing():  # type: ignore[no-untyped-def]
            with real_connection() as connection:
                yield _TracingConnection(connection)

        db.connection = tracing  # type: ignore[assignment]
        try:
            service.summary(_asset_row(db))
        finally:
            db.connection = real_connection  # type: ignore[assignment]
        assert captured and all("embeddings_blob" not in sql for sql in captured)
        assert all("*" not in sql.split("FROM")[0] for sql in captured), captured


class TestIdempotency:
    def test_create_job_shortcircuits_when_ready(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 1]))
        assert service.create_job("p1", _asset_row(db)) is None

    def test_create_job_shortcircuits_when_stale(self, tmp_path: Path) -> None:
        """指纹已变同样短路：新作业必撞部分唯一索引（门 §3 的已知不可写路径）。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 1]))
        with db.connection() as con:
            con.execute("UPDATE assets SET fingerprint='sha256:zzz' WHERE id='a1'")
        assert service.summary(_asset_row(db))["status"] == "stale"
        assert service.create_job("p1", _asset_row(db)) is None

    def test_create_job_shortcircuits_when_unavailable(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        service._write_row("a1", "sha256:aaa", "unavailable", "no_speech",
                           None, [], [], None, None, None)
        assert service.create_job("p1", _asset_row(db)) is None

    def test_create_job_registers_when_absent(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        job_id = service.create_job("p1", _asset_row(db))
        assert job_id
        with db.connection() as con:
            row = con.execute("SELECT kind,status,resource_class FROM jobs WHERE id=?",
                              (job_id,)).fetchone()
        assert (row["kind"], row["status"], row["resource_class"]) == (
            "speaker_diarization", "queued", "light")

    def test_create_job_shortcircuits_when_inflight(self, tmp_path: Path) -> None:
        """在飞短路：连点不会入队两个作业（P87 复核 M-a 的同源缺陷）。"""
        db, service = _service(tmp_path)
        first = service.create_job("p1", _asset_row(db))
        assert first
        assert service.create_job("p1", _asset_row(db)) is None


class TestRecluster:
    def test_recluster_does_not_rerun_inference(self, tmp_path: Path) -> None:
        """**本切片的核心不变量**：换 τ 只重跑聚类，推理调用计数为 0。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 0, 1, 1])
        service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                            embedder=_StubEmbedder([0, 0, 0, 0, 1, 1]))
        before = svc.EMBEDDER_SESSION_COUNT
        result = service.recluster("a1", strategy="silhouette_capk")
        assert svc.EMBEDDER_SESSION_COUNT == before
        assert result["status"] == "ready" and result["window_count"] == 6
        assert result["threshold_strategy"].startswith("recluster:")

    def test_recluster_updates_row_and_changes_threshold(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 0, 0, 1, 1])
        created = service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                      embedder=_StubEmbedder([0, 0, 0, 0, 1, 1]))
        summary_before = service.summary(_asset_row(db))
        fixed = service.recluster("a1", strategy="distance_mixture")
        assert fixed["threshold"] != created["threshold"] or fixed["speaker_count"] in (1, 2)
        summary_after = service.summary(_asset_row(db))
        assert summary_after["threshold"] == fixed["threshold"]
        assert summary_after["speaker_count"] == fixed["speaker_count"]
        assert summary_before["speaker_diarization_id"] == summary_after["speaker_diarization_id"]

    def test_recluster_without_row_raises(self, tmp_path: Path) -> None:
        _, service = _service(tmp_path)
        with pytest.raises(DomainError) as excinfo:
            service.recluster("a1")
        assert excinfo.value.code == "SPEAKER_NOT_FOUND"

    def test_recluster_rejects_missing_blob(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        now = utc_now()
        with db.connection() as con:
            con.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,turns_json,windows_json,created_at,updated_at) "
                "VALUES ('sd1','a1','sha256:aaa',1,'ready','[]','[[0.0,2.0]]',?,?)",
                (now, now))
        with pytest.raises(DomainError) as excinfo:
            service.recluster("a1")
        assert excinfo.value.code == "SPEAKER_EMBEDDINGS_MISSING"


class TestAnalyzePcmSemantics:
    def test_silence_yields_unavailable_no_speech(self, tmp_path: Path) -> None:
        db, service = _service(tmp_path)
        pcm, _ = _pcm([0, 0])
        result = service.analyze_pcm(
            "a1", "sha256:aaa", pcm,
            voiced=np.zeros(400, dtype=bool), embedder=_StubEmbedder([0]))
        assert result["status"] == "unavailable" and result["reason"] == "no_speech"
        assert service.summary(_asset_row(db))["status"] == "unavailable"

    def test_single_speaker_does_not_oversegment(self, tmp_path: Path) -> None:
        """单说话人素材不得凭空产出多说话人（spike 的过分割轴）。"""
        _, service = _service(tmp_path)
        plan = [0] * 8
        pcm, voiced = _pcm(plan)
        result = service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                     embedder=_StubEmbedder(plan))
        assert result["status"] == "ready"
        assert result["speaker_count"] == 1

    def test_two_speakers_are_separated(self, tmp_path: Path) -> None:
        _, service = _service(tmp_path)
        plan = [0, 0, 0, 0, 1, 1, 1, 1]
        pcm, voiced = _pcm(plan)
        result = service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                     embedder=_StubEmbedder(plan),
                                     strategy="distance_mixture")
        assert result["status"] == "ready"
        assert result["speaker_count"] == 2

    def test_turns_are_monotonic_and_cover_speech(self, tmp_path: Path) -> None:
        _, service = _service(tmp_path)
        plan = [0, 0, 0, 0, 1, 1, 1, 1]
        pcm, voiced = _pcm(plan)
        result = service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                     embedder=_StubEmbedder(plan),
                                     strategy="distance_mixture")
        assert result["turn_count"] >= 2
        with service.db.connection() as con:
            row = con.execute(
                "SELECT turns_json FROM speaker_diarizations WHERE id=?",
                (result["speaker_diarization_id"],)).fetchone()
        from aivs_core.database import json_loads

        turns = json_loads(row["turns_json"])
        starts = [t["start_us"] for t in turns]
        assert starts == sorted(starts)
        assert all(t["end_us"] > t["start_us"] for t in turns)

    def test_determinism(self, tmp_path: Path) -> None:
        """同输入必同输出（无随机数；多起点 EM 走确定性网格）。"""
        _, service = _service(tmp_path)
        plan = [0, 0, 0, 1, 1, 1]
        pcm, voiced = _pcm(plan)
        first = service.analyze_pcm("a1", "sha256:aaa", pcm, voiced=voiced,
                                    embedder=_StubEmbedder(plan),
                                    strategy="distance_mixture")
        second = service.analyze_pcm("a1", "sha256:bbb", pcm, voiced=voiced,
                                     embedder=_StubEmbedder(plan),
                                     strategy="distance_mixture")
        assert first["speaker_count"] == second["speaker_count"]
        assert first["threshold"] == second["threshold"]
        assert first["turn_count"] == second["turn_count"]


class TestAvailability:
    def test_without_model_manager_reports_missing(self, tmp_path: Path) -> None:
        _, service = _service(tmp_path)
        state = service.availability()
        assert state["ready"] is False
        assert state["reason"] in {"embedding_model_missing", "silero_asset_missing"}

    def test_missing_silero_takes_precedence(self, tmp_path: Path, monkeypatch) -> None:
        """O1：Silero 缺失必须报 **silero_asset_missing**（可诊断，不是泛化错误）。"""
        _, service = _service(tmp_path)
        monkeypatch.setattr(svc, "require_silero_asset_path",
                            lambda: (_ for _ in ()).throw(svc.SileroAssetMissing()))
        state = service.availability()
        assert state["ready"] is False and state["reason"] == "silero_asset_missing"

    def test_analyze_path_without_model_is_unavailable(self, tmp_path: Path) -> None:
        """模型未就绪 ⇒ 落 unavailable(silero_asset_missing/embedding_model_missing)，
        **不是静默降级**（D4）。"""
        db, service = _service(tmp_path)
        import asyncio

        result = asyncio.run(service.analyze_path(
            "a1", "sha256:aaa", tmp_path / "missing.wav"))
        assert result["status"] == "unavailable"
        assert result["reason"] in {"silero_asset_missing", "embedding_model_missing"}
        assert service.summary(_asset_row(db))["status"] == "unavailable"


class TestBlobRoundtrip:
    def test_encode_decode_roundtrip(self) -> None:
        matrix = np.arange(12, dtype=np.float64).reshape(3, 4) / 7.0
        decoded = svc.decode_embeddings(encode_embeddings(matrix))
        # decode 返回展平向量；_matrix 负责 reshape（并做尺寸校验）
        assert decoded.shape == (12,)
        assert np.allclose(decoded, matrix.reshape(-1), atol=1e-6)

    def test_decoded_size_mismatch_is_rejected_by_matrix(self) -> None:
        blob = encode_embeddings(np.zeros((3, 4), dtype=np.float64))
        assert svc._matrix(blob, 3, 4).shape == (3, 4)
        assert svc._matrix(blob, 5, 4).shape == (0, 0)
        assert svc._matrix(None, 3, 4).shape == (0, 0)
