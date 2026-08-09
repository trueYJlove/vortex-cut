# 阶段 1 可用剪辑基础详细设计

> 负责人：LiuWei（架构师）  
> 状态：设计基线 v1.0  
> 日期：2026-08-09  
> 依据：`ARCHITECTURE.md`、`docs/STAGE0_DETAILED_DESIGN.md`、`docs/adr/0001-stage0-exit-and-stage1-entry.md`、阶段 0 验收记录及 2026-08-09 需求确认

## 1. 目标与退出条件

阶段 1 将阶段 0 的桌面壳、Core Sidecar、FFmpeg 和安装包技术基线扩展为一个真正可使用、但不依赖 LLM 的本地剪辑工作台。

核心闭环固定为：

```text
创建项目
  -> 导入视频、音频、图片或文本
  -> 探测并生成代理、缩略图、波形和场景索引
  -> 首次使用时按用户确认下载本地转录模型
  -> 本地转录视频或音频
  -> 按转录文本选择、删除、排序和微调片段
  -> 修正并生成字幕
  -> 交互预览
  -> 生成权威预览
  -> 导出 1080x1920 H.264/AAC 成片
```

阶段 1 的退出条件是：用户不依赖 AI 推理，也能在关闭项目或应用、重新启动后继续完成“导入 -> 按文本剪辑 -> 字幕 -> 预览 -> 导出”，且原素材始终只读。

## 2. 已确认产品决策

1. 阶段 0 本机可解决项作为阶段 1 编码前置门禁；干净 Windows 和多品牌 GPU 等环境性项目延期验证，但保留未验证状态。
2. 阶段 1 不包含 LLM 自动选片、多个 AI 粗剪候选、文生图、文生视频、自动发布或专业多轨时间线。
3. 本地转录使用内置 `faster-whisper` 运行能力，模型不进入安装包。第一次使用转录功能时，经用户明确确认后下载。
4. 未安装转录模型时，项目、素材导入、手工剪辑、预览和导出仍可使用。
5. 编辑器实现视频播放、文本同步选段、片段删除/拆分/排序/首尾微调、字幕修正、少量字幕预设、撤销/重做和自动保存。
6. 视频获得完整处理能力；音频支持导入和转录；图片支持导入及基础定时展示；文本支持导入为转录稿或字幕稿。
7. 阶段 1 时间线只有单主画面轨和单字幕轨。视频内嵌音频随视频片段处理；独立音频不进入多轨混音。
8. 权威输出固定为 `1080x1920`、H.264/AAC、CFR 30fps，并支持背景模糊、居中裁切和完整画面留边三种布局。
9. 只导出本地文件，不登录或自动发布到任何平台。
10. 阶段 1 按 1A、1B、1C 三个可独立验收的增量交付。

## 3. 非目标

- 不实现任意数量音视频轨、关键帧动画、蒙版、专业调色、复杂转场或混音台。
- 不实现 BGM、独立旁白编排、说话人分离、OCR、视觉理解或游戏事件识别。
- 不实现自然语言 TimelinePatch；但会冻结可被阶段 2 复用的 Timeline Patch v1 结构。
- 不提供云端 ASR，不上传用户媒体、音频或转录正文。
- 不把模型下载伪装成安装过程的一部分，不在用户未确认时后台下载大文件。
- 不将代理文件用于最终导出。
- 不复制 Premiere、DaVinci Resolve 或剪映的完整工作方式。

## 4. 阶段 0 前置门禁

阶段 1 详细设计可以完成，但功能编码开始前必须关闭以下本机可执行项：

| 门禁 | 通过条件 | 责任建议 |
|---|---|---|
| G0-1 Python 覆盖率 | `services/core/src` 总覆盖率不低于 80%，测试全部通过 | YeJing |
| G0-2 媒体兼容 | VFR、无音轨、中文路径素材完成真实 proxy 和竖屏输出验证 | YeJing |
| G0-3 构建自举 | 一个受支持命令可从无本地产物状态准备 Sidecar、FFmpeg、electron-builder 依赖并生成安装包 | ZhangSan |
| G0-4 独立验收 | LiuKeAi 对上述结果输出通过/未通过/未验证报告 | LiuKeAi |

以下项目不阻塞阶段 1 编码，但必须持续显示为“未验证”，不得写成通过：

- 无开发环境或干净 Windows x64 机器安装、升级和卸载。
- NVIDIA、AMD、Intel 硬件编码完整矩阵。
- 5 GB 以上和 1-2 小时真实游戏录像性能。

建议新增统一命令：

```text
pnpm bootstrap:windows    准备并校验构建依赖
pnpm package:win          自动调用 bootstrap preflight 后打包
pnpm verify:stage0        执行本机阶段 0 收尾矩阵
```

## 5. 架构决策

### 5.1 延续模块化单体

阶段 1 不拆分微服务。Electron 主进程、React Renderer、Python Core、SQLite 和受控媒体/ASR 子进程仍随一个桌面产品发布。

边界保持不变：

- Electron 主进程负责窗口、文件选择、系统凭据、受限本地文件协议和 Sidecar 生命周期。
- Renderer 只获得实体 ID、受限播放 URL 和 UI 会话令牌，不获得输入素材绝对路径或管理令牌。
- Core 负责项目、素材、分析、时间线、任务、预览、渲染和数据库。
- FFmpeg、FFprobe 和 ASR 在 Core 管理下以参数数组或受控 Python Worker 执行。
- 领域层不得导入 Electron、FastAPI、SQLite 或具体 ASR SDK。

### 5.2 数据访问与迁移

阶段 1 继续使用 Python 标准库 `sqlite3`，不在本阶段同时引入完整 ORM 重写。必须新增 Repository 接口和有序 SQL 迁移执行器，使领域服务不依赖 SQLite SQL。

迁移规则：

1. 建立 `schema_migrations` 表，迁移文件按不可变版本号顺序执行。
2. 每次迁移前执行 SQLite 在线备份到 `backups/app-{timestamp}.db`。
3. 单个迁移在事务中完成；失败时回滚、保持备份并禁止写入。
4. 已发布迁移不得修改，只能新增下一版本。
5. 阶段 0 的 `stage0.db` 在首次启动时复制为 `app.db` 后迁移；原文件至少保留一个发布周期。
6. 应用版本降级遇到未知 schema 时只读打开或拒绝启动，不反向破坏数据库。

### 5.3 时间和标识

- 领域、数据库和 API 时间范围统一使用整数微秒。
- 时间戳使用 UTC ISO 8601。
- 实体 ID 为不可推测随机 ID，API 不接受路径作为业务实体标识。
- 原素材剪辑点绑定原素材时间戳；代理仅用于交互播放。

### 5.4 任务执行

阶段 1 仍使用 Core 内置持久化调度器，按资源类别限制并发：

```text
cpu_light       指纹、文本导入、时间线编译
cpu_heavy       ASR、场景检测、最终渲染
gpu_encode      硬件编码
disk_io         模型下载、代理、缩略图、波形
```

默认同一时间最多执行一个 `cpu_heavy` 任务和一个 `disk_io` 任务；最终渲染运行时暂停新 ASR。并发值以后可根据性能观察调整，不由 Renderer 自行决定。

## 6. 建议代码结构

```text
apps/desktop/src/
  main/
    sidecar/
    ipc/
    media-protocol/
  preload/
  app/
    shell/
    projects/
    assets/
    editor/
    jobs/
    settings/
  lib/
    core-client/

packages/contracts/src/
  generated/                 OpenAPI 生成 DTO
  ids.ts
  events.ts
  timeline.ts
  render-plan.ts

services/core/src/aivs_core/
  api/                       FastAPI 路由和 DTO 映射
  application/               用例编排和事务边界
  domain/
    projects/
    assets/
    analysis/
    timeline/
    render/
    jobs/
    models/
  infrastructure/
    sqlite/
      migrations/
      repositories/
    files/
    ffmpeg/
    asr/
  bootstrap.py

resources/
  model-manifests/
  subtitle-presets/
  platform-profiles/

tools/
  fixtures/
  verification/
```

迁移按业务切片逐步移动现有 `app.py`、`jobs.py` 和 `media/*`，不允许一次性重写后再集成。旧 API 在相应新 API 通过真实 E2E 后删除。

## 7. 文件与存储

### 7.1 应用目录

```text
%LOCALAPPDATA%/AIVideoStudio/
  app.db
  backups/
  config/
  logs/
  models/
    asr/
  shared-cache/
  projects/
  crash-reports/
```

### 7.2 项目目录

```text
projects/{project_id}/
  project.json
  managed-assets/
  generated-assets/
  proxy/
  analysis/
  thumbnails/
  waveforms/
  previews/
  exports/
  temp/
```

`project.json` 只保存可用于诊断和重新发现项目的最小元数据，SQLite 是项目事实来源。原始外部素材默认只引用，不自动复制。

所有临时产物先写入同卷 `temp/{job_id}`，校验完成后原子移动。缓存可以清理；用户导出、项目事实和不可再生的用户修改不得被缓存清理器删除。

## 8. 数据库 Schema v1

以下字段为逻辑定义；实现时可按 Repository 需要增加索引，但不得改变语义。

### 8.1 `projects`

```text
id TEXT PK
name TEXT NOT NULL
status TEXT NOT NULL             active/archived/missing
canvas_json TEXT NOT NULL
current_timeline_revision_id TEXT NULL
root_dir TEXT NOT NULL           仅基础设施层读取
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
last_opened_at TEXT NOT NULL
```

项目名称 1-120 字符；画布阶段 1 固定为 1080x1920、30/1，但仍以版本化 JSON 保存。

### 8.2 `assets`

```text
id TEXT PK
project_id TEXT NOT NULL FK projects
kind TEXT NOT NULL               video/audio/image/text
storage_mode TEXT NOT NULL       external/managed/generated
display_name TEXT NOT NULL
media_info_json TEXT NULL
fingerprint TEXT NOT NULL
size_bytes INTEGER NOT NULL
modified_at TEXT NULL
availability TEXT NOT NULL       available/missing/changed/unsupported
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 8.3 `asset_locations`

```text
asset_id TEXT PK FK assets
uri TEXT NOT NULL                file:// 仅基础设施层解析
last_verified_at TEXT NOT NULL
```

绝对路径不得出现在 UI DTO、日志默认字段或时间线 JSON 中。

### 8.4 `asset_derivatives`

```text
id TEXT PK
asset_id TEXT NOT NULL FK assets
kind TEXT NOT NULL               proxy/thumbnail/waveform/audio_extract
cache_key TEXT NOT NULL UNIQUE
uri TEXT NOT NULL
media_info_json TEXT NULL
size_bytes INTEGER NOT NULL
sha256 TEXT NOT NULL
tool_version TEXT NOT NULL
created_at TEXT NOT NULL
last_accessed_at TEXT NOT NULL
```

### 8.5 `transcripts`

```text
id TEXT PK
asset_id TEXT NOT NULL FK assets
status TEXT NOT NULL              pending/ready/stale/failed
language TEXT NOT NULL
model_id TEXT NOT NULL
model_revision TEXT NOT NULL
source_fingerprint TEXT NOT NULL
duration_us INTEGER NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### 8.6 `transcript_segments` 和 `transcript_words`

```text
transcript_segments:
  id TEXT PK
  transcript_id TEXT NOT NULL FK transcripts
  ordinal INTEGER NOT NULL
  start_us INTEGER NOT NULL
  end_us INTEGER NOT NULL
  text TEXT NOT NULL
  confidence REAL NULL

transcript_words:
  id TEXT PK
  segment_id TEXT NOT NULL FK transcript_segments
  ordinal INTEGER NOT NULL
  start_us INTEGER NOT NULL
  end_us INTEGER NOT NULL
  text TEXT NOT NULL
  probability REAL NULL
```

分段必须按时间有序且不越过素材时长；文本修改不覆盖原始 ASR 记录，而是在字幕或用户修订层保存。

### 8.7 `scenes`

```text
id TEXT PK
asset_id TEXT NOT NULL FK assets
ordinal INTEGER NOT NULL
start_us INTEGER NOT NULL
end_us INTEGER NOT NULL
score REAL NULL
thumbnail_derivative_id TEXT NULL
detector_version TEXT NOT NULL
```

### 8.8 `timeline_revisions`

```text
id TEXT PK
project_id TEXT NOT NULL FK projects
parent_revision_id TEXT NULL FK timeline_revisions
schema_version INTEGER NOT NULL
document_json TEXT NOT NULL
document_sha256 TEXT NOT NULL
summary TEXT NOT NULL
created_by TEXT NOT NULL           user/system/import
created_at TEXT NOT NULL
```

Revision 不可更新。撤销/重做只移动项目当前版本指针；从旧版本继续编辑会创建新分支。

### 8.9 `timeline_drafts`

```text
project_id TEXT PK FK projects
base_revision_id TEXT NOT NULL
document_json TEXT NOT NULL
updated_at TEXT NOT NULL
```

拖动中的高频状态最多每 500 ms 落盘一次；鼠标释放、文本失焦、删除、移动、拆分和布局切换必须形成正式 revision。

### 8.10 `jobs` 扩展

在阶段 0 字段基础上增加：

```text
project_id TEXT NULL FK projects
resource_class TEXT NOT NULL
idempotency_key TEXT NULL UNIQUE
parent_job_id TEXT NULL FK jobs
max_attempts INTEGER NOT NULL DEFAULT 1
next_run_at TEXT NULL
result_json TEXT NULL
```

阶段 1 任务类型：

```text
asset_probe
proxy_generate
thumbnail_generate
waveform_generate
scene_detect
model_download
transcribe
authoritative_preview
final_export
```

### 8.11 `model_installations`

```text
model_id TEXT PK
provider TEXT NOT NULL
revision TEXT NOT NULL
status TEXT NOT NULL               absent/downloading/installed/corrupt
install_dir TEXT NOT NULL
expected_bytes INTEGER NOT NULL
installed_bytes INTEGER NOT NULL
manifest_sha256 TEXT NOT NULL
license_id TEXT NOT NULL
last_error TEXT NULL
updated_at TEXT NOT NULL
```

### 8.12 `render_artifacts` 和 `export_records`

```text
render_artifacts:
  id TEXT PK
  project_id TEXT NOT NULL
  timeline_revision_id TEXT NOT NULL
  kind TEXT NOT NULL               authoritative_preview/final_export
  render_plan_json TEXT NOT NULL
  uri TEXT NOT NULL
  media_info_json TEXT NOT NULL
  size_bytes INTEGER NOT NULL
  sha256 TEXT NOT NULL
  created_at TEXT NOT NULL

export_records:
  id TEXT PK
  project_id TEXT NOT NULL
  timeline_revision_id TEXT NOT NULL
  artifact_id TEXT NOT NULL
  profile_id TEXT NOT NULL
  destination_uri TEXT NOT NULL
  created_at TEXT NOT NULL
```

## 9. 素材导入和派生产物

### 9.1 文件选择与授权

Electron 主进程使用系统文件对话框，允许一次选择多个支持文件。主进程逐个创建短期 `file_grant`，Renderer 只把 grant ID 提交给 Core。

支持扩展名只是文件对话框提示，实际类型必须通过内容探测确认。阶段 1 至少覆盖：

- 视频：MP4、MOV、MKV、WebM。
- 音频：WAV、MP3、M4A、AAC、FLAC。
- 图片：PNG、JPEG、WebP。
- 文本：UTF-8 TXT、SRT、VTT。

### 9.2 注册事务

导入流程：

1. 校验 grant、文件存在性和大小上限。
2. 计算快速指纹：大小、mtime、首尾采样块哈希；后台补充完整 SHA-256。
3. FFprobe 或结构化解析器确认类型和元数据。
4. 在单个事务中创建 Asset 和派生任务。
5. 返回 Asset DTO，不等待所有派生产物完成。
6. UI 在素材项上分别显示代理、波形、场景和转录状态。

重复导入同一项目、同一指纹的文件时返回现有 Asset，并提示已存在；不得重复排队。

### 9.3 外部素材变化

打开项目和开始渲染前重新校验大小、mtime 和采样指纹。

- `missing`：禁止渲染，显示“重新定位”。
- `changed`：禁止复用旧分析和代理，用户确认后重新分析。
- 重新定位到同指纹文件：保留分析和时间线引用。
- 指纹不同：作为替换操作，显式使相关派生产物和预览失效。

### 9.4 代理、缩略图和波形

- 视频代理：最大 960x540、CFR 30fps、H.264、可随机访问、保留音频。
- 缩略图：场景首帧或等间隔 JPEG/WebP，长边不超过 320px。
- 波形：提取单声道 16 kHz 峰值数据，输出版本化二进制或 JSON；UI 不直接解析整段 PCM。
- 图片预览：生成受控尺寸缩略图；原图只读。
- 文本：解析编码和格式，不生成媒体代理。

所有派生产物缓存键包含源指纹、工具版本和参数版本。

## 10. 本地转录与模型管理

### 10.1 Provider 边界

定义能力接口：

```text
SpeechToTextProvider.transcribe(
  audio_uri,
  language,
  model_id,
  word_timestamps,
  cancel_token,
  progress_callback
) -> TranscriptResult
```

阶段 1 只实现 `FasterWhisperProvider`。`faster-whisper` 和 CTranslate2 运行库随 Sidecar 打包；仅模型权重首次使用时下载。Provider 不持有项目状态，结果必须经过时间范围和排序校验后再入库。

### 10.2 模型目录

阶段 1 至少提供：

- 推荐：多语言 `small`，面向普通 PC 和首次使用。
- 可选：多语言 `medium`，质量更高但下载、磁盘和推理成本更大。

显示名称、准确下载字节数、安装后占用、来源、许可证和固定 revision 全部来自版本化 manifest，不在 UI 中硬编码。实现前必须锁定模型仓库 revision 和每个文件 SHA-256。

### 10.3 首次下载交互

用户第一次点击“开始转录”且没有已安装模型时，显示确认对话框：

```text
标题：需要下载本地语音识别模型
用途：在你的电脑上把视频或音频转换为文字
隐私：素材不会上传到模型提供方
模型：Whisper small（推荐）
下载大小：来自 manifest 的实际值
磁盘占用：来自 manifest 的实际值
保存位置：%LOCALAPPDATA%/AIVideoStudio/models/asr
网络：需要联网一次，安装后可离线使用
操作：下载并转录 / 选择其他模型 / 暂不转录
```

下载界面必须具备：

- 总进度、已下载/总大小、当前文件和状态。
- 取消；取消后保留可安全续传的 `.partial` 文件。
- HTTP Range 续传；服务器不支持 Range 时明确重新下载。
- 指数退避重试和手动重试。
- 磁盘空间预检，至少预留预计安装大小加 20%。
- 每文件 SHA-256 和总 manifest 校验。
- 校验失败时删除损坏最终目录，但保留诊断信息。
- 下载到临时目录，全部通过后原子重命名为固定 revision 目录。
- 模型设置页可以查看、切换和删除未被运行任务使用的模型。

模型下载任务不携带用户媒体，不需要“上传素材”确认。任何代理或镜像源变更必须在 UI 展示实际来源域名。

### 10.4 转录流程

1. 对视频/音频生成标准化单声道 16 kHz 音频派生物。
2. 校验模型安装和音频指纹。
3. 启动独立 ASR Worker，开启词级时间戳。
4. 每完成一批分段写入临时结果并更新任务进度。
5. 完整结果进行排序、边界、重叠和素材时长校验。
6. 在事务中替换同模型、同源指纹的未编辑 Transcript。
7. 取消时终止 Worker，临时结果不作为 ready Transcript。

语言默认自动检测，用户可以在任务启动前选择中文、英文或自动。中英混合使用多语言模型。

## 11. Timeline Schema v1

时间线是纯 JSON 领域契约，不包含绝对路径、FFmpeg 参数或 UI 像素坐标。

```json
{
  "schema_version": 1,
  "project_id": "project_id",
  "canvas": {
    "width": 1080,
    "height": 1920,
    "fps_num": 30,
    "fps_den": 1,
    "background_color": "#000000"
  },
  "tracks": [
    { "id": "V1", "kind": "visual", "locked": false },
    { "id": "C1", "kind": "caption", "locked": false }
  ],
  "clips": [
    {
      "id": "clip_id",
      "track_id": "V1",
      "order_index": 0,
      "asset_id": "asset_id",
      "asset_kind": "video",
      "source_start_us": 0,
      "source_end_us": 5000000,
      "timeline_start_us": 0,
      "timeline_end_us": 5000000,
      "layout": "blurred_background",
      "audio": { "enabled": true, "gain_db": 0.0 }
    }
  ],
  "captions": [
    {
      "id": "caption_id",
      "track_id": "C1",
      "start_us": 0,
      "end_us": 1800000,
      "text": "字幕文本",
      "preset_id": "default-bottom",
      "source_segment_ids": ["segment_id"]
    }
  ],
  "provenance": {
    "created_by": "user",
    "source_transcript_ids": []
  }
}
```

### 11.1 约束

- `V1` 片段按 `order_index` 连续排列，不允许重叠或隐式空隙。
- 视频片段源范围必须位于 Asset 时长内，且时长至少 100 ms。
- 图片片段 `source_start_us/source_end_us` 为 `null`，阶段 1 默认展示 3 秒，可调整为 0.5-30 秒。
- 文本和独立音频不能作为 `V1` clip。
- 时间线时间由顺序和片段时长确定，服务端重算并拒绝客户端伪造的不一致值。
- 字幕不得越过时间线总时长，最短 200 ms，相邻字幕可以接触但不得重叠。
- 布局只能为 `blurred_background`、`crop_fill`、`fit`。
- 阶段 1 不支持速度变化、反放、画中画、转场和独立音频项目。对应字段不得以“以后会用”为由提前接受任意值。

### 11.2 Timeline Patch v1

Renderer 的每次正式编辑提交：

```json
{
  "schema_version": 1,
  "base_revision_id": "revision_id",
  "operations": [
    { "op": "remove_clip", "clip_id": "clip_id" },
    { "op": "move_clip", "clip_id": "clip_id", "to_index": 1 },
    { "op": "trim_clip", "clip_id": "clip_id", "source_start_us": 100000, "source_end_us": 4900000 },
    { "op": "split_clip", "clip_id": "clip_id", "source_time_us": 2000000 },
    { "op": "set_layout", "clip_id": "clip_id", "layout": "crop_fill" },
    { "op": "update_caption", "caption_id": "caption_id", "text": "修正文本" }
  ],
  "summary": "删除 1 个片段并修正字幕"
}
```

Core 必须校验引用、范围、锁定、顺序和 base revision。base 已过期返回 `409 TIMELINE_CONFLICT`，不静默覆盖。阶段 2 的自然语言修改也只能生成同一 Patch 契约。

## 12. 文本剪辑规则

1. 用户选择转录句子创建片段时，使用所选 segment/word 的真实源时间范围，并可配置首尾各 100-300 ms 保护边界。
2. 删除文本对应片段只影响当前 Timeline Revision，不删除 Transcript 或 Asset。
3. 同一源素材可以被多次引用。
4. 调整文本片段顺序等价于移动 clip，并同步移动由该 clip 派生的字幕。
5. 字幕文本修正只修改 Timeline Caption，不篡改原始 ASR Transcript。
6. 用户可以从完整素材、所选转录段或空时间线开始。
7. 删除最后一个画面片段后允许保存空时间线，但禁止预览和导出，并显示明确原因。

## 13. 字幕

阶段 1 使用 ASS/libass 烧录字幕，提供 3 个内置预设：

```text
default-bottom     底部居中、白字黑描边
game-safe-bottom   上移避开常见游戏 HUD
high-contrast      高对比底色，适合复杂画面
```

预设定义字体候选、字号、描边、阴影、颜色、安全边距和最大行宽。字体必须随安装包携带或使用经过许可的系统字体回退；缺失字体不得静默改变布局。

字幕编辑支持文本、开始/结束时间和预设切换，不开放任意 ASS 标签或字体文件路径。导出前校验空文本、重叠、越界、不可显示字符和安全区。

## 14. Render Plan v1

Timeline Revision 不能直接生成 shell 字符串。Core 先编译纯数据 Render Plan：

```json
{
  "schema_version": 1,
  "timeline_revision_id": "revision_id",
  "mode": "authoritative_preview",
  "inputs": [
    { "input_id": "I0", "asset_id": "asset_id", "fingerprint": "sha256" }
  ],
  "segments": [
    {
      "clip_id": "clip_id",
      "input_id": "I0",
      "source_start_us": 0,
      "source_end_us": 5000000,
      "layout": "blurred_background",
      "audio_enabled": true,
      "gain_db": 0.0
    }
  ],
  "captions": { "format": "ass", "preset_version": 1 },
  "output": {
    "width": 540,
    "height": 960,
    "fps_num": 30,
    "fps_den": 1,
    "video_codec": "h264",
    "audio_codec": "aac",
    "pixel_format": "yuv420p"
  }
}
```

规则：

- `authoritative_preview` 为 540x960，使用和最终导出相同的片段、布局、字幕和音频计划。
- `final_export` 为 1080x1920，并从原素材读取。
- Render Plan 保存到产物记录中，用于复现和诊断。
- 基础设施层将 `asset_id` 解析为路径，再由受控 builder 生成 FFmpeg argv 和 filter graph。
- 用户文本、文件名和路径不得作为 filter graph 代码拼接；字幕通过安全生成的 ASS 文件输入。
- 输出完成后 FFprobe 校验分辨率、编码、帧率、像素格式、时长和音轨，并计算 SHA-256。

## 15. 预览与播放

### 15.1 交互预览

Renderer 播放代理，使用 DOM/CSS 或 Canvas 叠加当前布局和字幕。它用于快速拖动和文本选段，不声称像素级等同成片。

素材和产物通过 Electron 注册的受限 `aivideo-media://{opaque_token}` 协议播放：

- token 由主进程根据 Core 内部解析结果短期签发。
- 协议只允许读取已注册 AssetDerivative 或 RenderArtifact。
- 防止目录遍历，禁止 Renderer 构造任意本地路径。
- 支持 Range 请求，保证视频拖动。

### 15.2 权威预览

用户点击“生成预览”时，对当前正式 Timeline Revision 创建任务。相同 revision、Render Plan 版本和工具版本复用成功产物。时间线变化后旧预览显示为“已过期”，但保留到缓存清理。

只有权威预览通过产物校验后，UI 才显示“可验收预览”。

## 16. API v1

API 前缀继续为 `/api/v1`。阶段 1 新增以下资源，具体 DTO 由 OpenAPI 生成 TypeScript 类型，禁止长期手写两套契约。

### 16.1 项目

```text
POST   /projects
GET    /projects
GET    /projects/{project_id}
PATCH  /projects/{project_id}
POST   /projects/{project_id}/open
POST   /projects/{project_id}/archive
```

删除项目不进入阶段 1；避免误删用户项目和外部引用。归档只修改状态，不删除文件。

### 16.2 素材

```text
POST   /projects/{project_id}/assets/import
GET    /projects/{project_id}/assets
GET    /projects/{project_id}/assets/{asset_id}
POST   /projects/{project_id}/assets/{asset_id}/relocate
POST   /projects/{project_id}/assets/{asset_id}/reanalyze
GET    /projects/{project_id}/assets/{asset_id}/derivatives
POST   /projects/{project_id}/assets/{asset_id}/playback-ticket
```

`import` 接收 `grant_ids[]`，不接收路径。`relocate` 接收新 grant ID 和预期 Asset ID。

### 16.3 转录与模型

```text
GET    /asr/models
POST   /asr/models/{model_id}/download
DELETE /asr/models/{model_id}
POST   /projects/{project_id}/assets/{asset_id}/transcriptions
GET    /projects/{project_id}/assets/{asset_id}/transcriptions
GET    /transcriptions/{transcript_id}/segments
```

模型删除遇到运行任务返回 `409 MODEL_IN_USE`。转录创建必须指定 model ID、revision 和 language。

### 16.4 时间线

```text
POST   /projects/{project_id}/timelines
GET    /projects/{project_id}/timeline
POST   /projects/{project_id}/timeline/patches
POST   /projects/{project_id}/timeline/undo
POST   /projects/{project_id}/timeline/redo
PUT    /projects/{project_id}/timeline/draft
DELETE /projects/{project_id}/timeline/draft
GET    /projects/{project_id}/timeline/revisions
GET    /timeline-revisions/{revision_id}
```

所有正式修改返回新 revision 和新的项目 ETag。

### 16.5 预览、导出和任务

```text
POST   /projects/{project_id}/previews
GET    /projects/{project_id}/previews
POST   /projects/{project_id}/exports
GET    /projects/{project_id}/exports
GET    /jobs
GET    /jobs/{job_id}
POST   /jobs/{job_id}/cancel
POST   /jobs/{job_id}/retry
```

导出目的路径仍通过 Electron 保存对话框产生的受限 destination grant 提交，Renderer 不提交绝对路径。

### 16.6 错误契约

统一返回：

```json
{
  "error": {
    "code": "TIMELINE_CONFLICT",
    "message": "时间线已在其他操作中更新",
    "trace_id": "trace_id",
    "details": {}
  }
}
```

新增错误至少包括：

```text
PROJECT_NOT_FOUND
ASSET_MISSING
ASSET_CHANGED
ASSET_DUPLICATE
DERIVATIVE_NOT_READY
MODEL_NOT_INSTALLED
MODEL_DOWNLOAD_FAILED
MODEL_HASH_MISMATCH
MODEL_IN_USE
TRANSCRIPTION_FAILED
TIMELINE_INVALID
TIMELINE_CONFLICT
TIMELINE_EMPTY
PREVIEW_STALE
EXPORT_DESTINATION_INVALID
MIGRATION_FAILED
DISK_SPACE_LOW
```

## 17. 进程与事件协议

Sidecar `ready.json` 和父进程监督协议保持阶段 0 兼容。协议版本只有出现不兼容消息变化时递增；新增 API 本身不要求破坏旧握手。

WebSocket 事件：

```text
project.updated
asset.updated
derivative.updated
model.updated
transcript.updated
timeline.updated
job.created
job.updated
job.finished
```

每个事件包含 `event_id`、`occurred_at`、实体 ID 和最小状态摘要，不发送完整 transcript 或 timeline。Renderer 收到事件后按 ID GET 当前事实；断线后也以 Core/SQLite 当前状态为准。

## 18. 桌面交互设计

### 18.1 项目首页

- 最近项目列表：名称、更新时间、素材数量、当前时长和状态。
- 新建项目：只要求项目名，画布使用阶段 1 默认值。
- 打开项目时检查素材可用性和遗留任务恢复。
- 项目卡片可归档，不提供危险的直接永久删除。

### 18.2 编辑工作台

采用安静、工作型布局：

```text
顶部：项目名、保存状态、撤销/重做、任务状态、生成预览、导出
左侧：素材 / 转录 两个标签页
中央：播放器和画面布局控制
底部：简化时间线，固定 V1 和 C1
右侧：所选片段或字幕属性
```

不得使用卡片套卡片或营销式首屏。播放器和时间线拥有稳定尺寸，任务状态、长文件名和中文文本不能引起布局跳动。图标按钮使用现有图标库或 Lucide，并提供 tooltip。

### 18.3 状态反馈

- 自动保存：显示“保存中 / 已保存 / 保存失败”，不依赖用户猜测。
- 素材处理：代理、波形、转录分别显示状态和重试入口。
- 模型缺失：只在触发转录时拦截，不用全屏阻塞其他功能。
- 预览过期：时间线修改后立即标记，不继续把旧视频称为当前预览。
- 导出完成：提供播放、打开文件和在资源管理器中显示。
- 错误消息提供用户可执行动作，详细日志通过诊断入口查看。

## 19. 安全与隐私

1. Renderer 不获得 admin token、原素材路径、模型目录路径或任意文件访问能力。
2. 所有文件选择和导出位置由 Electron 系统对话框授权。
3. 模型下载只允许版本化 manifest 中的 HTTPS 来源，校验重定向目标和 SHA-256。
4. 阶段 1 不上传媒体、音频、图片、文本或转录。
5. 日志默认只记录 Asset ID、文件显示名的脱敏形式、任务 ID 和错误分类。
6. Transcript 正文不写普通日志；诊断包导出前列出内容并由用户确认。
7. FFmpeg、FFprobe 和外部进程全部使用参数数组，有超时、取消和进程树清理。
8. ASS 文本必须转义，不允许用户文本注入脚本标签或 filter graph。

## 20. 崩溃恢复与幂等

- Core 启动时将 `running/cancelling` 转为 `interrupted`。
- `proxy_generate`、缩略图、波形、场景和模型下载可按幂等键自动恢复或复用。
- ASR 任务默认提示重试；只有完整校验的 Transcript 才标记 ready。
- 权威预览可以自动重试一次；最终导出不自动覆盖用户目标文件。
- Timeline Draft 每 500 ms 节流保存，重启后提示恢复草稿或回到最后正式版本。
- 成功产物写入数据库和文件原子移动必须处于可恢复顺序：文件先校验，数据库后提交。
- 相同 Asset 指纹、工具版本和参数不重复生成派生物。

## 21. 增量交付

### 21.1 阶段 1A：项目与素材基础

范围：

- 数据库迁移和备份。
- Project、Asset、AssetLocation、Derivative Repository。
- 项目首页和工作台壳。
- 多文件导入、素材重新定位。
- 代理、缩略图、波形、场景切分。
- 持久化任务、恢复、取消、重试和幂等。
- 受限媒体播放协议。

退出条件：关闭并重启应用后项目和素材仍存在；视频可通过代理流畅拖动；素材变化可被识别；派生任务可恢复。

### 21.2 阶段 1B：转录与文本剪辑

范围：

- 模型 manifest、友好下载、校验、续传和模型管理。
- faster-whisper Provider 和转录任务。
- Transcript/Segment/Word 数据。
- Timeline Schema v1、Patch v1 和不可变 Revision。
- 文本选段、删除、移动、拆分和首尾微调。
- 字幕生成、修正、预设。
- 自动保存、撤销、重做和草稿恢复。

退出条件：用户可从真实中文或中英混合视频生成词级转录，按文本构建并修改时间线，重启后继续编辑。

### 21.3 阶段 1C：预览与导出

范围：

- Render Plan v1 编译和验证。
- 三种横转竖布局。
- 权威预览、过期检测和复用。
- ASS 字幕烧录。
- 1080x1920 H.264/AAC CFR 30fps 最终导出。
- 播放、打开文件、资源管理器定位和导出记录。
- 完整真实 Electron E2E 和安装包复验。

退出条件：以原素材生成与权威预览内容一致的最终成片，产物校验通过，取消和崩溃不产生伪成功文件。

## 22. 任务拆分原则

详细实施前由 LiuWei 为每个增量冻结 OpenAPI、Timeline 和 Render Plan 契约，再拆分开发所有权。建议边界：

- YeJing：Core 领域、Repository、迁移、任务、媒体、ASR、Timeline、Render Plan 和 Python 测试。
- ZhangSan：Electron/React、受限文件协议、Core Client、编辑器 UI、OpenAPI 生成契约和桌面测试。
- 共享契约：由 LiuWei 冻结；任何一方发现契约缺口先提交变更请求，不单边修改另一侧依赖。
- LiuKeAi：每个增量完成后独立检查 diff、运行自动化和真实链路验收，输出通过/未通过/未验证报告。

只有文件所有权和接口依赖可清晰解耦时并行。数据库和 Core 同一切片不得同时由两个开发人员修改。

## 23. 测试素材

自动生成且可提交脚本的最小素材矩阵：

| ID | 素材 | 用途 |
|---|---|---|
| F1 | 30 秒 CFR 横屏、有音轨、中文语音 | 导入、代理、ASR、字幕、导出 |
| F2 | 30 秒 VFR 横屏、有音轨 | 时间映射和最终渲染 |
| F3 | 15 秒竖屏、无音轨 | 无音轨和布局 |
| F4 | 10 秒奇数尺寸视频 | 缩放和像素格式 |
| F5 | WAV 中文/英文混合语音 | 独立音频转录 |
| F6 | PNG/JPEG | 图片片段定时展示 |
| F7 | UTF-8 TXT、SRT、VTT | 文本/字幕导入 |
| F8 | 中文、空格和长路径下的 F1 | 路径安全 |
| F9 | 损坏或截断媒体 | 错误分类 |
| F10 | 10 分钟游戏录像 | 任务取消、性能观察 |

真实人工样本至少包含一段实际游戏录像和自然中文解说。测试仓库不提交未经许可的用户素材。

## 24. 自动化测试策略

### 24.1 Core 单元测试

- 迁移顺序、备份和失败回滚。
- Asset 指纹、重复导入、missing/changed/relocate。
- 时间范围、微秒换算和 VFR 映射。
- Timeline Schema、Patch、冲突、拆分、移动、修剪、撤销/重做。
- Render Plan 对三种布局、无音轨、图片和字幕的编译。
- 模型 manifest、下载续传、哈希失败、磁盘不足和取消。
- ASR 结果排序、越界和部分结果拒绝。
- 任务状态机、幂等、恢复和进程清理。

核心关键模块覆盖率门槛不低于 85%；阶段 0 收尾的全局门槛先保持不低于 80%。

### 24.2 契约和桌面测试

- OpenAPI 生成后工作区无未提交差异。
- Renderer 不使用管理接口或绝对路径。
- 项目首页、素材状态、编辑命令、自动保存和模型下载对话框组件测试。
- Core Client 对错误、409 冲突、WebSocket 断线和轮询回退测试。
- `aivideo-media` 协议 Range、过期 token 和目录遍历测试。

### 24.3 集成和 E2E

- 真实 FFmpeg/FFprobe 派生产物。
- 使用小型测试模型或固定受控 ASR fixture 的 Provider 集成；发布候选必须额外使用正式 small 模型真实转录。
- SQLite 迁移后打开阶段 0 数据库。
- 强制终止 Core 后恢复项目、草稿和 interrupted 任务。
- 真实 Electron：创建项目、导入、转录、文本选段、修正字幕、权威预览、导出。
- 最终视频 FFprobe 和 SHA-256 校验。

Mock 只能用于故障注入和 UI 单元测试，不能替代最终真实媒体 E2E。

## 25. 阶段 1 验收标准

### 25.1 阶段 1A

- [ ] 可创建、重命名、归档和重新打开项目。
- [ ] 可导入视频、音频、图片和文本，原素材不被修改。
- [ ] 重复素材不重复注册或重复生成派生物。
- [ ] 代理、缩略图、波形和场景索引真实生成并可取消。
- [ ] Renderer 不获得素材绝对路径，代理支持 Range 播放和拖动。
- [ ] 素材移动或改变后显示 missing/changed，并可重新定位。
- [ ] 应用异常退出后任务转为 interrupted，项目和派生产物不损坏。
- [ ] SQLite 迁移有备份、回滚和版本记录。

### 25.2 阶段 1B

- [ ] 未安装模型时点击转录，出现包含用途、隐私、大小、磁盘、位置和联网说明的确认界面。
- [ ] 用户拒绝下载后仍可继续使用非转录功能。
- [ ] 模型下载支持进度、取消、续传、重试、空间预检和 SHA-256 校验。
- [ ] 正式 small 模型可以对中文和中英混合素材生成词级时间戳。
- [ ] 转录取消后没有 ready 的部分 Transcript 或残留 Worker。
- [ ] 可按文本创建、删除、拆分、移动和微调片段。
- [ ] 可修正字幕且原始转录记录保持不变。
- [ ] 自动保存、撤销、重做和重启草稿恢复真实可用。
- [ ] Timeline Patch 冲突返回 409，不覆盖较新版本。

### 25.3 阶段 1C

- [ ] 三种布局均能生成权威预览和最终成片。
- [ ] 权威预览和最终导出共享同一 Render Plan 语义。
- [ ] 最终导出读取原素材而不是代理。
- [ ] 输出为 1080x1920、H.264/AAC、CFR 30fps、yuv420p。
- [ ] 无音轨素材导出时按配置生成合法静音 AAC 或明确无音轨策略，不能失败或伪成功。
- [ ] ASS 字幕无注入、越界、重叠或缺失字体问题。
- [ ] 时间线变化后旧权威预览立即标记过期。
- [ ] 取消预览/导出后 5 秒内无相关 FFmpeg，目标位置不存在伪成功文件。
- [ ] 导出产物经过 FFprobe 校验并计算 SHA-256。
- [ ] UI 可播放产物、打开文件并在资源管理器中定位。

### 25.4 质量和发布

- [ ] 阶段 0 本机前置门禁全部通过。
- [ ] `pnpm run ci`、Python lint/typecheck/test 和真实 Electron E2E 全部通过。
- [ ] Core 关键模块测试覆盖率不低于 85%。
- [ ] 安装包包含 ASR 运行库但不包含模型权重，资源清单和许可证完整。
- [ ] 安装包运行不依赖用户系统 Node、Python、FFmpeg 或 Whisper。
- [ ] 日志和错误响应不包含令牌、授权头、转录正文或未经脱敏的绝对路径。
- [ ] LiuKeAi 对每个增量和阶段 1 总体出具独立验收报告。
- [ ] 干净 Windows 和未覆盖 GPU 仍可标记未验证，但不得遗漏或伪装为通过。

## 26. 性能观察项

阶段 1 不以未经基线验证的硬指标阻塞所有功能，但必须记录：

- 30 秒、10 分钟和可获得的长视频导入、代理、波形、转录、预览和导出耗时。
- small/medium 模型下载大小、磁盘占用、CPU/GPU/内存峰值和实时倍率。
- 项目含 100、500、1000 个转录分段时的页面加载、搜索和编辑延迟。
- 100 个 Timeline Revision 的数据库大小和撤销/重做延迟。
- 应用空闲、播放、ASR 和渲染时的内存与 CPU。

任何会令普通 PC 长时间无响应的任务调度问题均为阻塞缺陷，不以“性能观察项”为由放行。

## 27. 风险与缓解

| 风险 | 缓解 |
|---|---|
| faster-whisper/CTranslate2 增大安装包并增加 PyInstaller 复杂度 | 1B 开始前先做打包 spike；运行库随包、模型外置 |
| 模型源在部分网络环境下载不稳定 | 续传、重试、固定 revision、可配置受信镜像并显示来源 |
| VFR 代理与原素材时间映射偏移 | 所有剪辑点绑定原时间；用 VFR 黄金样片逐段比对 |
| 时间线功能膨胀成专业 NLE | 固定 V1/C1 和明确不支持项，新增能力必须变更设计 |
| React 交互预览与最终渲染不一致 | 明确区分交互预览和权威预览，最终验收只认 Render Plan |
| 数据库从阶段 0 演进时破坏已有数据 | 复制、备份、事务迁移和真实旧库升级测试 |
| 模型/字体许可证遗漏 | manifest、第三方清单和安装包校验作为发布门禁 |
| 只有一台开发机导致兼容性证据不足 | 保持未验证状态，优先准备 Windows Sandbox/虚拟机方案 |

## 28. 实施顺序

1. 完成 G0-1 至 G0-4，并由 LiuKeAi 验收。
2. 冻结阶段 1A OpenAPI、迁移 v1、Asset DTO 和 Job 扩展。
3. 实施 1A Core 与桌面切片，完成独立验收。
4. 先完成 faster-whisper Sidecar 打包和正式 small 模型下载 spike。
5. 冻结 Transcript、Timeline Schema v1 和 Patch v1。
6. 实施 1B，并完成中文/中英混合真实转录验收。
7. 冻结 Render Plan v1、字幕预设和导出 Profile。
8. 实施 1C，并完成真实 Electron 全链路验收。
9. 重新构建安装包，记录大小、SHA-256、组件和许可证。
10. LiuKeAi 出具阶段 1 总体验收报告，LiuWei 根据报告做阶段退出决策。

## 29. 阶段退出决策

只有 1A、1B、1C 验收清单和质量门禁通过，且没有未关闭的结构性阻塞问题，LiuWei 才能确认阶段 1 完成。

干净 Windows 和暂时无法获得的 GPU 可以保留为明确未验证项，但以下问题不得延期到阶段 2：

- 项目或时间线无法可靠恢复。
- 原素材可能被修改或错误引用。
- VFR 时间映射存在可复现偏移。
- 模型下载不透明、不可取消或缺少哈希校验。
- Renderer 可访问任意本地路径。
- 权威预览与最终导出使用不同语义。
- 取消或崩溃产生伪成功产物。

阶段 1 通过后，阶段 2 才开始设计创作简报、制作配方、Provider 管理、候选召回排序和自然语言 TimelinePatch。
