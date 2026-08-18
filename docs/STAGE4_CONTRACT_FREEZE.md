# 阶段 4 契约冻结：生成式素材预研与素材化闭环

> 负责人：LiuWei（架构师）
> 状态：草案冻结（待用户确认）
> 日期：2026-08-18
> 基线：`91d4f94 docs: add Stage 4 requirements skeleton`
> 依据：`ARCHITECTURE.md`、阶段 1–3B 冻结契约与详细设计、`docs/STAGE4_REQUIREMENTS.md`

## 1. 已确认决策与阶段边界

### 1.1 现阶段定位

本阶段定义为 **Stage 4“生成式素材”方向的预研冻结阶段（内部代号：Stage 4A）**，聚焦：

1. 在不改变 Stage 1–3B 已冻结能力的前提下，完成“模型化生成素材”的能力框架设计；
2. 实现 `文本素材 / 图片 / 语音（TTS）` 三类生成意图的统一数据模型、能力描述与任务生命周期；
3. 提供一个可回放、可验收、可回滚的原型闭环（含精度/性能验证计划）；
4. 明确 `STAGE3A 3x3 重构图 + STAGE3B 重构图` 的不变量和兼容边界。

### 1.2 已确认范围（冻结约束）

- 不在本阶段修改 `TimelineDocument v1` 的 schema（包括 `tracks=V1/C1`）；
- 不在本阶段做自动把生成素材“自动入 Timeline 并直接自动重算局部”的逻辑；
- 不在本阶段做成片段自动替换、跨平台自动发片、发布与投放；
- 不在本阶段更改 `CONTRACT_VERSION` 的实际运行值（即不要求代码立即变更 `CONTRACT_VERSION`）；
- 本阶段产物默认保持“可验证、可扩展、可回滚”的实验属性，不作为 Stage 1–3 生产行为的缺省前提。

## 2. 用户价值与阶段目标

### 2.1 主要价值

- 为后续 `Stage 4（架构路线）` 的 TTS / 图片 / 视频生成能力打基础；
- 让用户后续能够配置可控的生成模版（Prompt/Crosswalk）并按需生成可追溯素材；
- 在不污染现有剪辑链路的情况下，让渲染预算、失败归档和安全边界提前可验证；
- 为下一步“自动候选增强”预留标准化素材来源。

### 2.2 本阶段验收目标

- 完成：`Contracts + Core + 迁移策略 + Desktop 交互边界 + 原型验证策略` 四件套的冻结文档；
- 输出：准确的风险清单 + 可执行的验证项，不强制立即真实调用外部大模型；
- 提供：下一阶段（Stage 4B）可直接启用的“技术分解清单”。

## 3. 非目标（本阶段明确拒绝）

1. 直接修改 Stage 3A/3B 的导入导出质量门禁；
2. 在 Stage 4A 中改写 `RenditionSnapshot / Export` 执行链路；
3. 在当前阶段写入 `绝对路径` 到契约、Job、日志或证据；
4. 自动化外传媒体/原文到模型；
5. 直接实现复杂 `视频生成`（长时段）生产闭环；
6. 改变 `protocol_version` 与 `/api/v1` 前缀。

## 4. 兼容性与通用规则

- `protocol_version` 保持 `1`；API 前缀保持 `/api/v1`；
- 现有 Stage 1–3B 的 `Project/Asset/Transcript/Timeline/Preview/Export/Rendition` 行为不改语义；
- `CONTRACT_VERSION` 与 `Python Sidecar API` 保持可向下兼容；
- 任何新增字段需兼容老客户端忽略（`extra=forbid` 的 request 只在新增接口中使用）；
- Stage 3B 的 `stage3b-v1` 契约可保持兼容，`Stage 4A` 暂不改变既有渲染/预览/批次调用路径。

## 5. 架构与技术边界

### 5.1 Core / 数据模型边界

- 新增“生成素材 Domain”：`media generation request`（请求）和 `generation task`（任务）；
- 任务不直接触发 Timeline 改写，仅形成可审计的 `Asset/元数据` 中间产物（或其失败记录）；
- 生成素材任务状态应与现有 `jobs` 的恢复机制兼容（支持重启回放、cancel/retry/interrupted）；
- 统一用 `payload hash / prompt hash / provider config hash / output hash` 做幂等核验；
- 若请求参数变更或 Provider 配置变化，必须重新评估并要求重新提交。

### 5.2 Provider 边界

- 仍保留 `Provider` 仅作为候选能力入口；
- Stage 4A 先实现统一能力元数据层：`provider capabilitiy`（含 `text`、`image`、`tts`、`video` 能力位）；
- 本阶段默认要求：若无法注入外部密钥，则 `generate` 流程只能进入 `SIMULATION/UNSUPPORTED`，不得静默降级为内建合成；
- 不在本阶段要求 `文本生成 + 图片生成 + TTS` 三者均已完成真链路。

### 5.3 Desktop / IPC 边界

- 新增 IPC 仅承担“生成素材请求创建/列表/重试/取消”的读写透传；
- 渲染侧不持有私钥，不持有绝对路径，不显示敏感字段；
- 预览侧仍沿用现有 `受限媒体` 机制或返回摘要信息，不直接展示完整模型响应。

## 6. API 与数据契约（拟定）

### 6.1 新增标识符与枚举

- `MediaGenerationRequestId`
- `MediaGenerationTaskId`

新增枚举（拟）:

- `GenerationKind = "image" | "tts" | "video"`
- `GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"`
- `GenerationInputKind = "single" | "batch"`

### 6.2 新增/拟新增对象

- `MediaGenerationPlan`：请求级对象（project_id、generation_kind、prompt、参数、provider_config_id、输入素材引用/镜头引用）；
- `MediaGenerationTask`：任务级对象（request_id、job_id、stage、进度、output_asset_id、output_sha256、error_code）；
- `GeneratedAssetRef`：生成结果引用（asset_id、asset_kind、media_info、source_generation_id）；
- `MediaGenerationRetryInput/Request`。

### 6.3 新增 API（提案）

- `GET /api/v1/projects/{project_id}/media-generation-requests`
- `POST /api/v1/projects/{project_id}/media-generation-requests`
- `GET /api/v1/media-generation-requests/{request_id}`
- `POST /api/v1/media-generation-requests/{request_id}/confirm`
- `POST /api/v1/media-generation-requests/{request_id}/retry`
- `POST /api/v1/media-generation-requests/{request_id}/cancel`
- `POST /api/v1/providers/{provider_config_id}/generation-capability-test`

注：本阶段仅冻结接口与行为语义，不在 `docs/STAGE4_DETAILED_DESIGN.md` 确认前提交实现。

### 6.4 错误码（拟新增）

- `GENERATION_REQUEST_INVALID`
- `GENERATION_KIND_UNSUPPORTED`
- `GENERATION_PROVIDER_UNSUPPORTED`
- `GENERATION_INPUT_CHANGED`
- `GENERATION_OUTPUT_INVALID`
- `GENERATION_RETRY_NOT_ALLOWED`
- `GENERATION_PAYLOAD_EXPIRED`
- `GENERATION_HASH_MISMATCH`

### 6.5 数据库迁移

- 不允许直接覆盖 v10；新增 `V11`，只追加新表与最小索引；
- 约定：v10~v11 升级需保持已存在 Stage 3B 与更早版本表与索引 checksum 的严格不可变。

## 7. 安全与隐私不变式（Stage 4A 强制）

1. DTO、日志、UI、Job、SQLite 中不得出现绝对路径、字幕正文、完整转录、Provider `secret`；
2. 不记录完整 Prompt 明文（仅保留 hash 与白名单参数摘要）；
3. 不展示 Provider 返回的原始响应体、请求体、stderr、command；
4. 若任务失败必须给出**错误码**与**不可敏感的失败摘要**；
5. 对外调用必须遵守最小权限与可追溯性，单次确认与重试策略可见。

## 8. 与现有版本的兼容与不变式

- `Stage 3A`：Preset、Rendition Snapshot、Preview、Batch 与重试语义不变；
- `Stage 3B`：3×3 Snapshot 与独立 Batch 行为不变；
- `TimelineDocument v1` 与 `RenderPlan v1` 不变；
- 不允许在未明确迁移窗口时更改 `jobs kind` 的既有用户可见语义。

## 9. 稳定错误码与状态映射（本阶段）

- HTTP 400：输入不合法、请求哈希不匹配、参数缺失；
- HTTP 409：任务状态不允许该动作（retry/cancel）；
- HTTP 404：请求/任务不存在；
- 409/500：Provider 能力与任务状态冲突时按现有映射返回。

## 10. 角色与职责边界

- **LiuWei（架构师）**：冻结规则、确认是否符合 `ARCHITECTURE.md`；批准/调整跨模块边界与阶段门禁。
- **ZhangSan（Core/数据/渲染）**：负责 Core 领域对象、数据库 v11、作业生命周期、验证规则与失败恢复。
- **YeJing（Contracts/Desktop/Electron/打包）**：负责 Contracts 导出与校验、IPC/Preload 限权、受限媒体与验证脚本。
- **LiuKeAi（独立验收）**：确认迁移、接口、隐私、恢复与安全门禁；若阶段中存在阻塞项，不得宣告通过。

角色定义是职责分工，不规定工作顺序。

## 11. Stage 4A 验收门禁（冻结版）

1. 文档化通过：`docs/STAGE4_CONTRACT_FREEZE.md`、`docs/STAGE4_DETAILED_DESIGN.md` 已有完整边界与验收项；
2. 与现有 Stage 3B 行为兼容声明可追溯（`git log` 与文档交叉引用）；
3. Provider 能力边界与敏感字段红线完成测试用例框架设计；
4. 数据库 v10→v11 策略与回滚策略明确；
5. Electron IPC 仅新增“生成素材请求读写”最小通道，且具备 `rendererSafe`；
6. 原型验证章节中，性能/精度指标、失败样例与回滚策略明确；
7. 未完成真实 Provider 验证时，必须在文档中标记 `UNVERIFIED`。

## 12. 立即待确认项（进入 Stage 4A 实施前）

1. 是否在 Stage 4A 同时覆盖 `tts + image + video`，或先仅 `tts + image`；
2. 迁移版本是否定为 `V11`（建议）及其兼容窗口；
3. 是否允许 Stage 4A 期间执行外部真实模型 dry-run；
4. 生成结果是否先入库为 `asset`，还是仅先入 `asset draft`；
5. 是否要求 Stage 4A 导出到桌面侧可见的素材卡片 UI。

> 以上第 1/2/3 点建议默认值：
> - 同期开启 `tts + image`（video 作为候选项在 `未验证` 标识下保留）；
> - 迁移版本设为 `V11`；
> - 无真实凭据时不发起真实模型调用。

## 13. 变更可否与否

本冻结文档通过前，LiuWei 仅批准：

- 方案方向与边界（阶段 4A）
- 不变量与验收门禁

不代表本阶段即刻实现，且不构成对实时 Provider 调用、预算或外传流程的豁免。
