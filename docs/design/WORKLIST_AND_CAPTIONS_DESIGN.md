# W4.1 工作单编排与 Captions 设计规格

> 本文合并原 Worklist 编排、本地 `captions`、Provider `captions` 文本生成、Egress 两阶段控制与响应适配器阶梯等 8 份规划/设计门文档。
> 当前工作线与 `roughcut`/`style` 延后守卫状态统一见 [`../STATUS.md`](../STATUS.md) §3/§4（P149）。

---

## 1. W4.1 工作单编排核心（Worklist Orchestration）

### 1.1 数据模型（迁移 v27，不复用 `agent_sessions`）

`agent_session` 面向“单会话外部 consent + 失败反馈循环”，而 Worklist 是“固定步骤链、每步等待显式 Apply 的本地编排”，两者独立建表：

- **`worklists`**：`id, project_id, base_revision_id, base_document_sha256, status ('prepared'|'confirmed'|'running'|'waiting_for_apply'|'succeeded'|'failed'|'cancelled'|'expired'), current_step_ordinal, step_count, max_steps, token_budget, created_at, updated_at, finished_at`。
- **`worklist_steps`**：`id, worklist_id, ordinal, kind ('roughcut'|'editing_grammar'|'captions'|'style'), status, base_revision_id, input_sha256, proposal_id, applied_revision_id, error_json, started_at, finished_at, created_at`（`UNIQUE(worklist_id, ordinal)`）。
- **`worklist_step_audits`**：`id, worklist_step_id, planner_id, params_sha256, output_sha256, egress_preview_id, created_at`。

### 1.2 状态机、并发与执行边界

```text
prepared -> confirmed -> running -> waiting_for_apply -> running -> ... -> succeeded
prepared/confirmed/running/waiting_for_apply -> failed | cancelled | expired
```

- **不可旁路**：每步只能生成 proposal 并停在 `waiting_for_apply`，必须经用户显式 `apply`（原子校验 `project_id`、当前 Revision、step `base_revision_id` 与 `proposed_document_sha256`，冲突返回 `WORKLIST_BASE_DRIFT`）后才创建单个不可变 Revision 并推进下一步；空操作 `noop` 不得生成空 Revision。
- **隔离与恢复**：单项目同时最多一个活跃 worklist；取消幂等终态，迟到回调不得推进；Desktop 切换项目时取消本地订阅并凭 `project_id + epoch` 隔离；Core 重启后禁止重跑已有 `applied_revision_id` 的 step。
- **步骤实现边界**：当前已交付 `editing_grammar`（零 egress）与 `captions`（本地装配 / Provider 文本生成）；`roughcut` 与 `style` 明确返回 `WORKLIST_STEP_UNAVAILABLE` 且零 job 副作用（延后触发条件见 [`../STATUS.md`](../STATUS.md) §4 P149）。

### 1.3 API 与事件

- `POST /api/v1/projects/{project_id}/worklists/prepare` / `POST .../worklists` / `GET .../worklists` / `GET .../worklists/{worklist_id}` / `POST .../cancel` / `POST .../steps/{step_id}/apply`
- 事件 `worklist.updated` 仅传摘要刷新信号（`worklist_id, project_id, status, current_step, progress`），绝不含指令、raw response、secret 或路径；权威状态永远以 `GET worklist` 为准。

---

## 2. 本地 Transcript `captions` Step（零网络）

- **职责**：仅从已有本地 `transcript_id` 与显式 `segment_ids` 装配 `insert_transcript_segments` TimelinePatch proposal，不改写文本、不进 `AI_PATCH_OPERATIONS`、零网络调用、不新增迁移（参数存 `worklist_steps.params_json`）。
- **前置校验（任一失败返 `WORKLIST_CAPTIONS_*` 且零副作用）**：项目/Revision 一致、transcript 归属当前 project、全部 segment 归属该 transcript 且非空无重、`at_index` 合法、`preset_id ∈ CAPTION_PRESETS`。

---

## 3. Provider `captions` 文本生成与 Egress 两阶段控制

### 3.1 隐私与白名单边界

- **不扩大 `AI_PATCH_OPERATIONS`**；不允许 Provider 返回时间码、`clip_id`、`asset_id` 或 `TimelinePatch`。
- Core 只按当前 project 显式选中的 segment 发送脱敏载荷 `captions_provider_v1`（`segment_id, ordinal, text, duration_bucket`，含 `language, preset_id, max_chars_per_caption`）；时间范围留在 Core 侧，由 Core 将校验后的输出绑定回原始 segment 时间范围并生成确定性 proposal。
- 严禁把 raw request/response、API key、路径或完整 Timeline 写入数据库日志、Worklist 或 UI。

### 3.2 两阶段 Egress 契约

- `POST /projects/{project_id}/captions-provider/prepare` → 校验项目/Revision、Provider capability（含已选适配器）与 segment 归属，返回不可变 `CaptionsProviderEgressPreview`（摘要、字段清单、hash、估算 token、过期时间）。
- `POST /projects/{project_id}/captions-provider` → 仅收 `captions_provider_egress_preview_id + payload_sha256`，复核基线/快照/过期后创建一次性 consent、invocation 与 job。
- `GET /captions-provider-generations/{generation_id}` → 只读状态与脱敏错误。
- Output schema `caption-text-output-v1`：`{ items: [{ segment_refs, text, confidence }], warnings }`；`items` 非空、`segment_refs` 只能引用输入集合且不能重复覆盖、`text` 非空且 ≤ `max_chars_per_caption`（fail-closed）；固定错误码 `CAPTIONS_PROVIDER_{PARAMS,SEGMENTS,OUTPUT}_INVALID` / `CAPTIONS_PROVIDER_CONSENT_REQUIRED` / `CAPTIONS_PROVIDER_BASE_DRIFT`。

---

## 4. `captions` Provider 响应适配器阶梯（迁移 v34）

### 4.1 适配器优先级与 `captionscript` 语法

```python
CAPTIONS_ADAPTER_IDS = (
    "openai_chat_completions_json_schema_v1",
    "openai_chat_completions_captionscript_v1",
)
CAPTIONS_PROBE_PROTOCOL_VERSION = "1"
```

- 网关拒绝 `json_schema`（HTTP 400 → `PROVIDER_CONTENT_REJECTED`，确定性不重试）时自动降级到 `captionscript`；不纳入 `/responses`（502）与裸 `json_object` 弱档。
- **`openai_chat_completions_captionscript_v1` 严格框定格式**（禁止空行、Markdown 围栏或前后缀；每个输入 segment ID 必须恰好出现一次；单行 JSON 仅含 `{segment_refs, text}`；复用中性 `_script_lines` 并委托 `validate_captions_provider_value` 校验）：

```text
AIVS-CAPTION/1
{"segment_refs":["seg_0"],"text":"..."}
{"segment_refs":["seg_1","seg_2"],"text":"..."}
AIVS-END
```

### 4.2 迁移 v34 与不变量触发器

- `provider_configs` 新增 `captions_provider_response_adapter_id`、`captions_provider_probe_protocol_version`、`captions_provider_capability_failure_code`、`captions_provider_capability_probe_sha256`，并将历史未记录适配器的 `supported`/`unsupported` 行重置为 `untested`。
- 数据库触发器 `provider_captions_capability_valid_insert/update` 强制：`supported` 必须绑定合法 `adapter` + `'1'` + `tested_at` + `probe_sha256`（`failure_code` 为空）；`unsupported` 必须有 `tested_at` + `failure_code` + `probe_sha256`（`adapter`/`protocol` 为空）；`untested` 五列全空。
- `claim_for_runner` 严格使用已探测通过的 `captions_provider_response_adapter_id`；`finish_reason=length` 且 `content` 为空归为确定性 schema 失败（不按网络错误重试）。
