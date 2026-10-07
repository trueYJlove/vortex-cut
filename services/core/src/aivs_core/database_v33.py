from __future__ import annotations

V33_VERSION = "v33"
V33_SQL = """
CREATE TABLE captions_provider_proposal_applications (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES captions_provider_proposals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX captions_provider_proposal_applications_project ON captions_provider_proposal_applications(project_id,created_at DESC);
"""
