from __future__ import annotations

import hashlib
import sqlite3
from typing import Any

from ..database import Database, json_dumps, json_loads
from ..projects import DomainError
from ..renditions.presets import canonical_sha256
from ..renditions.reframe import crop_window, display_geometry

COMPILER_VERSION = "render-plan-v1"
REFRAME_COMPILER_VERSION = "render-plan-reframe-v1"
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

# 前端"比例"下拉 → 渲染输出尺寸（权威预览 / 最终导出）。
# "fit" 表示跟随时间线默认（竖屏），由 PROFILES 兜底。
OUTPUT_RATIO_DIMENSIONS: dict[str, dict[str, tuple[int, int]]] = {
    "169": {"authoritative_preview": (960, 540), "final_export": (1920, 1080)},
    "916": {"authoritative_preview": (540, 960), "final_export": (1080, 1920)},
    "11": {"authoritative_preview": (720, 720), "final_export": (1440, 1440)},
    "43": {"authoritative_preview": (832, 624), "final_export": (1664, 1248)},
    "34": {"authoritative_preview": (624, 832), "final_export": (1248, 1664)},
}

RATIO_PROFILE_ID = {
    "authoritative_preview": "preview-{ratio}-v1",
    "final_export": "export-{ratio}-v1",
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
        output_ratio: str | None = None,
    ) -> dict[str, Any]:
        if mode not in PROFILES:
            raise DomainError("RENDER_PLAN_INVALID", "渲染模式不合法")
        if output_ratio not in (None, "fit") and output_ratio not in OUTPUT_RATIO_DIMENSIONS:
            raise DomainError("RENDER_PLAN_INVALID", "输出比例不合法")
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
            return self._compile_document(db, revision_id, document, mode, output_ratio)

    def compile_rendition(
        self,
        project_id: str,
        timeline_revision_id: str,
        rendition_snapshot_id: str,
        mode: str,
        *,
        reject_draft: bool = False,
    ) -> dict[str, Any]:
        """Compile a target-specific plan from an immutable Stage 3A snapshot."""
        if mode not in {"authoritative_preview", "final_export"}:
            raise DomainError("RENDITION_SNAPSHOT_INVALID", "渲染模式不合法")
        with self.database.connection() as db:
            project = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            revision = db.execute(
                "SELECT * FROM timeline_revisions WHERE id=?", (timeline_revision_id,)
            ).fetchone()
            snapshot_row = db.execute(
                "SELECT * FROM rendition_snapshots WHERE id=?", (rendition_snapshot_id,)
            ).fetchone()
            if (
                project is None
                or revision is None
                or snapshot_row is None
                or project["status"] == "archived"
            ):
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照引用不存在")
            if (
                revision["project_id"] != project_id
                or snapshot_row["project_id"] != project_id
                or snapshot_row["timeline_revision_id"] != timeline_revision_id
                or snapshot_row["timeline_document_sha256"] != revision["document_sha256"]
            ):
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照与 Timeline 不匹配")
            if (
                reject_draft
                and db.execute(
                    "SELECT 1 FROM timeline_drafts WHERE project_id=?", (project_id,)
                ).fetchone()
            ):
                raise DomainError("RENDER_PLAN_INVALID", "存在未提交草稿，不能生成权威预览")
            document = json_loads(revision["document_json"])
            snapshot = json_loads(snapshot_row["snapshot_json"])
            if (
                not document.get("clips")
                or snapshot.get("rendition_snapshot_id") != rendition_snapshot_id
            ):
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照内容不合法")
            plan = self._compile_document(db, timeline_revision_id, document, mode)
            layouts = {
                item["clip_id"]: item["layout"] for item in snapshot.get("resolved_segments", [])
            }
            if set(layouts) != {segment["clip_id"] for segment in plan["segments"]}:
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出快照片段不完整")
            for segment in plan["segments"]:
                segment["layout"] = layouts[segment["clip_id"]]
            profile_key = "preview_profile" if mode == "authoritative_preview" else "export_profile"
            profile = snapshot.get(profile_key)
            if not isinstance(profile, dict):
                raise DomainError("RENDITION_SNAPSHOT_INVALID", "输出 Profile 不合法")
            plan["output"] = dict(profile)
            plan["rendition_snapshot_id"] = rendition_snapshot_id
            plan["rendition_snapshot_sha256"] = snapshot_row["snapshot_sha256"]
            plan["timeline_document_sha256"] = revision["document_sha256"]
            plan["captions"]["rendition_style"] = snapshot.get("caption_style_sha256")
            semantics = content_semantics(plan) | {
                "timeline_document_sha256": revision["document_sha256"],
                "rendition_snapshot_sha256": snapshot_row["snapshot_sha256"],
                "output": profile,
            }
            digest = hashlib.sha256(json_dumps(semantics).encode("utf-8")).hexdigest()
            plan["content_fingerprint"] = f"sha256:{digest}"
            return plan

    def compile_reframe(
        self,
        project_id: str,
        timeline_revision_id: str,
        rendition_reframe_snapshot_id: str,
        mode: str,
        *,
        reject_draft: bool = False,
    ) -> dict[str, Any]:
        """Compile Stage 3B without changing the Stage 3A compiler path."""
        with self.database.connection() as db:
            row = db.execute(
                "SELECT * FROM rendition_reframe_snapshots WHERE id=?",
                (rendition_reframe_snapshot_id,),
            ).fetchone()
            if row is None:
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照不存在")
            try:
                snapshot = json_loads(row["snapshot_json"])
            except (TypeError, ValueError) as exc:
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照损坏") from exc
            if (
                canonical_sha256(snapshot) != row["snapshot_sha256"]
                or row["project_id"] != project_id
                or row["timeline_revision_id"] != timeline_revision_id
                or snapshot.get("project_id") != project_id
                or snapshot.get("timeline_revision_id") != timeline_revision_id
                or snapshot.get("base_rendition_snapshot_id") != row["base_rendition_snapshot_id"]
                or snapshot.get("base_snapshot_sha256") != row["base_snapshot_sha256"]
                or snapshot.get("geometry_contract_version") != 1
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照校验失败")
            revision = db.execute(
                "SELECT document_json,document_sha256 FROM timeline_revisions WHERE id=?",
                (timeline_revision_id,),
            ).fetchone()
            if (
                revision is None
                or revision["document_sha256"] != row["timeline_document_sha256"]
                or snapshot.get("timeline_document_sha256") != revision["document_sha256"]
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图与 Timeline 不匹配")
            document = json_loads(revision["document_json"])
            clip_assets = {
                clip.get("clip_id"): clip.get("asset_id") for clip in document.get("clips", [])
            }
            media_by_clip: dict[str, dict[str, Any]] = {}
            for clip_id, asset_id in clip_assets.items():
                asset = db.execute(
                    "SELECT media_info_json FROM assets WHERE id=?", (asset_id,)
                ).fetchone()
                if asset is None:
                    raise DomainError("RENDER_INPUT_CHANGED", "重构图素材不可用")
                media_by_clip[clip_id] = json_loads(asset["media_info_json"] or "{}")
        plan = self.compile_rendition(
            project_id,
            timeline_revision_id,
            snapshot["base_rendition_snapshot_id"],
            mode,
            reject_draft=reject_draft,
        )
        if plan["rendition_snapshot_sha256"] != snapshot["base_snapshot_sha256"]:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出快照已变化")
        adjustments = {item["clip_id"]: item for item in snapshot.get("resolved_adjustments", [])}
        if not adjustments or len(adjustments) != row["adjustment_count"]:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图锚点不完整")
        for segment in plan["segments"]:
            adjustment = adjustments.get(segment["clip_id"])
            if adjustment is None:
                continue
            if segment["layout"] != "crop_fill":
                raise DomainError("REFRAME_NOT_APPLICABLE", "重构图仅适用于 crop_fill")
            streams = media_by_clip[segment["clip_id"]].get("video_streams") or []
            if not streams:
                raise DomainError("REFRAME_NOT_APPLICABLE", "重构图素材几何不可用")
            crop = crop_window(
                display_geometry(streams[0]),
                int(plan["output"]["width"]),
                int(plan["output"]["height"]),
                adjustment["horizontal_anchor"],
                adjustment["vertical_anchor"],
            )
            segment["reframe"] = {
                "horizontal_anchor": adjustment["horizontal_anchor"],
                "vertical_anchor": adjustment["vertical_anchor"],
                "geometry_contract_version": 1,
                "crop_x": crop.x,
                "crop_y": crop.y,
            }
        if set(adjustments) != {
            segment["clip_id"] for segment in plan["segments"] if "reframe" in segment
        }:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图引用未知 Clip")
        plan["schema_version"] = 2
        plan["compiler_version"] = REFRAME_COMPILER_VERSION
        plan["rendition_reframe_snapshot_id"] = rendition_reframe_snapshot_id
        plan["rendition_reframe_snapshot_sha256"] = row["snapshot_sha256"]
        plan["base_rendition_snapshot_id"] = snapshot["base_rendition_snapshot_id"]
        semantics = content_semantics(plan) | {
            "timeline_document_sha256": plan["timeline_document_sha256"],
            "base_rendition_snapshot_sha256": plan["rendition_snapshot_sha256"],
            "rendition_reframe_snapshot_sha256": row["snapshot_sha256"],
            "caption_style_sha256": plan["captions"].get("rendition_style"),
            "output": plan["output"],
        }
        digest = hashlib.sha256(json_dumps(semantics).encode("utf-8")).hexdigest()
        plan["content_fingerprint"] = f"sha256:{digest}"
        return plan

    def _compile_document(
        self,
        db: sqlite3.Connection,
        revision_id: str,
        document: dict[str, Any],
        mode: str,
        output_ratio: str | None = None,
    ) -> dict[str, Any]:
        inputs: list[dict[str, Any]] = []
        input_by_asset: dict[str, str] = {}
        segments: list[dict[str, Any]] = []
        # 多轨道：段落记录来源轨道与轨道标志；轨道静音/独奏直接合并进
        # audio_enabled（当前渲染图为单视觉轨 + 随段音频语义）。
        tracks_by_id: dict[str, dict[str, Any]] = {
            track["id"]: track
            for track in document.get("tracks", [])
            if isinstance(track, dict) and track.get("id")
        }
        any_solo = any(bool(track.get("solo")) for track in tracks_by_id.values())
        # B2：转场锚定在片段尾部——按 after_clip_id 索引，编译段时挂到对应段。
        transition_by_anchor: dict[str, dict[str, Any]] = {
            item["after_clip_id"]: item for item in document.get("transitions", [])
        }
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
            transition = transition_by_anchor.get(clip["clip_id"])
            track = tracks_by_id.get(clip.get("track_id", "V1"))
            track_muted = bool(track.get("muted")) if track else False
            track_solo = bool(track.get("solo")) if track else False
            audio_effective = (
                bool(clip["audio"]["enabled"])
                and not track_muted
                and not (any_solo and not track_solo)
            )
            segments.append(
                {
                    "clip_id": clip["clip_id"],
                    "track_id": clip.get("track_id", "V1"),
                    "track_hidden": bool(track.get("hidden")) if track else False,
                    "input_id": input_id,
                    "asset_kind": clip["asset_kind"],
                    "source_start_us": clip["source_start_us"],
                    "source_end_us": clip["source_end_us"],
                    "timeline_start_us": clip["timeline_start_us"],
                    "timeline_end_us": clip["timeline_end_us"],
                    "layout": clip["layout"],
                    "audio_enabled": audio_effective,
                    "gain_db": float(clip["audio"]["gain_db"]),
                    "speed_milli": int(clip.get("speed_milli", 1000)),
                    "reverse_playback": bool(clip.get("reverse_playback", False)),
                    "keyframes": clip.get("keyframes"),
                    "transition_in": (
                        {
                            "transition_id": transition["transition_id"],
                            "kind": transition["kind"],
                            "duration_us": int(transition["duration_us"]),
                        }
                        if transition is not None
                        else None
                    ),
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
        output = dict(PROFILES[mode])
        if output_ratio in OUTPUT_RATIO_DIMENSIONS:
            width, height = OUTPUT_RATIO_DIMENSIONS[output_ratio][mode]
            output["width"] = width
            output["height"] = height
            output["profile_id"] = RATIO_PROFILE_ID[mode].format(ratio=output_ratio)
        semantics = {
            "inputs": inputs,
            "segments": segments,
            "captions": caption_items,
            "canvas_background_color": document["canvas"]["background_color"],
            "preset_version": PRESET_VERSION,
            "font_bundle_version": FONT_BUNDLE_VERSION,
            # 输出规格参与指纹：同一时间线不同比例视为不同渲染产物，
            # 避免跨比例误复用，也让排队后比例变更可被 run() 检出。
            "output": {
                "profile_id": output["profile_id"],
                "width": output["width"],
                "height": output["height"],
            },
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
            "output": output,
        }


def content_semantics(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "inputs": plan["inputs"],
        "segments": plan["segments"],
        "captions": plan["captions"]["items"],
        "preset_version": plan["captions"]["preset_version"],
        "font_bundle_version": plan["captions"]["font_bundle_version"],
    }
