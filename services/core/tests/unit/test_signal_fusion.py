"""W4.2 信号融合单测（门 §4 F1–F6 + 负向对照）。

分层：`signal_fusion` 是纯函数，全部可确定性断言。
`planning` 层的接线由 test_planning_cv_recall.py 的回归锁保护（F4）。
"""
from __future__ import annotations

import pytest

from aivs_core.signal_fusion import (
    BEAT_HIT_TOLERANCE_US,
    FUSION_WEIGHTS,
    FUSION_WEIGHTS_VERSION,
    beat_hit_score,
    fuse_scores,
    minmax_normalize,
    normalize_weights,
)


class TestWeightsAreExplicit:
    def test_F6_weights_readable_and_versioned(self):
        """F6：权重必须是可读常量且带版本号（禁止内联魔数）。"""
        assert set(FUSION_WEIGHTS) == {'transcript', 'cv', 'beat'}
        assert abs(sum(FUSION_WEIGHTS.values()) - 1.0) < 1e-9
        assert FUSION_WEIGHTS_VERSION >= 1

    def test_D3_equal_weights_unoptimized(self):
        """D3：三源等权起步（1/3），且这是「未调优」的显式记录。"""
        for v in FUSION_WEIGHTS.values():
            assert abs(v - 1.0 / 3.0) < 1e-9


class TestNormalizeWeights:
    def test_all_three_sources(self):
        w = normalize_weights(['transcript', 'cv', 'beat'])
        assert abs(sum(w.values()) - 1.0) < 1e-9

    def test_missing_source_reweights_not_zero_fills(self):
        """门 §3.2：缺源重新归一，不是补 0。

        负向对照：若补 0，两源各为 1/3（和 2/3），候选分被系统性压低。
        """
        w = normalize_weights(['transcript', 'cv'])
        assert abs(sum(w.values()) - 1.0) < 1e-9
        assert abs(w['transcript'] - 0.5) < 1e-9
        assert 'beat' not in w

    def test_unknown_source_ignored(self):
        w = normalize_weights(['transcript', 'speaker_unknown'])
        assert set(w) == {'transcript'}

    def test_empty_returns_empty(self):
        assert normalize_weights([]) == {}


class TestMinMaxNormalize:
    def test_basic(self):
        assert minmax_normalize([1.0, 2.0, 3.0]) == [0.0, 0.5, 1.0]

    def test_all_equal_returns_half_not_zero(self):
        """全相等（多元素）时返回 0.5：既不除零，也不虚构区分度。"""
        assert minmax_normalize([2.0, 2.0, 2.0]) == [0.5, 0.5, 0.5]

    def test_single_element_preserved(self):
        """单元素保持原值——min-max 对单元素无意义，压成 0.5 会把满分候选降级。"""
        assert minmax_normalize([2.0]) == [1.0]
        assert minmax_normalize([0.0]) == [1.0]

    def test_empty(self):
        assert minmax_normalize([]) == []

    def test_F5_normalization_is_within_candidate_set(self):
        """F5：归一化在**本次候选集内**做。

        同一组原始值放进不同候选集，归一化结果不同 —— 证明不是全局归一。
        """
        a = minmax_normalize([1.0, 5.0])
        b = minmax_normalize([1.0, 5.0, 100.0])
        assert a != b[:2]


class TestBeatHit:
    def test_on_beat(self):
        assert beat_hit_score(1_000_000, [1_000_000, 2_000_000]) == 1.0

    def test_within_tolerance(self):
        assert beat_hit_score(1_000_000 + BEAT_HIT_TOLERANCE_US, [1_000_000]) == 1.0

    def test_outside_tolerance(self):
        assert beat_hit_score(1_000_000 + BEAT_HIT_TOLERANCE_US + 1, [1_000_000]) == 0.0

    def test_empty_beats(self):
        assert beat_hit_score(1_000_000, []) == 0.0


class TestFuseScores:
    def test_F1_three_sources_produce_ranked_output(self):
        cands = [
            {'key': 'a', 'start_us': 0, 'parts': {
                'transcript': {'match': 1.0, 'confidence': 0.9},
                'cv': {'features': {'face': 1.0, 'motion': 0.9, 'sharpness': 0.8}},
                'beat': {'hit': 1.0}}},
            {'key': 'b', 'start_us': 1000, 'parts': {
                'transcript': {'match': 0.0, 'confidence': 0.1},
                'cv': {'features': {'face': 0.0, 'motion': 0.1, 'sharpness': 0.2}},
                'beat': {'hit': 0.0}}},
        ]
        out = fuse_scores(cands, ('transcript', 'cv', 'beat'))
        assert [x['key'] for x in out] == ['a', 'b']
        assert out[0]['score'] > out[1]['score']
        assert set(out[0]['contributions']) == {'transcript', 'cv', 'beat'}

    def test_F2_missing_source_still_works_and_recorded(self):
        """F2：缺源可运行，且 contributions 里能看到实际参与的源。"""
        cands = [
            {'key': 'a', 'start_us': 0, 'parts': {'transcript': {'match': 1.0, 'confidence': 1.0}}},
            {'key': 'b', 'start_us': 1000, 'parts': {'transcript': {'match': 0.0, 'confidence': 0.0}}},
        ]
        out = fuse_scores(cands, ('transcript', 'cv', 'beat'))
        assert len(out) == 2
        assert set(out[0]['contributions']) == {'transcript'}
        assert abs(out[0]['score'] - 1.0) < 1e-9

    def test_score_range_and_determinism(self):
        cands = [{'key': str(i), 'start_us': i * 100, 'parts': {
            'transcript': {'match': i / 10, 'confidence': 0.5}}} for i in range(10)]
        a = fuse_scores(cands, ('transcript',))
        b = fuse_scores(cands, ('transcript',))
        assert [x['key'] for x in a] == [x['key'] for x in b]
        assert all(0.0 <= x['score'] <= 1.0 for x in a)

    def test_empty_candidates(self):
        assert fuse_scores([], ('transcript',)) == []

    def test_negative_control_zero_fill_would_lower_single_source(self):
        """负向对照：若把缺源补 0（而非重新归一），单源候选分会明显偏低。

        这条证明 normalize_weights 的重新归一是**有实际影响**的选择，
        而不是无区别的实现细节。
        """
        cands = [
            {'key': 'a', 'start_us': 0, 'parts': {'transcript': {'match': 1.0, 'confidence': 1.0}}},
        ]
        out = fuse_scores(cands, ('transcript', 'cv', 'beat'))
        assert abs(out[0]['score'] - 1.0) < 1e-9     # 重新归一 => 满分
        # 若补 0：1.0 * (1/3) = 0.333
        assert out[0]['score'] > 0.5
