"""Provider 代理三级回退与 factory 注入单元测试（PROXY_SUPPORT 规划门 §3.1）。

为什么此前是零覆盖：services/core/tests 全量 grep resolve_provider_proxy / winreg
命中 0，config.py 的三级回退与 app 装配的注入从未被任何测试碰过。代理是
"优化不是依赖"的路径——这正是最容易静默坏掉的那类代码：注册表读不动时
回退直连的容错分支，坏了也没人发现，直到用户在中国网络下配好 Provider 却
永远 PROVIDER_NETWORK_ERROR（规划门 §0 记录的原始现场）。

注册表一律 monkeypatch，绝不读真实注册表——否则这些用例在开着系统代理的
机器上绿、在别人机器上红，不可复现。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

import aivs_core.config as config_module
import aivs_core.provider_images as provider_module
from aivs_core.config import Settings, proxy_display_value, resolve_provider_proxy
from aivs_core.provider_images import (
    ApiKeyFunImagesProvider,
    ProviderImageError,
    ProviderImageRequest,
    image_client_factory_for_proxy,
)
from aivs_core.providers import (
    OpenAICompatibleTextProvider,
    ProviderError,
    StructuredTextRequest,
)

# ── 三级回退 ────────────────────────────────────────────────────────────


def test_custom_mode_returns_explicit_proxy() -> None:
    settings = Settings(proxy_mode="custom", provider_proxy="http://127.0.0.1:10809")
    assert resolve_provider_proxy(settings) == "http://127.0.0.1:10809"


def test_custom_mode_without_value_is_direct() -> None:
    """custom 但没填地址 → 直连（不是"回退 system"：用户选了自定义就该听话）。"""
    assert resolve_provider_proxy(Settings(proxy_mode="custom", provider_proxy="")) is None
    assert resolve_provider_proxy(Settings(proxy_mode="custom", provider_proxy=None)) is None


def test_direct_mode_ignores_configured_proxy() -> None:
    settings = Settings(proxy_mode="direct", provider_proxy="http://127.0.0.1:10809")
    assert resolve_provider_proxy(settings) is None


def test_system_mode_off_windows_is_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_module.sys, "platform", "darwin")
    assert resolve_provider_proxy(Settings(proxy_mode="system")) is None


def _fake_winreg(
    monkeypatch: pytest.MonkeyPatch,
    values: dict[str, Any] | None,
    *,
    raises: BaseException | None = None,
) -> None:
    """替换 winreg：只实现被测路径用到的 OpenKey/QueryValueEx/HKEY_CURRENT_USER。"""
    module = SimpleNamespace(HKEY_CURRENT_USER=object())

    class _Key:
        def __enter__(self) -> _Key:
            return self

        def __exit__(self, *args: Any) -> None:
            return None

    def open_key(*_args: Any, **_kwargs: Any) -> _Key:
        if raises is not None:
            raise raises
        return _Key()

    def query_value_ex(_key: Any, name: str) -> tuple[Any, int]:
        assert values is not None
        return (values[name], 1)

    module.OpenKey = open_key  # type: ignore[attr-defined]
    module.QueryValueEx = query_value_ex  # type: ignore[attr-defined]
    monkeypatch.setattr(config_module.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "winreg", module)


def test_system_mode_win32_proxy_disabled_is_direct(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_winreg(monkeypatch, {"ProxyEnable": 0, "ProxyServer": "127.0.0.1:10809"})
    assert resolve_provider_proxy(Settings(proxy_mode="system")) is None


def test_system_mode_win32_bare_host_port_gets_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    """注册表常见形态 127.0.0.1:10809 无协议前缀——httpx 需要 scheme。"""
    _fake_winreg(monkeypatch, {"ProxyEnable": 1, "ProxyServer": "127.0.0.1:10809"})
    assert resolve_provider_proxy(Settings(proxy_mode="system")) == "http://127.0.0.1:10809"


def test_system_mode_win32_per_protocol_takes_https_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """http=...;https=... 取 https 段（Provider 出网是 HTTPS，取 http 段会白绕一圈）。"""
    _fake_winreg(monkeypatch, {
        "ProxyEnable": 1,
        "ProxyServer": "http=127.0.0.1:10808;https=127.0.0.1:10809",
    })
    assert resolve_provider_proxy(Settings(proxy_mode="system")) == "http://127.0.0.1:10809"


def test_system_mode_win32_registry_oserror_falls_back_to_direct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """注册表不可读 → 静默直连（代理是优化不是依赖，不能因此让 Provider 全挂）。"""
    _fake_winreg(monkeypatch, None, raises=OSError("registry unavailable"))
    assert resolve_provider_proxy(Settings(proxy_mode="system")) is None


# ── 回显值脱敏 ──────────────────────────────────────────────────────────


def test_proxy_display_value_drops_credentials() -> None:
    """只回显 scheme://host:port：URL 凭据段/查询串不得进入错误消息。"""
    assert proxy_display_value("http://127.0.0.1:10809") == "http://127.0.0.1:10809"
    assert proxy_display_value("http://user:pass@127.0.0.1:10809") == "http://127.0.0.1:10809"
    assert proxy_display_value("http://127.0.0.1:10809/?token=secret") == "http://127.0.0.1:10809"
    assert proxy_display_value(None) is None
    assert proxy_display_value("") is None


# ── factory 注入：文本 Provider ─────────────────────────────────────────


def _text_request() -> StructuredTextRequest:
    return StructuredTextRequest(
        "pc", "https://provider.example/v1", "m", "key", {"payload": "x"},
        capability="connection_test", output_schema="timeline-patch-output-v1",
    )


class _BrokenClient:
    """只用于触发 TransportError 的最小 client 替身。"""

    def __init__(self, error: BaseException, **kwargs: Any) -> None:
        self.error = error
        self.init_kwargs = kwargs

    async def __aenter__(self) -> _BrokenClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def build_request(self, *_: Any, **__: Any) -> httpx.Request:
        return httpx.Request("POST", "https://provider.example")

    async def send(self, _: httpx.Request, **__: Any) -> httpx.Response:
        raise self.error


def _proxied_text_factory(capture: dict[str, Any], proxy: str):
    """复刻 app.py 装配的 factory 形态（kwargs.pop trust_env + proxy 透传）。"""

    def factory(**kwargs: Any) -> Any:
        kwargs.pop("trust_env", None)
        capture.update(kwargs)
        capture["proxy"] = proxy
        capture["trust_env"] = False
        return _BrokenClient(httpx.ConnectError("offline"), **kwargs)

    return factory


def test_text_provider_factory_receives_proxy_and_keeps_trust_env_false() -> None:
    """断言代理真的传到了 client 构造上——只断言类型不算验证注入。"""
    capture: dict[str, Any] = {}
    provider = OpenAICompatibleTextProvider(
        client_factory=_proxied_text_factory(capture, "http://127.0.0.1:10809"),
        proxy_display="http://127.0.0.1:10809",
    )
    with pytest.raises(ProviderError) as raised:
        asyncio.run(provider.generate(_text_request(), asyncio.Event()))
    assert capture["proxy"] == "http://127.0.0.1:10809"
    assert capture["trust_env"] is False
    # 代理上下文进了消息，且没带任何凭据
    assert "127.0.0.1:10809" in str(raised.value)


def test_text_provider_without_proxy_keeps_legacy_wording() -> None:
    """无代理时消息必须逐字等于历史文案（既有诊断与用户认知锚在这句话上）。"""
    capture: dict[str, Any] = {}
    provider = OpenAICompatibleTextProvider(
        client_factory=_proxied_text_factory(capture, ""),
    )
    with pytest.raises(ProviderError) as raised:
        asyncio.run(provider.generate(_text_request(), asyncio.Event()))
    assert raised.value.code == "PROVIDER_NETWORK_ERROR"
    assert raised.value.message == "Provider 网络请求失败"


# ── factory 注入：图片 Provider（Task A 的接线） ────────────────────────


class _StreamOnlyClient:
    """记录构造参数并让 stream() 立即连接失败的最小 client 替身。"""

    instances: list[dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        _StreamOnlyClient.instances.append(kwargs)

    async def __aenter__(self) -> _StreamOnlyClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def stream(self, *_args: Any, **_kwargs: Any) -> Any:
        raise httpx.ConnectError("offline", request=httpx.Request("POST", "https://x"))


def _run_image(provider: ApiKeyFunImagesProvider) -> ProviderImageError:
    with pytest.raises(ProviderImageError) as raised:
        asyncio.run(provider.generate(
            ProviderImageRequest("prompt", "1024x1024", "secret"),
            asyncio.Event(),
            lambda: None,
        ))
    return raised.value


def test_image_default_factory_keeps_original_semantics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """未注入时：不重定向、trust_env=False、超时 900/connect=15——与改动前逐字节相同。"""
    monkeypatch.setattr(provider_module.httpx, "AsyncClient", _StreamOnlyClient)
    _StreamOnlyClient.instances.clear()
    _run_image(ApiKeyFunImagesProvider())
    kwargs = _StreamOnlyClient.instances[-1]
    assert kwargs["follow_redirects"] is False
    assert kwargs["trust_env"] is False
    assert kwargs["timeout"] == httpx.Timeout(900, connect=15)
    assert "proxy" not in kwargs


def test_image_default_factory_keeps_legacy_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """无代理时图片 Provider 的两种历史文案逐字不变（没有代理就不加噪音）。"""
    monkeypatch.setattr(provider_module.httpx, "AsyncClient", _StreamOnlyClient)
    assert _run_image(ApiKeyFunImagesProvider()).message == "无法连接 Provider"


def test_image_injected_proxy_factory_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    """注入工厂必须真的被用上，且代理透传到 client——不是只换个类型。"""
    monkeypatch.setattr(provider_module.httpx, "AsyncClient", _StreamOnlyClient)
    _StreamOnlyClient.instances.clear()
    provider = ApiKeyFunImagesProvider(
        client_factory=image_client_factory_for_proxy("http://127.0.0.1:10809"),
        proxy_display="http://127.0.0.1:10809",
    )
    error = _run_image(provider)
    kwargs = _StreamOnlyClient.instances[-1]
    assert kwargs["proxy"] == "http://127.0.0.1:10809"
    assert kwargs["trust_env"] is False
    assert kwargs["follow_redirects"] is False
    assert kwargs["timeout"] == httpx.Timeout(900, connect=15)
    # 错误消息带代理上下文，且不含密钥
    assert error.code == "PROVIDER_NETWORK_ERROR"
    assert "127.0.0.1:10809" in error.message
    assert "secret" not in error.message


# ── app 装配：CoreState 真的把代理装上去了 ─────────────────────────────


def _core_state(tmp_path: Path, **overrides: Any) -> Any:
    from aivs_core.app import CoreState

    settings = Settings(
        data_dir=tmp_path,
        ffmpeg=Path("missing"),
        ffprobe=Path("missing"),
        manifest_dir=tmp_path / "manifests",
        **overrides,
    )
    return CoreState(settings)


def test_app_assembly_injects_proxy_into_both_providers(tmp_path: Path) -> None:
    """装配级验证：文本与图片 Provider 都拿到了同一个代理。

    这是 Task A 的实质——此前只有文本侧接了代理，图片侧直连必失败。
    """
    state = _core_state(
        tmp_path,
        proxy_mode="custom",
        provider_proxy="http://127.0.0.1:10809",
        image_provider_network_enabled=True,
    )
    assert state.provider_proxy == "http://127.0.0.1:10809"
    text_provider = state._text_provider_factory()
    assert text_provider._proxy_display == "http://127.0.0.1:10809"
    image_provider = state.provider_image_generation.provider
    assert image_provider._proxy_display == "http://127.0.0.1:10809"


def test_app_assembly_without_proxy_leaves_defaults(tmp_path: Path) -> None:
    """无代理：不注入工厂（保持默认路径），且回显值为 None（不加任何噪音）。"""
    state = _core_state(
        tmp_path,
        proxy_mode="direct",
        provider_proxy="http://127.0.0.1:10809",
        image_provider_network_enabled=True,
    )
    assert state.provider_proxy is None
    assert state._image_client_factory is None
    assert state.provider_image_generation.provider._proxy_display is None
