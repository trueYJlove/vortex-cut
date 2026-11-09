"""v43 迁移：让「配置行可删」与「审计行不可改写」共存（2026-11-09）。

**v42 留下的漏洞**：v42 把 13 张表的 provider_config_id 改成 `ON DELETE SET NULL`，
但没注意到 5 张表上还有 `*_no_update` 不可变触发器。`SET NULL` 本身是一次 UPDATE，
于是删除在运行期撞上：

    sqlite3.IntegrityError: egress previews are immutable

真实后果（用户实测）：xkiro 删得掉（只有 provider_invocations 引用，无触发器），
xkiro2 删不掉（被 egress_previews / captions_provider_egress_previews 引用）。
删除行为变成「看有没有被带触发器的表引用」的运气问题。

**为什么不能简单删掉这些触发器**：它们的职责是「审计行不可改写」——
删掉就等于给篡改开后门，`payload_sha256`、`brief_snapshot_json` 都能被就地改掉。

**做法**：给触发器加一个**窄到不能再窄**的例外——只允许「把 provider_config_id
置为 NULL，且其余每一列与 OLD 完全一致」这一种 UPDATE。
实现上逐列写出 `NEW.x IS OLD.x` 比对（用 `IS` 而非 `=`，NULL 与 NULL 才算相等），
而非依赖 `BEFORE UPDATE OF` 列清单——列清单无法表达「只允许这一列变、
且只允许变成 NULL」，而且漏列一列就是静默放行。

**验证（真实库副本，源库只读）**：
  · 删除 xkiro2 → 成功，审计行保留、指针置空；
  · `UPDATE egress_previews SET payload_sha256=<new>` → 仍被拒；
  · 把 provider_config_id 改成**另一个非 NULL** 值 → 被拒（只允许置空，不允许改指向）。
"""
from __future__ import annotations

V43_VERSION = "v43"

V43_SQL = """
-- agent_session_egress_previews
DROP TRIGGER IF EXISTS agent_session_previews_no_update;
CREATE TRIGGER agent_session_previews_no_update BEFORE UPDATE ON agent_session_egress_previews
WHEN NOT (
  NEW.provider_config_id IS NULL
  AND   NEW.id IS OLD.id
  AND   NEW.project_id IS OLD.project_id
  AND   NEW.base_revision_id IS OLD.base_revision_id
  AND   NEW.base_document_sha256 IS OLD.base_document_sha256
  AND   NEW.provider_snapshot_json IS OLD.provider_snapshot_json
  AND   NEW.provider_config_sha256 IS OLD.provider_config_sha256
  AND   NEW.payload_sha256 IS OLD.payload_sha256
  AND   NEW.stats_json IS OLD.stats_json
  AND   NEW.expires_at IS OLD.expires_at
  AND   NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'agent session previews are immutable'); END;

-- captions_provider_egress_previews
DROP TRIGGER IF EXISTS captions_provider_previews_no_update;
CREATE TRIGGER captions_provider_previews_no_update BEFORE UPDATE ON captions_provider_egress_previews
WHEN NOT (
  NEW.provider_config_id IS NULL
  AND   NEW.id IS OLD.id
  AND   NEW.project_id IS OLD.project_id
  AND   NEW.base_revision_id IS OLD.base_revision_id
  AND   NEW.base_document_sha256 IS OLD.base_document_sha256
  AND   NEW.provider_snapshot_json IS OLD.provider_snapshot_json
  AND   NEW.provider_config_sha256 IS OLD.provider_config_sha256
  AND   NEW.payload_sha256 IS OLD.payload_sha256
  AND   NEW.stats_json IS OLD.stats_json
  AND   NEW.expires_at IS OLD.expires_at
  AND   NEW.created_at IS OLD.created_at
  AND   NEW.payload_json IS OLD.payload_json
)
BEGIN SELECT RAISE(ABORT,'captions provider previews are immutable'); END;

-- egress_previews
DROP TRIGGER IF EXISTS egress_previews_no_update;
CREATE TRIGGER egress_previews_no_update BEFORE UPDATE ON egress_previews
WHEN NOT (
  NEW.provider_config_id IS NULL
  AND   NEW.id IS OLD.id
  AND   NEW.project_id IS OLD.project_id
  AND   NEW.brief_snapshot_json IS OLD.brief_snapshot_json
  AND   NEW.brief_sha256 IS OLD.brief_sha256
  AND   NEW.recipe_snapshot_id IS OLD.recipe_snapshot_id
  AND   NEW.provider_snapshot_json IS OLD.provider_snapshot_json
  AND   NEW.provider_config_sha256 IS OLD.provider_config_sha256
  AND   NEW.transcript_refs_json IS OLD.transcript_refs_json
  AND   NEW.segment_whitelist_json IS OLD.segment_whitelist_json
  AND   NEW.payload_sha256 IS OLD.payload_sha256
  AND   NEW.payload_json IS OLD.payload_json
  AND   NEW.stats_json IS OLD.stats_json
  AND   NEW.expires_at IS OLD.expires_at
  AND   NEW.created_at IS OLD.created_at
  AND   NEW.candidate_response_adapter_id IS OLD.candidate_response_adapter_id
  AND   NEW.candidate_probe_protocol_version IS OLD.candidate_probe_protocol_version
  AND   NEW.candidate_capability_probe_sha256 IS OLD.candidate_capability_probe_sha256
)
BEGIN SELECT RAISE(ABORT,'egress previews are immutable'); END;

-- timeline_patch_egress_previews
DROP TRIGGER IF EXISTS timeline_patch_previews_no_update;
CREATE TRIGGER timeline_patch_previews_no_update BEFORE UPDATE ON timeline_patch_egress_previews
WHEN NOT (
  NEW.provider_config_id IS NULL
  AND   NEW.id IS OLD.id
  AND   NEW.project_id IS OLD.project_id
  AND   NEW.base_revision_id IS OLD.base_revision_id
  AND   NEW.base_document_sha256 IS OLD.base_document_sha256
  AND   NEW.provider_snapshot_json IS OLD.provider_snapshot_json
  AND   NEW.provider_config_sha256 IS OLD.provider_config_sha256
  AND   NEW.payload_sha256 IS OLD.payload_sha256
  AND   NEW.stats_json IS OLD.stats_json
  AND   NEW.expires_at IS OLD.expires_at
  AND   NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'timeline patch previews are immutable'); END;

-- timeline_patch_proposals
DROP TRIGGER IF EXISTS timeline_patch_proposals_no_update;
CREATE TRIGGER timeline_patch_proposals_no_update BEFORE UPDATE ON timeline_patch_proposals
WHEN NOT (
  NEW.provider_config_id IS NULL
  AND   NEW.id IS OLD.id
  AND   NEW.generation_id IS OLD.generation_id
  AND   NEW.project_id IS OLD.project_id
  AND   NEW.base_revision_id IS OLD.base_revision_id
  AND   NEW.base_document_sha256 IS OLD.base_document_sha256
  AND   NEW.patch_json IS OLD.patch_json
  AND   NEW.patch_sha256 IS OLD.patch_sha256
  AND   NEW.proposed_document_sha256 IS OLD.proposed_document_sha256
  AND   NEW.diff_json IS OLD.diff_json
  AND   NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'timeline patch proposals are immutable'); END;

"""