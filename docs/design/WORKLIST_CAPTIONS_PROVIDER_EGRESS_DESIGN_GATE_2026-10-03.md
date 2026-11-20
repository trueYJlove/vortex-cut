# W4.1 captions Provider egress——Design Gate

> 当前状态以 [`../STATUS.md`](../STATUS.md) 为准。本门冻结 egress prepare/create 的契约，不声明真实 Provider 已交付。

## 1. 复用边界

复用 `TimelinePatchPlanningService` 的 egress 两阶段语义：

1. `prepare`：校验当前项目/Revision、Provider capability、显式 transcript segment 归属，生成不可变 preview；
2. `create`：仅接受 preview ID + payload hash，重新校验项目基线、Provider snapshot、过期时间和 payload hash；成功后创建 consent、invocation 和 job；
3. runner：消费一次性 consent，调用既有 `StructuredTextRequest`，输出经 `validate_captions_provider_value` 校验后才生成 proposal；
4. Worklist：只在 proposal 已生成时进入 `waiting_for_apply`，Apply 仍由用户显式触发。

不新增网络旁路、不把 raw response 写入数据库、不扩大 AI patch 白名单。

## 2. API 契约

- `POST /projects/{project_id}/captions-provider/prepare`
  - 输入：`base_revision_id`、`provider_config_id`、`transcript_id`、`segment_ids`、`language`、`preset_id`、`max_chars_per_caption`；
  - 输出：`CaptionsProviderEgressPreview`，只含 Provider 公共信息、schema/recipe 版本、sent_fields、hash、统计和过期时间。
- `POST /projects/{project_id}/captions-provider`
  - 输入：`captions_provider_egress_preview_id`、`payload_sha256`；
  - 输出：标准 Job/Invocation 摘要。
- `GET /captions-provider-generations/{generation_id}`：只读状态与脱敏错误。

不允许客户端提交 transcript 文本、Provider response、时间码或 patch。

## 3. Preview payload

Core 内部 payload 固定为 `captions_provider_v1`：显式 segment 的 ID、ordinal、脱敏文本、duration_bucket，以及 language、preset、max chars。segment 时间范围只保留在 Core 侧，Provider 不可伪造。

## 4. 持久化

首个实现复用 `timeline_patch_egress_previews` 的不可变/过期/哈希原则，但不复用 timeline patch generation 表的语义。若实现需要新表，必须单独迁移并同步 STATUS §1；不得把 captions generation 伪装为 timeline patch generation。

## 5. 安全验收

- 跨项目 transcript/segment 拒绝；
- Provider capability 未通过拒绝；
- 未 consent 不创建调用；
- payload、Provider snapshot 或 Revision 漂移拒绝；
- raw response、secret、路径、完整 Timeline 不进 UI/日志/Worklist；
- Provider 输出只能覆盖输入 segment，Core 自行绑定时间；
- 取消、超限、schema 错误均不创建 Revision。

## 6. Implementation Slice 2

1. 新增 Core DTO、纯 payload builder 与 preview redaction；
2. 新增独立 captions provider preview/generation 表或明确复用审计记录；
3. 接入既有 Provider runner 和 capability 字段；
4. contracts + Main/Preload typed IPC；
5. Desktop consent 摘要和 job 状态；
6. Worklist planner 只消费已完成 generation 的受控 proposal；
7. 自动化矩阵与独立 Reviewer 复核。

## 7. Gate 结论

Design Gate 通过，允许进入 Implementation Slice 2。真实 Provider、真实代理、两步会话仍属于后续 Verification Gate，不可由 mock 代替。

## 8. 承诺

本门登记为 `STATUS.md` §4 P40；实施切片登记为 P41。任何迁移、协议、白名单变化必须同步更新 `STATUS.md` §1。

## 变更记录

- 2026-10-03：首次冻结。
