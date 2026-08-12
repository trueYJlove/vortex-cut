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

AsrRunner = Callable[
    [Any, asyncio.Event, Callable[[float], None], Callable[[str], None]],
    Awaitable[dict[str, Any]],
]
RenderRunner = Callable[
    [
        Any,
        asyncio.Event,
        Callable[[float], None],
        Callable[[str], None],
        Callable[[int | None], None],
    ],
    Awaitable[dict[str, Any]],
]


class JobService:
    def __init__(
        self,
        db: Database,
        data_dir: Path,
        ffmpeg: Path,
        ffprobe: FFprobe,
        encoders: EncoderDetector,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
        asr_runner: AsrRunner | None = None,
        retry_validator: Callable[[Any], None] | None = None,
        render_runner: RenderRunner | None = None,
    ) -> None:
        self.db = db
        self.data_dir = data_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoders = encoders
        self.emit = emit
        self.asr_runner = asr_runner
        self.retry_validator = retry_validator
        self.render_runner = render_runner
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
        # A forced task cancellation can bypass _run's exception handling. Never
        # leave an in-flight job looking successful or runnable after shutdown;
        # the next explicit retry is the only way to resume it.
        self.db.recover_interrupted()

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

    def create_model_download(self, model_id: str, model_revision: str) -> dict[str, Any]:
        return self._create_special(
            kind="model_download",
            input_data={"model_id": model_id},
            model_id=model_id,
            model_revision=model_revision,
        )

    def create_transcription(
        self,
        asset_id: str,
        model_id: str,
        model_revision: str,
        input_fingerprint: str,
        audio_uri: str,
        language: str,
        word_timestamps: bool,
        project_id: str | None,
    ) -> dict[str, Any]:
        return self._create_special(
            kind="transcription",
            input_data={
                "asset_id": asset_id,
                "audio_uri": audio_uri,
                "language": language,
                "word_timestamps": word_timestamps,
            },
            asset_id=asset_id,
            model_id=model_id,
            model_revision=model_revision,
            input_fingerprint=input_fingerprint,
            project_id=project_id,
        )

    def _create_special(
        self,
        kind: str,
        input_data: dict[str, Any],
        asset_id: str | None = None,
        model_id: str | None = None,
        model_revision: str | None = None,
        input_fingerprint: str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        job_id = new_id()
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs (id,project_id,asset_id,kind,type,status,stage,progress,"
                "input_json,model_id,model_revision,input_fingerprint,resource_class,attempt,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    asset_id,
                    kind,
                    kind,
                    "queued",
                    "queued",
                    0,
                    json_dumps(input_data),
                    model_id,
                    model_revision,
                    input_fingerprint,
                    "asr",
                    1,
                    now,
                    now,
                ),
            )
        return self.get(job_id) or {"job_id": job_id, "status": "queued", "created_at": now}

    def create_render(
        self,
        kind: str,
        project_id: str,
        timeline_revision_id: str,
        encoder: str,
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        if kind not in {"authoritative_preview", "final_export"}:
            raise ValueError("RENDER_PLAN_INVALID")
        job_id = new_id()
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                "encoder_requested,encoder_used,fallback_reason,timeline_revision_id,"
                "resource_class,attempt,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    kind,
                    kind,
                    "queued",
                    "queued",
                    0,
                    json_dumps(input_data),
                    encoder,
                    encoder,
                    input_data.get("toolchain", {}).get("fallback_reason"),
                    timeline_revision_id,
                    "render",
                    1,
                    now,
                    now,
                ),
            )
        return self.get(job_id) or {"job_id": job_id, "status": "queued", "created_at": now}

    def delete_queued(self, job_id: str) -> None:
        with self.db.connection() as db:
            db.execute("DELETE FROM jobs WHERE id=? AND status='queued'", (job_id,))

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
        result["input"].pop("audio_uri", None)
        result["input"].pop("destination_path", None)
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
        result["result"] = (
            json_loads(result.pop("result_json")) if result.get("result_json") else None
        )
        result.pop("resource_class", None)
        return result

    def latest_model_download(self, model_id: str, model_revision: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT id FROM jobs WHERE kind='model_download' AND model_id=? "
                "AND model_revision=? ORDER BY created_at DESC LIMIT 1",
                (model_id, model_revision),
            ).fetchone()
        return self.get(row[0]) if row else None

    def latest_transcription(
        self,
        asset_id: str,
        input_fingerprint: str,
        model_id: str,
        model_revision: str,
    ) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT id FROM jobs WHERE kind='transcription' AND asset_id=? "
                "AND input_fingerprint=? AND model_id=? AND model_revision=? "
                "ORDER BY created_at DESC LIMIT 1",
                (asset_id, input_fingerprint, model_id, model_revision),
            ).fetchone()
        return self.get(row[0]) if row else None

    def retry(self, job_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            if row["status"] not in {"interrupted", "failed"}:
                raise ValueError("JOB_INVALID_STATE")
            if self.retry_validator:
                self.retry_validator(row)
            db.execute(
                "UPDATE jobs SET status='queued',stage='queued',progress=0,attempt=?,"
                "error_code=NULL,error_message=NULL,finished_at=NULL,result_json=NULL,"
                "cancel_requested=0,updated_at=? WHERE id=?",
                (int(row["attempt"] or 1) + 1, utc_now(), job_id),
            )
        return self.get(job_id)

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
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row or row["status"] != "queued":
            return
        self._transition_job(job_id, "queued", "running", stage="running", started_at=now)
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        cancel_event = self.cancel_events.setdefault(job_id, asyncio.Event())
        await self._emit_update(self.get(job_id))
        try:
            if row["kind"] in {"model_download", "transcription"}:
                result = await self._run_asr(row, cancel_event, job_id)
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] in {"authoritative_preview", "final_export"}:
                if self.render_runner is None:
                    raise RuntimeError("RENDER_FAILED")
                result = await self.render_runner(
                    row,
                    cancel_event,
                    lambda value: self._set_progress(job_id, value),
                    lambda value: self._set_stage(job_id, value),
                    lambda value: self._set_worker_pid(job_id, value),
                )
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] in {"asset_probe", "asset_fingerprint"}:
                pass
            else:
                await self._run_media(row, job_id, cancel_event)
            current_status = self._current_status(job_id)
            if current_status == "running":
                self._transition_job(
                    job_id,
                    current_status,
                    "succeeded",
                    stage="completed",
                    progress=1,
                    finished_at=utc_now(),
                    worker_pid=None,
                )
        except (RuntimeError, ValueError) as exc:
            code = getattr(exc, "code", None)
            if code is None:
                candidate = str(exc).split(":", 1)[0].strip()
                code = candidate if _is_error_code(candidate) else "INTERNAL_ERROR"
            message = getattr(exc, "message", None) or _job_error_message(code)
            current_status = self._current_status(job_id)
            if current_status in {"running", "cancelling"}:
                target = _error_target(current_status, code)
                self._transition_job(
                    job_id,
                    current_status,
                    target,
                    stage=target,
                    error_code=code,
                    error_message=message,
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
                    stage=target,
                    error_code="INTERNAL_ERROR",
                    error_message="任务执行失败",
                    finished_at=utc_now(),
                    worker_pid=None,
                )
        finally:
            self.cancel_events.pop(job_id, None)
            await self._emit_update(self.get(job_id))

    async def _run_asr(
        self, row: Any, cancel_event: asyncio.Event, job_id: str
    ) -> dict[str, Any]:
        if self.asr_runner is None:
            raise RuntimeError("MODEL_RUNTIME_UNAVAILABLE")
        result = await self.asr_runner(
            row,
            cancel_event,
            lambda value: self._set_progress(job_id, value),
            lambda value: self._set_stage(job_id, value),
        )
        if cancel_event.is_set() or self._current_status(job_id) != "running":
            raise RuntimeError("JOB_CANCELLED")
        return result

    async def _run_media(
        self, row: Any, job_id: str, cancel_event: asyncio.Event
    ) -> None:
        payload = json_loads(row["input_json"])
        work = self.data_dir / "jobs" / job_id / "work"
        artifacts = self.data_dir / "jobs" / job_id / "artifacts"
        work.mkdir(parents=True, exist_ok=True)
        artifacts.mkdir(parents=True, exist_ok=True)
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
        final = artifacts / output.name
        shutil.move(output, final)
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
                (
                    new_id(),
                    job_id,
                    row["kind"],
                    str(final),
                    result["size_bytes"],
                    result["sha256"],
                    json_dumps(result["media_info"]),
                    utc_now(),
                ),
            )
    def _set_progress(self, job_id: str, progress: float) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND status='running'",
                (progress, utc_now(), job_id),
            )

    def _set_stage(self, job_id: str, stage: str) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET stage=?,updated_at=? WHERE id=? AND status='running'",
                (stage, utc_now(), job_id),
            )

    def _set_worker_pid(self, job_id: str, worker_pid: int | None) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET worker_pid=?,updated_at=? WHERE id=? AND status IN "
                "('running','cancelling')",
                (worker_pid, utc_now(), job_id),
            )

    def _current_status(self, job_id: str) -> str | None:
        with self.db.connection() as db:
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        return row[0] if row else None


def _is_error_code(value: str) -> bool:
    return bool(value) and "_" in value and value.isupper() and not any(c.isspace() for c in value)


def _error_target(current_status: str, code: str) -> str:
    cancel_codes = {"JOB_CANCELLED", "MODEL_DOWNLOAD_CANCELLED", "TRANSCRIPTION_CANCELLED"}
    if code in cancel_codes:
        return "cancelled"
    if current_status == "cancelling":
        return "interrupted"
    return "failed"


def _job_error_message(code: str) -> str:
    messages = {
        "MODEL_RUNTIME_UNAVAILABLE": "本地 ASR 运行时不可用",
        "MODEL_DOWNLOAD_FAILED": "模型下载失败",
        "MODEL_HASH_MISMATCH": "模型文件校验失败，请重试下载",
        "MODEL_DISK_SPACE_INSUFFICIENT": "磁盘空间不足，无法安装模型",
        "MODEL_NOT_INSTALLED": "模型尚未安装",
        "TRANSCRIPTION_INPUT_CHANGED": "素材指纹已变化，转录结果失效",
        "TRANSCRIPTION_FAILED": "本地转录失败",
        "TRANSCRIPTION_CANCELLED": "转录已取消",
        "MODEL_DOWNLOAD_CANCELLED": "模型下载已取消",
        "JOB_CANCELLED": "任务已取消",
        "RENDER_PLAN_INVALID": "渲染计划不合法",
        "RENDER_INPUT_CHANGED": "渲染输入已变化",
        "RENDER_FONT_MISSING": "字幕字体资源缺失",
        "RENDER_FAILED": "渲染失败",
        "RENDER_VALIDATION_FAILED": "渲染产物校验失败",
        "EXPORT_DESTINATION_INVALID": "导出目标无效",
        "EXPORT_DESTINATION_EXISTS": "导出目标已存在",
        "EXPORT_DESTINATION_EXPIRED": "导出授权已过期",
    }
    return messages.get(code, "任务执行失败")
