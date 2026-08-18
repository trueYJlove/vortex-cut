# Stage 4A 独立验收记录（LiuKeAi）

> 状态：Gate 4A-3 通过
> 日期：2026-08-18
> 验收模式：只读审查、独立复跑；未调用真实 Provider
> Provider 调用：0

> 历史说明：本文件冻结 Gate 4A-3 隔离原型的独立验收事实。后续 Gate 4A-4 生产实现结果单独记录于 `docs/STAGE4A_PRODUCTION_VALIDATION.md`；因此下文关于“生产实现尚未开始”的描述按当时语境保留。

## 1. 验收结论

Gate 4A-3 **通过**。本结论只覆盖 Stage 4A 隔离原型的数据结构、迁移兼容模型、任务生命周期、隐私边界和本地性能，不代表真实生成能力已经完成。

一票否决项均未触发：

- 未发现 Provider 调用或网络外传；
- 未发现 token/API key/Provider payload 读取；
- 未发现 Prompt 明文、secret sentinel 或工作目录绝对路径持久化；
- 未修改生产 Core、SQLite 迁移、Contracts、Desktop/Electron、README 或 Stage 1–3B 实现；
- 未把结构样例匹配率描述为真实模型精度。

## 2. 范围与基线审查

- [x] 工作区差异仅包含 Stage 4A 文档、隔离原型和原型测试；
- [x] 生产 `database.py`、Core routes、Contracts、Desktop/Electron 未被修改；
- [x] README 未修改；
- [x] 原型只使用临时数据库，不接触用户数据库；
- [x] Stage 1–3B DTO、API 与行为无原型差异。

## 3. 迁移与数据模型

- [x] v1–v10 migration SQL/checksum 10/10 保持一致；
- [x] 模拟 v11 的 Request/Task 两表和必要索引存在；
- [x] Request 不含 status，UPDATE/DELETE 均被拒绝；
- [x] Task 持有唯一 `job_id`，未给既有 jobs 表增加 Stage 4 owner 列；
- [x] 同 Request + attempt 唯一；同一父 Task 最多一个直接 retry；
- [x] SQLite dump 不含 Prompt sentinel、secret sentinel 或工作目录绝对路径。

## 4. 生命周期

- [x] 同 project + request hash 幂等复用 Request；
- [x] 首次执行为 attempt 1；
- [x] running 在恢复时转 interrupted，且不自动重发；
- [x] retry 创建 attempt 2、新 Task 和新 Job；
- [x] `retry_of_task_id` 保留正确父子关系；
- [x] 非终态 retry 和同一父 Task 的重复 retry 均被 `GENERATION_RETRY_NOT_ALLOWED` 拒绝。

## 5. Contracts / Desktop / Electron 边界

- [x] Stage 3B DTO 和接口无字段或语义变化；
- [x] 新 DTO 仍停留在冻结设计，未写入生产 Contracts；
- [x] Prompt 仅作为原型瞬时命令输入，不出现在响应或持久证据；
- [x] 原型输出不含媒体路径、字幕/转写正文、Provider 载荷、凭据和原始异常；
- [x] 原型未接入正式导航、Windows 包或安装器入口。

## 6. Provider 与网络

- [x] Provider invocation 计数为 0；
- [x] 原型未导入网络客户端模块，未读取环境密钥；
- [x] 无真实模型调用或媒体外传；
- [x] 未修改 `provider_configs.kind`，未增加 capability probe。

## 7. 独立复跑结果

### 7.1 Stage 4A 原型

- Ruff：通过；
- pytest：`1 passed`；
- 结构样例：14/14 匹配，false accept/reject 均为 0；
- prepare：p50 0.095 ms，p95 0.197 ms；
- create：p50 11.448 ms，p95 13.903 ms；
- p95 门槛：300 ms；
- 报告一致性和静态无网络边界断言：通过。

### 7.2 Core 回归

执行时显式排除 `real_provider` 标记：

- `332 passed`；
- `1 deselected`（真实 Provider 用例，按本阶段约束不执行）；
- `1 warning`（Starlette/httpx 测试客户端弃用提示，非本阶段回归失败）。

首次全量命令因验收 `--basetemp` 的父目录未预建，造成依赖 `tmp_path` 的用例在 setup 阶段统一报 `FileNotFoundError`；创建被忽略的本地证据目录后原样复跑，得到上述有效结果。该首次结果不是业务断言失败，也未用于通过判定。

### 7.3 Contracts / Desktop / 构建

- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- `pnpm test`：14 个测试文件、109 个测试全部通过；
- `pnpm build`：通过；
- `pyright`：0 errors / 0 warnings；
- 全量 Ruff：通过；
- `git diff --check`：通过。

## 8. “准确率”口径

100% 只表示 14 个预定义结构输入样例的接受/拒绝结果全部符合预期。它不是模型精度，不证明图片视觉质量、Prompt 遵循度、TTS 音质、发音或语义准确性。

## 9. 未验证项

以下继续为 `UNVERIFIED`：

- 真实图片生成质量；
- 真实 TTS 音质与语义准确性；
- 真实 Provider 的时延、费用、限流和错误适配；
- 视频生成；
- Windows 打包后的正式 Stage 4A 业务交互；
- 生产 SQLite v11、完整 API/Contracts/Desktop 实现。

## 10. Gate 判定与后续限制

Gate 4A-3 通过，可以结束 Stage 4A 的“契约冻结、详细设计、隔离原型、技术边界确认”工作。

该通过结论**不自动授权生产编码**。进入生产 v11 和业务实现前仍需明确授权；任何真实 Provider、视频生成、Batch、正式 Asset 注册或 Timeline 集成都必须重新确认范围，必要时重新冻结契约。
