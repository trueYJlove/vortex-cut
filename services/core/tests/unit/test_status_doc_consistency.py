"""文档同步纪律的机器校验（AGENTS.md「Documentation Sync Discipline」Rule 2）。

**这不是 Core 领域测试**——它是仓库级治理检查。放在 Core 单测目录，是因为
Core 全量回归是本仓库既有的强制回归门；治理检查必须挂在"会被真正执行"的地方，
否则就是又一纸空文（2026-09-24 审计的核心教训）。

校验三件事：

1. **事实块一致性**：`docs/STATUS.md` §1 的机器可读块必须等于代码实际值。
   新增/修改迁移、白名单 op、CV 算法版本、协议版本时若不同步更新 STATUS.md，本测试红。
2. **过期表述黑名单**：非历史文档不得重新引入已知过期表述。
   "历史文档"由 `docs/STATUS.md` §6 的表格声明——把某文档列入 §6 即自动豁免黑名单，
   因此豁免集是自维护的，不需要在本文件里手工维护列表。
3. **正文数值复述一致性**：STATUS.md 正文散文里写死的数字（如"算法版本 3"、
   "23 种显式冻结"）也必须等于 §1 事实块。§1 只覆盖结构化声明，正文复述是 2026-09-24
   至 2026-10-09 之间静默存活的一处盲区——本测试把它一并纳入机器校验。

维护方式见 `docs/STATUS.md` §7。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from aivs_core.database import MIGRATIONS
from aivs_core.media.cv_signals import CV_ALGORITHM_VERSION
from aivs_core.timeline import AI_PATCH_OPERATIONS, PATCH_OPERATIONS

REPO = Path(__file__).resolve().parents[4]
STATUS_DOC = REPO / "docs/STATUS.md"

_FACTS_BEGIN = "<!-- STATUS-FACTS-BEGIN -->"
_FACTS_END = "<!-- STATUS-FACTS-END -->"

# 已知过期表述：一旦在**非历史文档**中以"断言"形式出现即失败。
# 只收"确定已消亡"的表述——宁可少收，不可误伤（误伤会让人绕过这套机制）。
STALE_PHRASES = (
    "处于 Stage 2C",
    "项目当前处于 Stage 2C",
    "Stage 3 尚未实现",
)

# 修正语境标记：同一行出现任一标记时，视为"引用/勘误"而非"断言"，豁免。
# 设计理由：修正文档时必然要引用被修正的原文（否则读者不知改了什么），
# 若连引用都禁止，这套机制就会因为误伤而被绕过——那比不检查更糟。
_CORRECTION_MARKERS = (
    "曾", "历史", "已修正", "已被", "已过期", "过期", "教训",
    "不再", "取代", "~~", "修正", "勘误",
)

# 扫描范围：人类入口与 docs 下的全部 Markdown。
_SCAN_GLOBS = ("*.md", "docs/**/*.md")

# 正文数值复述：STATUS.md 散文里写死的数字必须等于 §1 事实块。
# 键 = 事实块字段；值 = (正则, 人类可读说明)。正则必须捕获数字。
# 只登记"确实被正文复述过"的字段——没有正文复述的字段无需在此出现。
_PROSE_NUMBER_PATTERNS = {
    "cv_algorithm_version": (r"算法版本\s*(\d+)", "CV 信号算法版本"),
    "ai_patch_operations": (r"(\d+)\s*种显式冻结", "AI 操作白名单条数"),
}


def _status_text() -> str:
    assert STATUS_DOC.is_file(), f"状态源缺失：{STATUS_DOC}"
    return STATUS_DOC.read_text(encoding="utf-8")


def _status_facts() -> dict:
    """解析 STATUS.md 的事实块（marker 之间的 JSON）。"""
    text = _status_text()
    assert _FACTS_BEGIN in text, "STATUS.md 缺少事实块起始 marker"
    assert _FACTS_END in text, "STATUS.md 缺少事实块结束 marker"
    block = text.split(_FACTS_BEGIN, 1)[1].split(_FACTS_END, 1)[0]
    start, end = block.find("{"), block.rfind("}")
    assert start != -1 and end != -1, "事实块内未找到 JSON 对象"
    return json.loads(block[start:end + 1])


def _historical_docs() -> set[Path]:
    """STATUS.md §6 声明的历史文档（自动豁免黑名单）。"""
    text = _status_text()
    marker = "## 6."
    assert marker in text, "STATUS.md 缺少 §6 历史状态文档索引"
    section = text.split(marker, 1)[1].split("## 7.", 1)[0]
    paths = re.findall(r"`([^`]+\.md)`", section)
    return {(REPO / p).resolve() for p in paths}


def _live_markdown() -> list[Path]:
    excluded = _historical_docs() | {STATUS_DOC.resolve()}
    found: dict[Path, None] = {}
    for pattern in _SCAN_GLOBS:
        for path in REPO.glob(pattern):
            resolved = path.resolve()
            if resolved in excluded or not path.is_file():
                continue
            found[resolved] = None
    return sorted(found)


# ---- 1. 事实块一致性 ----


def test_status_facts_match_code() -> None:
    facts = _status_facts()
    actual = {
        "protocol_version": _protocol_version(),
        "latest_migration": _latest_migration(),
        "patch_operations": len(PATCH_OPERATIONS),
        "ai_patch_operations": len(AI_PATCH_OPERATIONS),
        "cv_algorithm_version": CV_ALGORITHM_VERSION,
    }
    drift = {
        key: {"status_md": facts.get(key), "code": value}
        for key, value in actual.items()
        if facts.get(key) != value
    }
    assert not drift, (
        "docs/STATUS.md §1 的事实块与代码不一致——改了代码就必须同步改状态源："
        f"{json.dumps(drift, ensure_ascii=False)}"
    )


def test_status_prose_numbers_match_facts() -> None:
    """STATUS.md 正文散文里复述的数字必须等于 §1 事实块。

    背景（2026-10-09 发现，见 §4 P65）：§1 的结构化字段有机器校验，但 §3 散文
    里写死的数字曾自建立日起就与代码不符（CV 算法版本、白名单条数），多轮全量
    回归全绿放行——"复述"绕过了唯一被校验的那一份声明（Rule 5 预言的失败模式）。
    本测试把正文复述拉回校验范围，与 §1 用同一个事实来源比对。

    按行判定并沿用 _CORRECTION_MARKERS 豁免，理由与黑名单测试相同：
    勘误/登记历史旧值时必然要引用被修正的数字（§4 P65 行本身就引用了旧值），
    连引用都禁止会让这套机制因误伤而被绕过——那比不检查更糟。
    """
    text = _status_text()
    facts = _status_facts()
    for field in _PROSE_NUMBER_PATTERNS:
        assert facts.get(field) is not None, f"正文复述登记了未知事实字段：{field}"
    drift: list[str] = []
    in_facts_block = False
    for lineno, line in enumerate(text.splitlines(), start=1):
        if _FACTS_BEGIN in line:
            in_facts_block = True
            continue
        if _FACTS_END in line:
            in_facts_block = False
            continue
        if in_facts_block or any(marker in line for marker in _CORRECTION_MARKERS):
            continue
        for field, (pattern, label) in _PROSE_NUMBER_PATTERNS.items():
            expected = facts[field]
            for match in re.finditer(pattern, line):
                if int(match.group(1)) != expected:
                    drift.append(
                        f"docs/STATUS.md:{lineno} {label}：正文写 {match.group(1)}，"
                        f"§1 {field} = {expected}"
                    )
    assert not drift, (
        "docs/STATUS.md 正文散文复述的数字与 §1 事实块不一致——"
        "复述即漂移的起点（AGENTS.md 文档同步纪律 Rule 5）：\n  "
        + "\n  ".join(drift)
    )


def test_status_prose_number_patterns_actually_match() -> None:
    """反向对照：登记的每个正文模式必须真的能匹配到东西。

    否则模式写错（错别字/格式变了）会让上面那条测试**恒真**——这正是
    "有校验但校验失效"的经典失败模式，必须自带区分力证明。
    """
    text = _status_text()
    unmatched = [
        f"{label}（模式 {pattern!r}）"
        for field, (pattern, label) in _PROSE_NUMBER_PATTERNS.items()
        if not re.search(pattern, text)
    ]
    assert not unmatched, (
        "以下正文复述模式在 STATUS.md 中匹配不到任何内容，"
        "说明模式已失效、对应校验形同虚设：\n  " + "\n  ".join(unmatched)
    )


def test_status_facts_block_has_no_unknown_keys() -> None:
    """事实块不得残留已废弃字段（防止字段改名后留下僵尸条目）。"""
    known = {
        "protocol_version",
        "latest_migration",
        "patch_operations",
        "ai_patch_operations",
        "cv_algorithm_version",
    }
    unknown = set(_status_facts()) - known
    assert not unknown, f"STATUS.md 事实块含未知字段：{sorted(unknown)}"


def _protocol_version() -> int:
    text = (REPO / "packages/contracts/src/index.ts").read_text(encoding="utf-8")
    match = re.search(r"PROTOCOL_VERSION\s*=\s*(\d+)", text)
    assert match, "未能从 contracts 解析 PROTOCOL_VERSION"
    return int(match.group(1))


def _latest_migration() -> int:
    versions = []
    for key in MIGRATIONS:
        match = re.fullmatch(r"v(\d+)", str(key))
        assert match, f"MIGRATIONS 键格式非预期：{key!r}"
        versions.append(int(match.group(1)))
    assert versions, "MIGRATIONS 为空"
    return max(versions)


# ---- 2. 过期表述黑名单 ----


def test_no_stale_status_claims_in_live_docs() -> None:
    """非历史文档不得以**断言**形式重新引入过期表述。

    按行判定：同一行含修正语境标记（见 `_CORRECTION_MARKERS`）时豁免——
    修正文档必须能引用被修正的原文。
    """
    offenders: list[str] = []
    for path in _live_markdown():
        text = path.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if any(marker in line for marker in _CORRECTION_MARKERS):
                continue
            for phrase in STALE_PHRASES:
                if phrase in line:
                    rel = path.relative_to(REPO)
                    offenders.append(f"{rel}:{lineno}: {phrase}")
    assert not offenders, (
        "非历史文档中以断言形式出现已知过期表述。三选一：\n"
        "  ① 修正该表述，改为引用 docs/STATUS.md；\n"
        "  ② 若是在记录勘误/历史教训，在该行加上修正语境标记（如「曾」「已修正」「~~」）；\n"
        "  ③ 若该文档确为点时间记录，登记到 docs/STATUS.md §6 获得豁免。\n"
        + "\n".join(offenders)
    )


def test_historical_docs_actually_exist() -> None:
    """§6 登记的路径必须真实存在——防止登记名写错导致豁免静默失效。"""
    missing = [
        str(path.relative_to(REPO))
        for path in sorted(_historical_docs())
        if not path.is_file()
    ]
    assert not missing, f"STATUS.md §6 登记了不存在的文档：{missing}"


@pytest.mark.parametrize("anchor", ["## 1.", "## 4.", "## 6.", "## 7."])
def test_status_doc_keeps_required_sections(anchor: str) -> None:
    """状态源的结构本身也是契约——缺节会让纪律无从落地。"""
    assert anchor in _status_text(), f"docs/STATUS.md 缺少必需章节：{anchor}"
