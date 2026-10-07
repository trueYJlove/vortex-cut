from __future__ import annotations

from copy import deepcopy
import asyncio
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from .captions_provider import (
    CAPTIONS_PROVIDER_OUTPUT_SCHEMA,
    CAPTIONS_PROVIDER_RECIPE_ID,
    build_captions_provider_payload,
    build_captions_provider_patch,
    captions_provider_preview,
)
from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .planning import sha256
from .projects import DomainError
from .planning import ProviderRepository
from .providers import (
    CAPTIONS_ADAPTER_IDS,
    CAPTIONS_PROBE_PROTOCOL_VERSION,
    RETRYABLE_PROVIDER_ERRORS,
    ProviderError,
    ProviderSecretVault,
    StructuredTextRequest,
    captions_adapter_supported,
    normalized_base_url,
    validate_captions_provider_value,
)
from .timeline import TimelineService


def _expires() -> str:
    return (datetime.now(UTC) + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CaptionsProviderEgressService:
    def __init__(self, db: Database, providers: ProviderRepository, vault: ProviderSecretVault, timelines: TimelineService, transcripts: Any, provider_factory: Any = None) -> None:
        self.db, self.providers, self.vault, self.timelines, self.transcripts, self.provider_factory = db, providers, vault, timelines, transcripts, provider_factory

    async def test_capability(self, provider_config_id: str) -> dict[str, Any]:
        """Probe the captions adapter ladder and persist the chosen adapter.

        Mirrors TimelinePatchPlanningService.test_provider_capability: walk the
        declared adapter order, retry only retryable (network-class) failures,
        and persist the first adapter that validates. Persisting the failure
        code and probe hash is what makes "network unreachable" distinguishable
        from "gateway rejects this response_format" (2026-10-03 misdiagnosis).
        """
        provider = self.providers.get(provider_config_id)
        status, adapter, protocol = "unsupported", None, None
        failure = "CAPTIONS_PROVIDER_CAPABILITY_UNSUPPORTED"
        now = utc_now()
        failures: list[dict[str, str]] = []
        payload = {"schema_version": 1, "recipe_id": "captions_provider_v1", "language": "en", "preset_id": "default-bottom", "max_chars_per_caption": 24, "segments": [{"segment_id": "probe_segment", "ordinal": 0, "text": "probe", "duration_bucket": "short"}]}
        try:
            if not provider.get("enabled"):
                raise ProviderError("PROVIDER_DISABLED", "Provider 未启用")
            if not self.provider_factory:
                raise ProviderError("CAPTIONS_PROVIDER_CAPABILITY_UNSUPPORTED", "Provider factory 未配置")
            secret = self.vault.for_request(provider_config_id)
            for candidate in CAPTIONS_ADAPTER_IDS:
                # 网络类错误重试（对齐 candidate/timeline_patch 探测）：网关抖动
                # 不判死刑；schema 类是确定性失败，立即换下一档。
                for attempt in range(3):
                    try:
                        request = StructuredTextRequest(
                            provider_config_id,
                            provider["base_url"],
                            provider["model"],
                            secret,
                            payload,
                            capability="captions_provider_capability_probe",
                            output_schema="caption-text-output-v1",
                            response_adapter_id=candidate,
                        )
                        result = await self.provider_factory().generate(request, asyncio.Event())
                        validate_captions_provider_value(result.value, ["probe_segment"], 24)
                        status, adapter, protocol, failure = (
                            "supported",
                            candidate,
                            CAPTIONS_PROBE_PROTOCOL_VERSION,
                            None,
                        )
                        break
                    except ProviderError as exc:
                        if exc.code == "PROVIDER_CANCELLED":
                            raise
                        failure = exc.code
                        if attempt == 0:
                            failures.append({"adapter_id": candidate, "safe_error_code": exc.code})
                        if exc.code not in RETRYABLE_PROVIDER_ERRORS:
                            break
                    except ValueError:
                        # HTTP 200 但内容不合 schema：确定性失败，换下一档。
                        # 必须在此捕获——否则 ValueError 会穿透整个阶梯，
                        # 使后续档位永远得不到尝试机会。
                        failure = "CAPTIONS_PROVIDER_SCHEMA_MISMATCH"
                        if attempt == 0:
                            failures.append(
                                {
                                    "adapter_id": candidate,
                                    "safe_error_code": "CAPTIONS_PROVIDER_SCHEMA_MISMATCH",
                                }
                            )
                        break
                if adapter:
                    break
        except ProviderError as exc:
            failure = exc.code
        except ValueError:
            failure = "CAPTIONS_PROVIDER_SCHEMA_MISMATCH"
        digest = sha256({"protocol": CAPTIONS_PROBE_PROTOCOL_VERSION, "results": failures})
        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET captions_provider_capability_status=?,"
                "captions_provider_response_adapter_id=?,"
                "captions_provider_probe_protocol_version=?,"
                "captions_provider_capability_tested_at=?,"
                "captions_provider_capability_failure_code=?,"
                "captions_provider_capability_probe_sha256=? WHERE id=?",
                (status, adapter, protocol, now, failure, digest, provider_config_id),
            )
        return {"captions_provider_capability_status": status, "captions_provider_capability_tested_at": now, "captions_provider_capability_failure_code": failure, "captions_provider_capability_probe_sha256": digest, "captions_provider_response_adapter_id": adapter, "captions_provider_probe_protocol_version": protocol}

    def _require_capable(self, provider: dict[str, Any]) -> None:
        """Fail closed unless the provider passed the captions probe with an adapter."""
        if (
            not provider.get("enabled")
            or provider.get("credential_status") != "configured"
            or provider.get("captions_provider_capability_status") != "supported"
            or not provider.get("captions_provider_capability_tested_at")
            or not captions_adapter_supported(provider.get("captions_provider_response_adapter_id"))
        ):
            raise DomainError("CAPTIONS_PROVIDER_UNSUPPORTED", "Provider 未通过 captions 能力测试")

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        provider = self.providers.get(request["provider_config_id"])
        self._require_capable(provider)
        with self.db.connection() as db:
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != request["base_revision_id"]:
                raise DomainError("CAPTIONS_PROVIDER_BASE_DRIFT", "Timeline 基线已变化")
            revision = self.timelines._revision(db, request["base_revision_id"])
            transcript = self.transcripts.get(request["transcript_id"])
            if not transcript:
                raise DomainError("CAPTIONS_PROVIDER_SEGMENTS_INVALID", "转录不存在")
            asset = db.execute("SELECT project_id FROM assets WHERE id=?", (transcript["asset_id"],)).fetchone()
            if not asset or asset["project_id"] != project_id:
                raise DomainError("CAPTIONS_PROVIDER_SEGMENTS_INVALID", "转录不属于当前项目")
        by_id = {item["segment_id"]: item for item in transcript["segments"]}
        ids = request["segment_ids"]
        if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids) or any(item not in by_id for item in ids):
            raise DomainError("CAPTIONS_PROVIDER_SEGMENTS_INVALID", "字幕片段选择无效")
        segments = [{"segment_id": item, "text": by_id[item]["text"], "duration_bucket": "short" if by_id[item]["end_us"] - by_id[item]["start_us"] < 2_000_000 else "long"} for item in ids]
        try:
            payload = build_captions_provider_payload(language=request.get("language") or transcript["language"], preset_id=request["preset_id"], max_chars_per_caption=request["max_chars_per_caption"], segments=segments)
        except ValueError as exc:
            raise DomainError("CAPTIONS_PROVIDER_PARAMS_INVALID", str(exc)) from exc
        payload_hash, expires_at, now = sha256(payload), _expires(), utc_now()
        provider_snapshot = {key: provider[key] for key in ("provider_config_id", "display_name", "base_url", "model", "enabled", "credential_status")}
        preview_id = f"captions_provider_preview_{new_id()}"
        stats = {"segment_count": len(segments), "character_count": sum(len(x["text"]) for x in segments)}
        with self.db.connection() as db:
            db.execute("INSERT INTO captions_provider_egress_previews (id,project_id,provider_config_id,base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,payload_sha256,stats_json,expires_at,created_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (preview_id, project_id, provider["provider_config_id"], revision["timeline_revision_id"], revision["document_sha256"], json_dumps(provider_snapshot), sha256(provider_snapshot), payload_hash, json_dumps(stats), expires_at, now, json_dumps(payload)))
        return {"captions_provider_egress_preview_id": preview_id, **captions_provider_preview(provider=provider, payload=payload, payload_sha256=payload_hash, expires_at=expires_at)}

    def create(self, project_id: str, preview_id: str, payload_sha256: str, jobs: Any = None) -> dict[str, Any]:
        """Create consent + generation (+ invocation + job) atomically.

        The returned DTO is deliberately unchanged (three keys) so the frozen
        contract stays valid; the job/invocation linkage is internal wiring that
        lets the existing JobService dispatch actually execute the generation.
        """
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM captions_provider_egress_previews WHERE id=? AND project_id=?", (preview_id, project_id)).fetchone()
            if not row:
                raise DomainError("CAPTIONS_PROVIDER_PREVIEW_NOT_FOUND", "外传预览不存在")
            payload = json_loads(row["payload_json"])
            if row["payload_sha256"] != payload_sha256 or sha256(payload) != payload_sha256:
                raise DomainError("CAPTIONS_PROVIDER_EGRESS_MISMATCH", "外传内容已变化")
            if datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00")) <= datetime.now(UTC):
                raise DomainError("CAPTIONS_PROVIDER_EGRESS_EXPIRED", "外传预览已过期")
            current = self.timelines._project(db, project_id)
            if current["current_timeline_revision_id"] != row["base_revision_id"]:
                raise DomainError("CAPTIONS_PROVIDER_BASE_DRIFT", "Timeline 基线已变化")
            provider = self.providers.get(row["provider_config_id"])
            snapshot = json_loads(row["provider_snapshot_json"])
            current_snapshot = {key: provider[key] for key in ("provider_config_id", "display_name", "base_url", "model", "enabled", "credential_status")}
            if sha256(snapshot) != row["provider_config_sha256"] or current_snapshot != snapshot:
                raise DomainError("CAPTIONS_PROVIDER_SNAPSHOT_DRIFT", "Provider 配置或凭据状态已变化")
            if not provider.get("enabled") or provider.get("credential_status") != "configured":
                raise DomainError("CAPTIONS_PROVIDER_UNSUPPORTED", "Provider 未通过 captions 能力测试")
            self._require_capable(provider)
            existing = db.execute("SELECT g.id,g.status,c.id AS consent_id FROM captions_provider_generations g JOIN captions_provider_egress_consents c ON c.id=g.egress_consent_id WHERE g.egress_preview_id=?", (preview_id,)).fetchone()
            if existing:
                if existing["status"] != "queued":
                    raise DomainError("CAPTIONS_PROVIDER_EGRESS_REUSED", "外传预览已使用")
                self._ensure_job(db, jobs, project_id, existing["id"], payload_sha256)
                return {"captions_provider_generation_id": existing["id"], "status": existing["status"], "consent_id": existing["consent_id"]}
            consent_id, generation_id, invocation_id, job_id, now = (
                f"captions_consent_{new_id()}",
                f"captions_generation_{new_id()}",
                f"invocation_{new_id()}",
                f"job_{new_id()}",
                utc_now(),
            )
            db.execute("BEGIN")
            try:
                db.execute("INSERT INTO captions_provider_egress_consents VALUES (?,?,?,?,?)", (consent_id, preview_id, payload_sha256, now, None))
                db.execute("INSERT INTO captions_provider_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (generation_id, project_id, preview_id, consent_id, row["provider_config_id"], row["base_revision_id"], row["base_document_sha256"], "queued", payload_sha256, now, now, None))
                db.execute(
                    "INSERT INTO provider_invocations(id,captions_provider_generation_id,provider_config_id,"
                    "capability,provider_name,model,prompt_template_version,output_schema_version,"
                    "input_sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        invocation_id,
                        generation_id,
                        row["provider_config_id"],
                        "captions_provider_generation",
                        snapshot["display_name"],
                        snapshot["model"],
                        CAPTIONS_PROVIDER_RECIPE_ID,
                        CAPTIONS_PROVIDER_OUTPUT_SCHEMA,
                        payload_sha256,
                        "queued",
                        now,
                    ),
                )
                self._insert_job(db, jobs, job_id, now, project_id, generation_id, invocation_id, payload_sha256)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return {"captions_provider_generation_id": generation_id, "status": "queued", "consent_id": consent_id}

    def _insert_job(self, db: Any, jobs: Any, job_id: str, now: str, project_id: str, generation_id: str, invocation_id: str, payload_sha256: str) -> None:
        """Insert the dispatchable job row inside the caller's transaction.

        Without this the generation would stay queued forever: Slice 2/3 wired
        prepare/create and the capability probe but nothing ever executed the
        generation (run_mock was the only, unreferenced, executor).
        """
        if jobs is None or not hasattr(jobs, "insert_captions_provider_job"):
            return
        jobs.insert_captions_provider_job(
            db, job_id, now, project_id, generation_id, invocation_id, payload_sha256
        )

    def _ensure_job(self, db: Any, jobs: Any, project_id: str, generation_id: str, payload_sha256: str) -> None:
        """Idempotently guarantee a queued generation has an invocation and one job.

        Older rows (created before this slice) have neither; repair them from the
        generation row so a re-issued create still becomes executable.
        """
        if jobs is None or not hasattr(jobs, "insert_captions_provider_job"):
            return
        if db.execute(
            "SELECT id FROM jobs WHERE captions_provider_generation_id=?", (generation_id,)
        ).fetchone():
            return
        invocation = db.execute(
            "SELECT id FROM provider_invocations WHERE captions_provider_generation_id=?",
            (generation_id,),
        ).fetchone()
        if invocation:
            invocation_id = invocation["id"]
        else:
            generation = db.execute(
                "SELECT provider_config_id FROM captions_provider_generations WHERE id=?",
                (generation_id,),
            ).fetchone()
            if not generation:
                return
            provider = self.providers.get(generation["provider_config_id"])
            invocation_id, now = f"invocation_{new_id()}", utc_now()
            db.execute(
                "INSERT INTO provider_invocations(id,captions_provider_generation_id,"
                "provider_config_id,capability,provider_name,model,prompt_template_version,"
                "output_schema_version,input_sha256,status,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    invocation_id,
                    generation_id,
                    generation["provider_config_id"],
                    "captions_provider_generation",
                    provider.get("display_name") or "",
                    provider.get("model") or "",
                    CAPTIONS_PROVIDER_RECIPE_ID,
                    CAPTIONS_PROVIDER_OUTPUT_SCHEMA,
                    payload_sha256,
                    "queued",
                    now,
                ),
            )
        self._insert_job(
            db, jobs, f"job_{new_id()}", utc_now(), project_id, generation_id,
            invocation_id, payload_sha256,
        )

    def claim_for_runner(self, project_id: str, generation_id: str) -> dict[str, Any]:
        """Atomically consume consent and claim a queued generation.

        This is an internal runner boundary; it does not call the network or
        expose payload text through an HTTP route.
        """
        with self.db.connection() as db:
            row = db.execute("SELECT g.*,c.consumed_at,p.payload_json,p.expires_at,p.provider_snapshot_json,p.provider_config_sha256 FROM captions_provider_generations g JOIN captions_provider_egress_consents c ON c.id=g.egress_consent_id JOIN captions_provider_egress_previews p ON p.id=g.egress_preview_id WHERE g.id=? AND g.project_id=?", (generation_id, project_id)).fetchone()
            if not row:
                raise DomainError("CAPTIONS_PROVIDER_GENERATION_NOT_FOUND", "字幕 Provider 任务不存在")
            if row["status"] != "queued" or row["consumed_at"] is not None:
                raise DomainError("CAPTIONS_PROVIDER_GENERATION_NOT_CLAIMABLE", "字幕 Provider 任务不可领取")
            if datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00")) <= datetime.now(UTC):
                raise DomainError("CAPTIONS_PROVIDER_EGRESS_EXPIRED", "外传预览已过期")
            provider = self.providers.get(row["provider_config_id"])
            snapshot = json_loads(row["provider_snapshot_json"])
            current_snapshot = {key: provider[key] for key in ("provider_config_id", "display_name", "base_url", "model", "enabled", "credential_status")}
            if sha256(snapshot) != row["provider_config_sha256"] or current_snapshot != snapshot:
                raise DomainError("CAPTIONS_PROVIDER_SNAPSHOT_DRIFT", "Provider 配置或凭据状态已变化")
            self._require_capable(provider)
            now = utc_now()
            db.execute("BEGIN")
            try:
                if db.execute("UPDATE captions_provider_egress_consents SET consumed_at=? WHERE id=? AND consumed_at IS NULL", (now, row["egress_consent_id"])).rowcount != 1:
                    raise DomainError("CAPTIONS_PROVIDER_GENERATION_NOT_CLAIMABLE", "字幕 Provider 授权已消费")
                if db.execute("UPDATE captions_provider_generations SET status='running',updated_at=? WHERE id=? AND status='queued'", (now, generation_id)).rowcount != 1:
                    raise DomainError("CAPTIONS_PROVIDER_GENERATION_NOT_CLAIMABLE", "字幕 Provider 任务状态已变化")
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
            return {"generation_id": generation_id, "provider": provider, "payload": json_loads(row["payload_json"]), "payload_sha256": row["payload_sha256"], "base_revision_id": row["base_revision_id"], "response_adapter_id": provider.get("captions_provider_response_adapter_id")}

    async def run_generation(
        self, row: Any, cancel: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        """Real captions Provider worker: the network call for one generation.

        Mirrors TimelinePatchPlanningService.run_generation: re-validate every
        snapshot, claim the one-shot consent atomically, call the Provider using
        the adapter selected by the capability probe (never an unprobed one),
        validate strictly, then persist only normalized output. Raw Provider
        response text is never stored. On any failure the generation and its
        invocation are archived fail-closed.
        """
        generation_id = row["captions_provider_generation_id"]
        invocation_id = row["provider_invocation_id"]
        provider_called = False
        try:
            stage("loading_snapshot")
            claimed = self.claim_for_runner(row["project_id"], generation_id)
            provider = claimed["provider"]
            payload = claimed["payload"]
            adapter = claimed["response_adapter_id"]
            if not captions_adapter_supported(adapter):
                # 未经探测通过的适配器绝不使用（fail-closed）。
                raise DomainError(
                    "CAPTIONS_PROVIDER_UNSUPPORTED", "Provider 未通过 captions 能力测试"
                )
            secret = self.vault.for_request(provider["provider_config_id"])
            if cancel.is_set():
                raise ProviderError("PROVIDER_CANCELLED", "调用已取消")
            stage("calling_provider")
            started = time.monotonic()
            provider_called = True
            result = await self.provider_factory().generate(
                StructuredTextRequest(
                    provider["provider_config_id"],
                    provider["base_url"],
                    provider["model"],
                    secret,
                    payload,
                    capability="captions_provider_generation",
                    output_schema=CAPTIONS_PROVIDER_OUTPUT_SCHEMA,
                    response_adapter_id=adapter,
                ),
                cancel,
            )
            stage("validating_response")
            segment_ids = [item["segment_id"] for item in payload["segments"]]
            try:
                normalized = validate_captions_provider_value(
                    result.value, segment_ids, payload["max_chars_per_caption"]
                )
            except ValueError as exc:
                raise ProviderError(
                    "CAPTIONS_PROVIDER_OUTPUT_INVALID", "字幕 Provider 输出不符合固定结构"
                ) from exc
            stage("persisting_result")
            now, duration_ms = utc_now(), int((time.monotonic() - started) * 1000)
            result_id = f"captions_result_{new_id()}"
            output_sha256 = sha256(normalized)
            with self.db.connection() as db:
                db.execute("BEGIN")
                try:
                    db.execute(
                        "INSERT INTO captions_provider_results(id,generation_id,output_json,"
                        "output_sha256,created_at) VALUES (?,?,?,?,?)",
                        (result_id, generation_id, json_dumps(normalized), output_sha256, now),
                    )
                    db.execute(
                        "UPDATE captions_provider_generations SET status='succeeded',"
                        "updated_at=?,finished_at=? WHERE id=? AND status='running'",
                        (now, now, generation_id),
                    )
                    db.execute(
                        "UPDATE provider_invocations SET status='succeeded',finished_at=?,"
                        "duration_ms=?,usage_json=?,provider_request_id=?,output_sha256=?"
                        " WHERE id=?",
                        (
                            now,
                            duration_ms,
                            json_dumps(result.usage) if result.usage is not None else None,
                            result.provider_request_id,
                            output_sha256,
                            invocation_id,
                        ),
                    )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
            return {
                "captions_provider_generation_id": generation_id,
                "status": "succeeded",
                "result_id": result_id,
                "output_sha256": output_sha256,
            }
        except (ProviderError, DomainError) as exc:
            self._archive_failure(
                generation_id, invocation_id, getattr(exc, "code", "CAPTIONS_PROVIDER_OUTPUT_INVALID"),
                may_have_processed=provider_called,
            )
            raise

    def _archive_failure(
        self, generation_id: str, invocation_id: str, code: str, *, may_have_processed: bool
    ) -> None:
        status = "cancelled" if code == "PROVIDER_CANCELLED" else "failed"
        now = utc_now()
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                db.execute(
                    "UPDATE captions_provider_generations SET status=?,updated_at=?,"
                    "finished_at=? WHERE id=?",
                    (status, now, now, generation_id),
                )
                db.execute(
                    "UPDATE provider_invocations SET status=?,finished_at=?,"
                    "provider_may_have_processed=?,error_code=? WHERE id=?",
                    (status, now, int(may_have_processed), code, invocation_id),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def run_mock(self, project_id: str, generation_id: str, provider_value: Any) -> dict[str, Any]:
        """Run the local, no-network adapter against a supplied Provider-shaped value.

        This deliberately persists only normalized schema output; it never creates
        a Timeline Revision and is not the real Provider worker.
        """
        claimed = self.claim_for_runner(project_id, generation_id)
        payload = claimed["payload"]
        segment_ids = [item["segment_id"] for item in payload["segments"]]
        try:
            normalized = validate_captions_provider_value(provider_value, segment_ids, payload["max_chars_per_caption"])
        except ValueError as exc:
            now = utc_now()
            with self.db.connection() as db:
                db.execute("UPDATE captions_provider_generations SET status='failed',updated_at=?,finished_at=? WHERE id=? AND status='running'", (now, now, generation_id))
            return {"captions_provider_generation_id": generation_id, "status": "failed", "error_code": "CAPTIONS_PROVIDER_OUTPUT_INVALID", "error": str(exc)}
        now = utc_now()
        result_id = f"captions_result_{new_id()}"
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                db.execute("INSERT INTO captions_provider_results(id,generation_id,output_json,output_sha256,created_at) VALUES (?,?,?,?,?)", (result_id, generation_id, json_dumps(normalized), sha256(normalized), now))
                db.execute("UPDATE captions_provider_generations SET status='succeeded',updated_at=?,finished_at=? WHERE id=? AND status='running'", (now, now, generation_id))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return {"captions_provider_generation_id": generation_id, "status": "succeeded", "result_id": result_id, "output_sha256": sha256(normalized)}

    def create_proposal(self, project_id: str, generation_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT g.*,r.output_json FROM captions_provider_generations g JOIN captions_provider_results r ON r.generation_id=g.id WHERE g.id=? AND g.project_id=?", (generation_id, project_id)).fetchone()
            if not row:
                raise DomainError("CAPTIONS_PROVIDER_RESULT_NOT_FOUND", "字幕 Provider 结果不存在")
            if row["status"] != "succeeded":
                raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_INVALID", "只有成功结果可以生成提案")
            existing = db.execute("SELECT id FROM captions_provider_proposals WHERE generation_id=?", (generation_id,)).fetchone()
            if existing:
                return self.get_proposal(project_id, existing["id"])
            revision = self.timelines._revision(db, row["base_revision_id"])
            payload_row = db.execute("SELECT payload_json FROM captions_provider_egress_previews WHERE id=?", (row["egress_preview_id"],)).fetchone()
            if not payload_row:
                raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_INVALID", "字幕 Provider 输入快照不存在")
            payload = json_loads(payload_row["payload_json"])
            patch = build_captions_provider_patch(document=revision["document"], payload=payload, provider_value=json_loads(row["output_json"]))
            if not patch["operations"]:
                raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_EMPTY", "字幕 Provider 没有产生文本变化")
            proposed = deepcopy(revision["document"])
            for operation in patch["operations"]:
                self.timelines._apply_operation(db, project_id, proposed, operation)
            proposal_id, now = f"captions_proposal_{new_id()}", utc_now()
            db.execute("INSERT INTO captions_provider_proposals(id,generation_id,project_id,base_revision_id,base_document_sha256,patch_json,patch_sha256,proposed_document_json,proposed_document_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (proposal_id, generation_id, project_id, row["base_revision_id"], revision["document_sha256"], json_dumps(patch), sha256(patch), json_dumps(proposed), sha256(proposed), now))
        return self.get_proposal(project_id, proposal_id)

    def get_proposal_for_generation(self, project_id: str, generation_id: str) -> dict[str, Any]:
        """Read an existing proposal for a generation without creating one."""
        with self.db.connection() as db:
            row = db.execute(
                "SELECT p.id FROM captions_provider_proposals p "
                "JOIN captions_provider_generations g ON g.id=p.generation_id "
                "WHERE p.generation_id=? AND p.project_id=? AND g.project_id=?",
                (generation_id, project_id, project_id),
            ).fetchone()
        if not row:
            raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_NOT_FOUND", "字幕 Provider 提案不存在")
        return self.get_proposal(project_id, row["id"])

    def get_proposal(self, project_id: str, proposal_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM captions_provider_proposals WHERE id=? AND project_id=?", (proposal_id, project_id)).fetchone()
        if not row:
            raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_NOT_FOUND", "字幕 Provider 提案不存在")
        return {"captions_provider_proposal_id": row["id"], "generation_id": row["generation_id"], "project_id": row["project_id"], "base_revision_id": row["base_revision_id"], "base_document_sha256": row["base_document_sha256"], "patch": json_loads(row["patch_json"]), "patch_sha256": row["patch_sha256"], "proposed_document_sha256": row["proposed_document_sha256"], "created_at": row["created_at"], "applied_revision_id": None}

    def apply_proposal(self, project_id: str, proposal_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "proposed_document_sha256"}:
            raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_INVALID", "字幕 Provider 应用请求无效")
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                row = db.execute("SELECT * FROM captions_provider_proposals WHERE id=? AND project_id=?", (proposal_id, project_id)).fetchone()
                if not row:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_NOT_FOUND", "字幕 Provider 提案不存在")
                applied = db.execute("SELECT timeline_revision_id FROM captions_provider_proposal_applications WHERE proposal_id=?", (proposal_id,)).fetchone()
                if applied:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_APPLIED", "字幕 Provider 提案已应用")
                if request["base_revision_id"] != row["base_revision_id"] or request["proposed_document_sha256"] != row["proposed_document_sha256"]:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_CONFLICT", "字幕 Provider 提案哈希不匹配")
                patch = json_loads(row["patch_json"])
                if sha256(patch) != row["patch_sha256"]:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_INVALID", "字幕 Provider Patch 哈希无效")
                base = self.timelines._revision(db, row["base_revision_id"])
                if base["document_sha256"] != row["base_document_sha256"] or self.timelines._project(db, project_id)["current_timeline_revision_id"] != row["base_revision_id"]:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_CONFLICT", "Timeline 基线已变化")
                proposed = json_loads(row["proposed_document_json"])
                if sha256(proposed) != row["proposed_document_sha256"]:
                    raise DomainError("CAPTIONS_PROVIDER_PROPOSAL_CONFLICT", "拟议文档哈希不一致")
                revision = self.timelines.create_revision_from_document(db, project_id, row["base_revision_id"], proposed, patch["summary"])
                now = utc_now()
                db.execute("INSERT INTO captions_provider_proposal_applications(id,proposal_id,project_id,timeline_revision_id,created_at) VALUES (?,?,?,?,?)", (f"captions_application_{new_id()}", proposal_id, project_id, revision["timeline_revision_id"], now))
                db.execute("DELETE FROM timeline_drafts WHERE project_id=?", (project_id,))
                db.execute("COMMIT")
                return revision
            except Exception:
                db.execute("ROLLBACK")
                raise

    def get(self, project_id: str, generation_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT id AS captions_provider_generation_id,project_id,status,base_revision_id,payload_sha256,created_at,updated_at,finished_at FROM captions_provider_generations WHERE id=? AND project_id=?", (generation_id, project_id)).fetchone()
        if not row:
            raise DomainError("CAPTIONS_PROVIDER_GENERATION_NOT_FOUND", "字幕 Provider 任务不存在")
        return dict(row)
