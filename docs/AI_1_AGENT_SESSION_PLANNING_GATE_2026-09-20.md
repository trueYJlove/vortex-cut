# AI-1 内置多步 Agent（单发提案升级）——Planning Gate

> 起草：LiuWei，2026-09-20。承接 ADR-0003（D2：自建薄编排层，多步任务循环）。
> 实施：ZhangSan（Core）。验收：LiuKeAi。UI 面为独立小单（见 §1 边界）。

## 0. 现状走读结论（2026-09-20 代码级）

Stage 2B 闭环现状（证据：`timeline_planning.py`、`providers.py`、`timeline.py`、`jobs.py`、`database.py` V5_SQL）：

**单发链路**：prepare（构造 payload + egress preview）→ 用户确认 → create_generation（consent 落库 + job 排队）→ `run_generation` 六阶段（loading_snapshot → calling_provider → validating_response → applying_patch_in_memory → computing_diff → persisting_proposal）→ proposal 持久化 → 用户采纳 → apply 复放建 Revision。

**可直接复用的组件**（接缝调研结论，无新造）：

1. `apply_in_memory(ai=True)`（timeline.py:511）——无副作用沙盒执行器，就是 agent 循环每步的现成验证器；AI 白名单 `AI_PATCH_OPERATIONS`（timeline.py:52）= `PATCH_OPERATIONS`（22 种，timeline.py:17）减 9 种结构性操作，净 13 种：remove_clip / move_clip / position_clip / trim_clip / split_clip / set_layout / set_audio / set_speed / set_reverse_playback / set_image_duration / remove_caption / update_caption / set_caption_timing / set_caption_preset —— 此处按 13 计。
2. 单次 LLM 调用原语 `StructuredTextRequest` + `OpenAICompatibleTextProvider`（providers.py）——严格解析（拒绝重复键/非有限数）、90s 超时、2MB 响应上限、取消传播、审计一行。
3. job 骨架：`PlanningRunner` 签名（jobs.py:46）、`phase/phase_progress` 细粒度列（C22）、cancel_event → httpx 传播、network 令牌（容量 2）。
4. `timeline_diff` + 每步审计：`provider_invocations` 天然一行一步。
5. payload 构造与 stats：`_payload`（timeline_planning.py:444）——时间线是脱敏投影（source_N 别名、无 asset_id/路径、转录文本只经 caption text 出现）。

**两个最紧的既有约束**（agent 循环设计绕不开）：

- **consent 单次消费**：`timeline_patch_egress_consents` 触发器（database.py:345–347）只允许 NULL→consumed_at 的一次转换，且消费时 payload_sha256 必须与 preview 完全一致——设计为单次调用的防重放模型。
- **一代一提案 + 禁止 retry**：`timeline_patch_proposals.generation_id UNIQUE`；`jobs.retry` 对 timeline_patch_generation 直接拒绝（jobs.py:532，`CANDIDATE_GENERATION_RECONFIRM_REQUIRED`）。

## 1. 范围

### 必须实现（Core）

1. **Agent 循环执行体（AI-1-1）**：新 kind `agent_session` 的 job runner = 循环体。每步：构造该步消息 → 单次 provider 调用（复用调用原语，一行 `provider_invocations` 审计）→ 响应解析为 TimelinePatch → `apply_in_memory(ai=True)` 沙盒验证 → 通过则该步落为新 Revision（见 §2 状态推进）；失败则进入结构化错误反馈重试（见下）。步间取消传播（cancel_event 逐步检查）。
2. **结构化校验错误（AI-1-2）**：`apply_in_memory` 校验失败时产出机器可读错误结构（至少：失败 op 序号、op 类型、失败字段、期望值域、错误码），随错误消息文本一并作为下步反馈。现有 `DomainError(code, message)` 保留，新增结构化 detail（不破坏现有错误路径）。
3. **循环闸门（AI-1-3）**：总步数上限（初值 6，可配置）、每步沿用既有单次预算（100 ops / 2MB / 90s）、上下文截断策略（反馈历史超过预算时保留：原始 instruction + 最近 K 步反馈，K=2 初值）。
4. **编排入口（AI-1-4）**：新端点（`/api/v1/projects/{id}/agent-sessions/prepare|create|...` 骨架对齐现有 timeline-patch-generations 三段式）。会话指令 = 用户 instruction（1–4000 字符沿用）+ 会话目标（剪短/字幕/样式类自然语言，不做模板化"工作流"数据模型——指令即工作流，模板留给 prompt 层演进）。
5. **持久化（AI-1-5）**：新表 `agent_sessions`（id/project_id/base_revision_id/instruction/上限/状态）与 `agent_steps`（ordinal/kind=llm_step；stage 复用既有 JobStage；input_sha256/output_json/error_json/duration/tokens）。**最终成果 proposal 复用现有 `timeline_patch_proposals`**（会话每步的累计 diff 落 `agent_steps`，不再另设汇总表）。迁移 v20，附逐版本测试。
6. **Consent 升级（AI-1-6）**：**一个会话 = 一次 consent**。新表 `agent_session_egress_previews/consents`（对齐现有三段式：preview 明示会话级 sent_fields——含新增的"多轮反馈"字段；确认 payload_sha256；落库 consent），触发器只允许消费一次 = 整个会话。既有单发 preview/consent 链路零改动。
7. **WebSocket 事件（AI-1-7）**：会话生命周期事件 `agent_session.updated {session_id, status, progress, step}`——整体承载在 `job.updated` 既有通道（job_id ↔ session_id 映射），新增一条事件类型，不改既有订阅协议。

### 明确不做（边界）

- **AI 操作白名单扩容**（add_transition / set_caption_style / add_caption 等）：独立工作单。本单白名单维持 `AI_PATCH_OPERATIONS` 13 种不动——验证循环机制不与操作能力混谈。
- **嵌套会话 / 并行会话**：一项目同时仅一个 active session；会话不支持嵌套。
- **自主改写 instruction**：会话指令用户定，agent 只能基于它执行；反馈重试不改指令语义。
- **UI 面板**：agent 步骤可视化（每步指令/diff 展示）为独立 Desktop 小单，依赖 AI-1-7 事件到位。
- **MCP 适配层**：ADR-0003 D6 顺序为 AI-1 之后，独立立项。

## 2. 设计要点

- **状态推进策略——每步落 Revision（预览链路小改动）**：AI-1-1 的步骤累积语义与现有六阶段 pipeline 差异最大，故显式裁决。每步成功即以该步后文档 `create_revision_from_document`， Revision 链天然记录轨迹、任意步可回退（用户 Undo 即回到上一步）。代价：Revision 行数增长（一次会话 ≤6 行，同量级于现有粗剪候选采纳链，可接受）。否决"会话内文档仅存内存、会话结束一次落盘"方案：中途失败即全丢、无中途产物可回退、与不可变 Revision 哲学相悖。
- **消息结构**：步 1 = instruction + 时间线投影 payload（沿用 `_payload` 脱敏投影）；步 N>1 = 步 N-1 失败反馈（结构化错误 + 该步尝试的 ops 摘要）+ 原始 instruction。**每步都是独立单轮调用**（provider 端无对话历史），历史由 Core 侧裁剪后注入——egress preview 的 sent_fields 如实列明，用户知情范围准确。
- **每步成功后基线即新 Revision**：下一步 payload 从新基线投影，避免多步漂移；`base_document_sha256` 校验改为"当前步开始时最新 Revision"（会话内基线推进合法，跨会话外部修改则中止——status=failed，error_code=AGENT_SESSION_BASE_DRIFT）。
- **会话状态机**：`queued → running(step 1..N) → succeeded | failed | cancelled`。失败不落任何 partial revision（每步原子性由 apply_in_memory + create_revision_from_document 事务保证）。`jobs.retry` 对 agent_session **允许重试**（与单发 AI 类不同：consent 按会话粒度已消费，重试 = 新会话重新走 prepare/confirm，语义清晰）。
- **费用上限**：会话级 token 上限（初值 200k tokens），超限中止 status=failed，error_code=AGENT_SESSION_BUDGET_EXCEEDED。`provider_invocations` 已记录 usage，会话聚合即得。
- **Provider 适配器**：会话内固定一个适配器（沿用现有探测机制选中者），不跨步回退——与现有"绝不回退"原则一致。

## 3. 验收（LiuKeAi）

1. **单测（Core）**：
   - 循环收敛：步 1 校验失败（结构化错误注入）→ 步 2 成功 → succeeded，Revision 恰好 +2（失败步不落 Revision）；
   - 步数上限：构造持续失败 → 恰在第 6 步后中止，error_code=AGENT_SESSION_STEP_LIMIT；
   - 预算上限：mock usage 累计超 200k → AGENT_SESSION_BUDGET_EXCEEDED；
   - 取消传播：步 2 运行中取消 → status=cancelled，无 partial Revision；
   - consent：会话级单次消费（二次创建同 consent 必失败）；既有单发 consent 链路回归零改动（既有测试全绿）；
   - 结构化错误：失败 op 序号/字段/码可编程断言；
   - 基线漂移：会话内步进合法；外部并发修改 → AGENT_SESSION_BASE_DRIFT。
2. **集成**：真 provider mock 或 capability 测试通过的 provider，跑通"剪短一点并加字幕"两步会话；`provider_invocations` 行数 = 步数。
3. **回归**：Core + Desktop 全量；既有 timeline-patch 单发链路行为不变（契约 PROTOCOL_VERSION 不动，仅新增 DTO/端点/事件类型）。
4. **隐私红线（ADR-0003 D4 门禁项）**：sent_fields 如实反映多轮反馈注入；无新增外发字段逃逸 preview 审计；纯本地路径不受影响。

## 4. 风险

| 风险 | 对策 |
|---|---|
| 会话级 consent 扩大单次外发授权面 | preview 明示会话级 sent_fields 与步数上限；一次确认覆盖整个会话，边界写入 ADR-0003 D4 审计粒度 |
| 每步落 Revision 增长行数 | ≤6 步/会话上限兜底；Revision 行轻（JSON 文档），与粗剪候选链同量级 |
| 多步 LLM 费用不可预期 | 会话级 token 硬上限 + provider_invocations 聚合实时展示（UI 单消费） |
| 结构化错误注入被 LLM 忽略（循环不收敛） | 步数上限 + 预算上限双闸门兜底；失败会话对用户零副作用（无 partial Revision） |
| patchscript 适配器无 model-controlled summary，多轮反馈注入复杂 | json_schema 适配器优先级在 patchscript 之前（TIMELINE_PATCH_ADAPTER_IDS 声明顺序），实测主流 provider 命中 json_schema；会话内反馈注入对 patchscript 类降级为 message 文本（可接受的降级路径） |

## 5. 开放问题（实施前裁决，ZhangSan）

- agent_steps 的 input/output JSON 是否需要哈希钉死（对齐 egress 链路的全链路哈希哲学）——倾向是，实施时定字段。
- 会话级 consent 的 preview 过期时间（沿用 15 分钟还是放宽）——倾向放宽到会话最长时长 + 缓冲，实施时定值。
