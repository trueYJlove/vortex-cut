from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import statistics
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CORE_SRC = ROOT / "services" / "core" / "src"
if str(CORE_SRC) not in sys.path:
    sys.path.insert(0, str(CORE_SRC))

from aivs_core.database import (  # noqa: E402
    MIGRATIONS,
    Database,
    json_dumps,
    utc_now,
)
from aivs_core.ids import new_id  # noqa: E402

PRODUCTION_VERSION = "v11"
FROZEN_VERSIONS = tuple(f"v{number}" for number in range(1, 11))
GENERATION_KINDS = {"image", "tts"}
TERMINAL_RETRYABLE = {"failed", "cancelled", "interrupted"}
SENSITIVE_KEYS = {
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
ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
SHA256_PREFIX = "sha256:"


class PrototypeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_value(value: Any) -> str:
    return SHA256_PREFIX + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_text(value: str) -> str:
    return SHA256_PREFIX + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validate_id(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 128
        or any(char not in ID_CHARS for char in value)
    ):
        raise PrototypeError("GENERATION_REQUEST_INVALID", f"{field} 无效")
    return value


def _reject_sensitive_keys(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _reject_sensitive_keys(item)
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        if not isinstance(key, str) or key.lower() in SENSITIVE_KEYS:
            raise PrototypeError("GENERATION_REQUEST_INVALID", "参数包含敏感字段")
        _reject_sensitive_keys(item)


def _validate_parameters(kind: str, parameters: Any) -> dict[str, Any]:
    if not isinstance(parameters, dict):
        raise PrototypeError("GENERATION_REQUEST_INVALID", "parameters 无效")
    _reject_sensitive_keys(parameters)
    if kind == "image":
        allowed = {"width", "height", "style_preset_id", "seed"}
        if set(parameters) - allowed:
            raise PrototypeError("GENERATION_REQUEST_INVALID", "图片参数包含未知字段")
        width, height = parameters.get("width"), parameters.get("height")
        if (
            not isinstance(width, int)
            or isinstance(width, bool)
            or not isinstance(height, int)
            or isinstance(height, bool)
            or not 64 <= width <= 4096
            or not 64 <= height <= 4096
        ):
            raise PrototypeError("GENERATION_REQUEST_INVALID", "图片尺寸无效")
        seed = parameters.get("seed")
        if seed is not None and (
            not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**31 - 1
        ):
            raise PrototypeError("GENERATION_REQUEST_INVALID", "图片 seed 无效")
        style = parameters.get("style_preset_id")
        if style is not None:
            _validate_id(style, "style_preset_id")
    else:
        allowed = {"voice_preset_id", "language", "speed_milli"}
        if set(parameters) - allowed:
            raise PrototypeError("GENERATION_REQUEST_INVALID", "TTS 参数包含未知字段")
        _validate_id(parameters.get("voice_preset_id"), "voice_preset_id")
        language = parameters.get("language")
        if language not in {"zh-CN", "en-US"}:
            raise PrototypeError("GENERATION_REQUEST_INVALID", "TTS 语言无效")
        speed = parameters.get("speed_milli")
        if not isinstance(speed, int) or isinstance(speed, bool) or not 500 <= speed <= 2000:
            raise PrototypeError("GENERATION_REQUEST_INVALID", "TTS 语速无效")
    return json.loads(canonical_json(parameters))


def prepare_request(
    project_id: Any,
    kind: Any,
    prompt: Any,
    input_refs: Any,
    parameters: Any,
) -> dict[str, Any]:
    project = _validate_id(project_id, "project_id")
    if kind not in GENERATION_KINDS:
        raise PrototypeError("GENERATION_KIND_UNSUPPORTED", "生成类型不支持")
    if (
        not isinstance(prompt, str)
        or not 1 <= len(prompt) <= 4000
        or any(ord(char) < 32 and char not in "\n\t" for char in prompt)
    ):
        raise PrototypeError("GENERATION_REQUEST_INVALID", "生成指令无效")
    if (
        not isinstance(input_refs, list)
        or not 1 <= len(input_refs) <= 32
        or len(set(input_refs)) != len(input_refs)
    ):
        raise PrototypeError("GENERATION_REQUEST_INVALID", "input_refs 无效")
    refs = sorted(_validate_id(value, "input_ref") for value in input_refs)
    normalized_parameters = _validate_parameters(kind, parameters)
    facts = {
        "schema_version": 1,
        "project_id": project,
        "generation_kind": kind,
        "execution_mode": "simulation_only",
        "prompt_sha256": sha256_text(prompt),
        "input_refs": refs,
        "parameters": normalized_parameters,
    }
    return {**facts, "request_sha256": sha256_value(facts)}


def apply_prototype_v11(db: Database) -> dict[str, str]:
    frozen = {
        version: hashlib.sha256(MIGRATIONS[version].encode("utf-8")).hexdigest()
        for version in FROZEN_VERSIONS
    }
    production_checksum = hashlib.sha256(MIGRATIONS[PRODUCTION_VERSION].encode("utf-8")).hexdigest()
    with db.connection() as sql:
        applied = {
            row[0]: row[2]
            for row in sql.execute("SELECT version,applied_at,checksum FROM schema_migrations")
        }
    if any(applied.get(version) != checksum for version, checksum in frozen.items()):
        raise RuntimeError("v1-v10 migration checksum baseline mismatch")
    if applied.get(PRODUCTION_VERSION) != production_checksum:
        raise RuntimeError("production v11 migration checksum mismatch")
    return frozen


def seed_project(db: Database, project_id: str = "project_stage4a") -> None:
    now = utc_now()
    with db.connection() as sql:
        sql.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,root_dir,"
            "root_dir_name,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (project_id, "Stage4A", "active", "{}", None, "internal", "internal", now, now, now),
        )


def create_request(db: Database, prepared: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    with db.connection() as sql:
        existing = sql.execute(
            "SELECT * FROM media_generation_requests WHERE project_id=? AND request_sha256=?",
            (prepared["project_id"], prepared["request_sha256"]),
        ).fetchone()
        if existing:
            return dict(existing), True
        request_id, now = new_id(), utc_now()
        sql.execute(
            "INSERT INTO media_generation_requests(id,project_id,generation_kind,execution_mode,"
            "prompt_sha256,input_refs_json,parameters_json,request_sha256,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                request_id,
                prepared["project_id"],
                prepared["generation_kind"],
                "simulation_only",
                prepared["prompt_sha256"],
                json_dumps(prepared["input_refs"]),
                json_dumps(prepared["parameters"]),
                prepared["request_sha256"],
                now,
            ),
        )
        row = sql.execute(
            "SELECT * FROM media_generation_requests WHERE id=?", (request_id,)
        ).fetchone()
    return dict(row), False


def _insert_task(
    db: Database,
    request_id: str,
    attempt: int,
    retry_of_task_id: str | None,
) -> dict[str, Any]:
    task_id, job_id, now = new_id(), new_id(), utc_now()
    safe_input = {
        "media_generation_task_id": task_id,
        "request_id": request_id,
        "execution_mode": "simulation_only",
    }
    with db.connection() as sql:
        sql.execute("BEGIN")
        try:
            sql.execute(
                "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                "resource_class,attempt,created_at,updated_at) "
                "SELECT ?,project_id,'media_generation','media_generation','queued','queued',0,?,"
                "'local',?,?,? FROM media_generation_requests WHERE id=?",
                (job_id, json_dumps(safe_input), attempt, now, now, request_id),
            )
            if sql.execute("SELECT changes()").fetchone()[0] != 1:
                raise PrototypeError("GENERATION_REQUEST_INVALID", "生成请求不存在")
            sql.execute(
                "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
                "retry_of_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    request_id,
                    job_id,
                    attempt,
                    "queued",
                    "queued",
                    retry_of_task_id,
                    now,
                    now,
                ),
            )
            sql.execute("COMMIT")
        except Exception:
            sql.execute("ROLLBACK")
            raise
        row = sql.execute("SELECT * FROM media_generation_tasks WHERE id=?", (task_id,)).fetchone()
    return dict(row)


def create_task(db: Database, request_id: str) -> dict[str, Any]:
    with db.connection() as sql:
        count = sql.execute(
            "SELECT COUNT(*) FROM media_generation_tasks WHERE request_id=?", (request_id,)
        ).fetchone()[0]
    if count:
        raise PrototypeError("GENERATION_RETRY_NOT_ALLOWED", "首个任务已存在")
    return _insert_task(db, request_id, 1, None)


def retry_task(db: Database, task_id: str) -> dict[str, Any]:
    with db.connection() as sql:
        original = sql.execute(
            "SELECT * FROM media_generation_tasks WHERE id=?", (task_id,)
        ).fetchone()
        if not original or original["status"] not in TERMINAL_RETRYABLE:
            raise PrototypeError("GENERATION_RETRY_NOT_ALLOWED", "当前任务不可重试")
        newer = sql.execute(
            "SELECT 1 FROM media_generation_tasks WHERE retry_of_task_id=?", (task_id,)
        ).fetchone()
        if newer:
            raise PrototypeError("GENERATION_RETRY_NOT_ALLOWED", "该任务已经重试")
    return _insert_task(db, original["request_id"], original["attempt"] + 1, task_id)


def set_running(db: Database, task_id: str) -> None:
    now = utc_now()
    with db.connection() as sql:
        task = sql.execute(
            "SELECT job_id,status FROM media_generation_tasks WHERE id=?", (task_id,)
        ).fetchone()
        if not task or task["status"] != "queued":
            raise PrototypeError("GENERATION_REQUEST_INVALID", "任务状态无效")
        sql.execute(
            "UPDATE jobs SET status='running',stage='running',started_at=?,updated_at=? WHERE id=?",
            (now, now, task["job_id"]),
        )
        sql.execute(
            "UPDATE media_generation_tasks SET status='running',stage='running',"
            "updated_at=? WHERE id=?",
            (now, task_id),
        )


def fail_task(db: Database, task_id: str) -> None:
    now = utc_now()
    with db.connection() as sql:
        task = sql.execute(
            "SELECT job_id FROM media_generation_tasks WHERE id=?", (task_id,)
        ).fetchone()
        sql.execute(
            "UPDATE jobs SET status='failed',stage='failed',error_code='GENERATION_OUTPUT_INVALID',"
            "error_message='模拟输出校验失败',finished_at=?,updated_at=? WHERE id=?",
            (now, now, task["job_id"]),
        )
        sql.execute(
            "UPDATE media_generation_tasks SET status='failed',stage='failed',"
            "error_code='GENERATION_OUTPUT_INVALID',error_message='模拟输出校验失败',"
            "finished_at=?,updated_at=? WHERE id=?",
            (now, now, task_id),
        )


def recover_generation_tasks(db: Database) -> int:
    now = utc_now()
    with db.connection() as sql:
        rows = sql.execute(
            "SELECT t.id,t.job_id FROM media_generation_tasks t JOIN jobs j ON j.id=t.job_id "
            "WHERE t.status IN ('running') OR j.status IN ('running','cancelling')"
        ).fetchall()
        for row in rows:
            sql.execute(
                "UPDATE jobs SET status='interrupted',stage='interrupted',"
                "error_code='JOB_INTERRUPTED',error_message='Core 重启前任务未完成',"
                "finished_at=?,updated_at=? WHERE id=?",
                (now, now, row["job_id"]),
            )
            sql.execute(
                "UPDATE media_generation_tasks SET status='interrupted',stage='interrupted',"
                "error_code='GENERATION_INTERRUPTED',error_message='任务在重启前未完成',"
                "finished_at=?,updated_at=? WHERE id=?",
                (now, now, row["id"]),
            )
    return len(rows)


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * quantile) - 1))
    return ordered[index]


def validation_cases() -> list[tuple[dict[str, Any], bool, str | None]]:
    valid_image = {
        "project_id": "project_stage4a",
        "kind": "image",
        "prompt": "合成测试图片提示，仅在进程内参与哈希",
        "input_refs": ["asset_1"],
        "parameters": {"width": 1024, "height": 1024, "style_preset_id": "clean", "seed": 7},
    }
    valid_tts = {
        "project_id": "project_stage4a",
        "kind": "tts",
        "prompt": "合成测试配音文本，仅在进程内参与哈希",
        "input_refs": ["brief_1"],
        "parameters": {"voice_preset_id": "voice_1", "language": "zh-CN", "speed_milli": 1000},
    }
    return [
        (valid_image, True, None),
        (valid_tts, True, None),
        ({**valid_image, "kind": "video"}, False, "GENERATION_KIND_UNSUPPORTED"),
        ({**valid_image, "prompt": ""}, False, "GENERATION_REQUEST_INVALID"),
        ({**valid_image, "input_refs": []}, False, "GENERATION_REQUEST_INVALID"),
        (
            {**valid_image, "input_refs": ["asset_1", "asset_1"]},
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        ({**valid_image, "input_refs": ["bad/ref"]}, False, "GENERATION_REQUEST_INVALID"),
        (
            {**valid_image, "parameters": {"width": 63, "height": 1024}},
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {**valid_image, "parameters": {"width": True, "height": 1024}},
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {**valid_image, "parameters": {"width": 1024, "height": 1024, "path": "X"}},
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {**valid_image, "parameters": {"width": 1024, "height": 1024, "api_key": "X"}},
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {
                **valid_tts,
                "parameters": {"voice_preset_id": "voice_1", "language": "xx", "speed_milli": 1000},
            },
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {
                **valid_tts,
                "parameters": {
                    "voice_preset_id": "voice_1",
                    "language": "zh-CN",
                    "speed_milli": 499,
                },
            },
            False,
            "GENERATION_REQUEST_INVALID",
        ),
        (
            {
                **valid_tts,
                "parameters": {
                    "voice_preset_id": "bad/ref",
                    "language": "zh-CN",
                    "speed_milli": 1000,
                },
            },
            False,
            "GENERATION_REQUEST_INVALID",
        ),
    ]


def run_prototype(work_dir: Path, iterations: int = 200) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    database_path = work_dir / "stage4a-prototype.db"
    db = Database(database_path)
    db.initialize()
    frozen_checksums = apply_prototype_v11(db)
    seed_project(db)

    cases = validation_cases()
    matched = 0
    for payload, expected_valid, expected_code in cases:
        try:
            prepare_request(**payload)
            actual_valid, actual_code = True, None
        except PrototypeError as error:
            actual_valid, actual_code = False, error.code
        matched += int((actual_valid, actual_code) == (expected_valid, expected_code))

    prompt_sentinel = "STAGE4A_PROMPT_PLAINTEXT_MUST_NOT_PERSIST"
    secret_sentinel = "STAGE4A_SECRET_MUST_NOT_PERSIST"
    secret_rejected = False
    try:
        prepare_request(
            "project_stage4a",
            "image",
            "敏感字段拒绝测试",
            ["asset_1"],
            {"width": 1024, "height": 1024, "api_key": secret_sentinel},
        )
    except PrototypeError as error:
        secret_rejected = error.code == "GENERATION_REQUEST_INVALID"

    payload = prepare_request(
        "project_stage4a",
        "image",
        prompt_sentinel,
        ["asset_1", "brief_1"],
        {"height": 1024, "width": 1024, "style_preset_id": "clean", "seed": 7},
    )
    reordered = prepare_request(
        "project_stage4a",
        "image",
        prompt_sentinel,
        ["brief_1", "asset_1"],
        {"seed": 7, "style_preset_id": "clean", "width": 1024, "height": 1024},
    )
    if payload["request_sha256"] != reordered["request_sha256"]:
        raise RuntimeError("canonical request hash is unstable")

    request, reused = create_request(db, payload)
    request_again, reused_again = create_request(db, reordered)
    if reused or not reused_again or request_again["id"] != request["id"]:
        raise RuntimeError("request idempotency failed")

    first = create_task(db, request["id"])
    non_terminal_retry_rejected = False
    try:
        retry_task(db, first["id"])
    except PrototypeError as error:
        non_terminal_retry_rejected = error.code == "GENERATION_RETRY_NOT_ALLOWED"
    set_running(db, first["id"])
    recovered = recover_generation_tasks(db)
    retried = retry_task(db, first["id"])
    duplicate_retry_rejected = False
    try:
        retry_task(db, first["id"])
    except PrototypeError as error:
        duplicate_retry_rejected = error.code == "GENERATION_RETRY_NOT_ALLOWED"
    set_running(db, retried["id"])
    fail_task(db, retried["id"])

    prepare_ms: list[float] = []
    create_ms: list[float] = []
    for index in range(iterations):
        started = time.perf_counter_ns()
        prepared = prepare_request(
            "project_stage4a",
            "image" if index % 2 == 0 else "tts",
            f"synthetic-{index}",
            [f"asset_{index % 8}"],
            {"width": 512, "height": 512, "seed": index}
            if index % 2 == 0
            else {"voice_preset_id": "voice_1", "language": "zh-CN", "speed_milli": 1000},
        )
        prepare_ms.append((time.perf_counter_ns() - started) / 1_000_000)
        started = time.perf_counter_ns()
        created, _ = create_request(db, prepared)
        create_ms.append((time.perf_counter_ns() - started) / 1_000_000)
        if index < 32:
            create_task(db, created["id"])

    with closing(sqlite3.connect(database_path)) as sql:
        dump = "\n".join(sql.iterdump())
        versions = [
            row[0] for row in sql.execute("SELECT version FROM schema_migrations ORDER BY rowid")
        ]
        tables = {
            row[0] for row in sql.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        indexes = {
            row[0] for row in sql.execute("SELECT name FROM sqlite_master WHERE type='index'")
        }
        provider_invocations = sql.execute("SELECT COUNT(*) FROM provider_invocations").fetchone()[
            0
        ]
        immutable_update_ok = False
        try:
            sql.execute("UPDATE media_generation_requests SET execution_mode='other'")
        except sqlite3.IntegrityError:
            immutable_update_ok = True
        immutable_delete_ok = False
        try:
            sql.execute("DELETE FROM media_generation_requests WHERE id=?", (request["id"],))
        except sqlite3.IntegrityError:
            immutable_delete_ok = True
        secret_absent = secret_sentinel not in dump
        prompt_absent = prompt_sentinel not in dump
        absolute_path_absent = str(work_dir.resolve()) not in dump

    return {
        "prototype": "stage4a-generation-model-v1",
        "execution_mode": "simulation_only",
        "provider_call_count": provider_invocations,
        "validation": {
            "cases": len(cases),
            "matched": matched,
            "accuracy_percent": round(100 * matched / len(cases), 2),
            "false_accepts": 0 if matched == len(cases) else None,
            "false_rejects": 0 if matched == len(cases) else None,
            "scope": "结构化输入校验准确率；不代表真实图片/TTS内容质量",
        },
        "migration": {
            "frozen_versions_verified": len(frozen_checksums),
            "production_v11_present": PRODUCTION_VERSION in versions,
            "required_tables_present": {
                "media_generation_requests",
                "media_generation_tasks",
            }.issubset(tables),
            "required_indexes_present": {
                "idx_media_generation_requests_project",
                "idx_media_generation_tasks_request",
                "idx_media_generation_tasks_job",
                "uq_media_generation_tasks_retry_of",
            }.issubset(indexes),
            "immutable_request_update": immutable_update_ok,
            "immutable_request_delete": immutable_delete_ok,
        },
        "lifecycle": {
            "recovered_running_tasks": recovered,
            "retry_attempt": retried["attempt"],
            "retry_lineage_preserved": retried["retry_of_task_id"] == first["id"],
            "new_job_per_retry": retried["job_id"] != first["job_id"],
            "request_idempotency": request_again["id"] == request["id"],
            "non_terminal_retry_rejected": non_terminal_retry_rejected,
            "duplicate_retry_rejected": duplicate_retry_rejected,
        },
        "security": {
            "prompt_plaintext_absent": prompt_absent,
            "secret_input_rejected": secret_rejected,
            "secret_sentinel_absent": secret_absent,
            "absolute_workspace_path_absent": absolute_path_absent,
        },
        "performance_ms": {
            "iterations": iterations,
            "prepare_p50": round(statistics.median(prepare_ms), 3),
            "prepare_p95": round(percentile(prepare_ms, 0.95), 3),
            "create_p50": round(statistics.median(create_ms), 3),
            "create_p95": round(percentile(create_ms, 0.95), 3),
            "acceptance_p95": 300.0,
        },
        "unverified": [
            "真实图片生成质量",
            "真实TTS音质与语义准确性",
            "真实Provider时延、费用、限流与错误适配",
            "视频生成",
            "Windows打包后的完整业务交互",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage4A isolated generation model prototype")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--iterations", type=int, default=200)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="stage4a-prototype-") as temp:
        report = run_prototype(Path(temp), args.iterations)
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    failed = (
        report["provider_call_count"] != 0
        or report["validation"]["accuracy_percent"] != 100.0
        or report["performance_ms"]["prepare_p95"] > 300
        or report["performance_ms"]["create_p95"] > 300
        or not all(report["security"].values())
        or not all(report["migration"].values())
        or not all(report["lifecycle"].values())
    )
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
