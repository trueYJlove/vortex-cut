# Stage 4C 契约冻结：结构化镜头与资产需求清单

> 负责人：LiuWei（架构师）
> 状态：已确认冻结；Gate 4C-1 至 Gate 4C-4 均通过；Gate 4C-5 已授权，随本次 PR 合并主干后通过
> 日期：2026-08-18
> 基线：`27e5ab5 Merge pull request #2 from trueYJlove/codex/stage4b-simulation-workbench`
> 依据：`ARCHITECTURE.md`、Stage 1–4B 冻结文档

## 1. 架构结论

Stage 4C 推荐只建立**人工编排的结构化镜头与资产需求清单**，作为生成式素材的上游事实层：

```text
用户填写标题与镜头需求
  -> 保存不可变清单 Revision
  -> 审阅、复制为下一 Revision
  -> 用户确认当前 Revision
  -> 后续阶段按 Requirement 创建生成请求
```

首版继续固定：

- Provider 调用数为 `0`；
- 不自动生成脚本或分镜正文；
- 不调用真实图片、TTS 或视频 Provider；
- 不生成、不注册、不替换任何媒体 Asset；
- 不写 Timeline，不触发 Preview、Render、Export 或 Batch；
- 不修改 Stage 4A/4B 的 `simulation_only` Request/Task 行为；
- SQLite 采用独立追加迁移 **v12**，追加 Shot List、Revision 与 Shot Requirement 三张表；
- `CONTRACT_VERSION` 建议升级为 `stage4c-v1`，API 前缀与 Sidecar `protocol_version=1` 保持不变。

本阶段的核心价值不是“做一个文档编辑器”，而是形成可版本化、可确认、可被后续真实生成引用的结构化需求事实，避免 Provider 输出与创作意图、镜头顺序和来源溯源脱节。

## 2. 与总架构和既有阶段的关系

`ARCHITECTURE.md` 的生成式视频路径是：

```text
创作简报 -> 脚本和分镜 -> 镜头需求清单
-> 搜索已有素材或调用图片/视频/TTS Provider
-> 生成资产入库并记录溯源 -> 装配到 Timeline
```

当前项目已经具备：

- Stage 2：Brief、文本 Provider 安全外传、候选与 TimelinePatch；
- Stage 3：多平台渲染、批量导出、静态 3×3 reframe；
- Stage 4A：Image/TTS Request、Task、Job 与 SQLite v11 生产骨架；
- Stage 4B：正式模拟工作台、取消/重试/恢复和 Windows 真实交互。

当前缺口是“哪个镜头需要什么素材”的权威事实层。Stage 4C 不替代 Brief、CandidatePlan、TimelineRevision 或 MediaGenerationRequest：

- Brief 是项目级创作目标；
- CandidatePlan 是从既有素材召回的候选剪辑方案；
- TimelineRevision 是已装配的可渲染事实；
- MediaGenerationRequest 是一次具体生成输入的不可变事实；
- Stage 4C Shot List 是生成前、面向镜头的资产需求事实。

## 3. 候选方向评估

### 3.1 候选 A：单一真实图片 Provider 闭环

**用户价值**

用户可从 Prompt 真正生成图片并在工作台查看结果。

**技术影响**

- Core：Image Provider capability、网络下载、超时/取消、内容类型与尺寸校验、临时文件和原子落盘；
- SQLite：Provider 配置能力字段、egress preview/consent、ProviderInvocation 与媒体 provenance；
- Contracts/Desktop/Electron：新 Provider 配置、密钥、精确外传确认、费用、结果预览；
- Asset：必须新增内部生成媒体注册能力；当前公共 `import_asset` 只接受 Renderer 授权路径并注册 `external` Asset；
- Windows：证书、代理、防火墙、真实凭据、费用、内容政策和安装态下载取证。

**风险与成本**

高。图片生成协议并不存在类似 OpenAI-compatible text 的统一可靠契约；同步 base64、异步 URL、轮询任务、临时下载 URL和供应商审核状态差异很大。若同时解决 Provider、Asset 和 UI，会把多个高风险域捆绑为一阶段。

**结论**

不推荐作为 Stage 4C。可在后续以单一图片 Provider、单一输出、单一 Asset 注册闭环单独冻结。

### 3.2 候选 B：单一真实 TTS Provider 闭环

**用户价值**

用户可把文本转换为真实音频，为旁白工作流提供直接价值。

**技术影响**

- Core：TTS Provider、音频下载、FFprobe 校验、采样率/声道/时长规范化；
- SQLite：voice/model snapshot、ProviderInvocation、费用和输出 provenance；
- Contracts/Desktop：声音预设枚举、语言能力、精确外传确认、试听与结果处理；
- 安全：Prompt 本身就是完整旁白正文，Stage 4A/4B 的“不持久化 Prompt”与异步重试恢复存在直接冲突；
- Windows：音频设备并非生成必需但试听链路会扩大验收面。

**风险与成本**

高于表面认知。异步 Job 若重启后仍需重发正文，就必须重新冻结明文生命周期、恢复语义和付费幂等；若不持久化正文则无法自动恢复。声音授权、voice ID 稳定性和语言适配也是额外契约。

**结论**

不推荐作为 Stage 4C。应在文本持久化与外传策略单独冻结后实施。

### 3.3 候选 C：结构化镜头与资产需求清单（推荐）

**用户价值**

- 把创作目标拆成可审阅的镜头顺序和素材需求；
- 明确哪些镜头需要图片、配音或后续视频，哪些可使用已有素材；
- 为后续 Provider 请求、生成 Asset provenance、局部重生成和预算建立稳定引用点；
- 即使 Provider 尚未接入，用户也能完成规划、版本确认和需求交接。

**技术影响**

- Core：新增独立 `ShotRequirementService`，只做结构校验、Revision、确认和并发冲突检测；
- SQLite：v12 仅追加清单、Revision、Shot Requirement 三张表及不可变触发器；
- Contracts：新增独立 Shot List DTO/guards/API；
- Desktop：独立工作台，支持新建草稿、镜头排序、编辑、保存 Revision 与确认；
- Electron：新增窄 IPC/Preload，不扩展文件系统或网络权限；
- Windows：验证安装态持久化、升级、重启恢复和项目隔离，不需要真实网络与凭据。

**迁移与兼容**

v12 从 v11 追加空表，不改写历史行。Stage 1–4B 表及校验和保持不变。老项目默认没有清单；新客户端按空状态展示。旧 Core 遵循现有未知版本拒绝策略，回退必须恢复升级前备份。

**隐私与 Provider 边界**

清单正文属于用户主动保存的项目内容，可以持久化并在 Renderer 显示；但不得写入日志、遥测或验收证据。不得借此把正文发送给 Provider。对外 DTO 可返回正文给所属项目的 Renderer，但不得包含真实媒体绝对路径、Provider 凭据、请求载荷或原始异常。

**真实验收成本**

中等，可在不引入网络和媒体资产生命周期的情况下完成 Core/SQLite、Desktop、重启恢复和 Windows 安装升级验收。

**结论**

唯一推荐。

## 4. Stage 4C 冻结范围

### 4.1 包含

1. 每个项目一个 Shot List 聚合根；
2. 不可变 Shot List Revision；
3. 每个 Revision 包含 `1–24` 个有序 Shot Requirement；
4. 每个 Shot 恰好一个视觉需求：`existing_media | image`，并可选一个 `tts` 旁白需求；
5. Revision 保存、读取、历史列表和确认；
6. 基于 `base_revision_id` 的乐观并发控制；
7. 独立 Desktop 工作台；
8. SQLite v11→v12 迁移、重启恢复、Windows 安装升级与隐私取证。

`video` 不进入首版枚举。它在总架构中仍是后续能力，但不在 Stage 4C 中预占不成熟的参数和验收行为。

### 4.2 明确不包含

- 自动生成脚本、分镜或需求；
- 任何真实 Provider、能力探测、密钥、计费、配额或网络请求；
- 修改或复用 Stage 2 Provider 外传表；
- 从 Requirement 自动创建 Stage 4A/4B Request；
- 真实图片、TTS 或视频生成；
- 生成 Asset 注册、Asset 替换或 `assets.storage_mode` 扩展；
- Timeline 自动装配、TimelinePatch、Preview、Render、Export 或 Batch；
- 角色、场景、风格资产库；
- Prompt 模板库、多人协作、发布平台账号或 README 修改。

## 5. 领域契约

### 5.1 Shot List

每个项目最多一个聚合根：

```ts
interface ShotList {
  shot_list_id: ShotListId;
  project_id: ProjectId;
  current_revision_id: ShotListRevisionId | null;
  confirmed_revision_id: ShotListRevisionId | null;
  created_at: string;
  updated_at: string;
}
```

- 聚合根只维护当前指针和确认指针；
- 没有 Revision 时允许空状态；
- 确认不复制内容，只原子移动 `confirmed_revision_id`；
- 首版只允许确认当前 Revision；确认历史 Revision 必须先复制内容并保存为新的当前 Revision。
- 生命周期严格派生：`empty` 表示无 current；`confirmed` 表示 confirmed 与 current 相同；`drafted` 表示有 current 且 confirmed 为空或与 current 不同。确认后保存下一 Revision 时旧 confirmed 继续保留，状态为 `drafted`。

### 5.2 不可变 Revision

```ts
interface ShotListRevision {
  schema_version: 1;
  shot_list_revision_id: ShotListRevisionId;
  shot_list_id: ShotListId;
  project_id: ProjectId;
  parent_revision_id: ShotListRevisionId | null;
  title: string;
  summary: string;
  document_sha256: string;
  created_at: string;
}
```

- Revision 和所属 Requirement 均不可 UPDATE/DELETE；
- 每次保存完整快照，不做增量 Patch；
- `document_sha256` 对规范化后的标题、摘要和有序 Requirements 计算；
- 空白归一、长度限制和 Unicode 控制字符拒绝由 Core 执行；
- Renderer 计算的 hash 不具权威性。

### 5.3 Shot Requirement 与资产需求

```ts
interface ShotRequirement {
  shot_requirement_id: ShotRequirementId;
  shot_list_revision_id: ShotListRevisionId;
  ordinal: number;
  title: string;
  visual_direction: string;
  target_duration_us: number | null;
  visual: {
    requirement_kind: "existing_media" | "image";
    source_asset_id: AssetId | null;
  };
  narration: {
    requirement_kind: "tts";
    text: string;
  } | null;
}
```

不变式：

- `ordinal` 从 `0` 连续递增，单 Revision 内唯一；
- `title` 为 `1–120` 字符；
- `visual_direction` 为 `1–2000` 字符，描述画面与构图要求；
- `target_duration_us` 可空；非空时为 `100_000–600_000_000` 整数微秒；
- 每个 Shot 恰好一个 `visual`，kind 只能是 `existing_media | image`；
- `existing_media` 必须指定同项目且存在的 `source_asset_id`；`image` 的 `source_asset_id` 必须为空；
- 每个 Shot 最多一个 `narration`，其 kind 必须是 `tts`，`text` 为 `1–2000` 字符的人工旁白正文；
- 无旁白用 `narration=null` 表达；v12 直接把 visual/narration 字段冻结在不可变 Shot 行中，以数据库 CHECK 保证 `narration_kind` 与 `narration_text` 同空或同非空；
- v12 不预留 `generation_request_id`；未来从资产需求创建生成 Request 时，应以独立关联/溯源迁移冻结，避免当前阶段耦合 Stage 4A/4B。

## 6. 命令与 API 契约

建议新增独立 API：

```text
GET  /api/v1/projects/{project_id}/shot-list
GET  /api/v1/projects/{project_id}/shot-list/revisions?limit=&cursor=
GET  /api/v1/shot-list-revisions/{revision_id}
POST /api/v1/projects/{project_id}/shot-list/revisions
POST /api/v1/projects/{project_id}/shot-list/confirm
```

### 6.1 保存 Revision

请求：

```ts
interface ShotListRevisionCreateInput {
  schema_version: 1;
  base_revision_id: ShotListRevisionId | null;
  title: string;
  summary: string;
  requirements: ShotRequirementInput[];
}
```

规则：

- 首次保存必须传 `base_revision_id=null`；
- 非首次保存必须等于当前 Revision；
- 不匹配返回 `SHOT_LIST_CONFLICT`；
- 完全相同的 canonical document 可幂等返回当前 Revision，`reused=true`；
- 新内容创建新 Revision 并原子更新 current 指针；
- 保存 Revision 不自动确认。

### 6.2 确认 Revision

请求：

```ts
interface ShotListConfirmInput {
  revision_id: ShotListRevisionId;
  expected_current_revision_id: ShotListRevisionId;
}
```

规则：

- Revision 必须属于该项目 Shot List；
- `expected_current_revision_id` 必须仍是当前 Revision；
- 首版只允许确认当前 Revision，避免 UI 把旧版本误设为有效需求；
- 重复确认同一 Revision 幂等成功；
- 确认不触发 Provider、Request、Asset 或 Timeline 操作。

### 6.3 稳定错误码

建议新增：

```text
SHOT_LIST_NOT_FOUND
SHOT_LIST_REVISION_NOT_FOUND
SHOT_LIST_INVALID
SHOT_LIST_CONFLICT
SHOT_REQUIREMENT_INVALID
SHOT_REQUIREMENT_ASSET_NOT_FOUND
SHOT_REQUIREMENT_ASSET_PROJECT_MISMATCH
SHOT_LIST_CONFIRMATION_CONFLICT
```

错误响应只包含稳定 code、去敏中文摘要和 request ID；不包含原始异常、SQL、路径、正文、stack、stderr、command 或 traceback。

Electron IPC 只允许 `SHOT_LIST_NOT_FOUND`、`SHOT_LIST_REVISION_NOT_FOUND`、`SHOT_LIST_INVALID`、`SHOT_LIST_CONFLICT`、`SHOT_LIST_CONFIRMATION_CONFLICT` 五个固定码进入 Renderer；其他 Core 异常统一投影为 `Core request failed`。Requirement 细分错误仍由 Core 契约保留，但首版不直接透传到 Renderer。

## 7. SQLite v12 冻结建议

### 7.1 迁移原则

- 只追加 `V12_VERSION` 与 `V12_SQL`；
- v1–v11 SQL 文本和 checksum 不变；
- 迁移前沿用现有数据库备份；
- 整个 v12 在单事务中执行，失败回滚；
- 不回填历史项目，不修改既有表；
- 不增加兼容 helper，除非原型证明真实历史数据库需要；
- 老 Core 打开 v12 应按现有严格未知版本策略拒绝。

### 7.2 Gate 4C-2 后冻结表结构

```sql
CREATE TABLE shot_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  current_revision_id TEXT NULL,
  confirmed_revision_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, project_id),
  FOREIGN KEY(current_revision_id, id)
    REFERENCES shot_list_revisions(id, shot_list_id),
  FOREIGN KEY(confirmed_revision_id, id)
    REFERENCES shot_list_revisions(id, shot_list_id)
);

CREATE TABLE shot_list_revisions (
  id TEXT PRIMARY KEY,
  shot_list_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  parent_revision_id TEXT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  summary TEXT NOT NULL CHECK(length(summary) <= 4000),
  document_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(id, shot_list_id),
  UNIQUE(shot_list_id, document_sha256),
  FOREIGN KEY(shot_list_id, project_id)
    REFERENCES shot_lists(id, project_id),
  FOREIGN KEY(parent_revision_id, shot_list_id)
    REFERENCES shot_list_revisions(id, shot_list_id)
);

CREATE TABLE shot_requirements (
  id TEXT PRIMARY KEY,
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 23),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  visual_direction TEXT NOT NULL CHECK(length(visual_direction) BETWEEN 1 AND 2000),
  target_duration_us INTEGER NULL CHECK(
    target_duration_us IS NULL OR
    target_duration_us BETWEEN 100000 AND 600000000
  ),
  visual_kind TEXT NOT NULL CHECK(visual_kind IN ('existing_media','image')),
  visual_source_asset_id TEXT NULL REFERENCES assets(id),
  narration_kind TEXT NULL CHECK(narration_kind IS NULL OR narration_kind='tts'),
  narration_text TEXT NULL CHECK(
    narration_text IS NULL OR length(narration_text) BETWEEN 1 AND 2000
  ),
  CHECK(
    (visual_kind='existing_media' AND visual_source_asset_id IS NOT NULL) OR
    (visual_kind='image' AND visual_source_asset_id IS NULL)
  ),
  CHECK(
    (narration_kind IS NULL AND narration_text IS NULL) OR
    (narration_kind='tts' AND narration_text IS NOT NULL)
  ),
  UNIQUE(shot_list_revision_id, ordinal)
);

CREATE INDEX shot_list_revisions_by_list_created
  ON shot_list_revisions(shot_list_id, created_at DESC, id DESC);
CREATE INDEX shot_requirements_by_visual_asset
  ON shot_requirements(visual_source_asset_id);

CREATE TRIGGER shot_list_revisions_no_update
BEFORE UPDATE ON shot_list_revisions
BEGIN SELECT RAISE(ABORT, 'shot list revisions immutable'); END;
CREATE TRIGGER shot_list_revisions_no_delete
BEFORE DELETE ON shot_list_revisions
BEGIN SELECT RAISE(ABORT, 'shot list revisions immutable'); END;
CREATE TRIGGER shot_requirements_no_update
BEFORE UPDATE ON shot_requirements
BEGIN SELECT RAISE(ABORT, 'shot requirements immutable'); END;
CREATE TRIGGER shot_requirements_no_delete
BEFORE DELETE ON shot_requirements
BEGIN SELECT RAISE(ABORT, 'shot requirements immutable'); END;
CREATE TRIGGER shot_lists_identity_no_update
BEFORE UPDATE OF id, project_id, created_at ON shot_lists
BEGIN SELECT RAISE(ABORT, 'shot list identity immutable'); END;
CREATE TRIGGER shot_requirements_asset_owner
BEFORE INSERT ON shot_requirements
WHEN NEW.visual_kind='existing_media' AND NOT EXISTS (
  SELECT 1
  FROM assets a
  JOIN shot_list_revisions r ON r.id=NEW.shot_list_revision_id
  WHERE a.id=NEW.visual_source_asset_id AND a.project_id=r.project_id
)
BEGIN SELECT RAISE(ABORT, 'asset project mismatch'); END;
```

Gate 4C-2 已验证 SQLite 可以在 `shot_lists` 中声明指向后建 `shot_list_revisions` 的复合外键。生产 v12 冻结为：`(current_revision_id,id)` 与 `(confirmed_revision_id,id)` 引用 `(revision.id,revision.shot_list_id)`；Revision 的 `(shot_list_id,project_id)` 引用 Shot List 的 `(id,project_id)`；父 Revision 使用 `(parent_revision_id,shot_list_id)` 复合外键。不可变性与 existing_media 的同项目 Asset 归属使用触发器。两种指针方案均通过，但复合外键可由 `PRAGMA foreign_key_check` 审计，因此优先采用。

## 8. Contracts / Desktop / Electron 变更清单

### Contracts

新增：

- `ShotListId`、`ShotListRevisionId`、`ShotRequirementId`；
- `ShotVisualRequirementKind`、`ShotNarrationRequirementKind`；
- `ShotVisualRequirementInput/DTO`、`ShotNarrationRequirementInput/DTO`、`ShotRequirementInput/DTO`；
- `ShotListRevisionCreateInput/Response`；
- `ShotListRevisionSummary/Detail/Page`；
- `ShotListState`、`ShotListConfirmInput`；
- 全部精确 key guard 与 parser；
- `CONTRACT_VERSION = "stage4c-v1"`。

不得向 Stage 4A/4B DTO 追加可选字段。

### Core Client / IPC / Preload

新增与五个 API 一一对应的窄方法。所有输入和输出在 Renderer 边界做精确白名单校验；不提供通用 `invoke`、文件路径、网络 URL 或任意 JSON 透传能力。

### Desktop

新增独立 `ShotRequirementWorkbench`：

- 空状态与“创建需求清单”；
- 标题、摘要和 `1–24` 个 Shot；
- 上移/下移，禁止任意脚本或 HTML；
- 视觉需求选择 existing_media 时只显示视觉 Asset `display_name`，提交 Asset ID；旁白提供“无 / TTS 需求”，选择 TTS 后必须填写旁白正文；
- 保存新 Revision；
- 查看 Revision 历史与当前/已确认标识；
- 明确“不会调用 Provider、不会生成媒体、不会写入时间线”；
- 项目切换清空未保存表单并隔离迟到响应。

## 9. 隐私与安全冻结

1. Provider invocation 固定为 `0`；生产代码不得导入生成 Provider adapter；
2. 清单正文只保存在 SQLite 项目事实和当前 Renderer 内存；
3. 日志、Job、安装证据和测试报告不得包含标题、摘要或 creative direction 正文；
4. DTO 可向当前 Renderer 返回清单正文，这是本阶段明确的用户项目内容契约；
5. DTO、日志和证据不得包含 Asset 绝对路径、URI、字幕/转写正文、Provider token/API key/Authorization、请求载荷或原始异常；
6. E2E 默认关闭 trace、video 和 screenshot；若失败保留 DOM/截图，必须先进行正文 sentinel 扫描并在收尾前删除含正文证据；
7. 不新增外部网络依赖；Provider fail-on-call 计数必须为 0；
8. 测试使用合成正文和合成 Asset ID，不读取用户媒体或凭据。

## 10. 兼容性与迁移

- Stage 1–4B 行为不变；
- TimelineDocument v1、RenderPlan v1、Rendition Snapshot、Batch 和 reframe 契约不变；
- Stage 4A/4B Request/Task 的 `simulation_only` 和 retry lineage 不变；
- 新表为空时所有旧项目正常打开；
- 没有 Shot List 时 GET 返回明确空状态，不用 500 或伪造 Revision；
- v11→v12 安装升级必须保留所有项目、Provider、Timeline、Export 和 MediaGeneration 历史；
- v12 数据库不支持直接降级；回退应用须恢复迁移前备份；
- API 前缀 `/api/v1` 和 Sidecar `protocol_version=1` 不变；Contracts 版本单独升级反映公开 DTO 增量。

## 11. 角色与文件所有权

这里只定义职责和边界，不规定串行、并行或 subagent 拓扑。

### LiuWei（架构）

- 冻结范围、领域不变式、公开契约、迁移和 Gate；
- 裁决 Shot List 与 Brief/Candidate/Timeline/MediaGeneration 的边界；
- 所有范围扩展必须重新确认。

建议所有权：

```text
docs/design/STAGE4C_CONTRACT_FREEZE.md
docs/design/STAGE4C_DETAILED_DESIGN.md
```

### ZhangSan（Core / SQLite / Jobs）

- v12 迁移、领域服务、Core routes、并发控制和 Core tests；
- 不修改 Desktop/Electron；
- 不接 Provider、Job runner、Asset 注册或 Timeline。

建议所有权：

```text
services/core/src/aivs_core/database.py
services/core/src/aivs_core/shot_requirements.py
services/core/src/aivs_core/app.py
services/core/tests/**/test_stage4c_*.py
```

### YeJing（Contracts / Desktop / Electron）

- Contracts DTO/guards、Core Client、IPC/Preload、独立工作台和前端/E2E；
- 不修改 Core 数据库和领域服务；
- 不增加文件或网络权限。

建议所有权：

```text
packages/contracts/src/index.ts
packages/contracts/tests/**
apps/desktop/src/lib/core-client.ts
apps/desktop/electron/main/stage4c-ipc.ts
apps/desktop/electron/main/index.ts
apps/desktop/electron/preload/index.ts
apps/desktop/src/app/shot-requirements/**
apps/desktop/src/app/App.tsx
apps/desktop/src/styles.css
apps/desktop/tests/**stage4c**
apps/desktop/e2e/**stage4c**
```

交叉点只通过冻结 DTO、五个 API、稳定错误码和 v12 schema 对接。同一文件需要多人修改时由所有者集成，禁止并发写同一文件。

### LiuKeAi（独立审查）

- 只读复核范围、迁移、正文隐私、Windows 安装升级和回归证据；
- 不修补被验收实现；
- 不用开发者自测代替独立验收。

## 12. 门禁

### Gate 4C-1：契约确认

通过条件：

- 用户确认候选 C、`1–24` 个 Shot、visual/narration 组合、SQLite v12 和 `CONTRACT_VERSION=stage4c-v1`；
- 确认 Provider=0、无 Asset/Timeline、README 不处理；
- 两份文档冻结。

### Gate 4C-2：隔离原型

只允许原型验证：

- v12 建表、外键、不可变触发器和迁移性能；
- canonical hash、Revision 幂等、并发冲突和确认；
- 1–24 个 Shot、视觉/旁白组合边界、跨项目 Asset 拒绝；
- 正文 sentinel 不进入日志/证据；
- Provider invocation 仍为 0。

不得接入正式 UI 或真实 Provider。

### Gate 4C-3：生产实现与开发验证

- 正式 v12、Core API、Contracts、IPC/Preload 和工作台；
- 定向与全量回归通过；
- 不触发 Provider、Job、Asset 注册或 Timeline；
- 未经单独授权不得开始。

### Gate 4C-4：独立真实验收

- 开发态真实 Electron + Sidecar；
- 全新 Windows NSIS 构建、实际安装、v11→v12 原位升级、重启恢复和卸载；
- 空状态、保存、多 Revision、冲突、确认、项目切换和历史恢复；
- SQLite、日志、磁盘和失败证据正文隐私取证；
- Stage 1–4B 全量回归。

### Gate 4C-5：收尾（已授权；合并主干后通过）

- 独立验收通过；
- 文档与实现一致；
- 收尾、提交、推送、PR/MR 和合并已获授权；本次 PR 合并主干后通过；
- 真实 Provider、媒体生成、Asset 注册和 Timeline 集成仍标记 `UNVERIFIED`。

## 13. 变更控制

以下任一变化必须停止并重新确认：

- Provider 调用数从 0 变为非 0；
- 自动生成脚本、分镜或需求；
- 新增 `video`、角色/场景/风格资产管理或 Batch；
- 从 Requirement 自动创建生成 Request；
- 注册、替换 Asset 或写 Timeline；
- 修改 Stage 4A/4B Request/Task 语义；
- 修改 v1–v11 迁移文本或 checksum；
- 把正文写入日志、Job 或验收证据；
- 修改 README。

## 14. 已确认冻结事项

用户已于 2026-08-18 全部确认以下十项，Gate 4C-1 已通过：

1. Stage 4C 选择候选 C：结构化镜头与资产需求清单；
2. 首版完全人工编排，不调用文本 Provider；
3. 每个 Revision 为 `1–24` 个 Shot；
4. 每个 Shot 恰好一个 `existing_media | image` 视觉需求，并可选一个带人工正文的 `tts` 旁白需求；生成类型不含 `video`；
5. SQLite 升级到 v12，三张追加表；
6. `CONTRACT_VERSION` 升级到 `stage4c-v1`，API/Sidecar protocol 保持 v1；
7. 保存完整不可变 Revision，基于 `base_revision_id` 乐观并发；
8. 首版只允许确认当前 Revision；
9. Provider=0，不生成媒体、不注册 Asset、不写 Timeline；
10. README 暂不处理。
