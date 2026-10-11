"""DER 评分器 —— **薄转发**到常设实现 `tools/quality_eval/diarization.py`。

Design Gate §6 S0 ① 要求：仪器从 spike 提升为常设（`tools/quality_eval/`），
且**自检以 pytest 用例形态落进 `services/core/tests`**（`pyproject` 的 `testpaths`
只收 core —— 迁到 tools 的自检不会进任何门，复核 F2 实测）。

本文件保留为**薄转发**，唯一目的是防"两份实现漂移"：spike 侧的历史脚本
（`ami_eval.py` / `aishell_eval.py` / `threshold_strategies.py` /
`normalization_experiment.py`）仍 `from spikes.w22_speaker.der import ...`，
它们读到的必须是**同一份实现**。这里**不复制任何逻辑**。

旧版（原地实现）的最后 sha256 记录在 `evidence/2026-10-11-ami-diarization/harness.sha256`
（`6130d8d4...`），可据此追溯迁移前的结果。
"""

from __future__ import annotations

import sys
from pathlib import Path

# tools/quality_eval 加入 sys.path（本文件位于 tools/spikes/w22_speaker/）
_QE = Path(__file__).resolve().parents[2] / "quality_eval"
if str(_QE) not in sys.path:
    sys.path.insert(0, str(_QE))

from diarization import (  # noqa: E402,F401
    COLLAR_S,
    FRAME_S,
    SELFTEST_REF,
    SELFTEST_TOTAL_S,
    DerResult,
    load_rttm,
    run_selftest,
    score,
)

__all__ = [
    "COLLAR_S",
    "FRAME_S",
    "SELFTEST_REF",
    "SELFTEST_TOTAL_S",
    "DerResult",
    "load_rttm",
    "run_selftest",
    "score",
]


if __name__ == "__main__":
    raise SystemExit(0 if not run_selftest() else 1)
