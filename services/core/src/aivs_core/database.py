from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .database_v13 import V13_SQL
from .database_v14 import V14_SQL
from .database_v15 import V15_SQL
from .database_v16 import V16_SQL
from .database_v17 import V17_SQL
from .database_v18 import V18_SQL
from .database_v19 import V19_SQL
from .database_v20 import V20_SQL
from .database_v21 import V21_SQL
from .performance import measured


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class MigrationError(RuntimeError):
    """Raised when the database cannot be safely opened or migrated."""


V1_VERSION = "v1"
V2_VERSION = "v2"
V3_VERSION = "v3"
V4_VERSION = "v4"
V5_VERSION = "v5"
V6_VERSION = "v6"
V7_VERSION = "v7"
V8_VERSION = "v8"
V9_VERSION = "v9"
V10_VERSION = "v10"
V11_VERSION = "v11"
V12_VERSION = "v12"
V13_VERSION = "v13"
V14_VERSION = "v14"
V15_VERSION = "v15"
V16_VERSION = "v16"
V17_VERSION = "v17"
V18_VERSION = "v18"
V19_VERSION = "v19"
V20_VERSION = "v20"
V21_VERSION = "v21"
V1_SQL = """
CREATE TABLE IF NOT EXISTS media_inputs (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, display_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, probe_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived','missing')),
  canvas_json TEXT NOT NULL,
  current_timeline_revision_id TEXT,
  root_dir TEXT NOT NULL,
  root_dir_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK(kind IN ('video','audio','image','text')),
  storage_mode TEXT NOT NULL CHECK(storage_mode IN ('external','managed')),
  display_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at TEXT,
  availability TEXT NOT NULL CHECK(availability IN ('available','missing','changed','unsupported')),
  media_info_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS asset_locations (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  previous_uri TEXT,
  previous_fingerprint TEXT,
  relocated_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'proxy',
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','succeeded','failed','cancelling','cancelled','interrupted'
  )),
  stage TEXT,
  progress REAL NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  encoder_requested TEXT,
  encoder_used TEXT,
  fallback_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  worker_pid INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  media_info_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, created_at);
"""
V2_SQL = """
CREATE TABLE IF NOT EXISTS model_installations (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  install_dir TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  installed_bytes INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  license_id TEXT NOT NULL,
  last_error TEXT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL,
  language TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  duration_us INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NULL
);
CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_us INTEGER NOT NULL,
  end_us INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_asset ON transcripts(asset_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_transcript
  ON transcript_segments(transcript_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_transcript_words_segment
  ON transcript_words(segment_id, ordinal);
"""
V3_SQL = """
CREATE TABLE IF NOT EXISTS timeline_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_revision_id TEXT NULL REFERENCES timeline_revisions(id),
  schema_version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_drafts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  document_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_navigation (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  redo_stack_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_artifacts (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  kind TEXT NOT NULL,
  render_plan_json TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  toolchain_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  artifact_id TEXT NOT NULL REFERENCES render_artifacts(artifact_id),
  profile_id TEXT NOT NULL,
  destination_uri TEXT NOT NULL,
  destination_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_revisions_project
  ON timeline_revisions(project_id, created_at DESC, id DESC);
CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_update
BEFORE UPDATE ON timeline_revisions
BEGIN
  SELECT RAISE(ABORT, 'timeline revisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS timeline_revisions_no_delete
BEFORE DELETE ON timeline_revisions
BEGIN
  SELECT RAISE(ABORT, 'timeline revisions are immutable');
END;
"""
V4_SQL = """
CREATE TABLE IF NOT EXISTS project_briefs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  document_json TEXT NOT NULL, document_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='openai_compatible_text'), display_name TEXT NOT NULL,
  base_url TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  input_price_per_million REAL NULL, output_price_per_million REAL NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_snapshots (
  id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, document_json TEXT NOT NULL, document_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS egress_previews (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  brief_snapshot_json TEXT NOT NULL, brief_sha256 TEXT NOT NULL, recipe_snapshot_id TEXT NOT NULL REFERENCES recipe_snapshots(id),
  provider_snapshot_json TEXT NOT NULL, provider_config_sha256 TEXT NOT NULL,
  transcript_refs_json TEXT NOT NULL, segment_whitelist_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL, stats_json TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS egress_consents (
  id TEXT PRIMARY KEY, egress_preview_id TEXT NOT NULL UNIQUE REFERENCES egress_previews(id), payload_sha256 TEXT NOT NULL,
  consumed_at TEXT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_generations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), egress_preview_id TEXT NOT NULL REFERENCES egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES egress_consents(id), provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  brief_snapshot_json TEXT NOT NULL, brief_sha256 TEXT NOT NULL, recipe_snapshot_id TEXT NOT NULL REFERENCES recipe_snapshots(id),
  timeline_baseline_revision_id TEXT NULL REFERENCES timeline_revisions(id), status TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS provider_invocations (
  id TEXT PRIMARY KEY, candidate_generation_id TEXT NULL REFERENCES candidate_generations(id), provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  capability TEXT NOT NULL, provider_name TEXT NOT NULL, model TEXT NOT NULL, prompt_template_version TEXT NOT NULL,
  output_schema_version TEXT NOT NULL, input_sha256 TEXT NOT NULL, output_sha256 TEXT NULL, status TEXT NOT NULL,
  started_at TEXT NULL, finished_at TEXT NULL, duration_ms INTEGER NULL, provider_request_id TEXT NULL,
  usage_json TEXT NULL, estimated_cost REAL NULL, actual_cost REAL NULL, provider_may_have_processed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL, error_message TEXT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_plans (
  id TEXT PRIMARY KEY, candidate_generation_id TEXT NOT NULL REFERENCES candidate_generations(id), project_id TEXT NOT NULL REFERENCES projects(id),
  ordinal INTEGER NOT NULL, variant TEXT NOT NULL, document_json TEXT NOT NULL, document_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(candidate_generation_id, ordinal), UNIQUE(candidate_generation_id, variant)
);
CREATE TABLE IF NOT EXISTS candidate_adoptions (
  id TEXT PRIMARY KEY, candidate_plan_id TEXT NOT NULL UNIQUE REFERENCES candidate_plans(id), project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefs_project ON project_briefs(project_id);
CREATE INDEX IF NOT EXISTS idx_previews_expiry ON egress_previews(expires_at);
CREATE INDEX IF NOT EXISTS idx_generations_project ON candidate_generations(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_generation ON provider_invocations(candidate_generation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_status ON provider_invocations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_project ON candidate_plans(project_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS recipe_snapshots_no_update BEFORE UPDATE ON recipe_snapshots BEGIN SELECT RAISE(ABORT,'recipe snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS recipe_snapshots_no_delete BEFORE DELETE ON recipe_snapshots BEGIN SELECT RAISE(ABORT,'recipe snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS egress_previews_no_update BEFORE UPDATE ON egress_previews BEGIN SELECT RAISE(ABORT,'egress previews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS egress_previews_no_delete BEFORE DELETE ON egress_previews BEGIN SELECT RAISE(ABORT,'egress previews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS egress_consents_no_delete BEFORE DELETE ON egress_consents BEGIN SELECT RAISE(ABORT,'egress consents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS egress_consents_only_consume BEFORE UPDATE ON egress_consents
WHEN NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.id=OLD.id AND NEW.egress_preview_id=OLD.egress_preview_id AND NEW.payload_sha256=OLD.payload_sha256 AND NEW.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'egress consents are immutable except first consumption'); END;
CREATE TRIGGER IF NOT EXISTS candidate_plans_no_update BEFORE UPDATE ON candidate_plans BEGIN SELECT RAISE(ABORT,'candidate plans are immutable'); END;
CREATE TRIGGER IF NOT EXISTS candidate_plans_no_delete BEFORE DELETE ON candidate_plans BEGIN SELECT RAISE(ABORT,'candidate plans are immutable'); END;
CREATE TRIGGER IF NOT EXISTS candidate_adoptions_no_update BEFORE UPDATE ON candidate_adoptions BEGIN SELECT RAISE(ABORT,'candidate adoptions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS candidate_adoptions_no_delete BEFORE DELETE ON candidate_adoptions BEGIN SELECT RAISE(ABORT,'candidate adoptions are immutable'); END;
"""  # noqa: E501
V5_SQL = """
CREATE TABLE IF NOT EXISTS timeline_patch_egress_previews (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id), base_document_sha256 TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL, provider_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_patch_egress_consents (
  id TEXT PRIMARY KEY, egress_preview_id TEXT NOT NULL UNIQUE REFERENCES timeline_patch_egress_previews(id),
  payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS timeline_patch_generations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES timeline_patch_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES timeline_patch_egress_consents(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id), base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, finished_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS timeline_patch_proposals (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE REFERENCES timeline_patch_generations(id),
  project_id TEXT NOT NULL REFERENCES projects(id), base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL, provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  patch_json TEXT NOT NULL, patch_sha256 TEXT NOT NULL, proposed_document_sha256 TEXT NOT NULL,
  diff_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timeline_patch_applications (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES timeline_patch_proposals(id),
  project_id TEXT NOT NULL REFERENCES projects(id), timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_patch_previews_expiry ON timeline_patch_egress_previews(expires_at);
CREATE INDEX IF NOT EXISTS idx_timeline_patch_generations_project ON timeline_patch_generations(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_patch_proposals_project ON timeline_patch_proposals(project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_timeline_patch_generation ON provider_invocations(timeline_patch_generation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_timeline_patch_generation ON jobs(timeline_patch_generation_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS timeline_patch_previews_no_update BEFORE UPDATE ON timeline_patch_egress_previews BEGIN SELECT RAISE(ABORT,'timeline patch previews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_previews_no_delete BEFORE DELETE ON timeline_patch_egress_previews BEGIN SELECT RAISE(ABORT,'timeline patch previews are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_consents_no_delete BEFORE DELETE ON timeline_patch_egress_consents BEGIN SELECT RAISE(ABORT,'timeline patch consents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_consents_only_consume BEFORE UPDATE ON timeline_patch_egress_consents
WHEN NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.id=OLD.id AND NEW.egress_preview_id=OLD.egress_preview_id AND NEW.payload_sha256=OLD.payload_sha256 AND NEW.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'timeline patch consents are immutable except first consumption'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_proposals_no_update BEFORE UPDATE ON timeline_patch_proposals BEGIN SELECT RAISE(ABORT,'timeline patch proposals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_proposals_no_delete BEFORE DELETE ON timeline_patch_proposals BEGIN SELECT RAISE(ABORT,'timeline patch proposals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_applications_no_update BEFORE UPDATE ON timeline_patch_applications BEGIN SELECT RAISE(ABORT,'timeline patch applications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_patch_applications_no_delete BEFORE DELETE ON timeline_patch_applications BEGIN SELECT RAISE(ABORT,'timeline patch applications are immutable'); END;
"""  # noqa: E501
V6_SQL = """
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_capability_status TEXT NOT NULL DEFAULT 'untested'
  CHECK(timeline_patch_capability_status IN ('untested','supported','unsupported'));
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_response_adapter_id TEXT NULL;
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_probe_protocol_version TEXT NULL;
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_capability_tested_at TEXT NULL;
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_capability_failure_code TEXT NULL;
ALTER TABLE provider_configs
ADD COLUMN timeline_patch_capability_probe_sha256 TEXT NULL;
CREATE TRIGGER IF NOT EXISTS provider_timeline_patch_capability_valid_insert
BEFORE INSERT ON provider_configs
WHEN (
  NEW.timeline_patch_capability_status='untested'
  AND (
    NEW.timeline_patch_response_adapter_id IS NOT NULL
    OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
    OR NEW.timeline_patch_capability_tested_at IS NOT NULL
    OR NEW.timeline_patch_capability_failure_code IS NOT NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NOT NULL
  )
) OR (
  NEW.timeline_patch_capability_status='supported'
  AND (
    NEW.timeline_patch_response_adapter_id
      IS NOT 'openai_chat_completions_json_schema_v1'
    OR NEW.timeline_patch_probe_protocol_version IS NOT '1'
    OR NEW.timeline_patch_capability_tested_at IS NULL
    OR NEW.timeline_patch_capability_failure_code IS NOT NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NULL
  )
) OR (
  NEW.timeline_patch_capability_status='unsupported'
  AND (
    NEW.timeline_patch_response_adapter_id IS NOT NULL
    OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
    OR NEW.timeline_patch_capability_tested_at IS NULL
    OR NEW.timeline_patch_capability_failure_code IS NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NULL
  )
)
BEGIN SELECT RAISE(ABORT,'invalid timeline patch capability state'); END;
CREATE TRIGGER IF NOT EXISTS provider_timeline_patch_capability_valid_update
BEFORE UPDATE OF
  timeline_patch_capability_status,
  timeline_patch_response_adapter_id,
  timeline_patch_probe_protocol_version,
  timeline_patch_capability_tested_at,
  timeline_patch_capability_failure_code,
  timeline_patch_capability_probe_sha256
ON provider_configs
WHEN (
  NEW.timeline_patch_capability_status='untested'
  AND (
    NEW.timeline_patch_response_adapter_id IS NOT NULL
    OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
    OR NEW.timeline_patch_capability_tested_at IS NOT NULL
    OR NEW.timeline_patch_capability_failure_code IS NOT NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NOT NULL
  )
) OR (
  NEW.timeline_patch_capability_status='supported'
  AND (
    NEW.timeline_patch_response_adapter_id
      IS NOT 'openai_chat_completions_json_schema_v1'
    OR NEW.timeline_patch_probe_protocol_version IS NOT '1'
    OR NEW.timeline_patch_capability_tested_at IS NULL
    OR NEW.timeline_patch_capability_failure_code IS NOT NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NULL
  )
) OR (
  NEW.timeline_patch_capability_status='unsupported'
  AND (
    NEW.timeline_patch_response_adapter_id IS NOT NULL
    OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
    OR NEW.timeline_patch_capability_tested_at IS NULL
    OR NEW.timeline_patch_capability_failure_code IS NULL
    OR NEW.timeline_patch_capability_probe_sha256 IS NULL
  )
)
BEGIN SELECT RAISE(ABORT,'invalid timeline patch capability state'); END;
CREATE TRIGGER IF NOT EXISTS provider_timeline_patch_capability_reset_on_config_change
AFTER UPDATE OF
  kind,display_name,base_url,model,enabled,
  input_price_per_million,output_price_per_million
ON provider_configs
WHEN OLD.timeline_patch_capability_status!='untested'
BEGIN
  UPDATE provider_configs SET timeline_patch_capability_status='untested',
    timeline_patch_response_adapter_id=NULL,timeline_patch_probe_protocol_version=NULL,
    timeline_patch_capability_tested_at=NULL,timeline_patch_capability_failure_code=NULL,
    timeline_patch_capability_probe_sha256=NULL WHERE id=NEW.id;
END;
"""  # noqa: E501
V7_SQL = """
DROP TRIGGER IF EXISTS provider_timeline_patch_capability_valid_insert;
DROP TRIGGER IF EXISTS provider_timeline_patch_capability_valid_update;
CREATE TRIGGER provider_timeline_patch_capability_valid_insert
BEFORE INSERT ON provider_configs
WHEN (NEW.timeline_patch_capability_status='supported' AND (
  NEW.timeline_patch_response_adapter_id IS NULL
  OR NEW.timeline_patch_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1',
    'openai_responses_patchscript_v1',
    'openai_chat_completions_json_schema_v1',
    'openai_chat_completions_patchscript_v1'
  )
  OR NEW.timeline_patch_probe_protocol_version IS NOT '1'
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='unsupported' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='untested' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NOT NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid timeline patch capability state'); END;
CREATE TRIGGER provider_timeline_patch_capability_valid_update
BEFORE UPDATE OF
  timeline_patch_capability_status,
  timeline_patch_response_adapter_id,
  timeline_patch_probe_protocol_version,
  timeline_patch_capability_tested_at,
  timeline_patch_capability_failure_code,
  timeline_patch_capability_probe_sha256
ON provider_configs
WHEN (NEW.timeline_patch_capability_status='supported' AND (
  NEW.timeline_patch_response_adapter_id IS NULL
  OR NEW.timeline_patch_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1',
    'openai_responses_patchscript_v1',
    'openai_chat_completions_json_schema_v1',
    'openai_chat_completions_patchscript_v1'
  )
  OR NEW.timeline_patch_probe_protocol_version IS NOT '1'
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='unsupported' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='untested' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NOT NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid timeline patch capability state'); END;
"""
V8_SQL = """
ALTER TABLE provider_configs ADD COLUMN candidate_capability_status TEXT NOT NULL DEFAULT 'untested'
  CHECK(candidate_capability_status IN ('untested','supported','unsupported'));
ALTER TABLE provider_configs ADD COLUMN candidate_response_adapter_id TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN candidate_probe_protocol_version TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN candidate_capability_tested_at TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN candidate_capability_failure_code TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN candidate_capability_probe_sha256 TEXT NULL;
ALTER TABLE egress_previews ADD COLUMN candidate_response_adapter_id TEXT NULL;
ALTER TABLE egress_previews ADD COLUMN candidate_probe_protocol_version TEXT NULL;
ALTER TABLE egress_previews ADD COLUMN candidate_capability_probe_sha256 TEXT NULL;
ALTER TABLE candidate_generations ADD COLUMN candidate_response_adapter_id TEXT NULL;
ALTER TABLE candidate_generations ADD COLUMN candidate_probe_protocol_version TEXT NULL;
ALTER TABLE candidate_generations ADD COLUMN candidate_capability_probe_sha256 TEXT NULL;
ALTER TABLE candidate_generations ADD COLUMN provider_config_sha256 TEXT NULL;
CREATE TRIGGER provider_candidate_capability_valid_insert BEFORE INSERT ON provider_configs
WHEN (NEW.candidate_capability_status='supported' AND (
  NEW.candidate_response_adapter_id IS NULL OR NEW.candidate_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1','openai_responses_candidatescript_v1',
    'openai_chat_completions_json_schema_v1','openai_chat_completions_candidatescript_v1')
  OR NEW.candidate_probe_protocol_version IS NOT '1' OR NEW.candidate_capability_tested_at IS NULL
  OR NEW.candidate_capability_failure_code IS NOT NULL
  OR NEW.candidate_capability_probe_sha256 IS NULL
)) OR (NEW.candidate_capability_status='unsupported' AND (
  NEW.candidate_response_adapter_id IS NOT NULL OR NEW.candidate_probe_protocol_version IS NOT NULL
  OR NEW.candidate_capability_tested_at IS NULL OR NEW.candidate_capability_failure_code IS NULL
  OR NEW.candidate_capability_probe_sha256 IS NULL
)) OR (NEW.candidate_capability_status='untested' AND (
  NEW.candidate_response_adapter_id IS NOT NULL OR NEW.candidate_probe_protocol_version IS NOT NULL
  OR NEW.candidate_capability_tested_at IS NOT NULL
  OR NEW.candidate_capability_failure_code IS NOT NULL
  OR NEW.candidate_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid candidate capability state'); END;
CREATE TRIGGER provider_candidate_capability_valid_update
BEFORE UPDATE OF candidate_capability_status,
  candidate_response_adapter_id,candidate_probe_protocol_version,
  candidate_capability_tested_at,candidate_capability_failure_code,
  candidate_capability_probe_sha256 ON provider_configs
WHEN (NEW.candidate_capability_status='supported' AND (
  NEW.candidate_response_adapter_id IS NULL OR NEW.candidate_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1','openai_responses_candidatescript_v1',
    'openai_chat_completions_json_schema_v1','openai_chat_completions_candidatescript_v1')
  OR NEW.candidate_probe_protocol_version IS NOT '1' OR NEW.candidate_capability_tested_at IS NULL
  OR NEW.candidate_capability_failure_code IS NOT NULL
  OR NEW.candidate_capability_probe_sha256 IS NULL
)) OR (NEW.candidate_capability_status='unsupported' AND (
  NEW.candidate_response_adapter_id IS NOT NULL OR NEW.candidate_probe_protocol_version IS NOT NULL
  OR NEW.candidate_capability_tested_at IS NULL OR NEW.candidate_capability_failure_code IS NULL
  OR NEW.candidate_capability_probe_sha256 IS NULL
)) OR (NEW.candidate_capability_status='untested' AND (
  NEW.candidate_response_adapter_id IS NOT NULL OR NEW.candidate_probe_protocol_version IS NOT NULL
  OR NEW.candidate_capability_tested_at IS NOT NULL
  OR NEW.candidate_capability_failure_code IS NOT NULL
  OR NEW.candidate_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid candidate capability state'); END;
CREATE TRIGGER provider_candidate_capability_reset_on_config_change
AFTER UPDATE OF base_url,model ON provider_configs
WHEN OLD.candidate_capability_status!='untested'
BEGIN UPDATE provider_configs SET candidate_capability_status='untested',
  candidate_response_adapter_id=NULL,candidate_probe_protocol_version=NULL,
  candidate_capability_tested_at=NULL,candidate_capability_failure_code=NULL,
  candidate_capability_probe_sha256=NULL WHERE id=NEW.id; END;
"""
V9_SQL = """
CREATE TABLE IF NOT EXISTS rendition_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  timeline_document_sha256 TEXT NOT NULL,
  platform_preset_id TEXT NOT NULL,
  platform_preset_version INTEGER NOT NULL,
  platform_preset_sha256 TEXT NOT NULL,
  rendition_preset_id TEXT NOT NULL,
  rendition_preset_version INTEGER NOT NULL,
  rendition_preset_sha256 TEXT NOT NULL,
  layout_policy TEXT NOT NULL CHECK(layout_policy IN (
    'preserve_timeline','fit_all','crop_fill_all','blurred_background_all')),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,timeline_revision_id,timeline_document_sha256,platform_preset_id,
    platform_preset_sha256,rendition_preset_id,rendition_preset_sha256,layout_policy,snapshot_sha256)
);
CREATE TABLE IF NOT EXISTS export_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  timeline_document_sha256 TEXT NOT NULL,
  directory_display_name TEXT NOT NULL,
  retry_of_batch_id TEXT NULL REFERENCES export_batches(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_batch_items (
  id TEXT PRIMARY KEY,
  export_batch_id TEXT NOT NULL REFERENCES export_batches(id),
  ordinal INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  rendition_snapshot_id TEXT NOT NULL REFERENCES rendition_snapshots(id),
  preview_artifact_id TEXT NOT NULL REFERENCES render_artifacts(artifact_id),
  platform_preset_id TEXT NOT NULL,
  rendition_preset_id TEXT NOT NULL,
  destination_display_name TEXT NOT NULL,
  retry_of_item_id TEXT NULL REFERENCES export_batch_items(id),
  created_at TEXT NOT NULL,
  UNIQUE(export_batch_id,ordinal),
  UNIQUE(export_batch_id,platform_preset_id,rendition_preset_id)
);
ALTER TABLE jobs ADD COLUMN export_batch_item_id TEXT NULL REFERENCES export_batch_items(id);
ALTER TABLE render_artifacts ADD COLUMN rendition_snapshot_id TEXT NULL REFERENCES rendition_snapshots(id);
ALTER TABLE export_records ADD COLUMN export_batch_item_id TEXT NULL REFERENCES export_batch_items(id);
CREATE INDEX IF NOT EXISTS idx_rendition_snapshots_project_revision
  ON rendition_snapshots(project_id,timeline_revision_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_batches_project ON export_batches(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_batch_items_batch ON export_batch_items(export_batch_id,ordinal);
CREATE INDEX IF NOT EXISTS idx_jobs_export_batch_item ON jobs(export_batch_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_records_batch_item_unique
  ON export_records(export_batch_item_id) WHERE export_batch_item_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS rendition_snapshots_no_update
BEFORE UPDATE ON rendition_snapshots BEGIN SELECT RAISE(ABORT,'rendition snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rendition_snapshots_no_delete
BEFORE DELETE ON rendition_snapshots BEGIN SELECT RAISE(ABORT,'rendition snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS export_batches_no_update
BEFORE UPDATE ON export_batches BEGIN SELECT RAISE(ABORT,'export batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS export_batch_items_no_update
BEFORE UPDATE ON export_batch_items BEGIN SELECT RAISE(ABORT,'export batch items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS export_batch_items_no_delete
BEFORE DELETE ON export_batch_items BEGIN SELECT RAISE(ABORT,'export batch items are immutable'); END;
"""  # noqa: E501
V10_SQL = """
CREATE TABLE IF NOT EXISTS rendition_reframe_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  timeline_document_sha256 TEXT NOT NULL,
  base_rendition_snapshot_id TEXT NOT NULL REFERENCES rendition_snapshots(id),
  base_snapshot_sha256 TEXT NOT NULL,
  platform_preset_id TEXT NOT NULL,
  rendition_preset_id TEXT NOT NULL,
  geometry_contract_version INTEGER NOT NULL CHECK(geometry_contract_version = 1),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  adjustment_count INTEGER NOT NULL CHECK(adjustment_count BETWEEN 1 AND 500),
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,base_rendition_snapshot_id,base_snapshot_sha256,snapshot_sha256)
);
CREATE TABLE IF NOT EXISTS reframe_export_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  timeline_document_sha256 TEXT NOT NULL,
  directory_display_name TEXT NOT NULL,
  retry_of_batch_id TEXT NULL REFERENCES reframe_export_batches(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reframe_export_batch_items (
  id TEXT PRIMARY KEY,
  reframe_export_batch_id TEXT NOT NULL REFERENCES reframe_export_batches(id),
  ordinal INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  rendition_reframe_snapshot_id TEXT NOT NULL REFERENCES rendition_reframe_snapshots(id),
  preview_artifact_id TEXT NOT NULL REFERENCES render_artifacts(artifact_id),
  platform_preset_id TEXT NOT NULL,
  rendition_preset_id TEXT NOT NULL,
  destination_display_name TEXT NOT NULL,
  retry_of_item_id TEXT NULL REFERENCES reframe_export_batch_items(id),
  created_at TEXT NOT NULL,
  UNIQUE(reframe_export_batch_id,ordinal),
  UNIQUE(reframe_export_batch_id,platform_preset_id,rendition_preset_id)
);
ALTER TABLE jobs ADD COLUMN reframe_export_batch_item_id TEXT NULL
  REFERENCES reframe_export_batch_items(id);
ALTER TABLE render_artifacts ADD COLUMN rendition_reframe_snapshot_id TEXT NULL
  REFERENCES rendition_reframe_snapshots(id);
ALTER TABLE export_records ADD COLUMN reframe_export_batch_item_id TEXT NULL
  REFERENCES reframe_export_batch_items(id);
CREATE INDEX IF NOT EXISTS idx_rendition_reframe_snapshots_project_revision
  ON rendition_reframe_snapshots(project_id,timeline_revision_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reframe_export_batches_project
  ON reframe_export_batches(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reframe_export_batch_items_batch
  ON reframe_export_batch_items(reframe_export_batch_id,ordinal);
CREATE INDEX IF NOT EXISTS idx_jobs_reframe_export_batch_item
  ON jobs(reframe_export_batch_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_records_reframe_batch_item_unique
  ON export_records(reframe_export_batch_item_id)
  WHERE reframe_export_batch_item_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS rendition_reframe_snapshots_no_update
BEFORE UPDATE ON rendition_reframe_snapshots
BEGIN SELECT RAISE(ABORT,'rendition reframe snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rendition_reframe_snapshots_no_delete
BEFORE DELETE ON rendition_reframe_snapshots
BEGIN SELECT RAISE(ABORT,'rendition reframe snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reframe_export_batches_no_update
BEFORE UPDATE ON reframe_export_batches
BEGIN SELECT RAISE(ABORT,'reframe export batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reframe_export_batches_no_delete
BEFORE DELETE ON reframe_export_batches
BEGIN SELECT RAISE(ABORT,'reframe export batches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reframe_export_batch_items_no_update
BEFORE UPDATE ON reframe_export_batch_items
BEGIN SELECT RAISE(ABORT,'reframe export batch items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reframe_export_batch_items_no_delete
BEFORE DELETE ON reframe_export_batch_items
BEGIN SELECT RAISE(ABORT,'reframe export batch items are immutable'); END;
CREATE TRIGGER IF NOT EXISTS jobs_stage3_batch_owner_exclusive_insert
BEFORE INSERT ON jobs
WHEN NEW.export_batch_item_id IS NOT NULL AND NEW.reframe_export_batch_item_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 batch owners are mutually exclusive'); END;
CREATE TRIGGER IF NOT EXISTS jobs_stage3_batch_owner_exclusive_update
BEFORE UPDATE OF export_batch_item_id,reframe_export_batch_item_id ON jobs
WHEN NEW.export_batch_item_id IS NOT NULL AND NEW.reframe_export_batch_item_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 batch owners are mutually exclusive'); END;
CREATE TRIGGER IF NOT EXISTS render_artifacts_stage3_snapshot_owner_exclusive_insert
BEFORE INSERT ON render_artifacts
WHEN NEW.rendition_snapshot_id IS NOT NULL AND NEW.rendition_reframe_snapshot_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 snapshot owners are mutually exclusive'); END;
CREATE TRIGGER IF NOT EXISTS render_artifacts_stage3_snapshot_owner_exclusive_update
BEFORE UPDATE OF rendition_snapshot_id,rendition_reframe_snapshot_id ON render_artifacts
WHEN NEW.rendition_snapshot_id IS NOT NULL AND NEW.rendition_reframe_snapshot_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 snapshot owners are mutually exclusive'); END;
CREATE TRIGGER IF NOT EXISTS export_records_stage3_batch_owner_exclusive_insert
BEFORE INSERT ON export_records
WHEN NEW.export_batch_item_id IS NOT NULL AND NEW.reframe_export_batch_item_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 batch owners are mutually exclusive'); END;
CREATE TRIGGER IF NOT EXISTS export_records_stage3_batch_owner_exclusive_update
BEFORE UPDATE OF export_batch_item_id,reframe_export_batch_item_id ON export_records
WHEN NEW.export_batch_item_id IS NOT NULL AND NEW.reframe_export_batch_item_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'stage3 batch owners are mutually exclusive'); END;
"""  # noqa: E501
V11_SQL = """
CREATE TABLE IF NOT EXISTS media_generation_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  generation_kind TEXT NOT NULL CHECK(generation_kind IN ('image','tts')),
  execution_mode TEXT NOT NULL CHECK(execution_mode='simulation_only'),
  prompt_sha256 TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, request_sha256)
);
CREATE TABLE IF NOT EXISTS media_generation_tasks (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES media_generation_requests(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','succeeded','failed','cancelled','interrupted'
  )),
  stage TEXT NOT NULL,
  retry_of_task_id TEXT NULL REFERENCES media_generation_tasks(id),
  output_asset_id TEXT NULL REFERENCES assets(id),
  output_sha256 TEXT NULL,
  result_summary_json TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL,
  UNIQUE(request_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_media_generation_requests_project
  ON media_generation_requests(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_media_generation_tasks_request
  ON media_generation_tasks(request_id, attempt, created_at);
CREATE INDEX IF NOT EXISTS idx_media_generation_tasks_job
  ON media_generation_tasks(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_generation_tasks_retry_of
  ON media_generation_tasks(retry_of_task_id)
  WHERE retry_of_task_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS media_generation_requests_no_update
BEFORE UPDATE ON media_generation_requests
BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END;
CREATE TRIGGER IF NOT EXISTS media_generation_requests_no_delete
BEFORE DELETE ON media_generation_requests
BEGIN SELECT RAISE(ABORT,'media generation requests are immutable'); END;
"""
V12_SQL = """
CREATE TABLE shot_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  current_revision_id TEXT NULL,
  confirmed_revision_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, project_id),
  FOREIGN KEY(current_revision_id, id)
    REFERENCES shot_list_revisions(id, shot_list_id),
  FOREIGN KEY(confirmed_revision_id, id)
    REFERENCES shot_list_revisions(id, shot_list_id)
);
CREATE TABLE shot_list_revisions (
  id TEXT PRIMARY KEY,
  shot_list_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  parent_revision_id TEXT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK(length(summary) <= 4000),
  document_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(id, shot_list_id),
  UNIQUE(shot_list_id, document_sha256),
  FOREIGN KEY(shot_list_id, project_id)
    REFERENCES shot_lists(id, project_id),
  FOREIGN KEY(parent_revision_id, shot_list_id)
    REFERENCES shot_list_revisions(id, shot_list_id)
);
CREATE TABLE shot_requirements (
  id TEXT PRIMARY KEY,
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 23),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  visual_direction TEXT NOT NULL CHECK(length(visual_direction) BETWEEN 1 AND 2000),
  target_duration_us INTEGER NULL CHECK(
    target_duration_us IS NULL OR target_duration_us BETWEEN 100000 AND 600000000
  ),
  visual_kind TEXT NOT NULL CHECK(visual_kind IN ('existing_media','image')),
  visual_source_asset_id TEXT NULL REFERENCES assets(id),
  narration_kind TEXT NULL CHECK(narration_kind IS NULL OR narration_kind='tts'),
  narration_text TEXT NULL CHECK(
    narration_text IS NULL OR length(narration_text) BETWEEN 1 AND 2000
  ),
  CHECK(
    (visual_kind='existing_media' AND visual_source_asset_id IS NOT NULL) OR
    (visual_kind='image' AND visual_source_asset_id IS NULL)
  ),
  CHECK(
    (narration_kind IS NULL AND narration_text IS NULL) OR
    (narration_kind='tts' AND narration_text IS NOT NULL)
  ),
  UNIQUE(shot_list_revision_id, ordinal)
);
CREATE INDEX shot_list_revisions_by_list_created
  ON shot_list_revisions(shot_list_id, created_at DESC, id DESC);
CREATE INDEX shot_requirements_by_visual_asset
  ON shot_requirements(visual_source_asset_id);
CREATE TRIGGER shot_list_revisions_no_update
BEFORE UPDATE ON shot_list_revisions
BEGIN SELECT RAISE(ABORT, 'shot list revisions immutable'); END;
CREATE TRIGGER shot_list_revisions_no_delete
BEFORE DELETE ON shot_list_revisions
BEGIN SELECT RAISE(ABORT, 'shot list revisions immutable'); END;
CREATE TRIGGER shot_requirements_no_update
BEFORE UPDATE ON shot_requirements
BEGIN SELECT RAISE(ABORT, 'shot requirements immutable'); END;
CREATE TRIGGER shot_requirements_no_delete
BEFORE DELETE ON shot_requirements
BEGIN SELECT RAISE(ABORT, 'shot requirements immutable'); END;
CREATE TRIGGER shot_lists_identity_no_update
BEFORE UPDATE OF id, project_id, created_at ON shot_lists
BEGIN SELECT RAISE(ABORT, 'shot list identity immutable'); END;
CREATE TRIGGER shot_requirements_asset_owner
BEFORE INSERT ON shot_requirements
WHEN NEW.visual_kind='existing_media' AND NOT EXISTS (
  SELECT 1
  FROM assets a
  JOIN shot_list_revisions r ON r.id=NEW.shot_list_revision_id
  WHERE a.id=NEW.visual_source_asset_id AND a.project_id=r.project_id
)
BEGIN SELECT RAISE(ABORT, 'asset project mismatch'); END;
"""
MIGRATIONS: dict[str, str] = {
    V1_VERSION: V1_SQL,
    V2_VERSION: V2_SQL,
    V3_VERSION: V3_SQL,
    V4_VERSION: V4_SQL,
    V5_VERSION: V5_SQL,
    V6_VERSION: V6_SQL,
    V7_VERSION: V7_SQL,
    V8_VERSION: V8_SQL,
    V9_VERSION: V9_SQL,
    V10_VERSION: V10_SQL,
    V11_VERSION: V11_SQL,
    V12_VERSION: V12_SQL,
    V13_VERSION: V13_SQL,
    V14_VERSION: V14_SQL,
    V15_VERSION: V15_SQL,
    V16_VERSION: V16_SQL,
    V17_VERSION: V17_SQL,
    V18_VERSION: V18_SQL,
    V19_VERSION: V19_SQL,
    V20_VERSION: V20_SQL,
    V21_VERSION: V21_SQL,
}


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.last_backup: Path | None = None

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._adopt_stage0_database()
        with self.connection() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)"
            )
            applied = {
                row[0]: row[2]
                for row in db.execute("SELECT version, applied_at, checksum FROM schema_migrations")
            }
            unknown = set(applied) - set(MIGRATIONS)
            if unknown:
                raise MigrationError(f"未知数据库版本: {sorted(unknown)}")
            for version, sql in MIGRATIONS.items():
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise MigrationError(f"迁移校验和不匹配: {version}")
                    continue
                self.last_backup = self._backup()
                try:
                    if version in {V13_VERSION, V14_VERSION}:
                        self._apply_rebuild(db, version, sql, checksum)
                        continue
                    db.execute("BEGIN")
                    self._apply_v1_compatibility(db)
                    self._apply_v2_compatibility(db)
                    self._apply_v3_compatibility(db)
                    self._apply_v4_compatibility(db)
                    self._apply_v5_compatibility(db)
                    self._apply_v6_compatibility(db)
                    self._apply_v7_compatibility(db)
                    self._apply_v8_compatibility(db)
                    self._apply_v9_compatibility(db)
                    self._apply_v10_compatibility(db)
                    statements = _statements(sql)
                    if version == V9_VERSION:
                        statements = self._v9_statements(db, statements)
                    elif version == V10_VERSION:
                        statements = self._v10_statements(db, statements)
                    for statement in statements:
                        db.execute(statement)
                    db.execute(
                        "INSERT INTO schema_migrations(version, applied_at, checksum) "
                        "VALUES (?,?,?)",
                        (version, utc_now(), checksum),
                    )
                    db.execute("COMMIT")
                except Exception as exc:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                    raise MigrationError(f"迁移 {version} 失败") from exc

            self._ensure_v1_columns(db)

    @staticmethod
    def _apply_rebuild(db: sqlite3.Connection, version: str, sql: str, checksum: str) -> None:
        db.execute("PRAGMA foreign_keys=OFF")
        try:
            db.execute("BEGIN IMMEDIATE")
            for statement in _statements(sql):
                db.execute(statement)
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise MigrationError("重建迁移后外键检查失败")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MigrationError("重建迁移后完整性检查失败")
            db.execute(
                "INSERT INTO schema_migrations(version,applied_at,checksum) VALUES (?,?,?)",
                (version, utc_now(), checksum),
            )
            db.execute("COMMIT")
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.execute("PRAGMA foreign_keys=ON")

    def _backup(self) -> Path:
        backup_dir = self.path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        target = backup_dir / f"app-{timestamp}.db"
        source = sqlite3.connect(self.path) if self.path.exists() else None
        destination = sqlite3.connect(target)
        try:
            if source is not None:
                source.backup(destination)
        finally:
            destination.close()
            if source is not None:
                source.close()
        return target

    def _adopt_stage0_database(self) -> None:
        legacy = self.path.with_name("stage0.db")
        if self.path.name == "app.db" and not self.path.exists() and legacy.exists():
            shutil.copy2(legacy, self.path)

    @staticmethod
    def _apply_v1_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" in tables:
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            additions = {
                "project_id": "TEXT REFERENCES projects(id)",
                "kind": "TEXT",
            }
            for name, definition in additions.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
            if "type" in columns:
                db.execute("UPDATE jobs SET kind=COALESCE(kind,type) WHERE kind IS NULL")

    @staticmethod
    def _ensure_v1_columns(db: sqlite3.Connection) -> None:
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        if "kind" in columns:
            db.execute("UPDATE jobs SET kind=COALESCE(kind,type)")

    @staticmethod
    def _apply_v2_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" not in tables:
            return
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        additions = {
            "asset_id": "TEXT REFERENCES assets(id)",
            "model_id": "TEXT",
            "model_revision": "TEXT",
            "input_fingerprint": "TEXT",
            "resource_class": "TEXT",
            "result_json": "TEXT",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")

    @staticmethod
    def _apply_v3_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" not in tables:
            return
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        additions = {
            "timeline_revision_id": "TEXT REFERENCES timeline_revisions(id)",
            "idempotency_key": "TEXT",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")

    @staticmethod
    def _apply_v4_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" not in tables:
            return
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        additions = {
            "provider_invocation_id": "TEXT REFERENCES provider_invocations(id)",
            "candidate_generation_id": "TEXT REFERENCES candidate_generations(id)",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")

    @staticmethod
    def _apply_v5_compatibility(db: sqlite3.Connection) -> None:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "provider_invocations" in tables:
            columns = {row[1] for row in db.execute("PRAGMA table_info(provider_invocations)")}
            if "timeline_patch_generation_id" not in columns:
                db.execute(
                    "ALTER TABLE provider_invocations ADD COLUMN timeline_patch_generation_id "
                    "TEXT REFERENCES timeline_patch_generations(id)"
                )
        if "jobs" in tables:
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            if "timeline_patch_generation_id" not in columns:
                db.execute(
                    "ALTER TABLE jobs ADD COLUMN timeline_patch_generation_id "
                    "TEXT REFERENCES timeline_patch_generations(id)"
                )

    @staticmethod
    def _apply_v6_compatibility(db: sqlite3.Connection) -> None:
        # v6's SQL performs the only required additions. This helper deliberately
        # has no data rewrite: every historical Provider must remain untested.
        del db

    @staticmethod
    def _apply_v7_compatibility(db: sqlite3.Connection) -> None:
        # v7 only replaces capability constraints; existing metadata is preserved.
        del db

    @staticmethod
    def _apply_v8_compatibility(db: sqlite3.Connection) -> None:
        # v8 is append-only: historical rows keep nullable snapshot columns.
        del db

    @staticmethod
    def _apply_v9_compatibility(db: sqlite3.Connection) -> None:
        # v9 has no data rewrite. Existing partial columns are handled by
        # _v9_statements while preserving the fixed migration checksum.
        del db

    @staticmethod
    def _v9_statements(db: sqlite3.Connection, statements: list[str]) -> list[str]:
        existing = {
            table: {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            for table in ("jobs", "render_artifacts", "export_records")
        }
        additions = {
            "ALTER TABLE jobs ADD COLUMN export_batch_item_id": ("jobs", "export_batch_item_id"),
            "ALTER TABLE render_artifacts ADD COLUMN rendition_snapshot_id": (
                "render_artifacts",
                "rendition_snapshot_id",
            ),
            "ALTER TABLE export_records ADD COLUMN export_batch_item_id": (
                "export_records",
                "export_batch_item_id",
            ),
        }
        return [
            statement
            for statement in statements
            if not any(
                statement.startswith(prefix) and column in existing[table]
                for prefix, (table, column) in additions.items()
            )
        ]

    @staticmethod
    def _apply_v10_compatibility(db: sqlite3.Connection) -> None:
        # v10 has no historical data rewrite. Partial ALTER additions are
        # filtered while the frozen migration text retains a stable checksum.
        del db

    @staticmethod
    def _v10_statements(db: sqlite3.Connection, statements: list[str]) -> list[str]:
        existing = {
            table: {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            for table in ("jobs", "render_artifacts", "export_records")
        }
        additions = {
            "ALTER TABLE jobs ADD COLUMN reframe_export_batch_item_id": (
                "jobs",
                "reframe_export_batch_item_id",
            ),
            "ALTER TABLE render_artifacts ADD COLUMN rendition_reframe_snapshot_id": (
                "render_artifacts",
                "rendition_reframe_snapshot_id",
            ),
            "ALTER TABLE export_records ADD COLUMN reframe_export_batch_item_id": (
                "export_records",
                "reframe_export_batch_item_id",
            ),
        }
        return [
            statement
            for statement in statements
            if not any(
                statement.startswith(prefix) and column in existing[table]
                for prefix, (table, column) in additions.items()
            )
        ]

    def recover_interrupted(self) -> int:
        now = utc_now()
        with self.connection() as db:
            cursor = db.execute(
                "UPDATE jobs SET status='interrupted', worker_pid=NULL, "
                "stage='interrupted', error_code='JOB_INTERRUPTED', "
                "error_message='Core 重启前任务未完成', "
                "finished_at=?, updated_at=? "
                "WHERE status IN ('running','cancelling')",
                (now, now),
            )
            return cursor.rowcount


def _statements(sql: str) -> list[str]:
    statements: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise sqlite3.OperationalError("incomplete migration statement")
    return statements


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str) -> Any:
    return json.loads(value)


@measured("hash")
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"
