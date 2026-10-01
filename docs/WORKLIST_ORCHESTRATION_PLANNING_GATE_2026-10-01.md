# W4.1 工作单编排 MVP——Planning Gate

> 本文是 W4.1 的规划门输入，不声明项目当前状态；当前状态唯一以 [`STATUS.md`](STATUS.md) 为准。
> 目标：在既有 AI-1 多步会话、TimelinePatch 提案/预览/采纳和不可变 Revision 之上，增加一个有界、可取消、可逐步审阅的工作单编排层。

## 1. 问题与边界

AI-1 已提供“单会话内失败反馈重试”的有界循环，但工作单仍缺少显式步骤链。W4.1 不重做 provider、agent session 或 TimelinePatch，而是增加一个本地可持久化的 orchestration plan，把多个已存在的规划器/AI 能力串起来。

本 MVP 只支持固定白名单步骤，不做通用 agent、动态工具发现或 MCP。候选步骤：

1. `roughcut`：已有候选粗剪，生成提案；
2. `editing_grammar`：已有去停顿、L/J cut、卡点等确定性规划器；
3. `captions`：已有转录/字幕提案能力；
4. `style`：已有布局/字幕样式提案能力。

BGM、语义 embedding、多机位和云端关键帧理解不在 MVP 内；它们分别由总纲后续工作包负责。

## 2. 不变量

- 每一步必须经过既有 TimelinePatch → preview/diff → explicit apply 语义；工作单不得旁路写 Timeline。
- 每一步成功只落一个不可变 Revision；失败、取消和过期步骤不得留下 partial Revision。
- 工作单固定绑定 `project_id`、`base_revision_id` 和 `plan_id`；项目切换、基线漂移或会话失效立即中止。
- 云端步骤仍必须使用既有 egress preview/consent；纯本地 grammar 步骤零 egress。
- 步数、token、墙钟时间和单项目并发均有上限。
- 每一步持久化输入摘要、工具/规划器 ID、参数摘要、输出 patch 摘要、Revision ID、状态、错误和耗时；不得持久化 provider secret 或原始敏感响应。
- 重试创建新 step，不覆盖旧 step；取消必须传播到当前 job/provider 调用。
- Desktop 展示每一步状态和 diff，用户逐步确认，不自动批量采纳。

## 3. 建议契约

新增契约采用增量字段，不修改 `PROTOCOL_VERSION`：

- `WorklistPlan`：`plan_id`、`project_id`、`base_revision_id`、`status`、`steps`、`created_at`、`updated_at`；
- `WorklistStep`：`step_id`、`ordinal`、`kind`、`status`、`input_sha256`、`proposal_id`、`revision_id`、`error_code`、`started_at`、`finished_at`；
- `WorklistStepKind`：固定枚举，第一版只允许 `roughcut | editing_grammar | captions | style`；
- `POST /projects/{project_id}/worklists/prepare`：校验项目、基线、步骤枚举和预算，返回脱敏计划预览；
- `POST /projects/{project_id}/worklists`：在明确确认后创建 job；
- `GET /projects/{project_id}/worklists/{plan_id}`：返回权威状态和步骤明细；
- `POST /projects/{project_id}/worklists/{plan_id}/steps/{step_id}/apply`：显式采纳当前步骤提案；
- `POST /projects/{project_id}/worklists/{plan_id}/cancel`：取消工作单。

实际端点命名、是否复用 agent session 表以及迁移版本必须在设计门裁决后实现，不能在本规划门中隐式冻结。

## 4. 状态机

```text
prepared -> confirmed -> running
running -> waiting_for_apply -> running
running -> succeeded | failed | cancelled | expired
waiting_for_apply -> cancelled | expired
```

- `waiting_for_apply` 是用户审阅边界；未经 apply 不得进入下一步。
- apply 时重新检查 `project_id`、当前正式 Revision 和 step 的 `base_revision_id`。
- 冲突统一返回基线漂移错误，要求刷新并重新 prepare，不自动合并。

## 5. 验收标准

### 正确性

1. 固定四步计划可 prepare；非法步骤、重复步骤、空步骤和超预算请求被拒绝。
2. 每一步只能在上一合法 Revision 成功采纳后启动。
3. 任一步失败不会创建 partial Revision；工作单状态和 step 状态可查询。
4. 用户切换项目后，旧工作单的事件、轮询和结果不能写入新项目 UI，也不能用新项目 ID 采纳旧 step。
5. 外部修改正式 Timeline 后，下一步 apply 必须因基线漂移停止。
6. 取消能停止当前 job，且之后不能继续推进下一步。

### 隐私与审计

1. grammar 步骤无网络调用，单测通过禁止 egress 的 spy。
2. provider 步骤具有 egress preview、单次 consent 和 payload hash。
3. 日志、事件和 Desktop UI 不显示 secret、原始 provider 响应或内部文件路径。

### 性能与可靠性

1. prepare 和纯 grammar step 在本地 fixture 上 p95 < 1s；
2. 每一步有超时和取消路径；
3. 重启 Core 后可恢复查询状态，不重复采纳已落盘 Revision；
4. 单项目最多一个 queued/running worklist；重复提交幂等或明确拒绝。

### 测试矩阵

- Core：状态机、预算、基线漂移、取消、重启恢复、重复提交、step 原子性；
- Desktop：逐步 diff/apply、项目切换隔离、取消、错误/重试、隐私字段；
- E2E：本地 grammar 零 egress、受控 provider 单次 consent、四步最小工作单；
- 回归：既有 agent_session、TimelinePatch、Stage 2A/2B 和纯编辑链路全部通过。

## 6. 实施切片

1. Design Gate：冻结 step schema、复用/新增存储方案、端点和事件映射；
2. Core slice：prepare + 状态机 + step 审计 + grammar adapter；
3. Desktop slice：工作单面板、step diff、逐步 apply/cancel；
4. Controlled E2E：项目切换、provider consent、失败重试、基线漂移；
5. Verification Gate：对照本清单逐项核验，并在 [`STATUS.md`](STATUS.md) 登记/核销承诺。

## 7. 暂不进入实现的裁决

- 不把工作单实现成无限 agent loop；
- 不允许“全部步骤自动采纳”；
- 不把 P33 预览性能当作工作单的隐式依赖，但每一步完成后必须通过现有预览/提案链路；
- 不在本工作包内引入 embedding、diarization、MCP 或新的 provider 协议。

## 8. Gate 输出

进入 Design Gate 前必须补齐：

- 四步 MVP 的真实产品流程图；
- 现有 `agent_session` 与新 `worklist` 的复用边界；
- 迁移/契约变更清单；
- 取消和项目切换的事件时序图；
- 受控 provider 和零 egress 测试 fixture；
- 每项验收标准对应的测试文件和 evidence 路径。
