from __future__ import annotations

V31_VERSION = "v31"
V31_SQL = """
CREATE TABLE captions_provider_results (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL UNIQUE REFERENCES captions_provider_generations(id),
  output_json TEXT NOT NULL,
  output_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX captions_provider_results_generation ON captions_provider_results(generation_id);
CREATE TRIGGER captions_provider_results_no_update BEFORE UPDATE ON captions_provider_results BEGIN SELECT RAISE(ABORT,'captions provider results are immutable'); END;
CREATE TRIGGER captions_provider_results_no_delete BEFORE DELETE ON captions_provider_results BEGIN SELECT RAISE(ABORT,'captions provider results are immutable'); END;
"""
