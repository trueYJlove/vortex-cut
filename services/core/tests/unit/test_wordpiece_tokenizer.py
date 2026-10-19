"""W3.1 中文 CLIP WordPiece 分词器 —— 与参考实现逐 token 对拍。

为什么必须有这组测试：分词是检索质量的**第一道前提**。
P143 已证现役英文 CLIP 把中文切成 UTF-8 字节碎片（「猫」→ `ç Į «`），
换中文 CLIP 的全部收益都建立在「中文单字是真实语义 token」上。
若本实现与 `tokenizers` 库有偏差，收益会被静默抵消而**没有任何报错**——
这正是 P151/P152 两次自曝过的失败形态（读数异常但没有测试能拦住）。

**参考实现**：`tokenizers` 库（与生产同样读取真实 tokenizer.json）。
若该开发依赖缺失，本测试 skip（**不允许**改成「断言恒真」——那是掩耳盗铃）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivs_core.media.wordpiece_tokenizer import (
    CLS_ID,
    DEFAULT_CONTEXT_LEN,
    PAD_ID,
    SEP_ID,
    load_wordpiece_tokenizer,
    normalize,
    pre_tokenize,
)

TOKENIZER = Path(__file__).resolve().parents[4] / ".tmp" / "cc-probe" / "tokenizer.json"

tokenizers_lib = pytest.importorskip("tokenizers", reason="参考实现缺失，跳过对拍（不得改为恒真断言）")


def _ref_expected(text: str, context_len: int = DEFAULT_CONTEXT_LEN) -> list[int]:
    """参考实现 + 与生产一致的截断/补齐规则。"""
    tk = tokenizers_lib.Tokenizer.from_file(str(TOKENIZER))
    ids = list(tk.encode(text).ids)
    body = ids[1:-1][: context_len - 2]
    out = [CLS_ID] + body + [SEP_ID]
    out = out[:context_len]
    return out + [PAD_ID] * (context_len - len(out))


needs_asset = pytest.mark.skipif(
    not TOKENIZER.exists(), reason="中文 CLIP tokenizer.json 未落地（开发期资产）"
)


@needs_asset
@pytest.mark.parametrize(
    "text",
    [
        "\u732b",                                   # 单个汉字
        "\u4e00\u4e2a\u4eba\u5728\u8bf4\u8bdd",  # 中文短句
        "\u753b\u9762\u4e2d\u6709\u4e00\u4e2a\u4eba\u7ad9\u5728\u6d77\u8fb9",  # 中文长句
        "cat",
        "a person talking",
        "Hello World",
        "\u4f60\u597d\uff0c\u4e16\u754c\uff01",  # 中文 + 全角标点
        "2024\u5e74",                                # 数字 + 中文
        "\u732b cat \u72d7",                         # 中英混排
        "   ",                                        # 纯空白
        "",
        "\u4e00" * 60,                               # 超长 -> 截断边界
    ],
)
def test_wordpiece_matches_reference_token_for_token(text: str) -> None:
    tk = load_wordpiece_tokenizer(str(TOKENIZER))
    ids, mask = tk.encode(text)
    assert [int(v) for v in ids[0]] == _ref_expected(text)
    # 注意力掩码必须与实际 token 数一致（PAD 位置为 0）
    assert int(mask[0].sum()) == min(len([v for v in _ref_expected(text) if v != PAD_ID]), DEFAULT_CONTEXT_LEN)


@needs_asset
def test_chinese_chars_become_real_vocab_ids_not_byte_fragments() -> None:
    """这是 W3.1 中文优先的**核心断言**：汉字必须是词表实体。

    P143 记录了现役英文 CLIP 的失效：CJK 词表条目 0，中文走字节回退。
    中文 CLIP 的 tokenizer 里 7,321 个 CJK 单字是真实词表项。
    """
    data = json.loads(TOKENIZER.read_text(encoding="utf-8"))
    vocab = data["model"]["vocab"]
    cjk = [k for k in vocab if len(k) == 1 and "\u4e00" <= k <= "\u9fff"]
    assert len(cjk) > 5000, f"CJK 单字词表条目过少：{len(cjk)}"
    # 逐字必须命中词表，且编码后是 1 个 body token（不是 3 个字节碎片）
    tk = load_wordpiece_tokenizer(str(TOKENIZER))
    for ch in "\u732b\u72d7\u9a6c\u5c71\u6d77":
        assert ch in vocab, f"{ch} 不在词表"
        ids, _ = tk.encode(ch)
        body = [int(v) for v in ids[0] if int(v) not in (CLS_ID, SEP_ID, PAD_ID)]
        assert body == [vocab[ch]], f"{ch} 未编码成单个词表 id：{body}"


@needs_asset
def test_long_input_is_truncated_to_context_len() -> None:
    tk = load_wordpiece_tokenizer(str(TOKENIZER))
    ids, _ = tk.encode("\u4e00" * 200, DEFAULT_CONTEXT_LEN)
    assert ids.shape == (1, DEFAULT_CONTEXT_LEN)
    assert int(ids[0][0]) == CLS_ID
    assert int(ids[0][-1]) in (SEP_ID, PAD_ID)


@needs_asset
def test_normalizer_lowercases_and_splits_cjk() -> None:
    assert normalize("ABC") == "abc"
    # CJK 两侧必须补空格（BertNormalizer.handle_chinese_chars）
    assert " \u732b " in normalize("\u732b")
    assert pre_tokenize("\u732b\u72d7") == ["\u732b", "\u72d7"]
    assert pre_tokenize("hello world") == ["hello", "world"]
    assert pre_tokenize("\u4f60\u597d\uff0c") == ["\u4f60", "\u597d", "\uff0c"]


@needs_asset
def test_rejects_non_wordpiece_tokenizer() -> None:
    """负向：把 BPE 分词器交给 WordPiece 必须显式失败，不得静默降级。"""
    en_tok = Path(__file__).resolve().parents[4] / ".tmp" / "clip-probe" / "tokenizer.json"
    if not en_tok.exists():
        pytest.skip("英文 CLIP tokenizer 未落地")
    with pytest.raises(ValueError, match="unsupported tokenizer type"):
        load_wordpiece_tokenizer(str(en_tok))
