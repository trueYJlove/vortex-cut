from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import PROTOCOL_VERSION, __version__
from .asr_jobs import AsrCoordinator
from .auth import AuthStore
from .config import Settings
from .database import Database, MigrationError, json_dumps, json_loads, utc_now
from .ids import new_id
from .jobs import JobService
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe
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


class ProjectCreateRequest(BaseModel):
    name: str
    root_dir_name: str | None = None


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


class TimelineRevisionDiffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    base_revision_id: str
    target_revision_id: str


class DestinationGrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    path: str
    overwrite_authorized: bool


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
        self.encoders = EncoderDetector(settings.ffmpeg)
        self.model_registry = ModelRegistry(settings.manifest_dir)
        self.model_manager = ModelManager(self.db, settings.data_dir, self.model_registry)
        self.transcripts = TranscriptRepository(self.db)
        self.timelines = TimelineService(self.db)
        self.provider_secrets = ProviderSecretVault()
        self.providers = ProviderRepository(self.db, self.provider_secrets)
        self.recipes = RecipeRegistry(settings.recipe_dir)
        self.planning = PlanningService(
            self.db, self.recipes, self.providers, self.provider_secrets, self.timelines
        )
        self.timeline_patch_planning = TimelinePatchPlanningService(
            self.db, self.providers, self.provider_secrets, self.timelines
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

        async def probe_asset(path: Path, **kwargs: Any) -> dict[str, Any]:
            return await self.ffprobe.probe(path, **kwargs)

        self.projects = ProjectAssetService(
            self.db,
            settings.data_dir,
            probe_asset,
            transcript_stale=self.transcripts.mark_asset_stale,
            purge_asset_clips=self.timelines.purge_asset_clips,
        )
        self.image_provider_secrets = ProviderSecretVault()
        self.image_provider_configs = ImageProviderConfigService(
            self.db, self.image_provider_secrets
        )
        image_provider = (
            ApiKeyFunImagesProvider() if settings.image_provider_network_enabled else None
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
            render_runner=self.render_coordinator.run,
            planning_runner=self.planning.run_generation,
            timeline_patch_runner=self.timeline_patch_planning.run_generation,
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
        if exc.code == "ASSET_NOT_FOUND"
        else 409
        if exc.code
        in {
            "TRANSCRIPTION_INPUT_CHANGED",
            "TRANSCRIPTION_NOT_READY",
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
            "PROJECT_ARCHIVED",
            "CONFLICT",
            "TIMELINE_ALREADY_EXISTS",
            "TIMELINE_CONFLICT",
            "PREVIEW_IR_UNSUPPORTED",
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
    }:
        status = 422
    if exc.code in {
        "PROJECT_NOT_FOUND",
        "ASSET_NOT_FOUND",
        "GRANT_NOT_FOUND",
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
        yield
        await state.jobs.stop()
        state.auth.clear()

    app = FastAPI(title="AIVideo Core", version=__version__, lifespan=lifespan)
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
            return state.projects.resolve_asset_path(asset_id)
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
            return state.projects.create_project(request.name, request.root_dir_name)
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
        if output_ratio != "169":
            raise _error("PREVIEW_IR_RATIO_UNSUPPORTED", "合成预览当前仅支持 16:9 画布", 400)
        try:
            return await state.render_coordinator.preview_ir(project_id, timeline_revision_id, output_ratio)
        except DomainError as exc:
            raise _domain(exc) from exc

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
