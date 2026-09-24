from __future__ import annotations

# W1.1 剪辑语法层骨架：语法提案与采纳落盘（零 egress，无 provider 外键）。
#
# 动机：P-A 纯语法路径不经过 LLM/egress，不能复用 timeline_patch_*（那套强绑
# generation + provider + consent）。本迁移为确定性提案提供不可变落盘。
#
# 与 timeline_patch_proposals 的差异：无 generation_id / provider_config_id；
# 增 rationale_json（C7/D5 可解释）与 planner/params（工具化复算）。

V24_VERSION = "v24"

V24_SQL = """
CREATE TABLE editing_grammar_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  planner TEXT NOT NULL,
  params_json TEXT NOT NULL,
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL,
  proposed_document_sha256 TEXT NOT NULL,
  rationale_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE editing_grammar_applications (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES editing_grammar_proposals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_editing_grammar_proposals_project
  ON editing_grammar_proposals(project_id, created_at DESC, id DESC);
CREATE TRIGGER editing_grammar_proposals_no_update BEFORE UPDATE ON editing_grammar_proposals
BEGIN SELECT RAISE(ABORT, 'editing grammar proposals are immutable'); END;
CREATE TRIGGER editing_grammar_proposals_no_delete BEFORE DELETE ON editing_grammar_proposals
BEGIN SELECT RAISE(ABORT, 'editing grammar proposals are immutable'); END;
CREATE TRIGGER editing_grammar_applications_no_update BEFORE UPDATE ON editing_grammar_applications
BEGIN SELECT RAISE(ABORT, 'editing grammar applications are immutable'); END;
CREATE TRIGGER editing_grammar_applications_no_delete BEFORE DELETE ON editing_grammar_applications
BEGIN SELECT RAISE(ABORT, 'editing grammar applications are immutable'); END;
"""
