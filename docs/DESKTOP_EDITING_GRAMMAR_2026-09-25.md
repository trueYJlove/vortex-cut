# Desktop 接剪辑语法层 —— 实施记录

> 实施：YeJing（Contracts/Desktop）+ ZhangSan 协作，2026-09-25。验收：LiuKeAi。
> 承接：`EDITING_GRAMMAR_IMPLEMENTATION_2026-09-24.md` §4 L1；
> 排序：ADR-0005 阶段 2 → W0.4 补素材/Wave 1 真实验收 → **本单**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 契约 | `EditingGrammarTool` / `PrepareResult` / `Proposal` / `ProposalListItem` + `parse*` |
| IPC | `editing-grammar:{planners,prepare,propose,proposal-list,proposal-get,proposal-apply}` |
| Preload | `listEditingGrammarPlanners` / `prepareEditingGrammar` / `proposeEditingGrammar` / `listEditingGrammarProposals` / `getEditingGrammarProposal` / `applyEditingGrammarProposal` |
| core-client | 同上六方法（HTTP 直连路径） |
| UI | `EditingGrammarPanel`：工具目录 → 参数 JSON → 干跑 → 提案 → Diff → 采纳 |
| 入口 | 工具菜单「剪辑语法」（零 egress，无 Provider） |
| 采纳 | `acceptState` + 刷新渲染数据；空操作/基线漂移/已应用均有失败文案 |

## 2. 验收核对表

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 工具目录可见（4 个规划器） | ✅ | IPC `editing-grammar:planners` + 面板下拉 |
| 2 | 干跑不写 Timeline | ✅ | `prepare` 只读；Core 既有 `test_zero_egress_plan_propose_apply` |
| 3 | 提案列表 / 详情 / Diff | ✅ | `list/get` + `TimelineDiffView` |
| 4 | 采纳显式落正式 Revision | ✅ | `apply` → `parseTimelineState` → `acceptState` |
| 5 | 空操作不可采纳 | ✅ | UI 仅在 `operations.length > 0` 显示采纳按钮；Core 侧拒 apply |
| 6 | 基线漂移提示 | ✅ | `base_revision_id !== current` 时禁用采纳并提示 |
| 7 | 零 egress / 敏感键裁剪 | ✅ | `stage2bRendererSafe`；无 provider 调用 |
| 8 | 类型与 IPC 白名单 | ✅ | `pnpm typecheck` 绿；`stage2b-ipc.test.ts` 冻结 handler 列表 + 干跑转发用例 |

## 3. 回归

- Desktop：**80 files / 707 tests passed**
- `pnpm typecheck` 通过（contracts build + desktop tsc）
- 既有 JSdom `HTMLMediaElement.load` 噪声未在本单引入

## 4. 边界

1. 参数编辑为 JSON 文本（含 4 个规划器预设），不做逐字段表单——规划器 schema 后续可驱动动态表单。
2. Desktop 未接密度旋钮 UI（ADR-0005 阶段 2 契约字段已就绪，属独立小单）。
3. 真实口播/音乐上的规划器质量调参仍以 W0.4 合成门为准，真人库另册。

## 5. 剩余范围

| # | 项 |
|---|---|
| L1 | 密度旋钮 / sampling_strategy 呈现 |
| L2 | 参数 JSON → schema 驱动表单 |
| L3 | 真人素材质量评测预测接入（cut_pr 出数） |
