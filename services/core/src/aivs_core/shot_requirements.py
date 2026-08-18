from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from typing import Any

from .database import Database, utc_now
from .ids import new_id
from .projects import DomainError

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SENSITIVE_KEYS = {
    "path",
    "uri",
    "absolute_path",
    "prompt",
    "transcript",
    "caption",
    "authorization",
    "api_key",
    "secret",
    "payload",
    "raw_exception",
    "raw_response",
    "stderr",
    "command",
    "traceback",
}


def _fail(code: str, message: str) -> None:
    raise DomainError(code, message)


def _id(value: Any, field: str = "id") -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _fail("SHOT_LIST_INVALID", f"{field} 不合法")
    return value


def _reject_sensitive(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _reject_sensitive(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _SENSITIVE_KEYS:
                _fail("SHOT_LIST_INVALID", "请求包含禁止字段")
            _reject_sensitive(item)


def _exact(value: Any, keys: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        _fail(code, "请求字段不合法")
    _reject_sensitive(value)
    return value


def _controls(text: str, code: str) -> None:
    if any(unicodedata.category(char) in {"Cc", "Cs"} and char not in "\n\t" for char in text):
        _fail(code, "文本包含不支持的控制字符")


def _inline(value: Any, minimum: int, maximum: int, code: str) -> str:
    if not isinstance(value, str):
        _fail(code, "文本字段不合法")
    text = unicodedata.normalize("NFC", value)
    _controls(text, code)
    text = re.sub(r"\s+", " ", text.strip())
    if not minimum <= len(text) <= maximum:
        _fail(code, "文本长度不合法")
    return text


def _block(value: Any, minimum: int, maximum: int, code: str) -> str:
    if not isinstance(value, str):
        _fail(code, "文本字段不合法")
    text = unicodedata.normalize("NFC", value).replace("\r\n", "\n").replace("\r", "\n")
    _controls(text, code)
    text = "\n".join(line.rstrip(" \t") for line in text.split("\n")).strip(" \t\n")
    if not minimum <= len(text) <= maximum:
        _fail(code, "文本长度不合法")
    return text


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _document_sha256(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _normalize(value: Any) -> dict[str, Any]:
    root = _exact(
        value,
        {"schema_version", "base_revision_id", "title", "summary", "requirements"},
        "SHOT_LIST_INVALID",
    )
    if root["schema_version"] != 1:
        _fail("SHOT_LIST_INVALID", "schema_version 必须为 1")
    base = root["base_revision_id"]
    if base is not None:
        base = _id(base, "base_revision_id")
    raw_items = root["requirements"]
    if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= 24:
        _fail("SHOT_REQUIREMENT_INVALID", "镜头数量必须为 1 至 24")
    requirements: list[dict[str, Any]] = []
    for ordinal, raw in enumerate(raw_items):
        item = _exact(
            raw,
            {"title", "visual_direction", "target_duration_us", "visual", "narration"},
            "SHOT_REQUIREMENT_INVALID",
        )
        duration = item["target_duration_us"]
        if duration is not None and (
            not isinstance(duration, int)
            or isinstance(duration, bool)
            or not 100_000 <= duration <= 600_000_000
        ):
            _fail("SHOT_REQUIREMENT_INVALID", "目标时长不合法")
        visual = _exact(
            item["visual"],
            {"requirement_kind", "source_asset_id"},
            "SHOT_REQUIREMENT_INVALID",
        )
        kind = visual["requirement_kind"]
        source = visual["source_asset_id"]
        if kind == "existing_media":
            source = _id(source, "source_asset_id")
        elif kind == "image" and source is None:
            pass
        else:
            _fail("SHOT_REQUIREMENT_INVALID", "视觉需求组合不合法")
        narration_value = item["narration"]
        narration = None
        if narration_value is not None:
            narration_raw = _exact(
                narration_value, {"requirement_kind", "text"}, "SHOT_REQUIREMENT_INVALID"
            )
            if narration_raw["requirement_kind"] != "tts":
                _fail("SHOT_REQUIREMENT_INVALID", "旁白需求类型不合法")
            narration = {
                "requirement_kind": "tts",
                "text": _block(narration_raw["text"], 1, 2000, "SHOT_REQUIREMENT_INVALID"),
            }
        requirements.append(
            {
                "ordinal": ordinal,
                "title": _inline(item["title"], 1, 120, "SHOT_REQUIREMENT_INVALID"),
                "visual_direction": _block(
                    item["visual_direction"], 1, 2000, "SHOT_REQUIREMENT_INVALID"
                ),
                "target_duration_us": duration,
                "visual": {"requirement_kind": kind, "source_asset_id": source},
                "narration": narration,
            }
        )
    content = {
        "schema_version": 1,
        "title": _inline(root["title"], 1, 120, "SHOT_LIST_INVALID"),
        "summary": _block(root["summary"], 0, 4000, "SHOT_LIST_INVALID"),
        "requirements": requirements,
    }
    return {
        "base_revision_id": base,
        "content": content,
        "document_sha256": _document_sha256(content),
    }


class ShotRequirementService:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _project(sql: sqlite3.Connection, project_id: str, *, active: bool = False) -> sqlite3.Row:
        row = sql.execute("SELECT id,status FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            _fail("PROJECT_NOT_FOUND", "项目不存在")
        if active and row["status"] != "active":
            _fail("PROJECT_ARCHIVED", "项目已归档，不能修改镜头需求")
        return row

    @staticmethod
    def _summary(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "schema_version": int(row["schema_version"]),
            "shot_list_revision_id": row["id"],
            "shot_list_id": row["shot_list_id"],
            "project_id": row["project_id"],
            "parent_revision_id": row["parent_revision_id"],
            "title": row["title"],
            "requirement_count": int(row["requirement_count"]),
            "document_sha256": row["document_sha256"],
            "created_at": row["created_at"],
        }

    @classmethod
    def _detail(cls, sql: sqlite3.Connection, revision_id: str) -> dict[str, Any]:
        row = sql.execute(
            "SELECT r.*,(SELECT COUNT(*) FROM shot_requirements q "
            "WHERE q.shot_list_revision_id=r.id) requirement_count "
            "FROM shot_list_revisions r WHERE r.id=?",
            (revision_id,),
        ).fetchone()
        if row is None:
            _fail("SHOT_LIST_REVISION_NOT_FOUND", "镜头需求版本不存在")
        requirements = []
        for item in sql.execute(
            "SELECT * FROM shot_requirements WHERE shot_list_revision_id=? ORDER BY ordinal",
            (revision_id,),
        ):
            requirements.append(
                {
                    "shot_requirement_id": item["id"],
                    "shot_list_revision_id": item["shot_list_revision_id"],
                    "ordinal": int(item["ordinal"]),
                    "title": item["title"],
                    "visual_direction": item["visual_direction"],
                    "target_duration_us": item["target_duration_us"],
                    "visual": {
                        "requirement_kind": item["visual_kind"],
                        "source_asset_id": item["visual_source_asset_id"],
                    },
                    "narration": (
                        {"requirement_kind": "tts", "text": item["narration_text"]}
                        if item["narration_kind"] == "tts"
                        else None
                    ),
                }
            )
        return {**cls._summary(row), "summary": row["summary"], "requirements": requirements}

    @classmethod
    def _state(cls, sql: sqlite3.Connection, project_id: str) -> dict[str, Any]:
        cls._project(sql, project_id)
        shot_list = sql.execute(
            "SELECT * FROM shot_lists WHERE project_id=?", (project_id,)
        ).fetchone()
        if shot_list is None:
            return {
                "shot_list_id": None,
                "project_id": project_id,
                "lifecycle": "empty",
                "current_revision": None,
                "confirmed_revision": None,
            }
        current = (
            cls._detail(sql, shot_list["current_revision_id"])
            if shot_list["current_revision_id"] is not None
            else None
        )
        confirmed = None
        if shot_list["confirmed_revision_id"] is not None:
            confirmed_row = sql.execute(
                "SELECT r.*,(SELECT COUNT(*) FROM shot_requirements q "
                "WHERE q.shot_list_revision_id=r.id) requirement_count "
                "FROM shot_list_revisions r WHERE r.id=?",
                (shot_list["confirmed_revision_id"],),
            ).fetchone()
            if confirmed_row is not None:
                confirmed = cls._summary(confirmed_row)
        lifecycle = (
            "confirmed"
            if current is not None
            and confirmed is not None
            and current["shot_list_revision_id"] == confirmed["shot_list_revision_id"]
            else "drafted"
        )
        return {
            "shot_list_id": shot_list["id"],
            "project_id": project_id,
            "lifecycle": lifecycle,
            "current_revision": current,
            "confirmed_revision": confirmed,
        }

    def get_state(self, project_id: str) -> dict[str, Any]:
        _id(project_id, "project_id")
        with self.db.connection() as sql:
            return self._state(sql, project_id)

    def list_revisions(
        self, project_id: str, limit: int = 20, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        _id(project_id, "project_id")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            _fail("SHOT_LIST_INVALID", "分页参数不合法")
        if cursor is not None and (not cursor.isdigit() or len(cursor) > 10):
            _fail("SHOT_LIST_INVALID", "分页参数不合法")
        offset = int(cursor or 0)
        with self.db.connection() as sql:
            self._project(sql, project_id)
            rows = sql.execute(
                "SELECT r.*,(SELECT COUNT(*) FROM shot_requirements q "
                "WHERE q.shot_list_revision_id=r.id) requirement_count "
                "FROM shot_list_revisions r WHERE r.project_id=? "
                "ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?",
                (project_id, limit, offset),
            ).fetchall()
        items = [self._summary(row) for row in rows]
        return items, str(offset + len(items)) if len(items) == limit else None

    def get_revision(self, revision_id: str) -> dict[str, Any]:
        _id(revision_id, "revision_id")
        with self.db.connection() as sql:
            return self._detail(sql, revision_id)

    def create_revision(self, project_id: str, value: dict[str, Any]) -> dict[str, Any]:
        _id(project_id, "project_id")
        normalized = _normalize(value)
        content = normalized["content"]
        now = utc_now()
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                self._project(sql, project_id, active=True)
                shot_list = sql.execute(
                    "SELECT * FROM shot_lists WHERE project_id=?", (project_id,)
                ).fetchone()
                if shot_list is None:
                    if normalized["base_revision_id"] is not None:
                        _fail("SHOT_LIST_CONFLICT", "镜头需求已更新，请重新载入")
                    shot_list_id = new_id()
                    current_revision_id = None
                    sql.execute(
                        "INSERT INTO shot_lists(id,project_id,current_revision_id,"
                        "confirmed_revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                        (shot_list_id, project_id, None, None, now, now),
                    )
                else:
                    shot_list_id = shot_list["id"]
                    current_revision_id = shot_list["current_revision_id"]
                    if normalized["base_revision_id"] != current_revision_id:
                        _fail("SHOT_LIST_CONFLICT", "镜头需求已更新，请重新载入")
                if current_revision_id is not None:
                    current_hash = sql.execute(
                        "SELECT document_sha256 FROM shot_list_revisions WHERE id=?",
                        (current_revision_id,),
                    ).fetchone()
                    if (
                        current_hash is not None
                        and current_hash[0] == normalized["document_sha256"]
                    ):
                        revision = self._detail(sql, current_revision_id)
                        state = self._state(sql, project_id)
                        sql.execute("COMMIT")
                        return {"revision": revision, "state": state, "reused": True}
                for item in content["requirements"]:
                    if item["visual"]["requirement_kind"] != "existing_media":
                        continue
                    asset = sql.execute(
                        "SELECT project_id FROM assets WHERE id=?",
                        (item["visual"]["source_asset_id"],),
                    ).fetchone()
                    if asset is None:
                        _fail("SHOT_REQUIREMENT_ASSET_NOT_FOUND", "引用的素材不存在")
                    if asset["project_id"] != project_id:
                        _fail("SHOT_REQUIREMENT_ASSET_PROJECT_MISMATCH", "引用的素材不属于当前项目")
                revision_id = new_id()
                sql.execute(
                    "INSERT INTO shot_list_revisions(id,shot_list_id,project_id,"
                    "parent_revision_id,schema_version,title,summary,document_sha256,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        revision_id,
                        shot_list_id,
                        project_id,
                        current_revision_id,
                        1,
                        content["title"],
                        content["summary"],
                        normalized["document_sha256"],
                        now,
                    ),
                )
                for item in content["requirements"]:
                    narration = item["narration"]
                    sql.execute(
                        "INSERT INTO shot_requirements(id,shot_list_revision_id,ordinal,title,"
                        "visual_direction,target_duration_us,visual_kind,visual_source_asset_id,"
                        "narration_kind,narration_text) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            new_id(),
                            revision_id,
                            item["ordinal"],
                            item["title"],
                            item["visual_direction"],
                            item["target_duration_us"],
                            item["visual"]["requirement_kind"],
                            item["visual"]["source_asset_id"],
                            narration["requirement_kind"] if narration else None,
                            narration["text"] if narration else None,
                        ),
                    )
                sql.execute(
                    "UPDATE shot_lists SET current_revision_id=?,updated_at=? WHERE id=?",
                    (revision_id, now, shot_list_id),
                )
                revision = self._detail(sql, revision_id)
                state = self._state(sql, project_id)
                sql.execute("COMMIT")
                return {"revision": revision, "state": state, "reused": False}
            except DomainError:
                sql.execute("ROLLBACK")
                raise
            except sqlite3.IntegrityError as exc:
                sql.execute("ROLLBACK")
                raise DomainError("SHOT_LIST_INVALID", "镜头需求保存失败") from exc
            except Exception:
                sql.execute("ROLLBACK")
                raise

    def confirm(self, project_id: str, value: dict[str, Any]) -> dict[str, Any]:
        _id(project_id, "project_id")
        command = _exact(
            value,
            {"revision_id", "expected_current_revision_id"},
            "SHOT_LIST_INVALID",
        )
        revision_id = _id(command["revision_id"], "revision_id")
        expected = _id(command["expected_current_revision_id"], "expected_current_revision_id")
        with self.db.connection() as sql:
            sql.execute("BEGIN IMMEDIATE")
            try:
                self._project(sql, project_id, active=True)
                shot_list = sql.execute(
                    "SELECT * FROM shot_lists WHERE project_id=?", (project_id,)
                ).fetchone()
                if (
                    shot_list is None
                    or shot_list["current_revision_id"] != expected
                    or revision_id != expected
                ):
                    _fail("SHOT_LIST_CONFIRMATION_CONFLICT", "当前版本已变化，请重新载入")
                reused = shot_list["confirmed_revision_id"] == revision_id
                if not reused:
                    sql.execute(
                        "UPDATE shot_lists SET confirmed_revision_id=?,updated_at=? WHERE id=?",
                        (revision_id, utc_now(), shot_list["id"]),
                    )
                state = self._state(sql, project_id)
                sql.execute("COMMIT")
                return {"state": state, "reused": reused}
            except DomainError:
                sql.execute("ROLLBACK")
                raise
            except Exception:
                sql.execute("ROLLBACK")
                raise
