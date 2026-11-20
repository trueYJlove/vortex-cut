# 阶段 3A 详细设计：平台预设、横竖双画幅与多目标批量导出

> 角色：LiuWei（架构师）  
> 状态：已冻结，stage3a-v1  
> 日期：2026-08-15  
> 契约来源：[STAGE3A_CONTRACT_FREEZE.md](STAGE3A_CONTRACT_FREEZE.md)  
> 基线：07a400f feat(brand): 完成 Vortex Cut 品牌切换与打包修复

本文把阶段 3A 契约落到可执行工程方案。当前阶段只输出文档，不启动 ZhangSan、YeJing 编码，不提交 Git，也不处理既有工作区残留。

## 1. 交付目标

阶段 3A 的产品能力是：

1. 在本地提供版本化平台预设与画幅预设。
2. 对同一 Timeline Revision 生成 9:16 与 16:9 两类权威预览。
3. 一次创建 1-8 个平台/画幅目标的批量导出。
4. 每个输出目标使用独立不可变 RenditionSnapshot。
5. 批量导出以目录级授权、安全文件名、独立 Job 和 ExportRecord 保证路径安全与失败隔离。
6. Provider 调用数保持 0。

阶段 3A 不改变 TimelineDocument v1，不做智能重构图、不做云端发布、不开放任意比例，也不改 Stage 2 的 Brief、Provider、Candidate、TimelinePatch 或 adopt 语义。

## 2. 现有实现基线

只读审计结论如下：

| 领域 | 当前状态 | 3A 影响 |
| --- | --- | --- |
| Contracts | packages/contracts/src/index.ts 中 RenderProfileId 只包含 preview-portrait-v1 与 export-portrait-v1 | 需要新增平台、画幅、Snapshot、批次、目录授权 DTO 和 guard，同时保留旧接口 |
| Timeline | services/core/src/aivs_core/timeline.py 与契约仍固定 TimelineDocument v1，canvas 为 1080x1920 | 不修改 Timeline schema，横屏只作为输出层画布覆盖 |
| RenderPlan | services/core/src/aivs_core/rendering/plan.py 的 PROFILES 固定 540x960 预览与 1080x1920 导出 | 需要引入 RenditionPreset 驱动的 Preview/Export Profile |
| ASS 字幕 | services/core/src/aivs_core/rendering/ass.py 固定 PlayResX 1080、PlayResY 1920，样式读 resources/fonts/caption-presets.json | 需要按 Rendition 解析 PlayRes、字号、边距和安全区 |
| FFmpeg | services/core/src/aivs_core/rendering/ffmpeg.py 已有 fit、crop_fill、blurred_background 等布局滤镜 | 需要让画布尺寸来自 RenderPlan 输出，并用 Snapshot 的逐 Clip 布局 |
| RenderService | services/core/src/aivs_core/rendering/service.py 支持旧单项 authoritative_preview/final_export | 需要新增目标化 preview 与 batch export 服务，旧服务保持兼容 |
| DestinationGrant | 当前是单文件授权，Renderer 可请求保存文件路径，Core 只消费目标文件 | 需要新增目录级 DirectoryGrant，Core 自行生成文件名 |
| SQLite | services/core/src/aivs_core/database.py 最新迁移为 v8 | 需要新增 v9 表、索引、触发器和兼容迁移 |
| Desktop | apps/desktop/src/app/App.tsx 与 Electron IPC 只支持单项预览/导出 | 需要新增多平台导出面板、目标化预览、批次状态和重试 |
| 打包 | apps/desktop/electron-builder.yml 已打包 fonts、recipes、manifests、model-manifests | 需要加入新 presets/renditions 字幕资源，并验证 Windows 包资源完整 |

## 3. 总体数据流

阶段 3A 的主链路为：

1. Core 启动时加载并严格校验平台预设、画幅预设和画幅感知字幕样式资源。
2. Desktop 通过 GET /api/v1/platform-presets 与 GET /api/v1/rendition-presets 获取安全 DTO。
3. 用户选择平台、画幅和布局策略。
4. Desktop 调 POST /api/v1/projects/{project_id}/rendition-previews。
5. Core 读取 TimelineRevision，计算 document hash，创建或复用 RenditionSnapshot。
6. Core 用 snapshot hash、timeline document hash、preview profile 和 toolchain hash 查找可复用权威预览。
7. 无可复用预览时创建 authoritative_preview Job，Job 编译 RenderPlan 并渲染对应画幅。
8. 每个目标 Preview ready 后，用户选择输出目录。
9. Electron Main 创建 DirectoryGrant，Renderer 只拿到 grant ID 与展示名。
10. Desktop 调 POST /api/v1/projects/(project_id)/export-batches。
11. Core 原子校验全部 items；全部通过才创建 ExportBatch、ExportBatchItem 和每项 final_export Job。
12. Job 逐项渲染到授权目录内的同目录临时文件，校验后原子移动到最终文件。
13. Desktop 通过 Job/Event、Batch 查询和 ExportRecord DTO 展示批次状态、成功文件、失败码和重试入口。

关键不变量：

- Timeline 是输入事实；Snapshot 是输出事实；RenderPlan 是执行计划。
- Snapshot 创建后不可更新、不可删除。
- Batch 状态由 item 关联 Job 派生，不作为第二事实源。
- Renderer 永远不接触本地绝对路径或 destination_uri。
- Provider 模块不被调用。

## 4. 资源与预设设计

### 4.1 新增资源目录

建议新增：

- resources/renditions/manifest.json
- resources/renditions/portrait-9x16-v1.json
- resources/renditions/landscape-16x9-v1.json
- resources/platform-presets/manifest.json
- resources/platform-presets/generic.json
- resources/platform-presets/douyin.json
- resources/platform-presets/wechat-channels.json
- resources/platform-presets/xiaohongshu.json
- resources/fonts/caption-styles-v2.json

resources/fonts/caption-presets.json 保留给旧 portrait 路径兼容；新目标化路径读取 caption-styles-v2.json。

electron-builder.yml、package-win 资源捕获和 verify-package-real 均需要把新增资源纳入打包验收。

### 4.2 PlatformPreset 校验

Core 新增 services/core/src/aivs_core/renditions/presets.py，负责：

- 以 UTF-8 读取 JSON。
- 拒绝未知字段。
- 拒绝重复 ID。
- 校验 schema_version、preset_version、filename_tag、display_name。
- 校验 allowed_rendition_ids 都存在于 Rendition manifest。
- 校验 default_rendition_id 属于 allowed_rendition_ids。
- 对每个规范化 JSON 计算 document_sha256。
- 启动时一次性加载，失败则 Core 启动失败，错误码 PLATFORM_PRESET_INVALID。

首版平台：

| ID | 展示名 | 默认画幅 | 允许画幅 |
| --- | --- | --- | --- |
| generic | 通用平台 | portrait-9x16-v1 | portrait-9x16-v1、landscape-16x9-v1 |
| douyin | 抖音 | portrait-9x16-v1 | portrait-9x16-v1、landscape-16x9-v1 |
| wechat-channels | 微信视频号 | portrait-9x16-v1 | portrait-9x16-v1、landscape-16x9-v1 |
| xiaohongshu | 小红书 | portrait-9x16-v1 | portrait-9x16-v1、landscape-16x9-v1 |

平台预设只表达 Vortex Cut 的本地交付默认，不代表第三方平台实时审核规则。

### 4.3 RenditionPreset 校验

RenditionPreset 字段包括：

- schema_version：1
- rendition_preset_id
- display_name
- aspect_ratio
- preview_profile
- export_profile
- allowed_layout_policies
- caption_style_ref
- filename_tag
- document_sha256

首版固定规格：

| ID | Preview | Export | 文件名标签 |
| --- | --- | --- | --- |
| portrait-9x16-v1 | 540x960 | 1080x1920 | portrait |
| landscape-16x9-v1 | 960x540 | 1920x1080 | landscape |

Profile 必须严格为：

- fps_num=30
- fps_den=1
- video_codec=h264
- audio_codec=aac
- audio_sample_rate=48000
- pixel_format=yuv420p
- faststart=true

硬件编码和软件编码可以有不同码率，但 FFprobe 结果必须满足同一规格。

## 5. Contracts 设计

文件所有权：YeJing 独占 packages/contracts/src/index.ts 及 apps/desktop/tests/contracts.test.ts 的契约测试。

### 5.1 版本

- CONTRACT_VERSION 升级为 stage3a-v1。
- API 路径仍为 /api/v1。
- Sidecar protocol_version 仍为 1。
- 旧 RenderProfileId 保留 preview-portrait-v1 与 export-portrait-v1。
- 新目标化 Profile ID 建议扩展为：
  - preview-portrait-9x16-v1
  - export-portrait-9x16-v1
  - preview-landscape-16x9-v1
  - export-landscape-16x9-v1

旧 profile 不删除，旧 API 仍返回旧 profile。

### 5.2 新增品牌类型

新增类型：

- PlatformPresetId
- RenditionPresetId
- RenditionSnapshotId
- ExportBatchId
- ExportBatchItemId
- DirectoryGrantId

新增枚举：

- LayoutPolicy：preserve_timeline、fit_all、crop_fill_all、blurred_background_all
- RenditionWarningCode：CENTER_CROP_MAY_HIDE_CONTENT、LETTERBOX_EXPECTED、PILLARBOX_EXPECTED
- ExportBatchItemStatus：queued、running、succeeded、failed、cancelled、interrupted
- ExportBatchStatus：queued、running、succeeded、partial、failed、cancelled、interrupted

### 5.3 DTO

新增公开 DTO：

- PlatformPreset
- RenditionPreset
- RenditionSnapshotSummary
- RenditionPreviewCreateInput
- RenditionPreviewCreateResponse
- RenditionPreviewListResponse
- DirectoryGrant
- ExportBatchCreateInput
- ExportBatchCreateResponse
- ExportBatch
- ExportBatchItem
- ExportBatchRetryInput
- ExportBatchRetryResponse

DTO 只允许安全字段：

- ID、display_name、profile ID、hash、状态、时间、警告 code。
- 不允许本地路径、URI、Caption 正文、ASS、FFmpeg stderr、Provider payload、Authorization 或完整 URL。

### 5.4 Guard 与脱敏

所有 isX 和 parseX guard 必须：

- onlyKeys 严格拒绝未知字段。
- hasSensitiveKey 拒绝敏感键。
- 校验数组上限，batch items 为 1-8。
- 校验同批次 platform_preset_id + rendition_preset_id 唯一。
- 校验 hash 为 64 位 SHA-256。
- 校验 grant ID 只能是 directory_ 前缀品牌 ID。
- 校验 retry 只能包含原失败、取消或中断 item。

removeSensitiveFields 和 rendererSafe 不应为了新 DTO 放宽规则。

## 6. RenditionSnapshot 编译器

建议新增 services/core/src/aivs_core/renditions/snapshot.py。

输入：

- project_id
- timeline_revision_id
- platform_preset_id
- rendition_preset_id
- layout_policy

流程：

1. 验证 project 存在且未归档。
2. 验证 timeline_revision 属于 project。
3. 读取 revision.document_json 与 document_sha256。
4. 校验平台允许目标 rendition。
5. 按 layout_policy 解析每个 Clip 的布局：
   - preserve_timeline：读取 Clip 自身 layout。
   - fit_all：全部 fit。
   - crop_fill_all：全部 crop_fill。
   - blurred_background_all：全部 blurred_background。
6. 按 rendition 解析 caption_style_version 和三套 CaptionPreset 的具体样式。
7. 生成 warnings：
   - crop_fill_all 对任意非目标比例素材可给 CENTER_CROP_MAY_HIDE_CONTENT。
   - fit_all 对目标比例不一致素材可给 LETTERBOX_EXPECTED 或 PILLARBOX_EXPECTED。
   - blurred_background_all 不做主体检测，不给智能裁切承诺。
8. 构造规范 JSON，计算 snapshot_sha256。
9. 若同 project、revision、platform、rendition、layout_policy、document_sha256、preset hash、caption style hash 的 snapshot 已存在，则复用已有 Snapshot。
10. 否则插入 rendition_snapshots。

Snapshot 存储 resolved_segments，而不是存储第二套 Timeline。任何后续预览或导出只读 Snapshot，不重新推断布局。

## 7. RenderPlan 与渲染设计

### 7.1 RenderPlanCompiler

services/core/src/aivs_core/rendering/plan.py 需要新增目标化编译入口，例如 compile_rendition：

- 入参 project_id、timeline_revision_id、mode、rendition_snapshot_id。
- mode 仍为 authoritative_preview 或 final_export。
- 读取并校验 Snapshot 与 Revision 当前 document_sha256 一致。
- output 来自 RenditionPreset 的 preview_profile 或 export_profile。
- segments 的 layout 来自 snapshot.resolved_segments，不直接读 Clip layout，除非 Snapshot 本身是 preserve_timeline 编译结果。
- content_fingerprint 至少包含：
  - inputs
  - resolved_segments
  - captions 的安全渲染语义
  - timeline_document_sha256
  - rendition_snapshot_sha256
  - caption_style_hash
  - compiler_version
  - output profile

旧 compile 保留给旧 /previews 与 /exports，继续输出 preview-portrait-v1 与 export-portrait-v1。

### 7.2 ASS 字幕

services/core/src/aivs_core/rendering/ass.py 需要拆分：

- 旧 build_ass 继续使用 resources/fonts/caption-presets.json 与 1080x1920。
- 新 build_rendition_ass 接收 resolved caption style 与 target width/height。

新字幕样式必须满足：

- PlayResX 等于 Rendition export 或 preview 的目标宽度。
- PlayResY 等于目标高度。
- 三个 CaptionPreset ID 不变。
- 横屏 1920x1080 使用独立字号和边距，不直接复用竖屏像素。
- 字幕文本仍通过 escape_ass_text，限制控制字符、长度和 ASS 注入。
- RenderPlan 可包含渲染所需样式，但公开 DTO 不返回 Caption 正文或 ASS 文件。

建议 caption-styles-v2.json 结构按 rendition_preset_id 分组：

- portrait-9x16-v1：play_res=1080x1920，三套 preset 样式。
- landscape-16x9-v1：play_res=1920x1080，三套 preset 样式。

Preview 使用同一视觉语义，但按 preview 分辨率等比缩放或直接使用 preview PlayRes；两种方式必须在资源中显式冻结，不允许运行时猜测。

### 7.3 FFmpeg 滤镜

services/core/src/aivs_core/rendering/ffmpeg.py 的滤镜入口继续由 RenderPlan output width/height 驱动。

需要覆盖：

- 竖屏 540x960 与 1080x1920。
- 横屏 960x540 与 1920x1080。
- fit：完整显示，补黑边。
- crop_fill：中心裁切填满，不做人脸/主体识别。
- blurred_background：背景中心裁切模糊，前景完整显示。
- SAR 非 1、旋转元数据、奇数尺寸、图片素材、有声/静音混排。

输出验证由 services/core/src/aivs_core/rendering/validation.py 保持严格：

- 宽高精确。
- CFR 30fps。
- H.264/AAC。
- yuv420p。
- 48 kHz stereo。
- 时长误差在既有阈值内。
- 完整解码成功。

## 8. Preview 复用与 stale 规则

目标化 Preview 新增 API：

- GET /api/v1/platform-presets
- GET /api/v1/rendition-presets
- POST /api/v1/projects/{project_id}/rendition-previews
- GET /api/v1/projects/{project_id}/rendition-previews

Preview 复用键：

- project_id
- timeline_revision_id
- timeline_document_sha256
- rendition_snapshot_id
- rendition_snapshot_sha256
- profile_id
- content_fingerprint
- toolchain hash
- succeeded Job

任一变化不得复用。

stale 判断：

- 预览所属 timeline_revision_id 不是项目当前 Revision：对新批次不可用。
- Snapshot 的 timeline_document_sha256 与 Revision 表记录不一致：不可用。
- Profile、preset hash 或 toolchain hash 不一致：不可用。
- 其他画幅或平台目标的 Preview 不可替代当前目标。

旧 /api/v1/projects/{project_id}/previews 保持不变，仍只表达 portrait 单项兼容路径。

## 9. ExportBatch 设计

建议新增 services/core/src/aivs_core/renditions/batch.py，RenderService 只承接具体渲染执行。

### 9.1 创建批次

POST /api/v1/projects/{project_id}/export-batches 输入：

- timeline_revision_id
- directory_grant_id
- items，数量 1-8
- 每项包含 rendition_snapshot_id、preview_artifact_id、encoder_mode 可选

Core 原子预检：

1. project 存在且未归档。
2. timeline_revision 属于 project。
3. DirectoryGrant 存在、未过期、未被 claim。
4. items 数量 1-8。
5. 同批次 platform_preset_id + rendition_preset_id 不重复。
6. 每个 Snapshot 属于同 project 与 timeline_revision。
7. 每个 Snapshot 的 document hash 与 Revision 记录一致。
8. 每个 preview_artifact 属于同 Snapshot。
9. preview_artifact 是 ready 的 authoritative_preview。
10. Preview profile 与 Snapshot preview_profile 一致。
11. toolchain 与当前导出 toolchain 策略兼容。
12. 授权目录可写，剩余空间满足每个 item 的保守估算。
13. 生成的每个目标文件不存在。

全部通过后，在一个事务中创建 export_batches、export_batch_items、jobs。任何失败不得创建部分批次或部分 Job。

### 9.2 状态派生

export_batch_items 自身只保存身份、引用、ordinal、目标展示名和时间，不保存第二套运行状态。

item 状态从关联 jobs.status 派生：

- queued、running、succeeded、failed、cancelled、interrupted。
- cancelling 对外折算为 running 或 cancelling 不暴露，建议对外仍显示 running 并给取消中提示。

batch 状态从所有 item 派生：

| 条件 | batch status |
| --- | --- |
| 全部 queued | queued |
| 有 queued/running 且未全部终态 | running |
| 全部 succeeded | succeeded |
| 至少一项 succeeded 且其余均终态非成功 | partial |
| 全部 cancelled | cancelled |
| 无成功且含 interrupted | interrupted |
| 其他无成功终态组合 | failed |

### 9.3 取消

新增或复用 Job cancel：

- 用户取消批次时，Core 对 queued/running item 的 Job 发起取消。
- succeeded item 不变，文件保留。
- failed、cancelled、interrupted item 不变。
- 临时文件只删除当前 item 的临时文件。

若 Core 重启：

- running/cancelling 的 batch item Job 由现有 Job 恢复策略进入 interrupted。
- DirectoryGrant 不持久化，未完成 item 必须重试并重新授权目录。

### 9.4 重试

POST /api/v1/export-batches/{batch_id}/retry 输入：

- directory_grant_id
- item_ids，必须来自原批次且状态为 failed、cancelled 或 interrupted。

行为：

- 创建新 ExportBatch。
- 创建新 ExportBatchItem 与新 Job。
- 保存 retry_of_batch_id 与 retry_of_item_id。
- 重新生成安全文件名。
- 不修改原批次、原 item、原 Job、原 ExportRecord 或原输出文件。

## 10. DirectoryGrant 与路径安全

现有单文件 DestinationGrantStore 保留给旧 /exports。

新增 DirectoryGrantStore：

- 创建时接收目录绝对路径。
- 目录必须存在、可写、可解析。
- expires_at 为 15 分钟。
- claim 后绑定一个 batch_id。
- Core 重启后内存 grant 清空。
- safe_dto 只返回 directory_grant_id、display_name、expires_at。

Electron Main 新增导出目录选择：

- 使用 dialog.showOpenDialog，properties 包含 openDirectory。
- 不把目录路径传给 Renderer。
- 只调用 Core internal API 创建 DirectoryGrant。

Core 生成文件名：

格式：

{safe-project}-{platform-tag}-{portrait 或 landscape}-{item-short-id}.mp4

safe-project 规则：

- Unicode 规范化。
- 删除控制字符。
- Windows 非法字符替换为连字符。
- 去掉尾部空格和点。
- 禁止 CON、PRN、AUX、NUL、COM1-COM9、LPT1-LPT9 等保留名。
- 限长，保证最终完整文件名低于 Windows 常见限制。

路径边界：

- 最终路径必须是授权目录的直接子文件。
- 禁止相对段。
- 禁止子目录。
- 禁止替代数据流。
- 禁止非 .mp4 扩展。
- 禁止符号链接逃逸；若目录或目标解析异常，失败。
- 文件已存在返回 EXPORT_DESTINATION_EXISTS，本阶段不提供覆盖开关。

## 11. SQLite v9 详细设计

文件所有权：ZhangSan 独占 services/core/src/aivs_core/database.py 与迁移测试；YeJing 只读依赖。

### 11.1 新表

新增 rendition_snapshots：

| 字段 | 说明 |
| --- | --- |
| id | RenditionSnapshotId，主键 |
| project_id | projects(id) |
| timeline_revision_id | timeline_revisions(id) |
| timeline_document_sha256 | Revision document hash |
| platform_preset_id | 平台 ID |
| platform_preset_version | 1 |
| platform_preset_sha256 | 规范 JSON hash |
| rendition_preset_id | 画幅 ID |
| rendition_preset_version | 1 |
| rendition_preset_sha256 | 规范 JSON hash |
| layout_policy | 四选一 |
| snapshot_json | 规范 JSON |
| snapshot_sha256 | 规范 hash |
| warnings_json | 固定 warning code 数组 |
| created_at | 时间 |

约束：

- UNIQUE(project_id, timeline_revision_id, timeline_document_sha256, platform_preset_id, platform_preset_sha256, rendition_preset_id, rendition_preset_sha256, layout_policy, snapshot_sha256)
- BEFORE UPDATE 触发器拒绝。
- BEFORE DELETE 触发器拒绝。

新增 export_batches：

| 字段 | 说明 |
| --- | --- |
| id | ExportBatchId |
| project_id | projects(id) |
| timeline_revision_id | timeline_revisions(id) |
| timeline_document_sha256 | 创建时 document hash |
| directory_display_name | 安全展示名 |
| retry_of_batch_id | 可空 |
| created_at | 时间 |

新增 export_batch_items：

| 字段 | 说明 |
| --- | --- |
| id | ExportBatchItemId |
| export_batch_id | export_batches(id) |
| ordinal | 0 起 |
| project_id | 冗余便于查询 |
| timeline_revision_id | 冗余便于查询 |
| rendition_snapshot_id | rendition_snapshots(id) |
| preview_artifact_id | render_artifacts(artifact_id) |
| platform_preset_id | 冗余安全展示 |
| rendition_preset_id | 冗余安全展示 |
| destination_display_name | 安全文件名 |
| retry_of_item_id | 可空 |
| created_at | 时间 |

约束：

- UNIQUE(export_batch_id, ordinal)
- UNIQUE(export_batch_id, platform_preset_id, rendition_preset_id)
- 身份和引用字段禁止 UPDATE。

### 11.2 旧表扩展

jobs 新增：

- export_batch_item_id TEXT NULL REFERENCES export_batch_items(id)

render_artifacts 新增：

- rendition_snapshot_id TEXT NULL REFERENCES rendition_snapshots(id)

export_records 新增：

- export_batch_item_id TEXT NULL UNIQUE REFERENCES export_batch_items(id)

历史行全部保持 NULL。

### 11.3 迁移原则

- MIGRATIONS 新增 V9_VERSION 与 V9_SQL。
- v1-v8 SQL 文本和 checksum 不得改动。
- 已应用未知版本继续拒绝。
- 每个新库和 v8 升级库均生成备份。
- 迁移使用事务，失败回滚。
- 迁移幂等，重复 initialize 不新增额外结构或错误。
- 触发器必须覆盖 Snapshot 不可变、Batch/Item 身份字段不可变。

### 11.4 查询视图

不建议新增 SQLite VIEW，避免把派生状态固化在数据库层。BatchService 查询时 JOIN jobs 并在 Python 层派生状态，便于保持对 Job 状态机的兼容。

## 12. Core API 设计

services/core/src/aivs_core/app.py 新增路由：

- GET /api/v1/platform-presets
- GET /api/v1/rendition-presets
- POST /api/v1/projects/{project_id}/rendition-previews
- GET /api/v1/projects/{project_id}/rendition-previews
- POST /api/v1/internal/directory-grants
- POST /api/v1/projects/{project_id}/export-batches
- GET /api/v1/projects/{project_id}/export-batches
- GET /api/v1/export-batches/{batch_id}
- POST /api/v1/export-batches/{batch_id}/cancel
- POST /api/v1/export-batches/{batch_id}/retry

旧路由保持：

- POST /api/v1/projects/{project_id}/previews
- GET /api/v1/projects/{project_id}/previews
- POST /api/v1/projects/{project_id}/exports
- GET /api/v1/projects/{project_id}/exports

错误处理：

- DomainError code 必须使用固定 allowlist。
- API 响应只包含 code、message、details 的安全子集。
- FFmpeg stderr、绝对路径、Caption 文本和 Provider 信息只允许进入内部受控日志，并且日志仍需脱敏。

## 13. Job 与事件设计

jobs.kind 继续使用 authoritative_preview 与 final_export，避免引入多套 worker。

新增关联：

- rendition_snapshot_id 进入 render job input_json 与 render_artifacts。
- export_batch_item_id 进入 jobs 表。
- final_export 的 input_json 不再存 destination_path 原始绝对路径；批量导出路径由 DirectoryGrant 在运行时解析或由已 claim 的安全内部对象提供。若必须在 input_json 放路径供同进程 worker 使用，只能放在 Core 内部，不得进入 DTO、Event 或 Renderer。

事件：

- 现有 Job Event 保留。
- Desktop 可通过 job_id 订阅 item 进度。
- 新增 batch 查询端点用于聚合状态。
- Event payload 不新增路径字段。

## 14. Desktop / Electron / Preload 设计

文件所有权：YeJing 独占 apps/desktop/electron/main、apps/desktop/electron/preload、apps/desktop/src、apps/desktop/tests 与 E2E 中的 Stage 3A 切片。

### 14.1 Electron Main

apps/desktop/electron/main/index.ts 新增 IPC：

- preset:list-platforms
- preset:list-renditions
- rendition-preview:create
- rendition-preview:list
- export:choose-directory
- export-batch:create
- export-batch:get
- export-batch:list
- export-batch:cancel
- export-batch:retry

Main 层职责：

- 对 ID、limit、cursor、layout_policy、encoder_mode 做轻量输入约束。
- 调 Core API。
- 调 artifactMediaUrl 生成受限媒体 URL。
- 对 batch/export DTO 调 rendererSafe。
- 不返回目录绝对路径。

### 14.2 Preload

apps/desktop/electron/preload/index.ts 扩展 DesktopApi：

- listPlatformPresets
- listRenditionPresets
- createRenditionPreview
- listRenditionPreviews
- chooseExportDirectory
- createExportBatch
- getExportBatch
- listExportBatches
- cancelExportBatch
- retryExportBatch

TypeScript 类型全部从 contracts 引入，不在 preload 中自定义放宽。

### 14.3 Renderer

apps/desktop/src/app/App.tsx 首版可以在现有页面内新增“多平台导出”区域，不必新建复杂路由。

UI 状态：

- platformPresets
- renditionPresets
- selectedTargets
- targetLayoutPolicies
- renditionPreviewsByTarget
- directoryGrant
- activeBatch
- batchItems
- retrySelection

交互要求：

- 平台与画幅两个控件分离。
- 平台默认值可以带出默认画幅，但用户可改画幅。
- 同一批次最多 8 个唯一平台/画幅组合。
- 每个目标显示规格、布局策略、警告和 Preview 状态。
- Preview 未 ready 时禁用创建批次。
- 选择目录后只显示 display_name。
- 批次创建后逐项显示状态、进度、目标文件名、安全错误码。
- 失败项提供重试入口，重试必须重新选择目录。

交互预览与权威预览必须文案区分；只有权威预览可作为 Batch item 依据。

## 15. 打包资源与真实验收脚本

需要更新：

- apps/desktop/electron-builder.yml：增加 platform-presets 与 renditions。
- apps/desktop/scripts/package-win.mjs：capture extraResources 中包含新目录和 manifest hash。
- apps/desktop/scripts/verify-package-real.mjs：新增 Stage 3A 资源完整性与真实双画幅批量导出检查。
- apps/desktop/tests/package-script-safety.test.ts：静态断言新增资源、固定错误码和证据脱敏。
- tools/packaging/build-sidecar.ps1：若资源复制白名单涉及新目录，需要纳入。
- resources/manifests/components.json：由真实构建或明确资源更新流程维护，不能伪造 hash。

verify-package-real 的 Stage 3A 成功证据建议新增：

- platform_presets_loaded=true
- rendition_presets_loaded=true
- preview_portrait_ready=true
- preview_landscape_ready=true
- export_batch_created=true
- export_batch_items=2
- export_batch_status=succeeded 或 partial 用于专门失败隔离场景
- provider_invocation_count=0
- renderer_paths_redacted=true

失败证据只写固定 code、stage、布尔 checks，不写路径、字幕、URL 或 stderr。

## 16. 测试策略

### 16.1 Contracts

命令：

- pnpm --filter @aivideo/contracts build
- pnpm --filter @aivideo/desktop test -- contracts.test.ts

覆盖：

- 新 DTO 正例。
- 未知字段拒绝。
- 敏感字段拒绝。
- ID、hash、状态、layout_policy、warning code 校验。
- batch items 0、9、重复目标拒绝。
- retry 非终态 item 拒绝。
- 旧 Preview/Export DTO 继续通过。

### 16.2 Core 单元测试

新增或扩展：

- services/core/tests/unit/test_stage3a_presets.py
- services/core/tests/unit/test_stage3a_snapshot.py
- services/core/tests/unit/test_stage3a_batch.py
- services/core/tests/unit/test_migrations_v9.py
- services/core/tests/unit/test_render_plan_stage3a.py
- services/core/tests/unit/test_render_ass_stage3a.py

覆盖：

- 资源 manifest/hash/重复 ID/未知字段/非法引用。
- Snapshot 不可变、复用、布局解析、warning。
- v8 到 v9 迁移、全新库、幂等、失败回滚、未知版本拒绝、v1-v8 checksum 未变。
- 目标化 RenderPlan 输出尺寸和 profile。
- 横屏 ASS PlayRes 与样式独立。
- 批次原子创建与状态派生。
- DirectoryGrant 过期、复用、越界、冲突和安全文件名。

### 16.3 Core 集成与真实 FFmpeg

新增：

- services/core/tests/integration/test_stage3a_rendition_preview_api.py
- services/core/tests/integration/test_stage3a_export_batch_api.py
- services/core/tests/integration/test_stage3a_render_real.py

覆盖：

- 9:16 Preview。
- 16:9 Preview。
- 同一 TimelineRevision 生成两个 Snapshot。
- 跨画幅 Preview 不复用。
- Snapshot stale。
- 同批次两个目标成功。
- 人为制造一个 item 失败时另一个成功文件保留。
- 取消与 interrupted。
- retry 新批次。
- FFprobe 验证尺寸、编码、音频、CFR、完整解码。
- Provider invocation 表或 mock 计数为 0。

### 16.4 Desktop 与 Electron

命令：

- pnpm --filter @aivideo/desktop lint
- pnpm --filter @aivideo/desktop build
- pnpm --filter @aivideo/desktop test

新增或扩展：

- apps/desktop/tests/core-client.test.ts
- apps/desktop/tests/preload.test.ts
- apps/desktop/tests/app.test.tsx
- apps/desktop/tests/export-destination.test.ts
- apps/desktop/e2e/stage3a-renditions.electron.spec.ts
- apps/desktop/e2e/stage3a-export-batch.electron.spec.ts

覆盖：

- 平台与画幅解耦。
- 选择平台只设置默认画幅，不锁定画幅。
- Preview 门禁。
- 目录授权 DTO 不含路径。
- batch 状态与 item 进度。
- partial、failed、cancelled、interrupted 展示。
- 失败项重试必须重新授权。
- 受限媒体 URL 可播放。
- Renderer 不显示绝对路径。

### 16.5 打包与安全

命令视情况分级：

- node --check apps/desktop/scripts/package-win.mjs
- node --check apps/desktop/scripts/verify-package-real.mjs
- pnpm --filter @aivideo/desktop test -- package-script-safety.test.ts
- pnpm --filter @aivideo/desktop package:win
- pnpm --filter @aivideo/desktop package:verify:real
- git diff --check

真实包验收必须覆盖：

- 新资源存在。
- Windows 安装后 Core 可加载 presets。
- 真实 9:16 与 16:9 Preview。
- 真实同批次至少两个目标导出。
- Provider 调用数为 0。
- 证据和日志脱敏。

## 17. 文件所有权与任务拆分建议

阶段 3A 可拆为两个开发切片，但必须避免同文件冲突。

### 17.1 ZhangSan：Core 与数据库切片

独占文件：

- services/core/src/aivs_core/database.py
- services/core/src/aivs_core/renditions/*
- services/core/src/aivs_core/rendering/plan.py
- services/core/src/aivs_core/rendering/ass.py
- services/core/src/aivs_core/rendering/ffmpeg.py
- services/core/src/aivs_core/rendering/validation.py
- services/core/src/aivs_core/rendering/service.py
- services/core/src/aivs_core/jobs.py
- services/core/src/aivs_core/app.py 中 Core 路由实现区
- services/core/tests/unit/test_stage3a_*.py
- services/core/tests/unit/test_migrations_v9.py
- services/core/tests/integration/test_stage3a_*.py
- resources/renditions/*
- resources/platform-presets/*
- resources/fonts/caption-styles-v2.json

禁止事项：

- 不修改 TimelineDocument v1。
- 不改 Stage 2 Provider/Planning 语义。
- 不删除或重写历史 Preview/Export。
- 不在 DTO、日志或证据输出路径、Caption 正文或 Provider 数据。

### 17.2 YeJing：Contracts、Desktop、打包切片

独占文件：

- packages/contracts/src/index.ts
- apps/desktop/src/lib/core-client.ts
- apps/desktop/src/env.d.ts
- apps/desktop/electron/main/index.ts
- apps/desktop/electron/preload/index.ts
- apps/desktop/electron/main/export-destination.ts 或新增 directory-grants.ts
- apps/desktop/src/app/App.tsx
- apps/desktop/src/styles.css
- apps/desktop/tests/*
- apps/desktop/e2e/stage3a-*.electron.spec.ts
- apps/desktop/electron-builder.yml
- apps/desktop/scripts/package-win.mjs
- apps/desktop/scripts/verify-package-real.mjs

禁止事项：

- 不绕过 contracts guard。
- 不让 Renderer 看到目录绝对路径。
- 不把旧单文件 DestinationGrant 改成破坏兼容的目录授权。
- 不把平台和画幅重新绑定为单一选项。

### 17.3 集成顺序

推荐安全顺序：

1. ZhangSan 先完成 Contracts 依赖以外的 Core 资源加载、v9 迁移、Snapshot 与 batch 领域测试草案。
2. YeJing 完成 contracts DTO/guard，并与 ZhangSan 对齐字段名。
3. ZhangSan 接入 Core API 与真实渲染。
4. YeJing 接入 Desktop/Electron/Preload 与 UI。
5. 双方各自运行局部测试。
6. LiuWei 检查 diff 冲突风险后，交 LiuKeAi 独立验收。

如果实际执行时发现 packages/contracts/src/index.ts 阻塞 Core 类型对齐，可先由 YeJing 完成 contracts，ZhangSan 只按冻结文档实现 Python DTO 校验，不等待 Desktop。

## 18. LiuKeAi 独立验收清单

LiuKeAi 验收不得只依据开发报告，需要独立检查 diff、运行命令并记录证据。

必须逐项给出通过、未通过或未验证：

1. 契约一致：实现没有偏离 STAGE3A_CONTRACT_FREEZE.md。
2. Timeline 兼容：TimelineDocument v1 未修改，旧项目可打开。
3. 旧 API 兼容：旧 portrait Preview/Export 仍通过。
4. 预设资源：平台和画幅资源严格校验，坏资源启动失败。
5. Snapshot：不可变、可复用、hash 稳定、布局解析确定。
6. 字幕：竖屏和横屏 PlayRes 与样式独立，三 Preset ID 保持。
7. Preview：两画幅权威 Preview 可生成，跨画幅不复用，stale 正确。
8. Batch：1-8 items，原子创建，部分失败隔离，状态派生正确。
9. Retry：失败、取消、中断项可创建新批次，原历史不变。
10. DirectoryGrant：过期、复用、路径穿越、冲突和符号链接场景安全。
11. Render：真实 FFmpeg 产物规格、时长、解码和 hash 通过。
12. Desktop：平台/画幅解耦，Preview 门禁和批次 UI 正确。
13. 安全：Renderer、DTO、日志、Job/Event、证据不泄漏路径、Caption、Provider 或 Key。
14. Provider：Stage 3A 全链路 Provider 调用数为 0。
15. Windows 包：资源完整，真实安装包验收通过或明确未验证原因。
16. 工作区：不混入既有 components.json 换行差异和 tools/fix_mojibake.py。

## 19. 阶段门禁

进入编码前：

- 用户确认本详细设计。
- LiuWei 根据本设计发出明确交接。
- 决定是否并行 ZhangSan 与 YeJing；若并行，先冻结文件所有权。

开发完成前：

- ZhangSan/YeJing 完成实现并报告验证命令。
- LiuKeAi 独立验收通过。
- 阻塞项已关闭，未验证项获得用户明确接受。
- git diff --check 通过。
- Provider 调用数确认为 0。

只有上述条件满足后，LiuWei 才能向用户报告 Stage 3A 开发完成。当前仅完成设计文档输出，不代表编码完成。
