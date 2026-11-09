"""v42 迁移：让 Provider 真正可删（用户裁决 2026-11-09）。

**问题**：用户实测「停用之后依然无法删除」，并指出「我用的所有软件添加的
provider 都是可以删除的」。真实库确诊（源库只读打开、逐表核对）：

    DELETE FROM provider_configs -> sqlite3.IntegrityError:
      NOT NULL constraint failed: provider_invocations.provider_config_id

即 `ProviderStore.delete()` 里的 PROVIDER_IN_USE 只是**第二道**拦截，第一道
是表结构本身：13 张引用表的 provider_config_id 全是 NOT NULL + NO ACTION。

**为什么可以删而不破坏审计链**：审计行自带身份，不依赖 provider_configs 那一行。
真实库实测 28 条历史行 **0 行缺身份**：
  * provider_invocations 自带 provider_name / model；
  * *_egress_previews 自带 provider_snapshot_json / provider_config_sha256。
删除只把指针置空，行内字段一个不动，故「谁在何时把什么发给了哪个模型、
花了多少钱」依然可查。不可变触发器保护的是**审计行不可改写**，
不是**配置行不可删除**——两者不冲突。

**判据沿用本仓既有三次同型修复**（1cf5cab / 6d3bbf2 / ce6ceee）：
记录本身自足，就不该拦住删除。

**做法**：13 张表 provider_config_id 由 NOT NULL 改可空、外键由 NO ACTION 改
ON DELETE SET NULL，触发器与索引逐字重建。SQLite 无 ALTER COLUMN，必须重建表
（本仓 v13/v14 已有 _apply_rebuild 先例）。

**顺序注意**：本集合内部有互相引用（provider_invocations -> 三张 generations，
candidate_generations -> egress_previews 等），但重建全程 PRAGMA foreign_keys=OFF，
顺序不影响正确性；迁移结束由 _apply_rebuild 做 foreign_key_check + integrity_check。
"""
from __future__ import annotations

V42_VERSION = "v42"

V42_SQL = """
-- agent_session_egress_previews
CREATE TABLE agent_session_egress_previews_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL,
  provider_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO agent_session_egress_previews_v42 (id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at) SELECT id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at FROM agent_session_egress_previews;
DROP TABLE agent_session_egress_previews;
ALTER TABLE agent_session_egress_previews_v42 RENAME TO agent_session_egress_previews;
CREATE INDEX idx_agent_session_previews_expiry ON agent_session_egress_previews(expires_at);
CREATE TRIGGER agent_session_previews_no_delete BEFORE DELETE ON agent_session_egress_previews BEGIN SELECT RAISE(ABORT,'agent session previews are immutable'); END;
CREATE TRIGGER agent_session_previews_no_update BEFORE UPDATE ON agent_session_egress_previews BEGIN SELECT RAISE(ABORT,'agent session previews are immutable'); END;

-- agent_sessions
CREATE TABLE agent_sessions_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES agent_session_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES agent_session_egress_consents(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  instruction TEXT NOT NULL,
  max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 6),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
INSERT INTO agent_sessions_v42 (id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, instruction, max_steps, status, payload_sha256, created_at, updated_at, finished_at) SELECT id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, instruction, max_steps, status, payload_sha256, created_at, updated_at, finished_at FROM agent_sessions;
DROP TABLE agent_sessions;
ALTER TABLE agent_sessions_v42 RENAME TO agent_sessions;
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id, created_at DESC, id DESC);

-- asset_frame_tags
CREATE TABLE asset_frame_tags_v42 (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  vocabulary_id TEXT NOT NULL,
  vocabulary_version INTEGER NOT NULL CHECK(vocabulary_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable','failed')),
  reason TEXT,
  frame_index INTEGER NOT NULL,
  timestamp_us INTEGER NOT NULL CHECK(timestamp_us >= 0),
  labels_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  generation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO asset_frame_tags_v42 (id, asset_id, source_fingerprint, algorithm_version, vocabulary_id, vocabulary_version, status, reason, frame_index, timestamp_us, labels_json, notes, provider_config_id, generation_id, created_at, updated_at) SELECT id, asset_id, source_fingerprint, algorithm_version, vocabulary_id, vocabulary_version, status, reason, frame_index, timestamp_us, labels_json, notes, provider_config_id, generation_id, created_at, updated_at FROM asset_frame_tags;
DROP TABLE asset_frame_tags;
ALTER TABLE asset_frame_tags_v42 RENAME TO asset_frame_tags;
CREATE INDEX idx_asset_frame_tags_asset
  ON asset_frame_tags(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX idx_asset_frame_tags_ready
  ON asset_frame_tags(asset_id, source_fingerprint, algorithm_version,
                      vocabulary_version, frame_index)
  WHERE status = 'ready';

-- candidate_generations
CREATE TABLE candidate_generations_v42 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), egress_preview_id TEXT NOT NULL REFERENCES egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES egress_consents(id), provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  brief_snapshot_json TEXT NOT NULL, brief_sha256 TEXT NOT NULL, recipe_snapshot_id TEXT NOT NULL REFERENCES recipe_snapshots(id),
  timeline_baseline_revision_id TEXT NULL REFERENCES timeline_revisions(id), status TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT NULL
, candidate_response_adapter_id TEXT NULL, candidate_probe_protocol_version TEXT NULL, candidate_capability_probe_sha256 TEXT NULL, provider_config_sha256 TEXT NULL);
INSERT INTO candidate_generations_v42 (id, project_id, egress_preview_id, egress_consent_id, provider_config_id, brief_snapshot_json, brief_sha256, recipe_snapshot_id, timeline_baseline_revision_id, status, payload_sha256, created_at, updated_at, finished_at, candidate_response_adapter_id, candidate_probe_protocol_version, candidate_capability_probe_sha256, provider_config_sha256) SELECT id, project_id, egress_preview_id, egress_consent_id, provider_config_id, brief_snapshot_json, brief_sha256, recipe_snapshot_id, timeline_baseline_revision_id, status, payload_sha256, created_at, updated_at, finished_at, candidate_response_adapter_id, candidate_probe_protocol_version, candidate_capability_probe_sha256, provider_config_sha256 FROM candidate_generations;
DROP TABLE candidate_generations;
ALTER TABLE candidate_generations_v42 RENAME TO candidate_generations;
CREATE INDEX idx_generations_project ON candidate_generations(project_id, created_at DESC, id DESC);

-- captions_provider_egress_previews
CREATE TABLE captions_provider_egress_previews_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL,
  provider_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
, payload_json TEXT NOT NULL DEFAULT '{}');
INSERT INTO captions_provider_egress_previews_v42 (id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at, payload_json) SELECT id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at, payload_json FROM captions_provider_egress_previews;
DROP TABLE captions_provider_egress_previews;
ALTER TABLE captions_provider_egress_previews_v42 RENAME TO captions_provider_egress_previews;
CREATE INDEX captions_provider_previews_project ON captions_provider_egress_previews(project_id,created_at DESC,id DESC);
CREATE TRIGGER captions_provider_previews_no_delete BEFORE DELETE ON captions_provider_egress_previews BEGIN SELECT RAISE(ABORT,'captions provider previews are immutable'); END;
CREATE TRIGGER captions_provider_previews_no_update BEFORE UPDATE ON captions_provider_egress_previews BEGIN SELECT RAISE(ABORT,'captions provider previews are immutable'); END;

-- captions_provider_generations
CREATE TABLE captions_provider_generations_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES captions_provider_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES captions_provider_egress_consents(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
INSERT INTO captions_provider_generations_v42 (id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, status, payload_sha256, created_at, updated_at, finished_at) SELECT id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, status, payload_sha256, created_at, updated_at, finished_at FROM captions_provider_generations;
DROP TABLE captions_provider_generations;
ALTER TABLE captions_provider_generations_v42 RENAME TO captions_provider_generations;
CREATE INDEX captions_provider_generations_project ON captions_provider_generations(project_id,created_at DESC,id DESC);

-- egress_previews
CREATE TABLE egress_previews_v42 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  brief_snapshot_json TEXT NOT NULL, brief_sha256 TEXT NOT NULL, recipe_snapshot_id TEXT NOT NULL REFERENCES recipe_snapshots(id),
  provider_snapshot_json TEXT NOT NULL, provider_config_sha256 TEXT NOT NULL,
  transcript_refs_json TEXT NOT NULL, segment_whitelist_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL, stats_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
, candidate_response_adapter_id TEXT NULL, candidate_probe_protocol_version TEXT NULL, candidate_capability_probe_sha256 TEXT NULL);
INSERT INTO egress_previews_v42 (id, project_id, provider_config_id, brief_snapshot_json, brief_sha256, recipe_snapshot_id, provider_snapshot_json, provider_config_sha256, transcript_refs_json, segment_whitelist_json, payload_sha256, payload_json, stats_json, expires_at, created_at, candidate_response_adapter_id, candidate_probe_protocol_version, candidate_capability_probe_sha256) SELECT id, project_id, provider_config_id, brief_snapshot_json, brief_sha256, recipe_snapshot_id, provider_snapshot_json, provider_config_sha256, transcript_refs_json, segment_whitelist_json, payload_sha256, payload_json, stats_json, expires_at, created_at, candidate_response_adapter_id, candidate_probe_protocol_version, candidate_capability_probe_sha256 FROM egress_previews;
DROP TABLE egress_previews;
ALTER TABLE egress_previews_v42 RENAME TO egress_previews;
CREATE INDEX idx_previews_expiry ON egress_previews(expires_at);
CREATE TRIGGER egress_previews_no_delete BEFORE DELETE ON egress_previews BEGIN SELECT RAISE(ABORT,'egress previews are immutable'); END;
CREATE TRIGGER egress_previews_no_update BEFORE UPDATE ON egress_previews BEGIN SELECT RAISE(ABORT,'egress previews are immutable'); END;

-- keyframe_egress_previews
CREATE TABLE keyframe_egress_previews_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT REFERENCES assets(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL,
  model_id TEXT,
  model_revision TEXT,
  payload_sha256 TEXT NOT NULL,
  frames_json TEXT NOT NULL DEFAULT '[]',
  excluded_frames_json TEXT NOT NULL DEFAULT '[]',
  sampling_mode TEXT NOT NULL CHECK(sampling_mode IN ('scene_cut','interval_only')),
  covered_scene_cuts INTEGER NOT NULL DEFAULT 0,
  total_frame_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  payloads_purged_at TEXT,
  detached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO keyframe_egress_previews_v42 (id, project_id, asset_id, provider_config_id, source_fingerprint, model_id, model_revision, payload_sha256, frames_json, excluded_frames_json, sampling_mode, covered_scene_cuts, total_frame_bytes, expires_at, payloads_purged_at, detached_at, created_at, updated_at) SELECT id, project_id, asset_id, provider_config_id, source_fingerprint, model_id, model_revision, payload_sha256, frames_json, excluded_frames_json, sampling_mode, covered_scene_cuts, total_frame_bytes, expires_at, payloads_purged_at, detached_at, created_at, updated_at FROM keyframe_egress_previews;
DROP TABLE keyframe_egress_previews;
ALTER TABLE keyframe_egress_previews_v42 RENAME TO keyframe_egress_previews;
CREATE INDEX idx_keyframe_previews_asset
  ON keyframe_egress_previews(asset_id, created_at DESC);
CREATE INDEX idx_keyframe_previews_expiry
  ON keyframe_egress_previews(expires_at);

-- keyframe_generations
CREATE TABLE keyframe_generations_v42 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES keyframe_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES keyframe_egress_consents(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
INSERT INTO keyframe_generations_v42 (id, project_id, egress_preview_id, egress_consent_id, provider_config_id, source_fingerprint, status, payload_sha256, created_at, finished_at) SELECT id, project_id, egress_preview_id, egress_consent_id, provider_config_id, source_fingerprint, status, payload_sha256, created_at, finished_at FROM keyframe_generations;
DROP TABLE keyframe_generations;
ALTER TABLE keyframe_generations_v42 RENAME TO keyframe_generations;
CREATE INDEX idx_keyframe_generations_project
  ON keyframe_generations(project_id, created_at DESC);

-- provider_invocations
CREATE TABLE provider_invocations_v42 (
  id TEXT PRIMARY KEY, candidate_generation_id TEXT NULL REFERENCES candidate_generations(id), provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  capability TEXT NOT NULL, provider_name TEXT NOT NULL, model TEXT NOT NULL, prompt_template_version TEXT NOT NULL,
  output_schema_version TEXT NOT NULL, input_sha256 TEXT NOT NULL, output_sha256 TEXT NULL, status TEXT NOT NULL,
  started_at TEXT NULL, finished_at TEXT NULL, duration_ms INTEGER NULL, provider_request_id TEXT NULL,
  usage_json TEXT NULL, estimated_cost REAL NULL, actual_cost REAL NULL, provider_may_have_processed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL, error_message TEXT NULL, created_at TEXT NOT NULL
, timeline_patch_generation_id TEXT REFERENCES timeline_patch_generations(id), captions_provider_generation_id TEXT NULL
  REFERENCES captions_provider_generations(id), keyframe_generation_id TEXT);
INSERT INTO provider_invocations_v42 (id, candidate_generation_id, provider_config_id, capability, provider_name, model, prompt_template_version, output_schema_version, input_sha256, output_sha256, status, started_at, finished_at, duration_ms, provider_request_id, usage_json, estimated_cost, actual_cost, provider_may_have_processed, error_code, error_message, created_at, timeline_patch_generation_id, captions_provider_generation_id, keyframe_generation_id) SELECT id, candidate_generation_id, provider_config_id, capability, provider_name, model, prompt_template_version, output_schema_version, input_sha256, output_sha256, status, started_at, finished_at, duration_ms, provider_request_id, usage_json, estimated_cost, actual_cost, provider_may_have_processed, error_code, error_message, created_at, timeline_patch_generation_id, captions_provider_generation_id, keyframe_generation_id FROM provider_invocations;
DROP TABLE provider_invocations;
ALTER TABLE provider_invocations_v42 RENAME TO provider_invocations;
CREATE INDEX idx_invocations_captions_provider_generation
  ON provider_invocations(captions_provider_generation_id,created_at DESC);
CREATE INDEX idx_invocations_generation ON provider_invocations(candidate_generation_id, created_at DESC);
CREATE INDEX idx_invocations_status ON provider_invocations(status, created_at DESC);
CREATE INDEX idx_invocations_timeline_patch_generation ON provider_invocations(timeline_patch_generation_id,created_at DESC);

-- timeline_patch_egress_previews
CREATE TABLE timeline_patch_egress_previews_v42 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id), base_document_sha256 TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL, provider_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO timeline_patch_egress_previews_v42 (id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at) SELECT id, project_id, provider_config_id, base_revision_id, base_document_sha256, provider_snapshot_json, provider_config_sha256, payload_sha256, stats_json, expires_at, created_at FROM timeline_patch_egress_previews;
DROP TABLE timeline_patch_egress_previews;
ALTER TABLE timeline_patch_egress_previews_v42 RENAME TO timeline_patch_egress_previews;
CREATE INDEX idx_timeline_patch_previews_expiry ON timeline_patch_egress_previews(expires_at);
CREATE TRIGGER timeline_patch_previews_no_delete BEFORE DELETE ON timeline_patch_egress_previews BEGIN SELECT RAISE(ABORT,'timeline patch previews are immutable'); END;
CREATE TRIGGER timeline_patch_previews_no_update BEFORE UPDATE ON timeline_patch_egress_previews BEGIN SELECT RAISE(ABORT,'timeline patch previews are immutable'); END;

-- timeline_patch_generations
CREATE TABLE timeline_patch_generations_v42 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES timeline_patch_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES timeline_patch_egress_consents(id),
  provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id), base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, finished_at TEXT NULL
);
INSERT INTO timeline_patch_generations_v42 (id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, status, payload_sha256, created_at, updated_at, finished_at) SELECT id, project_id, egress_preview_id, egress_consent_id, provider_config_id, base_revision_id, base_document_sha256, status, payload_sha256, created_at, updated_at, finished_at FROM timeline_patch_generations;
DROP TABLE timeline_patch_generations;
ALTER TABLE timeline_patch_generations_v42 RENAME TO timeline_patch_generations;
CREATE INDEX idx_timeline_patch_generations_project ON timeline_patch_generations(project_id,created_at DESC,id DESC);

-- timeline_patch_proposals
CREATE TABLE timeline_patch_proposals_v42 (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE REFERENCES timeline_patch_generations(id),
  project_id TEXT NOT NULL REFERENCES projects(id), base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL, provider_config_id TEXT NULL REFERENCES provider_configs(id) ON DELETE SET NULL,
  patch_json TEXT NOT NULL, patch_sha256 TEXT NOT NULL, proposed_document_sha256 TEXT NOT NULL,
  diff_json TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO timeline_patch_proposals_v42 (id, generation_id, project_id, base_revision_id, base_document_sha256, provider_config_id, patch_json, patch_sha256, proposed_document_sha256, diff_json, created_at) SELECT id, generation_id, project_id, base_revision_id, base_document_sha256, provider_config_id, patch_json, patch_sha256, proposed_document_sha256, diff_json, created_at FROM timeline_patch_proposals;
DROP TABLE timeline_patch_proposals;
ALTER TABLE timeline_patch_proposals_v42 RENAME TO timeline_patch_proposals;
CREATE INDEX idx_timeline_patch_proposals_project ON timeline_patch_proposals(project_id,created_at DESC,id DESC);
CREATE TRIGGER timeline_patch_proposals_no_delete BEFORE DELETE ON timeline_patch_proposals BEGIN SELECT RAISE(ABORT,'timeline patch proposals are immutable'); END;
CREATE TRIGGER timeline_patch_proposals_no_update BEFORE UPDATE ON timeline_patch_proposals BEGIN SELECT RAISE(ABORT,'timeline patch proposals are immutable'); END;

"""