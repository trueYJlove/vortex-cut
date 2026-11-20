# Stage 4B 隔离交互原型验证记录

> 负责人：LiuWei（架构师）
> 独立边界复核：LiuKeAi
> 日期：2026-08-18
> 对应门禁：Gate 4B-2
> 结论：通过；未授权 Gate 4B-3 生产实现

## 1. 验证目的

本记录验证 `docs/design/STAGE4B_CONTRACT_FREEZE.md` 与 `docs/design/STAGE4B_DETAILED_DESIGN.md` 冻结的生成任务验证工作台交互模型是否可落地。验证只使用隔离 TypeScript 控制器与 fake Desktop API，不接入正式 Renderer，不修改 Core、SQLite、Contracts、Electron IPC 或 Preload。

验证目标：

1. form → prepare → confirm → create → terminal 状态链可实现；
2. 字段变化、关闭与项目切换使旧确认失效；
3. 快速模拟任务不会因 Job 订阅竞态丢失终态；
4. Task API 而非 Job event 是生成状态权威；
5. cancel/retry 状态门禁与 attempt lineage 可正确编排；
6. Prompt、绝对路径和原始异常不进入安全证据；
7. Provider、媒体写入和 Asset 注册调用数为 0；
8. 原型不进入生产构建依赖。

本验证不代表正式 UI、真实 Windows 安装交互或真实 Provider 已通过。

## 2. 原型范围

新增隔离模型：

```text
tools/prototypes/stage4b_generation_workbench_model.ts
```

新增专用测试：

```text
apps/desktop/tests/stage4b-workbench-prototype.test.ts
```

生产代码未导入 `Stage4BWorkbenchPrototype`。`App.tsx`、Core、SQLite、Contracts、`stage4-ipc.ts`、Preload、Core Client 和打包配置均未修改。

原型使用与冻结契约同构的最小类型，不向 `packages/contracts` 导出任何新类型。正式生产实现仍须复用现有 Contracts DTO 和七个 Preload 方法。

## 3. 交互模型结论

### 3.1 Prepare 与确认失效

验证通过：

- Prepare 后只产生 kind、execution mode、Prompt 字符数/hash、input ref 数量、白名单参数和 Request hash；
- 安全确认对象不含 Prompt 正文；
- 任一字段变化立即清除 prepared；
- 无 prepared 时 create 被拒绝；
- Renderer 不需要也不应重写 Core canonical hash 算法。

### 3.2 Create 与 Prompt 生命周期

验证通过：

- Create 使用产生确认时的原 draft 与 Core `request_sha256`；
- Create 成功后清除 draft Prompt 和 prepared；
- 安全证据只保留合成 ID、状态、Provider=0、无媒体和无 Asset 结论；
- Prompt 不进入 Request/Task 历史模型。

### 3.3 快速终态竞态

验证通过，冻结生产编排顺序可行：

1. Create 返回；
2. 立即回读 Task；
3. 若仍非终态，建立 Job 订阅；
4. 订阅建立后第二次回读 Task；
5. Job event 只触发 Task 回读；
6. Task 进入终态后清理订阅。

专用用例模拟第一次回读为 `running`、订阅建立前后任务转为 `succeeded`，第二次回读能稳定得到终态。

### 3.4 Cancel、Retry 与 lineage

验证通过：

- 只有 `queued | running` 可 cancel；
- 只有 `failed | cancelled | interrupted` 可 retry；
- retry 后保留 attempt 1，并新增 attempt 2；
- attempt 2 的 `retry_of_task_id` 指向 attempt 1；
- UI 模型不乐观伪造权威终态，每次操作后重新读取 Task。

### 3.5 项目隔离与迟到响应

验证通过：

- 项目切换会清理 Prompt、prepared、选中项和 Job 订阅；
- 旧项目的迟到 Request 响应不会覆盖新项目状态；
- 当前项目 Asset ID 白名单拒绝跨项目输入引用；
- 生产实现仍不得把 Renderer 校验视为 Core 安全权威。若后续证明必须增加 Core 归属校验，须返回 Gate 4B-1 重新冻结，不得隐式修改后端。

## 4. 隐私与安全验证

测试使用合成 sentinel，验证原始异常同时携带：

- Prompt sentinel；
- 合成绝对路径 sentinel；
- raw stack/token sentinel。

结果：三类 sentinel 均未进入 `safeEvidence()`；错误被统一映射为安全文案。

静态检查结果：

- 生产代码未导入 Stage 4B 隔离原型；
- 原型无 OpenAI/Anthropic、HTTP client、`fetch`、Provider SDK、`provider_configs` 或 `provider_invocations` 依赖；
- 未读取或输出 Provider token、API key、Authorization 或 Provider 请求载荷；
- 未生成媒体，未注册 Asset，未修改 Timeline；
- Provider 调用计数：`0`；
- 媒体写入计数：`0`；
- Asset 注册计数：`0`。

## 5. 测试结果

### 5.1 Stage 4B 原型定向

```text
1 test file passed
8 tests passed
```

覆盖：

1. Prepare 安全确认与字段变化失效；
2. Create 后 Prompt 清理与快速终态立即回读；
3. 订阅前完成竞态；
4. Job event 只触发 Task 权威回读；
5. Cancel/Retry 状态门禁与 attempt lineage；
6. 项目切换、迟到响应和订阅清理；
7. Prompt/路径/raw error sentinel 隔离；
8. Provider/媒体/Asset 三项调用计数为 0。

### 5.2 Desktop / Contracts 全量

```text
16 test files passed
126 tests passed
```

该结果包含新增的 8 个原型用例；原 Stage 4A 基线的 118 个 Desktop/Contracts 用例全部保持通过。

### 5.3 Stage 4A Core 定向回归

```text
23 tests passed
1 warning
```

覆盖 Stage 4A media generation service、SQLite v11 migration、API 与隔离模型。pytest 断言全部完成且退出码为 0。测试进程退出清理 Windows 临时目录符号链接时出现既有 `PermissionError` 提示，不影响断言或 Gate 结论。

### 5.4 静态与构建

- Desktop typecheck：通过；
- Desktop lint：通过；
- Desktop production build：通过；
- `git diff --check`：通过；
- 生产源码原型依赖扫描：通过；
- 原型网络/Provider 依赖扫描：通过。

## 6. LiuKeAi 独立边界复核

### 范围

- [x] 只新增隔离原型、专用测试和 Stage 4B 文档；
- [x] 未修改正式 Renderer；
- [x] 未修改 Core、SQLite、Contracts、IPC、Preload 或打包；
- [x] 未修改 README；
- [x] 未引入真实 Provider、媒体、Asset、Timeline 或 Batch。

### 契约

- [x] `simulation_only` 未扩展；
- [x] API/DTO/IPC/Preload 增量为 0；
- [x] SQLite 保持 v11；
- [x] `CONTRACT_VERSION` 未修改；
- [x] Task 响应保持状态权威，Job event 只作为刷新提示。

### 隐私

- [x] Prompt 只存在于原型表单内存及 fake 命令参数；
- [x] 安全确认、历史与证据不含 Prompt；
- [x] 原始异常、绝对路径和 sentinel 不泄漏；
- [x] Provider 调用数为 0；
- [x] 无 token/API key/请求载荷读取或输出。

### 可落地性

- [x] 快速终态竞态有明确且经过测试的解决路径；
- [x] Cancel/Retry 和 lineage 可由现有 API 支撑；
- [x] 项目切换和迟到响应有隔离机制；
- [x] 无需增加 Task 单项 API、聚合 API 或数据库字段。

独立复核结论：Gate 4B-2 范围适中、与 Stage 1–4A 契约兼容、生产实现可落地。

## 7. 未验证事项

以下继续标记 `UNVERIFIED`：

- 正式 `App.tsx` 入口和 React 组件；
- Renderer 视觉、键盘、焦点与无障碍交互；
- 正式 Electron + Sidecar E2E；
- Windows 打包、NSIS 安装和安装版本业务交互；
- 真实图片、TTS 内容质量；
- 真实 Provider、网络、凭据、费用和限流；
- 媒体落盘、Asset 注册和 Timeline 装配；
- 视频生成、Batch、脚本/分镜和角色/场景/风格管理。

## 8. Gate 结论

Gate 4B-2 判定为：**通过**。

允许的下一步仅为：在用户明确授权后进入 Gate 4B-3，按照冻结写集实现正式 Renderer 工作台并完成开发验证。

Gate 4B-2 通过不构成以下授权：

- 不授权真实 Provider；
- 不授权 SQLite v12；
- 不授权新增 API/DTO/IPC/Preload；
- 不授权媒体文件、Asset、Timeline、Batch 或视频生成；
- 不授权直接进入 Gate 4B-4 Windows 独立真实验收。
