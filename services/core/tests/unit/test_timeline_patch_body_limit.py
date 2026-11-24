from __future__ import annotations

from collections import deque
from typing import Any

from aivs_core.app import TIMELINE_PATCH_BODY_LIMIT, TimelinePatchBodyLimitMiddleware


def _run_immediate(coroutine: Any) -> None:
    """Drive the fake ASGI exchange, whose awaitables intentionally never yield I/O."""
    try:
        coroutine.send(None)
    except StopIteration:
        return
    raise AssertionError("The in-memory ASGI harness unexpectedly yielded control")


def _call_middleware(headers: list[tuple[bytes, bytes]], chunks: list[bytes]) -> tuple[list[dict[str, Any]], bool, bytes]:
    messages = deque([
        *[
            {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
            for index, chunk in enumerate(chunks)
        ]
    ])
    sent: list[dict[str, Any]] = []
    called = False

    async def receive() -> dict[str, Any]:
        return messages.popleft() if messages else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def app(scope: dict[str, Any], app_receive: Any, app_send: Any) -> None:
        nonlocal called
        called = True
        body = bytearray()
        while True:
            message = await app_receive()
            if message["type"] != "http.request":
                break
            body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break
        await app_send({"type": "http.response.start", "status": 204, "headers": []})
        await app_send({"type": "http.response.body", "body": bytes(body)})

    scope = {
        "type": "http", "method": "POST", "path": "/api/v1/projects/p1/timeline/patches",
        "headers": headers,
    }
    _run_immediate(TimelinePatchBodyLimitMiddleware(app)(scope, receive, send))
    response_body = next((item.get("body", b"") for item in sent if item["type"] == "http.response.body"), b"")
    return sent, called, response_body


def test_declared_oversize_rejected_before_downstream_parse() -> None:
    sent, called, _ = _call_middleware(
        [(b"content-length", str(TIMELINE_PATCH_BODY_LIMIT + 1).encode("ascii"))],
        [],
    )
    assert not called
    assert sent[0]["status"] == 413


def test_chunked_oversize_rejected_before_downstream_parse() -> None:
    sent, called, _ = _call_middleware(
        [(b"transfer-encoding", b"chunked")],
        [b"x" * (TIMELINE_PATCH_BODY_LIMIT - 1), b"xx"],
    )
    assert not called
    assert sent[0]["status"] == 413


def test_body_at_limit_is_replayed_intact() -> None:
    body = b"x" * TIMELINE_PATCH_BODY_LIMIT
    sent, called, echoed = _call_middleware([(b"content-length", str(len(body)).encode("ascii"))], [body])
    assert called
    assert sent[0]["status"] == 204
    assert echoed == body
