# 历史档案索引（`docs/archive/`）

> **只读历史参考**：本目录仅保留仍被现行代码注释、自动化测试、ADR 裁决或未闭环条目引用的少数历史契约与排查流水；**其余一次性里程碑验收与阶段总结已清理，可从 Git 历史追溯**。当前阶段、能力边界与未闭环工作统一见 [`../STATUS.md`](../STATUS.md)。

## 1. 被代码、测试或 ADR 引用的历史契约与决策

| 文档 | 说明 |
|---|---|
| [STAGE1B_CONTRACT_FREEZE.md](STAGE1B_CONTRACT_FREEZE.md) | Stage 1B 契约冻结（被 `services/core/src/aivs_core/model_registry.py` 引用错误码集合） |
| [STAGE_M3_0_IR_CONTRACT_DRAFT.md](STAGE_M3_0_IR_CONTRACT_DRAFT.md) | M3-0 权威合成 IR 契约草案（被 `services/core/src/aivs_core/rendering/ir.py` 与 M3-0 验收报告引用） |
| [W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md](W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md) | W2.2 降级交付设计门（被 `ADR-0009` 与 `STATUS.md` §4 `P132` 引用） |
| [PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md](PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md) | 性能工程实施方案（被 `probe_cache.py` 引用 A07 探测缓存约束） |
| [PERFORMANCE_G3_CLOSEOUT_2026-09-10.md](PERFORMANCE_G3_CLOSEOUT_2026-09-10.md) | 性能 G3 收口记录（被 `ffmpeg.py` 引用 C23 分块倒放未实施注释） |
| [PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md](PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md) | C20 v2 合成预览默认开启决策（被 `SyntheticPreview.tsx` 注释引用） |
| [PREVIEW_SMOOTHNESS_IMPLEMENTATION_2026-09-29.md](PREVIEW_SMOOTHNESS_IMPLEMENTATION_2026-09-29.md) | 预览流畅度收敛实施与 L8 登记（被 `p33-seek-play.electron.spec.ts` 引用） |
| [WAVE1_MANUAL_CHECKLIST_2026-10-10.md](WAVE1_MANUAL_CHECKLIST_2026-10-10.md) | Wave 1 剪辑手法桌面手测清单（被 `wave1-editing-tools.electron.spec.ts` 与 `STATUS.md` §5 引用） |
| [W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md](W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md) | W3.3 关键帧理解切片实施摘要（纳入 `test_keyframe_wording.py` 正则检查） |

## 2. 未闭环排查流水与冻结前置门（关联 `STATUS.md` §4）

| 文档 | 说明 |
|---|---|
| [OPEN_ISSUES_DETAILED_LOG_2026-11.md](OPEN_ISSUES_DETAILED_LOG_2026-11.md) | 从 `STATUS.md` §4 抽离的开放工作包与缺陷排查流水（`P149`/`P161`/`P165`/`P194`–`P235`） |
| [PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md](PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md) | B13 解码驻留上限规划门（承载 `STATUS.md` §4 `P197` 挂起追踪口径） |
| [PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md](PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md) | B13 驻留上限与 C20-T 独立验收记录（承载 `STATUS.md` §4 `P197` 基线） |
