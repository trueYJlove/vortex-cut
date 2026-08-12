from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from ..database import Database, json_dumps, json_loads, sha256_file, utc_now
from ..ids import new_id
from ..jobs import JobService
from ..media.encoders import EncoderDetector
from ..media.ffprobe import FFprobe
from ..media.process import run_process
from ..projects import DomainError, ProjectAssetService
from .ass import CaptionResources, build_ass
from .ffmpeg import build_timeline_args, run_timeline_render
from .plan import COMPILER_VERSION, RenderPlanCompiler
from .validation import validate_rendered_media

logger = logging.getLogger(__name__)


class JobRow(Protocol):
    def __getitem__(self, key: str) -> Any: ...


class DestinationGrantStore:
    def __init__(self) -> None:
        self._grants: dict[str, dict[str, Any]] = {}

    def create(self, path_value: Any, overwrite_authorized: Any) -> dict[str, Any]:
        if not isinstance(path_value, str) or not isinstance(overwrite_authorized, bool):
            raise DomainError("EXPORT_DESTINATION_INVALID", "导出目标参数不合法")
        path = Path(path_value).expanduser()
        if not path.is_absolute() or path.suffix.lower() != ".mp4":
            raise DomainError("EXPORT_DESTINATION_INVALID", "导出目标必须是绝对 MP4 路径")
        try:
            parent = path.parent.resolve(strict=True)
        except OSError as exc:
            raise DomainError("EXPORT_DESTINATION_INVALID", "导出目标父目录不存在") from exc
        if not parent.is_dir() or not os.access(parent, os.W_OK):
            raise DomainError("EXPORT_DESTINATION_INVALID", "导出目标父目录不可写")
        target = parent / path.name
        if target.exists():
            if not target.is_file():
                raise DomainError("EXPORT_DESTINATION_INVALID", "导出目标不是普通文件")
            if not overwrite_authorized:
                raise DomainError("EXPORT_DESTINATION_EXISTS", "导出目标已存在")
        expires_at = (
            (datetime.now(UTC) + timedelta(hours=1))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        grant_id = f"destination_{new_id()}"
        grant = {
            "destination_grant_id": grant_id,
            "display_name": target.name,
            "extension": ".mp4",
            "overwrite_authorized": overwrite_authorized,
            "expires_at": expires_at,
            "path": target,
            "claimed_by": None,
        }
        self._grants[grant_id] = grant
        return self.safe_dto(grant)

    def claim(self, grant_id: str, job_id: str) -> None:
        grant = self._require(grant_id)
        if grant["claimed_by"] is not None:
            raise DomainError("EXPORT_DESTINATION_EXPIRED", "导出授权已被消费")
        grant["claimed_by"] = job_id

    def inspect(self, grant_id: str) -> dict[str, Any]:
        grant = self._require(grant_id)
        if grant["claimed_by"] is not None:
            raise DomainError("EXPORT_DESTINATION_EXPIRED", "导出授权已被消费")
        return grant

    def resolve(self, grant_id: str, job_id: str) -> dict[str, Any]:
        grant = self._require(grant_id)
        if grant["claimed_by"] != job_id:
            raise DomainError("EXPORT_DESTINATION_EXPIRED", "导出授权不可用于当前任务")
        return grant

    def release(self, grant_id: str, job_id: str) -> None:
        grant = self._grants.get(grant_id)
        if grant and grant["claimed_by"] == job_id:
            grant["claimed_by"] = None

    def _require(self, grant_id: str) -> dict[str, Any]:
        grant = self._grants.get(grant_id)
        if grant is None or grant["expires_at"] <= utc_now():
            self._grants.pop(grant_id, None)
            raise DomainError("EXPORT_DESTINATION_EXPIRED", "导出授权不存在或已过期")
        return grant

    @staticmethod
    def safe_dto(grant: dict[str, Any]) -> dict[str, Any]:
        return {
            "destination_grant_id": grant["destination_grant_id"],
            "display_name": grant["display_name"],
            "extension": grant["extension"],
            "overwrite_authorized": grant["overwrite_authorized"],
            "expires_at": grant["expires_at"],
        }


class RenderCoordinator:
    def __init__(
        self,
        database: Database,
        data_dir: Path,
        ffmpeg: Path,
        ffprobe: FFprobe,
        projects: ProjectAssetService,
        compiler: RenderPlanCompiler,
        caption_resources: CaptionResources,
        destinations: DestinationGrantStore,
    ) -> None:
        self.database = database
        self.data_dir = data_dir
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.projects = projects
        self.compiler = compiler
        self.caption_resources = caption_resources
        self.destinations = destinations

    def cleanup_orphans(self) -> None:
        with self.database.connection() as db:
            rows = db.execute(
                "SELECT id,status,input_json FROM jobs WHERE kind='final_export' "
                "AND status IN ('failed','cancelled','interrupted')"
            ).fetchall()
        for row in rows:
            try:
                payload = json_loads(row["input_json"])
            except (TypeError, ValueError):
                logger.warning("Skipping invalid render cleanup payload for job %s", row["id"])
                continue
            destination = payload.get("destination_path")
            if isinstance(destination, str):
                target = Path(destination)
                temporary = target.parent / f".{target.stem}.{row['id']}.aivs-tmp.mp4"
                self._unlink_orphan(temporary, row["id"])
            shutil.rmtree(self.data_dir / "jobs" / row["id"] / "work", ignore_errors=True)

    @staticmethod
    def _unlink_orphan(path: Path, job_id: str) -> None:
        for attempt in range(4):
            try:
                path.unlink(missing_ok=True)
                return
            except OSError as exc:
                if attempt == 3:
                    logger.warning(
                        "Deferred locked render cleanup for job %s at %s: %s",
                        job_id,
                        path,
                        exc,
                    )
                    return
                time.sleep(0.1 * (2**attempt))

    async def run(
        self,
        row: JobRow,
        cancel_event: asyncio.Event,
        progress: Any,
        stage: Any,
        worker_pid: Any,
    ) -> dict[str, Any]:
        payload = json_loads(row["input_json"])
        mode = row["kind"]
        job_id = row["id"]
        stage("compiling")
        plan = self.compiler.compile(
            row["project_id"], row["timeline_revision_id"], mode
        )
        if plan["content_fingerprint"] != payload["content_fingerprint"]:
            raise DomainError("RENDER_INPUT_CHANGED", "渲染输入在排队后已变化")
        stage("preparing")
        input_paths = {
            item["input_id"]: Path(self.projects.resolve_asset_path(item["asset_id"])["path"])
            for item in plan["inputs"]
        }
        segment_paths = [input_paths[item["input_id"]] for item in plan["segments"]]
        segment_probes = [await self.ffprobe.probe(path) for path in segment_paths]
        bundle, presets, font_path = self.caption_resources.load()
        work = self.data_dir / "jobs" / job_id / "work"
        artifact_dir = self.data_dir / "jobs" / job_id / "artifacts"
        work.mkdir(parents=True, exist_ok=True)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        fonts = work / "fonts"
        fonts.mkdir(exist_ok=True)
        shutil.copy2(font_path, fonts / font_path.name)
        (work / "captions.ass").write_text(
            build_ass(plan["captions"]["items"], bundle, presets), encoding="utf-8-sig"
        )
        destination_grant = None
        if mode == "final_export":
            destination_grant = self.destinations.resolve(
                payload["destination_grant_id"], job_id
            )
            target = Path(destination_grant["path"])
            if target.exists() and not destination_grant["overwrite_authorized"]:
                raise DomainError("EXPORT_DESTINATION_EXISTS", "导出目标已存在")
            output = target.parent / f".{target.stem}.{job_id}.aivs-tmp.mp4"
        else:
            output = work / "authoritative-preview.mp4"
        args = build_timeline_args(
            plan,
            segment_paths,
            segment_probes,
            row["encoder_requested"],
            str(output),
            captions=bool(plan["captions"]["items"]),
        )
        expected_duration = plan["segments"][-1]["timeline_end_us"]
        attempts = 2 if mode == "authoritative_preview" else 1
        try:
            for attempt in range(1, attempts + 1):
                try:
                    if attempt > 1:
                        self._set_attempt(job_id, attempt)
                    stage("rendering")
                    await run_timeline_render(
                        self.ffmpeg,
                        args,
                        work,
                        expected_duration,
                        cancel_event,
                        progress,
                        worker_pid,
                    )
                    stage("validating")
                    media_info, size_bytes, digest = await validate_rendered_media(
                        self.ffmpeg,
                        self.ffprobe,
                        output,
                        plan["output"],
                        expected_duration,
                    )
                    break
                except DomainError as exc:
                    if attempt == attempts or exc.code not in {
                        "RENDER_FAILED",
                        "RENDER_VALIDATION_FAILED",
                    }:
                        raise
                    output.unlink(missing_ok=True)
                except RuntimeError as exc:
                    if attempt == attempts or str(exc).startswith("JOB_CANCELLED"):
                        raise
                    output.unlink(missing_ok=True)
            if cancel_event.is_set():
                raise RuntimeError("JOB_CANCELLED")
            stage("finalizing")
            artifact_id = f"artifact_{new_id()}"
            export_record_id = None
            if mode == "authoritative_preview":
                final_path = artifact_dir / "authoritative-preview.mp4"
                os.replace(output, final_path)
                display_name = final_path.name
            else:
                assert destination_grant is not None
                final_path = Path(destination_grant["path"])
                os.replace(output, final_path)
                display_name = destination_grant["display_name"]
                export_record_id = f"export_{new_id()}"
            toolchain = payload["toolchain"]
            now = utc_now()
            with self.database.connection() as db:
                db.execute("BEGIN")
                try:
                    db.execute(
                        "INSERT INTO artifacts(id,job_id,kind,path,size_bytes,sha256,"
                        "media_info_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                        (
                            artifact_id,
                            job_id,
                            mode,
                            str(final_path),
                            size_bytes,
                            digest,
                            json_dumps(media_info),
                            now,
                        ),
                    )
                    db.execute(
                        "INSERT INTO render_artifacts(artifact_id,project_id,"
                        "timeline_revision_id,kind,render_plan_json,content_fingerprint,"
                        "profile_id,toolchain_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            artifact_id,
                            row["project_id"],
                            row["timeline_revision_id"],
                            mode,
                            json_dumps(plan),
                            plan["content_fingerprint"],
                            plan["output"]["profile_id"],
                            json_dumps(toolchain),
                            now,
                        ),
                    )
                    if export_record_id is not None:
                        db.execute(
                            "INSERT INTO export_records(id,project_id,timeline_revision_id,"
                            "artifact_id,profile_id,destination_uri,destination_display_name,"
                            "created_at) VALUES (?,?,?,?,?,?,?,?)",
                            (
                                export_record_id,
                                row["project_id"],
                                row["timeline_revision_id"],
                                artifact_id,
                                plan["output"]["profile_id"],
                                final_path.as_uri(),
                                display_name,
                                now,
                            ),
                        )
                    db.execute("COMMIT")
                except Exception:
                    db.execute("ROLLBACK")
                    raise
            result = {"render_artifact_id": artifact_id}
            if export_record_id is not None:
                result["export_record_id"] = export_record_id
            return result
        finally:
            output.unlink(missing_ok=True)

    def _set_attempt(self, job_id: str, attempt: int) -> None:
        with self.database.connection() as db:
            db.execute(
                "UPDATE jobs SET attempt=?,updated_at=? WHERE id=?",
                (attempt, utc_now(), job_id),
            )


class RenderService:
    def __init__(
        self,
        database: Database,
        ffmpeg: Path,
        encoders: EncoderDetector,
        compiler: RenderPlanCompiler,
        jobs: JobService,
        destinations: DestinationGrantStore,
    ) -> None:
        self.database = database
        self.ffmpeg = ffmpeg
        self.encoders = encoders
        self.compiler = compiler
        self.jobs = jobs
        self.destinations = destinations

    async def create_preview(
        self, project_id: str, timeline_revision_id: str | None, encoder_mode: str
    ) -> dict[str, Any]:
        encoder_mode = _encoder_mode(encoder_mode)
        plan = self.compiler.compile(
            project_id,
            timeline_revision_id,
            "authoritative_preview",
            reject_draft=True,
        )
        encoder, fallback = await self.encoders.choose(encoder_mode)
        toolchain = await self._toolchain(encoder, fallback)
        reused = self._reusable_preview(plan, toolchain)
        if reused is not None:
            return {"job": None, "preview": reused, "reused": True}
        job = self.jobs.create_render(
            "authoritative_preview",
            project_id,
            plan["timeline_revision_id"],
            encoder,
            {
                "content_fingerprint": plan["content_fingerprint"],
                "toolchain": toolchain,
            },
        )
        return {"job": job, "preview": None, "reused": False}

    async def create_export(
        self,
        project_id: str,
        timeline_revision_id: str | None,
        destination_grant_id: str,
        encoder_mode: str,
    ) -> dict[str, Any]:
        encoder_mode = _encoder_mode(encoder_mode)
        plan = self.compiler.compile(project_id, timeline_revision_id, "final_export")
        encoder, fallback = await self.encoders.choose(encoder_mode)
        toolchain = await self._toolchain(encoder, fallback)
        grant = self.destinations.inspect(destination_grant_id)
        required_bytes = max(
            64 * 1024 * 1024,
            (plan["segments"][-1]["timeline_end_us"] // 1_000_000 + 1) * 2 * 1024 * 1024,
        )
        if shutil.disk_usage(Path(grant["path"]).parent).free < required_bytes:
            raise DomainError("EXPORT_DISK_SPACE_INSUFFICIENT", "导出目标磁盘空间不足")
        job = self.jobs.create_render(
            "final_export",
            project_id,
            plan["timeline_revision_id"],
            encoder,
            {
                "content_fingerprint": plan["content_fingerprint"],
                "toolchain": toolchain,
                "destination_grant_id": destination_grant_id,
                "destination_path": str(grant["path"]),
            },
        )
        try:
            self.destinations.claim(destination_grant_id, job["job_id"])
        except Exception:
            self.jobs.delete_queued(job["job_id"])
            raise
        return {"job": job, "export_record": None}

    def list_previews(
        self, project_id: str, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        return self._list_artifacts(project_id, "authoritative_preview", limit, cursor)

    def current_preview(self, project_id: str) -> dict[str, Any] | None:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT ra.artifact_id FROM projects p JOIN render_artifacts ra "
                "ON ra.project_id=p.id AND ra.timeline_revision_id="
                "p.current_timeline_revision_id JOIN artifacts a "
                "ON a.id=ra.artifact_id JOIN jobs j ON j.id=a.job_id "
                "WHERE p.id=? AND ra.kind='authoritative_preview' "
                "AND j.status='succeeded' ORDER BY ra.created_at DESC,"
                "ra.artifact_id DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        if row is None:
            return None
        preview = self.artifact_dto(row["artifact_id"])
        return preview if preview["status"] == "ready" else None

    def list_exports(
        self, project_id: str, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        limit, offset = _page(limit, cursor)
        with self.database.connection() as db:
            rows = db.execute(
                "SELECT e.id FROM export_records e WHERE e.project_id=? "
                "ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?",
                (project_id, limit, offset),
            ).fetchall()
        items = [self.export_dto(row[0]) for row in rows]
        return items, str(offset + len(items)) if len(items) == limit else None

    def artifact_dto(self, artifact_id: str) -> dict[str, Any]:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT ra.*,a.path,a.size_bytes,a.sha256,a.media_info_json,j.encoder_used,"
                "j.fallback_reason,p.current_timeline_revision_id FROM render_artifacts ra "
                "JOIN artifacts a ON a.id=ra.artifact_id JOIN jobs j ON j.id=a.job_id "
                "JOIN projects p ON p.id=ra.project_id WHERE ra.artifact_id=?",
                (artifact_id,),
            ).fetchone()
        if row is None:
            raise DomainError("ARTIFACT_NOT_FOUND", "渲染产物不存在")
        status = (
            "stale"
            if row["timeline_revision_id"] != row["current_timeline_revision_id"]
            else "ready"
        )
        return {
            "render_artifact_id": row["artifact_id"],
            "project_id": row["project_id"],
            "timeline_revision_id": row["timeline_revision_id"],
            "kind": row["kind"],
            "status": status,
            "content_fingerprint": row["content_fingerprint"],
            "profile_id": row["profile_id"],
            "display_name": Path(row["path"]).name,
            "size_bytes": row["size_bytes"],
            "sha256": row["sha256"],
            "media_info": json_loads(row["media_info_json"]),
            "encoder": row["encoder_used"],
            "fallback_reason": row["fallback_reason"],
            "created_at": row["created_at"],
        }

    def export_dto(self, export_record_id: str) -> dict[str, Any]:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT e.*,a.size_bytes,a.sha256,a.media_info_json,a.path,j.encoder_used,"
                "j.fallback_reason FROM export_records e JOIN artifacts a ON a.id=e.artifact_id "
                "JOIN jobs j ON j.id=a.job_id WHERE e.id=?",
                (export_record_id,),
            ).fetchone()
        if row is None:
            raise DomainError("EXPORT_NOT_FOUND", "导出记录不存在")
        return {
            "export_record_id": row["id"],
            "project_id": row["project_id"],
            "timeline_revision_id": row["timeline_revision_id"],
            "render_artifact_id": row["artifact_id"],
            "status": "succeeded" if Path(row["path"]).is_file() else "missing",
            "profile_id": row["profile_id"],
            "destination_display_name": row["destination_display_name"],
            "size_bytes": row["size_bytes"],
            "sha256": row["sha256"],
            "media_info": json_loads(row["media_info_json"]),
            "encoder": row["encoder_used"],
            "fallback_reason": row["fallback_reason"],
            "created_at": row["created_at"],
        }

    def resolve_artifact(self, artifact_id: str) -> dict[str, str]:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT path,sha256 FROM artifacts WHERE id=?", (artifact_id,)
            ).fetchone()
        if row is None:
            raise DomainError("ARTIFACT_NOT_FOUND", "渲染产物不存在")
        path = Path(row["path"])
        if not path.is_file() or sha256_file(path) != row["sha256"]:
            raise DomainError("ARTIFACT_NOT_FOUND", "渲染产物不存在或已损坏")
        return {"artifact_id": artifact_id, "path": str(path.resolve())}

    def _list_artifacts(
        self, project_id: str, kind: str, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        limit, offset = _page(limit, cursor)
        with self.database.connection() as db:
            rows = db.execute(
                "SELECT artifact_id FROM render_artifacts WHERE project_id=? AND kind=? "
                "ORDER BY created_at DESC,artifact_id DESC LIMIT ? OFFSET ?",
                (project_id, kind, limit, offset),
            ).fetchall()
        items = [self.artifact_dto(row[0]) for row in rows]
        return items, str(offset + len(items)) if len(items) == limit else None

    def _reusable_preview(
        self, plan: dict[str, Any], toolchain: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self.database.connection() as db:
            rows = db.execute(
                "SELECT ra.artifact_id,a.path,a.sha256 FROM render_artifacts ra "
                "JOIN artifacts a ON a.id=ra.artifact_id WHERE ra.timeline_revision_id=? "
                "AND ra.kind='authoritative_preview' AND ra.content_fingerprint=? "
                "AND ra.profile_id=? AND ra.toolchain_json=? ORDER BY ra.created_at DESC",
                (
                    plan["timeline_revision_id"],
                    plan["content_fingerprint"],
                    plan["output"]["profile_id"],
                    json_dumps(toolchain),
                ),
            ).fetchall()
        for row in rows:
            path = Path(row["path"])
            if path.is_file() and sha256_file(path) == row["sha256"]:
                return self.artifact_dto(row["artifact_id"])
        return None

    async def _toolchain(self, encoder: str, fallback: str | None) -> dict[str, Any]:
        result = await run_process(self.ffmpeg, ["-hide_banner", "-version"], 10)
        if result.returncode != 0 or not result.stdout:
            raise DomainError("RENDER_FAILED", "无法读取 FFmpeg 版本")
        return {
            "compiler_version": COMPILER_VERSION,
            "preset_version": 1,
            "font_bundle_version": 1,
            "ffmpeg_version": result.stdout.splitlines()[0],
            "encoder": encoder,
            "fallback_reason": fallback,
        }


def _encoder_mode(value: str) -> str:
    if value not in {"auto", "software"}:
        raise DomainError("RENDER_PLAN_INVALID", "编码器模式不合法")
    return value


def _page(limit: int, cursor: str | None) -> tuple[int, int]:
    if not 1 <= limit <= 100:
        raise DomainError("RENDER_PLAN_INVALID", "limit 参数范围需为 1-100")
    if cursor is None:
        return limit, 0
    if not cursor.isdigit():
        raise DomainError("RENDER_PLAN_INVALID", "cursor 参数不合法")
    return limit, int(cursor)
