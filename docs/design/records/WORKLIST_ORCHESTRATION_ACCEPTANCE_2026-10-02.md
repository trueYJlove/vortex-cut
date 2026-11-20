# W4.1 Implementation Slice 1——专项验收记录

> 验收日期：2026-10-02。本文记录自动化验收证据；项目当前状态仍以 [`../../STATUS.md`](../../STATUS.md) 为准。
> 范围：v27 Core Worklist + 本地 `editing_grammar` step + Desktop typed IPC/最小面板。

## 1. Cross-check

| Design Gate 条目 | 结果 | 证据 |
|---|---|---|
| v27 三张表、字段和 CHECK 约束 | ✅ | `services/core/tests/unit/test_worklist.py`；`test_migrations_v12.py`、`test_migrations_v3.py` |
| `prepare/create/get/list/apply/cancel` 最小闭环 | ✅ | `worklist.py`、Core app worklist routes；`test_worklist_service.py` |
| 同项目 active worklist 防重复 | ✅ | `test_worklist_active_is_project_scoped_and_duplicate_apply_rejected` |
| 多步骤按 ordinal 推进 | ✅ | `test_worklist_advances_each_step_and_finishes`：第一步 apply 后进入第二步 waiting，全部 apply 后 succeeded |
| 基线校验 | ✅ | `prepare/create` 检查项目当前 Revision；editing proposal apply 继续执行既有 hash/基线校验 |
| 重复 apply 拒绝 | ✅（既有服务链） | `EditingGrammarService.apply` 的 `EDITING_GRAMMAR_PROPOSAL_APPLIED`；Worklist 只保存 applied revision |
| cancel 终态和迟到 apply 拒绝 | ✅（Core 状态机） | `cancel` 将 active step 置 cancelled；apply 要求 Worklist/step 为 waiting_for_apply |
| editing grammar 零 egress | ✅（既有规划器测试） | `services/core/tests/unit/test_editing_grammar.py` 的网络调用守卫 |
| Contracts runtime parsing | ✅ | `parseWorklist`；`pnpm typecheck` |
| Main IPC 白名单和脱敏解析 | ✅ | `tests/stage2b-ipc.test.ts` |
| Preload bridge | ✅ | `tests/preload.test.ts`；`pnpm typecheck` |
| Desktop 最小面板 | ✅ | `apps/desktop/src/app/worklist/WorklistPanel.tsx`；`tests/worklist-panel.test.tsx` |
| Desktop 项目切换隔离 | ✅ 自动化通过 | `tests/worklist-panel.test.tsx`：A 请求迟到、组件切换到 B 后不污染 B；面板使用 `key={project.project_id}` 且请求按 projectId |
| Core 重启恢复 | ✅ | `test_worklist_state_survives_database_reopen_without_reproposing`；真实打包 Electron 两次启动均显示 Core 已连接，第二次通过历史工作单选择器打开同一 worklist，UI 恢复显示 `waiting_for_apply` |
| roughcut/style 明确拒绝 | ✅ | Core `WORKLIST_STEP_UNAVAILABLE`；当前切片未产生 job 副作用 |
| captions 本地 transcript 装配 | ✅ 自动化通过 | `WORKLIST_CAPTIONS_DESIGN_GATE_2026-10-02.md`；Core captions planner；Desktop `WorklistPanel` 可选 captions 参数；Provider 文本生成仍明确不在本切片 |
| 真实 GUI/Electron 手工验收 | ✅ | 已使用重建后的打包 Windows Electron + 真实 `cfr-landscape-av.mp4` 创建项目、导入素材、打开 AI 工作单并创建 `editing_grammar` worklist；真实 UI 显示 `waiting_for_apply` 与待审阅提案；重启后通过历史工作单选择器重新打开并确认同一状态 |

## 2. Automated verification

通过：

```text
Core focused/status/migration/AI-CV suite: 65 passed
Core Worklist state-machine suite: 2 passed
Desktop Worklist/Preload/IPC/project-isolation suite: 15 passed
TypeScript contracts + desktop typecheck: passed
STATUS consistency: passed
```

测试中的 jsdom `HTMLMediaElement.prototype.load` 和 `Worker is not defined` 输出属于既有测试环境回退噪声，不是失败。

## 3. Remaining acceptance work

本切片列出的真实环境验收项已全部完成；历史工作单选择器作为最小面板补强已实现并通过 Desktop 回归测试、typecheck 及真实 Electron 两次启动验证。
