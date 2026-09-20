from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from aivs_core.providers import (
    CANDIDATE_ADAPTER_IDS,
    CANDIDATE_PROBE_PROTOCOL_VERSION,
    MAX_RESPONSE_BYTES,
    TIMELINE_PATCH_ADAPTER_ID,
    TIMELINE_PATCH_ADAPTER_IDS,
    TIMELINE_PATCH_PROBE_PROTOCOL_VERSION,
    OpenAICompatibleTextProvider,
    ProviderError,
    StructuredTextRequest,
    candidate_adapter_supported,
    normalized_base_url,
    parse_candidatescript,
    parse_patchscript,
    timeline_patch_adapter_supported,
)


def _candidate_script(
    *,
    newline: str = "\n",
    clips_per_variant: int = 1,
    score: object = None,
) -> str:
    records: list[str] = []
    for variant in ("balanced", "compact", "bold"):
        records.append(
            json.dumps(
                {
                    "op": "candidate",
                    "variant": variant,
                    "title_suggestion": variant,
                    "summary": "summary",
                }
            )
        )
        for index in range(clips_per_variant):
            records.append(
                json.dumps(
                    {
                        "op": "clip",
                        "variant": variant,
                        "segment_refs": [f"{variant}-{index}"],
                        "reason": "reason",
                        "model_score": score,
                    }
                )
            )
    return newline.join(["AIVS-CANDIDATE/1", *records, "AIVS-END"])


def _request() -> StructuredTextRequest:
    return StructuredTextRequest("p1", "https://provider.example/v1", "model", "SENTINEL_KEY", {})


def test_candidatescript_parser_enforces_closed_framing_and_variants() -> None:
    records = []
    for variant in ("balanced", "compact", "bold"):
        records.append(
            json.dumps(
                {
                    "op": "candidate",
                    "variant": variant,
                    "title_suggestion": variant,
                    "summary": "summary",
                }
            )
        )
        records.append(
            json.dumps(
                {
                    "op": "clip",
                    "variant": variant,
                    "segment_refs": ["s1"],
                    "reason": "reason",
                    "model_score": None,
                }
            )
        )
    raw = "AIVS-CANDIDATE/1\n" + "\n".join(records) + "\nAIVS-END\n"
    assert [item["variant"] for item in parse_candidatescript(raw)["candidates"]] == [
        "balanced",
        "compact",
        "bold",
    ]
    for invalid in (
        raw.replace("\n", "\r\n", 1),
        raw.replace('"s1"', '"s1","segment_refs":["s1"]', 1),
        raw + "tail",
    ):
        with pytest.raises(ValueError):
            parse_candidatescript(invalid)
    assert len(CANDIDATE_ADAPTER_IDS) == 4
    # 探测协议 v2（2026-09-20 裁决）：时长精确匹配放宽为结构校验。
    assert CANDIDATE_PROBE_PROTOCOL_VERSION == "2"
    assert candidate_adapter_supported("openai_responses_candidatescript_v1")


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("clips_per_variant", [1, 30])
def test_candidatescript_parser_accepts_only_complete_line_protocol(
    newline: str, clips_per_variant: int
) -> None:
    parsed = parse_candidatescript(
        _candidate_script(newline=newline, clips_per_variant=clips_per_variant) + newline
    )
    assert [len(candidate["clips"]) for candidate in parsed["candidates"]] == [
        clips_per_variant,
        clips_per_variant,
        clips_per_variant,
    ]


@pytest.mark.parametrize(
    "raw",
    [
        "\ufeff" + _candidate_script(),
        _candidate_script().replace("\n", "\r\n", 1),
        "```text\n" + _candidate_script() + "\n```",
        "# comment\n" + _candidate_script(),
        _candidate_script().replace("\n", "\n\n", 1),
        "prefix\n" + _candidate_script(),
        _candidate_script() + "\nsuffix",
        _candidate_script().replace(
            '"summary": "summary"',
            '"summary":"a","summary":"b"',
            1,
        ),
        _candidate_script().replace(
            '"summary": "summary"',
            '"extra":1,"summary":"summary"',
            1,
        ),
        _candidate_script().replace(
            '"summary": "summary"',
            '"title_suggestion":true',
            1,
        ),
        _candidate_script().replace('"model_score": null', '"model_score": NaN', 1),
        _candidate_script().replace('"model_score": null', '"model_score": Infinity', 1),
        _candidate_script().replace('"variant": "compact"', '"variant": "bold"', 1),
        _candidate_script().replace('"segment_refs": ["balanced-0"]', '"segment_refs": []', 1),
        _candidate_script().replace(
            '"segment_refs": ["balanced-0"]',
            '"segment_refs": ["balanced-0", "balanced-0"]',
            1,
        ),
        _candidate_script(clips_per_variant=30).replace(
            '"model_score": null}',
            '"model_score": null}\n{"op":"clip","variant":"balanced",'
            '"segment_refs":["extra"],"reason":"r","model_score":null}',
            1,
        ),
    ],
)
def test_candidatescript_parser_rejects_untrusted_or_invalid_records(raw: str) -> None:
    with pytest.raises(ValueError):
        parse_candidatescript(raw)


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
    assert TIMELINE_PATCH_PROBE_PROTOCOL_VERSION == "2"


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
    raw = 'AIVS-PATCH/1\n{"op":"set_layout","clip_id":"c","layout":"fit"}\nAIVS-END'

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
                "choices": [{"message": {"content": raw if patchscript else json.dumps(patch)}}]
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("adapter", "endpoint"),
    [
        ("openai_responses_candidatescript_v1", "/responses"),
        ("openai_chat_completions_candidatescript_v1", "/chat/completions"),
    ],
)
async def test_candidate_script_adapters_use_fixed_endpoint_and_contract_instructions(
    adapter: str, endpoint: str
) -> None:
    captured: list[dict] = []
    records = []
    for variant in ("balanced", "compact", "bold"):
        records += [
            {
                "op": "candidate",
                "variant": variant,
                "title_suggestion": variant,
                "summary": "summary",
            },
            {
                "op": "clip",
                "variant": variant,
                "segment_refs": ["s1"],
                "reason": "reason",
                "model_score": None,
            },
        ]
    raw = "AIVS-CANDIDATE/1\n" + "\n".join(json.dumps(item) for item in records) + "\nAIVS-END"

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        response = (
            {"output": [{"type": "message", "content": [{"type": "output_text", "text": raw}]}]}
            if adapter.startswith("openai_responses")
            else {"choices": [{"message": {"content": raw}}]}
        )
        assert request.url.path == "/v1" + endpoint
        return httpx.Response(200, json=response, request=request)

    result = await _provider(httpx.MockTransport(handler)).generate(
        StructuredTextRequest(
            "p1",
            "https://provider.example/v1",
            "m",
            "SENTINEL_KEY",
            {"business": "data"},
            capability="candidate_planning",
            response_adapter_id=adapter,
        ),
        asyncio.Event(),
    )
    assert len(captured) == 1
    body = captured[0]
    instructions = (
        body["instructions"] if "instructions" in body else body["messages"][0]["content"]
    )
    assert "AIVS-CANDIDATE/1" in instructions
    assert "text" not in body and "response_format" not in body and "tools" not in body
    assert [candidate["variant"] for candidate in result.value["candidates"]] == [
        "balanced",
        "compact",
        "bold",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("adapter", "endpoint", "script"),
    [
        ("openai_responses_json_schema_v1", "/responses", False),
        ("openai_responses_candidatescript_v1", "/responses", True),
        ("openai_chat_completions_json_schema_v1", "/chat/completions", False),
        ("openai_chat_completions_candidatescript_v1", "/chat/completions", True),
    ],
)
async def test_every_candidate_adapter_uses_its_single_fixed_request_shape(
    adapter: str, endpoint: str, script: bool
) -> None:
    captured: list[dict] = []
    candidate_value = parse_candidatescript(_candidate_script())
    content = _candidate_script() if script else json.dumps(candidate_value)

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append({"path": request.url.path, "body": json.loads(request.content)})
        envelope = (
            {
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": content}],
                    }
                ]
            }
            if adapter.startswith("openai_responses")
            else {"choices": [{"message": {"content": content}}]}
        )
        return httpx.Response(200, json=envelope, request=request)

    result = await _provider(httpx.MockTransport(handler)).generate(
        StructuredTextRequest(
            "p1",
            "https://provider.example/v1",
            "m",
            "SENTINEL_KEY",
            {"opaque": "business-content"},
            capability="candidate_planning",
            response_adapter_id=adapter,
        ),
        asyncio.Event(),
    )
    assert len(captured) == 1
    assert captured[0]["path"] == "/v1" + endpoint
    body = captured[0]["body"]
    if adapter == "openai_responses_json_schema_v1":
        assert set(body) == {"model", "instructions", "input", "text"}
        assert body["text"]["format"]["name"] == "candidate-plan-output-v1"
        assert "response_format" not in body and "tools" not in body
    elif adapter == "openai_responses_candidatescript_v1":
        assert set(body) == {"model", "instructions", "input"}
        assert "text" not in body and "response_format" not in body and "tools" not in body
        assert "AIVS-CANDIDATE/1" in body["instructions"]
    elif adapter == "openai_chat_completions_json_schema_v1":
        assert set(body) == {"model", "messages", "response_format"}
        assert "tools" not in body
        assert body["response_format"]["json_schema"]["name"] == "candidate-plan-output-v1"
    else:
        assert set(body) == {"model", "messages"}
        assert "response_format" not in body and "tools" not in body
        assert "AIVS-CANDIDATE/1" in body["messages"][0]["content"]
    assert result.value == candidate_value


def test_patchscript_parser_rejects_bool_duplicate_and_unknown_fields() -> None:
    valid = 'AIVS-PATCH/1\n{"op":"move_clip","clip_id":"c","to_index":0}\nAIVS-END'
    assert parse_patchscript(valid)["operations"][0]["to_index"] == 0
    for raw in (
        'AIVS-PATCH/1\n{"op":"move_clip","clip_id":"c","to_index":true}\nAIVS-END',
        'AIVS-PATCH/1\n{"op":"move_clip","clip_id":"c","clip_id":"d","to_index":0}\nAIVS-END',
        'AIVS-PATCH/1\n{"op":"move_clip","clip_id":"c","to_index":0,"extra":1}\nAIVS-END',
    ):
        with pytest.raises(ValueError):
            parse_patchscript(raw)
    assert len(TIMELINE_PATCH_ADAPTER_IDS) == 4


@pytest.mark.parametrize(
    "raw",
    [
        '```text\nAIVS-PATCH/1\n{"op":"remove_clip","clip_id":"c"}\nAIVS-END\n```',
        'AIVS-PATCH/1\n\n{"op":"remove_clip","clip_id":"c"}\nAIVS-END',
        'AIVS-PATCH/1\n{"op":"set_clip_locked","clip_id":"c","locked":false}\nAIVS-END',
        'AIVS-PATCH/1\n{"op":"remove_clip","clip_id":"c"}\nAIVS-END\ntrailing',
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
