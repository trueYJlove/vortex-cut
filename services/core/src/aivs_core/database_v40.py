"""W3.3 Layer 2 关键帧理解 —— v40 迁移（Design Gate 2026-10-21 §2，已批准）。

两张表 + 一处增列，语义在门里已冻结：

1. `keyframe_egress_previews` —— 帧级**外传预览载荷载体**。
   **刻意不用 ON DELETE CASCADE**：既有外传审计表（egress_previews /
   egress_consents）一律「不可变 + 无 CASCADE」（database.py:332-333），
   外传审计记录不得随素材删除而消失。
   但 P102 的「分析行阻塞素材删除」陷阱必须避开 ⇒ 素材删除路径显式调用
   `detach_asset()` 把 asset_id 置 NULL 并记 detached_at，既不丢审计、
   也不阻塞删除。这也是本表 asset_id 允许 NULL 的原因。

2. `asset_frame_tags` —— 逐帧打标结果。
   属**派生分析数据**（与 asset_semantic_index 同类），用 ON DELETE CASCADE：
   素材没了，它的打标结论也就没有意义了（P102 的正确处置形态）。
   source_fingerprint 与 asset_semantic_index 同源，禁止第三套指纹口径。

3. `provider_invocations.keyframe_generation_id` —— 增列。
   验收项 A10 要求「provider_invocations 行数 = 调用次数」可断言，
   而该表原先只有 candidate_generation_id（database.py:307-317），
   不加列则该验收**无法机器判定**。

--

为什么 expires_at 建索引：purge_expired 按 expires_at 扫描，
既有 egress_previews 已有 idx_previews_expiry（database.py:325），本表照抄。

为什么 payload_sha256 是 NOT NULL：v28 的 egress_previews 即 NOT NULL
（database.py_v28.py:13），且 create 阶段要与调用方传入的哈希比对，
可空会让「NULL 与 NULL 相等」成为未定义的放行路径。
"""
from __future__ import annotations

V40_VERSION = "v40"

V40_SQL = """
CREATE TABLE IF NOT EXISTS keyframe_egress_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT REFERENCES assets(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  source_fingerprint TEXT NOT NULL,
  model_id TEXT,
  model_revision TEXT,
  payload_sha256 TEXT NOT NULL,
  frames_json TEXT NOT NULL DEFAULT '[]',
  excluded_frames_json TEXT NOT NULL DEFAULT '[]',
  sampling_mode TEXT NOT NULL CHECK(sampling_mode IN ('scene_cut','interval_only')),
  covered_scene_cuts INTEGER NOT NULL DEFAULT 0,
  total_frame_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  payloads_purged_at TEXT,
  detached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyframe_previews_asset
  ON keyframe_egress_previews(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyframe_previews_expiry
  ON keyframe_egress_previews(expires_at);

CREATE TABLE IF NOT EXISTS asset_frame_tags (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version >= 1),
  vocabulary_id TEXT NOT NULL,
  vocabulary_version INTEGER NOT NULL CHECK(vocabulary_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable','failed')),
  reason TEXT,
  frame_index INTEGER NOT NULL,
  timestamp_us INTEGER NOT NULL CHECK(timestamp_us >= 0),
  labels_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  provider_config_id TEXT REFERENCES provider_configs(id),
  generation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_frame_tags_asset
  ON asset_frame_tags(asset_id, algorithm_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_frame_tags_ready
  ON asset_frame_tags(asset_id, source_fingerprint, algorithm_version,
                      vocabulary_version, frame_index)
  WHERE status = 'ready';

--
-- 同意书与生成记录：Design Gate §3.2 的三段式（prepare→create→claim）必须有
-- 独立的 consent 与 generation 载体，否则 I-1「未消费 consent 不得发网络」
-- 没有可断言的实体。
--
-- ⚠️ 这两张表在设计门 §2 的 DDL 里**被漏掉了**（门只写了 previews 与 frame_tags），
-- 而 §3.2 的服务签名已经用到 create(consent+generation) 与 claim_for_runner。
-- 实现时补齐，并回写实施记录——不做「代码引用不存在的表」这种静默不一致。
--
-- consent 语义照抄既有 egress_consents：只允许「首次消费」这一次 UPDATE，
-- 其余字段不可变（见下方触发器）。这样「消费」是单向且可审计的。
CREATE TABLE IF NOT EXISTS keyframe_egress_consents (
  id TEXT PRIMARY KEY,
  egress_preview_id TEXT NOT NULL REFERENCES keyframe_egress_previews(id),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS keyframe_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  egress_preview_id TEXT NOT NULL REFERENCES keyframe_egress_previews(id),
  egress_consent_id TEXT NOT NULL REFERENCES keyframe_egress_consents(id),
  provider_config_id TEXT NOT NULL REFERENCES provider_configs(id),
  source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_keyframe_generations_project
  ON keyframe_generations(project_id, created_at DESC);

-- 与既有 egress_consents 同款：只允许首次消费，其余一切 UPDATE 拒绝。
CREATE TRIGGER IF NOT EXISTS keyframe_egress_consents_no_delete
  BEFORE DELETE ON keyframe_egress_consents
  BEGIN SELECT RAISE(ABORT,'keyframe egress consents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS keyframe_egress_consents_only_consume
  BEFORE UPDATE ON keyframe_egress_consents
  WHEN NOT (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND NEW.id=OLD.id AND NEW.egress_preview_id=OLD.egress_preview_id
    AND NEW.payload_sha256=OLD.payload_sha256 AND NEW.created_at=OLD.created_at)
  BEGIN SELECT RAISE(ABORT,'keyframe egress consents are immutable except first consumption'); END;
ALTER TABLE provider_invocations ADD COLUMN keyframe_generation_id TEXT;
"""