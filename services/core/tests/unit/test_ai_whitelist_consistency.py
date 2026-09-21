"""WHITELIST_EXPANSION（2026-09-22）白-5：三处同步一致性 + 晋升 op 沙盒用例。

准入纪律：AI_PATCH_OPERATIONS（显式冻结）/ TIMELINE_PATCH_OPERATIONS_SCHEMA
（json_schema oneOf）/ _PATCH_FIELDS（patchscript 域校验）三处必须逐 op
对齐——缺一即测试红，杜绝"白名单说允许、解析器不认"的漂移复发。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.providers import (
    TIMELINE_PATCH_OPERATIONS_SCHEMA,
    _PATCH_FIELDS,
    validate_timeline_patch_value,
)
from aivs_core.timeline import AI_PATCH_OPERATIONS, TimelineService
from test_timeline import _create, _patch, _service


def _schema_ops() -> set[str]:
    return {
        item["properties"]["op"]["const"]
        for item in TIMELINE_PATCH_OPERATIONS_SCHEMA["oneOf"]
    }


def test_three_way_consistency() -> None:
    assert _schema_ops() == set(_PATCH_FIELDS) == set(AI_PATCH_OPERATIONS)


def test_whitelist_is_subset_of_patch_operations() -> None:
    from aivs_core.timeline import PATCH_OPERATIONS

    assert AI_PATCH_OPERATIONS <= PATCH_OPERATIONS


def test_structurally_excluded_operations_stay_out() -> None:
    excluded = {
        "insert_asset_clip", "insert_transcript_segments", "add_caption",
        "import_captions", "set_clip_locked", "add_track", "remove_track",
        "move_track", "set_track_flags", "set_clip_mask", "set_clip_keying",
    }
    assert not (excluded & AI_PATCH_OPERATIONS)


def test_mask_and_keying_explicitly_excluded_with_reason() -> None:
    # 裁决记录：像素级数据无文本可描述性——显式排除而非顺手包含。
    assert "set_clip_mask" not in AI_PATCH_OPERATIONS
    assert "set_clip_keying" not in AI_PATCH_OPERATIONS


# ----------------------------------------------------------------------
# 晋升 op 端到端：parse → validate → apply_in_memory(ai=True) 沙盒
# ----------------------------------------------------------------------

def _patch_document(service: TimelineService, tmp_path: Path):
    state = _create(service)
    with service.db.connection() as db:
        document = service._revision(db, state["current_revision"]["timeline_revision_id"])["document"]
    return state, document


def test_promoted_add_transition_e2e(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    _create(service, {"kind": "empty"})
    with service.db.connection() as db:
        document = service._revision(db, service.get_state("p1")["current_revision"]["timeline_revision_id"])["document"]
    # 空时间线无 clip——先以用户路径插入两段素材架出转场锚点（经 patch，非 AI op）。
    return


def test_schema_rejects_extra_fields_for_promoted_op() -> None:
    good = {"summary": "s", "operations": [
        {"op": "add_transition", "after_clip_id": "clip_1", "kind": "fade", "duration_us": 500_000}
    ]}
    assert validate_timeline_patch_value(good)["operations"][0]["kind"] == "fade"
    extra = {"summary": "s", "operations": [
        {"op": "add_transition", "after_clip_id": "clip_1", "kind": "fade",
         "duration_us": 500_000, "timeline_start_us": 0}
    ]}
    with pytest.raises(ValueError, match="unknown or invalid operation fields"):
        validate_timeline_patch_value(extra)


def test_schema_accepts_promoted_stock_gap_ops() -> None:
    for operation in (
        {"op": "position_clip", "clip_id": "c", "timeline_start_us": 0, "track_id": "V1"},
        {"op": "set_speed", "clip_id": "c", "speed_milli": 2000},
        {"op": "set_reverse_playback", "clip_id": "c", "reverse_playback": True},
    ):
        value = validate_timeline_patch_value({"summary": "s", "operations": [operation]})
        assert value["operations"][0]["op"] == operation["op"]


def test_schema_rejects_unknown_op_and_extra_fields() -> None:
    # 本地解析器只做结构校验（数值域在 apply_in_memory/网关 json_schema 侧）——
    # 这里断言结构边界：未知 op 与多余字段拒、合法晋升 op 过。
    with pytest.raises(ValueError, match="unknown or invalid operation"):
        validate_timeline_patch_value({"summary": "s", "operations": [
            {"op": "set_clip_mask", "clip_id": "c", "mask": {}}
        ]})
    with pytest.raises(ValueError, match="unknown or invalid operation fields"):
        validate_timeline_patch_value({"summary": "s", "operations": [
            {"op": "add_transition", "after_clip_id": "c", "kind": "fade",
             "duration_us": 500_000, "timeline_start_us": 0}
        ]})


def _seed_two_clips(service: TimelineService) -> tuple[dict, str]:
    """单 clip 无法承载转场（需后继片段）——插入第二段架出锚点。"""
    state = _create(service, {"kind": "full_asset", "asset_id": "v1"})
    state = _patch(service, state, [{"op": "insert_asset_clip", "asset_id": "v2", "at_index": 1}])
    with service.db.connection() as db:
        document = service._revision(
            db, state["current_revision"]["timeline_revision_id"]
        )["document"]
    return document, document["clips"][0]["clip_id"]


def test_domain_ranges_enforced_at_apply(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    document, clip_id = _seed_two_clips(service)
    from aivs_core.projects import DomainError

    with pytest.raises(DomainError, match="0.1-2 秒"):
        with service.db.connection() as db:
            service.apply_in_memory(
                db, "p1", document,
                [{"op": "add_transition", "after_clip_id": clip_id, "kind": "fade",
                  "duration_us": 50}],
                ai=True,
            )
    with pytest.raises(DomainError, match="0.25x-4x"):
        with service.db.connection() as db:
            service.apply_in_memory(
                db, "p1", document,
                [{"op": "set_speed", "clip_id": clip_id, "speed_milli": 5000}],
                ai=True,
            )


def test_promoted_ops_pass_apply_in_memory_ai_gate(tmp_path: Path) -> None:
    service, db = _service(tmp_path)
    document, clip_id = _seed_two_clips(service)
    with service.db.connection() as db:
        # ai=True 闸门放行晋升 op——apply 成功返回新文档。
        proposed = service.apply_in_memory(
            db, "p1", document,
            [{"op": "add_transition", "after_clip_id": clip_id, "kind": "fade",
              "duration_us": 500_000}],
            ai=True,
        )
        assert proposed["transitions"][0]["kind"] == "fade"
        proposed = service.apply_in_memory(
            db, "p1", document,
            [{"op": "set_speed", "clip_id": clip_id, "speed_milli": 2000}],
            ai=True,
        )
        assert proposed["clips"][0]["speed_milli"] == 2000
        proposed = service.apply_in_memory(
            db, "p1", document,
            [{"op": "set_clip_keyframes", "clip_id": clip_id, "property": "scale",
              "frames": [{"t_us": 0, "v": 1.0}, {"t_us": 1_000_000, "v": 1.5}]}],
            ai=True,
        )
        assert proposed["clips"][0]["keyframes"]["scale"]["frames"][1]["v"] == 1.5
        # caption 侧：先以用户路径加字幕（add_caption 非白名单 op），再样式覆盖。
        proposed = service.apply_in_memory(
            db, "p1", proposed,
            [{"op": "add_caption", "start_us": 0, "end_us": 1_000_000,
              "text": "第一句", "preset_id": "default-bottom", "source_clip_id": None}],
            ai=False,
        )
        caption_id = proposed["captions"][-1]["caption_id"]
        proposed = service.apply_in_memory(
            db, "p1", proposed,
            [{"op": "set_caption_style", "caption_id": caption_id,
              "style": {"font_size": 72, "bold": True}}],
            ai=True,
        )
        assert proposed["captions"][-1]["style_override"] == {"font_size": 72, "bold": True}
