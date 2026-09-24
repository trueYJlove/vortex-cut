from __future__ import annotations

# ADR-0005 阶段 1（CV 采样预算与诚实降级）：cv_analyses 增采样密度字段。
#
# 动机：4K60 长 GOP 素材触发全量回退后完整作业达 40.5 s/分钟源（门 ≤10），
# 且**用户与召回层都无从知晓**——存储层没有任何"这次分析达到了什么密度"的记录。
# 本迁移补上该记录，使"诚实降级"可查询、可消费。
#
# 字段语义（规划门 §2.5）：
#   - density_status：判据是**回退阈值**而非目标间隔。full = 没有留下"本该填
#     而没填"的盲区；sparse = 明知有盲区但未填（预算不足或回退被中止）。
#   - gap_threshold_us：分析时生效的阈值**快照**。存快照而非读当前常量，
#     因为该常量可能被调整，而历史行必须能自我解释。
#   - achieved_max_gap_us：落库样本相邻时间戳最大差（程度信息，布尔无法表达）。
#   - wall_clock_ms：作业墙钟（性能门证据来源）。
#
# 存量行回填：`density_status` 由 ADD COLUMN 的 DEFAULT 'full' 自动填充，
# **该默认值是准确的**——存量行全部产生于"无条件回退"的旧行为：凡
# max_gap > 4s 者必已回退至 ≤4s，故所有存量行都满足 achieved ≤ threshold。
# 该断言由迁移测试覆盖（test_migrations_v23）。
# `gap_threshold_us` 为可空列无自动默认，显式回填为当时的常量值 4_000_000
# （迁移是冻结快照，此处刻意硬编码而不引用 Python 常量）。
V23_VERSION = "v23"

V23_SQL = """
ALTER TABLE cv_analyses ADD COLUMN density_status TEXT NOT NULL DEFAULT 'full'
  CHECK(density_status IN ('full','sparse'));
ALTER TABLE cv_analyses ADD COLUMN gap_threshold_us INTEGER NULL
  CHECK(gap_threshold_us IS NULL OR gap_threshold_us > 0);
ALTER TABLE cv_analyses ADD COLUMN achieved_max_gap_us INTEGER NULL
  CHECK(achieved_max_gap_us IS NULL OR achieved_max_gap_us >= 0);
ALTER TABLE cv_analyses ADD COLUMN wall_clock_ms INTEGER NULL
  CHECK(wall_clock_ms IS NULL OR wall_clock_ms >= 0);
UPDATE cv_analyses SET gap_threshold_us=4000000 WHERE gap_threshold_us IS NULL;
"""
