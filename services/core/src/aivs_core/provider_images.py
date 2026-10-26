from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import struct
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import av  # pyright: ignore[reportMissingImports]
import httpx

from .projects import DomainError

IMAGE_ENDPOINT = "https://api.apikey.fun/v1/images/generations"
IMAGE_PROVIDER_KIND = "apikey_fun_images"
IMAGE_ADAPTER_ID = "apikey_fun_images_sse_v1"
IMAGE_MODEL = "gpt-image-2"
IMAGE_PROTOCOL_VERSION = "1"
ALLOWED_IMAGE_SIZES = {"1024x1024"}
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_ENVELOPE_BYTES = 36 * 1024 * 1024
MAX_IMAGE_EDGE = 4096
MAX_IMAGE_PIXELS = 16_777_216


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


class ProviderImageError(RuntimeError):
    def __init__(self, code: str, message: str, may_have_processed: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.may_have_processed = may_have_processed


_DIAGNOSTIC_LIMIT = 64


def _new_protocol_diagnostic() -> dict[str, Any]:
    return {
        "schema_version": 2,
        "outcome": "pending",
        "failure_stage": "none",
        "http_status_class": "not_observed",
        "content_type_class": "not_observed",
        "stream_started": False,
        "stream_ended": False,
        "chunk_count": 0,
        "envelope_byte_count": 0,
        "frame_count": 0,
        "data_event_count": 0,
        "completed_event_count": 0,
        "other_event_count": 0,
        "partial_image_event_count": 0,
        "direct_image_shape_count": 0,
        "nested_data_image_shape_count": 0,
        "chat_delta_shape_count": 0,
        "responses_image_shape_count": 0,
        "url_only_shape_count": 0,
        "unclassified_shape_count": 0,
        "candidate_encoding_class": "not_observed",
        "candidate_size_class": "not_observed",
        "done_marker_count": 0,
        "image_field_location": "not_observed",
        "base64_state": "not_checked",
    }


def _string_size_class(value: str) -> str:
    size = len(value)
    if size < 4_096:
        return "under_4k"
    if size < 262_144:
        return "4k_to_256k"
    if size < 1_048_576:
        return "256k_to_1m"
    if size <= 36 * 1_048_576:
        return "1m_to_36m"
    return "over_36m"


def _candidate_encoding_class(value: str) -> str:
    stripped = value.strip()
    lowered = stripped[:32].lower()
    if lowered.startswith("data:image/"):
        return "data_image_uri"
    if lowered.startswith(("http://", "https://")):
        return "remote_url"
    if stripped and len(stripped) % 4 == 0:
        allowed = frozenset(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
        )
        if all(char in allowed for char in stripped):
            return "base64_like"
    return "other"


def _merge_observation(current: str, observed: str) -> str:
    if current == "not_observed":
        return observed
    return current if current == observed else "mixed"


def _observe_protocol_shape(event: dict[str, Any], diagnostic: dict[str, Any]) -> None:
    """Record approved shape classes only; never retain event keys or values."""
    classified = False
    candidates: list[str] = []

    direct = event.get("b64_json")
    if isinstance(direct, str):
        diagnostic["direct_image_shape_count"] += 1
        candidates.append(direct)
        classified = True

    data = event.get("data")
    if isinstance(data, list):
        nested = [
            item.get("b64_json")
            for item in data
            if isinstance(item, dict) and isinstance(item.get("b64_json"), str)
        ]
        if nested:
            diagnostic["nested_data_image_shape_count"] += 1
            candidates.extend(nested)
            classified = True
        if any(
            isinstance(item, dict)
            and isinstance(item.get("url"), str)
            and not isinstance(item.get("b64_json"), str)
            for item in data
        ):
            diagnostic["url_only_shape_count"] += 1
            classified = True

    choices = event.get("choices")
    if isinstance(choices, list):
        delta_candidates = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                delta_candidates.append(delta["content"])
        if delta_candidates:
            diagnostic["chat_delta_shape_count"] += 1
            candidates.extend(delta_candidates)
            classified = True

    response = event.get("response")
    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, list):
            response_candidates = []
            for item in output:
                if not isinstance(item, dict):
                    continue
                result = item.get("result")
                if isinstance(result, str):
                    response_candidates.append(result)
            if response_candidates:
                diagnostic["responses_image_shape_count"] += 1
                candidates.extend(response_candidates)
                classified = True

    if event.get("type") == "image_generation.partial_image":
        diagnostic["partial_image_event_count"] += 1
        classified = True

    if not classified:
        diagnostic["unclassified_shape_count"] += 1
    for candidate in candidates:
        diagnostic["candidate_encoding_class"] = _merge_observation(
            diagnostic["candidate_encoding_class"], _candidate_encoding_class(candidate)
        )
        diagnostic["candidate_size_class"] = _merge_observation(
            diagnostic["candidate_size_class"], _string_size_class(candidate)
        )


def _status_class(status: int) -> str:
    if 200 <= status < 300:
        return "2xx"
    if 400 <= status < 500:
        return "4xx"
    if 500 <= status < 600:
        return "5xx"
    return "other"


def _content_type_class(value: str) -> str:
    lowered = value.lower()
    if "text/event-stream" in lowered:
        return "event_stream"
    if "json" in lowered:
        return "json"
    if not lowered.strip():
        return "missing"
    return "other"


def _completed_image(event: dict[str, Any]) -> tuple[str, str]:
    direct = event.get("b64_json")
    if isinstance(direct, str):
        return direct, "direct"
    data = event.get("data")
    if (
        isinstance(data, list)
        and len(data) == 1
        and isinstance(data[0], dict)
        and isinstance(data[0].get("b64_json"), str)
    ):
        return data[0]["b64_json"], "nested_data"
    raise ValueError("missing completed image")


def _is_completed_image_candidate(event: dict[str, Any]) -> bool:
    if event.get("type") == "image_generation.completed":
        return True
    data = event.get("data")
    return (
        isinstance(data, list)
        and len(data) == 1
        and isinstance(data[0], dict)
        and isinstance(data[0].get("b64_json"), str)
    )

@dataclass(frozen=True)
class PromptReservation:
    preview_id: str
    prompt: str
    facts: dict[str, Any]
    expires_at: str


class PromptVault:
    """Bounded process-only vault. Values are never serialized or represented."""

    def __init__(
        self,
        ttl_seconds: float = 300,
        capacity: int = 64,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl_seconds
        self._capacity = capacity
        self._clock = clock
        self._entries: dict[str, dict[str, Any]] = {}

    def __repr__(self) -> str:
        return f"PromptVault(entries={len(self._entries)}, redacted=True)"

    def put(self, preview_id: str, prompt: str, facts: dict[str, Any], expires_at: str) -> None:
        self._purge()
        if len(self._entries) >= self._capacity:
            raise DomainError("IMAGE_GENERATION_PREVIEW_CAPACITY", "待确认生成请求过多")
        self._entries[preview_id] = {
            "prompt": prompt,
            "facts": facts,
            "expires_at": expires_at,
            "deadline": self._clock() + self._ttl,
            "reserved": False,
        }

    def reserve(self, preview_id: str) -> PromptReservation:
        self._purge()
        item = self._entries.get(preview_id)
        if item is None:
            raise DomainError("IMAGE_GENERATION_PREVIEW_EXPIRED", "生成确认已过期")
        if item["reserved"]:
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "生成确认正在使用")
        item["reserved"] = True
        return PromptReservation(
            preview_id, item["prompt"], dict(item["facts"]), item["expires_at"]
        )

    def release(self, preview_id: str) -> None:
        item = self._entries.get(preview_id)
        if item is not None:
            item["reserved"] = False

    def commit(self, preview_id: str) -> None:
        item = self._entries.get(preview_id)
        if item is None or not item["reserved"]:
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "生成确认不可用")
        del self._entries[preview_id]

    def transfer(self, preview_id: str, task_id: str) -> None:
        item = self._entries.get(preview_id)
        if item is None or not item["reserved"] or task_id in self._entries:
            raise DomainError("IMAGE_GENERATION_CONFIRMATION_INVALID", "生成确认不可用")
        item["reserved"] = False
        self._entries[task_id] = item
        del self._entries[preview_id]

    def discard(self, preview_id: str) -> None:
        self._entries.pop(preview_id, None)

    def clear(self) -> None:
        self._entries.clear()

    def count(self) -> int:
        self._purge()
        return len(self._entries)

    def _purge(self) -> None:
        now = self._clock()
        expired = [key for key, value in self._entries.items() if value["deadline"] <= now]
        for key in expired:
            del self._entries[key]


@dataclass(frozen=True)
class ProviderImageRequest:
    prompt: str
    size: str
    api_key: str
    diagnostic_id: str | None = None


@dataclass(frozen=True)
class ProviderImageResult:
    content: bytes
    provider_request_id: str | None
    usage: dict[str, int | float] | None
    response_sha256: str


class ImageProvider(Protocol):
    async def generate(
        self,
        request: ProviderImageRequest,
        cancel_event: asyncio.Event,
        on_dispatch: Callable[[], None],
    ) -> ProviderImageResult: ...


class FailOnCallImageProvider:
    async def generate(
        self,
        request: ProviderImageRequest,
        cancel_event: asyncio.Event,
        on_dispatch: Callable[[], None],
    ) -> ProviderImageResult:
        del request, cancel_event, on_dispatch
        raise ProviderImageError("IMAGE_PROVIDER_CALL_DISABLED", "当前环境未启用真实图片调用")


def _default_image_client(**kwargs: Any) -> httpx.AsyncClient:
    """默认出网 client factory：与注入前逐字节相同（不重定向、不读环境代理、超时 900/15）。

    抽成工厂的**唯一目的**是让代理可注入——图片 Provider 此前与文本 Provider 行为
    不一致（文本侧早已注入代理，图片侧没有），系统代理开着的用户文本可用、图片必失败。
    语义不变是硬约束：默认路径必须与本模块历史上的内联构造完全等价。
    """
    return httpx.AsyncClient(
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(900, connect=15),
        **kwargs,
    )


def image_client_factory_for_proxy(proxy: str) -> Callable[[], httpx.AsyncClient]:
    """装配侧代理注入用的工厂构造器（PROXY_SUPPORT：图片 Provider 同款 client 模式）。

    超时/不重定向/trust_env=False 只在 _default_image_client 定义一次——装配侧
    复制这些常量就会与图片 Provider 默认路径漂移，故此处只负责补 proxy。
    """

    def factory() -> httpx.AsyncClient:
        return _default_image_client(proxy=proxy)

    return factory


def _image_network_message(proxy: str | None, direct: str) -> str:
    """网络类错误文案：有代理才追加代理上下文，无代理逐字返回历史文案。

    ConnectError（"无法连接 Provider"）与 TransportError（"Provider 网络请求
    失败"）是两条既有区分，不能合并——前者定位"连不上"，后者定位"连上后传输
    中断"。这里只做**追加**，不改写原有措辞：无代理时输出与改动前逐字节相同。
    """
    if proxy:
        return f"{direct}（经代理 {proxy} 连接失败）"
    return direct


class ApiKeyFunImagesProvider:
    """固定第三方 SSE 端点；一次派发、不重定向、不重试。

    代理只来自**显式配置注入**（app 装配按三级回退解析后传入 client_factory），
    绝不读环境变量（trust_env=False 保持——出网路径完全显式是既有安全取舍）。
    """

    def __init__(
        self,
        client_factory: Callable[..., httpx.AsyncClient] | None = None,
        proxy_display: str | None = None,
    ) -> None:
        # None = 默认工厂（行为与注入前逐字节相同）；注入 = 装配侧的代理/测试替身。
        self._client_factory: Callable[..., httpx.AsyncClient] = (
            client_factory or _default_image_client
        )
        # 已脱敏代理回显值（scheme://host:port）——只用于出错文案，不参与出网。
        self._proxy_display = proxy_display
        self._protocol_diagnostics: dict[str, dict[str, Any]] = {}

    def take_protocol_diagnostic(self, diagnostic_id: str) -> dict[str, Any] | None:
        """Return and remove a content-free diagnostic for an isolated acceptance task."""
        value = self._protocol_diagnostics.pop(diagnostic_id, None)
        return dict(value) if value is not None else None

    def _store_protocol_diagnostic(
        self, diagnostic_id: str | None, value: dict[str, Any]
    ) -> None:
        if not diagnostic_id:
            return
        while len(self._protocol_diagnostics) >= _DIAGNOSTIC_LIMIT:
            self._protocol_diagnostics.pop(next(iter(self._protocol_diagnostics)))
        self._protocol_diagnostics[diagnostic_id] = dict(value)

    async def generate(
        self,
        request: ProviderImageRequest,
        cancel_event: asyncio.Event,
        on_dispatch: Callable[[], None],
    ) -> ProviderImageResult:
        diagnostic = _new_protocol_diagnostic()
        if request.size != "1024x1024":
            raise ProviderImageError("IMAGE_PROVIDER_UNSUPPORTED", "图片尺寸不受支持")
        if cancel_event.is_set():
            raise ProviderImageError("JOB_CANCELLED", "任务已取消")
        payload = {
            "model": IMAGE_MODEL,
            "prompt": request.prompt,
            "n": 1,
            "size": request.size,
            "stream": True,
            "response_format": "b64_json",
        }
        on_dispatch()
        try:
            # 经注入的工厂构造（默认工厂语义逐字节不变；代理只走显式配置链）。
            async with self._client_factory() as client:
                async with client.stream(
                    "POST",
                    IMAGE_ENDPOINT,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {request.api_key}",
                        "Accept": "text/event-stream",
                        "Content-Type": "application/json",
                    },
                ) as response:
                    status = response.status_code
                    diagnostic["http_status_class"] = _status_class(status)
                    request_id = response.headers.get("x-request-id")
                    if status != 200:
                        diagnostic["failure_stage"] = "http_status"
                        await response.aread()
                        _raise_status(status)
                    content_type = response.headers.get("content-type", "")
                    diagnostic["content_type_class"] = _content_type_class(content_type)
                    if diagnostic["content_type_class"] != "event_stream":
                        diagnostic["failure_stage"] = "unexpected_content_type"
                        await response.aread()
                        raise ProviderImageError(
                            "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
                        )
                    response_hasher = hashlib.sha256()
                    buffer = bytearray()
                    completed_image: str | None = None
                    completed_usage: dict[str, int | float] | None = None
                    diagnostic["stream_started"] = True

                    def process_frame(frame: bytes) -> None:
                        nonlocal completed_image, completed_usage
                        diagnostic["frame_count"] += 1
                        if _is_done_sse_frame(frame):
                            diagnostic["done_marker_count"] += 1
                        try:
                            event = _parse_sse_frame(frame)
                        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                            diagnostic["failure_stage"] = "event_decode"
                            raise
                        if event is None:
                            return
                        diagnostic["data_event_count"] += 1
                        _observe_protocol_shape(event, diagnostic)
                        if not _is_completed_image_candidate(event):
                            diagnostic["other_event_count"] += 1
                            return
                        diagnostic["completed_event_count"] += 1
                        try:
                            completed_image, location = _completed_image(event)
                            diagnostic["image_field_location"] = location
                        except ValueError:
                            diagnostic["image_field_location"] = "missing"
                            diagnostic["failure_stage"] = "completed_image_field"
                            raise
                        try:
                            completed_usage = _safe_usage(event.get("usage"))
                        except ValueError:
                            diagnostic["failure_stage"] = "usage_shape"
                            raise

                    async for chunk in response.aiter_bytes():
                        diagnostic["chunk_count"] += 1
                        if cancel_event.is_set():
                            diagnostic["failure_stage"] = "cancelled"
                            raise ProviderImageError("JOB_CANCELLED", "任务已取消", True)
                        response_hasher.update(chunk)
                        diagnostic["envelope_byte_count"] += len(chunk)
                        buffer.extend(chunk)
                        if diagnostic["envelope_byte_count"] > MAX_ENVELOPE_BYTES:
                            diagnostic["failure_stage"] = "envelope_too_large"
                            raise ProviderImageError(
                                "GENERATED_IMAGE_TOO_LARGE", "Provider 返回的图片过大", True
                            )
                        while True:
                            popped = _pop_sse_frame(buffer)
                            if popped is None:
                                break
                            frame, buffer = popped
                            process_frame(frame)
                    if buffer.strip():
                        process_frame(bytes(buffer))
                    diagnostic["stream_ended"] = True
        except ProviderImageError:
            diagnostic["outcome"] = "failed"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise
        except httpx.TimeoutException as exc:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "timeout"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError("PROVIDER_TIMEOUT", "Provider 请求超时", True) from exc
        except httpx.ConnectError as exc:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "connect"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError(
                "PROVIDER_NETWORK_ERROR",
                _image_network_message(self._proxy_display, "无法连接 Provider"),
                True,
            ) from exc
        except httpx.TransportError as exc:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "transport"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError(
                "PROVIDER_NETWORK_ERROR",
                _image_network_message(self._proxy_display, "Provider 网络请求失败"),
                True,
            ) from exc
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            diagnostic["outcome"] = "failed"
            if diagnostic["failure_stage"] == "none":
                diagnostic["failure_stage"] = "event_decode"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError(
                "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
            ) from exc
        completed_count = diagnostic["completed_event_count"]
        if completed_count == 0 or completed_image is None:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "completed_event_missing"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError("PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True)
        if completed_count != 1:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "completed_event_duplicate"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError("PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True)
        try:
            content = base64.b64decode(completed_image, validate=True)
        except (ValueError, binascii.Error) as exc:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "base64_decode"
            diagnostic["base64_state"] = "invalid"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError(
                "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
            ) from exc
        diagnostic["base64_state"] = "valid"
        if len(content) > MAX_IMAGE_BYTES:
            diagnostic["outcome"] = "failed"
            diagnostic["failure_stage"] = "image_too_large"
            self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
            raise ProviderImageError("GENERATED_IMAGE_TOO_LARGE", "Provider 返回的图片过大", True)
        diagnostic["outcome"] = "succeeded"
        diagnostic["failure_stage"] = "none"
        self._store_protocol_diagnostic(request.diagnostic_id, diagnostic)
        return ProviderImageResult(
            content, request_id, completed_usage, "sha256:" + response_hasher.hexdigest()
        )
def _raise_status(status: int) -> None:
    if status in {401, 403}:
        raise ProviderImageError("PROVIDER_AUTH_FAILED", "Provider 凭据无效", True)
    if status == 429:
        raise ProviderImageError("PROVIDER_RATE_LIMITED", "Provider 请求受限", True)
    if status >= 500:
        raise ProviderImageError("PROVIDER_UNAVAILABLE", "Provider 暂不可用", True)
    raise ProviderImageError("PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True)


def _pop_sse_frame(buffer: bytearray) -> tuple[bytes, bytearray] | None:
    matches = [
        (index, delimiter)
        for delimiter in (b"\r\n\r\n", b"\n\n", b"\r\r")
        if (index := buffer.find(delimiter)) >= 0
    ]
    if not matches:
        return None
    index, delimiter = min(matches, key=lambda item: item[0])
    return bytes(buffer[:index]), bytearray(buffer[index + len(delimiter) :])


def _parse_sse_frame(frame: bytes) -> dict[str, Any] | None:
    payload_lines: list[str] = []
    for raw_line in frame.replace(b"\r\n", b"\n").split(b"\n"):
        if raw_line.startswith(b"data:"):
            payload_lines.append(raw_line[5:].lstrip().decode("utf-8"))
    if not payload_lines:
        return None
    payload = "\n".join(payload_lines).strip()
    if not payload or payload == "[DONE]":
        return None
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("invalid SSE event")
    return value


def _is_done_sse_frame(frame: bytes) -> bool:
    for raw_line in frame.replace(b"\r\n", b"\n").split(b"\n"):
        if raw_line.startswith(b"data:") and raw_line[5:].lstrip().strip() == b"[DONE]":
            return True
    return False

def _completed_b64_json(event: dict[str, Any]) -> str:
    direct = event.get("b64_json")
    if isinstance(direct, str):
        return direct
    data = event.get("data")
    if (
        isinstance(data, list)
        and len(data) == 1
        and isinstance(data[0], dict)
        and isinstance(data[0].get("b64_json"), str)
    ):
        return data[0]["b64_json"]
    raise ValueError("missing completed image")


def _safe_usage(value: Any) -> dict[str, int | float] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("invalid usage")
    result: dict[str, int | float] = {}
    for key in ("images", "input_tokens", "output_tokens", "total_tokens"):
        item = value.get(key)
        if isinstance(item, bool) or (item is not None and not isinstance(item, (int, float))):
            raise ValueError("invalid usage")
        if item is not None and item >= 0:
            result[key] = item
    return result or None


def _validate_native_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
    if width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE:
        raise ProviderImageError("GENERATED_IMAGE_TOO_LARGE", "生成图片尺寸超过安全上限")
    if width * height > MAX_IMAGE_PIXELS:
        raise ProviderImageError("GENERATED_IMAGE_TOO_LARGE", "生成图片像素超过安全上限")


def _strict_png(value: bytes) -> tuple[int, int]:
    if len(value) < 33 or value[8:12] != b"\x00\x00\x00\r" or value[12:16] != b"IHDR":
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
    header_width, header_height = struct.unpack(">II", value[16:24])
    _validate_native_dimensions(header_width, header_height)
    offset = 8
    saw_iend = False
    while offset < len(value):
        if offset + 12 > len(value):
            raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
        length = struct.unpack(">I", value[offset : offset + 4])[0]
        end = offset + 12 + length
        if end > len(value):
            raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
        kind = value[offset + 4 : offset + 8]
        payload = value[offset + 8 : offset + 8 + length]
        expected = struct.unpack(">I", value[offset + 8 + length : end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected:
            raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
        offset = end
        if kind == b"IEND":
            saw_iend = True
            break
    if not saw_iend or offset != len(value):
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码")
    return header_width, header_height


def validate_generated_image(value: bytes, requested_size: str) -> dict[str, Any]:
    if len(value) > MAX_IMAGE_BYTES:
        raise ProviderImageError("GENERATED_IMAGE_TOO_LARGE", "生成图片过大")
    if requested_size not in ALLOWED_IMAGE_SIZES:
        raise ProviderImageError("IMAGE_PROVIDER_UNSUPPORTED", "图片尺寸不受支持")
    if not value.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ProviderImageError("GENERATED_IMAGE_FORMAT_UNSUPPORTED", "生成图片格式不受支持")
    header_dimensions = _strict_png(value)
    try:
        with av.open(io.BytesIO(value), mode="r") as container:
            frames = list(container.decode(video=0))
    except Exception as exc:
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片无法解码") from exc
    if len(frames) != 1:
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片必须为单帧")
    width, height = frames[0].width, frames[0].height
    _validate_native_dimensions(width, height)
    if (width, height) != header_dimensions:
        raise ProviderImageError("GENERATED_IMAGE_DECODE_FAILED", "生成图片尺寸元数据不一致")
    return {
        "format": "png",
        "extension": "png",
        "width": width,
        "height": height,
        "size_bytes": len(value),
        "sha256": sha256_bytes(value),
    }
