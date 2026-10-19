"""W3.1 中文 CLIP 的 WordPiece 分词器（从 tokenizer.json 解析，零第三方依赖）。

为什么需要它：现役 `clip_tokenizer.ClipTokenizer` 是**手写 BPE**
（`</w>` 词尾后缀 + GPT-2 字节级映射），只支持 CLIP 原版英文分词。
中文 CLIP（ViT-B/16）用的是 **BERT WordPiece**（`[CLS]/[SEP]/[PAD]/[UNK]`、
`##` 续接前缀、21,128 词表、`handle_chinese_chars`），两者算法族不同，
不能靠参数切换兼容，故单列实现。

规则来源：tokenizer.json 的 normalizer / pre_tokenizer / post_processor / model 段。
  normalizer    : BertNormalizer（clean_text / handle_chinese_chars / lowercase）
  pre_tokenizer : BertPreTokenizer（空白切分 + CJK 单字独立 + 标点独立）
  model         : WordPiece，max_input_chars_per_word=100，unk=[UNK]
  post_processor: [CLS] ... [SEP]

与 `tokenizers` 库**逐 token 一致**由测试断言（真实 tokenizer.json + 参考实现对拍）。
"""
from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path

import numpy as np

# 中文 CLIP 导出时的官方 context length（见 P150/P151 实测：必须固定 52）。
DEFAULT_CONTEXT_LEN = 52

# 中文 CLIP 的 BERT 词表特殊 id
PAD_ID = 0
UNK_ID = 100
CLS_ID = 101
SEP_ID = 102


def _is_control(ch: str) -> bool:
    """BertNormalizer.clean_text：控制字符（\\t \\n \\r 除外）视为空白。"""
    if ch in ("\\t", "\\n", "\\r"):
        return False
    return unicodedata.category(ch) in ("Cc", "Cf", "Co", "Cs", "Cn")


def _is_whitespace(ch: str) -> bool:
    return ch.isspace() or ch == "\\u3000"


def _is_cjk(ch: str) -> bool:
    """BertNormalizer.handle_chinese_chars 覆盖范围（BERT 判定，中文 CLIP 沿用）。"""
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0x20000 <= cp <= 0x2A6DF
        or 0x2A700 <= cp <= 0x2B73F
        or 0x2B740 <= cp <= 0x2B81F
        or 0x2B820 <= cp <= 0x2CEAF
        or 0xF900 <= cp <= 0xFAFF
        or 0x2F800 <= cp <= 0x2FA1F
    )


def _is_punctuation(ch: str) -> bool:
    """BertPreTokenizer 标点判定。"""
    cp = ord(ch)
    if 33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126:
        return True
    return unicodedata.category(ch).startswith("P")


def normalize(text: str, *, clean_text: bool = True, handle_chinese_chars: bool = True,
              lowercase: bool = True) -> str:
    """BertNormalizer 等价实现。"""
    out: list[str] = []
    for ch in text:
        if clean_text:
            if ch in ("\\u0000", "\\ufffd"):
                continue
            if _is_control(ch):
                out.append(" ")
                continue
        if _is_whitespace(ch):
            out.append(" ")
            continue
        if handle_chinese_chars and _is_cjk(ch):
            out.append(" " + ch + " ")
            continue
        out.append(ch)
    s = "".join(out)
    return s.lower() if lowercase else s


def pre_tokenize(text: str) -> list[str]:
    """BertPreTokenizer 等价：空白切分；CJK 单字独立；标点独立。"""
    pieces: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            pieces.append("".join(buf))
            buf.clear()

    for ch in text:
        if ch == " ":
            flush()
            continue
        if _is_cjk(ch) or _is_punctuation(ch):
            flush()
            pieces.append(ch)
            continue
        buf.append(ch)
    flush()
    return pieces


class WordPieceTokenizer:
    """从 tokenizer.json 加载的 BERT WordPiece（中文 CLIP）。构造一次、复用。"""

    def __init__(self, tokenizer_path: str | Path) -> None:
        data = json.loads(Path(tokenizer_path).read_text(encoding="utf-8"))
        model = data.get("model", {})
        if model.get("type") != "WordPiece":
            raise ValueError("unsupported tokenizer type: " + str(model.get("type")))
        self.vocab: dict[str, int] = dict(model["vocab"])
        self.unk_token: str = model.get("unk_token") or "[UNK]"
        self.prefix: str = model.get("continuing_subword_prefix") or "##"
        self.max_chars: int = int(model.get("max_input_chars_per_word") or 100)
        norm = data.get("normalizer") or {}
        self._clean = bool(norm.get("clean_text", True))
        self._cjk = bool(norm.get("handle_chinese_chars", True))
        self._lower = bool(norm.get("lowercase", True))
        self.cls_id = self.vocab.get("[CLS]", CLS_ID)
        self.sep_id = self.vocab.get("[SEP]", SEP_ID)
        self.pad_id = self.vocab.get("[PAD]", PAD_ID)
        self.unk_id = self.vocab.get(self.unk_token, UNK_ID)
        self.cache: dict[str, list[str]] = {}

    def _wordpiece(self, word: str) -> list[str]:
        """贪心最长匹配；超长或无解整词判 [UNK]（与参考实现一致）。"""
        cached = self.cache.get(word)
        if cached is not None:
            return cached
        if len(word) > self.max_chars:
            self.cache[word] = [self.unk_token]
            return self.cache[word]
        out: list[str] = []
        start = 0
        n = len(word)
        while start < n:
            end = n
            found: str | None = None
            while start < end:
                sub = word[start:end]
                if start > 0:
                    sub = self.prefix + sub
                if sub in self.vocab:
                    found = sub
                    break
                end -= 1
            if found is None:
                self.cache[word] = [self.unk_token]
                return self.cache[word]
            out.append(found)
            start = end
        self.cache[word] = out
        return out

    def encode(self, text: str, context_len: int = DEFAULT_CONTEXT_LEN):
        """文本 -> (input_ids (1,T) int64, attention_mask (1,T) int64)。

        截断：保留 [CLS] + body + [SEP]，body 上限 context_len-2。
        """
        body: list[int] = []
        normed = normalize(str(text), clean_text=self._clean,
                           handle_chinese_chars=self._cjk, lowercase=self._lower)
        for piece in pre_tokenize(normed):
            for tok in self._wordpiece(piece):
                body.append(int(self.vocab.get(tok, self.unk_id)))
        body = body[: max(0, context_len - 2)]
        ids = [self.cls_id] + body + [self.sep_id]
        ids = ids[:context_len]
        mask = [1] * len(ids)
        pad = context_len - len(ids)
        if pad > 0:
            ids += [self.pad_id] * pad
            mask += [0] * pad
        return (
            np.asarray([ids], dtype=np.int64),
            np.asarray([mask], dtype=np.int64),
        )


@lru_cache(maxsize=4)
def load_wordpiece_tokenizer(path: str) -> WordPieceTokenizer:
    return WordPieceTokenizer(path)
