from __future__ import annotations

V28_VERSION = "v28"
V28_SQL = """
CREATE TABLE captions_provider_egress_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  provider_snapshot_json TEXT NOT NULL,
  provider_config_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE captions_provider_egress_consents (
  id TEXT PRIMARY KEY,
  egress_preview_id TEXT NOT NULL UNIQUE REFERENCES captions_provider_egress_previews(id),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT NULL
);
CREATE TABLE captions_provider_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES captions_provider_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES captions_provider_egress_consents(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX captions_provider_previews_project ON captions_provider_egress_previews(project_id,created_at DESC,id DESC);
CREATE INDEX captions_provider_generations_project ON captions_provider_generations(project_id,created_at DESC,id DESC);
CREATE TRIGGER captions_provider_previews_no_update BEFORE UPDATE ON captions_provider_egress_previews BEGIN SELECT RAISE(ABORT,'captions provider previews are immutable'); END;
CREATE TRIGGER captions_provider_previews_no_delete BEFORE DELETE ON captions_provider_egress_previews BEGIN SELECT RAISE(ABORT,'captions provider previews are immutable'); END;
CREATE TRIGGER captions_provider_consents_no_delete BEFORE DELETE ON captions_provider_egress_consents BEGIN SELECT RAISE(ABORT,'captions provider consents are immutable'); END;
CREATE TRIGGER captions_provider_consents_only_consume BEFORE UPDATE ON captions_provider_egress_consents
WHEN NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.id=OLD.id AND NEW.egress_preview_id=OLD.egress_preview_id AND NEW.payload_sha256=OLD.payload_sha256 AND NEW.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'captions provider consents are immutable except first consumption'); END;
"""
