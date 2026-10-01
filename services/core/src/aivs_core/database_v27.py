from __future__ import annotations

V27_VERSION = "v27"
V27_SQL = """
CREATE TABLE worklists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  base_revision_id TEXT NOT NULL,
  base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','confirmed','running','waiting_for_apply','succeeded','failed','cancelled','expired')),
  current_step_ordinal INTEGER NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL,
  max_steps INTEGER NOT NULL,
  token_budget INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX worklists_project_status ON worklists(project_id,status,created_at DESC);
CREATE TABLE worklist_steps (
  id TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL REFERENCES worklists(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('roughcut','editing_grammar','captions','style')),
  planner_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_for_apply','succeeded','failed','cancelled','expired')),
  base_revision_id TEXT NULL,
  input_sha256 TEXT NULL,
  proposal_id TEXT NULL,
  applied_revision_id TEXT NULL,
  error_json TEXT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(worklist_id,ordinal)
);
CREATE INDEX worklist_steps_worklist ON worklist_steps(worklist_id,ordinal);
CREATE TABLE worklist_step_audits (
  id TEXT PRIMARY KEY,
  worklist_step_id TEXT NOT NULL REFERENCES worklist_steps(id),
  planner_id TEXT NOT NULL,
  params_sha256 TEXT NOT NULL,
  output_sha256 TEXT NULL,
  egress_preview_id TEXT NULL,
  created_at TEXT NOT NULL
);
"""
