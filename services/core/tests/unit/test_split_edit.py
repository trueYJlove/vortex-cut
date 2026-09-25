"""W1.4 split_edit / L-J cut——方向、边界、双声（规划门 §3）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from aivs_core.editing_grammar import EditingGrammarService, LjCutPlanner
from aivs_core.editing_grammar.lj_cut import auto_lj_mode, choose_audio_delta
from aivs_core.projects import DomainError
from aivs_core.timeline import AI_PATCH_OPERATIONS
from test_timeline import _create, _patch, _service


def _video(service, state):
    state = _patch(
        service,
        state,
        [
            {
                "op": "insert_asset_clip",
                "asset_id": "v1",
                "at_index": 0,
                "source_start_us": 0,
                "source_end_us": 5_000_000,
            }
        ],
    )
    return state, state["current_revision"]["document"]["clips"][0]["clip_id"]


class TestSplitEditOp:
    def test_jcut_negative_delta_and_dual_sound_prevention(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        state = _patch(
            service,
            state,
            [
                {
                    "op": "split_edit",
                    "clip_id": clip_id,
                    "source_time_us": 2_000_000,
                    "audio_delta_us": -400_000,
                }
            ],
        )
        clips = state["current_revision"]["document"]["clips"]
        videos = [c for c in clips if c["asset_kind"] == "video"]
        audios = [c for c in clips if c["asset_kind"] == "audio"]
        assert len(videos) == 2
        assert len(audios) == 2
        # 双声防护：V1 两段必须静音
        assert all(v["audio"]["enabled"] is False for v in videos)
        assert all(a["audio"]["enabled"] is True for a in audios)
        # J-cut：音频切点 1.6s
        left_a = min(audios, key=lambda a: a["source_start_us"])
        right_a = max(audios, key=lambda a: a["source_start_us"])
        assert left_a["source_end_us"] == 1_600_000
        assert right_a["source_start_us"] == 1_600_000

    def test_lcut_positive_delta(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        state = _patch(
            service,
            state,
            [
                {
                    "op": "split_edit",
                    "clip_id": clip_id,
                    "source_time_us": 2_000_000,
                    "audio_delta_us": 400_000,
                }
            ],
        )
        audios = [c for c in state["current_revision"]["document"]["clips"] if c["asset_kind"] == "audio"]
        left_a = min(audios, key=lambda a: a["source_start_us"])
        assert left_a["source_end_us"] == 2_400_000

    def test_rejects_out_of_bounds_audio_cut(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        with pytest.raises(DomainError) as exc:
            _patch(
                service,
                state,
                [
                    {
                        "op": "split_edit",
                        "clip_id": clip_id,
                        "source_time_us": 2_000_000,
                        "audio_delta_us": -3_000_000,
                    }
                ],
            )
        assert exc.value.code == "TIMELINE_INVALID"

    def test_rejects_short_picture_halves(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        with pytest.raises(DomainError) as exc:
            _patch(
                service,
                state,
                [
                    {
                        "op": "split_edit",
                        "clip_id": clip_id,
                        "source_time_us": 50_000,
                        "audio_delta_us": 0,
                    }
                ],
            )
        assert exc.value.code == "TIMELINE_INVALID"

    def test_in_ai_whitelist(self) -> None:
        assert "split_edit" in AI_PATCH_OPERATIONS


class TestLjCutPlanner:
    def test_j_direction_and_window(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        planner = LjCutPlanner()
        words = [
            {"start_us": 0, "end_us": 500_000, "text": "你好"},
            {"start_us": 2_300_000, "end_us": 2_800_000, "text": "世界"},
        ]
        result = planner.plan(
            state["current_revision"]["document"],
            {
                "clip_id": clip_id,
                "mode": "j",
                "source_time_us": 2_000_000,
                "words": words,
            },
        )
        delta = result.operations[0]["audio_delta_us"]
        assert delta < 0
        assert -500_000 <= delta <= -300_000
        assert result.rationale["audio_cut_us"] == 2_000_000 + delta

    def test_l_direction(self, tmp_path: Path) -> None:
        service, _ = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        planner = LjCutPlanner()
        words = [{"start_us": 0, "end_us": 1_500_000, "text": "上一句"}]
        result = planner.plan(
            state["current_revision"]["document"],
            {
                "clip_id": clip_id,
                "mode": "l",
                "source_time_us": 2_000_000,
                "words": words,
            },
        )
        delta = result.operations[0]["audio_delta_us"]
        assert 300_000 <= delta <= 500_000

    def test_missing_words_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(DomainError) as exc:
            choose_audio_delta(
                mode="j",
                picture_cut_us=2_000_000,
                words=[],
                clip_start_us=0,
                clip_end_us=5_000_000,
                offset_us=400_000,
            )
        assert exc.value.code == "EDITING_GRAMMAR_NO_WORDS"


class TestAutoLjMode:
    def test_prefers_j_when_next_word_exists(self):
        words = [
            {"start_us": 0, "end_us": 1_000_000},
            {"start_us": 2_200_000, "end_us": 2_800_000},
        ]
        assert auto_lj_mode(words, 2_000_000) == "j"

    def test_falls_back_to_l_without_next_word(self):
        words = [{"start_us": 0, "end_us": 1_000_000}]
        assert auto_lj_mode(words, 2_000_000) == "l"

    def test_no_words_rejected(self):
        with pytest.raises(DomainError) as exc:
            auto_lj_mode([], 1_000_000)
        assert exc.value.code == "EDITING_GRAMMAR_NO_WORDS"

    def test_e2e_propose_apply(self, tmp_path: Path) -> None:
        service, db = _service(tmp_path)
        state = _create(service)
        state, clip_id = _video(service, state)
        grammar = EditingGrammarService(db, service)
        req = {
            "base_revision_id": state["current_revision"]["timeline_revision_id"],
            "planner": "lj_cut",
            "params": {
                "clip_id": clip_id,
                "mode": "j",
                "source_time_us": 2_000_000,
                "words": [{"start_us": 2_300_000, "end_us": 2_800_000}],
            },
        }
        proposal = grammar.propose("p1", req)
        revision = grammar.apply(
            "p1",
            proposal["editing_grammar_proposal_id"],
            {
                "base_revision_id": req["base_revision_id"],
                "proposed_document_sha256": proposal["proposed_document_sha256"],
            },
        )
        videos = [c for c in revision["document"]["clips"] if c["asset_kind"] == "video"]
        assert len(videos) == 2
        assert all(v["audio"]["enabled"] is False for v in videos)
