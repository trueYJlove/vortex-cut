# Stage 4B 生产实现与开发验证记录

> 负责人：LiuWei（架构师）
> Core / SQLite / Jobs 边界复核：ZhangSan
> Contracts / Desktop / Electron 边界复核：YeJing
> 独立验收复核：LiuKeAi
> 日期：2026-08-18
> 对应门禁：Gate 4B-3
> 结论：Gate 4B-3 通过；后续 Gate 4B-4 已于 2026-08-18 通过，见 `docs/STAGE4B_INDEPENDENT_ACCEPTANCE.md`

## 1. 实现范围

Gate 4B-3 将 Stage 4A 已冻结的 `simulation_only` 生成领域接入正式 Desktop Renderer，提供：

- 顶栏正式入口“生成验证（模拟）”；
- image 与 TTS 白名单参数表单；
- Prepare → Confirm → Create 交互；
- Request 历史与 Task 六状态展示；
- cancel 与 retry 状态门禁、attempt 与 retry lineage 展示；
- 快速终态的立即回读、订阅后第二次回读、Job 事件触发 Task 权威回读和有限轮询；
- 关闭、项目切换和卸载时的 Prompt、订阅与定时器清理。

本实现没有真实媒体生成能力。入口、确认和结果持续声明：Provider 调用 0 次；不会生成媒体，不会注册素材，也不会写入时间线。

## 2. 文件清单

生产文件：

```text
apps/desktop/src/app/media-generation/MediaGenerationWorkbench.tsx
apps/desktop/src/app/App.tsx
apps/desktop/src/styles.css
```

测试文件：

```text
apps/desktop/tests/media-generation-workbench.test.tsx
apps/desktop/tests/app.test.tsx
```

Gate 4B-1 / 4B-2 已产生的文档与隔离原型继续保留：

```text
docs/STAGE4B_CONTRACT_FREEZE.md
docs/STAGE4B_DETAILED_DESIGN.md
docs/STAGE4B_PROTOTYPE_VALIDATION.md
tools/prototypes/stage4b_generation_workbench_model.ts
apps/desktop/tests/stage4b-workbench-prototype.test.ts
```

## 3. 冻结边界核对

以下路径相对基线无差异：

```text
packages/contracts/
apps/desktop/electron/
apps/desktop/src/lib/core-client.ts
services/core/
README.md
```

结论：

- SQLite 保持 v11，无迁移；
- API / DTO / Core Client / IPC / Preload 零新增；
- `CONTRACT_VERSION` 保持 `stage3b-v1`；
- 生产代码未导入 Gate 4B-2 隔离原型；
- 生产组件未新增网络库、Provider SDK、凭据、Provider 配置或调用记录依赖；
- Stage 1–4A 已冻结实现未被修改。

## 4. 状态机与竞态验证

组件定向测试验证：

1. image / TTS 表单与参数范围；
2. Renderer 只把 Asset ID 作为 `input_refs`，不读取或提交 `media_url`；
3. Prepare 确认页只显示 Prompt 字符数与 hash，不回显正文；
4. 字段变化使 prepared 失效；
5. Create 使用 prepared 对应的 draft 快照，成功后清除 Prompt；
6. `reused=true` 有明确复用提示；
7. 六种 Task 状态、cancel/retry 门禁、attempt 与 retry parent；
8. Create 后立即回读；非终态先订阅再二次回读；
9. Job event 只触发 Task API 权威回读，不直接写 Task 状态；
10. 非终态采用有限轮询，终态、关闭、切项目或卸载停止；
11. 迟到响应不能污染新项目；
12. 项目切换重新打开时 Prompt 为空。

## 5. 隐私与安全结论

- Prompt 只存在于受控表单内存和 Prepare/Create 命令参数；不写历史 DTO、持久 store 或证据；
- Create 成功、关闭、项目切换和卸载都会清理 Prompt；
- 历史仅显示 kind、时间、hash、input ref 数量、Task 状态和 lineage；
- UI 不渲染媒体 URL、绝对路径、字幕/转写正文、原始异常、stderr、command 或 traceback；
- catch 使用固定安全错误，不执行 `console.error(rawError)`；
- sentinel 测试确认原始异常与绝对路径不进入 DOM 或 console；
- Provider 调用数固定为 0，成功结果为 `validated_without_media`，输出 Asset 与 SHA 均为空；
- 无媒体写入、Asset 注册、Timeline 写入、Preview、Render 或 Export 调用。

## 6. 自动化验证结果

### 6.1 Desktop 定向

```text
apps/desktop/tests/media-generation-workbench.test.tsx
apps/desktop/tests/app.test.tsx
```

结果：38 passed（其中 Stage 4B 工作台 10 项，App 全量 28 项）。

### 6.2 Desktop 全量

```text
pnpm --filter @aivideo/desktop test
```

最终结果：17 files / 138 tests passed。

### 6.3 Stage 4A Core 定向

```text
uv run --locked --extra dev pytest services/core/tests/unit/test_media_generation.py services/core/tests/unit/test_migrations_v11.py services/core/tests/integration/test_stage4a_media_generation_api.py services/core/tests/prototype/test_stage4a_generation_model.py -q
```

结果：23 passed，退出码 0。测试进程结束时出现既有 Windows 临时 pytest 符号链接清理 `PermissionError`；不影响断言或退出码。

### 6.4 静态与构建

```text
pnpm --filter @aivideo/desktop typecheck
pnpm --filter @aivideo/desktop lint
pnpm --filter @aivideo/desktop build
git diff --check
```

结果：全部通过。Renderer 生产构建成功。

## 7. 角色边界复核

### LiuWei

范围与状态机保持在正式模拟工作台，不把真实 Provider、媒体生成、Asset 生命周期或新数据模型带入 Stage 4B。

### ZhangSan

Core、SQLite v11、Request/Task/Job 语义与恢复、取消、重试实现无变更；现有七个 API 足以支持 Renderer。

### YeJing

工作台只使用既有 `window.desktop` 能力；Contracts、Core Client、Electron IPC 与 Preload 无变更；项目切换和卸载清理已覆盖。

### LiuKeAi

开发验收可落地且未越过冻结边界。Gate 4B-3 可判定通过，但本结论不替代真实 Electron/Sidecar、Windows 安装包、重启恢复与磁盘/数据库取证。

## 8. Gate 结论

Gate 4B-3 判定为：**通过**。

本文件冻结 Gate 4B-3 当时的开发验证事实。当时未执行提交，也未进行 Windows 独立真实验收；后续 Gate 4B-4 已完成真实 Electron + Sidecar、Windows 构建/NSIS 安装、核心交互、重启恢复及独立取证，详见 `docs/STAGE4B_INDEPENDENT_ACCEPTANCE.md`。
