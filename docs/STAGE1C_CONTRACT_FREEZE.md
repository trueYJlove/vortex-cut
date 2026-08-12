# 阶段 1C 契约冻结：文本剪辑、权威预览与最终导出

> 负责人：LiuWei（架构师）
> 状态：冻结，`stage1c-v1`
> 日期：2026-08-11
> 基线：`9adb85c feat(stage1b): 完成本地ASR转录与可靠性闭环`
> 依据：`ARCHITECTURE.md`、`docs/STAGE1_DETAILED_DESIGN.md`、
> `docs/STAGE1A_CONTRACT_FREEZE.md`、`docs/STAGE1B_CONTRACT_FREEZE.md` 及阶段 1B
> 最终独立复验报告

## 1. 已确认决策

2026-08-11 需求讨论确认以下决策：

1. 阶段 1C 承接阶段 1B 冻结时延后的 Timeline、TimelinePatch、文本剪辑和字幕编辑，
   并按 `1C-Editor -> 1C-Render` 两个顺序门禁交付。
2. 阶段 1 支持图片片段进入主画面轨；图片只支持固定时长和三种既有布局，不支持动画。
3. 最终导出不强制先生成最新权威预览。用户可以直接导出正式 Timeline Revision，但 UI
   必须明确显示“尚未生成当前版本预览”或“当前预览已过期”。

本文件是 ZhangSan、YeJing 和 LiuKeAi 的共享基线。DTO、错误码、状态机、数据库语义、
Render Plan 或验收要求存在缺口时，必须先向 LiuWei 提交变更请求；未经确认不得单方面改变。

## 2. 范围与非目标

### 2.1 1C-Editor 范围

- Timeline Schema v1、不可变 Timeline Revision、Timeline Patch v1。
- 从完整视频、转录选段、图片或空时间线创建和追加内容。
- 片段删除、移动、拆分、首尾微调、图片时长修改和布局选择。
- 从 Transcript 生成字幕，并支持字幕文本、时间和预设修改。
- 自动保存草稿、正式保存、冲突检测、撤销、重做和重启恢复。
- 使用代理或受限原素材的交互预览。
- 固定单主画面轨 `V1` 和单字幕轨 `C1`。

### 2.2 1C-Render 范围

- Render Plan v1 编译、规范化、哈希和验证。
- `blurred_background`、`crop_fill`、`fit` 三种横转竖布局。
- ASS/libass 字幕生成、安全转义和字体资源管理。
- 540x960 权威预览、复用、过期检测和播放。
- 1080x1920 H.264/AAC、CFR 30fps、yuv420p 最终导出。
- 导出目的授权、显式覆盖授权、导出记录、打开文件和资源管理器定位。
- FFprobe 产物校验、SHA-256、任务取消、进程清理和崩溃恢复。
- 真实 Core、真实 FFmpeg、真实 Electron 和安装包复验。

### 2.3 非目标

- 多画面轨、独立音频轨、BGM、旁白、多轨混音或音频关键帧。
- 转场、变速、反放、画中画、关键帧动画、图片 Ken Burns 动画。
- 人脸、主体或 HUD 智能跟踪；`crop_fill` 始终使用固定中心裁切。
- 任意字体、任意 ASS 标签、用户自定义 FFmpeg 参数或 filter graph。
- 4K、横屏成片、自定义分辨率、自定义帧率或平台批量 Profile。
- 自动上传、登录、发布、云渲染或 AI 自动选片。
- 用交互预览代替权威预览进行最终一致性验收。

## 3. 兼容性与通用规则

- `CONTRACT_VERSION` 从 `stage1b-v1` 升级为 `stage1c-v1`。
- API 前缀继续为 `/api/v1`；Sidecar 握手 `protocol_version` 继续为 `1`。
- 1A、1B 已发布 DTO 和 API 语义保持兼容，只允许新增字段、枚举值和资源。
- 所有实体 ID 为不可预测的 URL-safe 字符串，限制为 `[A-Za-z0-9_-]{1,128}`。
- 媒体时间使用整数微秒，时间戳使用 UTC ISO 8601 字符串。
- Timeline、Render Plan、Renderer DTO 和普通日志不得包含绝对路径。
- Renderer 不得获得管理令牌、数据库路径、素材 URI、产物路径或目标导出路径。
- 原素材只读。交互预览优先使用代理，最终导出只能读取当前 fingerprint 对应的原素材。
- 正式 Revision 是预览和导出的唯一输入；草稿不得直接进入 Render Plan。

## 4. 标识与枚举

新增标识：

```text
TimelineRevisionId
TimelineClipId
TimelineCaptionId
RenderArtifactId
ExportRecordId
DestinationGrantId
PlaybackTicketId
```

新增枚举：

```text
TimelineCreatedBy = user | system | import
TimelineLayout = blurred_background | crop_fill | fit
TimelineClipKind = video | image
CaptionOrigin = transcript | user
CaptionPresetId = default-bottom | game-safe-bottom | high-contrast
RenderMode = authoritative_preview | final_export
RenderArtifactStatus = ready | stale
ExportStatus = succeeded | missing
EncoderMode = auto | software
```

`JobKind` 新增：

```text
authoritative_preview
final_export
```

渲染 Job 的 `stage` 至少允许：

```text
queued
compiling
preparing
rendering
validating
finalizing
completed
failed
cancelled
interrupted
```

## 5. Timeline Schema v1

Timeline 是路径无关的纯领域 JSON。Core 持久化前必须规范化顺序、重算时间并校验全部引用。

```json
{
  "schema_version": 1,
  "project_id": "project_01",
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
      "clip_id": "clip_01",
      "track_id": "V1",
      "order_index": 0,
      "asset_id": "asset_01",
      "asset_kind": "video",
      "source_start_us": 0,
      "source_end_us": 5000000,
      "timeline_start_us": 0,
      "timeline_end_us": 5000000,
      "layout": "blurred_background",
      "audio": { "enabled": true, "gain_db": 0.0 }
    },
    {
      "clip_id": "clip_02",
      "track_id": "V1",
      "order_index": 1,
      "asset_id": "asset_02",
      "asset_kind": "image",
      "source_start_us": null,
      "source_end_us": null,
      "timeline_start_us": 5000000,
      "timeline_end_us": 8000000,
      "layout": "fit",
      "audio": { "enabled": false, "gain_db": 0.0 }
    }
  ],
  "captions": [
    {
      "caption_id": "caption_01",
      "track_id": "C1",
      "source_clip_id": "clip_01",
      "start_us": 0,
      "end_us": 1800000,
      "text": "字幕文本",
      "preset_id": "default-bottom",
      "origin": "transcript",
      "edited": false,
      "source_segment_ids": ["segment_01"]
    }
  ],
  "provenance": {
    "created_by": "user",
    "source_transcript_ids": ["transcript_01"]
  }
}
```

### 5.1 Clip 约束

- `tracks` 在 v1 中必须且只能为 `V1` 和 `C1`。
- `V1` Clip 按 `order_index` 从 `0` 连续排列，不允许重复、空隙或重叠。
- Core 按 Clip 顺序重算 `timeline_start_us/timeline_end_us`；客户端提交的不一致值无效。
- 视频 Clip 的源范围必须位于 Asset 时长内，最短 100 ms，且
  `timeline_end_us - timeline_start_us = source_end_us - source_start_us`。
- 图片 Clip 的源范围必须为 `null`；时间线时长为 0.5-30 秒，默认 3 秒。
- 视频和图片 Asset 必须属于同一 Project，状态为 `available` 且 fingerprint 未变化。
- `layout` 只能使用三种冻结值。
- 视频内嵌音频随 Clip 处理；`gain_db` 范围为 -60.0 至 12.0。
- 图片、无音轨视频或 `audio.enabled=false` 的片段在渲染时生成等长静音。
- 空时间线允许持久化，但禁止生成预览和导出。

### 5.2 Caption 约束

- Caption 时间是 Timeline 绝对时间，最短 200 ms，不能越过总时长。
- 相邻 Caption 可以首尾接触，但不得重叠。
- Transcript 生成的 Caption 必须保存 `source_clip_id` 和 `source_segment_ids`。
- 手工 Caption 的 `source_clip_id` 可以为 `null`，`source_segment_ids` 必须为空。
- 修正 Caption 只更新 Timeline；不得修改 Transcript、Segment 或 Word。
- 用户修改 Transcript 来源 Caption 后 `edited=true`，来源 ID 继续保留用于审计。
- 删除 Clip 时删除绑定该 Clip 的 Caption。
- 移动 Clip 时绑定 Caption 按相同时间差整体移动。
- 修剪 Clip 时 Caption 与保留范围求交；小于 200 ms 的残片删除，其余部分裁剪到边界。
- 拆分 Clip 时 Caption 按时间范围归属左右 Clip；跨拆分点的 Caption 分为两条，任一部分小于
  200 ms 时只保留合法部分。

## 6. Timeline Revision 与草稿

`TimelineRevision`：

```json
{
  "timeline_revision_id": "revision_01",
  "project_id": "project_01",
  "parent_revision_id": null,
  "schema_version": 1,
  "document": {},
  "document_sha256": "sha256",
  "summary": "从完整素材创建时间线",
  "created_by": "user",
  "created_at": "2026-08-11T00:00:00.000Z"
}
```

规则：

- Revision 创建后不可更新或删除。
- 正式修改必须在一个数据库事务中插入 Revision 并更新 Project 当前指针。
- `base_revision_id` 必须等于当前 Revision，否则返回 `409 TIMELINE_CONFLICT`。
- Undo 将当前指针移动到父 Revision，并把原当前 Revision 压入 redo 栈。
- Redo 从 redo 栈恢复；从 Undo 后的旧 Revision 创建新修改时清空 redo 栈并形成新分支。
- Undo、Redo 请求同样必须提交当前 `base_revision_id`，禁止静默覆盖。
- 草稿记录 `base_revision_id`。当前正式 Revision 改变后，旧草稿进入 conflict，不能自动覆盖。
- 草稿最多每 500 ms 写入一次；鼠标释放、文本失焦和结构操作必须提交正式 Patch。
- 重启后如果草稿 base 仍是当前 Revision，UI 提供恢复或丢弃；不自动恢复到画面中。

## 7. Timeline 创建与 Patch v1

### 7.1 创建来源

`POST /projects/{project_id}/timelines` 支持：

```json
{
  "schema_version": 1,
  "source": {
    "kind": "full_asset",
    "asset_id": "asset_01"
  },
  "default_layout": "blurred_background",
  "caption_preset_id": "default-bottom"
}
```

`source.kind` 允许：

- `empty`：创建空时间线。
- `full_asset`：视频全长或图片默认 3 秒。
- `transcript_selection`：提交一个 ready Transcript、按时间有序的 Segment ID 列表、
  0-300 ms 首尾保护边界和是否创建 Caption。

项目已有当前 Timeline 时再次创建返回 `409 TIMELINE_ALREADY_EXISTS`，不得覆盖。

### 7.2 Patch 请求

```json
{
  "schema_version": 1,
  "base_revision_id": "revision_01",
  "operations": [
    { "op": "remove_clip", "clip_id": "clip_01" },
    { "op": "move_clip", "clip_id": "clip_02", "to_index": 0 },
    {
      "op": "trim_clip",
      "clip_id": "clip_03",
      "source_start_us": 100000,
      "source_end_us": 4900000
    },
    { "op": "split_clip", "clip_id": "clip_03", "source_time_us": 2000000 },
    { "op": "set_layout", "clip_id": "clip_03", "layout": "crop_fill" },
    { "op": "set_audio", "clip_id": "clip_03", "enabled": true, "gain_db": -3.0 },
    { "op": "set_image_duration", "clip_id": "clip_04", "duration_us": 5000000 },
    { "op": "update_caption", "caption_id": "caption_01", "text": "修正文本" },
    {
      "op": "set_caption_timing",
      "caption_id": "caption_01",
      "start_us": 100000,
      "end_us": 1700000
    },
    {
      "op": "set_caption_preset",
      "caption_id": "caption_01",
      "preset_id": "high-contrast"
    }
  ],
  "summary": "调整片段并修正字幕"
}
```

Patch v1 允许的操作：

```text
insert_asset_clip
insert_transcript_segments
remove_clip
move_clip
trim_clip
split_clip
set_layout
set_audio
set_image_duration
add_caption
remove_caption
update_caption
set_caption_timing
set_caption_preset
```

单个 Patch 最多 100 个操作。Core 按顺序在内存副本上应用，全部成功后才创建一个 Revision；
任一操作失败时整个 Patch 回滚。

## 8. Caption Preset 与 ASS

内置预设固定为：

```text
default-bottom     底部居中、白字、黑描边
game-safe-bottom   在 default-bottom 基础上上移，避开常见游戏 HUD
high-contrast      高对比不透明底色，适合复杂画面
```

实现规则：

- 预设以版本化资源文件保存，首版 `preset_version=1`。
- 安装包携带一套许可明确的简体中文字体及其许可证；首选 Noto Sans SC 等 OFL 字体。
- Core 生成 ASS 文件，明确指定字体目录，不依赖机器字体发现结果决定最终布局。
- 用户文本必须转义 ASS 控制字符；禁止传入原始 Override Tag、换行控制码或字体路径。
- 文本规范化保留合法 Unicode，拒绝 NUL、非法代理字符和不可显示控制字符。
- 每条 Caption 限制 1-200 个 Unicode 字符；空白文本不允许进入正式 Revision。
- 字幕安全区、最大行宽、字号、描边和背景全部由预设决定。
- 当前随包 FFmpeg 已验证启用 libass，存在 `ass` 和 `subtitles` filter；打包复验仍必须再次检查。

## 9. Render Plan v1

Render Plan 由 Core 从正式 Revision 编译，Renderer 不得创建或修改。

```json
{
  "schema_version": 1,
  "compiler_version": "render-plan-v1",
  "timeline_revision_id": "revision_01",
  "mode": "authoritative_preview",
  "content_fingerprint": "sha256",
  "inputs": [
    {
      "input_id": "I0",
      "asset_id": "asset_01",
      "asset_kind": "video",
      "fingerprint": "sha256",
      "duration_us": 30000000,
      "has_audio": true
    }
  ],
  "segments": [
    {
      "clip_id": "clip_01",
      "input_id": "I0",
      "asset_kind": "video",
      "source_start_us": 0,
      "source_end_us": 5000000,
      "timeline_start_us": 0,
      "timeline_end_us": 5000000,
      "layout": "blurred_background",
      "audio_enabled": true,
      "gain_db": 0.0
    }
  ],
  "captions": {
    "format": "ass",
    "preset_version": 1,
    "font_bundle_version": 1,
    "items": []
  },
  "output": {
    "profile_id": "preview-portrait-v1",
    "width": 540,
    "height": 960,
    "fps_num": 30,
    "fps_den": 1,
    "video_codec": "h264",
    "audio_codec": "aac",
    "audio_sample_rate": 48000,
    "pixel_format": "yuv420p"
  }
}
```

### 9.1 编译规则

- `content_fingerprint` 只由规范化输入 fingerprint、Clip、布局、音频和 Caption 语义计算，
  不包含输出分辨率、码率、目标路径或 Job ID。
- 权威预览和最终导出的 `content_fingerprint` 必须相同。
- `authoritative_preview` Profile 为 540x960、CFR 30fps、H.264/AAC、yuv420p。
- `final_export` Profile 为 1080x1920、CFR 30fps、H.264/AAC、yuv420p。
- 最终导出解析 Asset 时必须再次核对存在性、size、mtime 和完整 fingerprint。
- Render Plan 保存到 RenderArtifact，供复现、审计和故障诊断。
- Render Plan 不包含绝对路径、命令行、filter graph 或临时目录。
- 基础设施层将 Asset ID 解析为路径，并通过受控 builder 生成 argv 和 filter graph。

### 9.2 布局语义

- `blurred_background`：源画面中心裁切填满背景并模糊；前景保持比例完整显示并居中。
- `crop_fill`：源画面保持比例缩放后中心裁切填满画布，不进行主体跟踪。
- `fit`：源画面保持比例完整显示并居中，空白区域使用 Timeline 背景色。
- 旋转元数据、样本宽高比和奇数尺寸必须在规范化后处理；编码前保证偶数尺寸和 yuv420p。
- 图片按 Clip 时长循环为静态视频帧，并使用与视频相同的布局语义。

### 9.3 音频语义

- 输出始终包含 48 kHz AAC 音轨。
- 有音轨且启用音频的 Clip 按源时间裁切并应用 `gain_db`。
- 图片、无音轨视频和禁用音频的 Clip 使用等长静音。
- 每个 Clip 的音频必须与其画面严格等长，再按 Timeline 顺序拼接。
- 阶段 1 不执行响度标准化、降噪、混音、淡入淡出或声道自动创作。

## 10. 权威预览

`AuthoritativePreview` DTO 至少包含：

```text
render_artifact_id
project_id
timeline_revision_id
status                      ready | stale
content_fingerprint
profile_id
size_bytes
sha256
media_info
created_at
```

规则：

- 创建预览时未指定 Revision 则使用项目当前正式 Revision。
- 空时间线、草稿、归档项目或缺失/变化素材不得创建预览。
- 复用键由 Revision ID、Render Plan/字体预设版本、`content_fingerprint`、Profile、
  FFmpeg 版本和实际编码器组成。
- 复用只允许使用已完成 FFprobe 校验和 SHA-256 校验的产物。
- 项目当前 Revision 改变后，旧预览立即在查询结果中表现为 `stale`。
- stale 预览可继续播放用于比较，但 UI 不得称其为当前可验收预览。
- 权威预览允许系统自动重试一次；重试必须复用同一正式 Revision。

## 11. 最终导出与 DestinationGrant

### 11.1 DestinationGrant

Electron 保存对话框返回目标后，由主进程通过管理接口创建一次性授权：

```json
{
  "destination_grant_id": "destination_01",
  "display_name": "项目名.mp4",
  "extension": ".mp4",
  "overwrite_authorized": false,
  "expires_at": "2026-08-11T01:00:00.000Z"
}
```

- Renderer 只能获得上述 DTO，不能获得目标路径。
- 目标必须是 `.mp4`，父目录必须已存在且可写。
- 目标已存在时，Electron 必须通过系统对话框取得明确覆盖确认，并设置
  `overwrite_authorized=true`。
- DestinationGrant 只允许成功消费一次，随 Sidecar 退出或过期失效。
- 目标授权不得复用为素材读取授权。

### 11.2 导出规则

- 最终导出输入必须是正式 Revision；允许没有当前权威预览或当前预览 stale。
- UI 在无当前预览时显示提示，但不得把提示实现为禁用导出。
- 每次导出都创建新 Job 和 ExportRecord；不得因为内容相同而静默覆盖既有用户导出。
- 先在目标目录同卷创建隐藏临时文件，完整校验后再原子移动到目标。
- 未授权覆盖时发现目标存在，返回 `EXPORT_DESTINATION_EXISTS`。
- 已授权覆盖也只能在新产物校验成功后替换旧文件；失败和取消必须保留旧文件。
- 最终导出不自动重试。用户重试时必须重新选择目标并取得新的 DestinationGrant。
- ExportRecord 保存私有 destination URI；UI DTO 只返回显示名和可执行动作，不返回路径。

## 12. 产物校验

权威预览和最终导出成功前必须由 FFprobe 验证：

- 文件存在且大小大于 0。
- 只有一个主视频流；宽高、codec、像素格式和 CFR 帧率符合 Profile。
- 存在 AAC 音轨，采样率为 48 kHz。
- 输出总时长与 Timeline 总时长误差不超过一帧加 50 ms。
- 片段边界、字幕首尾和音频总时长不存在越界。
- 文件可从头读取到尾，FFprobe/解码检查无截断错误。
- 完成 SHA-256 计算并写入 Artifact 与 ExportRecord 关联数据。

预览与导出一致性至少验证：

- 两份 Render Plan 的 `content_fingerprint` 相同。
- 片段数量、顺序、源时间、布局、音频状态和 Caption 列表一致。
- 最终导出缩放到 540x960 后，固定抽样帧与权威预览的 SSIM 不低于 0.95。
- 总时长差不超过一帧加 50 ms。

## 13. SQLite migration v3

阶段 1C 新增不可变 `v3`，不得修改已发布 v1、v2 SQL 或 checksum。

```text
timeline_revisions
  id TEXT PRIMARY KEY
  project_id TEXT NOT NULL REFERENCES projects(id)
  parent_revision_id TEXT NULL REFERENCES timeline_revisions(id)
  schema_version INTEGER NOT NULL
  document_json TEXT NOT NULL
  document_sha256 TEXT NOT NULL
  summary TEXT NOT NULL
  created_by TEXT NOT NULL
  created_at TEXT NOT NULL

timeline_drafts
  project_id TEXT PRIMARY KEY REFERENCES projects(id)
  base_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id)
  document_json TEXT NOT NULL
  updated_at TEXT NOT NULL

timeline_navigation
  project_id TEXT PRIMARY KEY REFERENCES projects(id)
  redo_stack_json TEXT NOT NULL
  updated_at TEXT NOT NULL

render_artifacts
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id)
  project_id TEXT NOT NULL REFERENCES projects(id)
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id)
  kind TEXT NOT NULL
  render_plan_json TEXT NOT NULL
  content_fingerprint TEXT NOT NULL
  profile_id TEXT NOT NULL
  toolchain_json TEXT NOT NULL
  created_at TEXT NOT NULL

export_records
  id TEXT PRIMARY KEY
  project_id TEXT NOT NULL REFERENCES projects(id)
  timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id)
  artifact_id TEXT NOT NULL REFERENCES render_artifacts(artifact_id)
  profile_id TEXT NOT NULL
  destination_uri TEXT NOT NULL
  destination_display_name TEXT NOT NULL
  created_at TEXT NOT NULL
```

`jobs` 逻辑扩展至少包含：

```text
timeline_revision_id TEXT NULL
idempotency_key TEXT NULL
resource_class TEXT NULL
result_json TEXT NULL
```

Migration v3 必须沿用迁移前备份、事务、checksum、未知版本拒绝和失败回滚语义，并验证
阶段 1A/1B 数据库升级后 Project、Asset、Job、Model 和 Transcript 数据保持可读。

## 14. HTTP API v1

### 14.1 Timeline

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/projects/{project_id}/timelines` | TimelineCreateInput | TimelineState，201 |
| GET | `/projects/{project_id}/timeline` | 无 | TimelineState |
| POST | `/projects/{project_id}/timeline/patches` | TimelinePatch | TimelineState |
| POST | `/projects/{project_id}/timeline/undo` | `{base_revision_id}` | TimelineState |
| POST | `/projects/{project_id}/timeline/redo` | `{base_revision_id}` | TimelineState |
| PUT | `/projects/{project_id}/timeline/draft` | TimelineDraftInput | TimelineDraft |
| DELETE | `/projects/{project_id}/timeline/draft` | 无 | 204 |
| GET | `/projects/{project_id}/timeline/revisions` | `limit? cursor?` | Page<TimelineRevisionSummary> |
| GET | `/timeline-revisions/{revision_id}` | 无 | TimelineRevision |

`TimelineState` 返回当前 Revision、草稿摘要、`can_undo`、`can_redo` 和当前预览摘要。

### 14.2 Preview 与 Export

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/projects/{project_id}/previews` | `{timeline_revision_id?, encoder_mode?}` | PreviewCreateResponse |
| GET | `/projects/{project_id}/previews` | `limit? cursor?` | Page<AuthoritativePreview> |
| POST | `/projects/{project_id}/exports` | `{timeline_revision_id?, destination_grant_id, encoder_mode?}` | ExportCreateResponse |
| GET | `/projects/{project_id}/exports` | `limit? cursor?` | Page<ExportRecord> |
| GET | `/render-artifacts/{artifact_id}` | 无 | RenderArtifact |

### 14.3 管理接口

仅 Electron 主进程使用：

```text
POST /api/v1/internal/destination-grants
GET  /api/v1/internal/assets/{asset_id}/resolve
GET  /api/v1/internal/artifacts/{artifact_id}/resolve
```

管理接口响应中的路径不得转发给 Renderer。

## 15. Electron 与受限媒体协议

- 统一使用 `aivideo://media/{opaque_ticket}`，不再把 Asset ID 或 Artifact ID 直接作为可播放 URL。
- Ticket 由 Electron 主进程在解析受限路径后生成，绑定实体、路径、用途和短期过期时间。
- Ticket 只允许 `GET/HEAD`，必须支持 Range；过期、未知、目录遍历和非普通文件返回 404/403。
- Asset、代理和 RenderArtifact 使用同一 Ticket Registry，但用途必须区分。
- 应用重启后由主进程按需向 Core 管理接口重新解析，不依赖内存中遗留路径。
- `openArtifact` 和 `openArtifactFolder` 继续只在主进程执行。
- 新增保存对话框 IPC，Renderer 只获得 DestinationGrant DTO。

## 16. 桌面工作台

阶段 1C 首屏为实际编辑工作台，不增加营销页：

```text
顶部：项目名、保存状态、撤销、重做、任务状态、生成预览、导出
左侧：素材和转录标签页
中央：交互播放器、播放控制和布局切换
右侧：所选 Clip 或 Caption 属性
底部：固定 V1/C1 简化时间线
```

交互要求：

- 从 Transcript 选择 Segment 后可追加到时间线，并立即看到对应 Caption。
- 支持完整素材和图片追加，图片默认 3 秒。
- 时间线提供选择、移动、拆分、删除和边缘微调，不实现自由多轨拖放。
- Clip 属性提供三种布局、音频启用和增益；图片不显示音频控制。
- Caption 属性提供文本、开始/结束时间和预设。
- 播放器显示交互预览；权威预览生成后可切换播放。
- 保存状态明确显示“保存中、已保存、保存失败、草稿冲突”。
- 当前正式 Revision 改变后立即显示预览过期状态。
- 无当前预览时允许导出，但必须显示非阻塞提示。
- 导出完成后提供播放、打开文件和在资源管理器中显示。
- 图标按钮使用 Lucide，提供 tooltip 和可访问名称；播放器和时间线尺寸稳定。

## 17. 错误码

阶段 1C 至少新增：

```text
TIMELINE_NOT_FOUND
TIMELINE_ALREADY_EXISTS
TIMELINE_INVALID
TIMELINE_CONFLICT
TIMELINE_EMPTY
TIMELINE_DRAFT_CONFLICT
TIMELINE_CLIP_NOT_FOUND
TIMELINE_CAPTION_NOT_FOUND
TIMELINE_SOURCE_INVALID
TIMELINE_OPERATION_UNSUPPORTED
RENDER_PLAN_INVALID
RENDER_INPUT_CHANGED
RENDER_FONT_MISSING
RENDER_FAILED
RENDER_VALIDATION_FAILED
PREVIEW_NOT_FOUND
EXPORT_NOT_FOUND
EXPORT_DESTINATION_INVALID
EXPORT_DESTINATION_EXISTS
EXPORT_DESTINATION_EXPIRED
EXPORT_DISK_SPACE_INSUFFICIENT
ARTIFACT_NOT_FOUND
PLAYBACK_TICKET_INVALID
```

HTTP 映射：参数错误 400；未认证 401；无权限 403；实体不存在 404；Revision、状态、目标文件
或资源冲突 409；内部渲染错误 500。`message` 可本地化，程序只能依据 `code` 分支。

## 18. 任务取消、恢复与文件一致性

- Core 启动时将遗留 `running/cancelling` Job 转为 `interrupted`。
- 取消运行中的预览或导出时必须终止完整 FFmpeg 进程树。
- 发出取消后 5 秒内不得存在关联 FFmpeg 进程。
- Job 临时目录使用 `temp/{job_id}` 或目标目录同卷临时文件。
- 预览失败、取消或 interrupted 时不得创建 ready RenderArtifact。
- 导出失败、取消或 interrupted 时不得创建 ExportRecord，不得留下新目标文件或破坏旧目标文件。
- Core 启动清理可识别的孤立临时文件，但不得删除用户成功导出或未知文件。
- Job 成功顺序固定为：渲染完成 -> FFprobe/解码校验 -> SHA-256 -> 原子移动 -> 数据库提交
  -> Job succeeded。
- 数据库提交失败时产物不能被 UI 识别为成功，恢复流程必须能清理或重新登记明确可验证的孤立产物。

## 19. 开发阶段与文件所有权

### 19.1 1C-Editor

YeJing 负责：

- `services/core/src/aivs_core/timeline/**` 或等价 Core Timeline 模块。
- `services/core/src/aivs_core/database.py` 的 migration v3。
- Timeline Repository、校验、Patch、Revision、Draft、Undo/Redo 和 HTTP API。
- `services/core/tests/**` 中对应单元和集成测试。

ZhangSan 负责：

- `packages/contracts/**` 的 `stage1c-v1` 类型和 guard。
- `apps/desktop/src/**` 编辑工作台、播放器、时间线和属性面板。
- `apps/desktop/electron/**` Timeline IPC、播放 Ticket 和受限媒体协议升级。
- `apps/desktop/tests/**`、`apps/desktop/e2e/**` 中 Editor 测试。

1C-Editor 经 LiuKeAi 独立验收通过后，才进入 1C-Render。

### 19.2 1C-Render

YeJing 负责：

- Core Render Plan、ASS、受控 FFmpeg builder、预览/导出 Job、校验和记录。
- `resources/fonts/**` 字体文件、版本信息和许可证内容。
- Core 渲染单元、集成、取消、崩溃和真实媒体验证工具。

ZhangSan 负责：

- Preview/Export DTO、Core Client、IPC 和 DestinationGrant 桌面流程。
- 预览状态、导出对话框、进度、播放、打开和定位 UI。
- Electron E2E、打包资源配置、安装包验证脚本和桌面测试。

### 19.3 共享禁止事项

- 两名开发工程师共享工作区，不得回退、覆盖或格式化对方和用户的无关修改。
- YeJing 不修改 `packages/contracts/**`、桌面 UI 或 Electron 文件。
- ZhangSan 不修改 `services/core/src/**`、Core 数据库或 Core 渲染实现。
- 两人不得修改本冻结文档语义；发现缺口先报告 LiuWei。
- 根级脚本、打包清单或测试素材必须事先明确单一所有者，禁止并行编辑同一文件。

## 20. 测试策略

### 20.1 Core 单元测试

- Timeline Schema、视频/图片范围、微秒、顺序、空时间线和跨项目引用。
- 全部 Patch 操作、原子回滚、409 冲突、分支、Undo/Redo 和草稿恢复。
- Caption 与 Clip 的移动、修剪、拆分、删除和手工编辑规则。
- 三种布局、视频、图片、无音轨、禁用音频和增益的 Render Plan。
- Render Plan 规范化、`content_fingerprint` 稳定性和预览/导出语义一致性。
- ASS 转义、控制字符拒绝、字体缺失和三种预设。
- FFmpeg argv 无 shell 拼接、路径/中文/空格安全和 filter graph 输入隔离。
- FFprobe 校验、SHA-256、临时文件、原子替换、取消和进程树清理。
- Preview 复用、stale、Export 不复用目标授权和失败不覆盖。

Timeline 与 Render 关键模块覆盖率不低于 85%；Core 全局覆盖率不低于 80%。

### 20.2 契约与桌面测试

- Contracts guard 覆盖全部新增 DTO、枚举和错误响应。
- Renderer DTO 中不存在 path、URI、token 或管理字段。
- Playback Ticket 的 Range、过期、用途隔离和重启后重新解析。
- 编辑器操作、保存状态、冲突、恢复、撤销/重做和预览过期 UI。
- 无当前预览时导出按钮仍可用且提示存在。
- 导出保存对话框、覆盖授权、Job 进度、播放、打开和定位。
- 长中文 Caption、长文件显示名和窄窗口不引起布局重叠或跳动。

### 20.3 真实集成与 E2E

- 固定媒体链路：创建项目 -> 导入 -> 创建 Timeline -> 编辑 -> 字幕 -> 权威预览 -> 导出。
- 使用真实中文及中英混合 ASR 结果执行 Transcript 选段到最终成片的完整 Electron 链路。
- 三种布局分别生成权威预览和最终导出。
- 图片片段、无音轨竖屏视频、奇数尺寸视频、VFR 视频和中文长路径。
- 最终导出必须验证 1080x1920、H.264/AAC、30fps CFR、yuv420p、48 kHz 和 SHA-256。
- 抽样验证权威预览与最终导出的 `content_fingerprint`、时长和 SSIM。
- 取消预览和导出后 5 秒内无关联 FFmpeg，无伪成功文件。
- 强制终止 Core 后 Job 为 interrupted，草稿/Revision 完整，目标文件未被破坏。
- 真实安装包包含字体、字体许可证和支持 libass 的 FFmpeg；启动不依赖系统 Node、Python、
  FFmpeg、字体或 Whisper。

Mock 只能用于错误注入和 UI 单元测试，不得替代最终真实媒体、真实 Electron 或真实安装包验证。

## 21. 独立验收门禁

### 21.1 1C-Editor

- [ ] 可从完整视频、Transcript 选段、图片和空时间线创建或追加内容。
- [ ] 删除、移动、拆分、视频微调、图片时长和三种布局真实可用。
- [ ] Caption 自动生成、修正、时间调整和三种预设可持久化。
- [ ] 原始 Transcript 不因 Caption 修改而变化。
- [ ] 自动保存、正式 Revision、409 冲突、Undo/Redo 和重启草稿恢复通过。
- [ ] Renderer 不获得路径，代理/素材交互预览支持 Range 和拖动。
- [ ] migration v3 从真实阶段 1B 数据库升级并保留全部既有数据。

### 21.2 1C-Render

- [ ] 三种布局均生成权威预览和最终成片。
- [ ] 图片、无音轨、禁音和多 Clip 音频均生成合法连续 AAC。
- [ ] 权威预览和最终导出共享相同 `content_fingerprint` 与内容语义。
- [ ] 最终导出读取原素材，素材 fingerprint 变化时拒绝渲染。
- [ ] 输出规格、时长、字幕、SSIM、FFprobe 和 SHA-256 校验通过。
- [ ] Timeline 变化后旧预览立即 stale；相同当前预览可以可靠复用。
- [ ] 无当前预览时导出可用且显示非阻塞提示。
- [ ] 目标存在时无授权不覆盖；有授权也只在新产物校验成功后替换。
- [ ] 取消和 Core 崩溃不产生伪成功 Artifact、ExportRecord 或目标文件。
- [ ] UI 可以播放、打开文件并在资源管理器中定位。
- [ ] 真实 Electron 全链路和安装包复验通过。

### 21.3 阶段 1 总退出

- [ ] 阶段 1A、1B、1C 的阻塞项全部关闭。
- [ ] 用户不依赖 LLM，可完成“导入 -> 转录/手工选段 -> 文本剪辑 -> 字幕 -> 预览 -> 导出”。
- [ ] 关闭并重启应用后，Project、Asset、Transcript、Timeline、草稿、Job 和导出记录可恢复。
- [ ] `pnpm run ci`、Python lint/typecheck/test、真实媒体工具、Electron E2E 和安装包验证通过。
- [ ] LiuKeAi 提交逐项带命令、环境、证据路径和结论的独立验收报告。

干净 Windows、GPU 编码矩阵和长视频性能可以在明确记录环境限制后保留为非阻塞
`unverified`；本机完整 CPU 软件编码链路、真实字幕、真实预览和真实导出不得标记为未验证。

## 22. 结构性阻塞条件

出现以下任一情况时，LiuWei 不得宣布阶段 1C 或阶段 1 完成：

- Timeline Revision、Patch 或 migration v3 不能可靠恢复或存在静默覆盖。
- Caption 与 Clip 编辑后失去确定绑定，预览和导出内容不可复现。
- 权威预览和最终导出使用不同内容语义或不同 Timeline 输入。
- 最终导出读取代理、素材变化后继续渲染，或 Renderer 获得绝对路径。
- ASS 可注入、字体布局依赖未打包系统资源，或安装包 FFmpeg 缺少 libass。
- 取消/崩溃留下伪成功记录、未清理 FFmpeg，或覆盖用户原有目标文件。
- 只通过 Mock、局部 API、开发服务器或页面 smoke，未完成真实 Electron/Core/FFmpeg 链路。
