# Stage 6-R 契约冻结草案：多条已采用图片的显式 Timeline 批量装配

> 状态：Gate 6-R2 Core 生产实现完成，待独立验收  
> 基线：`origin/master = b361e4e`，包含 PR #11 的 Stage 5-R 实现  
> 前置：Stage 5-R 已完成恢复、验收与合并  
> 本文件取代旧 `STAGE6_*` 草稿作为 Stage 6 重启后的唯一规划依据

## 1. LiuWei 架构结论

旧 Stage 6 草稿将多图装配、历史比较、智能建议和跨项目分享捆绑在一个阶段中，且与当前自有 SQLite migration、`apps/desktop` 实际入口不匹配，不能作为实施依据。

Stage 6-R 只保留一个最小、可验证、无 Provider 依赖的单一目标：

> **在同一 Project 的同一 confirmed Shot List Revision 中，选择多条 image Requirement 的当前 Adoption，按用户显式确认的顺序一次性装配到既有 Timeline，创建一个新 Timeline Revision，并为每条 Requirement 记录一条不可变装配事实。**

## 2. 范围决策

### 2.1 已采纳的唯一范围

- 输入是 2–24 条 image Requirement（与既有 `shot_requirements.ordinal` 的 0–23 约束一致）；
- 每条 Requirement 只允许出现一次；
- 只使用每条 Requirement 的当前 Adoption；
- 所有 Requirement 必须属于同一 Project；
- 所有 Requirement 必须属于同一 confirmed Shot List Revision；
- 用户显式指定批量插入的起始 `at_index`；
- 用户显式指定每张图片的时长与布局；
- 图片按用户选择顺序连续插入；
- Prepare 只创建一个批量 Preview，不修改 Timeline；
- Apply 在同一事务中创建恰好一个 Timeline Revision 和 N 条 Assembly 事实；
- Provider 调用、网络外传、费用增量固定为 0；
- 不调用真实 AI Provider；
- Stage 5 单图装配行为保持不变。

### 2.2 明确不包含

- 不允许一条 Requirement 在同一批次中出现多次；
- 不允许一条 Requirement 采用多个当前图片；
- 不支持跨 Project 装配；
- 不支持跨 confirmed Shot List Revision 装配；
- 不支持部分成功；
- 不支持自动选择图片或自动排序；
- 不支持智能建议；
- 不支持历史回滚或版本比较；
- 不支持跨项目分享；
- 不支持自动 Preview、Render、Export 或 Batch；
- 不修改 TimelineDocument v1、RenderPlan v1、Stage 4D/4E/5 公开契约；
- 不引入 Alembic、SQLAlchemy、`services/web` 或新 Web 服务。

## 3. 当前能力与断点

### 3.1 已具备

- Stage 4E 提供每条 Requirement 的 immutable Adoption ledger 和当前 Adoption 派生规则；
- Stage 5 提供单条已采用图片的 Preview、Apply、Assembly 事实与 SQLite v16 表；
- Timeline v1 支持 image Clip、0.5–30 秒时长、布局、锁定、Revision 与 CAS；
- `TimelineService.build_asset_insert_document` 是纯内存确定性构建，可在同一事务中连续调用；
- Desktop、Electron、Contracts 已具备 Stage 5 单图装配链路。

### 3.2 当前断点

- 用户只能逐条 Requirement 发起 Stage 5 装配；
- 多次 Stage 5 Apply 会创建多个 Timeline Revision，无法表达“一次确认、一个 Revision、多条装配事实”；
- 当前没有跨 Requirement 的批量资格校验和批量幂等事实。

## 4. 领域不变式

### 4.1 资格

- Project 必须处于 `active`；
- 所有 Requirement 必须属于当前 confirmed Shot List Revision；
- Requirement 必须是 `visual_kind='image'` 且没有既有素材来源；
- 每个 Requirement 必须存在当前 Adoption；
- 当前 Adoption 必须可用且对应 managed image Asset；
- 所有 Asset 必须属于当前 Project；
- 项目必须已有 Timeline，且不存在未处理 Timeline Draft。

### 4.2 输入

- `item_count` 必须为 2–24；
- 同一批次内 `requirement_id` 必须唯一；
- `at_index` 必须指向当前 Timeline 合法插入位置；
- 每张图片时长必须为 `500_000..30_000_000` 微秒；
- 每张图片布局必须属于既有 `TimelineLayout` 枚举；
- 不允许 Renderer 提交 Timeline Document 或 Timeline Patch。

### 4.3 顺序与插入

- 第一张图片插入用户指定 `at_index`；
- 后续图片按数组顺序依次插入前一张图片之后；
- 若插入会移动锁定 Clip，整批拒绝；
- 不自动优化顺序、去重或重排；
- 不改写 Caption 正文，只允许 Timeline 既有归一化逻辑平移受影响 Caption。

### 4.4 Preview

- 批量 Preview 持久化安全摘要，不保存完整 Timeline Document；
- Preview 必须记录每个 item 的 Requirement、Adoption、Asset、时长、布局和 proposed Clip ID；
- Preview 必须记录最终 proposed Document hash 与总影响摘要；
- Preview 有效期为 15 分钟；
- Prepare 只新增批量 Preview，不创建 Timeline Revision 或 Assembly。

### 4.5 Apply 与幂等

- Apply 必须显式确认；
- Apply 使用当前 Timeline Revision 与所有 item 的当前 Adoption CAS；
- 任一 item 失效、冲突、不可用或已装配时，整批失败；
- 成功 Apply 只创建一个 Timeline Revision；
- 成功 Apply 只创建一个批量 Assembly 批次事实和 N 条 item Assembly 事实；
- 同一 Preview 重放返回既有结果，不重复写入；
- Preview 过期后必须重新 Prepare。

## 5. SQLite v17 草案

### 5.1 迁移原则

- 从 v16 到 v17 只追加新表和索引；
- 不修改 Stage 4D/4E/5 既有表；
- 不迁移或回填历史数据；
- 继续使用当前 `database_v17.py` + `MIGRATIONS` 自有迁移机制；
- 新表禁止 UPDATE/DELETE，保持 append-only。

### 5.2 新表

建议新增三张表：

1. `shot_requirement_timeline_batch_assembly_previews`
   - 保存批量 Preview 安全摘要与最终 proposed Document hash；
   - 不保存完整 Timeline Document；
   - 不保存 Requirement/Prompt/字幕/转写正文或媒体路径。

2. `shot_requirement_timeline_batch_assemblies`
   - 保存批量装配批次事实；
   - 关联 base Timeline Revision 与 output Timeline Revision；
   - 一次成功 Apply 只插入一行。

3. `shot_requirement_timeline_batch_assembly_items`
   - 保存批次内每个 Requirement 的装配事实；
   - 关联 Preview item、Adoption、Asset、proposed Clip ID；
   - 一次成功 Apply 插入 N 行。

### 5.3 关键约束

- `batch_id` 唯一；
- `preview_id` 唯一；
- `item_index` 在批内唯一且连续；
- `(batch_id, requirement_id)` 唯一；
- `(batch_id, proposed_clip_id)` 唯一；
- Preview 与 item 均不可变；
- 批次事实与 item 事实不可变；
- trigger 校验同一 Project、同一 Shot List Revision、同一 Timeline 基线。

## 6. API / DTO 契约草案

### 6.1 API

建议新增项目级批量端点：

```text
POST /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies/prepare
POST /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies
GET  /api/v1/shot-requirement-timeline-batch-assembly-previews/{preview_id}
GET  /api/v1/shot-requirement-timeline-batch-assemblies/{batch_id}
GET  /api/v1/projects/{project_id}/shot-requirement-timeline-batch-assemblies
```

### 6.2 输入摘要

```text
PrepareInput:
- base_timeline_revision_id
- at_index
- items: [
    requirement_id
    expected_adoption_id
    duration_us
    layout
  ]

ApplyInput:
- batch_preview_id
- proposed_document_sha256
- confirmed: true
```

### 6.3 输出边界

Preview 与 Assembly DTO 只允许安全摘要：

- ID、版本、数量、顺序；
- Asset 安全摘要；
- Timeline Revision ID 与 hash；
- clip 计数、位移计数、总时长变化；
- item 的 Requirement/Adoption/Asset/Clip ID。

禁止返回：

- Timeline Document；
- Requirement 标题或视觉说明；
- Prompt/Requirement 正文；
- Caption/Transcript 正文；
- 媒体绝对路径或 URI；
- Provider 凭据或原始请求/响应；
- 原始异常对象。

## 7. 稳定错误码

建议新增：

```text
STAGE6_BATCH_REQUEST_INVALID
STAGE6_BATCH_SIZE_INVALID
STAGE6_BATCH_REQUIREMENT_DUPLICATED
STAGE6_BATCH_REQUIREMENT_NOT_ELIGIBLE
STAGE6_BATCH_ADOPTION_CONFLICT
STAGE6_BATCH_TIMELINE_REQUIRED
STAGE6_BATCH_TIMELINE_CONFLICT
STAGE6_BATCH_TIMELINE_DRAFT_EXISTS
STAGE6_BATCH_ASSET_UNAVAILABLE
STAGE6_BATCH_ALREADY_ASSEMBLED
STAGE6_BATCH_POSITION_INVALID
STAGE6_BATCH_DURATION_INVALID
STAGE6_BATCH_PREVIEW_EXPIRED
STAGE6_BATCH_PREVIEW_MISMATCH
STAGE6_BATCH_CONFIRMATION_REQUIRED
STAGE6_BATCH_NOT_FOUND
```

未知异常必须投影为安全错误，不携带原始异常对象。

## 8. Desktop / Electron / Windows

- 在图片履约工作区新增批量装配入口；
- 用户显式选择已具备当前 Adoption 的 image Requirement；
- 用户显式排序、设置起始位置、每张时长与布局；
- UI 必须在 Prepare 前展示 all-or-nothing 语义；
- Apply 成功后通过既有 Timeline API 刷新；
- Electron IPC 只允许白名单 DTO；
- Windows 无新增打包要求；
- v16 数据库升级 v17 后既有 Stage 5 数据必须保持可读。

## 9. 隐私、安全与 Provider 边界

- Provider 调用增量为 0；
- 网络外传增量为 0；
- 费用增量为 0；
- 不读取、不输出、不持久化 token、API key、Authorization、原始请求/响应；
- 不读取、不输出媒体绝对路径；
- 不持久化 Prompt/Requirement 正文、字幕/转写正文或原始异常对象；
- 所有错误使用稳定安全错误码和安全消息。

## 10. 角色与互斥文件所有权

### LiuWei

- 本契约冻结与最终架构决策。

### ZhangSan

- Core 批量装配服务；
- SQLite v17；
- Timeline 内部确定性构建；
- Core 单元/集成测试。

不得修改 Contracts、Desktop、Electron 或样式文件。

### YeJing

- Contracts stage6r；
- Desktop 批量装配 UI；
- Electron IPC；
- Windows 验证。

不得修改 Core 数据库或 Timeline 领域实现。

### LiuKeAi

- 独立验证范围、事务、幂等、迁移、隐私与测试覆盖；
- 不参与实现。

## 11. Gate 6-R0 验收清单

- [ ] 旧 Stage 6 草稿被明确标记为历史依据，不再作为实施依据；
- [ ] 唯一范围冻结为多条当前已采用图片的显式批量装配；
- [ ] 不改变 Stage 4E 单当前 Adoption 模型；
- [ ] 不改变 Stage 5 单图装配行为；
- [ ] 批量语义为 all-or-nothing；
- [ ] 成功 Apply 只创建一个 Timeline Revision；
- [ ] Provider/网络/费用增量为 0；
- [ ] 隐私边界不弱于 Stage 5；
- [ ] 数据库方案只追加 v17 表；
- [ ] 三份 Stage 6-R 文档相互一致。

## 12. 结论

Stage 6-R 推荐进入 Gate 6-R1 原型设计。必须先以隔离原型验证多 item 顺序构建、锁定冲突、事务原子性、幂等和 SQLite v17 约束，再申请生产实现授权。

