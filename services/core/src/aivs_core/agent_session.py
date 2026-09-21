from __future__ import annotations

import asyncio
import hashlib
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .planning import ProviderRepository, canonical_json, invocation_cost, sha256
from .projects import DomainError
from .providers import (
    ProviderSecretVault,
    StructuredTextRequest,
    TextReasoningProvider,
    OpenAICompatibleTextProvider,
)
from .timeline import TimelineService, timeline_diff
from .timeline_planning import (
    GenerationPayloadStore,
    PendingTimelinePatchEgressStore,
    _expired,
)

# AI-1（ADR-0003 D2 / AI_1_AGENT_SESSION_PLANNING_GATE）：Stage 2B 单发提案
# 升级为有界多步循环。设计要点（Planning Gate §2 裁决）：
# - 一个会话 = 一次 consent（会话级 preview 明示多轮反馈字段；触发器保证
#   只能消费一次，覆盖整个循环）；
# - 每步都是独立单轮调用（provider 端无对话历史），失败反馈由 Core 侧
#   裁剪后注入下一步 payload；
# - 每步成功即落不可变 Revision（会话轨迹 = Revision 链，任意步可 Undo），
#   下一步从新基线投影；
# - 双闸门：步数上限（会话创建时钉死，1-6）+ 会话级 token 预算
#   （provider_invocations usage 聚合）；
# - 会话内基线推进合法；跨步外部并发修改 → AGENT_SESSION_BASE_DRIFT 中止。
MAX_SESSION_STEPS = 6
SESSION_TOKEN_BUDGET = 200_000
SESSION_PREVIEW_TTL_MINUTES = 30
# 反馈历史注入预算（字符）：保留最近 K 步失败反馈，更早的丢弃（K=2）。
FEEDBACK_KEEP_STEPS = 2
FEEDBACK_CHARS_PER_STEP = 1200

AGENT_SESSION_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")

AGENT_SESSION_ERROR_CODES = {
    "AGENT_SESSION_INVALID",
    "AGENT_SESSION_NOT_FOUND",
    "AGENT_SESSION_ALREADY_ACTIVE",
    "AGENT_SESSION_EGRESS_EXPIRED",
    "AGENT_SESSION_EGRESS_MISMATCH",
    "AGENT_SESSION_PROVIDER_UNTESTED",
    "AGENT_SESSION_PROVIDER_UNSUPPORTED",
    "AGENT_SESSION_STEP_LIMIT",
    "AGENT_SESSION_BUDGET_EXCEEDED",
    "AGENT_SESSION_BASE_DRIFT",
}


def _structured_failure(exc: BaseException) -> dict[str, Any] | None:
    """从 apply_in_memory 的 __cause__ 提取 op 级结构化失败（AI-1-2）。"""
    cause = getattr(exc, "__cause__", None)
    if (
        isinstance(cause, ValueError)
        and cause.args
        and isinstance(cause.args[0], dict)
        and "operation_index" in cause.args[0]
    ):
        return dict(cause.args[0])
    return None


class AgentSessionService:
    def __init__(
        self,
        db: Database,
        providers: ProviderRepository,
        vault: ProviderSecretVault,
        timelines: TimelineService,
        provider_factory: Any = OpenAICompatibleTextProvider,
        pending_store: PendingTimelinePatchEgressStore | None = None,
        session_store: GenerationPayloadStore | None = None,
        emit: Any = None,
    ) -> None:
        self.db = db
        self.providers = providers
        self.vault = vault
        self.timelines = timelines
        self.provider_factory = provider_factory
        self.pending_store = pending_store or PendingTimelinePatchEgressStore()
        self.session_store = session_store or GenerationPayloadStore()
        self.emit = emit

    # ------------------------------------------------------------------
    # 三段式入口：prepare（预览）→ create_session（确认 + 排队）
    # ------------------------------------------------------------------

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "provider_config_id", "instruction"}:
            raise DomainError("AGENT_SESSION_INVALID", "会话准备请求无效")
        instruction = request["instruction"]
        if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 4000:
            raise DomainError("AGENT_SESSION_INVALID", "会话指令无效")
        provider = self._provider_with_capability(request["provider_config_id"])
        if not provider["enabled"]:
            raise DomainError("AGENT_SESSION_INVALID", "Provider 未启用")
        if provider["timeline_patch_capability_status"] == "untested":
            raise DomainError(
                "AGENT_SESSION_PROVIDER_UNTESTED", "Provider 尚未通过能力测试"
            )
        if provider["timeline_patch_capability_status"] != "supported":
            raise DomainError(
                "AGENT_SESSION_PROVIDER_UNSUPPORTED", "Provider 不支持严格 TimelinePatch 输出"
            )
        with self.db.connection() as db:
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != request["base_revision_id"]:
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "Timeline 基线已变化")
            revision = self.timelines._revision(db, request["base_revision_id"])
        payload = self._step_payload(
            instruction.strip(), revision["document"], feedback=None
        )
        payload_hash, now = sha256(payload), utc_now()
        expires_at = (
            (datetime.now(UTC) + timedelta(minutes=SESSION_PREVIEW_TTL_MINUTES))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        provider_snapshot = {
            key: provider[key]
            for key in (
                "provider_config_id",
                "display_name",
                "base_url",
                "model",
                "enabled",
                "credential_status",
                "timeline_patch_capability_status",
                "timeline_patch_response_adapter_id",
                "timeline_patch_probe_protocol_version",
                "timeline_patch_capability_tested_at",
                "timeline_patch_capability_failure_code",
                "timeline_patch_capability_probe_sha256",
            )
        }
        preview_id = f"agent_session_preview_{new_id()}"
        stats = {
            "character_count": len(canonical_json(payload)),
            "estimated_tokens": max(1, len(canonical_json(payload)) // 4),
            "clip_count": len(revision["document"]["clips"]),
            "caption_count": len(revision["document"]["captions"]),
            "locked_count": len(revision["document"].get("locked_elements", [])),
            "max_steps": MAX_SESSION_STEPS,
            "token_budget": SESSION_TOKEN_BUDGET,
        }
        self.pending_store.put(
            preview_id,
            {
                "project_id": project_id,
                "provider_config_id": provider["provider_config_id"],
                "base_revision_id": revision["timeline_revision_id"],
                "base_document_sha256": revision["document_sha256"],
                "provider_config_sha256": sha256(provider_snapshot),
                "payload_sha256": payload_hash,
                "instruction": instruction.strip(),
                "expires_at": expires_at,
                "response_adapter_id": provider["timeline_patch_response_adapter_id"],
            },
        )
        with self.db.connection() as db:
            try:
                db.execute(
                    "INSERT INTO agent_session_egress_previews(id,project_id,provider_config_id,base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,payload_sha256,stats_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        preview_id,
                        project_id,
                        provider["provider_config_id"],
                        revision["timeline_revision_id"],
                        revision["document_sha256"],
                        json_dumps(provider_snapshot),
                        sha256(provider_snapshot),
                        payload_hash,
                        json_dumps(stats),
                        expires_at,
                        now,
                    ),
                )
            except Exception:
                self.pending_store.discard(preview_id)
                raise
        return {
            "agent_session_egress_preview_id": preview_id,
            "provider": {
                "display_name": provider["display_name"],
                "origin": provider["base_url"],
                "model": provider["model"],
            },
            "prompt_template_version": "agent-session-v1",
            "output_schema_version": "timeline-patch-output-v1",
            "sent_fields": [
                "instruction",
                "feedback",
                "project_ref",
                "timeline",
                "locked_elements",
                "allowed_operations",
                "canvas",
                "target_duration_us",
            ],
            "payload_sha256": payload_hash,
            **stats,
            "expires_at": expires_at,
        }

    def create_session(
        self, project_id: str, preview_id: str, payload_sha256: str, jobs: Any
    ) -> dict[str, Any]:
        with self.db.connection() as db:
            # 一项目同时仅一个 active 会话（Planning Gate §1 边界）。
            active = db.execute(
                "SELECT id FROM agent_sessions WHERE project_id=? AND status IN ('queued','running')",
                (project_id,),
            ).fetchone()
            if active:
                raise DomainError("AGENT_SESSION_ALREADY_ACTIVE", "项目已有进行中的 Agent 会话")
            preview = db.execute(
                "SELECT * FROM agent_session_egress_previews WHERE id=? AND project_id=?",
                (preview_id, project_id),
            ).fetchone()
            if not preview:
                raise DomainError("AGENT_SESSION_NOT_FOUND", "会话外传预览不存在")
            pending = self.pending_store.pop(preview_id)
            if pending is None:
                raise DomainError("AGENT_SESSION_EGRESS_EXPIRED", "会话外传预览正文已失效")
            if preview["payload_sha256"] != payload_sha256:
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "外传内容已变化")
            if _expired(preview["expires_at"]):
                raise DomainError("AGENT_SESSION_EGRESS_EXPIRED", "会话外传预览已过期")
            provider = self._provider_with_capability(preview["provider_config_id"])
            snapshot = json_loads(preview["provider_snapshot_json"])
            if sha256(snapshot) != preview["provider_config_sha256"] or any(
                provider[k] != snapshot[k] for k in snapshot
            ):
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "Provider 配置已变化")
            if provider["timeline_patch_capability_status"] != "supported":
                raise DomainError("AGENT_SESSION_PROVIDER_UNSUPPORTED", "Provider 能力状态已变化")
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != preview["base_revision_id"]:
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "Timeline 基线已变化")
            revision = self.timelines._revision(db, preview["base_revision_id"])
            if revision["document_sha256"] != preview["base_document_sha256"]:
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "Timeline 基线哈希已变化")
            session_id, consent_id, job_id, now = (
                f"agent_session_{new_id()}",
                f"agent_session_consent_{new_id()}",
                f"job_{new_id()}",
                utc_now(),
            )
            db.execute("BEGIN")
            try:
                db.execute(
                    "INSERT INTO agent_session_egress_consents(id,egress_preview_id,payload_sha256,created_at) VALUES (?,?,?,?)",  # noqa: E501
                    (consent_id, preview_id, payload_sha256, now),
                )
                db.execute(
                    "INSERT INTO jobs(id,project_id,kind,type,status,stage,progress,input_json,"
                    "resource_class,attempt,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        job_id,
                        project_id,
                        "agent_session",
                        "agent_session",
                        "queued",
                        "queued",
                        0,
                        json_dumps({"agent_session_id": session_id}),
                        "network",
                        1,
                        now,
                        now,
                    ),
                )
                db.execute(
                    "INSERT INTO agent_sessions(id,project_id,egress_preview_id,egress_consent_id,provider_config_id,base_revision_id,base_document_sha256,instruction,max_steps,status,payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        session_id,
                        project_id,
                        preview_id,
                        consent_id,
                        provider["provider_config_id"],
                        revision["timeline_revision_id"],
                        revision["document_sha256"],
                        pending["instruction"],
                        MAX_SESSION_STEPS,
                        "queued",
                        payload_sha256,
                        now,
                        now,
                    ),
                )
                self.session_store.put(
                    session_id,
                    {
                        **pending,
                        "session_id": session_id,
                        "consent_id": consent_id,
                        "job_id": job_id,
                    },
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                self.session_store.discard(session_id)
                raise
        job = jobs.get(job_id)
        if job is None:
            self.session_store.discard(session_id)
            raise DomainError("AGENT_SESSION_INVALID", "会话 Job 创建失败")
        return {"agent_session_id": session_id, "job": job}

    # ------------------------------------------------------------------
    # 循环执行体（job runner）
    # ------------------------------------------------------------------

    async def run_session(
        self, row: Any, cancel: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        # 调度器传入裸 jobs 行（SELECT *，input_json 未水合）；直接从
        # input_json 取会话 ID（run_session 可能拿到重试时新造的最小行）。
        input_payload = row["input"] if "input" in row.keys() else json_loads(row["input_json"])
        session_id = input_payload["agent_session_id"]
        entry = self.session_store.pop(session_id)
        try:
            stage("loading_snapshot")
            if entry is None:
                raise DomainError("AGENT_SESSION_EGRESS_EXPIRED", "会话正文已失效")
            with self.db.connection() as db:
                session = db.execute(
                    "SELECT * FROM agent_sessions WHERE id=?", (session_id,)
                ).fetchone()
                consent = db.execute(
                    "SELECT * FROM agent_session_egress_consents WHERE id=?",
                    (session["egress_consent_id"],),
                ).fetchone()
                preview = db.execute(
                    "SELECT * FROM agent_session_egress_previews WHERE id=?",
                    (session["egress_preview_id"],),
                ).fetchone()
            if not session or not consent or not preview:
                raise DomainError("AGENT_SESSION_NOT_FOUND", "会话快照不完整")
            if session["status"] != "queued" or consent["consumed_at"] is not None:
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "会话状态或授权已变化")
            provider = self._provider_with_capability(session["provider_config_id"])
            snapshot = json_loads(preview["provider_snapshot_json"])
            if any(provider[k] != snapshot[k] for k in snapshot):
                raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "Provider 配置已变化")
            # 消费会话级 consent（一次确认覆盖整个循环；触发器保证单次）。
            now = utc_now()
            with self.db.connection() as db:
                updated = db.execute(
                    "UPDATE agent_session_egress_consents SET consumed_at=? "
                    "WHERE id=? AND consumed_at IS NULL",
                    (now, consent["id"]),
                ).rowcount
                if updated != 1:
                    raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "会话授权已消费")
                db.execute(
                    "UPDATE agent_sessions SET status='running',updated_at=? WHERE id=?",
                    (now, session_id),
                )
            self._emit_session(session_id, "running", 0.0, 0)
            # 跨步状态：当前基线（会话内推进合法）+ 累计 token。
            with self.db.connection() as db:
                project = self.timelines._project(db, session["project_id"])
                current_revision = self.timelines._revision(
                    db, project["current_timeline_revision_id"]
                )
            base_revision_id = session["base_revision_id"]
            if (
                current_revision["timeline_revision_id"] != base_revision_id
                or current_revision["document_sha256"] != session["base_document_sha256"]
            ):
                raise DomainError("AGENT_SESSION_BASE_DRIFT", "会话启动前基线已变化")
            document = current_revision["document"]
            tokens_used = 0
            feedback_history: list[dict[str, Any]] = []
            step = 0
            while True:
                step += 1
                if cancel.is_set():
                    raise DomainError("JOB_CANCELLED", "会话已取消")
                if step > session["max_steps"]:
                    raise DomainError(
                        "AGENT_SESSION_STEP_LIMIT",
                        f"会话超出步数上限（{session['max_steps']}）",
                    )
                stage("calling_provider")
                payload = self._step_payload(
                    session["instruction"], document,
                    feedback=self._feedback(feedback_history),
                )
                payload_hash = sha256(payload)
                invocation_id = f"invocation_{new_id()}"
                with self.db.connection() as db:
                    db.execute(
                        "INSERT INTO provider_invocations(id,provider_config_id,capability,provider_name,model,prompt_template_version,output_schema_version,input_sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                        (
                            invocation_id,
                            provider["provider_config_id"],
                            "agent_session_planning",
                            provider["display_name"],
                            provider["model"],
                            "agent-session-v1",
                            "timeline-patch-output-v1",
                            payload_hash,
                            "running",
                            utc_now(),
                        ),
                    )
                started = time.monotonic()
                result = await self.provider_factory().generate(
                    StructuredTextRequest(
                        provider["provider_config_id"],
                        provider["base_url"],
                        provider["model"],
                        self.vault.for_request(provider["provider_config_id"]),
                        payload,
                        capability="timeline_patch_planning",
                        output_schema="timeline-patch-output-v1",
                        response_adapter_id=snapshot["timeline_patch_response_adapter_id"],
                    ),
                    cancel,
                )
                usage = result.usage or {}
                tokens_used += int(usage.get("total_tokens") or 0)
                if tokens_used > SESSION_TOKEN_BUDGET:
                    self._finish_invocation(
                        invocation_id, "failed", started,
                        usage=usage, cost=invocation_cost(provider, result.usage),
                        output_sha256=result.response_sha256,
                        error_code="AGENT_SESSION_BUDGET_EXCEEDED",
                        error_message="会话 token 预算超限",
                    )
                    self._record_step(
                        session_id, step, "failed", "calling_provider",
                        payload_hash, None, {
                            "code": "AGENT_SESSION_BUDGET_EXCEEDED",
                            "message": "会话 token 预算超限",
                            "tokens_used": tokens_used,
                        }, started,
                    )
                    raise DomainError(
                        "AGENT_SESSION_BUDGET_EXCEEDED",
                        f"会话 token 预算超限（{tokens_used} > {SESSION_TOKEN_BUDGET}）",
                    )
                stage("validating_response")
                value = result.value
                if (
                    not isinstance(value, dict)
                    or set(value) != {"summary", "operations"}
                    or not isinstance(value["summary"], str)
                    or not value["summary"].strip()
                    or not isinstance(value["operations"], list)
                    or not 1 <= len(value["operations"]) <= 100
                ):
                    raise DomainError("PROVIDER_SCHEMA_MISMATCH", "Patch 输出不符合固定结构")
                stage("applying_patch_in_memory")
                try:
                    with self.db.connection() as db:
                        proposed = self.timelines.apply_in_memory(
                            db, session["project_id"], document, value["operations"], ai=True
                        )
                except DomainError as exc:
                    failure = _structured_failure(exc)
                    self._finish_invocation(
                        invocation_id, "failed", started,
                        usage=usage, cost=invocation_cost(provider, result.usage),
                        output_sha256=result.response_sha256,
                        error_code=exc.code,
                        error_message=exc.message,
                    )
                    self._record_step(
                        session_id, step, "failed", "applying_patch_in_memory",
                        payload_hash, value["summary"].strip() if isinstance(
                            value.get("summary"), str) else None,
                        {
                            "code": exc.code,
                            "message": exc.message,
                            "failure": failure,
                        },
                        started,
                    )
                    feedback_history.append({
                        "step": step,
                        "code": exc.code,
                        "message": exc.message,
                        "failure": failure,
                    })
                    continue  # 带反馈进入下一步
                # 步成功：落不可变 Revision（会话内基线推进）。
                stage("persisting_step")
                proposed_hash = (
                    f"sha256:{hashlib.sha256(json_dumps(proposed).encode()).hexdigest()}"
                )
                revision = None
                with self.db.connection() as db:
                    db.execute("BEGIN")
                    try:
                        # 基线漂移防护：项目当前指针仍须等于本步起点的基线。
                        project = self.timelines._project(db, session["project_id"])
                        if project["current_timeline_revision_id"] != base_revision_id:
                            raise DomainError(
                                "AGENT_SESSION_BASE_DRIFT", "会话执行中基线被外部修改"
                            )
                        revision = self.timelines.create_revision_from_document(
                            db,
                            session["project_id"],
                            base_revision_id,
                            proposed,
                            f"agent step {step}: {value['summary'].strip()}",
                        )
                        db.execute("COMMIT")
                    except Exception:
                        db.execute("ROLLBACK")
                        raise
                self._finish_invocation(
                    invocation_id, "succeeded", started,
                    usage=usage, cost=invocation_cost(provider, result.usage),
                    output_sha256=result.response_sha256,
                )
                diff = timeline_diff(current_revision, revision)
                self._record_step(
                    session_id, step, "succeeded", "persisting_step",
                    payload_hash, value["summary"].strip(),
                    {"operations": len(value["operations"]), "diff": diff["summary"]},
                    started,
                )
                base_revision_id = revision["timeline_revision_id"]
                document = revision["document"]
                current_revision = revision
                progress(min(step / session["max_steps"], 0.99))
                self._emit_session(session_id, "running", min(step / session["max_steps"], 0.99), step)
                # 收束判定（Planning Gate §2）：成功步即会话成功——失败步
                # continue 留在循环内带反馈重试，循环本身即重试机制；连续
                # 失败由 max_steps/token 预算双闸门兜底。
                break
            # 成功收束：最后一步 Revision 即会话成果。
            finished = utc_now()
            with self.db.connection() as db:
                db.execute(
                    "UPDATE agent_sessions SET status='succeeded',updated_at=?,finished_at=? WHERE id=?",
                    (finished, finished, session_id),
                )
            progress(1.0)
            self._emit_session(session_id, "succeeded", 1.0, step)
            return {
                "agent_session_id": session_id,
                "steps_completed": step,
                "final_revision_id": base_revision_id,
            }
        except asyncio.CancelledError:
            self._archive_failure(session_id, "AGENT_SESSION_CANCELLED", "会话已取消")
            raise
        except DomainError as exc:
            status = "cancelled" if exc.code in {"JOB_CANCELLED", "AGENT_SESSION_CANCELLED"} else "failed"
            self._archive_failure(session_id, exc.code, exc.message)
            _ = status
            raise
        finally:
            self.session_store.discard(session_id)

    # ------------------------------------------------------------------
    # 内部辅助
    # ------------------------------------------------------------------

    @staticmethod
    def _step_payload(
        instruction: str, document: dict[str, Any], feedback: dict[str, Any] | None
    ) -> dict[str, Any]:
        from .timeline import AI_PATCH_OPERATIONS

        if not isinstance(document, dict) or "clips" not in document:
            raise DomainError("AGENT_SESSION_EGRESS_MISMATCH", "基线文档不可用")
        asset_refs: dict[str, str] = {}
        clips = []
        for clip in document["clips"]:
            asset_refs.setdefault(clip["asset_id"], f"source_{len(asset_refs) + 1}")
            clips.append(
                {
                    "clip_id": clip["clip_id"],
                    "order_index": clip["order_index"],
                    "kind": clip["asset_kind"],
                    "source_ref": asset_refs[clip["asset_id"]],
                    "source_start_us": clip["source_start_us"],
                    "source_end_us": clip["source_end_us"],
                    "timeline_start_us": clip["timeline_start_us"],
                    "timeline_end_us": clip["timeline_end_us"],
                    "layout": clip["layout"],
                    "audio": clip["audio"],
                }
            )
        captions = [
            {
                "caption_id": item["caption_id"],
                "source_clip_id": item["source_clip_id"],
                "start_us": item["start_us"],
                "end_us": item["end_us"],
                "text": item["text"],
                "preset_id": item["preset_id"],
            }
            for item in document["captions"]
        ]
        duration = document["clips"][-1]["timeline_end_us"] if document["clips"] else 0
        payload: dict[str, Any] = {
            "schema_version": 1,
            "prompt_template_version": "agent-session-v1",
            "output_schema_version": "timeline-patch-output-v1",
            "project_ref": f"project_{hashlib.sha256('agent'.encode()).hexdigest()[:16]}",
            "instruction": instruction,
            "timeline": {"clips": clips, "captions": captions},
            "locked_elements": list(document.get("locked_elements", [])),
            "allowed_operations": sorted(AI_PATCH_OPERATIONS),
            "canvas": document["canvas"],
            "target_duration_us": duration,
        }
        if feedback is not None:
            payload["feedback"] = feedback
        return payload

    @staticmethod
    def _feedback(history: list[dict[str, Any]]) -> dict[str, Any] | None:
        """裁剪失败反馈：仅保留最近 FEEDBACK_KEEP_STEPS 步、每步限长。"""
        if not history:
            return None
        trimmed = []
        for item in history[-FEEDBACK_KEEP_STEPS:]:
            entry = {
                "step": item["step"],
                "code": item["code"],
                "message": item["message"][:FEEDBACK_CHARS_PER_STEP],
            }
            if item.get("failure"):
                entry["failure"] = item["failure"]
            trimmed.append(entry)
        return {"previous_failures": trimmed}

    def _provider_with_capability(self, provider_config_id: str) -> dict[str, Any]:
        provider = self.providers.get(provider_config_id)
        with self.db.connection() as db:
            row = db.execute(
                "SELECT timeline_patch_capability_status,timeline_patch_response_adapter_id,"
                "timeline_patch_probe_protocol_version,timeline_patch_capability_tested_at,"
                "timeline_patch_capability_failure_code,timeline_patch_capability_probe_sha256 "
                "FROM provider_configs WHERE id=?",
                (provider_config_id,),
            ).fetchone()
        if not row:
            raise DomainError("AGENT_SESSION_NOT_FOUND", "Provider 不存在")
        return {**provider, **dict(row)}

    def _finish_invocation(
        self,
        invocation_id: str,
        status: str,
        started: float,
        *,
        usage: dict[str, Any] | None,
        cost: float | None,
        output_sha256: str | None,
        error_code: str | None = None,
        error_message: str | None = None,
        provider_may_have_processed: bool = False,
    ) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_invocations SET status=?,finished_at=?,duration_ms=?,"
                "usage_json=?,estimated_cost=?,output_sha256=?,error_code=?,error_message=?,"
                "provider_may_have_processed=? WHERE id=?",
                (
                    status,
                    utc_now(),
                    int((time.monotonic() - started) * 1000),
                    json_dumps(usage) if usage else None,
                    cost,
                    output_sha256,
                    error_code,
                    error_message,
                    int(provider_may_have_processed),
                    invocation_id,
                ),
            )

    def _record_step(
        self,
        session_id: str,
        ordinal: int,
        status: str,
        stage_name: str,
        input_sha256: str,
        summary: str | None,
        payload: dict[str, Any],
        started: float,
    ) -> None:
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO agent_steps(id,session_id,ordinal,status,stage,input_sha256,summary,output_json,error_json,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                (
                    f"agent_step_{new_id()}",
                    session_id,
                    ordinal,
                    status,
                    stage_name,
                    input_sha256,
                    summary,
                    json_dumps(payload) if status == "succeeded" else None,
                    json_dumps(payload) if status == "failed" else None,
                    int((time.monotonic() - started) * 1000),
                    utc_now(),
                ),
            )

    def _archive_failure(self, session_id: str, code: str, message: str) -> None:
        now = utc_now()
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                db.execute(
                    "UPDATE agent_sessions SET status=?,updated_at=?,finished_at=? WHERE id=? "
                    "AND status IN ('queued','running')",
                    (
                        "cancelled" if code == "AGENT_SESSION_CANCELLED" else "failed",
                        now,
                        now,
                        session_id,
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        self._emit_session(session_id, "cancelled" if code == "AGENT_SESSION_CANCELLED" else "failed", 1.0, None)

    def _emit_session(
        self, session_id: str, status: str, progress_value: float, step: int | None
    ) -> None:
        if self.emit is None:
            return
        payload: dict[str, Any] = {
            "agent_session_id": session_id,
            "status": status,
            "progress": progress_value,
        }
        if step is not None:
            payload["step"] = step
        try:
            result = self.emit(
                {"type": "agent_session.updated", "payload": payload}
            )
            if result is not None and hasattr(result, "__awaitable__"):
                asyncio.get_running_loop().create_task(result)
        except RuntimeError:
            pass

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def list_sessions(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id,status,base_revision_id,instruction,max_steps,created_at,"
                "updated_at,finished_at FROM agent_sessions WHERE project_id=? "
                "ORDER BY created_at DESC, id DESC",
                (project_id,),
            ).fetchall()
        return [
            {
                "agent_session_id": row["id"],
                "project_id": project_id,
                "status": row["status"],
                "base_revision_id": row["base_revision_id"],
                "instruction": row["instruction"],
                "max_steps": row["max_steps"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "finished_at": row["finished_at"],
            }
            for row in rows
        ]

    def get_session(self, session_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM agent_sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not row:
                raise DomainError("AGENT_SESSION_NOT_FOUND", "会话不存在")
            steps = db.execute(
                "SELECT ordinal,status,stage,summary,error_json,duration_ms,created_at "
                "FROM agent_steps WHERE session_id=? ORDER BY ordinal",
                (session_id,),
            ).fetchall()
        return {
            "agent_session_id": row["id"],
            "project_id": row["project_id"],
            "base_revision_id": row["base_revision_id"],
            "instruction": row["instruction"],
            "max_steps": row["max_steps"],
            "status": row["status"],
            "payload_sha256": row["payload_sha256"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
            "steps": [
                {
                    "ordinal": step["ordinal"],
                    "status": step["status"],
                    "stage": step["stage"],
                    "summary": step["summary"],
                    "error": json_loads(step["error_json"]) if step["error_json"] else None,
                    "duration_ms": step["duration_ms"],
                    "created_at": step["created_at"],
                }
                for step in steps
            ],
        }
