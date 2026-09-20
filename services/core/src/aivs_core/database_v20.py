from __future__ import annotations

# AI-1（ADR-0003 D2）：内置多步 agent 会话。一个会话 = 一次 consent（触发器
# 只允许 NULL→consumed_at 一次，消费即覆盖整个循环——每步 LLM 调用各落一行
# provider_invocations 审计）；每步成功即落不可变 Revision（会话轨迹 = Revision
# 链，任意步可 Undo 回退）。表结构对齐 timeline_patch_* 先例（不可变 + 单次
# 消费 + 哈希钉死）。
V20_VERSION = "v20"

V20_SQL = """
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES agent_session_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES agent_session_egress_consents(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
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
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id, created_at DESC, id DESC);

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  stage TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  summary TEXT NULL,
  output_json TEXT NULL,
  error_json TEXT NULL,
  duration_ms INTEGER NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, ordinal)
);
CREATE INDEX idx_agent_steps_session ON agent_steps(session_id, ordinal);

CREATE TABLE agent_session_egress_previews (
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
CREATE INDEX idx_agent_session_previews_expiry ON agent_session_egress_previews(expires_at);

CREATE TABLE agent_session_egress_consents (
  id TEXT PRIMARY KEY,
  egress_preview_id TEXT NOT NULL REFERENCES agent_session_egress_previews(id),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT NULL
);

CREATE TRIGGER agent_session_previews_no_update BEFORE UPDATE ON agent_session_egress_previews BEGIN SELECT RAISE(ABORT,'agent session previews are immutable'); END;
CREATE TRIGGER agent_session_previews_no_delete BEFORE DELETE ON agent_session_egress_previews BEGIN SELECT RAISE(ABORT,'agent session previews are immutable'); END;
CREATE TRIGGER agent_session_consents_no_delete BEFORE DELETE ON agent_session_egress_consents BEGIN SELECT RAISE(ABORT,'agent session consents are immutable'); END;
CREATE TRIGGER agent_session_consents_only_consume BEFORE UPDATE ON agent_session_egress_consents
WHEN NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.id=OLD.id AND NEW.egress_preview_id=OLD.egress_preview_id AND NEW.payload_sha256=OLD.payload_sha256 AND NEW.created_at=OLD.created_at)
BEGIN SELECT RAISE(ABORT,'agent session consents are immutable except first consumption'); END;
CREATE TRIGGER agent_steps_no_update BEFORE UPDATE ON agent_steps BEGIN SELECT RAISE(ABORT,'agent steps are immutable'); END;
CREATE TRIGGER agent_steps_no_delete BEFORE DELETE ON agent_steps BEGIN SELECT RAISE(ABORT,'agent steps are immutable'); END;
"""
