"""W2.2 验收仪器（DER 评分器）—— **pytest 形态**，落在 core 的 testpaths 内。

Design Gate §6 S0 ① / §7：仪器实现在 `tools/quality_eval/diarization.py`，
但 `pyproject` 的 `testpaths` 只收 `services/core/tests` ⇒ **自检必须在这里**，
否则"仪器常设化"等于没有门（复核 F2 实测：迁到 tools 的自检不进任何门）。

本文件把 spike 的 9 项自检逐项落成断言，并**补上区分力**：
- 负向对照 A：把评分器换成"恒 0"⇒ 用例必须红（证明断言不是恒真）。
- 负向对照 B：collar 关掉 ⇒ 平移用例的 DER 必须变小（证明 collar 真的在起作用）。
- 负向对照 C：忽略重叠关掉 ⇒ 重叠帧进入分母，结果必须改变（证明口径开关有效）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


der = _load("quality_eval_diarization", QE / "diarization.py")

REF = der.SELFTEST_REF
TOTAL = der.SELFTEST_TOTAL_S


class TestKnownAnswers:
    """已知答案：评分器对"完全正确"必须给 0，对"全空"必须给 1。"""

    def test_identical_is_zero(self):
        r = der.score(REF, list(REF), total_s=TOTAL)
        assert r.der == pytest.approx(0.0, abs=0.02)
        assert r.miss == 0.0 and r.speaker_error == 0.0

    def test_permuted_labels_is_zero(self):
        # 说话人编号是任意的 ⇒ 换名不得改变分数（穷举最优映射的意义）
        hyp = [(a, b, {"A": "X", "B": "Y", "C": "Z"}[s]) for a, b, s in REF]
        assert der.score(REF, hyp, total_s=TOTAL).der == pytest.approx(0.0, abs=0.02)

    def test_empty_hypothesis_is_one(self):
        r = der.score(REF, [], total_s=TOTAL)
        assert r.der == pytest.approx(1.0, abs=1e-9)
        assert r.miss == pytest.approx(1.0) and r.false_alarm == 0.0

    def test_single_speaker_equals_one_minus_max_share(self):
        r = der.score(REF, [(0.0, 40.0, "S")], total_s=TOTAL)
        assert r.der == pytest.approx(1 - 20.0 / 40.0, abs=0.05)
        assert r.false_alarm == 0.0  # 没在参考静音处说话


class TestShiftMonotonicity:
    """平移对照：DER 随平移量单调上升，且大平移显著变差。

    **不能拍"2s 就该 >0.5"**：10 s 轮次上平移 2 s 只错边界带，DER≈0.23 是正确结果。
    """

    def test_monotonic_and_large_shift_hurts(self):
        shifts = [0.0, 1.0, 2.0, 5.0]
        ders = [
            der.score(REF, [(a + s, b + s, sp) for a, b, sp in REF], total_s=TOTAL).der
            for s in shifts
        ]
        assert all(ders[i] <= ders[i + 1] + 1e-9 for i in range(len(ders) - 1)), ders
        assert ders[-1] > 0.4, ders


class TestBoundaryCases:
    def test_half_missing(self):
        r = der.score(REF, REF[:2], total_s=TOTAL)
        assert r.miss > 0.0 and r.der > 0.0

    def test_extra_speech_in_silence_counts_as_false_alarm(self):
        r = der.score(REF, [*REF, (45.0, 55.0, "D")], total_s=TOTAL)
        assert r.false_alarm > 0.0

    def test_no_scored_frames_raises(self):
        # 参考全为空 ⇒ 无计分帧，必须显式报错而不是返回 0（"没有证据"≠"完美"）
        with pytest.raises(ValueError):
            der.score([], [], total_s=TOTAL)

    def test_rttm_loader_roundtrip(self, tmp_path: Path):
        p = tmp_path / "a.rttm"
        p.write_text(
            "SPEAKER m 1 0.000 10.000 <NA> <NA> spk1 <NA> <NA>\n"
            "SPEAKER m 1 10.000 5.000 <NA> <NA> spk2 <NA> <NA>\n",
            encoding="utf-8",
        )
        turns = der.load_rttm(p)
        assert turns == [(0.0, 10.0, "spk1"), (10.0, 15.0, "spk2")]


class TestNegativeControls:
    """负向对照：证明上面的断言**有区分力**，不是恒真。"""

    def test_nc_a_constant_zero_scorer_would_pass_identical_but_fail_empty(self):
        # 若把 score 换成"恒 0"，identical 用例仍绿 ⇒ 单看 identical 不足以钉死评分器；
        # 但 empty 用例立刻红。这里直接断言两者的期望值不同，证明二者共同构成区分力。
        identical = der.score(REF, list(REF), total_s=TOTAL).der
        empty = der.score(REF, [], total_s=TOTAL).der
        assert identical != empty
        assert identical == pytest.approx(0.0, abs=0.02)
        assert empty == pytest.approx(1.0, abs=1e-9)

    def test_nc_b_collar_actually_matters(self):
        # 关掉 collar（=0）后，边界带进入计分。**方向不做先验假设**：
        # 平移假设下边界帧同时是"错误帧"与"新增分母"，DER 涨或跌都合理
        # （本机实测：0.0975 → 0.1239，即涨）。有区分力的判据是
        # **计分帧数与 DER 都改变**，而不是拍一个方向。
        shifted = [(a + 1.0, b + 1.0, s) for a, b, s in REF]
        with_collar = der.score(REF, shifted, total_s=TOTAL, collar_s=0.25)
        without = der.score(REF, shifted, total_s=TOTAL, collar_s=0.0)
        assert without.scored_frames != with_collar.scored_frames
        assert without.der != pytest.approx(with_collar.der)

    def test_nc_c_ignore_overlap_switch_changes_result(self):
        # 参考里造一段重叠：忽略重叠（默认）时该段不计分；不忽略时它进分母。
        ref = [*REF, (25.0, 35.0, "D")]  # 25–30 与 A、30–35 与 C 重叠
        hyp = [(0.0, 40.0, "S")]
        ignore = der.score(ref, hyp, total_s=TOTAL, ignore_overlap=True)
        keep = der.score(ref, hyp, total_s=TOTAL, ignore_overlap=False)
        assert ignore.scored_frames != keep.scored_frames
        assert keep.scored_frames > ignore.scored_frames


class TestOptimalMappingSubsetSearch:
    """**最优映射必须穷举"挑哪几个假设说话人"**（2026-10-12 交叉校验发现的缺陷）。

    旧实现 `permutations(range(n_ref), min(n_hyp, n_ref))` 永远只用**序号最小的**
    min(n_hyp,n_ref) 个假设去映射，从不搜索子集。n_hyp ≤ n_ref 时它与全排列等价
    （故既有 9 项自检全绿）；**一旦 n_hyp > n_ref，它就可能跳过真正的匹配对**，
    把 DER 高估——而且**只惩罚过分割**，恰好掩盖"欠分割的代价"。

    实测（EN2002c，AMI）：旧 0.4659 / 新 0.1801 / NIST md-eval-22.pl 独立给 0.1806。
    故本组用例是**仪器正确性**的门，不是风格问题。
    """

    @staticmethod
    def _ref_three():
        return [(0.0, 10.0, "R0"), (20.0, 30.0, "R1"), (40.0, 50.0, "R2")]

    def test_extra_leading_cluster_does_not_hide_the_match(self):
        # hyp 的第一个说话人是**多余的空簇**；真正的对应在 hyp1..hyp3。
        # 旧实现只用前 3 个假设（X0,X1,X2）⇒ 找不到最优 ⇒ DER 高估。
        hyp = [(0.0, 0.2, "X0"), (0.0, 10.0, "X1"), (20.0, 30.0, "X2"), (40.0, 50.0, "X3")]
        r = der.score(self._ref_three(), hyp, total_s=60.0, ignore_overlap=True)
        assert r.der == pytest.approx(0.0, abs=1e-9), r.der
        assert r.speaker_error == pytest.approx(0.0, abs=1e-9)
        # 映射必须指向 hyp1..hyp3，**不能**包含 X0
        assert set(r.mapping) == {1, 2, 3}

    def test_extra_middle_cluster_does_not_hide_the_match(self):
        """多余簇夹在中间（序号小于后面的真簇）⇒ 必须仍能跳过它。

        **只断言 speaker_error 与映射**，不断言 DER：XJUNK 在参考静音里说话，
        那段**合法地**计入 FA（9.55 s / 29.5 s ≈ 0.32），与本用例要测的
        "映射搜索是否完整"无关。（初版把 DER 断言成 0 是我自己写错了夹具，
        被这条失败的用例当场纠正。）
        """
        # **说话人编号是 sorted(标签) 的序**（`_hyp_frames` 实现如此），
        # 故这里用 "XB" 作多余簇，使其**确实落在序号 1**（初版用 "XJUNK"，
        # 它按字典序排到最后、根本没夹在中间——是我的夹具错了，不是搜索错了）。
        hyp = [
            (0.0, 10.0, "XA"),
            (10.0, 19.8, "XB"),  # 多余簇，序号 1
            (20.0, 30.0, "XC"),
            (40.0, 50.0, "XD"),
        ]
        r = der.score(self._ref_three(), hyp, total_s=60.0, ignore_overlap=True)
        assert r.speaker_error == pytest.approx(0.0, abs=1e-9), r.speaker_error
        assert r.mapping == {0: 0, 2: 1, 3: 2}  # 跳过序号 1 的多余簇
        assert r.false_alarm > 0.0  # 多余簇在参考静音处说话 ⇒ 有 FA（这是对的）

    def test_der_is_invariant_to_hypothesis_relabeling(self):
        """**最强的一条性质**：说话人编号是任意的 ⇒ DER 必须与编号命名无关。

        这条性质一旦成立，「只排列前 m 个假设」这类按**序号**裁剪的实现就必然违反它
        （因为"哪些编号排在前 m"取决于命名）。实测旧实现会在 24 种编号里给出多个值。

        本用例对 4 个假设说话人的**全部 24 种编号**逐一评分，要求取值唯一。
        """
        from itertools import permutations

        ref = [(0.0, 10.0, "R0"), (20.0, 30.0, "R1"), (40.0, 50.0, "R2")]
        # 真实对应 R0<-XA、R1<-XB、R2<-XC；XJ 是多余的短簇（且命名会打乱顺序）
        base = [
            (0.0, 10.0, "XA"),
            (50.0, 50.5, "XJ"),
            (20.0, 30.0, "XB"),
            (40.0, 50.0, "XC"),
        ]
        names = ["XA", "XJ", "XB", "XC"]
        seen = set()
        for perm in permutations(names):
            ren = dict(zip(names, perm))
            hyp = [(a, b, ren[s]) for a, b, s in base]
            seen.add(round(der.score(ref, hyp, total_s=60.0, ignore_overlap=True).der, 9))
        assert len(seen) == 1, f"DER 随假设编号变化：{sorted(seen)}"
        assert seen.pop() == pytest.approx(0.00843, abs=1e-4)

    def test_negative_control_old_implementation_violates_relabeling(self):
        """**负向对照**：旧实现（只排列前 m 个假设）**确实违反**上一条性质。

        若不做这一步，「重新编号不变性」可能只是**恒真**（比如评分器恰好对编号不敏感），
        那它就证明不了任何事。实测旧实现在 24 种编号下给出 **2 个不同值**
        （0.00843 与 0.341763）——差异高达 **33 个点**，正是"按序号裁剪"的直接后果。
        """
        from itertools import permutations

        import numpy as np

        COLLAR_S, FRAME_S = der.COLLAR_S, der.FRAME_S
        _collar_mask, _hyp_frames, _ref_frames = (
            der._collar_mask,
            der._hyp_frames,
            der._ref_frames,
        )

        def der_old(ref, hyp, total_s):
            """**复刻旧实现**：只对前 min(n_hyp, n_ref) 个假设做排列。"""
            n_frames = int(round(total_s / FRAME_S))
            ref_count, ref_owner = _ref_frames(ref, n_frames)
            hyp_owner = _hyp_frames(hyp, n_frames)
            collar = _collar_mask(ref, n_frames, COLLAR_S)
            scored = (ref_count > 0) & (ref_count == 1) & (~collar)
            n_scored = int(scored.sum())
            n_ref = int(ref_owner.max()) + 1 if ref_owner.max() >= 0 else 0
            n_hyp = int(hyp_owner.max()) + 1 if hyp_owner.max() >= 0 else 0
            cont = np.zeros((max(n_ref, 1), max(n_hyp, 1)), dtype=np.int64)
            both = scored & (hyp_owner >= 0) & (ref_owner >= 0)
            np.add.at(cont, (ref_owner[both], hyp_owner[both]), 1)
            hit_frames = n_scored - int(((hyp_owner == -1) & scored).sum())
            best_hit = -1
            for target in permutations(range(n_ref), min(n_hyp, n_ref)):
                best_hit = max(best_hit, sum(int(cont[r, h]) for h, r in enumerate(target)))
            miss = int(((hyp_owner == -1) & scored).sum())
            fa = int(((hyp_owner != -1) & (ref_count == 0) & (~collar)).sum())
            return (miss + (hit_frames - max(best_hit, 0)) + fa) / n_scored

        ref = [(0.0, 10.0, "R0"), (20.0, 30.0, "R1"), (40.0, 50.0, "R2")]
        base = [
            (0.0, 10.0, "XA"),
            (50.0, 50.5, "XJ"),
            (20.0, 30.0, "XB"),
            (40.0, 50.0, "XC"),
        ]
        names = ["XA", "XJ", "XB", "XC"]
        old_vals = set()
        for perm in permutations(names):
            ren = dict(zip(names, perm))
            hyp = [(a, b, ren[s]) for a, b, s in base]
            old_vals.add(round(der_old(ref, hyp, 60.0), 6))
        assert len(old_vals) > 1, "旧实现竟未违反不变性——本对照失去区分力"
        assert max(old_vals) - min(old_vals) > 0.3

    def test_n_hyp_le_n_ref_still_correct(self):
        # **负向对照的方向**：假设数 ≤ 参考数时新旧等价，必须仍然正确
        hyp = [(0.0, 10.0, "X0"), (20.0, 30.0, "X1")]
        r = der.score(self._ref_three(), hyp, total_s=60.0, ignore_overlap=True)
        # R0,R1 各被正确命中；R2 全丢（10 s / 30 s 参考语音）
        assert r.miss > 0.0 and r.speaker_error == pytest.approx(0.0, abs=1e-9)

    def test_hungarian_matches_brute_force_exactly(self):
        """**匹配器本身**必须与穷举逐值一致——否则"修好映射"只是换了个 bug。

        300 组随机矩阵（含并列/零权重/n_hyp 远大于 n_ref），逐组比对最优命中数。
        """
        from itertools import permutations

        import numpy as np

        rng = np.random.default_rng(20261012)
        mismatches = 0
        for trial in range(300):
            n = int(rng.integers(1, 6))
            m = int(rng.integers(n, 10))
            w = rng.integers(0, 50, size=(n, m)).astype(np.float64)
            if trial % 3 == 0:
                w[int(rng.integers(0, n)), int(rng.integers(0, m))] = 0.0
            best = -1.0
            for cols in permutations(range(m), n):
                best = max(best, sum(w[r, cols[r]] for r in range(n)))
            rows, col = der._max_weight_matching(w)
            got = sum(w[r, col[r]] for r in range(len(rows)))
            if abs(got - best) > 1e-9:
                mismatches += 1
        assert mismatches == 0

    def test_hungarian_requires_rows_le_cols(self):
        import numpy as np
        import pytest

        with pytest.raises(ValueError):
            der._max_weight_matching(np.zeros((3, 2)))

    def test_hungarian_bounded_at_gate_worst_case(self):
        """门内最坏形态（n_ref=8, n_hyp=200）必须**毫秒级**——否则整套评测跑不完。

        这是把穷举换成匈牙利的直接理由：穷举的正确形式是 P(n_hyp,m)×P(n_ref,m)，
        实测把中文 K 阶梯从 ~20 min 拖到 500 s/场。
        """
        import time

        import numpy as np

        rng = np.random.default_rng(0)
        w = rng.integers(0, 1000, size=(8, 200)).astype(np.float64)
        t0 = time.perf_counter()
        _, col = der._max_weight_matching(w)
        elapsed = time.perf_counter() - t0
        assert elapsed < 0.5, elapsed
        assert len(set(col.tolist())) == 8  # 单射

    def test_regression_old_implementation_would_fail(self):
        """**负向对照**：把旧的"只排列前 m 个假设"逻辑原地复算一遍，必须给出更差的分数。

        这证明本组用例真的在测那个缺陷，而不是在测别的东西。
        """
        from itertools import permutations

        import numpy as np

        # 用已加载的常设实现里的私有助手，**不新开 import**（tools/ 不在 testpaths 的 path 上）
        COLLAR_S, FRAME_S = der.COLLAR_S, der.FRAME_S
        _collar_mask, _hyp_frames = der._collar_mask, der._hyp_frames
        _ref_frames = der._ref_frames

        ref = self._ref_three()
        hyp = [(0.0, 0.2, "X0"), (0.0, 10.0, "X1"), (20.0, 30.0, "X2"), (40.0, 50.0, "X3")]
        n_frames = int(round(60.0 / FRAME_S))
        ref_count, ref_owner = _ref_frames(ref, n_frames)
        hyp_owner = _hyp_frames(hyp, n_frames)
        collar = _collar_mask(ref, n_frames, COLLAR_S)
        scored = (ref_count > 0) & (ref_count == 1) & (~collar)
        n_scored = int(scored.sum())
        n_ref = int(ref_owner.max()) + 1
        n_hyp = int(hyp_owner.max()) + 1
        cont = np.zeros((n_ref, n_hyp), dtype=np.int64)
        both = scored & (hyp_owner >= 0) & (ref_owner >= 0)
        np.add.at(cont, (ref_owner[both], hyp_owner[both]), 1)
        hit_frames = n_scored - int(((hyp_owner == -1) & scored).sum())
        # 旧逻辑
        old_hit = -1
        for target in permutations(range(n_ref), min(n_hyp, n_ref)):
            old_hit = max(old_hit, sum(int(cont[r, h]) for h, r in enumerate(target)))
        miss = int(((hyp_owner == -1) & scored).sum())
        fa = int(((hyp_owner != -1) & (ref_count == 0) & (~collar)).sum())
        old_der = (miss + (hit_frames - max(old_hit, 0)) + fa) / n_scored
        new_der = der.score(ref, hyp, total_s=60.0, ignore_overlap=True).der
        assert old_der > new_der + 0.1, (old_der, new_der)


class TestSelftestHarness:
    def test_run_selftest_all_pass(self):
        assert der.run_selftest(verbose=False) == []

    def test_forwarder_shares_one_implementation(self):
        # spike 侧的薄转发必须与常设实现**同源**（防止两份实现漂移）
        fwd = _load(
            "spike_der_forwarder",
            ROOT / "tools" / "spikes" / "w22_speaker" / "der.py",
        )
        assert fwd.FRAME_S == der.FRAME_S
        assert fwd.score(REF, list(REF), total_s=TOTAL).der == pytest.approx(
            der.score(REF, list(REF), total_s=TOTAL).der
        )
        # 真正的"同源"检查：转发器用到的 score 必须**来自常设实现那个文件**，
        # 而不是在 der.py 里另有一份拷贝。
        # 区分力：把实现复制回 der.py（两份实现漂移）⇒ 本断言红。
        # （原为 `assert find_spec("diarization") is not None or True` —— `X or True` 恒真、
        #   什么也没断言；2026-10-11 复核发现并改为上面这条有牙的检查。）
        assert Path(fwd.score.__code__.co_filename).resolve() == (QE / "diarization.py").resolve()
        assert Path(der.score.__code__.co_filename).resolve() == (QE / "diarization.py").resolve()
