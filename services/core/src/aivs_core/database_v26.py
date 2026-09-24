from __future__ import annotations

# W1.2 节拍网格存储：algorithm_version 行化，照抄 cv_analyses 范式（总纲 §8）。

V26_VERSION = "v26"

V26_SQL = """
CREATE TABLE beat_grids (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  bpm REAL NULL,
  lag_s REAL NULL,
  confidence REAL NULL,
  beats_json TEXT NOT NULL DEFAULT '[]',
  downbeats_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NULL,
  model_revision TEXT NULL,
  sample_rate INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX idx_beat_grids_asset ON beat_grids(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX idx_beat_grids_ready ON beat_grids(asset_id, algorithm_version, source_fingerprint)
  WHERE status IN ('ready','unavailable');
"""
