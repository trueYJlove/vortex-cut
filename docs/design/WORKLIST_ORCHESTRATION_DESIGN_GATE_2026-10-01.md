# W4.1 工作单编排 MVP——Design Gate

> 本文冻结 W4.1 MVP 的实现边界；当前项目状态仍只由 [`../STATUS.md`](../STATUS.md) 声明。
> 前置规划门：[`../requirements/WORKLIST_ORCHESTRATION_PLANNING_GATE_2026-10-01.md`](../requirements/WORKLIST_ORCHESTRATION_PLANNING_GATE_2026-10-01.md)。

## 1. Design Gate 决策

### D1：新增 worklist 数据模型，不复用 agent_sessions 主表

`agent_session` 的语义是“一次外部 consent + provider 失败反馈重试循环”，而 worklist 是“多个固定步骤、每步等待用户 apply 的本地编排”。两者状态机、审计粒度和 consent 生命周期不同，因此不把 worklist 伪装成 agent session。

复用以下既有基础设施：

- `jobs`：worklist runner 仅作为一个有界 job；
- `TimelineService`：基线校验、Revision 生成和冲突语义；
- `TimelinePatch` / `editing_grammar`：所有步骤统一输出提案；
- `agent_session` 的 egress/consent 校验代码模式，但不共享表；
- `agent_session.updated` 的事件承载模式，新增 `worklist.updated` 事件。

### D2：迁移 v27，三张表

使用新迁移 `v27`：

```sql
CREATE TABLE worklists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  base_document_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','confirmed','running','waiting_for_apply','succeeded','failed','cancelled','expired')),
  current_step_ordinal INTEGER NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL,
  max_steps INTEGER NOT NULL,
  token_budget INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE worklist_steps (
  id TEXT PRIMARY KEY,
  worklist_id TEXT NOT NULL REFERENCES worklists(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('roughcut','editing_grammar','captions','style')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_for_apply','succeeded','failed','cancelled','expired')),
  base_revision_id TEXT,
  input_sha256 TEXT,
  proposal_id TEXT,
  applied_revision_id TEXT,
  error_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(worklist_id, ordinal)
);

CREATE TABLE worklist_step_audits (
  id TEXT PRIMARY KEY,
  worklist_step_id TEXT NOT NULL REFERENCES worklist_steps(id),
  planner_id TEXT NOT NULL,
  params_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  egress_preview_id TEXT,
  created_at TEXT NOT NULL
);
```

所有 worklist 与 step 记录均按 append/状态受限更新设计；提案和 Revision 仍由既有不可变表负责，不能在 worklist 表中复制 Timeline 文档。

### D3：状态机和用户边界

```text
prepared -> confirmed -> running -> waiting_for_apply -> running
                                      └───────────────> succeeded
prepared/confirmed/running/waiting_for_apply -> failed | cancelled | expired
```

- `prepared` 只表示本地校验通过，不启动 job；
- `confirmed` 由用户提交 payload hash 后进入 queued/running；
- 每个 step 生成 proposal 后进入 `waiting_for_apply`；
- 只有 `apply` 成功后才进入下一个 step；
- `apply` 必须原子校验 `project_id`、worklist 当前 Revision、step base Revision 和 proposal hash；
- 任何冲突进入 `failed`，不自动 merge；
- 空操作 proposal 可以展示，但不得产生无意义 Revision；step 可记为 succeeded/noop；
- cancel 是幂等终态，取消后迟到 job/event 不得推进 step；
- 过期由 Core 在读/写边界惰性标记，不依赖后台清理任务。

### D4：步骤执行边界

MVP 固定四种 kind：

| kind | 执行器 | egress | 第一阶段策略 |
|---|---|---:|---|
| `roughcut` | 复用 Stage 2A 候选提案 | 是 | 只允许已有候选源和 provider 能力 |
| `editing_grammar` | `EditingGrammarService` planner registry | 否 | 直接生成本地 proposal |
| `captions` | 既有转录/字幕 patch adapter | 视 provider 而定 | 未具备 adapter 时显式拒绝，不静默降级 |
| `style` | 既有 TimelinePatch adapter | 是 | 必须先经过 egress preview/consent |

第一实现切片只实现 `editing_grammar`，因为它能验证完整 worklist 状态机而不需要真实 Provider。其他 kind 先完成契约和拒绝语义，再分别接入。

### D5：API 与 IPC

Core REST：

```text
POST /api/v1/projects/{project_id}/worklists/prepare
POST /api/v1/projects/{project_id}/worklists
GET  /api/v1/projects/{project_id}/worklists
GET  /api/v1/projects/{project_id}/worklists/{worklist_id}
POST /api/v1/projects/{project_id}/worklists/{worklist_id}/cancel
POST /api/v1/projects/{project_id}/worklists/{worklist_id}/steps/{step_id}/apply
```

请求约束：

- prepare：`base_revision_id`、固定有序 `steps`、预算参数；
- create：`worklist_prepare_id`、`payload_sha256`；纯本地 worklist 也使用不可变 prepare 快照，避免确认前后参数漂移；
- apply：`step_id`、`base_revision_id`、`proposed_document_sha256`；
- 所有路径参数必须由 Core 验证 project ownership，Renderer 不发送文件路径。

Desktop IPC 只暴露 typed wrapper，不把 Core 原始响应直接透传 Renderer。项目切换时取消 worklist poll/subscription 并清空当前 project 的 worklist state；每个回调都检查 project ID + epoch。

### D6：事件

新增事件：

```json
{
  "type": "worklist.updated",
  "payload": {
    "worklist_id": "...",
    "project_id": "...",
    "status": "waiting_for_apply",
    "current_step": 1,
    "progress": 0.25
  }
}
```

事件只作刷新提示；权威状态永远是 `GET worklist`。事件不包含 instruction、provider response、secret、文件路径或 Timeline 全文。

### D7：并发与漂移

- 一个 project 只能有一个 `prepared/confirmed/running/waiting_for_apply` worklist；
- worklist 的 base revision 和当前 revision 必须在 prepare/create/apply/下一 step 四个边界重新检查；
- 项目切换只影响 Desktop 展示和取消本地订阅，不取消已经持久化的 Core job；Core 仍会把旧 worklist 安全推进到 cancelled/failed，不能写新项目；
- Core 重启后通过数据库恢复 worklist 状态，禁止重新执行已经有 `applied_revision_id` 的 step；
- runner 使用 job cancellation event；apply 只在 job 到达 waiting 状态后可执行。

## 2. 第一实现切片（进入 Implementation Gate）

只实现本地 `editing_grammar` worklist：

1. migration v27 的 `worklists/worklist_steps/worklist_step_audits`；
2. Core `WorklistService.prepare/create/get/list/cancel/apply`；
3. runner 接入 `editing_grammar` planner registry；
4. 四个 REST 端点最小闭环：prepare/create/get/apply/cancel；
5. contracts + Desktop Main/Preload typed IPC；
6. Desktop 最小面板：步骤状态、proposal diff、Apply/Cancel；
7. Core 单测和 Desktop 项目切换隔离测试。

暂不实现 roughcut/captions/style 的实际执行器；它们返回明确的 `WORKLIST_STEP_UNAVAILABLE`，并且不得产生 job 副作用。

## 3. Design Gate 验收

- 数据库迁移逐版本测试，状态 CHECK 和 step 唯一性测试；
- 同一项目重复 create 被拒绝；不同项目可并行；
- 外部 Revision 变化后 apply 返回 `WORKLIST_BASE_DRIFT`；
- 取消后 proposal 迟到不能 apply；
- editing grammar 规划器 monkeypatch 网络调用必须为零；
- step apply 只产生一个 Revision，重复 apply 幂等拒绝；
- 项目 A→B 切换后，A 的事件/迟到响应不污染 B 的 UI；
- Desktop typecheck、contracts build、Core 全量相关测试通过；
- 验收记录包含逐项 cross-check 表后，才核销 STATUS 中的 P34。

## 4. 未冻结事项

以下不在本 Design Gate 中擅自决定：

- roughcut/captions/style 的具体 provider payload；
- Worklist 是否最终支持暂停/恢复；
- 多工作单历史的分页/归档策略；
- W4.1 完整 UI 的视觉设计；
- P27–P33 预览门的核销。
