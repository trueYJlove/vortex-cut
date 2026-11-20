# 阶段 4A 详细设计：生成式素材请求与任务生产骨架

> 角色：LiuWei（架构师）
> 状态：已确认；生产实现 Gate 4A-5 独立验收通过
> 日期：2026-08-18
> 上位契约：`docs/design/STAGE4_CONTRACT_FREEZE.md`

## 1. 设计目标

Stage 4A 用最小的独立生产领域实现 `image | tts` 生成任务基础设施，但不提供真实生成业务。设计目标为：

1. Request 是不可变、可幂等复用的输入事实；
2. Task 是一次执行尝试，复用 Job 生命周期并保留 retry lineage；
3. Prompt、媒体正文、路径和凭据不进入持久层或响应面；
4. 正式 SQLite v11 可以从 v10 基线安全追加；
5. 不侵入 Stage 1–3B、Timeline、Preview、Export 或 Batch。

## 2. 现有能力与复用边界

### 2.1 可复用

- `Database.initialize()` 的迁移 checksum、备份、未知版本拒绝和逐句事务执行；
- `jobs` 的状态、resource class、result/error 安全摘要、重启恢复与 runner 扩展方式；
- Core `/api/v1`、稳定错误映射、Contracts guard、Core Client 与独立 IPC 模式；
- 现有 Asset 服务作为未来真实结果的唯一注册入口。

### 2.2 不复用或不修改

- 不把生成请求塞进 `candidate_generations`；
- 不借用 Stage 3A/3B Snapshot、Batch 或 retry 表；
- 不修改 `TimelineDocument v1`、`RenderPlan v1`；
- 不扩展 `provider_configs.kind` 或执行 capability probe；
- 不增加 `generated` storage mode，不引入 `asset_draft`；
- 隔离原型代码保留在 `tools/prototypes`；生产 `database.py`、`app.py` 和 Contracts 只承载冻结后的正式 v11/API/DTO，不导入原型模块。

## 3. 领域设计

### 3.1 Prepare

输入：

- `project_id`：合法不透明 ID；
- `generation_kind`：`image | tts`；
- `prompt`：1–4000 字符的瞬时命令输入；
- `input_refs`：1–32 个唯一不透明 ID，排序后参与哈希；
- `parameters`：按 kind 白名单校验。

图片参数白名单：

- `width`, `height`：64–4096 整数；
- `style_preset_id`：可选不透明 ID；
- `seed`：可选 0–2^31-1 整数。

TTS 参数白名单：

- `voice_preset_id`：必填不透明 ID；
- `language`：首版 `zh-CN | en-US`；
- `speed_milli`：500–2000 整数。

Canonical facts：

```json
{
  "schema_version": 1,
  "project_id": "opaque-id",
  "generation_kind": "image-or-tts",
  "execution_mode": "simulation_only",
  "prompt_sha256": "sha256:<hex>",
  "input_refs": ["sorted-opaque-id"],
  "parameters": {}
}
```

使用 UTF-8、key 排序和无多余空白的 canonical JSON 计算 `request_sha256`。Prepare 响应不含 Prompt 明文。

### 3.2 Create 与幂等

- Core 重新规范化并核对 prepared facts 和 `request_sha256`；
- `UNIQUE(project_id, request_sha256)` 命中时返回既有 Request，并标识复用；
- 首个 Task 必须是 `attempt=1`，同时创建独立 Job；
- Request 创建和 Task/Job 创建应分别在明确事务内完成；正式实现应处理并发唯一约束冲突并回读既有记录。

### 3.3 Request / Task 状态归属

Request 不含 status。Task 是状态事实，Job 是通用调度事实：

```text
Request (immutable)
  ├─ Task attempt 1 ── Job A
  └─ Task attempt 2 ── Job B   retry_of -> attempt 1
```

Task 和 Job 状态更新必须位于同一事务；正式实现通过独立领域方法封装状态映射，避免双写漂移。

### 3.4 恢复与重试

- 启动恢复查找 Task 为 running 或其 Job 为 running/cancelling 的记录；
- Task 与 Job 一并转为 interrupted，使用安全错误码/摘要；
- 不自动重发；
- 仅 failed/cancelled/interrupted 可重试；
- retry 新建 Task、Job，`attempt+1`，保留直接父 task ID；
- 同一父任务最多创建一个直接 retry，正式 v11 用唯一约束兜底。

### 3.5 Cancel

Stage 4A 不实现运行中 Provider 取消，生产骨架只定义：

- queued Task 可原子转 cancelled；
- 对 running Task 的取消语义保持未实现，返回稳定冲突错误；
- 真实 Provider 的 cancelling、超时与补偿必须在后续外传契约中重新冻结。

## 4. SQLite v11 设计

### 4.1 迁移实现

- 增加 `V11_VERSION`、`V11_SQL` 和 `MIGRATIONS` 末尾条目；
- 不改 v1–v10 任一字符串或 checksum；
- 使用 `_statements(V11_SQL)` 逐句执行，保持现有 `BEGIN/COMMIT/ROLLBACK` 语义；
- v11 只建新表、索引和触发器，不做旧表 compatibility ALTER；
- 初始化前由现有机制创建备份，失败恢复备份。

### 4.2 表结构

`media_generation_requests`：

```text
id PK
project_id FK projects
generation_kind CHECK image|tts
execution_mode CHECK simulation_only
prompt_sha256
input_refs_json
parameters_json
request_sha256
created_at
UNIQUE(project_id, request_sha256)
```

正式 SQL 的类型约束为 `CHECK(generation_kind IN ('image','tts'))`。

Request 增加禁止 UPDATE、DELETE 的触发器。

`media_generation_tasks`：

```text
id PK
request_id FK media_generation_requests
job_id NOT NULL UNIQUE FK jobs
attempt CHECK >= 1
status CHECK queued|running|succeeded|failed|cancelled|interrupted
stage
retry_of_task_id NULL FK media_generation_tasks
output_asset_id NULL FK assets
output_sha256 NULL
result_summary_json NULL
error_code/error_message NULL
created_at/updated_at/finished_at
UNIQUE(request_id, attempt)
UNIQUE(retry_of_task_id) where retry_of_task_id is not null
```

采用 Task→Job 单向 FK；不向 jobs 增加 `media_generation_task_id`。Request 使用默认 RESTRICT 语义，不使用 `ON DELETE CASCADE`，以符合不可删除规则。

### 4.3 JSON 和安全约束

SQLite 只能保存：

- Request：排序后的 input ID、按 kind 校验后的参数；
- Task：结果 hash 和显式白名单 result summary；
- Job input：`media_generation_task_id`、`request_id`、`execution_mode`。

不保存 Prompt、路径、URI、Provider payload/response、token、字幕/转写正文、stderr、command 或 traceback。

## 5. Core 服务与 Job runner

生产实现新增 `MediaGenerationService`，负责：

- `prepare_request`
- `create_request_and_task`
- `list/get_request`
- `list_tasks`
- `cancel_queued_task`
- `retry_task`
- `recover_interrupted_tasks`

Jobs 增加 `kind/type = media_generation`。现有 `jobs` 字段允许新增字符串值，无需迁移旧表；但 runner 注册和结果序列化必须是独立分支，不能更改既有 runner 语义。

simulation runner 只验证输入 hash、状态迁移和安全摘要：

```text
queued -> running -> succeeded|failed
              restart -> interrupted -> explicit retry
```

不得生成假媒体并宣称模型成功。`simulation_only` 成功结果固定表达为 `validated_without_media`；失败/恢复路径使用稳定 generation 错误码与安全摘要。

## 6. API 与 Contracts

### 6.1 路由

采用上位契约冻结的独立 request/task 路由。Retry/Cancel 以 task ID 为主语，避免一个 Request 有多次尝试时语义不明确。

### 6.2 请求和响应

- Request models 使用 `extra=forbid`；
- create 输入复用 prepare 的瞬时命令字段并携带 `request_sha256`；Core 重新规范化并核对 hash；
- Prompt 只存在于 prepare/create 命令输入，在 Core 哈希后立即丢弃；
- 所有响应由白名单字段重新构造，不从数据库行或异常对象直接透传；
- 列表使用现有稳定分页结构；
- 旧客户端和旧接口无字段变化。

### 6.3 Contracts guard

TypeScript 新增独立 guard/parse 函数并覆盖：

- kind/status/execution mode 枚举；
- sha256 格式、ID、参数边界；
- unknown/sensitive keys 拒绝；
- 响应不含 Prompt、路径、正文、Provider 数据或 raw error；
- Stage 3B DTO 解析回归。

## 7. Desktop / Electron 边界

- Core Client 新增独立方法，不修改 Stage 3B 方法签名；
- Electron 使用新增 `stage4-ipc.ts` 与命名空间化 channel；
- Main 进程只转发明确命令并返回 renderer-safe DTO；
- Preload 只暴露 prepare/create/list/get/retry/cancel 的窄接口；
- Prompt 可由用户在输入控件中编辑，但不得从 Core 响应回显、缓存到持久 store、写日志或写验收截图；
- Stage 4A 不接入 Renderer 正式导航和 Windows 正式业务入口；`App.tsx` 保持不变。

## 8. 文件所有权与集成边界

角色定义不规定执行顺序。

### ZhangSan：Core / SQLite / Jobs

写集合：

- `services/core/src/aivs_core/database.py`
- `services/core/src/aivs_core/media_generation.py`（新增）
- `services/core/src/aivs_core/jobs.py`
- `services/core/src/aivs_core/app.py`
- 对应 Core tests

交付边界：只消费冻结的字段和错误码；不修改 Contracts/Desktop；不直接注册 Asset；不调用 Provider。

### YeJing：Contracts / Desktop / Electron

写集合：

- `packages/contracts/src/index.ts` 与对应测试
- `apps/desktop/src/lib/core-client.ts` 与对应测试
- `apps/desktop/electron/main/stage4-ipc.ts`（新增）
- 必要的 Preload 窄接口、固定 channel 与测试；不新增 Stage 4A Renderer 组件

交付边界：不修改数据库/Core 领域；不把 Prompt、路径或原始错误暴露到响应/日志；不接入正式打包入口。

### LiuWei / LiuKeAi

- LiuWei：维护冻结文档、跨模块接口和 Gate；
- LiuKeAi：在实现者自测之后独立复跑，不修改被验收代码。

若文件集合冲突，由文件所有者集成；禁止以并发改同一文件解决接口分歧。

## 9. 隔离原型与实测结果

原型文件：

- `tools/prototypes/stage4a_generation_model.py`
- `services/core/tests/prototype/test_stage4a_generation_model.py`

原型工具只使用临时数据库，并复用 `Database.initialize()` 验证正式 v11；v1–v10 SQL/checksum 未修改，工具不接触用户数据库或调用业务路由。

2026-08-18，200 次本机模拟结果：

- 结构校验：14/14 匹配，0 false accept，0 false reject；
- 此处“准确率 100%”只指预定义结构样例匹配，不代表图片/TTS 内容质量；
- prepare：p50 0.095 ms，p95 0.197 ms；
- create：p50 11.448 ms，p95 13.903 ms；
- 门槛：两项 p95 ≤ 300 ms；
- v1–v10 checksum 验证 10/10，正式 v11 两表、必要索引和 Request UPDATE/DELETE 不可变触发器通过；
- Request 幂等、running→interrupted、attempt 2、retry lineage、新 Job、非终态/重复 retry 拒绝均通过；
- Prompt/secret sentinel 与工作目录绝对路径未出现在 SQLite dump，携带 secret 的输入被拒绝；
- Provider invocation 计数为 0。

详细安全结果见 `docs/design/records/STAGE4A_PROTOTYPE_VALIDATION.md`。性能数字是单机隔离原型数据，不是生产 SLA。

## 10. 测试拆分

### 10.1 Core / 数据库

- v10→v11、v1–v10 checksum、未知版本拒绝、失败事务回滚；
- 表/索引/触发器/唯一约束；
- canonical hash、输入白名单、Request 幂等与不可变；
- Task/Job 原子双写、恢复、取消、重试并发和 lineage；
- dump/log/error 安全断言。

### 10.2 Contracts / Desktop / Electron

- DTO guard 正反例与 Stage 3B 回归；
- Core Client 路由和安全解析；
- IPC channel 白名单、错误映射和 raw error 拒绝；
- Renderer 不显示/持久化 Prompt、路径、正文或 Provider 数据；
- 原型不可从正式导航触达。

### 10.3 集成与独立验收

- 同一 Request 的并发幂等；
- running 恢复后不自动执行；
- retry 创建新 Task/Job；
- Provider 调用计数 0；
- SQLite/DTO/log/Renderer 四面隐私检查；
- Stage 1–3B 回归不变。

## 11. 开发切片（不规定人员执行顺序）

- **切片 A：生产 v11 与领域服务**——两表、约束、Request/Task 服务；
- **切片 B：Contracts 与 API**——独立 DTO、guards、routes、错误映射；
- **切片 C：Jobs 生命周期**——runner、恢复、取消、retry lineage；
- **切片 D：Desktop 安全边界**——Core Client、IPC、Preload 窄接口；不接正式导航；
- **切片 E：安全与回归**——隐私、迁移、Stage 1–3B、Provider=0；
- **切片 F：独立验收**——按冻结清单复跑并形成结论。

切片存在接口依赖，但不约束团队必须串行或并行；集成必须满足对应 Gate。

## 12. 风险与退路

1. **双状态漂移**：Task/Job 未原子更新。退路：单一 service + 单事务 + 恢复一致性扫描；
2. **幂等并发**：先查后写竞争。退路：数据库唯一约束 + 冲突回读；
3. **Prompt 泄漏**：日志或 Renderer 回显。退路：命令/响应类型分离 + 白名单构造 + sentinel 测试；
4. **迁移锁与回滚**：v11 半完成。退路：逐句事务执行 + 既有备份恢复；
5. **范围漂移**：提前引入视频、Provider、Asset 或 Batch。退路：变更必须重新冻结；
6. **原型数据误读**：把结构准确率当成模型精度。退路：所有报告显式列出 UNVERIFIED。

## 13. ZhangSan / YeJing 技术可行性确认

### ZhangSan（Core / SQLite / Jobs）

结论：**已按冻结条件实现并通过开发验证**。现有迁移器和 Jobs 模型已支撑两表方案；Task 反向持有唯一 `job_id`，未修改 jobs owner。生产实现已覆盖唯一约束、Task/Job 原子双写、并发幂等和重启一致性恢复。不得在本切片扩展 Asset storage mode、调用 Provider 或侵入 Timeline/Stage 3 Batch。

### YeJing（Contracts / Desktop / Electron）

结论：**已按冻结条件实现并通过开发验证**。独立 DTO、Core Client 方法、`stage4-ipc.ts` 与 Preload 窄接口未改变 Stage 3B 契约。Prompt 只允许作为用户发起的命令输入瞬时传到 Core；响应、日志、持久 store、截图和 renderer-safe 对象不得回显。本阶段没有新增 Stage 4A Renderer UI，亦不进入 Windows 正式业务交互与发布验收。

### 交叉边界

两侧只通过冻结 API/DTO、错误码、Job 状态和安全摘要对接。Core 不向 Electron 暴露数据库行或原始异常；Desktop 不自行计算权威状态或绕过 Core hash 复核。以上结论确认的是技术可实现性，不授权生产编码。

## 14. Gate 与后续

- Gate 4A-1：已完成，文档已确认；
- Gate 4A-2：隔离原型实测通过；
- Gate 4A-3：LiuKeAi 独立复跑与边界审查通过；
- Gate 4A-4：已获明确授权；生产骨架开发验证通过；
- Gate 4A-5：Task/Job 漂移恢复缺陷已修复，独立故障注入、全量回归与静态构建门禁通过。

真实图片/TTS 内容质量、Provider 延迟/费用/错误、视频生成和 Windows 正式交互继续标记 `UNVERIFIED`。
