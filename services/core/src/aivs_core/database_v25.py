from __future__ import annotations

# W1.5：语法提案落盘完整拟议文档。
#
# 动因：remove_pauses 等规划器的 insert/split 会 mint 新 clip_id，重放
# apply_in_memory 无法得到同一 document_sha256。采纳时以**提案时**的
# proposed_document_json 为准，并用 proposed_document_sha256 自校验。

V25_VERSION = "v25"

V25_SQL = """
ALTER TABLE editing_grammar_proposals
ADD COLUMN proposed_document_json TEXT NOT NULL DEFAULT '{}';
"""
