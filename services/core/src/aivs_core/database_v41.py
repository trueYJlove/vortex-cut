"""W3.3 Layer 2 关键帧理解 —— v41 迁移（Design Gate 2026-10-21 §7 S3 行，已批准）。

**六列 vision 能力探测**，照 v30（状态 + 测试时间）+ v34（适配器 / 协议版本 /
失败码 / 探测哈希）的 captions 六列范式逐列对齐：

| 本迁移（vision）                    | captions 对应列                              |
|-------------------------------------|----------------------------------------------|
| vision_capability_status            | captions_provider_capability_status          |
| vision_capability_tested_at         | captions_provider_capability_tested_at       |
| vision_response_adapter_id          | captions_provider_response_adapter_id         |
| vision_probe_protocol_version       | captions_provider_probe_protocol_version      |
| vision_capability_failure_code      | captions_provider_capability_failure_code     |
| vision_capability_probe_sha256      | captions_provider_capability_probe_sha256     |

列名**逐字取自规划门 §2.1 第 3 条**（不是本迁移自创）：那一行已经把六列写死。
注意命名里的两处不对称（status/tested_at/failure_code/probe_sha256 带
`capability` 中缀，adapter_id/protocol_version 不带）是**门里的原文**，
此处照抄不改——擅自"统一命名"会让文档与代码对不上，而文档才是冻结源。

为什么六列都要触发器等长：
  * `supported` 若允许缺 adapter 或协议版本 ⇒ 放行门禁拿不到可选档位，
    「探测通过」变成不可判定；
  * `unsupported` 若允许缺 failure_code ⇒ 重演 2026-10-03 的 captions 误诊
    （"网络不可达"与"网关拒绝该能力"在库里无法区分）；
  * `supported` 若允许同时带 failure_code ⇒ 同一行自相矛盾，放行方无法判定。

与 v34 的一处**有意不同**：v34 末尾把历史行重置为 untested（因为改造前的
探测语义不可信）。本表是**新增列**，全部历史行天然为默认 `untested`，
无需 UPDATE，也就不写那条重置语句。
"""
from __future__ import annotations

V41_VERSION = "v41"

V41_SQL = """
ALTER TABLE provider_configs ADD COLUMN vision_capability_status TEXT NOT NULL
  DEFAULT 'untested' CHECK(vision_capability_status IN ('untested','supported','unsupported'));
ALTER TABLE provider_configs ADD COLUMN vision_capability_tested_at TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN vision_response_adapter_id TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN vision_probe_protocol_version TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN vision_capability_failure_code TEXT NULL;
ALTER TABLE provider_configs ADD COLUMN vision_capability_probe_sha256 TEXT NULL;

CREATE TRIGGER provider_vision_capability_valid_insert
BEFORE INSERT ON provider_configs
WHEN (NEW.vision_capability_status='supported' AND (
  NEW.vision_response_adapter_id IS NULL
  OR NEW.vision_response_adapter_id NOT IN ('openai_chat_completions_image_url_v1')
  OR NEW.vision_probe_protocol_version IS NOT '1'
  OR NEW.vision_capability_tested_at IS NULL
  OR NEW.vision_capability_failure_code IS NOT NULL
  OR NEW.vision_capability_probe_sha256 IS NULL
)) OR (NEW.vision_capability_status='unsupported' AND (
  NEW.vision_response_adapter_id IS NOT NULL
  OR NEW.vision_probe_protocol_version IS NOT NULL
  OR NEW.vision_capability_tested_at IS NULL
  OR NEW.vision_capability_failure_code IS NULL
  OR NEW.vision_capability_probe_sha256 IS NULL
)) OR (NEW.vision_capability_status='untested' AND (
  NEW.vision_response_adapter_id IS NOT NULL
  OR NEW.vision_probe_protocol_version IS NOT NULL
  OR NEW.vision_capability_tested_at IS NOT NULL
  OR NEW.vision_capability_failure_code IS NOT NULL
  OR NEW.vision_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid vision capability state'); END;

CREATE TRIGGER provider_vision_capability_valid_update
BEFORE UPDATE OF
  vision_capability_status,
  vision_capability_tested_at,
  vision_response_adapter_id,
  vision_probe_protocol_version,
  vision_capability_failure_code,
  vision_capability_probe_sha256 ON provider_configs
WHEN (NEW.vision_capability_status='supported' AND (
  NEW.vision_response_adapter_id IS NULL
  OR NEW.vision_response_adapter_id NOT IN ('openai_chat_completions_image_url_v1')
  OR NEW.vision_probe_protocol_version IS NOT '1'
  OR NEW.vision_capability_tested_at IS NULL
  OR NEW.vision_capability_failure_code IS NOT NULL
  OR NEW.vision_capability_probe_sha256 IS NULL
)) OR (NEW.vision_capability_status='unsupported' AND (
  NEW.vision_response_adapter_id IS NOT NULL
  OR NEW.vision_probe_protocol_version IS NOT NULL
  OR NEW.vision_capability_tested_at IS NULL
  OR NEW.vision_capability_failure_code IS NULL
  OR NEW.vision_capability_probe_sha256 IS NULL
)) OR (NEW.vision_capability_status='untested' AND (
  NEW.vision_response_adapter_id IS NOT NULL
  OR NEW.vision_probe_protocol_version IS NOT NULL
  OR NEW.vision_capability_tested_at IS NOT NULL
  OR NEW.vision_capability_failure_code IS NOT NULL
  OR NEW.vision_capability_probe_sha256 IS NOT NULL
)) BEGIN SELECT RAISE(ABORT,'invalid vision capability state'); END;
"""
