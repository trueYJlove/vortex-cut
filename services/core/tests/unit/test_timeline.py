from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.timeline import (
    MAX_IMAGE_US,
    TimelineService,
    _clip_timeline_duration_us,
    _project_active_transitions,
)


def _service(tmp_path: Path) -> tuple[TimelineService, Database]:
    database = Database(tmp_path / "app.db")
    database.initialize()
    with database.connection() as db:
        for project_id in ("p1", "p2"):
            db.execute(
                "INSERT INTO projects(id,name,status,canvas_json,root_dir,root_dir_name,"
                "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (project_id, project_id, "active", "{}", "root", "root", "now", "now", "now"),
            )
        assets = [
            ("v1", "p1", "video", "fp-v1", 5_000_000, True),
            ("v2", "p1", "video", "fp-v2", 2_000_000, False),
            ("i1", "p1", "image", "fp-i1", 0, False),
            ("a1", "p1", "audio", "fp-a1", 8_000_000, True),
            ("other", "p2", "video", "fp-other", 1_000_000, True),
        ]
        for asset_id, project_id, kind, fingerprint, duration, has_audio in assets:
            media = {
                "duration_us": duration,
                "video_streams": [{}] if kind == "video" else [],
                "audio_streams": [{}] if has_audio else [],
            }
            db.execute(
                "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,media_info_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    asset_id,
                    project_id,
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
            "INSERT INTO transcripts(id,asset_id,status,language,provider,model_id,"
            "model_revision,source_fingerprint,duration_us,created_at,updated_at) "
            "VALUES ('t1','v1','ready','zh','test','m','r','fp-v1',5000000,'now','now')"
        )
        for segment in (
            ("s1", 0, 500_000, 1_500_000, "第一段"),
            ("s2", 1, 2_000_000, 3_000_000, "第二段"),
        ):
            db.execute(
                "INSERT INTO transcript_segments(id,transcript_id,ordinal,start_us,end_us,"
                "text,confidence) VALUES (?,'t1',?,?,?,?,0.9)",
                segment,
            )
    return TimelineService(database), database


def _create(service: TimelineService, source: dict | None = None) -> dict:
    return service.create(
        "p1",
        {
            "schema_version": 1,
            "source": source or {"kind": "empty"},
            "default_layout": "blurred_background",
            "caption_preset_id": "default-bottom",
        },
    )


def _patch(
    service: TimelineService,
    state: dict,
    operations: list[dict],
    summary: str = "修改",
) -> dict:
    return service.patch(
        "p1",
        {
            "schema_version": 1,
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "operations": operations,
            "summary": summary,
        },
    )


def _insert_asset(database: Database, asset_id: str, kind: str, media: dict) -> None:
    with database.connection() as db:
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id, "p1", kind, "external", asset_id, f"fp-{asset_id}",
                1, "available", json_dumps(media), "now", "now",
            ),
        )


def test_create_empty_full_video_image_and_source_validation(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    empty = _create(service)
    assert empty["current_revision"]["document"]["clips"] == []
    with pytest.raises(DomainError) as duplicate:
        _create(service)
    assert duplicate.value.code == "TIMELINE_ALREADY_EXISTS"

    service2, _ = _service(tmp_path / "second")
    video = _create(service2, {"kind": "full_asset", "asset_id": "v1"})
    clip = video["current_revision"]["document"]["clips"][0]
    assert (clip["timeline_start_us"], clip["timeline_end_us"]) == (0, 5_000_000)
    assert clip["audio"]["enabled"] is True

    service3, _ = _service(tmp_path / "third")
    image = _create(service3, {"kind": "full_asset", "asset_id": "i1"})
    image_clip = image["current_revision"]["document"]["clips"][0]
    assert image_clip["asset_kind"] == "image"
    assert image_clip["timeline_end_us"] == 3_000_000
    assert image_clip["source_start_us"] is None

    service4, _ = _service(tmp_path / "fourth")
    with pytest.raises(DomainError) as cross_project:
        _create(service4, {"kind": "full_asset", "asset_id": "other"})
    assert cross_project.value.code == "TIMELINE_SOURCE_INVALID"


def test_replace_silent_video_on_audio_clip_and_long_image_duration(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    audio_state = _create(service, {"kind": "full_asset", "asset_id": "a1"})
    audio_clip = audio_state["current_revision"]["document"]["clips"][0]
    audio_state = _patch(service, audio_state, [{
        "op": "replace_clip_source", "clip_id": audio_clip["clip_id"], "asset_id": "v2",
    }])
    replaced_audio = audio_state["current_revision"]["document"]["clips"][0]
    assert replaced_audio["asset_id"] == "v2"
    assert replaced_audio["asset_kind"] == "audio"
    assert replaced_audio["audio"]["enabled"] is True
    assert replaced_audio["timeline_start_us"] == 0
    assert replaced_audio["timeline_end_us"] == 2_000_000
    # P235-R1：无音轨视频替换到音轨后仍保持音频片段可编辑语义（增益/淡变/修剪/变速）及撤销链路。
    edited_audio_state = _patch(service, audio_state, [
        {"op": "set_audio", "clip_id": replaced_audio["clip_id"], "enabled": True, "gain_db": -6.0, "fade_in_us": 200_000, "fade_out_us": 300_000},
        {"op": "trim_clip", "clip_id": replaced_audio["clip_id"], "source_start_us": 200_000, "source_end_us": 1_800_000},
        {"op": "set_speed", "clip_id": replaced_audio["clip_id"], "speed_milli": 2000},
    ])
    edited_clip = edited_audio_state["current_revision"]["document"]["clips"][0]
    assert edited_clip["audio"] == {"enabled": True, "gain_db": -6.0, "fade_in_us": 200_000, "fade_out_us": 300_000}
    assert edited_clip["timeline_end_us"] - edited_clip["timeline_start_us"] == 800_000
    undone_audio = service.undo("p1", edited_audio_state["current_revision"]["timeline_revision_id"])
    assert undone_audio["current_revision"]["document"]["clips"][0]["audio"]["gain_db"] == 0.0

    image_service, image_database = _service(tmp_path / "image")
    with image_database.connection() as db:
        db.execute(
            "INSERT INTO assets(id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,media_info_json,created_at,updated_at) "
            "VALUES ('i2','p1','image','external','i2','fp-i2',1,'available',?,'now','now')",
            (json_dumps({"duration_us": 0, "video_streams": [{}], "audio_streams": []}),),
        )
    image_state = _create(image_service, {"kind": "full_asset", "asset_id": "i1"})
    image_clip = image_state["current_revision"]["document"]["clips"][0]
    image_state = _patch(image_service, image_state, [{
        "op": "set_image_duration", "clip_id": image_clip["clip_id"], "duration_us": 40_000_000,
    }])
    image_state = _patch(image_service, image_state, [{
        "op": "replace_clip_source", "clip_id": image_clip["clip_id"], "asset_id": "i2",
    }])
    replaced_image = image_state["current_revision"]["document"]["clips"][0]
    assert replaced_image["asset_id"] == "i2"
    assert replaced_image["timeline_end_us"] == 40_000_000


def test_position_clips_over_100_commit_as_one_revision_and_undo_atomically(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    segment_count = 105
    with database.connection() as db:
        db.execute(
            "UPDATE assets SET media_info_json=? WHERE id='v1'",
            (json_dumps({"duration_us": 20_000_000, "video_streams": [{}], "audio_streams": [{}]}),),
        )
        db.execute("UPDATE transcripts SET duration_us=20000000 WHERE id='t1'")
        db.executemany(
            "INSERT INTO transcript_segments(id,transcript_id,ordinal,start_us,end_us,text,confidence) "
            "VALUES (?,'t1',?,?,?,?,0.9)",
            [
                (f"bulk_{index}", index, index * 150_000, index * 150_000 + 100_000, f"片段 {index}")
                for index in range(segment_count)
            ],
        )

    state = _create(service, {
        "kind": "transcript_selection",
        "transcript_id": "t1",
        "segment_ids": [f"bulk_{index}" for index in range(segment_count)],
        "padding_before_us": 0,
        "padding_after_us": 0,
        "create_captions": False,
    })
    original = state["current_revision"]
    original_clips = original["document"]["clips"]
    assert len(original_clips) == segment_count
    moving = original_clips[:103]
    offset_us = 100_000_000
    placements = [
        {
            "clip_id": clip["clip_id"],
            "timeline_start_us": clip["timeline_start_us"] + offset_us,
            "track_id": "V1",
        }
        for clip in moving
    ]
    request = {
        "schema_version": 1,
        "base_revision_id": original["timeline_revision_id"],
        "operations": [{"op": "position_clips", "placements": placements}],
        "summary": "移动 103 个片段",
    }
    assert len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) < 4 * 1024 * 1024

    applied = service.patch("p1", request)
    moved_revision = applied["current_revision"]
    assert moved_revision["parent_revision_id"] == original["timeline_revision_id"]
    moved_clips = {clip["clip_id"]: clip for clip in moved_revision["document"]["clips"]}
    assert all(
        moved_clips[clip["clip_id"]]["timeline_start_us"] == clip["timeline_start_us"] + offset_us
        for clip in moving
    )
    assert len(service.list_revisions("p1", limit=10)[0]) == 2

    undone = service.undo("p1", moved_revision["timeline_revision_id"])
    assert undone["current_revision"]["timeline_revision_id"] == original["timeline_revision_id"]
    assert undone["can_redo"] is True
    redone = service.redo("p1", original["timeline_revision_id"])
    assert redone["current_revision"]["timeline_revision_id"] == moved_revision["timeline_revision_id"]

    revision_before_invalid_patch = redone["current_revision"]["timeline_revision_id"]
    invalid_placements = [*placements]
    invalid_placements[0] = {**invalid_placements[0], "timeline_start_us": -1}
    with pytest.raises(DomainError) as invalid:
        _patch(service, redone, [{"op": "position_clips", "placements": invalid_placements}])
    assert invalid.value.code == "TIMELINE_INVALID"
    assert service.get_state("p1")["current_revision"]["timeline_revision_id"] == revision_before_invalid_patch


def test_replace_unknown_duration_uses_target_source_window(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    _insert_asset(database, "v-missing-duration", "video", {
        "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(database, "v-zero-duration", "video", {
        "duration_us": 0, "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(database, "v-null-duration", "video", {
        "duration_us": None, "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(database, "a-zero-duration", "audio", {
        "duration_us": 0, "video_streams": [], "audio_streams": [{}],
    })

    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip = state["current_revision"]["document"]["clips"][0]
    state = _patch(service, state, [{
        "op": "set_speed", "clip_id": clip["clip_id"], "speed_milli": 2000,
    }])
    clip = state["current_revision"]["document"]["clips"][0]
    target_end = clip["timeline_end_us"]
    assert target_end == 2_500_000

    for asset_id in ("v-missing-duration", "v-zero-duration", "v-null-duration"):
        state = _patch(service, state, [{
            "op": "replace_clip_source", "clip_id": clip["clip_id"], "asset_id": asset_id,
        }])
        clip = state["current_revision"]["document"]["clips"][0]
        assert clip["asset_id"] == asset_id
        assert (clip["source_start_us"], clip["source_end_us"]) == (0, 5_000_000)
        assert clip["speed_milli"] == 2000
        assert (clip["timeline_start_us"], clip["timeline_end_us"]) == (0, target_end)
        assert clip["audio"]["enabled"] is False

    audio_state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "a1", "at_index": 0, "track_id": "A1",
    }])
    audio_clip = next(
        clip for clip in audio_state["current_revision"]["document"]["clips"]
        if clip["asset_id"] == "a1"
    )
    audio_state = _patch(service, audio_state, [{
        "op": "replace_clip_source", "clip_id": audio_clip["clip_id"], "asset_id": "a-zero-duration",
    }])
    replaced_audio = next(
        clip for clip in audio_state["current_revision"]["document"]["clips"]
        if clip["clip_id"] == audio_clip["clip_id"]
    )
    assert replaced_audio["asset_id"] == "a-zero-duration"
    assert (replaced_audio["source_start_us"], replaced_audio["source_end_us"]) == (0, 8_000_000)
    assert replaced_audio["timeline_end_us"] == 8_000_000

    # P235-R1：未知时长（None / 0）在 Replace 后允许 set_clip_source_window（滑移/首尾锚）并保持 undo/redo 一致。
    slip_state = _patch(service, audio_state, [{
        "op": "set_clip_source_window",
        "clip_id": replaced_audio["clip_id"],
        "source_start_us": 1_000_000,
        "source_end_us": 9_000_000,
        "anchor": "timeline",
    }])
    slipped_audio = next(
        c for c in slip_state["current_revision"]["document"]["clips"]
        if c["clip_id"] == replaced_audio["clip_id"]
    )
    assert (slipped_audio["source_start_us"], slipped_audio["source_end_us"]) == (1_000_000, 9_000_000)
    assert (slipped_audio["timeline_start_us"], slipped_audio["timeline_end_us"]) == (0, 8_000_000)
    with pytest.raises(DomainError) as window_overflow:
        _patch(service, slip_state, [{
            "op": "set_clip_source_window",
            "clip_id": replaced_audio["clip_id"],
            "source_start_us": 0,
            "source_end_us": MAX_IMAGE_US + 1,
            "anchor": "start",
        }])
    assert window_overflow.value.code == "TIMELINE_INVALID"
    undone_slip = service.undo("p1", slip_state["current_revision"]["timeline_revision_id"])
    reverted_audio = next(
        c for c in undone_slip["current_revision"]["document"]["clips"]
        if c["clip_id"] == replaced_audio["clip_id"]
    )
    assert (reverted_audio["source_start_us"], reverted_audio["source_end_us"]) == (0, 8_000_000)


def test_replace_unknown_duration_enforces_minimum_and_safe_source_end(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    _insert_asset(database, "v-min-source", "video", {
        "duration_us": 100_000, "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(database, "v-short-source", "video", {
        "duration_us": 99_999, "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(database, "v-unknown", "video", {
        "duration_us": 0, "video_streams": [{}], "audio_streams": [],
    })

    state = _create(service, {"kind": "full_asset", "asset_id": "v-min-source"})
    clip = state["current_revision"]["document"]["clips"][0]
    assert clip["timeline_end_us"] == 100_000
    state = _patch(service, state, [{
        "op": "replace_clip_source", "clip_id": clip["clip_id"], "asset_id": "v-unknown",
    }])
    clip = state["current_revision"]["document"]["clips"][0]
    assert (clip["source_start_us"], clip["source_end_us"]) == (0, 100_000)
    assert clip["timeline_end_us"] == 100_000

    revision_before_short = state["current_revision"]["timeline_revision_id"]
    with pytest.raises(DomainError) as too_short:
        _patch(service, state, [{
            "op": "replace_clip_source", "clip_id": clip["clip_id"], "asset_id": "v-short-source",
        }])
    assert too_short.value.code == "TIMELINE_SOURCE_INVALID"
    assert service.get_state("p1")["current_revision"]["timeline_revision_id"] == revision_before_short

    long_service, long_database = _service(tmp_path / "long")
    _insert_asset(long_database, "v-huge", "video", {
        "duration_us": 9_007_199_254_740_991, "video_streams": [{}], "audio_streams": [],
    })
    _insert_asset(long_database, "v-unknown", "video", {
        "duration_us": 0, "video_streams": [{}], "audio_streams": [],
    })
    long_state = _create(long_service, {"kind": "full_asset", "asset_id": "v-huge"})
    long_clip = long_state["current_revision"]["document"]["clips"][0]
    long_state = _patch(long_service, long_state, [{
        "op": "set_speed", "clip_id": long_clip["clip_id"], "speed_milli": 4000,
    }])
    revision_before = long_state["current_revision"]["timeline_revision_id"]
    with pytest.raises(DomainError) as overflow:
        _patch(long_service, long_state, [{
            "op": "replace_clip_source", "clip_id": long_clip["clip_id"], "asset_id": "v-unknown",
        }])
    assert overflow.value.code == "TIMELINE_INVALID"
    assert long_service.get_state("p1")["current_revision"]["timeline_revision_id"] == revision_before

    invalid_document = copy.deepcopy(long_state["current_revision"]["document"])
    invalid_clip = invalid_document["clips"][0]
    invalid_clip["asset_id"] = "v-unknown"
    invalid_clip["source_end_us"] = MAX_IMAGE_US + 1
    invalid_clip["timeline_end_us"] = invalid_clip["timeline_start_us"] + _clip_timeline_duration_us(
        invalid_clip["source_start_us"], invalid_clip["source_end_us"], 4000,
    )
    with long_database.connection() as db:
        with pytest.raises(DomainError) as invalid_source_window:
            long_service._normalize_and_validate(
                db,
                invalid_document,
                previous_document=long_state["current_revision"]["document"],
            )
    assert invalid_source_window.value.code == "TIMELINE_INVALID"


def test_split_duplicate_and_bulk_position_are_atomic_core_operations(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    source = state["current_revision"]["document"]["clips"][0]
    copies = [
        {
            "item_kind": "clip", "source_id": source["clip_id"], "copy_id": f"copy_{index}",
            "timeline_start_us": 6_000_000 + index * 5_000_000, "track_id": "V1",
        }
        for index in range(101)
    ]
    state = _patch(service, state, [{"op": "duplicate_timeline_items", "copies": copies}])
    assert len(state["current_revision"]["document"]["clips"]) == 102
    moved = [
        {"clip_id": f"copy_{index}", "timeline_start_us": 6_100_000 + index * 5_000_000, "track_id": "V1"}
        for index in range(101)
    ]
    before_move_revision = state["current_revision"]["timeline_revision_id"]
    state = _patch(service, state, [{"op": "position_clips", "placements": moved}])
    moved_revision = state["current_revision"]["timeline_revision_id"]
    assert next(c for c in state["current_revision"]["document"]["clips"] if c["clip_id"] == "copy_100")["timeline_start_us"] == 506_100_000
    assert moved_revision != before_move_revision

    undone = service.undo("p1", moved_revision)
    assert undone["current_revision"]["timeline_revision_id"] == before_move_revision
    assert next(c for c in undone["current_revision"]["document"]["clips"] if c["clip_id"] == "copy_100")["timeline_start_us"] == 506_000_000
    state = service.redo("p1", before_move_revision)
    assert state["current_revision"]["timeline_revision_id"] == moved_revision

    before_failed_patch = state["current_revision"]["timeline_revision_id"]
    with pytest.raises(DomainError) as failed_bulk:
        _patch(service, state, [
            {"op": "position_clips", "placements": moved},
            {"op": "set_layout", "clip_id": "missing_clip", "layout": "fit"},
        ])
    assert failed_bulk.value.code == "TIMELINE_CLIP_NOT_FOUND"
    unchanged = service.get_state("p1")
    assert unchanged["current_revision"]["timeline_revision_id"] == before_failed_patch
    assert next(c for c in unchanged["current_revision"]["document"]["clips"] if c["clip_id"] == "copy_100")["timeline_start_us"] == 506_100_000

    state = _patch(service, state, [{
        "op": "split_timeline_clips", "clip_ids": [source["clip_id"]], "caption_ids": [],
        "timeline_time_us": 2_500_000,
    }])
    source_halves = [c for c in state["current_revision"]["document"]["clips"] if c["asset_id"] == "v1" and c["timeline_start_us"] < 6_000_000]
    assert len(source_halves) == 2
    assert (source_halves[0]["timeline_start_us"], source_halves[0]["timeline_end_us"]) == (0, 2_500_000)
    assert (source_halves[1]["timeline_start_us"], source_halves[1]["timeline_end_us"]) == (2_500_000, 5_000_000)


def test_duplicate_deleted_clip_snapshot_is_validated_before_reading_fields(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    source = copy.deepcopy(state["current_revision"]["document"]["clips"][0])
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": source["clip_id"]}])

    missing_required = copy.deepcopy(source)
    missing_required.pop("timeline_end_us")
    extra_field = copy.deepcopy(source)
    extra_field["unexpected"] = True
    for copy_id, snapshot in (("bad_clip_missing", missing_required), ("bad_clip_extra", extra_field)):
        with pytest.raises(DomainError) as invalid:
            _patch(service, state, [{
                "op": "duplicate_timeline_items",
                "copies": [{
                    "item_kind": "clip", "source_id": source["clip_id"], "copy_id": copy_id,
                    "timeline_start_us": 6_000_000, "track_id": "V1", "snapshot": snapshot,
                }],
            }])
        assert invalid.value.code == "TIMELINE_INVALID"

    duplicated = _patch(service, state, [{
        "op": "duplicate_timeline_items",
        "copies": [{
            "item_kind": "clip", "source_id": source["clip_id"], "copy_id": "good_clip_copy",
            "timeline_start_us": 6_000_000, "track_id": "V1", "snapshot": source,
        }],
    }])
    clone = duplicated["current_revision"]["document"]["clips"][0]
    assert clone["clip_id"] == "good_clip_copy"
    assert clone["timeline_start_us"] == 6_000_000


def test_duplicate_deleted_caption_snapshot_is_validated_before_reading_fields(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(service, state, [{
        "op": "add_caption", "start_us": 0, "end_us": 300_000, "text": "已删除字幕",
        "preset_id": "default-bottom", "source_clip_id": None,
    }])
    source = copy.deepcopy(state["current_revision"]["document"]["captions"][0])
    state = _patch(service, state, [{"op": "remove_caption", "caption_id": source["caption_id"]}])

    missing_required = copy.deepcopy(source)
    missing_required.pop("end_us")
    extra_field = copy.deepcopy(source)
    extra_field["unexpected"] = True
    invalid_origin = copy.deepcopy(source)
    invalid_origin["origin"] = []
    for copy_id, snapshot in (
        ("bad_caption_missing", missing_required),
        ("bad_caption_extra", extra_field),
        ("bad_caption_origin", invalid_origin),
    ):
        with pytest.raises(DomainError) as invalid:
            _patch(service, state, [{
                "op": "duplicate_timeline_items",
                "copies": [{
                    "item_kind": "caption", "source_id": source["caption_id"], "copy_id": copy_id,
                    "timeline_start_us": 1_000_000, "snapshot": snapshot,
                }],
            }])
        assert invalid.value.code == "TIMELINE_INVALID"

    duplicated = _patch(service, state, [{
        "op": "duplicate_timeline_items",
        "copies": [{
            "item_kind": "caption", "source_id": source["caption_id"], "copy_id": "good_caption_copy",
            "timeline_start_us": 1_000_000, "snapshot": source,
        }],
    }])
    clone = duplicated["current_revision"]["document"]["captions"][0]
    assert clone["caption_id"] == "good_caption_copy"
    assert clone["text"] == "已删除字幕"
    assert clone["start_us"] == 1_000_000


def test_add_track_can_preallocate_and_insert_near_target(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(service, state, [
        {"op": "add_track", "kind": "audio", "track_id": "A2", "audio_index": 0},
        {"op": "add_track", "kind": "video", "track_id": "V2", "before_track_id": "V1"},
    ])
    tracks = state["current_revision"]["document"]["tracks"]
    ids = [item["id"] for item in tracks]
    assert ids.index("V2") < ids.index("V1")
    assert ids.index("A2") == ids.index("A1") + 1


def test_transcript_selection_creates_ordered_clips_and_captions(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    state = _create(
        service,
        {
            "kind": "transcript_selection",
            "transcript_id": "t1",
            "segment_ids": ["s1", "s2"],
            "padding_before_us": 100_000,
            "padding_after_us": 200_000,
            "create_captions": True,
        },
    )
    document = state["current_revision"]["document"]
    assert [clip["order_index"] for clip in document["clips"]] == [0, 1]
    assert document["clips"][0]["source_start_us"] == 400_000
    assert document["clips"][1]["timeline_start_us"] == 1_300_000
    assert [caption["source_segment_ids"] for caption in document["captions"]] == [
        ["s1"],
        ["s2"],
    ]
    assert all(caption["origin"] == "transcript" for caption in document["captions"])
    with database.connection() as db:
        text = db.execute("SELECT text FROM transcript_segments WHERE id='s1'").fetchone()[0]
        assert text == "第一段"


def test_all_clip_patch_operations_and_normalization(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(
        service,
        state,
        [
            {"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000},
            {
                "op": "insert_asset_clip",
                "asset_id": "v2",
                "at_index": 2,
                "source_start_us": 0,
                "source_end_us": 1_000_000,
                "layout": "fit",
            },
        ],
    )
    clips = state["current_revision"]["document"]["clips"]
    image_id, third_id = clips[1]["clip_id"], clips[2]["clip_id"]
    state = _patch(
        service,
        state,
        [
            {"op": "move_clip", "clip_id": third_id, "to_index": 0},
            {
                "op": "trim_clip",
                "clip_id": first_id,
                "source_start_us": 500_000,
                "source_end_us": 4_500_000,
            },
            {"op": "set_layout", "clip_id": first_id, "layout": "crop_fill"},
            {"op": "set_audio", "clip_id": first_id, "enabled": True, "gain_db": -3},
            {"op": "set_image_duration", "clip_id": image_id, "duration_us": 2_000_000},
            {"op": "split_clip", "clip_id": first_id, "source_time_us": 2_500_000},
        ],
    )
    clips = state["current_revision"]["document"]["clips"]
    assert [clip["order_index"] for clip in clips] == list(range(4))
    # 自由定位：move_clip 只改列表顺序不重排时间；变速/裁剪在原位发生，
    # 变长时把后续片段涟漪右推，缩短后留下空隙。
    assert [clip["timeline_start_us"] for clip in clips] == [
        7_000_000,
        500_000,
        2_500_000,
        5_000_000,
    ]
    assert clips[1]["layout"] == "crop_fill"
    assert clips[1]["audio"]["gain_db"] == -3.0
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": image_id}])
    assert len(state["current_revision"]["document"]["clips"]) == 3


def test_roll_and_slip_source_windows_preserve_their_timeline_anchors(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first = state["current_revision"]["document"]["clips"][0]
    state = _patch(service, state, [{"op": "split_clip", "clip_id": first["clip_id"], "source_time_us": 2_500_000}])
    left, right = state["current_revision"]["document"]["clips"]

    state = _patch(service, state, [
        {"op": "set_clip_source_window", "clip_id": left["clip_id"], "source_start_us": 0, "source_end_us": 3_500_000, "anchor": "start"},
        {"op": "set_clip_source_window", "clip_id": right["clip_id"], "source_start_us": 3_500_000, "source_end_us": 5_000_000, "anchor": "end"},
    ])
    left, right = state["current_revision"]["document"]["clips"]
    assert (left["timeline_start_us"], left["timeline_end_us"]) == (0, 3_500_000)
    assert (right["timeline_start_us"], right["timeline_end_us"]) == (3_500_000, 5_000_000)

    state = _patch(service, state, [{
        "op": "set_clip_source_window", "clip_id": left["clip_id"],
        "source_start_us": 500_000, "source_end_us": 4_000_000, "anchor": "timeline",
    }])
    left = state["current_revision"]["document"]["clips"][0]
    assert (left["source_start_us"], left["source_end_us"]) == (500_000, 4_000_000)
    assert (left["timeline_start_us"], left["timeline_end_us"]) == (0, 3_500_000)

    with pytest.raises(DomainError) as outside_asset:
        _patch(service, state, [{
            "op": "set_clip_source_window", "clip_id": left["clip_id"],
            "source_start_us": 500_000, "source_end_us": 5_500_000, "anchor": "start",
        }])
    assert outside_asset.value.code == "TIMELINE_SOURCE_INVALID"


def test_caption_operations_and_clip_linkage(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(
        service,
        {
            "kind": "transcript_selection",
            "transcript_id": "t1",
            "segment_ids": ["s1"],
            "padding_before_us": 0,
            "padding_after_us": 0,
            "create_captions": True,
        },
    )
    document = state["current_revision"]["document"]
    clip_id = document["clips"][0]["clip_id"]
    caption_id = document["captions"][0]["caption_id"]
    state = _patch(
        service,
        state,
        [
            {"op": "update_caption", "caption_id": caption_id, "text": "修正文本"},
            {
                "op": "set_caption_timing",
                "caption_id": caption_id,
                "start_us": 0,
                "end_us": 800_000,
            },
            {"op": "set_caption_preset", "caption_id": caption_id, "preset_id": "high-contrast"},
        ],
    )
    caption = state["current_revision"]["document"]["captions"][0]
    assert (caption["text"], caption["edited"], caption["preset_id"]) == (
        "修正文本",
        True,
        "high-contrast",
    )
    state = _patch(
        service,
        state,
        [{"op": "split_clip", "clip_id": clip_id, "source_time_us": 900_000}],
    )
    assert len(state["current_revision"]["document"]["captions"]) == 2
    left_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    right_id = state["current_revision"]["document"]["clips"][1]["clip_id"]
    state = _patch(
        service,
        state,
        [{"op": "remove_clip", "clip_id": left_id}],
    )
    remaining = state["current_revision"]["document"]["captions"]
    assert len(remaining) == 1
    assert remaining[0]["source_clip_id"] == right_id
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": right_id}])
    assert state["current_revision"]["document"]["captions"] == []
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "i1",
                "at_index": 0,
                "duration_us": 1_000_000,
            }
        ],
    )
    state = _patch(
        service,
        state,
        [
            {
                "op": "add_caption",
                "start_us": 0,
                "end_us": 300_000,
                "text": "手工字幕",
                "preset_id": "game-safe-bottom",
                "source_clip_id": None,
            }
        ],
    )
    manual_id = state["current_revision"]["document"]["captions"][0]["caption_id"]
    state = _patch(service, state, [{"op": "remove_caption", "caption_id": manual_id}])
    assert state["current_revision"]["document"]["captions"] == []


def test_import_captions_batch_replaces_and_validates(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "empty"})
    # 批量导入：乱序条目自动排序；replace_existing 清掉旧手工字幕。
    state = _patch(
        service,
        state,
        [
            {
                "op": "add_caption",
                "start_us": 0,
                "end_us": 300_000,
                "text": "旧字幕",
                "preset_id": "default-bottom",
                "source_clip_id": None,
            },
            {
                "op": "import_captions",
                "entries": [
                    {"start_us": 1_000_000, "end_us": 1_500_000, "text": "第二句"},
                    {"start_us": 0, "end_us": 800_000, "text": "第一句"},
                ],
                "preset_id": "default-bottom",
                "replace_existing": True,
            },
        ],
    )
    captions = state["current_revision"]["document"]["captions"]
    assert [c["text"] for c in captions] == ["第一句", "第二句"]
    assert all(c["origin"] == "user" and c["track_id"] == "C1" for c in captions)
    # 时间重叠拒绝（原子回滚，上一状态不变）。
    with pytest.raises(DomainError):
        _patch(
            service,
            state,
            [
                {
                    "op": "import_captions",
                    "entries": [
                        {"start_us": 0, "end_us": 1_000_000, "text": "a"},
                        {"start_us": 500_000, "end_us": 1_200_000, "text": "b"},
                    ],
                    "preset_id": "default-bottom",
                    "replace_existing": False,
                }
            ],
        )
    # 条目时长不足 0.2s 拒绝。
    with pytest.raises(DomainError):
        _patch(
            service,
            state,
            [
                {
                    "op": "import_captions",
                    "entries": [{"start_us": 0, "end_us": 100_000, "text": "短"}],
                    "preset_id": "default-bottom",
                    "replace_existing": False,
                }
            ],
        )


def test_patch_is_atomic_conflict_navigation_branch_and_draft(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    base = state["current_revision"]["timeline_revision_id"]
    document = copy.deepcopy(state["current_revision"]["document"])
    draft = service.save_draft(
        "p1", {"schema_version": 1, "base_revision_id": base, "document": document}
    )
    assert draft["conflict"] is False
    with pytest.raises(DomainError) as failed:
        _patch(
            service,
            state,
            [
                {"op": "set_layout", "clip_id": document["clips"][0]["clip_id"], "layout": "fit"},
                {"op": "set_layout", "clip_id": "missing", "layout": "fit"},
            ],
        )
    assert failed.value.code == "TIMELINE_CLIP_NOT_FOUND"
    with database.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM timeline_revisions").fetchone()[0] == 1
    state2 = _patch(
        service,
        state,
        [{"op": "set_layout", "clip_id": document["clips"][0]["clip_id"], "layout": "fit"}],
    )
    assert service.get_state("p1")["draft"]["conflict"] is True
    with pytest.raises(DomainError) as conflict:
        _patch(service, state, [{"op": "remove_clip", "clip_id": document["clips"][0]["clip_id"]}])
    assert conflict.value.code == "TIMELINE_CONFLICT"
    state1 = service.undo("p1", state2["current_revision"]["timeline_revision_id"])
    assert state1["current_revision"]["timeline_revision_id"] == base
    assert state1["can_redo"] is True
    redone = service.redo("p1", base)
    assert redone["current_revision"]["timeline_revision_id"] == (
        state2["current_revision"]["timeline_revision_id"]
    )
    back = service.undo("p1", redone["current_revision"]["timeline_revision_id"])
    branch = _patch(
        service,
        back,
        [{"op": "set_layout", "clip_id": document["clips"][0]["clip_id"], "layout": "crop_fill"}],
    )
    assert branch["can_redo"] is False
    with pytest.raises(DomainError) as draft_conflict:
        service.save_draft(
            "p1", {"schema_version": 1, "base_revision_id": base, "document": document}
        )
    assert draft_conflict.value.code == "TIMELINE_DRAFT_CONFLICT"
    service.delete_draft("p1")
    assert service.get_state("p1")["draft"] is None


def test_insert_transcript_patch_and_validation_limits(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_transcript_segments",
                "transcript_id": "t1",
                "segment_ids": ["s2"],
                "at_index": 0,
                "padding_before_us": 100_000,
                "padding_after_us": 100_000,
                "create_captions": True,
                "layout": "fit",
            }
        ],
    )
    assert state["current_revision"]["document"]["clips"][0]["layout"] == "fit"
    with pytest.raises(DomainError) as too_many:
        _patch(service, state, [{"op": "remove_clip", "clip_id": "x"}] * 101)
    assert too_many.value.code == "TIMELINE_INVALID"
    with pytest.raises(DomainError) as bad_text:
        _patch(
            service,
            state,
            [
                {
                    "op": "add_caption",
                    "start_us": 0,
                    "end_us": 300_000,
                    "text": "bad\x00text",
                    "preset_id": "default-bottom",
                    "source_clip_id": None,
                }
            ],
        )
    assert bad_text.value.code == "TIMELINE_INVALID"


def test_revision_listing_trimmed_caption_and_invalid_draft_shape(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(
        service,
        {
            "kind": "transcript_selection",
            "transcript_id": "t1",
            "segment_ids": ["s1"],
            "padding_before_us": 200_000,
            "padding_after_us": 200_000,
            "create_captions": True,
        },
    )
    revision_id = state["current_revision"]["timeline_revision_id"]
    assert service.get_revision(revision_id)["timeline_revision_id"] == revision_id
    items, cursor = service.list_revisions("p1", limit=1)
    assert items[0]["timeline_revision_id"] == revision_id
    assert "document_sha256" in items[0]
    assert "schema_version" not in items[0]
    assert cursor == "1"
    clip = state["current_revision"]["document"]["clips"][0]
    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": clip["clip_id"],
                "source_start_us": 500_000,
                "source_end_us": 1_300_000,
            }
        ],
    )
    caption = state["current_revision"]["document"]["captions"][0]
    # 自由定位：裁剪后片段窗口为 [200ms, 1s)，绑定字幕钳制进该窗口。
    assert (caption["start_us"], caption["end_us"]) == (200_000, 1_000_000)
    invalid = copy.deepcopy(state["current_revision"]["document"])
    invalid["ui_x"] = 10
    with pytest.raises(DomainError) as bad_draft:
        service.save_draft(
            "p1",
            {
                "schema_version": 1,
                "base_revision_id": state["current_revision"]["timeline_revision_id"],
                "document": invalid,
            },
        )
    assert bad_draft.value.code == "TIMELINE_INVALID"
    with pytest.raises(DomainError):
        service.list_revisions("p1", cursor="bad")


def test_audio_clip_insert_appends_to_a1(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    # 多轨道规范序（自上而下）：动态轨区 + C1 + V1 + A1；A1 恒存在。
    assert [track["id"] for track in state["current_revision"]["document"]["tracks"]] == [
        "C1",
        "V1",
        "A1",
    ]


def test_track_management_add_remove_move_and_flags(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    video_id = state["current_revision"]["document"]["clips"][0]["clip_id"]

    # 新增轨道插入到 C1 之上（动态区域底部）；视频轨 V2、文本轨 T1。
    state = _patch(
        service,
        state,
        [{"op": "add_track", "kind": "video"}, {"op": "add_track", "kind": "text"}],
    )
    tracks = state["current_revision"]["document"]["tracks"]
    assert [track["id"] for track in tracks] == ["V2", "T1", "C1", "V1", "A1"]
    assert [track["kind"] for track in tracks[:2]] == ["video", "text"]

    # 跨轨移动：V1 → V2（同类型轨道）。
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 0, "track_id": "V2"}],
    )
    moved = next(
        clip for clip in state["current_revision"]["document"]["clips"] if clip["clip_id"] == video_id
    )
    assert moved["track_id"] == "V2"

    # 换位：T1 移到动态区域顶部。
    state = _patch(service, state, [{"op": "move_track", "track_id": "T1", "to_index": 0}])
    assert [track["id"] for track in state["current_revision"]["document"]["tracks"]][:2] == ["T1", "V2"]

    # 轨道标志：隐藏/静音/独奏/锁定一次设置。
    state = _patch(
        service,
        state,
        [{"op": "set_track_flags", "track_id": "V2", "hidden": True, "muted": True, "solo": True, "locked": True}],
    )
    v2 = next(track for track in state["current_revision"]["document"]["tracks"] if track["id"] == "V2")
    assert (v2["hidden"], v2["muted"], v2["solo"], v2["locked"]) == (True, True, True, True)

    # 锁定轨道上的片段不可再操作；解锁由 set_track_flags 自身完成。
    with pytest.raises(DomainError) as locked_track:
        _patch(
            service,
            state,
            [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 1_000_000}],
        )
    assert locked_track.value.code == "TIMELINE_LOCKED"
    state = _patch(service, state, [{"op": "set_track_flags", "track_id": "V2", "locked": False}])

    # 类型约束：文本轨不支持静音；动态音频轨可创建；音频片段不可上文本轨。
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_track_flags", "track_id": "T1", "muted": True}])
    state = _patch(service, state, [{"op": "add_track", "kind": "audio", "track_id": "A2", "audio_index": 0}])
    assert any(track["id"] == "A2" for track in state["current_revision"]["document"]["tracks"])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 0, "track_id": "T1"}])

    # 删除动态轨道：其上片段级联删除；固定轨道不可删。
    state = _patch(service, state, [{"op": "remove_track", "track_id": "V2"}])
    assert all(clip["clip_id"] != video_id for clip in state["current_revision"]["document"]["clips"])
    assert all(track["id"] != "V2" for track in state["current_revision"]["document"]["tracks"])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "remove_track", "track_id": "V1"}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "move_track", "track_id": "A1", "to_index": 0}])

    # 文本轨与动态轨一致：可删除（删后 V1/A1 尾部结构仍合法），可重建。
    state = _patch(service, state, [{"op": "remove_track", "track_id": "C1"}])
    remaining_ids = [track["id"] for track in state["current_revision"]["document"]["tracks"]]
    assert remaining_ids[-3:] == ["V1", "A1", "A2"]
    assert "C1" not in remaining_ids
    state = _patch(service, state, [{"op": "add_track", "kind": "text"}])
    rebuilt_ids = [track["id"] for track in state["current_revision"]["document"]["tracks"]]
    # 新文本轨编号递增（不复用已删 id），插入到 V1 之前。
    assert rebuilt_ids[-4].startswith("T") and rebuilt_ids[-3:] == ["V1", "A1", "A2"]


def test_alt_overwrite_replaces_the_range_and_preserves_uncovered_video_and_audio(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    original_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "v2", "at_index": 0,
        "track_id": "V1", "timeline_start_us": 2_000_000, "edit_mode": "overwrite",
    }])
    clips = state["current_revision"]["document"]["clips"]
    video = sorted((clip for clip in clips if clip["track_id"] == "V1"), key=lambda clip: clip["timeline_start_us"])
    assert [(clip["timeline_start_us"], clip["timeline_end_us"]) for clip in video] == [
        (0, 2_000_000), (2_000_000, 4_000_000), (4_000_000, 5_000_000),
    ]
    assert [clip["order_index"] for clip in video] == [0, 1, 2]
    assert video[0]["clip_id"] == original_id
    assert (video[0]["source_start_us"], video[0]["source_end_us"]) == (0, 2_000_000)
    assert (video[2]["source_start_us"], video[2]["source_end_us"]) == (4_000_000, 5_000_000)
    assert video[1]["asset_id"] == "v2"

    # A1 uses the same overwrite range semantics and keeps the uncovered left side.
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}])
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "a1", "at_index": 0,
        "timeline_start_us": 2_000_000, "edit_mode": "overwrite",
    }])
    audio = sorted(
        (clip for clip in state["current_revision"]["document"]["clips"] if clip["track_id"] == "A1"),
        key=lambda clip: clip["timeline_start_us"],
    )
    assert [(clip["timeline_start_us"], clip["timeline_end_us"]) for clip in audio] == [
        (0, 2_000_000), (2_000_000, 10_000_000),
    ]


def test_asset_insert_uses_pointer_time_and_ripples_linked_successors_once(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "track_id": "V1",
        "timeline_start_us": 7_000_000, "edit_mode": "place",
    }])
    video = next(clip for clip in state["current_revision"]["document"]["clips"] if clip["asset_id"] == "v2")
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "a1", "at_index": 1, "track_id": "A1",
        "timeline_start_us": 7_000_000, "edit_mode": "place",
    }])
    audio = next(clip for clip in state["current_revision"]["document"]["clips"] if clip["asset_id"] == "a1")
    state = _patch(service, state, [{"op": "set_clip_link", "clip_ids": [video["clip_id"], audio["clip_id"]]}])

    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "track_id": "V1",
        "timeline_start_us": 5_000_000, "edit_mode": "insert", "linkage_enabled": True,
    }])
    clips = state["current_revision"]["document"]["clips"]
    placed_video = sorted((clip for clip in clips if clip["track_id"] == "V1"), key=lambda clip: clip["timeline_start_us"])
    assert [(clip["timeline_start_us"], clip["timeline_end_us"]) for clip in placed_video] == [
        (0, 5_000_000), (5_000_000, 7_000_000), (9_000_000, 11_000_000),
    ]
    shifted_audio = next(clip for clip in clips if clip["clip_id"] == audio["clip_id"])
    assert (shifted_audio["timeline_start_us"], shifted_audio["timeline_end_us"]) == (9_000_000, 17_000_000)


def test_asset_insert_rejects_a_pointer_inside_an_existing_clip(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    with pytest.raises(DomainError) as exc:
        _patch(service, state, [{
            "op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "track_id": "V1",
            "timeline_start_us": 2_000_000, "edit_mode": "insert",
        }])
    assert exc.value.code == "TIMELINE_INVALID"


def test_alt_overwrite_refuses_locked_linked_but_reprojects_transition_bound_content(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    replacement = {"op": "insert_asset_clip", "asset_id": "v2", "at_index": 0,
                   "track_id": "V1", "timeline_start_us": 1_000_000, "edit_mode": "overwrite"}

    locked = _patch(service, state, [{"op": "set_clip_locked", "clip_id": clip_id, "locked": True}])
    with pytest.raises(DomainError) as locked_error:
        _patch(service, locked, [replacement])
    assert locked_error.value.code == "TIMELINE_LOCKED"

    linked = _patch(service, locked, [
        {"op": "set_clip_locked", "clip_id": clip_id, "locked": False},
        {"op": "detach_audio", "clip_id": clip_id},
    ])
    with pytest.raises(DomainError) as linked_error:
        _patch(service, linked, [replacement])
    assert linked_error.value.code == "TIMELINE_LINKED"

    unlinked = _patch(service, linked, [{"op": "clear_clip_link", "clip_id": clip_id}])
    adjacent = _patch(service, unlinked, [
        {"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000},
    ])
    with_transition = _patch(service, adjacent, [
        {"op": "add_transition", "after_clip_id": clip_id, "kind": "fade", "duration_us": 500_000},
    ])
    fixed_incoming = with_transition["current_revision"]["document"]["transitions"][0]["incoming_clip_id"]
    overwritten = _patch(service, with_transition, [replacement])
    compat = overwritten["current_revision"]["document"]["transitions"]
    assert len(compat) == 1
    assert compat[0]["incoming_clip_id"] == fixed_incoming


def test_position_clips_moves_writable_link_member_and_leaves_locked_partner(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    video_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    document = state["current_revision"]["document"]
    audio = next(clip for clip in document["clips"] if clip["asset_kind"] == "audio")
    assert document["clips"][0]["link_group_id"] == audio["link_group_id"]

    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": audio["clip_id"], "locked": True}])
    moved = _patch(service, state, [{
        "op": "position_clips",
        "placements": [{"clip_id": video_id, "timeline_start_us": 1_000_000}],
    }])
    clips = {clip["clip_id"]: clip for clip in moved["current_revision"]["document"]["clips"]}
    assert clips[video_id]["timeline_start_us"] == 1_000_000
    assert clips[audio["clip_id"]]["timeline_start_us"] == 0
    assert clips[video_id]["link_group_id"] == clips[audio["clip_id"]]["link_group_id"]


def test_audio_insert_appends_to_a1_with_free_positions(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}],
    )
    document = state["current_revision"]["document"]
    assert any(track["id"] == "A1" and track["kind"] == "audio" for track in document["tracks"])
    audio_clips = [c for c in document["clips"] if c["track_id"] == "A1"]
    assert len(audio_clips) == 1
    audio = audio_clips[0]
    assert (audio["asset_kind"], audio["timeline_start_us"], audio["timeline_end_us"]) == (
        "audio",
        0,
        8_000_000,
    )
    assert audio["order_index"] == 0
    # A second audio clip appends after the first, keeping A1 positions free.
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}],
    )
    audio_clips = [
        c
        for c in state["current_revision"]["document"]["clips"]
        if c["track_id"] == "A1"
    ]
    assert [c["timeline_start_us"] for c in audio_clips] == [0, 8_000_000]
    assert [c["order_index"] for c in audio_clips] == [0, 1]
    # V1 packing is untouched by audio inserts.
    video_clips = [
        c
        for c in state["current_revision"]["document"]["clips"]
        if c["track_id"] == "V1"
    ]
    assert [(c["timeline_start_us"], c["timeline_end_us"]) for c in video_clips] == [(0, 5_000_000)]


def test_position_clip_moves_audio_and_video_freely_but_rejects_overlaps(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}],
    )
    document = state["current_revision"]["document"]
    audio_id = next(c["clip_id"] for c in document["clips"] if c["track_id"] == "A1")
    video_id = next(c["clip_id"] for c in document["clips"] if c["track_id"] == "V1")

    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": audio_id, "timeline_start_us": 12_500_000}],
    )
    audio = next(c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1")
    assert (audio["timeline_start_us"], audio["timeline_end_us"]) == (12_500_000, 20_500_000)
    assert audio["order_index"] == 0
    # Normalization preserves the free position.
    state = _patch(
        service,
        state,
        [{"op": "set_layout", "clip_id": video_id, "layout": "fit"}],
    )
    audio = next(
        c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1"
    )
    assert (audio["timeline_start_us"], audio["timeline_end_us"]) == (12_500_000, 20_500_000)

    # V1 视频片段同样可以自由定位（可留空隙），时长保持不变。
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 1_000_000}],
    )
    video = next(c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "V1")
    assert (video["timeline_start_us"], video["timeline_end_us"]) == (1_000_000, 6_000_000)
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 0}],
    )
    video = next(c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "V1")
    assert (video["timeline_start_us"], video["timeline_end_us"]) == (0, 5_000_000)

    # 与同轨其他片段重叠被拒绝。
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v2",
                "at_index": 1,
                "source_start_us": 0,
                "source_end_us": 1_000_000,
            }
        ],
    )
    second_video_id = next(
        c["clip_id"]
        for c in state["current_revision"]["document"]["clips"]
        if c["track_id"] == "V1" and c["clip_id"] != video_id
    )
    with pytest.raises(DomainError) as overlap:
        _patch(
            service,
            state,
            [{"op": "position_clip", "clip_id": second_video_id, "timeline_start_us": 1_000_000}],
        )
    assert overlap.value.code == "TIMELINE_INVALID"
    # 紧贴（首尾相接）是允许的。
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": second_video_id, "timeline_start_us": 5_000_000}],
    )
    moved = next(
        c for c in state["current_revision"]["document"]["clips"] if c["clip_id"] == second_video_id
    )
    assert (moved["timeline_start_us"], moved["timeline_end_us"]) == (5_000_000, 6_000_000)
    with pytest.raises(DomainError) as negative:
        _patch(
            service,
            state,
            [{"op": "position_clip", "clip_id": audio_id, "timeline_start_us": -1}],
        )
    assert negative.value.code == "TIMELINE_INVALID"


def test_trim_audio_clip_keeps_opposite_edge_fixed(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}],
    )
    audio = state["current_revision"]["document"]["clips"][0]
    assert audio["track_id"] == "A1"

    # Left trim: right edge (timeline_end) stays fixed, timeline_start moves right.
    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": audio["clip_id"],
                "source_start_us": 2_000_000,
                "source_end_us": 8_000_000,
            }
        ],
    )
    audio = state["current_revision"]["document"]["clips"][0]
    assert (audio["source_start_us"], audio["source_end_us"]) == (2_000_000, 8_000_000)
    assert (audio["timeline_start_us"], audio["timeline_end_us"]) == (2_000_000, 8_000_000)

    # Right trim: left edge stays fixed, timeline_end moves left.
    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": audio["clip_id"],
                "source_start_us": 2_000_000,
                "source_end_us": 5_000_000,
            }
        ],
    )
    audio = state["current_revision"]["document"]["clips"][0]
    assert (audio["source_start_us"], audio["source_end_us"]) == (2_000_000, 5_000_000)
    assert (audio["timeline_start_us"], audio["timeline_end_us"]) == (2_000_000, 5_000_000)

    # OpenFilm can extend back into the source room outside the current clip window.
    state = _patch(
        service,
        state,
        [{
            "op": "trim_clip",
            "clip_id": audio["clip_id"],
            "source_start_us": 1_000_000,
            "source_end_us": 5_000_000,
        }],
    )
    audio = state["current_revision"]["document"]["clips"][0]
    assert (audio["timeline_start_us"], audio["timeline_end_us"]) == (1_000_000, 5_000_000)
    with pytest.raises(DomainError) as beyond_source:
        _patch(service, state, [{
            "op": "trim_clip",
            "clip_id": audio["clip_id"],
            "source_start_us": 1_000_000,
            "source_end_us": 9_000_000,
        }])
    assert beyond_source.value.code == "TIMELINE_SOURCE_INVALID"
    with pytest.raises(DomainError) as too_short:
        _patch(
            service,
            state,
            [
                {
                    "op": "trim_clip",
                    "clip_id": audio["clip_id"],
                    "source_start_us": 1_000_000,
                    "source_end_us": 1_050_000,
                }
            ],
        )
    assert too_short.value.code == "TIMELINE_INVALID"


def test_audio_and_video_tracks_coexist_with_independent_normalization(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(
        service,
        state,
        [
            {"op": "insert_asset_clip", "asset_id": "v1", "at_index": 0},
            {"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0},
            {"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0},
        ],
    )
    document = state["current_revision"]["document"]
    audio_ids = [c["clip_id"] for c in document["clips"] if c["track_id"] == "A1"]
    video_id = next(c["clip_id"] for c in document["clips"] if c["track_id"] == "V1")

    state = _patch(
        service,
        state,
        [
            {"op": "position_clip", "clip_id": audio_ids[1], "timeline_start_us": 3_000_000},
            {
                "op": "trim_clip",
                "clip_id": video_id,
                "source_start_us": 500_000,
                "source_end_us": 4_000_000,
            },
        ],
    )
    document = state["current_revision"]["document"]
    video = next(c for c in document["clips"] if c["track_id"] == "V1")
    # 自由定位：V1 裁剪原位发生（左缘右移、右缘固定），不再重打包回零。
    assert (video["timeline_start_us"], video["timeline_end_us"]) == (500_000, 4_000_000)
    audio_by_id = {c["clip_id"]: c for c in document["clips"] if c["track_id"] == "A1"}
    assert (
        audio_by_id[audio_ids[0]]["timeline_start_us"],
        audio_by_id[audio_ids[0]]["timeline_end_us"],
    ) == (0, 8_000_000)
    assert (
        audio_by_id[audio_ids[1]]["timeline_start_us"],
        audio_by_id[audio_ids[1]]["timeline_end_us"],
    ) == (3_000_000, 11_000_000)
    assert [c["order_index"] for c in document["clips"] if c["track_id"] == "A1"] == [0, 1]
    # Moving an audio clip reports a "moved" diff entry.
    base = state["current_revision"]
    moved = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": audio_ids[1], "timeline_start_us": 20_000_000}],
    )
    diff = service.compare_revisions(
        "p1",
        base["timeline_revision_id"],
        moved["current_revision"]["timeline_revision_id"],
    )
    assert {"type": "moved", "clip_id": audio_ids[1]} in diff["clip_changes"]


def test_set_speed_rescales_v1_timeline_and_later_clips(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v2",
                "at_index": 1,
                "source_start_us": 0,
                "source_end_us": 2_000_000,
            },
        ],
    )
    second_id = state["current_revision"]["document"]["clips"][1]["clip_id"]

    # 0.5x：5s 视频变 10s，后续片段整体后移。
    state = _patch(service, state, [{"op": "set_speed", "clip_id": first_id, "speed_milli": 500}])
    clips = state["current_revision"]["document"]["clips"]
    assert (clips[0]["timeline_start_us"], clips[0]["timeline_end_us"]) == (0, 10_000_000)
    assert (clips[1]["timeline_start_us"], clips[1]["timeline_end_us"]) == (10_000_000, 12_000_000)
    assert clips[0]["speed_milli"] == 500

    # 恢复原速 + 加速：4x 时 5s 视频 → 1.25s。
    # 自由定位：缩短后不再自动合拢，v2 保持在被推开的 10s 位置。
    state = _patch(service, state, [{"op": "set_speed", "clip_id": first_id, "speed_milli": 1000}])
    clips = state["current_revision"]["document"]["clips"]
    assert (clips[0]["timeline_start_us"], clips[0]["timeline_end_us"]) == (0, 5_000_000)
    assert clips[1]["timeline_start_us"] == 10_000_000
    state = _patch(service, state, [{"op": "set_speed", "clip_id": second_id, "speed_milli": 4000}])
    clips = state["current_revision"]["document"]["clips"]
    assert (clips[1]["timeline_start_us"], clips[1]["timeline_end_us"]) == (10_000_000, 10_500_000)

    # 变短后的空隙可以通过 position_clip 重新贴回（自由定位语义）。
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": second_id, "timeline_start_us": 5_000_000}],
    )
    clips = state["current_revision"]["document"]["clips"]
    assert (clips[1]["timeline_start_us"], clips[1]["timeline_end_us"]) == (5_000_000, 5_500_000)

    # 变速操作进入 diff。
    base = _patch(
        service,
        state,
        [{"op": "set_speed", "clip_id": second_id, "speed_milli": 1000}],
    )
    diff = service.compare_revisions(
        "p1",
        state["current_revision"]["timeline_revision_id"],
        base["current_revision"]["timeline_revision_id"],
    )
    assert any(change["type"] == "speed_changed" for change in diff["clip_changes"])


def test_set_speed_on_a1_clip_keeps_right_edge_fixed(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "a1"})
    audio_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": audio_id, "timeline_start_us": 2_000_000}],
    )
    base_end = state["current_revision"]["document"]["clips"][0]["timeline_end_us"]
    assert base_end == 10_000_000

    # 2x：时长减半，右缘不动、左缘平移。
    state = _patch(service, state, [{"op": "set_speed", "clip_id": audio_id, "speed_milli": 2000}])
    clip = state["current_revision"]["document"]["clips"][0]
    assert (clip["timeline_start_us"], clip["timeline_end_us"]) == (6_000_000, 10_000_000)
    assert clip["source_start_us"] == 0 and clip["source_end_us"] == 8_000_000


def test_set_reverse_playback_only_applies_to_video_and_reports_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    video_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    base = state["current_revision"]
    state = _patch(
        service,
        state,
        [{"op": "set_reverse_playback", "clip_id": video_id, "reverse_playback": True}],
    )
    assert state["current_revision"]["document"]["clips"][0]["reverse_playback"] is True
    diff = service.compare_revisions(
        "p1",
        base["timeline_revision_id"],
        state["current_revision"]["timeline_revision_id"],
    )
    assert {"type": "reverse_toggled", "clip_id": video_id} in diff["clip_changes"]


def test_set_speed_rejects_out_of_range_values_and_image_clips(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    video_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    for bad in (99, 100_001):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_speed", "clip_id": video_id, "speed_milli": bad}])

    for speed in (100, 100_000):
        state = _patch(service, state, [{"op": "set_speed", "clip_id": video_id, "speed_milli": speed}])
        assert state["current_revision"]["document"]["clips"][0]["speed_milli"] == speed

    image_state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 0, "duration_us": 1_000_000}],
    )
    image_id = image_state["current_revision"]["document"]["clips"][0]["clip_id"]
    with pytest.raises(DomainError):
        _patch(service, image_state, [{"op": "set_speed", "clip_id": image_id, "speed_milli": 2000}])


def test_insert_asset_clip_carries_speed_and_reverse(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    # 插入携带 4x + 倒放的视频；timeline 时长按插入时速度推导。
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v2",
                "at_index": 1,
                "source_start_us": 0,
                "source_end_us": 2_000_000,
                "speed_milli": 4000,
                "reverse_playback": True,
            },
        ],
    )
    clips = state["current_revision"]["document"]["clips"]
    assert clips[0]["clip_id"] == first_id
    assert (clips[0]["timeline_start_us"], clips[0]["timeline_end_us"]) == (0, 5_000_000)
    assert clips[1]["speed_milli"] == 4000
    assert clips[1]["reverse_playback"] is True
    assert (clips[1]["timeline_start_us"], clips[1]["timeline_end_us"]) == (5_000_000, 5_500_000)

    # 图片携带变速被拒；倒放非视频被拒。
    with pytest.raises(DomainError):
        _patch(
            service,
            state,
            [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 0, "duration_us": 1_000_000, "speed_milli": 2000}],
        )
    with pytest.raises(DomainError):
        _patch(
            service,
            state,
            [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0, "reverse_playback": True}],
        )
    # 越界速度被拒。
    with pytest.raises(DomainError):
        _patch(
            service,
            state,
            [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 0, "source_start_us": 0, "source_end_us": 1_000_000, "speed_milli": 100_001}],
        )


def test_transitions_add_update_remove_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 2_000_000}],
    )
    base = state["current_revision"]

    # 添加：合法路径。
    state = _patch(
        service,
        state,
        [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 500_000}],
    )
    transitions = state["current_revision"]["document"]["transitions"]
    assert len(transitions) == 1
    assert transitions[0]["after_clip_id"] == first_id
    assert transitions[0]["kind"] == "fade"
    assert transitions[0]["duration_us"] == 500_000
    transition_id = transitions[0]["transition_id"]

    # 重复添加同锚点被拒。
    with pytest.raises(DomainError) as duplicate:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "dissolve", "duration_us": 300_000}])
    assert duplicate.value.code == "TIMELINE_TRANSITION_EXISTS"

    # 时长越界被拒；非法类型被拒；A1 片段锚点被拒（无 A1 相邻视频后继场景，用不存在 id 更直接）。
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 50_000}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 3_000_000}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "circleopen", "duration_us": 500_000}])

    # 更新：改类型与时长。
    after_add = state["current_revision"]
    state = _patch(
        service,
        state,
        [{"op": "update_transition", "transition_id": transition_id, "kind": "zoomin", "duration_us": 1_000_000}],
    )
    updated = state["current_revision"]["document"]["transitions"][0]
    assert (updated["kind"], updated["duration_us"]) == ("zoomin", 1_000_000)

    # diff：base→add 后为 added；add 后→update 后为 updated；summary 计数一致。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], after_add["timeline_revision_id"])
    assert [item["type"] for item in diff["transition_changes"]] == ["added"]
    assert diff["summary"]["transition_changes"] == 1
    diff_updated = service.compare_revisions("p1", after_add["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert [item["type"] for item in diff_updated["transition_changes"]] == ["updated"]
    assert diff_updated["summary"]["transition_changes"] == 1

    # 删除。
    state = _patch(service, state, [{"op": "remove_transition", "transition_id": transition_id}])
    assert state["current_revision"]["document"]["transitions"] == []
    diff_removed = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert diff_removed["transition_changes"] == []


def test_set_clip_transition_facts_validation_normalization_and_projection(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    outgoing = state["current_revision"]["document"]["clips"][0]
    state = _patch(service, state, [{
        "op": "add_track", "kind": "video", "track_id": "V2",
    }])
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "v2", "at_index": 1,
        "source_start_us": 0, "source_end_us": 2_000_000, "track_id": "V2",
        "timeline_start_us": 4_000_000, "edit_mode": "overwrite",
    }])
    incoming = next(clip for clip in state["current_revision"]["document"]["clips"] if clip["track_id"] == "V2")
    state = _patch(service, state, [
        {"op": "set_clip_transition_facts", "clip_id": outgoing["clip_id"], "picture_fade_out_us": 1_000_000},
        {"op": "set_clip_transition_facts", "clip_id": incoming["clip_id"], "picture_fade_in_us": 1_000_000},
    ])
    active = state["active_transitions"]
    assert len(active) == 1
    assert (active[0]["outgoing_clip_id"], active[0]["incoming_clip_id"], active[0]["kind"]) == (
        outgoing["clip_id"], incoming["clip_id"], "dissolve",
    )
    stable_id = active[0]["transition_id"]

    # The projector is final-layout based, and stable identity follows the clip pair.
    state = _patch(service, state, [{
        "op": "position_clip", "clip_id": incoming["clip_id"], "timeline_start_us": 4_010_000,
    }])
    assert state["active_transitions"] == []
    document = state["current_revision"]["document"]
    saved_incoming = next(clip for clip in document["clips"] if clip["clip_id"] == incoming["clip_id"])
    assert saved_incoming["picture_fade_in_us"] == 1_000_000
    state = _patch(service, state, [{
        "op": "position_clip", "clip_id": incoming["clip_id"], "timeline_start_us": 4_000_000,
    }])
    assert state["active_transitions"][0]["transition_id"] == stable_id

    # Omitted fields preserve; null/zero clear; motion IDs are pinned and durations are bounded.
    state = _patch(service, state, [{
        "op": "set_clip_transition_facts", "clip_id": incoming["clip_id"],
        "move_in": {"preset_id": "motions/move-push-left", "duration_us": 1_000_000},
    }])
    changed = next(clip for clip in state["current_revision"]["document"]["clips"] if clip["clip_id"] == incoming["clip_id"])
    assert changed["picture_fade_in_us"] == 1_000_000
    assert changed["move_in"] == {"preset_id": "motions/move-push-left", "duration_us": 1_000_000}
    state = _patch(service, state, [{
        "op": "set_clip_transition_facts", "clip_id": incoming["clip_id"],
        "picture_fade_in_us": 0, "move_in": None,
    }])
    changed = next(clip for clip in state["current_revision"]["document"]["clips"] if clip["clip_id"] == incoming["clip_id"])
    assert "picture_fade_in_us" not in changed and "move_in" not in changed

    revision_before_bad_patch = state["current_revision"]["timeline_revision_id"]
    invalid_ops = [
        {"op": "set_clip_transition_facts", "clip_id": incoming["clip_id"], "move_in": {"preset_id": "made-up", "duration_us": 100_000}},
        {"op": "set_clip_transition_facts", "clip_id": incoming["clip_id"], "move_out": {"preset_id": "motions/move-push-left", "duration_us": 3_000_000}},
        {"op": "set_clip_transition_facts", "clip_id": incoming["clip_id"], "picture_fade_in_us": 1_500_000, "picture_fade_out_us": 1_000_000},
        {"op": "set_clip_transition_facts", "clip_id": incoming["clip_id"]},
    ]
    for operation in invalid_ops:
        with pytest.raises(DomainError):
            _patch(service, state, [operation])
        assert service.get_state("p1")["current_revision"]["timeline_revision_id"] == revision_before_bad_patch

    audio_service = _service(tmp_path / "audio-again")[0]
    audio_state = _create(audio_service, {"kind": "full_asset", "asset_id": "a1"})
    audio_id = audio_state["current_revision"]["document"]["clips"][0]["clip_id"]
    with pytest.raises(DomainError):
        _patch(audio_service, audio_state, [{"op": "set_clip_transition_facts", "clip_id": audio_id, "picture_fade_in_us": 100_000}])


def test_final_transition_projector_matches_move_dip_white_rest_and_linked_audio_dedup() -> None:
    def clip(
        clip_id: str, track_id: str, start: int, end: int, kind: str, asset_id: str,
        *, source_start: int | None = None, source_end: int | None = None, **extra: object,
    ) -> dict:
        return {
            "clip_id": clip_id, "track_id": track_id, "timeline_start_us": start,
            "timeline_end_us": end, "asset_kind": kind, "asset_id": asset_id,
            "source_start_us": source_start, "source_end_us": source_end, **extra,
        }

    tracks = [{"id": "V2"}, {"id": "V1"}, {"id": "V3"}, {"id": "A1"}, {"id": "A2"}]
    out = clip("out", "V1", 0, 5_000_000, "video", "picture", source_start=0, source_end=5_000_000,
               picture_fade_out_us=1_000_000, link_group_id="out-link")
    head = clip("head", "V2", 4_000_000, 6_000_000, "video", "picture", source_start=1_000_000, source_end=3_000_000,
                picture_fade_in_us=1_000_000, link_group_id="in-link")
    rest = clip("rest", "V3", 6_000_000, 8_000_000, "video", "picture", source_start=3_000_000, source_end=5_000_000,
                link_group_id="in-link")
    audio_out = clip("audio-out", "A1", 0, 5_000_000, "audio", "sound", source_start=0, source_end=5_000_000,
                     audio={"enabled": True, "gain_db": 0.0, "fade_out_us": 1_000_000}, link_group_id="out-link")
    audio_in = clip("audio-in", "A2", 4_000_000, 6_000_000, "audio", "sound", source_start=1_000_000, source_end=3_000_000,
                    audio={"enabled": True, "gain_db": 0.0, "fade_in_us": 1_000_000}, link_group_id="in-link")
    document = {"tracks": tracks, "clips": [out, head, rest, audio_out, audio_in]}

    active = _project_active_transitions(document)
    assert len(active) == 1  # The linked audio crossfade is part of the picture dissolve.
    assert active[0]["kind"] == "dissolve"
    assert active[0]["rest_clip_id"] == "rest"
    assert active[0]["on_clip_id"] == "out"

    move_out = copy.deepcopy(out)
    move_out.pop("picture_fade_out_us")
    move_out["move_out"] = {"preset_id": "motions/move-push-right", "duration_us": 1_000_000}
    move_head = copy.deepcopy(head)
    move_head.pop("picture_fade_in_us")
    move_head["move_in"] = {"preset_id": "motions/move-push-left", "duration_us": 1_000_000}
    moved = _project_active_transitions({"tracks": tracks, "clips": [move_out, move_head]})
    assert len(moved) == 1 and moved[0]["kind"] == "move"
    assert moved[0]["incoming_move_preset_id"] == "motions/move-push-left"
    assert moved[0]["outgoing_move_preset_id"] == "motions/move-push-right"

    dip_out = clip("dip-out", "V1", 0, 5_000_000, "image", "still", picture_fade_out_us=500_000)
    dip_in = clip("dip-in", "V1", 5_000_000, 7_000_000, "video", "picture-2", picture_fade_in_us=500_000)
    white = clip("white", "V2", 4_500_000, 5_500_000, "image", "white-system")
    black = _project_active_transitions({"tracks": tracks, "clips": [dip_out, dip_in]})
    white_projection = _project_active_transitions(
        {"tracks": tracks, "clips": [dip_out, dip_in, white]}, system_white_page_asset_ids={"white-system"}
    )
    assert len(black) == 1 and black[0]["kind"] == "dip-black"
    assert len(white_projection) == 1 and white_projection[0]["kind"] == "dip-white"
    assert white_projection[0]["white_page_asset_id"] == "white-system"


def test_transition_requires_video_anchor_with_video_successor(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    only_id = state["current_revision"]["document"]["clips"][0]["clip_id"]

    # 单片段无后继。
    with pytest.raises(DomainError) as no_successor:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": only_id, "kind": "fade", "duration_us": 500_000}])
    assert no_successor.value.code == "TIMELINE_TRANSITION_INVALID"

    # 视频→图片：图片作为后继合法。
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000}])
    image_id = state["current_revision"]["document"]["clips"][1]["clip_id"]
    state = _patch(service, state, [{"op": "add_transition", "after_clip_id": only_id, "kind": "fade", "duration_us": 400_000}])
    transitions = state["current_revision"]["document"]["transitions"]
    assert len(transitions) == 1 and transitions[0]["after_clip_id"] == only_id

    # 音频素材进入 A1 轨，不影响 V1 转场；但 A1 片段作锚点非法。
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0}])
    audio_id = next(c["clip_id"] for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "A1")
    with pytest.raises(DomainError) as audio_anchor:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": audio_id, "kind": "fade", "duration_us": 400_000}])
    assert audio_anchor.value.code == "TIMELINE_TRANSITION_INVALID"


def test_transition_same_track_adjacency_p231(tmp_path: Path) -> None:
    """P231 S3 负向对照：转场同轨邻接——V2 轨内相邻段可加转场，跨轨段不可加。"""
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    # 新建 V2 轨 + 两段 V2 片段（首尾相接）。
    state = _patch(service, state, [{"op": "add_track", "kind": "video"}])
    state = _patch(service, state, [
        {"op": "insert_asset_clip", "asset_id": "v2", "at_index": 0, "track_id": "V2",
         "source_start_us": 0, "source_end_us": 1_000_000},
    ])
    state = _patch(service, state, [
        {"op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "track_id": "V2",
         "source_start_us": 1_000_000, "source_end_us": 2_000_000},
    ])
    v2_clips = [c for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "V2"]
    assert len(v2_clips) == 2
    left_id, right_id = v2_clips[0]["clip_id"], v2_clips[1]["clip_id"]
    # 同轨邻接（V2 内）：可加转场。
    state = _patch(service, state, [{"op": "add_transition", "after_clip_id": left_id, "kind": "fade", "duration_us": 300_000}])
    transitions = state["current_revision"]["document"]["transitions"]
    assert any(t["after_clip_id"] == left_id for t in transitions)
    # 跨轨（V2 锚点 → V1 后继）：不可加（后继须同轨）。
    v1_id = next(c["clip_id"] for c in state["current_revision"]["document"]["clips"] if c["track_id"] == "V1")
    with pytest.raises(DomainError) as cross_track:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": right_id, "kind": "fade", "duration_us": 300_000}])
    assert cross_track.value.code == "TIMELINE_TRANSITION_INVALID"
    _ = v1_id


def test_transition_locked_clip_rejected(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000}])
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": first_id, "locked": True}])
    with pytest.raises(DomainError) as locked:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 500_000}])
    assert locked.value.code == "TIMELINE_LOCKED"


def test_remove_clip_cascades_fixed_transition_pair_and_split_remaps_outgoing(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "source_start_us": 0, "source_end_us": 2_000_000}])
    second_id = state["current_revision"]["document"]["clips"][1]["clip_id"]

    state = _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 500_000}])
    state = _patch(service, state, [{"op": "split_clip", "clip_id": first_id, "source_time_us": 4_800_000}])
    right_id = next(
        clip["clip_id"] for clip in state["current_revision"]["document"]["clips"]
        if clip["clip_id"] != first_id and clip["asset_id"] == "v1"
    )
    transition = state["current_revision"]["document"]["transitions"][0]
    assert transition["after_clip_id"] == right_id
    assert transition["incoming_clip_id"] == second_id

    # Removing either fixed endpoint removes the compatibility record; it is not rebound.
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": second_id}])
    assert state["current_revision"]["document"]["transitions"] == []


def test_legacy_transition_without_identity_stays_dormant_and_never_rebinds(tmp_path: Path) -> None:
    service, database = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    outgoing_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "source_start_us": 0, "source_end_us": 2_000_000}])
    incoming_id = state["current_revision"]["document"]["clips"][1]["clip_id"]
    state = _patch(service, state, [{"op": "add_transition", "after_clip_id": outgoing_id, "kind": "fade", "duration_us": 500_000}])
    state = _patch(service, state, [{"op": "add_track", "kind": "video", "track_id": "V2"}])
    state = _patch(service, state, [{"op": "position_clip", "clip_id": incoming_id, "track_id": "V2", "timeline_start_us": 6_000_000}])
    state = _patch(service, state, [{
        "op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000,
        "track_id": "V1", "timeline_start_us": 5_000_000, "edit_mode": "overwrite",
    }])
    compat = state["current_revision"]["document"]["transitions"][0]
    assert compat["after_clip_id"] == outgoing_id
    assert compat["incoming_clip_id"] == incoming_id
    assert state["active_transitions"] == []

    legacy = copy.deepcopy(state["current_revision"]["document"])
    legacy["transitions"][0].pop("incoming_clip_id")
    with database.connection() as db:
        service._normalize_and_validate(db, legacy, previous_document=state["current_revision"]["document"])
    assert legacy["transitions"][0]["incoming_clip_id"] is None


def test_keyframes_set_clear_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    base = state["current_revision"]

    # 设置 opacity 关键帧（合法路径）。
    state = _patch(
        service,
        state,
        [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
          "frames": [{"t_us": 0, "v": 1.0}, {"t_us": 2_000_000, "v": 0.5}]}],
    )
    keyframes = state["current_revision"]["document"]["clips"][0]["keyframes"]
    assert keyframes["opacity"]["frames"] == [{"t_us": 0, "v": 1.0}, {"t_us": 2_000_000, "v": 0.5}]

    # 设置 position 关键帧（x/y 比率）。
    state = _patch(
        service,
        state,
        [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "position",
          "frames": [{"t_us": 0, "x": 0.0, "y": 0.0}, {"t_us": 1_000_000, "x": -0.25, "y": 0.3}]}],
    )
    keyframes = state["current_revision"]["document"]["clips"][0]["keyframes"]
    assert keyframes["position"]["frames"][1] == {"t_us": 1_000_000, "x": -0.25, "y": 0.3}

    # diff 记录 keyframes_changed（两次操作，相对 base）。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert sum(1 for c in diff["clip_changes"] if c["type"] == "keyframes_changed") == 1

    # 非法路径：坐标越界、时间乱序、超片段时长、字段错误、超帧数。
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "position",
                                 "frames": [{"t_us": 0, "x": 0.8, "y": 0.0}]}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
                                 "frames": [{"t_us": 2_000_000, "v": 1.0}, {"t_us": 1_000_000, "v": 0.5}]}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
                                 "frames": [{"t_us": 9_000_000, "v": 1.0}]}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
                                 "frames": [{"t_us": 0, "v": 1.0, "x": 0.1}]}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
                                 "frames": [{"t_us": i * 10_000, "v": 0.5} for i in range(40)]}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "scale",
                                 "frames": [{"t_us": 0, "v": 9.0}]}])

    # 清除存在的属性；清除不存在的属性被拒。
    state = _patch(service, state, [{"op": "clear_clip_keyframes", "clip_id": clip_id, "property": "opacity"}])
    assert "opacity" not in state["current_revision"]["document"]["clips"][0]["keyframes"]
    assert "position" in state["current_revision"]["document"]["clips"][0]["keyframes"]
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "clear_clip_keyframes", "clip_id": clip_id, "property": "opacity"}])


def test_transform_set_clear_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    base = state["current_revision"]

    # 设置静态变换（完整字段）。
    state = _patch(
        service, state,
        [{"op": "set_clip_transform", "clip_id": clip_id,
          "transform": {"x": 0.7, "y": 0.2, "scale": 0.4, "rotate": 15.0, "opacity": 0.85}}],
    )
    transform = state["current_revision"]["document"]["clips"][0]["transform"]
    assert transform == {"x": 0.7, "y": 0.2, "scale": 0.4, "rotate": 15.0, "opacity": 0.85}

    # 部分字段覆盖（只改归一侧，其余保留）。
    state = _patch(
        service, state,
        [{"op": "set_clip_transform", "clip_id": clip_id,
          "transform": {"scale": 0.6}}],
    )
    transform = state["current_revision"]["document"]["clips"][0]["transform"]
    assert transform == {"scale": 0.6}

    # diff 记录 transform_changed（相对 base，一次覆盖）。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert sum(1 for c in diff["clip_changes"] if c["type"] == "transform_changed") == 1

    # 空 transform = 清除字段（回到缺省）。
    state = _patch(service, state, [{"op": "set_clip_transform", "clip_id": clip_id, "transform": {}}])
    assert "transform" not in state["current_revision"]["document"]["clips"][0]

    # 非法路径：越界值 / 字段不合法。
    for bad in (
        {"x": 1.2},
        {"y": -0.1},
        {"scale": 6.0},
        {"scale": 0.01},
        {"rotate": 200.0},
        {"opacity": 1.5},
        {"unknown": 1.0},
    ):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_clip_transform", "clip_id": clip_id, "transform": bad}])


def test_mask_set_clear_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    base = state["current_revision"]

    # 设置椭圆蒙版。
    state = _patch(
        service, state,
        [{"op": "set_clip_mask", "clip_id": clip_id,
          "mask": {"kind": "ellipse", "x": 0.5, "y": 0.5, "width": 0.6, "height": 0.8, "feather": 0.1, "rotation": 0.0, "invert": False}}],
    )
    mask = state["current_revision"]["document"]["clips"][0]["mask"]
    assert mask["kind"] == "ellipse" and mask["width"] == 0.6 and mask["feather"] == 0.1

    # 线性蒙版 + 反选。
    state = _patch(service, state, [{"op": "set_clip_mask", "clip_id": clip_id, "mask": {"kind": "linear", "rotation": 90.0, "invert": True}}])
    mask = state["current_revision"]["document"]["clips"][0]["mask"]
    assert mask == {"kind": "linear", "rotation": 90.0, "invert": True}

    # diff 记录 mask_changed（相对 base）。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert sum(1 for c in diff["clip_changes"] if c["type"] == "mask_changed") == 1

    # 空 mask = 清除字段（回到无蒙版）。
    state = _patch(service, state, [{"op": "set_clip_mask", "clip_id": clip_id, "mask": {}}])
    assert "mask" not in state["current_revision"]["document"]["clips"][0]

    # 非法路径：越界 / 非法类型 / 未知字段。
    for bad in (
        {"kind": "star"},
        {"kind": "rect", "width": 0.0},
        {"kind": "rect", "height": 1.5},
        {"kind": "ellipse", "x": 1.2},
        {"kind": "ellipse", "feather": -0.1},
        {"kind": "linear", "rotation": 190.0},
        {"kind": "rect", "unknown": 1.0},
        {"kind": "ellipse", "invert": "yes"},
    ):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_clip_mask", "clip_id": clip_id, "mask": bad}])


def test_keying_set_clear_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    base = state["current_revision"]

    # 设置绿幕抠像。
    state = _patch(service, state, [{"op": "set_clip_keying", "clip_id": clip_id,
                                     "keying": {"color": "00FF00", "similarity": 0.4, "blend": 0.1, "invert": False}}])
    keying = state["current_revision"]["document"]["clips"][0]["keying"]
    assert keying == {"color": "00FF00", "similarity": 0.4, "blend": 0.1, "invert": False}

    # 部分更新 + 反选（整块替换，语义同 set_clip_mask）。
    state = _patch(service, state, [{"op": "set_clip_keying", "clip_id": clip_id, "keying": {"similarity": 0.2, "invert": True}}])
    keying = state["current_revision"]["document"]["clips"][0]["keying"]
    assert keying == {"similarity": 0.2, "invert": True}

    # diff 记录 keying_changed（相对 base）。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert sum(1 for c in diff["clip_changes"] if c["type"] == "keying_changed") == 1

    # 空 keying = 清除字段。
    state = _patch(service, state, [{"op": "set_clip_keying", "clip_id": clip_id, "keying": {}}])
    assert "keying" not in state["current_revision"]["document"]["clips"][0]

    # 非法路径。
    for bad in (
        {"color": "green"},
        {"color": "GGGGGG"},
        {"color": "00FF00", "similarity": 1.5},
        {"color": "00FF00", "blend": -0.1},
        {"color": "00FF00", "unknown": 1},
        {"color": "00FF00", "invert": "yes"},
    ):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_clip_keying", "clip_id": clip_id, "keying": bad}])


def test_keyframes_remap_on_speed_and_split_partition(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(
        service,
        state,
        [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "scale",
          "frames": [{"t_us": 0, "v": 1.0}, {"t_us": 4_000_000, "v": 2.0}]}],
    )

    # 0.5x 变速：时长 4s → 8s，关键帧等比重映射。
    state = _patch(service, state, [{"op": "set_speed", "clip_id": clip_id, "speed_milli": 500}])
    frames = state["current_revision"]["document"]["clips"][0]["keyframes"]["scale"]["frames"]
    assert frames == [{"t_us": 0, "v": 1.0}, {"t_us": 8_000_000, "v": 2.0}]

    # 拆分（源 2s 处 → 时间线 4s 处）：关键帧切分归两侧。
    state = _patch(service, state, [{"op": "split_clip", "clip_id": clip_id, "source_time_us": 2_000_000}])
    clips = state["current_revision"]["document"]["clips"]
    left_frames = clips[0]["keyframes"]["scale"]["frames"]
    right_frames = clips[1]["keyframes"]["scale"]["frames"]
    assert left_frames == [{"t_us": 0, "v": 1.0}]
    assert right_frames == [{"t_us": 4_000_000, "v": 2.0}]

    # 拆分点之前无帧、之后全在右侧：整属性移到右段（右段时间轴 4s，帧设在 3s 处）。
    right_id = clips[1]["clip_id"]
    state = _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": right_id, "property": "opacity",
                                     "frames": [{"t_us": 3_000_000, "v": 0.3}]}])
    # 再拆右段（源 3s 处 → 叧段时间线 2s 处）：opacity 帧在拆分点之后，整属性归新右段。
    state = _patch(service, state, [{"op": "split_clip", "clip_id": right_id, "source_time_us": 3_000_000}])
    clips = state["current_revision"]["document"]["clips"]
    assert "keyframes" not in clips[1]
    assert clips[2]["keyframes"]["opacity"]["frames"] == [{"t_us": 1_000_000, "v": 0.3}]


def test_keyframes_locked_clip_rejected(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    clip_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": clip_id, "locked": True}])
    with pytest.raises(DomainError) as locked:
        _patch(service, state, [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "opacity",
                                 "frames": [{"t_us": 0, "v": 1.0}]}])
    assert locked.value.code == "TIMELINE_LOCKED"


def test_caption_style_set_merge_clear_and_diff(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(
        service,
        {
            "kind": "transcript_selection",
            "transcript_id": "t1",
            "segment_ids": ["s1"],
            "padding_before_us": 0,
            "padding_after_us": 0,
            "create_captions": True,
        },
    )
    caption_id = state["current_revision"]["document"]["captions"][0]["caption_id"]
    base = state["current_revision"]

    # 设置部分覆盖（合法路径）。
    state = _patch(
        service,
        state,
        [{"op": "set_caption_style", "caption_id": caption_id,
          "style": {"font_size": 96, "primary_color": "&H0000FFFF"}}],
    )
    override = state["current_revision"]["document"]["captions"][0]["style_override"]
    assert override == {"font_size": 96, "primary_color": "&H0000FFFF"}

    # 部分合并：第二次只改描边，字号保留。
    state = _patch(
        service,
        state,
        [{"op": "set_caption_style", "caption_id": caption_id, "style": {"outline": 6}}],
    )
    override = state["current_revision"]["document"]["captions"][0]["style_override"]
    assert override == {"font_size": 96, "primary_color": "&H0000FFFF", "outline": 6}

    # diff 记录 style_changed（相对 base 一次计数——caption_changes 按字幕聚合）。
    diff = service.compare_revisions("p1", base["timeline_revision_id"], state["current_revision"]["timeline_revision_id"])
    assert any(c["type"] == "style_changed" for c in diff["caption_changes"])

    # 非法路径：字段越界、颜色格式、对齐值、坐标越界、未知字段。
    # （对齐已扩展为 ASS numpad 1-9；0 越界、10 越界仍拒绝。）
    for bad_style in (
        {"font_size": 200},
        {"outline": 20},
        {"alignment": 0},
        {"alignment": 10},
        {"margin_v": 900},
        {"primary_color": "red"},
        {"pos_x": 1.5},
        {"letter_spacing": -1},
        {"bold": "yes"},
        {"unknown_field": 1},
    ):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_caption_style", "caption_id": caption_id, "style": bad_style}])

    # 清除；清除不存在覆盖被拒。
    state = _patch(service, state, [{"op": "clear_caption_style", "caption_id": caption_id}])
    assert "style_override" not in state["current_revision"]["document"]["captions"][0]
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "clear_caption_style", "caption_id": caption_id}])


# ── as_audio：视频素材取音轨入 A1（M3-3 第一段）────────────────────────────


def test_as_audio_video_insert_lands_on_a1(tmp_path: Path) -> None:
    """视频素材 as_audio=true → clip 落 A1、asset_kind=audio、audio.enabled。"""
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    state = _patch(
        service,
        state,
        [{"op": "insert_asset_clip", "asset_id": "v1", "at_index": 0, "as_audio": True}],
    )
    clips = state["current_revision"]["document"]["clips"]
    a1_clip = next(clip for clip in clips if clip["track_id"] == "A1")
    assert a1_clip["asset_id"] == "v1"
    assert a1_clip["asset_kind"] == "audio"
    assert a1_clip["audio"]["enabled"] is True
    assert a1_clip["layout"] == "fit"
    # 固定轨尾语义：A1 段追加到轨道末尾（与音频素材一致）。
    assert a1_clip["timeline_start_us"] == 0


def test_as_audio_rejects_silent_video_and_audio_kind(tmp_path: Path) -> None:
    """无声视频与音频素材的 as_audio 插入被拒(音频素材直接插入即可)。"""
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    with pytest.raises(DomainError) as exc:
        _patch(
            service,
            state,
            [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 0, "as_audio": True}],
        )
    assert exc.value.code == "TIMELINE_INVALID"
    with pytest.raises(DomainError) as exc:
        _patch(
            service,
            state,
            [{"op": "insert_asset_clip", "asset_id": "a1", "at_index": 0, "as_audio": True}],
        )
    assert exc.value.code == "TIMELINE_INVALID"


def test_shared_openfilm_transition_projection_fixture() -> None:
    fixture_path = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "openfilm_transition_projection.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    cases = fixture["cases"]
    for name in (
        "touch_dip_black",
        "cross_track_dissolve",
        "cross_track_move_rest",
        "linked_audio_dedupe",
        "audio_crossfade",
        "dip_white",
    ):
        case = cases[name]
        trusted_white = set(case.get("trusted_white_page_asset_ids", []))
        actual = _project_active_transitions(
            case["document"], system_white_page_asset_ids=trusted_white,
        )
        assert actual == case["expected_active_transitions"], name
    stale = cases["stale_compatibility"]
    assert _project_active_transitions(stale["before_document"]) == []
    assert _project_active_transitions(stale["after_document"]) == stale["expected_after_active_transitions"]
