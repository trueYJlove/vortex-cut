from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import PROTOCOL_VERSION, __version__
from .auth import AuthStore
from .config import Settings
from .database import Database, MigrationError, json_dumps, json_loads, utc_now
from .ids import new_id
from .jobs import JobService
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe
from .projects import DomainError, ProjectAssetService


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


class JobRequest(BaseModel):
    media_id: str
    project_id: str | None = None
    encoder_mode: str = "auto"
    start_us: int = Field(default=0, ge=0)
    duration_us: int | None = Field(default=None, gt=0, le=30_000_000)


class VerticalRequest(JobRequest):
    duration_us: int = Field(default=10_000_000, gt=0, le=30_000_000)
    layout: str = "blurred_background"


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
        self.jobs = JobService(
            self.db, settings.data_dir, settings.ffmpeg, self.ffprobe, self.encoders, self.emit
        )

        async def probe_asset(path: Path, **kwargs: Any) -> dict[str, Any]:
            return await self.ffprobe.probe(path, **kwargs)

        self.projects = ProjectAssetService(self.db, settings.data_dir, probe_asset)

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


def _domain(exc: DomainError) -> HTTPException:
    status = (
        409
        if exc.code
        in {
            "ASSET_DUPLICATE",
            "ASSET_CHANGED",
            "PROJECT_ARCHIVED",
            "CONFLICT",
        }
        else 400
    )
    if exc.code in {"PROJECT_NOT_FOUND", "ASSET_NOT_FOUND", "GRANT_NOT_FOUND", "MEDIA_NOT_FOUND"}:
        status = 404
    return _error(exc.code, exc.message, status)


def _error_payload(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "trace_id": new_id()}}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    state = CoreState(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.prepare()
        try:
            state.db.initialize()
        except MigrationError:
            raise
        state.db.recover_interrupted()
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

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload(
                str(detail.get("code", "INTERNAL_ERROR")), str(detail.get("message", "请求失败"))
            ),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=400, content=_error_payload("VALIDATION_ERROR", "请求参数无效")
        )

    @app.exception_handler(MigrationError)
    async def migration_error(_: Request, __: MigrationError) -> JSONResponse:
        return JSONResponse(
            status_code=409, content=_error_payload("MIGRATION_FAILED", "数据库迁移失败")
        )

    def require_admin(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_admin(state.bearer(authorization)):
            raise _error("UNAUTHORIZED", "需要管理权限", 401)
        return state

    def require_ui(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_ui(state.bearer(authorization)):
            raise _error("UNAUTHORIZED", "需要界面会话权限", 401)
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
            raise _error("MEDIA_UNSUPPORTED", "必须选择普通文件", 400)
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
        with state.db.connection() as db:
            row = db.execute("SELECT path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            raise _error("NOT_FOUND", "产物不存在", 404)
        return {"artifact_id": artifact_id, "path": row[0]}

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
            raise _error("MEDIA_NOT_FOUND", "媒体不存在", 404)
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
            raise _error(str(exc), "无法读取媒体文件", 400) from exc
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
            raise _error("VALIDATION_ERROR", "必须提供 name", 400)
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
            raise _error("VALIDATION_ERROR", "任务区间超出媒体时长", 400)
        data = {
            "path": media["path"],
            "size_bytes": media["size_bytes"],
            "modified_at": int(media["modified_at"]),
        }
        if request.project_id is not None and not state.projects.get_project(request.project_id):
            raise _error("PROJECT_NOT_FOUND", "Project not found", 404)
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
            raise _error(str(exc), "任务参数不受支持", 400) from exc

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
            raise _error(str(exc), "浠诲姟鍒楄〃鍙傛暟鏃犳晥", 400) from exc
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
