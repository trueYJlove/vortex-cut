from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.rendering.plan import RenderPlanCompiler, content_semantics


def _compiler(tmp_path: Path) -> tuple[RenderPlanCompiler, Database, str]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    document = {
        "schema_version": 1,
        "project_id": "p1",
        "canvas": {
            "width": 1080,
            "height": 1920,
            "fps_num": 30,
            "fps_den": 1,
            "background_color": "#000000",
        },
        "tracks": [
            {"id": "V1", "kind": "visual", "locked": False},
            {"id": "C1", "kind": "caption", "locked": False},
        ],
        "clips": [
            {
                "clip_id": "c1",
                "track_id": "V1",
                "order_index": 0,
                "asset_id": "v1",
                "asset_kind": "video",
                "source_start_us": 100_000,
                "source_end_us": 1_100_000,
                "timeline_start_us": 0,
                "timeline_end_us": 1_000_000,
                "layout": "blurred_background",
                "audio": {"enabled": True, "gain_db": -3.0},
            },
            {
                "clip_id": "c2",
                "track_id": "V1",
                "order_index": 1,
                "asset_id": "i1",
                "asset_kind": "image",
                "source_start_us": None,
                "source_end_us": None,
                "timeline_start_us": 1_000_000,
                "timeline_end_us": 2_000_000,
                "layout": "fit",
                "audio": {"enabled": False, "gain_db": 0.0},
            },
        ],
        "captions": [
            {
                "caption_id": "caption1",
                "track_id": "C1",
                "source_clip_id": None,
                "start_us": 100_000,
                "end_us": 800_000,
                "text": "中英 mixed caption",
                "preset_id": "high-contrast",
                "origin": "user",
                "edited": True,
                "source_segment_ids": [],
            }
        ],
        "provenance": {"created_by": "user", "source_transcript_ids": []},
    }
    with database.connection() as db:
        db.execute(
            "INSERT INTO projects(id,name,status,canvas_json,current_timeline_revision_id,"
            "root_dir,root_dir_name,created_at,updated_at,last_opened_at) VALUES "
            "('p1','P','active','{}','r1','root','root','now','now','now')"
        )
        for asset_id, kind, fingerprint, media in (
            (
                "v1",
                "video",
                "sha256:video",
                {"duration_us": 2_000_000, "video_streams": [{}], "audio_streams": [{}]},
            ),
            (
                "i1",
                "image",
                "sha256:image",
                {"duration_us": 0, "video_streams": [{}], "audio_streams": []},
            ),
        ):
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    "p1",
                    kind,
                    "external",
                    asset_id,
                    fingerprint,
                    1,
                    "available",
                    json_dumps(media),
                    "now",
                    "now",
                ),
            )
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("r1", "p1", None, 1, json_dumps(document), "sha256:revision", "s", "user", "now"),
        )
    return RenderPlanCompiler(database), database, "r1"


def test_preview_and_export_plans_share_content_semantics(tmp_path: Path) -> None:
    compiler, _, revision_id = _compiler(tmp_path)
    preview = compiler.compile("p1", revision_id, "authoritative_preview")
    export = compiler.compile("p1", revision_id, "final_export")
    # 内容语义（素材/片段/字幕）一致，但输出规格参与指纹 → 预览与导出指纹不同。
    assert content_semantics(preview) == content_semantics(export)
    assert preview["content_fingerprint"] != export["content_fingerprint"]
    assert preview["output"]["profile_id"] == "preview-portrait-v1"
    assert export["output"]["profile_id"] == "export-portrait-v1"
    assert (preview["output"]["width"], preview["output"]["height"]) == (540, 960)
    assert (export["output"]["width"], export["output"]["height"]) == (1080, 1920)
    serialized = json_dumps(preview)
    assert "root" not in serialized
    assert "path" not in serialized.lower()
    assert "filter_complex" not in serialized
    assert preview == compiler.compile("p1", revision_id, "authoritative_preview")


def test_plan_output_ratio_overrides_dimensions_and_profile(tmp_path: Path) -> None:
    compiler, _, revision_id = _compiler(tmp_path)
    preview = compiler.compile("p1", revision_id, "authoritative_preview", output_ratio="169")
    export = compiler.compile("p1", revision_id, "final_export", output_ratio="169")
    assert (preview["output"]["width"], preview["output"]["height"]) == (960, 540)
    assert (export["output"]["width"], export["output"]["height"]) == (1920, 1080)
    assert preview["output"]["profile_id"] == "preview-169-v1"
    assert export["output"]["profile_id"] == "export-169-v1"
    # 同一比例重复编译 → 指纹一致（幂等）。
    assert preview["content_fingerprint"] == compiler.compile(
        "p1", revision_id, "authoritative_preview", output_ratio="169"
    )["content_fingerprint"]
    # 不同比例 → 指纹不同（避免跨比例误复用）。
    portrait = compiler.compile("p1", revision_id, "authoritative_preview")
    assert portrait["content_fingerprint"] != preview["content_fingerprint"]
    assert portrait["output"]["profile_id"] != preview["output"]["profile_id"]
    # "fit" 保持默认竖屏 profile。
    fit = compiler.compile("p1", revision_id, "authoritative_preview", output_ratio="fit")
    assert fit["output"]["profile_id"] == "preview-portrait-v1"
    with pytest.raises(DomainError):
        compiler.compile("p1", revision_id, "authoritative_preview", output_ratio="bogus")


def test_plan_rejects_draft_empty_archived_and_changed_inputs(tmp_path: Path) -> None:
    compiler, database, revision_id = _compiler(tmp_path)
    with database.connection() as db:
        db.execute(
            "INSERT INTO timeline_drafts VALUES ('p1','r1','{}','now')"
        )
    with pytest.raises(DomainError) as draft:
        compiler.compile("p1", revision_id, "authoritative_preview", reject_draft=True)
    assert draft.value.code == "RENDER_PLAN_INVALID"
    with database.connection() as db:
        db.execute("DELETE FROM timeline_drafts WHERE project_id='p1'")
        db.execute("UPDATE assets SET availability='changed' WHERE id='v1'")
    with pytest.raises(DomainError) as changed:
        compiler.compile("p1", revision_id, "final_export")
    assert changed.value.code == "RENDER_INPUT_CHANGED"
    with database.connection() as db:
        db.execute("UPDATE assets SET availability='available' WHERE id='v1'")
        db.execute("UPDATE projects SET status='archived' WHERE id='p1'")
    with pytest.raises(DomainError):
        compiler.compile("p1", revision_id, "authoritative_preview")
