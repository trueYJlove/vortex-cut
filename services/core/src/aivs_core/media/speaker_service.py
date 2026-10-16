"""W2.2 说话人分离 —— Core 服务层（**建作业 / 执行 / 摘要 / 重聚类**）。

Design Gate §1/§2 冻结的 `SpeakerDiarizationService`。与 `beat_service.py` /
`angle_sync.py` 同型（`kind=speaker_diarization` 轻作业档）。

## 三个必须显式成立的语义（都有测试钉死）

1. **幂等**：指纹相符的 `ready`/`unavailable` 行存在 ⇒ `create_job` 返回 `None`；
   指纹**已变**同样短路（新作业必撞部分唯一索引，属已知不可写路径，见门 §3）。
   另有**在飞短路**（`queued`/`running` 作业存在则不入队）。
2. **stale 是读时算的**：行内 `source_fingerprint != 素材当前指纹` ⇒ 摘要报 `stale`，
   **不据此拒答**（与 P79 的"改回原样可自证"语义一致：回退到旧指纹自动恢复 ready）。
3. **重聚类不重跑推理**：`recluster` 只读 `embeddings_blob` + `windows_json`，
   **不构造 ONNX 会话、不调用嵌入器**（测试用进程级会话计数器钉死为 0）。

## 摘要为什么必须列投影（复核 F6）

`embeddings_blob` 单行可达 1.3 MB。摘要走 `SELECT` **显式标量列**，
BLOB 仅由 `recluster` 显式读取——一次 `SELECT *` 就会把整行拉进内存。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..model_registry import ModelError
from ..projects import DomainError
from . import speaker as sp
from .speaker_embedding import EMBEDDING_MODEL_ID, SpeakerEmbedder
from .speaker_vad import (
    VAD_MODEL_ID,
    SileroAssetMissing,
    SileroVoiceActivity,
    require_silero_asset_path,
)

SPEAKER_ALGORITHM_VERSION = 1
DEFAULT_SAMPLE_RATE = 16000
MIN_DURATION_S = 1.0

# --- 降级交付（Design Gate 2026-10-14，D3）-------------------------------------
# S3 判精度门三项全不过（门 §5.20），且 §5.21 实测否决了「只交付高置信区间」
# （欠分割场的 margin 最大 ⇒ 置信度在最该报警处给最高分）。
# ⇒ 采纳 D3：**输出不变，只标注**。字段机器可读，因为下游（W2.3 机位切换）
# 必须在**代码里**拒绝；靠文档的约束会腐烂。
QUALITY_GATE_BASIS = "gate:mean_le_0.40,worst_en_le_0.60,worst_cn_le_0.55"
# 未通过精度门 = 本包当前状态；将来精度门通过后改为 validated 即解除下游约束
# （下游按**取值**检查而非版本号，故升级无需改下游代码）。
QUALITY_STATUS_UNVALIDATED = "unvalidated"
# 允许的用途。**multicam_switch 恒不在其中**——本门最硬的下游约束。
USABLE_FOR_REFERENCE_ONLY = '["reference"]'

# 摘要投影：**显式标量列**（BLOB 不在其中——见模块 docstring）
SUMMARY_COLUMNS = (
    "id,asset_id,source_fingerprint,algorithm_version,status,reason,speaker_count,"
    "turns_json,windows_json,embedding_model,model_revision,vad_model,threshold,"
    "threshold_strategy,sample_rate,quality_status,quality_basis,usable_for,"
    "created_at,updated_at,finished_at"
)

# 推理会话计数（测试用：钉死"重聚类不重跑推理"；生产路径只增不减）
EMBEDDER_SESSION_COUNT = 0


def pcm_s16le_args(input_path: str, sample_rate: int = DEFAULT_SAMPLE_RATE) -> list[str]:
    """16 kHz 单声道 PCM（§4 冻结：多通道阵列取单通道，**不下混**避免梳状干涉）。"""
    return [
        "-hide_banner",
        "-nostdin",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
    ]


def encode_embeddings(matrix: np.ndarray) -> bytes:
    """窗 embedding 矩阵 → float32 BLOB（小端、行主序）。"""
    return np.ascontiguousarray(np.asarray(matrix, dtype="<f4")).tobytes()


def decode_embeddings(blob: bytes | None) -> np.ndarray:
    """BLOB → (n_windows, dim) float64 矩阵；空 BLOB 返回 0 行。"""
    if not blob:
        return np.zeros((0, 0), dtype=np.float64)
    flat = np.frombuffer(blob, dtype="<f4")
    if flat.size == 0:
        return np.zeros((0, 0), dtype=np.float64)
    return flat.astype(np.float64)


def _matrix(blob: bytes | None, n_windows: int, dim: int) -> np.ndarray:
    flat = decode_embeddings(blob)
    if n_windows <= 0 or dim <= 0 or flat.size != n_windows * dim:
        return np.zeros((0, 0), dtype=np.float64)
    return flat.reshape(n_windows, dim)


class SpeakerDiarizationService:
    def __init__(
        self,
        db: Database,
        ffmpeg: Path,
        resolve_asset_path: Callable[[str], dict[str, str]],
        *,
        model_manager: Any = None,
        ffprobe: Any = None,
    ) -> None:
        self.db = db
        self.ffmpeg = ffmpeg
        self._resolve = resolve_asset_path
        self.model_manager = model_manager
        self.ffprobe = ffprobe
        self._vad: SileroVoiceActivity | None = None
        self._embedder: SpeakerEmbedder | None = None

    # ------------------------------------------------------------ 模型就绪判定

    def availability(self) -> dict[str, Any]:
        """VAD + embedding 模型就绪判定（**不抛**：把 O1 耦合变成可测分支）。"""
        try:
            vad_path: str | None = str(require_silero_asset_path())
        except SileroAssetMissing:
            vad_path = None
        embed_path: str | None = None
        reason: str | None = "silero_asset_missing" if vad_path is None else None
        if self.model_manager is not None:
            try:
                ready = self.model_manager.ready_path(EMBEDDING_MODEL_ID)
                embed_path = str(ready)
            except ModelError:
                embed_path = None
                if reason is None:
                    reason = "embedding_model_missing"
            except Exception:
                embed_path = None
                if reason is None:
                    reason = "embedding_model_missing"
        else:
            reason = reason or "embedding_model_missing"
        return {"ready": reason is None, "reason": reason,
                "vad_path": vad_path, "embedding_dir": embed_path}

    def _vad_session(self) -> SileroVoiceActivity:
        if self._vad is None:
            self._vad = SileroVoiceActivity(require_silero_asset_path())
        return self._vad

    def _embedder_session(self) -> SpeakerEmbedder:
        """**唯一**构造 ONNX 会话的地方（重聚类路径绝不触及）。"""
        global EMBEDDER_SESSION_COUNT
        if self._embedder is None:
            assert self.model_manager is not None
            directory = self.model_manager.ready_path(EMBEDDING_MODEL_ID)
            from .speaker_embedding import EMBEDDING_MODEL_FILE

            self._embedder = SpeakerEmbedder(directory / EMBEDDING_MODEL_FILE)
            EMBEDDER_SESSION_COUNT += 1
        return self._embedder

    def embedding_model_revision(self) -> str | None:
        if self.model_manager is None:
            return None
        try:
            manifest = self.model_manager.registry.get(EMBEDDING_MODEL_ID)
        except Exception:
            return None
        return str(getattr(manifest, "revision", "") or "") or None

    # ------------------------------------------------------------ 解码

    async def decode_pcm(
        self, input_path: Path, cancel_event: asyncio.Event | None = None
    ) -> np.ndarray:
        process = await asyncio.create_subprocess_exec(
            str(self.ffmpeg),
            *pcm_s16le_args(str(input_path)),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(asyncio.subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert process.stdout is not None
        chunks: list[bytes] = []
        cancelled = False
        while True:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                process.kill()
                break
            chunk = await process.stdout.read(1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
        await process.wait()
        if cancelled:
            raise DomainError("JOB_CANCELLED", "任务已取消")
        raw = b"".join(chunks)
        if not raw:
            return np.zeros(0, dtype=np.float64)
        return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0

    # ------------------------------------------------------------ 核心分析（纯注入）

    def analyze_pcm(
        self,
        asset_id: str,
        source_fingerprint: str,
        pcm: np.ndarray,
        *,
        voiced: np.ndarray,
        strategy: str = "silhouette_capk",
        k_max: int = sp.DEFAULT_K_MAX,
        threshold: float | None = None,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        embedder: SpeakerEmbedder | None = None,
        model_revision: str | None = None,
        vad_model: str = VAD_MODEL_ID,
    ) -> dict[str, Any]:
        """VAD 掩码 + PCM → 落库（测试直接注入 voiced / embedder，不碰 ONNX）。"""
        samples = np.asarray(pcm, dtype=np.float64).reshape(-1)
        total_s = samples.shape[0] / float(sample_rate)
        grid = sp.window_grid(total_s)
        indices = sp.select_windows(grid, voiced)
        windows = [grid[i] for i in indices]

        turns: list[dict[str, Any]] = []
        # **不要**在这里用 threshold 当累加器——它会遮蔽同名入参（本实现首版即踩：
        # 外部传入的 oracle τ 被静默丢弃，τ 扫描给出"所有 τ 同结果"的假结论）。
        chosen_threshold: float | None = threshold
        threshold_strategy: str | None = None
        status, reason = "ready", None
        embeddings: np.ndarray | None = None

        if not windows:
            status, reason = "unavailable", "no_speech"
        else:
            vectors = np.asarray(
                [embedder.embed(samples[int(a * sample_rate) : int(b * sample_rate)])
                 for a, b in windows],
                dtype=np.float64,
            ) if embedder is not None else np.zeros((0, 0), dtype=np.float64)
            if vectors.shape[0] != len(windows):
                status, reason = "failed", "embedding_unavailable"
            else:
                embeddings = vectors
                dendro = sp.build_dendrogram(vectors)
                if chosen_threshold is None:
                    chosen_threshold, threshold_strategy = sp.choose_threshold(
                        dendro, vectors, k_max=k_max, strategy=strategy
                    )
                else:
                    # **oracle 上界**入口（门 §5 的既有方法论：用真值调 τ 只用来
                    # 判断"哪个环节有欠账"，不得当作可达精度）。策略名显式标注，
                    # 使"这条 τ 是外部给的"在摘要里可见。
                    threshold_strategy = "oracle:external"
                labels = sp.labels_at(dendro, float(chosen_threshold))
                turns = sp.windows_to_turns(windows, labels, total_s)

        row_id = f"speaker_diarization_{new_id()}"
        speaker_count = len({int(t["speaker"]) for t in turns}) if turns else None
        blob = encode_embeddings(embeddings) if embeddings is not None else None
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,reason,speaker_count,turns_json,windows_json,"
                "embeddings_blob,embedding_model,model_revision,vad_model,threshold,"
                "threshold_strategy,sample_rate,quality_status,quality_basis,usable_for,"
                "created_at,updated_at,finished_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row_id, asset_id, source_fingerprint, SPEAKER_ALGORITHM_VERSION,
                    status, reason, speaker_count,
                    json_dumps(turns),
                    json_dumps([[float(a), float(b)] for a, b in windows]),
                    blob,
                    EMBEDDING_MODEL_ID if embedder is not None else None,
                    model_revision,
                    vad_model,
                    chosen_threshold,
                    threshold_strategy,
                    sample_rate,
                    # 降级交付标注（D3）：**每次落库都写**，不依赖列默认值——
                    # 默认值是迁移的安全网，不是写入路径的省事手段。
                    QUALITY_STATUS_UNVALIDATED,
                    QUALITY_GATE_BASIS,
                    USABLE_FOR_REFERENCE_ONLY,
                    now, now, now,
                ),
            )
        return {
            "speaker_diarization_id": row_id,
            "asset_id": asset_id,
            "status": status,
            "reason": reason,
            "speaker_count": speaker_count,
            "turn_count": len(turns),
            "window_count": len(windows),
            "threshold": chosen_threshold,
            "threshold_strategy": threshold_strategy,
        }

    async def analyze_path(
        self,
        asset_id: str,
        source_fingerprint: str,
        input_path: Path,
        cancel_event: asyncio.Event | None = None,
        *,
        strategy: str = "silhouette_capk",
        k_max: int = sp.DEFAULT_K_MAX,
    ) -> dict[str, Any]:
        """真实链路：模型就绪 → 解码 → Silero VAD → 窗 embedding → 聚类 → 落库。"""
        ready = self.availability()
        if not ready["ready"]:
            return self._write_row(
                asset_id, source_fingerprint, "unavailable", ready["reason"],
                None, [], [], None, None, None,
            )
        pcm = await self.decode_pcm(input_path, cancel_event)
        if pcm.shape[0] / DEFAULT_SAMPLE_RATE < MIN_DURATION_S:
            return self._write_row(
                asset_id, source_fingerprint, "unavailable", "too_short",
                None, [], [], None, None, None,
            )
        voiced = self._vad_session().voiced_10ms(pcm)
        return self.analyze_pcm(
            asset_id, source_fingerprint, pcm, voiced=voiced,
            strategy=strategy, k_max=k_max, embedder=self._embedder_session(),
            model_revision=self.embedding_model_revision(),
        )

    def _write_row(
        self, asset_id: str, source_fingerprint: str, status: str, reason: str | None,
        threshold: float | None, turns: list[dict[str, Any]],
        windows: list[list[float]], blob: bytes | None, strategy: str | None,
        sample_rate: int | None,
    ) -> dict[str, Any]:
        row_id = f"speaker_diarization_{new_id()}"
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,reason,speaker_count,turns_json,windows_json,"
                "embeddings_blob,embedding_model,model_revision,vad_model,threshold,"
                "threshold_strategy,sample_rate,quality_status,quality_basis,usable_for,"
                "created_at,updated_at,finished_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    row_id, asset_id, source_fingerprint, SPEAKER_ALGORITHM_VERSION,
                    status, reason, None, json_dumps(turns), json_dumps(windows), blob,
                    None, None, VAD_MODEL_ID, threshold, strategy, sample_rate,
                    QUALITY_STATUS_UNVALIDATED, QUALITY_GATE_BASIS,
                    USABLE_FOR_REFERENCE_ONLY,
                    now, now, now,
                ),
            )
        return {
            "speaker_diarization_id": row_id, "asset_id": asset_id,
            "status": status, "reason": reason, "speaker_count": None,
            "turn_count": 0, "window_count": len(windows),
            "threshold": threshold, "threshold_strategy": strategy,
        }

    # ------------------------------------------------------------ 存储：摘要 / 行选择

    def latest_row(self, asset_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                f"SELECT {SUMMARY_COLUMNS} FROM speaker_diarizations "  # noqa: S608（常量投影）
                "WHERE asset_id=? AND algorithm_version=? "
                "ORDER BY created_at DESC LIMIT 1",
                (asset_id, SPEAKER_ALGORITHM_VERSION),
            ).fetchone()
        return dict(row) if row else None

    def rows_for_asset(self, asset_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                f"SELECT {SUMMARY_COLUMNS} FROM speaker_diarizations "  # noqa: S608
                "WHERE asset_id=? AND algorithm_version=? ORDER BY created_at DESC",
                (asset_id, SPEAKER_ALGORITHM_VERSION),
            ).fetchall()
        return [dict(row) for row in rows]

    def summary(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        """摘要（Renderer 可见；**无路径字段、无 BLOB**）。stale 读时算。"""
        row = self.latest_row(asset_row["id"])
        if row is None:
            return None
        status = str(row["status"])
        if status in {"ready", "unavailable"} and (
            row["source_fingerprint"] != asset_row["fingerprint"]
        ):
            status = "stale"
        turns = json_loads(row["turns_json"] or "[]")
        return {
            "speaker_diarization_id": row["id"],
            "status": status,
            "reason": row["reason"],
            "speaker_count": row["speaker_count"],
            "turn_count": len(turns),
            "window_count": len(json_loads(row["windows_json"] or "[]")),
            "threshold": row["threshold"],
            "threshold_strategy": row["threshold_strategy"],
            # 降级交付标注必须**透出到摘要**（只存表里等于下游看不见）
            "quality_status": row["quality_status"],
            "quality_basis": row["quality_basis"],
            "usable_for": json_loads(row["usable_for"] or '["reference"]'),
            "algorithm_version": str(row["algorithm_version"]),
            "embedding_model": row["embedding_model"],
            "vad_model": row["vad_model"],
            "recorded_at": row["finished_at"] or row["created_at"],
        }

    # ------------------------------------------------------------ 作业

    def create_job(self, project_id: str, asset_row: dict[str, Any]) -> str | None:
        """登记说话人分离作业；幂等/在飞短路时返回 None。"""
        summary = self.summary(asset_row)
        if summary and summary["status"] in ("ready", "unavailable", "stale"):
            return None
        with self.db.connection() as db:
            active = db.execute(
                "SELECT id FROM jobs WHERE kind='speaker_diarization' "
                "AND status IN ('queued','running') AND project_id=? "
                "AND input_json LIKE ?",
                (project_id, "%" + asset_row["id"] + "%"),
            ).fetchone()
        if active is not None:
            return None
        job_id = new_id()
        now = utc_now()
        payload = {
            "asset_id": asset_row["id"],
            "asset_fingerprint": str(asset_row["fingerprint"]),
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,"
                "progress,input_json,encoder_requested,resource_class,attempt,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, project_id, asset_row["id"], "speaker_diarization",
                 "speaker_diarization", "queued", "queued", 0, json_dumps(payload),
                 None, "light", 1, now, now),
            )
        return job_id

    async def run_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Callable[[float], None] | None = None,
        stage: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        payload = json_loads(row["input_json"])
        asset_id = payload.get("asset_id")
        fingerprint = payload.get("asset_fingerprint")
        if not asset_id or not fingerprint:
            raise DomainError("SPEAKER_JOB_INVALID", "非说话人分离作业载荷")
        try:
            resolved = self._resolve(asset_id)
        except DomainError as exc:
            if exc.code in {"ASSET_MISSING", "ASSET_CHANGED"}:
                return self._write_row(asset_id, fingerprint, "unavailable",
                                       "asset_not_available", None, [], [], None, None, None)
            raise
        if stage:
            stage("speaker:vad")
        if progress:
            progress(0.2)
        result = await self.analyze_path(
            asset_id, fingerprint, Path(resolved["path"]), cancel_event
        )
        if progress:
            progress(1.0)
        return result

    # ------------------------------------------------------------ 重聚类（不重跑推理）

    def recluster(
        self,
        asset_id: str,
        *,
        strategy: str = "silhouette_capk",
        k_max: int = sp.DEFAULT_K_MAX,
    ) -> dict[str, Any]:
        """换 τ / 换策略：**只读已存 embedding，重跑聚类**（不构造 ONNX 会话）。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT id,asset_id,source_fingerprint,status,turns_json,windows_json,"
                "embeddings_blob,embedding_model,model_revision,sample_rate,"
                "threshold_strategy FROM speaker_diarizations "
                "WHERE asset_id=? AND algorithm_version=? AND status='ready' "
                "ORDER BY created_at DESC LIMIT 1",
                (asset_id, SPEAKER_ALGORITHM_VERSION),
            ).fetchone()
        if row is None:
            raise DomainError("SPEAKER_NOT_FOUND", "没有可重聚类的分析结果")
        windows = [(float(a), float(b)) for a, b in json_loads(row["windows_json"] or "[]")]
        blob = row["embeddings_blob"]
        dim = int(np.frombuffer(blob, dtype="<f4").size // max(len(windows), 1)) if blob else 0
        vectors = _matrix(blob, len(windows), dim)
        if windows and vectors.shape[0] != len(windows):
            raise DomainError("SPEAKER_EMBEDDINGS_MISSING", "该行没有可用的窗 embedding")
        if not windows:
            raise DomainError("SPEAKER_NO_WINDOWS", "该行没有可用窗")
        dendro = sp.build_dendrogram(vectors)
        threshold, chosen = sp.choose_threshold(
            dendro, vectors, k_max=k_max, strategy=strategy
        )
        labels = sp.labels_at(dendro, threshold)
        total_s = windows[-1][1]
        turns = sp.windows_to_turns(windows, labels, total_s)
        speaker_count = len({int(t["speaker"]) for t in turns}) if turns else None
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "UPDATE speaker_diarizations SET turns_json=?,speaker_count=?,threshold=?,"
                "threshold_strategy=?,updated_at=? WHERE id=?",
                (json_dumps(turns), speaker_count, threshold,
                 f"recluster:{chosen}", now, row["id"]),
            )
        return {
            "speaker_diarization_id": row["id"],
            "asset_id": asset_id,
            "status": "ready",
            "speaker_count": speaker_count,
            "turn_count": len(turns),
            "window_count": len(windows),
            "threshold": threshold,
            "threshold_strategy": f"recluster:{chosen}",
            "previous_strategy": row["threshold_strategy"],
        }
