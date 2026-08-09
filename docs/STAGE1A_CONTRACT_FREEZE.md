# 阶段 1A 契约冻结

- 版本：`stage1a-v1`
- 日期：2026-08-09
- 架构师：LiuWei
- 适用范围：项目、素材、受限文件授权、任务持久化与 SQLite migration v1
- 明确不包含：ASR 模型下载与转录、Timeline/TimelinePatch、Render Plan、最终 Export

本文件是 ZhangSan 与 YeJing 的共享接口基线。两方不得单方面修改以下语义；发现缺口时先向 LiuWei 提交契约变更请求，变更请求获得确认并更新本文件后才能实施。

## 1. 通用约束

- API 前缀固定为 `/api/v1`。
- 所有实体 ID 使用不可预测的 URL-safe 字符串，格式限制为 `[A-Za-z0-9_-]{1,128}`。
- 领域时间统一使用 UTC ISO 8601 字符串；媒体时间和剪辑范围统一使用整数微秒 `*_us`，禁止持久化浮点秒。
- JSON 字段使用 `snake_case`；TypeScript 类型从共享契约包导出，禁止在 Renderer 或 Core Client 手写另一套同名 DTO。
- API 错误统一为 `{ "error": { "code": string, "message": string, "trace_id": string } }`；`message` 可本地化，`code` 稳定且用于程序分支。
- Renderer 不得获得绝对路径、管理令牌、Core 管理令牌或数据库路径。
- 原始素材默认 `external` 且只读；Core 只保存路径指纹和派生信息，不修改原始文件。

## 2. 实体与枚举

### 2.1 Project

```json
{
  "project_id": "project_01",
  "name": "My Project",
  "status": "active",
  "canvas": { "width": 1080, "height": 1920, "fps_num": 30, "fps_den": 1 },
  "root_dir_name": "My Project",
  "current_timeline_revision_id": null,
  "created_at": "2026-08-09T00:00:00.000Z",
  "updated_at": "2026-08-09T00:00:00.000Z",
  "last_opened_at": "2026-08-09T00:00:00.000Z"
}
```

Project 状态只允许 `active | archived | missing`。阶段 1A 的创建、重命名、归档、重新打开必须形成可持久化状态变化。

### 2.2 Asset

```json
{
  "asset_id": "asset_01",
  "project_id": "project_01",
  "kind": "video",
  "storage_mode": "external",
  "display_name": "clip.mp4",
  "fingerprint": "sha256:...",
  "size_bytes": 123456,
  "modified_at": "2026-08-09T00:00:00.000Z",
  "availability": "available",
  "media_info": null,
  "created_at": "2026-08-09T00:00:00.000Z",
  "updated_at": "2026-08-09T00:00:00.000Z"
}
```

`kind` 为 `video | audio | image | text`；`storage_mode` 为 `external | managed`，阶段 1A 默认只实现 `external`。`availability` 为 `available | missing | changed | unsupported`。

### 2.3 FileGrant

```json
{
  "grant_id": "grant_01",
  "display_name": "clip.mp4",
  "size_bytes": 123456,
  "modified_at": "2026-08-09T00:00:00.000Z",
  "expires_at": "2026-08-09T01:00:00.000Z"
}
```

`grant_id` 只允许作为 Core API 的短期引用。Renderer 可以持有 `grant_id`，但不能得到其对应绝对路径；管理端令牌只能留在 Electron 主进程。

### 2.4 Job

阶段 1A 扩展现有 Job DTO，但不改变阶段 0 已冻结的状态词汇：

```text
queued -> running -> succeeded
                 |-> failed
                 |-> cancelling -> cancelled
                 `-> interrupted
```

```json
{
  "job_id": "job_01",
  "project_id": "project_01",
  "kind": "asset_probe",
  "status": "queued",
  "stage": "queued",
  "progress": 0,
  "attempt": 1,
  "input": { "asset_id": "asset_01" },
  "error": null,
  "created_at": "2026-08-09T00:00:00.000Z",
  "updated_at": "2026-08-09T00:00:00.000Z",
  "started_at": null,
  "finished_at": null
}
```

阶段 1A 允许的 `kind` 至少包含 `asset_probe | asset_fingerprint | proxy`。不得在本阶段加入 ASR、Timeline 或最终 Export Job。

## 3. HTTP API

所有需要 UI 会话的接口使用 `Authorization: Bearer <ui_token>`。管理接口只能由 Electron 主进程调用。

### 3.1 Projects

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/projects` | `status?`、`limit?`、`cursor?` | `{ "items": Project[], "next_cursor": string|null }` |
| POST | `/projects` | `{ "name": string, "root_dir_name?": string }` | `Project`，201 |
| GET | `/projects/{project_id}` | 无 | `Project` |
| PATCH | `/projects/{project_id}` | `{ "name?": string }` | `Project` |
| POST | `/projects/{project_id}/archive` | 无 | `Project` |
| POST | `/projects/{project_id}/reopen` | 无 | `Project` |

项目名称长度为 1-120 个 Unicode 字符；归档项目不可导入新素材，重新打开后恢复可编辑。

### 3.2 Assets

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/projects/{project_id}/assets` | `availability?`、`limit?`、`cursor?` | `{ "items": Asset[], "next_cursor": string|null }` |
| POST | `/projects/{project_id}/assets` | `{ "grant_id": GrantId, "kind?": AssetKind }` | `Asset`，201 |
| GET | `/assets/{asset_id}` | 无 | `Asset` |
| POST | `/assets/{asset_id}/refresh` | 无 | `Asset` |
| POST | `/assets/{asset_id}/relocate` | `{ "grant_id": GrantId }` | `Asset` |

导入必须通过 FileGrant；重复指纹不得重复注册同一派生资产。`refresh` 重新检查文件指纹，`relocate` 只更新外部引用并保留历史可审计字段。

### 3.3 Jobs

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/projects/{project_id}/jobs` | `status?`、`limit?`、`cursor?` | `{ "items": Job[], "next_cursor": string|null }` |
| GET | `/jobs/{job_id}` | 无 | `Job` |
| POST | `/jobs/{job_id}/cancel` | 无 | `Job` |

Job 事件继续使用 `/api/v1/events` WebSocket；消息类型为 `job.updated`，事件只携带脱敏 Job 摘要，Renderer 需要通过 GET 获取完整状态。

## 4. 稳定错误码

```text
UNAUTHORIZED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
PROJECT_NOT_FOUND
PROJECT_ARCHIVED
PROJECT_NAME_INVALID
ASSET_NOT_FOUND
ASSET_DUPLICATE
ASSET_MISSING
ASSET_CHANGED
ASSET_UNSUPPORTED
GRANT_NOT_FOUND
GRANT_EXPIRED
MEDIA_NOT_FOUND
MEDIA_UNSUPPORTED
JOB_NOT_FOUND
JOB_INVALID_STATE
JOB_CANCELLED
JOB_INTERRUPTED
MIGRATION_FAILED
CONFLICT
INTERNAL_ERROR
```

HTTP 映射：输入或状态错误使用 400；未认证 401；无权限 403；实体不存在 404；版本或资源冲突 409；服务器内部错误 500。错误码不得用异常文本替代。

## 5. SQLite migration v1

迁移执行器必须维护 `schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`，迁移文件只增不改。

v1 至少包含以下表和约束：

- `projects`：项目实体、状态、画布 JSON、目录显示名和时间字段。
- `assets`：项目外键、类型、存储模式、显示名、指纹、大小、修改时间、可用性和媒体信息 JSON。
- `asset_locations`：Asset 到外部 URI 的受限存储记录，禁止进入 UI DTO。
- `jobs`：项目外键、类型、状态、进度、输入 JSON、attempt、错误字段和生命周期时间。
- `artifacts`：Job 外键、产物类型、受控路径、大小、SHA-256、媒体信息 JSON 和创建时间。

每次迁移前复制数据库到 `backups/app-{timestamp}.db`；单次迁移在事务中执行，失败必须回滚并保留备份。未知 schema 版本只能只读打开或拒绝启动，不得降级破坏数据。

## 6. 验收契约

- Core API、contracts 包和 Electron Core Client 的字段名称、状态词汇、错误码一致。
- Renderer 单元测试不得断言绝对路径或管理令牌存在。
- 真实 Electron E2E 必须创建、重命名、归档、重新打开项目，导入至少视频/音频/图片/文本四类素材，并验证移动或修改后的 `missing/changed`。
- 强制停止 Core 后重新启动，running/cancelling Job 必须变为 `interrupted`，且数据库备份、迁移记录和任务状态可核对。
- OpenAPI/契约生成后工作区不得产生未提交差异。
- 本契约不授权实现 ASR 模型、Timeline、Render Plan 或最终 Export。
