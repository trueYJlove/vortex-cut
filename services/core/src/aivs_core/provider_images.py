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


class ApiKeyFunImagesProvider:
    """Fixed third-party SSE endpoint; one dispatch, no redirects, retries, or env proxy."""

    async def generate(
        self,
        request: ProviderImageRequest,
        cancel_event: asyncio.Event,
        on_dispatch: Callable[[], None],
    ) -> ProviderImageResult:
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
            async with httpx.AsyncClient(
                follow_redirects=False,
                trust_env=False,
                timeout=httpx.Timeout(900, connect=15),
            ) as client:
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
                    request_id = response.headers.get("x-request-id")
                    if status != 200:
                        await response.aread()
                        _raise_status(status)
                    content_type = response.headers.get("content-type", "").lower()
                    if "text/event-stream" not in content_type:
                        await response.aread()
                        raise ProviderImageError(
                            "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
                        )
                    response_hasher = hashlib.sha256()
                    envelope_size = 0
                    buffer = bytearray()
                    completed_image: str | None = None
                    completed_usage: dict[str, int | float] | None = None
                    completed_count = 0
                    async for chunk in response.aiter_bytes():
                        if cancel_event.is_set():
                            raise ProviderImageError("JOB_CANCELLED", "任务已取消", True)
                        response_hasher.update(chunk)
                        envelope_size += len(chunk)
                        buffer.extend(chunk)
                        if envelope_size > MAX_ENVELOPE_BYTES:
                            raise ProviderImageError(
                                "GENERATED_IMAGE_TOO_LARGE", "Provider 返回的图片过大", True
                            )
                        while True:
                            popped = _pop_sse_frame(buffer)
                            if popped is None:
                                break
                            frame, buffer = popped
                            event = _parse_sse_frame(frame)
                            if event is None:
                                continue
                            if event.get("type") == "image_generation.completed":
                                completed_count += 1
                                completed_image = _completed_b64_json(event)
                                completed_usage = _safe_usage(event.get("usage"))
                    if buffer.strip():
                        event = _parse_sse_frame(bytes(buffer))
                        if event is not None and event.get("type") == "image_generation.completed":
                            completed_count += 1
                            completed_image = _completed_b64_json(event)
                            completed_usage = _safe_usage(event.get("usage"))
        except ProviderImageError:
            raise
        except httpx.TimeoutException as exc:
            raise ProviderImageError("PROVIDER_TIMEOUT", "Provider 请求超时", True) from exc
        except httpx.ConnectError as exc:
            raise ProviderImageError("PROVIDER_NETWORK_ERROR", "无法连接 Provider", True) from exc
        except httpx.TransportError as exc:
            raise ProviderImageError(
                "PROVIDER_NETWORK_ERROR", "Provider 网络请求失败", True
            ) from exc
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ProviderImageError(
                "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
            ) from exc
        if completed_count != 1 or completed_image is None:
            raise ProviderImageError("PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True)
        try:
            content = base64.b64decode(completed_image, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ProviderImageError(
                "PROVIDER_INVALID_RESPONSE", "Provider 响应无效", True
            ) from exc
        if len(content) > MAX_IMAGE_BYTES:
            raise ProviderImageError("GENERATED_IMAGE_TOO_LARGE", "Provider 返回的图片过大", True)
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
