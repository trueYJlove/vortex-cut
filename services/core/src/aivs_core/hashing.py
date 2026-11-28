"""Deterministic canonical JSON and SHA-256 hashing helpers."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Serialize `value` into deterministic compact UTF-8 JSON."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_canonical(value: Any) -> str:
    """Return prefixed SHA-256 digest (`sha256:...`) of canonical JSON."""
    return f"sha256:{hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()}"


def sha256_text(value: str) -> str:
    """Return prefixed SHA-256 digest (`sha256:...`) of raw UTF-8 text."""
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"
