from __future__ import annotations

import asyncio
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .job_scheduler import JobScheduler, policy_for
from .media.encoders import EncoderDetector
from .media.ffprobe import FFprobe
from .media.render import build_render_args, render_media
from .state import transition_sql

# B16：同时在途 job 上限（重任务经调度器仍单槽；网络/轻量并行——此上限
# 是总闸（防 jobs 表风暴下任务字典无界）；与调度器资源表共同生效）
_MAX_CONCURRENT_JOBS = 4


def _iso_to_epoch(value: str) -> float:
    """ISO 时间串 → epoch 秒（aging 计算用；解析失败退 0 = 保守不 aging）。"""
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0

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
        Callable[[str, float | None], None],
    ],
    Awaitable[dict[str, Any]],
]
PlanningRunner = Callable[
    [Any, asyncio.Event, Callable[[float], None], Callable[[str], None]], Awaitable[dict[str, Any]]
]
PreviewSourceRunner = Callable[
    [
        Any,
        asyncio.Event,
        Callable[[float], None],
        Callable[[str], None],
    ],
    Awaitable[dict[str, Any]],
]
# B14 波形作业执行体（与 PreviewSourceRunner 同形；waveform.run_waveform_job）
WaveformRunner = PreviewSourceRunner
GenerationStart = Callable[[str], None]
GenerationRecover = Callable[[], int]
GenerationFinish = Callable[[str, str, dict[str, Any] | None, str | None, str | None], None]


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
        preview_source_runner: PreviewSourceRunner | None = None,
        waveform_runner: WaveformRunner | None = None,
        render_runner: RenderRunner | None = None,
        planning_runner: PlanningRunner | None = None,
        timeline_patch_runner: PlanningRunner | None = None,
        agent_session_runner: PlanningRunner | None = None,
        media_generation_runner: PlanningRunner | None = None,
        media_generation_start: GenerationStart | None = None,
        media_generation_finish: GenerationFinish | None = None,
        media_generation_recover: GenerationRecover | None = None,
        provider_image_generation_runner: PlanningRunner | None = None,
        provider_image_generation_start: GenerationStart | None = None,
        provider_image_generation_finish: GenerationFinish | None = None,
        provider_image_generation_recover: GenerationRecover | None = None,
        scheduler: JobScheduler | None = None,
    ) -> None:
        self.db = db
        self.data_dir = data_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.encoders = encoders
        self.emit = emit
        self.asr_runner = asr_runner
        self.retry_validator = retry_validator
        self.preview_source_runner = preview_source_runner
        self.waveform_runner = waveform_runner
        self.render_runner = render_runner
        self.planning_runner = planning_runner
        self.timeline_patch_runner = timeline_patch_runner
        self.agent_session_runner = agent_session_runner
        self.media_generation_runner = media_generation_runner
        self.media_generation_start = media_generation_start
        self.media_generation_finish = media_generation_finish
        self.media_generation_recover = media_generation_recover
        self.provider_image_generation_runner = provider_image_generation_runner
        self.provider_image_generation_start = provider_image_generation_start
        self.provider_image_generation_finish = provider_image_generation_finish
        self.provider_image_generation_recover = provider_image_generation_recover
        # B16：资源配额调度器（None = 旧单槽行为——兼容既有测试/旧构造）
        self.scheduler = scheduler
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
        if self.media_generation_recover:
            self.media_generation_recover()
        if self.provider_image_generation_recover:
            self.provider_image_generation_recover()
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

    def create_batch_render_in_transaction(
        self,
        db: Any,
        project_id: str,
        timeline_revision_id: str,
        export_batch_item_id: str,
        encoder: str,
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert a final-export job in the caller's batch preflight transaction."""
        job_id, now = new_id(), utc_now()
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_requested,encoder_used,fallback_reason,timeline_revision_id,export_batch_item_id,"
            "resource_class,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
            (
                job_id,
                project_id,
                "final_export",
                "final_export",
                "queued",
                "queued",
                0,
                json_dumps(input_data),
                encoder,
                encoder,
                input_data.get("toolchain", {}).get("fallback_reason"),
                timeline_revision_id,
                export_batch_item_id,
                "render",
                1,
                now,
                now,
            ),
        )
        return {"job_id": job_id, "status": "queued", "created_at": now}

    def create_reframe_batch_render_in_transaction(
        self,
        db: Any,
        project_id: str,
        timeline_revision_id: str,
        reframe_export_batch_item_id: str,
        encoder: str,
        input_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert a Stage 3B final-export job without using Stage 3A ownership."""
        job_id, now = new_id(), utc_now()
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "encoder_requested,encoder_used,fallback_reason,timeline_revision_id,"
            "reframe_export_batch_item_id,resource_class,attempt,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                job_id,
                project_id,
                "final_export",
                "final_export",
                "queued",
                "queued",
                0,
                json_dumps(input_data),
                encoder,
                encoder,
                input_data.get("toolchain", {}).get("fallback_reason"),
                timeline_revision_id,
                reframe_export_batch_item_id,
                "render",
                1,
                now,
                now,
            ),
        )
        return {"job_id": job_id, "status": "queued", "created_at": now}

    def create_candidate_generation(
        self, project_id: str, generation_id: str, invocation_id: str, payload_sha256: str
    ) -> dict[str, Any]:
        job_id, now = new_id(), utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                "candidate_generation_id,provider_invocation_id,resource_class,attempt,created_at,updated_at) "  # noqa: E501
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    job_id,
                    project_id,
                    "candidate_generation",
                    "candidate_generation",
                    "queued",
                    "queued",
                    0,
                    json_dumps(
                        {
                            "candidate_generation_id": generation_id,
                            "egress_payload_sha256": payload_sha256,
                        }
                    ),
                    generation_id,
                    invocation_id,
                    "network",
                    1,
                    now,
                    now,
                ),
            )
        return self.get(job_id) or {"job_id": job_id, "status": "queued", "created_at": now}

    def create_timeline_patch_generation(
        self, project_id: str, generation_id: str, invocation_id: str, payload_sha256: str
    ) -> dict[str, Any]:
        job_id, now = new_id(), utc_now()
        with self.db.connection() as db:
            self.insert_timeline_patch_job(
                db, job_id, now, project_id, generation_id, invocation_id, payload_sha256
            )
        return self.get(job_id) or {"job_id": job_id, "status": "queued", "created_at": now}

    @staticmethod
    def insert_timeline_patch_job(
        db: Any,
        job_id: str,
        now: str,
        project_id: str,
        generation_id: str,
        invocation_id: str,
        payload_sha256: str,
    ) -> None:
        db.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "timeline_patch_generation_id,provider_invocation_id,resource_class,attempt,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                job_id,
                project_id,
                "timeline_patch_generation",
                "timeline_patch_generation",
                "queued",
                "queued",
                0,
                json_dumps(
                    {
                        "timeline_patch_generation_id": generation_id,
                        "egress_payload_sha256": payload_sha256,
                    }
                ),
                generation_id,
                invocation_id,
                "network",
                1,
                now,
                now,
            ),
        )

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
        # C22：细分阶段扩展（可选字段；未知 phase 的旧 UI 忽略即可）。
        result["phase"] = result.pop("phase", None)
        result["phase_progress"] = result.pop("phase_progress", None)
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
            if row["kind"] in {"candidate_generation", "timeline_patch_generation"}:
                raise ValueError("CANDIDATE_GENERATION_RECONFIRM_REQUIRED")
            # agent_session 允许 jobs.retry：会话级 consent 已消费，重试 =
            # 全新会话重新走 prepare/confirm（AI-1 规划门 §2 裁决）。
            if row["kind"] == "media_generation":
                raise ValueError("GENERATION_RETRY_NOT_ALLOWED")
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
            row = db.execute("SELECT status,kind FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        status = row["status"]
        if row["kind"] == "media_generation":
            raise ValueError("JOB_INVALID_STATE")
        if status == "queued":
            now = utc_now()
            self._transition_job(job_id, status, "cancelled", finished_at=now)
        elif status == "running":
            self._transition_job(job_id, status, "cancelling", cancel_requested=1)
            self.cancel_events.setdefault(job_id, asyncio.Event()).set()
            job = self.get(job_id)
            if (
                job_id in self.tasks
                and job
                and job["kind"] in {"candidate_generation", "timeline_patch_generation"}
            ):
                self.tasks[job_id].cancel()
        elif status == "cancelling":
            self.cancel_events.setdefault(job_id, asyncio.Event()).set()
        result = self.get(job_id)
        await self._emit_update(result)
        return result

    async def _loop(self) -> None:
        """B16 调度循环：分级 FIFO + 资源令牌准入（重任务单槽、network/light
        有界并行）；无调度器时回退旧单槽行为（兼容测试/旧构造）。"""
        while True:
            if not self.tasks:
                if self.scheduler is None:
                    # 旧路径：一次一个（行为与 B16 前完全一致）
                    with self.db.connection() as db:
                        row = db.execute(
                            "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
                        ).fetchone()
                    if row:
                        self._spawn(row[0])
                else:
                    # B16：全部 queued 候选 → 优先级排序 → 逐个 admit 尝试
                    # （高优先级资源不足不阻塞低优先级可运行任务）
                    with self.db.connection() as db:
                        rows = db.execute(
                            "SELECT id, kind, created_at FROM jobs WHERE status='queued' "
                            "ORDER BY created_at LIMIT 128"
                        ).fetchall()
                    candidates = [
                        {
                            "job_id": row["id"],
                            "kind": row["kind"],
                            # created_at 为 ISO 串——排序稳定即可（同批内比较）；
                            # aging 用 ts_epoch 转换（失败退 0 = 不 aging，保守）
                            "created_ts": _iso_to_epoch(str(row["created_at"])),
                        }
                        for row in rows
                    ]
                    ranked = sorted(
                        candidates,
                        key=lambda item: (
                            self.scheduler.effective_priority(
                                policy_for(str(item["kind"])), float(item["created_ts"])),
                            float(item["created_ts"]),
                            str(item["job_id"]),
                        ),
                    )
                    for candidate in ranked:
                        if len(self.tasks) >= _MAX_CONCURRENT_JOBS:
                            break
                        admission = await self.scheduler.admit(
                            str(candidate["kind"]), str(candidate["job_id"]))
                        if admission is None:
                            continue  # 资源不足/lease 暂缓：试下一候选（防头阻塞）
                        self._spawn(str(candidate["job_id"]), admission)
                        break  # 本轮只启动一个（0.05s 轮询逐个放行）
            await asyncio.sleep(0.05)

    def _spawn(self, job_id: str, admission: Any = None) -> None:
        """启动 job task；持有调度准入时 finally 归还令牌（恰好一次）。"""
        release = (
            self.scheduler.release(job_id) if self.scheduler and admission else None
        )

        async def run_with_release() -> None:
            try:
                await self._run(job_id)
            finally:
                if release is not None:
                    await release
        task = asyncio.create_task(run_with_release())
        self.tasks[job_id] = task
        task.add_done_callback(
            lambda _, current_id=job_id: self.tasks.pop(current_id, None)
        )

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
        # C22：状态离开 running 即清细分阶段（终态行不残留过期的 phase）。
        assignments.append("phase=NULL")
        assignments.append("phase_progress=NULL")
        assignments.append("updated_at=?")
        values.append(utc_now())
        values.append(job_id)
        with self.db.connection() as db:
            db.execute(f"UPDATE jobs SET {','.join(assignments)} WHERE id=?", values)

    def _generation_callbacks(
        self, row: Any
    ) -> tuple[PlanningRunner, GenerationStart, GenerationFinish]:
        payload = json_loads(row["input_json"])
        mode = payload.get("execution_mode")
        if mode == "simulation_only":
            callbacks = (
                self.media_generation_runner,
                self.media_generation_start,
                self.media_generation_finish,
            )
        elif mode == "provider_image_v1":
            callbacks = (
                self.provider_image_generation_runner,
                self.provider_image_generation_start,
                self.provider_image_generation_finish,
            )
        else:
            raise RuntimeError("GENERATION_EXECUTION_MODE_INVALID")
        runner, start, finish = callbacks
        if runner is None or start is None or finish is None:
            raise RuntimeError("GENERATION_OUTPUT_INVALID")
        return runner, start, finish

    async def _run(self, job_id: str) -> None:
        now = utc_now()
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row or row["status"] != "queued":
            return
        generation_runner: PlanningRunner | None = None
        generation_finish: GenerationFinish | None = None
        if row["kind"] == "media_generation":
            generation_runner, generation_start, generation_finish = self._generation_callbacks(row)
            generation_start(job_id)
        else:
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
                    lambda name, value: self._set_phase(job_id, name, value),
                )
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] == "candidate_generation":
                if self.planning_runner is None:
                    raise RuntimeError("PLANNING_UNAVAILABLE")
                result = await self.planning_runner(
                    row,
                    cancel_event,
                    lambda value: self._set_progress(job_id, value),
                    lambda value: self._set_stage(job_id, value),
                )
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] == "timeline_patch_generation":
                if self.timeline_patch_runner is None:
                    raise RuntimeError("PLANNING_UNAVAILABLE")
                result = await self.timeline_patch_runner(
                    row,
                    cancel_event,
                    lambda value: self._set_progress(job_id, value),
                    lambda value: self._set_stage(job_id, value),
                )
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] == "agent_session":
                # AI-1：多步 agent 会话（runner 内部即循环体；progress/stage
                # 经既有回调逐步上报，取消传播逐步生效）。
                if self.agent_session_runner is None:
                    raise RuntimeError("PLANNING_UNAVAILABLE")
                result = await self.agent_session_runner(
                    row,
                    cancel_event,
                    lambda value: self._set_progress(job_id, value),
                    lambda value: self._set_stage(job_id, value),
                )
                with self.db.connection() as db:
                    db.execute(
                        "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                        (json_dumps(result), utc_now(), job_id),
                    )
            elif row["kind"] == "media_generation":
                if generation_runner is None:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                result = await generation_runner(
                    row,
                    cancel_event,
                    lambda value: self._set_progress(job_id, value),
                    lambda value: self._set_stage(job_id, value),
                )
            elif row["kind"] in {"asset_probe", "asset_fingerprint"}:
                pass
            else:
                await self._run_media(row, job_id, cancel_event)
            current_status = self._current_status(job_id)
            if current_status == "running" and row["kind"] == "media_generation":
                if generation_finish is None:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                generation_finish(job_id, "succeeded", result, None, None)
            elif current_status == "running":
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
                if row["kind"] == "media_generation" and generation_finish:
                    generation_finish(job_id, target, None, code, message)
                else:
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
        except asyncio.CancelledError:
            current_status = self._current_status(job_id)
            if current_status in {"running", "cancelling"}:
                target = "cancelled" if current_status == "cancelling" else "interrupted"
                error_code = "JOB_CANCELLED" if target == "cancelled" else "JOB_INTERRUPTED"
                message = _job_error_message(error_code)
                if row["kind"] == "media_generation" and generation_finish:
                    generation_finish(job_id, target, None, error_code, message)
                else:
                    self._transition_job(
                        job_id,
                        current_status,
                        target,
                        stage=target,
                        error_code=error_code,
                        error_message=message,
                        finished_at=utc_now(),
                        worker_pid=None,
                    )
            raise
        except Exception:
            current_status = self._current_status(job_id)
            if current_status in {"running", "cancelling"}:
                target = "cancelled" if current_status == "cancelling" else "failed"
                if row["kind"] == "media_generation" and generation_finish:
                    generation_finish(job_id, target, None, "INTERNAL_ERROR", "任务执行失败")
                else:
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

    async def _run_asr(self, row: Any, cancel_event: asyncio.Event, job_id: str) -> dict[str, Any]:
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

    async def _run_media(self, row: Any, job_id: str, cancel_event: asyncio.Event) -> None:
        payload = json_loads(row["input_json"])
        if row["kind"] == "waveform":
            # B14 波形：流式 PCM 聚合 → 金字塔，产物进 B10 派生缓存
            if self.waveform_runner is None:
                raise RuntimeError("RENDER_FAILED")
            result = await self.waveform_runner(
                row, cancel_event,
                lambda value: self._set_progress(job_id, value),
                lambda value: self._set_stage(job_id, value),
            )
            with self.db.connection() as db:
                db.execute(
                    "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                    (json_dumps(result), utc_now(), job_id),
                )
            return
        if "cache_key" in payload:
            # B11 全源代理：产物进 B10 派生缓存（不做 artifacts 行）
            result = await self.preview_source_runner(
                row, cancel_event,
                lambda value: self._set_progress(job_id, value),
                lambda value: self._set_stage(job_id, value),
            )
            with self.db.connection() as db:
                db.execute(
                    "UPDATE jobs SET result_json=?,updated_at=? WHERE id=?",
                    (json_dumps(result), utc_now(), job_id),
                )
            return
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
        output = work / ("vertical-sample.mp4" if row["type"] == "vertical_sample" else "proxy.mp4")
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

    def _set_phase(self, job_id: str, phase: str, phase_progress: float | None) -> None:
        """C22 细分阶段：phase 必到、phase_progress 可空（None = 不定进度）。
        发布临界区（publishing）后任务可能已提交完成——只写 running 行，
        完成时的状态迁移会在下一步覆盖 phase。"""
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET phase=?,phase_progress=?,updated_at=? WHERE id=? "
                "AND status IN ('running','cancelling')",
                (phase, phase_progress, utc_now(), job_id),
            )

    def _current_status(self, job_id: str) -> str | None:
        with self.db.connection() as db:
            row = db.execute("SELECT status,kind FROM jobs WHERE id=?", (job_id,)).fetchone()
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
        "PROXY_JOB_INVALID": "代理生成作业载荷不合法",
        "RENDER_PLAN_INVALID": "渲染计划不合法",
        "RENDER_INPUT_CHANGED": "渲染输入已变化",
        "RENDER_FONT_MISSING": "字幕字体资源缺失",
        "RENDER_FAILED": "渲染失败",
        "RENDER_VALIDATION_FAILED": "渲染产物校验失败",
        "RENDER_VALIDATION_TIMEOUT": "渲染产物校验超时（解码无推进或超出绝对上限）",
        "RENDER_REVERSE_TOO_LONG": "倒放段超出内存预算，请缩短片段或拆分倒放",
        "EXPORT_DESTINATION_INVALID": "导出目标无效",
        "EXPORT_DESTINATION_EXISTS": "导出目标已存在",
        "EXPORT_DESTINATION_EXPIRED": "导出授权已过期",
    }
    return messages.get(code, "任务执行失败")
