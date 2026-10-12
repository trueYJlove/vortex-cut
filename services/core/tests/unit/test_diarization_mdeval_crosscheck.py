r"""W2.2 §5.3 —— 独立仪器交叉校验工具的 pytest 形态。

**为什么要为"校验工具"再写测试**：本工具的作用是**质疑验收仪器本身**。
若它自己解析错、或把"口径不同"误读成"实现有错"，就会把决策带偏。
故这里钉死三件事：

1. **DER 解析必须真的解析**（对真实 md-eval 输出形态），且**解析失败要抛错**——
   不能静默返回 0（那会让"两边一致"变成恒真）。
2. **RTTM 写出的字段位置必须正确**（md-eval 按列号读），否则交叉校验比的是错的东西。
3. **本仓评分器的口径开关必须语义正确**（ignore_overlap ⇔ md-eval -1）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"
sys.path.insert(0, str(QE))
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


xc = _load("quality_eval_mdeval_crosscheck", QE / "diarization_mdeval_crosscheck.py")

# md-eval-22.pl 实测输出片段（-1 口径）
SAMPLE_OUTPUT = """
SCORED SPEAKER TIME =1114.850000 secs
MISSED SPEAKER TIME =137.350000 secs
FALARM SPEAKER TIME =12.980000 secs
SPEAKER ERROR TIME =403.480000 secs
 OVERALL SPEAKER DIARIZATION ERROR = 49.68 percent of scored speaker time  (ALL)
"""


class TestParseDer:
    def test_parses_overall_line(self):
        assert xc._parse_der(SAMPLE_OUTPUT) == 0.4968

    def test_prefers_overall_over_percent_total(self):
        """带 UEM 时会出现 'Percent Total Error'；OVERALL (ALL) 才是全说话人合计口径。"""
        txt = "Percent Total Error       =  12.34\n" + SAMPLE_OUTPUT
        assert xc._parse_der(txt) == 0.4968

    def test_falls_back_to_percent_total(self):
        assert xc._parse_der("Percent Total Error       =  12.34") == 0.1234

    def test_unparseable_raises_instead_of_returning_zero(self):
        """**负向对照**：解析不了必须抛错，绝不返回 0（否则"两边一致"恒真）。"""
        import pytest

        with pytest.raises(RuntimeError):
            xc._parse_der("no numbers here at all")


class TestParseDerIsExposed:
    def test_module_exposes_parse_helper(self):
        assert callable(xc._parse_der)
        assert callable(xc.write_rttm)


class TestWriteRttm:
    def test_field_positions_match_rttm_spec(self, tmp_path: Path):
        """md-eval 按**列号**读 RTTM：SPEAKER <uri> <ch> <start> <dur> <...> <spkr> <...>。"""
        p = tmp_path / "x.rttm"
        xc.write_rttm(p, [(1.5, 3.0, "spk7")], uri="meetA")
        f = p.read_text(encoding="utf-8").split()
        assert f[0] == "SPEAKER"
        assert f[1] == "meetA"
        assert f[3] == "1.500" and f[4] == "1.500"  # start / duration
        assert f[7] == "spk7"

    def test_skips_nonpositive_durations(self, tmp_path: Path):
        p = tmp_path / "y.rttm"
        xc.write_rttm(p, [(5.0, 5.0, "spk1"), (0.0, 1.0, "spk2")], uri="m")
        lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        assert len(lines) == 1
        assert "spk2" in lines[0]


class TestScorerOverlapSemantics:
    """交叉校验的**口径映射**前提：本仓 ignore_overlap=False 必须真的把重叠放进分母。"""

    def test_count_overlap_increases_scored_frames(self):
        der = _load("quality_eval_diarization_for_xc", QE / "diarization.py")
        ref = [(0.0, 10.0, "A"), (5.0, 15.0, "B")]  # 5–10 s 重叠
        hyp = [(0.0, 15.0, "S")]
        ig = der.score(ref, hyp, total_s=20.0, ignore_overlap=True)
        kp = der.score(ref, hyp, total_s=20.0, ignore_overlap=False)
        assert kp.scored_frames > ig.scored_frames
