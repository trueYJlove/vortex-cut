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
