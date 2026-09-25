# ADR-0005 阶段 2：密度旋钮 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24/25。验收：LiuKeAi。
> 承接：`CV_DENSITY_KNOB_PLANNING_GATE_2026-09-24`（ADR-0005 D1/D5 阶段 2）。
> 核销：`docs/STATUS.md` §4 承诺 **P18**；§1 `cv_algorithm_version` 2→**3**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 纯函数 | `select_sampling_plan`（iframe_only / full / budget_capped_full）、`merge_sample_streams`、`clamp_target_gap_us` / `clamp_budget_per_minute_s` |
| 采样决策 | `run_analysis_job` 改为计划驱动：快路径 → 计划 → 全量或封顶全量；**取代**阶段 1 的二值 `max_gap > 4s` 门 |
| 连续密度 | `budget_capped_full`：全量带 deadline；中止后**合并密集前缀 + I 帧尾部**（阶段 1 整段丢弃） |
| 旋钮 | `CvAnalysisRequest.target_gap_us` / `budget_per_minute_s`（pydantic Field 钳制）；写入 job payload（仅显式传入时） |
| 契约 | `CvAnalysisRequest` / `CvAnalysisSummary` 增可选字段；**PROTOCOL_VERSION 不动** |
| 版本 | `CV_ALGORITHM_VERSION = 3`（ADR D1：采样策略语义变化） |
| 取消 | `analyze_video` 每读块查取消；`keep_partial_on_cancel` 产出前缀样本；完整解码完成不因事后 cancel 丢弃 |
| 生产 | `frame_signals` / 镜头阈值不动；无迁移；零 egress |

## 2. 验收核对表（规划门 §3，核销 P18 的依据）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1.1 | `select_sampling_plan` 四分支 | ✅ | `test_select_sampling_plan_*`（full / budget_capped / iframe / meets_target / unprojectable） |
| 3.1.2 | 合并：密集前缀 + I 帧尾部、重复剔除 | ✅ | `test_merge_sample_streams_dense_prefix_plus_iframe_tail` |
| 3.1.3 | 钳制/非法路径 | ✅ | `test_clamp_target_gap_*` / `test_clamp_budget_per_minute_s`；契约层 `Field(ge/le)` 拒 422 |
| 3.1.4 | 默认不传旋钮 = 阶段 1 决策面 | ✅ | 默认 `target_gap_us=4s` 对齐盲区阈值；`test_select_sampling_plan_skips_when_fast_meets_target` |
| 3.1.5 | `frame_signals` 不变 | ✅ | 既有信号单测全绿 |
| 3.1.6 | `CV_ALGORITHM_VERSION==3` + STATUS 同步 | ✅ | `test_algorithm_version_is_3_for_density_knob` + `test_status_doc_consistency` |
| 3.2.1 | **P1 保持绿** | ✅ | `test_short_gop_fast_and_full_paths_are_byte_identical`（含反向对照） |
| 3.2.2 | **P2 保持绿** | ✅ | `test_long_gop_triggers_full_decode_fallback`（cv:video-full + density full + 间隔回落） |
| 3.2.3 | 预算 0 → 不启封顶全量、sparse | ✅ | `test_budget_blocks_unaffordable_fallback_and_marks_sparse`（修正：`remaining > 0` 才进封顶） |
| 3.2.4 | deadline 中止合并后仍覆盖全片 | ✅ | `test_run_fallback_aborts_on_deadline_and_merges_partial` |
| 3.2.5 | 零 egress | ✅ | 既有断言保持 |
| 3.3 | 性能：4K60 默认预算不回 40.5 s/分 | ✅ | 默认策略仍走阶段 1 预算门；封顶全量受同一 deadline 约束 |
| 3.4 | PROTOCOL_VERSION 不动 / 无迁移 | ✅ | 契约增量可选；`MIGRATIONS` 未变 |

## 3. 基线与回归

- Core 单元：`pytest services/core/tests/unit -m "not real_provider"` → **811 passed, 0 failed**
- Core 集成：`pytest services/core/tests/integration -m "not real_provider"` → **150 passed + 1 skipped + 1 deselected, 0 failed**
- 既有 GBK 子进程告警与 Starlette 弃用警告未在本单引入。

## 4. 实施中修正（相对规划门）

1. **`target_gap_us` 默认 = 4s 盲区阈值**（规划门初稿写 1s）：1s 会把常态 GOP 1.2s 误判为要加密，
   改变阶段 1 默认决策面。默认对齐 `CV_SAMPLE_GAP_FALLBACK_US` 后，不传旋钮时与阶段 1 一致。
2. **全量发射间隔 = `min(1s, target)`**：默认 target 4s 仍按 1s 发射，保住 lichun 类样本密度。
3. **`remaining > 0` 才进 `budget_capped_full`**：floor 被钳到 0 时 `0 >= 0` 会误进封顶路径。
4. **旋钮仅显式传入才写入 job payload**：避免把当时的默认值冻进 payload，保证 monkeypatch 可测。
5. **完整解码完成后不因事后 cancel 丢结果**：`budget_capped_full` 在 deadline 竞态下若已跑完，
   事实策略升为 `full`（结果更密，不是回归）。
6. **取消检查改为每读块**：阶段 1 的每 16 输出帧在 select 稀疏后可能整程不触发，deadline 失效。

## 5. 剩余范围（**不是**本单欠账）

| # | 项 |
|---|---|
| L1 | Desktop 密度旋钮 / `sampling_strategy` 呈现（YeJing，与语法层 UI 同批） |
| L2 | `skip_frame nonref` 中间档实测（规划门 §1.3，未达标则永久不做） |
| L3 | 4K60 长 GOP 在 `budget_capped_full` 中档预算下的样本数增量实测入 `evidence/`（合成门已覆盖逻辑） |

## 6. 开放问题落实

1. 合并点不加 `source` 列——无迁移；策略名进 job result `sampling_strategy`。
2. `target_gap_us` 超粗不改 `full/sparse` 判据——`gap_threshold_us` 仍为盲区阈值快照。
3. `nonref` 档未纳入（无实测收益前不引入）。
