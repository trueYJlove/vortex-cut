from __future__ import annotations

# AI-2 Layer 0（ADR-0003 D3）：本地 CV 信号分析。规划门裁决：不复用
# derived_media_cache（可 LRU 清理的缓存语义不匹配召回层的稳定可查要求），
# 采用 transcripts 先例——主行带 source_fingerprint 判 stale + 明细层按
# 时间网格。algorithm_version 即信号集版本：算法升级 → 新 version 行 +
# 旧数据标记 stale，召回层永远取最新 ready，不做原地重算。
V21_VERSION = "v21"

V21_SQL = """
CREATE TABLE cv_analyses (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','stale','failed')),
  model_revision TEXT NULL,
  sample_count INTEGER NULL,
  scene_cut_count INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL,
  UNIQUE(asset_id, algorithm_version)
);
CREATE INDEX idx_cv_analyses_asset ON cv_analyses(asset_id, algorithm_version DESC);
CREATE INDEX idx_cv_analyses_status ON cv_analyses(status, created_at DESC);

CREATE TABLE cv_samples (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES cv_analyses(id),
  sample_index INTEGER NOT NULL,
  timestamp_us INTEGER NOT NULL CHECK(timestamp_us >= 0),
  scene_cut INTEGER NOT NULL DEFAULT 0 CHECK(scene_cut IN (0, 1)),
  motion_energy REAL NOT NULL CHECK(motion_energy >= 0.0),
  sharpness REAL NOT NULL CHECK(sharpness >= 0.0),
  brightness REAL NOT NULL CHECK(brightness >= 0.0),
  audio_energy REAL NOT NULL DEFAULT 0.0 CHECK(audio_energy >= 0.0),
  face_count INTEGER NULL,
  face_score REAL NULL,
  UNIQUE(analysis_id, sample_index)
);
CREATE INDEX idx_cv_samples_time ON cv_samples(analysis_id, timestamp_us);
"""
