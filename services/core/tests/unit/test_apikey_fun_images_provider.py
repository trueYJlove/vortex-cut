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

async def _generate_with_diagnostic(
    monkeypatch: pytest.MonkeyPatch, response: FakeResponse, diagnostic_id: str
) -> tuple[ApiKeyFunImagesProvider, Any | None, ProviderImageError | None]:
    provider = ApiKeyFunImagesProvider()
    _install_client(monkeypatch, response, {})
    caught: ProviderImageError | None = None
    result: Any | None = None
    try:
        result = await provider.generate(
            ProviderImageRequest(
                PROMPT_SENTINEL, "1024x1024", SECRET_SENTINEL, diagnostic_id
            ),
            asyncio.Event(),
            lambda: None,
        )
    except ProviderImageError as exc:
        caught = exc
    return provider, result, caught


@pytest.mark.asyncio
async def test_protocol_diagnostic_is_content_free_and_one_shot_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, result, error = await _generate_with_diagnostic(
        monkeypatch, FakeResponse([_completed(nested=True)]), "task-safe"
    )

    assert error is None
    assert result is not None
    diagnostic = provider.take_protocol_diagnostic("task-safe")
    assert diagnostic == {
        "schema_version": 2,
        "outcome": "succeeded",
        "failure_stage": "none",
        "http_status_class": "2xx",
        "content_type_class": "event_stream",
        "stream_started": True,
        "stream_ended": True,
        "chunk_count": 1,
        "envelope_byte_count": len(_completed(nested=True)),
        "frame_count": 2,
        "data_event_count": 1,
        "completed_event_count": 1,
        "other_event_count": 0,
        "partial_image_event_count": 0,
        "direct_image_shape_count": 0,
        "nested_data_image_shape_count": 1,
        "chat_delta_shape_count": 0,
        "responses_image_shape_count": 0,
        "url_only_shape_count": 0,
        "unclassified_shape_count": 0,
        "candidate_encoding_class": "base64_like",
        "candidate_size_class": "under_4k",
        "done_marker_count": 1,
        "image_field_location": "nested_data",
        "base64_state": "valid",
    }
    serialized = json.dumps(diagnostic)
    assert PROMPT_SENTINEL not in serialized
    assert SECRET_SENTINEL not in serialized
    assert base64.b64encode(IMAGE_BYTES).decode() not in serialized
    assert provider.take_protocol_diagnostic("task-safe") is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "stage", "content_type", "completed"),
    [
        (FakeResponse([_completed()], content_type="application/json"),
         "unexpected_content_type", "json", 0),
        (FakeResponse([b"data: {}\n\n"]),
         "completed_event_missing", "event_stream", 0),
        (FakeResponse([_completed() + _completed()]),
         "completed_event_duplicate", "event_stream", 2),
        (FakeResponse([b"data: {\"type\":\"image_generation.completed\"}\n\n"]),
         "completed_image_field", "event_stream", 1),
        (
            FakeResponse([
                b"data: {\"type\":\"image_generation.completed\","
                b"\"b64_json\":\"%%%\"}\n\n"
            ]),
            "base64_decode",
            "event_stream",
            1,
        ),
    ],
)
async def test_protocol_diagnostic_classifies_invalid_responses_without_content(
    monkeypatch: pytest.MonkeyPatch,
    response: FakeResponse,
    stage: str,
    content_type: str,
    completed: int,
) -> None:
    provider, result, error = await _generate_with_diagnostic(
        monkeypatch, response, "task-failed"
    )

    assert result is None
    assert error is not None and error.code == "PROVIDER_INVALID_RESPONSE"
    diagnostic = provider.take_protocol_diagnostic("task-failed")
    assert diagnostic is not None
    assert diagnostic["outcome"] == "failed"
    assert diagnostic["failure_stage"] == stage
    assert diagnostic["http_status_class"] == "2xx"
    assert diagnostic["content_type_class"] == content_type
    assert diagnostic["completed_event_count"] == completed
    serialized = json.dumps(diagnostic)
    assert PROMPT_SENTINEL not in serialized
    assert SECRET_SENTINEL not in serialized
    assert "b64_json" not in serialized
    assert "image_generation.completed" not in serialized


@pytest.mark.asyncio
async def test_protocol_diagnostic_classifies_http_failure_without_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, result, error = await _generate_with_diagnostic(
        monkeypatch, FakeResponse([], status=429), "task-rate-limited"
    )

    assert result is None
    assert error is not None and error.code == "PROVIDER_RATE_LIMITED"
    diagnostic = provider.take_protocol_diagnostic("task-rate-limited")
    assert diagnostic is not None
    assert diagnostic["failure_stage"] == "http_status"
    assert diagnostic["http_status_class"] == "4xx"
    assert diagnostic["content_type_class"] == "not_observed"
    assert diagnostic["envelope_byte_count"] == 0
@pytest.mark.asyncio
async def test_unique_nested_data_candidate_is_accepted_without_known_event_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    encoded = base64.b64encode(IMAGE_BYTES).decode()
    event = {
        "opaque_status": "not-retained",
        "data": [{"b64_json": encoded}],
        "usage": {"images": 1},
    }
    envelope = b"data: " + json.dumps(event).encode() + b"\n\ndata: [DONE]\n\n"
    capture: dict[str, Any] = {}
    _install_client(monkeypatch, FakeResponse([envelope]), capture)

    result, dispatches = await _generate()

    assert result.content == IMAGE_BYTES
    assert result.usage == {"images": 1}
    assert dispatches == 1


@pytest.mark.asyncio
async def test_multiple_nested_data_candidates_are_rejected_as_ambiguous(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    encoded = base64.b64encode(IMAGE_BYTES).decode()
    first = {"data": [{"b64_json": encoded}]}
    second = {"data": [{"b64_json": encoded}]}
    envelope = (
        b"data: " + json.dumps(first).encode() + b"\n\n"
        b"data: " + json.dumps(second).encode() + b"\n\ndata: [DONE]\n\n"
    )
    provider, result, error = await _generate_with_diagnostic(
        monkeypatch, FakeResponse([envelope]), "task-ambiguous"
    )

    assert result is None
    assert error is not None and error.code == "PROVIDER_INVALID_RESPONSE"
    diagnostic = provider.take_protocol_diagnostic("task-ambiguous")
    assert diagnostic is not None
    assert diagnostic["completed_event_count"] == 2
    assert diagnostic["failure_stage"] == "completed_event_duplicate"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event", "expected"),
    [
        (
            {"type": "image_generation.partial_image", "b64_json": "QUJDRA=="},
            {
                "partial_image_event_count": 1,
                "direct_image_shape_count": 1,
                "candidate_encoding_class": "base64_like",
                "candidate_size_class": "under_4k",
            },
        ),
        (
            {"choices": [{"delta": {"content": "data:image/png;base64,QUJDRA=="}}]},
            {
                "chat_delta_shape_count": 1,
                "candidate_encoding_class": "data_image_uri",
                "candidate_size_class": "under_4k",
            },
        ),
        (
            {"response": {"output": [{"result": "QUJDRA=="}]}},
            {
                "responses_image_shape_count": 1,
                "candidate_encoding_class": "base64_like",
                "candidate_size_class": "under_4k",
            },
        ),
        (
            {"data": [{"url": "https://safe.invalid/generated.png"}]},
            {
                "url_only_shape_count": 1,
                "candidate_encoding_class": "not_observed",
                "candidate_size_class": "not_observed",
            },
        ),
        (
            {"unknown": {"opaque": "PRIVATE_EVENT_TEXT"}},
            {
                "unclassified_shape_count": 1,
                "candidate_encoding_class": "not_observed",
                "candidate_size_class": "not_observed",
            },
        ),
    ],
)
async def test_protocol_diagnostic_classifies_approved_shapes_without_values(
    monkeypatch: pytest.MonkeyPatch,
    event: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    envelope = b"data: " + json.dumps(event).encode() + b"\n\ndata: [DONE]\n\n"
    provider, result, error = await _generate_with_diagnostic(
        monkeypatch, FakeResponse([envelope]), "task-shape"
    )

    assert result is None
    assert error is not None and error.code == "PROVIDER_INVALID_RESPONSE"
    diagnostic = provider.take_protocol_diagnostic("task-shape")
    assert diagnostic is not None
    for key, value in expected.items():
        assert diagnostic[key] == value
    serialized = json.dumps(diagnostic)
    assert PROMPT_SENTINEL not in serialized
    assert SECRET_SENTINEL not in serialized
    assert "PRIVATE_EVENT_TEXT" not in serialized
    assert "safe.invalid" not in serialized
    assert "data:image" not in serialized
    assert "QUJDRA==" not in serialized
