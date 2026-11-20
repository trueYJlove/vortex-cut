# AI-1 内置多步 Agent——实施记录

> 实施：ZhangSan（Core），2026-09-20。承接 `AI_1_AGENT_SESSION_PLANNING_GATE_2026-09-20.md`
> 与 ADR-0003（D2）。Desktop UI 面板为后续独立小单（契约/事件面已就绪）。

## 0. 交付面

| 层 | 内容 |
|---|---|
| 迁移 v20 | `agent_sessions` / `agent_steps` / `agent_session_egress_previews` / `agent_session_egress_consents` 四表 + 不可变与单次消费触发器（`database_v20.py`，注册于 `database.py` MIGRATIONS） |
| 服务 | `agent_session.py`：`AgentSessionService`（prepare / create_session / run_session 循环体 / 查询） |
| 结构化错误 | `timeline.py` `apply_in_memory`：op 级失败挂 `__cause__` 结构化 detail（operation_index/op/field/reason），既有 code/message 语义不变 |
| jobs | 新 kind `agent_session`（`job_scheduler.py` KIND_POLICIES network×1 优先级 4；`jobs.py` 分发 + `retry` 放行——会话级 consent 已消费，重试 = 新会话重新 prepare/confirm） |
| 端点 | `POST /projects/{id}/agent-sessions/prepare`、`POST /projects/{id}/agent-sessions`、`GET` ×2（app.py，三段式对齐 timeline-patch-generations） |
| 契约 | `AgentSession` / `AgentSessionStep` / `AgentSessionEgressPreview` / 请求响应 DTO；`JobKind += "agent_session"`；错误码 `AGENT_SESSION_*` 九项（contracts rebuild 通过） |

## 1. 核心语义（对规划门 §2 的落实与偏差）

- **一个会话 = 一次 consent**：会话级 preview 明示 `feedback` 外发字段（多轮反馈注入）+ 步数/token 上限；触发器保证 NULL→consumed_at 单次。既有单发 timeline_patch consent 链路零改动。
- **每步独立单轮调用**：步 N>1 的 payload 注入最近 2 步失败反馈（每步截断 1200 字符），provider 端无对话历史；`sent_fields` 如实列明。
- **每步成功即落不可变 Revision**：会话轨迹 = Revision 链，任意步可 Undo；失败步零副作用（沙盒验证先行）。下一步从新基线投影。
- **收束判定（对规划门的一处简化）**：成功步即会话成功——循环本身就是重试机制（失败步带反馈 continue），不引入额外"模型自评完成"信号。连续失败由双闸门兜底：步数上限（1–6，初值 6）+ 会话 token 预算（200k，provider_invocations usage 聚合）。
- **基线漂移**：会话内步进合法；步落盘时项目指针 ≠ 步起点基线 → `AGENT_SESSION_BASE_DRIFT` 中止（failed）。
- **审计**：每步一行 `provider_invocations`（capability=`agent_session_planning`，input_sha256 联动 step 行）+ 一行不可变 `agent_steps`（状态/stage/摘要/错误 JSON）。
- **事件**：`agent_session.updated {agent_session_id, status, progress, step}`（emit 注入 CoreState，复用既有 WS 通道）。
- **单会话约束**：一项目同时仅一个 queued/running 会话（`AGENT_SESSION_ALREADY_ACTIVE`）。

## 2. 验证

- 新增 `test_agent_session.py` 9 项全绿：收敛（失败→结构化反馈→成功，Revision 恰 +1，反馈进下一步 payload 可断言）、步数上限（恰 6 步中止、无 partial Revision）、token 预算、中途取消（cancelled、无步成果落盘）、consent 单次消费、二会话拒绝、外部基线漂移中止、v20 表/触发器（含 consent 二次消费被 RAISE）、结构化失败提取。
- Core 全量 **840 passed + 2 skipped**；既有 timeline-patch 单发链路回归零变化。
- Desktop **668 passed**（77 文件）+ `tsc --noEmit` 干净；contracts rebuild 通过。
- 迁移测试更新：16 处"最新版本 = v19"断言随 v20 更新（test_migrations_v2/3/12/14/15/16/17/18/19、stage1a_api、stage3b_reframe_real 的 MAX=20、stage4d prototype 冻结集排除 v20）——均为断言面更新，无产品代码回退。

## 3. 开放边界（后续工作单）

> **【2026-09-24 修正】本节三条边界已全部关闭**，原文保留作历史记录。
> 当前状态以 [`docs/../../STATUS.md`](../../STATUS.md) 为准。

- ~~Desktop UI（会话启动/步骤可视化/取消按钮）——依赖本单事件与端点，已就绪。~~
  **✅ 已交付**：`AgentSessionPanel.tsx`（挂载 `App.tsx`），含每步 diff 浏览与费用聚合；
  独立验收见 `DESKTOP_SETTINGS_UI_INDEPENDENT_ACCEPTANCE_2026-09-21.md`（DESK-5 ✅）。
- ~~AI 操作白名单扩容（`add_caption`/`set_caption_style`/`add_transition` 等）——独立单，机制面已验证。~~
  **✅ 已交付**：commit `5bec655`（`AI_WHITELIST_EXPANSION_PLANNING_GATE_2026-09-22`），
  白名单扩至 **22 种显式冻结** + 三处同步准入；`add_caption` 经显式裁决维持排除。
- ~~真实 provider 集成验收（capability 测试通过的 provider 端到端）——依赖用户提供真实 provider 配置。~~
  **✅ 已完成**：`AI_VALIDATION_REPORT_2026-09-20.md` §实验 C 双模型
  （deepseek-v4.1-flash / gpt-5.6-luna）会话均 succeeded；`AI_VALIDATION_DEEPSEEK_PATCH_RERUN_2026-09-21.md` 复跑。
- 开放问题裁决落实：agent_steps 的 input/output 已含 sha256 钉死（input_sha256 列）；会话 preview TTL 定为 30 分钟（步间总时长 + 缓冲）。
