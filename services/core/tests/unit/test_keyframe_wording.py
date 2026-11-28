"""W3.3 A9 ②：优越性表述的**正则负向检查**（机器判据）。

规划门 §4 A9 原文：
> ② 对实施记录与门文档做**正则负向检查**：出现"更好/优于/优于单源/质量提升"
>   等优越性表述即失败（**白名单语境豁免**，照 STATUS.md 一致性测试的修正
>   语境豁免做法）

**为什么这条检查必须存在**：本仓的失败模式不是"写了优越性表述"，而是
"声明质量结论却没有任何机器判据拦着"（P147 融合排序、W2.2 精度门、P142 命中率）。
A9 ①（预登记）钉的是"看数之前先定判据"，②（本文件）钉的是"事后不得悄悄
改口说更好"。两者缺一，质量口径就只剩自觉。

**为什么自己写正则而不是复用 test_status_doc_consistency 的黑名单**：
那边的 STALE_PHRASES 匹配的是**整句过期表述**（"处于 Stage 2C"），其豁免
标记是"修正语境"（曾/历史/已修正…）。语义结构不同——这边要拦的是**比较级
形容词**，豁免语境是**否定/免责**（不承诺/不得/未证…）。复用一个列表会让
两套判据互相污染：把"不承诺"塞进 STALE_PHRASES 的豁免集，会让过期表述
也能靠说"不承诺"蒙混过关。

---

## 扫描范围

`docs/W3_3_*.md` —— **glob 全量**，不写死文件名列表。理由：将来新增的
实施记录必须自动被覆盖；写死列表正是让新记录"自动逃逸"的那种写法。

## 判据

对每个文件逐行匹配 SUPERIORITY_PATTERN；命中且**不属于白名单语境** ⇒ 失败。

### 白名单语境（窄，且必须可证）

豁免**不是按文件**给的——按文件整体豁免会让那条门文档变成盲区（A9 原文
自身就含这些词，整体豁免等于把唯一有判据的地方挖空）。三种语境：

  W1 **判据原文自带标记**：同一行含 "优越性表述" 或 "等优越性" 或 "即失败"。
     这是 A9 那条验收行**描述判据**的语境，删掉它这条检查就没有出处了。
     标记是行内的，不依赖文件名。
  W2 **否定/免责语境**：同一行含任一否定词（不承诺 / 不得 / 未证 / 不声称 /
     无基线 / 不算 / 不能证明 / 禁止 / 不主张 / 不构成）。这是
     "本门不承诺打标质量优于任何基线"那类**正确的**表述——它恰恰是 A9 想要
     的东西，拦掉它会逼人删掉免责声明。
  W3 **引用/勘误语境**：同一行含 曾 / 历史 / 已修正 / 已被 / 已过期 / 不再 /
     取代 / 修正 / 勘误 / ~~ 。照抄 STATUS 一致性测试的修正语境做法。
**豁免集刻意只保留这三种**，全部由门 §4 A9 原文与 STATUS 一致性测试的
既有做法背书。早先还试过一条「代码形态搭配」豁免，已在收口时**删除**：
门里没有这条，且它存在的唯一理由是一处实施记录的行文
（W3_3_S2_IMPLEMENTATION:82）——该行已由调度方改写为「但这反而让用例变强了」，
豁免随之失去理由。豁免越少，判据越硬。

**豁免规则的边界（如实）**：W1–W3 都是**行内**判据，因此"同一行的前半句说
不承诺、后半句说更好"不会被拦。这不是遗漏而是取舍——跨行/跨句语义判断
只能靠人；机器判据的职责是把**裸断言**拦住，而裸断言才是实际会发生的形态。
把这个局限写在这里，而不是让人以为它有语义理解能力。
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
DOCS = REPO / "docs"

# 扫描范围：递归 glob 全量（覆盖 keyframe-understanding 活规格与历史 W3_3_*/KEYFRAME_UNDERSTANDING_* 命名）。
# **不要**换成写死的文件名列表——那会让将来新增的实施记录自动逃逸。
SCAN_GLOBS = ("**/keyframe-understanding*.md", "**/W3_3_*.md", "**/KEYFRAME_UNDERSTANDING_*.md")

# 优越性表述。刻意做成一个显式枚举而不是宽泛的"更"前缀：
# 那会误伤"更多/更快/更少"等中性的工程描述（比如"更多帧被移除"），
# 而误伤是这套机制被绕过的最主要原因（见 test_status_doc_consistency 的同款注释）。
SUPERIORITY_PATTERN = re.compile(
    r"更好|更佳|更优|优先于|优于|质量提升|准确率更高|效果更好|显著提升|"
    r"性能更优|领跑|追平|反超|胜过|强于"
)

# W1：判据原文自带标记（A9 那一行在**描述**这条检查）。
_CRITERION_MARKERS = ("优越性表述", "等优越性", "即失败")

# W2：否定/免责语境。**本仓实际出现过的正确表述**是
# "本门不承诺打标质量优于任何基线"（规划门 :176），必须豁免。
_NEGATION_MARKERS = (
    "不承诺", "不得", "未证", "不声称", "无基线", "不算", "不能证明",
    "禁止", "不主张", "不构成", "不保证", "不意味着",
)

# W3：引用/勘误语境（照 STATUS.md 一致性测试的修正语境做法）。
_CORRECTION_MARKERS = (
    "曾", "历史", "已修正", "已被", "已过期", "不再", "取代", "修正", "勘误", "~~",
)

# （W4 代码形态豁免已在收口时删除，见模块头。）


def scan_paths() -> list[Path]:
    found: dict[Path, Path] = {}
    for pattern in SCAN_GLOBS:
        for path in DOCS.glob(pattern):
            found.setdefault(path.resolve(), path)
    return sorted(found.values(), key=lambda p: p.as_posix())


def hits_in(text: str) -> list[tuple[int, str, str]]:
    """返回 [(行号, 命中词, 该行)]，**不含**豁免语境。"""
    found: list[tuple[int, str, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = SUPERIORITY_PATTERN.search(line)
        if match is None:
            continue
        if _exempt(line):
            continue
        found.append((number, match.group(0), line))
    return found


def _exempt(line: str) -> bool:
    """判定一行是否属于白名单语境。三种标记任一命中即豁免。"""
    if any(marker in line for marker in _CRITERION_MARKERS):
        return True
    if any(marker in line for marker in _NEGATION_MARKERS):
        return True
    return any(marker in line for marker in _CORRECTION_MARKERS)


# ── 防恒真自检 ──


def test_pattern_matches_constructed_violation() -> None:
    """正则**确实**能命中违规文本。否则正则写错就永远绿。

    本仓已有"首版恒真被负向对照当场暴露"的先例（P142 / P150），
    所以这条自检不是形式要求：它是把"检查本身是否工作"变成可断言的事实。
    """
    assert SUPERIORITY_PATTERN.search("本方案质量提升明显")
    assert SUPERIORITY_PATTERN.search("该实现优于单源基线")
    assert SUPERIORITY_PATTERN.search("打标效果更好")
    assert SUPERIORITY_PATTERN.search("召回优于单源")


def test_pattern_does_not_match_neutral_engineering_phrasing() -> None:
    """反向自检：中性工程描述**不得**被误伤。

    误伤会让下一个人直接放宽正则（本仓既有教训），所以"不误伤"本身要有断言。
    """
    for neutral in (
        "更多帧被移除",
        "更早的版本没有索引",
        "更快收敛",
        "更少的内存占用",
        "优先用切点、间隔兜底",
    ):
        assert SUPERIORITY_PATTERN.search(neutral) is None, neutral


def test_scan_covers_all_w3_3_documents() -> None:
    """glob 全量：至少覆盖门文档 + 实施记录，且不含空集。

    这条钉的是"扫描范围"这一维——如果 glob 写错成空集，
    下面那条"全量通过"会**恒真**（空集上任何断言都成立）。
    """
    paths = scan_paths()
    names = {path.name for path in paths}
    # 活规格已收口为 docs/specs/keyframe-understanding.md。
    assert len(paths) >= 1, f"扫描集过小，疑似 glob 写错：{sorted(names)}"
    assert "keyframe-understanding.md" in names, names


def test_exemption_markers_are_narrow() -> None:
    """豁免标记必须窄到**不能豁免裸断言**。

    这是本文件最容易变成橡皮章的地方：只要有一个标记足够常见，
    整条检查就等于不存在。这里用构造的反例把它钉住。
    """
    assert not _exempt("本方案质量提升明显")
    assert not _exempt("该实现优于单源基线")
    # W2 的典型正确用法必须被豁免（否则逼人删掉免责声明）。
    assert _exempt("本门不承诺打标质量优于任何基线")

    # **代码形态搭配不再豁免**（W4 已于收口删除）：这条钉住"删除真的生效"。
    # 注意这是在测豁免集本身，不是在测文档——文档那行已被改写。
    assert not _exempt("但这反而暴露了更好的写法")
    assert hits_in("但这反而暴露了更好的写法"), "W4 删除后该形态必须命中"


def test_current_docs_have_no_superiority_claims() -> None:
    """**当前 docs/W3_3_*.md 全量扫描通过**（这是被检查对象本身）。"""
    violations: list[str] = []
    for path in scan_paths():
        for number, word, line in hits_in(path.read_text(encoding="utf-8")):
            violations.append(
                f"{path.name}:{number} 命中「{word}」 —— {line.strip()[:160]}"
            )
    assert not violations, (
        "W3.3 文档出现优越性表述（A9 ②）。若确属免责/引用语境，"
        "请在该行写明否定或修正标记，不要放宽本测试的白名单：\n"
        + "\n".join(violations)
    )


def test_a9_criterion_line_is_exempt_but_not_by_filename() -> None:
    """A9 那一行**含违规词却必须豁免**，且豁免来自行内标记而非文件名。

    这条是对"白名单要窄"的直接验证：如果豁免是整文件级的，
    同文件里任意一行写"质量提升明显"都会逃逸——第二段断言正好
    检验同一文件内的裸断言仍会被抓。
    """
    gate = DOCS / "specs/keyframe-understanding.md"
    text = gate.read_text(encoding="utf-8")
    a9_line = next(
        line for line in text.splitlines() if line.startswith("| **A9**")
    )
    assert SUPERIORITY_PATTERN.search(a9_line)  # 确实含违规词
    assert _exempt(a9_line)                      # 但被行内标记豁免

    injected = text + "\n本方案质量提升明显，显著提升召回。\n"
    found = hits_in(injected)
    assert found, "同一文件的裸断言必须被抓——否则豁免是文件级的"
