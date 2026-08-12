from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .database import Database, json_dumps, json_loads, sha256_file, utc_now
from .ids import new_id

PROJECT_STATUSES = {"active", "archived", "missing"}
ASSET_KINDS = {"video", "audio", "image", "text"}
ASSET_AVAILABILITIES = {"available", "missing", "changed", "unsupported"}
SUPPORTED_EXTENSIONS = {
    "video": {".mp4", ".mov", ".mkv", ".webm", ".avi"},
    "audio": {".wav", ".mp3", ".m4a", ".aac", ".flac"},
    "image": {".png", ".jpg", ".jpeg", ".webp"},
    "text": {".txt", ".srt", ".vtt"},
}


class DomainError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def modified_iso(path: Path) -> str:
    return (
        datetime.fromtimestamp(path.stat().st_mtime, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class ProjectAssetService:
    def __init__(
        self,
        db: Database,
        data_dir: Path,
        probe: Callable[..., Awaitable[dict[str, Any]]],
        transcript_stale: Callable[[str, str | None], None] | None = None,
    ) -> None:
        self.db = db
        self.data_dir = data_dir
        self.probe = probe
        self.transcript_stale = transcript_stale

    def create_project(self, name: str, root_dir_name: str | None = None) -> dict[str, Any]:
        project_name = _project_name(name)
        root_name = _project_name(root_dir_name or project_name)
        project_id = f"project_{new_id()}"
        now = utc_now()
        root_dir = self.data_dir / "projects" / project_id
        root_dir.mkdir(parents=True, exist_ok=True)
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO projects (id,name,status,canvas_json,current_timeline_revision_id,"
                "root_dir,root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    project_id,
                    project_name,
                    "active",
                    json_dumps({"width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1}),
                    None,
                    str(root_dir),
                    root_name,
                    now,
                    now,
                    now,
                ),
            )
        return self.get_project(project_id)  # type: ignore[return-value]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        return _project_dto(row) if row else None

    def list_projects(
        self, status: str | None = None, limit: int = 50, cursor: str | None = None
    ) -> tuple[list[dict[str, Any]], str | None]:
        if status is not None and status not in PROJECT_STATUSES:
            raise DomainError("VALIDATION_ERROR", "状态筛选条件不合法")
        offset = _cursor_offset(cursor)
        query = "SELECT * FROM projects"
        values: list[Any] = []
        if status:
            query += " WHERE status=?"
            values.append(status)
        query += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        values.extend([_limit(limit), offset])
        with self.db.connection() as db:
            rows = db.execute(query, values).fetchall()
        items = [_project_dto(row) for row in rows]
        next_cursor = str(offset + len(items)) if len(items) == _limit(limit) else None
        return items, next_cursor

    def rename_project(self, project_id: str, name: str) -> dict[str, Any]:
        project_name = _project_name(name)
        self._require_project(project_id)
        with self.db.connection() as db:
            db.execute(
                "UPDATE projects SET name=?,updated_at=? WHERE id=?",
                (project_name, utc_now(), project_id),
            )
        return self.get_project(project_id)  # type: ignore[return-value]

    def archive_project(self, project_id: str) -> dict[str, Any]:
        project = self._require_project_row(project_id)
        if project["status"] == "archived":
            return _project_dto(project)
        with self.db.connection() as db:
            db.execute(
                "UPDATE projects SET status='archived',updated_at=? WHERE id=?",
                (utc_now(), project_id),
            )
        return self.get_project(project_id)  # type: ignore[return-value]

    def reopen_project(self, project_id: str) -> dict[str, Any]:
        self._require_project(project_id)
        with self.db.connection() as db:
            db.execute(
                "UPDATE projects SET status='active',last_opened_at=?,updated_at=? WHERE id=?",
                (utc_now(), utc_now(), project_id),
            )
        return self.get_project(project_id)  # type: ignore[return-value]

    def list_assets(
        self,
        project_id: str,
        availability: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        self._require_project(project_id)
        if availability is not None and availability not in ASSET_AVAILABILITIES:
            raise DomainError("VALIDATION_ERROR", "可用性筛选条件不合法")
        offset = _cursor_offset(cursor)
        query = "SELECT * FROM assets WHERE project_id=?"
        values: list[Any] = [project_id]
        if availability:
            query += " AND availability=?"
            values.append(availability)
        query += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        values.extend([_limit(limit), offset])
        with self.db.connection() as db:
            rows = db.execute(query, values).fetchall()
        items = [_asset_dto(row) for row in rows]
        next_cursor = str(offset + len(items)) if len(items) == _limit(limit) else None
        return items, next_cursor

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return _asset_dto(row) if row else None

    async def import_asset(
        self, project_id: str, grant: dict[str, Any], requested_kind: str | None = None
    ) -> dict[str, Any]:
        project = self._require_project_row(project_id)
        if project["status"] == "archived":
            raise DomainError("PROJECT_ARCHIVED", "项目已归档，无法导入素材")
        path = _grant_path(grant)
        kind = _asset_kind(path, requested_kind)
        fingerprint = sha256_file(path)
        with self.db.connection() as db:
            duplicate = db.execute(
                "SELECT * FROM assets WHERE project_id=? AND fingerprint=?",
                (project_id, fingerprint),
            ).fetchone()
        if duplicate:
            raise DomainError("ASSET_DUPLICATE", "素材已存在于项目中")
        availability = "available"
        try:
            media_info = await self._media_info(path, kind)
        except DomainError as exc:
            if exc.code not in {
                "MEDIA_UNSUPPORTED",
                "MEDIA_HAS_NO_VIDEO",
                "MEDIA_PROBE_TIMEOUT",
                "FFMPEG_NOT_FOUND",
            }:
                raise
            availability = "unsupported"
            media_info = None
        asset_id = f"asset_{new_id()}"
        now = utc_now()
        modified_at = modified_iso(path)
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    project_id,
                    kind,
                    "external",
                    path.name,
                    fingerprint,
                    path.stat().st_size,
                    modified_at,
                    availability,
                    json_dumps(media_info) if media_info is not None else None,
                    now,
                    now,
                ),
            )
            db.execute(
                "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
                (asset_id, path.as_uri(), now),
            )
        return self.get_asset(asset_id)  # type: ignore[return-value]

    async def refresh_asset(self, asset_id: str) -> dict[str, Any]:
        row = self._require_asset_row(asset_id)
        location = self._location(asset_id)
        if not location:
            raise DomainError("ASSET_NOT_FOUND", "素材不存在")
        path = _path_from_uri(location["uri"])
        now = utc_now()
        if not path.is_file():
            self._update_asset(asset_id, "missing", now=now)
            self._mark_transcripts_stale(asset_id, None)
            return self.get_asset(asset_id)  # type: ignore[return-value]
        try:
            fingerprint = sha256_file(path)
            if fingerprint != row["fingerprint"]:
                self._remember_previous_fingerprint(asset_id, row["fingerprint"])
                self._mark_transcripts_stale(asset_id, fingerprint)
            media_info = await self._media_info(path, row["kind"])
            availability = "available" if fingerprint == row["fingerprint"] else "changed"
        except DomainError:
            fingerprint = row["fingerprint"]
            media_info = None
            availability = "unsupported"
        self._update_asset(
            asset_id,
            availability,
            fingerprint=fingerprint if availability == "changed" else None,
            size_bytes=path.stat().st_size,
            modified_at=modified_iso(path),
            media_info=media_info,
            now=now,
        )
        with self.db.connection() as db:
            db.execute(
                "UPDATE asset_locations SET last_verified_at=? WHERE asset_id=?",
                (now, asset_id),
            )
        return self.get_asset(asset_id)  # type: ignore[return-value]

    def current_source(self, asset_id: str) -> tuple[dict[str, Any], str | None, str | None]:
        row = self._require_asset_row(asset_id)
        location = self._location(asset_id)
        if not location:
            self._update_asset(asset_id, "missing")
            self._mark_transcripts_stale(asset_id, None)
            return self.get_asset(asset_id) or _asset_dto(row), None, None
        path = _path_from_uri(location["uri"])
        if not path.is_file():
            self._update_asset(asset_id, "missing")
            self._mark_transcripts_stale(asset_id, None)
            return self.get_asset(asset_id) or _asset_dto(row), None, None
        try:
            fingerprint = sha256_file(path)
        except OSError as exc:
            raise DomainError("ASSET_MISSING", "素材文件缺失") from exc
        if fingerprint != row["fingerprint"]:
            self._remember_previous_fingerprint(asset_id, row["fingerprint"])
            self._update_asset(asset_id, "changed", fingerprint=fingerprint)
            self._mark_transcripts_stale(asset_id, fingerprint)
        elif row["availability"] != "changed":
            self._update_asset(asset_id, "available")
        return self.get_asset(asset_id) or _asset_dto(row), path.as_uri(), fingerprint

    def resolve_asset_path(self, asset_id: str) -> dict[str, str]:
        row = self._require_asset_row(asset_id)
        if row["availability"] == "missing":
            raise DomainError("ASSET_MISSING", "素材文件缺失")
        if row["availability"] != "available":
            raise DomainError("ASSET_CHANGED", "素材文件已变化")
        location = self._location(asset_id)
        if location is None:
            self._update_asset(asset_id, "missing")
            raise DomainError("ASSET_MISSING", "素材文件缺失")
        try:
            path = _path_from_uri(location["uri"]).resolve(strict=True)
            if not path.is_file():
                raise OSError
            stat = path.stat()
        except OSError as exc:
            self._update_asset(asset_id, "missing")
            raise DomainError("ASSET_MISSING", "素材文件缺失") from exc
        if stat.st_size != row["size_bytes"] or modified_iso(path) != row["modified_at"]:
            self._update_asset(asset_id, "changed")
            raise DomainError("ASSET_CHANGED", "素材文件已变化")
        try:
            fingerprint = sha256_file(path)
        except OSError as exc:
            self._update_asset(asset_id, "missing")
            raise DomainError("ASSET_MISSING", "素材文件缺失") from exc
        if fingerprint != row["fingerprint"]:
            self._remember_previous_fingerprint(asset_id, row["fingerprint"])
            self._update_asset(asset_id, "changed", fingerprint=fingerprint)
            self._mark_transcripts_stale(asset_id, fingerprint)
            raise DomainError("ASSET_CHANGED", "素材文件已变化")
        return {"asset_id": asset_id, "path": str(path)}

    async def relocate_asset(self, asset_id: str, grant: dict[str, Any]) -> dict[str, Any]:
        row = self._require_asset_row(asset_id)
        path = _grant_path(grant)
        fingerprint = sha256_file(path)
        location = self._location(asset_id)
        previous_fingerprint = location["previous_fingerprint"] if location else None
        if fingerprint not in {row["fingerprint"], previous_fingerprint}:
            raise DomainError("ASSET_CHANGED", "素材文件已变化，无法重新定位")
        try:
            media_info = await self._media_info(path, row["kind"])
            availability = "available"
        except DomainError as exc:
            if exc.code not in {
                "MEDIA_UNSUPPORTED",
                "MEDIA_HAS_NO_VIDEO",
                "MEDIA_PROBE_TIMEOUT",
                "FFMPEG_NOT_FOUND",
            }:
                raise
            media_info = None
            availability = "unsupported"
        now = utc_now()
        with self.db.connection() as db:
            db.execute(
                "UPDATE asset_locations SET uri=?,last_verified_at=?,previous_uri=?,"
                "previous_fingerprint=?,relocated_at=? WHERE asset_id=?",
                (
                    path.as_uri(),
                    now,
                    location["uri"] if location else None,
                    row["fingerprint"],
                    now,
                    asset_id,
                ),
            )
        self._update_asset(
            asset_id,
            availability,
            fingerprint=fingerprint,
            size_bytes=path.stat().st_size,
            modified_at=modified_iso(path),
            media_info=media_info,
            now=now,
        )
        return self.get_asset(asset_id)  # type: ignore[return-value]

    async def _media_info(self, path: Path, kind: str) -> dict[str, Any] | None:
        if kind == "text":
            try:
                path.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise DomainError("ASSET_UNSUPPORTED", "文本素材必须为 UTF-8 编码") from exc
            return {"format_name": path.suffix.lower().lstrip("."), "duration_us": 0}
        if kind == "image":
            return {"format_name": path.suffix.lower().lstrip("."), "duration_us": 0}
        try:
            result = await self.probe(path, require_video=kind == "video")
        except TypeError:
            result = await self.probe(path)
        except RuntimeError as exc:
            raise DomainError(str(exc), "媒体文件探测失败") from exc
        return result

    def _update_asset(self, asset_id: str, availability: str, **fields: Any) -> None:
        assignments = ["availability=?", "updated_at=?"]
        values: list[Any] = [availability, fields.pop("now", utc_now())]
        if "fingerprint" in fields and fields["fingerprint"] is not None:
            assignments.append("fingerprint=?")
            values.append(fields["fingerprint"])
        if "size_bytes" in fields:
            assignments.append("size_bytes=?")
            values.append(fields["size_bytes"])
        if "modified_at" in fields:
            assignments.append("modified_at=?")
            values.append(fields["modified_at"])
        if "media_info" in fields:
            assignments.append("media_info_json=?")
            values.append(
                json_dumps(fields["media_info"]) if fields["media_info"] is not None else None
            )
        values.append(asset_id)
        with self.db.connection() as db:
            db.execute(f"UPDATE assets SET {','.join(assignments)} WHERE id=?", values)

    def _require_project(self, project_id: str) -> dict[str, Any]:
        row = self._require_project_row(project_id)
        return _project_dto(row)

    def _require_project_row(self, project_id: str) -> Any:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
        return row

    def _require_asset_row(self, asset_id: str) -> Any:
        with self.db.connection() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not row:
            raise DomainError("ASSET_NOT_FOUND", "素材不存在")
        return row

    def _location(self, asset_id: str) -> Any:
        with self.db.connection() as db:
            return db.execute(
                "SELECT * FROM asset_locations WHERE asset_id=?", (asset_id,)
            ).fetchone()

    def _remember_previous_fingerprint(self, asset_id: str, fingerprint: str) -> None:
        with self.db.connection() as db:
            db.execute(
                "UPDATE asset_locations SET previous_fingerprint=? WHERE asset_id=?",
                (fingerprint, asset_id),
            )

    def _mark_transcripts_stale(self, asset_id: str, fingerprint: str | None) -> None:
        if self.transcript_stale:
            self.transcript_stale(asset_id, fingerprint)


def _project_name(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 120 or not value.strip():
        raise DomainError("PROJECT_NAME_INVALID", "项目名称不合法，长度需为 1-120 个字符")
    return value


def _limit(value: int) -> int:
    if value < 1 or value > 100:
        raise DomainError("VALIDATION_ERROR", "limit 参数范围需为 1-100")
    return value


def _cursor_offset(value: str | None) -> int:
    if value is None:
        return 0
    try:
        offset = int(value)
    except ValueError as exc:
        raise DomainError("VALIDATION_ERROR", "cursor 参数不合法") from exc
    if offset < 0:
        raise DomainError("VALIDATION_ERROR", "cursor 参数不合法")
    return offset


def _project_dto(row: Any) -> dict[str, Any]:
    return {
        "project_id": row["id"],
        "name": row["name"],
        "status": row["status"],
        "canvas": json_loads(row["canvas_json"]),
        "root_dir_name": row["root_dir_name"],
        "current_timeline_revision_id": row["current_timeline_revision_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_opened_at": row["last_opened_at"],
    }


def _asset_dto(row: Any) -> dict[str, Any]:
    return {
        "asset_id": row["id"],
        "project_id": row["project_id"],
        "kind": row["kind"],
        "storage_mode": row["storage_mode"],
        "display_name": row["display_name"],
        "fingerprint": row["fingerprint"],
        "size_bytes": row["size_bytes"],
        "modified_at": row["modified_at"],
        "availability": row["availability"],
        "media_info": json_loads(row["media_info_json"]) if row["media_info_json"] else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _grant_path(grant: dict[str, Any]) -> Path:
    path_value = grant.get("path")
    if not path_value:
        raise DomainError("GRANT_NOT_FOUND", "文件授权不存在")
    path = Path(path_value)
    if not path.is_file():
        raise DomainError("MEDIA_NOT_FOUND", "媒体文件不存在")
    return path


def _path_from_uri(uri: str) -> Path:
    if not uri.startswith("file:"):
        return Path(uri)
    parsed = urlparse(uri)
    value = unquote(parsed.path)
    if parsed.netloc:
        value = f"//{parsed.netloc}{value}"
    elif len(value) >= 3 and value[0] == "/" and value[2] == ":":
        value = value[1:]
    return Path(value)


def _asset_kind(path: Path, requested_kind: str | None) -> str:
    suffix = path.suffix.lower()
    inferred = next(
        (kind for kind, extensions in SUPPORTED_EXTENSIONS.items() if suffix in extensions), None
    )
    if requested_kind is not None:
        if requested_kind not in ASSET_KINDS:
            raise DomainError("ASSET_UNSUPPORTED", "不支持的素材格式")
        if inferred is not None and inferred != requested_kind:
            raise DomainError("ASSET_UNSUPPORTED", "素材类型与文件格式不匹配")
        return requested_kind
    if inferred is None:
        raise DomainError("ASSET_UNSUPPORTED", "不支持的素材格式")
    return inferred
