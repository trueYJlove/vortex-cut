# 阶段 1B 契约冻结：本地 ASR 模型与转录链路

> 负责人：LiuWei（架构师）  
> 状态：冻结，stage1b-v1  
> 日期：2026-08-10  
> 基线：`126f690 feat(stage1a): 完成项目素材与任务工作区`  
> 依据：`ARCHITECTURE.md`、`docs/design/STAGE1_DETAILED_DESIGN.md`、`docs/design/STAGE1A_CONTRACT_FREEZE.md` 及阶段 1A 独立验收记录

## 1. 范围与非目标

阶段 1B 只实现本地 ASR Provider、模型清单与按需下载、转录任务、原始 Transcript 保存和桌面端真实交互闭环。

本阶段明确不实现：

- Timeline、TimelinePatch、Render Plan、权威预览和最终 Export。
- 云端 ASR、默认上传媒体或转录正文。
- 将模型权重打入安装包；安装包只携带 ASR runtime、版本化 manifest 和许可证信息。
- 以 Mock 代替真实模型、真实 Core 或真实 Electron E2E 验证。

阶段 1A 的 Project、Asset、FileGrant、受限媒体协议和既有媒体 Job API 继续有效；本契约只定义新增或扩展的 1B 语义。

## 2. 兼容性与通用规则

### 2.1 契约版本

- `CONTRACT_VERSION` 从 `stage1a-v1` 升级为 `stage1b-v1`。
- 1B DTO 只允许新增字段或新增枚举值，不得改变 1A 字段含义。
- 旧客户端遇到未知 Job kind 或模型状态必须显示为不可操作状态，不能猜测其业务含义。
- DTO、错误码、状态机和 API 路径的任何变更，必须先由 LiuWei 提交变更请求并更新本文件，再修改实现。

### 2.2 标识、时间和隐私

- 实体 ID 使用不可推测的字符串 ID：`model_id`、`transcript_id`、`job_id`、`asset_id`。
- 所有业务时长和时间边界使用 JSON 整数微秒，字段名统一使用 `_us`；禁止浮点秒。
- 时间戳使用 UTC ISO 8601 字符串，格式与 1A 一致。
- Renderer 只能获得实体 ID、脱敏显示信息、状态和受限资源 URL，不得获得素材绝对路径、数据库路径、管理令牌或模型安装绝对路径。
- 默认日志不得包含 Token、授权头、绝对路径、完整媒体 URI、原始转录正文或未脱敏隐私数据。

## 3. Transcript DTO

### 3.1 结构

```text
Transcript
  transcript_id: string
  asset_id: string
  status: pending | ready | stale | failed
  language: string
  segments: TranscriptSegment[]
  words: TranscriptWord[] | null
  provider: string
  model_id: string
  model_revision: string
  source_media_fingerprint: string
  duration_us: integer
  created_at: timestamp
  updated_at: timestamp
```

```text
TranscriptSegment
  segment_id: string
  ordinal: integer >= 0
  start_us: integer >= 0
  end_us: integer > start_us
  text: string
  confidence: number | null, 0 <= value <= 1
  words: TranscriptWord[] | null
```

```text
TranscriptWord
  word_id: string
  segment_id: string
  ordinal: integer >= 0
  start_us: integer >= 0
  end_us: integer > start_us
  text: string
  confidence: number | null, 0 <= value <= 1
```

### 3.2 约束

- `segments` 按 `start_us`、再按 `ordinal` 升序排列；每个 segment 的 `end_us` 不得超过 `duration_us`。
- 同一 segment 的 words 按时间升序排列，并且必须位于 segment 范围内。
- `language` 使用 BCP-47 风格的短语言标识，自动检测至少返回 `zh`、`en` 或 provider 返回的明确标识。
- `ready` Transcript 必须绑定导入时的 Asset fingerprint。Asset fingerprint 变化或 Asset 进入 `missing/changed` 后，旧 Transcript 必须变为 `stale` 或拒绝复用，不得静默作为新转录结果。
- 原始 ASR Transcript 只读。字幕修订、用户编辑和展示格式化不得覆盖原始 Transcript，应使用后续阶段的独立修订层。
- 取消或失败的临时分段不得作为 `ready` Transcript 返回或持久化为可用结果。

## 4. ASR Provider 契约

### 4.1 Provider 元数据

```text
AsrProvider
  provider_id: string
  model_id: string
  model_revision: string
  supported_languages: string[]
  supports_word_timestamps: boolean
  runtime_version: string
  model_size_bytes: integer
  model_sha256: string
  license: LicenseInfo
  source: ModelSource
  local_only: true
  status: unavailable | installed | corrupt | runtime_unavailable
```

```text
LicenseInfo
  id: string
  name: string
  url: string | null
  attribution: string | null
  acceptance_required: boolean
```

```text
ModelSource
  kind: trusted_manifest | https
  display_name: string
  host: string | null
  url: string | null
```

阶段 1B 只实现 `FasterWhisperProvider`。Provider 必须通过显式接口接收 `audio_uri`、语言、模型、词级时间戳开关、取消令牌和进度回调，返回结构化 Transcript 结果；Provider 不直接修改项目状态或数据库。

### 4.2 模型 manifest

版本化 manifest 至少包含：

```text
ModelManifest
  model_id: string
  provider: string
  revision: string
  download_url: string | null
  trusted_source_id: string | null
  size_bytes: integer > 0
  installed_size_bytes: integer > 0
  sha256: lowercase hex string, 64 chars
  license: LicenseInfo
  supported_languages: string[]
  runtime_requirements: object
  files: ModelFile[]
  installed_path: string | null       # Core 内部字段，禁止出现在 Renderer DTO
  created_at: timestamp
```

每个 `ModelFile` 至少包含相对路径、大小和 SHA-256。manifest 中的下载源必须是受信任来源或 HTTPS；模型 revision、文件清单、大小、哈希和许可证必须来自版本化资源文件，不能由 Renderer 传入或覆盖。

### 4.3 模型状态机

```text
unavailable -> queued -> downloading -> verifying -> ready
                         |-> paused -> downloading
                         |-> cancelled
                         `-> failed -> queued
ready -> downloading       # 仅下载新 revision，不覆盖当前 ready revision
ready -> unavailable       # 删除/卸载且没有可用 revision
```

- `paused` 表示保留可安全续传的 `.partial` 文件；`cancelled` 不得留下 ready 目录、未完成安装目录或孤儿 Worker，但可以保留受隔离目录管理的 partial 缓存供下一次显式下载续传。
- 下载写入与目标 ready 目录同卷的临时位置，完成大小和 SHA-256 校验后才可原子移动并标记 `ready`。
- 磁盘预检至少预留 `installed_size_bytes * 1.2` 的可用空间；不足时不得启动下载。
- 取消、断网、范围请求不支持、磁盘不足和哈希不一致必须保留稳定错误码和脱敏诊断信息。

## 5. ASR Job 契约

### 5.1 Job DTO 扩展

```text
JobKind = 1A kinds | model_download | transcription

Job
  job_id: string
  project_id: string | null
  asset_id: string | null
  kind: JobKind
  status: queued | running | succeeded | failed | cancelling | cancelled | interrupted
  stage: queued | downloading | paused | verifying | transcribing | persisting | completed | failed | cancelled | interrupted
  progress: number | null, 0 <= value <= 1
  attempt: integer >= 1
  model_id: string | null
  model_revision: string | null
  input_fingerprint: string | null
  error: JobError | null
  created_at: timestamp
  updated_at: timestamp
  started_at: timestamp | null
  finished_at: timestamp | null
```

`JobError` 使用稳定 `ErrorCode`、面向用户的中文 message 和可选 trace_id；不得把绝对路径、响应正文或模型下载令牌写入 error。

### 5.2 状态语义

```text
queued -> running -> succeeded
                  |-> failed
                  |-> cancelling -> cancelled
                  `-> interrupted
```

- Core 强制退出或异常停止时，正在下载或转录的 Job 必须在下次启动时变为 `interrupted`，不能伪造 `succeeded`。
- 重启后 Job、stage、attempt、错误原因、输入指纹和模型 revision 必须可查询。
- `interrupted` 任务只能通过显式重试重新进入 `queued`；重试必须重新校验素材 fingerprint 和模型 ready 状态。
- 取消必须可持久化；`queued` 可直接变为 `cancelled`，运行中的任务先进入 `cancelling`，Worker 终止并清理临时结果后变为 `cancelled`。
- 同一 Asset、同一 input fingerprint、同一 model revision 的 ready Transcript 可复用；Asset 或模型 revision 不同不得复用。

## 6. API 契约

所有 API 使用 `/api/v1`、UI session Bearer token 和 1A 的错误 envelope：

```json
{"error":{"code":"ERROR_CODE","message":"中文说明","trace_id":"trace_id"}}
```

### 6.1 模型

```text
GET  /models
  -> { items: ModelSummary[], next_cursor: string | null }

GET  /models/{model_id}
  -> ModelDetail

POST /models/{model_id}/download
  body: { license_acceptance: string | null }
  -> { model: ModelDetail, job: Job }

GET  /models/{model_id}/download
  -> { model: ModelDetail, job: Job | null }

POST /models/{model_id}/cancel
  -> { model: ModelDetail, job: Job }
```

`ModelSummary`/`ModelDetail` 必须提供用途、显示名称、provider、revision、语言、下载大小、安装后占用、许可证、来源、是否需要网络、local_only、状态和 progress；不得提供 `installed_path`。

### 6.2 转录

```text
POST /assets/{asset_id}/transcription
  body: {
    model_id: string
    language: string | "auto"
    word_timestamps: boolean
    license_acceptance: string | null
  }
  -> { job: Job, transcript: Transcript | null }

GET /assets/{asset_id}/transcription
  -> { items: TranscriptSummary[], next_cursor: string | null }

GET /transcriptions/{transcript_id}
  -> Transcript
```

若模型未安装，POST 转录必须返回 `MODEL_NOT_INSTALLED` 和可供确认界面展示的 ModelDetail；不得隐式下载或上传素材。若 Asset fingerprint 已变化，必须返回 `TRANSCRIPTION_INPUT_CHANGED`。

### 6.3 任务

```text
GET  /projects/{project_id}/jobs
  -> { items: Job[], next_cursor: string | null }

GET  /jobs/{job_id}
  -> Job

POST /jobs/{job_id}/cancel
  -> Job
```

已有 1A Job API 的字段和错误语义保持兼容；1B 仅增加 `asset_id`、模型字段和新的 `kind/stage` 值。

## 7. 稳定错误码

除 1A 已有错误码外，1B 至少冻结：

```text
MODEL_NOT_FOUND
MODEL_NOT_INSTALLED
MODEL_DOWNLOAD_FAILED
MODEL_DOWNLOAD_CANCELLED
MODEL_HASH_MISMATCH
MODEL_LICENSE_REQUIRED
MODEL_DISK_SPACE_INSUFFICIENT
MODEL_RUNTIME_UNAVAILABLE
TRANSCRIPTION_NOT_READY
TRANSCRIPTION_FAILED
TRANSCRIPTION_CANCELLED
TRANSCRIPTION_INPUT_CHANGED
TRANSCRIPTION_UNSUPPORTED_LANGUAGE
JOB_NOT_FOUND
JOB_INVALID_STATE
JOB_INTERRUPTED
UNAUTHORIZED
FORBIDDEN
CONFLICT
INTERNAL_ERROR
```

错误码是机器可判断的稳定值；message 可本地化但不能承担状态判断。HTTP 状态码沿用 1A：未授权 401、资源不存在 404、参数或状态冲突 400/409、内部错误 500。

## 8. SQLite migration v2 逻辑契约

阶段 1B 新增下一不可变迁移版本 `v2`，不得修改已发布 v1 SQL。v2 至少提供：

```text
model_installations
  model_id TEXT PRIMARY KEY
  provider TEXT NOT NULL
  revision TEXT NOT NULL
  status TEXT NOT NULL
  install_dir TEXT NOT NULL
  expected_bytes INTEGER NOT NULL
  installed_bytes INTEGER NOT NULL
  manifest_sha256 TEXT NOT NULL
  license_id TEXT NOT NULL
  last_error TEXT NULL
  updated_at TEXT NOT NULL

transcripts
  id TEXT PRIMARY KEY
  asset_id TEXT NOT NULL REFERENCES assets(id)
  status TEXT NOT NULL
  language TEXT NOT NULL
  provider TEXT NOT NULL
  model_id TEXT NOT NULL
  model_revision TEXT NOT NULL
  source_fingerprint TEXT NOT NULL
  duration_us INTEGER NOT NULL
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

transcript_segments
  id TEXT PRIMARY KEY
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE
  ordinal INTEGER NOT NULL
  start_us INTEGER NOT NULL
  end_us INTEGER NOT NULL
  text TEXT NOT NULL
  confidence REAL NULL

transcript_words
  id TEXT PRIMARY KEY
  segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE
  ordinal INTEGER NOT NULL
  start_us INTEGER NOT NULL
  end_us INTEGER NOT NULL
  text TEXT NOT NULL
  confidence REAL NULL
```

对 `jobs` 的扩展必须保持 v1 行兼容，并允许持久化 `asset_id`、`model_id`、`model_revision`、`input_fingerprint`、`resource_class`、`result_json` 或等价字段。迁移执行器必须沿用 1A 的备份、事务、checksum、未知版本拒绝和失败回滚语义；真实重启验证必须证明 v2 数据可读。

## 9. 文件与所有权边界

### YeJing

写入范围：`services/core/src/**`、`services/core/tests/**`、`resources/model-manifests/**`；仅为 ASR 真实验证必要时新增 `tools/verification/**`。

负责 Core Provider、manifest、下载器、模型安装、ASR Job、Transcript Repository/API、迁移和 Core 测试。

### ZhangSan

写入范围：`packages/contracts/**`、`apps/desktop/electron/**`、`apps/desktop/src/**`、`apps/desktop/tests/**`、`apps/desktop/e2e/**`。

负责共享 DTO、Core Client、IPC、模型确认/下载进度/错误恢复界面、Transcript 查看、桌面测试和真实 Electron E2E。

### 共享规则

- 两方不得修改对方所有权范围或本文件语义。
- 发现契约缺口先向 LiuWei 提交变更请求，未获批准不得单方面调整 DTO、错误码、状态机或 API。
- 不得回退用户或其他 Agent 的修改，不得将绝对路径、管理令牌或模型安装路径泄露给 Renderer。

## 10. 开发与独立验收清单

开发者验证不等同于最终验收。完成后由 LiuKeAi 独立检查 diff，并逐项记录命令、环境、结果、证据路径和剩余风险：

1. manifest、revision、许可证、大小和 SHA-256。
2. 未安装模型确认界面及拒绝下载后的非 ASR 功能。
3. 下载进度、暂停/取消、断点续传、失败重试、哈希失败和磁盘不足。
4. 运行时缺失和本地处理隐私边界。
5. 中文及中英混合真实音频转录。
6. Transcript 时间戳、顺序、只读保存和素材 fingerprint 绑定。
7. 素材变化后的转录失效。
8. Core 强制停止后的 `interrupted` 恢复。
9. 真实 Electron E2E、打包 runtime、manifest、许可证和启动验证。
10. Core 覆盖率不低于 80%，前端/契约/CI/打包命令通过。

干净 Windows、无开发环境安装、GPU 编码器矩阵和暂时无法取得的硬件/长视频样本继续记录为“未验证”，不得用本机结果替代。

在 LiuKeAi 输出完整通过报告、LiuWei 确认阶段准入前，不得启动阶段 1C。
