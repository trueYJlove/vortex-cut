"""W3.3 关键帧盲评统计（A9 的「可独立运行」交付物）。

读评分表 → 算主指标 → 输出 result.json。

统计口径由 PRE_REGISTRATION.md §3 冻结：主指标 = 合理率，
且**必须与样本量限制同报**（15 帧的 95% CI 约 ±25pp）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

TIERS = ("合理", "部分合理", "不合理")


def parse_sheet(text: str) -> tuple[list[dict[str, str]], list[str]]:
    """解析评分表行。返回 (每帧的档位, 未勾选/多勾选的编号)。"""
    rows: list[dict[str, str]] = []
    problems: list[str] = []
    for line in text.splitlines():
        if not line.startswith("| sample-"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 6:
            continue
        sample_id = cells[0]
        marks = cells[3:6]
        checked = [TIERS[i] for i, mark in enumerate(marks) if mark and mark not in ("☐", "")]
        if len(checked) != 1:
            problems.append(sample_id)
            continue
        rows.append({"sample_id": sample_id, "tier": checked[0]})
    return rows, problems


def summarize(rows: list[dict[str, str]], problems: list[str]) -> dict[str, object]:
    """按预登记口径统计。"""
    total = len(rows)
    counts = {tier: sum(1 for row in rows if row["tier"] == tier) for tier in TIERS}
    rate = (counts["合理"] / total) if total else None
    caveat = (
        f"样本量限制：{total} 帧的 95% 置信区间约 ±25 个百分点；"
        "本结果不得表述为「准确率 N%」，亦不得用于模型间比较。"
    )
    return {
        "sample_count": total,
        "counts": counts,
        "agree_rate": round(rate, 4) if rate is not None else None,
        "unscored_or_ambiguous": problems,
        "caveat": caveat,
    }


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print("用法: python summarize.py <score-sheet-done.md>")
        return 2
    text = Path(args[0]).read_text(encoding="utf-8")
    rows, problems = parse_sheet(text)
    result = summarize(rows, problems)
    Path("result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
