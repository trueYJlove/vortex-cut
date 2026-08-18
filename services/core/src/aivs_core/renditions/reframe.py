from __future__ import annotations

import hashlib
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from ..database import Database, json_dumps, json_loads, utc_now
from ..ids import new_id
from ..projects import DomainError
from .presets import RenditionPresetRegistry, canonical_sha256

GEOMETRY_CONTRACT_VERSION = 1
_HORIZONTAL = {"left": Fraction(0), "center": Fraction(1, 2), "right": Fraction(1)}
_VERTICAL = {"top": Fraction(0), "center": Fraction(1, 2), "bottom": Fraction(1)}
_WARNING_ORDER = (
    "STATIC_REFRAME_APPLIED",
    "REFRAME_AXIS_NORMALIZED",
    "REFRAME_MAY_HIDE_OPPOSITE_EDGE",
)


@dataclass(frozen=True)
class DisplayGeometry:
    width: Fraction
    height: Fraction


@dataclass(frozen=True)
class CropWindow:
    x: int
    y: int
    width: int
    height: int
    scaled_width: int
    scaled_height: int


def display_geometry(video_stream: dict[str, Any]) -> DisplayGeometry:
    try:
        width = int(video_stream["width"])
        height = int(video_stream["height"])
        sar_num = int(video_stream.get("sample_aspect_ratio_num", 1))
        sar_den = int(video_stream.get("sample_aspect_ratio_den", 1))
        rotation = int(video_stream.get("rotation", 0)) % 360
    except (KeyError, TypeError, ValueError) as exc:
        raise DomainError("REFRAME_NOT_APPLICABLE", "素材显示几何不合法") from exc
    if (
        width <= 0
        or height <= 0
        or sar_num <= 0
        or sar_den <= 0
        or rotation not in {0, 90, 180, 270}
    ):
        raise DomainError("REFRAME_NOT_APPLICABLE", "素材显示几何不合法")
    display_width = Fraction(width * sar_num, sar_den)
    display_height = Fraction(height)
    if rotation in {90, 270}:
        display_width, display_height = display_height, display_width
    return DisplayGeometry(display_width, display_height)


def normalize_adjustment(
    geometry: DisplayGeometry,
    target_width: int,
    target_height: int,
    horizontal_anchor: str,
    vertical_anchor: str,
) -> tuple[str, str, bool]:
    if horizontal_anchor not in _HORIZONTAL or vertical_anchor not in _VERTICAL:
        raise DomainError("REFRAME_ANCHOR_INVALID", "静态锚点不合法")
    overflow_x, overflow_y = _overflow(geometry, target_width, target_height)
    normalized_horizontal = horizontal_anchor if overflow_x > 0 else "center"
    normalized_vertical = vertical_anchor if overflow_y > 0 else "center"
    axis_normalized = (
        normalized_horizontal != horizontal_anchor or normalized_vertical != vertical_anchor
    )
    if normalized_horizontal == "center" and normalized_vertical == "center":
        raise DomainError("REFRAME_NOT_APPLICABLE", "该锚点对目标画幅没有可见效果")
    return normalized_horizontal, normalized_vertical, axis_normalized


def crop_window(
    geometry: DisplayGeometry,
    target_width: int,
    target_height: int,
    horizontal_anchor: str,
    vertical_anchor: str,
) -> CropWindow:
    normalized_horizontal, normalized_vertical, _ = normalize_adjustment(
        geometry, target_width, target_height, horizontal_anchor, vertical_anchor
    )
    scaled_width, scaled_height = _scaled_size(geometry, target_width, target_height)
    overflow_x = max(0, scaled_width - target_width)
    overflow_y = max(0, scaled_height - target_height)
    x = _even_offset(overflow_x, _HORIZONTAL[normalized_horizontal])
    y = _even_offset(overflow_y, _VERTICAL[normalized_vertical])
    return CropWindow(x, y, target_width, target_height, scaled_width, scaled_height)


def _overflow(geometry: DisplayGeometry, width: int, height: int) -> tuple[int, int]:
    scaled_width, scaled_height = _scaled_size(geometry, width, height)
    return max(0, scaled_width - width), max(0, scaled_height - height)


def _scaled_size(geometry: DisplayGeometry, width: int, height: int) -> tuple[int, int]:
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise DomainError("REFRAME_NOT_APPLICABLE", "目标画布几何不合法")
    scale = max(Fraction(width, 1) / geometry.width, Fraction(height, 1) / geometry.height)
    scaled_width = _nearest_even(geometry.width * scale)
    scaled_height = _nearest_even(geometry.height * scale)
    return max(width, scaled_width), max(height, scaled_height)


def _nearest_even(value: Fraction) -> int:
    """Match FFmpeg scale force_divisible_by=2 using exact rational arithmetic."""
    even_units = value / 2
    quotient, remainder = divmod(even_units.numerator, even_units.denominator)
    if remainder * 2 >= even_units.denominator:
        quotient += 1
    return quotient * 2


def _even_offset(overflow: int, coefficient: Fraction) -> int:
    raw = Fraction(overflow) * coefficient
    offset = raw.numerator // raw.denominator
    offset -= offset % 2
    maximum = overflow - (overflow % 2)
    return max(0, min(offset, maximum))


class RenditionReframeSnapshotService:
    def __init__(
        self,
        database: Database,
        presets: RenditionPresetRegistry,
    ) -> None:
        self.database = database
        self.presets = presets

    def create_or_reuse(
        self,
        project_id: str,
        base_rendition_snapshot_id: str,
        adjustments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self._validate_adjustment_shape(adjustments)
        with self.database.connection() as db:
            project = db.execute("SELECT status FROM projects WHERE id=?", (project_id,)).fetchone()
            base_row = db.execute(
                "SELECT * FROM rendition_snapshots WHERE id=?",
                (base_rendition_snapshot_id,),
            ).fetchone()
            if (
                project is None
                or project["status"] == "archived"
                or base_row is None
                or base_row["project_id"] != project_id
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "项目或基础输出快照不合法")
            revision = db.execute(
                "SELECT * FROM timeline_revisions WHERE id=?",
                (base_row["timeline_revision_id"],),
            ).fetchone()
            if (
                revision is None
                or revision["project_id"] != project_id
                or revision["document_sha256"] != base_row["timeline_document_sha256"]
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出快照的 Revision 不合法")
            try:
                base = json_loads(base_row["snapshot_json"])
                document = json_loads(revision["document_json"])
            except (TypeError, ValueError) as exc:
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出快照损坏") from exc
            self._validate_base(base, base_row, revision, project_id)
            rendition = self.presets.renditions.get(base["rendition_preset_id"])
            platform = self.presets.platforms.get(base["platform_preset_id"])
            if (
                rendition is None
                or platform is None
                or rendition["document_sha256"] != base["rendition_preset_sha256"]
                or platform["document_sha256"] != base["platform_preset_sha256"]
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出预设不再可解释")
            target = rendition["export_profile"]
            resolved_layout = {
                item.get("clip_id"): item.get("layout") for item in base["resolved_segments"]
            }
            clips = document.get("clips")
            if not isinstance(clips, list) or not clips:
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础 Timeline 不合法")
            clip_order = {clip.get("clip_id"): index for index, clip in enumerate(clips)}
            clip_assets = {clip.get("clip_id"): clip.get("asset_id") for clip in clips}
            resolved_adjustments: list[dict[str, str]] = []
            axis_normalized = False
            for adjustment in adjustments:
                clip_id = adjustment["clip_id"]
                if clip_id not in clip_order:
                    raise DomainError("REFRAME_CLIP_NOT_FOUND", "静态锚点引用的 Clip 不存在")
                if resolved_layout.get(clip_id) != "crop_fill":
                    raise DomainError(
                        "REFRAME_NOT_APPLICABLE", "只有 crop_fill Clip 可以设置静态锚点"
                    )
                asset = db.execute(
                    "SELECT project_id,kind,availability,media_info_json FROM assets WHERE id=?",
                    (clip_assets[clip_id],),
                ).fetchone()
                if (
                    asset is None
                    or asset["project_id"] != project_id
                    or asset["kind"] not in {"video", "image"}
                    or asset["availability"] != "available"
                ):
                    raise DomainError("REFRAME_NOT_APPLICABLE", "Clip 素材不支持静态锚点")
                try:
                    media_info = json_loads(asset["media_info_json"] or "{}")
                    streams = media_info.get("video_streams") or []
                    geometry = display_geometry(streams[0])
                except (TypeError, ValueError, IndexError, DomainError) as exc:
                    raise DomainError("REFRAME_NOT_APPLICABLE", "Clip 素材几何不可用") from exc
                horizontal, vertical, normalized = normalize_adjustment(
                    geometry,
                    int(target["width"]),
                    int(target["height"]),
                    adjustment["horizontal_anchor"],
                    adjustment["vertical_anchor"],
                )
                axis_normalized = axis_normalized or normalized
                resolved_adjustments.append(
                    {
                        "clip_id": clip_id,
                        "horizontal_anchor": horizontal,
                        "vertical_anchor": vertical,
                    }
                )
            resolved_adjustments.sort(key=lambda item: clip_order[item["clip_id"]])
            warnings = ["STATIC_REFRAME_APPLIED", "REFRAME_MAY_HIDE_OPPOSITE_EDGE"]
            if axis_normalized:
                warnings.append("REFRAME_AXIS_NORMALIZED")
            warnings = [warning for warning in _WARNING_ORDER if warning in warnings]
            snapshot = {
                "schema_version": 1,
                "project_id": project_id,
                "timeline_revision_id": revision["id"],
                "timeline_document_sha256": revision["document_sha256"],
                "base_rendition_snapshot_id": base_rendition_snapshot_id,
                "base_snapshot_sha256": base_row["snapshot_sha256"],
                "platform_preset_id": base["platform_preset_id"],
                "rendition_preset_id": base["rendition_preset_id"],
                "base_layout_policy": base["layout_policy"],
                "geometry_contract_version": GEOMETRY_CONTRACT_VERSION,
                "resolved_adjustments": resolved_adjustments,
                "warnings": warnings,
            }
            snapshot_hash = canonical_sha256(snapshot)
            found = db.execute(
                "SELECT id FROM rendition_reframe_snapshots WHERE project_id=? "
                "AND base_rendition_snapshot_id=? AND base_snapshot_sha256=? "
                "AND snapshot_sha256=?",
                (
                    project_id,
                    base_rendition_snapshot_id,
                    base_row["snapshot_sha256"],
                    snapshot_hash,
                ),
            ).fetchone()
            if found is not None:
                snapshot_id = found["id"]
            else:
                snapshot_id = f"rendition_reframe_snapshot_{new_id()}"
                db.execute(
                    "INSERT INTO rendition_reframe_snapshots("
                    "id,project_id,timeline_revision_id,timeline_document_sha256,"
                    "base_rendition_snapshot_id,base_snapshot_sha256,platform_preset_id,"
                    "rendition_preset_id,geometry_contract_version,snapshot_json,"
                    "snapshot_sha256,adjustment_count,warnings_json,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        snapshot_id,
                        project_id,
                        revision["id"],
                        revision["document_sha256"],
                        base_rendition_snapshot_id,
                        base_row["snapshot_sha256"],
                        base["platform_preset_id"],
                        base["rendition_preset_id"],
                        GEOMETRY_CONTRACT_VERSION,
                        json_dumps(snapshot),
                        snapshot_hash,
                        len(resolved_adjustments),
                        json_dumps(warnings),
                        utc_now(),
                    ),
                )
        return self.safe_summary(snapshot_id)

    def get(self, snapshot_id: str) -> dict[str, Any]:
        with self.database.connection() as db:
            row = db.execute(
                "SELECT * FROM rendition_reframe_snapshots WHERE id=?", (snapshot_id,)
            ).fetchone()
        if row is None:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照不存在")
        try:
            snapshot = json_loads(row["snapshot_json"])
        except (TypeError, ValueError) as exc:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照损坏") from exc
        if (
            canonical_sha256(snapshot) != row["snapshot_sha256"]
            or len(snapshot.get("resolved_adjustments", [])) != row["adjustment_count"]
        ):
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "重构图快照校验失败")
        return snapshot | {"rendition_reframe_snapshot_id": snapshot_id}

    def safe_summary(self, snapshot_id: str) -> dict[str, Any]:
        snapshot = self.get(snapshot_id)
        with self.database.connection() as db:
            row = db.execute(
                "SELECT snapshot_sha256,adjustment_count,created_at "
                "FROM rendition_reframe_snapshots WHERE id=?",
                (snapshot_id,),
            ).fetchone()
        assert row is not None
        return {
            "rendition_reframe_snapshot_id": snapshot_id,
            "project_id": snapshot["project_id"],
            "timeline_revision_id": snapshot["timeline_revision_id"],
            "base_rendition_snapshot_id": snapshot["base_rendition_snapshot_id"],
            "base_snapshot_sha256": snapshot["base_snapshot_sha256"],
            "platform_preset_id": snapshot["platform_preset_id"],
            "rendition_preset_id": snapshot["rendition_preset_id"],
            "adjustment_count": row["adjustment_count"],
            "reframe_snapshot_sha256": row["snapshot_sha256"],
            "warnings": snapshot["warnings"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _validate_adjustment_shape(adjustments: list[dict[str, Any]]) -> None:
        if not isinstance(adjustments, list) or not 1 <= len(adjustments) <= 500:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "静态锚点数量不合法")
        seen: set[str] = set()
        for item in adjustments:
            if (
                not isinstance(item, dict)
                or set(item) != {"clip_id", "horizontal_anchor", "vertical_anchor"}
                or not isinstance(item["clip_id"], str)
            ):
                raise DomainError("REFRAME_SNAPSHOT_INVALID", "静态锚点字段不合法")
            if item["clip_id"] in seen:
                raise DomainError("REFRAME_ADJUSTMENT_DUPLICATE", "同一 Clip 不能重复设置静态锚点")
            seen.add(item["clip_id"])
            if (
                item["horizontal_anchor"] not in _HORIZONTAL
                or item["vertical_anchor"] not in _VERTICAL
                or (item["horizontal_anchor"] == "center" and item["vertical_anchor"] == "center")
            ):
                raise DomainError("REFRAME_ANCHOR_INVALID", "静态锚点不合法")

    @staticmethod
    def _validate_base(base: dict[str, Any], row: Any, revision: Any, project_id: str) -> None:
        expected = {
            "schema_version",
            "project_id",
            "timeline_revision_id",
            "timeline_document_sha256",
            "platform_preset_id",
            "platform_preset_version",
            "platform_preset_sha256",
            "rendition_preset_id",
            "rendition_preset_version",
            "rendition_preset_sha256",
            "layout_policy",
            "resolved_segments",
            "caption_style_version",
            "caption_style_sha256",
            "preview_profile",
            "export_profile",
            "warnings",
            "rendition_snapshot_id",
        }
        if (
            not isinstance(base, dict)
            or set(base) != expected
            or base.get("schema_version") != 1
            or base.get("rendition_snapshot_id") != row["id"]
        ):
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出快照结构不合法")
        base_facts = {key: value for key, value in base.items() if key != "rendition_snapshot_id"}
        if (
            canonical_sha256(base_facts) != row["snapshot_sha256"]
            or base["project_id"] != project_id
            or base["timeline_revision_id"] != revision["id"]
            or base["timeline_document_sha256"] != revision["document_sha256"]
        ):
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出快照校验失败")
        document_json = revision["document_json"]
        digest = f"sha256:{hashlib.sha256(document_json.encode('utf-8')).hexdigest()}"
        if digest != revision["document_sha256"]:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "Timeline Revision 校验失败")
        segments = base.get("resolved_segments")
        if not isinstance(segments, list) or not segments:
            raise DomainError("REFRAME_SNAPSHOT_INVALID", "基础输出布局不合法")
