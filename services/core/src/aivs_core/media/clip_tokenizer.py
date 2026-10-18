"""W3.1 CLIP 真实 BPE 分词器（从 tokenizer.json 解析，零第三方依赖）。

为什么自己写而不是引 tokenizers/tiktoken：
- 本仓已有 onnxruntime/numpy 两个推理依赖，分词不该再引一个二进制轮子；
- 受信清单已是「逐文件 sha256」模式，自实现让分词行为可审、可测、可复现；
- CLIP 分词规则是冻结的（词表 + 合并表就是全部状态）。

规则来源：tokenizer.json 的 model/pre_tokenizer/normalizer/post_processor 段。
  normalizer    : NFC -> 空白折叠 -> 小写
  pre_tokenizer : Split(正则) 后 ByteLevel（GPT-2 字节<->unicode 映射）
  model         : BPE，end_of_word_suffix = "</w>"，merges 按 rank 优先
  post_processor: <|startoftext|> ... <|endoftext|>，padding 到 77

与占位实现的区别：占位版把整词哈希成假 id，本版产出真实 CLIP token；
因此 A8（命中率）的质量前提由此具备，但语料前提仍未具备（见 P142）。
"""
from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import numpy as np

START_OF_TEXT = 49406
END_OF_TEXT = 49407
DEFAULT_CONTEXT_LEN = 77

# CLIP pre_tokenizer 原文（tokenizer.json）：
#   <|startoftext|>|<|endoftext|>|'s|'t|'re|'ve|'m|'ll|'d
#   |[p{L}]+|[p{N}]|[^sp{L}p{N}]+     （Split behavior=Removed, invert=true
#   ⇒ 等价于「只保留匹配到的片段」，片段间空白被丢弃）
# 本仓无 regex 模块，故用字符类别手写等价切分：连续字母 / 单个数字 /
# 连续标点（非空白非字母非数字）/ 缩写后缀。
_CONTRACTIONS = ("'s", "'t", "'re", "'ve", "'m", "'ll", "'d")
_SPECIAL = ("<|startoftext|>", "<|endoftext|>")


def _is_letter(ch: str) -> bool:
    return ch.isalpha()


def _is_number(ch: str) -> bool:
    return ch.isdigit()


def _pretokenize_text(text: str) -> list[str]:
    """按 CLIP 正则语义切分（保留匹配片段，丢弃空白）。"""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        matched = None
        for sp in _SPECIAL:
            if text.startswith(sp, i):
                matched = sp
                break
        if matched is None:
            for c in _CONTRACTIONS:
                if text.startswith(c, i):
                    matched = c
                    break
        if matched is None:
            if _is_letter(ch):
                j = i
                while j < n and _is_letter(text[j]):
                    j += 1
                matched = text[i:j]
            elif _is_number(ch):
                matched = ch
            else:
                j = i
                while j < n and not text[j].isspace() and not _is_letter(text[j]) and not _is_number(text[j]):
                    j += 1
                matched = text[i:j]
        out.append(matched)
        i += len(matched)
    return out


def _bytes_to_unicode() -> dict[int, str]:
    """GPT-2 的字节 -> unicode 映射（可逆、避开不可打印码位）。"""
    bs = (
        list(range(ord("!"), ord("~") + 1))
        + list(range(0xA1, 0xAC + 1))
        + list(range(0xAE, 0xFF + 1))
    )
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


_BYTE_ENCODER = _bytes_to_unicode()


def _split_chars(suffix: str, token: str) -> list[str]:
    """把词拆成 BPE 单元：词尾后缀**直接附着在最后一个字符上**。

    实测证据（tokenizer.json）：
    - 词表含 `n</w>`(333) / `e</w>`(324) / `he</w>`(797) 等**基础符号**；
    - 合并表含 `th e</w>`(6) / `o n</w>`(13) 等规则，但**没有任何**产生
      `n</w>` 的规则（`n </w>` 不在合并表里），也没有 `< /`、`/ w` 等。
    ⇒ 后缀不是独立字符，而是**在 BPE 之前粘到最后一字符**形成的单元。
    把 `</w>` 当独立字符会让 BPE 拼出 `< / w >`（实测每词多 27,14,86,29）。
    """
    if suffix and token.endswith(suffix):
        head = token[: -len(suffix)]
        if not head:
            return [suffix]
        return list(head[:-1]) + [head[-1] + suffix]
    return list(token)


class ClipTokenizer:
    """从 tokenizer.json 加载的 CLIP BPE。构造一次、复用（合并表 5 万条）。"""

    def __init__(self, tokenizer_path: str | Path) -> None:
        data = json.loads(Path(tokenizer_path).read_text(encoding='utf-8'))
        model = data.get('model', {})
        if model.get('type') != 'BPE':
            raise ValueError('unsupported tokenizer type: ' + str(model.get('type')))
        self.vocab: dict[str, int] = dict(model['vocab'])
        self.end_of_word_suffix: str = model.get('end_of_word_suffix') or ''
        raw = model.get('merges') or []
        self.merges: dict[tuple[str, str], int] = {}
        for rank, item in enumerate(raw):
            if isinstance(item, str):
                left, _, right = item.partition(' ')
            else:
                left, right = item[0], item[1]
            self.merges[(left, right)] = rank
        self.cache: dict[str, list[str]] = {}

    def _bpe(self, token: str) -> list[str]:
        """对单个字节级词做 BPE 合并（按 rank 从小到大反复合并）。"""
        if token in self.cache:
            return self.cache[token]
        word = _split_chars(self.end_of_word_suffix, token)
        if not word:
            self.cache[token] = []
            return []
        while len(word) > 1:
            best = None
            for i in range(len(word) - 1):
                pair = (word[i], word[i + 1])
                rank = self.merges.get(pair)
                if rank is not None and (best is None or rank < best[0]):
                    best = (rank, pair[0], pair[1])
            if best is None:
                break
            _, left, right = best
            merged: list[str] = []
            i = 0
            while i < len(word):
                if i < len(word) - 1 and word[i] == left and word[i + 1] == right:
                    merged.append(left + right)
                    i += 2
                else:
                    merged.append(word[i])
                    i += 1
            word = merged
        self.cache[token] = word
        return word

    def encode(self, text: str, context_len: int = DEFAULT_CONTEXT_LEN):
        """文本 -> (input_ids (1,T) int64, attention_mask (1,T) int64)。"""
        normalized = unicodedata.normalize('NFC', str(text))
        normalized = re.sub(r'\s+', ' ', normalized).strip().lower()
        body: list[int] = []
        for piece in self._pretokenize(normalized):
            for tok in self._bpe(piece):
                vid = self.vocab.get(tok)
                if vid is None:
                    vid = self.vocab.get('<|endoftext|>', END_OF_TEXT)
                body.append(int(vid))
        # 先截断再补 EOT：参考实现（tokenizers 库）在 77 上限下保留
        # [SOT] + 75 body + [EOT]。若先 append 再切片，EOT 会被切掉，
        # 与参考实现不一致（实测末位变成 body token 而非 49407）。
        body = body[: context_len - 2] if context_len >= 2 else []
        ids: list[int] = [START_OF_TEXT] + body + [END_OF_TEXT]
        ids = ids[:context_len]
        mask = [1] * len(ids)
        pad = context_len - len(ids)
        if pad > 0:
            ids += [0] * pad
            mask += [0] * pad
        return (
            np.asarray([ids], dtype=np.int64),
            np.asarray([mask], dtype=np.int64),
        )

    def _pretokenize(self, text: str) -> list[str]:
        """正则切分 + 字节级映射 + 词尾 </w> 后缀。

        关键：`</w>` 必须**拼进词本身再交给 BPE**，而不是作为一个独立片段。
        词表里 34483/49408 条以字面 `</w>` 结尾，合并表也存在 `e</w>` 这类
        规则——把 `</w>` 当普通字符切出来会让 BPE 先把它拆成 `< / w >`
        四个 token（实测每词多出 27,14,86,29）。参考实现（tokenizers 库）
        产出的是 `cat</w>` 这样的单 token，本实现与之逐 token 对齐。
        """
        pieces: list[str] = []
        for chunk in _pretokenize_text(text):
            if chunk in {'<|startoftext|>', '<|endoftext|>'} or not chunk:
                continue
            mapped = ''.join(_BYTE_ENCODER[b] for b in chunk.encode('utf-8'))
            if not mapped:
                continue
            pieces.append(mapped + self.end_of_word_suffix)
        return pieces


@lru_cache(maxsize=4)
def load_tokenizer(path: str) -> ClipTokenizer:
    """按路径缓存（合并表 5 万条，重复构造代价高）。"""
    return ClipTokenizer(path)


def tokenize_clip(text: str, tokenizer_path: str | Path, context_len: int = DEFAULT_CONTEXT_LEN):
    return load_tokenizer(str(tokenizer_path)).encode(text, context_len)
