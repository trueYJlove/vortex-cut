from __future__ import annotations

import copy
from pathlib import Path

import pytest

from aivs_core.database import Database, json_dumps
from aivs_core.projects import DomainError
from aivs_core.timeline import TimelineService


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

    # 类型约束：文本轨不支持静音；音频轨不可新增；音频片段不可上视频轨。
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "set_track_flags", "track_id": "T1", "muted": True}])
    with pytest.raises(DomainError):
        _patch(service, state, [{"op": "add_track", "kind": "audio"}])
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
    assert remaining_ids[-2:] == ["V1", "A1"]
    assert "C1" not in remaining_ids
    state = _patch(service, state, [{"op": "add_track", "kind": "text"}])
    rebuilt_ids = [track["id"] for track in state["current_revision"]["document"]["tracks"]]
    # 新文本轨编号递增（不复用已删 id），插入到 V1 之前。
    assert rebuilt_ids[-3].startswith("T") and rebuilt_ids[-2:] == ["V1", "A1"]


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

    # Outward trims and sub-100ms trims are rejected.
    with pytest.raises(DomainError) as outward:
        _patch(
            service,
            state,
            [
                {
                    "op": "trim_clip",
                    "clip_id": audio["clip_id"],
                    "source_start_us": 1_000_000,
                    "source_end_us": 5_000_000,
                }
            ],
        )
    assert outward.value.code == "TIMELINE_INVALID"
    with pytest.raises(DomainError) as too_short:
        _patch(
            service,
            state,
            [
                {
                    "op": "trim_clip",
                    "clip_id": audio["clip_id"],
                    "source_start_us": 2_000_000,
                    "source_end_us": 2_050_000,
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
    for bad in (100, 4001):
        with pytest.raises(DomainError):
            _patch(service, state, [{"op": "set_speed", "clip_id": video_id, "speed_milli": bad}])

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
            [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 0, "source_start_us": 0, "source_end_us": 1_000_000, "speed_milli": 5000}],
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


def test_transition_locked_clip_rejected(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000}])
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": first_id, "locked": True}])
    with pytest.raises(DomainError) as locked:
        _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 500_000}])
    assert locked.value.code == "TIMELINE_LOCKED"


def test_remove_clip_cascades_transitions_and_split_conflict(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    first_id = state["current_revision"]["document"]["clips"][0]["clip_id"]
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 1, "source_start_us": 0, "source_end_us": 2_000_000}])
    second_id = state["current_revision"]["document"]["clips"][1]["clip_id"]

    # 拆分点落在转场区间内（5s 片段尾部 0.5s 内）被拒。
    state = _patch(service, state, [{"op": "add_transition", "after_clip_id": first_id, "kind": "fade", "duration_us": 500_000}])
    with pytest.raises(DomainError) as conflict:
        _patch(service, state, [{"op": "split_clip", "clip_id": first_id, "source_time_us": 4_800_000}])
    assert conflict.value.code == "TIMELINE_TRANSITION_INVALID"
    # 区间外拆分正常，转场跟随前段。
    state = _patch(service, state, [{"op": "split_clip", "clip_id": first_id, "source_time_us": 2_000_000}])
    assert len(state["current_revision"]["document"]["transitions"]) == 1

    # 删除锚点片段：其转场级联删除；相邻后继继承前后关系后转场仍指向正确片段。
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": first_id}])
    assert state["current_revision"]["document"]["transitions"] == []

    # 重建三段场景：删除锚点片段后 V1 序为 [v1右半, v2]；插入图片到中间成 [v1右半, i1, v2]。
    left_id = state["current_revision"]["document"]["clips"][0]["clip_id"]  # v1 split 右半
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "i1", "at_index": 1, "duration_us": 1_000_000}])
    middle_id = state["current_revision"]["document"]["clips"][1]["clip_id"]
    state = _patch(
        service,
        state,
        [
            {"op": "add_transition", "after_clip_id": left_id, "kind": "fade", "duration_us": 300_000},
            {"op": "add_transition", "after_clip_id": middle_id, "kind": "dissolve", "duration_us": 300_000},
        ],
    )
    assert len(state["current_revision"]["document"]["transitions"]) == 2
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": middle_id}])
    remaining = state["current_revision"]["document"]["transitions"]
    assert len(remaining) == 1
    assert remaining[0]["after_clip_id"] == left_id


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
