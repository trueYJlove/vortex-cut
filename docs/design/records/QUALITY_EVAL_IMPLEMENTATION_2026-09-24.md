# W0.4 质量评测体系骨架 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`QUALITY_EVAL_PLANNING_GATE_2026-09-24`（含 §5 开放问题裁决）。
> 核销：`docs/STATUS.md` §4 承诺 **P9 / P10 / P11**（核销条件是本记录 §2 验收核对表）。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 评测集 | `eval_set/`：`manifest.json`（五档 + `min_samples`）、`schema/annotation.schema.json`（八项指标字段齐备 + `schema_version`/`secondary`/`av_defects` 预留）、`README.md` |
| 标注 | `annotations/<asset_id>.json`；自检真值 `syn-cut-basic` / `syn-ndcg-basic` |
| 预测 | `predictions/<asset_id>/{scene_cut,recall}.json`（与被测系统解耦的工件格式） |
| 指标 | `tools/quality_eval/metrics.py`：切点 P/R（一对一贪心、容差窗）、nDCG@k（线性折扣）、轻量标注校验 |
| harness | `tools/quality_eval/run_quality_eval.py`：`--selfcheck` + 基线；输出 `evidence/quality_eval/<UTC>-{selfcheck,baseline}.json` |
| 回归 | `tools/quality_eval/compare_baselines.py`：回退超 `regression_tolerance` → 非零退出 |
| 测试 | `services/core/tests/unit/test_quality_eval.py`（15 项） |
| 隐私 | 无网络客户端；媒体不入仓强制；**零 egress** |
| 生产代码 | **未改动** `planning.py` / `cv_signals.py` / 契约 / 迁移 |

## 2. 验收核对表（规划门 §3，核销 P9 的依据）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1.1 | 五档槽位在 manifest 强制存在 | ✅ | `eval_set/manifest.json` `buckets` 五键 + `min_samples` |
| 3.1.2 | 标注 schema 覆盖 §11.2 八项 | ✅ | `annotation.schema.json`：`scene_cuts_us` / `recall` / `beat_grid_us` / `lj_offsets` / `multicam_switch_us` / `narrative_coherence` / `structure_usable` / `av_defects`（后者仅预留） |
| 3.1.3 | schema 正/负用例 + 旧标注可加载 | ✅ | `TestValidate` + `validate_annotation` 轻量校验（无 jsonschema 依赖，裁决 1 的工具面） |
| 3.2.1 | 已知切点 P=R=1；超窗下降 | ✅ | `test_perfect_match` / `test_miss_outside_tolerance` / `test_hit_inside_tolerance` / `test_one_to_one_not_double_count` |
| 3.2.2 | nDCG 与手算一致 | ✅ | `test_reversed_hand_calc`（含 `test_perfect_ranking`） |
| 3.2.3 | 同输入两次逐字节一致 | ✅ | `run_selfcheck` 纯函数；确定性由指标实现保证 + `TestSelfcheck` |
| 3.2.4 | 空标注/未标注 → `unavailable`+reason，无假 0 | ✅ | `test_repo_eval_set_runs` 观察 bucket 指标；双空口径写入 `metrics.py` 注释并测（`test_empty_both`） |
| 3.3.1 | 样本不足 → `insufficient`+reason，无数值冒充通过 | ✅ | `test_insufficient_not_fake_score`（状态 `insufficient` 且 `value` 仅作诊断） |
| 3.3.2 | 首快照如实暴露分档缺口 | ✅ | `evidence/quality_eval/20260924T090400Z-baseline.json` `gaps`：spoken_single 0/5、spoken_multi 0/3、music 0/3、life_no_voice 2/5、long_gop 0/2 |
| 3.3.3 | 快照含 git_commit / algorithm_version / density_status | ✅ | 同快照顶层字段 + 逐素材 `density_status` |
| 3.4.1 | 无网络依赖；断网可跑 | ✅ | harness 仅 stdlib；自检/基线本地跑通 |
| 3.4.2 | 不改生产权重与算法 | ✅ | 本单 diff 零触碰 `planning.py` / `cv_signals.py` |
| 3.4.3 | 无 egress 增量 / 无 PROTOCOL_VERSION / 无迁移 | ✅ | 同上 |
| 3.5.1 | compare：改进 0 退出；回退非零 | ✅ | `TestCompare` + 自比对 `ok: true` |
| 3.5.2 | 文档列出强制跑评测的四类改动 | ✅ | 规划门 §2.5 + `eval_set/README.md` |

**P10**（`insufficient` 诚实语义 + 缺口表）：3.3.1–3.3.2 ✅。
**P11**（口径冻结）：参数 `cut_tolerance_us=200000` / `ndcg_k=10` / `regression_tolerance=0.0` 写入快照 `params`；规划门 §2.3 写明禁止静默改口径 ✅。

## 3. 基线与回归

- 自检：`evidence/quality_eval/20260924T090400Z-selfcheck.json`（`ok: true`，6 项检查）。
- 首基线：`evidence/quality_eval/20260924T090400Z-baseline.json`。
- Core 全量：`pytest services/core/tests -m "not real_provider"` → **930 passed + 1 skipped + 1 deselected, 0 failed**（含本单 15 项）。
- 既有跳过/弃选与 GBK 子进程告警未在本单引入（见既有测试面），未处理。

## 4. 剩余范围（**不是**本单欠账）

1. **补素材与人工标注**——缺口表即清单；在 spoken_single / music 等达标前，**禁止**用质量分通过 Wave 1 调参验收（裁决 2）。
2. Wave 1/2 能力落地后，将对应指标从 `unavailable` 切到可测（卡点 / L/J / 多机位）。
3. 叙事连贯 / 结构可用率的人工评分工作流（schema 已就绪）。
4. 双声/静音缺陷率独立小单（裁决 5）。
5. CI 强制挂钩（裁决 3：骨架阶段明确不做）。

## 5. 开放问题裁决落实

规划门 §5 五项已按授权冻结（存放策略 (b)、质量分验收门、不上 CI、单人标注、双声出骨架）。实施与裁决一致，无偏离。
