from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.renditions.presets import RenditionPresetRegistry, canonical_sha256
from aivs_core.renditions.reframe import RenditionReframeSnapshotService


def _setup(tmp_path: Path):
    db = Database(tmp_path / "app.db")
    db.initialize()
    presets = RenditionPresetRegistry(Path(__file__).resolve().parents[4] / "resources")
    presets.load()
    document = {
        "schema_version": 1,
        "project_id": "project_1",
        "clips": [
            {
                "clip_id": "clip_1",
                "asset_id": "asset_1",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 1_000_000,
                "timeline_start_us": 0,
                "timeline_end_us": 1_000_000,
                "layout": "crop_fill",
                "audio": {"enabled": True, "gain_db": 0.0},
            },
            {
                "clip_id": "clip_2",
                "asset_id": "asset_2",
                "asset_kind": "video",
                "source_start_us": 0,
                "source_end_us": 1_000_000,
                "timeline_start_us": 1_000_000,
                "timeline_end_us": 2_000_000,
                "layout": "fit",
                "audio": {"enabled": True, "gain_db": 0.0},
            },
        ],
        "captions": [],
        "canvas": {"background_color": "#000000"},
    }
    document_json = json_dumps(document)
    document_hash = "sha256:" + hashlib.sha256(document_json.encode()).hexdigest()
    platform = presets.platforms["generic"]
    rendition = presets.renditions["portrait-9x16-v1"]
    snapshot = {
        "schema_version": 1,
        "project_id": "project_1",
        "timeline_revision_id": "revision_1",
        "timeline_document_sha256": document_hash,
        "platform_preset_id": "generic",
        "platform_preset_version": platform["preset_version"],
        "platform_preset_sha256": platform["document_sha256"],
        "rendition_preset_id": "portrait-9x16-v1",
        "rendition_preset_version": rendition["preset_version"],
        "rendition_preset_sha256": rendition["document_sha256"],
        "layout_policy": "preserve_timeline",
        "resolved_segments": [
            {"clip_id": "clip_1", "layout": "crop_fill"},
            {"clip_id": "clip_2", "layout": "fit"},
        ],
        "caption_style_version": presets.caption_styles["caption_style_version"],
        "caption_style_sha256": canonical_sha256(presets.caption_style("portrait-9x16-v1")),
        "preview_profile": rendition["preview_profile"],
        "export_profile": rendition["export_profile"],
        "warnings": [],
    }
    snapshot_hash = canonical_sha256(snapshot)
    media = json.dumps(
        {
            "video_streams": [
                {
                    "width": 1920,
                    "height": 1080,
                    "sample_aspect_ratio_num": 1,
                    "sample_aspect_ratio_den": 1,
                    "rotation": 0,
                }
            ],
            "audio_streams": [],
        }
    )
    with db.connection() as sql:
        sql.execute(
            "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("project_1", "P", "active", "{}", "revision_1", "root", "root", "now", "now", "now"),
        )
        sql.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("revision_1", "project_1", None, 1, document_json, document_hash, "s", "user", "now"),
        )
        for asset_id in ("asset_1", "asset_2"):
            sql.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    "project_1",
                    "video",
                    "external",
                    asset_id,
                    asset_id + "fp",
                    1,
                    "available",
                    media,
                    "now",
                    "now",
                ),
            )
        sql.execute(
            "INSERT INTO rendition_snapshots("
            "id,project_id,timeline_revision_id,timeline_document_sha256,platform_preset_id,"
            "platform_preset_version,platform_preset_sha256,rendition_preset_id,"
            "rendition_preset_version,rendition_preset_sha256,layout_policy,snapshot_json,"
            "snapshot_sha256,warnings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "rendition_snapshot_1",
                "project_1",
                "revision_1",
                document_hash,
                "generic",
                platform["preset_version"],
                platform["document_sha256"],
                "portrait-9x16-v1",
                rendition["preset_version"],
                rendition["document_sha256"],
                "preserve_timeline",
                json_dumps(snapshot | {"rendition_snapshot_id": "rendition_snapshot_1"}),
                snapshot_hash,
                "[]",
                "now",
            ),
        )
    return db, presets


def _item(clip="clip_1", horizontal="right", vertical="top"):
    return {"clip_id": clip, "horizontal_anchor": horizontal, "vertical_anchor": vertical}


def test_snapshot_normalizes_reuses_and_summary_hides_adjustments(tmp_path: Path) -> None:
    db, presets = _setup(tmp_path)
    service = RenditionReframeSnapshotService(db, presets)
    first = service.create_or_reuse("project_1", "rendition_snapshot_1", [_item()])
    second = service.create_or_reuse(
        "project_1", "rendition_snapshot_1", [_item(vertical="bottom")]
    )
    assert first == second
    assert "resolved_adjustments" not in first and "adjustments" not in first
    assert first["warnings"] == [
        "STATIC_REFRAME_APPLIED",
        "REFRAME_AXIS_NORMALIZED",
        "REFRAME_MAY_HIDE_OPPOSITE_EDGE",
    ]
    internal = service.get(first["rendition_reframe_snapshot_id"])
    assert internal["resolved_adjustments"] == [_item(vertical="center")]


@pytest.mark.parametrize(
    ("items", "code"),
    [
        ([_item(horizontal="center", vertical="center")], "REFRAME_ANCHOR_INVALID"),
        ([_item(clip="missing")], "REFRAME_CLIP_NOT_FOUND"),
        ([_item(clip="clip_2")], "REFRAME_NOT_APPLICABLE"),
        ([_item(), _item()], "REFRAME_ADJUSTMENT_DUPLICATE"),
    ],
)
def test_snapshot_rejects_invalid_adjustments(tmp_path: Path, items, code: str) -> None:
    db, presets = _setup(tmp_path)
    with pytest.raises(DomainError) as error:
        RenditionReframeSnapshotService(db, presets).create_or_reuse(
            "project_1", "rendition_snapshot_1", items
        )
    assert error.value.code == code


def test_snapshot_detects_base_tampering(tmp_path: Path) -> None:
    db, presets = _setup(tmp_path)
    with db.connection() as sql:
        sql.execute("DROP TRIGGER rendition_snapshots_no_update")
        sql.execute("UPDATE rendition_snapshots SET snapshot_sha256='broken'")
    with pytest.raises(DomainError) as error:
        RenditionReframeSnapshotService(db, presets).create_or_reuse(
            "project_1", "rendition_snapshot_1", [_item()]
        )
    assert error.value.code == "REFRAME_SNAPSHOT_INVALID"
