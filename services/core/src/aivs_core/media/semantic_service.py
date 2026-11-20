"""W3.1 素材池语义检索：ONNX 双塔 + 索引服务。

规划门：`docs/requirements/W3_1_SEMANTIC_SEARCH_PLANNING_GATE_2026-10-18.md` §2.1–§2.5。

分层纪律（与 beat_grid / speaker 同款）：
- 纯算法在 `semantic.py`（零 I/O，可单测）；
- 解码/ONNX/落库在本模块；
- 全链路**零 egress**（ADR-0003 D4）：模型经受信清单一次性下载，推理纯本地。
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
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
#   - 视觉塔：ViT-B/16（196 token）vs B/32（49 token）⇒ 索引编码更慢。
#     **2026-10-20 实测（P159），原「推算 3.9× / 14.9 s / 约 2× 余量」已作废**：
#     fp32 双塔 17.8 s/源分钟 vs quantized 单塔 11.6（只计编码；含抽帧 20.1 vs 13.9），
#     对门限 30 的余量是 1.7× 而非 2×。检索侧方向相反：fp32 107 ms 快于
#     quantized 317 ms——双塔查询只跑文本塔，单塔每次都要带整个合并模型。
# 效果：中文词查询 top1 0.30→1.00、中文句查询 0.62→1.00（P151/P152）
ZH_MODEL_ID = "chinese-clip-vit-base-patch16"
ZH_CONTEXT_LEN = 52

EN_CONTEXT_LEN = 77

# 模型选择顺序 = 「中文优先」（用户 2026-10-19 裁决）：中文 ready 则用它，
# 否则回退英文；两者都不可用 ⇒ 未安装。
#
# 为什么要有这张表：修复前模型 id / revision / context length 分散在三处
# （`_model_paths()` 写死英文 MODEL_ID、`_persist()` 写死英文 revision、
# `search_text()` 按分词器类型猜 context length），三套判据各自漂移，
# 结果是「装了中文模型也不会被使用」且索引永远记成英文模型。
_MODEL_PREFERENCE: tuple[str, ...] = (ZH_MODEL_ID, MODEL_ID)
_MODEL_CONTEXT_LENGTH = {ZH_MODEL_ID: ZH_CONTEXT_LEN, MODEL_ID: EN_CONTEXT_LEN}
# 受信清单不可达时的兜底 revision（正常路径读清单：ready 校验本就按清单
# revision 做，写死一份等于允许两者漂移）。
_MODEL_REVISION_FALLBACK = {
    ZH_MODEL_ID: "zh-export-2026-10-19",
    MODEL_ID: "xenova-clip-vit-base-patch32",
}

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


@dataclass(frozen=True)
class ActiveModel:
    """当前生效的语义模型（模型选择收敛于此，唯一来源）。

    model_id / revision 决定索引行归属与检索过滤：两个模型的 embedding
    **同为 512 维**，混排不会抛 shape 错误，只会静默地把两个向量空间的
    向量做 cosine —— 所以归属必须显式携带，不能靠维度区分。
    """

    model_id: str
    revision: str
    context_len: int
    vision_path: Path
    text_path: Path


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

    def latest_index(
        self, asset_id: str, *, active: ActiveModel | None = None
    ) -> dict[str, Any] | None:
        """该素材在**当前 active model** 下的最新索引行；模型切换后旧行不再返回。

        为什么要按 model_id / model_revision 过滤：两个模型的 embedding 同为
        512 维，混在一起不会抛 shape 错误，只会**静默地**把两个向量空间的向量
        做 cosine —— 返回一堆看似正常、实际无意义的排序。

        active 为 None（无模型可用）时不加过滤：此时无从归属，调用方（摘要）
        需要看到既有行才能报告「未安装」，检索侧另有守卫。

        ⚠️ 不传 `active` 时本方法会自己解析模型：解析要校验大文件 sha256，
        批量调用方（摘要）请显式传入以免重复解析。
        """
        if active is None:
            active = self._active_model()
        sql = (
            "SELECT * FROM asset_semantic_index WHERE asset_id=? AND algorithm_version=? "
            "AND status IN ('ready','unavailable')"
        )
        params: list[Any] = [asset_id, INDEX_ALGORITHM_VERSION]
        if active is not None:
            sql += " AND model_id=? AND model_revision=?"
            params.extend([active.model_id, active.revision])
        sql += " ORDER BY created_at DESC LIMIT 1"
        with self.db.connection() as db:
            row = db.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

    def _latest_any_model_index(self, asset_id: str) -> dict[str, Any] | None:
        """任一模型的最近索引行（仅用于「别的模型产的索引」失鲜上报）。"""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM asset_semantic_index WHERE asset_id=? AND algorithm_version=? "
                "AND status IN ('ready','unavailable') ORDER BY created_at DESC LIMIT 1",
                (asset_id, INDEX_ALGORITHM_VERSION),
            ).fetchone()
        return dict(row) if row else None

    def index_summary(self, asset_row: dict[str, Any]) -> dict[str, Any] | None:
        """端点摘要。**别的模型产的索引一律报 stale**（不可用，不是可比较的）。

        stale 是本仓既有的读时状态词汇（`cv_signals.analysis_summary` :1244、
        `speaker_service.summary` :411、契约 `TranscriptStatus`），而 `asset_semantic_index`
        的 status CHECK 集合不含 stale —— 与指纹失鲜一样，只在读侧计算。
        """
        asset_id = str(asset_row["id"])
        active = self._active_model()
        row = self.latest_index(asset_id, active=active)
        owned = row is not None
        if row is None:
            row = self._latest_any_model_index(asset_id)
            if row is None:
                return None
        status = str(row["status"])
        if active is not None and not owned:
            status = "stale"
        elif status == "ready" and str(row.get("source_fingerprint") or "") != str(
            asset_row.get("fingerprint") or ""
        ):
            status = "stale"
        return {
            "index_id": row["id"],
            "status": status,
            "reason": row.get("reason"),
            "frame_count": row.get("frame_count") or 0,
            "algorithm_version": row.get("algorithm_version"),
            "model_id": row.get("model_id"),
            "model_revision": row.get("model_revision"),
        }

    # ---------------------------------------------------------------- 检索

    def search_text(self, project_id: str, query: str, limit: int = DEFAULT_SEARCH_K) -> list[dict[str, Any]]:
        """自然语言查询入口：分词 → 文本塔编码 → 项目内余弦检索。

        分词是**真实实现**：`clip_tokenize` 按 `tokenizer.json` 的 `model.type`
        分派 —— `BPE`（英文 CLIP）/ `WordPiece`（中文 CLIP），两者均与
        `tokenizers` 库逐 token 一致（含超长截断边界）。context length 由
        **active model** 决定（中文 52 / 英文 77，见 `ActiveModel`）：两个文本塔
        的 ONNX 输入维度不同，传错直接抛 shape 错误。

        ⚠️ **但门 §3 A8（C2 命中率）仍显式留空** —— 原因是**评测语料限制**
        （P142 语料无语义、P143 中文端到端未测），不是管线缺陷。因此：
        - 链路（HTTP → 分词 → 编码 → 检索 → DTO）真实可用，可端到端断言；
        - **不得据本方法宣称命中率**：管线可用 ≠ 能力达标，两者不能互相冒充。
        """
        active = self._require_active_model()
        tokenizer = active.text_path.parent / "tokenizer.json"
        # context length 由模型决定，与 id 同源（见 ActiveModel）：中文 CLIP 的
        # text 塔 sequence_length 是固定维度 52，传错直接抛 shape 错误（P151 实测）。
        input_ids, mask = clip_tokenize(query, tokenizer, active.context_len)
        encoder = ClipEncoder(active.vision_path, active.text_path)
        query_vec = encoder.encode_text(input_ids, mask)
        return self.search(project_id, query_vec, limit, active=active)

    def search(
        self,
        project_id: str,
        query_vec: np.ndarray,
        limit: int = DEFAULT_SEARCH_K,
        *,
        active: ActiveModel | None = None,
    ) -> list[dict[str, Any]]:
        """项目内语义检索：只读已 ready 且属于 **active model** 的索引行，绝不跨项目。

        ⚠️ 这里的 model_id / model_revision 过滤是**静默错误的唯一防线**：英文与
        中文 CLIP 的 embedding 同为 512 维，缺了它不会报错、不会丢行，只会把两个
        向量空间的向量做 cosine —— 返回一堆看似正常、实际无意义的排序。

        active model 解析不出来时无从过滤（此时不存在「active」可言）；唯一调用方
        `search_text()` 已在编码前抛 SEMANTIC_MODEL_NOT_INSTALLED。

        `active` 由调用方传入（`search_text()` 已解析过）：模型解析要校验大文件
        的 sha256，一次检索不应解析两遍。
        """
        if active is None:
            active = self._active_model()
        sql = (
            "SELECT i.asset_id, i.embeddings_blob, i.embedding_dim, i.frames_json "
            "FROM asset_semantic_index i JOIN assets a ON a.id = i.asset_id "
            "WHERE a.project_id = ? AND i.algorithm_version = ? AND i.status = 'ready'"
        )
        params: list[Any] = [project_id, INDEX_ALGORITHM_VERSION]
        if active is not None:
            sql += " AND i.model_id = ? AND i.model_revision = ?"
            params.extend([active.model_id, active.revision])
        with self.db.connection() as db:
            rows = db.execute(sql, tuple(params)).fetchall()

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
        active = self._active_model()
        # 索引行的 model_id / model_revision 必须与**产生这些向量的模型**一致，
        # 否则检索侧按 active model 过滤时会把它们当作别人的行静默排除。
        if active is None:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="model_not_installed", frames=[], matrix=None,
                                 active=None)

        frames_bytes = await self._decode_frames(input_path, cancel_event)
        if frames_bytes is None:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="no_video_stream", frames=[], matrix=None,
                                 active=active)
        if stage:
            stage("semantic:encode")

        count = len(frames_bytes)
        picked = thin_frames(count)
        if picked:
            frames_bytes = [frames_bytes[i] for i in picked]

        encoder = ClipEncoder(active.vision_path, active.text_path)
        batch = np.stack([preprocess_image(f)[0] for f in frames_bytes]) if frames_bytes else np.zeros((0, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE), dtype=np.float32)
        matrix = encoder.encode_image(batch) if len(batch) else np.zeros((0, 0))
        if matrix.size == 0:
            return self._persist(asset_id, source_fingerprint, "unavailable",
                                 reason="no_frames", frames=[], matrix=None,
                                 active=active)
        return self._persist(asset_id, source_fingerprint, "ready", reason=None,
                             frames=list(range(len(frames_bytes))), matrix=matrix,
                             active=active)

    # ---------------------------------------------------------------- 内部

    def _active_model(self) -> ActiveModel | None:
        """按「中文优先」解析当前应使用的模型；都不可用返回 None。

        **模型选择的唯一来源**：模型 id、revision、context length、双塔路径
        全部从这里取，不允许调用方各自写死或按分词器类型另判一套。

        走 model_manager.ready_path 而不是自己拼路径：受信清单 / 目录约定 /
        就绪标记集中一处，与 faster-whisper / CAM++ 同一条路径。ready_path
        已返回该模型的安装目录（models/clip/<model_id>/），不可再拼一层——
        曾在此多拼一次导致「模型已装却报未安装」。
        """
        if self.model_manager is None:
            return None
        for model_id in _MODEL_PREFERENCE:
            try:
                root = Path(self.model_manager.ready_path(model_id))
            except Exception:
                continue
            vision = root / VISION_FILE
            text = root / TEXT_FILE
            if not (vision.is_file() and text.is_file()):
                continue
            return ActiveModel(
                model_id=model_id,
                revision=self._model_revision(model_id),
                context_len=_MODEL_CONTEXT_LENGTH[model_id],
                vision_path=vision,
                text_path=text,
            )
        return None

    def _model_revision(self, model_id: str) -> str:
        """该模型受信清单里的 revision（索引行的归属凭据之一）。

        读清单而不是写死：ready 判定本就按清单 revision 做，写死一份等于允许
        两者漂移。清单不可达时退回兜底常量（宁可记录得粗，也不要整个检索崩）。
        """
        registry = getattr(self.model_manager, "registry", None)
        try:
            return str(registry.get(model_id).revision)
        except Exception:
            return _MODEL_REVISION_FALLBACK.get(model_id, "")

    def _require_active_model(self) -> ActiveModel:
        active = self._active_model()
        if active is None:
            raise SemanticError("SEMANTIC_MODEL_NOT_INSTALLED", "语义模型尚未安装")
        return active

    def _model_paths(self) -> tuple[Path | None, Path | None]:
        """active model 的双塔路径；未就绪返回 (None, None)。"""
        active = self._active_model()
        if active is None:
            return None, None
        return active.vision_path, active.text_path

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
        active: ActiveModel | None,
    ) -> dict[str, Any]:
        """落一行索引。model_id / model_revision 取自 active model（唯一来源）。

        不可用时 active 为 None：行仍要落（availability 是显式降级信号），归属
        记 None —— 检索侧按 model_id 过滤，NULL 不会与任何 active model 相等。

        `active` 由 index_path 传入（它已解析过，不重复解析——解析要校验大文件 sha256）。
        """
        model_id = active.model_id if active is not None else None
        model_revision = active.revision if active is not None else None
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
                    model_id, model_revision, now, now, now,
                ),
            )
        return {"index_id": index_id, "status": status, "reason": reason, "frames": frames}
