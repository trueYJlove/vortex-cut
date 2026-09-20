from __future__ import annotations

# 能力探测协议 v2（2026-09-20 裁决，AI 真实世界验证发现 3）：
# candidate 探测时长校验从"精确等于目标"放宽为结构校验（变体顺序/引用
# 闭合/非空），时长质量由真实候选采纳链的 0.8-1.2× 硬门兜底。真实验证
# 依据：gpt-5.6-luna 与 deepseek-v4.1-flash 结构正确性 100% 合格而精确
# 时长算术不过——强门槛把结构合法的中档模型全部误判 unsupported。
# timeline_patch 探测协议同步升至 v2（保持两探测语义对称；patch 侧校验
# 本身未放宽，仅版本号随协议族演进）。触发器换血：DROP + 重建（对齐
# V7 的触发器换血先例）。
V22_VERSION = "v22"

V22_SQL = """
DROP TRIGGER IF EXISTS provider_candidate_capability_valid_insert;
DROP TRIGGER IF EXISTS provider_candidate_capability_valid_update;
CREATE TRIGGER provider_candidate_capability_valid_insert
BEFORE INSERT ON provider_configs
WHEN (NEW.candidate_capability_status='supported' AND (
  NEW.candidate_response_adapter_id IS NULL OR NEW.candidate_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1','openai_responses_candidatescript_v1',
    'openai_chat_completions_json_schema_v1','openai_chat_completions_candidatescript_v1')
  OR NEW.candidate_probe_protocol_version IS NOT '2' OR NEW.candidate_capability_tested_at IS NULL
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
  OR NEW.candidate_probe_protocol_version IS NOT '2' OR NEW.candidate_capability_tested_at IS NULL
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
  OR NEW.timeline_patch_probe_protocol_version IS NOT '2'
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='unsupported' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NULL OR NEW.timeline_patch_capability_failure_code IS NULL
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
  timeline_patch_capability_probe_sha256 ON provider_configs
WHEN (NEW.timeline_patch_capability_status='supported' AND (
  NEW.timeline_patch_response_adapter_id IS NULL
  OR NEW.timeline_patch_response_adapter_id NOT IN (
    'openai_responses_json_schema_v1',
    'openai_responses_patchscript_v1',
    'openai_chat_completions_json_schema_v1',
    'openai_chat_completions_patchscript_v1'
  )
  OR NEW.timeline_patch_probe_protocol_version IS NOT '2'
  OR NEW.timeline_patch_capability_tested_at IS NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='unsupported' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NULL OR NEW.timeline_patch_capability_failure_code IS NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NULL
)) OR (NEW.timeline_patch_capability_status='untested' AND (
  NEW.timeline_patch_response_adapter_id IS NOT NULL
  OR NEW.timeline_patch_probe_protocol_version IS NOT NULL
  OR NEW.timeline_patch_capability_tested_at IS NOT NULL
  OR NEW.timeline_patch_capability_failure_code IS NOT NULL
  OR NEW.timeline_patch_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid timeline patch capability state'); END;

UPDATE provider_configs SET candidate_capability_status='untested',
  candidate_response_adapter_id=NULL,candidate_probe_protocol_version=NULL,
  candidate_capability_tested_at=NULL,candidate_capability_failure_code=NULL,
  candidate_capability_probe_sha256=NULL
WHERE candidate_capability_status IN ('supported','unsupported');
UPDATE provider_configs SET timeline_patch_capability_status='untested',
  timeline_patch_response_adapter_id=NULL,timeline_patch_probe_protocol_version=NULL,
  timeline_patch_capability_tested_at=NULL,timeline_patch_capability_failure_code=NULL,
  timeline_patch_capability_probe_sha256=NULL
WHERE timeline_patch_capability_status IN ('supported','unsupported');
"""
