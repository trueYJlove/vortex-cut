# Stage 4A 生产实现开发验证记录

> 日期：2026-08-18
> Gate：4A-4
> 状态：生产骨架实现与 Gate 4A-5 独立验收通过
> 执行模式：`simulation_only`
> Provider 调用：`0`

## 1. 验证结论

Stage 4A 已按冻结契约完成生产骨架实现，并通过开发侧门禁。覆盖范围是 SQLite v11、生成 Request/Task 领域、Jobs 生命周期、七个 Core API、Contracts DTO/guards、Desktop Core Client、Electron IPC 与 Preload 窄接口。

本结论不代表真实图片或 TTS 已生成：本阶段不创建媒体文件、不注册 Asset、不调用真实 Provider，也未接入 Renderer 正式导航。

## 2. 已实现范围

### 2.1 Core 与 SQLite

- 正式 SQLite v11 追加 `media_generation_requests` 与 `media_generation_tasks`；
- v1–v10 SQL/checksum 保持不变，v11 checksum 为 `fab9f1ecc013eb368a8d86e05514672be1019840d16c02914e7187cd92bc8a50`；
- Request 由触发器禁止 UPDATE/DELETE，`project_id + request_sha256` 唯一；
- Task 与 Job 一对一，`request_id + attempt` 唯一，同一直接父 Task 最多一个 retry；
- Request 幂等、queued cancel、终态 retry、running/cancelling 重启恢复为 interrupted；
- Task 与 Job 终态更新位于同一事务；generic Job retry/cancel 不能绕过生成域规则；
- simulation 结果固定为 `validated_without_media`，`output_asset_id` 为空。

### 2.2 API、Contracts 与 Desktop 边界

已实现七个独立 API：

1. prepare；
2. create；
3. 按项目列出 Request；
4. 获取单个 Request；
5. 列出 Request 的 Task；
6. Task retry；
7. Task cancel。

Contracts 新增独立 generation DTO、guards、parsers 和八个稳定错误码；当前 `CONTRACT_VERSION` 保持 `stage3b-v1`。Desktop Core Client、Electron `stage4-ipc.ts` 和 Preload 只暴露对应窄接口，不提供通用 invoke。

## 3. 隐私与安全验证

### 3.1 SQLite 面

- Prompt 只存 SHA-256，不存明文；
- Job input 只含不透明 request/task ID 和 `simulation_only`；
- 数据库断言确认 Prompt sentinel 与临时工作目录绝对路径不存在；
- 不保存 Provider payload/response、token、字幕/转写正文、stderr、command、traceback 或原始异常。

### 3.2 DTO / IPC / Renderer 面

- prepare/create 命令可瞬时携带 Prompt，但所有响应 guard 拒绝 Prompt、路径、正文、Provider 数据及原始错误字段；
- Core Client 与 Electron 在解析响应前执行敏感字段清理，并由 Contracts parser 白名单复核；
- IPC channel、ID、分页和 retry/cancel 空对象均为固定契约；
- 未修改 `apps/desktop/src/app/App.tsx`，没有 Stage 4A 正式 Renderer 入口。

### 3.3 Provider 面

- 全量 Core 回归显式排除唯一 `real_provider` 用例；
- simulation result 的 `provider_call_count` 为 0；
- 本阶段没有读取 Provider token/API key，没有网络外传；
- `provider_configs.kind` 未扩展。

## 4. 验证结果

### 4.1 Core

- 定向迁移/原型兼容回归：`26 passed`；
- 全量 Core（`-m "not real_provider"`）：`349 passed, 1 deselected`；
- 唯一 warning 为 Starlette/httpx 测试客户端弃用提示，不是业务回归失败；
- Ruff：通过；
- Pyright：`0 errors, 0 warnings, 0 informations`。

### 4.2 Contracts / Desktop / Electron

- Stage 4A 定向测试：4 个文件，`38 passed`；
- 全量 `pnpm test`：15 个文件，`118 passed`；
- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- `pnpm build`：通过。

### 4.3 原型兼容验证

生产 v11 落地后，原型工具改为直接验证正式 v11：

- 结构样例：14/14；
- v1–v10 checksum：10/10；
- 正式 v11 两表、四个索引与两个不可变触发器：通过；
- prepare p95：0.190 ms；create p95：18.060 ms；门槛均为 300 ms；
- Provider invocation 计数：0；
- Prompt、secret 与绝对路径 sentinel：均未进入数据库 dump。

性能仅表示本机 Python/SQLite 结构处理，不是生产 SLA。

## 5. 兼容性结论

- TimelineDocument v1、RenderPlan v1、Stage 3A/3B Snapshot/Preview/Batch/Retry 行为未修改；
- `jobs` 不增加 owner 列，`assets.storage_mode` 不扩展；
- `App.tsx`、README 未修改；
- 老客户端可忽略新增 API；只认识 v10 的旧 Core 仍会按既有未知版本策略拒绝 v11，回退应用必须同时恢复升级前数据库备份。

## 6. 未验证项

以下继续为 `UNVERIFIED`：

- 真实图片视觉质量与 Prompt 遵循度；
- 真实 TTS 音质、发音和语义准确性；
- 真实 Provider 的时延、费用、限流、取消和错误适配；
- 视频生成与批量生成；
- 正式 Asset 注册或 Timeline 集成；
- Renderer 正式 UI；
- Windows 打包、安装和启动后的 Stage 4A 正式业务交互。

## 7. Gate 判定

Gate 4A-4 的生产骨架实现与开发验证通过，Provider 调用数为 0；本记录形成时工作区未提交。

若后续要求真实 Provider、真实媒体、Asset 注册、正式 UI、Batch、Timeline 集成或 Windows 发布验收，必须开启新的 Gate，并在需要时重新冻结契约。

## Gate 4A-5 缺陷修复与独立复验补充（2026-08-18）

首次独立生产验收发现 Task/Job 单侧非终态漂移不能一致恢复。生产实现已做最小修复：可安全裁决的未完成 pair 在同一事务中双侧收敛为 `interrupted`，逐侧校验影响行数；终态与活动态冲突 fail-closed，不静默改写。

新增覆盖：

- Task queued + Job running；
- Task running + Job queued；
- Task running + Job cancelling；
- 第二侧更新失败时双侧事务回滚；
- terminal/active 冲突拒绝自动裁决。

独立复验结果：

- Stage 4A Core 定向：`23 passed`；
- Desktop/Contracts 定向：`38 passed`；
- Core 全量，排除 `real_provider`：`354 passed, 1 deselected`；
- Desktop/Contracts 全量：`118 passed`；
- Ruff、Pyright、lint、typecheck、build、`git diff --check`：全部通过；
- Provider 调用数：0。

Gate 4A-5 最终判定为通过。详细记录见 `docs/STAGE4A_PRODUCTION_INDEPENDENT_ACCEPTANCE.md`。
