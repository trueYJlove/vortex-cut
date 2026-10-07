from __future__ import annotations

V32_VERSION = "v32"
V32_SQL = """
CREATE TABLE captions_provider_proposals (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE REFERENCES captions_provider_generations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL,
  proposed_document_json TEXT NOT NULL,
  proposed_document_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX captions_provider_proposals_project ON captions_provider_proposals(project_id,created_at DESC,id DESC);
CREATE TRIGGER captions_provider_proposals_no_update BEFORE UPDATE ON captions_provider_proposals BEGIN SELECT RAISE(ABORT,'captions provider proposals are immutable'); END;
CREATE TRIGGER captions_provider_proposals_no_delete BEFORE DELETE ON captions_provider_proposals BEGIN SELECT RAISE(ABORT,'captions provider proposals are immutable'); END;
"""
