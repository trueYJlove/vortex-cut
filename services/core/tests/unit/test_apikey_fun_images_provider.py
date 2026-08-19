from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

import aivs_core.provider_images as provider_module
from aivs_core.provider_images import (
    ApiKeyFunImagesProvider,
    ProviderImageError,
    ProviderImageRequest,
)

PROMPT_SENTINEL = "PROMPT_SENTINEL_APIKEY_FUN_PRIVATE"
SECRET_SENTINEL = "SECRET_SENTINEL_APIKEY_FUN_PRIVATE"
IMAGE_BYTES = b"safe-image-bytes"


class FakeResponse:
    def __init__(
        self,
        chunks: list[bytes],
        status: int = 200,
        content_type: str = "text/event-stream; charset=utf-8",
    ) -> None:
        self.status_code = status
        self.headers = {"content-type": content_type, "x-request-id": "safe-request-id"}
        self._chunks = chunks

    async def aread(self) -> bytes:
        return b"redacted-by-test"

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


class FakeStream:
    def __init__(self, response: FakeResponse, failure: Exception | None = None) -> None:
        self.response = response
        self.failure = failure

    async def __aenter__(self) -> FakeResponse:
        if self.failure is not None:
            raise self.failure
        return self.response

    async def __aexit__(self, *args: Any) -> None:
        del args


class FakeClient:
    def __init__(
        self,
        response: FakeResponse,
        capture: dict[str, Any],
        failure: Exception | None = None,
        **kwargs: Any,
    ) -> None:
        capture["client"] = kwargs
        self.response, self.capture, self.failure = response, capture, failure

    async def __aenter__(self) -> FakeClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        del args

    def stream(self, method: str, url: str, **kwargs: Any) -> FakeStream:
        self.capture["request"] = {"method": method, "url": url, **kwargs}
        return FakeStream(self.response, self.failure)


def _completed(nested: bool = False, delimiter: bytes = b"\n\n") -> bytes:
    encoded = base64.b64encode(IMAGE_BYTES).decode()
    image = {"data": [{"b64_json": encoded}]} if nested else {"b64_json": encoded}
    event = {
        "type": "image_generation.completed",
        **image,
        "usage": {"images": 1, "total_tokens": 12},
    }
    return b"data: " + json.dumps(event).encode() + delimiter + b"data: [DONE]" + delimiter


def _install_client(
    monkeypatch: pytest.MonkeyPatch,
    response: FakeResponse,
    capture: dict[str, Any],
    failure: Exception | None = None,
) -> None:
    monkeypatch.setattr(
        provider_module.httpx,
        "AsyncClient",
        lambda **kwargs: FakeClient(response, capture, failure, **kwargs),
    )


async def _generate(cancel_event: asyncio.Event | None = None) -> tuple[Any, int]:
    dispatches = 0

    def dispatched() -> None:
        nonlocal dispatches
        dispatches += 1

    result = await ApiKeyFunImagesProvider().generate(
        ProviderImageRequest(PROMPT_SENTINEL, "1024x1024", SECRET_SENTINEL),
        cancel_event or asyncio.Event(),
        dispatched,
    )
    return result, dispatches


@pytest.mark.asyncio
@pytest.mark.parametrize(("nested", "delimiter"), [(False, b"\n\n"), (True, b"\r\n\r\n")])
async def test_completed_sse_uses_fixed_profile_and_one_dispatch(
    monkeypatch: pytest.MonkeyPatch, nested: bool, delimiter: bytes
) -> None:
    envelope = _completed(nested, delimiter)
    chunks = [envelope[:7], envelope[7:31], envelope[31:]]
    capture: dict[str, Any] = {}
    _install_client(monkeypatch, FakeResponse(chunks), capture)

    result, dispatches = await _generate()

    assert result.content == IMAGE_BYTES
    assert result.provider_request_id == "safe-request-id"
    assert result.usage == {"images": 1, "total_tokens": 12}
    assert result.response_sha256 == "sha256:" + hashlib.sha256(envelope).hexdigest()
    assert dispatches == 1
    assert capture["client"]["follow_redirects"] is False
    assert capture["client"]["trust_env"] is False
    request = capture["request"]
    assert request["method"] == "POST"
    assert request["url"] == "https://api.apikey.fun/v1/images/generations"
    assert request["json"] == {
        "model": "gpt-image-2",
        "prompt": PROMPT_SENTINEL,
        "n": 1,
        "size": "1024x1024",
        "stream": True,
        "response_format": "b64_json",
    }
    assert request["headers"]["Accept"] == "text/event-stream"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "PROVIDER_AUTH_FAILED"), (403, "PROVIDER_AUTH_FAILED"),
     (429, "PROVIDER_RATE_LIMITED"), (503, "PROVIDER_UNAVAILABLE"),
     (400, "PROVIDER_INVALID_RESPONSE")],
)
async def test_http_failures_are_safe_and_not_retried(
    monkeypatch: pytest.MonkeyPatch, status: int, code: str
) -> None:
    capture: dict[str, Any] = {}
    _install_client(monkeypatch, FakeResponse([], status=status), capture)
    dispatches = 0

    def dispatched() -> None:
        nonlocal dispatches
        dispatches += 1

    with pytest.raises(ProviderImageError) as caught:
        await ApiKeyFunImagesProvider().generate(
            ProviderImageRequest(PROMPT_SENTINEL, "1024x1024", SECRET_SENTINEL),
            asyncio.Event(),
            dispatched,
        )
    assert caught.value.code == code
    assert caught.value.may_have_processed is True
    assert dispatches == 1
    assert PROMPT_SENTINEL not in str(caught.value)
    assert SECRET_SENTINEL not in str(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        FakeResponse([b"data: {}\n\n"]),
        FakeResponse([_completed() + _completed()]),
        FakeResponse([b"data: {\"type\":\"image_generation.completed\",\"b64_json\":\"%%%\"}\n\n"]),
        FakeResponse([_completed()], content_type="application/json"),
    ],
)
async def test_invalid_sse_is_rejected_without_sensitive_details(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse
) -> None:
    _install_client(monkeypatch, response, {})
    with pytest.raises(ProviderImageError) as caught:
        await _generate()
    assert caught.value.code == "PROVIDER_INVALID_RESPONSE"
    assert caught.value.may_have_processed is True
    assert PROMPT_SENTINEL not in str(caught.value)
    assert SECRET_SENTINEL not in str(caught.value)


@pytest.mark.asyncio
async def test_connect_failure_after_dispatch_is_conservatively_counted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    capture: dict[str, Any] = {}
    request = httpx.Request("POST", "https://safe.invalid")
    failure = httpx.ConnectError("private", request=request)
    _install_client(monkeypatch, FakeResponse([]), capture, failure)
    with pytest.raises(ProviderImageError) as caught:
        await _generate()
    assert caught.value.code == "PROVIDER_NETWORK_ERROR"
    assert caught.value.may_have_processed is True
    assert "private" not in str(caught.value)


@pytest.mark.asyncio
async def test_cancel_before_dispatch_and_unsupported_size_do_not_call_provider() -> None:
    cancelled = asyncio.Event()
    cancelled.set()
    calls = 0

    def dispatched() -> None:
        nonlocal calls
        calls += 1

    with pytest.raises(ProviderImageError) as caught:
        await ApiKeyFunImagesProvider().generate(
            ProviderImageRequest(PROMPT_SENTINEL, "1024x1024", SECRET_SENTINEL),
            cancelled,
            dispatched,
        )
    assert caught.value.code == "JOB_CANCELLED"
    with pytest.raises(ProviderImageError) as unsupported:
        await ApiKeyFunImagesProvider().generate(
            ProviderImageRequest(PROMPT_SENTINEL, "2048x2048", SECRET_SENTINEL),
            asyncio.Event(),
            dispatched,
        )
    assert unsupported.value.code == "IMAGE_PROVIDER_UNSUPPORTED"
    assert calls == 0


@pytest.mark.asyncio
async def test_envelope_limit_is_streaming_and_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(provider_module, "MAX_ENVELOPE_BYTES", 8)
    _install_client(monkeypatch, FakeResponse([b"12345", b"67890"]), {})
    with pytest.raises(ProviderImageError) as caught:
        await _generate()
    assert caught.value.code == "GENERATED_IMAGE_TOO_LARGE"
    assert caught.value.may_have_processed is True
