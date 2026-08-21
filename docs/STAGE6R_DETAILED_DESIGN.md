# Stage 6-R 详细设计草案：多条已采用图片的显式 Timeline 批量装配

> 状态：Gate 6-R2 Core 生产实现完成，待独立验收  
> 依赖契约：`docs/STAGE6R_CONTRACT_FREEZE.md`  
> 本文件取代旧 `STAGE6_DETAILED_DESIGN.md` 作为 Stage 6 重启后的设计依据

## 1. 设计概述

Stage 6-R 在不改变 Stage 4E Adoption 模型和 Stage 5 单图装配行为的前提下，新增一个跨 Requirement 的批量装配切片：

```text
用户显式选择多条 image Requirement 的当前 Adoption
→ 本地确定性批量 Preview
→ 用户显式确认
→ 单事务创建一个 Timeline Revision
→ 记录一个批量 Assembly 批次和 N 条 item Assembly
```

## 2. 领域服务

新增 `ShotRequirementTimelineBatchAssemblyService`，不修改 Stage 5 服务职责。

### 2.1 主要方法

```text
prepare(project_id, request) -> BatchPreview
apply(project_id, request) -> BatchApplyResponse
get_preview(preview_id) -> BatchPreview
get_batch(batch_id) -> BatchAssembly
list(project_id, limit, cursor) -> BatchAssemblyPage
list_items(batch_id, limit, cursor) -> BatchAssemblyItemPage
```

### 2.2 资格校验

Prepare 和 Apply 都必须重新校验：

1. Project active；
2. 所有 Requirement 属于当前 confirmed Shot List Revision；
3. 所有 Requirement 为 image 且无既有素材来源；
4. 所有 item 的 `expected_adoption_id` 等于当前 Adoption；
5. 所有当前 Adoption 对应 managed available image Asset；
6. 所有 Asset 属于当前 Project；
7. 项目已有 Timeline；
8. 当前 Timeline Revision 等于请求基线；
9. 不存在未处理 Timeline Draft；
10. 没有任何 Requirement 已装配到当前 Timeline；
11. 批量插入不会移动锁定 Clip。

任一条件失败，整批失败。

## 3. Timeline 构建算法

### 3.1 基础原则

- 只使用既有 `TimelineService.build_asset_insert_document`；
- 不新增 TimelinePatch operation；
- 不修改 TimelineDocument v1 schema；
- 不复制 Timeline 校验规则。

### 3.2 构建流程

1. 读取 base Timeline Revision 的 Document；
2. 对 items 按数组顺序执行：
   - 第一次使用用户指定 `at_index`；
   - 后续使用前一张图片插入后的下一个位置；
3. 每次调用 `build_asset_insert_document` 获得新的纯内存 Document；
4. 每次 build 后复用 Timeline 归一化和校验；
5. 最后一次 build 的 Document 作为 proposed Document；
6. 计算 proposed Document hash。

### 3.3 影响统计

Preview 汇总：

- `item_count`；
- `clip_count_before`；
- `clip_count_after`；
- `shifted_clip_count`；
- `shifted_caption_count`；
- `duration_before_us`；
- `duration_after_us`。

每个 item 记录自己在当时插入阶段的增量影响，但最终 DTO 不返回 Timeline Document。

## 4. 事务与并发

### 4.1 Prepare

```text
BEGIN IMMEDIATE
→ 批量资格校验
→ 顺序构建 proposed Document
→ 插入一个批量 Preview
→ 插入 N 条 Preview item
→ COMMIT
```

Prepare 不创建 Timeline Revision、Assembly、Render Job 或 Artifact。

### 4.2 Apply

```text
BEGIN IMMEDIATE
→ 读取 Preview 与 items
→ hash 校验
→ 幂等检查
→ 过期检查
→ 批量资格重校验
→ 从 base Document 顺序重建 proposed Document
→ create_revision_from_document 一次
→ 插入一个批量 Assembly 批次
→ 插入 N 条 item Assembly
→ COMMIT
```

### 4.3 原子性

- 任一 item 校验失败，整批回滚；
- Timeline Revision 写入失败时，Assembly 批次和 item 均不写入；
- Assembly 任一写入失败时，整个事务回滚；
- 重启后 Preview、Assembly、Timeline Revision 与 Undo/Redo 状态一致。

### 4.4 幂等

- 同一 `batch_preview_id` 重复 Apply 时，如果已有批事实，返回既有批次并标记 `reused=true`；
- `proposed_document_sha256` 不匹配时拒绝；
- Preview 过期后拒绝；
- 不允许通过重新排序同一批 item 生成同一 Preview。

## 5. SQLite v17 设计

### 5.1 `shot_requirement_timeline_batch_assembly_previews`

字段摘要：

```text
id
project_id
shot_list_revision_id
base_timeline_revision_id
base_document_sha256
at_index
item_count
proposed_document_sha256
preview_sha256
clip_count_before
clip_count_after
shifted_clip_count
shifted_caption_count
duration_before_us
duration_after_us
expires_at
created_at
```

### 5.2 `shot_requirement_timeline_batch_assembly_preview_items`

字段摘要：

```text
id
batch_preview_id
item_index
shot_requirement_id
adoption_id
asset_id
proposed_clip_id
duration_us
layout
item_sha256
created_at
```

### 5.3 `shot_requirement_timeline_batch_assemblies`

字段摘要：

```text
id
project_id
shot_list_revision_id
batch_preview_id
base_timeline_revision_id
output_timeline_revision_id
proposed_document_sha256
item_count
created_at
```

### 5.4 `shot_requirement_timeline_batch_assembly_items`

字段摘要：

```text
id
batch_assembly_id
item_index
shot_requirement_id
adoption_id
asset_id
proposed_clip_id
duration_us
layout
created_at
```

### 5.5 约束与触发器

- Preview / Preview item 禁止 UPDATE/DELETE；
- Assembly / Assembly item 禁止 UPDATE/DELETE；
- `(batch_preview_id, item_index)` 唯一；
- `(batch_assembly_id, item_index)` 唯一；
- `(batch_assembly_id, shot_requirement_id)` 唯一；
- `(batch_assembly_id, proposed_clip_id)` 唯一；
- trigger 校验：
  - Project 一致；
  - Shot List Revision 一致；
  - Adoption 属于 Requirement；
  - Asset 属于 Project；
  - Preview hash 与 Apply hash 一致。

## 6. Contracts 设计

新增 `packages/contracts/src/stage6r.ts`：

```text
ShotRequirementTimelineBatchAssemblyPreviewId
ShotRequirementTimelineBatchAssemblyId
ShotRequirementTimelineBatchAssemblyPrepareInput
ShotRequirementTimelineBatchAssemblyApplyInput
ShotRequirementTimelineBatchAssemblyItemInput
ShotRequirementTimelineBatchAssemblyPreviewItem
ShotRequirementTimelineBatchAssemblyPreview
ShotRequirementTimelineBatchAssemblyItem
ShotRequirementTimelineBatchAssembly
ShotRequirementTimelineBatchAssemblyApplyResponse
ShotRequirementTimelineBatchAssemblyPage
ShotRequirementTimelineBatchAssemblyItemPage
```

契约版本升级为 `stage6r-v1`。

### 6.1 输入校验

- `items.length` 为 2–24；
- Requirement ID 唯一；
- `at_index >= 0`；
- `duration_us` 在 0.5–30 秒；
- `layout` 属于现有枚举；
- `confirmed === true`；
- 拒绝所有敏感键。

### 6.2 输出校验

所有 DTO 均使用严格白名单键集合，不允许出现：

```text
document
path
uri
absolute_path
prompt
requirement
visual_direction
narration_text
transcript
caption
authorization
api_key
secret
payload
raw_exception
raw_response
base64
stderr
command
traceback
```

## 7. Core API 设计

新增端点：

```text
POST /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies/prepare
POST /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies
GET  /api/v1/shot-requirement-timeline-batch-assembly-previews/{preview_id}
GET  /api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}
GET  /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies
GET  /api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}/items
```

错误处理遵循 Stage 6-R 契约冻结文档的稳定错误码。

## 8. Electron 与 Desktop 设计

### 8.1 Electron IPC

新增：

```text
stage6r:batch-assembly-prepare
stage6r:batch-assembly-apply
stage6r:batch-assembly-preview-get
stage6r:batch-assembly-get
stage6r:batch-assembly-list
stage6r:batch-assembly-item-list
```

IPC 只接受白名单 DTO，错误只透传稳定 code/message。

### 8.2 Desktop UI

在图片履约工作区新增批量装配面板：

1. 列出当前 confirmed Revision 中具备当前 Adoption 的 image Requirement；
2. 用户勾选并显式排序；
3. 用户设置起始插入位置；
4. 用户为每张图片设置时长和布局；
5. UI 显示 all-or-nothing 提示；
6. Prepare 后显示安全摘要；
7. Apply 需要用户显式确认；
8. 成功后通过既有 Timeline API 刷新。

### 8.3 禁止行为

- 不自动选择 item；
- 不自动排序；
- 不自动装配所有 Requirement；
- 不自动创建 Timeline；
- 不自动渲染或导出。

## 9. 测试策略

### 9.1 Core 单元测试

- 请求结构校验；
- 批量大小边界：1、2、24、25；
- Requirement 重复；
- 时长边界；
- layout 枚举；
- 当前 Adoption CAS；
- Asset unavailable；
- Timeline Draft；
- Timeline 基线冲突；
- 锁定 Clip；
- Preview 过期；
- hash mismatch；
- 幂等重放。

### 9.2 Core 集成测试

- 2、24 条 item 成功装配；
- 单条失败整批回滚；
- 成功后仅一个 Timeline Revision；
- 批次和 item 数量一致；
- 顺序与 Clip 位置一致；
- Undo/Redo；
- 重启恢复；
- v16→v17 升级；
- Stage 5 回归。

### 9.3 Contracts 测试

- DTO 白名单；
- 敏感键拒绝；
- 分页；
- 类型守卫；
- 错误映射。

### 9.4 Desktop / Electron 测试

- 批量选择与排序；
- 起始位置与时长布局输入；
- Prepare 摘要展示；
- Apply 显式确认；
- IPC 白名单；
- 错误安全投影；
- Stage 5 单图面板不回归。

## 10. 开发切片

### Gate 6-R1：隔离原型

- `tools/prototypes/stage6r_timeline_batch_assembly_model.py`
- 纯内存批量构建；
- SQLite v17 schema 原型；
- 事务与幂等模型；
- 不接入生产 API/UI。

### Gate 6-R2：Core 生产实现

- v17 migration；
- 批量服务；
- API；
- Core 测试。

### Gate 6-R3：Contracts / Electron / Desktop

- stage6r contracts；
- IPC；
- 批量装配面板；
- UI 测试。

### Gate 6-R4：独立验收

- fresh/upgrade 数据库；
- Electron E2E；
- 隐私扫描；
- Windows 安装态验证。

### Gate 6-R5：总回归与收口

- Core 全量；
- Contracts/Desktop 全量；
- Stage 5 回归；
- 文档更新；
- 版本控制收口。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 多 item 顺序构建导致重复 normalize 成本高 | 上限 24；Prepare/Apply 复用同一确定性算法 |
| 锁定 Clip 冲突复杂 | 每次 build 后由 Timeline 权威校验，不复制规则 |
| 批量失败时部分写入 | 单事务 all-or-nothing |
| 幂等语义复杂 | Preview ID 唯一，批事实唯一，重放返回 reused |
| 隐私泄漏 | 严格白名单 DTO，禁止 Document 和正文 |
| v17 迁移风险 | 只追加表，不修改 v16 |
| Stage 5 回归风险 | 不修改 Stage 5 服务与 API，纳入总回归 |

## 12. 明确禁止

- 不引入 Alembic/SQLAlchemy；
- 不引入 `services/web`；
- 不修改 Provider adapter；
- 不新增 Provider 或网络调用；
- 不引入智能建议、跨项目分享、版本比较；
- 不自动装配、自动渲染或自动导出；
- 不持久化媒体路径、Requirement 正文、Prompt、字幕、转写或原始异常。

## 13. Gate 6-R1 准入条件

- Stage 6-R 契约冻结文档通过审查；
- 批量范围、all-or-nothing 和幂等语义无歧义；
- SQLite v17 草案无破坏 v16 兼容性的字段；
- 原型只新增隔离文件，不接入生产链路。

