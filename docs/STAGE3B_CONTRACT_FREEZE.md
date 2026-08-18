# 阶段 3B 契约冻结：逐片段静态焦点锚点重构图

> 角色：LiuWei（架构师）
> 状态：已确认、待实现，`stage3b-v1`
> 日期：2026-08-18
> 基线：`5222e3a feat: add Stage 3A rendition batch export`
> 依据：`ARCHITECTURE.md`、阶段 1A–3A 冻结契约与详细设计，以及用户对阶段 3B 范围、3×3 静态锚点、独立 Snapshot/API/Batch、SQLite v10 和 Provider 零调用边界的确认

## 1. 文档地位与已确认决策

本文是阶段 3B 的唯一需求来源，但不取代阶段 1–3A 已冻结契约。阶段 3B 实现必须同时满足
`STAGE3A_CONTRACT_FREEZE.md` 的兼容性和安全不变量；出现冲突时必须暂停实现，由 LiuWei 组织契约变更确认。

已确认：

1. 阶段 3B 只解决 Stage 3A 固定中心 `crop_fill` 可能隐藏关键画面的问题。
2. 用户可以为每个适用 Clip 选择一个静态 3×3 焦点锚点；锚点在整个 Clip 生命周期内固定。
3. 只支持离散锚点，不支持自由坐标、像素偏移、百分比、关键帧、平滑移动或自动跟踪。
4. 只允许调整 Stage 3A 基础 `RenditionSnapshot v1` 中已解析为 `crop_fill` 的 Clip。
5. 阶段 3B 创建独立、不可变的 `RenditionReframeSnapshot v1`，引用而不修改基础 Snapshot。
6. 阶段 3B 使用独立 Preview API、Batch/Item API 和 retry lineage；不向 Stage 3A 严格 DTO 增加 optional 字段。
7. SQLite 从 v9 追加升级到 v10；v1–v9 SQL 和 checksum 不得修改。
8. 阶段 3B 不调用任何 AI Provider，不读取 Provider 凭据，不产生 Provider 费用，真实 Provider 调用数必须为 0。
9. 本契约定义团队角色、职责、边界、所有权和交付接口，不规定角色执行顺序，也不规定使用单会话、subagent 或其他执行拓扑。实际工作可串行或并行，但不得突破契约和文件所有权。

## 2. 用户价值与范围

### 2.1 用户价值

横屏游戏录像输出为 9:16 时，中心裁切可能隐藏位于左右区域的角色、操作或 HUD；竖屏素材输出为
16:9 时也可能需要选择上方或下方构图。阶段 3B 通过用户显式选择静态焦点，提供：

- 可预测、可复核的逐 Clip 构图；
- Preview 与 Export 使用相同语义；
- 不依赖视觉模型、网络或 Provider；
- 不创建第二条 Timeline，不改变剪辑内容；
- 为未来自动检测或动态跟踪保留独立演进边界，但不提前承诺这些能力。

### 2.2 交付范围

- 新增 3×3 锚点枚举和严格 DTO/guard。
- 新增不可变 `RenditionReframeSnapshot v1`。
- 新增 Stage 3B 权威 Preview 创建、查询、复用和 stale 规则。
- 新增 1–8 项 Reframe Batch、partial 失败隔离、取消、重启恢复和显式 retry lineage。
- RenderPlan 增加仅供 Stage 3B 使用的版本化重构图执行语义。
- FFmpeg 在旋转/SAR 归一化后按锚点确定裁切窗口，并保持 yuv420p 所需的偶数几何。
- Desktop 提供适用 Clip 列表、3×3 锚点控件、非权威交互构图提示、权威 Preview 门禁和批次结果。
- Electron 继续使用白名单 IPC、受限媒体协议和目录授权。
- SQLite v10、Contracts、Core、Desktop、Electron、真实 FFmpeg 和 Windows 实际安装验收。

## 3. 非目标

- AI 主体、人脸、摄像头、HUD、OCR、游戏事件或显著区域检测。
- 自动选焦、自动重新构图、逐帧跟踪、关键帧、缓动、pan/zoom 或 Ken Burns。
- 任意 `x/y`、像素、百分比、表达式、FFmpeg 参数、filter graph 或命令文本。
- 修改 `TimelineDocument v1`、Clip schema、TimelinePatch、Lock、Revision、Draft、Diff、CandidatePlan 或 adopt。
- 新画幅、新平台、2K/4K、自由编码参数或覆盖 Stage 3A preset。
- 修改字幕主题、字幕正文、CaptionPreset、BGM、旁白、独立音频轨或多轨混音。
- 云端发布、平台登录、封面、发布文案或平台审核模拟。
- 将构图参考线表述为平台安全区保证或自动 HUD 保护。
- 依赖图、局部 RenderPlan、局部权威 Preview 或仅重渲染单一 Clip；首版仍完整渲染目标。
- Provider capability、Provider adapter、外传确认、网络调用或密钥管理变更。

## 4. Stage 1–3A 兼容性与安全不变量

- `CONTRACT_VERSION` 从 `stage3a-v1` 升至 `stage3b-v1`；Sidecar `protocol_version=1` 和 `/api/v1` 保持不变。
- `TimelineDocument v1` 以及所有 Stage 1/2 公开 schema 和语义保持不变。
- Stage 3A 的 `PlatformPreset v1`、`RenditionPreset v1`、四个 `LayoutPolicy`、`RenditionSnapshot v1`、
  权威 Preview、ExportBatch、DirectoryGrant、状态派生和 retry 语义保持不变。
- Stage 3A 默认中心裁切保持不变。没有显式创建 Reframe Snapshot 的流程必须生成与 Stage 3A 相同的结果。
- 旧 Stage 1C Preview/Export API 和 Stage 3A 全部 API 保持可用，不返回 Stage 3B 新字段。
- 历史 Project、Revision、Snapshot、Artifact、ExportRecord、Batch 和 Job 不重写、不删除。
- Stage 3A Preview 不能充当 Stage 3B 权威 Preview；另一个 Reframe Snapshot 的 Preview 也不能替代。
- Renderer 不得获得绝对路径、destination URI、Caption/Transcript 正文、完整 Timeline 文档、原始异常、
  FFmpeg stderr、Provider 数据、密钥、Authorization 或完整 URL。
- 新 API 不接受路径、文件名、URL、codec、滤镜、命令、任意数值坐标或媒体正文。
- 原子输出、冲突拒绝、临时文件清理、授权目录边界和受限媒体规则沿用 Stage 3A。

## 5. 标识、枚举与限制

新增品牌类型：

- `RenditionReframeSnapshotId`
- `ReframeExportBatchId`
- `ReframeExportBatchItemId`

ID 继续满足 `[A-Za-z0-9_-]{1,128}`，时间使用 UTC ISO 8601，hash 使用既有 SHA-256 格式。

```text
HorizontalAnchor = left | center | right
VerticalAnchor   = top | center | bottom
```

九个用户选择组合为：

```text
left/top       center/top       right/top
left/center    center/center    right/center
left/bottom    center/bottom    right/bottom
```

`RenditionReframeAdjustment v1`：

```json
{
  "clip_id": "clip_01",
  "horizontal_anchor": "left",
  "vertical_anchor": "center"
}
```

输入限制：

- `adjustments` 长度为 1–500，`clip_id` 不得重复。
- 输入只列出用户要求覆盖默认中心裁切的 Clip。
- 每项经几何规范化后必须至少有一个轴不是 `center`；无实际效果的项以 `REFRAME_NOT_APPLICABLE` 拒绝。
- 所有调整必须属于同一个基础 Snapshot，不允许跨 Project、Revision 或 Snapshot 混用。

## 6. RenditionReframeSnapshot v1

### 6.1 身份与规范字段

Reframe Snapshot 是 Stage 3B 输出语义的不可变事实，不是 Timeline，也不是对 Stage 3A Snapshot 的更新。
规范文档至少包含：

- `schema_version=1`
- `rendition_reframe_snapshot_id`
- `project_id`、`timeline_revision_id`
- `timeline_document_sha256`
- `base_rendition_snapshot_id`、`base_snapshot_sha256`
- 基础 Snapshot 的 `platform_preset_id`、`rendition_preset_id`、`layout_policy`
- `geometry_contract_version=1`
- 排序后的 `resolved_adjustments[]`
- `warnings[]`
- `reframe_snapshot_sha256`
- `created_at`

内部 `resolved_adjustments[]` 每项至少冻结：

```json
{
  "clip_id": "clip_01",
  "base_layout": "crop_fill",
  "horizontal_anchor": "left",
  "vertical_anchor": "center"
}
```

Snapshot 可保存重现规范化所需的受控几何摘要或 hash，但公开 DTO 不返回素材尺寸、路径、媒体正文或完整内部 JSON。

### 6.2 创建和复用

Core 必须：

1. 读取现有 Stage 3A `rendition_snapshots` 行，不得重编译或修改基础 Snapshot。
2. 验证基础 Snapshot、Project、Revision、document hash、preset hash 和 resolved segments 完整一致。
3. 验证每个 Clip 存在且基础解析布局为 `crop_fill`。
4. 根据经旋转和 SAR 归一化后的显示几何规范化无效轴。
5. 按 Timeline Clip 顺序规范化 `resolved_adjustments`，计算规范 JSON SHA-256。
6. 规范事实完全相同时复用现有 Reframe Snapshot；否则创建新行。

Snapshot 创建后禁止 UPDATE 和 DELETE。Stage 3A Snapshot、Timeline 或全局 preset 后续变化不得改写历史 Reframe Snapshot。

## 7. 静态焦点与裁切几何契约

1. 几何计算必须在源画面旋转和 sample aspect ratio 归一化后进行。
2. 先按目标画布执行保持宽高比的 `increase` 缩放，再计算超出目标画布的裁切余量。
3. 水平锚点映射为水平余量的 `0% / 50% / 100%`；垂直锚点映射为垂直余量的
   `0% / 50% / 100%`。
4. 某轴没有正裁切余量时，该轴规范化为 `center`。
5. 裁切起点必须限制在合法范围内，并按确定规则规范化为满足 yuv420p 的偶数像素；不能依赖 FFmpeg 隐式取整。
6. 同一个有效锚点在 Preview 和 Export 的不同分辨率下保持相同的归一化构图意图。
7. 没有 adjustment 的 `crop_fill` Clip 继续使用 Stage 3A 中心裁切。
8. `fit` 和 `blurred_background` 不接受 adjustment；不得改变其 Stage 3A 行为。
9. 静态焦点只改变裁切窗口，不改变 Clip 时序、音频、字幕、锁定或内容顺序。

固定警告码首版只允许：

- `STATIC_REFRAME_APPLIED`
- `REFRAME_AXIS_NORMALIZED`
- `REFRAME_MAY_HIDE_OPPOSITE_EDGE`

警告不得包含路径、Caption/Transcript/媒体正文或任意异常详情。

## 8. Stage 3B 权威 Preview

新增：

- `POST /api/v1/projects/{project_id}/rendition-reframe-previews`
- `GET /api/v1/projects/{project_id}/rendition-reframe-previews`

创建输入：

```json
{
  "base_rendition_snapshot_id": "snapshot_01",
  "adjustments": [
    {"clip_id":"clip_01","horizontal_anchor":"left","vertical_anchor":"center"}
  ],
  "encoder_mode": "auto"
}
```

Core 创建或复用 Reframe Snapshot。Preview 复用键至少包含：

```text
timeline_document_sha256
base_snapshot_sha256
reframe_snapshot_sha256
preview_profile_id
toolchain_sha256
encoder/fallback semantics
```

Preview DTO 返回 Reframe Snapshot 安全摘要、Artifact 安全元数据和受限媒体展示所需 ID；不返回本地路径。
基础 Snapshot、Reframe Snapshot、工具链、Profile、输入 fingerprint 或 Artifact 有效性任一不匹配时不得复用。

Desktop 的交互构图可以作为非权威近似，但必须清楚标注；只有上述 Core/FFmpeg 产物是权威 Preview。

## 9. ReframeExportBatch v1

### 9.1 创建

新增：

- `POST /api/v1/projects/{project_id}/reframe-export-batches`
- `GET /api/v1/projects/{project_id}/reframe-export-batches`
- `GET /api/v1/reframe-export-batches/{batch_id}`
- `POST /api/v1/reframe-export-batches/{batch_id}/cancel`
- `POST /api/v1/reframe-export-batches/{batch_id}/retry`

创建输入包含：

- `directory_grant_id`
- 1–8 个 items
- 每项只含 `rendition_reframe_snapshot_id`、`preview_artifact_id` 和可选 `encoder_mode`

同一批次内基础 Snapshot 的 `platform_preset_id + rendition_preset_id` 不得重复。Core 必须原子验证所有
Project、Revision、document hash、基础 Snapshot、Reframe Snapshot、Preview、Profile、状态和工具链；全部通过后才能创建 Batch、Items 和 Jobs。

输出安全文件名：

```text
{safe-project}-{platform-tag}-{portrait|landscape}-reframe-{item-short-id}.mp4
```

沿用 Stage 3A 的 Windows 安全文件名、直接子文件、无覆盖、同目录临时文件、完整校验和原子移动规则。

### 9.2 状态、取消和恢复

Item 状态与 Stage 3A 一致：

```text
queued | running | succeeded | failed | cancelled | interrupted
```

Batch 状态与 Stage 3A 一致并由关联 Job 派生：

```text
queued | running | succeeded | partial | failed | cancelled | interrupted
```

状态派生优先级、partial 隔离和取消语义完全沿用 Stage 3A。Core 重启后未完成 Job 按既有规则进入
`interrupted`；历史成功文件和记录保持不变。Stage 3A 与 Stage 3B Batch lineage 不得互相引用。

### 9.3 Retry lineage

Retry 只允许选择原 Reframe Batch 中 `failed | cancelled | interrupted` 的 item，并要求新的
DirectoryGrant。Retry 创建新的 Reframe Batch、Item 和 Job，保存 `retry_of_batch_id` 和
`retry_of_item_id`；不得修改原记录、复用旧授权或跨 Stage 3A lineage 重试。

## 10. DirectoryGrant、路径和文件安全

- 复用 Stage 3A Core 内存 `DirectoryGrantStore` 的安全语义，不改变 Stage 3A DTO。
- Electron Main 通过目录选择器取得绝对路径并调用内部管理 API；Renderer 只得到 grant ID、展示名和过期时间。
- Grant 15 分钟过期，绑定一个 Batch 后不可被其他 Batch 复用，Core 重启后失效。
- 最终路径必须是授权目录的直接子文件；禁止相对段、子目录、符号链接逃逸、替代数据流和非 `.mp4` 扩展。
- 已存在文件返回 `EXPORT_DESTINATION_EXISTS`，不得覆盖或静默改名。
- 失败或取消只清理当前 item 的临时文件，不删除其他成功文件、历史产物、用户原文件或授权目录内容。

## 11. SQLite v10

v10 只追加迁移，至少新增：

- `rendition_reframe_snapshots`
- `reframe_export_batches`
- `reframe_export_batch_items`
- `jobs.reframe_export_batch_item_id` 可空外键
- `render_artifacts.rendition_reframe_snapshot_id` 可空外键
- `export_records.reframe_export_batch_item_id` 可空且唯一外键

约束：

- Reframe Snapshot 禁止 UPDATE/DELETE。
- Reframe Batch 和 Item 的身份、Project、Revision、Snapshot、Preview、目录展示名和 retry 引用不可更新；历史行不可删除。
- Reframe final export Job、Artifact、ExportRecord 不能同时声明 Stage 3A item/snapshot 和 Stage 3B item/snapshot 归属。
- Item 状态从 Job 派生，不新增第二状态事实源。
- 历史行新列保持 `NULL`；历史数据不回填 Reframe 事实。

迁移必须满足：

- v1–v9 SQL 与 checksum 保持不变；
- 全新数据库可初始化到 v10；
- 真实 v9 备份可升级并保留全部 Stage 1–3A 数据；
- 升级前备份、单事务应用、失败回滚、重复初始化幂等；
- 未知版本和 checksum 不匹配继续拒绝；
- 不提供破坏性 down migration；旧二进制遇到 v10 必须安全拒绝写入。

## 12. Contracts 与公开 DTO

新增 DTO：

- `RenditionReframeAdjustment`
- `RenditionReframePreviewCreateInput/Response`
- `RenditionReframeSnapshotSummary`
- `RenditionReframePreview/Page`
- `ReframeExportBatchCreateItem/Input/Response`
- `ReframeExportBatchItem`
- `ReframeExportBatch/Page`
- `ReframeExportBatchRetryInput/Response`

安全摘要示例：

```json
{
  "rendition_reframe_snapshot_id": "reframe_01",
  "project_id": "project_01",
  "timeline_revision_id": "revision_01",
  "base_rendition_snapshot_id": "snapshot_01",
  "base_snapshot_sha256": "sha256:...",
  "platform_preset_id": "douyin",
  "rendition_preset_id": "portrait-9x16-v1",
  "adjustment_count": 1,
  "reframe_snapshot_sha256": "sha256:...",
  "warnings": ["STATIC_REFRAME_APPLIED"],
  "created_at": "2026-08-18T00:00:00.000Z"
}
```

所有 guard 必须严格拒绝未知字段、敏感键、非法枚举、重复 Clip、0 或 501 项、错误状态组合和跨实体不一致。
公开 DTO 不返回完整 adjustments；Desktop 在当前编辑会话中保留用户选择，持久历史只展示安全计数、hash 和固定警告。

## 13. Desktop、Electron 与 IPC

Desktop 必须：

1. 从一个 Stage 3A 基础 Snapshot 进入“静态焦点重构图”。
2. 只为基础 resolved layout 为 `crop_fill` 的 Clip 启用锚点控件。
3. 默认中心；只有至少一个有效非中心调整时才允许生成 Stage 3B Preview。
4. 将交互构图明确标为“非权威近似”。
5. 将参考线明确标为“不执行 HUD/主体识别，不代表平台审核安全区”。
6. Reframe 选择改变后，旧 Preview 不再满足当前输出门禁。
7. 所有目标的 Stage 3B Preview ready 后才能授权目录并创建 Reframe Batch。
8. 显示逐项进度、安全文件名、固定错误码、partial 和显式重试入口。

Electron/Preload 必须：

- 只暴露具体的 Reframe 方法，不暴露通用 fetch、任意 IPC channel 或路径参数。
- 对 Renderer 输入再次做严格 ID、枚举、数组长度和 unknown-field 校验。
- 继续通过受限媒体 ticket 展示 Artifact；不得向 Renderer 公开解析后的路径。
- 可以复用目录选择 IPC 的实现，但不得改变 Stage 3A 的公开方法和返回值。

## 14. 隐私、安全和 Provider 边界

- 阶段 3B 全链路 Provider 调用数必须为 0。
- 不读取 safeStorage 中的 Provider secret，不测试 capability，不创建 EgressPreview、Consent 或 ProviderInvocation。
- DTO、日志、Job/Event、SQLite 公开证据和验收报告不得包含绝对路径、Caption/Transcript 正文、完整 Timeline、
  原始异常、stderr、命令行、Provider token、API key、Authorization、Prompt、请求载荷或响应。
- 错误只能返回稳定 code 和安全消息。程序分支不得依赖本地化 message。
- 合成验收素材不得包含真实用户媒体、账户或秘密。

## 15. 稳定错误码

至少新增：

```text
REFRAME_SNAPSHOT_INVALID
REFRAME_ADJUSTMENT_DUPLICATE
REFRAME_CLIP_NOT_FOUND
REFRAME_NOT_APPLICABLE
REFRAME_ANCHOR_INVALID
REFRAME_PREVIEW_REQUIRED
REFRAME_PREVIEW_STALE
REFRAME_BATCH_INVALID
REFRAME_BATCH_ITEM_DUPLICATE
REFRAME_RETRY_NOT_ALLOWED
```

继续复用 Stage 3A 目录和目标错误码：

```text
EXPORT_DIRECTORY_GRANT_INVALID
EXPORT_DIRECTORY_GRANT_EXPIRED
EXPORT_DIRECTORY_GRANT_CLAIMED
EXPORT_DESTINATION_EXISTS
```

输入错误为 400/422，不存在为 404，状态/快照/工具链冲突为 409，内部安全渲染错误为 500；具体映射在详细设计中冻结。

## 16. 角色、职责与协作边界

以下是职责定义，不是执行顺序。实际实施可以串行或并行，也可以由单一执行单元或多个执行单元完成；
任何方式都必须遵守文件所有权、冻结接口和集成门禁。

### LiuWei（架构师）

- 维护范围、契约和架构边界。
- 裁决跨 Core/Contracts/Desktop 的字段或语义冲突。
- 批准契约变更、所有权调整和阶段门禁结果。
- 不以进度压力放宽 Stage 3A 兼容、安全或 Provider 零调用要求。

### ZhangSan（Core/数据/渲染负责人）

- 负责 SQLite v10、Reframe Snapshot、RenderPlan/FFmpeg、Job、Preview、Batch 和 Core API。
- 保证几何确定性、数据库不可变性、任务恢复、文件原子性和 Python 测试。
- 不修改 Stage 3A 公开语义，不接触 Provider 调用，不向公开数据泄漏敏感内容。

### YeJing（Contracts/Desktop/Electron/打包负责人）

- 负责共享 DTO/guard、Core Client、Desktop UI、白名单 IPC/Preload、受限媒体和 Windows 包验证。
- 保证 Renderer 输入输出脱敏、交互门禁和参考线文案准确。
- 不绕过 Contracts，不让 Renderer 获得路径，不向 Core 注入任意渲染参数。

### LiuKeAi（独立审查与验收负责人）

- 不以开发者报告代替独立 diff、命令和真实产物核验。
- 审查范围膨胀、Stage 1–3A 冲突、迁移、真实 FFmpeg、Windows 安装、安全和 Provider 零调用。
- 对未验证项明确记录，不把本地模拟通过表述为真实包通过。

## 17. 验收与退出门禁

- Contracts：DTO/guard 正反用例、unknown/sensitive key、锚点、计数、状态和跨实体校验。
- SQLite v10：真实 v9 升级、全新库、备份、幂等、失败回滚、未知版本、历史兼容和 v1–v9 checksum。
- Snapshot：基础引用、适用性、排序、规范化、复用、不可变、hash 稳定。
- Geometry：九宫格、旋转、SAR、奇数尺寸、横/竖 overflow 和偶数裁切。
- Preview：Stage 3A 不可替代、跨 Snapshot 不复用、stale、工具链变化和失败清理。
- Batch：1–8 项、原子预检、unique target、partial、取消、interrupted、retry 新 lineage。
- Render：真实 FFmpeg、9:16/16:9、H.264/AAC、CFR 30、yuv420p、48 kHz stereo、完整解码和 hash。
- 一致性：Preview 与 Export 的归一化构图一致。
- Desktop/Electron：适用 Clip、3×3 控件、非权威标识、Preview 门禁、目录 DTO 和 Renderer 脱敏。
- 回归：Stage 1–3A Core、Contracts、Desktop、Electron E2E、旧 Preview/Export/Batch 全部保持。
- Windows：真实 NSIS 安装、启动、非中心 Preview、批量导出、partial/retry 和重启恢复。
- Provider：调用数为 0，且无 secret、payload 或 ProviderInvocation 参与。
- 安全：SQLite、日志、Job/Event、DTO、证据和当前 diff 不泄漏受禁内容。

只有实现与测试完成、LiuKeAi 独立验收逐项通过或未验证项获得用户明确接受、阻塞项关闭并经用户确认后，
才能报告 Stage 3B 开发完成。本文冻结不代表实现已经开始或完成。
