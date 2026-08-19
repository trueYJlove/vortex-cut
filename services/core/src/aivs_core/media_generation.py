from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .projects import DomainError

GENERATION_KINDS = {"image", "tts"}
RETRYABLE_STATUSES = {"failed", "cancelled", "interrupted"}
EXECUTION_MODE = "simulation_only"
_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
_SENSITIVE_KEYS = {
    "path",
    "uri",
    "absolute_path",
    "prompt",
    "transcript",
    "caption",
    "api_key",
    "secret",
    "authorization",
    "payload",
    "raw_response",
    "stderr",
    "command",
}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_value(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _id(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 128
        or any(c not in _ID_CHARS for c in value)
    ):
        raise DomainError("GENERATION_REQUEST_INVALID", f"{field} 无效")
    return value


def _reject_sensitive(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _reject_sensitive(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _SENSITIVE_KEYS:
                raise DomainError("GENERATION_REQUEST_INVALID", "参数包含敏感字段")
            _reject_sensitive(item)


def _parameters(kind: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DomainError("GENERATION_REQUEST_INVALID", "parameters 无效")
    _reject_sensitive(value)
    if kind == "image":
        if set(value) - {"width", "height", "style_preset_id", "seed"}:
            raise DomainError("GENERATION_REQUEST_INVALID", "图片参数包含未知字段")
        for name in ("width", "height"):
            current = value.get(name)
            if (
                isinstance(current, bool)
                or not isinstance(current, int)
                or not 64 <= current <= 4096
            ):
                raise DomainError("GENERATION_REQUEST_INVALID", f"{name} 无效")
        if "style_preset_id" in value:
            _id(value["style_preset_id"], "style_preset_id")
        if "seed" in value:
            seed = value["seed"]
            if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**31 - 1:
                raise DomainError("GENERATION_REQUEST_INVALID", "seed 无效")
    else:
        if set(value) != {"voice_preset_id", "language", "speed_milli"}:
            raise DomainError("GENERATION_REQUEST_INVALID", "TTS 参数无效")
        _id(value.get("voice_preset_id"), "voice_preset_id")
        if value.get("language") not in {"zh-CN", "en-US"}:
            raise DomainError("GENERATION_REQUEST_INVALID", "TTS 语言无效")
        speed = value.get("speed_milli")
        if isinstance(speed, bool) or not isinstance(speed, int) or not 500 <= speed <= 2000:
            raise DomainError("GENERATION_REQUEST_INVALID", "TTS 语速无效")
    return json.loads(_canonical_json(value))


class MediaGenerationService:
    def __init__(self, db: Database) -> None:
        self.db = db

    def prepare(
        self, project_id: Any, kind: Any, prompt: Any, input_refs: Any, parameters: Any
    ) -> dict[str, Any]:
        project = _id(project_id, "project_id")
        with self.db.connection() as sql:
            if not sql.execute("SELECT 1 FROM projects WHERE id=?", (project,)).fetchone():
                raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
        if kind not in GENERATION_KINDS:
            raise DomainError("GENERATION_KIND_UNSUPPORTED", "生成类型不支持")
        if (
            not isinstance(prompt, str)
            or not 1 <= len(prompt) <= 4000
            or any(ord(c) < 32 and c not in "\n\t" for c in prompt)
        ):
            raise DomainError("GENERATION_REQUEST_INVALID", "生成指令无效")
        if not isinstance(input_refs, list) or not 1 <= len(input_refs) <= 32:
            raise DomainError("GENERATION_REQUEST_INVALID", "input_refs 无效")
        refs = sorted(_id(item, "input_ref") for item in input_refs)
        if len(set(refs)) != len(refs):
            raise DomainError("GENERATION_REQUEST_INVALID", "input_refs 必须唯一")
        facts = {
            "schema_version": 1,
            "project_id": project,
            "generation_kind": kind,
            "execution_mode": EXECUTION_MODE,
            "prompt_sha256": _sha256_text(prompt),
            "input_refs": refs,
            "parameters": _parameters(kind, parameters),
        }
        return {**facts, "request_sha256": _sha256_value(facts)}

    def create(
        self,
        project_id: str,
        kind: Any,
        prompt: Any,
        input_refs: Any,
        parameters: Any,
        request_sha256: Any,
    ) -> dict[str, Any]:
        prepared = self.prepare(project_id, kind, prompt, input_refs, parameters)
        if request_sha256 != prepared["request_sha256"]:
            raise DomainError("GENERATION_HASH_MISMATCH", "生成请求摘要不匹配")
        now, request_id = utc_now(), new_id()
        reused = False
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                row = sql.execute(
                    (
                        "SELECT * FROM media_generation_requests WHERE project_id=? "
                        "AND request_sha256=? AND execution_mode=?"
                    ),
                    (project_id, request_sha256, EXECUTION_MODE),
                ).fetchone()
                if row:
                    request_id, reused = row["id"], True
                else:
                    sql.execute(
                        (
                            "INSERT INTO media_generation_requests("
                            "id,project_id,generation_kind,execution_mode,prompt_sha256,input_refs_json,"
                            "parameters_json,request_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
                        ),
                        (
                            request_id,
                            project_id,
                            kind,
                            EXECUTION_MODE,
                            prepared["prompt_sha256"],
                            json_dumps(prepared["input_refs"]),
                            json_dumps(prepared["parameters"]),
                            request_sha256,
                            now,
                        ),
                    )
                task = sql.execute(
                    "SELECT * FROM media_generation_tasks WHERE request_id=? AND attempt=1",
                    (request_id,),
                ).fetchone()
                if not task:
                    task_id, job_id = new_id(), new_id()
                    self._insert_task(sql, request_id, task_id, job_id, 1, None, now)
                    task = sql.execute(
                        "SELECT t.* FROM media_generation_tasks t JOIN media_generation_requests r "
                        "ON r.id=t.request_id WHERE t.id=? AND r.execution_mode=?",
                        (task_id, EXECUTION_MODE),
                    ).fetchone()
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        return {"request": self.get(request_id), "task": self._task(task), "reused": reused}

    @staticmethod
    def _insert_task(
        sql: sqlite3.Connection,
        request_id: str,
        task_id: str,
        job_id: str,
        attempt: int,
        parent: str | None,
        now: str,
    ) -> None:
        safe_input = {
            "media_generation_task_id": task_id,
            "request_id": request_id,
            "execution_mode": EXECUTION_MODE,
        }
        sql.execute(
            (
                "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                "resource_class,attempt,created_at,updated_at) SELECT ?,project_id,"
                "'media_generation','media_generation','queued','queued',0,?,'local',?,?,? "
                "FROM media_generation_requests WHERE id=? AND execution_mode=?"
            ),
            (job_id, json_dumps(safe_input), attempt, now, now, request_id, EXECUTION_MODE),
        )
        if sql.execute("SELECT changes()").fetchone()[0] != 1:
            raise DomainError("GENERATION_REQUEST_INVALID", "生成请求不存在")
        sql.execute(
            (
                "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
                "retry_of_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
            ),
            (task_id, request_id, job_id, attempt, "queued", "queued", parent, now, now),
        )

    def list(
        self, project_id: str, limit: int = 50, cursor: str | None = None
    ) -> list[dict[str, Any]]:
        _id(project_id, "project_id")
        offset = self._offset(limit, cursor)
        with self.db.connection() as sql:
            rows = sql.execute(
                (
                    "SELECT * FROM media_generation_requests WHERE project_id=? AND execution_mode=? "  # noqa: E501
                    "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?"
                ),
                (project_id, EXECUTION_MODE, limit, offset),
            ).fetchall()
        return [self._request(row) for row in rows]

    def get(self, request_id: str) -> dict[str, Any]:
        _id(request_id, "request_id")
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM media_generation_requests WHERE id=? AND execution_mode=?",
                (request_id, EXECUTION_MODE),
            ).fetchone()
        if not row:
            raise DomainError("GENERATION_REQUEST_INVALID", "生成请求不存在")
        return self._request(row)

    def list_tasks(
        self, request_id: str, limit: int = 50, cursor: str | None = None
    ) -> list[dict[str, Any]]:
        self.get(request_id)
        offset = self._offset(limit, cursor)
        with self.db.connection() as sql:
            rows = sql.execute(
                (
                    "SELECT * FROM media_generation_tasks WHERE request_id=? "
                    "ORDER BY attempt,created_at LIMIT ? OFFSET ?"
                ),
                (request_id, limit, offset),
            ).fetchall()
        return [self._task(row) for row in rows]

    def retry(self, task_id: str) -> dict[str, Any]:
        _id(task_id, "task_id")
        now = utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                row = sql.execute(
                    "SELECT t.* FROM media_generation_tasks t JOIN media_generation_requests r "
                    "ON r.id=t.request_id WHERE t.id=? AND r.execution_mode=?",
                    (task_id, EXECUTION_MODE),
                ).fetchone()
                if not row:
                    raise DomainError("GENERATION_TASK_NOT_FOUND", "生成任务不存在")
                child = sql.execute(
                    "SELECT 1 FROM media_generation_tasks WHERE retry_of_task_id=?", (task_id,)
                ).fetchone()
                if row["status"] not in RETRYABLE_STATUSES or child:
                    raise DomainError("GENERATION_RETRY_NOT_ALLOWED", "当前生成任务不可重试")
                new_task, new_job = new_id(), new_id()
                self._insert_task(
                    sql, row["request_id"], new_task, new_job, int(row["attempt"]) + 1, task_id, now
                )
                result = sql.execute(
                    "SELECT * FROM media_generation_tasks WHERE id=?", (new_task,)
                ).fetchone()
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        return self._task(result)

    def cancel(self, task_id: str) -> dict[str, Any]:
        _id(task_id, "task_id")
        now = utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                row = sql.execute(
                    "SELECT t.* FROM media_generation_tasks t JOIN media_generation_requests r "
                    "ON r.id=t.request_id WHERE t.id=? AND r.execution_mode=?",
                    (task_id, EXECUTION_MODE),
                ).fetchone()
                if not row:
                    raise DomainError("GENERATION_TASK_NOT_FOUND", "生成任务不存在")
                if row["status"] != "queued":
                    raise DomainError("JOB_INVALID_STATE", "仅排队中的生成任务可取消")
                sql.execute(
                    (
                        "UPDATE jobs SET status='cancelled',stage='cancelled',"
                        "finished_at=?,updated_at=? WHERE id=? AND status='queued'"
                    ),
                    (now, now, row["job_id"]),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise DomainError("JOB_INVALID_STATE", "仅排队中的生成任务可取消")
                sql.execute(
                    (
                        "UPDATE media_generation_tasks SET status='cancelled',stage='cancelled',"
                        "finished_at=?,updated_at=? WHERE id=?"
                    ),
                    (now, now, task_id),
                )
                result = sql.execute(
                    "SELECT t.* FROM media_generation_tasks t JOIN media_generation_requests r "
                    "ON r.id=t.request_id WHERE t.id=? AND r.execution_mode=?",
                    (task_id, EXECUTION_MODE),
                ).fetchone()
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        return self._task(result)

    def start_job(self, job_id: str) -> None:
        now = utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                task = sql.execute(
                    "SELECT t.id,t.status FROM media_generation_tasks t "
                    "JOIN media_generation_requests r ON r.id=t.request_id "
                    "WHERE t.job_id=? AND r.execution_mode=?",
                    (job_id, EXECUTION_MODE),
                ).fetchone()
                if not task or task["status"] != "queued":
                    raise DomainError("GENERATION_REQUEST_INVALID", "生成任务状态无效")
                sql.execute(
                    (
                        "UPDATE jobs SET status='running',stage='running',"
                        "started_at=?,updated_at=? WHERE id=? AND status='queued'"
                    ),
                    (now, now, job_id),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise DomainError("GENERATION_REQUEST_INVALID", "生成任务状态无效")
                sql.execute(
                    (
                        "UPDATE media_generation_tasks SET status='running',stage='running',"
                        "updated_at=? WHERE id=?"
                    ),
                    (now, task["id"]),
                )
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise

    async def run_simulation(
        self, row: Any, cancel_event: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        # Stage 4A has no external work or intermediate progress. Keeping both
        # records at ``running`` avoids Task/Job stage drift.
        del row, cancel_event, progress, stage
        await asyncio.sleep(0)
        return {
            "execution_mode": EXECUTION_MODE,
            "outcome": "validated_without_media",
            "provider_call_count": 0,
        }

    def recover_interrupted_tasks(self) -> int:
        """Atomically recover unfinished generation Task/Job pairs without replay."""
        now = utc_now()
        recovered = 0
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                rows = sql.execute(
                    "SELECT t.id,t.job_id,t.status AS task_status,j.status AS job_status "
                    "FROM media_generation_tasks t JOIN jobs j ON j.id=t.job_id "
                    "JOIN media_generation_requests r ON r.id=t.request_id "
                    "WHERE r.execution_mode=? AND "
                    "(t.status='running' OR j.status IN ('running','cancelling'))",
                    (EXECUTION_MODE,),
                ).fetchall()
                for row in rows:
                    if row["task_status"] not in {"queued", "running"} or row["job_status"] not in {
                        "queued",
                        "running",
                        "cancelling",
                    }:
                        raise RuntimeError("GENERATION_OUTPUT_INVALID")
                    sql.execute(
                        (
                            "UPDATE jobs SET status='interrupted',stage='interrupted',progress=0,"
                            "error_code='GENERATION_INTERRUPTED',"
                            "error_message='Core 重启前生成任务未完成',worker_pid=NULL,"
                            "finished_at=?,updated_at=? WHERE id=? "
                            "AND status IN ('queued','running','cancelling')"
                        ),
                        (now, now, row["job_id"]),
                    )
                    if sql.execute("SELECT changes()").fetchone()[0] != 1:
                        raise RuntimeError("GENERATION_OUTPUT_INVALID")
                    sql.execute(
                        (
                            "UPDATE media_generation_tasks SET status='interrupted',"
                            "stage='interrupted',error_code='GENERATION_INTERRUPTED',"
                            "error_message='Core 重启前生成任务未完成',finished_at=?,updated_at=? "
                            "WHERE id=? AND status IN ('queued','running')"
                        ),
                        (now, now, row["id"]),
                    )
                    if sql.execute("SELECT changes()").fetchone()[0] != 1:
                        raise RuntimeError("GENERATION_OUTPUT_INVALID")
                    recovered += 1
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        return recovered

    def finish_job(
        self,
        job_id: str,
        status: str,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        if status not in {"succeeded", "failed", "cancelled", "interrupted"}:
            raise ValueError("invalid generation terminal status")
        now = utc_now()
        stage = "completed" if status == "succeeded" else status
        task_code = "GENERATION_INTERRUPTED" if status == "interrupted" else error_code
        task_message = "任务在重启前未完成" if status == "interrupted" else error_message
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                sql.execute(
                    (
                        "UPDATE jobs SET status=?,stage=?,progress=?,result_json=?,error_code=?,"
                        "error_message=?,worker_pid=NULL,finished_at=?,updated_at=? WHERE id=? "
                        "AND status IN ('running','cancelling')"
                    ),
                    (
                        status,
                        stage,
                        1 if status == "succeeded" else 0,
                        json_dumps(result) if result else None,
                        task_code,
                        task_message,
                        now,
                        now,
                        job_id,
                    ),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                sql.execute(
                    (
                        "UPDATE media_generation_tasks SET status=?,stage=?,result_summary_json=?,"
                        "error_code=?,error_message=?,finished_at=?,updated_at=? WHERE job_id=? "
                        "AND status='running'"
                    ),
                    (
                        status,
                        stage,
                        json_dumps(result) if result else None,
                        task_code,
                        task_message,
                        now,
                        now,
                        job_id,
                    ),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise

    @staticmethod
    def _offset(limit: int, cursor: str | None) -> int:
        try:
            offset = int(cursor or 0)
        except (TypeError, ValueError) as exc:
            raise DomainError("GENERATION_REQUEST_INVALID", "cursor 无效") from exc
        if not 1 <= limit <= 100 or offset < 0 or (cursor is not None and not cursor.isdecimal()):
            raise DomainError("GENERATION_REQUEST_INVALID", "分页参数无效")
        return offset

    @staticmethod
    def _request(row: Any) -> dict[str, Any]:
        return {
            "request_id": row["id"],
            "project_id": row["project_id"],
            "generation_kind": row["generation_kind"],
            "execution_mode": row["execution_mode"],
            "prompt_sha256": row["prompt_sha256"],
            "input_refs": json_loads(row["input_refs_json"]),
            "parameters": json_loads(row["parameters_json"]),
            "request_sha256": row["request_sha256"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _task(row: Any) -> dict[str, Any]:
        error = (
            {"code": row["error_code"], "message": row["error_message"]}
            if row["error_code"]
            else None
        )
        return {
            "task_id": row["id"],
            "request_id": row["request_id"],
            "job_id": row["job_id"],
            "attempt": int(row["attempt"]),
            "status": row["status"],
            "stage": row["stage"],
            "retry_of_task_id": row["retry_of_task_id"],
            "output_asset_id": row["output_asset_id"],
            "output_sha256": row["output_sha256"],
            "result_summary": json_loads(row["result_summary_json"])
            if row["result_summary_json"]
            else None,
            "error": error,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
        }
