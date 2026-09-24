"""文档同步纪律的机器校验（AGENTS.md「Documentation Sync Discipline」Rule 2）。

**这不是 Core 领域测试**——它是仓库级治理检查。放在 Core 单测目录，是因为
Core 全量回归是本仓库既有的强制回归门；治理检查必须挂在"会被真正执行"的地方，
否则就是又一纸空文（2026-09-24 审计的核心教训）。

校验两件事：

1. **事实块一致性**：`docs/STATUS.md` §1 的机器可读块必须等于代码实际值。
   新增/修改迁移、白名单 op、CV 算法版本、协议版本时若不同步更新 STATUS.md，本测试红。
2. **过期表述黑名单**：非历史文档不得重新引入已知过期表述。
   "历史文档"由 `docs/STATUS.md` §6 的表格声明——把某文档列入 §6 即自动豁免黑名单，
   因此豁免集是自维护的，不需要在本文件里手工维护列表。

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
