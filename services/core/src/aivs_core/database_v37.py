from __future__ import annotations

# W2.2 说话人分离（Design Gate 2026-10-11 §3，冻结）：
# 单表 + 部分唯一索引（照抄 beat_grids / angle_syncs 范式：algorithm_version 行化 +
# 指纹入唯一键 + 读时 stale）。
#
# 为什么存 embeddings_blob：本包已确定瓶颈在 **τ 选择**，存下窗 embedding 后换 τ/换策略
# 只重跑聚类、不重跑 ONNX（实测 71–79 s/场 → 0.3–9.4 s，8–15×）。
#
# 删除语义（F1 阻断级）：**ON DELETE CASCADE**。反例警示：beat_grids / cv_analyses 用
# NO ACTION，实测「插一行分析 ⇒ DELETE FROM assets 直接被 FK 拒绝」，且 delete_asset
# 把该拒绝报成"被镜头需求或生成记录引用"（原因错、无出路，见 P102）。派生分析数据
# **随素材自动清**，本表不重蹈覆辙。
V37_VERSION = "v37"

V37_SQL = """
CREATE TABLE IF NOT EXISTS speaker_diarizations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  reason TEXT,
  speaker_count INTEGER,
  turns_json TEXT NOT NULL DEFAULT '[]',
  windows_json TEXT NOT NULL DEFAULT '[]',
  embeddings_blob BLOB,
  embedding_model TEXT,
  model_revision TEXT,
  vad_model TEXT,
  threshold REAL,
  threshold_strategy TEXT,
  sample_rate INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_speaker_diarizations_asset
  ON speaker_diarizations(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_diarizations_ready
  ON speaker_diarizations(asset_id, algorithm_version, source_fingerprint)
  WHERE status IN ('ready','unavailable');
"""
