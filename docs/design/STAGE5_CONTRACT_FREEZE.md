# Stage 5 契约冻结草案：已采用图片的显式 Timeline 装配

> 负责人：LiuWei（架构师）
> 日期：2026-08-20
> 基线：Stage 4E 完成提交 `f484256`（PR #5）
> 上游契约：Stage 4C `stage4c-v1`、Stage 4D `stage4d-v2`、Stage 4E `stage4e-v1`
> 建议数据库版本：SQLite v16
> 建议 API/DTO 契约：`stage5-v1`
> 状态：Stage 5-R 当前源码已通过 Gate 5-R1–R5 恢复验收；历史 Gate 5-3/5-4 记录恢复有效；版本控制操作待用户授权
> Stage 5-R 说明：因原始 Stage 5 新增文件漏提交，历史记录曾临时作废；当前源码已经 Gate 5-R1–R5 重验，历史记录恢复有效。
> Stage 5 Provider 调用：本阶段前后增量固定为 0
> README：本阶段暂不处理

## 1. LiuWei 架构结论

Stage 5 唯一推荐范围是：**把 Stage 4E 当前采用的图片结果，经本地确定性 Preview 和用户二次确认，显式插入既有 Timeline，原子创建一个新的 Timeline Revision，并记录不可变装配事实。**

核心链路：

```text
confirmed image Requirement
  -> current Stage 4E Adoption
  -> local deterministic assembly Preview
  -> user explicit confirmation
  -> new TimelineDocument v1 Revision
  -> immutable Assembly fact
  -> existing Preview / Render / Export（由用户另行触发）
```

本阶段不调用 AI，不调用图片 Provider，不生成新媒体，不自动替换，不批量装配，也不改变 TimelineDocument v1、RenderPlan v1 或 Stage 1–4E 已冻结行为。

## 2. 当前能力与断点

### 2.1 已具备

- Stage 4C：已确认 Shot List Revision、顺序明确的 Requirement、目标时长和视觉需求；
- Stage 4D：真实图片生成、Task/Invocation、managed Asset 与 Provenance；
- Stage 4E：Requirement↔Request immutable link、append-only Adoption 和当前采用结果；
- Timeline v1：image clip、`insert_asset_clip`、0.5–30 秒图片时长、布局、锁定、Revision、CAS、Undo/Redo；
- Rendering：图片输入可进入既有 FFmpeg Render Plan；
- Desktop/Electron：Shot Requirement 工作台和 Timeline 编辑器均已有正式入口；
- Windows：Sidecar、safeStorage、NSIS 安装和离线恢复链路已验收。

### 2.2 当前断点

Stage 4E 的“采用”只表示 Requirement 当前选择了哪个生成结果，不表示该 Asset 已进入 Timeline。用户仍需脱离 Requirement 上下文手工查找 Asset、选择时长和插入位置，且缺少 Requirement/Adoption/Timeline Revision 之间的审计关系。

### 2.3 不得突破

- Adoption 不自动等于 Timeline 装配；
- 生成成功不自动触发装配；
- Prepare 不修改 Timeline；
- Apply 必须有显式确认并使用当前 Timeline Revision CAS；
- 不得绕过锁定 Clip，也不得通过插入间接移动锁定 Clip；
- 不修改已有 Timeline、Render、Preview、Export、Batch 或 Provider 契约。

## 3. 候选方向比较

### 3.1 候选 A：已采用图片的显式 Timeline 装配（唯一推荐）

**用户价值**

- 闭合“需求→生成→采用→进入成片工程”的最后一段主链；
- 用户在应用前可看到插入位置、时长、布局、时间线时长变化和受影响数量；
- 应用后仍可使用既有 Undo/Redo、Preview、Render 和 Export。

**与 Stage 4E 的边界**

- Stage 4E 只产生和切换 Adoption；Stage 5 只消费当前 Adoption；
- 不改 Stage 4E link/adoption 表、DTO、状态机或 Provider 行为；
- Stage 5 的装配事实独立追加，不能反写“已装配”到 Adoption 行。

**分层影响**

- Core：新增本地确定性装配服务，并复用 Timeline 的校验和 Revision 写入边界；
- SQLite：v16 新增 Preview 与 Assembly 两张表；
- Contracts：独立 `stage5-v1` DTO/guard；
- Desktop：在图片履约区域增加“装配到时间线”工作流；
- Electron：独立窄 IPC，不透传未知字段；
- Windows：只增加离线 UI/API 行为，不增加二进制或网络依赖。

**迁移与兼容**

- v15→v16 只追加空表，不回填历史 Adoption；
- TimelineDocument v1、RenderPlan v1、API 前缀和 Sidecar protocol 不变；
- 老项目和无 Adoption 项目行为不变。

**隐私、Provider 与安全**

- Provider 调用固定为 0，不读取 Provider 凭据；
- Preview/Assembly 只保存 ID、hash、枚举、计数和时间，不复制 Requirement 正文、Prompt、字幕或路径；
- 使用 current Adoption、current confirmed Shot Revision 和 current Timeline Revision 三重 CAS。

**真实验收成本与风险**

- 成本：中等；需验证 SQLite v16、Timeline 原子 Revision、锁定、Undo/Redo、真实本地 PNG Preview/Render、Windows 安装态升级；
- 主要风险：跨域事务、过期 Preview、间接移动锁定 Clip、重复应用；
- 可拆为 Gate 5-2 原型、Gate 5-3 生产实现、Gate 5-4 独立离线真实验收、Gate 5-5 收尾。

**结论**：推荐。用户价值直接、范围单一、网络与费用风险为零，并复用已经验证的 Timeline/Render 能力。

### 3.2 候选 B：真实 TTS Provider 与旁白 Requirement 履约（本阶段不推荐）

**用户价值**

- 将 Stage 4C narration Requirement 生成旁白音频，为生成式短片补齐声音资产。

**与 Stage 4E 的边界**

- 需要新 Provider Profile、音频 Request/Task/Invocation/Asset/Provenance 和 narration link/adoption；
- 不能复用图片输出校验、SSE 结构或图片尺寸契约。

**分层影响**

- Core：新增 TTS adapter、音频解码/探测、任务和重试；
- SQLite：至少增加 Provider 配置、请求快照、Invocation、Provenance、Requirement link/adoption；
- Contracts/Desktop/Electron：增加凭据、声音/语速/格式、试听和费用确认；
- Windows：增加真实网络、音频依赖和安装态设备/编码验收。

**迁移与兼容**

- 可只追加迁移，但表和状态机明显多于候选 A；
- 必须保持图片 Provider 和 Stage 4E 行为不变。

**隐私与 Provider**

- 旁白正文会外传，需要新的 egress 确认；
- 必须处理密钥、计费、限流、内容政策和 Provider 不确定协议。

**真实验收成本与风险**

- 成本：高；需要真实调用预算、中文发音/停顿/时长/采样率/声道验收；
- 风险：Provider 协议不明确、正文隐私、音质主观性和音画同步。

**结论**：不推荐放入 Stage 5。应在 Timeline 图片闭环稳定后作为独立阶段冻结，不能与候选 A 捆绑。

### 3.3 候选 C：角色、场景和风格资产库（本阶段不推荐）

**用户价值**

- 支持漫剧/短剧的跨镜头一致性和可复用视觉参考。

**与 Stage 4E 的边界**

- 需要独立聚合根、版本、标签、引用关系和可能的参考图外传；
- 不能把普通 managed Asset 或 Adoption 直接改造成可变资产库记录。

**分层影响**

- Core/SQLite：新资产集合、版本、引用完整性和删除策略；
- Contracts/Desktop：资产浏览、筛选、编辑和项目/全局作用域；
- Electron/Windows：缩略图缓存、磁盘配额与迁移验收；
- Provider：若仅做本地库可为 0，但真正一致性生成仍需参考图/编辑能力。

**迁移与兼容**

- 可采用独立表，但需要先冻结项目级还是全局级、不可变版本与垃圾回收；
- 不应修改现有 `assets.storage_mode` 或生成 Provenance。

**真实验收成本与风险**

- 成本：中高；需要大量 UI、版本与生命周期验收；
- 风险：在生成资产尚未进入 Timeline 主链前建设资产库，价值验证偏前置。

**结论**：不推荐作为当前 Stage 5；适合在装配闭环和参考图 Provider 能力明确后单独规划。

## 4. Stage 5 冻结范围

### 4.1 包含

1. 每次只处理一条当前 confirmed Revision 下的 image Requirement；
2. 只消费该 Requirement 的当前 Stage 4E Adoption；
3. 要求 adopted Asset 为同项目、managed、image、available，且 Provenance/Task/Link 链完整；
4. 要求项目已存在 Timeline；
5. 用户显式选择 `at_index`、图片时长和既有 `TimelineLayout`；
6. 本地确定性 Prepare，生成持久化、不可变、可重启读取的装配 Preview；
7. Preview 显示插入位置、目标时长、布局、Clip/Caption 位移数量、前后总时长和 hash；
8. 显式 Apply，原子创建 Timeline Revision 和不可变 Assembly 事实；
9. Apply 成功后可使用既有 Undo/Redo；
10. SQLite v16、`stage5-v1`、Desktop/Electron 窄接口和 Windows 离线验收；
11. Provider dispatch、费用和网络外传增量均为 0。

### 4.2 明确不包含

- TTS、视频或第二图片 Provider；
- 新图片生成、retry、cancel、Provider 配置或 Prompt 修改；
- 自动装配、自动采用、自动选择插入点或后台触发；
- 一键装配全部 Requirements、Batch 或多选；
- 替换现有 Clip、删除 Clip、覆盖素材或修改 Adoption；
- 创建新 Timeline；没有 Timeline 时必须先走既有创建流程；
- 修改或绕过锁定 Clip；
- 自动生成字幕、旁白、转场、Ken Burns、动画、BGM 或音频混合；
- 自动触发 Preview、Render、Export 或发布；
- TimelineDocument v2、RenderPlan v2 或新增 TimelinePatch operation；
- 角色/场景/风格资产库；
- 修改 Stage 1–4E 数据表、Provider adapter、图片协议或预算；
- README 更新。

## 5. 领域不变式

### 5.1 资格

Prepare 和 Apply 均必须重新验证：

- Project 为 active；
- Requirement 属于当前 `confirmed_revision_id`，且 `visual_kind='image'`；
- `expected_adoption_id` 是该 Requirement 最大 `adoption_ordinal` 对应的当前 Adoption；
- Adoption、Link、成功 Task、managed Asset 和 Provenance 链一致；
- Asset 为同项目 `image + managed + available`；
- Project 当前 Timeline Revision 等于请求的 `base_timeline_revision_id`；
- 不存在未处理的 Timeline Draft；
- `at_index` 在 `0..clip_count`；
- 插入不会导致任何 locked Clip 的时间位置变化。

任一条件不满足必须 fail closed，不得自动切换 Adoption、自动重算插入点或自动选择新 Timeline 基线。

### 5.2 图片时长

- Timeline v1 图片时长边界保持 `500_000..30_000_000` 微秒；
- 用户显式输入时必须位于该边界；
- 未显式输入且 Requirement `target_duration_us` 处于边界内时，使用 Requirement 值；
- Requirement 目标时长为空时使用明确展示的默认值 `3_000_000` 微秒；
- Requirement 目标时长超出 Timeline 图片边界时，不截断、不钳制，返回 `STAGE5_DURATION_CONFIRMATION_REQUIRED`，要求用户显式选择合法值。

### 5.3 插入与锁定

- Stage 5 仅执行一条等价于既有 `insert_asset_clip` 的本地操作；
- `at_index` 后的 Clip 会发生时间位移；若其中任一 Clip 被锁定，Prepare 和 Apply 都返回 `STAGE5_LOCKED_SHIFT`；
- 不改变已有 Clip ID、Asset、布局、音频、时长或锁定状态；
- 不修改已有 Caption 正文或相对绑定，只允许 Timeline 既有归一化逻辑平移受影响 Caption；
- Preview 必须报告 `shifted_clip_count`、`shifted_caption_count` 和 `locked_shift_count=0`。

### 5.4 Preview

- Preview 是本地确定性事实，不是媒体 Preview，也不是 Provider egress preview；
- Preview 持久化 IDs、hash、位置、枚举、时长、计数和过期时间，不保存完整 Timeline Document；
- `proposed_clip_id` 在 Prepare 时生成并冻结，使 Apply 可重算相同目标 Document hash；
- 有效期建议 15 分钟；过期只能重新 Prepare，不能延长或修改旧 Preview；
- 相同输入可复用尚未过期且未应用的 Preview；过期后允许新增 Preview；
- Prepare 只新增/复用 Preview，不创建 Timeline Revision 或 Assembly。

### 5.5 Apply 与幂等

- Apply 输入必须包含 `confirmed=true` 和 `proposed_document_sha256`；
- Apply 使用 `BEGIN IMMEDIATE`，事务内重验资格、过期时间、当前 Adoption、Timeline CAS、Draft、Asset availability 和锁定；
- Core 以冻结参数重算目标 Document，hash 不一致则拒绝；
- Timeline Revision 与 Assembly 必须在同一事务中提交或回滚；
- 同一 Preview 最多对应一个 Assembly；重复 Apply 返回既有结果，不能创建第二个 Revision；
- 如果当前 Timeline 已包含同 Requirement 历史 Assembly 的 Clip，返回 `STAGE5_ALREADY_ASSEMBLED`；用户先通过既有 Timeline 操作移除/撤销后，才可基于新 Preview 再次装配；
- Apply 不修改 Preview、Adoption、Requirement、Asset 或旧 Timeline Revision。

### 5.6 Undo/Redo

- Undo/Redo 继续移动项目 Timeline 指针，不删除 Assembly 审计事实；
- Assembly 只证明某次用户确认曾创建特定 Revision/Clip，不保存可变 `is_current`；
- 当前是否生效由当前 Timeline Document 是否包含 `proposed_clip_id` 派生；
- 分支后旧 Assembly 保留为历史，不自动重新应用。

## 6. SQLite v16 草案

### 6.1 迁移原则

- 新增独立 `database_v16.py`；
- v1–v15 SQL 文本与 checksum 不变；
- v15→v16 前沿用既有备份；
- 单事务追加，失败完整回滚；
- 不回填历史 Adoption 或 Timeline；
- `foreign_key_check` 与 `integrity_check` 必须通过；
- 旧 Core 打开 v16 按未知版本策略拒绝，回退必须恢复迁移前备份。

### 6.2 新表

```sql
CREATE TABLE shot_requirement_timeline_assembly_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  base_document_sha256 TEXT NOT NULL CHECK(base_document_sha256 GLOB 'sha256:*'),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  at_index INTEGER NOT NULL CHECK(at_index >= 0),
  duration_us INTEGER NOT NULL CHECK(duration_us BETWEEN 500000 AND 30000000),
  layout TEXT NOT NULL CHECK(layout IN ('blurred_background','crop_fill','fit')),
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  preview_sha256 TEXT NOT NULL CHECK(preview_sha256 GLOB 'sha256:*'),
  clip_count_before INTEGER NOT NULL CHECK(clip_count_before >= 0),
  shifted_clip_count INTEGER NOT NULL CHECK(shifted_clip_count >= 0),
  shifted_caption_count INTEGER NOT NULL CHECK(shifted_caption_count >= 0),
  duration_before_us INTEGER NOT NULL CHECK(duration_before_us >= 0),
  duration_after_us INTEGER NOT NULL CHECK(duration_after_us >= duration_before_us),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE shot_requirement_timeline_assemblies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  adoption_id TEXT NOT NULL REFERENCES shot_requirement_image_adoptions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  assembly_preview_id TEXT NOT NULL UNIQUE
    REFERENCES shot_requirement_timeline_assembly_previews(id),
  base_timeline_revision_id TEXT NOT NULL REFERENCES timeline_revisions(id),
  output_timeline_revision_id TEXT NOT NULL UNIQUE REFERENCES timeline_revisions(id),
  proposed_clip_id TEXT NOT NULL UNIQUE,
  proposed_document_sha256 TEXT NOT NULL CHECK(proposed_document_sha256 GLOB 'sha256:*'),
  created_at TEXT NOT NULL
);
```

正式 SQL 还必须包含：

- Requirement/Revision/Adoption/Asset/Timeline 的同项目关系校验触发器；
- Preview 和 Assembly 的 UPDATE/DELETE 禁止触发器；
- Requirement 历史、Timeline Revision 和当前生效查询索引；
- Assembly 插入时 Preview 字段逐项一致性校验。

不在数据库中存储完整 Timeline JSON 副本、Requirement 正文、Prompt、路径、URI、Provider 响应或异常。

## 7. API / DTO 契约草案

### 7.1 新 ID 与类型

- `ShotRequirementTimelineAssemblyPreviewId`
- `ShotRequirementTimelineAssemblyId`
- 复用 `TimelineRevisionId`、`TimelineClipId`、`TimelineLayout`、`AssetId` 和 Stage 4E Adoption ID。

### 7.2 API

```text
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies/prepare
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies
GET  /api/v1/shot-requirement-timeline-assembly-previews/{preview_id}
GET  /api/v1/shot-requirement-timeline-assemblies/{assembly_id}
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/timeline-assemblies
```

Prepare 输入：

```ts
interface ShotRequirementTimelineAssemblyPrepareInput {
  expected_adoption_id: ShotRequirementImageAdoptionId;
  base_timeline_revision_id: TimelineRevisionId;
  at_index: number;
  duration_us: number | null;
  layout: TimelineLayout;
}
```

Apply 输入：

```ts
interface ShotRequirementTimelineAssemblyApplyInput {
  assembly_preview_id: ShotRequirementTimelineAssemblyPreviewId;
  proposed_document_sha256: string;
  confirmed: true;
}
```

公开输出仅包括：

- 上述安全 ID 和 hash；
- `at_index`、`duration_us`、layout；
- Clip/Caption 数量与总时长变化；
- Asset 的安全摘要（ID、kind、availability、宽高、hash）；
- Preview 过期时间、Assembly 时间；
- 输出 Timeline Revision 的安全 summary。

Stage 5 Apply 响应不得返回完整 TimelineDocument、Caption/Transcript/Requirement 正文或路径。Renderer 如需刷新 Timeline，使用既有已冻结 Timeline API。

### 7.3 契约版本

- `CONTRACT_VERSION` 建议升级为 `stage5-v1`；
- `API_PREFIX=/api/v1` 不变；
- Sidecar `protocol_version=1` 不变；
- Stage 4E DTO 和 parser 不修改语义；Stage 5 放在独立 `stage5.ts`。

## 8. 稳定错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| `STAGE5_REQUIREMENT_NOT_ELIGIBLE` | 409 | Requirement 不是当前 confirmed image Requirement |
| `STAGE5_ADOPTION_CONFLICT` | 409 | expected Adoption 已不是当前 Adoption |
| `STAGE5_ASSET_UNAVAILABLE` | 409 | adopted Asset 不可用或链路不完整 |
| `STAGE5_TIMELINE_REQUIRED` | 409 | 项目尚无 Timeline |
| `STAGE5_TIMELINE_CONFLICT` | 409 | Timeline 基线已变化 |
| `STAGE5_TIMELINE_DRAFT_EXISTS` | 409 | 存在未处理 Draft |
| `STAGE5_POSITION_INVALID` | 422 | 插入位置越界 |
| `STAGE5_DURATION_INVALID` | 422 | 显式图片时长超界 |
| `STAGE5_DURATION_CONFIRMATION_REQUIRED` | 409 | Requirement 目标时长无法直接用于 Timeline |
| `STAGE5_LOCKED_SHIFT` | 409 | 装配会间接移动锁定 Clip |
| `STAGE5_PREVIEW_EXPIRED` | 409 | Preview 已过期 |
| `STAGE5_PREVIEW_MISMATCH` | 409 | Preview/hash/Requirement 不一致 |
| `STAGE5_ALREADY_ASSEMBLED` | 409 | 当前 Timeline 已包含该 Requirement 的装配 Clip |
| `STAGE5_ASSEMBLY_NOT_FOUND` | 404 | Preview 或 Assembly 不存在 |
| `STAGE5_CONFIRMATION_REQUIRED` | 422 | 未显式确认 Apply |

错误响应只含稳定 code 和安全 message，不返回原始异常。

## 9. Desktop / Electron / Windows

- 在 Stage 4E 图片履约区的当前 Adoption 下增加“装配到时间线”；
- 没有 Timeline、存在 Draft、Asset 不可用或 Requirement 非当前 confirmed 时禁用并解释；
- 用户选择插入点、时长和布局；不得自动替用户确认；
- Prepare 确认页展示安全变化摘要，并明确“不会调用 Provider，不会自动渲染或导出”；
- Apply 使用独立确认按钮；成功后展示 Revision/Clip 安全摘要和“前往时间线”；
- 不在 Stage 5 面板复制 Prompt、Requirement 正文或 Caption 正文；
- Electron 使用独立 `stage5-ipc.ts` 和显式白名单 parser；
- Windows/NSIS 必须覆盖 fresh、v15→v16、重启恢复、卸载保留数据库和全程零网络。

## 10. 隐私、安全与 Provider 边界

1. Provider dispatch 固定为 0；不得读取或解密 Provider 凭据；
2. 不创建 HTTP client，不允许任何 Stage 5 网络外传；
3. SQLite/DTO/Renderer 日志/公开证据不出现 Requirement、Prompt、字幕、转写正文；
4. 不出现媒体绝对路径、URI、Authorization、token、API key、Provider payload、SSE/base64 或原始异常；
5. Stage 5 只使用不透明 ID、hash、枚举、计数、尺寸和时间；
6. Prepare 与 Apply 都必须做授权、项目归属、CAS、锁定和 availability 复验；
7. 不接受 Renderer 提供的完整 Timeline Document 或任意 Patch；
8. Provider 费用增量为 0，Stage 4D/4E 历史预算不计入 Stage 5 新调用，因为 Stage 5 禁止调用。

## 11. 兼容性与迁移计划

- v16 新表为空时，Stage 1–4E 所有项目按原行为打开；
- 历史 Adoption 不自动创建 Preview 或 Assembly；
- 历史 Timeline Revision 不修改、不回写；
- 现有 Timeline Undo/Redo、Draft、Preview、Render、Export、Rendition、Reframe 和 Batch 契约不变；
- Stage 4E Adoption 可继续切换；切换后旧 Stage 5 Preview 失效，已创建的 Timeline Revision 不自动修改；
- generated Asset 后续 unavailable 时，历史 Revision 和 Assembly 保留，既有 Timeline/Asset 可用性规则负责阻止渲染；
- v16 不承诺旧二进制直接打开；回退使用迁移前数据库备份；
- 不修改 README。

## 12. 角色与互斥文件所有权

角色只定义职责、交付物和写入边界，不规定顺序、并行方式或是否使用 subagent。

### LiuWei（架构与集成）

- 冻结范围、跨域不变量、API/DTO/SQLite 边界和 Gate；
- 审核 Timeline/Adoption/Assembly 的事务一致性；
- 负责 Stage 5 文档和最终集成裁决；
- 不替代实现角色修改其专属文件。

### ZhangSan（Core / SQLite / Timeline 内部边界）

建议专属写入：

- `services/core/src/aivs_core/database_v16.py`
- `services/core/src/aivs_core/shot_requirement_timeline_assembly.py`
- 对 `database.py`、`app.py`、`state.py` 和 `timeline.py` 的最小集成；
- Stage 5 Core migration/unit/integration/prototype tests。

不得修改 Contracts、Desktop、Electron 或样式文件。不得扩张 Timeline 公共 schema 或 Provider adapter。

### YeJing（Contracts / Desktop / Electron / Windows）

建议专属写入：

- `packages/contracts/src/stage5.ts` 及导出/测试；
- Stage 5 Core client；
- `apps/desktop/electron/main/stage5-ipc.ts`、preload 窄接口；
- 独立 Stage 5 装配面板、样式、UI tests 和 Electron E2E；
- Windows/NSIS 离线验收脚本。

不得修改 Core 数据库、Timeline 领域实现或 Provider adapter。

### LiuKeAi（独立审查与验收）

- 只读审查范围、迁移、事务、隐私、打包和证据；
- 不用开发者自测替代独立验收；
- 发现问题后退回责任角色，不直接在验收步骤中修补实现。

共享热点由文件所有者集成；跨角色只通过冻结 DTO、API、错误码、hash 和事务后置条件对接。

## 13. LiuKeAi 独立验收清单

1. 基线为合入 Stage 4E 的主干，工作区变更可追溯；
2. v1–v15 checksum 不变，v15→v16 有备份且只追加预期表/索引/触发器；
3. fresh v16、升级 v16 的 FK/integrity/checksum 均通过；
4. Prepare Provider/Job/Request/Task/Invocation/Asset/Adoption/Timeline Revision 增量均为 0；
5. Prepare 只新增或复用安全 Preview；重启后可读取；
6. 过期 Preview、stale Adoption、stale Timeline、Draft 和 unavailable Asset 全部 fail closed；
7. 锁定 Clip 不发生直接或间接位移；
8. Apply 原子新增恰好一个 Timeline Revision 和一个 Assembly；
9. 同 Preview 重放不新增第二 Revision；
10. 并发 Apply 只有一个成功事实；
11. 新 Revision 只增加一个 image Clip，已有 Clip/Caption/锁定内容不被改写；
12. duration、layout、at_index 和目标 Document hash 与 Preview 一致；
13. Undo/Redo 可用，Assembly 历史不删除；
14. 使用真实本地可解码 PNG，经现有权威 Preview/Render 验证新 Revision 可消费；
15. Stage 1–4E 全量回归通过；
16. Contracts build、Desktop lint/typecheck/tests/build 通过；
17. 开发态和 NSIS 安装态 fresh、v15→v16、重启、卸载保留数据库通过；
18. 全程网络 fail-on-call，Provider dispatch 增量为 0；
19. SQLite、DTO、Renderer、日志和证据的敏感哨兵扫描为 0；
20. README 未修改。

## 14. Gate

### Gate 5-1：目标、范围与契约冻结（已通过）

- 完成现状盘点、三候选比较和唯一推荐；
- 冻结 v16、`stage5-v1`、事务、锁定、隐私和角色边界；
- 只允许文档变更，Provider 调用为 0；
- 用户已于 2026-08-20 接受第 16 节全部冻结建议，本 Gate 已通过。

### Gate 5-2：隔离原型（已通过）

- 已在临时 SQLite/内存 Document 验证 Preview 重算 hash、位置、时长、锁定、CAS、幂等和事务；
- 24 条实际执行规则矩阵匹配 24/24（100%）；最终独立报告 Prepare p95 为 15.636 ms，Apply p95 为 14.337 ms；
- Stage 5 的 9 项隔离原型测试通过，Core 全部 prototype 回归 25 项通过；SQLite integrity 为 `ok`、FK 违规为 0；
- 生产文件与 README 变更均为 0，Provider dispatch 增量、网络调用和隐私哨兵命中均为 0；
- 本 Gate 已通过；Gate 5-3 后续已获用户授权并完成。

### Gate 5-3：生产实现与开发验证（已完成）

- 已实现 SQLite v16 两张 append-only 表、约束触发器、迁移接入及对应迁移测试；
- 已实现 Core Prepare/Apply/Get/List 服务与五条正式 API，并通过事务、CAS、锁定、幂等、重启恢复和稳定错误映射测试；
- 已实现独立 `stage5-v1` Contracts、五个固定 Electron IPC/preload 方法和 Requirement-scoped Desktop 装配面板；
- 已完成开发验证：Stage 5 Core 相关组合 22 项通过，v16 兼容修正组合 17 项通过，Core 全量 `460 passed, 1 skipped`；Desktop 全量 `207 passed`；Contracts 与 Desktop typecheck/build 通过；Ruff 通过；
- 全量 Core 仅有 1 条 Starlette/httpx 弃用警告；测试成功退出后出现 pytest 清理 Windows 临时目录的 `PermissionError` 噪声，不属于业务测试失败；
- 隐私测试发现通用清敏边界不能删除旧 Timeline API 合法使用的 `document`，已新增仅用于 Stage 5 的窄清敏边界并验证 DTO/Renderer 不返回完整 Document、正文、路径或原始异常；
- Stage 5 Provider dispatch、网络调用和费用在本阶段前后增量均为 0；这不表示历史数据库中的 Provider 总调用数为 0；
- Gate 5-4 已完成真实本地 PNG、权威 FFmpeg Preview/Render、Windows/NSIS fresh 与 v15→v16 安装态验收；
- 当前未提交，README 未修改。

### Gate 5-4：独立离线真实验收（已通过）

- fresh v16 与 v15→v16 Core 真实验收通过，SQLite checksum、备份、FK、integrity 和历史事实保留符合契约；
- 真实本地 PNG 经显式装配后进入既有权威 Preview/Render，H.264/AAC、尺寸、像素格式、采样率、SHA-256 和 ffprobe 解码均通过；
- Prepare/Apply、原子 Revision/Assembly、重放幂等、Undo/Redo、重启恢复和单 image Clip 均通过；
- Electron 开发态 fresh、开发态 v15→v16、Windows/NSIS 安装态 fresh、安装态 v15→v16 四类 E2E 均通过；
- 当前源码 Sidecar/Desktop/NSIS 重建、正式 package verify、静默安装、静默卸载与两份数据库哈希不变均通过；
- LiuKeAi 验收期间未修改生产业务逻辑；发现的问题均确认为验收夹具或宿主环境问题；
- Stage 5 Provider dispatch、网络和费用增量为 0，README 未修改；
- 独立记录见 `docs/design/records/STAGE5_INDEPENDENT_ACCEPTANCE.md`。

### Gate 5-R5：Windows/NSIS 安装态恢复收口（已通过）

- 当前源码 PyInstaller Sidecar、Desktop、Electron Builder 与 NSIS 制品重建通过；
- installed_fresh 与 installed_upgrade_v15 Stage 5 E2E 均通过；
- 独立 Windows package verify 通过；
- 真实 NSIS 静默安装与静默卸载均 exit code 0；
- fresh 与 v15→v16 专用用户数据库卸载后均保留，且卸载前后 SHA-256 不变；
- Provider、网络外传与费用增量均为 0；
- 历史 Gate 5-3/5-4 记录恢复有效。
### Gate 5-5：收尾门禁

- 全量 Core/Contracts/Desktop/E2E/Windows 回归；
- 迁移、隐私、证据和文档收口；
- README 不处理；
- 版本控制、推送、PR/MR 和合并均按用户授权执行。

## 15. 变更控制

以下任一变化必须退回 Gate 5-1 重新确认：

- 引入 TTS、视频、第二图片 Provider或任何 Stage 5 网络调用；
- 自动装配、Batch、替换/删除既有 Clip；
- 创建 Timeline、自动 Preview/Render/Export；
- 修改 TimelineDocument/RenderPlan/TimelinePatch 公共 schema；
- 允许移动锁定 Clip或忽略 Timeline Draft；
- 将完整 Timeline、Requirement、Prompt、字幕、转写、路径或 Provider 内容写入 Stage 5 表/DTO/日志；
- 修改 v1–v15 migration/checksum；
- 反写或删除 Stage 4E Adoption；
- 把 Preview 与 Apply 合并为一次无确认操作；
- 修改 README。

## 16. 已确认冻结项

LiuWei 建议全部按以下默认值冻结：

1. 唯一范围选择候选 A；
2. 每次只装配一条当前 adopted image Requirement；
3. 只插入，不替换、不删除、不 Batch；
4. 项目必须已有 Timeline，且不得存在 Draft；
5. 用户显式选择插入位置、时长和布局；空目标时长默认 3 秒；
6. 超出 0.5–30 秒的 Requirement 目标时长必须人工重选，不自动钳制；
7. 插入导致任一 locked Clip 位移时拒绝；
8. Preview 持久化、不可变、15 分钟有效，不保存完整 Timeline；
9. Apply 使用 current Adoption + current confirmed Revision + current Timeline Revision CAS；
10. Timeline Revision 与 Assembly 同事务；同 Preview 重放幂等；
11. SQLite v16 两张独立表，Contracts `stage5-v1`；
12. Provider、网络和费用增量固定为 0；
13. Gate 5-4 使用真实本地 PNG 和既有 Preview/Render，但不调用 Provider；
14. README 暂不处理。



