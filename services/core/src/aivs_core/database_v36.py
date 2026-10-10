from __future__ import annotations

# W2.1 机位同步（Planning Gate 2026-10-10 §2.1，评审修订版）：
# 两张纯分析表——angle_groups（机位组：参考机位 + 有序成员）与 angle_syncs（每机位偏移结果）。
# 关键设计（评审 C1/C2/C3 修正）：
# - 指纹入唯一键 + 部分索引（照抄 v26 beat_grids 范式）：素材变更 = 新指纹 = 新行可写，
#   旧行保留；否则「stale 后重算」会与旧行唯一键冲突而永远写失败；
# - status / source 加 CHECK；参考行 offset_us 恒 0 由 CHECK 保证；
# - 组内成员顺序落在 members_json（组创建即固定，本轮不做成员增删）；
# - asset 侧为裸引用（沿用全仓惯例，删素材走 ASSET_IN_USE 拒绝路径）。
V36_VERSION = "v36"

V36_SQL = """
CREATE TABLE IF NOT EXISTS angle_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  reference_asset_id TEXT NOT NULL REFERENCES assets(id),
  members_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_angle_groups_project
  ON angle_groups(project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS angle_syncs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES angle_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  is_reference INTEGER NOT NULL CHECK(is_reference IN (0,1)),
  offset_us INTEGER,
  confidence REAL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed','unavailable')),
  reason TEXT,
  source TEXT NOT NULL CHECK(source IN ('auto','manual')),
  reference_fingerprint TEXT NOT NULL,
  asset_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (is_reference = 0 OR offset_us = 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_angle_syncs_ready ON angle_syncs(
  group_id,asset_id,algorithm_version,source,asset_fingerprint,reference_fingerprint
) WHERE status IN ('ready','unavailable');
CREATE INDEX IF NOT EXISTS idx_angle_syncs_group
  ON angle_syncs(group_id,asset_id,created_at DESC);
"""
