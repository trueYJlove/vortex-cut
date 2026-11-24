"""W0.3 声画链接——链接组模型与联动语义（规划门 §3）。"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from aivs_core.projects import DomainError
from aivs_core.timeline import AI_PATCH_OPERATIONS
from test_timeline import _create, _patch, _service


def _clips(state: dict) -> list[dict]:
    return state["current_revision"]["document"]["clips"]


def _by_id(state: dict, clip_id: str) -> dict:
    return next(c for c in _clips(state) if c["clip_id"] == clip_id)


def _insert_video(service, state, **extra):
    op = {
        "op": "insert_asset_clip",
        "asset_id": "v1",
        "at_index": 0,
        "source_start_us": 0,
        "source_end_us": 2_000_000,
    }
    op.update(extra)
    result = _patch(service, state, [op])
    clip_id = result["current_revision"]["document"]["clips"][0]["clip_id"]
    return result, clip_id


def _audio_id(state: dict) -> str:
    return next(c for c in _clips(state) if c["asset_kind"] == "audio")["clip_id"]


def test_detach_audio_creates_aligned_linked_pair(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    video = _by_id(state, video_id)
    audio = next(c for c in _clips(state) if c["asset_kind"] == "audio")
    assert video["audio"]["enabled"] is False
    assert audio["track_id"] == "A1"
    assert audio["source_start_us"] == video["source_start_us"]
    assert audio["source_end_us"] == video["source_end_us"]
    assert audio["timeline_start_us"] == video["timeline_start_us"]
    assert audio["link_group_id"] == video["link_group_id"]

    with pytest.raises(DomainError) as again:
        _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    assert again.value.code == "TIMELINE_INVALID"


def test_insert_with_link_to_joins_group(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": 1,
                "as_audio": True,
                "source_start_us": 0,
                "source_end_us": 1_000_000,
                "link_to_clip_id": video_id,
            }
        ],
    )
    video = _by_id(state, video_id)
    audio = next(c for c in _clips(state) if c["asset_kind"] == "audio")
    assert video["link_group_id"] == audio["link_group_id"]


def test_set_and_clear_clip_link(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, v = _insert_video(service, state)
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "a1",
                "at_index": 1,
                "source_start_us": 0,
                "source_end_us": 1_000_000,
            }
        ],
    )
    a = _audio_id(state)
    state = _patch(service, state, [{"op": "set_clip_link", "clip_ids": [v, a]}])
    assert _by_id(state, v)["link_group_id"] == _by_id(state, a)["link_group_id"]
    state = _patch(service, state, [{"op": "clear_clip_link", "clip_id": v}])
    assert "link_group_id" not in _by_id(state, v)
    assert "link_group_id" not in _by_id(state, a)


def test_remove_propagates_unless_ignore_link(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    assert len(_clips(state)) == 2
    state = _patch(service, state, [{"op": "remove_clip", "clip_id": video_id}])
    assert _clips(state) == []

    service2, _ = _service(tmp_path / "s2")
    state2 = _create(service2)
    state2, video_id2 = _insert_video(service2, state2)
    state2 = _patch(service2, state2, [{"op": "detach_audio", "clip_id": video_id2}])
    audio_id = _audio_id(state2)
    state2 = _patch(
        service2,
        state2,
        [{"op": "remove_clip", "clip_id": video_id2, "ignore_link": True}],
    )
    remaining = _clips(state2)
    assert [c["clip_id"] for c in remaining] == [audio_id]
    assert "link_group_id" not in remaining[0]


@pytest.mark.parametrize(
    "operation", ["remove_clip", "position_clip", "split_clip", "clear_clip_link"]
)
def test_linked_operation_rejects_locked_member(tmp_path: Path, operation: str) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    state = _patch(
        service, state, [{"op": "set_clip_locked", "clip_id": _audio_id(state), "locked": True}]
    )
    op = {"op": operation, "clip_id": video_id}
    if operation == "position_clip":
        op["timeline_start_us"] = 1_000_000
    elif operation == "trim_clip":
        op.update(source_start_us=0, source_end_us=1_000_000)
    elif operation == "split_clip":
        op["source_time_us"] = 1_000_000
    with pytest.raises(DomainError) as error:
        _patch(service, state, [op])
    assert error.value.code == "TIMELINE_LOCKED"


def test_trim_leaves_locked_link_partner_and_trims_lead(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": audio_id, "locked": True}])
    state = _patch(service, state, [{
        "op": "trim_clip", "clip_id": video_id,
        "source_start_us": 0, "source_end_us": 1_500_000,
    }])
    assert _by_id(state, video_id)["source_end_us"] == 1_500_000
    assert _by_id(state, audio_id)["source_end_us"] == 2_000_000


def test_linked_trim_uses_common_timeline_edge_for_different_speeds(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(service, state, [{"op": "set_speed", "clip_id": video_id, "speed_milli": 2000}])
    state = _patch(service, state, [{
        "op": "trim_clip", "clip_id": audio_id,
        "source_start_us": 0, "source_end_us": 1_000_000, "ignore_link": True,
    }])

    state = _patch(service, state, [{
        "op": "trim_clip", "clip_id": video_id,
        "source_start_us": 0, "source_end_us": 3_000_000,
    }])

    video = _by_id(state, video_id)
    audio = _by_id(state, audio_id)
    assert video["timeline_end_us"] - video["timeline_start_us"] == 1_500_000
    assert audio["source_start_us"] == 0
    assert audio["source_end_us"] == 1_500_000
    assert audio["timeline_end_us"] - audio["timeline_start_us"] == 1_500_000

    service2, _ = _service(tmp_path / "audio-lead")
    state2 = _create(service2)
    state2, video2 = _insert_video(service2, state2)
    state2 = _patch(service2, state2, [{"op": "detach_audio", "clip_id": video2}])
    audio2 = _audio_id(state2)
    state2 = _patch(service2, state2, [{"op": "set_speed", "clip_id": audio2, "speed_milli": 2000}])
    state2 = _patch(service2, state2, [{
        "op": "trim_clip", "clip_id": audio2,
        "source_start_us": 0, "source_end_us": 3_000_000,
    }])
    video = _by_id(state2, video2)
    audio = _by_id(state2, audio2)
    assert video["source_end_us"] == 2_500_000
    assert video["timeline_end_us"] == 2_500_000
    assert audio["source_end_us"] == 3_000_000
    assert audio["timeline_end_us"] == 2_500_000


def test_link_creation_rejects_locked_member(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": audio_id, "locked": True}])
    with pytest.raises(DomainError) as error:
        _patch(service, state, [{"op": "set_clip_link", "clip_ids": [video_id, audio_id]}])
    assert error.value.code == "TIMELINE_LOCKED"


def test_removing_track_rejects_locked_clip(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(service, state, [{"op": "add_track", "kind": "video"}])
    state, clip_id = _insert_video(service, state, track_id="V2")
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": clip_id, "locked": True}])
    with pytest.raises(DomainError) as error:
        _patch(service, state, [{"op": "remove_track", "track_id": "V2"}])
    assert error.value.code == "TIMELINE_LOCKED"


def test_removing_track_rejects_locked_linked_clip(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(service, state, [{"op": "add_track", "kind": "video"}])
    state, clip_id = _insert_video(service, state, track_id="V2")
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": clip_id}])
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": _audio_id(state), "locked": True}])
    with pytest.raises(DomainError) as error:
        _patch(service, state, [{"op": "remove_track", "track_id": "V2"}])
    assert error.value.code == "TIMELINE_LOCKED"


def test_ignore_link_keeps_locked_member_unchanged(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": audio_id, "locked": True}])
    state = _patch(service, state, [{
        "op": "position_clip", "clip_id": video_id, "timeline_start_us": 1_000_000,
        "ignore_link": True,
    }])
    assert _by_id(state, video_id)["timeline_start_us"] == 1_000_000
    assert _by_id(state, audio_id)["timeline_start_us"] == 0


def test_ignore_link_allows_automatic_rider_to_move_without_unrelated_link_partner(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(service, state, [{
        "op": "position_clips",
        "placements": [{"clip_id": video_id, "timeline_start_us": 1_000_000}],
        "ignore_link": True,
    }])
    assert _by_id(state, video_id)["timeline_start_us"] == 1_000_000
    assert _by_id(state, audio_id)["timeline_start_us"] == 0


def test_atomic_positions_swap_and_respect_locks(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, first = _insert_video(service, state)
    state, _ = _insert_video(service, state, at_index=1)
    second = next(clip["clip_id"] for clip in _clips(state) if clip["clip_id"] != first)
    state = _patch(service, state, [{
        "op": "position_clips",
        "placements": [
            {"clip_id": first, "timeline_start_us": 2_000_000},
            {"clip_id": second, "timeline_start_us": 0},
        ],
    }])
    assert _by_id(state, first)["timeline_start_us"] == 2_000_000
    assert _by_id(state, second)["timeline_start_us"] == 0
    with pytest.raises(DomainError) as overlap:
        _patch(service, state, [{
            "op": "position_clips",
            "placements": [{"clip_id": first, "timeline_start_us": 1_000_000}],
        }])
    assert overlap.value.code == "TIMELINE_INVALID"
    state = _patch(service, state, [{"op": "set_clip_locked", "clip_id": second, "locked": True}])
    with pytest.raises(DomainError) as error:
        _patch(service, state, [{
            "op": "position_clips",
            "placements": [
                {"clip_id": first, "timeline_start_us": 0},
                {"clip_id": second, "timeline_start_us": 2_000_000},
            ],
        }])
    assert error.value.code == "TIMELINE_LOCKED"


def test_position_and_trim_propagate(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(
        service,
        state,
        [{"op": "position_clip", "clip_id": video_id, "timeline_start_us": 1_000_000}],
    )
    assert _by_id(state, video_id)["timeline_start_us"] == 1_000_000
    assert _by_id(state, audio_id)["timeline_start_us"] == 1_000_000

    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": video_id,
                "source_start_us": 500_000,
                "source_end_us": 1_500_000,
            }
        ],
    )
    for clip_id in (video_id, audio_id):
        clip = _by_id(state, clip_id)
        assert clip["source_start_us"] == 500_000
        assert clip["source_end_us"] == 1_500_000


def test_trim_ignore_link_only_target(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": video_id,
                "source_start_us": 500_000,
                "source_end_us": 1_500_000,
                "ignore_link": True,
            }
        ],
    )
    assert _by_id(state, video_id)["source_start_us"] == 500_000
    assert _by_id(state, audio_id)["source_start_us"] == 0


def test_unlinked_document_ops_match_legacy_shape(tmp_path: Path) -> None:
    """D8：无链接字段的文档，trim/move/remove/position 保持旧语义（无 link 键）。"""
    service, _ = _service(tmp_path)
    state = _create(service)
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": 0,
                "source_start_us": 0,
                "source_end_us": 2_000_000,
            },
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": 1,
                "source_start_us": 2_000_000,
                "source_end_us": 4_000_000,
            },
        ],
    )
    first = _clips(state)[0]["clip_id"]
    second = _clips(state)[1]["clip_id"]
    state = _patch(
        service,
        state,
        [
            {
                "op": "trim_clip",
                "clip_id": first,
                "source_start_us": 500_000,
                "source_end_us": 1_500_000,
            },
            {"op": "position_clip", "clip_id": first, "timeline_start_us": 1_000_000},
            {"op": "move_clip", "clip_id": second, "to_index": 0},
            {"op": "remove_clip", "clip_id": second},
        ],
    )
    clips = _clips(state)
    assert len(clips) == 1
    assert "link_group_id" not in clips[0]
    assert clips[0]["source_start_us"] == 500_000
    assert clips[0]["source_end_us"] == 1_500_000
    assert clips[0]["timeline_start_us"] == 1_000_000


def test_singleton_group_is_dropped(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, video_id = _insert_video(service, state)
    state = _patch(service, state, [{"op": "detach_audio", "clip_id": video_id}])
    audio_id = _audio_id(state)
    state = _patch(
        service,
        state,
        [{"op": "remove_clip", "clip_id": audio_id, "ignore_link": True}],
    )
    assert "link_group_id" not in _by_id(state, video_id)


def test_trim_link_rejects_mismatched_asset(tmp_path: Path) -> None:
    service, _ = _service(tmp_path)
    state = _create(service)
    state, v = _insert_video(service, state)
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "a1",
                "at_index": 1,
                "source_start_us": 0,
                "source_end_us": 1_000_000,
            }
        ],
    )
    a = _audio_id(state)
    state = _patch(service, state, [{"op": "set_clip_link", "clip_ids": [v, a]}])
    with pytest.raises(DomainError) as exc:
        _patch(
            service,
            state,
            [
                {
                    "op": "trim_clip",
                    "clip_id": v,
                    "source_start_us": 500_000,
                    "source_end_us": 1_500_000,
                }
            ],
        )
    assert exc.value.code == "TIMELINE_INVALID"


def test_structural_link_ops_not_in_ai_whitelist() -> None:
    assert "detach_audio" not in AI_PATCH_OPERATIONS
    assert "set_clip_link" not in AI_PATCH_OPERATIONS
    assert "clear_clip_link" not in AI_PATCH_OPERATIONS
