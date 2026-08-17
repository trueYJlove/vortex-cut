# 阶段 3A 契约冻结：平台预设、横竖双画幅与批量导出

> 角色：LiuWei（架构师）  
> 状态：已冻结，stage3a-v1  
> 日期：2026-08-15  
> 基线：`07a400f feat(brand): 完成 Vortex Cut 品牌切换与打包修复`  
> 依据：`ARCHITECTURE.md`、阶段 1C/2A/2B/2C 冻结契约与详细设计，以及用户对阶段 3A 范围、横竖画幅和共享 Timeline 方案的确认

## 1. 已确认决策

1. 阶段 3A 聚焦平台预设、横竖双画幅权威预览和多目标批量导出。
2. 发布平台与输出画幅是两个独立维度；平台可以提供默认画幅，但不得与竖屏画幅绑定。
3. 首版只支持标准竖屏 `9:16 / 1080x1920` 与横屏 `16:9 / 1920x1080`。两者均为
   H.264/AAC、CFR 30fps、yuv420p、48 kHz stereo MP4。
4. 横竖输出共享同一个不可变 `TimelineRevision` 的剪辑内容；每个输出目标使用独立、不可变的
   `RenditionSnapshot` 冻结平台、画幅、确定性布局、字幕样式和编码参数。
5. 阶段 3A 不创建两套可分别编辑的横竖 Timeline，不修改 `TimelineDocument v1`，也不允许
   输出层反向写入正式 Timeline。
6. 每个批量导出目标必须先有与同一 Snapshot、Timeline Revision 和工具链匹配的 ready 权威预览；
   不能用交互预览、旧 Revision 预览或另一画幅预览替代。
7. 批次内每个导出项使用独立 Job 和 ExportRecord。单项失败不得删除、覆盖或回滚其他成功项；
   显式重试创建新批次和新 Job，保留原批次历史。
8. 阶段 3A 不调用 AI Provider，不产生 Provider 费用，真实 Provider 调用数必须为 0。

本文是阶段 3A 的唯一需求来源。实现期间如需改变画幅集合、Timeline 兼容策略、Snapshot、
批次状态、路径授权、SQLite v9 或退出门禁，必须先由 LiuWei 组织变更确认。

## 2. 目标与范围

- 增加版本化 `PlatformPreset v1` 和 `RenditionPreset v1` 资源及严格本地校验。
- 首批平台标签为 `generic`、`douyin`、`wechat-channels`、`xiaohongshu`；首版均允许
  9:16 与 16:9。预设是 Vortex Cut 的交付默认值，不承诺第三方平台当前审核或上传规则。
- 增加 `RenditionSnapshot v1`，冻结 Timeline Revision、document hash、平台/画幅预设及 hash、
  布局解析结果、字幕解析结果、输出 Profile 和警告。
- 为 9:16 与 16:9 分别生成权威 Preview；Preview 产物和复用键包含 snapshot hash 与工具链。
- 增加 `ExportBatch v1` 和 `ExportBatchItem v1`，一次选择 1-8 个唯一平台/画幅目标。
- 增加目录级导出授权，由 Electron Main 获取用户授权，Core 在授权目录内生成安全文件名。
- Desktop 提供平台/画幅选择、确定性布局策略、逐目标预览、警告、批次进度、结果和失败项重试。
- 新增 SQLite v9，保留 v1-v8 SQL/checksum、历史数据、未知版本拒绝、备份、事务和回滚语义。
- 扩展 Contracts、Core、Desktop、Electron E2E、真实 FFmpeg、Windows 包和安全验收。

## 3. 非目标

- 任意宽高、1:1、4:5、3:4、2K、4K、可变帧率或用户自定义 FFmpeg 参数。
- 两套可分别编辑的横竖 Timeline、Timeline 分支同步、画幅专属 Undo/Redo 或画幅专属 AI Patch。
- AI 主体、人脸、摄像头或 HUD 检测/跟踪，OCR、游戏事件识别、关键帧裁切或自动重新构图。
- BGM、旁白、独立音频轨、多轨混音、音频关键帧、版权曲库或音量自动化。
- 自由字幕模板编辑、字幕动画、逐字特效或用户自定义字体。
- 云端发布、平台账号授权、直接上传、封面生成、发布文案或平台审核模拟。
- AI 自动选择平台、画幅、布局或导出目标；Stage 2 Provider、Candidate、adopt、TimelinePatch
  均不参与本阶段输出决策。
- 依赖图、局部 RenderPlan 或局部权威预览重算；每个 Rendition 仍完整渲染。
- 替换 `AIVS_*`、`@aivideo/*`、`aivideo://`、SQLite API 前缀或其他内部兼容标识。

## 4. 兼容性与安全不变量

- `CONTRACT_VERSION` 从 `stage2c-v1` 升至 `stage3a-v1`；Sidecar `protocol_version` 和
  API `/api/v1` 保持 1。
- `TimelineDocument v1`、TimelineCanvas、Clip、Caption、Lock、Revision、Draft、Patch、Diff、
  Proposal、Apply、CandidatePlan 和 adopt 的公开 schema 与语义保持不变。
- 历史项目及历史 Preview/ExportRecord 不重写、不删除；v9 新外键对历史行允许 `NULL`。
- 旧 `POST /projects/{id}/previews` 与 `POST /projects/{id}/exports` 保持阶段 1C portrait
  Profile 行为，用于向后兼容，不具备批次语义。
- 新目标化 API 不能接受绝对路径、任意文件名、FFmpeg 参数、滤镜、codec、URL 或命令文本。
- Renderer 只能看到 grant ID、display name、平台/画幅 ID、状态、hash 和受限媒体 URL；不得看到
  本地绝对路径、destination URI、Job 内部路径或原始错误详情。
- DirectoryGrant 只存在于 Core 进程内，15 分钟过期，绑定一个批次后不可被其他批次复用；
  Core 重启后必须重新授权。授权目录外不得创建、覆盖、移动或删除文件。
- 新批次默认不覆盖已有文件。Core 生成含安全项目名、平台、画幅和 item 短 ID 的唯一
  `.mp4` 文件名；发现冲突必须失败，不得静默改名或覆盖。
- Render 使用同目录临时文件，完整校验后原子移动到最终文件；失败和取消只删除当前 item 的
  临时文件，不删除成功文件、历史产物、用户原文件或其他 item 产物。
- Snapshot、Batch 和 Item 的公开 DTO、日志、Job/Event、错误和验收证据不得包含 Caption 正文、
  媒体内容、绝对路径、Provider 数据、API Key、Authorization 或完整 URL。
- Stage 1/2 的 safeStorage、IPC 白名单、受限媒体协议、Clip Lock、Caption 保护、Revision、
  Preview/Export 校验和 Provider 安全边界保持不变。

## 5. 平台与画幅预设

### 5.1 PlatformPreset v1

资源字段固定为：

| 字段 | 规则 |
| --- | --- |
| schema_version | 固定 1 |
| platform_preset_id | `generic`、`douyin`、`wechat-channels`、`xiaohongshu` |
| display_name | 本地化展示名，1-40 字符 |
| preset_version | 固定 1 |
| allowed_rendition_ids | 非空、无重复，只能引用 manifest 中的 Rendition |
| default_rendition_id | 必须包含在 allowed 集合内 |
| filename_tag | 小写 ASCII、数字和连字符，1-32 字符 |
| document_sha256 | 规范 JSON SHA-256 |

首版四个平台均允许 `portrait-9x16-v1` 与 `landscape-16x9-v1`；平台名称仅用于用户选择、
默认值和文件名，不改变 Timeline 内容。

### 5.2 RenditionPreset v1

| ID | Preview | Final Export | 固定规格 |
| --- | --- | --- | --- |
| portrait-9x16-v1 | 540x960 | 1080x1920 | 9:16 |
| landscape-16x9-v1 | 960x540 | 1920x1080 | 16:9 |

两者固定 30/1 fps、H.264、AAC、yuv420p、48 kHz stereo、faststart。软件和硬件编码可以有
不同码率，但最终媒体规格必须一致并经 FFprobe 和完整解码校验。

资源清单必须包含每个预设的版本、规范 hash、Preview/Export Profile、允许的布局策略、
字幕样式表引用和安全边距版本。未知字段、重复 ID、非法引用、hash 不匹配或非精确规格一律拒绝启动。

## 6. RenditionSnapshot v1

Snapshot 是输出语义的不可变事实，不是第二条 Timeline。其规范字段为：

- `schema_version=1`
- `rendition_snapshot_id`、`project_id`、`timeline_revision_id`
- `timeline_document_sha256`
- `platform_preset_id/version/document_sha256`
- `rendition_preset_id/version/document_sha256`
- `layout_policy`
- `resolved_segments[] = { clip_id, layout }`
- `caption_style_version` 与按画幅解析后的三个 CaptionPreset 样式 hash
- `preview_profile`、`export_profile`
- `warnings[]`、`snapshot_sha256`、`created_at`

`layout_policy` 只允许：

- `preserve_timeline`：逐 Clip 沿用 Timeline 中的 `fit/crop_fill/blurred_background`；
- `fit_all`：所有 Clip 完整显示，允许 letterbox/pillarbox；
- `crop_fill_all`：所有 Clip 中心裁切填满，不做主体跟踪；
- `blurred_background_all`：前景完整显示，背景中心裁切并模糊。

Core 必须把策略解析为每个 Clip 的固定布局并写入 Snapshot。后续 Preview/Export 只读取解析结果，
不能重新猜测。警告只允许固定代码，如 `CENTER_CROP_MAY_HIDE_CONTENT`、
`LETTERBOX_EXPECTED`、`PILLARBOX_EXPECTED`；不得包含媒体或 Caption 正文。

## 7. 字幕画幅规则

- 保留 `default-bottom`、`game-safe-bottom`、`high-contrast` 三个 CaptionPreset ID。
- 增加画幅感知、版本化字幕样式资源；每个 Rendition 都必须冻结 PlayRes、字号、左右边距、
  下边距、描边、背景和安全区。
- 竖屏历史样式视觉语义保持兼容；横屏使用独立的 1920x1080 解析值，不按竖屏像素直接复用。
- Snapshot 只保存解析样式的规范 hash，RenderPlan 保存完成渲染所需的固定样式；公开 DTO 不返回
  Caption 正文或完整 ASS。
- 本阶段不开放用户自定义数值、字体、颜色、动画或任意 ASS。

## 8. 权威预览契约

新增：

- `GET /api/v1/platform-presets`
- `GET /api/v1/rendition-presets`
- `POST /api/v1/projects/{project_id}/rendition-previews`
- `GET /api/v1/projects/{project_id}/rendition-previews`

创建输入包含：`timeline_revision_id`、`platform_preset_id`、`rendition_preset_id`、
`layout_policy` 和可选 `encoder_mode`。Core 创建或复用 Snapshot，再以
`timeline document hash + snapshot hash + preview profile + toolchain hash` 作为 Preview 复用键。

Preview DTO 必须返回 Snapshot 安全摘要、固定警告和受限媒体 URL，不返回本地路径。Timeline、
Snapshot、资源 hash 或工具链任一变化时不得复用。Timeline Revision 被撤销为历史版本不会删除预览，
但 Desktop 默认只把当前 Revision 的对应预览标为可用于新批次。

## 9. ExportBatch v1

### 9.1 创建输入

新增 `POST /api/v1/projects/{project_id}/export-batches`，输入包含：

- `timeline_revision_id`
- `directory_grant_id`
- 1-8 个 items；每项只包含 `rendition_snapshot_id`、`preview_artifact_id` 和
  可选 `encoder_mode`

同一批次内 `platform_preset_id + rendition_preset_id` 不得重复。Core 必须验证项目、Revision、
document hash、Snapshot、Preview、Profile、状态和工具链一致，所有项全过后才原子创建批次和 Jobs。
任何预检失败时不得创建部分批次、部分 Job 或输出文件。

### 9.2 状态

`ExportBatchItemStatus` 为：

- `queued`、`running`
- `succeeded`
- `failed`、`cancelled`、`interrupted`

`ExportBatchStatus` 由 item 状态派生，不作为第二事实源：

- 全部 queued：`queued`
- 任一 queued/running 且未全部终态：`running`
- 全部 succeeded：`succeeded`
- 至少一项 succeeded 且其余均终态非成功：`partial`
- 全部 cancelled：`cancelled`
- 无成功项且含 interrupted：`interrupted`
- 其他无成功终态组合：`failed`

批次取消只请求取消 queued/running item；已成功 item 和文件保持不变。

### 9.3 重试

新增 `POST /api/v1/export-batches/{batch_id}/retry`。只允许选择原批次中 failed、cancelled 或
interrupted 的 item，并要求新的 DirectoryGrant。重试创建新的 ExportBatch、item 和 Job，
保存 `retry_of_batch_id` 与 `retry_of_item_id`；不得修改原记录或复用旧路径授权。

## 10. 路径与文件命名

Electron Main 使用目录选择器创建内部 DirectoryGrant，Renderer 只接收安全 DTO。Core 文件名格式为：

`{safe-project}-{platform-tag}-{portrait|landscape}-{item-short-id}.mp4`

安全项目名移除 Windows 非法字符、控制字符、尾部空格/点和保留设备名，并有长度上限。最终路径经
规范化后必须仍是授权目录的直接子文件。禁止相对段、子目录、符号链接逃逸、替代数据流和非
`.mp4` 扩展名。已存在文件导致 `EXPORT_DESTINATION_EXISTS`，本阶段不提供覆盖开关。

## 11. SQLite v9

v9 新增：

- `rendition_snapshots`：不可变 Snapshot JSON/hash 及全部资源引用；
- `export_batches`：批次、Revision hash、目录 display name、重试来源和时间；
- `export_batch_items`：ordinal、Snapshot、Preview artifact、目标 display name 和重试来源；
- `jobs.export_batch_item_id` 可空外键；
- `render_artifacts.rendition_snapshot_id` 可空外键；
- `export_records.export_batch_item_id` 可空且唯一外键。

历史行的新列保持 `NULL`。Snapshot 禁止 UPDATE/DELETE；Batch 和 Item 的身份及引用字段禁止更新。
Item 运行状态从关联 Job 派生，避免双重状态源。迁移必须通过真实 v8 升级、备份、幂等、失败回滚、
未知版本拒绝和 v1-v8 checksum 未变验证。

## 12. Desktop 交互

1. 用户打开“多平台导出”，选择当前 Timeline Revision。
2. 选择 1-8 个平台/画幅组合及每个目标的确定性布局策略。
3. 系统展示固定规格、布局说明和警告；用户为缺失目标生成权威 Preview。
4. 所有目标 Preview ready 后，用户选择一次输出目录并确认精确目标列表。
5. 创建 Batch，界面逐项显示平台、画幅、状态、进度、文件名、固定错误码和操作。
6. 成功项可播放、打开和定位；失败项可选择后重新授权目录并创建重试批次。

交互预览必须明确标为非权威；不同画幅的权威 Preview 不得互相替代。用户关闭窗口或 Core 重启后，
丢失的 DirectoryGrant 使未完成 item 进入 interrupted，重新导出必须显式授权和重试。

## 13. 错误码

至少新增以下固定错误码：

- `PLATFORM_PRESET_INVALID`
- `RENDITION_PRESET_INVALID`
- `RENDITION_NOT_ALLOWED_FOR_PLATFORM`
- `RENDITION_SNAPSHOT_INVALID`
- `RENDITION_PREVIEW_REQUIRED`
- `RENDITION_PREVIEW_STALE`
- `EXPORT_BATCH_INVALID`
- `EXPORT_BATCH_ITEM_DUPLICATE`
- `EXPORT_DIRECTORY_GRANT_INVALID`
- `EXPORT_DIRECTORY_GRANT_EXPIRED`
- `EXPORT_DIRECTORY_GRANT_CLAIMED`
- `EXPORT_DESTINATION_EXISTS`
- `EXPORT_RETRY_NOT_ALLOWED`

Renderer 和验收证据只接收固定 code 与安全中文消息，不接收路径、FFmpeg stderr 或原始异常。

## 14. 验收与退出门禁

- Contracts：所有新 DTO、guard、严格字段、状态组合、跨实体引用和敏感字段拒绝。
- SQLite v9：真实 v8 升级、全新库、备份、幂等、失败回滚、未知版本拒绝及历史数据兼容。
- Preset：manifest/hash/未知字段/重复 ID/非法引用/精确规格/打包资源正反用例。
- RenderPlan/ASS/FFmpeg：两画幅、四布局策略、三 CaptionPreset、奇数尺寸/SAR/旋转源、
  静音与有声混排、CFR、H.264/AAC、尺寸、时长、hash 和完整解码。
- Preview：Snapshot 复用键、跨画幅不复用、stale、工具链变化、失败清理和重启行为。
- Batch：1-8 项、原子预检、独立进度、部分成功、取消、interrupted、重试新批次和历史保留。
- 路径安全：过期/复用 grant、冲突、保留名、Unicode、路径穿越、符号链接和授权目录边界。
- Desktop：平台与画幅解耦、Preview 门禁、批次状态、失败项重试、Renderer DTO 脱敏。
- 回归：阶段 1/2 Core、Contracts、Desktop、loopback Electron E2E、旧 portrait Preview/Export。
- 真实集成：9:16 与 16:9 Preview 和 Export、同批次至少两个目标、部分失败隔离、重启后历史恢复。
- Windows 包：预设和字幕资源齐全，真实安装包完整链路通过。
- Provider：调用数必须为 0。
- 安全扫描：SQLite、Job/Event、日志、DTO、证据和当前 diff 无敏感路径或正文泄漏。

只有 ZhangSan/YeJing 完成被分配实现、相关测试通过、LiuKeAi 独立逐项验收且阻塞项关闭后，
LiuWei 才能宣布阶段 3A 完成。
