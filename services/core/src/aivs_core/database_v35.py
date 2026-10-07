from __future__ import annotations

# captions Provider 真实 runner 接线（ADAPTER_DESIGN_GATE 2026-10-05 后续切片）：
# Slice 2/3 只实现了 prepare/create 与能力探测，create 之后 generation 停在
# queued 且无任何执行者——既没有 provider_invocations 审计行，也没有可被
# JobService 拾取的 jobs 行。本迁移补齐两处外键与索引，使 captions 生成能像
# timeline_patch_generation 一样走既有 job 分派（含资源调度、取消、恢复）。
# 纯新增列（NULL 默认），不改写历史行。
V35_VERSION = "v35"

V35_SQL = """
ALTER TABLE jobs ADD COLUMN captions_provider_generation_id TEXT NULL
  REFERENCES captions_provider_generations(id);
ALTER TABLE provider_invocations ADD COLUMN captions_provider_generation_id TEXT NULL
  REFERENCES captions_provider_generations(id);
CREATE INDEX IF NOT EXISTS idx_jobs_captions_provider_generation
  ON jobs(captions_provider_generation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invocations_captions_provider_generation
  ON provider_invocations(captions_provider_generation_id,created_at DESC);
"""
