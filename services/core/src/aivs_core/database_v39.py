from __future__ import annotations

# W3.1 素材池语义检索（Planning Gate 2026-10-18 §2.2，冻结）：
# 单表 + 部分唯一索引，照抄 v37（speaker_diarizations）范式：
# algorithm_version 行化 + 指纹入唯一键 + 读时 stale。
#
# 删除语义：**ON DELETE CASCADE**。反例警示（P102）：beat_grids / cv_analyses
# 用 NO ACTION，实测「插一行分析 ⇒ DELETE FROM assets 直接被 FK 拒绝」，且
# delete_asset 把该拒绝报成"被镜头需求或生成记录引用"（原因错、无出路）。
# 派生分析数据**随素材自动清**，本表不重蹈覆辙。
#
# 为什么存 embeddings_blob：换 K / 换聚合策略 / 换相似度口径时只重排不重跑
# ONNX（沿用 v37 已实测的 8–15× 收益理由）。
V39_VERSION = "v39"

V39_SQL = """
CREATE TABLE IF NOT EXISTS asset_semantic_index (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  reason TEXT,
  frame_count INTEGER NOT NULL DEFAULT 0,
  embedding_dim INTEGER NOT NULL DEFAULT 0,
  frames_json TEXT NOT NULL DEFAULT '[]',
  embeddings_blob BLOB,
  model_id TEXT,
  model_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_semantic_index_asset
  ON asset_semantic_index(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_semantic_index_ready
  ON asset_semantic_index(asset_id, source_fingerprint, algorithm_version)
  WHERE status = 'ready';
"""
