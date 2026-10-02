# W4.1 Implementation Slice 1——专项验收记录

> 验收日期：2026-10-02。本文记录自动化验收证据；项目当前状态仍以 [`STATUS.md`](STATUS.md) 为准。
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
| Desktop 项目切换隔离 | ⚠️ 部分 | 面板使用 `key={project.project_id}` 且请求按 projectId；已有 `project-switch-isolation.test.tsx` 通过，但尚无 Worklist 专项 A→B 延迟响应测试 |
| Core 重启恢复 | ⚠️ 未核销 | 数据持久化存在；尚无重启后 running/waiting 恢复专项测试 |
| roughcut/captions/style 明确拒绝 | ✅ | Core `WORKLIST_STEP_UNAVAILABLE`；当前切片未产生 job 副作用 |
| 真实 GUI/Electron 手工验收 | ⚠️ 未核销 | 当前证据为 jsdom/Vitest、Core API 和 TypeScript；未使用真实素材启动 Electron 完成手工签字 |

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

1. 增加 Worklist 专项 A→B 项目切换延迟响应测试；
2. 增加 Core 重启后 Worklist 状态恢复/不重复执行测试；
3. 以真实 Electron/真实素材完成一次面板操作签字；
4. 完成上述证据后再将 STATUS P35 核销，不提前宣称完整验收通过。
