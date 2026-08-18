# Stage 4C Gate 4C-3 生产实现与开发验证记录

> 负责人：LiuWei（架构师）
> Core / SQLite 评估：ZhangSan
> Contracts / Desktop / Electron 评估：YeJing
> 独立验收边界复核：LiuKeAi
> 日期：2026-08-18
> 基线：`master` / `27e5ab5` / SQLite v11
> 结论：Gate 4C-3 与 Gate 4C-4 均通过；Gate 4C-5 已授权，随本次 PR 合并主干后通过

## 1. Gate 范围与结论

Gate 4C-3 已按冻结契约完成结构化 Shot List 生产实现及开发侧验证：

- 正式追加 SQLite v12，不修改 v1–v11 SQL 或 checksum；
- Shot List / Revision / Requirement 领域服务；
- 五个固定 Core API；
- `stage4c-v1` Contracts、exact-key runtime guards 与响应安全检查；
- 五个固定 Electron IPC channel 与 Preload 窄接口；
- Desktop Shot Requirement Workbench；
- Core、Contracts、Desktop、Electron 的定向与全量开发验证。

本 Gate 未调用真实 Provider，未生成或注册媒体，未创建生成 Request/Task/Job，未写 Timeline，也未执行 Windows 安装态真实验收。

## 2. 生产实现清单

### 2.1 Core 与 SQLite

```text
services/core/src/aivs_core/database.py
services/core/src/aivs_core/shot_requirements.py
services/core/src/aivs_core/app.py
```

SQLite v12 追加：

```text
shot_lists
shot_list_revisions
shot_requirements
```

实现并验证：

- 每项目最多一个 Shot List；
- 每个不可变 Revision 保存 `1–24` 个有序 Requirement；
- current、confirmed、parent 使用复合外键保证聚合归属；
- Revision 与 Requirement 不可更新/删除；Shot List 身份不可变；
- existing_media Asset 由 Core 与 SQLite 触发器双层校验项目归属；
- canonical JSON、NFC 规范化与 SHA-256；
- `BEGIN IMMEDIATE`、`base_revision_id` 乐观并发、相同文档幂等复用；
- 只允许确认当前 Revision，重复确认幂等；
- Summary/Detail 分离，历史列表不携带正文详情。

五个固定 API：

```text
GET  /api/v1/projects/{project_id}/shot-list
GET  /api/v1/projects/{project_id}/shot-list/revisions
GET  /api/v1/shot-list-revisions/{revision_id}
POST /api/v1/projects/{project_id}/shot-list/revisions
POST /api/v1/projects/{project_id}/shot-list/confirm
```

### 2.2 Contracts 与 Core Client

```text
packages/contracts/src/index.ts
apps/desktop/src/lib/core-client.ts
```

- `CONTRACT_VERSION` 升级为 `stage4c-v1`；
- 新增 Shot List、Revision、Requirement branded ID 与 Input/Output DTO；
- runtime guards 执行 exact-key、类型、长度、ID、敏感字段和正文所属边界检查；
- Summary 禁止携带正文，Detail 只允许所属 `summary`、`visual_direction` 与 narration `text`；
- Core Client 仅调用五个冻结路径，并对输入、输出执行 Contracts parse。

### 2.3 Electron 与 Preload

```text
apps/desktop/electron/main/stage4c-ipc.ts
apps/desktop/electron/main/index.ts
apps/desktop/electron/preload/index.ts
```

仅新增五个固定 channel：

```text
shot-list:get
shot-list:revisions
shot-list:revision:get
shot-list:revision:create
shot-list:confirm
```

边界：

- wrapper key 精确校验，ID、limit、cursor 使用白名单规则；
- 输入输出均经 Contracts runtime guard；
- 只连接固定 Core URL；
- 无通用 invoke、文件系统能力、Provider 能力或凭据接口；
- 不向 Renderer 暴露媒体绝对路径、URI、Provider 数据或原始异常对象。

### 2.4 Desktop Workbench

```text
apps/desktop/src/app/shot-requirements/ShotRequirementWorkbench.tsx
apps/desktop/src/app/App.tsx
apps/desktop/src/styles.css
```

已实现：

- 独立模态入口，持续显示零 Provider/媒体/Timeline 副作用说明；
- 清单标题与摘要；
- `1–24` 个 Shot 的添加、删除、上移和下移；
- Shot 标题、画面要求与可选目标时长；
- `image | existing_media` 视觉需求；existing_media 只展示 Asset display name、提交 Asset ID；
- 可选 `tts + 人工正文` 旁白需求；
- 保存完整不可变 Revision、幂等复用提示与冲突不覆盖；
- 历史 Summary 列表、Detail 按需加载与复制为新草稿；
- 两步确认当前 Revision；
- 项目切换清空草稿，epoch 隔离迟到响应；
- 不使用 localStorage，不触发生成、Asset 注册或 Timeline 写入。

## 3. 测试与验证清单

新增或扩展的主要测试：

```text
services/core/tests/unit/test_migrations_v12.py
services/core/tests/integration/test_stage4c_shot_list_api.py
services/core/tests/prototype/test_stage4c_shot_list_model.py
apps/desktop/tests/contracts.test.ts
apps/desktop/tests/core-client.test.ts
apps/desktop/tests/preload.test.ts
apps/desktop/tests/stage4c-ipc.test.ts
apps/desktop/tests/shot-requirement-workbench.test.tsx
apps/desktop/tests/app.test.tsx
```

迁移回归测试中的“当前数据库版本”断言同步到 v12；旧的 `MIGRATIONS.pop()/重新插入` 夹具改为测试局部 monkeypatch，避免修改全局字典顺序。生产 v1–v11 迁移文本与 checksum 未变。

### 3.1 Python 定向验证

```text
python -m ruff check services/core/src services/core/tests tools/prototypes/stage4c_shot_list_model.py
python -m pytest <v8/v9/v10/v12 migration + Stage 4C prototype/API> -q
```

结果：Ruff 通过；`16 passed`。存在一项既有 Starlette/httpx 弃用警告，不影响断言。

### 3.2 Desktop 直接边界验证

```text
pnpm --filter @aivideo/desktop test -- shot-requirement-workbench.test.tsx
```

结果：`1 file / 6 tests passed`。其中直接证明达到 24 条后添加按钮禁用，且无法产生第 25 条。

### 3.3 Core 全量验证

```text
python -m ruff check services/core/src services/core/tests
python -m pytest services/core/tests -q --basetemp=.pytest-stage4c-full
```

结果：Ruff 通过；`359 passed, 1 skipped`。存在一项既有 Starlette/httpx 弃用警告。

### 3.4 仓库级前端验证

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Gate 4C-3 当时结果全部通过；Gate 4C-4 补充 IPC 安全回归后重新全量执行：

- Contracts build 通过；
- Desktop TypeScript lint/typecheck 通过；
- Desktop：`19 files / 153 tests passed`；
- Electron main、preload 与 Renderer production build 通过。

## 4. 零副作用与隐私门禁

Core API 集成测试在创建、幂等复用、冲突和确认流程前后执行数据库计数差异检查，结果为：

```text
Provider 调用数              = 0
ProviderInvocation 增量      = 0
MediaGenerationRequest 增量  = 0
MediaGenerationTask 增量     = 0
Job 增量                     = 0
Generated Asset 增量         = 0
TimelineRevision 增量        = 0
```

同时验证：

- 冲突响应不回显用户正文；
- Summary 不承载正文，Detail 只承载业务所属正文；
- DTO、IPC 响应、DOM 与日志不暴露真实媒体绝对路径、location URI、Provider token/API key、Provider payload 或原始异常对象；
- 原型与测试使用合成 ID、合成数据库和受控字段，不读取真实 Provider 配置；
- 未发起任何网络 Provider 调用。

## 5. 兼容性与迁移结果

- 全新数据库按 v1→v12 顺序初始化；
- 真实形态的历史 v3/v9/v11 数据库样本可追加升级至 v12；
- 升级前备份仍由既有迁移机制创建；
- 历史项目、Asset、ProviderInvocation 等既有事实保持；
- v12 不回填 Shot List 历史，不预留生成 Request 外键；
- Stage 4A/4B Request、Task、Job 与 `simulation_only` 语义未修改；
- Sidecar API prefix 与 protocol version 保持 v1；
- README 未修改。

## 6. Gate 4C-4 后续状态

Gate 4C-3 之后，用户已授权并完成 Gate 4C-4 独立真实验收。开发态真实 Electron + Sidecar、全新 NSIS 构建与安装、安装态 fresh、v11→v12 原位升级、重启恢复、实际卸载、数据库保留、隐私取证及全量回归均通过。

完整证据与角色审查结论见：

```text
docs/STAGE4C_INDEPENDENT_ACCEPTANCE.md
```

Gate 4C-4 中发现并修复了 Stage 4C 自身的 Contracts 生命周期 guard 和 Electron IPC 安全错误投影；没有修改 Stage 1–4B 冻结行为。Gate 4C-5 收尾、提交、推送、PR/MR 与合并已获授权；本次 PR 合并主干后通过。
