from __future__ import annotations

import asyncio
import os
import platform
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from . import PROTOCOL_VERSION, __version__
from .auth import AuthStore
from .config import Settings
from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .jobs import JobService
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe


class SessionResponse(BaseModel):
    token: str
    expires_with_process: bool = True
    scopes: list[str]


class FileGrantRequest(BaseModel):
    path: str


class ProbeRequest(BaseModel):
    grant_id: str


class JobRequest(BaseModel):
    media_id: str
    encoder_mode: str = "auto"


class VerticalRequest(JobRequest):
    start_us: int = Field(default=0, ge=0)
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
        self.jobs = JobService(self.db, settings.data_dir, settings.ffmpeg, self.ffprobe, self.encoders, self.emit)

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

    def bearer(self, authorization: str | None) -> str | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        return authorization[7:]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    state = CoreState(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        settings.prepare(); state.db.initialize(); state.db.recover_interrupted(); await state.jobs.start()
        yield
        await state.jobs.stop(); state.auth.clear()

    app = FastAPI(title="AIVideo Core", version=__version__, lifespan=lifespan)
    app.state.core = state

    def require_admin(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_admin(state.bearer(authorization)):
            raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "需要管理权限"})
        return state

    def require_ui(authorization: str | None = Header(default=None)) -> CoreState:
        if not state.auth.is_ui(state.bearer(authorization)):
            raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "需要界面会话权限"})
        return state

    @app.get("/api/v1/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "protocol_version": PROTOCOL_VERSION, "build_version": __version__,
                "database": "ok", "scheduler": "ok"}

    @app.get("/api/v1/internal/health")
    async def internal_health(_: CoreState = Depends(require_admin)) -> dict[str, Any]:
        return {"status": "ok", "protocol_version": PROTOCOL_VERSION, "build_version": __version__}

    @app.post("/api/v1/internal/sessions", response_model=SessionResponse)
    async def create_session(_: CoreState = Depends(require_admin)) -> SessionResponse:
        return SessionResponse(token=state.auth.create_ui_token(), scopes=["system:read", "media:probe", "jobs:write", "jobs:read"])

    @app.post("/api/v1/internal/file-grants")
    async def create_grant(request: FileGrantRequest, _: CoreState = Depends(require_admin)) -> dict[str, Any]:
        path = Path(request.path).expanduser()
        try: path = path.resolve(strict=True)
        except OSError: raise HTTPException(400, detail={"code": "MEDIA_NOT_FOUND", "message": "媒体文件不存在"})
        if not path.is_file(): raise HTTPException(400, detail={"code": "MEDIA_UNSUPPORTED", "message": "必须选择普通文件"})
        stat = path.stat(); grant_id = new_id()
        modified_at = __import__("datetime").datetime.fromtimestamp(stat.st_mtime, __import__("datetime").timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        state.grants[grant_id] = {"path": str(path), "display_name": path.name, "size_bytes": stat.st_size,
                                  "modified_at": modified_at, "modified_at_ns": stat.st_mtime_ns}
        return {key: value for key, value in state.grants[grant_id].items() if key != "path" and key != "modified_at_ns"} | {"grant_id": grant_id}

    @app.get("/api/v1/internal/artifacts/{artifact_id}/resolve")
    async def resolve_artifact(artifact_id: str, _: CoreState = Depends(require_admin)) -> dict[str, str]:
        with state.db.connection() as db: row = db.execute("SELECT path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row: raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "产物不存在"})
        return {"artifact_id": artifact_id, "path": row[0]}

    @app.post("/api/v1/internal/shutdown")
    async def shutdown(_: CoreState = Depends(require_admin)) -> dict[str, str]:
        state.shutdown_event.set(); return {"status": "shutting_down"}

    @app.get("/api/v1/system/capabilities")
    async def capabilities(_: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = await state.encoders.capabilities()
        usage = shutil.disk_usage(state.settings.data_dir)
        return {"platform": platform.platform(), "cpu_count": os.cpu_count(), "ffmpeg": str(state.settings.ffmpeg),
                "ffprobe": str(state.settings.ffprobe), "free_bytes": usage.free, **result}

    def grant_for(grant_id: str) -> dict[str, Any]:
        grant = state.grants.get(grant_id)
        if not grant: raise HTTPException(404, detail={"code": "GRANT_NOT_FOUND", "message": "文件授权已失效"})
        return grant

    def media_for(media_id: str) -> dict[str, Any]:
        with state.db.connection() as db: row = db.execute("SELECT * FROM media_inputs WHERE id=?", (media_id,)).fetchone()
        if not row: raise HTTPException(404, detail={"code": "MEDIA_NOT_FOUND", "message": "媒体不存在"})
        return dict(row)

    @app.post("/api/v1/media/probe")
    async def probe(request: ProbeRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        grant = grant_for(request.grant_id)
        try: result = await state.ffprobe.probe(Path(grant["path"]))
        except RuntimeError as exc: raise HTTPException(400, detail={"code": str(exc), "message": "无法读取该媒体文件"}) from exc
        media_id = new_id(); now = utc_now()
        with state.db.connection() as db:
            db.execute("INSERT INTO media_inputs VALUES (?,?,?,?,?,?,?)", (media_id,grant["path"],grant["display_name"],grant["size_bytes"],str(grant["modified_at_ns"]),json_dumps(result),now))
        return {"media_id": media_id, **result}

    async def create_job(request: JobRequest, kind: str, start_us: int = 0, duration_us: int = 10_000_000, layout: str = "blurred_background") -> dict[str, Any]:
        media = media_for(request.media_id); probe_data = json_loads(media["probe_json"])
        if start_us + duration_us > probe_data["duration_us"]: raise HTTPException(400, detail={"code": "MEDIA_RANGE_INVALID", "message": "任务区间超出媒体时长"})
        data = {"path": media["path"], "size_bytes": media["size_bytes"], "modified_at": int(media["modified_at"])}
        try: return state.jobs.create(kind, request.media_id, data, request.encoder_mode, start_us, duration_us, layout)
        except ValueError as exc: raise HTTPException(400, detail={"code": str(exc), "message": "样片布局不受支持"}) from exc

    @app.post("/api/v1/jobs/proxy")
    async def proxy(request: JobRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]: return await create_job(request, "proxy")

    @app.post("/api/v1/jobs/vertical-sample")
    async def vertical(request: VerticalRequest, _: CoreState = Depends(require_ui)) -> dict[str, Any]: return await create_job(request, "vertical_sample", request.start_us, request.duration_us, request.layout)

    @app.get("/api/v1/jobs")
    async def jobs(_: CoreState = Depends(require_ui)) -> list[dict[str, Any]]: return state.jobs.list()

    @app.get("/api/v1/jobs/{job_id}")
    async def job(job_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = state.jobs.get(job_id)
        if not result: raise HTTPException(404, detail={"code": "JOB_NOT_FOUND", "message": "任务不存在"})
        return result

    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def cancel(job_id: str, _: CoreState = Depends(require_ui)) -> dict[str, Any]:
        result = await state.jobs.cancel(job_id)
        if not result: raise HTTPException(404, detail={"code": "JOB_NOT_FOUND", "message": "任务不存在"})
        return result

    @app.websocket("/api/v1/events")
    async def events(socket: WebSocket) -> None:
        await socket.accept()
        try:
            message = await asyncio.wait_for(socket.receive_json(), timeout=3)
            if message.get("type") != "authenticate" or not state.auth.is_ui(message.get("token")):
                await socket.close(code=1008); return
            state.connections.add(socket)
            await socket.send_json({"event_id": new_id(), "occurred_at": utc_now(), "type": "system.ready", "payload": {"protocol_version": PROTOCOL_VERSION}})
            while True: await socket.receive_text()
        except (TimeoutError, WebSocketDisconnect):
            state.connections.discard(socket)
        except Exception:
            state.connections.discard(socket)

    return app
