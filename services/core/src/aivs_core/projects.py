from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .background_work import AssetChangedError, hashed_fingerprint
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
        purge_asset_clips: Callable[[sqlite3.Connection, str], dict[str, int]] | None = None,
        transcript_revalidate: Callable[[str, str], None] | None = None,
        detach_keyframe_previews: Callable[[sqlite3.Connection, str], int] | None = None,
    ) -> None:
        self.db = db
        self.data_dir = data_dir
        self.probe = probe
        self.transcript_stale = transcript_stale
        self.purge_asset_clips = purge_asset_clips
        self.transcript_revalidate = transcript_revalidate
        self.detach_keyframe_previews = detach_keyframe_previews

    _DEFAULT_CANVAS = {"width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1}

    @staticmethod
    def _validate_canvas(canvas: dict[str, Any] | None) -> dict[str, Any]:
        """新建项目画布（可选）：宽高为偶数且在合理范围，帧率 1..120。
        未提供时回退默认竖屏 1080x1920@30（历史项目同款）。"""
        if not canvas:
            return dict(ProjectAssetService._DEFAULT_CANVAS)
        if not isinstance(canvas, dict):
            raise DomainError("PROJECT_CANVAS_INVALID", "画布参数无效")
        try:
            width = int(canvas["width"])
            height = int(canvas["height"])
        except (KeyError, TypeError, ValueError):
            raise DomainError("PROJECT_CANVAS_INVALID", "画布宽高无效") from None
        try:
            fps_num = int(canvas.get("fps_num", 30))
            fps_den = int(canvas.get("fps_den", 1))
        except (TypeError, ValueError):
            raise DomainError("PROJECT_CANVAS_INVALID", "画布帧率无效") from None
        if not (64 <= width <= 7680 and width % 2 == 0 and 64 <= height <= 7680 and height % 2 == 0):
            raise DomainError("PROJECT_CANVAS_INVALID", "画布宽高需为 64..7680 的偶数")
        fps = fps_num / fps_den if fps_den > 0 else 0
        if fps_den <= 0 or not (1 <= fps <= 120):
            raise DomainError("PROJECT_CANVAS_INVALID", "画布帧率需在 1..120")
        return {"width": width, "height": height, "fps_num": fps_num, "fps_den": fps_den}

    def create_project(self, name: str, root_dir_name: str | None = None,
                       canvas: dict[str, Any] | None = None) -> dict[str, Any]:
        project_name = _project_name(name)
        root_name = _project_name(root_dir_name or project_name)
        canvas_value = self._validate_canvas(canvas)
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
                    json_dumps(canvas_value),
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
        # A05a：大文件哈希走后台线程池（事件循环不阻塞；stat 前后比对）
        fingerprint = await self._hash(path)
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

    def insert_generated_image_in_transaction(
        self,
        db: Any,
        project_id: str,
        asset_id: str,
        path: Path,
        fingerprint: str,
        media_info: dict[str, Any],
        display_name: str,
        now: str,
    ) -> dict[str, Any]:
        """Narrow capability used only after Stage 4D validated and published an image."""
        project = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project:
            raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
        if project["status"] != "active":
            raise DomainError("PROJECT_ARCHIVED", "项目不可写入生成素材")
        root = Path(project["root_dir"]).resolve()
        resolved = path.resolve()
        if resolved.parent != (root / "generated" / "image").resolve() or not resolved.is_file():
            raise DomainError("GENERATED_ASSET_REGISTER_FAILED", "生成素材路径无效")
        if db.execute(
            "SELECT 1 FROM assets WHERE project_id=? AND fingerprint=?",
            (project_id, fingerprint),
        ).fetchone():
            raise DomainError("GENERATED_ASSET_DUPLICATE", "生成图片与已有素材重复")
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id,
                project_id,
                "image",
                "managed",
                display_name,
                fingerprint,
                path.stat().st_size,
                modified_iso(path),
                "available",
                json_dumps(media_info),
                now,
                now,
            ),
        )
        db.execute(
            "INSERT INTO asset_locations(asset_id,uri,last_verified_at) VALUES (?,?,?)",
            (asset_id, path.as_uri(), now),
        )
        row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return _asset_dto(row)
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
            fingerprint = await self._hash(path)
            # 「内容回退到上一版」是合法状态：接受集与 relocate_asset 同口径
            # （当前指纹 ∪ previous_fingerprint）。否则一次外部修改会让素材永久停在
            # changed——refresh 会把新指纹写成基准，改回原样也无法自证（2026-10-10
            # 真机观察：还原文件后 availability 仍为 changed，且 Core 对任何
            # TimelinePatch fail-closed）。回退时把基准指回当前内容，并把该指纹
            # 对应的转录从 stale 恢复为 ready（内容逐字节相同，转录仍然有效）。
            accepted = {row["fingerprint"]}
            previous = location["previous_fingerprint"] if location else None
            if previous:
                accepted.add(previous)
            reverted = fingerprint != row["fingerprint"] and fingerprint in accepted
            if fingerprint not in accepted:
                self._remember_previous_fingerprint(asset_id, row["fingerprint"])
                self._mark_transcripts_stale(asset_id, fingerprint)
            elif reverted:
                self._remember_previous_fingerprint(asset_id, row["fingerprint"])
                self._revalidate_transcripts(asset_id, fingerprint)
            media_info = await self._media_info(path, row["kind"])
            availability = "available" if fingerprint in accepted else "changed"
        except DomainError:
            fingerprint = row["fingerprint"]
            media_info = None
            availability = "unsupported"
        self._update_asset(
            asset_id,
            availability,
            fingerprint=fingerprint if (availability == "changed" or reverted) else None,
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

    def delete_asset(self, asset_id: str, *, remove_timeline_clips: bool = False) -> dict[str, int]:
        """删除素材（硬删 assets 行，级联清理 locations/transcripts 等从表）。

        时间线 Clip 以 document_json 形式存于 timeline_revisions（无外键）：
        - remove_timeline_clips=False：任一 Revision 仍引用该素材时拒绝删除
          （ASSET_IN_USE），提示先从时间线移除相关片段；
        - remove_timeline_clips=True：级联删除所有 Revision/草稿中的相关片段
          （字幕、转场一并清理），随后删除素材行，返回清理计数。

        transcripts 表对 assets 无级联外键，删除前先手工清理转录数据；
        其余从表（asset_locations 等）由 ON DELETE CASCADE 处理。
        """
        self._require_asset_row(asset_id)
        # W2.1（Planning Gate §2.1 C3①）：机位组引用走显式拒绝——否则会撞 FK 后落到
        # 「素材被镜头需求或生成记录引用」这种与机位无关的误导文案。机位组一旦引用素材
        # 就锁住它，用户需先删除机位组（DELETE /angle-groups/{id}，元数据随组 CASCADE）。
        with self.db.connection() as db:
            angle_used = db.execute(
                "SELECT COUNT(*) AS n FROM angle_groups WHERE reference_asset_id=?",
                (asset_id,),
            ).fetchone()["n"]
            angle_member = db.execute(
                "SELECT COUNT(*) AS n FROM angle_syncs WHERE asset_id=?", (asset_id,)
            ).fetchone()["n"]
            group_member = db.execute(
                "SELECT COUNT(*) AS n FROM angle_groups WHERE members_json LIKE ?",
                ("%" + asset_id + "%",),
            ).fetchone()["n"]
        if angle_used or angle_member or group_member:
            raise DomainError(
                "ASSET_IN_USE",
                "素材被机位组引用，请先删除相关机位组后再删除素材",
            )
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
                used = db.execute(
                    """
                    SELECT COUNT(*) AS n
                    FROM timeline_revisions tr, json_each(tr.document_json, '$.clips')
                    WHERE json_extract(json_each.value, '$.asset_id') = ?
                    """,
                    (asset_id,),
                ).fetchone()
                clip_count = used["n"] if used else 0
                if clip_count and not remove_timeline_clips:
                    raise DomainError(
                        "ASSET_IN_USE",
                        "素材仍被时间线片段引用，请先移除相关片段后再删除",
                    )
                counts = {"removed_clips": 0, "removed_captions": 0}
                if clip_count and self.purge_asset_clips:
                    counts = dict(self.purge_asset_clips(db, asset_id))
                # transcripts/segments/words 无级联外键，先手工清理。
                db.execute(
                    "DELETE FROM transcript_words WHERE segment_id IN ("
                    "SELECT s.id FROM transcript_segments s JOIN transcripts t ON t.id=s.transcript_id WHERE t.asset_id=?)",
                    (asset_id,),
                )
                db.execute(
                    "DELETE FROM transcript_segments WHERE transcript_id IN ("
                    "SELECT id FROM transcripts WHERE asset_id=?)",
                    (asset_id,),
                )
                db.execute("DELETE FROM transcripts WHERE asset_id=?", (asset_id,))
                # 派生分析数据（可重算）同样先手工清理。
                # 2026-10-11 复现的既有缺陷：beat_grids / cv_analyses 对 assets 是
                # ON DELETE **NO ACTION**，一旦存在分析行，下面的 DELETE 直接被 FK 拒绝，
                # 而上面的通用 except 会把它报成"素材被镜头需求或生成记录引用"——
                # **原因错且无出路**（用户跑过一次 CV 分析或节拍分析就永远删不掉素材）。
                # 这两张表是纯派生数据（删掉可重新分析），故与 transcripts 同口径清理。
                db.execute("DELETE FROM beat_grids WHERE asset_id=?", (asset_id,))
                # cv_analyses 还有子表 cv_samples（FK 同为 NO ACTION）⇒ 必须自下而上清，
                # 否则删分析行本身会被拒（这条是写测试时才暴露的：只清父表会撞 cv_samples）。
                db.execute(
                    "DELETE FROM cv_samples WHERE analysis_id IN ("
                    "SELECT id FROM cv_analyses WHERE asset_id=?)",
                    (asset_id,),
                )
                db.execute("DELETE FROM cv_analyses WHERE asset_id=?", (asset_id,))
                # 派生代理作业对 assets 是 NO ACTION（jobs.asset_id 由 v2 兼容迁移
                # ALTER 补列，database.py:1120）⇒ 不清就撞 FK，被下面通用 except 报成
                # 「素材被镜头需求或生成记录引用」——原因错且无出路。而**每次视频导入
                # 都会自动登记一条 kind='proxy' 作业**（preview_source.create_proxy_job），
                # 所以这不是边缘情况，是几乎所有素材都带（2026-10 用户事故实证）。
                # 只清 kind='proxy'：代理是可重算派生数据，与 beat_grids/cv_analyses 同口径；
                # 其余 kind（生成记录/导出/转录/模型下载等）仍由下面的 FK 拒绝保护。
                db.execute("DELETE FROM jobs WHERE asset_id=? AND kind='proxy'", (asset_id,))
                # 关键帧外传预览对 assets 是 NO ACTION：不先断开引用，下面的
                # DELETE 必被 FK 拒绝并被报成「素材被镜头需求或生成记录引用」
                # ——原因错且无出路（做过一次关键帧预览的素材永远删不掉，
                # 即 P102 原样重演）。预览行是**外传审计**，不能 CASCADE 掉，
                # 故只置空引用并留 detached_at。与 DELETE 同事务：半删状态下
                # 素材还在、预览还指向它，下次删除会再次被拒。
                if self.detach_keyframe_previews:
                    self.detach_keyframe_previews(db, asset_id)
                try:
                    db.execute("DELETE FROM assets WHERE id=?", (asset_id,))
                except sqlite3.IntegrityError as exc:
                    # 被 shot requirements / 生成记录等业务表引用时拒绝硬删，
                    # 保护 AI 流程的引用完整性（比级联破坏历史记录更安全）。
                    db.execute("ROLLBACK")
                    raise DomainError(
                        "ASSET_IN_USE",
                        "素材被镜头需求或生成记录引用，无法删除",
                    ) from exc
                db.execute("COMMIT")
                return counts
            except DomainError:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise
            except Exception:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise

    def asset_cache_identity(self, asset_id: str) -> tuple[str, str, int, int] | None:
        """A07：素材的缓存身份元组（fingerprint, path, size_bytes, mtime_ns）。

        只读数据库与轻量 stat——不哈希、不探测；供渲染/预览侧构造 probe 缓存键
        （fingerprint + stat 三元）。素材不可用（缺行/缺位置/文件不在）返回 None，
        调用方自行走真实探测与既有域错误路径。
        """
        try:
            row = self._require_asset_row(asset_id)
        except DomainError:
            return None
        location = self._location(asset_id)
        if not location:
            return None
        path = _path_from_uri(location["uri"])
        try:
            stat = path.stat()
        except OSError:
            return None
        return (
            str(row["fingerprint"] or ""),
            str(path),
            stat.st_size,
            stat.st_mtime_ns,
        )

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
            # 同步方法（sync 调用方 plan.py + async 端点混用）：保留同步哈希。
            # A05a 的后台化覆盖 async 入口（import/refresh/relocate）；此快速
            # 校验路径的阻塞搬移列入后续 API 层改造，不在本单强改签名。
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
            # 同步方法（rendering/service 预检路径）：保留同步哈希（同 current_source 注记）
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

    async def resolve_asset_path_async(self, asset_id: str) -> dict[str, str]:
        """异步入口：语义与 resolve_asset_path 逐位一致（含 stat 比对 + 指纹
        校验），但整体在线程池执行。同步版本在事件循环上做全文件 SHA-256，
        大素材/多素材投影时会把 accept 队列堵死（F04 100 素材复测实测：
        manifest 投影期间后续请求被 ECONNREFUSED）。"""
        return await asyncio.to_thread(self.resolve_asset_path, asset_id)

    async def relocate_asset(self, asset_id: str, grant: dict[str, Any]) -> dict[str, Any]:
        row = self._require_asset_row(asset_id)
        path = _grant_path(grant)
        fingerprint = await self._hash(path)
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

    async def _hash(self, path: Path) -> str:
        """A05a：素材哈希走后台线程池（受限队列 + stat 前后比对）。
        哈希期间 stat 变化 → ASSET_CHANGED（沿既有域错误语义）。"""
        try:
            return await hashed_fingerprint(path)
        except AssetChangedError as exc:
            raise DomainError("ASSET_CHANGED", "素材文件在哈希期间发生变化") from exc

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

    def _revalidate_transcripts(self, asset_id: str, fingerprint: str) -> None:
        if self.transcript_revalidate:
            self.transcript_revalidate(asset_id, fingerprint)


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
