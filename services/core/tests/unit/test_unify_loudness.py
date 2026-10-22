"""E8 响度归一规划器：纯函数判定（含 cap 命中、无音轨、达标 noop）。"""

from __future__ import annotations

import pytest

from aivs_core.editing_grammar import default_registry
from aivs_core.editing_grammar.unify_loudness import (
    MAX_GAIN_DB,
    MIN_GAIN_DB,
    UnifyLoudnessPlanner,
)
from aivs_core.projects import DomainError

ALGO = "ebu-r128-ebur128-v1"


def _clip(
    clip_id: str,
    *,
    kind: str = "video",
    gain_db: float = 0.0,
    enabled: bool = True,
) -> dict:
    return {
        "clip_id": clip_id,
        "asset_id": f"asset_{clip_id}",
        "asset_kind": kind,
        "source_start_us": 0,
        "source_end_us": 5_000_000,
        "timeline_start_us": 0,
        "timeline_end_us": 5_000_000,
        "layout": "fit",
        "audio": {"enabled": enabled, "gain_db": gain_db},
    }


def _document(*clips: dict) -> dict:
    return {"schema_version": 1, "clips": list(clips), "captions": []}


def _measured(clip_id: str, lufs: float | None, **extra) -> dict:
    record = {"clip_id": clip_id, "algorithm_version": ALGO, **extra}
    if lufs is None:
        record.update({"status": "unmeasurable", "integrated_lufs": None,
                       "reason": "LOUDNESS_BELOW_ABSOLUTE_GATE"})
    else:
        record.update({"status": "measured", "integrated_lufs": lufs, "reason": None})
    return record


def _signals(*records: dict) -> dict:
    return {"loudness": {"algorithm_version": ALGO, "items": list(records)}}


def _plan(document: dict, signals: dict, **params):
    return UnifyLoudnessPlanner().plan(document, params, signals=signals)


def test_registered_in_default_registry() -> None:
    """负向对照 4：从 default_registry() 摘掉注册 ⇒ 本条红。"""
    names = [tool["name"] for tool in default_registry().list_tools()]
    assert "unify_loudness" in names


def test_single_clip_within_tolerance_is_noop() -> None:
    """默认目标 -16，实测 -16.3 ⇒ 差 0.3 < 0.5 容差 ⇒ noop，不产 op。"""
    result = _plan(
        _document(_clip("c1")),
        _signals(_measured("c1", -16.3)),
    )
    assert result.noop is True
    assert result.operations == ()
    assert result.rationale["unchanged"] == ["c1"]


def test_all_clips_within_tolerance_is_noop() -> None:
    result = _plan(
        _document(_clip("c1"), _clip("c2"), _clip("c3", kind="audio")),
        _signals(_measured("c1", -16.2), _measured("c2", -15.8), _measured("c3", -16.0)),
    )
    assert result.noop is True
    assert result.operations == ()
    assert sorted(result.rationale["unchanged"]) == ["c1", "c2", "c3"]


def test_quiet_clip_gets_boost_gain() -> None:
    """实测 -26.5，目标 -16 ⇒ +10.5 dB。"""
    result = _plan(_document(_clip("c1")), _signals(_measured("c1", -26.5)))
    assert result.noop is False
    assert result.operations == (
        {"op": "set_audio", "clip_id": "c1", "enabled": True, "gain_db": 10.5},
    )
    assert result.rationale["clips"][0]["decision"] == "adjust"


def test_loud_clip_gets_negative_gain() -> None:
    """实测 -6.0，目标 -16 ⇒ -10.0 dB。"""
    result = _plan(_document(_clip("c1")), _signals(_measured("c1", -6.0)))
    assert result.operations == (
        {"op": "set_audio", "clip_id": "c1", "enabled": True, "gain_db": -10.0},
    )


def test_gain_is_idempotent_for_same_measurement() -> None:
    """同一实测在不同既有增益下算出同一绝对增益（不是 current_gain + delta 累加）。

    源实测 -20、目标 -16 ⇒ 该片段的正确增益恒为 +4 dB。若实现写成
    current_gain + delta，既有 +2 dB 的片段会得到 +6 dB——over-gain。
    """
    signals = _signals(_measured("c1", -20.0))
    fresh = _plan(_document(_clip("c1")), signals)
    with_existing = _plan(_document(_clip("c1", gain_db=2.0)), signals)
    assert fresh.operations[0]["gain_db"] == 4.0
    assert with_existing.operations[0]["gain_db"] == 4.0


def test_applying_the_plan_again_is_noop() -> None:
    """把规划结果写回文档后再规划 ⇒ 已达标，不产 op（真正收敛）。"""
    signals = _signals(_measured("c1", -20.0))
    first = _plan(_document(_clip("c1")), signals)
    applied = _clip("c1", gain_db=first.operations[0]["gain_db"])
    second = _plan(_document(applied), signals)
    assert second.noop is True
    assert second.operations == ()


def test_already_effective_clip_is_noop_even_if_source_is_quiet() -> None:
    """源实测 -26，但文档里已有 +10 dB ⇒ 生效 -16，已达标 ⇒ 不产 op。"""
    result = _plan(
        _document(_clip("c1", gain_db=10.0)),
        _signals(_measured("c1", -26.0)),
    )
    assert result.noop is True
    assert result.rationale["clips"][0]["effective_lufs"] == pytest.approx(-16.0)


def test_cap_hit_is_marked_and_produces_no_operation() -> None:
    """负向对照 1：去掉 cap 保护（无条件钳到 +12）⇒ 本条红。

    实测 -56，目标 -16 ⇒ 需要 +40 dB，超出契约上限 12 ⇒ 不产 op、点名。
    """
    result = _plan(_document(_clip("c1")), _signals(_measured("c1", -56.0)))
    assert result.operations == ()
    assert result.noop is True
    assert result.rationale["unreachable"] == ["c1"]
    decision = result.rationale["clips"][0]
    assert decision["decision"] == "unreachable_cap"
    assert decision["needed_gain_db"] == 40.0
    assert decision["shortfall_db"] == pytest.approx(28.0)
    assert "c1" in result.summary
    # 关键区分力：绝不出一个被钳到 12 的 op 假装达标。
    assert all(op["gain_db"] <= MAX_GAIN_DB for op in result.operations)
    assert [op["clip_id"] for op in result.operations] == []


def test_lower_cap_is_defensively_enforced() -> None:
    """下限 -60 dB 是防御性分支：真实 LUFS <= 0 且 target >= -40 时不会触发，
    但越域的测量值也**不能**被写成非法 op（下游 set_audio 会直接拒绝）。"""
    result = _plan(
        _document(_clip("c1")),
        _signals(_measured("c1", 25.0)),
        target_lufs=-40.0,
    )
    assert result.operations == ()
    assert result.rationale["unreachable"] == ["c1"]
    assert result.rationale["clips"][0]["decision"] == "unreachable_cap"
    assert result.rationale["clips"][0]["needed_gain_db"] == -65.0


def test_cap_hit_does_not_block_other_clips() -> None:
    """一段不可达标不影响其余片段产出正常 op。"""
    result = _plan(
        _document(_clip("far"), _clip("near")),
        _signals(_measured("far", -56.0), _measured("near", -20.0)),
    )
    assert result.noop is False
    assert [op["clip_id"] for op in result.operations] == ["near"]
    assert result.operations[0]["gain_db"] == 4.0
    assert result.rationale["unreachable"] == ["far"]


def test_clip_without_audio_is_skipped() -> None:
    """无音轨（测量侧返回 no_audio）⇒ 跳过、点名、不产 op。"""
    record = {
        "clip_id": "silent",
        "status": "no_audio",
        "integrated_lufs": None,
        "reason": "MEDIA_NO_AUDIO",
        "algorithm_version": ALGO,
    }
    result = _plan(
        _document(_clip("silent"), _clip("ok")),
        _signals(record, _measured("ok", -20.0)),
    )
    assert [op["clip_id"] for op in result.operations] == ["ok"]
    assert result.rationale["skipped"] == ["silent"]
    silent_decision = next(
        item for item in result.rationale["clips"] if item["clip_id"] == "silent"
    )
    assert silent_decision["decision"] == "skip"
    assert silent_decision["reason"] == "MEDIA_NO_AUDIO"
    # 绝不把测量失败当 0 dB 处理（那会算出 -16 dB 的假 op）。
    assert all(op["clip_id"] != "silent" for op in result.operations)


def test_unmeasured_clip_never_becomes_zero_lufs_operation() -> None:
    """压根没有测量记录 ⇒ 跳过（不是「实测 0 LUFS，需要 -16dB」）。"""
    result = _plan(_document(_clip("c1")), _signals())
    assert result.operations == ()
    assert result.rationale["skipped"] == ["c1"]
    decision = result.rationale["clips"][0]
    assert decision["measured_lufs"] is None
    assert decision["reason"] == "LOUDNESS_NOT_MEASURED"


def test_image_and_disabled_audio_clips_are_out_of_scope() -> None:
    image = {**_clip("img"), "asset_kind": "image", "source_start_us": None,
             "source_end_us": None}
    result = _plan(
        _document(image, _clip("muted", enabled=False)),
        _signals(_measured("img", -30.0), _measured("muted", -30.0)),
    )
    # 图片片段根本不进范围（不进 skipped，也不产 op）。
    assert result.rationale["skipped"] == ["muted"]
    assert result.rationale["clips"][0]["reason"] == "AUDIO_DISABLED"
    assert result.operations == ()


def test_clip_ids_scopes_the_run() -> None:
    result = _plan(
        _document(_clip("a"), _clip("b")),
        _signals(_measured("a", -20.0), _measured("b", -20.0)),
        clip_ids=["b"],
    )
    assert [op["clip_id"] for op in result.operations] == ["b"]


def test_unknown_clip_id_in_params_is_rejected() -> None:
    with pytest.raises(DomainError) as exc:
        _plan(_document(_clip("a")), _signals(_measured("a", -20.0)), clip_ids=["nope"])
    assert exc.value.code == "EDITING_GRAMMAR_PARAMS_INVALID"


def test_target_out_of_range_is_rejected() -> None:
    with pytest.raises(DomainError) as exc:
        _plan(_document(_clip("c1")), _signals(_measured("c1", -20.0)), target_lufs=5.0)
    assert exc.value.code == "EDITING_GRAMMAR_PARAMS_INVALID"


def test_unknown_params_rejected() -> None:
    with pytest.raises(DomainError) as exc:
        _plan(_document(_clip("c1")), _signals(_measured("c1", -20.0)), bogus=1)
    assert exc.value.code == "EDITING_GRAMMAR_PARAMS_INVALID"


def test_rationale_records_algorithm_version_and_bounds() -> None:
    result = _plan(_document(_clip("c1")), _signals(_measured("c1", -20.0)))
    assert result.rationale["algorithm_version"] == ALGO
    assert result.rationale["params"]["gain_bounds_db"] == [MIN_GAIN_DB, MAX_GAIN_DB]
    assert "ebur128" in result.rationale["measurement"]
