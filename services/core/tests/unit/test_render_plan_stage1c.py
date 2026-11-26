from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps, json_loads
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


def _install_fixture_timeline(
    database: Database, fixture_document: dict, revision_id: str, parent_revision_id: str,
) -> str:
    with database.connection() as db:
        row = db.execute("SELECT document_json FROM timeline_revisions WHERE id='r1'").fetchone()
        document = json_loads(row["document_json"])
        document["tracks"] = fixture_document["tracks"]
        document["clips"] = json.loads(json.dumps(fixture_document["clips"]))
        document["transitions"] = fixture_document.get("transitions", [])
        for clip in document["clips"]:
            clip["asset_id"] = "v1" if clip["asset_kind"] == "video" else "i1"
            clip["layout"] = "fit"
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            (revision_id, "p1", parent_revision_id, 1, json_dumps(document),
             "sha256:fixture", "fixture", "user", "now"),
        )
    return revision_id


def test_render_plan_matches_shared_openfilm_active_pair_fixture(tmp_path: Path) -> None:
    fixture_path = (
        Path(__file__).resolve().parents[4] / "tests" / "fixtures"
        / "openfilm_transition_projection.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    case = fixture["cases"]["cross_track_dissolve"]
    compiler, database, revision_id = _compiler(tmp_path)
    revision_id = _install_fixture_timeline(database, case["document"], "fixture-r2", "r1")

    preview = compiler.compile("p1", revision_id, "authoritative_preview")
    export = compiler.compile("p1", revision_id, "final_export")
    expected = case["expected_active_transitions"]
    assert preview["active_transitions"] == expected
    assert export["active_transitions"] == expected
    assert content_semantics(preview)["active_transitions"] == expected
    assert all(segment["transition_in"] is None for segment in preview["segments"])
    assert preview["compatibility_transitions"] == []


def test_render_plan_dormants_fixed_legacy_pair_after_successor_moves(tmp_path: Path) -> None:
    fixture_path = (
        Path(__file__).resolve().parents[4] / "tests" / "fixtures"
        / "openfilm_transition_projection.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    case = fixture["cases"]["stale_compatibility"]
    compiler, database, revision_id = _compiler(tmp_path)

    before_revision = _install_fixture_timeline(
        database, case["before_document"], "fixture-r2", "r1"
    )
    before = compiler.compile("p1", before_revision, "authoritative_preview")
    assert len(before["compatibility_transitions"]) == 1
    assert before["compatibility_transitions"][0]["outgoing_clip_id"] == "compat-out"
    assert before["compatibility_transitions"][0]["incoming_clip_id"] == "compat-in"
    outgoing = next(segment for segment in before["segments"] if segment["clip_id"] == "compat-out")
    assert outgoing["transition_in"] is not None

    after_revision = _install_fixture_timeline(
        database, case["after_document"], "fixture-r3", before_revision
    )
    after = compiler.compile("p1", after_revision, "authoritative_preview")
    assert after["active_transitions"] == case["expected_after_active_transitions"]
    assert after["compatibility_transitions"] == case["expected_after_compatibility_transitions"]
    assert all(segment["transition_in"] is None for segment in after["segments"])

    source_facts_document = json.loads(json.dumps(case["before_document"]))
    source_facts_document["clips"][0]["picture_fade_out_us"] = 300_000
    source_facts_document["clips"][1]["picture_fade_in_us"] = 300_000
    facts_revision = _install_fixture_timeline(
        database, source_facts_document, "fixture-r4", after_revision,
    )
    with_facts = compiler.compile("p1", facts_revision, "authoritative_preview")
    assert len(with_facts["active_transitions"]) == 1
    assert with_facts["active_transitions"][0]["kind"] == "dip-black"
    assert with_facts["compatibility_transitions"] == []


def test_unknown_duration_input_keeps_requested_preview_and_export_window(tmp_path: Path) -> None:
    compiler, database, _ = _compiler(tmp_path)
    with database.connection() as db:
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('unknown-video','p1','video','external','unknown','fp-unknown',"
            "1,'available',?,'now','now')",
            (json_dumps({"duration_us": 0, "video_streams": [{}], "audio_streams": []}),),
        )
        row = db.execute("SELECT document_json FROM timeline_revisions WHERE id='r1'").fetchone()
        document = json_loads(row["document_json"])
        clip = document["clips"][0]
        clip["asset_id"] = "unknown-video"
        clip["source_start_us"] = 0
        clip["source_end_us"] = 1_000_000
        db.execute(
            "INSERT INTO timeline_revisions VALUES (?,?,?,?,?,?,?,?,?)",
            ("unknown-duration-r2", "p1", "r1", 1, json_dumps(document),
             "sha256:unknown-duration", "test", "user", "now"),
        )

    for mode in ("authoritative_preview", "final_export"):
        plan = compiler.compile("p1", "unknown-duration-r2", mode)
        segment = next(item for item in plan["segments"] if item["clip_id"] == clip["clip_id"])
        source = next(item for item in plan["inputs"] if item["asset_id"] == "unknown-video")
        assert source["duration_us"] == 0  # 元数据仍表示未知，绝不伪造 EOF 边界。
        assert (segment["source_start_us"], segment["source_end_us"]) == (0, 1_000_000)
        assert (segment["timeline_start_us"], segment["timeline_end_us"]) == (0, 1_000_000)


def test_compile_document_sorts_deterministically_when_order_index_missing(tmp_path: Path) -> None:
    compiler, database, _ = _compiler(tmp_path)

    def _make_doc(first_pair: list[dict]) -> dict:
        return {
            "schema_version": 1,
            "project_id": "p1",
            "canvas": {
                "width": 1080,
                "height": 1920,
                "fps_num": 30,
                "fps_den": 1,
                "background_color": "#000000",
            },
            "tracks": [{"id": "V1", "kind": "visual", "locked": False}],
            "clips": [
                *first_pair,
                {
                    "clip_id": "c_next",
                    "track_id": "V1",
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
            "transitions": [
                {
                    "transition_id": "t_compat",
                    "after_clip_id": "c_b",
                    "incoming_clip_id": "c_next",
                    "kind": "dissolve",
                    "duration_us": 200_000,
                }
            ],
            "captions": [],
        }

    clip_a = {
        "clip_id": "c_a",
        "track_id": "V1",
        "asset_id": "v1",
        "asset_kind": "video",
        "source_start_us": 0,
        "source_end_us": 1_000_000,
        "timeline_start_us": 0,
        "timeline_end_us": 1_000_000,
        "layout": "fit",
        "audio": {"enabled": True, "gain_db": 0.0},
    }
    clip_b = {
        **clip_a,
        "clip_id": "c_b",
    }

    rev_ab = _install_fixture_timeline(database, _make_doc([clip_a, clip_b]), "legacy-ab", "r1")
    rev_ba = _install_fixture_timeline(database, _make_doc([clip_b, clip_a]), "legacy-ba", "legacy-ab")

    plan_ab = compiler.compile("p1", rev_ab, "authoritative_preview")
    plan_ba = compiler.compile("p1", rev_ba, "authoritative_preview")

    assert len(plan_ab["compatibility_transitions"]) == 1
    assert plan_ab["compatibility_transitions"] == plan_ba["compatibility_transitions"]
    assert plan_ab["compatibility_transitions"][0]["outgoing_clip_id"] == "c_b"
    assert plan_ab["compatibility_transitions"][0]["incoming_clip_id"] == "c_next"
