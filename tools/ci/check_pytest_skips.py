"""pytest skips 守卫：junitxml → 收集数/通过数下限 + 跳过白名单。

为什么需要它：pytest 对"用例被 skip"给的是**退出码 0**。本仓随包 ffmpeg
（resources/ffmpeg/win-x64/）不入库，runner 上若取不回二进制，44 个调 ffmpeg
的用例会静默跳过、流水线照样绿。同理"一个都没收集到"也是退出码 0
（pytest 8 的 no-tests-collected 仅在**未指定目标**时才是 5）。

所以门禁必须基于**结果文件**断言，而不是退出码：
  (a) 收集数 / 通过数不得低于 floor；
  (b) 每一个 skip 都必须命中白名单，白名单外的任何 skip 直接非零退出。

白名单条目必须同时写出 file::test 与理由；`*` 只允许用于"整模块因外部资产缺失
而跳过"的情形，且必须给 max 上限——不允许用它把整批 ffmpeg 用例放过。

单独运行（调试用）：
  uv run --locked --extra dev python tools/ci/check_pytest_skips.py --junit .tmp/ci/pytest-junit.xml
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_JUNIT = REPO_ROOT / ".tmp" / "ci" / "pytest-junit.xml"

# 理由与失败信息是中文；windows-latest 控制台代码页不是 UTF-8，
# 直接 print 会 UnicodeEncodeError，把正常判定变成假红。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")

# 收集/通过下限。两套实测读数（2026-10-23）：
#   本地（带全部资产）：收集 1590 / 通过 1589 / skip 1 / 0 failed
#   GitHub windows-latest（干净环境）：收集 1590 / 通过 1560 / skip 30 / 0 failed
# **收集数在两处完全一致（1590）**——这是本行最想钉住的事实：干净环境缺的是
# "跳过"而不是"少收集"，Pillow 之类的缺失会以 collection error 直接红，不会静默。
# 干净环境多出的 29 个跳过全部来自 CLIP/WordPiece tokenizer 对拍（需手工下载的
# 开发期资产，.gitignore 忽略 .tmp/），已在下方白名单内并写明理由。
# floor 取 1500：留出正常用例增删的余量，但足以拦住"0 collected"与
# "整个测试包被漏收集"（1590 → 1500 掉 90 条就会红）。
MIN_COLLECTED = 1500
# 通过数上限按**干净环境**取（1560），而不是本地的 1589：floor 必须能在
# CI 上成立，否则门会恒红。1450 相对 1560 留 110 条余量。
MIN_PASSED = 1450

# 允许的跳过：只有"在新克隆的仓库里本来就跑不了"的用例可以进来。
#
# 硬性边界：**不含任何随包 ffmpeg 依赖的用例**。工作流会在跑 pytest 之前按
# ffmpeg-manifest.json 取回二进制，那些用例一旦跳过就说明取回失败，必须红。
# 这也是为什么下面没有 test_keyframe_encode / test_keyframe_orchestration /
# test_loudness_measurement / test_decode_capability / test_keyframe_blind_eval
# / test_speaker_vad 的条目——它们在本仓 runner 上必须真跑。
#
# 条目的 tests 用**显式清单**而不是 "*"：整文件通配会把将来新增的、
# 本该真跑的用例一并放过。清单来源是实测（把 .tmp 资产移走后跑一遍，
# 逐条抄下 junit 里的 file::Class::test），不是猜的。
ALLOWED_SKIPS: list[dict] = [
    {
        "file": "services/core/tests/unit/test_clip_tokenizer.py",
        "tests": [
            "TestPretokenize::test_splits_words",
            "TestPretokenize::test_digits_split_individually",
            "TestPretokenize::test_contractions_kept",
            "TestPretokenize::test_whitespace_dropped",
            "TestEncoding::test_shape_and_special_tokens",
            "TestEncoding::test_padding_uses_mask",
            "TestEncoding::test_lowercased_and_normalized",
            "TestEncoding::test_truncation_keeps_end_of_text",
            "TestEncoding::test_known_vocab_ids",
            "TestAgainstReference::test_matches_reference_token_ids",
            "TestAgainstReference::test_matches_reference_when_truncated",
            "TestServiceIntegration::test_service_clip_tokenize_delegates",
        ],
        "reason": (
            "整文件 pytestmark=skipif(not TOKENIZER.is_file())：CLIP tokenizer.json 是"
            "受信模型资产，经 .tmp/clip-probe/ 手工下载，.gitignore 忽略 .tmp/，"
            "因此新克隆的仓库里必然缺失。"
            "为什么可接受：这些用例全部要读该 json 才能构造 ClipTokenizer，"
            "资产缺失时没有任何可断言的对象；且它们验的是 tokenizer 封装与参考实现对拍，"
            "不是本轮任何产品修复的回归面。注意本文件的 12 条全部受同一 skipif 支配，"
            "不存在'本该跑却被放过'的漏网用例。"
        ),
    },
    {
        "file": "services/core/tests/unit/test_wordpiece_tokenizer.py",
        "tests": [
            "test_wordpiece_matches_reference_token_for_token[*]",
            "test_chinese_chars_become_real_vocab_ids_not_byte_fragments",
            "test_long_input_is_truncated_to_context_len",
            "test_normalizer_lowercases_and_splits_cjk",
            "test_rejects_non_wordpiece_tokenizer",
        ],
        "reason": (
            "needs_asset=skipif(not TOKENIZER.exists())：中文 CLIP tokenizer.json（.tmp/cc-probe/）"
            "是开发期资产，同样落在 .gitignore 忽略的 .tmp/ 下。16 条跳过分属 5 个函数"
            "（test_wordpiece_matches_reference_token_for_token 有 12 个 param）。"
            "为什么可接受：它们都是与 HuggingFace tokenizers 参考实现的**对拍**，"
            "参考资产缺失时没有期望值可对；纯逻辑用例（load/normalize 的形状断言）"
            "不受该 skipif 影响，照常执行并真跑。"
        ),
    },
    {
        "file": "services/core/tests/unit/test_beat_analysis_job.py",
        "tests": ["TestBeatJob::test_real_click_track_full_chain_into_prepare"],
        "reason": (
            "test_real_click_track_full_chain_into_prepare 走 _require_real_media()："
            "需要 test-assets/generated/eval/music-110bpm.wav，该文件由 "
            "tools/fixtures/generate-media-fixtures.ps1 生成，落在 .gitignore 忽略的 "
            "test-assets/generated/ 下，不随仓库分发。"
            "为什么可接受：它验的是'真实节拍素材 → 完整链路'的端到端，"
            "节拍网格算法本身在同文件的合成信号用例里覆盖，不依赖该 wav。"
            "**注意只放行这 1 条**：同文件其余用例都不依赖资产，必须真跑。"
        ),
    },
    {
        "file": "services/core/tests/unit/test_vision_adapter.py",
        "tests": ["test_real_gateway_tags_a_real_frame"],
        "max": 1,
        "reason": (
            "真实外部 Provider 端到端：需要 AIVS_RUN_REAL_PROVIDER_TESTS=1 且网关 base/key/model "
            "三件套（pyproject 的 real_provider 标记即为此设计）。CI 无凭据、也不应把帧发给外部，"
            "跳过是**设计**而非降级；同一路由的合规逻辑由 mock 用例覆盖。"
        ),
    },
]


def _text(el: ET.Element | None, key: str) -> str:
    return "" if el is None else (el.get(key) or "")


def _rel_posix(raw: str, classname: str) -> str:
    """junit 的 file 属性在 Windows 上是反斜杠相对路径；统一成 posix 相对路径。"""
    if not raw:
        # 少数 junit family 不写 file 属性，用 classname 反推模块路径。
        mod = classname.split(".")
        raw = "/".join(mod)
    p = Path(raw.replace("\\", "/"))
    if p.is_absolute():
        try:
            p = p.resolve().relative_to(REPO_ROOT)
        except ValueError:
            pass
    return p.as_posix()


def _nodeid(file_path: str, classname: str, name: str) -> str:
    """file::Class::test 形式（pytest 失败时显示的同一形状）。"""
    stem = Path(file_path).stem
    parts = classname.split(".")
    tail: list[str] = []
    if stem in parts:
        tail = parts[parts.index(stem) + 1 :]
    return "::".join([file_path, *tail, name])


def _parse(junit: Path) -> tuple[list[dict], dict]:
    tree = ET.parse(junit)
    root = tree.getroot()
    cases: list[dict] = []
    for tc in root.iter("testcase"):
        skipped_el = tc.find("skipped")
        cases.append(
            {
                "nodeid": _nodeid(
                    _rel_posix(_text(tc, "file"), _text(tc, "classname")),
                    _text(tc, "classname"),
                    _text(tc, "name"),
                ),
                "file": _rel_posix(_text(tc, "file"), _text(tc, "classname")),
                "skipped": skipped_el is not None,
                "skip_msg": _text(skipped_el, "message"),
                "failed": tc.find("failure") is not None or tc.find("error") is not None,
            }
        )
    suite = root.find("testsuite")
    attrs = (
        {}
        if suite is None
        else {k: suite.get(k) for k in ("tests", "skipped", "failures", "errors")}
    )
    return cases, attrs


def _match(entry: dict, file_path: str, test_key: str) -> bool:
    """白名单匹配。

    ``fnmatch`` 不能直接用：pytest 的参数化 id 本身就带方括号
    （`test_x[\u732b]`、`test_x[cat]`），fnmatch 会把方括号当字符类，
    于是 `test_x[*]` 匹配不上 `test_x[cat]`。这里显式拆成
    "基名 + 参数段" 再比，语义只有两条：
      - `test_x[*]`  匹配 `test_x` 的任意参数化实例；
      - `TestCls::test_x` 精确匹配（含无参用例）。
    """
    if entry["file"] != file_path:
        return False
    base, _, params = test_key.partition("[")
    for pattern in entry["tests"]:
        if pattern == "*":
            return True
        p_base, _, p_params = pattern.partition("[")
        if p_base != base:
            continue
        if not p_params:  # 精确名（不带参数段）
            return True
        if p_params == "*]":  # 任意参数段
            return True
        if params and params == p_params:  # 指定某个参数实例
            return True
    return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="pytest skip/collection gate")
    ap.add_argument("--junit", default=str(DEFAULT_JUNIT), help="pytest --junitxml 产出的结果文件")
    ap.add_argument("--min-collected", type=int, default=MIN_COLLECTED)
    ap.add_argument("--min-passed", type=int, default=MIN_PASSED)
    args = ap.parse_args(argv)

    junit = Path(args.junit)
    if not junit.is_file():
        print(
            f"[skip-gate] FAIL 结果文件不存在：{junit}（pytest 未产出 junitxml）", file=sys.stderr
        )
        return 1

    cases, attrs = _parse(junit)
    if not cases:
        print(f"[skip-gate] FAIL 结果文件里没有任何 testcase：{junit}", file=sys.stderr)
        return 1

    collected = len(cases)
    skipped = [c for c in cases if c["skipped"]]
    failed = [c for c in cases if c["failed"]]
    passed = collected - len(skipped) - len(failed)
    print(
        f"[skip-gate] collected={collected} passed={passed}"
        f" skipped={len(skipped)} failed={len(failed)} (junit suite attrs: {attrs})"
    )

    problems: list[str] = []

    if collected < args.min_collected:
        problems.append(
            f"收集数 {collected} < floor {args.min_collected}：目标路径可能没被展开/漏收集，"
            "不允许静默变绿"
        )
    if passed < args.min_passed:
        problems.append(f"通过数 {passed} < floor {args.min_passed}：跳过或漏收集过多")

    hits = {id(entry): 0 for entry in ALLOWED_SKIPS}
    for case in skipped:
        test_key = case["nodeid"].split("::", 1)[1]
        matched = None
        for entry in ALLOWED_SKIPS:
            if _match(entry, case["file"], test_key):
                matched = entry
                break
        if matched is None:
            problems.append(
                f"白名单外的跳过：{case['nodeid']}  reason={case['skip_msg']!r}\n"
                "         → 若这是新的合法跳过，请把 file::test 与理由加进 "
                "tools/ci/check_pytest_skips.py 的 ALLOWED_SKIPS；"
                "若是 ffmpeg/资产缺失导致的，说明环境没准备好，必须红。"
            )
        else:
            hits[id(matched)] += 1

    for entry in ALLOWED_SKIPS:
        n = hits[id(entry)]
        limit = entry.get("max")
        if limit is not None and n > limit:
            problems.append(
                f"{entry['file']} 的跳过数 {n} 超过上限 {limit}：白名单条目可能被过度使用"
            )
        if n == 0:
            print(
                f"[skip-gate] note 白名单条目本环境未命中：{entry['file']}"
                "（资产在本地时属正常，见条目理由）"
            )

    if problems:
        print("\n[skip-gate] FAIL", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"[skip-gate] OK 跳过 {len(skipped)} 项，均在白名单内")
    for case in skipped:
        print(f"[skip-gate]   allowed: {case['nodeid']}  ({case['skip_msg']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
