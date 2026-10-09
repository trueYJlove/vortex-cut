"""PROVIDER 韧性（真实世界验证发现 4，2026-09-21）：
- generate() 总预算 deadline（read timeout 被网关慢滴重置的兜底）；
- 双探测（candidate/patch）网络类错误重试（抖动不判死刑，schema 错误不重试）；
- token 预算耗尽（P43/R1）：确定性失败码，非网络、不重试。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from aivs_core.database import Database
from aivs_core.planning import PlanningService, ProviderRepository, RecipeRegistry
from aivs_core.providers import (
    PROBE_TOTAL_BUDGET_SECONDS,
    RETRYABLE_PROVIDER_ERRORS,
    OpenAICompatibleTextProvider,
    ProviderError,
    ProviderSecretVault,
    StructuredTextRequest,
    TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
)
from aivs_core.timeline import TimelineService


def _service(tmp_path: Path, factory: Any) -> tuple[PlanningService, Database]:
    db = Database(tmp_path / "app.db")
    db.initialize()
    vault = ProviderSecretVault()
    providers = ProviderRepository(db, vault)
    providers.create(
        {
            "kind": "openai_compatible_text",
            "display_name": "provider",
            "base_url": "https://provider.example/v1",
            "model": "m",
            "input_price_per_million": 2.0,
            "output_price_per_million": 4.0,
        }
    )
    vault.set(providers.list()[0]["provider_config_id"], "TEST_API_KEY")
    planning = PlanningService(
        db, RecipeRegistry(Path("resources/recipes")), providers, vault,
        TimelineService(db), provider_factory=factory,
    )
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) "
            "VALUES ('p1','P','active','{}','root','root','now','now','now')"
        )
    return planning, db


# ----------------------------------------------------------------------
# 总预算 deadline：慢滴挂起被强制封顶
# ----------------------------------------------------------------------


async def test_generate_total_budget_caps_slow_drip(tmp_path: Path) -> None:
    """挂起 provider（永不返回）→ 总预算 deadline 强制 PROVIDER_TIMEOUT。"""
    from aivs_core.providers import OpenAICompatibleTextProvider

    class HangingProvider(OpenAICompatibleTextProvider):
        async def _generate_inner(self, request: Any, cancel_event: Any) -> Any:
            # 模拟网关慢滴：永挂但响应 cancel（wait_for 取消时收尾）
            await asyncio.Event().wait()

    service, _db = _service(tmp_path, HangingProvider)
    provider = service.providers.list()[0]
    request = StructuredTextRequest(
        provider["provider_config_id"], provider["base_url"], provider["model"],
        "key", {"probe": True},
        capability="timeline_patch_capability_probe",
        response_adapter_id="openai_chat_completions_json_schema_v1",
    )
    # 缩短预算（monkeypatch 常量不生效——frozen module 变量按值读取，
    # 直接改模块属性）
    import aivs_core.providers as providers_module

    original = providers_module.PROBE_TOTAL_BUDGET_SECONDS
    providers_module.PROBE_TOTAL_BUDGET_SECONDS = 0.2
    try:
        with pytest.raises(ProviderError) as exc:
            await HangingProvider().generate(request, asyncio.Event())
    finally:
        providers_module.PROBE_TOTAL_BUDGET_SECONDS = original
    assert "总预算" in exc.value.message


async def test_generate_budget_not_triggered_on_fast_response(tmp_path: Path) -> None:
    """正常快速响应不受预算影响。"""
    from aivs_core.providers import OpenAICompatibleTextProvider

    class FastProvider(OpenAICompatibleTextProvider):
        async def _generate_inner(self, request: Any, cancel_event: Any) -> Any:
            from aivs_core.providers import StructuredTextResult
            return StructuredTextResult(
                {"summary": "ok", "operations": []}, None, None)

    service, _db = _service(tmp_path, FastProvider)
    provider = service.providers.list()[0]
    request = StructuredTextRequest(
        provider["provider_config_id"], provider["base_url"], provider["model"],
        "key", {"probe": True},
        capability="timeline_patch_capability_probe",
        response_adapter_id="openai_chat_completions_json_schema_v1",
    )
    result = await FastProvider().generate(request, asyncio.Event())
    assert result.value["summary"] == "ok"
    _ = PROBE_TOTAL_BUDGET_SECONDS


# ----------------------------------------------------------------------
# 探测网络错误重试：抖动恢复，schema 错误不重试
# ----------------------------------------------------------------------


@pytest.mark.parametrize("retryable_code", ["PROVIDER_NETWORK_ERROR", "PROVIDER_UNAVAILABLE"])
async def test_candidate_probe_retries_network_errors(
    tmp_path: Path, retryable_code: str
) -> None:
    """前两次网络抖动 → 第三次成功 → supported（重试生效）。"""
    from aivs_core.providers import StructuredTextResult

    attempts = {"n": 0}

    class FlakyProvider:
        async def generate(self, request: Any, cancel_event: Any) -> StructuredTextResult:
            attempts["n"] += 1
            if attempts["n"] <= 2:
                raise ProviderError(retryable_code, "transient")
            refs = [s["segment_ref"] for s in request.payload["segments"]]
            return StructuredTextResult(
                {
                    "candidates": [
                        {"variant": v, "title_suggestion": v, "summary": "s",
                         "clips": [{"segment_ids": refs, "reason": "r",
                                    "model_score": None}]}
                        for v in ("balanced", "compact", "bold")
                    ]
                },
                None, None,
            )

    planning, _db = _service(tmp_path, lambda: FlakyProvider())
    _seed_probe_payload(planning)
    provider = planning.providers.list()[0]
    cap = await planning.test_candidate_provider_capability(
        provider["provider_config_id"])
    assert cap["candidate_capability_status"] == "supported"
    assert attempts["n"] == 3


async def test_candidate_probe_no_retry_on_schema_error(tmp_path: Path) -> None:
    """schema 错误是确定性失败 → 不重试（每适配器恰 1 次尝试）。"""
    from aivs_core.providers import StructuredTextResult

    attempts = {"n": 0}

    class BadSchemaProvider:
        async def generate(self, request: Any, cancel_event: Any) -> StructuredTextResult:
            attempts["n"] += 1
            return StructuredTextResult({"candidates": []}, None, None)

    planning, _db = _service(tmp_path, lambda: BadSchemaProvider())
    _seed_probe_payload(planning)
    provider = planning.providers.list()[0]
    cap = await planning.test_candidate_provider_capability(
        provider["provider_config_id"])
    assert cap["candidate_capability_status"] == "unsupported"
    assert attempts["n"] == 4  # 4 适配器各 1 次（无重试）


def _seed_probe_payload(planning: PlanningService) -> None:
    """给 test_candidate_provider_capability 的探测 payload 打桩——
    探测内部自造 payload（probe_{nonce}_i 段），无需外部数据；此函数
    仅占位以显式表达"探测是数据无关的"。"""
    return None


# ----------------------------------------------------------------------
# P43/R1（适配器规划门 2026-10-05）：推理模型 token 预算耗尽
# ----------------------------------------------------------------------


def _length_exhausted_body() -> bytes:
    """P43 实测现场复刻：reasoning 模型先吐 reasoning_content，
    max_tokens 不足时 finish_reason=length 且 content 为空。"""
    return json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content": "思考中",
                    },
                    "finish_reason": "length",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 898, "total_tokens": 908},
        }
    ).encode()


def _captions_request(adapter: str | None) -> StructuredTextRequest:
    return StructuredTextRequest(
        "pc",
        "https://provider.example/v1",
        "m",
        "key",
        {
            "schema_version": 1,
            "recipe_id": "captions_provider_v1",
            "language": "en",
            "preset_id": "default-bottom",
            "max_chars_per_caption": 24,
            "segments": [
                {"segment_id": "s1", "ordinal": 0, "text": "t", "duration_bucket": "short"}
            ],
        },
        capability="captions_provider_capability_probe",
        output_schema="caption-text-output-v1",
        response_adapter_id=adapter,
    )


def _mocked_provider(handler: Any) -> OpenAICompatibleTextProvider:
    return OpenAICompatibleTextProvider(
        lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        )
    )


@pytest.mark.parametrize(
    "adapter",
    [None, "openai_chat_completions_json_schema_v1", "openai_chat_completions_captionscript_v1"],
)
async def test_token_budget_exhaustion_maps_to_deterministic_code(adapter: str | None) -> None:
    """finish_reason=length + 空 content → PROVIDER_TOKEN_BUDGET_EXHAUSTED。

    三条路径都必须命中：非适配器（json_schema）、适配器 json_schema、
    适配器 captionscript（真实网关阶梯选中的档位）。误分类为
    PROVIDER_INVALID_RESPONSE 或网络码都算失败。
    """

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_length_exhausted_body(), request=request)

    with pytest.raises(ProviderError) as raised:
        await _mocked_provider(handler).generate(_captions_request(adapter), asyncio.Event())
    assert raised.value.code == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"


async def test_token_budget_exhaustion_not_masked_as_network_retry() -> None:
    """同形态响应在多次调用下仍恒为同一确定性码（不是抖动、不会自愈）。"""

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_length_exhausted_body(), request=request)

    client = _mocked_provider(handler)
    for _ in range(3):
        with pytest.raises(ProviderError) as raised:
            await client.generate(
                _captions_request("openai_chat_completions_captionscript_v1"),
                asyncio.Event(),
            )
        assert raised.value.code == "PROVIDER_TOKEN_BUDGET_EXHAUSTED"


def test_token_budget_exhausted_is_pinned_non_retryable() -> None:
    """钉死分类：该码不得进入 RETRYABLE_PROVIDER_ERRORS。

    进去了会把确定性耗尽伪装成网络抖动重试 3 次——既浪费往返，
    又把「该调大预算/换模型」的根因藏进抖动噪音（P43 的另一半承诺）。
    """
    assert "PROVIDER_TOKEN_BUDGET_EXHAUSTED" not in RETRYABLE_PROVIDER_ERRORS
