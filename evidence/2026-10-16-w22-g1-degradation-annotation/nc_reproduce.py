"""G1 负向对照独立复现（2026-10-16 复核）。

用途：不信任实现时的自我陈述，由本脚本临时改写生产文件 → 跑测试 → 回滚 → 复绿，
把三组对照的红数打到 stdout。补丁用字面替换并**断言命中**，命中失败即中止
（防"补丁没打上却报告通过"的静默失效）。

运行：仓库根目录 `.venv/Scripts/python.exe evidence/2026-10-16-w22-g1-degradation-annotation/nc_reproduce.py`
读数：`nc_result.txt`（本目录）
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SVC = REPO / "services" / "core" / "src" / "aivs_core" / "media" / "speaker_service.py"
PY = REPO / ".venv" / "Scripts" / "python.exe"
CORE = REPO / "services" / "core"
ORIGINAL = SVC.read_text(encoding="utf-8")

# NC1：只改 **INSERT** 语句（列清单 / 占位符 / 取值实参），**不动** SUMMARY_COLUMNS 与 summary DTO
#     ——窗口过宽会连带打红别的用例，得出错误的对照口径。
_NC1_INSERT_COLS = re.compile(
    r'quality_status,quality_basis,usable_for,"\n(\s*)"created_at,updated_at,finished_at\) "')
_NC1_PLACEHOLDERS = ("VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
_NC1_VALUES_A = ("                    QUALITY_STATUS_UNVALIDATED,\n"
                 "                    QUALITY_GATE_BASIS,\n"
                 "                    USABLE_FOR_REFERENCE_ONLY,\n", "")
_NC1_VALUES_B = ("                    QUALITY_STATUS_UNVALIDATED, QUALITY_GATE_BASIS,\n"
                 "                    USABLE_FOR_REFERENCE_ONLY,\n", "")

NC1 = [("INSERT 列清单", _NC1_INSERT_COLS, r'"\n\1"created_at,updated_at,finished_at) "'),
       ("placeholder", *_NC1_PLACEHOLDERS),
       ("values(A)", *_NC1_VALUES_A),
       ("values(B)", *_NC1_VALUES_B)]

NC2 = [
    ('            "quality_status": row["quality_status"],\n'
     '            "quality_basis": row["quality_basis"],\n'
     "            \"usable_for\": json_loads(row[\"usable_for\"] or '[\"reference\"]'),\n", ""),
]

NC3 = [
    ("USABLE_FOR_REFERENCE_ONLY = '[\"reference\"]'",
     "USABLE_FOR_REFERENCE_ONLY = '[\"reference\",\"multicam_switch\"]'"),
]

TESTS = ["tests/unit/test_speaker_quality_annotation.py",
         "tests/unit/test_speaker_storage.py"]


def apply_nc1() -> None:
    text = ORIGINAL
    new, n = _NC1_INSERT_COLS.subn(r'"\n\1"created_at,updated_at,finished_at) "', text)
    if n != 2:
        raise SystemExit(f"NC1 列清单命中 {n} 处（应为 2），对照无效")
    text = new
    # 两处 INSERT（analyze_pcm 与 _write_row）共用同一段列清单与占位符；
    # 取值实参因缩进/换行不同而分成两种写法。逐项断言命中数，防窗口失效。
    expected = {"placeholder": 2, "values(A)": 1, "values(B)": 1}
    for name, old, repl in NC1[1:]:
        c = text.count(old)
        if c != expected[name]:
            raise SystemExit(f"NC1 {name} 命中 {c} 处（应为 {expected[name]}），对照无效")
        text = text.replace(old, repl)
    # 自检：不得误伤投影与 DTO（否则又变成"窗口过宽"的错误对照）
    assert "quality_status" in text.split("SUMMARY_COLUMNS = (")[1].split(")")[0]
    assert '"quality_status": row["quality_status"]' in text
    SVC.write_text(text, encoding="utf-8")


def apply(patches: list[tuple[str, str]], label: str) -> None:
    text = ORIGINAL
    for old, new in patches:
        if old not in text:
            raise SystemExit(f"[{label}] 补丁未命中，对照无效：{old[:60]!r}")
        text = text.replace(old, new)
    SVC.write_text(text, encoding="utf-8")


def revert() -> None:
    SVC.write_text(ORIGINAL, encoding="utf-8")


def run() -> str:
    p = subprocess.run([str(PY), "-m", "pytest", *TESTS, "-q", "--tb=no",
                        "--tb=no", "-p", "no:cacheprovider"],
                       cwd=CORE, capture_output=True, text=True)
    out = p.stdout.strip()
    return out.splitlines()[-1] if out else "(no output)"


def main() -> int:
    print("=== G1 负向对照独立复现（补丁 -> 跑测试 -> 回滚）===")
    print(f"基线（未打补丁）: {run()}")

    apply_nc1()
    try:
        print(f"NC1 去 INSERT 三列            -> {run()}")
    finally:
        revert()

    apply(NC2, "NC2")
    try:
        print(f"NC2 去摘要 DTO 三字段          -> {run()}")
    finally:
        revert()

    apply(NC3, "NC3")
    try:
        print(f"NC3 usable_for 加 multicam_switch -> {run()}")
    finally:
        revert()

    print(f"回滚后基线: {run()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
