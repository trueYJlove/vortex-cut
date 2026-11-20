# Stage 4E Gate 4E-3 生产实现与离线验证

> 负责人：LiuWei（架构师）  
> 基线：`master` / `30dcb4e`  
> 日期：2026-08-20  
> 状态：通过；等待是否授权 Gate 4E-4 独立真实验收  
> Provider 调用：0  
> 提交/推送：未执行  
> README：未处理

## 1. Gate 目标与边界

本 Gate 按 `stage4e-v1` 冻结契约完成图片 Requirement 履约薄编排层的生产实现与离线验证：

- 只允许当前 confirmed Revision 中、没有 source Asset 的 image Requirement 发起写操作；
- Prepare 与显式 Create 复用 Stage 4D Request/Task/Invocation；
- Requirement→Request 使用不可变 link；
- 生成成功不自动采用，Adopt 使用 append-only ledger 与 CAS；
- 不修改 Timeline、Preview、Render、Export 或 Batch；
- 不新增 Provider、TTS、视频、2K、参考图、自动 Prompt、自动 retry 或自动 adoption；
- 不修改 v1–v14 migration SQL/checksum；
- 不进行真实图片生成或 Provider 网络调用。

## 2. 角色与文件边界

角色只定义职责和互斥写入边界，不约束实际执行顺序、并行方式或是否使用 subagent。

### 2.1 LiuWei（架构与整合）

- 维护冻结契约、跨层一致性和 Gate 结论；
- 核对 Stage 4C/4D 行为不变；
- 复核隐私、迁移与 Provider=0 证据。

### 2.2 ZhangSan（Core / SQLite / 任务系统）

负责：

- `database_v15.py` 与 migration wiring；
- `shot_requirement_image_fulfillment.py`；
- Stage 4D 内部 transaction hook；
- Core API/wiring 与 Core 测试；
- Stage 4D/4E 原型数据库基线维护。

不负责：Contracts、Renderer、preload、Electron IPC 或 UI 样式。

### 2.3 YeJing（Contracts / Desktop / Electron）

负责：

- `stage4e.ts` DTO/guards/parsers；
- Desktop CoreClient；
- Electron main/preload/IPC；
- Requirement 履约 UI 与 Desktop 测试。

不负责：SQLite SQL、Core 事务或 Provider worker。

### 2.4 LiuKeAi（独立审查）

- 审查范围、迁移、契约兼容、隐私和验收可落地性；
- 不以实现作者自证替代独立验收；
- Gate 4E-4/4E-5 仍需单独授权。

## 3. 生产实现清单

### 3.1 SQLite v15

新增且仅新增：

```text
shot_requirement_image_generation_links
shot_requirement_image_adoptions
```

数据库约束包括：

- Project/Revision/Requirement/Request 关系一致；
- link 创建时 Revision 必须是当前 confirmed Revision；
- Requirement 必须是没有 source Asset 的 image；
- Request 必须属于同 Project，并精确匹配冻结的 Stage 4D Profile；
- link/adoption 禁止 UPDATE 与 DELETE；
- adoption 的 Task 必须属于 link Request 且 succeeded；
- Asset 必须等于 Task 输出，并是同 Project、managed、available image；
- Provenance 必须同时匹配 Request/Task/Asset；
- adoption ordinal/previous 必须形成连续的追加链。

验证覆盖 fresh、v14→v15、checksum 保持、失败回滚、FK 与 integrity。v1–v14 生产 SQL 文件未改动。

### 3.2 Stage 4D 内部事务扩展

`ProviderImageGenerationService.create_from_reserved_preview(...)` 接受本地 transaction hook：

- fresh 与 reused 路径均在 COMMIT 前执行；
- hook 不联网、不读写媒体、不启动 worker；
- hook 失败使 Request/Task/Invocation/link 整体回滚；
- Stage 4D 公共 Create API 和 DTO 不变；
- 默认 Provider 仍为 `FailOnCallImageProvider`。

### 3.3 Stage 4E Core API

```text
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/links
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adoptions
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/prepare
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/create
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adopt
```

写操作在应用层重验当前 confirmed Revision。Adopt 在 `BEGIN IMMEDIATE` 内完成资格验证、当前 adoption CAS 与 append，不修改 Timeline。

### 3.4 Contracts / Electron / Desktop

- `CONTRACT_VERSION`：`stage4e-v1`；
- 六个 CoreClient/preload/IPC 方法已接通；
- Prompt 仅允许存在于 Prepare 输入；
- Create/Adopt/查询 DTO 使用独立白名单并递归拒绝敏感键；
- 当前 confirmed image Requirement 提供 Prepare/Create/Task/Adopt 工作台；
- 历史 Revision 仅提供只读履约历史；
- `existing_media` 不显示履约入口；
- Retry 要求重新输入 Prompt并再次显式确认，最终 retry DTO 不含 Prompt；
- CAS conflict 只刷新权威状态，不自动重发；
- succeeded + managed + available 才允许 Adopt。

## 4. 自动门禁结果

### 4.1 Core 定向回归

修正 v15 current-version 测试基线及 Stage 4D/4E 原型基线后：

```text
32 passed, 1 warning
```

最终收紧 v15 adoption 的历史 Revision 第二道数据库防线后，migration/service/API/原型定向回归：

```text
23 passed, 1 warning
```

### 4.2 Core 全量

```text
431 collected
430 passed
1 skipped
0 failed
1 StarletteDeprecationWarning
```

pytest 完成后出现 Windows 临时目录 cleanup `PermissionError`，但测试进程返回码为 0，发生在结果完成后的 atexit 清理阶段，不影响门禁结论。

### 4.3 Desktop 全量

```text
26 test files passed
194 tests passed
```

同时通过：

```text
pnpm --filter @aivideo/contracts build
pnpm --filter @aivideo/desktop typecheck
pnpm --filter @aivideo/desktop build
```

### 4.4 Stage 4E Desktop 专项复核

```text
4 test files passed
22 tests passed
```

覆盖 Contracts、IPC、生产工作台与隔离状态模型。

### 4.5 Python 静态检查

```text
All checks passed!
```

范围包括 Core 生产源码、Core 测试和 Stage 4D/4E Python 原型。

## 5. 隐私与安全证据

1. API 集成测试向 Prepare 注入 Prompt sentinel，向安全凭据入口注入 secret sentinel；
2. 所有 Stage 4E API 响应递归检查敏感键；
3. SQLite `iterdump()` 不包含 Prompt 或 secret sentinel；
4. link/adoption DTO 不复制 Requirement 正文；
5. Contracts 与 IPC 拒绝或剥离 Prompt、`visual_direction`、`narration_text`、路径、URI、Authorization、API key、secret、payload、SSE、base64、stderr、command、traceback 与原始响应/异常；
6. IPC 异常只返回冻结白名单错误码或统一 `Core request failed`；
7. Renderer 不回显 Prompt，迟到响应按 Project/Revision 身份丢弃；
8. 未读取、输出或记录真实 Provider token、API key 或请求载荷。

## 6. Provider 调用为 0 的证明

- Gate 使用默认 `image_provider_network_enabled=false`；
- 默认 Provider 仍为 `FailOnCallImageProvider`；
- 未运行真实图片生成或任何网络 Provider 验收；
- Stage 4E 集成测试读取 `provider_image_invocations`：

```sql
SELECT COALESCE(SUM(provider_call_count),0)
FROM provider_image_invocations;
```

结果为 `0`；
- Prepare、Create 事实创建、查询、失败 Adopt、重启/回归测试均未增加 Provider 调用；
- 本 Gate 真实 Provider 调用总数：**0**。

## 7. LiuKeAi 独立验收清单

- [x] Stage 4E 范围仍是单条图片 Requirement 履约，不捆绑大功能；
- [x] Stage 4C Requirement 公开契约未改；
- [x] Stage 4D Provider/Request/Task 公共契约未改；
- [x] v15 只追加两张事实表，v1–v14 SQL/checksum 不变；
- [x] fresh/reused link 均在 Stage 4D 事务内原子提交；
- [x] link/adoption 不可变，Adopt 使用 CAS；
- [x] 当前 confirmed Revision 才可写，历史 Revision 只读；
- [x] `existing_media` 无生成入口；
- [x] 生成成功不自动 Adopt，Adopt 不写 Timeline；
- [x] Retry 不自动发生且需二次显式确认；
- [x] DTO/IPC/Renderer/SQLite 不泄漏禁用数据；
- [x] Core、Contracts、Desktop、build 与 Ruff 门禁通过；
- [x] Provider 调用为 0；
- [x] 未提交、未推送、未修改 README。

## 8. Gate 结论与下一步

**Gate 4E-3 通过。** 当前实现满足 `stage4e-v1`、SQLite v15、离线生产门禁和 Provider=0 约束，未发现需要退回 Gate 4E-1 修改范围或契约的阻塞问题。

下一步是 **Gate 4E-4 独立真实验收**，但本轮没有该 Gate 的授权，因此不得启动真实 Provider、不得读取真实凭据、不得产生费用。若后续授权，必须使用隔离数据、单条全新 confirmed image Requirement、最多一次 fresh Task dispatch、失败不自动 retry，并单独记录费用和 Provider 调用增量。