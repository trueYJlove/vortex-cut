from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from aivs_core.providers import (
    MAX_RESPONSE_BYTES,
    OpenAICompatibleTextProvider,
    ProviderError,
    StructuredTextRequest,
    normalized_base_url,
)


def _request() -> StructuredTextRequest:
    return StructuredTextRequest("p1", "https://provider.example/v1", "model", "SENTINEL_KEY", {})


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://provider.example/v1/", "https://provider.example/v1"),
        ("https://provider.example/v1/chat/completions", "https://provider.example/v1"),
        ("http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"),
    ],
)
def test_normalized_base_url_accepts_safe_origins(value: str, expected: str) -> None:
    assert normalized_base_url(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "http://provider.example/v1",
        "https://key@provider.example/v1",
        "https://provider.example/v1?x=1",
        "https://provider.example/v1#part",
        "ftp://provider.example/v1",
    ],
)
def test_normalized_base_url_rejects_unsafe_origins(value: str) -> None:
    with pytest.raises(ProviderError, match="安全"):
        normalized_base_url(value)


def _provider(handler: httpx.AsyncBaseTransport) -> OpenAICompatibleTextProvider:
    return OpenAICompatibleTextProvider(
        lambda **kwargs: httpx.AsyncClient(transport=handler, **kwargs)
    )


def _response(value: dict | None = None) -> bytes:
    return json.dumps(
        {"choices": [{"message": {"content": json.dumps(value or {"candidates": []})}}]}
    ).encode()


@pytest.mark.asyncio
async def test_provider_sends_strict_schema_and_no_network_fallback() -> None:
    captured: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=_response(), request=request)

    result = await _provider(httpx.MockTransport(handler)).generate(_request(), asyncio.Event())
    assert result.value == {"candidates": []}
    assert captured["url"] == "https://provider.example/v1/chat/completions"
    assert captured["body"]["response_format"]["type"] == "json_schema"
    assert captured["body"]["response_format"]["json_schema"]["strict"] is True
    assert "untrusted" in captured["body"]["messages"][0]["content"]


@pytest.mark.asyncio
async def test_provider_streaming_limit_stops_at_two_mib() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1), request=request)

    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(_request(), asyncio.Event())
    assert raised.value.code == "PROVIDER_RESPONSE_TOO_LARGE"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code"), [(401, "PROVIDER_AUTH_FAILED"), (429, "PROVIDER_RATE_LIMITED")]
)
async def test_provider_http_error_categories(status: int, code: str) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=b"upstream secret body", request=request)

    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(_request(), asyncio.Event())
    assert raised.value.code == code
    assert "upstream" not in raised.value.message


@pytest.mark.asyncio
async def test_provider_invalid_json_and_cancel_are_safe() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json", request=request)

    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(_request(), asyncio.Event())
    assert raised.value.code == "PROVIDER_INVALID_RESPONSE"
    cancelled = asyncio.Event()
    cancelled.set()
    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(_request(), cancelled)
    assert raised.value.code == "PROVIDER_CANCELLED"


@pytest.mark.asyncio
async def test_provider_rejects_redirect_without_following_it() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(307, headers={"location": "https://evil.example"}, request=request)

    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(_request(), asyncio.Event())
    assert raised.value.code == "PROVIDER_UNAVAILABLE"
    assert calls == 1


@pytest.mark.asyncio
async def test_provider_tls_and_network_error_categories() -> None:
    class BrokenClient:
        def __init__(self, error: Exception, **_: object) -> None:
            self.error = error

        async def __aenter__(self) -> BrokenClient:
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        def build_request(self, *_: object, **__: object) -> httpx.Request:
            return httpx.Request("POST", "https://provider.example")

        async def send(self, _: httpx.Request, **__: object) -> httpx.Response:
            raise self.error

    for error, code in [
        (
            httpx.ConnectError(
                "certificate tls failed", request=httpx.Request("POST", "https://x")
            ),
            "PROVIDER_TLS_ERROR",
        ),
        (
            httpx.ConnectError("offline", request=httpx.Request("POST", "https://x")),
            "PROVIDER_NETWORK_ERROR",
        ),
    ]:
        provider = OpenAICompatibleTextProvider(lambda **kwargs: BrokenClient(error, **kwargs))  # type: ignore[arg-type]
        with pytest.raises(ProviderError) as raised:
            await provider.generate(_request(), asyncio.Event())
        assert raised.value.code == code
