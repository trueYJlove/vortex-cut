from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass, field


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass
class AuthStore:
    admin_token: str
    ui_token_hashes: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.admin_hash = token_hash(self.admin_token)
        self.admin_token = ""

    def is_admin(self, token: str | None) -> bool:
        return bool(token) and secrets.compare_digest(token_hash(token), self.admin_hash)

    def create_ui_token(self) -> str:
        token = secrets.token_urlsafe(32)
        self.ui_token_hashes.add(token_hash(token))
        return token

    def is_ui(self, token: str | None) -> bool:
        return bool(token) and token_hash(token) in self.ui_token_hashes

    def clear(self) -> None:
        self.ui_token_hashes.clear()
