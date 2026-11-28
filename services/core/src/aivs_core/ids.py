import re
from typing import Any
from uuid import uuid4

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def new_id() -> str:
    return uuid4().hex


def is_valid_id(value: Any) -> bool:
    """Return True if `value` is a non-empty ASCII identifier up to 128 chars."""
    return isinstance(value, str) and _ID_PATTERN.fullmatch(value) is not None


def validate_id(value: Any, code: str, message: str) -> str:
    """Validate an ASCII identifier (1..128 chars of `[A-Za-z0-9_-]`) or raise `DomainError`."""
    if not is_valid_id(value):
        from .projects import DomainError

        raise DomainError(code, message)
    return value
