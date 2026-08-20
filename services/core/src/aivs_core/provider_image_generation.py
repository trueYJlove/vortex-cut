from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sqlite3
import stat
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .projects import DomainError, ProjectAssetService
from .provider_images import (
    ALLOWED_IMAGE_SIZES,
    IMAGE_ADAPTER_ID,
    IMAGE_MODEL,
    IMAGE_PROTOCOL_VERSION,
    IMAGE_PROVIDER_KIND,
    FailOnCallImageProvider,
    ImageProvider,
    PromptVault,
    ProviderImageError,
    ProviderImageRequest,
    validate_generated_image,
)
from .providers import ProviderError, ProviderSecretVault

EXECUTION_MODE = "provider_image_v1"
CAPABILITY = "image_text_to_image"
ENDPOINT_IDENTITY = "apikey_fun_images_generations"
OUTPUT_FORMAT = "png"
_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
ImageGenerationTransactionHook = Callable[[sqlite3.Connection, str, str, bool], None]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_value(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(value).encode()).hexdigest()


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def _id(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 128
        or any(character not in _ID_CHARS for character in value)
    ):
        raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", f"{field} 无效")
    return value


def _prompt(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 4000
        or any(ord(character) < 32 and character not in "\n\t" for character in value)
    ):
        raise DomainError("GENERATION_REQUEST_INVALID", "生成指令无效")
    return value


def _size(value: Any) -> str:
    if value not in ALLOWED_IMAGE_SIZES:
        raise DomainError("IMAGE_PROVIDER_UNSUPPORTED", "图片尺寸不受支持")
    return str(value)


class ImageProviderConfigService:
    """Persistent safe metadata plus process-only credentials."""

    def __init__(self, db: Database, secrets: ProviderSecretVault) -> None:
        self.db, self.secrets = db, secrets

    def create(self, project_id: Any, request: dict[str, Any]) -> dict[str, Any]:
        project = _id(project_id, "project_id")
        if set(request) != {"display_name", "enabled"}:
            raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", "图片 Provider 配置无效")
        name, enabled = request["display_name"], request["enabled"]
        price, price_2k, currency = 0.10, 0.15, "CNY"
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", "显示名称无效")
        if not isinstance(enabled, bool):
            raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", "图片 Provider 配置无效")
        config_id, now = new_id(), utc_now()
        with self.db.connection() as sql:
            if not sql.execute(
                "SELECT 1 FROM projects WHERE id=? AND status='active'", (project,)
            ).fetchone():
                raise DomainError("PROJECT_NOT_FOUND", "项目不存在或不可写")
            try:
                sql.execute(
                    "INSERT INTO image_provider_configs(id,project_id,provider_kind,adapter_id,"
                    "capability,protocol_version,display_name,model,enabled,price_per_image,"
                    "price_2k_per_image,price_currency,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        config_id,
                        project,
                        IMAGE_PROVIDER_KIND,
                        IMAGE_ADAPTER_ID,
                        CAPABILITY,
                        IMAGE_PROTOCOL_VERSION,
                        name.strip(),
                        IMAGE_MODEL,
                        int(enabled),
                        price,
                        price_2k,
                        currency,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise DomainError(
                    "IMAGE_PROVIDER_CONFIG_INVALID", "项目已配置图片 Provider"
                ) from exc
        return self.get(config_id)

    def list(self, project_id: Any) -> list[dict[str, Any]]:
        project = _id(project_id, "project_id")
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT * FROM image_provider_configs WHERE project_id=? AND provider_kind=? "
                "ORDER BY created_at DESC,id DESC",
                (project, IMAGE_PROVIDER_KIND),
            ).fetchall()
        return [self._public(row) for row in rows]

    def get(self, config_id: Any) -> dict[str, Any]:
        config = _id(config_id, "provider_config_id")
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM image_provider_configs WHERE id=? AND provider_kind=?",
                (config, IMAGE_PROVIDER_KIND),
            ).fetchone()
        if not row:
            raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", "图片 Provider 配置不存在")
        return self._public(row)

    def require_for_project(self, config_id: Any, project_id: Any) -> Any:
        config, project = _id(config_id, "provider_config_id"), _id(project_id, "project_id")
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT * FROM image_provider_configs WHERE id=? AND project_id=? "
                "AND provider_kind=? AND adapter_id=? AND model=?",
                (config, project, IMAGE_PROVIDER_KIND, IMAGE_ADAPTER_ID, IMAGE_MODEL),
            ).fetchone()
        if not row or not bool(row["enabled"]):
            raise DomainError("IMAGE_PROVIDER_CONFIG_INVALID", "图片 Provider 配置不可用")
        return row

    def set_secret(self, config_id: Any, secret: str) -> dict[str, Any]:
        config = self.get(config_id)
        try:
            self.secrets.set(config["provider_config_id"], secret)
        except ProviderError as exc:
            raise DomainError(
                "IMAGE_PROVIDER_CREDENTIAL_MISSING", "图片 Provider 凭据无效"
            ) from exc
        return {
            "provider_config_id": config["provider_config_id"],
            "credential_status": "configured",
        }

    def delete_secret(self, config_id: Any) -> None:
        config = self.get(config_id)
        self.secrets.delete(config["provider_config_id"])

    def _public(self, row: Any) -> dict[str, Any]:
        return {
            "provider_config_id": row["id"],
            "project_id": row["project_id"],
            "provider_kind": row["provider_kind"],
            "adapter_id": row["adapter_id"],
            "capability": row["capability"],
            "protocol_version": row["protocol_version"],
            "display_name": row["display_name"],
            "model": row["model"],
            "enabled": bool(row["enabled"]),
            "price_per_image": row["price_per_image"],
            "price_2k_per_image": row["price_2k_per_image"],
            "price_currency": row["price_currency"],
            "credential_status": self.secrets.status(row["id"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


class ProviderImageGenerationService:
    def __init__(
        self,
        db: Database,
        configs: ImageProviderConfigService,
        secrets: ProviderSecretVault,
        projects: ProjectAssetService,
        provider: ImageProvider | None = None,
        vault: PromptVault | None = None,
    ) -> None:
        self.db, self.configs, self.secrets, self.projects = db, configs, secrets, projects
        # Gate 4D-3 默认失败关闭；生产网络适配器由后续 Gate 单独注入。
        self.provider = provider or FailOnCallImageProvider()
        self.vault = vault or PromptVault(capacity=32)

    def prepare(
        self, project_id: Any, provider_config_id: Any, prompt: Any, size: Any
    ) -> dict[str, Any]:
        project = _id(project_id, "project_id")
        config = self.configs.require_for_project(provider_config_id, project)
        if self.secrets.status(config["id"]) != "configured":
            raise DomainError("IMAGE_PROVIDER_CREDENTIAL_MISSING", "图片 Provider 凭据尚未配置")
        text, requested_size = _prompt(prompt), _size(size)
        profile = self._profile(config, requested_size)
        facts = {
            "schema_version": 1,
            "project_id": project,
            "generation_kind": "image",
            "execution_mode": EXECUTION_MODE,
            "prompt_sha256": _sha256_text(text),
            "input_refs": [],
            "parameters": {"size": requested_size},
            "provider_config_id": config["id"],
            "provider_kind": profile["provider_kind"],
            "adapter_id": profile["adapter_id"],
            "protocol_version": profile["protocol_version"],
            "model": profile["model"],
            "endpoint_identity": profile["endpoint_identity"],
            "provider_profile_sha256": profile["provider_profile_sha256"],
        }
        facts["payload_sha256"] = _sha256_value(
            {
                "adapter_id": IMAGE_ADAPTER_ID,
                "model": IMAGE_MODEL,
                "n": 1,
                "prompt_sha256": facts["prompt_sha256"],
                "response_format": "b64_json",
                "size": requested_size,
                "stream": True,
            }
        )
        facts["request_sha256"] = self._request_hash(facts)
        preview_id = new_id()
        expires_at = (
            (datetime.now(UTC) + timedelta(minutes=5))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        self.vault.put(preview_id, text, facts, expires_at)
        return self._prepared(preview_id, facts, config, expires_at)

    def create(
        self, project_id: Any, preview_id: Any, payload_sha256: Any, confirmed: Any
    ) -> dict[str, Any]:
        return self.create_from_reserved_preview(project_id, preview_id, payload_sha256, confirmed)

    def create_from_reserved_preview(
        self,
        project_id: Any,
        preview_id: Any,
        payload_sha256: Any,
        confirmed: Any,
        transaction_hook: ImageGenerationTransactionHook | None = None,
    ) -> dict[str, Any]:
        """Create/reuse Stage 4D facts and run a local-only hook before commit."""
        project, preview = _id(project_id, "project_id"), _id(preview_id, "preview_id")
        if confirmed is not True or not isinstance(payload_sha256, str):
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "生成确认无效")
        reservation = self.vault.reserve(preview)
        facts = reservation.facts
        if facts["project_id"] != project or not hmac.compare_digest(
            facts["payload_sha256"], payload_sha256
        ):
            self.vault.release(preview)
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "生成确认不匹配")
        task_id = new_id()
        self.vault.transfer(preview, task_id)
        try:
            response = self._create_from_facts(facts, task_id, transaction_hook)
        except Exception:
            self.vault.reserve(task_id)
            self.vault.transfer(task_id, preview)
            raise
        if response["reused"]:
            self.vault.discard(task_id)
        return response

    def _create_from_facts(
        self,
        facts: dict[str, Any],
        task_id: str,
        transaction_hook: ImageGenerationTransactionHook | None = None,
    ) -> dict[str, Any]:
        request_id, job_id, invocation_id, now = new_id(), new_id(), new_id(), utc_now()
        reused = False
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                existing = sql.execute(
                    "SELECT id FROM media_generation_requests WHERE project_id=? "
                    "AND request_sha256=? AND execution_mode=?",
                    (facts["project_id"], facts["request_sha256"], EXECUTION_MODE),
                ).fetchone()
                if existing:
                    request_id = existing["id"]
                    task = sql.execute(
                        "SELECT * FROM media_generation_tasks WHERE request_id=? AND attempt=1",
                        (request_id,),
                    ).fetchone()
                    reused = task is not None
                else:
                    sql.execute(
                        "INSERT INTO media_generation_requests(id,project_id,generation_kind,"
                        "execution_mode,prompt_sha256,input_refs_json,parameters_json,"
                        "request_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            request_id,
                            facts["project_id"],
                            "image",
                            EXECUTION_MODE,
                            facts["prompt_sha256"],
                            "[]",
                            _canonical_json(facts["parameters"]),
                            facts["request_sha256"],
                            now,
                        ),
                    )
                    sql.execute(
                        "INSERT INTO provider_image_request_profiles(request_id,provider_config_id,"
                        "provider_kind,adapter_id,capability,protocol_version,model,endpoint_identity,"
                        "size,output_format,provider_profile_sha256,payload_sha256,confirmed_at,created_at) "  # noqa: E501
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            request_id,
                            facts["provider_config_id"],
                            IMAGE_PROVIDER_KIND,
                            IMAGE_ADAPTER_ID,
                            CAPABILITY,
                            IMAGE_PROTOCOL_VERSION,
                            IMAGE_MODEL,
                            ENDPOINT_IDENTITY,
                            facts["parameters"]["size"],
                            OUTPUT_FORMAT,
                            facts["provider_profile_sha256"],
                            facts["payload_sha256"],
                            now,
                            now,
                        ),
                    )
                if not reused:
                    self._insert_task(sql, request_id, task_id, job_id, now)
                    sql.execute(
                        "INSERT INTO provider_image_invocations("
                        "id,task_id,provider_config_id,status,"
                        "provider_call_count,provider_may_have_processed,estimated_cost,"
                        "estimated_cost_currency,price_tier,created_at,updated_at) "
                        "VALUES (?,?,?,'prepared',0,0,0.10,'CNY','1K',?,?)",
                        (invocation_id, task_id, facts["provider_config_id"], now, now),
                    )
                    task = sql.execute(
                        "SELECT * FROM media_generation_tasks WHERE id=?", (task_id,)
                    ).fetchone()
                if transaction_hook is not None:
                    transaction_hook(sql, request_id, task["id"], reused)
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
        now: str,
        attempt: int = 1,
        retry_of_task_id: str | None = None,
    ) -> None:
        safe_input = _canonical_json(
            {
                "media_generation_task_id": task_id,
                "request_id": request_id,
                "execution_mode": EXECUTION_MODE,
            }
        )
        sql.execute(
            "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
            "resource_class,attempt,created_at,updated_at) SELECT ?,project_id,"
            "'media_generation','media_generation','queued','queued',0,?,'network',?,?,? "
            "FROM media_generation_requests WHERE id=? AND execution_mode=?",
            (job_id, safe_input, attempt, now, now, request_id, EXECUTION_MODE),
        )
        if sql.execute("SELECT changes()").fetchone()[0] != 1:
            raise DomainError("GENERATION_REQUEST_INVALID", "真实图片请求不存在")
        sql.execute(
            "INSERT INTO media_generation_tasks(id,request_id,job_id,attempt,status,stage,"
            "retry_of_task_id,created_at,updated_at) VALUES (?,?,?,?,'queued','queued',?,?,?)",
            (task_id, request_id, job_id, attempt, retry_of_task_id, now, now),
        )

    def list(
        self, project_id: Any, limit: int = 50, cursor: str | None = None
    ) -> list[dict[str, Any]]:
        project = _id(project_id, "project_id")
        offset = self._offset(limit, cursor)
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT r.* FROM media_generation_requests r "
                "JOIN provider_image_request_profiles p "
                "ON p.request_id=r.id WHERE r.project_id=? AND r.execution_mode=? "
                "AND p.provider_kind=? "
                "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                (project, EXECUTION_MODE, IMAGE_PROVIDER_KIND, limit, offset),
            ).fetchall()
        return [self._request(row) for row in rows]

    def get(self, request_id: Any) -> dict[str, Any]:
        request = _id(request_id, "request_id")
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT r.* FROM media_generation_requests r "
                "JOIN provider_image_request_profiles p "
                "ON p.request_id=r.id WHERE r.id=? AND r.execution_mode=? AND p.provider_kind=?",
                (request, EXECUTION_MODE, IMAGE_PROVIDER_KIND),
            ).fetchone()
        if not row:
            raise DomainError("GENERATION_REQUEST_INVALID", "真实图片请求不存在")
        return self._request(row)

    def list_tasks(
        self, request_id: Any, limit: int = 50, cursor: str | None = None
    ) -> list[dict[str, Any]]:
        request = _id(request_id, "request_id")
        self.get(request)
        offset = self._offset(limit, cursor)
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT t.*,i.provider_call_count,i.provider_may_have_processed,"
                "i.estimated_cost,i.estimated_cost_currency,i.price_tier "
                "FROM media_generation_tasks t "
                "JOIN provider_image_invocations i ON i.task_id=t.id WHERE t.request_id=? "
                "ORDER BY t.attempt,t.created_at LIMIT ? OFFSET ?",
                (request, limit, offset),
            ).fetchall()
        return [self._task(row) for row in rows]

    def cancel(self, task_id: Any) -> dict[str, Any]:
        task, now = _id(task_id, "task_id"), utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                row = sql.execute(
                    "SELECT t.* FROM media_generation_tasks t JOIN media_generation_requests r "
                    "ON r.id=t.request_id WHERE t.id=? AND r.execution_mode=?",
                    (task, EXECUTION_MODE),
                ).fetchone()
                if not row:
                    raise DomainError("GENERATION_TASK_NOT_FOUND", "真实图片任务不存在")
                if row["status"] != "queued":
                    raise DomainError("JOB_INVALID_STATE", "仅排队中的真实图片任务可取消")
                sql.execute(
                    "UPDATE jobs SET status='cancelled',stage='cancelled',finished_at=?,updated_at=? "  # noqa: E501
                    "WHERE id=? AND status='queued'",
                    (now, now, row["job_id"]),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise DomainError("JOB_INVALID_STATE", "真实图片任务状态已变化")
                sql.execute(
                    "UPDATE media_generation_tasks SET status='cancelled',stage='cancelled',"
                    "error_code='JOB_CANCELLED',error_message='任务已取消',"
                    "finished_at=?,updated_at=? WHERE id=?",
                    (now, now, task),
                )
                sql.execute(
                    "UPDATE provider_image_invocations SET status='cancelled',"
                    "error_code='JOB_CANCELLED',error_message='任务已取消',finished_at=?,updated_at=? "  # noqa: E501
                    "WHERE task_id=? AND status='prepared'",
                    (now, now, task),
                )
                result = sql.execute(
                    "SELECT * FROM media_generation_tasks WHERE id=?", (task,)
                ).fetchone()
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        self.vault.discard(task)
        return self._task(result)

    def recover_interrupted_tasks(self) -> int:
        now, recovered = utc_now(), 0
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                rows = sql.execute(
                    "SELECT t.id,t.job_id FROM media_generation_tasks t JOIN media_generation_requests r "  # noqa: E501
                    "ON r.id=t.request_id JOIN jobs j ON j.id=t.job_id WHERE r.execution_mode=? "
                    "AND (t.status='running' OR j.status IN ('running','cancelling'))",
                    (EXECUTION_MODE,),
                ).fetchall()
                for row in rows:
                    sql.execute(
                        "UPDATE jobs SET status='interrupted',stage='interrupted',progress=0,"
                        "error_code='GENERATION_INTERRUPTED',error_message='Core 重启前真实图片任务未完成',"  # noqa: E501
                        "finished_at=?,updated_at=? WHERE id=? AND status IN ('queued','running','cancelling')",  # noqa: E501
                        (now, now, row["job_id"]),
                    )
                    sql.execute(
                        "UPDATE media_generation_tasks SET status='interrupted',stage='interrupted',"  # noqa: E501
                        "error_code='GENERATION_INTERRUPTED',error_message='Core 重启前真实图片任务未完成',"  # noqa: E501
                        "finished_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
                        (now, now, row["id"]),
                    )
                    sql.execute(
                        "UPDATE provider_image_invocations SET status='interrupted',"
                        "error_code=COALESCE(error_code,'GENERATION_INTERRUPTED'),"
                        "error_message=COALESCE(error_message,'Core 重启前真实图片任务未完成'),"
                        "finished_at=COALESCE(finished_at,?),updated_at=? WHERE task_id=? "
                        "AND status IN ('prepared','running')",
                        (now, now, row["id"]),
                    )
                    recovered += 1
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise
        self.vault.clear()
        return recovered

    def prepare_retry(self, task_id: Any, prompt: Any) -> dict[str, Any]:
        task = _id(task_id, "task_id")
        text = _prompt(prompt)
        with self.db.connection() as sql:
            row = sql.execute(
                "SELECT t.*,r.project_id,r.prompt_sha256,p.provider_config_id,p.size,"
                "p.payload_sha256,p.provider_profile_sha256,p.provider_kind,p.adapter_id,"
                "p.protocol_version,p.model,p.endpoint_identity,i.provider_may_have_processed "
                "FROM media_generation_tasks t JOIN media_generation_requests r ON r.id=t.request_id "  # noqa: E501
                "JOIN provider_image_request_profiles p ON p.request_id=r.id "
                "JOIN provider_image_invocations i ON i.task_id=t.id "
                "WHERE t.id=? AND r.execution_mode=?",
                (task, EXECUTION_MODE),
            ).fetchone()
            child = sql.execute(
                "SELECT 1 FROM media_generation_tasks WHERE retry_of_task_id=?", (task,)
            ).fetchone()
        if not row:
            raise DomainError("GENERATION_TASK_NOT_FOUND", "真实图片任务不存在")
        if row["status"] not in {"failed", "cancelled", "interrupted"} or child:
            raise DomainError("GENERATION_RETRY_NOT_ALLOWED", "当前真实图片任务不可重试")
        if (
            row["provider_kind"] != IMAGE_PROVIDER_KIND
            or row["adapter_id"] != IMAGE_ADAPTER_ID
            or row["protocol_version"] != IMAGE_PROTOCOL_VERSION
            or row["model"] != IMAGE_MODEL
            or row["endpoint_identity"] != ENDPOINT_IDENTITY
            or row["size"] not in ALLOWED_IMAGE_SIZES
        ):
            raise DomainError(
                "GENERATION_RETRY_NOT_ALLOWED", "历史 Provider 请求不可由当前适配器重试"
            )
        if not hmac.compare_digest(row["prompt_sha256"], _sha256_text(text)):
            raise DomainError("GENERATION_PROMPT_HASH_MISMATCH", "生成指令与原请求不匹配")
        config = self.configs.require_for_project(row["provider_config_id"], row["project_id"])
        if self.secrets.status(config["id"]) != "configured":
            raise DomainError("IMAGE_PROVIDER_CREDENTIAL_MISSING", "图片 Provider 凭据尚未配置")
        facts = {
            "project_id": row["project_id"],
            "request_id": row["request_id"],
            "retry_of_task_id": task,
            "prompt_sha256": row["prompt_sha256"],
            "provider_config_id": row["provider_config_id"],
            "provider_profile_sha256": row["provider_profile_sha256"],
            "payload_sha256": row["payload_sha256"],
            "parameters": {"size": row["size"]},
            "provider_kind": row["provider_kind"],
            "adapter_id": row["adapter_id"],
            "protocol_version": row["protocol_version"],
            "model": row["model"],
            "endpoint_identity": row["endpoint_identity"],
            "attempt": int(row["attempt"]) + 1,
        }
        preview_id = new_id()
        expires_at = (
            (datetime.now(UTC) + timedelta(minutes=5))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        self.vault.put(preview_id, text, facts, expires_at)
        result = self._prepared(preview_id, facts, config, expires_at)
        result.update(
            {
                "retry_of_task_id": task,
                "attempt": facts["attempt"],
                "provider_may_have_processed": bool(row["provider_may_have_processed"]),
            }
        )
        return result

    def retry(
        self, task_id: Any, preview_id: Any, payload_sha256: Any, confirmed: Any
    ) -> dict[str, Any]:
        parent, preview = _id(task_id, "task_id"), _id(preview_id, "preview_id")
        if confirmed is not True or not isinstance(payload_sha256, str):
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "重试确认无效")
        reservation = self.vault.reserve(preview)
        facts = reservation.facts
        if facts.get("retry_of_task_id") != parent or not hmac.compare_digest(
            facts["payload_sha256"], payload_sha256
        ):
            self.vault.release(preview)
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "重试确认不匹配")
        task_id_new, job_id, invocation_id, now = new_id(), new_id(), new_id(), utc_now()
        self.vault.transfer(preview, task_id_new)
        try:
            with self.db.connection() as sql:
                sql.execute("BEGIN IMMEDIATE")
                try:
                    row = sql.execute(
                        "SELECT status,request_id FROM media_generation_tasks WHERE id=?", (parent,)
                    ).fetchone()
                    child = sql.execute(
                        "SELECT 1 FROM media_generation_tasks WHERE retry_of_task_id=?", (parent,)
                    ).fetchone()
                    if (
                        not row
                        or row["status"] not in {"failed", "cancelled", "interrupted"}
                        or child
                        or row["request_id"] != facts["request_id"]
                    ):
                        raise DomainError(
                            "GENERATION_RETRY_NOT_ALLOWED", "当前真实图片任务不可重试"
                        )
                    self._insert_task(
                        sql, facts["request_id"], task_id_new, job_id, now, facts["attempt"], parent
                    )
                    sql.execute(
                        "INSERT INTO provider_image_invocations(id,task_id,provider_config_id,status,"  # noqa: E501
                        "provider_call_count,provider_may_have_processed,estimated_cost,"
                        "estimated_cost_currency,price_tier,created_at,updated_at) "
                        "VALUES (?,?,?,'prepared',0,0,0.10,'CNY','1K',?,?)",
                        (invocation_id, task_id_new, facts["provider_config_id"], now, now),
                    )
                    result = sql.execute(
                        "SELECT * FROM media_generation_tasks WHERE id=?", (task_id_new,)
                    ).fetchone()
                    sql.execute("COMMIT")
                except Exception:
                    sql.execute("ROLLBACK")
                    raise
        except Exception:
            self.vault.reserve(task_id_new)
            self.vault.transfer(task_id_new, preview)
            raise
        return self._task(result)

    def start_job(self, job_id: str) -> None:
        now = utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                task = sql.execute(
                    "SELECT t.id,t.status,i.status invocation_status FROM media_generation_tasks t "
                    "JOIN provider_image_invocations i ON i.task_id=t.id WHERE t.job_id=?",
                    (job_id,),
                ).fetchone()
                if (
                    not task
                    or task["status"] != "queued"
                    or task["invocation_status"] != "prepared"
                ):
                    raise DomainError("GENERATION_REQUEST_INVALID", "真实图片任务状态无效")
                reservation = self.vault.reserve(task["id"])
                self.vault.release(task["id"])
                del reservation
                sql.execute(
                    "UPDATE jobs SET status='running',stage='preparing_provider',started_at=?,"
                    "updated_at=? WHERE id=? AND status='queued'",
                    (now, now, job_id),
                )
                sql.execute(
                    "UPDATE media_generation_tasks SET status='running',stage='preparing_provider',"
                    "updated_at=? WHERE id=? AND status='queued'",
                    (now, task["id"]),
                )
                sql.execute(
                    "UPDATE provider_image_invocations SET status='running',started_at=?,updated_at=? "  # noqa: E501
                    "WHERE task_id=? AND status='prepared'",
                    (now, now, task["id"]),
                )
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise

    async def run(
        self, row: Any, cancel_event: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        del progress
        payload = json_loads(row["input_json"])
        task_id = _id(payload.get("media_generation_task_id"), "task_id")
        reservation = self.vault.reserve(task_id)
        facts = reservation.facts
        try:
            if (
                facts.get("provider_kind") != IMAGE_PROVIDER_KIND
                or facts.get("adapter_id") != IMAGE_ADAPTER_ID
                or facts.get("protocol_version") != IMAGE_PROTOCOL_VERSION
                or facts.get("model") != IMAGE_MODEL
                or facts.get("endpoint_identity") != ENDPOINT_IDENTITY
                or facts["parameters"]["size"] not in ALLOWED_IMAGE_SIZES
            ):
                raise ProviderImageError(
                    "IMAGE_PROVIDER_PROFILE_MISMATCH", "图片 Provider 协议不匹配"
                )
            if cancel_event.is_set():
                raise ProviderImageError("JOB_CANCELLED", "任务已取消")
            try:
                api_key = self.secrets.for_request(facts["provider_config_id"])
            except ProviderError as exc:
                raise ProviderImageError(
                    "IMAGE_PROVIDER_CREDENTIAL_MISSING", "图片 Provider 凭据尚未配置"
                ) from exc
            self._set_task_stage(task_id, "calling_provider")
            stage("calling_provider")
            result = await self.provider.generate(
                ProviderImageRequest(
                    reservation.prompt, facts["parameters"]["size"], api_key, task_id
                ),
                cancel_event,
                lambda: self._mark_dispatched(task_id),
            )
        finally:
            self.vault.commit(task_id)
        self._set_task_stage(task_id, "validating_output")
        stage("validating_output")
        validated = validate_generated_image(result.content, facts["parameters"]["size"])
        if validated["format"] != OUTPUT_FORMAT:
            raise ProviderImageError(
                "GENERATED_IMAGE_FORMAT_UNSUPPORTED", "Provider 未返回 PNG 图片", True
            )
        if cancel_event.is_set():
            raise ProviderImageError("JOB_CANCELLED", "任务已取消", True)
        return self._publish(task_id, result, validated)

    def _mark_dispatched(self, task_id: str) -> None:
        with self.db.connection() as sql:
            sql.execute(
                "UPDATE provider_image_invocations SET provider_call_count=1,"
                "provider_may_have_processed=1,updated_at=? WHERE task_id=? AND status='running' "
                "AND provider_call_count=0",
                (utc_now(), task_id),
            )
            if sql.execute("SELECT changes()").fetchone()[0] != 1:
                raise ProviderImageError(
                    "IMAGE_PROVIDER_CALL_ALREADY_DISPATCHED", "图片调用边界已越过", True
                )

    def _set_task_stage(self, task_id: str, value: str) -> None:
        with self.db.connection() as sql:
            sql.execute(
                "UPDATE media_generation_tasks SET stage=?,updated_at=? WHERE id=? AND status='running'",  # noqa: E501
                (value, utc_now(), task_id),
            )

    def _publish(
        self, task_id: str, provider_result: Any, validated: dict[str, Any]
    ) -> dict[str, Any]:
        with self.db.connection() as sql:
            facts = sql.execute(
                "SELECT t.request_id,r.project_id,r.prompt_sha256,p.provider_kind,p.adapter_id,"
                "p.protocol_version,p.model,p.provider_profile_sha256,i.id invocation_id,"
                "c.price_per_image,c.price_currency FROM media_generation_tasks t "
                "JOIN media_generation_requests r ON r.id=t.request_id "
                "JOIN provider_image_request_profiles p ON p.request_id=r.id "
                "JOIN provider_image_invocations i ON i.task_id=t.id "
                "JOIN image_provider_configs c ON c.id=i.provider_config_id WHERE t.id=?",
                (task_id,),
            ).fetchone()
            project = (
                sql.execute(
                    "SELECT root_dir FROM projects WHERE id=?", (facts["project_id"],)
                ).fetchone()
                if facts
                else None
            )
        if not facts or not project:
            raise ProviderImageError("GENERATED_ASSET_REGISTER_FAILED", "生成素材注册失败", True)
        root = Path(project["root_dir"]).resolve()
        target_dir = (root / "generated" / "image").resolve()
        tmp_dir = (target_dir / ".tmp").resolve()
        if target_dir.parent != (root / "generated").resolve() or tmp_dir.parent != target_dir:
            raise ProviderImageError("GENERATED_ASSET_REGISTER_FAILED", "生成素材目录无效", True)
        target_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(exist_ok=True)
        asset_id, provenance_id = new_id(), new_id()
        part, final = tmp_dir / f"{task_id}.part", target_dir / f"{asset_id}.png"
        try:
            part.write_bytes(provider_result.content)
            if part.stat().st_size != validated["size_bytes"]:
                raise ProviderImageError("GENERATED_IMAGE_WRITE_FAILED", "生成图片写入失败", True)
            os.replace(part, final)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        now = utc_now()
        estimated_cost = (
            float(facts["price_per_image"]) if facts["price_per_image"] is not None else None
        )
        asset = None
        try:
            with self.db.connection() as sql:
                sql.execute("BEGIN IMMEDIATE")
                try:
                    asset = self.projects.insert_generated_image_in_transaction(
                        sql,
                        facts["project_id"],
                        asset_id,
                        final,
                        validated["sha256"],
                        {
                            "format": "png",
                            "width": validated["width"],
                            "height": validated["height"],
                        },
                        f"生成图片 {datetime.now().strftime('%Y-%m-%d')}",
                        now,
                    )
                    sql.execute(
                        "INSERT INTO generated_asset_provenance(id,asset_id,request_id,task_id,"
                        "invocation_id,prompt_sha256,provider_kind,adapter_id,protocol_version,model,"
                        "provider_profile_sha256,provider_response_sha256,output_sha256,created_at) "  # noqa: E501
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            provenance_id,
                            asset_id,
                            facts["request_id"],
                            task_id,
                            facts["invocation_id"],
                            facts["prompt_sha256"],
                            facts["provider_kind"],
                            facts["adapter_id"],
                            facts["protocol_version"],
                            facts["model"],
                            facts["provider_profile_sha256"],
                            provider_result.response_sha256,
                            validated["sha256"],
                            now,
                        ),
                    )
                    sql.execute(
                        "UPDATE provider_image_invocations SET provider_request_id=?,usage_json=?,"
                        "estimated_cost=?,estimated_cost_currency=?,price_tier='1K',provider_response_sha256=?,validated_format='png',"
                        "validated_width=?,validated_height=?,validated_size_bytes=?,output_sha256=?,"
                        "updated_at=? WHERE task_id=? AND status='running' AND provider_call_count=1",  # noqa: E501
                        (
                            provider_result.provider_request_id,
                            json_dumps(provider_result.usage) if provider_result.usage else None,
                            estimated_cost,
                            facts["price_currency"],
                            provider_result.response_sha256,
                            validated["width"],
                            validated["height"],
                            validated["size_bytes"],
                            validated["sha256"],
                            now,
                            task_id,
                        ),
                    )
                    if sql.execute("SELECT changes()").fetchone()[0] != 1:
                        raise ProviderImageError(
                            "GENERATION_OUTPUT_INVALID", "生成调用状态无效", True
                        )
                    sql.execute("COMMIT")
                except Exception:
                    sql.execute("ROLLBACK")
                    raise
        except Exception as exc:
            try:
                final.unlink()
            except OSError:
                relative = final.relative_to(root).as_posix()
                with self.db.connection() as sql:
                    sql.execute(
                        "UPDATE provider_image_invocations SET cleanup_required=1,"
                        "output_relative_path=?,updated_at=? WHERE task_id=? AND status='running'",
                        (relative, utc_now(), task_id),
                    )
            if isinstance(exc, ProviderImageError):
                raise
            if isinstance(exc, DomainError):
                raise ProviderImageError(exc.code, exc.message, True) from exc
            raise ProviderImageError(
                "GENERATED_ASSET_REGISTER_FAILED", "生成素材注册失败", True
            ) from exc
        return {
            "execution_mode": EXECUTION_MODE,
            "provider_call_count": 1,
            "asset": {
                "asset_id": asset["asset_id"],
                "display_name": asset["display_name"],
                "kind": asset["kind"],
                "storage_mode": asset["storage_mode"],
                "availability": asset["availability"],
            },
            "output": {
                "format": "png",
                "width": validated["width"],
                "height": validated["height"],
                "size_bytes": validated["size_bytes"],
                "sha256": validated["sha256"],
            },
            "provider": {
                "kind": facts["provider_kind"],
                "adapter_id": facts["adapter_id"],
                "model": facts["model"],
            },
            "estimated_cost": estimated_cost,
            "estimated_cost_currency": facts["price_currency"],
            "price_tier": "1K",
            "provenance_id": provenance_id,
        }

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
        now, terminal_stage = utc_now(), "completed" if status == "succeeded" else status
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                row = sql.execute(
                    "SELECT t.id,i.provider_call_count,i.cleanup_required FROM media_generation_tasks t "  # noqa: E501
                    "JOIN provider_image_invocations i ON i.task_id=t.id WHERE t.job_id=?",
                    (job_id,),
                ).fetchone()
                if not row:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                if status == "succeeded":
                    if not result or row["provider_call_count"] != 1 or row["cleanup_required"]:
                        raise RuntimeError("GENERATION_OUTPUT_INVALID")
                    asset_id, output_hash = result["asset"]["asset_id"], result["output"]["sha256"]
                else:
                    asset_id, output_hash, result = None, None, None
                code = "GENERATION_INTERRUPTED" if status == "interrupted" else error_code
                message = (
                    "Core 重启前真实图片任务未完成" if status == "interrupted" else error_message
                )
                sql.execute(
                    "UPDATE jobs SET status=?,stage=?,progress=?,result_json=?,error_code=?,"
                    "error_message=?,worker_pid=NULL,finished_at=?,updated_at=? WHERE id=? "
                    "AND status IN ('running','cancelling')",
                    (
                        status,
                        terminal_stage,
                        1 if status == "succeeded" else 0,
                        json_dumps(result) if result else None,
                        code,
                        message,
                        now,
                        now,
                        job_id,
                    ),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                sql.execute(
                    "UPDATE media_generation_tasks SET status=?,stage=?,output_asset_id=?,"
                    "output_sha256=?,result_summary_json=?,error_code=?,error_message=?,"
                    "finished_at=?,updated_at=? WHERE id=? AND status='running'",
                    (
                        status,
                        terminal_stage,
                        asset_id,
                        output_hash,
                        json_dumps(result) if result else None,
                        code,
                        message,
                        now,
                        now,
                        row["id"],
                    ),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                sql.execute(
                    "UPDATE provider_image_invocations SET status=?,error_code=?,error_message=?,"
                    "finished_at=?,updated_at=? WHERE task_id=? AND status='running'",
                    (status, code, message, now, now, row["id"]),
                )
                if sql.execute("SELECT changes()").fetchone()[0] != 1:
                    raise RuntimeError("GENERATION_OUTPUT_INVALID")
                sql.execute("COMMIT")
            except Exception:
                sql.execute("ROLLBACK")
                raise

    def cleanup_orphans(self) -> int:
        """Delete only Stage 4D-owned final/part files below fixed project directories."""
        cleaned = 0
        with self.db.connection() as sql:
            rows = sql.execute(
                "SELECT i.task_id,i.output_relative_path,r.project_id,p.root_dir "
                "FROM provider_image_invocations i "
                "JOIN media_generation_tasks t ON t.id=i.task_id "
                "JOIN media_generation_requests r ON r.id=t.request_id "
                "JOIN projects p ON p.id=r.project_id "
                "WHERE i.cleanup_required=1 AND r.execution_mode=?",
                (EXECUTION_MODE,),
            ).fetchall()
            for row in rows:
                output = self._cleanup_final_path(
                    Path(row["root_dir"]), row["output_relative_path"]
                )
                if output is None or self._path_is_reparse(output):
                    continue
                try:
                    output.unlink(missing_ok=True)
                except OSError:
                    continue
                sql.execute(
                    "UPDATE provider_image_invocations SET cleanup_required=0,"
                    "output_relative_path=NULL,updated_at=? WHERE task_id=? AND cleanup_required=1",
                    (utc_now(), row["task_id"]),
                )
                cleaned += 1

            projects = sql.execute(
                "SELECT DISTINCT p.id,p.root_dir FROM projects p "
                "JOIN media_generation_requests r ON r.project_id=p.id "
                "WHERE r.execution_mode=?",
                (EXECUTION_MODE,),
            ).fetchall()
            for project in projects:
                known_tasks = {
                    row["id"]
                    for row in sql.execute(
                        "SELECT t.id FROM media_generation_tasks t "
                        "JOIN media_generation_requests r ON r.id=t.request_id "
                        "WHERE r.project_id=? AND r.execution_mode=?",
                        (project["id"], EXECUTION_MODE),
                    ).fetchall()
                }
                cleaned += self._cleanup_part_files(Path(project["root_dir"]), known_tasks)
        return cleaned

    @classmethod
    def _cleanup_final_path(cls, project_root: Path, relative_value: Any) -> Path | None:
        if not isinstance(relative_value, str):
            return None
        relative = PurePosixPath(relative_value)
        if relative.is_absolute() or len(relative.parts) != 3:
            return None
        if relative.parts[:2] != ("generated", "image"):
            return None
        filename = relative.parts[2]
        if not filename.endswith(".png") or not cls._valid_file_id(filename[:-4]):
            return None
        root = project_root.resolve()
        generated = root / "generated"
        target = generated / "image"
        if cls._path_is_reparse(generated) or cls._path_is_reparse(target):
            return None
        return target / filename

    @classmethod
    def _cleanup_part_files(cls, project_root: Path, known_tasks: set[str]) -> int:
        root = project_root.resolve()
        generated = root / "generated"
        target = generated / "image"
        temporary = target / ".tmp"
        if any(cls._path_is_reparse(path) for path in (generated, target, temporary)):
            return 0
        if not temporary.is_dir():
            return 0
        cleaned = 0
        try:
            candidates = list(temporary.iterdir())
        except OSError:
            return 0
        for candidate in candidates:
            name = candidate.name
            if not name.endswith(".part"):
                continue
            task_id = name[:-5]
            if task_id not in known_tasks or not cls._valid_file_id(task_id):
                continue
            if cls._path_is_reparse(candidate) or not candidate.is_file():
                continue
            try:
                candidate.unlink()
            except OSError:
                continue
            cleaned += 1
        return cleaned

    @staticmethod
    def _valid_file_id(value: str) -> bool:
        return 1 <= len(value) <= 128 and all(character in _ID_CHARS for character in value)

    @staticmethod
    def _path_is_reparse(path: Path) -> bool:
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
        except OSError:
            return True
        attributes = getattr(info, "st_file_attributes", 0)
        return stat.S_ISLNK(info.st_mode) or bool(
            attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        )

    @staticmethod
    def _offset(limit: int, cursor: str | None) -> int:
        try:
            offset = int(cursor or 0)
        except (TypeError, ValueError) as exc:
            raise DomainError("GENERATION_REQUEST_INVALID", "分页参数无效") from exc
        if not 1 <= limit <= 100 or offset < 0 or (cursor is not None and not cursor.isdecimal()):
            raise DomainError("GENERATION_REQUEST_INVALID", "分页参数无效")
        return offset

    @staticmethod
    def _profile(config: Any, size: str) -> dict[str, Any]:
        profile = {
            "provider_config_id": config["id"],
            "provider_kind": IMAGE_PROVIDER_KIND,
            "adapter_id": IMAGE_ADAPTER_ID,
            "capability": CAPABILITY,
            "protocol_version": IMAGE_PROTOCOL_VERSION,
            "model": IMAGE_MODEL,
            "endpoint_identity": ENDPOINT_IDENTITY,
            "size": size,
            "output_format": OUTPUT_FORMAT,
            "transport": "sse",
            "response_format": "b64_json",
            "stream": True,
        }
        profile["provider_profile_sha256"] = _sha256_value(profile)
        return profile

    @staticmethod
    def _request_hash(facts: dict[str, Any]) -> str:
        return _sha256_value(
            {
                key: facts[key]
                for key in (
                    "schema_version",
                    "project_id",
                    "generation_kind",
                    "execution_mode",
                    "prompt_sha256",
                    "input_refs",
                    "parameters",
                    "provider_profile_sha256",
                )
            }
        )

    @staticmethod
    def _prepared(
        preview_id: str, facts: dict[str, Any], config: Any, expires_at: str
    ) -> dict[str, Any]:
        price = config["price_per_image"]
        return {
            "preview_id": preview_id,
            "project_id": facts["project_id"],
            "execution_mode": EXECUTION_MODE,
            "prompt_sha256": facts["prompt_sha256"],
            "payload_sha256": facts["payload_sha256"],
            "size": facts["parameters"]["size"],
            "output_format": OUTPUT_FORMAT,
            "image_count": 1,
            "provider": {
                "provider_config_id": config["id"],
                "provider_kind": config["provider_kind"],
                "adapter_id": config["adapter_id"],
                "model": config["model"],
            },
            "estimated_cost": float(price) if price is not None else None,
            "estimated_cost_currency": config["price_currency"],
            "price_tier": "1K",
            "expires_at": expires_at,
        }

    @staticmethod
    def _request(row: Any) -> dict[str, Any]:
        return {
            "request_id": row["id"],
            "project_id": row["project_id"],
            "generation_kind": row["generation_kind"],
            "execution_mode": row["execution_mode"],
            "prompt_sha256": row["prompt_sha256"],
            "parameters": json_loads(row["parameters_json"]),
            "request_sha256": row["request_sha256"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _task(row: Any) -> dict[str, Any]:
        keys = set(row.keys())
        return {
            "task_id": row["id"],
            "request_id": row["request_id"],
            "job_id": row["job_id"],
            "attempt": int(row["attempt"]),
            "status": row["status"],
            "stage": row["stage"],
            "retry_of_task_id": row["retry_of_task_id"],
            "provider_call_count": int(row["provider_call_count"])
            if "provider_call_count" in keys
            else 0,
            "provider_may_have_processed": bool(row["provider_may_have_processed"])
            if "provider_may_have_processed" in keys
            else False,
            "estimated_cost": row["estimated_cost"] if "estimated_cost" in keys else None,
            "estimated_cost_currency": row["estimated_cost_currency"]
            if "estimated_cost_currency" in keys
            else "CNY",
            "price_tier": row["price_tier"] if "price_tier" in keys else "1K",
            "output_asset_id": row["output_asset_id"],
            "output_sha256": row["output_sha256"],
            "result_summary": json_loads(row["result_summary_json"])
            if row["result_summary_json"]
            else None,
            "error": {"code": row["error_code"], "message": row["error_message"]}
            if row["error_code"]
            else None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
        }
