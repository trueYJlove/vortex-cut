"""W3.1 素材池语义检索：ONNX 双塔 + 索引服务。

规划门：`docs/W3_1_SEMANTIC_SEARCH_PLANNING_GATE_2026-10-18.md` §2.1–§2.5。

分层纪律（与 beat_grid / speaker 同款）：
- 纯算法在 `semantic.py`（零 I/O，可单测）；
- 解码/ONNX/落库在本模块；
- 全链路**零 egress**（ADR-0003 D4）：模型经受信清单一次性下载，推理纯本地。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import numpy as np

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError
from .clip_tokenizer import load_tokenizer
from .wordpiece_tokenizer import load_wordpiece_tokenizer
from .semantic import (
    DEFAULT_SEARCH_K,
    INDEX_ALGORITHM_VERSION,
    aggregate_embeddings,
    cosine_rank,
    l2_normalize,
    pack_embeddings,
    thin_frames,
    unpack_embeddings,
)

MODEL_ID = "clip-vit-base-patch32"
VISION_FILE = "vision_model.onnx"
TEXT_FILE = "text_model.onnx"

# W3.1 中文优先（用户 2026-10-19 裁决）：中文 CLIP ViT-B/16。
# 与现役英文 CLIP 的关键差异（P150–P153 实测）：
#   - 分词器：BERT WordPiece（中文单字有真实语义 id）vs 手写 BPE（中文走字节回退）
#   - context length：52 vs 77
#   - 视觉塔：ViT-B/16（196 token）vs B/32（49 token）⇒ 视觉推理慢约 3.9×，
#     但 D2 索引门限实测仍有约 2× 余量（推算 14.9 vs 门限 30 s/源分钟）
# 效果：中文词查询 top1 0.30→1.00、中文句查询 0.62→1.00（P151/P152）
ZH_MODEL_ID = "chinese-clip-vit-base-patch16"
ZH_CONTEXT_LEN = 52

# CLIP 标准输入（ViT-B/32）：224×224 RGB、像素归一到 [-1,1]。
CLIP_IMAGE_SIZE = 224
# ImageNet 统计量——CLIP 官方 preprocessor_config.json 同值。
CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)

# 抽帧：默认每 N 秒取一帧（关键帧语义由 FFmpeg select 表达式保证）。
DEFAULT_SAMPLE_INTERVAL_S = 2.0


class SemanticError(DomainError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message)


def rgb_frames_args(input_path: str, interval_s: float = DEFAULT_SAMPLE_INTERVAL_S) -> list[str]:
    """抽帧到 stdout（rawvideo rgb24，224×224）。

    select 表达式与 cv_signals 同款思路：关键帧 **或** 距上次输出 ≥ 间隔。
    这里额外先把每帧缩放到 224×224（CLIP 输入），避免整帧 RGB 传输出巨大带宽。
    """
    expr = f"eq(pict_type\\,I)+gte(t-prev_selected_t\\,{interval_s})"
    return [
        "-hide_banner", "-nostdin",
        "-i", input_path,
        "-an",
        "-vf", f"select='{expr}',scale={CLIP_IMAGE_SIZE}:{CLIP_IMAGE_SIZE}",
        "-fps_mode", "vfr",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "pipe:1",
    ]


def preprocess_image(frame_rgb: np.ndarray) -> np.ndarray:
    """(H,W,3) uint8 → (1,3,224,224) float32（CLIP 归一化，CHW）。"""
    arr = np.asarray(frame_rgb, dtype=np.float64) / 255.0
    arr = (arr - np.asarray(CLIP_MEAN)) / np.asarray(CLIP_STD)
    chw = np.transpose(arr, (2, 0, 1))
    return np.ascontiguousarray(chw, dtype=np.float32)[None, ...]


class ClipEncoder:
    """CLIP 双塔 ONNX 会话包装（vision + text 分离）。"""

    def __init__(self, vision_path: str | Path, text_path: str | Path, *, num_threads: int = 1) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = num_threads
        options.inter_op_num_threads = 1
        self.vision = ort.InferenceSession(
            str(vision_path), options, providers=["CPUExecutionProvider"]
        )
        self.text = ort.InferenceSession(
            str(text_path), options, providers=["CPUExecutionProvider"]
        )
        self._v_in = self.vision.get_inputs()[0].name
        self._v_out = self.vision.get_outputs()[0].name
        self._t_in = self.text.get_inputs()[0].name
        self._t_out = self.text.get_outputs()[0].name

    def encode_image(self, frames: np.ndarray) -> np.ndarray:
        """(N,3,224,224) float32 → (N,dim) L2 归一化 float64。"""
        if frames.size == 0:
            return np.zeros((0, 0), dtype=np.float64)
        out = self.vision.run([self._v_out], {self._v_in: frames})[0]
        return np.stack([l2_normalize(row) for row in np.asarray(out, dtype=np.float64)])

    def encode_text(self, input_ids: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
        """(1,T) int64 输入 → (dim,) L2 归一化 float64。"""
        feeds = {self._t_in: np.asarray(input_ids, dtype=np.int64)}
        names = {i.name for i in self.text.get_inputs()}
        if "attention_mask" in names:
            feeds["attention_mask"] = np.asarray(attention_mask, dtype=np.int64)
        out = self.text.run([self._t_out], feeds)[0]
        return l2_normalize(np.asarray(out, dtype=np.float64).reshape(-1))


def _tokenizer_kind(tokenizer_path: str | Path) -> str:
    """从 tokenizer.json 读 model.type（'BPE' / 'WordPiece'）。

    为什么按文件内容而非模型常量分派：分词器与模型同目录落地，
    类型就写在 tokenizer.json 里；读它比维护一张「模型→分词器」映射表
    更不容易漂移（新增模型只要清单随之落地即自动正确）。
    """
    data = json.loads(Path(tokenizer_path).read_text(encoding="utf-8"))
    return str((data.get("model") or {}).get("type") or "")


def clip_tokenize(text: str, tokenizer_path: str | Path, max_len: int = 77) -> tuple[np.ndarray, np.ndarray]:
    """CLIP 分词（按 tokenizer.json 的 model.type 分派）。

    - `BPE`（现役英文 CLIP）：`clip_tokenizer.ClipTokenizer`，词尾 `</w>` 后缀；
    - `WordPiece`（中文 CLIP，W3.1 中文优先）：`wordpiece_tokenizer.WordPieceTokenizer`，
      `[CLS]/[SEP]/[PAD]` + `##` 续接前缀。

    两者均与参考实现（`tokenizers` 库）**逐 token 一致**，含超长截断边界。
    """
    kind = _tokenizer_kind(tokenizer_path)
    if kind == "WordPiece":
        return load_wordpiece_tokenizer(str(tokenizer_path)).encode(str(text), max_len)
    tokenizer = load_tokenizer(str(tokenizer_path))
    return tokenizer.encode(str(text), max_len)


class SemanticIndexService:
    def __init__(self, db: Database, ffmpeg: Path, *, model_manager: Any = None) -> None:
        self.db = db
        self.ffmpeg = ffmpeg
        self.model_manager = model_manager

    # ---------------------------------------------------------------- 查询

    def latest_index(self, asset_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM asset_semantic_index WHERE asset_id=? AND algorithm_version=? "
                "AND status IN ('ready','unavailable') ORDER BY created_at DESC LIMIT 1",
                (asset_id, INDEX_ALGORITHM_VERSION),
            ).fetchone()
        return dict(row) if row else None

    def index_summary(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        row = self.latest_index(str(asset_row["id"]))
        if not row:
            return None
        stale = str(row.get("source_fingerprint") or "") != str(asset_row.get("fingerprint") or "")
        return {
            "index_id": row["id"],
            "status": "stale" if stale and row["status"] == "ready" else row["status"],
            "reason": row.get("reason"),
            "frame_count": row.get("frame_count") or 0,
            "algorithm_version": row.get("algorithm_version"),
            "model_id": row.get("model_id"),
            "model_revision": row.get("model_revision"),
        }

    # ---------------------------------------------------------------- 检索

    def search_text(self, project_id: str, query: str, limit: int = DEFAULT_SEARCH_K) -> list[dict[str, Any]]:
        """自然语言查询入口：分词 → 文本塔编码 → 项目内余弦检索。

        ⚠️ **本切片的分词是占位实现**（`clip_tokenize` 的 TODO）。因此：
        - 链路（HTTP → 编码 → 检索 → DTO）真实可用，可端到端断言；
        - **检索质量不可用**，且本门 A8 已显式留空 —— 不得据此宣称命中率。
        替换为真实 BPE 后无需改动本方法签名。
        """
        vision, text_path = self._model_paths()
        if text_path is None:
            raise SemanticError("SEMANTIC_MODEL_NOT_INSTALLED", "语义模型尚未安装")
        tokenizer = text_path.parent / "tokenizer.json"
        # context length 必须与**导出该塔时**一致：现役英文 CLIP 77，
        # 中文 CLIP 52（其 text 塔 ONNX 的 sequence_length 是固定维度，
        # 传错长度会直接抛 shape 错误 —— 见 P151 实测）。
        context_len = ZH_CONTEXT_LEN if _tokenizer_kind(tokenizer) == "WordPiece" else 77
        input_ids, mask = clip_tokenize(query, tokenizer, context_len)
        encoder = ClipEncoder(vision, text_path)  # type: ignore[arg-type]
        query_vec = encoder.encode_text(input_ids, mask)
        return self.search(project_id, query_vec, limit)

    def search(
        self,
        project_id: str,
        query_vec: np.ndarray,
        limit: int = DEFAULT_SEARCH_K,
    ) -> list[dict[str, Any]]:
        """项目内语义检索：只读已 ready 的索引行，**绝不跨项目**。"""
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT i.asset_id, i.embeddings_blob, i.embedding_dim, i.frames_json "
                "FROM asset_semantic_index i JOIN assets a ON a.id = i.asset_id "
                "WHERE a.project_id = ? AND i.algorithm_version = ? AND i.status = 'ready'",
                (project_id, INDEX_ALGORITHM_VERSION),
            ).fetchall()

        candidates: list[tuple[str, np.ndarray]] = []
        for row in rows:
            matrix = unpack_embeddings(row["embeddings_blob"], int(row["embedding_dim"] or 0))
            if matrix.size == 0:
                continue
            agg = aggregate_embeddings(list(matrix))
            if agg is not None:
                candidates.append((str(row["asset_id"]), agg))
        return cosine_rank(query_vec, candidates, limit)

    # ---------------------------------------------------------------- 作业

    def create_index_job(self, project_id: str, asset_row: dict[str, Any], path: str) -> str:
        job_id = new_id()
        now = utc_now()
        stat = Path(path).stat()
        payload = {
            "asset_id": asset_row["id"],
            "asset_fingerprint": str(asset_row["fingerprint"]),
            "path": str(path),
            "size_bytes": stat.st_size,
            "modified_at": stat.st_mtime_ns,
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,"
                "progress,input_json,encoder_requested,resource_class,attempt,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id, project_id, asset_row["id"], "semantic_index", "semantic_index",
                    "queued", "queued", 0, json_dumps(payload),
                    None, "light", 1, now, now,
                ),
            )
        return job_id

    async def run_index_job(
        self,
        row: Any,
        cancel_event: asyncio.Event,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        payload = json_loads(row["input_json"])
        if "asset_id" not in payload or "path" not in payload:
            raise SemanticError("SEMANTIC_JOB_INVALID", "非语义索引作业载荷")
        input_path = Path(payload["path"])
        if not input_path.is_file():
            raise SemanticError("MEDIA_CHANGED", "素材文件不存在")
        stat = input_path.stat()
        if ("size_bytes" in payload and "modified_at" in payload) and (
            stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]
        ):
            raise SemanticError("MEDIA_CHANGED", "素材文件已变化")
        if stage:
            stage("semantic:decode")
        result = await self.index_path(
            payload["asset_id"], payload["asset_fingerprint"], input_path, cancel_event, stage=stage
        )
        if progress:
            progress(1.0)
        return {"index_id": result["index_id"], "status": result["status"],
                "frame_count": len(result.get("frames") or [])}

    async def index_path(
        self,
        asset_id: str,
        source_fingerprint: str,
        input_path: Path,
        cancel_event: asyncio.Event | None = None,
        *,
        stage: Any = None,
    ) -> dict[str, Any]:
        """解码抽帧 → 编码 → 落库。模型缺失 ⇒ unavailable（显式降级，非崩溃）。"""
        vision, text = self._model_paths()
        if vision is None or text is None:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="model_not_installed", frames=[], matrix=None)

        frames_bytes = await self._decode_frames(input_path, cancel_event)
        if frames_bytes is None:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="no_video_stream", frames=[], matrix=None)
        if stage:
            stage("semantic:encode")

        count = len(frames_bytes)
        picked = thin_frames(count)
        if picked:
            frames_bytes = [frames_bytes[i] for i in picked]

        encoder = ClipEncoder(vision, text)
        batch = np.stack([preprocess_image(f)[0] for f in frames_bytes]) if frames_bytes else np.zeros((0, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE), dtype=np.float32)
        matrix = encoder.encode_image(batch) if len(batch) else np.zeros((0, 0))
        if matrix.size == 0:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="no_frames", frames=[], matrix=None)
        return self._persist(asset_id, source_fingerprint, "ready", reason=None,
                             frames=list(range(len(frames_bytes))), matrix=matrix)

    # ---------------------------------------------------------------- 内部

    def _model_paths(self) -> tuple[Path | None, Path | None]:
        """经 model_manager 解析安装目录；未就绪返回 (None, None)。

        走 registry 而不是自己拼路径：受信清单/目录约定/就绪标记集中一处，
        与 faster-whisper / CAM++ 同一条路径。
        """
        if self.model_manager is None:
            return None, None
        try:
            # ready_path 已返回**该模型的安装目录**（models/clip/<model_id>/），
            # 不可再拼一层——曾在此多拼一次导致「模型已装却报未安装」。
            root = Path(self.model_manager.ready_path(MODEL_ID))
        except Exception:
            return None, None
        vision = root / VISION_FILE
        text = root / TEXT_FILE
        if vision.is_file() and text.is_file():
            return vision, text
        return None, None

    async def _decode_frames(self, input_path: Path, cancel_event: asyncio.Event | None) -> list[np.ndarray] | None:
        """单遍 FFmpeg 抽帧到 stdout；无视频流 ⇒ None。"""
        proc = await asyncio.create_subprocess_exec(
            str(self.ffmpeg), *rgb_frames_args(str(input_path)),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        frame_size = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE * 3
        frames: list[np.ndarray] = []
        try:
            assert proc.stdout is not None
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise asyncio.CancelledError()
                chunk = await proc.stdout.readexactly(frame_size)
                frames.append(np.frombuffer(chunk, dtype=np.uint8).reshape(
                    CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, 3))
        except asyncio.IncompleteReadError:
            pass
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
        return frames

    def _persist(
        self, asset_id: str, source_fingerprint: str, status: str, *,
        reason: str | None, frames: list[int], matrix: np.ndarray | None,
    ) -> dict[str, Any]:
        index_id = new_id()
        now = utc_now()
        dim = int(matrix.shape[1]) if matrix is not None and matrix.ndim == 2 and matrix.shape[1] else 0
        blob = pack_embeddings(matrix) if matrix is not None and matrix.size else None
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,reason,frame_count,embedding_dim,frames_json,"
                "embeddings_blob,model_id,model_revision,created_at,updated_at,finished_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    index_id, asset_id, source_fingerprint, INDEX_ALGORITHM_VERSION,
                    status, reason, len(frames), dim, json_dumps(frames), blob,
                    MODEL_ID, "xenova-clip-vit-base-patch32", now, now, now,
                ),
            )
        return {"index_id": index_id, "status": status, "reason": reason, "frames": frames}
