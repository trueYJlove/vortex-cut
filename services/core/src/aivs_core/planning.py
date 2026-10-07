from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
import unicodedata
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .projects import DomainError
from .providers import (
    CANDIDATE_ADAPTER_IDS,
    RETRYABLE_PROVIDER_ERRORS,
    CANDIDATE_PROBE_PROTOCOL_VERSION,
    OpenAICompatibleTextProvider,
    ProviderError,
    ProviderSecretVault,
    StructuredTextRequest,
    TextReasoningProvider,
    candidate_adapter_supported,
    validate_candidate_output_value,
)
from .timeline import CAPTION_PRESETS, LAYOUTS, TimelineService

VARIANTS = ("balanced", "compact", "bold")
# AI-2 阶段三（ADR-0003 D3 Layer 0）：召回来源。"transcript" = 既有链路；
# "auto" = 有可用转录用之、否则 CV 场景段；"cv" = 强制 CV。
CANDIDATE_SOURCES = ("auto", "transcript", "cv")
# CV 场景段参数（阶段三首版）：最小场景段 2s、召回上限对齐转录路径。
CV_MIN_SCENE_US = 2_000_000
CV_MAX_SCENES = 160
# ADR-0005 阶段 1：`sparse` 分析的**运动能量降权系数**（只降权不排除）。
# 理由：sparse = 采样间隔超回退阈值，运动能量按"采样帧间差分"计算，
# 密度越稀越容易漏掉峰值运动 → 该维度系统性偏低，排序时需折减。
# **首版经验值，待 W0.4 评测集校准**——不做运行时可调（可预测性优先）。
CV_SPARSE_MOTION_WEIGHT = 0.5


class CandidatePayloadStore:
    """Short-lived process-only Candidate payload boundary; values are never serialized."""

    def __init__(self) -> None:
        self._values: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def put(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._values[key] = value

    def take(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._values.pop(key, None)
        if not value or datetime.fromisoformat(
            value["expires_at"].replace("Z", "+00:00")
        ) <= datetime.now(UTC):
            return None
        return value

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._values.get(key)
        if not value or datetime.fromisoformat(
            value["expires_at"].replace("Z", "+00:00")
        ) <= datetime.now(UTC):
            self.discard(key)
            return None
        return value

    def discard(self, key: str) -> None:
        with self._lock:
            self._values.pop(key, None)


PendingCandidateEgressStore = CandidatePayloadStore
CandidateGenerationPayloadStore = CandidatePayloadStore


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json(value).encode()).hexdigest()}"


def document_sha256(document: dict[str, Any]) -> str:
    return sha256({key: value for key, value in document.items() if key != "document_sha256"})


def invocation_cost(provider: Any, usage: dict[str, Any] | None) -> float | None:
    """Estimate a request cost only from configured unit prices and returned token usage."""
    if usage is None:
        return None
    total = 0.0
    priced = False
    for usage_keys, price_key in (
        (("prompt_tokens", "input_tokens"), "input_price_per_million"),
        (("completion_tokens", "output_tokens"), "output_price_per_million"),
    ):
        tokens = next((usage.get(key) for key in usage_keys if key in usage), None)
        price = provider[price_key]
        if isinstance(tokens, int) and not isinstance(tokens, bool) and tokens >= 0:
            token_count = tokens
        else:
            token_count = None
        if token_count is not None and price is not None:
            total += token_count * float(price) / 1_000_000
            priced = True
    return total if priced else None


def _clean_text(value: Any, minimum: int, maximum: int, field: str) -> str:
    if not isinstance(value, str):
        raise DomainError("BRIEF_INVALID", f"{field} 无效")
    text = unicodedata.normalize("NFC", " ".join(value.split()))
    if not minimum <= len(text) <= maximum or any(
        unicodedata.category(char) in {"Cc", "Cs"} for char in text
    ):
        raise DomainError("BRIEF_INVALID", f"{field} 无效")
    return text


def _id(value: Any, code: str = "PLANNING_INVALID") -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 128
        or any(not (x.isascii() and (x.isalnum() or x in "_-")) for x in value)
    ):
        raise DomainError(code, "标识符无效")
    return value


class RecipeRegistry:
    def __init__(self, recipe_dir: Path) -> None:
        self.recipe_dir = recipe_dir
        self._recipes = self._load()

    def _load(self) -> dict[str, dict[str, Any]]:
        manifest = json.loads((self.recipe_dir / "manifest.json").read_text(encoding="utf-8"))
        recipes: dict[str, dict[str, Any]] = {}
        for recipe_id in manifest["recipes"]:
            document = json.loads(
                (self.recipe_dir / f"{recipe_id}.json").read_text(encoding="utf-8")
            )
            if document.get("recipe_id") != recipe_id or document.get("schema_version") != 1:
                raise RuntimeError("invalid recipe resource")
            recipes[recipe_id] = document
        return recipes

    def list(self) -> list[dict[str, Any]]:
        return [self.public(recipe) for recipe in self._recipes.values()]

    def get(self, recipe_id: str) -> dict[str, Any]:
        try:
            return copy.deepcopy(self._recipes[recipe_id])
        except KeyError as exc:
            raise DomainError("RECIPE_NOT_FOUND", "Recipe 不存在") from exc

    def public(self, document: dict[str, Any]) -> dict[str, Any]:
        result = copy.deepcopy(document)
        result["document_sha256"] = document_sha256(document)
        return result


class ProviderRepository:
    def __init__(self, db: Database, vault: ProviderSecretVault) -> None:
        self.db, self.vault = db, vault

    def list(self) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute("SELECT * FROM provider_configs ORDER BY created_at,id").fetchall()
        return [self._dto(row) for row in rows]

    def get(self, provider_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM provider_configs WHERE id=?", (provider_id,)).fetchone()
        if not row:
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        return self._dto(row)

    def create(self, request: dict[str, Any]) -> dict[str, Any]:
        from .providers import normalized_base_url

        allowed = {
            "kind",
            "display_name",
            "base_url",
            "model",
            "enabled",
            "input_price_per_million",
            "output_price_per_million",
        }
        if set(request) - allowed or not {"kind", "display_name", "base_url", "model"} <= set(
            request
        ):
            raise DomainError("PROVIDER_INVALID_CONFIG", "Provider 字段无效")
        if request["kind"] != "openai_compatible_text":
            raise DomainError(
                "PROVIDER_CAPABILITY_UNSUPPORTED", "只支持 OpenAI-compatible 文本 Provider"
            )
        provider_id, now = f"provider_{new_id()}", utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO provider_configs(id,kind,display_name,base_url,model,enabled,input_price_per_million,output_price_per_million,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                (
                    provider_id,
                    request["kind"],
                    _clean_text(request["display_name"], 1, 100, "display_name"),
                    normalized_base_url(request["base_url"]),
                    _clean_text(request["model"], 1, 200, "model"),
                    int(request.get("enabled", True)),
                    request.get("input_price_per_million"),
                    request.get("output_price_per_million"),
                    now,
                    now,
                ),
            )
        return self.get(provider_id)

    def patch(self, provider_id: str, request: dict[str, Any]) -> dict[str, Any]:
        current = self.get(provider_id)
        merged = {**current, **request}
        from .providers import normalized_base_url

        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET display_name=?,base_url=?,model=?,enabled=?,input_price_per_million=?,output_price_per_million=?,updated_at=? WHERE id=?",  # noqa: E501
                (
                    _clean_text(merged["display_name"], 1, 100, "display_name"),
                    normalized_base_url(merged["base_url"]),
                    _clean_text(merged["model"], 1, 200, "model"),
                    int(merged["enabled"]),
                    merged.get("input_price_per_million"),
                    merged.get("output_price_per_million"),
                    utc_now(),
                    provider_id,
                ),
            )
        return self.get(provider_id)

    def _dto(self, row: Any) -> dict[str, Any]:
        return {
            "provider_config_id": row["id"],
            "kind": row["kind"],
            "display_name": row["display_name"],
            "base_url": row["base_url"],
            "model": row["model"],
            "enabled": bool(row["enabled"]),
            "credential_status": self.vault.status(row["id"]),
            "input_price_per_million": row["input_price_per_million"],
            "output_price_per_million": row["output_price_per_million"],
            "captions_provider_capability_status": row["captions_provider_capability_status"],
            "captions_provider_capability_tested_at": row["captions_provider_capability_tested_at"],
            "captions_provider_response_adapter_id": row["captions_provider_response_adapter_id"],
            "captions_provider_probe_protocol_version": row["captions_provider_probe_protocol_version"],
            "captions_provider_capability_failure_code": row["captions_provider_capability_failure_code"],
            "captions_provider_capability_probe_sha256": row["captions_provider_capability_probe_sha256"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "candidate_capability_status": row["candidate_capability_status"],
            "candidate_response_adapter_id": row["candidate_response_adapter_id"],
            "candidate_probe_protocol_version": row["candidate_probe_protocol_version"],
            "candidate_capability_tested_at": row["candidate_capability_tested_at"],
            "candidate_capability_failure_code": row["candidate_capability_failure_code"],
            "candidate_capability_probe_sha256": row["candidate_capability_probe_sha256"],
        }


class PlanningService:
    def __init__(
        self,
        db: Database,
        recipes: RecipeRegistry,
        providers: ProviderRepository,
        vault: ProviderSecretVault,
        timelines: TimelineService,
        provider_factory: Callable[[], TextReasoningProvider] = OpenAICompatibleTextProvider,
        pending_store: PendingCandidateEgressStore | None = None,
        generation_store: CandidateGenerationPayloadStore | None = None,
        cv_signals: Any = None,
    ) -> None:
        self.db, self.recipes, self.providers, self.vault, self.timelines = (
            db,
            recipes,
            providers,
            vault,
            timelines,
        )
        self.provider_factory = provider_factory
        self.pending_store = pending_store or PendingCandidateEgressStore()
        self.generation_store = generation_store or CandidateGenerationPayloadStore()
        # AI-2 阶段三：CV 信号服务（可空——无 CV 链路时 cv/auto 回退受限）。
        self.cv_signals = cv_signals

    @staticmethod
    def _candidate_supported(provider: dict[str, Any]) -> bool:
        return (
            provider.get("candidate_capability_status") == "supported"
            and candidate_adapter_supported(provider.get("candidate_response_adapter_id"))
            and provider.get("candidate_probe_protocol_version") == CANDIDATE_PROBE_PROTOCOL_VERSION
            and isinstance(provider.get("candidate_capability_tested_at"), str)
            and isinstance(provider.get("candidate_capability_probe_sha256"), str)
            and provider.get("candidate_capability_failure_code") is None
        )

    def _provider_with_candidate_capability(self, provider_id: str) -> dict[str, Any]:
        provider = self.providers.get(provider_id)
        with self.db.connection() as db:
            row = db.execute(
                "SELECT candidate_capability_status,"
                "candidate_response_adapter_id,"
                "candidate_probe_protocol_version,"
                "candidate_capability_tested_at,"
                "candidate_capability_failure_code,"
                "candidate_capability_probe_sha256 "
                "FROM provider_configs WHERE id=?",
                (provider_id,),
            ).fetchone()
        if not row:
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        return {**provider, **dict(row)}

    def candidate_capability(self, provider_id: str) -> dict[str, Any]:
        provider = self._provider_with_candidate_capability(provider_id)
        return {
            key: provider[key]
            for key in (
                "candidate_capability_status",
                "candidate_response_adapter_id",
                "candidate_probe_protocol_version",
                "candidate_capability_tested_at",
                "candidate_capability_failure_code",
                "candidate_capability_probe_sha256",
            )
        }

    async def test_candidate_provider_capability(self, provider_id: str) -> dict[str, Any]:
        provider = self._provider_with_candidate_capability(provider_id)
        if not provider["enabled"]:
            raise ProviderError("PROVIDER_DISABLED", "Provider 未启用")
        secret = self.vault.for_request(provider_id)
        nonce = new_id()
        payload = {
            "probe_protocol_version": CANDIDATE_PROBE_PROTOCOL_VERSION,
            "nonce": nonce,
            "variants": list(VARIANTS),
            "segments": [
                {
                    "segment_ref": f"probe_{nonce}_{index}",
                    "transcript_ref": "probe",
                    "start_us": index * 5_000_000,
                    "end_us": (index + 1) * 5_000_000,
                    "text": "synthetic",
                }
                for index in range(3)
            ],
        }
        failures: list[dict[str, str]] = []
        adapter: str | None = None
        failure = "PROVIDER_CAPABILITY_UNSUPPORTED"
        for candidate in CANDIDATE_ADAPTER_IDS:
            # 网络类错误重试（PROVIDER 韧性工作单 2026-09-21）：同
            # timeline-patch 探测——网关抖动不判死刑，schema 错误不重试。
            for attempt in range(3):
                try:
                    result = await self.provider_factory().generate(
                        StructuredTextRequest(
                            provider_id,
                            provider["base_url"],
                            provider["model"],
                            secret,
                            payload,
                            capability="candidate_capability_probe",
                            response_adapter_id=candidate,
                        ),
                        asyncio.Event(),
                    )
                    self._validate_candidate_probe(result.value, payload)
                    adapter = candidate
                    break
                except ProviderError as exc:
                    if exc.code == "PROVIDER_CANCELLED":
                        raise
                    failure = exc.code
                    if attempt == 0:
                        failures.append({"adapter_id": candidate, "safe_error_code": exc.code})
                    if exc.code not in RETRYABLE_PROVIDER_ERRORS:
                        break
            if adapter:
                break
        digest = sha256({"protocol": CANDIDATE_PROBE_PROTOCOL_VERSION, "results": failures})
        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_configs SET candidate_capability_status=?,"
                "candidate_response_adapter_id=?,"
                "candidate_probe_protocol_version=?,"
                "candidate_capability_tested_at=?,"
                "candidate_capability_failure_code=?,"
                "candidate_capability_probe_sha256=? WHERE id=?",
                (
                    "supported" if adapter else "unsupported",
                    adapter,
                    CANDIDATE_PROBE_PROTOCOL_VERSION if adapter else None,
                    utc_now(),
                    None if adapter else failure,
                    digest,
                    provider_id,
                ),
            )
        return self.candidate_capability(provider_id)

    @staticmethod
    def _validate_candidate_probe(value: dict[str, Any], payload: dict[str, Any]) -> None:
        """探测协议 v2（2026-09-20 裁决）：结构正确性校验。

        时长不再要求精确等于目标——真实候选采纳链本有 0.8-1.2× 时长硬门兜底
        质量；探测的职责是验证"模型能产出结构合法、引用闭合的输出"。旧版
        精确时长匹配经真实验证为跨模型失败点（gpt-5.6-luna 与
        deepseek-v4.1-flash 结构正确性均 100% 合格而算术不过），故放宽。
        """
        try:
            entries = validate_candidate_output_value(value)["candidates"]
        except ValueError as exc:
            raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Candidate Probe 输出无效") from exc
        segment_ranges = {
            segment["segment_ref"]: (segment["start_us"], segment["end_us"])
            for segment in payload["segments"]
        }
        for expected_variant, candidate in zip(VARIANTS, entries, strict=True):
            if candidate["variant"] != expected_variant:
                raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Candidate Probe 变体顺序无效")
            if not candidate["clips"]:
                raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Candidate Probe 片段为空")
            for clip in candidate["clips"]:
                refs = clip["segment_ids"]
                if (
                    not refs
                    or len(set(refs)) != len(refs)
                    or any(ref not in segment_ranges for ref in refs)
                ):
                    raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "Candidate Probe 引用无效")

    def put_brief(self, project_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        required = {
            "schema_version",
            "topic",
            "audience",
            "target_platform",
            "target_duration_us",
            "narrative_goal",
            "style_notes",
            "must_keep",
            "forbidden",
            "original_audio_policy",
            "caption_policy",
            "caption_preset_id",
            "default_layout",
        }
        if set(raw) != required or raw.get("schema_version") != 1:
            raise DomainError("BRIEF_INVALID", "Brief 字段无效")
        if (
            raw["target_platform"] != "generic_vertical"
            or raw["original_audio_policy"] not in {"preserve", "mute"}
            or raw["caption_policy"] not in {"auto_from_transcript", "none"}
            or raw["caption_preset_id"] not in CAPTION_PRESETS
            or raw["default_layout"] not in LAYOUTS
            or not isinstance(raw["target_duration_us"], int)
            or not 15_000_000 <= raw["target_duration_us"] <= 180_000_000
        ):
            raise DomainError("BRIEF_INVALID", "Brief 字段无效")
        lists = {}
        for key in ("must_keep", "forbidden"):
            values = raw[key]
            if not isinstance(values, list) or len(values) > 20:
                raise DomainError("BRIEF_INVALID", "Brief 列表无效")
            cleaned = sorted(set(_clean_text(v, 1, 100, key) for v in values))
            lists[key] = cleaned
        with self.db.connection() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
            existing = db.execute(
                "SELECT id,created_at FROM project_briefs WHERE project_id=?", (project_id,)
            ).fetchone()
            brief_id = existing["id"] if existing else f"brief_{new_id()}"
            now = utc_now()
            doc = {
                "schema_version": 1,
                "brief_id": brief_id,
                "project_id": project_id,
                "topic": _clean_text(raw["topic"], 1, 200, "topic"),
                "audience": _clean_text(raw["audience"], 1, 200, "audience"),
                "target_platform": "generic_vertical",
                "target_duration_us": raw["target_duration_us"],
                "narrative_goal": _clean_text(raw["narrative_goal"], 1, 500, "narrative_goal"),
                "style_notes": _clean_text(raw["style_notes"], 0, 1000, "style_notes"),
                **lists,
                "original_audio_policy": raw["original_audio_policy"],
                "caption_policy": raw["caption_policy"],
                "caption_preset_id": raw["caption_preset_id"],
                "default_layout": raw["default_layout"],
            }
            doc["document_sha256"] = document_sha256(doc)
            db.execute(
                "INSERT INTO project_briefs(id,project_id,document_json,document_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET document_json=excluded.document_json,document_sha256=excluded.document_sha256,updated_at=excluded.updated_at",  # noqa: E501
                (
                    brief_id,
                    project_id,
                    json_dumps(doc),
                    doc["document_sha256"],
                    existing["created_at"] if existing else now,
                    now,
                ),
            )
        return doc

    def get_brief(self, project_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT document_json FROM project_briefs WHERE project_id=?", (project_id,)
            ).fetchone()
        if not row:
            raise DomainError("BRIEF_NOT_FOUND", "尚未设置 Brief")
        return json_loads(row[0])

    def prepare(self, project_id: str, request: dict[str, Any]) -> dict[str, Any]:
        # AI-2 阶段三：candidate_source 可选增量（缺省 auto 保持旧行为——
        # 旧客户端不传新字段走纯转录路径，与旧图逐字节一致）。pydantic
        # dump 会带 None 缺省值，先归一化再校验键集合。
        request = {k: v for k, v in request.items() if v is not None}
        if set(request) not in (
            {"provider_config_id", "recipe_id", "transcript_ids"},
            {"provider_config_id", "recipe_id", "transcript_ids", "candidate_source"},
        ):
            raise DomainError("PLANNING_INVALID", "准备请求无效")
        source = request.get("candidate_source", "auto")
        if source not in CANDIDATE_SOURCES:
            raise DomainError("PLANNING_INVALID", "召回来源不合法")
        transcript_ids = request["transcript_ids"]
        if (
            not isinstance(transcript_ids, list)
            or not 0 <= len(transcript_ids) <= 20
            or len(set(transcript_ids)) != len(transcript_ids)
        ):
            raise DomainError("PLANNING_INVALID", "转录选择无效")
        brief = self.get_brief(project_id)
        provider = self._provider_with_candidate_capability(_id(request["provider_config_id"]))
        recipe = self.recipes.get(_id(request["recipe_id"]))
        if not provider["enabled"]:
            raise DomainError("PROVIDER_DISABLED", "Provider 未启用")
        if provider["candidate_capability_status"] == "untested":
            raise DomainError("CANDIDATE_PROVIDER_UNTESTED", "Provider 尚未测试 AI 粗剪兼容性")
        if not self._candidate_supported(provider):
            raise DomainError("CANDIDATE_PROVIDER_UNSUPPORTED", "Provider 不支持 AI 粗剪")
        selected: list[dict[str, Any]] = []
        cv_scenes: list[dict[str, Any]] = []
        with self.db.connection() as db:
            for transcript_id in transcript_ids:
                row = db.execute(
                    "SELECT t.*,a.project_id,a.availability,a.fingerprint FROM transcripts t JOIN assets a ON a.id=t.asset_id WHERE t.id=?",  # noqa: E501
                    (transcript_id,),
                ).fetchone()
                if (
                    not row
                    or row["project_id"] != project_id
                    or row["status"] != "ready"
                    or row["availability"] != "available"
                    or row["source_fingerprint"] != row["fingerprint"]
                ):
                    raise DomainError("TRANSCRIPTION_NOT_READY", "所选转录不可用")
                selected.extend(
                    {**dict(x), "transcript_id": transcript_id, "asset_id": row["asset_id"]}
                    for x in db.execute(
                        "SELECT id,ordinal,start_us,end_us,text,confidence FROM transcript_segments WHERE transcript_id=? ORDER BY ordinal",  # noqa: E501
                        (transcript_id,),
                    ).fetchall()
                )
        use_transcript = source in {"auto", "transcript"} and bool(selected)
        use_cv = source == "cv" or (source == "auto" and not selected)
        if use_cv:
            cv_scenes = self._cv_scenes(project_id)
            if not cv_scenes:
                raise DomainError(
                    "PLANNING_NO_SEGMENTS",
                    "所选素材无可用 CV 信号分析（需先完成视频分析）",
                )
        elif not use_transcript:
            # auto 但 transcript_ids 为空且无 CV：显式报错而非静默空召回。
            raise DomainError("PLANNING_INVALID", "转录选择无效")
        segments = self._select(brief, selected) if use_transcript else []
        if use_transcript and not segments:
            raise DomainError("PLANNING_NO_SEGMENTS", "预筛未得到可用片段")
        # 载荷与白名单：转录段与 CV 场景段统一为 provider 可见的段列表
        # （CV 段无 text——payload 里 text 置空串，sent_fields 增量登记）。
        payload_segments: list[dict[str, Any]] = []
        whitelist: list[dict[str, Any]] = []
        if use_transcript:
            for n, s in enumerate(segments):
                payload_segments.append(
                    {
                        "segment_ref": f"s{n + 1}",
                        "transcript_ref": f"t{transcript_ids.index(s['transcript_id']) + 1}",
                        "start_us": s["start_us"],
                        "end_us": s["end_us"],
                        "text": s["text"],
                    }
                )
                whitelist.append(
                    {"segment_ref": f"s{n + 1}", "segment_id": s["id"], "source": "transcript"}
                )
        if cv_scenes:
            base = len(payload_segments)
            for n, scene in enumerate(cv_scenes):
                payload_segments.append(
                    {
                        "segment_ref": f"s{base + n + 1}",
                        "transcript_ref": None,
                        "start_us": scene["start_us"],
                        "end_us": scene["end_us"],
                        "text": "",
                        "cv_features": scene["features"],
                    }
                )
                whitelist.append(
                    {
                        "segment_ref": f"s{base + n + 1}",
                        "segment_id": scene["scene_id"],
                        "source": "cv",
                        "asset_id": scene["asset_id"],
                        "start_us": scene["start_us"],
                        "end_us": scene["end_us"],
                        "features": scene["features"],
                    }
                )
        payload = {
            "brief": {
                k: v
                for k, v in brief.items()
                if k not in {"brief_id", "project_id", "document_sha256"}
            },
            "recipe": recipe,
            "variants": list(VARIANTS),
            "segments": payload_segments,
        }
        # Preserve references only internally; provider receives the same selected content visible in preview.  # noqa: E501
        payload_hash = sha256(payload)
        now = utc_now()
        expiry = (
            (datetime.now(UTC) + timedelta(minutes=15))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        snapshot_id = f"recipe_snapshot_{new_id()}"
        preview_id = f"preview_{new_id()}"
        provider_snapshot = {
            key: provider[key]
            for key in (
                "provider_config_id",
                "kind",
                "display_name",
                "base_url",
                "model",
                "enabled",
                "candidate_capability_status",
                "candidate_response_adapter_id",
                "candidate_probe_protocol_version",
                "candidate_capability_tested_at",
                "candidate_capability_failure_code",
                "candidate_capability_probe_sha256",
            )
        }
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO recipe_snapshots(id,recipe_id,document_json,document_sha256,created_at) VALUES (?,?,?,?,?)",  # noqa: E501
                (
                    snapshot_id,
                    recipe["recipe_id"],
                    json_dumps(recipe),
                    document_sha256(recipe),
                    now,
                ),
            )
            db.execute(
                "INSERT INTO egress_previews(id,project_id,provider_config_id,brief_snapshot_json,brief_sha256,recipe_snapshot_id,provider_snapshot_json,provider_config_sha256,transcript_refs_json,segment_whitelist_json,payload_sha256,payload_json,stats_json,expires_at,created_at,candidate_response_adapter_id,candidate_probe_protocol_version,candidate_capability_probe_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                (
                    preview_id,
                    project_id,
                    provider["provider_config_id"],
                    json_dumps(brief),
                    brief["document_sha256"],
                    snapshot_id,
                    json_dumps(provider_snapshot),
                    sha256(provider_snapshot),
                    json_dumps(transcript_ids),
                    json_dumps(whitelist),
                    payload_hash,
                    "{}",
                    json_dumps(
                        {
                            "segment_count": len(payload_segments),
                            "character_count": sum(len(x["text"]) for x in payload_segments),
                            "estimated_tokens": max(1, sum(len(x["text"]) for x in payload_segments) // 4),
                            "cv_scene_count": len(cv_scenes),
                            "candidate_source": source,
                        }
                    ),
                    expiry,
                    now,
                    provider["candidate_response_adapter_id"],
                    provider["candidate_probe_protocol_version"],
                    provider["candidate_capability_probe_sha256"],
                ),
            )
        self.pending_store.put(
            preview_id,
            {
                "payload": payload,
                "payload_sha256": payload_hash,
                "expires_at": expiry,
                "provider_config_sha256": sha256(provider_snapshot),
                "response_adapter_id": provider["candidate_response_adapter_id"],
                "probe_protocol_version": provider["candidate_probe_protocol_version"],
                "probe_sha256": provider["candidate_capability_probe_sha256"],
                "model": provider["model"],
            },
        )
        return {
            "egress_preview_id": preview_id,
            "provider": {
                "display_name": provider["display_name"],
                "origin": provider["base_url"],
                "model": provider["model"],
            },
            "prompt_template_version": "candidate-plan-v1",
            "sent_fields": [
                "brief",
                "recipe",
                "variants",
                "segments.segment_ref",
                "segments.transcript_ref",
                "segments.start_us",
                "segments.end_us",
                "segments.text",
                *(["segments.cv_features"] if cv_scenes else []),
            ],
            "payload_sha256": payload_hash,
            "expires_at": expiry,
            "payload": payload,
            "stats": {
                "transcript_count": len(transcript_ids) if use_transcript else 0,
                "segment_count": len(payload_segments),
                "character_count": sum(len(x["text"]) for x in payload_segments),
                "estimated_tokens": max(1, sum(len(x["text"]) for x in payload_segments) // 4),
                "cv_scene_count": len(cv_scenes),
                "candidate_source": source,
            },
        }

    def _cv_scenes(self, project_id: str) -> list[dict[str, Any]]:
        """CV 场景段召回（阶段三首版）：项目全部视频素材的 ready 分析 →
        场景切点合并为 ≥2s 场景段 → 特征排序（含人脸 > 运动 > 清晰度 > 序）。

        段 id 稳定可复现（asset_id + 场景序），供白名单回查。
        """
        scenes: list[dict[str, Any]] = []
        with self.db.connection() as db:
            assets = db.execute(
                "SELECT id,availability FROM assets WHERE project_id=? AND kind='video'",
                (project_id,),
            ).fetchall()
        for asset in assets:
            if asset["availability"] != "available":
                continue
            samples = self.cv_signals.samples_for_range(asset["id"], 0, 1 << 62) if self.cv_signals else []
            if not samples:
                continue
            # ADR-0005 阶段 1：sparse 分析的运动能量系统性偏低（采样帧间差分，
            # 密度越稀越易漏峰值），排序时折减——**只降权不排除**。
            density = self.cv_signals.latest_density(asset["id"]) if self.cv_signals else None
            sparse = bool(density and density.get("density_status") == "sparse")
            # 场景切点（含首帧）分界 → 场景段。
            cuts = [0] + [
                s["timestamp_us"] for s in samples if s["scene_cut"]
            ]
            for index, start in enumerate(cuts):
                end = cuts[index + 1] if index + 1 < len(cuts) else (
                    samples[-1]["timestamp_us"] + CV_MIN_SCENE_US
                )
                if end - start < CV_MIN_SCENE_US:
                    continue
                inside = [s for s in samples if start <= s["timestamp_us"] < end]
                if not inside:
                    continue
                scenes.append(
                    {
                        "scene_id": f"cv_scene_{asset['id']}_{index}",
                        "asset_id": asset["id"],
                        "start_us": int(start),
                        "end_us": int(min(end, 1 << 62)),
                        # 仅供本方法排序使用；不进 provider 载荷（载荷只取 features）。
                        "sparse": sparse,
                        "features": {
                            "face": max(
                                (s["face_count"] or 0) for s in inside
                            ),
                            "motion": max(
                                s["motion_energy"] for s in inside
                            ),
                            "sharpness": max(s["sharpness"] for s in inside),
                        },
                    }
                )
        # 排序：含人脸 > 运动能量 > 清晰度（规划门 §5 权重首版）。
        # sparse 分析的运动能量按 CV_SPARSE_MOTION_WEIGHT 折减后再比较。
        scenes.sort(
            key=lambda scene: (
                -scene["features"]["face"],
                -min(
                    scene["features"]["motion"]
                    * (CV_SPARSE_MOTION_WEIGHT if scene["sparse"] else 1.0),
                    1.0,
                ),
                -min(scene["features"]["sharpness"], 1.0),
                scene["start_us"],
            )
        )
        return scenes[:CV_MAX_SCENES]

    def _select(self, brief: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        keys = set(
            (brief["topic"] + " " + brief["narrative_goal"] + " " + " ".join(brief["must_keep"]))
            .lower()
            .split()
        )
        ranked = sorted(
            rows,
            key=lambda row: (
                -sum(key in row["text"].lower() for key in keys),
                -(row["confidence"] or 0),
                row["start_us"],
                row["id"],
            ),
        )
        chosen = []
        chars = 0
        duration = 0
        for row in ranked:
            if (
                len(chosen) >= 160
                or chars + len(row["text"]) > 32000
                or duration + row["end_us"] - row["start_us"] > 1_200_000_000
            ):
                continue
            chosen.append(row)
            chars += len(row["text"])
            duration += row["end_us"] - row["start_us"]
        if not chosen:
            raise DomainError("PLANNING_NO_SEGMENTS", "预筛未得到可用片段")
        return sorted(chosen, key=lambda row: (row["start_us"], row["id"]))

    def create_generation(
        self, project_id: str, preview_id: str, payload_sha256: str, jobs: Any
    ) -> dict[str, Any]:
        with self.db.connection() as db:
            preview = db.execute(
                "SELECT * FROM egress_previews WHERE id=? AND project_id=?",
                (preview_id, project_id),
            ).fetchone()
            if not preview:
                raise DomainError("EGRESS_PREVIEW_NOT_FOUND", "外传预览不存在")
            if preview["payload_sha256"] != payload_sha256:
                raise DomainError("EGRESS_PREVIEW_CHANGED", "外传内容已变化")
            if datetime.fromisoformat(preview["expires_at"].replace("Z", "+00:00")) <= datetime.now(
                UTC
            ):
                raise DomainError("EGRESS_PREVIEW_EXPIRED", "外传预览已过期")
            stored = self.pending_store.get(preview_id)
            if not stored:
                raise DomainError(
                    "CANDIDATE_EGRESS_PAYLOAD_UNAVAILABLE", "外传内容已失效，请重新准备"
                )
            payload = stored["payload"]
            if sha256(payload) != payload_sha256 or stored["payload_sha256"] != payload_sha256:
                raise DomainError("EGRESS_PREVIEW_CHANGED", "外传内容已变化")
            if (
                document_sha256(json_loads(preview["brief_snapshot_json"]))
                != preview["brief_sha256"]
            ):
                raise DomainError("EGRESS_PREVIEW_CHANGED", "Brief 快照已变化")
            current_brief = self.get_brief(project_id)
            if (
                current_brief["document_sha256"] != document_sha256(current_brief)
                or current_brief["document_sha256"] != preview["brief_sha256"]
            ):
                raise DomainError("EGRESS_PREVIEW_CHANGED", "Brief 已变化")
            recipe = db.execute(
                "SELECT document_json,document_sha256 FROM recipe_snapshots WHERE id=?",
                (preview["recipe_snapshot_id"],),
            ).fetchone()
            if (
                not recipe
                or document_sha256(json_loads(recipe["document_json"])) != recipe["document_sha256"]
            ):
                raise DomainError("EGRESS_PREVIEW_CHANGED", "Recipe 快照已变化")
            provider = db.execute(
                "SELECT * FROM provider_configs WHERE id=?", (preview["provider_config_id"],)
            ).fetchone()
            if not provider or not provider["enabled"]:
                raise DomainError("PROVIDER_DISABLED", "Provider 未启用")
            current_provider = self._provider_with_candidate_capability(provider["id"])
            provider_snapshot = json_loads(preview["provider_snapshot_json"])
            if sha256(provider_snapshot) != preview["provider_config_sha256"] or any(
                current_provider[key] != provider_snapshot[key]
                for key in (
                    "provider_config_id",
                    "kind",
                    "display_name",
                    "base_url",
                    "model",
                    "enabled",
                    "candidate_capability_status",
                    "candidate_response_adapter_id",
                    "candidate_probe_protocol_version",
                    "candidate_capability_tested_at",
                    "candidate_capability_failure_code",
                    "candidate_capability_probe_sha256",
                )
            ):
                raise DomainError("EGRESS_PREVIEW_CHANGED", "Provider 配置已变化")
            if not self._candidate_supported(current_provider) or any(
                stored[key] != value
                for key, value in {
                    "response_adapter_id": current_provider["candidate_response_adapter_id"],
                    "probe_protocol_version": current_provider["candidate_probe_protocol_version"],
                    "probe_sha256": current_provider["candidate_capability_probe_sha256"],
                    "model": current_provider["model"],
                    "provider_config_sha256": sha256(provider_snapshot),
                }.items()
            ):
                raise DomainError("CANDIDATE_CAPABILITY_STALE", "Provider 能力状态已变化")
            if any(
                preview[column] != stored[key]
                for column, key in (
                    ("candidate_response_adapter_id", "response_adapter_id"),
                    ("candidate_probe_protocol_version", "probe_protocol_version"),
                    ("candidate_capability_probe_sha256", "probe_sha256"),
                )
            ):
                raise DomainError("CANDIDATE_CAPABILITY_STALE", "Provider 能力快照已变化")
            transcript_ids = json_loads(preview["transcript_refs_json"])
            for transcript_id in transcript_ids:
                transcript = db.execute(
                    "SELECT t.status,t.source_fingerprint,a.availability,a.fingerprint,a.project_id "  # noqa: E501
                    "FROM transcripts t JOIN assets a ON a.id=t.asset_id WHERE t.id=?",
                    (transcript_id,),
                ).fetchone()
                if (
                    not transcript
                    or transcript["project_id"] != project_id
                    or transcript["status"] != "ready"
                    or transcript["availability"] != "available"
                    or transcript["source_fingerprint"] != transcript["fingerprint"]
                ):
                    raise DomainError("EGRESS_PREVIEW_CHANGED", "转录或素材已变化")
            generation_id = f"generation_{new_id()}"
            consent_id = f"consent_{new_id()}"
            invocation_id = f"invocation_{new_id()}"
            now = utc_now()
            db.execute("BEGIN")
            try:
                db.execute(
                    "INSERT INTO egress_consents(id,egress_preview_id,payload_sha256,created_at) VALUES (?,?,?,?)",  # noqa: E501
                    (consent_id, preview_id, payload_sha256, now),
                )
                baseline = db.execute(
                    "SELECT current_timeline_revision_id FROM projects WHERE id=?", (project_id,)
                ).fetchone()[0]
                db.execute(
                    "INSERT INTO candidate_generations(id,project_id,egress_preview_id,egress_consent_id,provider_config_id,brief_snapshot_json,brief_sha256,recipe_snapshot_id,timeline_baseline_revision_id,status,payload_sha256,created_at,updated_at,candidate_response_adapter_id,candidate_probe_protocol_version,candidate_capability_probe_sha256,provider_config_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        generation_id,
                        project_id,
                        preview_id,
                        consent_id,
                        provider["id"],
                        preview["brief_snapshot_json"],
                        preview["brief_sha256"],
                        preview["recipe_snapshot_id"],
                        baseline,
                        "queued",
                        payload_sha256,
                        now,
                        now,
                        stored["response_adapter_id"],
                        stored["probe_protocol_version"],
                        stored["probe_sha256"],
                        stored["provider_config_sha256"],
                    ),
                )
                db.execute(
                    "INSERT INTO provider_invocations(id,candidate_generation_id,provider_config_id,capability,provider_name,model,prompt_template_version,output_schema_version,input_sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                    (
                        invocation_id,
                        generation_id,
                        provider["id"],
                        "candidate_planning",
                        provider["display_name"],
                        provider["model"],
                        "candidate-plan-v1",
                        "candidate-plan-output-v1",
                        payload_sha256,
                        "queued",
                        now,
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        moved = self.pending_store.take(preview_id)
        if not moved:
            raise DomainError("CANDIDATE_EGRESS_PAYLOAD_UNAVAILABLE", "外传内容已失效，请重新准备")
        self.generation_store.put(
            generation_id,
            {
                **moved,
                "expires_at": (datetime.now(UTC) + timedelta(minutes=15))
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            },
        )
        job = jobs.create_candidate_generation(
            project_id, generation_id, invocation_id, payload_sha256
        )
        return {"candidate_generation_id": generation_id, "job": job}

    async def run_generation(
        self, row: Any, cancel: asyncio.Event, progress: Any, stage: Any
    ) -> dict[str, Any]:
        generation_id = row["candidate_generation_id"]
        payload_info = json_loads(row["input_json"])
        stage("loading_inputs")
        with self.db.connection() as db:
            generation = db.execute(
                "SELECT * FROM candidate_generations WHERE id=?", (generation_id,)
            ).fetchone()
            invocation = db.execute(
                "SELECT * FROM provider_invocations WHERE id=?", (row["provider_invocation_id"],)
            ).fetchone()
            preview = (
                db.execute(
                    "SELECT * FROM egress_previews WHERE id=?", (generation["egress_preview_id"],)
                ).fetchone()
                if generation
                else None
            )
            consent = (
                db.execute(
                    "SELECT * FROM egress_consents WHERE id=?", (generation["egress_consent_id"],)
                ).fetchone()
                if generation
                else None
            )
            provider = (
                db.execute(
                    "SELECT * FROM provider_configs WHERE id=?", (generation["provider_config_id"],)
                ).fetchone()
                if generation
                else None
            )
        if not generation or not invocation or not preview or not consent or not provider:
            raise ProviderError("PLANNING_INPUT_INVALID", "规划输入无效")
        stored = self.generation_store.take(generation_id)
        if not stored:
            raise ProviderError("CANDIDATE_EGRESS_PAYLOAD_UNAVAILABLE", "外传内容不可用")
        payload = stored["payload"]
        if (
            consent["consumed_at"]
            or sha256(payload) != payload_info["egress_payload_sha256"]
            or generation["payload_sha256"] != payload_info["egress_payload_sha256"]
            or not self._candidate_supported(
                self._provider_with_candidate_capability(provider["id"])
            )
            or generation["candidate_response_adapter_id"] != stored["response_adapter_id"]
            or generation["candidate_probe_protocol_version"] != stored["probe_protocol_version"]
            or generation["candidate_capability_probe_sha256"] != stored["probe_sha256"]
            or generation["provider_config_sha256"] != stored["provider_config_sha256"]
            or provider["model"] != stored["model"]
        ):
            raise ProviderError("CANDIDATE_CAPABILITY_STALE", "Provider 能力状态已变化")
        if cancel.is_set():
            raise ProviderError("PROVIDER_CANCELLED", "调用已取消")
        stage("building_payload")
        key = self.vault.for_request(provider["id"])
        with self.db.connection() as db:
            now = utc_now()
            db.execute("UPDATE egress_consents SET consumed_at=? WHERE id=?", (now, consent["id"]))
            db.execute(
                "UPDATE candidate_generations SET status='running',updated_at=? WHERE id=?",
                (now, generation_id),
            )
            db.execute(
                "UPDATE provider_invocations SET status='running',started_at=? WHERE id=?",
                (now, invocation["id"]),
            )
        stage("calling_provider")
        progress(0.25)
        started = time.monotonic()
        try:
            result = await self.provider_factory().generate(
                StructuredTextRequest(
                    provider["id"],
                    provider["base_url"],
                    provider["model"],
                    key,
                    payload,
                    capability="candidate_planning",
                    response_adapter_id=generation["candidate_response_adapter_id"],
                ),
                cancel,
            )
            stage("validating_response")
            candidates = self._validated_candidates(generation, preview, result.value)
            stage("persisting_candidates")
            progress(0.75)
            self._persist_candidates(
                generation,
                invocation,
                candidates,
                result,
                duration_ms=round((time.monotonic() - started) * 1000),
                estimated_cost=invocation_cost(provider, result.usage),
            )
        except asyncio.CancelledError:
            self._archive_generation_failure(
                generation_id,
                invocation["id"],
                "PROVIDER_CANCELLED",
                "Provider 调用已取消",
            )
            raise
        except ProviderError as exc:
            self._archive_generation_failure(generation_id, invocation["id"], exc.code, exc.message)
            raise
        progress(1)
        return {"candidate_generation_id": generation_id, "candidate_count": 3}

    def _archive_generation_failure(
        self, generation_id: str, invocation_id: str, code: str, message: str
    ) -> None:
        with self.db.connection() as db:
            now = utc_now()
            status = "cancelled" if code == "PROVIDER_CANCELLED" else "failed"
            db.execute(
                "UPDATE candidate_generations SET status=?,updated_at=?,finished_at=? WHERE id=?",  # noqa: E501
                (status, now, now, generation_id),
            )
            db.execute(
                "UPDATE provider_invocations SET status=?,finished_at=?,provider_may_have_processed=?,error_code=?,error_message=? WHERE id=?",  # noqa: E501
                (status, now, int(code == "PROVIDER_CANCELLED"), code, message, invocation_id),
            )

    async def test_provider(self, provider_id: str) -> dict[str, Any]:
        provider = self.providers.get(provider_id)
        secret = self.vault.for_request(provider_id)
        invocation_id = f"invocation_{new_id()}"
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO provider_invocations(id,candidate_generation_id,provider_config_id,capability,provider_name,model,prompt_template_version,output_schema_version,input_sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",  # noqa: E501
                (
                    invocation_id,
                    None,
                    provider_id,
                    "connection_test",
                    provider["display_name"],
                    provider["model"],
                    "connection-test-v1",
                    "candidate-plan-output-v1",
                    sha256({"capability": "connection_test"}),
                    "running",
                    now,
                ),
            )
        payload = {
            "capability": "connection_test",
            "instruction": "Return exactly three empty candidate variants for capability verification.",  # noqa: E501
        }
        try:
            result = await self.provider_factory().generate(
                StructuredTextRequest(
                    provider_id,
                    provider["base_url"],
                    provider["model"],
                    secret,
                    payload,
                    capability="connection_test",
                ),
                asyncio.Event(),
            )
            with self.db.connection() as db:
                db.execute(
                    "UPDATE provider_invocations SET status='succeeded',finished_at=?,usage_json=?,provider_request_id=? WHERE id=?",  # noqa: E501
                    (
                        utc_now(),
                        json_dumps(result.usage) if result.usage else None,
                        result.provider_request_id,
                        invocation_id,
                    ),
                )
        except ProviderError as exc:
            with self.db.connection() as db:
                db.execute(
                    "UPDATE provider_invocations SET status='failed',finished_at=?,error_code=?,error_message=? WHERE id=?",  # noqa: E501
                    (utc_now(), exc.code, exc.message, invocation_id),
                )
            raise
        return {
            "provider_config_id": provider_id,
            "provider_invocation_id": invocation_id,
            "status": "succeeded",
        }

    def _validated_candidates(
        self, generation: Any, preview: Any, value: dict[str, Any]
    ) -> list[dict[str, Any]]:
        entries = value.get("candidates") if isinstance(value, dict) else None
        if (
            not isinstance(entries, list)
            or len(entries) != 3
            or {x.get("variant") for x in entries if isinstance(x, dict)} != set(VARIANTS)
        ):
            raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "候选输出不符合固定三方案约束")
        brief = json_loads(generation["brief_snapshot_json"])
        whitelist = json_loads(preview["segment_whitelist_json"])
        refs = {x["segment_ref"]: x for x in whitelist}
        transcript_refs = {
            ref["segment_ref"]: ref["segment_id"]
            for ref in refs.values()
            if ref.get("source", "transcript") == "transcript"
        }
        cv_refs = {
            ref["segment_ref"]: ref for ref in refs.values() if ref.get("source") == "cv"
        }
        rows: dict[str, dict[str, Any]] = {}
        if transcript_refs:
            placeholders = ",".join("?" * len(transcript_refs))
            with self.db.connection() as db:
                rows.update(
                    {
                        r["id"]: {**dict(r), "source": "transcript"}
                        for r in db.execute(
                            "SELECT s.id,s.transcript_id,s.start_us,s.end_us,s.text,t.asset_id "
                            "FROM transcript_segments s JOIN transcripts t ON t.id=s.transcript_id "
                            f"WHERE s.id IN ({placeholders})",
                            list(transcript_refs.values()),
                        ).fetchall()
                    }
                )
        if cv_refs:
            with self.db.connection() as db:
                for ref, entry in cv_refs.items():
                    asset = db.execute(
                        "SELECT id,availability FROM assets WHERE id=? AND project_id=?",
                        (entry["asset_id"], generation["project_id"]),
                    ).fetchone()
                    if not asset or asset["availability"] != "available":
                        raise ProviderError(
                            "PROVIDER_SCHEMA_MISMATCH", "候选引用的 CV 场景素材不可用"
                        )
                    rows[entry["segment_id"]] = {
                        "id": entry["segment_id"],
                        "source": "cv",
                        "asset_id": entry["asset_id"],
                        "start_us": entry["start_us"],
                        "end_us": entry["end_us"],
                        "text": "",
                        "transcript_id": None,
                    }
        documents = []
        for ordinal, variant in enumerate(VARIANTS):
            entry = next(x for x in entries if x["variant"] == variant)
            clips = entry.get("clips")
            if not isinstance(clips, list) or not 1 <= len(clips) <= 30:
                raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "候选片段数量无效")
            normalized = []
            duration = 0
            for index, clip in enumerate(clips):
                selected = clip.get("segment_ids") if isinstance(clip, dict) else None
                if (
                    not isinstance(selected, list)
                    or not selected
                    or any(x not in refs for x in selected)
                ):
                    raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "候选引用越界")
                actual = [
                    rows[
                        refs[x]["segment_id"] if isinstance(refs[x], dict) else refs[x]
                    ]
                    for x in selected
                ]
                if actual[0]["source"] == "cv":
                    # CV 剪辑：允许同素材多场景段拼接（真实 provider 验证
                    # 2026-09-20：deepseek 自然行为即跨场景取段——粗剪语义
                    # 本就如此）。校验收缩为"同一素材"（拼接点由 adopt 按
                    # 时间线顺序铺排，无源内连续性要求）。
                    if len({x["asset_id"] for x in actual}) != 1:
                        raise ProviderError(
                            "PROVIDER_SCHEMA_MISMATCH", "候选 CV 片段跨素材"
                        )
                elif len({x["transcript_id"] for x in actual}) != 1 or any(
                    actual[n]["end_us"] > actual[n + 1]["start_us"] for n in range(len(actual) - 1)
                ):
                    raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "候选片段不连续")
                reason = _clean_text(clip.get("reason"), 1, 300, "reason")
                score = clip.get("model_score")
                if score is not None and (
                    not isinstance(score, (int, float))
                    or isinstance(score, bool)
                    or not 0 <= score <= 1
                ):
                    raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "模型参考分无效")
                duration += actual[-1]["end_us"] - actual[0]["start_us"]
                is_cv = actual[0]["source"] == "cv"
                normalized.append(
                    {
                        "clip_id": f"candidate_clip_{new_id()}",
                        "order_index": index,
                        "asset_id": actual[0]["asset_id"],
                        "transcript_id": actual[0]["transcript_id"],
                        "source_kind": "cv" if is_cv else "transcript",
                        "segment_ids": [x["id"] for x in actual],
                        "source_start_us": actual[0]["start_us"],
                        "source_end_us": actual[-1]["end_us"],
                        "reason": reason,
                        "model_score": float(score) if score is not None else None,
                        "caption_text": " ".join(x["text"] for x in actual),
                    }
                )
            if (
                not 0.8 * brief["target_duration_us"]
                <= duration
                <= 1.2 * brief["target_duration_us"]
                or not 15_000_000 <= duration <= 180_000_000
            ):
                raise ProviderError("PROVIDER_SCHEMA_MISMATCH", "候选时长无效")
            doc = {
                "schema_version": 1,
                "candidate_plan_id": f"candidate_{new_id()}",
                "candidate_generation_id": generation["id"],
                "project_id": generation["project_id"],
                "ordinal": ordinal,
                "variant": variant,
                "title_suggestion": _clean_text(entry.get("title_suggestion"), 1, 200, "title"),
                "summary": _clean_text(entry.get("summary"), 1, 500, "summary"),
                "duration_us": duration,
                "clips": normalized,
                "warnings": [],
            }
            doc["document_sha256"] = document_sha256(doc)
            documents.append(doc)
        return documents

    def _persist_candidates(
        self,
        generation: Any,
        invocation: Any,
        candidates: list[dict[str, Any]],
        result: Any,
        duration_ms: int | None = None,
        estimated_cost: float | None = None,
    ) -> None:
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                now = utc_now()
                for candidate in candidates:
                    db.execute(
                        "INSERT INTO candidate_plans(id,candidate_generation_id,project_id,ordinal,variant,document_json,document_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",  # noqa: E501
                        (
                            candidate["candidate_plan_id"],
                            generation["id"],
                            generation["project_id"],
                            candidate["ordinal"],
                            candidate["variant"],
                            json_dumps(candidate),
                            candidate["document_sha256"],
                            now,
                        ),
                    )
                db.execute(
                    "UPDATE candidate_generations SET status='succeeded',updated_at=?,finished_at=? WHERE id=?",  # noqa: E501
                    (now, now, generation["id"]),
                )
                db.execute(
                    "UPDATE provider_invocations SET status='succeeded',finished_at=?,duration_ms=?,usage_json=?,estimated_cost=?,provider_request_id=?,output_sha256=? WHERE id=?",  # noqa: E501
                    (
                        now,
                        duration_ms,
                        json_dumps(result.usage) if result.usage else None,
                        estimated_cost,
                        result.provider_request_id,
                        sha256(result.value),
                        invocation["id"],
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def list_generations(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id,status,payload_sha256,created_at,updated_at,finished_at FROM candidate_generations WHERE project_id=? ORDER BY created_at DESC,id DESC",  # noqa: E501
                (project_id,),
            ).fetchall()
        return [
            {
                "candidate_generation_id": r["id"],
                "status": r["status"],
                "payload_sha256": r["payload_sha256"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "finished_at": r["finished_at"],
            }
            for r in rows
        ]

    def get_generation(self, generation_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM candidate_generations WHERE id=?", (generation_id,)
            ).fetchone()
            if not row:
                raise DomainError("CANDIDATE_GENERATION_NOT_FOUND", "候选生成不存在")
            candidates = db.execute(
                "SELECT document_json FROM candidate_plans WHERE candidate_generation_id=? ORDER BY ordinal",  # noqa: E501
                (generation_id,),
            ).fetchall()
        return {
            "candidate_generation_id": row["id"],
            "project_id": row["project_id"],
            "status": row["status"],
            "payload_sha256": row["payload_sha256"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
            "candidate_plans": [json_loads(x[0]) for x in candidates],
        }

    def list_candidates(self, project_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT document_json FROM candidate_plans WHERE project_id=? ORDER BY created_at DESC,ordinal",  # noqa: E501
                (project_id,),
            ).fetchall()
        return [json_loads(x[0]) for x in rows]

    def get_candidate(self, candidate_id: str) -> dict[str, Any]:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT document_json FROM candidate_plans WHERE id=?", (candidate_id,)
            ).fetchone()
        if not row:
            raise DomainError("CANDIDATE_PLAN_NOT_FOUND", "候选不存在")
        return json_loads(row[0])

    def get_candidate_clip(
        self, project_id: str, candidate_id: str, candidate_clip_id: str
    ) -> dict[str, Any]:
        candidate = self.get_candidate(candidate_id)
        if candidate["project_id"] != project_id:
            raise DomainError("CANDIDATE_PLAN_NOT_FOUND", "候选不存在")
        for clip in candidate["clips"]:
            if clip["clip_id"] == candidate_clip_id:
                return {
                    "candidate_plan_id": candidate_id,
                    "project_id": project_id,
                    "candidate_clip_id": clip["clip_id"],
                    "asset_id": clip["asset_id"],
                    "transcript_id": clip["transcript_id"],
                    "segment_ids": clip["segment_ids"],
                    "source_start_us": clip["source_start_us"],
                    "source_end_us": clip["source_end_us"],
                    "caption_text": clip["caption_text"],
                }
        raise DomainError("CANDIDATE_CLIP_NOT_FOUND", "候选片段不存在")

    def adopt(self, project_id: str, candidate_id: str, request: dict[str, Any]) -> dict[str, Any]:
        if (
            set(request) != {"schema_version", "candidate_document_sha256", "base_revision_id"}
            or request["schema_version"] != 1
        ):
            raise DomainError("CANDIDATE_ADOPT_INVALID", "采用请求无效")
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                candidate_row = db.execute(
                    "SELECT * FROM candidate_plans WHERE id=? AND project_id=?",
                    (candidate_id, project_id),
                ).fetchone()
                if not candidate_row:
                    raise DomainError("CANDIDATE_PLAN_NOT_FOUND", "候选不存在")
                if candidate_row["document_sha256"] != request["candidate_document_sha256"]:
                    raise DomainError("CANDIDATE_ADOPT_INVALID", "候选哈希不匹配")
                if db.execute(
                    "SELECT 1 FROM candidate_adoptions WHERE candidate_plan_id=?", (candidate_id,)
                ).fetchone():
                    raise DomainError("CANDIDATE_ALREADY_ADOPTED", "候选已被采用")
                if db.execute(
                    "SELECT 1 FROM timeline_drafts WHERE project_id=?", (project_id,)
                ).fetchone():
                    raise DomainError("TIMELINE_DRAFT_CONFLICT", "存在未处理时间线草稿")
                generation = db.execute(
                    "SELECT * FROM candidate_generations WHERE id=?",
                    (candidate_row["candidate_generation_id"],),
                ).fetchone()
                project = db.execute(
                    "SELECT current_timeline_revision_id,canvas_json FROM projects WHERE id=?",
                    (project_id,),
                ).fetchone()
                if (
                    not project
                    or project["current_timeline_revision_id"]
                    != generation["timeline_baseline_revision_id"]
                    or request["base_revision_id"] != generation["timeline_baseline_revision_id"]
                ):
                    raise DomainError("TIMELINE_CONFLICT", "生成后的时间线基线已变化")
                candidate = json_loads(candidate_row["document_json"])
                brief = json_loads(generation["brief_snapshot_json"])
                clips = []
                captions = []
                offset = 0
                transcripts = []
                for candidate_clip in candidate["clips"]:
                    asset = db.execute(
                        "SELECT * FROM assets WHERE id=? AND project_id=?",
                        (candidate_clip["asset_id"], project_id),
                    ).fetchone()
                    is_cv = candidate_clip.get("source_kind") == "cv"
                    transcript = None
                    segments = []
                    if is_cv:
                        # CV 剪辑：无转录依赖——素材可用 + 指纹未变即可
                        #（范围来自生成时快照，adopt 侧以 asset 时长兜底校验）。
                        if (
                            not asset
                            or asset["availability"] != "available"
                        ):
                            raise DomainError("CANDIDATE_SOURCE_INVALID", "候选引用的素材已变化")
                        media_info = (
                            json_loads(asset["media_info_json"])
                            if asset["media_info_json"]
                            else {}
                        )
                        asset_duration = media_info.get("duration_us")
                        if (
                            not isinstance(asset_duration, int)
                            or candidate_clip["source_end_us"] > asset_duration
                            or candidate_clip["source_start_us"] < 0
                            or candidate_clip["source_end_us"]
                            <= candidate_clip["source_start_us"]
                        ):
                            raise DomainError(
                                "CANDIDATE_SOURCE_INVALID", "候选引用的素材范围已变化"
                            )
                    else:
                        transcript = db.execute(
                            "SELECT * FROM transcripts WHERE id=?", (candidate_clip["transcript_id"],)
                        ).fetchone()
                        ids = candidate_clip["segment_ids"]
                        marks = ",".join("?" * len(ids))
                        segments = db.execute(
                            f"SELECT id,start_us,end_us,text FROM transcript_segments WHERE id IN ({marks}) ORDER BY start_us",  # noqa: E501
                            ids,
                        ).fetchall()
                        if (
                            not asset
                            or not transcript
                            or asset["availability"] != "available"
                            or asset["fingerprint"] != transcript["source_fingerprint"]
                            or transcript["status"] != "ready"
                            or len(segments) != len(ids)
                        ):
                            raise DomainError("CANDIDATE_SOURCE_INVALID", "候选引用的素材或转录已变化")
                    duration = candidate_clip["source_end_us"] - candidate_clip["source_start_us"]
                    clip_id = f"clip_{new_id()}"
                    clips.append(
                        {
                            "clip_id": clip_id,
                            "track_id": "V1",
                            "order_index": len(clips),
                            "asset_id": asset["id"],
                            "asset_kind": "video",
                            "source_start_us": candidate_clip["source_start_us"],
                            "source_end_us": candidate_clip["source_end_us"],
                            "timeline_start_us": offset,
                            "timeline_end_us": offset + duration,
                            "layout": brief["default_layout"],
                            "audio": {
                                "enabled": brief["original_audio_policy"] == "preserve",
                                "gain_db": 0.0,
                            },
                        }
                    )
                    if brief["caption_policy"] == "auto_from_transcript" and not is_cv:
                        captions.append(
                            {
                                "caption_id": f"caption_{new_id()}",
                                "track_id": "C1",
                                "source_clip_id": clip_id,
                                "start_us": offset,
                                "end_us": offset + duration,
                                "text": " ".join(x["text"] for x in segments),
                                "preset_id": brief["caption_preset_id"],
                                "origin": "transcript",
                                "edited": False,
                                "source_segment_ids": ids,
                            }
                        )
                    offset += duration
                    if transcript is not None:
                        transcripts.append(transcript["id"])
                canvas = json_loads(project["canvas_json"])
                document = {
                    "schema_version": 1,
                    "project_id": project_id,
                    "canvas": {
                        "width": 1080,
                        "height": 1920,
                        "fps_num": 30,
                        "fps_den": 1,
                        "background_color": canvas.get("background_color", "#000000"),
                    },
                    "tracks": [
                        {"id": "V1", "kind": "visual", "locked": False},
                        {"id": "C1", "kind": "caption", "locked": False},
                    ],
                    "clips": clips,
                    "captions": captions,
                    "provenance": {
                        "created_by": "user",
                        "source_transcript_ids": sorted(set(transcripts)),
                    },
                }
                revision = self.timelines.create_revision_from_document(
                    db,
                    project_id,
                    generation["timeline_baseline_revision_id"],
                    document,
                    "采用 AI 候选方案",
                )
                db.execute(
                    "INSERT INTO candidate_adoptions(id,candidate_plan_id,project_id,timeline_revision_id,created_at) VALUES (?,?,?,?,?)",  # noqa: E501
                    (
                        f"adoption_{new_id()}",
                        candidate_id,
                        project_id,
                        revision["timeline_revision_id"],
                        utc_now(),
                    ),
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return {"candidate_plan_id": candidate_id, "timeline_revision": revision}
