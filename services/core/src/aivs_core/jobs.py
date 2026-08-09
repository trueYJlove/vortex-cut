from __future__ import annotations

import asyncio
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe
from .media.render import build_render_args, render_media
from .state import transition_sql


class JobService:
    def __init__(
        self,
        db: Database,
        data_dir: Path,
        ffmpeg: Path,
        ffprobe: FFprobe,
        encoders: EncoderDetector,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        self.db = db
        self.data_dir = data_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoders = encoders
        self.emit = emit
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.cancel_events: dict[str, asyncio.Event] = {}
        self.worker: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self.worker = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        for event in self.cancel_events.values():
            event.set()
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    def create(
        self,
        kind: str,
        media_id: str,
        input_data: dict[str, Any],
        encoder: str,
        start_us: int = 0,
        duration_us: int = 10_000_000,
        layout: str = "blurred_background",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        if kind == "vertical_sample" and layout != "blurred_background":
            raise ValueError("LAYOUT_UNSUPPORTED")
        job_id = new_id()
        now = utc_now()
        payload = {
            "media_id": media_id,
            "path": input_data["path"],
            "size_bytes": input_data["size_bytes"],
            "modified_at": input_data["modified_at"],
            "start_us": start_us,
            "duration_us": duration_us,
            "layout": layout,
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,kind,type,status,stage,progress,input_json,"
                "encoder_requested,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    kind,
                    kind,
                    "queued",
                    "queued",
                    0,
                    json_dumps(payload),
                    encoder,
                    1,
                    now,
                    now,
                ),
            )
        return self.get(job_id) or {"job_id": job_id, "status": "queued", "created_at": now}

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            artifacts = db.execute(
                "SELECT id,kind,size_bytes,sha256,media_info_json,created_at "
                "FROM artifacts WHERE job_id=?",
                (job_id,),
            ).fetchall()
        result = dict(row)
        result["job_id"] = result.pop("id")
        result["kind"] = result.get("kind") or result.get("type")
        result.pop("type", None)
        result["input"] = json_loads(result.pop("input_json"))
        result["input"].pop("path", None)
        result["artifacts"] = [dict(artifact) for artifact in artifacts]
        for artifact in result["artifacts"]:
            artifact["media_info"] = json_loads(artifact.pop("media_info_json"))
        if result.get("error_code"):
            result["error"] = {
                "code": result.pop("error_code"),
                "message": result.pop("error_message"),
            }
        else:
            result.pop("error_code", None)
            result.pop("error_message", None)
            result["error"] = None
        result.pop("cancel_requested", None)
        result.pop("encoder_requested", None)
        result["encoder"] = result.pop("encoder_used", None)
        result.pop("fallback_reason", None)
        result.pop("worker_pid", None)
        result["stage"] = result.get("stage") or result["status"]
        result["attempt"] = int(result.get("attempt") or 1)
        result["progress"] = float(result["progress"])
        return result

    def list(
        self,
        project_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> list[dict[str, Any]]:
        try:
            offset = int(cursor or 0)
        except ValueError as exc:
            raise ValueError("VALIDATION_ERROR") from exc
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError("VALIDATION_ERROR")
        where: list[str] = []
        values: list[Any] = []
        if project_id is not None:
            where.append("project_id=?")
            values.append(project_id)
        if status is not None:
            where.append("status=?")
            values.append(status)
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        values.extend([limit, offset])
        with self.db.connection() as db:
            ids = [
                row[0]
                for row in db.execute(
                    f"SELECT id FROM jobs{clause} ORDER BY created_at DESC LIMIT ? OFFSET ?", values
                )
            ]
        return [job for job_id in ids if (job := self.get(job_id)) is not None]

    async def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        status = row[0]
        if status == "queued":
            now = utc_now()
            self._transition_job(job_id, status, "cancelled", finished_at=now)
        elif status == "running":
            self._transition_job(job_id, status, "cancelling", cancel_requested=1)
            self.cancel_events.setdefault(job_id, asyncio.Event()).set()
        elif status == "cancelling":
            self.cancel_events.setdefault(job_id, asyncio.Event()).set()
        result = self.get(job_id)
        await self._emit_update(result)
        return result

    async def _loop(self) -> None:
        while True:
            if not self.tasks:
                with self.db.connection() as db:
                    row = db.execute(
                        "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
                    ).fetchone()
                if row:
                    job_id = row[0]
                    task = asyncio.create_task(self._run(job_id))
                    self.tasks[job_id] = task
                    task.add_done_callback(
                        lambda _, current_id=job_id: self.tasks.pop(current_id, None)
                    )
            await asyncio.sleep(0.05)

    async def _emit_update(self, job: dict[str, Any] | None) -> None:
        if job:
            await self.emit(
                {
                    "type": "job.updated",
                    "payload": {
                        "job_id": job["job_id"],
                        "status": job["status"],
                        "progress": job["progress"],
                    },
                }
            )

    def _transition_job(self, job_id: str, current: str, target: str, **fields: Any) -> None:
        status = transition_sql(current, target)
        assignments = ["status=?"]
        values: list[Any] = [status]
        for key, value in fields.items():
            assignments.append(f"{key}=?")
            values.append(value)
        assignments.append("updated_at=?")
        values.append(utc_now())
        values.append(job_id)
        with self.db.connection() as db:
            db.execute(f"UPDATE jobs SET {','.join(assignments)} WHERE id=?", values)

    async def _run(self, job_id: str) -> None:
        now = utc_now()
        with self.db.connection() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        self._transition_job(job_id, row[0], "running", stage="running", started_at=now)
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        await self._emit_update(self.get(job_id))
        if row["kind"] in {"asset_probe", "asset_fingerprint"}:
            self._transition_job(
                job_id,
                "running",
                "succeeded",
                stage="completed",
                progress=1,
                finished_at=utc_now(),
            )
            await self._emit_update(self.get(job_id))
            return
        payload = json_loads(row["input_json"])
        work = self.data_dir / "jobs" / job_id / "work"
        artifacts = self.data_dir / "jobs" / job_id / "artifacts"
        work.mkdir(parents=True, exist_ok=True)
        artifacts.mkdir(parents=True, exist_ok=True)
        try:
            input_path = Path(payload["path"])
            stat = input_path.stat()
            if stat.st_size != payload["size_bytes"] or stat.st_mtime_ns != payload["modified_at"]:
                raise RuntimeError("MEDIA_CHANGED")
            probe = await self.ffprobe.probe(input_path)
            encoder, fallback = await self.encoders.choose(row["encoder_requested"])
            with self.db.connection() as db:
                db.execute(
                    "UPDATE jobs SET encoder_used=?,fallback_reason=?,updated_at=? WHERE id=?",
                    (encoder, fallback, utc_now(), job_id),
                )
            output = work / (
                "vertical-sample.mp4" if row["type"] == "vertical_sample" else "proxy.mp4"
            )
            args = build_render_args(
                input_path,
                output,
                row["kind"],
                encoder,
                payload["start_us"],
                payload["duration_us"],
                bool(probe["audio_streams"]),
            )
            cancel_event = self.cancel_events.setdefault(job_id, asyncio.Event())
            result = await render_media(
                self.ffmpeg,
                self.ffprobe,
                args,
                output,
                payload["duration_us"],
                cancel_event,
                lambda progress: self._set_progress(job_id, progress),
            )
            if cancel_event.is_set():
                raise RuntimeError("JOB_CANCELLED")
            artifact_id = new_id()
            final = artifacts / output.name
            shutil.move(output, final)
            with self.db.connection() as db:
                db.execute(
                    "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
                    (
                        artifact_id,
                        job_id,
                        row["kind"],
                        str(final),
                        result["size_bytes"],
                        result["sha256"],
                        json_dumps(result["media_info"]),
                        utc_now(),
                    ),
                )
            current_status = self._current_status(job_id)
            if current_status != "running":
                raise RuntimeError("JOB_CANCELLED")
            self._transition_job(
                job_id,
                current_status,
                "succeeded",
                stage="completed",
                progress=1,
                finished_at=utc_now(),
                worker_pid=None,
            )
        except RuntimeError as exc:
            code = str(exc).split(":", 1)[0]
            target = "cancelled" if code == "JOB_CANCELLED" else "failed"
            current_status = self._current_status(job_id)
            if current_status in {"running", "cancelling"}:
                if current_status == "cancelling":
                    target = "cancelled" if code == "JOB_CANCELLED" else "interrupted"
                self._transition_job(
                    job_id,
                    current_status,
                    target,
                    stage="failed",
                    error_code=code,
                    error_message=code,
                    finished_at=utc_now(),
                    worker_pid=None,
                )
        except Exception:
            current_status = self._current_status(job_id)
            if current_status in {"running", "cancelling"}:
                target = "interrupted" if current_status == "cancelling" else "failed"
                self._transition_job(
                    job_id,
                    current_status,
                    target,
                    stage="failed",
                    error_code="INTERNAL_ERROR",
                    error_message="任务执行失败",
                    finished_at=utc_now(),
                    worker_pid=None,
                )
        finally:
            self.cancel_events.pop(job_id, None)
            await self._emit_update(self.get(job_id))

    def _set_progress(self, job_id: str, progress: float) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND status='running'",
                (progress, utc_now(), job_id),
            )

    def _current_status(self, job_id: str) -> str | None:
        with self.db.connection() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        return row[0] if row else None
