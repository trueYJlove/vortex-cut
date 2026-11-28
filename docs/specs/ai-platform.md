# AI 平台架构、工作单与稳定错误码契约

> 本文整合 AI 能力总纲（架构基线、隐私不变量、分层组合路径与规划矩阵）、AI 工作单编排与字幕生成设计，以及模型注册与转录稳定错误码契约。
> 不可逆架构与隐私裁决见 [`../adr/0003-ai-direction-and-privacy-hard-commitment.md`](../adr/0003-ai-direction-and-privacy-hard-commitment.md) 与 [`../adr/0004-ai-capability-master-plan-decisions.md`](../adr/0004-ai-capability-master-plan-decisions.md)；当前实际交付状态与未闭环项统一见 [`../STATUS.md`](../STATUS.md) 与 [`../BACKLOG.md`](../BACKLOG.md)。

---

## 1. 目标标准、架构前提与不变量

### 1.1 目标判定维度（C1–C7）

| 维度 | 判定标准 | 验证方式 |
|---|---|---|
| **C1 能力覆盖** | §2 能力矩阵中所有 **P0** 项可用且通过各自验收 | 逐项端到端（真实素材 + 真实 Provider） |
| **C2 理解深度** | 支持自然语言检索画面语义 | 检索评测集命中率 |
| **C3 剪辑语法** | A 类确定性手法（卡点 / L-J cut / 跳切 / 多机位）产出可采纳提案 | 合成夹具断言 + 真实素材端到端 |
| **C4 质量** | 自有评测集上粗剪「结构可用率」达标（用户仅微调不改结构） | 人工标注基准（见 [`local-intelligence.md`](local-intelligence.md) §4） |
| **C5 性能** | 素材分析 p95 ≤ 10s/分钟源（1080p30 档）；语法层提案 < 1s | 性能门 + `evidence/` 归档 |
| **C6 稳定性** | `script` 与 `json_schema` 适配器通路均明确边界；探测无挂起毒化 | 真实 Provider 矩阵复跑 |
| **C7 可解释** | 每个 AI / 语法决策可追溯到具体信号或规则来源 | 提案 payload 与 `rationale` 落盘检查 |

### 1.2 长期存储前提与不变量（I1–I8）

- **数据前提**：时间线文档以 JSON 存于 `timeline_revisions`，新增 clip 可选字段属于文档 schema 与契约增量，而非 SQL 迁移；分析产物按 `algorithm_version` 行化存储，并在读时按内容指纹判定 `stale`。
- **唯一写入路径**：`Proposals → Diff Preview → 显式 Apply → 不可变 Revision`，无旁路写入。

| ID | 不变量 | 来源 | 违反示例 |
|---|---|---|---|
| **I1** | **隐私硬承诺**：云端永不默认、永不静默；egress preview 可逐张审计；A 类语法能力零 egress | ADR-0003 D4 | 默认上云换召回 |
| **I2** | **提案-采纳形态**：一切 AI 产物经 `TimelinePatch → 预览 → 采纳 → Revision` | ADR-0003 D5 | 语法层直接写时间线 |
| **I3** | **契约纪律**：优先增量可选字段、`PROTOCOL_VERSION` 不动；新 op 走「白名单 + schema + 字段清单」三处同步 | 白名单治理 | 新 op 只加 `PATCH_OPERATIONS` |
| **I4** | **主线展平语义**：多机位切换结果在主视频轨展平，不依赖专用多机位私有轨 | DEC-2 | 另造不兼容切换轨 |
| **I5** | **确定性优先**：凡能由确定性规则解决的不引入 LLM | 总纲约束 | 用 LLM 判断卡点位置 |
| **I6** | **本地自立**：关掉云端也须有完整可用体验；召回不足时加强本地信号而非默认上云 | ADR-0003 D4 | 无网络即不可用 |
| **I7** | **有界性**：不做通用无界 agent 框架、不引入第三方 agent 运行时 | ADR-0003 D2 | 接入通用外部循环框架 |
| **I8** | **可解释性**：每个决策可追溯到信号或规则来源，依据随提案落盘 | 服务 C7 | 黑盒输出 patch |

---

## 2. 分层架构、能力矩阵与规划边界

### 2.1 三条组合路径（P-A / P-B / P-C）

```text
交付层: TimelinePatch → [Egress Preview (仅云端路径)] → 预览 → 采纳 → 不可变 Revision
          ▲                                          ▲
编排层: agent_session / worklist ──工具调用──▶ 剪辑语法层 (确定性/纯本地/零 egress)
          │ 脱敏文本/审阅帧 (egress)                   │ 信号快照 (零 egress)
理解层: 本地 Layer 0 (U1-U7) / 可选云端 Layer 2 (U8, opt-in)
```

- **P-A 纯语法**（信号 → 规划器 → patch）：卡点 / L-J cut / 跳切，**零 egress、无需 consent、< 1s**。
- **P-B 纯 LLM**（信号/转录 → 脱敏 payload → LLM → patch）：蒙太奇 / 自然语言修改 / 转录选段。
- **P-C LLM 编排语法**（LLM 选定规划器与参数 → 语法层出 patch）：复合意图通过确定性工具落地。

### 2.2 规划能力目录与硬边界（现状边界见 `STATUS.md` §3）

| 层 | ID 与能力域 | 优先级 | 承载模块 / 规格 |
|---|---|---|---|
| **理解层** | U1 容器探测 / U2 视觉信号 / U3 音频能量 / U4 本地 ASR / U6 节拍网格 | P0 | `media/`、[`timeline-and-editing.md`](timeline-and-editing.md) |
| | U5 说话人分离（降级交付） / U7 本地语义检索 | P0–P1 | [`camera-sync.md`](camera-sync.md)、[`local-intelligence.md`](local-intelligence.md) |
| | U8 云端关键帧理解（opt-in） | P1 | [`keyframe-understanding.md`](keyframe-understanding.md) |
| **语法层** | E1 转录粗剪 / E2 去停顿 / E3 L-J Cut / E4 卡点 | P0 | [`timeline-and-editing.md`](timeline-and-editing.md) |
| | E5 多机位切换（W2.3 冻结） / E6–E7 蒙太奇与匹配剪辑 / E8 响度归一 | P1–P2 | `ADR-0009`、[`../BACKLOG.md`](../BACKLOG.md) |
| **编排与信任** | O1–O4 单发/多步会话/工作单/语法工具化；D1–D5 审阅/审计/评测/可解释 | P0–P1 | §3、[`local-intelligence.md`](local-intelligence.md) |
| | O5 MCP / CLI 优先暴露层（结合 P236） | P2 | [`../plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md`](../plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md) |

- **明确不做**：全自动无人工确认发布、通用第三方 agent 运行时、传视频原片上云、默认开启云端、用 LLM 替代确定性剪辑判断。
- **已固化九项决策（DEC-1 ~ DEC-9）**：详见 [`../adr/0004-ai-capability-master-plan-decisions.md`](../adr/0004-ai-capability-master-plan-decisions.md)。

---

## 3. AI 工作单编排与字幕生成设计（W4.1）

### 3.1 数据模型与状态机（迁移 v27，独立于 `agent_sessions`）

- **`worklists`**：`id, project_id, base_revision_id, base_document_sha256, status ('prepared'|'confirmed'|'running'|'waiting_for_apply'|'succeeded'|'failed'|'cancelled'|'expired'), current_step_ordinal, step_count, max_steps, token_budget, ...`
- **`worklist_steps`**：`id, worklist_id, ordinal, kind ('roughcut'|'editing_grammar'|'captions'|'style'), status, base_revision_id, input_sha256, proposal_id, applied_revision_id, error_json, ...`（`UNIQUE(worklist_id, ordinal)`）
- **`worklist_step_audits`**：`id, worklist_step_id, planner_id, params_sha256, output_sha256, egress_preview_id, created_at`
- **不可旁路状态机**：`prepared → confirmed → running → waiting_for_apply → running → ... → succeeded`（终态含 `failed | cancelled | expired`）。每步只产 proposal，用户显式 `apply`（校验 `project_id`、当前 Revision、`base_revision_id` 与 `proposed_document_sha256`，冲突报 `WORKLIST_BASE_DRIFT`）后落单条不可变 Revision；单项目最多一个活跃 worklist；`roughcut`/`style` 当前返回 `WORKLIST_STEP_UNAVAILABLE` 且零副作用。
- **事件脱敏**：`worklist.updated` 仅传摘要刷新信号，绝不含指令、raw response、secret 或本地路径。

### 3.2 本地与 Provider `captions` 生成

- **本地 Transcript `captions`（零网络）**：从指定 `transcript_id` 与 `segment_ids` 装配 `insert_transcript_segments` proposal，前置校验失败返 `WORKLIST_CAPTIONS_*` 且零副作用。
- **Provider `captions` 文本生成（两阶段 Egress）**：
  - 仅发送脱敏载荷 `captions_provider_v1`（`segment_id, ordinal, text, duration_bucket`），不传时间码、`clip_id`、`asset_id` 或完整时间线，不扩大 `AI_PATCH_OPERATIONS`。
  - `POST .../captions-provider/prepare` → `CaptionsProviderEgressPreview` → `POST .../captions-provider`（校验 `payload_sha256` 与基线后落一次性 consent/job）→ 输出 schema `caption-text-output-v1`（fail-closed，错误码 `CAPTIONS_PROVIDER_{PARAMS,SEGMENTS,OUTPUT}_INVALID` / `CAPTIONS_PROVIDER_CONSENT_REQUIRED` / `CAPTIONS_PROVIDER_BASE_DRIFT`）。
- **响应适配器阶梯（迁移 v34）**：`CAPTIONS_ADAPTER_IDS = ("openai_chat_completions_json_schema_v1", "openai_chat_completions_captionscript_v1")`（`CAPTIONS_PROBE_PROTOCOL_VERSION = "1"`）。网关拒 `json_schema`（400 `PROVIDER_CONTENT_REJECTED`）时降级 `AIVS-CAPTION/1 ... AIVS-END` 严格脚本格式；数据库触发器强约束 `supported`/`unsupported`/`untested` 状态列一致性。

---

## 4. 模型注册与转录稳定错误码契约（Stage 1B 冻结）

以下稳定错误码为机器可判断契约（`services/core/src/aivs_core/model_registry.py` 遵循此集合；HTTP 映射：401 未授权、404 不存在、400/409 参数或状态冲突、500 内部错误）：

```text
MODEL_NOT_FOUND
MODEL_NOT_INSTALLED
MODEL_DOWNLOAD_FAILED
MODEL_DOWNLOAD_CANCELLED
MODEL_HASH_MISMATCH
MODEL_LICENSE_REQUIRED
MODEL_DISK_SPACE_INSUFFICIENT
MODEL_RUNTIME_UNAVAILABLE
TRANSCRIPTION_NOT_READY
TRANSCRIPTION_FAILED
TRANSCRIPTION_CANCELLED
TRANSCRIPTION_INPUT_CHANGED
TRANSCRIPTION_UNSUPPORTED_LANGUAGE
JOB_NOT_FOUND
JOB_INVALID_STATE
JOB_INTERRUPTED
UNAUTHORIZED
FORBIDDEN
CONFLICT
INTERNAL_ERROR
```

- 缺失模型调用转录必须返回 `MODEL_NOT_INSTALLED` 与 `ModelDetail`，不得静默下载或上传素材；素材指纹变更必须返回 `TRANSCRIPTION_INPUT_CHANGED`。
