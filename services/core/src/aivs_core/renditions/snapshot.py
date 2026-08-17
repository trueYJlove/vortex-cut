from __future__ import annotations

from typing import Any

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError
from .presets import RenditionPresetRegistry, canonical_sha256

_LAYOUT_BY_POLICY = {
    "fit_all": "fit",
    "crop_fill_all": "crop_fill",
    "blurred_background_all": "blurred_background",
}


class RenditionSnapshotService:
    def __init__(self, database: Database, presets: RenditionPresetRegistry) -> None:
        self.database = database
        self.presets = presets

    def create_or_reuse(
        self,
        project_id: str,
        timeline_revision_id: str,
        platform_preset_id: str,
        rendition_preset_id: str,
        layout_policy: str,
    ) -> dict[str, Any]:
        if layout_policy not in {"preserve_timeline", *_LAYOUT_BY_POLICY}:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "布局策略不合法")
        platform = self.presets.platforms.get(platform_preset_id)
        rendition = self.presets.renditions.get(rendition_preset_id)
        if platform is None:
            raise DomainError("PLATFORM_PRESET_INVALID", "平台预设不存在")
        if rendition is None:
            raise DomainError("RENDITION_PRESET_INVALID", "画幅预设不存在")
        if rendition_preset_id not in platform["allowed_rendition_ids"]:
            raise DomainError("RENDITION_NOT_ALLOWED_FOR_PLATFORM", "该平台不允许此画幅")
        with self.database.connection() as db:
            project = db.execute("SELECT status FROM projects WHERE id=?", (project_id,)).fetchone()
            revision = db.execute(
                "SELECT * FROM timeline_revisions WHERE id=?", (timeline_revision_id,)
            ).fetchone()
            if project is None or revision is None or revision["project_id"] != project_id:
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "项目或 Revision 不匹配")
            if project["status"] == "archived":
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "归档项目不能创建输出快照")
            document = json_loads(revision["document_json"])
            segments = self._resolve_segments(document, layout_policy)
            warnings = self._warnings(document, rendition, layout_policy)
            style = self.presets.caption_style(rendition_preset_id)
            style_hash = canonical_sha256(style)
            snapshot = {
                "schema_version": 1,
                "project_id": project_id,
                "timeline_revision_id": timeline_revision_id,
                "timeline_document_sha256": revision["document_sha256"],
                "platform_preset_id": platform_preset_id,
                "platform_preset_version": platform["preset_version"],
                "platform_preset_sha256": platform["document_sha256"],
                "rendition_preset_id": rendition_preset_id,
                "rendition_preset_version": rendition["preset_version"],
                "rendition_preset_sha256": rendition["document_sha256"],
                "layout_policy": layout_policy,
                "resolved_segments": segments,
                "caption_style_version": self.presets.caption_styles["caption_style_version"],
                "caption_style_sha256": style_hash,
                "preview_profile": rendition["preview_profile"],
                "export_profile": rendition["export_profile"],
                "warnings": warnings,
            }
            snapshot_hash = canonical_sha256(snapshot)
            row = db.execute(
                "SELECT id FROM rendition_snapshots WHERE project_id=? AND timeline_revision_id=? "
                "AND timeline_document_sha256=? AND platform_preset_id=? AND platform_preset_sha256=? "  # noqa: E501
                "AND rendition_preset_id=? AND rendition_preset_sha256=? AND layout_policy=? AND snapshot_sha256=?",  # noqa: E501
                (
                    project_id,
                    timeline_revision_id,
                    revision["document_sha256"],
                    platform_preset_id,
                    platform["document_sha256"],
                    rendition_preset_id,
                    rendition["document_sha256"],
                    layout_policy,
                    snapshot_hash,
                ),
            ).fetchone()
            if row:
                return self.summary(row["id"])
            snapshot_id = f"rendition_snapshot_{new_id()}"
            snapshot["rendition_snapshot_id"] = snapshot_id
            db.execute(
                "INSERT INTO rendition_snapshots(id,project_id,timeline_revision_id,timeline_document_sha256,"  # noqa: E501
                "platform_preset_id,platform_preset_version,platform_preset_sha256,rendition_preset_id,"
                "rendition_preset_version,rendition_preset_sha256,layout_policy,snapshot_json,snapshot_sha256,"
                "warnings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    snapshot_id,
                    project_id,
                    timeline_revision_id,
                    revision["document_sha256"],
                    platform_preset_id,
                    platform["preset_version"],
                    platform["document_sha256"],
                    rendition_preset_id,
                    rendition["preset_version"],
                    rendition["document_sha256"],
                    layout_policy,
                    json_dumps(snapshot),
                    snapshot_hash,
                    json_dumps(warnings),
                    utc_now(),
                ),
            )
        return self.summary(snapshot_id)

    def get(self, snapshot_id: str) -> dict[str, Any]:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT * FROM rendition_snapshots WHERE id=?", (snapshot_id,)
            ).fetchone()
        if row is None:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照不存在")
        snapshot = json_loads(row["snapshot_json"])
        if (
            canonical_sha256(
                {key: value for key, value in snapshot.items() if key != "rendition_snapshot_id"}
            )
            != row["snapshot_sha256"]
        ):
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照校验失败")
        return snapshot

    def summary(self, snapshot_id: str) -> dict[str, Any]:
        snapshot = self.get(snapshot_id)
        with self.database.connection() as db:
            row = db.execute(
                "SELECT snapshot_sha256,created_at FROM rendition_snapshots WHERE id=?",
                (snapshot_id,),
            ).fetchone()
        if row is None:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照不存在")
        return {
            key: snapshot[key]
            for key in (
                "rendition_snapshot_id",
                "project_id",
                "timeline_revision_id",
                "platform_preset_id",
                "rendition_preset_id",
                "layout_policy",
                "warnings",
            )
        } | {"snapshot_sha256": row["snapshot_sha256"], "created_at": row["created_at"]}

    @staticmethod
    def _resolve_segments(document: dict[str, Any], policy: str) -> list[dict[str, str]]:
        clips = document.get("clips")
        if not isinstance(clips, list) or not clips:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "空 Timeline 不能创建输出快照")
        result: list[dict[str, str]] = []
        for clip in clips:
            layout = (
                clip.get("layout") if policy == "preserve_timeline" else _LAYOUT_BY_POLICY[policy]
            )
            if layout not in {"fit", "crop_fill", "blurred_background"} or not isinstance(
                clip.get("clip_id"), str
            ):
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "Timeline 布局不合法")
            result.append({"clip_id": clip["clip_id"], "layout": layout})
        return result

    @staticmethod
    def _warnings(document: dict[str, Any], rendition: dict[str, Any], policy: str) -> list[str]:
        if policy == "crop_fill_all":
            return ["CENTER_CROP_MAY_HIDE_CONTENT"]
        if policy == "fit_all":
            ratio = rendition["aspect_ratio"]
            return ["LETTERBOX_EXPECTED" if ratio == "16:9" else "PILLARBOX_EXPECTED"]
        return []
