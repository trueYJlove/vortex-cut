# W1.1 剪辑语法层骨架 —— 实施记录

> 实施：ZhangSan（Core），2026-09-24。验收：LiuKeAi。
> 承接：`EDITING_GRAMMAR_PLANNING_GATE_2026-09-24`（总纲 §5.2/§5.3）。
> 核销：`docs/STATUS.md` §4 **P13**；§1 `latest_migration` 23→**24**。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 模块 | `aivs_core/editing_grammar/`：`protocol` / `planners` / `registry` / `service` |
| 纯函数 | `Planner.plan(document, params) -> PlanResult`；同输入两次 patch 逐字节相同 |
| 零 egress | 无网络依赖；测试 monkeypatch `socket` 断言 |
| rationale | 提案行 `rationale_json`（规则逐 clip、params、signals） |
| 统一输出 | TimelinePatch operations；apply 走 `apply_in_memory` + `create_revision_from_document` |
| 不写时间线 | propose 只 INSERT 提案表 |
| 工具化 | `GET …/editing-grammar/planners` 工具目录 |
| 参考规划器 | `drop_short_clips`（骨架 e2e，非 W1.5） |
| 三段式 REST | prepare / proposals / apply（**无 egress/consent**——P-A） |
| 迁移 | **v24**：`editing_grammar_proposals` + `editing_grammar_applications`（不可变触发器） |
| 测试 | `test_editing_grammar.py` 6 项；`test_migrations_v24.py` 2 项 |

## 2. 验收核对表（规划门 §3）

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 确定性（两次 plan / 两次 propose patch_sha） | ✅ | `test_plan_is_deterministic` / `test_same_proposal_patch_sha` |
| 3.2 | 零 egress | ✅ | `test_zero_egress_plan_propose_apply` |
| 3.3 | rationale 可读 | ✅ | 提案 `rationale.rules` 逐 clip action |
| 3.4 | e2e 采纳链 + 二次 apply 拒 | ✅ | `test_zero_egress_plan_propose_apply` |
| 3.5 | 无旁路写 | ✅ | `test_propose_does_not_write_timeline_until_apply` |
| 3.6 | 迁移 v24 + 不可变 | ✅ | `test_migrations_v24.py` |
| 3.7 | 空操作语义 | ✅ | noop 可 propose、apply 拒——`test_noop_proposal_rejects_apply` |
| 3.8 | 工具目录形状 | ✅ | `test_tool_catalog_shape` |

## 3. 开放问题落实

1. 空删除集 → **noop 提案、apply 拒**。
2. 跨 base apply → **拒**（哈希对账）。
3. `min_duration_us` 下限对齐 `MIN_VIDEO_US`（100ms）。

## 4. 剩余范围

| # | 项 |
|---|---|
| L1 | Desktop 提案列表/采纳 UI（YeJing） |
| L2 | 真实手法规划器 W1.3–W1.5（卡点/跳切/L-J） |
| L3 | 工具描述接入编排层（W4.1/W4.3） |
