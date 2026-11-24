from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
from collections import deque
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from . import PROTOCOL_VERSION, __version__
from . import performance as perf_diagnostics
from .asr_jobs import AsrCoordinator
from .auth import AuthStore
from .config import Settings
from .database import Database, MigrationError, json_dumps, json_loads, utc_now
from .ids import new_id
from .jobs import JobService
from .media.audio_chunks import PcmChunkError, PcmChunkService
from .media.beat_grid import BEAT_ALGORITHM_VERSION
from .media.speaker_service import SPEAKER_ALGORITHM_VERSION
from .media.cv_signals import CV_ALGORITHM_VERSION, CvAnalysisError
from .media.decode_capability import DecodeCapabilityProbe
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe
from .media.frame_decode import (
    FrameDecodeError,
    decode_frames,
    pack_nv12_response,
)
from .media.probe_cache import ProbeCache, probe_cache_key
from .media.process import run_process
from .media_generation import MediaGenerationService
from .model_registry import ModelError, ModelManager, ModelRegistry
from .planning import PlanningService, ProviderRepository, RecipeRegistry
from .projects import DomainError, ProjectAssetService
from .provider_image_generation import (
    ImageProviderConfigService,
    ProviderImageGenerationService,
)
from .provider_images import ApiKeyFunImagesProvider
from .providers import ProviderError, ProviderSecretVault
from .rendering.ass import CaptionResources
from .rendering.plan import RenderPlanCompiler
from .rendering.service import (
    DestinationGrantStore,
    DirectoryGrantStore,
    RenderCoordinator,
    RenderService,
)
from .renditions.batch import ExportBatchService
from .renditions.presets import RenditionPresetRegistry
from .renditions.reframe import RenditionReframeSnapshotService
from .renditions.reframe_batch import ReframeExportBatchService
from .renditions.snapshot import RenditionSnapshotService
from .shot_requirement_image_fulfillment import ShotRequirementImageFulfillmentService
from .shot_requirement_timeline_assembly import ShotRequirementTimelineAssemblyService
from .shot_requirement_timeline_batch_assembly import ShotRequirementTimelineBatchAssemblyService
from .shot_requirements import ShotRequirementService
from .timeline import TimelineService
from . import frame_tags as frame_tags_module
from .agent_session import AgentSessionService
from .timeline_planning import TimelinePatchPlanningService
from .transcription import TranscriptionError, TranscriptRepository


class SessionResponse(BaseModel):
    token: str
    expires_with_process: bool = True
    scopes: list[str]


class FileGrantRequest(BaseModel):
    path: str


class ProbeRequest(BaseModel):
    grant_id: str


class DerivedMediaRequest(BaseModel):
    """B10 派生媒体查询/解析请求（kind/params 枚举白名单在服务层再强制）。"""
    model_config = ConfigDict(extra="forbid")

    asset_id: str
    kind: str
    params: dict[str, str] = Field(default_factory=dict)


class PreviewSourceRequest(BaseModel):
    """B11 预览源请求（profile/mode 枚举在服务层再强制）。"""
    model_config = ConfigDict(extra="forbid")

    profile_id: str | None = None
    mode: str = "auto"
    encoder_mode: str = "auto"
    # 无 ready 条目时是否登记生成作业（默认 False：纯查询）
    generate: bool = False


class PreviewSourceMediaRequest(BaseModel):
    """B11 代理票据请求（Main → Core admin；Renderer 永不直调）。"""
    model_config = ConfigDict(extra="forbid")

    asset_id: str
    profile_id: str


class WaveformRequest(BaseModel):
    """B14 波形描述请求（generate=True 登记生成作业；参数服务端固定）。"""
    model_config = ConfigDict(extra="forbid")

    generate: bool = False


class FilmstripRequest(BaseModel):
    """WP-P232 缩略图请求（step_ms 由调用方按缩放档位传；generate=True 登记）。"""
    model_config = ConfigDict(extra="forbid")

    step_ms: int = Field(ge=1, le=3_600_000)
    generate: bool = False


class FilmstripMediaRequest(BaseModel):
    """WP-P232 Main 内部解析请求（step_ms 档位定位条目）。"""
    model_config = ConfigDict(extra="forbid")

    step_ms: int = Field(ge=1, le=3_600_000)


class BeatAnalysisRequest(BaseModel):
    """Wave1 L2：BGM 节拍分析请求（generate=True 登记分析作业）。

    音频/视频素材均可（视频取其音轨）；无音轨的分析结果为
    status=unavailable（非失败——调用方按摘要提示该素材无法检出节拍）。
    """
    model_config = ConfigDict(extra="forbid")

    generate: bool = False


class SemanticSearchRequest(BaseModel):
    """W3.1 语义检索请求：自然语言 → CLIP 文本塔 → 项目内余弦检索。

    **命中率不承诺**：门 §3 A8 显式留空（见 P142——现有评测语料为合成
    纯色块，无法验证画面语义）。本端点保证的是**链路可用**。
    """
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=512)
    limit: int = 20


class KeyframePreviewRequest(BaseModel):
    """W3.3 帧级外传预览请求（prepare，**无网络**）。"""
    model_config = ConfigDict(extra="forbid")

    provider_config_id: str
    interval_us: int | None = None


class KeyframeExcludeRequest(BaseModel):
    """逐张移除：只增不改（D4 审计）。"""
    model_config = ConfigDict(extra="forbid")

    frame_indices: list[int]


class KeyframeCreateRequest(BaseModel):
    """建 consent + generation。哈希必须与预览当前状态一致。"""
    model_config = ConfigDict(extra="forbid")

    payload_sha256: str

class SemanticIndexRequest(BaseModel):
    """W3.1 索引请求（generate=True 登记索引作业）。"""
    model_config = ConfigDict(extra="forbid")

    generate: bool = False


class SpeakerDiarizationRequest(BaseModel):
    """W2.2：说话人分离（generate=True 登记分析作业）。

    音频/视频素材均可（视频取其音轨）；无语音 / 模型未就绪 ⇒ unavailable
    （非失败——调用方按摘要提示，**不静默降级**到能量 VAD 之类未取证路径）。
    """
    model_config = ConfigDict(extra="forbid")

    generate: bool = False


class SpeakerReclusterRequest(BaseModel):
    """W2.2：换 τ / 换策略重聚类（复用已存 embedding，**不重跑推理**）。"""
    model_config = ConfigDict(extra="forbid")

    strategy: str = "silhouette_capk"
    k_max: int | None = None


class AngleGroupCreateRequest(BaseModel):
    """W2.1：建机位组（参考机位 + 有序成员；成员必须都是本项目视频素材）。"""
    model_config = ConfigDict(extra="forbid")

    name: str
    reference_asset_id: str
    member_asset_ids: list[str] = Field(default_factory=list)


class AngleSyncRequest(BaseModel):
    """W2.1：机位同步（generate=True 登记作业；全可用且指纹相符时幂等短路）。"""
    model_config = ConfigDict(extra="forbid")

    generate: bool = False


class AngleOffsetRequest(BaseModel):
    """W2.1：人工偏移（source=manual 的独立行，不覆盖自动测量）。"""
    model_config = ConfigDict(extra="forbid")

    offset_us: int


class DecodeFramesRequest(BaseModel):
    """H3 后端 B 窗口帧解码（合成帧号 → NV12 平面；路径永不进响应）。

    P30（§2.5 契约）：携带 restricted-media 票据 ticket_ref
    （aivideo://media/<ticket>），与媒体字节同一鉴权面——票据由 Electron
    Main 的 RestrictedMediaRegistry 权威校验（同 TTL/同 purpose/同实体），
    Core 侧做格式校验 + 窗口上限；路径解析保持 Core 内部（既有纪律：
    路径永不进响应、永不进渲染进程）。
    """
    model_config = ConfigDict(extra="forbid")

    frame_numbers: list[int] = Field(min_length=1, max_length=32)
    fps: float = Field(gt=0)
    pixel_format: Literal["nv12"] = "nv12"
    ticket_ref: str = Field(
        min_length=1,
        max_length=512,
        pattern=r"^aivideo://media/[A-Za-z0-9_-]{32,128}$",
    )


class CvAnalysisRequest(BaseModel):
    """AI-2 CV 信号分析请求（generate=True 登记分析作业）。

    ADR-0005 阶段 2 密度旋钮（可选；不传 = 默认，行为与阶段 1 决策面一致）：
    - `target_gap_us`：当前采样是否已够密的判据（默认 4s 盲区阈值）；
    - `budget_per_minute_s`：每分钟墙钟预算（默认 10，仍过 floor/cap）。
    """
    model_config = ConfigDict(extra="forbid")

    generate: bool = False
    target_gap_us: int | None = Field(default=None, ge=100_000, le=60_000_000)
    budget_per_minute_s: float | None = Field(default=None, ge=1.0, le=120.0)


class PcmChunkRequest(BaseModel):
    """B15 PCM 块确保请求（网格对齐在服务层强制）。"""
    model_config = ConfigDict(extra="forbid")

    start_sample: int


class PcmChunkMediaRequest(BaseModel):
    """B15 PCM 块票据请求（Main → Core admin；Renderer 永不直调）。"""
    model_config = ConfigDict(extra="forbid")

    start_sample: int


class EditorLoadLeaseRequest(BaseModel):
    """B16b 编辑器负载心跳（Main → Core admin；Renderer 永不直调）。"""
    model_config = ConfigDict(extra="forbid")

    window_id: str
    mode: str


class ProjectCreateRequest(BaseModel):
    name: str
    root_dir_name: str | None = None
    canvas: dict | None = None


class ProjectPatchRequest(BaseModel):
    name: str | None = None


class AssetImportRequest(BaseModel):
    grant_id: str
    kind: str | None = None


class AssetRelocateRequest(BaseModel):
    grant_id: str


class ModelDownloadRequest(BaseModel):
    license_acceptance: str | None = None


class TranscriptionRequest(BaseModel):
    model_id: str
    language: str = "auto"
    word_timestamps: bool = False
    license_acceptance: str | None = None


class JobRequest(BaseModel):
    media_id: str
    project_id: str | None = None
    encoder_mode: str = "auto"
    start_us: int = Field(default=0, ge=0)
    duration_us: int | None = Field(default=None, gt=0, le=30_000_000)


class VerticalRequest(JobRequest):
    duration_us: int = Field(default=10_000_000, gt=0, le=30_000_000)
    layout: str = "blurred_background"


class TimelineCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: int
    source: dict[str, Any]
    default_layout: str
    caption_preset_id: str


class TimelinePatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: int
    base_revision_id: str
    operations: list[dict[str, Any]]
    summary: str


TIMELINE_PATCH_BODY_LIMIT = 4 * 1024 * 1024


class TimelinePatchBodyLimitMiddleware:
    """Reject oversized raw TimelinePatch bodies before FastAPI JSON parsing."""

    def __init__(self, app: Any, limit_bytes: int = TIMELINE_PATCH_BODY_LIMIT) -> None:
        self.app = app
        self.limit_bytes = limit_bytes

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or len(scope.get("path", "").split("/")) != 7
            or not scope.get("path", "").startswith("/api/v1/projects/")
            or not scope.get("path", "").endswith("/timeline/patches")
        ):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.limit_bytes:
                    await self._too_large(send)
                    return
            except ValueError:
                pass

        messages: deque[dict[str, Any]] = deque()
        received_bytes = 0
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                messages.append(message)
                break
            if message.get("type") == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.limit_bytes:
                    await self._too_large(send)
                    return
                messages.append(message)
                if not message.get("more_body", False):
                    break
            else:
                messages.append(message)
                break

        async def replay_receive() -> dict[str, Any]:
            if messages:
                return messages.popleft()
            return await receive()

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _too_large(send: Any) -> None:
        body = json.dumps(
            {"detail": {"code": "TIMELINE_PATCH_TOO_LARGE", "message": "TimelinePatch body exceeds 4 MiB"}},
            separators=(",", ":"),
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode("ascii"))],
        })
        await send({"type": "http.response.body", "body": body})


class TimelineNavigationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    base_revision_id: str


class TimelineDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: int
    base_revision_id: str
    document: dict[str, Any]


class PreviewCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    timeline_revision_id: str | None = None
    encoder_mode: str = "auto"
    output_ratio: str = "fit"


class ExportCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    timeline_revision_id: str | None = None
    destination_grant_id: str
    encoder_mode: str = "auto"
    output_ratio: str = "fit"
    quality: str = "standard"
    resolution: str = "1080p"
    frame_rate: int = 30


class BriefPutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: int
    topic: str
    audience: str
    target_platform: str
    target_duration_us: int
    narrative_goal: str
    style_notes: str
    must_keep: list[str]
    forbidden: list[str]
    original_audio_policy: str
    caption_policy: str
    caption_preset_id: str
    default_layout: str


class ProviderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: str
    display_name: str
    base_url: str
    model: str
    enabled: bool = True
    input_price_per_million: float | None = None
    output_price_per_million: float | None = None


class ProviderPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    display_name: str | None = None
    base_url: str | None = None
    model: str | None = None
    enabled: bool | None = None
    input_price_per_million: float | None = None
    output_price_per_million: float | None = None


class ProviderSecretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    secret: str


class EgressPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider_config_id: str
    recipe_id: str
    transcript_ids: list[str]
    # AI-2 阶段三：召回来源（可选增量——缺省 auto 保持旧行为）。
    candidate_source: str | None = None


class CandidateGenerationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    egress_preview_id: str
    payload_sha256: str


class CandidateAdoptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: int
    candidate_document_sha256: str
    base_revision_id: str | None = None


class TimelinePatchPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    provider_config_id: str
    instruction: str


class TimelinePatchGenerationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    timeline_patch_egress_preview_id: str
    payload_sha256: str


class TimelinePatchProposalApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    proposed_document_sha256: str


class EditingGrammarPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    planner: str
    params: dict[str, Any]


class EditingGrammarProposalCreateRequest(EditingGrammarPrepareRequest):
    pass


class EditingGrammarProposalApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    proposed_document_sha256: str


class AgentSessionPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    provider_config_id: str
    instruction: str


class CaptionsProviderPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    provider_config_id: str
    transcript_id: str
    segment_ids: list[str]
    language: str | None = None
    preset_id: str
    max_chars_per_caption: int


class CaptionsProviderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    captions_provider_egress_preview_id: str
    payload_sha256: str


class CaptionsProviderProposalApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    proposed_document_sha256: str


class WorklistPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    steps: list[dict[str, Any]]
    max_steps: int
    token_budget: int


class WorklistCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    worklist_id: str
    base_revision_id: str


class WorklistApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    proposed_document_sha256: str


class AgentSessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    agent_session_egress_preview_id: str
    payload_sha256: str


class TimelineRevisionDiffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    target_revision_id: str


class DestinationGrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    path: str
    overwrite_authorized: bool


class DestinationGrantRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    file_name: str


class DirectoryGrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    path: str


class RenditionPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    timeline_revision_id: str
    platform_preset_id: str
    rendition_preset_id: str
    layout_policy: str
    encoder_mode: str = "auto"


class ExportBatchCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    timeline_revision_id: str
    directory_grant_id: str
    items: list[dict[str, Any]]


class ExportBatchRetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    directory_grant_id: str
    export_batch_item_ids: list[str]


class ReframeAdjustmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    clip_id: str
    horizontal_anchor: Literal["left", "center", "right"]
    vertical_anchor: Literal["top", "center", "bottom"]


class ReframePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    base_rendition_snapshot_id: str
    adjustments: list[ReframeAdjustmentRequest] = Field(min_length=1, max_length=500)
    encoder_mode: Literal["auto", "software"] = "auto"


class ReframeExportBatchItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    rendition_reframe_snapshot_id: str
    preview_artifact_id: str
    encoder_mode: Literal["auto", "software"] = "auto"


class ReframeExportBatchCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    directory_grant_id: str
    items: list[ReframeExportBatchItemRequest] = Field(min_length=1, max_length=8)


class ReframeExportBatchRetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    directory_grant_id: str
    reframe_export_batch_item_ids: list[str] = Field(min_length=1, max_length=8)


class MediaGenerationPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    generation_kind: str
    prompt: str
    input_refs: list[str]
    parameters: dict[str, Any]


class MediaGenerationCreateRequest(MediaGenerationPrepareRequest):
    request_sha256: str


class MediaGenerationEmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ImageProviderConfigCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    display_name: str
    enabled: bool = True


class ImageProviderSecretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    secret: str


class ProviderImageGenerationPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    provider_config_id: str
    prompt: str
    size: Literal["1024x1024", "1024x1536", "1536x1024"]


class ProviderImageGenerationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    preview_id: str
    payload_sha256: str
    confirmed: bool


class ProviderImageGenerationRetryPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    prompt: str


class ProviderImageGenerationRetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    preview_id: str
    payload_sha256: str
    confirmed: bool


class ProviderImageGenerationEmptyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ShotVisualRequirementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    requirement_kind: str
    source_asset_id: str | None


class ShotNarrationRequirementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    requirement_kind: str
    text: str


class ShotRequirementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str
    visual_direction: str
    target_duration_us: int | None
    visual: ShotVisualRequirementRequest
    narration: ShotNarrationRequirementRequest | None


class ShotListRevisionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: int
    base_revision_id: str | None
    title: str
    summary: str
    requirements: list[ShotRequirementRequest] = Field(min_length=1, max_length=24)


class ShotListConfirmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    revision_id: str
    expected_current_revision_id: str


class ShotRequirementImageFulfillmentPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_confirmed_revision_id: str
    provider_config_id: str
    prompt: str


class ShotRequirementImageFulfillmentCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    preview_id: str
    fulfillment_payload_sha256: str
    expected_confirmed_revision_id: str
    confirmed: bool


class ShotRequirementTimelineAssemblyPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_adoption_id: str
    base_timeline_revision_id: str
    at_index: int
    duration_us: int | None
    layout: str


class ShotRequirementTimelineAssemblyApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    assembly_preview_id: str
    proposed_document_sha256: str
    confirmed: bool


class ShotRequirementTimelineBatchAssemblyItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requirement_id: str
    expected_adoption_id: str
    duration_us: int
    layout: str


class ShotRequirementTimelineBatchAssemblyPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_timeline_revision_id: str
    at_index: int
    items: list[ShotRequirementTimelineBatchAssemblyItemRequest]


class ShotRequirementTimelineBatchAssemblyApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    batch_preview_id: str
    proposed_document_sha256: str
    confirmed: bool


class ShotRequirementImageAdoptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    generation_link_id: str
    task_id: str
    asset_id: str
    expected_current_adoption_id: str | None
    confirmed: bool


class CoreState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.db = Database(settings.database_path)
        self.auth = AuthStore(os.environ.get("AIVS_ADMIN_TOKEN", ""))
        self.grants: dict[str, dict[str, Any]] = {}
        self.connections: set[WebSocket] = set()
        self.shutdown_event = asyncio.Event()
        self.ffprobe = FFprobe(settings.ffprobe)
        # A07：probe 结果会话缓存（键 = fingerprint + stat + ffprobe build；
        # 成功 LRU≤256、失败 TTL 5s、并发同键 single-flight）。装饰层包住
        # FFprobe——app 内统一经 cached_probe 走缓存，FFprobe 本体语义不变。
        self.probe_cache = ProbeCache()
        # P30：`ffmpeg -decoders` 能力数据源（§2.5）——FFmpeg build 指纹键
        # 失效重探；进程内缓存（Core 重启即重探）。
        self.decode_capability_probe = DecodeCapabilityProbe(settings.ffmpeg)
        self.encoders = EncoderDetector(settings.ffmpeg)
        self.model_registry = ModelRegistry(settings.manifest_dir)
        self.model_manager = ModelManager(self.db, settings.data_dir, self.model_registry)
        self.transcripts = TranscriptRepository(self.db)
        # 字幕字体族白名单（多字体）：注入运行时字体注册表，font_name 校验
        # 用（非法名保持拒绝——防未注册字体静默回退 sans-serif）。
        self.timelines = TimelineService(self.db, font_families=CaptionResources(settings.font_dir).families())
        self.provider_secrets = ProviderSecretVault()
        self.providers = ProviderRepository(self.db, self.provider_secrets)
        self.recipes = RecipeRegistry(settings.recipe_dir)
        # PROXY_SUPPORT（2026-09-20 裁决）：三级回退解析代理 → provider factory
        # 注入（trust_env=False 保持，代理只来自显式配置链）。None = 直连。
        from .config import proxy_display_value, resolve_provider_proxy

        self.provider_proxy = resolve_provider_proxy(settings)
        from .providers import OpenAICompatibleTextProvider
        import httpx as _httpx

        # 脱敏回显值只喂错误文案（scheme://host:port）；出网代理本体走下面的 factory。
        _proxy_display = proxy_display_value(self.provider_proxy)

        if self.provider_proxy:
            _proxy = self.provider_proxy

            class _ProxiedTextProvider(OpenAICompatibleTextProvider):
                def __init__(self) -> None:
                    def factory(**kwargs: Any) -> Any:
                        kwargs.pop("trust_env", None)
                        return _httpx.AsyncClient(proxy=_proxy, trust_env=False, **kwargs)

                    super().__init__(client_factory=factory, proxy_display=_proxy_display)

            self._text_provider_factory: Any = _ProxiedTextProvider
        else:
            self._text_provider_factory = OpenAICompatibleTextProvider
        # 图片 Provider 与文本 Provider 共用同一条代理决策（PROXY_SUPPORT 规划门
        # §1 第 3 条「注入点统一」）——此前只接了文本侧，系统代理开着的用户
        # 文本可用、图片必失败。trust_env=False 保持一致：代理只来自显式配置链。
        from .provider_images import image_client_factory_for_proxy

        self._image_client_factory: Any = (
            image_client_factory_for_proxy(self.provider_proxy) if self.provider_proxy else None
        )
        self._image_proxy_display = _proxy_display
        # AI-2 阶段三：CV 信号服务先行构建（planning 注入召回汇合点）。
        from .media.cv_signals import CvSignalService

        self.cv_signals = CvSignalService(
            self.db, settings.ffmpeg, self.ffprobe, model_manager=self.model_manager
        )
        self.planning = PlanningService(
            self.db,
            self.recipes,
            self.providers,
            self.provider_secrets,
            self.timelines,
            provider_factory=self._text_provider_factory,
            cv_signals=self.cv_signals,
        )
        from .captions_provider_egress import CaptionsProviderEgressService
        self.captions_provider_egress = CaptionsProviderEgressService(
            self.db, self.providers, self.provider_secrets, self.timelines, self.transcripts, provider_factory=self._text_provider_factory
        )
        self.timeline_patch_planning = TimelinePatchPlanningService(
            self.db, self.providers, self.provider_secrets, self.timelines,
            provider_factory=self._text_provider_factory,
        )
        # W1.1：剪辑语法层（P-A，零 egress，无 provider/consent）。
        from .editing_grammar import EditingGrammarService
        from .media.loudness import LoudnessProbe

        # E8：响度测量探针（随包 ffmpeg 的 EBU R128；每次现测、不落库）。
        # resolve_asset_path 经闭包延后取——_wire_projects() 在本行之后才跑。
        self.loudness_probe = LoudnessProbe(
            settings.ffmpeg, lambda asset_id: self.projects.resolve_asset_path(asset_id)
        )
        self.editing_grammar = EditingGrammarService(
            self.db, self.timelines, loudness=self.loudness_probe
        )
        from .worklist import WorklistService
        self.worklists = WorklistService(self.db, self.timelines, self.editing_grammar, self.captions_provider_egress)
        # AI-1：多步 agent 会话（emit 传入以发 agent_session.updated 事件）。
        self.agent_sessions = AgentSessionService(
            self.db, self.providers, self.provider_secrets, self.timelines,
            provider_factory=self._text_provider_factory,
            emit=self.emit,
        )
        self.media_generation = MediaGenerationService(self.db)
        self.shot_requirements = ShotRequirementService(self.db)
        self.destinations = DestinationGrantStore()
        self.directory_grants = DirectoryGrantStore()
        self.rendition_presets = RenditionPresetRegistry(settings.font_dir.parent)
        self.rendition_snapshots = RenditionSnapshotService(self.db, self.rendition_presets)
        self.rendition_reframe_snapshots = RenditionReframeSnapshotService(
            self.db, self.rendition_presets
        )
        self.asr = AsrCoordinator(
            self.db, self.model_registry, self.model_manager, self.transcripts
        )
        self._wire_projects()
        self._build_render_stack(settings)
        # B10：派生媒体缓存（video_proxy/waveform/pcm/reverse）——内容寻址
        # 键 + project/asset 引用授权；生成作业由 B11+ 接入，本层先提供
        # 查询/解析/统计。cache 根 = data_dir/cache（计划目录约定的根）。
        from .media.derived_cache import DerivedMediaCache
        from .media.derived_service import DerivedMediaService

        self.derived_cache = DerivedMediaCache(self.db, settings.data_dir / "cache")
        self.derived_media = DerivedMediaService(
            self.db, self.derived_cache, toolchain_fingerprint=f"aivs-core-derived-v{__version__}"
        )
        # B11：preview-source（全源代理 + 预览源选择）。FFmpeg build 同步探测
        # 一次（失败退化为占位——缓存键随 build 换代，不可用时明确进入
        # no-ffmpeg-build 分支，不静默跨工具链复用）。
        from .media.preview_source import PreviewSourceService

        self.preview_source = PreviewSourceService(
            self.db,
            self.derived_cache,
            settings.ffmpeg,
            self.ffprobe,
            self.encoders,
            ffmpeg_build=_sync_tool_build(settings.ffmpeg),
        )
        # jobs 在 preview_source 之前构建（render 栈顺序）；此处回填 B11 runner。
        self.jobs.preview_source_runner = self.preview_source.run_proxy_job
        # B14：素材级持久化波形（流式 PCM → min/max 金字塔，kind=waveform
        # 复用 B10 派生缓存；FFmpeg build 同键策略——换工具链即键换代）。
        from .media.waveform import WaveformService

        self.waveform = WaveformService(
            self.db,
            self.derived_cache,
            settings.ffmpeg,
            self.ffprobe,
            ffmpeg_build=_sync_tool_build(settings.ffmpeg),
        )
        self.jobs.waveform_runner = self.waveform.run_waveform_job
        # WP-P232：素材级缩略图预抽（filmstrip sprite；ffmpeg tile 单 pass →
        # B10 派生缓存 kind="filmstrip"；导入/转录完成即登记，低优先级批量）。
        from .media.filmstrip import FilmstripService

        self.filmstrips = FilmstripService(
            self.db,
            self.derived_cache,
            settings.ffmpeg,
            self.ffprobe,
            ffmpeg_build=_sync_tool_build(settings.ffmpeg),
        )
        self.jobs.filmstrip_runner = self.filmstrips.run_filmstrip_job
        # Wave1 L2：BGM 节拍网格（PCM → numpy 检测 → beat_grids；卡点面板
        # 触发即用户视野，与 waveform 同档轻作业）。此前 BeatGridService 无
        # 任何调用方——beat_grids 在生产环境永远为空，beat_sync 必失败。
        from .media.beat_service import BeatGridService

        self.beats = BeatGridService(self.db, settings.ffmpeg)
        self.jobs.beat_runner = self.beats.run_beat_job
        # W2.1 机位同步：音频互相关 → 机位时间偏移表（本地、零 egress；只产元数据，
        # 不写任何时间线 op）。轻作业档，与 beat_analysis 同型。
        from .media.angle_sync import AngleSyncService

        self.angle_sync = AngleSyncService(
            self.db, settings.ffmpeg, self.projects.resolve_asset_path)
        self.jobs.angle_sync_runner = self.angle_sync.run_sync_job
        # W2.2 说话人分离：解码 → 随包 Silero VAD → 窗 embedding（CAM++，受信下载）
        # → 余弦 UPGMA 聚类 → speaker_diarizations（含 embedding BLOB，换 τ 不重跑推理）。
        # 全本地、零 egress（ADR-0003 D4）；模型未就绪 ⇒ unavailable，不静默降级。
        from .media.speaker_service import SpeakerDiarizationService

        self.speaker = SpeakerDiarizationService(
            self.db, settings.ffmpeg, self.projects.resolve_asset_path,
            model_manager=self.model_manager, ffprobe=self.ffprobe,
        )
        self.jobs.speaker_runner = self.speaker.run_job
        # AI-2 Layer 0：cv_signals 已在 planning 之前构建（召回汇合 +
        # model_manager 注入 → YuNet 人脸通道，模型未就绪 partial）；
        # 此处只回填 job runner。
        self.jobs.cv_signal_runner = self.cv_signals.run_analysis_job
        # W3.1 素材池语义检索：抽帧 → CLIP 双塔 ONNX → asset_semantic_index。
        # 全本地零 egress（ADR-0003 D4）；模型未安装 ⇒ unavailable，不静默降级。
        from .media.semantic_service import SemanticIndexService

        self.semantic = SemanticIndexService(
            self.db, settings.ffmpeg, model_manager=self.model_manager
        )
        self.jobs.semantic_runner = self.semantic.run_index_job
        # W3.3 Layer 2 关键帧理解：帧级外传预览（S2b）。
        # 本层**零网络**——prepare/exclude 只产本地预览与载荷文件；
        # 真正外传须经 create → claim（I-1：claim 是唯一放行点）。
        from .frame_tags import FrameTagService
        from .keyframe_egress import KeyframeEgressService
        from .keyframe_orchestration import KeyframeOrchestrator

        self.keyframe_egress = KeyframeEgressService(self.db)
        # S5a：逐帧标签**只读**端点（写侧属 S4，需真实网关）。
        self.frame_tags = FrameTagService(self.db)
        # S4 写侧：打标执行体。此前该类从未被实例化——create 产出的
        # generation 因没有任何执行者而永远停在 queued（runner 槽位空着，
        # 就算有作业也只会抛 RENDER_FAILED）。
        from .keyframe_tagging import KeyframeTaggingService

        self.keyframe_tagging = KeyframeTaggingService(
            self.db, self.keyframe_egress, self.providers, self.provider_secrets,
        )
        self.jobs.keyframe_runner = self.keyframe_tagging.run_tagging_job
        # S3：vision 能力探测。探测**本身也是网络调用**，因此走同一条
        # prepare→create→claim 三段式（Design Gate §3.2 I-1 / §5.1）。
        #
        # client_factory **必须在这里给**：探测服务自身不像 KeyframeTaggingService
        # 那样有 `or (lambda **kw: httpx.Client(**kw))` 默认值，缺了它 _call_provider
        # 会恒抛 VISION_PROBE_UNSUPPORTED ⇒ Provider 永远 untested ⇒ create 的
        # fail-closed 永远拒绝 ⇒ 打标链路在生产里一次都跑不通。这正是「一处在 app
        # 装配、一处在服务默认值」的不一致，故两处口径必须相同（同一句式）。
        from .vision_probe import VisionProbeService

        self.vision_probe = VisionProbeService(
            self.db, self.keyframe_egress, self.providers, self.provider_secrets,
            client_factory=lambda **kw: httpx.Client(**kw),
        )
        self.keyframe = KeyframeOrchestrator(
            self.db, self.keyframe_egress, settings.ffmpeg
        )
        # 启动期清一次过期载荷（R10/R16：独立目录只有本清理者，不会被 LRU 代删）。
        try:
            self.keyframe_egress.purge_expired()
        except Exception:  # noqa: BLE001 启动期清理失败不得阻断服务启动
            pass
        # B15：分块 PCM（48000Hz 双声道 f32le、2 秒/块；同步内联生成——
        # 低延迟任务不排 jobs 队列，begin_build single-flight 防并发重复）。
        self.pcm_chunks = PcmChunkService(
            self.db,
            self.derived_cache,
            settings.ffmpeg,
            self.ffprobe,
            ffmpeg_build=_sync_tool_build(settings.ffmpeg),
        )

    async def cached_probe(
        self,
        path: Path,
        fingerprint: str | None = None,
        require_video: bool = True,
    ) -> dict[str, Any]:
        """A07：经会话缓存的 ffprobe 探测。

        - 提供 fingerprint 时与 stat(size, mtime_ns) 共同构成缓存键（文件
          变化即键变化，自动失效）；未提供时退化为 stat+build 键。
        - 缓存键含 ffprobe build（版本变化自动全失效）。
        - 未命中（或失败 TTL 过期）走真实 FFprobe.probe；语义（错误码、
          require_video 检查、normalize）与直调完全一致。
        """

        async def run_probe() -> dict[str, Any]:
            return await self.ffprobe.probe(path, require_video=require_video)

        key = probe_cache_key(path, fingerprint, await self.ffprobe_build())
        if key is None:
            return await run_probe()
        return await self.probe_cache.get_or_probe(key, run_probe)

    async def ffprobe_build(self) -> str:
        """ffprobe build 标识（缓存键成分；读取一次后复用）。

        可执行文件缺失（测试/未安装环境）返回空串退化为 stat-only 键，
        不让 import 路径在 ffprobe 不可用时空抛——探测本身的失败仍由
        FFprobe.probe 按既有错误码报告。
        """
        if self._ffprobe_build is None:
            try:
                result = await run_process(
                    self.ffprobe.executable, ["-hide_banner", "-version"], 10
                )
            except (OSError, FileNotFoundError):
                self._ffprobe_build = ""
                return ""
            self._ffprobe_build = (
                result.stdout.splitlines()[0] if result.stdout and result.returncode == 0 else ""
            )
        return self._ffprobe_build

    _ffprobe_build: str | None = None

    def _wire_projects(self) -> None:
        async def probe_asset(path: Path, **kwargs: Any) -> dict[str, Any]:
            return await self.cached_probe(path, require_video=kwargs.get("require_video", True))

        self.projects = ProjectAssetService(
            self.db,
            self.settings.data_dir,
            probe_asset,
            transcript_stale=self.transcripts.mark_asset_stale,
            purge_asset_clips=self.timelines.purge_asset_clips,
            transcript_revalidate=self.transcripts.revalidate_for_fingerprint,
            # 关键帧外传预览对 assets 是 NO ACTION：不先 detach，删素材会被
            # FK 拒绝并报成「素材被镜头需求或生成记录引用」（P102 原样重演）。
            # 传闭包转发调用方的连接：detach 必须与 DELETE 同事务。
            detach_keyframe_previews=(
                lambda db, asset_id: self.keyframe_egress.detach_asset(asset_id, db)
            ),
        )

    def _build_render_stack(self, settings: Settings) -> None:
        """A07 抽取仅为 __init__ 可读性；语义与原内联构建完全一致。"""
        # B16：资源配额调度器（jobs._loop 消费；编辑器 lease 经内部端点心跳）
        from .job_scheduler import JobScheduler

        self.job_scheduler = JobScheduler()
        self.image_provider_secrets = ProviderSecretVault()
        self.image_provider_configs = ImageProviderConfigService(
            self.db, self.image_provider_secrets
        )
        image_provider = (
            ApiKeyFunImagesProvider(
                client_factory=self._image_client_factory,
                proxy_display=self._image_proxy_display,
            )
            if settings.image_provider_network_enabled
            else None
        )
        self.provider_image_generation = ProviderImageGenerationService(
            self.db,
            self.image_provider_configs,
            self.image_provider_secrets,
            self.projects,
            provider=image_provider,
        )
        self.shot_requirement_image_fulfillment = ShotRequirementImageFulfillmentService(
            self.db, self.provider_image_generation
        )
        self.shot_requirement_timeline_assembly = ShotRequirementTimelineAssemblyService(
            self.db, self.timelines
        )
        self.shot_requirement_timeline_batch_assembly = ShotRequirementTimelineBatchAssemblyService(
            self.db, self.timelines
        )
        self.render_compiler = RenderPlanCompiler(self.db)
        self.render_coordinator = RenderCoordinator(
            self.db,
            settings.data_dir,
            settings.ffmpeg,
            self.ffprobe,
            self.projects,
            self.render_compiler,
            CaptionResources(settings.font_dir),
            self.destinations,
            self.directory_grants,
            self.rendition_presets,
            probe=self.cached_probe,
            encoders=self.encoders,
        )
        self.jobs = JobService(
            self.db,
            settings.data_dir,
            settings.ffmpeg,
            self.ffprobe,
            self.encoders,
            self.emit,
            asr_runner=self.asr.run,
            retry_validator=self.asr.validate_retry,
            preview_source_runner=None,  # derived_cache 段构建后回填（B11）
            render_runner=self.render_coordinator.run,
            planning_runner=self.planning.run_generation,
            timeline_patch_runner=self.timeline_patch_planning.run_generation,
            captions_provider_runner=self.captions_provider_egress.run_generation,
            agent_session_runner=self.agent_sessions.run_session,
            media_generation_runner=self.media_generation.run_simulation,
            media_generation_start=self.media_generation.start_job,
            media_generation_finish=self.media_generation.finish_job,
            media_generation_recover=self.media_generation.recover_interrupted_tasks,
            provider_image_generation_runner=self.provider_image_generation.run,
            provider_image_generation_start=self.provider_image_generation.start_job,
            provider_image_generation_finish=self.provider_image_generation.finish_job,
            provider_image_generation_recover=(
                self.provider_image_generation.recover_interrupted_tasks
            ),
            # B16：资源配额调度（重任务单槽 + network/light 有界并行 +
            # 编辑器 lease 暂缓低优先级重任务）
            scheduler=self.job_scheduler,
        )
        self.renders = RenderService(
            self.db,
            settings.ffmpeg,
            self.encoders,
            self.render_compiler,
            self.jobs,
            self.destinations,
        )
        self.export_batches = ExportBatchService(
            self.db,
            self.rendition_snapshots,
            self.directory_grants,
            self.jobs,
            self.render_compiler,
            self.renders,
        )
        self.reframe_export_batches = ReframeExportBatchService(
            self.db,
            self.rendition_reframe_snapshots,
            self.directory_grants,
            self.jobs,
            self.render_compiler,
            self.renders,
        )

    async def emit(self, event: dict[str, Any]) -> None:
        message = {"event_id": new_id(), "occurred_at": utc_now(), **event}
        dead: list[WebSocket] = []
        for socket in self.connections:
            try:
                await socket.send_json(message)
            except Exception:
                dead.append(socket)
        for socket in dead:
            self.connections.discard(socket)

    @staticmethod
    def bearer(authorization: str | None) -> str | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        return authorization[7:]


def _error(code: str, message: str, status: int) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _preview_source_asset_row(state: Any, project_id: str, asset_id: str) -> dict[str, Any]:
    """B11 端点共用：素材行 + 归属校验（跨项目/缺素材走既有域错误）。"""
    row = state.derived_media._asset_row(asset_id)  # noqa: SLF001 同表同语义
    if row is None or row["project_id"] != project_id:
        raise _domain(DomainError("ASSET_NOT_FOUND", "素材不存在"))
    project = state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
    if project["status"] == "archived":
        raise _error("PROJECT_ARCHIVED", "项目已归档", 409)
    return row


def _sync_tool_build(executable: Path) -> str:
    """同步读取工具 build 标识（-version 首行；不可用返回空串占位）。

    构造期一次性（B11 代理缓存键成分）；ffprobe_build 是 async 版本，
    这里避免在 CoreState.__init__ 里跑事件循环。
    """
    import subprocess

    try:
        result = subprocess.run(
            [str(executable), "-hide_banner", "-version"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, ValueError):
        return ""
    if result.returncode != 0 or not result.stdout:
        return ""
    return result.stdout.splitlines()[0]


def _model_error(exc: ModelError, model: dict[str, Any] | None = None) -> HTTPException:
    status = (
        404
        if exc.code == "MODEL_NOT_FOUND"
        else 409
        if exc.code
        in {
            "MODEL_NOT_INSTALLED",
            "MODEL_LICENSE_REQUIRED",
            "MODEL_DISK_SPACE_INSUFFICIENT",
        }
        else 400
    )
    detail: dict[str, Any] = {"code": exc.code, "message": exc.message}
    if model is not None:
        detail["model"] = model
    return HTTPException(status, detail=detail)


def _transcription_error(exc: TranscriptionError) -> HTTPException:
    status = (
        404
        if exc.code in {"ASSET_NOT_FOUND", "TRANSCRIPTION_NOT_FOUND"}
        else 409
        if exc.code
        in {
            "TRANSCRIPTION_INPUT_CHANGED",
            "TRANSCRIPTION_NOT_READY",
            "TRANSCRIPTION_IN_USE",
            "MODEL_NOT_INSTALLED",
        }
        else 400
    )
    return _error(exc.code, exc.message, status)


def _domain(exc: DomainError) -> HTTPException:
    status = (
        409
        if exc.code
        in {
            "ASSET_DUPLICATE",
            "ASSET_CHANGED",
            "ASSET_MISSING",
            "ASSET_IN_USE",
            "PROVIDER_IN_USE",
            "PROJECT_ARCHIVED",
            "CONFLICT",
            "TIMELINE_ALREADY_EXISTS",
            "TIMELINE_CONFLICT",
            "PREVIEW_IR_UNSUPPORTED",
            "PREVIEW_IR_TOO_LARGE",
            "TIMELINE_DRAFT_CONFLICT",
            "TIMELINE_LOCKED",
            "TIMELINE_PATCH_EGRESS_EXPIRED",
            "TIMELINE_PATCH_EGRESS_MISMATCH",
            "TIMELINE_PATCH_PROVIDER_UNTESTED",
            "TIMELINE_PATCH_PROVIDER_UNSUPPORTED",
            "TIMELINE_PATCH_GENERATION_INVALID",
            "TIMELINE_PATCH_PROPOSAL_INVALID",
            "TIMELINE_PATCH_PROPOSAL_CONFLICT",
            "TIMELINE_PATCH_PROPOSAL_APPLIED",
            "RENDER_PLAN_INVALID",
            "RENDER_INPUT_CHANGED",
            "EXPORT_DESTINATION_INVALID",
            "EXPORT_DESTINATION_EXISTS",
            "EXPORT_DESTINATION_EXPIRED",
            "EXPORT_DISK_SPACE_INSUFFICIENT",
            "REFRAME_SNAPSHOT_INVALID",
            "REFRAME_NOT_APPLICABLE",
            "REFRAME_PREVIEW_REQUIRED",
            "REFRAME_PREVIEW_STALE",
            "REFRAME_RETRY_NOT_ALLOWED",
            "GENERATION_INPUT_CHANGED",
            "GENERATION_HASH_MISMATCH",
            "GENERATION_RETRY_NOT_ALLOWED",
            "GENERATION_PROMPT_HASH_MISMATCH",
            "IMAGE_GENERATION_CONFIRMATION_INVALID",
            "IMAGE_GENERATION_PREVIEW_EXPIRED",
            "JOB_INVALID_STATE",
            "SHOT_LIST_CONFLICT",
            "SHOT_LIST_CONFIRMATION_CONFLICT",
            "SHOT_REQUIREMENT_ASSET_PROJECT_MISMATCH",
            "STAGE5_REQUIREMENT_NOT_ELIGIBLE",
            "STAGE5_ADOPTION_CONFLICT",
            "STAGE5_ASSET_UNAVAILABLE",
            "STAGE5_TIMELINE_REQUIRED",
            "STAGE5_TIMELINE_CONFLICT",
            "STAGE5_TIMELINE_DRAFT_EXISTS",
            "STAGE5_DURATION_CONFIRMATION_REQUIRED",
            "STAGE5_LOCKED_SHIFT",
            "STAGE5_PREVIEW_EXPIRED",
            "STAGE5_PREVIEW_MISMATCH",
            "STAGE5_ALREADY_ASSEMBLED",
            "STAGE6_BATCH_REQUEST_INVALID",
            "STAGE6_BATCH_SIZE_INVALID",
            "STAGE6_BATCH_REQUIREMENT_DUPLICATED",
            "STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE",
            "STAGE6_BATCH_ADOPTION_CONFLICT",
            "STAGE6_BATCH_TIMELINE_REQUIRED",
            "STAGE6_BATCH_TIMELINE_CONFLICT",
            "STAGE6_BATCH_TIMELINE_DRAFT_EXISTS",
            "STAGE6_BATCH_ASSET_UNAVAILABLE",
            "STAGE6_BATCH_ALREADY_ASSEMBLED",
            "STAGE6_BATCH_PREVIEW_EXPIRED",
            "STAGE6_BATCH_PREVIEW_MISMATCH",
        }
        else 400
    )
    if exc.code in {
        "STAGE5_POSITION_INVALID",
        "STAGE5_DURATION_INVALID",
        "STAGE5_CONFIRMATION_REQUIRED",
        "STAGE6_BATCH_POSITION_INVALID",
        "STAGE6_BATCH_DURATION_INVALID",
        "STAGE6_BATCH_CONFIRMATION_REQUIRED",
        "EXPORT_STILL_PRESENT",
    }:
        status = 422
    if exc.code in {
        "PROJECT_NOT_FOUND",
        "ASSET_NOT_FOUND",
        "GRANT_NOT_FOUND",
        "PROVIDER_NOT_FOUND",
        "MEDIA_NOT_FOUND",
        "TIMELINE_NOT_FOUND",
        "TIMELINE_CLIP_NOT_FOUND",
        "TIMELINE_CAPTION_NOT_FOUND",
        "PREVIEW_NOT_FOUND",
        "EXPORT_NOT_FOUND",
        "ARTIFACT_NOT_FOUND",
        "CANDIDATE_PLAN_NOT_FOUND",
        "CANDIDATE_CLIP_NOT_FOUND",
        "CANDIDATE_GENERATION_NOT_FOUND",
        "TIMELINE_PATCH_GENERATION_NOT_FOUND",
        "TIMELINE_PATCH_PROPOSAL_NOT_FOUND",
        "REFRAME_CLIP_NOT_FOUND",
        "GENERATION_TASK_NOT_FOUND",
        "SHOT_LIST_NOT_FOUND",
        "SHOT_LIST_REVISION_NOT_FOUND",
        "SHOT_REQUIREMENT_ASSET_NOT_FOUND",
        "STAGE5_ASSEMBLY_NOT_FOUND",
        "STAGE6_BATCH_NOT_FOUND",
        "DERIVED_NOT_FOUND",
        "SPEAKER_NOT_FOUND",
        "KEYFRAME_GENERATION_NOT_FOUND",
    }:
        status = 404
    return _error(exc.code, exc.message, status)


def _error_payload(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "trace_id": new_id()}}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    state = CoreState(settings)

    def with_current_preview(timeline_state: dict[str, Any]) -> dict[str, Any]:
        timeline_state["current_preview"] = state.renders.current_preview(
            timeline_state["project_id"]
        )
        return timeline_state

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.prepare()
        try:
            state.rendition_presets.load()
            state.db.initialize()
        except MigrationError:
            raise
        state.media_generation.recover_interrupted_tasks()
        state.provider_image_generation.recover_interrupted_tasks()
        state.provider_image_generation.cleanup_orphans()
        state.db.recover_interrupted()
        state.render_coordinator.cleanup_orphans()
        # B10：启动恢复 building 残留（无在途认领的半产物不作命中）
        state.derived_cache.recover_orphaned_builds()
        seed_dir = os.environ.get("AIVS_E2E_MODEL_DIR")
        if seed_dir:
            state.model_manager.seed_external(Path(seed_dir))
        await state.jobs.start()
        ready_file = os.environ.get("AIVS_READY_FILE")
        if ready_file:
            Path(ready_file).write_text(
                json.dumps(
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "port": int(os.environ["AIVS_BOUND_PORT"]),
                        "pid": os.getpid(),
                        "build_version": __version__,
                    }
                ),
                encoding="utf-8",
            )
        perf_task = asyncio.create_task(perf_diagnostics.sample_loop_lag()) if perf_diagnostics.ENABLED else None
        try:
            yield
        finally:
            if perf_task is not None:
                perf_task.cancel()
                await asyncio.gather(perf_task, return_exceptions=True)
            perf_diagnostics.flush()
        await state.jobs.stop()
        state.auth.clear()

    app = FastAPI(title="AIVideo Core", version=__version__, lifespan=lifespan)
    app.add_middleware(TimelinePatchBodyLimitMiddleware)
    app.state.core = state

    def provider_public(provider: dict[str, Any]) -> dict[str, Any]:
        return {
            **state.timeline_patch_planning.provider_public(provider),
            **state.planning.candidate_capability(provider["provider_config_id"]),
        }

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = cast(dict[str, Any], exc.detail if isinstance(exc.detail, dict) else {})
        if "model" in detail:
            return JSONResponse(
                status_code=exc.status_code,
                content={
                    **_error_payload(
                        str(detail.get("code", "INTERNAL_ERROR")),
                        str(detail.get("message", "request failed")),
                    ),
                    "model": detail["model"],
                },
            )
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(
                str(detail.get("code", "INTERNAL_ERROR")), str(detail.get("message", "内部错误"))
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=400, content=_error_payload("VALIDATION_ERROR", "请求参数不合法")
        )

    @app.exception_handler(MigrationError)
    async def migration_error(_: Request, __: MigrationError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content=_error_payload("MIGRATION_FAILED", "数据库迁移失败")
        )

    def require_admin(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_admin(state.bearer(authorization)):
            raise _error("UNAUTHORIZED", "未授权访问", 401)
        return state

    def require_ui(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_ui(state.bearer(authorization)):
            raise _error("UNAUTHORIZED", "未授权访问", 401)
        return state

    @app.get("/api/v1/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "protocol_version": PROTOCOL_VERSION,
            "build_version": __version__,
            "database": "ok",
            "scheduler": "ok",
        }

    @app.get("/api/v1/internal/health")
    async def internal_health(_: CoreState = Depends(require_admin)) -> dict[str, Any]:
        return {"status": "ok", "protocol_version": PROTOCOL_VERSION, "build_version": __version__}

    @app.post("/api/v1/internal/sessions", response_model=SessionResponse)
    async def create_session(_: CoreState = Depends(require_admin)) -> SessionResponse:
        return SessionResponse(
            token=state.auth.create_ui_token(),
            scopes=[
                "system:read",
                "media:probe",
                "projects:read",
                "projects:write",
                "assets:read",
                "assets:write",
                "jobs:write",
                "jobs:read",
            ],
        )

    @app.put("/api/v1/internal/provider-secrets/{provider_config_id}")
    async def set_provider_secret(
        provider_config_id: str,
        request: ProviderSecretRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        try:
            state.providers.get(provider_config_id)
            state.provider_secrets.set(provider_config_id, request.secret)
            return {"provider_config_id": provider_config_id, "credential_status": "configured"}
        except (DomainError, ProviderError) as exc:
            raise _error(exc.code, exc.message, 400) from exc

    @app.delete("/api/v1/internal/provider-secrets/{provider_config_id}", status_code=204)
    async def delete_provider_secret(
        provider_config_id: str, _: CoreState = Depends(require_admin)
    ) -> None:
        state.provider_secrets.delete(provider_config_id)

    @app.get("/api/v1/projects/{project_id}/brief")
    async def get_brief(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.planning.get_brief(project_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.put("/api/v1/projects/{project_id}/brief")
    async def put_brief(
        project_id: str, request: BriefPutRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.planning.put_brief(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/recipes")
    async def list_recipes(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return {"items": state.recipes.list()}

    @app.get("/api/v1/recipes/{recipe_id}")
    async def get_recipe(recipe_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.recipes.public(state.recipes.get(recipe_id))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/providers")
    async def list_providers(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return {"items": [provider_public(item) for item in state.providers.list()]}

    @app.post("/api/v1/providers")
    async def create_provider(
        request: ProviderCreateRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            provider = state.providers.create(request.model_dump())
            return provider_public(provider)
        except (DomainError, ProviderError) as exc:
            raise _error(exc.code, exc.message, 400) from exc

    @app.patch("/api/v1/providers/{provider_config_id}")
    async def patch_provider(
        provider_config_id: str, request: ProviderPatchRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            provider = state.providers.patch(
                provider_config_id, {k: v for k, v in request.model_dump().items() if v is not None}
            )
            return provider_public(provider)
        except (DomainError, ProviderError) as exc:
            raise (
                _domain(exc) if isinstance(exc, DomainError) else _error(exc.code, exc.message, 400)
            )

    @app.delete("/api/v1/providers/{provider_config_id}", status_code=204)
    async def delete_provider(
        provider_config_id: str, _: CoreState = Depends(require_ui)
    ) -> None:
        """删除 Provider 配置（P67：废弃条目此前只能删密钥、条目永留下拉）。

        被外发/生成历史引用时拒绝（PROVIDER_IN_USE）——审计链不可静默断链；
        此时出路是删除密钥并停用。"""
        try:
            state.providers.delete(provider_config_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/providers/{provider_config_id}/test")
    async def test_provider(
        provider_config_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.planning.test_provider(provider_config_id)
        except (DomainError, ProviderError) as exc:
            raise (
                _domain(exc) if isinstance(exc, DomainError) else _error(exc.code, exc.message, 503)
            )

    @app.post("/api/v1/providers/{provider_config_id}/timeline-patch-capability-test")
    async def test_timeline_patch_provider_capability(
        provider_config_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.timeline_patch_planning.test_provider_capability(provider_config_id)
        except (DomainError, ProviderError) as exc:
            raise (
                _domain(exc) if isinstance(exc, DomainError) else _error(exc.code, exc.message, 503)
            )

    @app.post("/api/v1/providers/{provider_config_id}/candidate-planning-capability-test")
    async def test_candidate_provider_capability(
        provider_config_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.planning.test_candidate_provider_capability(provider_config_id)
        except (DomainError, ProviderError) as exc:
            raise (
                _domain(exc) if isinstance(exc, DomainError) else _error(exc.code, exc.message, 503)
            )

    @app.post("/api/v1/projects/{project_id}/candidate-generations/prepare")
    async def prepare_generation(
        project_id: str, request: EgressPrepareRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.planning.prepare(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/candidate-generations")
    async def create_generation(
        project_id: str,
        request: CandidateGenerationCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.planning.create_generation(
                project_id, request.egress_preview_id, request.payload_sha256, state.jobs
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/candidate-generations")
    async def list_candidate_generations(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.planning.list_generations(project_id)}

    @app.get("/api/v1/candidate-generations/{candidate_generation_id}")
    async def get_candidate_generation(
        candidate_generation_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.planning.get_generation(candidate_generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/candidate-plans")
    async def list_candidate_plans(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.planning.list_candidates(project_id)}

    @app.get("/api/v1/candidate-plans/{candidate_plan_id}")
    async def get_candidate_plan(
        candidate_plan_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.planning.get_candidate(candidate_plan_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get(
        "/api/v1/projects/{project_id}/candidate-plans/"
        "{candidate_plan_id}/clips/{candidate_clip_id}"
    )
    async def get_candidate_clip(
        project_id: str,
        candidate_plan_id: str,
        candidate_clip_id: str,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.planning.get_candidate_clip(
                project_id, candidate_plan_id, candidate_clip_id
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/candidate-plans/{candidate_plan_id}/adopt")
    async def adopt_candidate(
        project_id: str,
        candidate_plan_id: str,
        request: CandidateAdoptRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.planning.adopt(project_id, candidate_plan_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline-patch-generations/prepare")
    async def prepare_timeline_patch_generation(
        project_id: str,
        request: TimelinePatchPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.timeline_patch_planning.prepare(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline-patch-generations")
    async def create_timeline_patch_generation(
        project_id: str,
        request: TimelinePatchGenerationCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.timeline_patch_planning.create_generation(
                project_id,
                request.timeline_patch_egress_preview_id,
                request.payload_sha256,
                state.jobs,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/timeline-patch-generations")
    async def list_timeline_patch_generations(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.timeline_patch_planning.list_generations(project_id)}

    @app.get("/api/v1/timeline-patch-generations/{generation_id}")
    async def get_timeline_patch_generation(
        generation_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.timeline_patch_planning.get_generation(generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/timeline-patch-proposals")
    async def list_timeline_patch_proposals(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.timeline_patch_planning.list_proposals(project_id)}

    @app.get("/api/v1/timeline-patch-proposals/{proposal_id}")
    async def get_timeline_patch_proposal(
        proposal_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.timeline_patch_planning.get_proposal(proposal_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline-patch-proposals/{proposal_id}/apply")
    async def apply_timeline_patch_proposal(
        project_id: str,
        proposal_id: str,
        request: TimelinePatchProposalApplyRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            revision = state.timeline_patch_planning.apply(
                project_id, proposal_id, request.model_dump()
            )
            return with_current_preview(state.timelines.get_state(revision["project_id"]))
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- W1.1 剪辑语法层（P-A：零 egress，无 provider/consent）----
    @app.get("/api/v1/projects/{project_id}/editing-grammar/planners")
    async def list_editing_grammar_planners(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return state.editing_grammar.list_planners()

    @app.post("/api/v1/projects/{project_id}/editing-grammar/prepare")
    async def prepare_editing_grammar(
        project_id: str,
        request: EditingGrammarPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.editing_grammar.prepare(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/editing-grammar/proposals")
    async def create_editing_grammar_proposal(
        project_id: str,
        request: EditingGrammarProposalCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.editing_grammar.propose(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/editing-grammar/proposals")
    async def list_editing_grammar_proposals(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.editing_grammar.list_proposals(project_id)}

    @app.get("/api/v1/projects/{project_id}/editing-grammar/proposals/{proposal_id}")
    async def get_editing_grammar_proposal(
        project_id: str,
        proposal_id: str,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.editing_grammar.get_proposal(project_id, proposal_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/editing-grammar/proposals/{proposal_id}/apply")
    async def apply_editing_grammar_proposal(
        project_id: str,
        proposal_id: str,
        request: EditingGrammarProposalApplyRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            revision = state.editing_grammar.apply(
                project_id, proposal_id, request.model_dump()
            )
            return with_current_preview(state.timelines.get_state(revision["project_id"]))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/providers/{provider_id}/captions-provider-capability-test")
    async def test_captions_provider_capability(provider_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return await state.captions_provider_egress.test_capability(provider_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/captions-provider/prepare")
    async def prepare_captions_provider(project_id: str, request: CaptionsProviderPrepareRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.prepare(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/captions-provider")
    async def create_captions_provider(project_id: str, request: CaptionsProviderCreateRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.create(project_id, request.captions_provider_egress_preview_id, request.payload_sha256, state.jobs)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/captions-provider-generations/{generation_id}/proposal")
    async def create_captions_provider_proposal(project_id: str, generation_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.create_proposal(project_id, generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/captions-provider-generations/{generation_id}/proposal")
    async def get_captions_provider_proposal(project_id: str, generation_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.get_proposal_for_generation(project_id, generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/captions-provider-proposals/{proposal_id}/apply")
    async def apply_captions_provider_proposal(project_id: str, proposal_id: str, request: CaptionsProviderProposalApplyRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            revision = state.captions_provider_egress.apply_proposal(project_id, proposal_id, request.model_dump())
            return with_current_preview(state.timelines.get_state(revision["project_id"]))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/captions-provider-proposals/{proposal_id}")
    async def get_captions_provider_proposal_by_id(project_id: str, proposal_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.get_proposal(project_id, proposal_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/captions-provider-generations/{generation_id}")
    async def get_captions_provider(project_id: str, generation_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.captions_provider_egress.get(project_id, generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/worklists/prepare")
    async def prepare_worklist(project_id: str, request: WorklistPrepareRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try: return state.worklists.prepare(project_id, request.model_dump())
        except DomainError as exc: raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/worklists")
    async def create_worklist(project_id: str, request: WorklistCreateRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try: return state.worklists.create(project_id, request.model_dump())
        except DomainError as exc: raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/worklists")
    async def list_worklists(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return {"items": state.worklists.list(project_id)}

    @app.get("/api/v1/projects/{project_id}/worklists/{worklist_id}")
    async def get_worklist(project_id: str, worklist_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try: return state.worklists.get(project_id, worklist_id)
        except DomainError as exc: raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/worklists/{worklist_id}/cancel")
    async def cancel_worklist(project_id: str, worklist_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try: return state.worklists.cancel(project_id, worklist_id)
        except DomainError as exc: raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/worklists/{worklist_id}/steps/{step_id}/apply")
    async def apply_worklist_step(project_id: str, worklist_id: str, step_id: str, request: WorklistApplyRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            result = state.worklists.apply(project_id, worklist_id, step_id, request.model_dump())
            return with_current_preview(state.timelines.get_state(project_id))
        except DomainError as exc: raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/agent-sessions/prepare")
    async def prepare_agent_session(
        project_id: str,
        request: AgentSessionPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.agent_sessions.prepare(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/agent-sessions")
    async def create_agent_session(
        project_id: str,
        request: AgentSessionCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.agent_sessions.create_session(
                project_id,
                request.agent_session_egress_preview_id,
                request.payload_sha256,
                state.jobs,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/agent-sessions")
    async def list_agent_sessions(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return {"items": state.agent_sessions.list_sessions(project_id)}

    @app.get("/api/v1/agent-sessions/{agent_session_id}")
    async def get_agent_session(
        agent_session_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.agent_sessions.get_session(agent_session_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline/revision-diffs")
    async def compare_timeline_revisions(
        project_id: str,
        request: TimelineRevisionDiffRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.timelines.compare_revisions(
                project_id, request.base_revision_id, request.target_revision_id
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/file-grants")
    async def create_grant(
        request: FileGrantRequest, _: CoreState = Depends(require_admin)
    ) -> dict[str, Any]:
        path = Path(request.path).expanduser()
        try:
            path = path.resolve(strict=True)
        except OSError as exc:
            raise _error("MEDIA_NOT_FOUND", "媒体文件不存在", 400) from exc
        if not path.is_file():
            raise _error("MEDIA_UNSUPPORTED", "不支持的媒体格式", 400)
        stat = path.stat()
        expires_at = (
            (datetime.now(UTC) + timedelta(hours=1))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        grant_id = f"grant_{new_id()}"
        state.grants[grant_id] = {
            "path": str(path),
            "display_name": path.name,
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "modified_at_ns": stat.st_mtime_ns,
            "expires_at": expires_at,
        }
        return {
            "grant_id": grant_id,
            "display_name": path.name,
            "size_bytes": stat.st_size,
            "modified_at": state.grants[grant_id]["modified_at"],
            "expires_at": expires_at,
        }

    @app.get("/api/v1/internal/artifacts/{artifact_id}/resolve")
    async def resolve_artifact(
        artifact_id: str, _: CoreState = Depends(require_admin)
    ) -> dict[str, str]:
        try:
            return state.renders.resolve_artifact(artifact_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/internal/assets/{asset_id}/resolve")
    async def resolve_asset(asset_id: str, _: CoreState = Depends(require_admin)) -> dict[str, str]:
        try:
            # 异步入口：该端点被资产呈现扇出并发调用（每素材一次），同步全文件
            # 哈希会逐个堵死事件循环（100 素材时 accept 队列溢出，见 F04 复测）。
            return await state.projects.resolve_asset_path_async(asset_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/destination-grants")
    async def create_destination_grant(
        request: DestinationGrantRequest, _: CoreState = Depends(require_admin)
    ) -> dict[str, Any]:
        try:
            return state.destinations.create(request.path, request.overwrite_authorized)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/destination-grants/{grant_id}/rename")
    async def rename_destination_grant(
        grant_id: str,
        request: DestinationGrantRenameRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        try:
            return state.destinations.rename(grant_id, request.file_name)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/directory-grants")
    async def create_directory_grant(
        request: DirectoryGrantRequest, _: CoreState = Depends(require_admin)
    ) -> dict[str, Any]:
        try:
            return state.directory_grants.create(request.path)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/shutdown")
    async def shutdown(_: CoreState = Depends(require_admin)) -> dict[str, str]:
        state.shutdown_event.set()
        return {"status": "shutting_down"}

    @app.get("/api/v1/system/capabilities")
    async def capabilities(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = await state.encoders.capabilities()
        usage = shutil.disk_usage(state.settings.data_dir)
        return {
            "platform": platform.platform(),
            "cpu_count": os.cpu_count(),
            "free_bytes": usage.free,
            **result,
        }

    def grant_for(grant_id: str) -> dict[str, Any]:
        grant = state.grants.get(grant_id)
        if not grant:
            raise _error("GRANT_NOT_FOUND", "文件授权不存在", 404)
        if grant["expires_at"] <= utc_now():
            state.grants.pop(grant_id, None)
            raise _error("GRANT_EXPIRED", "文件授权已过期", 400)
        return grant

    def media_for(media_id: str) -> dict[str, Any]:
        with state.db.connection() as db:
            row = db.execute("SELECT * FROM media_inputs WHERE id=?", (media_id,)).fetchone()
        if not row:
            raise _error("MEDIA_NOT_FOUND", "媒体文件不存在", 404)
        return dict(row)

    def project_id_for_media(path: str, preferred_project_id: str | None = None) -> str | None:
        """Resolve a Stage 0 media probe to its Stage 1A asset owner."""
        try:
            uri = Path(path).resolve().as_uri()
        except (OSError, ValueError):
            return None
        clauses = ["asset_locations.uri=?"]
        values: list[Any] = [uri]
        if preferred_project_id is not None:
            clauses.append("assets.project_id=?")
            values.append(preferred_project_id)
        with state.db.connection() as db:
            row = db.execute(
                "SELECT assets.project_id "
                "FROM assets JOIN asset_locations ON asset_locations.asset_id=assets.id "
                f"WHERE {' AND '.join(clauses)} "
                "ORDER BY assets.updated_at DESC, assets.id DESC LIMIT 1",
                values,
            ).fetchone()
        return str(row[0]) if row else None

    @app.post("/api/v1/media/probe")
    async def probe(request: ProbeRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        grant = grant_for(request.grant_id)
        try:
            result = await state.ffprobe.probe(Path(grant["path"]))
        except RuntimeError as exc:
            raise _error(str(exc), "操作失败", 400) from exc
        media_id = new_id()
        now = utc_now()
        with state.db.connection() as db:
            db.execute(
                "INSERT INTO media_inputs VALUES (?,?,?,?,?,?,?)",
                (
                    media_id,
                    grant["path"],
                    grant["display_name"],
                    grant["size_bytes"],
                    str(grant["modified_at_ns"]),
                    json_dumps(result),
                    now,
                ),
            )
        return {"media_id": media_id, **result}

    @app.post("/api/v1/projects", status_code=201)
    async def create_project(
        request: ProjectCreateRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.projects.create_project(request.name, request.root_dir_name, request.canvas)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects")
    async def list_projects(
        status: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.projects.list_projects(status, limit, cursor)
        except DomainError as exc:
            raise _domain(exc) from exc
        return {"items": items, "next_cursor": next_cursor}

    @app.get("/api/v1/projects/{project_id}")
    async def get_project(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = state.projects.get_project(project_id)
        if not result:
            raise _error("PROJECT_NOT_FOUND", "项目不存在", 404)
        return result

    @app.patch("/api/v1/projects/{project_id}")
    async def rename_project(
        project_id: str, request: ProjectPatchRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        if request.name is None:
            raise _error("VALIDATION_ERROR", "请求参数不合法", 400)
        try:
            return state.projects.rename_project(project_id, request.name)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/archive")
    async def archive_project(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.projects.archive_project(project_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/reopen")
    async def reopen_project(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.projects.reopen_project(project_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/assets")
    async def list_assets(
        project_id: str,
        availability: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.projects.list_assets(project_id, availability, limit, cursor)
        except DomainError as exc:
            raise _domain(exc) from exc
        return {"items": items, "next_cursor": next_cursor}

    @app.post("/api/v1/projects/{project_id}/assets", status_code=201)
    async def import_asset(
        project_id: str, request: AssetImportRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.projects.import_asset(
                project_id, grant_for(request.grant_id), request.kind
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/assets/{asset_id}")
    async def get_asset(asset_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = state.projects.get_asset(asset_id)
        if not result:
            raise _error("ASSET_NOT_FOUND", "素材不存在", 404)
        return result

    @app.post("/api/v1/assets/{asset_id}/refresh")
    async def refresh_asset(asset_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return await state.projects.refresh_asset(asset_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/assets/{asset_id}/relocate")
    async def relocate_asset(
        asset_id: str, request: AssetRelocateRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.projects.relocate_asset(asset_id, grant_for(request.grant_id))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.delete("/api/v1/assets/{asset_id}")
    async def delete_asset(
        asset_id: str, remove_timeline_clips: bool = False, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        """删除素材；remove_timeline_clips=true 时级联删除时间线相关片段。"""
        try:
            counts = state.projects.delete_asset(
                asset_id, remove_timeline_clips=remove_timeline_clips
            )
        except DomainError as exc:
            raise _domain(exc) from exc
        return {"removed_clips": counts.get("removed_clips", 0), "removed_captions": counts.get("removed_captions", 0)}

    @app.post("/api/v1/projects/{project_id}/timelines", status_code=201)
    async def create_timeline(
        project_id: str,
        request: TimelineCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return with_current_preview(state.timelines.create(project_id, request.model_dump()))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/timeline")
    async def get_timeline(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return with_current_preview(state.timelines.get_state(project_id))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline/patches")
    async def patch_timeline(
        project_id: str,
        request: TimelinePatchRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return with_current_preview(state.timelines.patch(project_id, request.model_dump()))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline/undo")
    async def undo_timeline(
        project_id: str,
        request: TimelineNavigationRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return with_current_preview(state.timelines.undo(project_id, request.base_revision_id))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/timeline/redo")
    async def redo_timeline(
        project_id: str,
        request: TimelineNavigationRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return with_current_preview(state.timelines.redo(project_id, request.base_revision_id))
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.put("/api/v1/projects/{project_id}/timeline/draft")
    async def save_timeline_draft(
        project_id: str,
        request: TimelineDraftRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.timelines.save_draft(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.delete("/api/v1/projects/{project_id}/timeline/draft", status_code=204)
    async def delete_timeline_draft(project_id: str, _: CoreState = Depends(require_ui)) -> None:
        try:
            state.timelines.delete_draft(project_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/timeline/revisions")
    async def list_timeline_revisions(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.timelines.list_revisions(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/timeline-revisions/{revision_id}")
    async def get_timeline_revision(
        revision_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.timelines.get_revision(revision_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/previews")
    async def create_preview(
        project_id: str,
        request: PreviewCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return await state.renders.create_preview(
                project_id,
                request.timeline_revision_id,
                request.encoder_mode,
                request.output_ratio,
            )
        except DomainError as exc:
            raise _domain(exc) from exc
        except RuntimeError as exc:
            raise _error(str(exc).split(":", 1)[0], "无法创建权威预览", 409) from exc

    @app.get("/api/v1/projects/{project_id}/previews")
    async def list_previews(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.renders.list_previews(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/preview-ir")
    async def get_preview_ir(
        project_id: str,
        timeline_revision_id: str | None = None,
        output_ratio: str = "169",
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        if output_ratio not in {"169", "916", "11", "43", "34"}:
            raise _error("PREVIEW_IR_RATIO_UNSUPPORTED", "合成预览画布比例不合法", 400)
        try:
            return await state.render_coordinator.preview_ir(project_id, timeline_revision_id, output_ratio)
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- C20b：窗口化 IR v2（独立 endpoint；v1 响应形状不变） ----

    @app.get("/api/v1/projects/{project_id}/preview-ir-v2/manifest")
    async def get_preview_ir_v2_manifest(
        project_id: str,
        timeline_revision_id: str | None = None,
        output_ratio: str = "169",
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """C20 manifest：非帧字段显式 DTO（canvas/inputs/segments/captions 等）。

        与 v1 同鉴权（UI token）；manifest_id 绑定 revision/输出规格。"""
        if output_ratio not in {"169", "916", "11", "43", "34"}:
            raise _error("PREVIEW_IR_RATIO_UNSUPPORTED", "合成预览画布比例不合法", 400)
        try:
            return await state.render_coordinator.preview_ir_manifest(
                project_id, timeline_revision_id, output_ratio)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/preview-ir-v2/window")
    async def get_preview_ir_v2_window(
        project_id: str,
        start_frame: int,
        frame_count: int,
        timeline_revision_id: str | None = None,
        output_ratio: str = "169",
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """C20 窗口帧表：[start_frame, start_frame+frame_count) 的 v1 同语义帧。

        frame_count 1..300（计划硬上限）；越界/非法 400（PREVIEW_IR_WINDOW_INVALID）。
        同 revision 的窗口请求走服务端缓存切片（manifest 与窗口同源投影）。"""
        from .rendering.ir_window import MAX_WINDOW_FRAMES

        if output_ratio not in {"169", "916", "11", "43", "34"}:
            raise _error("PREVIEW_IR_RATIO_UNSUPPORTED", "合成预览画布比例不合法", 400)
        if start_frame < 0 or frame_count < 1 or frame_count > MAX_WINDOW_FRAMES:
            raise _error(
                "PREVIEW_IR_WINDOW_INVALID",
                f"窗口参数不合法（frame_count 1..{MAX_WINDOW_FRAMES}，start_frame >= 0）", 400)
        try:
            return await state.render_coordinator.preview_ir_window(
                project_id, timeline_revision_id, output_ratio, start_frame, frame_count)
        except DomainError as exc:
            raise _domain(exc) from exc
        except ValueError as exc:
            raise _error("PREVIEW_IR_WINDOW_INVALID", str(exc), 400) from exc

    @app.post("/api/v1/projects/{project_id}/derived-media/lookup")
    async def lookup_derived_media(
        project_id: str, request: DerivedMediaRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B10：派生条目状态查询（Renderer 可见，无路径字段）。"""
        try:
            return state.derived_media.lookup(
                project_id, request.asset_id, request.kind, request.params)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/derived-media/stats")
    async def derived_media_stats(
        project_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B10：派生缓存用量统计（预算可见性；无素材路径）。"""
        project = state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        if project["status"] == "archived":
            raise _error("PROJECT_ARCHIVED", "项目已归档", 409)
        return state.derived_media.stats()

    @app.post("/api/v1/internal/projects/{project_id}/derived-media/resolve")
    async def resolve_derived_media(
        project_id: str, request: DerivedMediaRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B10：Main 内部解析（admin 通道）；返回绝对路径供 Main 换票据——
        Renderer 永远拿不到 path，只有票据 media_url。"""
        try:
            return state.derived_media.resolve_internal(
                project_id, request.asset_id, request.kind, request.params)
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- B11：preview-source（全源代理与预览源选择） ----

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/preview-source")
    async def get_preview_source(
        project_id: str, asset_id: str, request: PreviewSourceRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B11：预览源描述/选择（Renderer 可见；无路径字段）。

        mode=auto：代理 ready 时返回代理描述；否则返回原源 ready（pending
        期间调用方回退原源，不阻塞 UI）。generate=true 且 mode=proxy 时才
        登记生成作业（禁止导入即整段转码）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            profile = request.profile_id
            if profile is not None:
                state.preview_source.proxy_params(profile)  # 档位白名单
            else:
                # 未指定档位：按源几何自动选择（与 describe 一致）
                profile = state.preview_source.describe(asset_row, "auto")["profile_id"]
            proxy = state.preview_source.proxy_entry(asset_row, profile) if (
                request.mode == "proxy" or request.mode == "auto"
            ) else None
            description = state.preview_source.describe(
                asset_row, request.mode, profile_id=profile, proxy=proxy,
            )
            job_id: str | None = None
            proxy_status = (proxy or {}).get("status")
            generate_allowed = (
                request.generate
                and request.mode == "proxy"
                # failed 允许重登记（显式 retry/重进视口）；ready/building/queued 幂等短路
                and proxy_status not in {"ready", "building", "queued"}
            )
            if generate_allowed:
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id = state.preview_source.create_proxy_job(
                    project_id, asset_row, description["profile_id"],
                    resolved_path["path"], request.encoder_mode,
                )
                # 回显 pending 状态（调用方立即知道作业在途）
                description = state.preview_source.describe(
                    asset_row, request.mode, profile_id=profile,
                    proxy={"cache_key": state.preview_source.proxy_cache_key(
                        asset_row["fingerprint"], description["profile_id"]),
                        "status": "building", "size_bytes": 0},
                )
            if "job_id" not in description:
                description["job_id"] = job_id
            return description
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/preview-source/jobs")
    async def create_preview_source_job(
        project_id: str, asset_id: str, request: PreviewSourceRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B11：显式登记代理生成作业（全源转码；作业状态经既有 jobs 查询流）。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            profile = request.profile_id or state.preview_source.describe(
                asset_row, "auto")["profile_id"]
            state.preview_source.proxy_params(profile)
            entry = state.preview_source.proxy_entry(asset_row, profile)
            entry_status = (entry or {}).get("status")
            # failed 允许重登记（显式 retry/重进视口）；ready/building/queued 幂等短路
            if entry_status in {"ready", "building", "queued"}:
                return {"job_id": None, "cache_key": (entry or {}).get("cache_key"),
                        "status": entry_status}
            resolved_path = state.projects.resolve_asset_path(asset_id)
            job_id = state.preview_source.create_proxy_job(
                project_id, asset_row, profile, resolved_path["path"],
                request.encoder_mode,
            )
            return {
                "job_id": job_id,
                "cache_key": state.preview_source.proxy_cache_key(
                    asset_row["fingerprint"], profile),
                "status": "queued",
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/projects/{project_id}/assets/{asset_id}/preview-source/media")
    async def resolve_preview_source_media(
        project_id: str, asset_id: str, request: PreviewSourceMediaRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B11：Main 内部解析代理文件（admin 通道）——绝对路径供 Main 换
        restricted-media 票据；Renderer 永远拿不到 path。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            state.preview_source.proxy_params(request.profile_id)
            key = state.preview_source.proxy_cache_key(
                asset_row["fingerprint"], request.profile_id)
            entry = state.derived_cache.lookup(key)
            if entry is None:
                raise _error("DERIVED_NOT_FOUND", "代理条目不存在或未就绪", 404)
            state.derived_cache.add_reference(key, project_id, asset_id)
            from .media.derived_cache import DerivedCacheError

            try:
                path = state.derived_cache.resolved_path(entry)
            except DerivedCacheError as exc:
                raise _domain(DomainError("DERIVED_CACHE_UNSAFE", exc.message)) from exc
            return {
                "cache_key": key,
                "status": "ready",
                "path": str(path),
                "size_bytes": entry.size_bytes,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- B14：素材级持久化波形（waveform） ----

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/waveform")
    async def get_asset_waveform(
        project_id: str, asset_id: str, request: WaveformRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B14：素材波形描述（Renderer 可见；无路径字段）。

        generate=True 且无 ready/building 条目时登记生成作业（流式 PCM
        聚合 → 金字塔，B10 派生缓存）；pending 期间调用方显示占位/无波形。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            if not (json_loads(asset_row["media_info_json"] or "{}").get("audio_streams") or []):
                raise _domain(DomainError(
                    "MEDIA_NO_AUDIO", "素材无音轨，不生成波形"))
            entry = state.waveform.waveform_entry(asset_row)
            job_id: str | None = None
            status = (entry or {}).get("status")
            if (
                request.generate
                # failed 允许重登记（显式 retry/重进视口）；ready/building/queued 幂等短路
                and status not in {"ready", "building", "queued"}
            ):
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id = state.waveform.create_waveform_job(
                    project_id, asset_row, resolved_path["path"])
                status = "queued"
            return {
                "cache_key": state.waveform.waveform_cache_key(asset_row["fingerprint"]),
                "status": status,
                "job_id": job_id,
                "size_bytes": (entry or {}).get("size_bytes"),
                "sample_rate": 8000,
                "channels": 1,
                "bucket": 256,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- WP-P232：素材级缩略图预抽（filmstrip sprite） ----

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/filmstrip")
    async def ensure_asset_filmstrip(
        project_id: str, asset_id: str, request: FilmstripRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """WP-P232：缩略图条目查询/登记（Renderer 可见；无路径字段）。

        step_ms 由调用方按当前缩放档位传入（ladderStepMs 语义——档位内
        幂等）。generate=True 且无 ready/building/queued 条目时登记生成作业
        （ffmpeg tile → sprite JPEG，B10 派生缓存）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            media_info = json_loads(asset_row["media_info_json"] or "{}")
            if not (media_info.get("video_streams") or []):
                raise _domain(DomainError(
                    "MEDIA_NO_VIDEO", "素材无视频流，不生成缩略条"))
            step_ms = state.filmstrips.nearest_step(request.step_ms)
            entry = state.filmstrips.filmstrip_entry(asset_row, step_ms)
            job_id: str | None = None
            status = (entry or {}).get("status")
            if (
                request.generate
                and status not in {"ready", "building", "queued"}
            ):
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id = state.filmstrips.create_filmstrip_job(
                    project_id, asset_row, resolved_path["path"], step_ms)
                status = "queued"
            return {
                "cache_key": state.filmstrips.filmstrip_cache_key(asset_row["fingerprint"], step_ms),
                "step_ms": step_ms,
                "status": status,
                "job_id": job_id,
                "size_bytes": (entry or {}).get("size_bytes"),
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/beat-analysis")
    async def get_asset_beat_analysis(
        project_id: str, asset_id: str, request: BeatAnalysisRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """Wave1 L2：素材节拍网格描述（Renderer 可见；无路径字段）。

        generate=True 且无 ready/queued/running 作业在途时登记分析作业
        （FFmpeg PCM 解码 → numpy 检测 → beat_grids）。beat_sync 的
        _signals_for 从 beat_grids 注入 beats_us——本路由是它在生产
        环境的唯一产出链路。音频/视频素材均可；无音轨 → unavailable。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            summary = state.beats.beat_summary(asset_row)
            job_id: str | None = None
            status = (summary or {}).get("status")
            if request.generate and status not in {"ready", "queued", "running", "unavailable"}:
                # 无分析或 stale/failed：登记新分析（stale = 素材指纹已变）。
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id = state.beats.create_beat_job(
                    project_id, asset_row, resolved_path["path"])
                status = "queued"
            return {
                "beat_grid_id": (summary or {}).get("beat_grid_id"),
                "status": status,
                "job_id": job_id,
                "bpm": (summary or {}).get("bpm"),
                "confidence": (summary or {}).get("confidence"),
                "beat_count": (summary or {}).get("beat_count"),
                "downbeat_count": (summary or {}).get("downbeat_count"),
                "algorithm_version": (summary or {}).get("algorithm_version") or str(BEAT_ALGORITHM_VERSION),
                "reason": (summary or {}).get("reason"),
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    # ── W3.1 素材池语义检索（只产元数据，不写任何时间线 op）──

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/semantic-index")
    async def post_asset_semantic_index(
        project_id: str, asset_id: str, request: SemanticIndexRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """素材语义索引摘要；generate=True 且无 ready/在途时登记索引作业。

        模型未安装 ⇒ status=unavailable(reason=model_not_installed)，
        **不静默降级**（与本仓既有 AI-2/W2.2 同一纪律）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            summary = state.semantic.index_summary(asset_row)
            job_id: str | None = None
            status = (summary or {}).get("status")
            if request.generate and status not in {"ready", "queued", "running", "unavailable"}:
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id = state.semantic.create_index_job(
                    project_id, asset_row, resolved_path["path"])
                status = "queued"
            return {
                "index_id": (summary or {}).get("index_id"),
                "status": status,
                "job_id": job_id,
                "frame_count": (summary or {}).get("frame_count"),
                "algorithm_version": (summary or {}).get("algorithm_version"),
                "model_id": (summary or {}).get("model_id"),
                "reason": (summary or {}).get("reason"),
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/semantic-search")
    async def post_semantic_search(
        project_id: str, request: SemanticSearchRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """项目内自然语言检索（**绝不跨项目**）。

        绑定约束（门 §3 A8）：返回的是**相似度排序**，不是可信命中的承诺。
        """
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        try:
            hits = state.semantic.search_text(project_id, request.query, request.limit)
        except DomainError as exc:
            raise _domain(exc) from exc
        return {"query": request.query, "hits": hits}

    # ── W3.3 Layer 2 关键帧理解（帧级外传预览；本组端点**零网络**）──

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/keyframe-preview")
    async def post_keyframe_preview(
        project_id: str, asset_id: str, request: KeyframePreviewRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """读切点 → 抽样 → 编码 → 落预览。**不发任何网络请求**。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            from .keyframe_orchestration import ensure_video_asset

            ensure_video_asset(asset_row)
            # 按 id 取即可：provider_configs 没有 project_id 列（Provider 是
            # 进程级配置，见 database.py 建表），所以「本项目是否用过该
            # Provider」在库里无对象可查。全仓其它取用点（1523、
            # keyframe_tagging._require_provider、vision_probe、
            # captions_provider_egress）同样只按 id 取，此处保持一致。
            # prepare 只要 DTO 形状（provider_config_id + model），get() 返回
            # 的正是 _dto(row)。未探测/停用的门禁不在这里：prepare 零网络，
            # 放行判据在 create 的 _require_vision_capable（A4）。
            provider = state.providers.get(request.provider_config_id)
            resolved = state.projects.resolve_asset_path(asset_id)
            # 这一行有三处必须同时对上，缺一个都是装配级错误（单测走服务层
            # 时看不见）：probe 是 async ⇒ 要 await；入参是 Path ⇒ 不能传
            # resolved["path"] 的 str（probe 内部会 path.stat()）；返回的是
            # dict ⇒ 不能按属性读 duration_us。
            detail = await state.ffprobe.probe(Path(resolved["path"]))
            duration_us = int(detail["duration_us"])
            kwargs: dict[str, Any] = {}
            if request.interval_us is not None:
                kwargs["interval_us"] = request.interval_us
            return await state.keyframe.prepare_preview(
                project_id, asset_row, provider,
                Path(resolved["path"]), duration_us, **kwargs,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/keyframe-preview/{preview_id}/exclude")
    async def post_keyframe_exclude(
        project_id: str, preview_id: str, request: KeyframeExcludeRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """逐张移除（只增不改）。重算 payload 哈希。**零网络**。"""
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        if not request.frame_indices:
            raise _error("VALIDATION_ERROR", "至少指定一帧", 400)
        try:
            return state.keyframe_egress.exclude_frames(
                project_id, preview_id, request.frame_indices)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/keyframe-preview/{preview_id}/create")
    async def post_keyframe_create(
        project_id: str, preview_id: str, request: KeyframeCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """建 consent + generation + 作业。**仍不发网络**——外传须经 claim（I-1）。

        传 jobs 是必须的：不传则生成记录落库后没有任何执行者，
        永远停在 queued（这正是 W3.3 收口前生产链路的断点）。
        """
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        try:
            return state.keyframe_egress.create(
                project_id, preview_id, request.payload_sha256, state.jobs)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/providers/{provider_id}/vision-capability")
    async def post_vision_capability(
        provider_id: str, project_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """vision 能力探测（S3）。**这是唯一会发网络的探测端点**。

        必须带 `project_id`：探测走 prepare→create→claim 三段式（I-1 / 评审 #4），
        而 `keyframe_egress_previews.project_id` 是 NOT NULL 外键——没有项目就
        没有预览行，也就没有可消费的 consent。设计门 §5.1 只冻结了路径与
        「必须先 prepare→create→claim」，未规定 project 如何传入；此处取
        query 参数，并在报告里标注这一处对门的下沉细节。
        """
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        try:
            return await state.vision_probe.probe(project_id, provider_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/keyframe-generations/{generation_id}")
    async def get_keyframe_generation(
        project_id: str, generation_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """生成状态（S5b）。零网络、只读；跨项目一律 404。"""
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        try:
            return state.keyframe_egress.generation_status(project_id, generation_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    # ── W3.3 关键帧打标结果读取（S5a；只读，不发网络）──

    @app.get("/api/v1/projects/{project_id}/assets/{asset_id}/frame-tags")
    async def get_asset_frame_tags(
        project_id: str, asset_id: str, label: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """该素材的逐帧标签。label 非空时只返回含该标签的帧。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            cleaned = frame_tags_module.validate_label(label) if label is not None else None
            return state.frame_tags.summary(asset_row, label=cleaned)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/frame-tags")
    async def get_project_frame_tags(
        project_id: str, label: str = "", limit: int = 100,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """项目内按标签过滤（D1）。**绝不跨项目**；空标签拒绝而非返回全部。"""
        state.projects._require_project_row(project_id)  # noqa: SLF001 归属校验
        if limit < 1 or limit > 500:
            raise _error("VALIDATION_ERROR", "limit 超出范围", 400)
        try:
            cleaned = frame_tags_module.validate_label(label)
            hits = state.frame_tags.by_label(project_id, cleaned, limit=limit)
        except DomainError as exc:
            raise _domain(exc) from exc
        return {"label": cleaned, "hits": hits}

    # ── W2.2 说话人分离（只产元数据，不写任何时间线 op）──

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/diarization")
    async def get_asset_diarization(
        project_id: str, asset_id: str, request: SpeakerDiarizationRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """说话人分离摘要（Renderer 可见；**无路径字段、无 embedding**）。

        generate=True 且无 ready/queued/running/stale 行时登记分析作业
        （解码 → 随包 Silero VAD → 窗 embedding → 聚类 → speaker_diarizations）。
        全本地零 egress；模型未就绪 ⇒ unavailable(embedding_model_missing)。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            summary = state.speaker.summary(asset_row)
            job_id: str | None = None
            if request.generate:
                job_id = state.speaker.create_job(project_id, asset_row)
            ready = state.speaker.availability()
            return {
                "speaker_diarization_id": (summary or {}).get("speaker_diarization_id"),
                "status": (summary or {}).get("status") if summary else (
                    "queued" if job_id else None),
                "job_id": job_id,
                "reason": (summary or {}).get("reason"),
                "speaker_count": (summary or {}).get("speaker_count"),
                "turn_count": (summary or {}).get("turn_count"),
                "window_count": (summary or {}).get("window_count"),
                "threshold": (summary or {}).get("threshold"),
                "threshold_strategy": (summary or {}).get("threshold_strategy"),
                "algorithm_version": (summary or {}).get("algorithm_version") or str(
                    SPEAKER_ALGORITHM_VERSION),
                "embedding_model": (summary or {}).get("embedding_model"),
                "vad_model": (summary or {}).get("vad_model"),
                "model_ready": ready["ready"],
                "model_reason": ready["reason"],
                "recorded_at": (summary or {}).get("recorded_at"),
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/assets/{asset_id}/diarization/turns")
    async def get_asset_diarization_turns(
        project_id: str, asset_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """说话人轮次时间轴（按需读取——摘要不带 turns，避免每次列表拉全量）。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            row = state.speaker.latest_row(asset_row["id"])
            if row is None:
                raise DomainError("SPEAKER_NOT_FOUND", "尚无说话人分离结果")
            status = str(row["status"])
            stale = status in {"ready", "unavailable"} and (
                row["source_fingerprint"] != asset_row["fingerprint"])
            return {
                "speaker_diarization_id": row["id"],
                "status": "stale" if stale else status,
                "speaker_count": row["speaker_count"],
                "threshold": row["threshold"],
                "threshold_strategy": row["threshold_strategy"],
                "turns": json_loads(row["turns_json"] or "[]"),
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/diarization/recluster")
    async def recluster_asset_diarization(
        project_id: str, asset_id: str, request: SpeakerReclusterRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """换 τ / 换策略重聚类（复用已存 embedding，**不重跑推理**）。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            from .media import speaker as speaker_algo

            k_max = request.k_max or speaker_algo.DEFAULT_K_MAX
            return state.speaker.recluster(
                asset_row["id"], strategy=request.strategy, k_max=k_max)
        except DomainError as exc:
            raise _domain(exc) from exc

    # ── W2.1 机位同步（只产元数据，不写任何时间线 op；I4/DEC-2）──

    @app.post("/api/v1/projects/{project_id}/angle-groups")
    async def create_angle_group(
        project_id: str, request: AngleGroupCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """建机位组：参考机位 + 有序成员（均为本项目视频素材）。"""
        try:
            return state.angle_sync.create_group(
                project_id, request.name, request.reference_asset_id,
                request.member_asset_ids,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/angle-groups")
    async def list_angle_groups(
        project_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return {"items": state.angle_sync.list_groups(project_id)}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/angle-groups/{group_id}")
    async def get_angle_group(
        project_id: str, group_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.angle_sync.group_summary(project_id, group_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.delete("/api/v1/projects/{project_id}/angle-groups/{group_id}")
    async def delete_angle_group(
        project_id: str, group_id: str, _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """删除机位组（同步行随组 CASCADE）；删除后其素材即可从项目移除。"""
        try:
            return state.angle_sync.delete_group(project_id, group_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/angle-groups/{group_id}/sync")
    async def sync_angle_group(
        project_id: str, group_id: str, request: AngleSyncRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """登记同步作业（generate=True）；组内全可用且指纹相符时幂等短路。"""
        try:
            job_id = state.angle_sync.create_sync_job(project_id, group_id) if request.generate else None
            return {"job_id": job_id, "group": state.angle_sync.group_summary(project_id, group_id)}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/angle-groups/{group_id}/angles/{asset_id}/offset")
    async def set_angle_offset(
        project_id: str, group_id: str, asset_id: str, request: AngleOffsetRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """人工偏移（source=manual 独立行，与自动结果并列）。"""
        try:
            return state.angle_sync.write_manual_offset(
                project_id, group_id, asset_id, request.offset_us)
        except DomainError as exc:
            raise _domain(exc) from exc


    @app.get("/api/v1/decode-capability")
    async def decode_capability(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        """P30：`ffmpeg -decoders` 能力数据源（§2.5）。

        响应含 decoders / probed_at / ffmpeg_fingerprint；FFmpeg build 指纹
        变化即重探（换 FFmpeg 不再沿用陈旧结论）。进程内缓存 = Core 重启重探。
        """
        return state.decode_capability_probe.get()

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/decode-frames")
    async def decode_asset_frames(
        project_id: str, asset_id: str, request: DecodeFramesRequest,
        _: CoreState = Depends(require_ui),
    ) -> Response:
        """H3 后端 B：合成帧号窗 → NV12 平面（路径永不进响应）。

        取帧语义与后端 A 对齐：target_us = frameN/fps*1e6，PTS 最近邻
        ±33_334μs。响应为 pack_nv12_response 紧凑二进制（AIV1）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            if asset_row["kind"] != "video":
                raise _domain(DomainError(
                    "DECODE_UNSUPPORTED_ASSET", "仅视频素材可解码窗口帧"))
            media = json_loads(asset_row["media_info_json"] or "{}")
            streams = media.get("video_streams") or []
            if not streams:
                raise _domain(DomainError("DECODE_NO_VIDEO", "素材无视频流"))
            width = int(streams[0].get("width") or 0)
            height = int(streams[0].get("height") or 0)
            resolved = state.projects.resolve_asset_path(asset_id)
            frames = await decode_frames(
                state.settings.ffmpeg,
                state.settings.ffprobe,
                Path(resolved["path"]),
                width=width,
                height=height,
                frame_numbers=request.frame_numbers,
                fps=request.fps,
            )
            body = pack_nv12_response(frames)
            return Response(
                content=body,
                media_type="application/vnd.aivideo.decode-frames-v1",
                headers={"X-Frame-Count": str(len(frames))},
            )
        except FrameDecodeError as exc:
            raise _domain(DomainError(exc.code, exc.message)) from exc
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/cv-analysis")
    async def get_asset_cv_analysis(
        project_id: str, asset_id: str, request: CvAnalysisRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """AI-2 Layer 0：素材 CV 信号分析描述（Renderer 可见；无路径字段）。

        generate=True 且无 ready/running/queued 条目时登记分析作业
        （关键帧采样 → numpy 信号 → cv_samples）。仅 video 素材可分析。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            if asset_row["kind"] != "video":
                raise _domain(DomainError(
                    "CV_ANALYSIS_UNSUPPORTED", "仅视频素材可分析 CV 信号"))
            summary = state.cv_signals.analysis_summary(asset_row)
            job_id: str | None = None
            status = (summary or {}).get("status")
            if request.generate and status not in {"ready", "running", "queued"}:
                # 无分析或 stale/failed：登记新分析（stale = 素材指纹已变）。
                resolved_path = state.projects.resolve_asset_path(asset_id)
                job_id, _analysis_id = state.cv_signals.create_analysis_job(
                    project_id, asset_row, resolved_path["path"],
                    target_gap_us=request.target_gap_us,
                    budget_per_minute_s=request.budget_per_minute_s,
                )
                status = "queued"
            return {
                "analysis_id": (summary or {}).get("analysis_id"),
                "status": status,
                "job_id": job_id,
                # 契约类型是 string（packages/contracts CvAnalysisSummary.algorithm_version；
                # Desktop 侧 parseCvAnalysisSummary 强制 typeof === "string"）。DB 常量是 int，
                # 此处曾直出 int → 桌面端每次读 CV 摘要都 ContractValidationError（真机手测
                # 2026-10-10 现场）。与 beat 路由同口径：出参统一 str。
                "algorithm_version": str(CV_ALGORITHM_VERSION),
                "sample_count": (summary or {}).get("sample_count"),
                "scene_cut_count": (summary or {}).get("scene_cut_count"),
                # ADR-0005 阶段 1/2：采样密度（增量可选字段；旧客户端不读不受影响）。
                "density_status": (summary or {}).get("density_status"),
                "achieved_max_gap_us": (summary or {}).get("achieved_max_gap_us"),
                "gap_threshold_us": (summary or {}).get("gap_threshold_us"),
                "signals": [
                    "scene_cut", "motion_energy", "sharpness", "brightness",
                    "audio_energy",
                ],
            }
        except DomainError as exc:
            raise _domain(exc) from exc
        except CvAnalysisError as exc:
            raise _domain(DomainError(exc.code, exc.message)) from exc

    @app.get("/api/v1/projects/{project_id}/assets/{asset_id}/cv-samples")
    async def list_asset_cv_samples(
        project_id: str, asset_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        """AI-2 可视化：素材最新 ready 分析的信号样本（Renderer sparkline）。

        只读投影：时间戳 + 数值信号，无路径字段；未就绪返回空 samples。
        """
        try:
            asset_row = _preview_source_asset_row(state, project_id, asset_id)
            if asset_row["kind"] != "video":
                raise _domain(DomainError(
                    "CV_ANALYSIS_UNSUPPORTED", "仅视频素材可分析 CV 信号"))
            samples = state.cv_signals.samples_for_range(asset_id, 0, 1 << 62)
            return {
                "asset_id": asset_id,
                "samples": [
                    {
                        "timestamp_us": s["timestamp_us"],
                        "scene_cut": bool(s["scene_cut"]),
                        "motion_energy": s["motion_energy"],
                        "sharpness": s["sharpness"],
                        "brightness": s["brightness"],
                        "audio_energy": s["audio_energy"],
                    }
                    for s in samples
                ],
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/projects/{project_id}/assets/{asset_id}/filmstrip/media")
    async def resolve_asset_filmstrip_media(
        project_id: str, asset_id: str, request: FilmstripMediaRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """WP-P232：Main 内部解析 sprite 文件（admin 通道）——绝对路径供
        Main 换 restricted-media 票据；Renderer 永远拿不到 path。"""
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            step_ms = state.filmstrips.nearest_step(request.step_ms)
            key = state.filmstrips.filmstrip_cache_key(asset_row["fingerprint"], step_ms)
            entry = state.derived_cache.lookup(key)
            if entry is None:
                raise _error("DERIVED_NOT_FOUND", "缩略图条目不存在或未就绪", 404)
            state.derived_cache.add_reference(key, project_id, asset_id)
            from .media.derived_cache import DerivedCacheError

            try:
                path = state.derived_cache.resolved_path(entry)
            except DerivedCacheError as exc:
                raise _error("DERIVED_CACHE_UNSAFE", exc.message, 500)
            meta_path = path.parent / (path.stem + ".json")
            meta = json_loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
            return {
                "cache_key": key,
                "kind": "filmstrip",
                "status": "ready",
                "path": str(path),
                "size_bytes": entry.size_bytes,
                "step_ms": step_ms,
                "cell_w": meta.get("cell_w") or 160,
                "cell_h": meta.get("cell_h") or 90,
                "count": meta.get("count") or 0,
                "duration_us": meta.get("duration_us") or 0,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/internal/projects/{project_id}/assets/{asset_id}/waveform/media")
    async def resolve_asset_waveform_media(
        project_id: str, asset_id: str,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B14：Main 内部解析波形文件（admin 通道）——绝对路径供 Main 换
        restricted-media 票据；Renderer 永远拿不到 path。

        无请求体（params 由服务端算法常量唯一决定——不收 Renderer 参数）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            key = state.waveform.waveform_cache_key(asset_row["fingerprint"])
            entry = state.derived_cache.lookup(key)
            if entry is None:
                raise _error("DERIVED_NOT_FOUND", "波形条目不存在或未就绪", 404)
            state.derived_cache.add_reference(key, project_id, asset_id)
            from .media.derived_cache import DerivedCacheError

            try:
                path = state.derived_cache.resolved_path(entry)
            except DerivedCacheError as exc:
                raise _domain(DomainError("DERIVED_CACHE_UNSAFE", exc.message)) from exc
            return {
                "cache_key": key,
                "status": "ready",
                "path": str(path),
                "size_bytes": entry.size_bytes,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    # ---- B15：分块 PCM（audio_pcm_chunk） ----

    @app.post("/api/v1/projects/{project_id}/assets/{asset_id}/pcm-chunks")
    async def ensure_pcm_chunk(
        project_id: str, asset_id: str, request: PcmChunkRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        """B15：确保一个 PCM 块 ready（Renderer 可见；无路径字段）。

        同步内联生成（2 秒块小任务，不排 jobs 队列——低延迟 PCM 不能等
        长导出；begin_build single-flight 防并发同 key 重复生成）。
        start_sample 必须对齐 96000 样本网格；尾块 valid_samples < 96000。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            if not (json_loads(asset_row["media_info_json"] or "{}").get("audio_streams") or []):
                raise _domain(DomainError(
                    "MEDIA_NO_AUDIO", "素材无音轨，不生成分块 PCM"))
            resolved_path = state.projects.resolve_asset_path(asset_id)
            result = await state.pcm_chunks.ensure_chunk(
                asset_row, request.start_sample, resolved_path["path"])
            return {
                "cache_key": result["cache_key"],
                "status": result["status"],
                "start_sample": result["start_sample"],
                "valid_samples": result["valid_samples"],
                "sample_rate": 48000,
                "channels": 2,
                "chunk_samples": 96000,
                "size_bytes": result["size_bytes"],
            }
        except DomainError as exc:
            raise _domain(exc) from exc
        except PcmChunkError as exc:
            # 服务层网格/媒体约束 → 400（代码语义与波形端点一致）
            raise _domain(DomainError(exc.code, exc.message)) from exc

    @app.post("/api/v1/internal/projects/{project_id}/assets/{asset_id}/pcm-chunks/media")
    async def resolve_pcm_chunk_media(
        project_id: str, asset_id: str, request: PcmChunkMediaRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B15：Main 内部解析 PCM 块文件（admin 通道）——路径仅供 Main 换票据。

        start_sample 与 ensure 相同网格校验（Renderer 不能任意偏移——
        请求伪造的偏移无法命中任何条目）。
        """
        asset_row = _preview_source_asset_row(state, project_id, asset_id)
        try:
            key = state.pcm_chunks.chunk_cache_key(
                asset_row["fingerprint"], request.start_sample)
            entry = state.derived_cache.lookup(key)
            if entry is None:
                raise _error("DERIVED_NOT_FOUND", "PCM 块不存在或未就绪", 404)
            state.derived_cache.add_reference(key, project_id, asset_id)
            from .media.derived_cache import DerivedCacheError

            try:
                path = state.derived_cache.resolved_path(entry)
            except DerivedCacheError as exc:
                raise _domain(DomainError("DERIVED_CACHE_UNSAFE", exc.message)) from exc
            return {
                "cache_key": key,
                "status": "ready",
                "path": str(path),
                "size_bytes": entry.size_bytes,
            }
        except DomainError as exc:
            raise _domain(exc) from exc
        except PcmChunkError as exc:
            raise _domain(DomainError(exc.code, exc.message)) from exc

    # ---- B16：编辑器负载 lease + 调度观测（admin 内部通道） ----

    @app.post("/api/v1/internal/editor-load-lease")
    async def editor_load_lease(
        request: EditorLoadLeaseRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B16b：编辑器负载心跳（Main 注入 window owner；TTL 3s）。

        mode ∈ playing/scrubbing/idle；无心跳/过期 = idle（Renderer 崩溃
        不永久饿死任务）。播放/拖动中：新的低优先级（≥4 级）重任务暂缓
        入队执行；已运行任务不受影响（不可抢占语义）。
        """
        import time as _time

        try:
            state.job_scheduler.lease.heartbeat(
                request.window_id, request.mode, _time.monotonic())
        except ValueError as exc:
            raise _error("LEASE_MODE_INVALID", str(exc), 400) from exc
        return {"status": "ok", "mode": request.mode, "ttl_s": 3.0}

    @app.get("/api/v1/internal/job-scheduler/stats")
    async def job_scheduler_stats(
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        """B16 调度器观测（admin 诊断：容量/持有/lease 快照）。"""
        return state.job_scheduler.snapshot()

    @app.get("/api/v1/platform-presets")
    async def list_platform_presets(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return {"items": state.rendition_presets.platform_dto()}

    @app.get("/api/v1/rendition-presets")
    async def list_rendition_presets(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return {"items": state.rendition_presets.rendition_dto()}

    @app.post("/api/v1/projects/{project_id}/rendition-previews")
    async def create_rendition_preview(
        project_id: str, request: RenditionPreviewRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            snapshot = state.rendition_snapshots.create_or_reuse(
                project_id,
                request.timeline_revision_id,
                request.platform_preset_id,
                request.rendition_preset_id,
                request.layout_policy,
            )
            return await state.renders.create_rendition_preview(
                project_id,
                request.timeline_revision_id,
                snapshot["rendition_snapshot_id"],
                request.encoder_mode,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/rendition-previews")
    async def list_rendition_previews(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.renders.list_rendition_previews(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/rendition-reframe-previews")
    async def create_rendition_reframe_preview(
        project_id: str,
        request: ReframePreviewRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            snapshot = state.rendition_reframe_snapshots.create_or_reuse(
                project_id,
                request.base_rendition_snapshot_id,
                [item.model_dump() for item in request.adjustments],
            )
            return await state.renders.create_reframe_preview(
                project_id,
                snapshot["timeline_revision_id"],
                snapshot["rendition_reframe_snapshot_id"],
                request.encoder_mode,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/rendition-reframe-previews")
    async def list_rendition_reframe_previews(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.renders.list_reframe_previews(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/reframe-export-batches")
    async def create_reframe_export_batch(
        project_id: str,
        request: ReframeExportBatchCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return await state.reframe_export_batches.create(
                project_id,
                request.directory_grant_id,
                [item.model_dump(exclude_none=True) for item in request.items],
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/reframe-export-batches")
    async def list_reframe_export_batches(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.reframe_export_batches.list(project_id)
            if not 1 <= limit <= 100 or (
                cursor is not None and (not cursor.isdigit() or int(cursor) < 0)
            ):
                raise DomainError("REFRAME_BATCH_INVALID", "分页参数不合法")
            offset = int(cursor or 0)
            page = items[offset : offset + limit]
            return {
                "items": page,
                "next_cursor": str(offset + len(page)) if len(page) == limit else None,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/reframe-export-batches/{batch_id}")
    async def get_reframe_export_batch(
        batch_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.reframe_export_batches.get(batch_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/reframe-export-batches/{batch_id}/cancel")
    async def cancel_reframe_export_batch(
        batch_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.reframe_export_batches.cancel(batch_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/reframe-export-batches/{batch_id}/retry")
    async def retry_reframe_export_batch(
        batch_id: str,
        request: ReframeExportBatchRetryRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return await state.reframe_export_batches.retry(
                batch_id,
                request.directory_grant_id,
                request.reframe_export_batch_item_ids,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/export-batches")
    async def create_export_batch(
        project_id: str, request: ExportBatchCreateRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.export_batches.create(
                project_id, request.timeline_revision_id, request.directory_grant_id, request.items
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/export-batches")
    async def list_export_batches(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.export_batches.list(project_id)
            if not 1 <= limit <= 100 or (
                cursor is not None and (not cursor.isdigit() or int(cursor) < 0)
            ):
                raise DomainError("EXPORT_BATCH_INVALID", "分页参数不合法")
            offset = int(cursor or 0)
            page = items[offset : offset + limit]
            return {
                "items": page,
                "next_cursor": str(offset + len(page)) if len(page) == limit else None,
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/export-batches/{batch_id}")
    async def get_export_batch(batch_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.export_batches.get(batch_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/export-batches/{batch_id}/cancel")
    async def cancel_export_batch(
        batch_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.export_batches.cancel(batch_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/export-batches/{batch_id}/retry")
    async def retry_export_batch(
        batch_id: str, request: ExportBatchRetryRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.export_batches.retry(
                batch_id, request.directory_grant_id, request.export_batch_item_ids
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/exports")
    async def create_export(
        project_id: str,
        request: ExportCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return await state.renders.create_export(
                project_id,
                request.timeline_revision_id,
                request.destination_grant_id,
                request.encoder_mode,
                request.output_ratio,
                quality=request.quality,
                resolution=request.resolution,
                frame_rate=request.frame_rate,
            )
        except DomainError as exc:
            raise _domain(exc) from exc
        except RuntimeError as exc:
            raise _error(str(exc).split(":", 1)[0], "无法创建最终导出", 409) from exc

    @app.get("/api/v1/projects/{project_id}/exports")
    async def list_exports(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.renders.list_exports(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.delete("/api/v1/projects/{project_id}/exports/{export_record_id}", status_code=204)
    async def delete_export_record(
        project_id: str, export_record_id: str, _: CoreState = Depends(require_ui)
    ) -> None:
        """移除一条文件已缺失的导出记录（文件在系统层被删后的列表清理）。

        记录不存在或归属项目不符均 404（不区分，避免越权探测）。"""
        try:
            dto = state.renders.export_dto(export_record_id)
            if dto["project_id"] != project_id:
                raise DomainError("EXPORT_NOT_FOUND", "导出记录不存在")
            state.renders.remove_export_record(export_record_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/render-artifacts/{artifact_id}")
    async def get_render_artifact(
        artifact_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.renders.artifact_dto(artifact_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/models")
    async def list_models(
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        if (
            limit < 1
            or limit > 100
            or (cursor is not None and (not cursor.isdigit() or int(cursor) < 0))
        ):
            raise _error("CONFLICT", "操作冲突，请刷新后重试", 400)
        items = state.model_manager.list_details()
        offset = int(cursor or 0)
        page = items[offset : offset + limit]
        return {
            "items": [
                {
                    key: value
                    for key, value in item.items()
                    if key not in {"runtime_requirements", "files", "available_disk_bytes"}
                }
                for item in page
            ],
            "next_cursor": str(offset + len(page)) if len(page) == limit else None,
        }

    @app.get("/api/v1/models/{model_id}")
    async def get_model(model_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.model_manager.detail(model_id)
        except ModelError as exc:
            raise _model_error(exc) from exc

    @app.post("/api/v1/models/{model_id}/download")
    async def download_model(
        model_id: str,
        request: ModelDownloadRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            manifest = state.model_registry.get(model_id)
            if manifest.license.acceptance_required and not request.license_acceptance:
                raise ModelError("MODEL_LICENSE_REQUIRED", "需要确认模型许可证后才能下载")
            existing = state.jobs.latest_model_download(model_id, manifest.revision)
            if existing and existing["status"] in {"queued", "running", "cancelling"}:
                return {"model": state.model_manager.detail(model_id), "job": existing}
            state.model_manager.queue(manifest)
            job = state.jobs.create_model_download(model_id, manifest.revision)
            return {"model": state.model_manager.detail(model_id), "job": job}
        except ModelError as exc:
            raise _model_error(exc) from exc

    @app.get("/api/v1/models/{model_id}/download")
    async def model_download_status(
        model_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            manifest = state.model_registry.get(model_id)
            return {
                "model": state.model_manager.detail(model_id),
                "job": state.jobs.latest_model_download(model_id, manifest.revision),
            }
        except ModelError as exc:
            raise _model_error(exc) from exc

    @app.post("/api/v1/models/{model_id}/cancel")
    async def cancel_model(model_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            manifest = state.model_registry.get(model_id)
            job = state.jobs.latest_model_download(model_id, manifest.revision)
            if not job:
                raise ModelError("CONFLICT", "操作冲突，请刷新后重试")
            cancelled = await state.jobs.cancel(job["job_id"])
            return {"model": state.model_manager.detail(model_id), "job": cancelled}
        except ModelError as exc:
            raise _model_error(exc) from exc

    @app.post("/api/v1/assets/{asset_id}/transcription")
    async def create_transcription(
        asset_id: str,
        request: TranscriptionRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            manifest = state.model_registry.get(request.model_id)
            if manifest.license.acceptance_required and not request.license_acceptance:
                raise ModelError("MODEL_LICENSE_REQUIRED", "需要确认模型许可证后才能下载")
            if request.language != "auto" and request.language not in manifest.supported_languages:
                raise TranscriptionError("TRANSCRIPTION_UNSUPPORTED_LANGUAGE", "不支持的转录语言")
            if request.word_timestamps and not manifest.supports_word_timestamps:
                raise TranscriptionError("TRANSCRIPTION_NOT_READY", "转录结果尚未就绪")
            model_detail = state.model_manager.detail(request.model_id)
            if model_detail["status"] != "ready":
                raise ModelError("MODEL_NOT_INSTALLED", "模型尚未安装")
            asset, audio_uri, fingerprint = state.projects.current_source(asset_id)
            if not audio_uri or not fingerprint:
                raise TranscriptionError(
                    "TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效"
                )
            if asset["fingerprint"] != fingerprint or asset["availability"] != "available":
                raise TranscriptionError(
                    "TRANSCRIPTION_INPUT_CHANGED", "素材指纹已变化，转录结果失效"
                )
            existing = state.transcripts.find_ready(
                asset_id,
                fingerprint,
                request.model_id,
                manifest.revision,
                request.word_timestamps,
            )
            if existing:
                latest = state.jobs.latest_transcription(
                    asset_id, fingerprint, request.model_id, manifest.revision
                )
                if latest is None:
                    latest = state.jobs.create_transcription(
                        asset_id,
                        request.model_id,
                        manifest.revision,
                        fingerprint,
                        audio_uri,
                        request.language,
                        request.word_timestamps,
                        asset["project_id"],
                    )
                    with state.db.connection() as db:
                        db.execute(
                            "UPDATE jobs SET status='succeeded',stage='completed',progress=1,"
                            "finished_at=?,updated_at=?,result_json=? WHERE id=?",
                            (
                                utc_now(),
                                utc_now(),
                                json_dumps({"transcript_id": existing["transcript_id"]}),
                                latest["job_id"],
                            ),
                        )
                    latest = state.jobs.get(latest["job_id"])
                return {"job": latest, "transcript": existing}
            job = state.jobs.create_transcription(
                asset_id,
                request.model_id,
                manifest.revision,
                fingerprint,
                audio_uri,
                request.language,
                request.word_timestamps,
                asset["project_id"],
            )
            return {"job": job, "transcript": None}
        except ModelError as exc:
            model = (
                state.model_manager.detail(request.model_id)
                if exc.code == "MODEL_NOT_INSTALLED"
                else None
            )
            raise _model_error(exc, model) from exc
        except (DomainError, TranscriptionError) as exc:
            if isinstance(exc, DomainError):
                raise _transcription_error(TranscriptionError(exc.code, exc.message)) from exc
            raise _transcription_error(exc) from exc

    @app.get("/api/v1/assets/{asset_id}/transcription")
    async def list_transcriptions(
        asset_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        if limit < 1 or limit > 100:
            raise _error("CONFLICT", "操作冲突，请刷新后重试", 400)
        try:
            asset_dto, source_uri, fingerprint = state.projects.current_source(asset_id)
            items, next_cursor = state.transcripts.list_for_asset(
                asset_id, fingerprint, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _transcription_error(TranscriptionError(exc.code, exc.message)) from exc
        except TranscriptionError as exc:
            raise _transcription_error(exc) from exc

    @app.delete("/api/v1/transcriptions/{transcript_id}", status_code=204)
    async def delete_transcription(
        transcript_id: str, _: CoreState = Depends(require_ui)
    ) -> None:
        """删除一条转录（含片段/词级数据）。

        仍被时间线字幕引用时拒绝（TRANSCRIPTION_IN_USE），避免让字幕永久
        失去来源片段。"""
        try:
            state.transcripts.delete(transcript_id)
        except TranscriptionError as exc:
            raise _transcription_error(exc) from exc

    @app.get("/api/v1/transcriptions/{transcript_id}")
    async def get_transcription(
        transcript_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        transcript = state.transcripts.get(transcript_id)
        if not transcript:
            raise _error("TRANSCRIPTION_NOT_READY", "转录结果尚未就绪", 404)
        try:
            state.projects.current_source(transcript["asset_id"])
        except DomainError:
            pass
        return state.transcripts.get(transcript_id) or transcript

    async def create_job(
        request: JobRequest,
        kind: str,
        start_us: int = 0,
        duration_us: int | None = None,
        layout: str = "blurred_background",
    ) -> dict[str, Any]:
        media = media_for(request.media_id)
        probe_data = json_loads(media["probe_json"])
        start_us = request.start_us if kind == "proxy" else start_us
        duration_us = (request.duration_us if kind == "proxy" else duration_us) or max(
            1, int(probe_data["duration_us"]) - start_us
        )
        if start_us + duration_us > probe_data["duration_us"]:
            raise _error("VALIDATION_ERROR", "请求参数不合法", 400)
        data = {
            "path": media["path"],
            "size_bytes": media["size_bytes"],
            "modified_at": int(media["modified_at"]),
        }
        if request.project_id is not None and not state.projects.get_project(request.project_id):
            raise _error("PROJECT_NOT_FOUND", "项目不存在", 404)
        project_id = project_id_for_media(media["path"], request.project_id)
        if project_id is None:
            project_id = request.project_id
        try:
            return state.jobs.create(
                kind,
                request.media_id,
                data,
                request.encoder_mode,
                start_us,
                duration_us,
                layout,
                project_id=project_id,
            )
        except ValueError as exc:
            raise _error(str(exc), "操作失败", 400) from exc

    @app.post("/api/v1/jobs/proxy")
    async def proxy(request: JobRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        return await create_job(request, "proxy", request.start_us, request.duration_us)

    @app.post("/api/v1/jobs/vertical-sample")
    async def vertical(
        request: VerticalRequest, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        return await create_job(
            request, "vertical_sample", request.start_us, request.duration_us, request.layout
        )

    @app.get("/api/v1/projects/{project_id}/jobs")
    async def project_jobs(
        project_id: str,
        status: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        if not state.projects.get_project(project_id):
            raise _error("PROJECT_NOT_FOUND", "项目不存在", 404)
        try:
            items = state.jobs.list(project_id, status, limit, cursor)
        except ValueError as exc:
            raise _error(str(exc), "操作失败", 400) from exc
        next_cursor = str(int(cursor or 0) + len(items)) if len(items) == limit else None
        return {"items": items, "next_cursor": next_cursor}

    @app.get("/api/v1/projects/{project_id}/shot-list")
    async def get_shot_list(project_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            return state.shot_requirements.get_state(project_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/shot-list/revisions")
    async def list_shot_list_revisions(
        project_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirements.list_revisions(project_id, limit, cursor)
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-list-revisions/{revision_id}")
    async def get_shot_list_revision(
        revision_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirements.get_revision(revision_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/shot-list/revisions")
    async def create_shot_list_revision(
        project_id: str,
        request: ShotListRevisionCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirements.create_revision(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/shot-list/confirm")
    async def confirm_shot_list_revision(
        project_id: str,
        request: ShotListConfirmRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirements.confirm(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment")
    async def get_shot_requirement_image_fulfillment(
        project_id: str, requirement_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_image_fulfillment.get(project_id, requirement_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/links"
    )
    async def list_shot_requirement_image_fulfillment_links(
        project_id: str,
        requirement_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirement_image_fulfillment.list_links(
                project_id, requirement_id, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adoptions"
    )
    async def list_shot_requirement_image_fulfillment_adoptions(
        project_id: str,
        requirement_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirement_image_fulfillment.list_adoptions(
                project_id, requirement_id, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/prepare"
    )
    async def prepare_shot_requirement_image_fulfillment(
        project_id: str,
        requirement_id: str,
        request: ShotRequirementImageFulfillmentPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_image_fulfillment.prepare(
                project_id,
                requirement_id,
                request.expected_confirmed_revision_id,
                request.provider_config_id,
                request.prompt,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/create"
    )
    async def create_shot_requirement_image_fulfillment(
        project_id: str,
        requirement_id: str,
        request: ShotRequirementImageFulfillmentCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_image_fulfillment.create(
                project_id,
                requirement_id,
                request.preview_id,
                request.fulfillment_payload_sha256,
                request.expected_confirmed_revision_id,
                request.confirmed,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adopt"
    )
    async def adopt_shot_requirement_image_fulfillment(
        project_id: str,
        requirement_id: str,
        request: ShotRequirementImageAdoptRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_image_fulfillment.adopt(
                project_id, requirement_id, request.model_dump()
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies/prepare"
    )
    async def prepare_shot_requirement_timeline_assembly(
        project_id: str,
        requirement_id: str,
        request: ShotRequirementTimelineAssemblyPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_assembly.prepare(
                project_id, requirement_id, request.model_dump()
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies"
    )
    async def apply_shot_requirement_timeline_assembly(
        project_id: str,
        requirement_id: str,
        request: ShotRequirementTimelineAssemblyApplyRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_assembly.apply(
                project_id, requirement_id, request.model_dump()
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-requirement-timeline-assembly-previews/{preview_id}")
    async def get_shot_requirement_timeline_assembly_preview(
        preview_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_assembly.get_preview(preview_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-requirement-timeline-assemblies/{assembly_id}")
    async def get_shot_requirement_timeline_assembly(
        assembly_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_assembly.get_assembly(assembly_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies")
    async def list_shot_requirement_timeline_assemblies(
        project_id: str,
        requirement_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirement_timeline_assembly.list(
                project_id, requirement_id, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies/prepare"
    )
    async def prepare_shot_requirement_timeline_batch_assembly(
        project_id: str,
        request: ShotRequirementTimelineBatchAssemblyPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_batch_assembly.prepare(
                project_id, request.model_dump()
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post(
        "/api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies"
    )
    async def apply_shot_requirement_timeline_batch_assembly(
        project_id: str,
        request: ShotRequirementTimelineBatchAssemblyApplyRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_batch_assembly.apply(
                project_id, request.model_dump()
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-requirement-timeline-batch-assembly-previews/{preview_id}")
    async def get_shot_requirement_timeline_batch_assembly_preview(
        preview_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_batch_assembly.get_preview(preview_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}")
    async def get_shot_requirement_timeline_batch_assembly(
        batch_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.shot_requirement_timeline_batch_assembly.get_batch(batch_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies")
    async def list_shot_requirement_timeline_batch_assemblies(
        project_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirement_timeline_batch_assembly.list(
                project_id, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}/items")
    async def list_shot_requirement_timeline_batch_assembly_items(
        batch_id: str,
        limit: int = 20,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items, next_cursor = state.shot_requirement_timeline_batch_assembly.list_items(
                batch_id, limit, cursor
            )
            return {"items": items, "next_cursor": next_cursor}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/image-provider-configs")
    async def list_image_provider_configs(
        project_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return {"items": state.image_provider_configs.list(project_id)}
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/image-provider-configs")
    async def create_image_provider_config(
        project_id: str,
        request: ImageProviderConfigCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.image_provider_configs.create(project_id, request.model_dump())
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.put("/api/v1/internal/image-provider-configs/{provider_config_id}/secret")
    async def set_image_provider_secret(
        provider_config_id: str,
        request: ImageProviderSecretRequest,
        _: CoreState = Depends(require_admin),
    ) -> dict[str, Any]:
        try:
            return state.image_provider_configs.set_secret(provider_config_id, request.secret)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.delete("/api/v1/internal/image-provider-configs/{provider_config_id}/secret")
    async def delete_image_provider_secret(
        provider_config_id: str, _: CoreState = Depends(require_admin)
    ) -> dict[str, Any]:
        try:
            state.image_provider_configs.delete_secret(provider_config_id)
            return {
                "provider_config_id": provider_config_id,
                "credential_status": "missing",
            }
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/provider-image-generations/prepare")
    async def prepare_provider_image_generation(
        project_id: str,
        request: ProviderImageGenerationPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.prepare(
                project_id, request.provider_config_id, request.prompt, request.size
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/provider-image-generations")
    async def create_provider_image_generation(
        project_id: str,
        request: ProviderImageGenerationCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.create(
                project_id, request.preview_id, request.payload_sha256, request.confirmed
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/provider-image-generations")
    async def list_provider_image_generations(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.provider_image_generation.list(project_id, limit, cursor)
            offset = int(cursor or 0)
        except (DomainError, ValueError) as exc:
            if isinstance(exc, DomainError):
                raise _domain(exc) from exc
            raise _error("GENERATION_REQUEST_INVALID", "分页参数无效", 400) from exc
        next_cursor = str(offset + len(items)) if len(items) == limit else None
        return {"items": items, "next_cursor": next_cursor}

    @app.get("/api/v1/provider-image-generations/{request_id}")
    async def get_provider_image_generation(
        request_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.get(request_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/provider-image-generations/{request_id}/tasks")
    async def list_provider_image_generation_tasks(
        request_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.provider_image_generation.list_tasks(request_id, limit, cursor)
            offset = int(cursor or 0)
        except (DomainError, ValueError) as exc:
            if isinstance(exc, DomainError):
                raise _domain(exc) from exc
            raise _error("GENERATION_REQUEST_INVALID", "分页参数无效", 400) from exc
        next_cursor = str(offset + len(items)) if len(items) == limit else None
        return {"items": items, "next_cursor": next_cursor}

    @app.post("/api/v1/provider-image-generation-tasks/{task_id}/retry/prepare")
    async def prepare_provider_image_generation_retry(
        task_id: str,
        request: ProviderImageGenerationRetryPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.prepare_retry(task_id, request.prompt)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/provider-image-generation-tasks/{task_id}/retry")
    async def retry_provider_image_generation(
        task_id: str,
        request: ProviderImageGenerationRetryRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.retry(
                task_id, request.preview_id, request.payload_sha256, request.confirmed
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/provider-image-generation-tasks/{task_id}/cancel")
    async def cancel_provider_image_generation(
        task_id: str,
        _: ProviderImageGenerationEmptyRequest,
        __: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.provider_image_generation.cancel(task_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/media-generation-requests/prepare")
    async def prepare_media_generation_request(
        project_id: str,
        request: MediaGenerationPrepareRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.media_generation.prepare(
                project_id,
                request.generation_kind,
                request.prompt,
                request.input_refs,
                request.parameters,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/projects/{project_id}/media-generation-requests")
    async def create_media_generation_request(
        project_id: str,
        request: MediaGenerationCreateRequest,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.media_generation.create(
                project_id,
                request.generation_kind,
                request.prompt,
                request.input_refs,
                request.parameters,
                request.request_sha256,
            )
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/projects/{project_id}/media-generation-requests")
    async def list_media_generation_requests(
        project_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.media_generation.list(project_id, limit, cursor)
        except DomainError as exc:
            raise _domain(exc) from exc
        next_cursor = str(int(cursor or 0) + len(items)) if len(items) == limit else None
        return {"items": items, "next_cursor": next_cursor}

    @app.get("/api/v1/media-generation-requests/{request_id}")
    async def get_media_generation_request(
        request_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return state.media_generation.get(request_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/media-generation-requests/{request_id}/tasks")
    async def list_media_generation_tasks(
        request_id: str,
        limit: int = 50,
        cursor: str | None = None,
        _: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            items = state.media_generation.list_tasks(request_id, limit, cursor)
        except DomainError as exc:
            raise _domain(exc) from exc
        next_cursor = str(int(cursor or 0) + len(items)) if len(items) == limit else None
        return {"items": items, "next_cursor": next_cursor}

    @app.post("/api/v1/media-generation-tasks/{task_id}/retry")
    async def retry_media_generation_task(
        task_id: str,
        _: MediaGenerationEmptyRequest,
        __: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.media_generation.retry(task_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.post("/api/v1/media-generation-tasks/{task_id}/cancel")
    async def cancel_media_generation_task(
        task_id: str,
        _: MediaGenerationEmptyRequest,
        __: CoreState = Depends(require_ui),
    ) -> dict[str, Any]:
        try:
            return state.media_generation.cancel(task_id)
        except DomainError as exc:
            raise _domain(exc) from exc

    @app.get("/api/v1/jobs")
    async def jobs(_: CoreState = Depends(require_ui)) -> list[dict[str, Any]]:
        return state.jobs.list()

    @app.get("/api/v1/jobs/{job_id}")
    async def job(job_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = state.jobs.get(job_id)
        if not result:
            raise _error("JOB_NOT_FOUND", "任务不存在", 404)
        return result

    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def cancel(job_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            result = await state.jobs.cancel(job_id)
        except ValueError as exc:
            raise _error(str(exc), "操作失败", 409) from exc
        if not result:
            raise _error("JOB_NOT_FOUND", "任务不存在", 404)
        return result

    @app.delete("/api/v1/jobs/{job_id}", status_code=204)
    async def delete_job(job_id: str, _: CoreState = Depends(require_ui)) -> None:
        """移除一条已结束的任务记录（历史清理）。

        运行中/排队中拒绝（JOB_INVALID_STATE）；被渲染产物或生成任务引用时
        拒绝（JOB_REFERENCED）。"""
        try:
            state.jobs.delete_finished(job_id)
        except ValueError as exc:
            code = str(exc)
            status = 404 if code == "JOB_NOT_FOUND" else 409
            message = (
                "任务不存在"
                if code == "JOB_NOT_FOUND"
                else "任务仍在进行中，请先取消后再删除"
                if code == "JOB_INVALID_STATE"
                else "任务被渲染产物或生成记录引用，无法删除"
            )
            raise _error(code, message, status) from exc

    @app.post("/api/v1/jobs/{job_id}/retry")
    async def retry(job_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        try:
            result = state.jobs.retry(job_id)
        except ValueError as exc:
            raise _error(str(exc), "操作失败", 409) from exc
        if not result:
            raise _error("JOB_NOT_FOUND", "任务不存在", 404)
        return result

    @app.websocket("/api/v1/events")
    async def events(socket: WebSocket) -> None:
        await socket.accept()
        try:
            message = await asyncio.wait_for(socket.receive_json(), timeout=3)
            if message.get("type") != "authenticate" or not state.auth.is_ui(message.get("token")):
                await socket.close(code=1008)
                return
            state.connections.add(socket)
            await socket.send_json(
                {
                    "event_id": new_id(),
                    "occurred_at": utc_now(),
                    "type": "system.ready",
                    "payload": {"protocol_version": PROTOCOL_VERSION},
                }
            )
            while True:
                await socket.receive_text()
        except (TimeoutError, WebSocketDisconnect):
            state.connections.discard(socket)
        except Exception:
            state.connections.discard(socket)

    return app
