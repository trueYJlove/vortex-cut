# Stage 4A 生产实现独立验收记录（LiuKeAi）

> 状态：Gate 4A-5 通过（阻塞缺陷已修复并独立复验）
> 日期：2026-08-18
> 基线：`master` / `5e9a59f docs: freeze Stage4A contract and detailed design`
> 验收方式：只读审查、临时数据库故障注入、独立复跑；未修改生产实现，未提交
> Provider 调用数：0

## 1. 验收结论

Gate 4A-5 **通过**。

首次独立验收曾确认生成 Task/Job 在单侧非终态漂移时不能一致恢复，因此 Gate 被阻塞。ZhangSan 随后完成最小修复：恢复扫描在同一事务内将可安全裁决的未完成 pair 双侧收敛为 `interrupted`，逐侧校验影响行数，并对终态与活动态冲突执行 fail-closed 回滚。

LiuKeAi 已独立重放原始故障注入，`queued/running`、`running/queued`、`running/cancelling` 三种状态均收敛为 `interrupted/interrupted`；事务回滚和不可安全裁决状态测试通过。定向测试、全量回归、静态检查与构建均通过，Provider 调用数保持 0。

## 2. 范围与边界

- [x] 工作区差异与 Gate 4A-4 预期交付一致，未发现额外未知实现；
- [x] README 未修改；
- [x] `apps/desktop/src/app/App.tsx` 未修改；
- [x] 未接入 Renderer 正式导航或 Windows 正式业务入口；
- [x] 未修改 TimelineDocument v1、RenderPlan v1、Stage 3A/3B Snapshot/Preview/Batch/Retry；
- [x] 未扩展 `provider_configs.kind` 或 `assets.storage_mode`；
- [x] 未生成真实媒体，未注册 Asset；
- [x] 本轮未提交。

## 3. SQLite v11 与数据模型

- [x] v1–v10 SQL/checksum 保持冻结；
- [x] v11 checksum 为 `fab9f1ecc013eb368a8d86e05514672be1019840d16c02914e7187cd92bc8a50`；
- [x] 正式新增 `media_generation_requests`、`media_generation_tasks`；
- [x] Request UPDATE/DELETE 触发器有效；
- [x] `UNIQUE(project_id, request_sha256)`、`UNIQUE(request_id, attempt)`、Task `job_id UNIQUE` 与非空 `retry_of_task_id` 唯一约束存在；
- [x] 既有 `jobs`、`assets` 和 Stage 3 表未增加 Stage 4A 列；
- [x] v10→v11、未知版本拒绝、checksum 与迁移回归测试通过。

## 4. 生命周期审查

### 4.1 已通过项

- [x] prepare/create 重新规范化并复算 canonical hash；
- [x] 同一 `project_id + request_sha256` 幂等复用 Request；
- [x] Request、首个 Task 与 Job 在同一事务内创建；
- [x] queued cancel 原子更新 Task/Job；
- [x] running cancel 被 `JOB_INVALID_STATE` 拒绝；
- [x] retry 创建新 Task、新 Job、`attempt+1` 并保留 lineage；
- [x] 非终态与重复 retry 被拒绝；
- [x] 通用 Job retry/cancel 不能绕过生成域独立路由；
- [x] finish 双写任一侧不满足预期状态时回滚整个事务；
- [x] 正常 Task=running、Job=running 的重启恢复会把两者原子转为 interrupted，且不自动重发。

### 4.2 已解除：单侧非终态漂移恢复一致性

位置：`services/core/src/aivs_core/media_generation.py` 的 `recover_interrupted_tasks()`。

首次验收发现扫描虽命中漂移 pair，却只更新原本处于 `running/cancelling` 的一侧。修复后，恢复逻辑：

1. 只对 Task=`queued|running` 且 Job=`queued|running|cancelling` 的未完成 pair 自动裁决；
2. 在同一 `BEGIN IMMEDIATE` 事务中将 Task 和 Job 双侧更新为 `interrupted`；
3. 每次 UPDATE 都要求实际影响 1 行，否则回滚；
4. 对“终态 + 活动态”等不可安全裁决组合抛出稳定内部失败并保持原数据；
5. 返回实际成功收敛的 pair 数。

独立临时数据库故障注入结果：

| 注入前 Task | 注入前 Job | 恢复返回数 | 恢复后 Task | 恢复后 Job |
|---|---|---:|---|---|
| queued | running | 1 | interrupted | interrupted |
| running | queued | 1 | interrupted | interrupted |
| running | cancelling | 1 | interrupted | interrupted |

自动化测试同时验证 Task 更新被触发器拒绝时 Job 更新随事务回滚，以及 terminal/active 冲突不会被静默覆盖。原阻塞缺陷已解除。

## 5. API、Contracts、Desktop 与 Electron

- [x] 七个独立生产 API 与七个固定 IPC channel 一致；
- [x] retry/cancel 固定发送 `{}`；
- [x] Prompt 仅允许出现在 prepare/create 瞬时命令输入；
- [x] Core Client 与 Electron Main 均先清理响应敏感字段，再执行严格 parser；
- [x] Contracts guards 拒绝未知字段及 Prompt、路径、正文、Provider 数据、stderr、command、traceback 等敏感字段；
- [x] Preload 仅暴露七个窄方法，无通用 invoke；
- [x] `CONTRACT_VERSION` 保持 `stage3b-v1`；
- [x] Stage 3B 3×3 锚点等既有 guard 回归通过；
- [x] `GENERATION_INPUT_CHANGED` 作为稳定预留码存在；冻结文档未定义其与首版 hash mismatch 相区别的触发流程，本次不判为缺陷。

## 6. 四面隐私与 Provider 边界

- [x] SQLite：Request/Task/Job 不保存 Prompt 明文、绝对路径、正文、Provider 请求/响应或密钥；
- [x] DTO：响应为显式白名单投影，不返回 Prompt、绝对路径、正文或原始异常；
- [x] 日志/错误：使用稳定错误码与安全摘要；
- [x] Renderer/Electron：响应先去敏再解析，Stage 4A 未进入正式 UI；
- [x] 生产生成模块未导入网络客户端或真实 Provider SDK；
- [x] 全量 Core 测试明确使用 `-m "not real_provider"`；
- [x] simulation 结果固定为 `validated_without_media`，`provider_call_count=0`；
- [x] 本轮未读取 Provider token、API key 或请求载荷，真实 Provider 调用数为 0。

## 7. 独立复跑结果

### 7.1 定向测试

- Stage 4A Core/迁移/API/原型：`23 passed`；
- Contracts/Core Client/IPC/Preload：4 个文件，`38 passed`。

### 7.2 全量回归

- Core：`354 passed, 1 deselected`，其中 deselected 为显式排除的 `real_provider`；
- Desktop/Contracts：15 个文件，`118 passed`。

pytest 在退出清理系统临时目录符号链接时出现一次 Windows `PermissionError` 提示；测试进程退出码为 0，全部断言已完成，不影响上述结果。

### 7.3 静态检查与构建

- Ruff：通过；
- Pyright：0 errors / 0 warnings；
- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- `pnpm build`：通过；
- `git diff --check`：通过（仅有 Git 的 LF→CRLF 工作区提示，无 whitespace error）。

## 8. 未验证项

以下继续为 `UNVERIFIED`：

- 真实图片生成质量；
- 真实 TTS 音质和语义准确性；
- 真实 Provider 时延、费用、限流与错误适配；
- 视频生成；
- 正式 Asset 注册与 Timeline 集成；
- Windows 安装包中的正式 Stage 4A 用户交互。

## 9. Gate 判定与后续限制

Gate 4A-5 最终判定：**通过**。

本结论仅覆盖冻结的 Stage 4A `simulation_only` 生产骨架，不扩展为真实生成能力授权。后续仍须遵守：

1. Provider 调用数保持 0，除非另行冻结真实外传、consent、凭据和错误适配契约；
2. 不以本 Gate 通过宣称真实图片或 TTS 质量已验证；
3. 视频生成、Batch、正式 Asset 注册、Timeline 自动集成和 Windows 正式入口均需新的范围确认；
4. 提交前保持 README、`App.tsx` 与 Stage 1–3B 冻结行为不变。
