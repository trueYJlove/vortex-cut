"""复验 CHECK 用例的区分力：移除 v38 的 CHECK 约束后它必须变红。

初版用例恒真（见实施记录 §4）：用 `raise AssertionError` 表达"INSERT 不该成功"，
却被同一个 `except Exception` 捕获 ⇒ 约束缺失时反而通过。修正后本脚本必须给出
"基线绿 / 移除 CHECK 红 / 回滚绿"三行。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
V38 = REPO / "services" / "core" / "src" / "aivs_core" / "database_v38.py"
PY = REPO / ".venv" / "Scripts" / "python.exe"
CORE = REPO / "services" / "core"
ORIG = V38.read_text(encoding="utf-8")

CHECK_LINE = (
    "ALTER TABLE speaker_diarizations ADD COLUMN quality_status TEXT NOT NULL "
    "DEFAULT 'unvalidated'\n  CHECK(quality_status IN ('validated','unvalidated'));")
if CHECK_LINE not in ORIG:
    raise SystemExit("v38 的 CHECK 行未命中，脚本需同步")

NOCHECK = ORIG.replace(
    CHECK_LINE,
    "ALTER TABLE speaker_diarizations ADD COLUMN quality_status TEXT NOT NULL "
    "DEFAULT 'unvalidated';")

T = ["tests/unit/test_speaker_quality_annotation.py::"
     "TestQualityAnnotation::test_quality_status_check_constraint_rejects_unknown_value"]


def run(tb: str = "--tb=no") -> str:
    p = subprocess.run([str(PY), "-m", "pytest", *T, "-q", tb, "-p", "no:cacheprovider"],
                       cwd=CORE, capture_output=True, text=True)
    out = p.stdout.strip()
    return out.splitlines()[-1] if out else "(no output)"


print(f"基线（CHECK 在位，应绿）        : {run()}")
try:
    V38.write_text(NOCHECK, encoding="utf-8")
    print(f"负向对照（移除 CHECK，必须红）  : {run('--tb=line')}")
finally:
    V38.write_text(ORIG, encoding="utf-8")
print(f"回滚后（应复绿）                : {run()}")
