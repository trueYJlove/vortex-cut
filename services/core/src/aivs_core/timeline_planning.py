from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .payload_store import ExpiringPayloadStore, is_expired as _expired
from .planning import ProviderRepository, canonical_json, invocation_cost, sha256
from .projects import DomainError
from .providers import (
    RETRYABLE_PROVIDER_ERRORS,
    TIMELINE_PATCH_ADAPTER_IDS,
    TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
    OpenAICompatibleTextProvider,
    ProviderError,
    ProviderSecretVault,
    StructuredTextRequest,
    TextReasoningProvider,
    timeline_patch_adapter_supported,
)
from .timeline import AI_PATCH_OPERATIONS, TimelineService, timeline_diff


TimelinePatchPayloadStore = ExpiringPayloadStore
PendingTimelinePatchEgressStore = ExpiringPayloadStore
GenerationPayloadStore = ExpiringPayloadStore


class TimelinePatchPlanningService:
    def __init__(
        self,
        db: Database,
        providers: ProviderRepository,
        vault: ProviderSecretVault,
        timelines: TimelineService,
        provider_factory: Callable[[], TextReasoningProvider] = OpenAICompatibleTextProvider,
        pending_store: PendingTimelinePatchEgressStore | None = None,
        generation_store: GenerationPayloadStore | None = None,
    ) -> None:
        self.db, self.providers, self.vault, self.timelines = db, providers, vault, timelines
        self.provider_factory = provider_factory
        self.pending_store = pending_store or PendingTimelinePatchEgressStore()
        self.generation_store = generation_store or GenerationPayloadStore()

    def provider_capability(self, provider_config_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT timeline_patch_capability_status,timeline_patch_response_adapter_id,"
                "timeline_patch_probe_protocol_version,timeline_patch_capability_tested_at,"
                "timeline_patch_capability_failure_code,timeline_patch_capability_probe_sha256 "
                "FROM provider_configs WHERE id=?",
                (provider_config_id,),
            ).fetchone()
        if not row:
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        return dict(row)

    def provider_public(self, provider: dict[str, Any]) -> dict[str, Any]:
        capability = self.provider_capability(provider["provider_config_id"])
        return {**provider, **capability}

    @staticmethod
    def _capability_supported(provider: dict[str, Any]) -> bool:
        return (
            provider.get("timeline_patch_capability_status") == "supported"
            and timeline_patch_adapter_supported(provider.get("timeline_patch_response_adapter_id"))
            and provider.get("timeline_patch_probe_protocol_version")
            == TIMELINE_PATCH_PROBE_PROTOCOL_VERSION
            and isinstance(provider.get("timeline_patch_capability_tested_at"), str)
            and isinstance(provider.get("timeline_patch_capability_probe_sha256"), str)
            and provider.get("timeline_patch_capability_failure_code") is None
        )

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
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        return {**provider, **dict(row)}

    @staticmethod
    def _validate_probe_output(value: dict[str, Any]) -> None:
        """Strictly validate the synthetic, data-free Patch scenario before support."""
        if set(value) != {"summary", "operations"} or not isinstance(value["summary"], str):
            raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Provider Probe 输出不符合固定结构")
        operations = value["operations"]
        if not isinstance(operations, list) or len(operations) != 1:
            raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Provider Probe 输出不符合固定结构")
        if operations[0] != {
            "op": "set_layout",
            "clip_id": "probe_clip_001",
            "layout": "fit",
        }:
            raise ProviderError(
                "PROVIDER_SCHEMA_MISMATCH",
                "Provider Probe 未通过本地 TimelinePatch 校验",
            )

    def _validate_probe_domain(self, value: dict[str, Any]) -> None:
        """Exercise the same TimelinePatch domain boundary with synthetic-only rows."""
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                project_id = "probe_project"
                db.execute(
                    "INSERT INTO projects("
                    "id,name,status,canvas_json,current_timeline_revision_id,root_dir,"
                    "root_dir_name,created_at,updated_at,last_opened_at"
                    ") "
                    "VALUES (?,?,?,? ,NULL,?,?,?, ?,?)",
                    (
                        project_id,
                        "probe",
                        "active",
                        '{"width":1080,"height":1920,"fps_num":30,"fps_den":1}',
                        "probe",
                        "probe",
                        "now",
                        "now",
                        "now",
                    ),
                )
                db.execute(
                    "INSERT INTO assets("
                    "id,project_id,kind,storage_mode,display_name,fingerprint,size_bytes,"
                    "availability,media_info_json,created_at,updated_at"
                    ") VALUES ('probe_asset',?,'video','external','probe','probe',1,"
                    "'available',?,'now','now')",
                    (project_id, json_dumps({"duration_us": 5_000_000, "video_streams": [{}]})),
                )
                document = {
                    "schema_version": 1,
                    "project_id": project_id,
                    "canvas": {
                        "width": 1080,
                        "height": 1920,
                        "fps_num": 30,
                        "fps_den": 1,
                        "background_color": "#000000",
                    },
                    "tracks": [
                        {"id": "V1", "kind": "visual", "locked": False},
                        {"id": "C1", "kind": "caption", "locked": False},
                    ],
                    "clips": [
                        {
                            "clip_id": "probe_clip_001",
                            "track_id": "V1",
                            "order_index": 0,
                            "asset_id": "probe_asset",
                            "asset_kind": "video",
                            "source_start_us": 0,
                            "source_end_us": 5_000_000,
                            "timeline_start_us": 0,
                            "timeline_end_us": 5_000_000,
                            "layout": "crop_fill",
                            "audio": {"enabled": True, "gain_db": 0.0},
                        }
                    ],
                    "captions": [],
                    "provenance": {"created_by": "user", "source_transcript_ids": []},
                    "locked_elements": [],
                }
                self.timelines.apply_in_memory(
                    db, project_id, document, value["operations"], ai=True
                )
            except (DomainError, ValueError, TypeError) as exc:
                db.execute("ROLLBACK")
                raise ProviderError(
                    "PROVIDER_SCHEMA_MISMATCH", "Provider Probe 未通过本地 TimelinePatch 校验"
                ) from exc
            db.execute("ROLLBACK")

    @staticmethod
    def _record_capability(
        db: Any,
        provider_config_id: str,
        status: str,
        adapter: str | None,
        protocol: str | None,
        tested_at: str,
        failure: str | None,
        digest: str | None,
    ) -> None:
        db.execute(
            "UPDATE provider_configs SET timeline_patch_capability_status=?,"
            "timeline_patch_response_adapter_id=?,timeline_patch_probe_protocol_version=?,"
            "timeline_patch_capability_tested_at=?,timeline_patch_capability_failure_code=?,"
            "timeline_patch_capability_probe_sha256=? WHERE id=?",
            (status, adapter, protocol, tested_at, failure, digest, provider_config_id),
        )

    async def test_provider_capability(self, provider_config_id: str) -> dict[str, Any]:
        provider = self._provider_with_capability(provider_config_id)
        now = utc_now()
        status, adapter, protocol, failure, digest = (
            "unsupported",
            None,
            None,
            "PROVIDER_CAPABILITY_UNSUPPORTED",
            None,
        )
        try:
            if not provider["enabled"]:
                raise ProviderError("PROVIDER_DISABLED", "Provider 未启用")
            secret = self.vault.for_request(provider_config_id)
            payload = {
                "probe_protocol_version": TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
                "nonce": new_id(),
                "scenario": {
                    "schema_version": 1,
                    "allowed_operation": "set_layout",
                    "clip_id": "probe_clip_001",
                    "expected_layout": "fit",
                },
            }
            probe_hashes: list[str] = []
            for candidate in TIMELINE_PATCH_ADAPTER_IDS:
                # 网络类错误重试（PROVIDER 韧性工作单 2026-09-21）：网关
                # 抖动/慢滴不该把 provider 永久标 unsupported；schema 类
                # 错误是确定性失败，不重试。
                for attempt in range(3):
                    try:
                        request = StructuredTextRequest(
                            provider_config_id,
                            provider["base_url"],
                            provider["model"],
                            secret,
                            payload,
                            capability="timeline_patch_capability_probe",
                            output_schema="timeline-patch-output-v1",
                            response_adapter_id=candidate,
                        )
                        result = await self.provider_factory().generate(
                            request,
                            asyncio.Event(),
                        )
                        probe_hashes.append(result.response_sha256 or sha256(result.value))
                        self._validate_probe_output(result.value)
                        self._validate_probe_domain(result.value)
                        status = "supported"
                        adapter = candidate
                        protocol = TIMELINE_PATCH_PROBE_PROTOCOL_VERSION
                        failure = None
                        break
                    except ProviderError as exc:
                        probe_hashes.append(sha256({"adapter": candidate, "code": exc.code}))
                        failure = (
                            "PROVIDER_CAPABILITY_UNSUPPORTED"
                            if exc.code
                            in {"PROVIDER_INVALID_RESPONSE", "PROVIDER_SCHEMA_MISMATCH"}
                            else exc.code
                        )
                        if exc.code not in RETRYABLE_PROVIDER_ERRORS:
                            break
                if adapter:
                    break
            digest = sha256(
                {
                    "protocol": TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
                    "results": probe_hashes,
                }
            )
        except ProviderError as exc:
            failure = (
                "PROVIDER_CAPABILITY_UNSUPPORTED"
                if exc.code in {"PROVIDER_INVALID_RESPONSE", "PROVIDER_SCHEMA_MISMATCH"}
                else exc.code
            )
        if digest is None:
            digest = sha256(
                {
                    "probe_protocol_version": TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
                    "failure_code": failure,
                }
            )
        with self.db.connection() as db:
            self._record_capability(
                db,
                provider_config_id,
                status,
                adapter,
                protocol,
                now,
                failure,
                digest,
            )
        return self.provider_capability(provider_config_id)

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "provider_config_id", "instruction"}:
            raise DomainError("TIMELINE_PATCH_GENERATION_INVALID", "准备请求无效")
        instruction = request["instruction"]
        if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 4000:
            raise DomainError("TIMELINE_PATCH_GENERATION_INVALID", "修改指令无效")
        provider = self._provider_with_capability(request["provider_config_id"])
        if not provider["enabled"]:
            raise DomainError("PROVIDER_DISABLED", "Provider 未启用")
        if provider["timeline_patch_capability_status"] == "untested":
            raise DomainError(
                "TIMELINE_PATCH_PROVIDER_UNTESTED",
                "Provider 尚未通过 TimelinePatch 能力测试",
            )
        if not self._capability_supported(provider):
            raise DomainError(
                "TIMELINE_PATCH_PROVIDER_UNSUPPORTED",
                "Provider 不支持严格 TimelinePatch 输出",
            )
        with self.db.connection() as db:
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != request["base_revision_id"]:
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "Timeline 基线已变化")
            revision = self.timelines._revision(db, request["base_revision_id"])
        payload = self._payload(project_id, instruction.strip(), revision["document"])
        payload_hash, now = sha256(payload), utc_now()
        expires_at = (
            (datetime.now(UTC) + timedelta(minutes=15))
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
        preview_id = f"timeline_patch_preview_{new_id()}"
        stats = {
            "character_count": len(canonical_json(payload)),
            "estimated_tokens": max(1, len(canonical_json(payload)) // 4),
            "clip_count": len(revision["document"]["clips"]),
            "caption_count": len(revision["document"]["captions"]),
            "locked_count": len(revision["document"].get("locked_elements", [])),
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
                "payload": payload,
                "expires_at": expires_at,
                "response_adapter_id": provider["timeline_patch_response_adapter_id"],
                "probe_protocol_version": provider["timeline_patch_probe_protocol_version"],
            },
        )
        with self.db.connection() as db:
            try:
                db.execute(
                    "INSERT INTO timeline_patch_egress_previews(id,project_id,provider_config_id,base_revision_id,base_document_sha256,provider_snapshot_json,provider_config_sha256,payload_sha256,stats_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
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
            "timeline_patch_egress_preview_id": preview_id,
            "provider": {
                "display_name": provider["display_name"],
                "origin": provider["base_url"],
                "model": provider["model"],
            },
            "prompt_template_version": "timeline-patch-v1",
            "output_schema_version": "timeline-patch-output-v1",
            "sent_fields": [
                "instruction",
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

    @staticmethod
    def _payload(project_id: str, instruction: str, document: dict[str, Any]) -> dict[str, Any]:
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
        return {
            "schema_version": 1,
            "prompt_template_version": "timeline-patch-v1",
            "output_schema_version": "timeline-patch-output-v1",
            "project_ref": f"project_{hashlib.sha256(project_id.encode()).hexdigest()[:16]}",
            "instruction": instruction,
            "timeline": {"clips": clips, "captions": captions},
            "locked_elements": list(document.get("locked_elements", [])),
            "allowed_operations": sorted(AI_PATCH_OPERATIONS),
            "canvas": document["canvas"],
            "target_duration_us": duration,
        }

    def create_generation(
        self, project_id: str, preview_id: str, payload_sha256: str, jobs: Any
    ) -> dict[str, Any]:
        with self.db.connection() as db:
            preview = db.execute(
                "SELECT * FROM timeline_patch_egress_previews WHERE id=? AND project_id=?",
                (preview_id, project_id),
            ).fetchone()
            if not preview:
                raise DomainError("TIMELINE_PATCH_GENERATION_NOT_FOUND", "外传预览不存在")
            pending = self.pending_store.pop(preview_id)
            if pending is None:
                raise DomainError("TIMELINE_PATCH_EGRESS_EXPIRED", "外传预览正文已失效")
            payload = pending["payload"]
            if preview["payload_sha256"] != payload_sha256 or sha256(payload) != payload_sha256:
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "外传内容已变化")
            if _expired(preview["expires_at"]):
                raise DomainError("TIMELINE_PATCH_EGRESS_EXPIRED", "外传预览已过期")
            if any(
                pending[key] != preview[key]
                for key in (
                    "project_id",
                    "provider_config_id",
                    "base_revision_id",
                    "base_document_sha256",
                    "provider_config_sha256",
                    "payload_sha256",
                    "expires_at",
                )
            ):
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "外传预览元数据已变化")
            provider = self._provider_with_capability(preview["provider_config_id"])
            snapshot = json_loads(preview["provider_snapshot_json"])
            if sha256(snapshot) != preview["provider_config_sha256"] or any(
                provider[k] != snapshot[k] for k in snapshot
            ):
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "Provider 配置或凭据状态已变化")
            if not self._capability_supported(provider):
                raise DomainError("TIMELINE_PATCH_PROVIDER_UNSUPPORTED", "Provider 能力状态已变化")
            project = self.timelines._project(db, project_id)
            if project["current_timeline_revision_id"] != preview["base_revision_id"]:
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "Timeline 基线已变化")
            revision = self.timelines._revision(db, preview["base_revision_id"])
            if (
                revision["document_sha256"] != preview["base_document_sha256"]
                or self._payload(project_id, payload["instruction"], revision["document"])
                != payload
            ):
                raise DomainError("TIMELINE_PATCH_EGRESS_MISMATCH", "Timeline 内容或锁定集合已变化")
            generation_id, consent_id, invocation_id, now = (
                f"timeline_patch_generation_{new_id()}",
                f"timeline_patch_consent_{new_id()}",
                f"invocation_{new_id()}",
                utc_now(),
            )
            job_id = f"job_{new_id()}"
            atomic_job = hasattr(jobs, "insert_timeline_patch_job") and hasattr(jobs, "get")
            db.execute("BEGIN")
            try:
                db.execute(
                    "INSERT INTO timeline_patch_egress_consents(id,egress_preview_id,payload_sha256,created_at) VALUES (?,?,?,?)",  # noqa: E501
                    (consent_id, preview_id, payload_sha256, now),
                )
                db.execute(
                    "INSERT INTO timeline_patch_generations(id,project_id,egress_preview_id,egress_consent_id,provider_config_id,base_revision_id,base_document_sha256,status,payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        generation_id,
                        project_id,
                        preview_id,
                        consent_id,
                        provider["provider_config_id"],
                        revision["timeline_revision_id"],
                        revision["document_sha256"],
                        "queued",
                        payload_sha256,
                        now,
                        now,
                    ),
                )
                db.execute(
                    "INSERT INTO provider_invocations(id,timeline_patch_generation_id,provider_config_id,capability,provider_name,model,prompt_template_version,output_schema_version,input_sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        invocation_id,
                        generation_id,
                        provider["provider_config_id"],
                        "timeline_patch_planning",
                        provider["display_name"],
                        provider["model"],
                        "timeline-patch-v1",
                        "timeline-patch-output-v1",
                        payload_sha256,
                        "queued",
                        now,
                    ),
                )
                if atomic_job:
                    jobs.insert_timeline_patch_job(
                        db,
                        job_id,
                        now,
                        project_id,
                        generation_id,
                        invocation_id,
                        payload_sha256,
                    )
                self.generation_store.put(
                    generation_id,
                    {
                        **pending,
                        "generation_id": generation_id,
                        "invocation_id": invocation_id,
                        "consent_id": consent_id,
                    },
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                self.generation_store.discard(generation_id)
                raise
        job = (
            jobs.get(job_id)
            if atomic_job
            else jobs.create_timeline_patch_generation(
                project_id, generation_id, invocation_id, payload_sha256
            )
        )
        if job is None:
            self.generation_store.discard(generation_id)
            raise DomainError("TIMELINE_PATCH_GENERATION_INVALID", "Patch Job 创建失败")
        return {"timeline_patch_generation_id": generation_id, "job": job}

    async def run_generation(
        self, row: Any, cancel: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        generation_id = row["timeline_patch_generation_id"]
        payload_entry = self.generation_store.pop(generation_id)
        provider_called = False
        try:
            stage("loading_snapshot")
            if payload_entry is None:
                raise ProviderError("TIMELINE_PATCH_EGRESS_EXPIRED", "生成正文已失效")
            with self.db.connection() as db:
                generation = db.execute(
                    "SELECT * FROM timeline_patch_generations WHERE id=?", (generation_id,)
                ).fetchone()
                invocation = db.execute(
                    "SELECT * FROM provider_invocations WHERE id=?",
                    (row["provider_invocation_id"],),
                ).fetchone()
                preview = (
                    db.execute(
                        "SELECT * FROM timeline_patch_egress_previews WHERE id=?",
                        (generation["egress_preview_id"],),
                    ).fetchone()
                    if generation
                    else None
                )
                consent = (
                    db.execute(
                        "SELECT * FROM timeline_patch_egress_consents WHERE id=?",
                        (generation["egress_consent_id"],),
                    ).fetchone()
                    if generation
                    else None
                )
            if not generation or not invocation or not preview or not consent:
                raise ProviderError("TIMELINE_PATCH_GENERATION_INVALID", "生成快照不完整")
            provider = self._provider_with_capability(generation["provider_config_id"])
            snapshot = json_loads(preview["provider_snapshot_json"])
            project = None
            revision = None
            with self.db.connection() as db:
                project = self.timelines._project(db, generation["project_id"])
                revision = self.timelines._revision(db, generation["base_revision_id"])
            payload = payload_entry["payload"]
            if (
                generation["status"] != "queued"
                or invocation["status"] != "queued"
                or consent["consumed_at"] is not None
                or payload_entry["generation_id"] != generation_id
                or payload_entry["invocation_id"] != invocation["id"]
                or payload_entry["consent_id"] != consent["id"]
                or payload_entry["payload_sha256"] != generation["payload_sha256"]
                or sha256(payload) != generation["payload_sha256"]
                or payload_entry["provider_config_sha256"] != preview["provider_config_sha256"]
                or sha256(snapshot) != preview["provider_config_sha256"]
                or any(provider[key] != snapshot[key] for key in snapshot)
                or not self._capability_supported(provider)
                or project["current_timeline_revision_id"] != generation["base_revision_id"]
                or revision["document_sha256"] != generation["base_document_sha256"]
                or revision["document_sha256"] != preview["base_document_sha256"]
                or self._payload(
                    generation["project_id"], payload["instruction"], revision["document"]
                )
                != payload
            ):
                raise ProviderError("TIMELINE_PATCH_EGRESS_MISMATCH", "生成外传快照已变化")
            if cancel.is_set():
                raise ProviderError("PROVIDER_CANCELLED", "调用已取消")
            secret = self.vault.for_request(provider["provider_config_id"])
            now = utc_now()
            with self.db.connection() as db:
                db.execute("BEGIN")
                try:
                    updated = db.execute(
                        "UPDATE timeline_patch_egress_consents SET consumed_at=? WHERE id=? AND consumed_at IS NULL",  # noqa: E501
                        (now, consent["id"]),
                    ).rowcount
                    if updated != 1:
                        raise ProviderError("TIMELINE_PATCH_EGRESS_MISMATCH", "外传授权已消费")
                    db.execute(
                        "UPDATE provider_invocations SET status='running',started_at=? WHERE id=?",
                        (now, invocation["id"]),
                    )
                    db.execute(
                        "UPDATE timeline_patch_generations SET status='running',updated_at=? WHERE id=?",  # noqa: E501
                        (now, generation_id),
                    )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
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
                    capability="timeline_patch_planning",
                    output_schema="timeline-patch-output-v1",
                    response_adapter_id=snapshot["timeline_patch_response_adapter_id"],
                ),
                cancel,
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
                raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Patch 输出不符合固定结构")
            stage("applying_patch_in_memory")
            with self.db.connection() as db:
                proposed = self.timelines.apply_in_memory(
                    db, generation["project_id"], revision["document"], value["operations"], ai=True
                )
            patch = {
                "schema_version": 1,
                "base_revision_id": revision["timeline_revision_id"],
                "operations": value["operations"],
                "summary": value["summary"].strip(),
            }
            patch_hash = sha256(patch)
            proposed_json = json_dumps(proposed)
            proposed_hash = f"sha256:{hashlib.sha256(proposed_json.encode()).hexdigest()}"
            stage("computing_diff")
            target = {
                "timeline_revision_id": None,
                "project_id": generation["project_id"],
                "document": proposed,
                "document_sha256": proposed_hash,
            }
            diff = timeline_diff(revision, target)
            stage("persisting_proposal")
            proposal_id, finished = f"timeline_patch_proposal_{new_id()}", utc_now()
            with self.db.connection() as db:
                db.execute("BEGIN")
                try:
                    db.execute(
                        "INSERT INTO timeline_patch_proposals(id,generation_id,project_id,base_revision_id,base_document_sha256,provider_config_id,patch_json,patch_sha256,proposed_document_sha256,diff_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                        (
                            proposal_id,
                            generation_id,
                            generation["project_id"],
                            revision["timeline_revision_id"],
                            revision["document_sha256"],
                            provider["provider_config_id"],
                            json_dumps(patch),
                            patch_hash,
                            proposed_hash,
                            json_dumps(diff),
                            finished,
                        ),
                    )
                    db.execute(
                        "UPDATE provider_invocations SET status='succeeded',finished_at=?,duration_ms=?,usage_json=?,estimated_cost=?,provider_request_id=?,output_sha256=? WHERE id=?",  # noqa: E501
                        (
                            finished,
                            int((time.monotonic() - started) * 1000),
                            json_dumps(result.usage) if result.usage else None,
                            invocation_cost(provider, result.usage),
                            result.provider_request_id,
                            result.response_sha256 or sha256(value),
                            invocation["id"],
                        ),
                    )
                    db.execute(
                        "UPDATE timeline_patch_generations SET status='succeeded',updated_at=?,finished_at=? WHERE id=?",  # noqa: E501
                        (finished, finished, generation_id),
                    )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
            progress(1.0)
            return {
                "timeline_patch_generation_id": generation_id,
                "timeline_patch_proposal_id": proposal_id,
            }
        except asyncio.CancelledError:
            self._archive_generation_failure(
                generation_id,
                row["provider_invocation_id"],
                "PROVIDER_CANCELLED",
                "Provider 调用已取消",
                may_have_processed=provider_called,
            )
            raise
        except (ProviderError, DomainError) as exc:
            self._archive_generation_failure(
                generation_id,
                row["provider_invocation_id"],
                exc.code,
                exc.message,
                may_have_processed=provider_called,
            )
            raise
        finally:
            self.generation_store.discard(generation_id)

    def _archive_generation_failure(
        self,
        generation_id: str,
        invocation_id: str,
        code: str,
        message: str,
        *,
        may_have_processed: bool,
    ) -> None:
        status = "cancelled" if code == "PROVIDER_CANCELLED" else "failed"
        now = utc_now()
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                db.execute(
                    "UPDATE provider_invocations SET status=?,finished_at=?,provider_may_have_processed=?,error_code=?,error_message=? WHERE id=?",  # noqa: E501
                    (status, now, int(may_have_processed), code, message, invocation_id),
                )
                db.execute(
                    "UPDATE timeline_patch_generations SET status=?,updated_at=?,finished_at=? WHERE id=?",  # noqa: E501
                    (status, now, now, generation_id),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def list_generations(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT * FROM timeline_patch_generations WHERE project_id=? ORDER BY created_at DESC,id DESC",  # noqa: E501
                (project_id,),
            ).fetchall()
        return [self._generation_dto(row) for row in rows]

    def get_generation(self, generation_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM timeline_patch_generations WHERE id=?", (generation_id,)
            ).fetchone()
        if not row:
            raise DomainError("TIMELINE_PATCH_GENERATION_NOT_FOUND", "Patch 生成不存在")
        return self._generation_dto(row)

    @staticmethod
    def _generation_dto(row: Any) -> dict[str, Any]:
        return {
            "timeline_patch_generation_id": row["id"],
            "project_id": row["project_id"],
            "base_revision_id": row["base_revision_id"],
            "base_document_sha256": row["base_document_sha256"],
            "status": row["status"],
            "payload_sha256": row["payload_sha256"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
        }

    def list_proposals(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT * FROM timeline_patch_proposals WHERE project_id=? ORDER BY created_at DESC,id DESC",  # noqa: E501
                (project_id,),
            ).fetchall()
            return [self._proposal_dto(db, row) for row in rows]

    def get_proposal(self, proposal_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM timeline_patch_proposals WHERE id=?", (proposal_id,)
            ).fetchone()
            if not row:
                raise DomainError("TIMELINE_PATCH_PROPOSAL_NOT_FOUND", "Patch 提案不存在")
            return self._proposal_dto(db, row)

    @staticmethod
    def _proposal_dto(db: Any, row: Any) -> dict[str, Any]:
        generation = db.execute(
            "SELECT * FROM timeline_patch_generations WHERE id=?", (row["generation_id"],)
        ).fetchone()
        provider = db.execute(
            "SELECT provider_name,model FROM provider_invocations "
            "WHERE timeline_patch_generation_id=?",
            (row["generation_id"],),
        ).fetchone()
        application = db.execute(
            "SELECT timeline_revision_id FROM timeline_patch_applications WHERE proposal_id=?",
            (row["id"],),
        ).fetchone()
        return {
            "schema_version": 1,
            "timeline_patch_proposal_id": row["id"],
            "timeline_patch_generation_id": row["generation_id"],
            "project_id": row["project_id"],
            "base_revision_id": row["base_revision_id"],
            "base_document_sha256": row["base_document_sha256"],
            "provider_config_id": row["provider_config_id"],
            "provider_display_name": provider["provider_name"],
            "model": provider["model"],
            "prompt_template_version": "timeline-patch-v1",
            "output_schema_version": "timeline-patch-output-v1",
            "patch": json_loads(row["patch_json"]),
            "patch_sha256": row["patch_sha256"],
            "proposed_document_sha256": row["proposed_document_sha256"],
            "diff": json_loads(row["diff_json"]),
            "created_at": row["created_at"],
            "applied_revision_id": application["timeline_revision_id"] if application else None,
            "generation_status": generation["status"],
        }

    def apply(self, project_id: str, proposal_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if set(request) != {"base_revision_id", "proposed_document_sha256"}:
            raise DomainError("TIMELINE_PATCH_PROPOSAL_INVALID", "应用请求无效")
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                row = db.execute(
                    "SELECT * FROM timeline_patch_proposals WHERE id=? AND project_id=?",
                    (proposal_id, project_id),
                ).fetchone()
                if not row:
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_NOT_FOUND", "Patch 提案不存在")
                if db.execute(
                    "SELECT 1 FROM timeline_patch_applications WHERE proposal_id=?", (proposal_id,)
                ).fetchone():
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_APPLIED", "Patch 提案已应用")
                generation = db.execute(
                    "SELECT * FROM timeline_patch_generations WHERE id=?", (row["generation_id"],)
                ).fetchone()
                invocation = db.execute(
                    "SELECT * FROM provider_invocations WHERE timeline_patch_generation_id=?",
                    (row["generation_id"],),
                ).fetchone()
                if (
                    not generation
                    or generation["status"] != "succeeded"
                    or not invocation
                    or invocation["status"] != "succeeded"
                ):
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_INVALID", "Patch 提案状态无效")
                if (
                    request["base_revision_id"] != row["base_revision_id"]
                    or request["proposed_document_sha256"] != row["proposed_document_sha256"]
                ):
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_CONFLICT", "Patch 提案哈希不匹配")
                project = self.timelines._project(db, project_id)
                if project["current_timeline_revision_id"] != row["base_revision_id"]:
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_CONFLICT", "Timeline 基线已变化")
                base = self.timelines._revision(db, row["base_revision_id"])
                if base["document_sha256"] != row["base_document_sha256"]:
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_CONFLICT", "Timeline 基线哈希已变化")
                patch = json_loads(row["patch_json"])
                if sha256(patch) != row["patch_sha256"]:
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_INVALID", "Patch 内容哈希无效")
                proposed = self.timelines.apply_in_memory(
                    db, project_id, base["document"], patch["operations"], ai=True
                )
                proposed_hash = (
                    f"sha256:{hashlib.sha256(json_dumps(proposed).encode()).hexdigest()}"
                )
                if proposed_hash != row["proposed_document_sha256"]:
                    raise DomainError("TIMELINE_PATCH_PROPOSAL_CONFLICT", "Patch 重放结果不一致")
                revision = self.timelines.create_revision_from_document(
                    db, project_id, row["base_revision_id"], proposed, patch["summary"]
                )
                db.execute("DELETE FROM timeline_drafts WHERE project_id=?", (project_id,))
                db.execute(
                    "INSERT INTO timeline_patch_applications(id,proposal_id,project_id,timeline_revision_id,created_at) VALUES (?,?,?,?,?)",  # noqa: E501
                    (
                        f"timeline_patch_application_{new_id()}",
                        proposal_id,
                        project_id,
                        revision["timeline_revision_id"],
                        utc_now(),
                    ),
                )
                db.execute("COMMIT")
                return revision
            except Exception:
                db.execute("ROLLBACK")
                raise
