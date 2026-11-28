"""Process-local expiring payload stores (values are never serialized or logged)."""
from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock
from typing import Any


def is_expired(expires_at: str) -> bool:
    return datetime.fromisoformat(expires_at.replace("Z", "+00:00")) <= datetime.now(UTC)


class ExpiringPayloadStore:
    """Thread-safe in-memory TTL store keyed by ID for ephemeral egress payloads."""

    def __init__(self) -> None:
        self._values: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def put(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._values[key] = value

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._values.get(key)
            if value is None:
                return None
            if is_expired(value["expires_at"]):
                self._values.pop(key, None)
                return None
            return value

    def pop(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._values.pop(key, None)
        if value is None or is_expired(value["expires_at"]):
            return None
        return value

    def take(self, key: str) -> dict[str, Any] | None:
        """Consume and return a non-expired payload entry."""
        return self.pop(key)

    def discard(self, key: str) -> None:
        with self._lock:
            self._values.pop(key, None)
