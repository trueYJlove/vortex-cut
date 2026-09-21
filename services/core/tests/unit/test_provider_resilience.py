"""PROVIDER 韧性（真实世界验证发现 4，2026-09-21）：
- generate() 总预算 deadline（read timeout 被网关慢滴重置的兜底）；
- 双探测（candidate/patch）网络类错误重试（抖动不判死刑，schema 错误不重试）。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from aivs_core.database import Database
from aivs_core.planning import PlanningService, ProviderRepository, RecipeRegistry
from aivs_core.providers import (
    PROBE_TOTAL_BUDGET_SECONDS,
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
