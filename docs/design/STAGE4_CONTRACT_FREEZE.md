# 阶段 4A 契约冻结：生成式素材请求与任务生产骨架

> 负责人：LiuWei（架构师）
> 状态：已确认冻结；生产实现 Gate 4A-5 独立验收通过
> 日期：2026-08-18
> 文档基线：`5e9a59f docs: freeze Stage4A contract and detailed design`
> 依据：`ARCHITECTURE.md`、Stage 1–3B 冻结文档、`docs/requirements/STAGE4_REQUIREMENTS.md`

## 1. 冻结结论

Stage 4A 只建立生成式素材的最小生产领域骨架，并保持零 Provider 调用：

- 独立领域：`media_generation_request`（不可变事实）与 `media_generation_task`（执行尝试）；
- 首版生成类型仅为 `image | tts`；`video` 不进入首版枚举，统一返回不支持；
- 执行模式固定为 `simulation_only`，Provider 调用数必须为 `0`；
- SQLite v11 已作为独立生产迁移实现，只追加两张表、索引与不可变触发器；
- 复用 Jobs 的生命周期、重启恢复和 retry lineage，但不复用 Stage 3A/3B 的 Snapshot、API 或 Batch；
- 不修改 `TimelineDocument v1`、`RenderPlan v1`、Stage 1–3B 行为和当前 `CONTRACT_VERSION`；
- 本阶段不创建真实媒体文件、不注册正式 Asset、不接入 Renderer 正式导航或 Windows 正式产品入口。

本冻结不代表真实图片生成、TTS 音质或真实 Provider 适配已经通过。

## 2. 用户价值与范围

### 2.1 用户价值

- 先验证生成请求的幂等、恢复、重试和隐私边界，避免真实模型接入后再返工基础设施；
- 为后续图片与 TTS 生成提供可审计、可回放、可扩展的数据模型；
- 隔离生成域与现有剪辑、预览、导出域，降低对稳定生产链路的回归风险。

### 2.2 本阶段包含

1. `image | tts` 的结构化请求校验与 canonical hash；
2. 不可变 Request、可变 Task、Task 与 Job 一对一绑定；
3. running 任务的重启恢复和终态任务的 retry lineage；
4. SQLite v10→v11 兼容模型验证；
5. 安全摘要、结构校验准确率与本地数据库性能验证；
6. Contracts、Core、Desktop/Electron 的边界和文件所有权冻结。

### 2.3 明确不包含

- 真实 Provider 调用、密钥配置、能力探测、计费或限流适配；
- 视频生成、文本生成或长时段生成；
- 生成内容自动写入 Timeline、自动替换片段或触发导出；
- 正式素材注册、`assets.storage_mode` 扩展或 `asset_draft` 新状态机；
- 多项生成 Batch、Windows 安装包正式入口和最终用户 UI；
- 对 Stage 3A/3B Snapshot、Preview、Batch、Retry 或打包行为的修改。

## 3. 领域不变式

### 3.1 Request

`MediaGenerationRequest` 是不可变事实：

- 只含 `project_id`、`generation_kind`、`execution_mode`、`prompt_sha256`、白名单 `input_refs`、白名单参数、`request_sha256` 和创建时间；
- 不持有 `status`、`error`、`job_id` 或输出字段；
- 同一 `project_id + request_sha256` 必须幂等复用；
- 禁止 UPDATE 和 DELETE；
- Prompt 明文只允许作为 create/prepare 命令的瞬时输入在 Core 内计算摘要，不得写入 SQLite、Job、日志、响应 DTO 或验收证据。

### 3.2 Task 与 Job

`MediaGenerationTask` 表示一次执行尝试：

- 每个 Task 必须且只能绑定一个 Job，`task.job_id` 唯一；
- 由 Task 反向持有 `job_id`，v11 不给既有 `jobs` 表加 owner 列；
- 首次执行 `attempt=1`；重试创建新 Task 和新 Job，不原地复用；
- 重试保留 `retry_of_task_id`，同一直接父任务只能产生一个直接重试；
- 可重试终态固定为 `failed | cancelled | interrupted`；
- `queued | running | succeeded | failed | cancelled | interrupted` 是首版 Task 状态集合；
- Core 重启时，未完成的生成 Task/Job 进入 `interrupted`，不得自动重发；
- Task 与 Job 的错误只允许稳定错误码和去敏摘要，不允许原始异常。

### 3.3 结果

- `simulation_only` 可产生结构化结果摘要，但不得伪造真实模型媒体；
- `output_asset_id` 在 `simulation_only` 中保持空值；
- 后续真实生成结果必须通过现有 Asset 服务注册，不能由生成域直接插入 Asset；
- 当前 `assets.storage_mode = external | managed` 不变；若未来增加 `generated`，必须另行冻结契约和迁移。

## 4. API / DTO 契约

### 4.1 新增类型

- `MediaGenerationRequestId`
- `MediaGenerationTaskId`
- `GenerationKind = "image" | "tts"`
- `GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"`
- `GenerationExecutionMode = "simulation_only"`

`video` 不是首版合法枚举；收到该值返回 `GENERATION_KIND_UNSUPPORTED`。

### 4.2 新增独立 DTO

- `MediaGenerationPrepareInput`：瞬时命令；含 kind、Prompt、input refs 和白名单参数；
- `MediaGenerationPreparedRequest`：只返回 hash、规范化参数和安全摘要，不回显 Prompt；
- `MediaGenerationCreateInput`：与 prepare 相同的瞬时命令字段 + `request_sha256`；Core 重新规范化并复算 hash；
- `MediaGenerationRequest` / `MediaGenerationRequestSummary`；
- `MediaGenerationTask` / `MediaGenerationResultSummary`；
- `MediaGenerationRetryInput`。

不得向 Stage 3B DTO 追加可选字段。响应 DTO、日志和 Renderer 可读取对象不得包含 Prompt、字幕/转写正文、绝对路径、Provider 请求/响应体、密钥、stderr、command 或原始异常。

### 4.3 生产 API

- `POST /api/v1/projects/{project_id}/media-generation-requests/prepare`
- `POST /api/v1/projects/{project_id}/media-generation-requests`
- `GET /api/v1/projects/{project_id}/media-generation-requests`
- `GET /api/v1/media-generation-requests/{request_id}`
- `GET /api/v1/media-generation-requests/{request_id}/tasks`
- `POST /api/v1/media-generation-tasks/{task_id}/retry`
- `POST /api/v1/media-generation-tasks/{task_id}/cancel`

Stage 4A 不新增 Provider capability API，不修改 `provider_configs.kind`。真实外传前必须另行恢复 prepare → egress preview → consent 的两阶段确认，不得沿用本阶段的零外传假设。

### 4.4 稳定错误码

- `GENERATION_REQUEST_INVALID`（HTTP 400）
- `GENERATION_KIND_UNSUPPORTED`（HTTP 400）
- `GENERATION_INPUT_CHANGED`（HTTP 409）
- `GENERATION_HASH_MISMATCH`（HTTP 409）
- `GENERATION_OUTPUT_INVALID`（任务失败码）
- `GENERATION_INTERRUPTED`（任务中断码）
- `GENERATION_RETRY_NOT_ALLOWED`（HTTP 409）
- `GENERATION_TASK_NOT_FOUND`（HTTP 404）

Provider 相关错误码等真实适配契约冻结后再增加，本阶段不预占其行为。

## 5. SQLite v11 冻结契约

### 5.1 迁移规则

- v1–v10 SQL、顺序与 checksum 严格不变；
- v11 仅追加 `media_generation_requests`、`media_generation_tasks`、索引和 Request 不可变触发器；
- 应使用仓库既有 `_statements()` 逐句执行模式，不使用会破坏显式事务边界的 `executescript()`；
- 正式 v11 由 `Database.initialize()` 按既有备份、显式事务和 checksum 规则执行；原型工具仅使用临时数据库验证正式 v11，不接触用户数据库。

### 5.2 表变更清单

`media_generation_requests`：

- `id`, `project_id`, `generation_kind`, `execution_mode`；
- `prompt_sha256`, `input_refs_json`, `parameters_json`, `request_sha256`；
- `created_at`；
- `UNIQUE(project_id, request_sha256)`；
- UPDATE/DELETE 拒绝触发器。

`media_generation_tasks`：

- `id`, `request_id`, `job_id UNIQUE`, `attempt`, `status`, `stage`；
- `retry_of_task_id`, `output_asset_id`, `output_sha256`, `result_summary_json`；
- `error_code`, `error_message`, `created_at`, `updated_at`, `finished_at`；
- 已包含 `UNIQUE(request_id, attempt)` 与对非空 `retry_of_task_id` 的唯一约束。

索引：

- `idx_media_generation_requests_project`
- `idx_media_generation_tasks_request`
- `idx_media_generation_tasks_job`
- `uq_media_generation_tasks_retry_of`（仅非空父任务）

既有表不加列；尤其不修改 `jobs`、`assets`、Stage 3A/3B 各表。

## 6. 隐私、安全与 Provider 边界

1. Provider 调用数固定为 0；不得读取 token、API key 或 Provider 请求载荷；
2. Prompt 明文仅在调用栈内短暂存在并立即哈希，不持久化、不回显；
3. input refs 只允许不透明 ID，不允许路径或 URI；参数采用按 kind 的显式白名单；
4. Job `input_json` 只保存 task/request ID 与 `simulation_only`，不保存 Prompt 或媒体内容；
5. SQLite dump、日志和证据必须通过 Prompt sentinel、secret sentinel 与绝对路径缺失断言；
6. Renderer、IPC 和 Core Client 必须采用显式白名单解析，禁止透传未知字段；
7. 所有失败输出为稳定错误码与安全摘要，禁止原始异常对象。

## 7. 兼容与迁移

- API 前缀 `/api/v1`、`protocol_version=1` 和当前 `CONTRACT_VERSION` 不变；
- Timeline、Preview、Export、Rendition、Reframe 与 Batch 行为不变；
- 老客户端不知道新增 API，仍可正常工作；新 DTO 仅用于新增 API；
- 数据库升级前沿用现有备份机制；升级失败必须回滚整个 v11 事务；
- 已升级数据库不能由只认识 v10 的旧 Core 打开，这是当前严格未知版本拒绝策略的预期行为；回退应用时必须同时恢复升级前数据库备份。

## 8. 角色与互斥文件所有权

角色定义职责和边界，不规定串行、并行或 subagent 拓扑。

- **LiuWei（架构）**：契约、跨域不变量、Gate 和范围变更裁决；主要文档为本文件与详细设计。
- **ZhangSan（Core/数据/任务）**：`database.py`、新增 `media_generation.py`、`jobs.py`、Core routes 与 Core tests；不得修改 Desktop/Electron 文件。
- **YeJing（Contracts/Desktop/Electron）**：Contracts 及测试、Core Client、新增独立 `stage4-ipc.ts`、Preload 类型与 Stage 4A IPC/Preload 窄接口；不得修改 Core 数据库或领域服务。
- **LiuKeAi（独立验收）**：只读审查与独立验收证据；不修补被验收实现，不以开发者自测替代验收。

交叉点仅通过已冻结 DTO/API、错误码、Job 状态映射和安全摘要对接。若同一文件确需跨角色修改，先拆接口或由文件所有者集成，禁止并发写同一文件。

## 9. 门禁

### Gate 4A-1：契约与详细设计

- 范围、数据模型、API/DTO、SQLite v11、隐私红线、角色边界已冻结。

### Gate 4A-2：隔离原型

- 隔离原型当时仅操作临时数据库，未修改生产迁移；
- 结构校验样例全部匹配；
- v1–v10 checksum 不变，隔离模型的 v11 表/触发器存在；
- Request 幂等、不可变，恢复与 retry lineage 通过；
- prepare/create p95 均不高于 300 ms；
- Provider 调用数为 0，安全 sentinel 与绝对路径均不进入数据库。

### Gate 4A-3：独立验收（已通过）

- LiuKeAi 已按独立清单复跑测试并审查证据；
- 明确标注真实图片质量、TTS 质量、真实 Provider、视频生成和 Windows 正式交互均为 `UNVERIFIED`；
- 后续生产实现必须获得新的范围授权；该授权已于 Gate 4A-4 启动前取得。

### Gate 4A-4：生产实现（开发验证通过）

- 正式 SQLite v11、`MediaGenerationService`、七个 Core API、独立 Contracts DTO/guards、Core Client、Electron IPC 与 Preload 窄接口已实现；
- `execution_mode` 仍固定为 `simulation_only`，生产任务结果仅为 `validated_without_media`，`provider_call_count=0`；
- `App.tsx` 与正式导航未接入，README、Timeline、RenderPlan、Stage 3A/3B Snapshot/Preview/Batch/Retry 均未修改；
- Core 回归显式排除 `real_provider` 后为 `354 passed, 1 deselected`；Desktop/Contracts 为 `118 passed`；Ruff、Pyright、lint、typecheck、build 与 `git diff --check` 均通过；
- 真实图片/TTS 内容质量、Provider 时延/费用/错误、视频生成及 Windows 正式业务交互继续为 `UNVERIFIED`。

### Gate 4A-5：独立生产验收（通过）

- Task/Job 单侧非终态漂移恢复缺陷已最小修复并独立复验；
- `queued/running`、`running/queued`、`running/cancelling` 均双侧收敛为 `interrupted`；
- 不可安全裁决状态 fail-closed，双写失败保持事务回滚；
- Stage 4A Core 定向 `23 passed`，Core 全量排除 `real_provider` 后 `354 passed, 1 deselected`；Desktop/Contracts `118 passed`；
- Provider 调用数为 0，README、`App.tsx` 与 Stage 1–3B 冻结行为未修改。

## 10. 变更控制

以下任一变化必须重新冻结，不得作为“小实现调整”直接带入：

- 引入真实 Provider 或任何网络外传；
- 新增 `video`、批量生成或正式 Asset 注册；
- 修改 Timeline、Stage 3A/3B、`provider_configs` 或 `assets.storage_mode`；
- 把 Prompt 明文持久化或返回 Renderer；
- 改变 v11 表归属、Request 可变性、Task/Job 一对一或 retry lineage。
