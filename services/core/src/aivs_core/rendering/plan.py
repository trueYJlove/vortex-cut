from __future__ import annotations

import hashlib
import sqlite3
from typing import Any

from ..database import Database, json_dumps, json_loads
from ..projects import DomainError

COMPILER_VERSION = "render-plan-v1"
PRESET_VERSION = 1
FONT_BUNDLE_VERSION = 1
PROFILES = {
    "authoritative_preview": {
        "profile_id": "preview-portrait-v1",
        "width": 540,
        "height": 960,
        "fps_num": 30,
        "fps_den": 1,
        "video_codec": "h264",
        "audio_codec": "aac",
        "audio_sample_rate": 48000,
        "pixel_format": "yuv420p",
    },
    "final_export": {
        "profile_id": "export-portrait-v1",
        "width": 1080,
        "height": 1920,
        "fps_num": 30,
        "fps_den": 1,
        "video_codec": "h264",
        "audio_codec": "aac",
        "audio_sample_rate": 48000,
        "pixel_format": "yuv420p",
    },
}


class RenderPlanCompiler:
    def __init__(self, database: Database) -> None:
        self.database = database

    def compile(
        self,
        project_id: str,
        timeline_revision_id: str | None,
        mode: str,
        *,
        reject_draft: bool = False,
    ) -> dict[str, Any]:
        if mode not in PROFILES:
            raise DomainError("RENDER_PLAN_INVALID", "渲染模式不合法")
        with self.database.connection() as db:
            project = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if project is None:
                raise DomainError("PROJECT_NOT_FOUND", "项目不存在")
            if project["status"] == "archived":
                raise DomainError("RENDER_PLAN_INVALID", "归档项目不能渲染")
            revision_id = timeline_revision_id or project["current_timeline_revision_id"]
            if revision_id is None:
                raise DomainError("TIMELINE_NOT_FOUND", "项目尚未创建时间线")
            revision = db.execute(
                "SELECT * FROM timeline_revisions WHERE id=?", (revision_id,)
            ).fetchone()
            if revision is None:
                raise DomainError("TIMELINE_NOT_FOUND", "Timeline Revision 不存在")
            if revision["project_id"] != project_id:
                raise DomainError("RENDER_PLAN_INVALID", "Revision 不属于当前项目")
            if reject_draft:
                draft = db.execute(
                    "SELECT 1 FROM timeline_drafts WHERE project_id=?", (project_id,)
                ).fetchone()
                if draft is not None:
                    raise DomainError("RENDER_PLAN_INVALID", "存在未提交草稿，不能生成权威预览")
            document = json_loads(revision["document_json"])
            if not document.get("clips"):
                raise DomainError("TIMELINE_EMPTY", "空时间线不能渲染")
            return self._compile_document(db, revision_id, document, mode)

    def _compile_document(
        self,
        db: sqlite3.Connection,
        revision_id: str,
        document: dict[str, Any],
        mode: str,
    ) -> dict[str, Any]:
        inputs: list[dict[str, Any]] = []
        input_by_asset: dict[str, str] = {}
        segments: list[dict[str, Any]] = []
        for clip in document["clips"]:
            asset = db.execute("SELECT * FROM assets WHERE id=?", (clip["asset_id"],)).fetchone()
            if (
                asset is None
                or asset["project_id"] != document["project_id"]
                or asset["availability"] != "available"
                or asset["kind"] != clip["asset_kind"]
            ):
                raise DomainError("RENDER_INPUT_CHANGED", "Timeline 引用的素材不可用或已变化")
            media_info = json_loads(asset["media_info_json"]) if asset["media_info_json"] else {}
            input_id = input_by_asset.get(asset["id"])
            if input_id is None:
                input_id = f"I{len(inputs)}"
                input_by_asset[asset["id"]] = input_id
                inputs.append(
                    {
                        "input_id": input_id,
                        "asset_id": asset["id"],
                        "asset_kind": asset["kind"],
                        "fingerprint": asset["fingerprint"],
                        "duration_us": int(media_info.get("duration_us") or 0),
                        "has_audio": bool(media_info.get("audio_streams")),
                    }
                )
            segments.append(
                {
                    "clip_id": clip["clip_id"],
                    "input_id": input_id,
                    "asset_kind": clip["asset_kind"],
                    "source_start_us": clip["source_start_us"],
                    "source_end_us": clip["source_end_us"],
                    "timeline_start_us": clip["timeline_start_us"],
                    "timeline_end_us": clip["timeline_end_us"],
                    "layout": clip["layout"],
                    "audio_enabled": clip["audio"]["enabled"],
                    "gain_db": float(clip["audio"]["gain_db"]),
                }
            )
        caption_items = [
            {
                "caption_id": item["caption_id"],
                "source_clip_id": item["source_clip_id"],
                "start_us": item["start_us"],
                "end_us": item["end_us"],
                "text": item["text"],
                "preset_id": item["preset_id"],
                "origin": item["origin"],
                "edited": item["edited"],
                "source_segment_ids": item["source_segment_ids"],
            }
            for item in document["captions"]
        ]
        semantics = {
            "inputs": inputs,
            "segments": segments,
            "captions": caption_items,
            "canvas_background_color": document["canvas"]["background_color"],
            "preset_version": PRESET_VERSION,
            "font_bundle_version": FONT_BUNDLE_VERSION,
        }
        digest = hashlib.sha256(json_dumps(semantics).encode("utf-8")).hexdigest()
        return {
            "schema_version": 1,
            "compiler_version": COMPILER_VERSION,
            "timeline_revision_id": revision_id,
            "mode": mode,
            "content_fingerprint": f"sha256:{digest}",
            "inputs": inputs,
            "segments": segments,
            "captions": {
                "format": "ass",
                "preset_version": PRESET_VERSION,
                "font_bundle_version": FONT_BUNDLE_VERSION,
                "items": caption_items,
            },
            "output": dict(PROFILES[mode]),
        }


def content_semantics(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "inputs": plan["inputs"],
        "segments": plan["segments"],
        "captions": plan["captions"]["items"],
        "preset_version": plan["captions"]["preset_version"],
        "font_bundle_version": plan["captions"]["font_bundle_version"],
    }
