from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from aivs_core.providers import (
    MAX_RESPONSE_BYTES,
    TIMELINE_PATCH_ADAPTER_ID,
    TIMELINE_PATCH_ADAPTER_IDS,
    TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
    OpenAICompatibleTextProvider,
    ProviderError,
    StructuredTextRequest,
    normalized_base_url,
    parse_patchscript,
    timeline_patch_adapter_supported,
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
        provider = OpenAICompatibleTextProvider(  # type: ignore[arg-type]
            lambda **kwargs: BrokenClient(error, **kwargs)
        )
        with pytest.raises(ProviderError) as raised:
            await provider.generate(_request(), asyncio.Event())
        assert raised.value.code == code


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        {"content": [{"type": "text", "text": "{}"}]},
        {"content": "```json\n{}\n```"},
        {"content": "before {}"},
        {"content": "{} after"},
        {"content": "{}", "tool_calls": []},
    ],
)
async def test_timeline_patch_adapter_rejects_noncanonical_content(message: dict) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        envelope = {"choices": [{"message": message}]}
        return httpx.Response(200, json=envelope, request=request)

    request = StructuredTextRequest(
        "p1",
        "https://provider.example/v1",
        "model",
        "SENTINEL_KEY",
        {},
        capability="timeline_patch_planning",
        output_schema="timeline-patch-output-v1",
        response_adapter_id=TIMELINE_PATCH_ADAPTER_ID,
    )
    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(request, asyncio.Event())
    assert raised.value.code == "PROVIDER_INVALID_RESPONSE"


@pytest.mark.asyncio
async def test_timeline_patch_adapter_accepts_only_registered_openai_content() -> None:
    patch = {
        "summary": "probe",
        "operations": [{"op": "set_layout", "clip_id": "clip_1", "layout": "fit"}],
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": json.dumps(patch)}}]},
            request=request,
        )

    request = StructuredTextRequest(
        "p1",
        "https://provider.example/v1",
        "model",
        "SENTINEL_KEY",
        {},
        capability="timeline_patch_planning",
        output_schema="timeline-patch-output-v1",
        response_adapter_id=TIMELINE_PATCH_ADAPTER_ID,
    )
    result = await _provider(httpx.MockTransport(handler)).generate(request, asyncio.Event())
    assert result.value == patch
    assert result.response_sha256 and result.response_sha256.startswith("sha256:")
    assert timeline_patch_adapter_supported(TIMELINE_PATCH_ADAPTER_ID)
    assert not timeline_patch_adapter_supported("json_object")
    assert TIMELINE_PATCH_PROBE_PROTOCOL_VERSION == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "adapter,endpoint,field",
    [
        ("openai_responses_json_schema_v1", "/responses", "text"),
        ("openai_responses_patchscript_v1", "/responses", None),
        ("openai_chat_completions_json_schema_v1", "/chat/completions", "response_format"),
        ("openai_chat_completions_patchscript_v1", "/chat/completions", None),
    ],
)
async def test_fixed_timeline_adapters_emit_exact_request_shape(
    adapter: str, endpoint: str, field: str | None
) -> None:
    captured: dict = {}
    patchscript = adapter.endswith("patchscript_v1")
    raw = "AIVS-PATCH/1\n{\"op\":\"set_layout\",\"clip_id\":\"c\",\"layout\":\"fit\"}\nAIVS-END"

    patch = {
        "summary": "s",
        "operations": [{"op": "set_layout", "clip_id": "c", "layout": "fit"}],
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        if adapter.startswith("openai_responses"):
            response = {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": raw if patchscript else json.dumps(patch),
                            }
                        ],
                    }
                ]
            }
        else:
            response = {
                "choices": [
                    {"message": {"content": raw if patchscript else json.dumps(patch)}}
                ]
            }
        return httpx.Response(200, json=response, request=request)

    request = StructuredTextRequest(
        "p1",
        "https://provider.example/v1",
        "m",
        "SENTINEL_KEY",
        {},
        capability="timeline_patch_planning",
        output_schema="timeline-patch-output-v1",
        response_adapter_id=adapter,
    )
    result = await _provider(httpx.MockTransport(handler)).generate(request, asyncio.Event())
    assert captured["path"] == "/v1" + endpoint
    assert (field in captured["body"]) is (field is not None)
    if adapter.startswith("openai_responses"):
        assert set(captured["body"]) >= {"model", "instructions", "input"}
        assert "response_format" not in captured["body"] and "tools" not in captured["body"]
        if patchscript:
            assert set(captured["body"]) == {"model", "instructions", "input"}
    assert result.value["operations"][0]["op"] == "set_layout"


def test_patchscript_parser_rejects_bool_duplicate_and_unknown_fields() -> None:
    valid = "AIVS-PATCH/1\n{\"op\":\"move_clip\",\"clip_id\":\"c\",\"to_index\":0}\nAIVS-END"
    assert parse_patchscript(valid)["operations"][0]["to_index"] == 0
    for raw in (
        "AIVS-PATCH/1\n{\"op\":\"move_clip\",\"clip_id\":\"c\",\"to_index\":true}\nAIVS-END",
        "AIVS-PATCH/1\n{\"op\":\"move_clip\",\"clip_id\":\"c\",\"clip_id\":\"d\",\"to_index\":0}\nAIVS-END",
        "AIVS-PATCH/1\n{\"op\":\"move_clip\",\"clip_id\":\"c\",\"to_index\":0,\"extra\":1}\nAIVS-END",
    ):
        with pytest.raises(ValueError):
            parse_patchscript(raw)
    assert len(TIMELINE_PATCH_ADAPTER_IDS) == 4


@pytest.mark.parametrize(
    "raw",
    [
        "```text\nAIVS-PATCH/1\n{\"op\":\"remove_clip\",\"clip_id\":\"c\"}\nAIVS-END\n```",
        "AIVS-PATCH/1\n\n{\"op\":\"remove_clip\",\"clip_id\":\"c\"}\nAIVS-END",
        "AIVS-PATCH/1\n{\"op\":\"set_clip_locked\",\"clip_id\":\"c\",\"locked\":false}\nAIVS-END",
        "AIVS-PATCH/1\n{\"op\":\"remove_clip\",\"clip_id\":\"c\"}\nAIVS-END\ntrailing",
    ],
)
def test_patchscript_parser_rejects_framing_and_forbidden_operations(raw: str) -> None:
    with pytest.raises(ValueError):
        parse_patchscript(raw)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {"output": []},
        {"output": [{"type": "message", "content": []}]},
        {
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": "x"},
                        {"type": "output_text", "text": "y"},
                    ],
                }
            ]
        },
    ],
)
async def test_responses_adapter_rejects_non_unique_output_text(response: dict) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response, request=request)

    request = StructuredTextRequest(
        "p1",
        "https://provider.example/v1",
        "m",
        "SENTINEL_KEY",
        {},
        capability="timeline_patch_planning",
        output_schema="timeline-patch-output-v1",
        response_adapter_id="openai_responses_patchscript_v1",
    )
    with pytest.raises(ProviderError) as raised:
        await _provider(httpx.MockTransport(handler)).generate(request, asyncio.Event())
    assert raised.value.code == "PROVIDER_INVALID_RESPONSE"
