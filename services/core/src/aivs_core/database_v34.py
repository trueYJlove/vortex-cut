from __future__ import annotations

# captions 响应适配器阶梯（ADAPTER_PLANNING_GATE / DESIGN_GATE 2026-10-05）：
# captions 路径原先固定走 json_schema，在不支持该 response_format 的网关上必然
# 失败；且失败码/probe 哈希从未落库，只剩笼统错误码，导致 2026-10-03 把网关
# 400 误诊为"网络不可达"。本迁移补齐与 timeline_patch/candidate 对称的四列与
# 状态不变量，使"选中的适配器"和"失败原因"可持久化、可区分。
# 旧探测语义不可信（改造前未记录适配器）→ 重置为 untested（对齐 v22 先例）。
# 触发器为纯新增，不重建 v22 已有的 candidate/timeline_patch 触发器。
V34_VERSION = "v34"

V34_SQL = """
ALTER TABLE provider_configs ADD COLUMN captions_provider_response_adapter_id TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_probe_protocol_version TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_failure_code TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN captions_provider_capability_probe_sha256 TEXT NULL;

CREATE TRIGGER provider_captions_capability_valid_insert
BEFORE INSERT ON provider_configs
WHEN (NEW.captions_provider_capability_status='supported' AND (
  NEW.captions_provider_response_adapter_id IS NULL
  OR NEW.captions_provider_response_adapter_id NOT IN (
    'openai_chat_completions_json_schema_v1',
    'openai_chat_completions_captionscript_v1')
  OR NEW.captions_provider_probe_protocol_version IS NOT '1'
  OR NEW.captions_provider_capability_tested_at IS NULL
  OR NEW.captions_provider_capability_failure_code IS NOT NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NULL
)) OR (NEW.captions_provider_capability_status='unsupported' AND (
  NEW.captions_provider_response_adapter_id IS NOT NULL
  OR NEW.captions_provider_probe_protocol_version IS NOT NULL
  OR NEW.captions_provider_capability_tested_at IS NULL
  OR NEW.captions_provider_capability_failure_code IS NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NULL
)) OR (NEW.captions_provider_capability_status='untested' AND (
  NEW.captions_provider_response_adapter_id IS NOT NULL
  OR NEW.captions_provider_probe_protocol_version IS NOT NULL
  OR NEW.captions_provider_capability_tested_at IS NOT NULL
  OR NEW.captions_provider_capability_failure_code IS NOT NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid captions capability state'); END;

CREATE TRIGGER provider_captions_capability_valid_update
BEFORE UPDATE OF
  captions_provider_capability_status,
  captions_provider_response_adapter_id,
  captions_provider_probe_protocol_version,
  captions_provider_capability_tested_at,
  captions_provider_capability_failure_code,
  captions_provider_capability_probe_sha256 ON provider_configs
WHEN (NEW.captions_provider_capability_status='supported' AND (
  NEW.captions_provider_response_adapter_id IS NULL
  OR NEW.captions_provider_response_adapter_id NOT IN (
    'openai_chat_completions_json_schema_v1',
    'openai_chat_completions_captionscript_v1')
  OR NEW.captions_provider_probe_protocol_version IS NOT '1'
  OR NEW.captions_provider_capability_tested_at IS NULL
  OR NEW.captions_provider_capability_failure_code IS NOT NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NULL
)) OR (NEW.captions_provider_capability_status='unsupported' AND (
  NEW.captions_provider_response_adapter_id IS NOT NULL
  OR NEW.captions_provider_probe_protocol_version IS NOT NULL
  OR NEW.captions_provider_capability_tested_at IS NULL
  OR NEW.captions_provider_capability_failure_code IS NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NULL
)) OR (NEW.captions_provider_capability_status='untested' AND (
  NEW.captions_provider_response_adapter_id IS NOT NULL
  OR NEW.captions_provider_probe_protocol_version IS NOT NULL
  OR NEW.captions_provider_capability_tested_at IS NOT NULL
  OR NEW.captions_provider_capability_failure_code IS NOT NULL
  OR NEW.captions_provider_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid captions capability state'); END;

UPDATE provider_configs SET captions_provider_capability_status='untested',
  captions_provider_response_adapter_id=NULL,
  captions_provider_probe_protocol_version=NULL,
  captions_provider_capability_tested_at=NULL,
  captions_provider_capability_failure_code=NULL,
  captions_provider_capability_probe_sha256=NULL
WHERE captions_provider_capability_status IN ('supported','unsupported');
"""
