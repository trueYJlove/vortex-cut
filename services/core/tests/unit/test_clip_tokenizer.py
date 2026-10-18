"""W3.1 CLIP 分词器回归：与参考实现逐 token 对齐。

判据来自外部参照（tokenizers 库），不是自我一致性——这是本仓「恒真测试」
禁忌的正面做法：若分词实现漂移，本套件必红。

tokenizer.json 不随仓库分发（受信下载），故无模型时整组 skip。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivs_core.media.clip_tokenizer import (
    DEFAULT_CONTEXT_LEN,
    END_OF_TEXT,
    START_OF_TEXT,
    ClipTokenizer,
    _pretokenize_text,
)

# 由 __file__ 推导仓库根，不依赖 cwd（P66 教训：隐藏 cwd 假设会让测试
# 只能从某一目录运行，且在 CI/不同工作目录下静默 skip）。
REPO_ROOT = Path(__file__).resolve().parents[4]
TOKENIZER = REPO_ROOT / ".tmp" / "clip-probe" / "clip" / "clip-vit-base-patch32" / "tokenizer.json"
pytestmark = pytest.mark.skipif(
    not TOKENIZER.is_file(), reason="CLIP tokenizer 未下载（受信模型，不随仓库分发）"
)


@pytest.fixture(scope="module")
def tk():
    return ClipTokenizer(TOKENIZER)


class TestPretokenize:
    def test_splits_words(self):
        assert _pretokenize_text("hello world") == ["hello", "world"]

    def test_digits_split_individually(self):
        assert _pretokenize_text("123") == ["1", "2", "3"]

    def test_contractions_kept(self):
        pieces = _pretokenize_text("it" + chr(39) + "s")
        assert any(p.endswith(chr(39) + "s") for p in pieces)

    def test_whitespace_dropped(self):
        assert _pretokenize_text("  a   b  ") == ["a", "b"]


class TestEncoding:
    def test_shape_and_special_tokens(self, tk):
        ids, mask = tk.encode("a photo of a person")
        assert ids.shape == (1, DEFAULT_CONTEXT_LEN)
        assert mask.shape == (1, DEFAULT_CONTEXT_LEN)
        assert ids[0, 0] == START_OF_TEXT
        n = int(mask[0].sum())
        assert ids[0, n - 1] == END_OF_TEXT

    def test_padding_uses_mask(self, tk):
        _, mask = tk.encode("cat")
        body = int(mask[0].sum())
        assert body < DEFAULT_CONTEXT_LEN
        assert mask[0, body:].sum() == 0

    def test_lowercased_and_normalized(self, tk):
        a, _ = tk.encode("HELLO")
        b, _ = tk.encode("hello")
        assert a.tolist() == b.tolist()

    def test_truncation_keeps_end_of_text(self, tk):
        ids, mask = tk.encode("word " * 200)
        assert ids.shape[1] == DEFAULT_CONTEXT_LEN
        assert ids[0, -1] == END_OF_TEXT
        assert int(mask[0].sum()) == DEFAULT_CONTEXT_LEN

    def test_known_vocab_ids(self, tk):
        assert tk.vocab["<|startoftext|>"] == START_OF_TEXT
        assert tk.vocab["<|endoftext|>"] == END_OF_TEXT
        assert tk.vocab["hello</w>"] == 3306
        assert tk.vocab["cat</w>"] == 2368


class TestAgainstReference:
    @pytest.fixture(scope="class")
    def ref(self):
        tokenizers = pytest.importorskip("tokenizers")
        t = tokenizers.Tokenizer.from_file(str(TOKENIZER))
        t.enable_truncation(max_length=DEFAULT_CONTEXT_LEN)
        t.enable_padding(length=DEFAULT_CONTEXT_LEN)
        return t

    TEXTS = [
        "a photo of a person",
        "hello world",
        "A DOG Running fast!!!",
        "it" + chr(39) + "s a test",
        "12345",
        "multi_underscore-case.and,punctuation",
        "two people talking in an office",
        "sunset over the ocean",
    ]

    def test_matches_reference_token_ids(self, tk, ref):
        for text in self.TEXTS:
            mine = tk.encode(text)[0][0].tolist()
            assert mine == ref.encode(text).ids, text

    def test_matches_reference_when_truncated(self, tk, ref):
        text = "word " * 200
        assert tk.encode(text)[0][0].tolist() == ref.encode(text).ids


class TestServiceIntegration:
    def test_service_clip_tokenize_delegates(self, tk):
        from aivs_core.media.semantic_service import clip_tokenize
        ids, mask = clip_tokenize("hello world", TOKENIZER)
        assert ids[0, 0] == START_OF_TEXT
        assert ids.dtype == np.int64
