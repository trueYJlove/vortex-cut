from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

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
from .model_registry import ModelError, ModelManager, ModelRegistry
from .planning import PlanningService, ProviderRepository, RecipeRegistry
from .projects import DomainError, ProjectAssetService
from .providers import ProviderError, ProviderSecretVault
from .rendering.ass import CaptionResources
from .rendering.plan import RenderPlanCompiler
from .rendering.service import (
    DestinationGrantStore,
    RenderCoordinator,
    RenderService,
)
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


class ExportCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    timeline_revision_id: str | None = None
    destination_grant_id: str
    encoder_mode: str = "auto"


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
        self.destinations = DestinationGrantStore()
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
        )
        self.renders = RenderService(
            self.db,
            settings.ffmpeg,
            self.encoders,
            self.render_compiler,
            self.jobs,
            self.destinations,
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
            "PROJECT_ARCHIVED",
            "CONFLICT",
            "TIMELINE_ALREADY_EXISTS",
            "TIMELINE_CONFLICT",
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
        }
        else 400
    )
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
            state.db.initialize()
        except MigrationError:
            raise
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
        return {
            "items": [
                provider_public(item)
                for item in state.providers.list()
            ]
        }

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
                _domain(exc)
                if isinstance(exc, DomainError)
                else _error(exc.code, exc.message, 503)
            )

    @app.post("/api/v1/providers/{provider_config_id}/candidate-planning-capability-test")
    async def test_candidate_provider_capability(
        provider_config_id: str, _: CoreState = Depends(require_ui)
    ) -> dict[str, Any]:
        try:
            return await state.planning.test_candidate_provider_capability(provider_config_id)
        except (DomainError, ProviderError) as exc:
            raise (
                _domain(exc)
                if isinstance(exc, DomainError)
                else _error(exc.code, exc.message, 503)
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
                project_id, request.timeline_revision_id, request.encoder_mode
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
        result = await state.jobs.cancel(job_id)
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
