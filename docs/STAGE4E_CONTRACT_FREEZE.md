# Stage 4E 契约冻结草案：图片 Requirement 履约与生成关联

> 负责人：LiuWei（架构师）
> 基线：`master` / `30dcb4e`
> 上游契约：Stage 4C `stage4c-v1`；Stage 4D 文档 `stage4d-v3`、API/DTO `stage4d-v2`
> 数据库目标：SQLite v15
> 建议 API/DTO 契约：`stage4e-v1`
> 状态：Gate 4E-1 至 Gate 4E-5 已通过；Stage 4E 已完成
> Provider 调用：Gate 4E-4 真实验收累计 10 次独立 fresh dispatch；Gate 4E-5 实际增量为 0
> README：本阶段暂不处理

## 1. 架构结论

Stage 4E 只补齐 Stage 4C 与 Stage 4D 之间的一条受控业务链：**用户从当前已确认的 Shot List Revision 选择一条 image Requirement，经独立 Prepare 与显式确认创建或复用 Stage 4D 图片生成 Request/Task，再以不可变关联记录该 Request 为此 Requirement 的一次履约来源；成功输出必须再次经用户显式采用，才成为该 Requirement 的当前采用 Asset。**

```text
当前已确认的 image Requirement
  -> 本地编辑生成指令
  -> Requirement-scoped Prepare（Provider=0）
  -> 审阅 Provider / 模型 / 1K / 价格 / 外传说明
  -> 显式 Create
  -> 原子建立 Requirement ↔ Request 关联
  -> Stage 4D Task 至多一次 dispatch
  -> 成功生成 managed Asset + Provenance
  -> 用户显式 Adopt
  -> 追加不可变 Adoption 事件
```

Stage 4E 不把“生成成功”自动等同于“已采用”，也不把“已采用”自动等同于“已装配到 Timeline”。

## 2. 当前缺口与既有边界

### 2.1 已具备

- Stage 4C / SQLite v12：不可变 Shot List Revision 与 `1–24` 条 Requirement；视觉类型支持 `existing_media | image`；Shot List 维护 current/confirmed Revision 指针。
- Stage 4D / SQLite v13–v14：固定 `apikey_fun_images / gpt-image-2` 的单图真实生成；Prompt vault；Request/Task/Invocation；managed PNG Asset；Generated Asset Provenance；受限预览；重启恢复和显式 retry lineage。
- Stage 4D 已证明 Provider 原生 PNG 尺寸在安全边界内可被接受，并已完成真实成功闭环。

### 2.2 尚缺

- Requirement 与 Generation Request 没有权威关联；
- 不能判断某个 Asset 是否履约了某条 Requirement；
- 同一 Requirement 的多次生成历史没有业务归属；
- 没有“当前采用哪一个成功结果”的并发安全事实；
- Stage 4C 已明确 v12 不预留 `generation_request_id`，要求后续通过独立关联迁移实现。

### 2.3 不得突破

- 不修改 v12 Requirement 的不可变结构和含义；
- 不修改 Stage 4D 公开图片生成 API、Request hash 或 retry 语义；Provider adapter 仅允许第 10.1 节冻结的证据驱动、防御性结构兼容，不接受其他协议扩张；
- 不自动写 Timeline，不触发 Preview、Render、Export 或 Batch；
- 不把通用 Stage 4D 历史图片自动回填为 Requirement 履约事实；
- 不因履约编排增加自动 retry 或后台批量 dispatch。

## 3. 候选方向

### 3.1 候选 A：给既有 Request/Requirement 直接追加外键

做法：在 `media_generation_requests` 或 `shot_requirements` 增加对方 ID，并直接更新关联或当前 Asset。

用户价值：结构直观，查询简单。

影响与风险：

- Core / SQLite：需要重建 v12 或 v13 表，改变既有不可变表；一条 Request 复用给多个 Requirement 时一对一外键失真；
- Contracts / Desktop：必须把 Requirement 身份塞进 Stage 4D 通用 DTO；
- Electron / Windows：实现量不大，但升级迁移风险高；
- 兼容性：容易改变 Stage 4C/4D hash、幂等和历史事实；
- 隐私：可能诱导把 Requirement 正文或 Prompt 写入新字段；
- 验收：必须重验 v12–v14 表重建和全部历史迁移。

结论：**不推荐**。与 Stage 4C 明确冻结的独立关联策略冲突，也破坏 Stage 4D 的通用图片生成边界。

### 3.2 候选 B：独立生成关联 + 追加式 Adoption Ledger

做法：SQLite v15 只追加两张表：

1. Requirement 与 Stage 4D Request 的不可变关联；
2. 成功 Task/Asset 的不可变 Adoption 事件。

当前采用结果按 Requirement 的最大 `adoption_ordinal` 派生；通过 `expected_current_adoption_id` 做 compare-and-swap。

用户价值：

- 能从镜头需求发起图片生成；
- 能看到该需求的生成/重试历史；
- 能在多个成功结果中明确选择当前采用项；
- 保留完整生成、重试、选择和切换历史。

影响：

- Core：新增薄编排服务，并对 Stage 4D 内部创建事务提供无外部副作用的绑定 hook；
- SQLite：v15 仅追加表、索引和触发器；
- Contracts：新增 fulfillment/link/adoption DTO，升级为 `stage4e-v1`；
- Desktop：在 Shot Requirement 工作台增加图片履约面板；
- Electron：增加独立 `stage4e-ipc.ts` 与窄 preload API；
- Windows：复用现有 Provider 凭据、任务、受限预览和包体能力。

兼容性：不回写 v12–v14，不回填历史；旧 Request 可在用户重新 Prepare/Create 且 hash 相同的情况下被安全复用并建立新关联。

结论：**唯一推荐**。范围适中，直接补齐 Stage 4C→4D 的架构断点，同时不进入 Timeline 或第二 Provider。

### 3.3 候选 C：生成成功后自动替换/装配 Timeline

做法：Requirement 生成成功或采用后自动创建 Timeline Revision，把图片插入镜头位置。

用户价值：端到端自动化更强。

影响与风险：

- Core：必须定义图片时长、轨道、位置、布局、缩放和与现有素材冲突的规则；
- SQLite / Contracts：引入 Requirement→TimelinePatch/Revision 关联；
- Desktop：需要装配预览、冲突解决、撤销和版本比较；
- Render / Export：必须重新验收权威 Preview、Render Plan 和导出；
- 风险：同时跨越生成、剪辑和渲染三个域，容易修改 Stage 1–3B 冻结行为。

结论：**不推荐作为 Stage 4E**。应在履约事实稳定后作为独立阶段重新冻结。

## 4. 唯一冻结范围

### 4.1 包含

1. 只处理当前 `confirmed_revision_id` 下 `visual_kind='image'` 的 Requirement；
2. 每次只处理一条 Requirement，不支持 Batch；
3. Renderer 可在本地用 `visual_direction` 预填生成指令，但用户可编辑，且不会因此产生外传；
4. Requirement-scoped Prepare：验证资格、配置、凭据与上下文，调用数为 0；
5. 显式 Create：要求 `confirmed=true`，绑定 Requirement context 与 Stage 4D prepared payload；
6. 在 Stage 4D Request/Task 创建或复用事务提交前，原子插入 Requirement↔Request link；
7. 复用 Stage 4D 的 Task 状态、cancel、显式 retry、Provider 调用、Asset/Provenance 与受限预览；
8. Requirement 履约历史和 adoption 历史查询；
9. 用户对成功 Task 输出执行显式 Adopt；
10. 采用切换采用追加事件，不更新/删除旧事件；
11. SQLite v15 仅追加迁移；
12. `CONTRACT_VERSION` 升级为 `stage4e-v1`，API 前缀和 Sidecar protocol 仍为 v1。

### 4.2 明确不包含

- TTS 或视频 Provider；
- 第二图片 Provider、2K、任意 endpoint/header/model/price；
- 参考图、局部编辑、图片变体或质量评分；
- 自动 Prompt 创作、脚本生成或正文改写；
- 一键履约全部 Requirements 或任何 Batch；
- 自动 retry、轮询触发的新 dispatch 或失败自动补发；
- 自动采用最新成功结果；
- Timeline 自动装配、替换、Patch、Preview、Render、Export；
- 角色、场景和风格资产库；
- 修改 Stage 4A/4B `simulation_only`；
- 除第 10.1 节冻结的唯一严格结构候选兼容外，修改 Stage 4D Provider adapter、图片安全边界或公开 API；
- README 更新。

## 5. 领域契约

### 5.1 Requirement 资格

Prepare 与 Create 均须重新验证：

- Project 存在且未归档；
- Requirement 存在并属于该 Project；
- Requirement 所属 Revision 等于 Shot List 当前 `confirmed_revision_id`；
- `visual_kind='image'` 且 `visual_source_asset_id IS NULL`；
- Revision、Requirement 和 Project 关系一致；
- Requirement 的规范化 hash 与 preview 中冻结值一致。

若确认指针在 Prepare 后变化，Create 必须以 `SHOT_REQUIREMENT_REVISION_STALE` 失败；不得创建/复用 Request，不得 dispatch。

### 5.2 Requirement hash

`requirement_sha256` 对以下规范化 JSON 计算：

```text
schema_version
shot_list_revision_id
shot_requirement_id
ordinal
title
visual_direction
target_duration_us
visual { requirement_kind, source_asset_id }
narration
```

采用 UTF-8、键排序、无多余空白并以 `sha256:` 前缀表示。Link 只保存该 hash，不重复保存 Requirement 正文。

### 5.3 Generation Link

每条 link 表示：用户曾明确授权某个 Stage 4D Request 作为某条 Requirement 的图片履约来源。

不变式：

- link 不等于成功；Task 状态仍是执行事实；
- 同一 Requirement + Request 最多一条 link；
- 同一 Request 可被多个 Requirement 显式关联；
- link 只能关联 `generation_kind='image'`、`execution_mode='provider_image_v1'`，且 `provider_image_request_profiles` 必须精确匹配 `apikey_fun_images / apikey_fun_images_sse_v1 / gpt-image-2 / protocol 1`；
- link 创建时 Requirement 必须属于当前 confirmed Revision；
- link 创建后不可 UPDATE/DELETE；
- Revision 后续被替换时，link 保留为历史，但不可再从旧 Revision 发起 Create 或 Adopt；`Create` 已提交的 queued/running Task 保留原显式授权，不自动取消，也不因 Revision 切换自动补发。

### 5.4 Adoption

Adoption 是用户对某个成功 Task 输出的显式业务选择，不是生成系统自动状态。

不变式：

- Task 必须属于该 Requirement 的一个已关联 Request；
- Task 必须 `status='succeeded'`；
- `task.output_asset_id` 必须等于 adoption asset；
- Adopt 当下 Asset 必须属于同一 Project，且为 `image / managed / available`；Adoption 写入后 Asset 若变为不可用，历史事件仍有效，state 改为 `adopted_unavailable`；
- `generated_asset_provenance` 必须同时匹配 Request、Task 和 Asset；
- Requirement Revision 在 Adopt 时仍须为当前 confirmed Revision；
- 每次切换写入新 adoption，`adoption_ordinal` 单调递增；
- 当前 adoption 为最大 ordinal；
- `expected_current_adoption_id` 不匹配时返回冲突，不覆盖其他窗口选择；
- 相同当前 link/task/asset 的重复命令返回 `reused=true`，不重复插入。

### 5.5 派生 lifecycle

不在数据库保存可变 lifecycle；查询时按以下优先级派生：

```text
adopted_unavailable 存在当前 adoption，但其 managed Asset 当前不可用
adopted             存在当前 adoption，且其 managed Asset 当前 available
review_required     无 adoption，但任一关联 Request 有 succeeded Task
in_progress         无成功结果，但任一关联 Task 为 queued/running/cancelling
no_usable_output    有 link，但没有成功或活动 Task
unstarted           没有 link
```

历史 Revision 查询额外返回 `currently_confirmed=false`，且所有写命令禁用。

## 6. Prepare / Create / Retry / Adopt

### 6.1 Prepare

输入：

```ts
interface ShotRequirementImageFulfillmentPrepareInput {
  expected_confirmed_revision_id: ShotListRevisionId;
  provider_config_id: ProviderConfigId;
  prompt: string;
  size: "1024x1024";
}
```

行为：

1. 校验 Requirement 资格与 expected Revision；
2. 调用 Stage 4D 内部 Prepare，仍为本地操作；
3. 在独立 TTL context vault 中用外层 preview ID 绑定 Requirement IDs/hash、内层 Stage 4D preview ID 与 payload hash；
4. 返回不含 Prompt 正文的 Prepared DTO；
5. 不写 SQLite，不创建 Job/Task/Request，不调用 Provider。

外层 `fulfillment_payload_sha256` 必须覆盖 Requirement context、expected Revision、Stage 4D payload hash 和 Provider 身份，防止跨 Requirement/Revision 替换。

### 6.2 Create

输入：

```ts
interface ShotRequirementImageFulfillmentCreateInput {
  preview_id: ShotRequirementImageFulfillmentPreviewId;
  payload_sha256: string;
  expected_confirmed_revision_id: ShotListRevisionId;
  confirmed: true;
}
```

行为：

1. reserve 外层 context；
2. 重新验证 Revision、Requirement、hash 和 payload；
3. 调用 Stage 4D 的内部事务共用路径；
4. 对 fresh 或 reused Request/Task，均在同一 `BEGIN IMMEDIATE` 事务内插入或复用 link；
5. link 插入失败则 fresh Request/Task/Invocation/Job 一并回滚；
6. 事务提交后才允许 worker 观察 queued Job；
7. 返回 request、task、link、`generation_reused` 与 `link_reused`。

Create 是一次显式 Provider dispatch 授权；若复用既有 Request/Task，不产生新的调用。实际调用仍由 Stage 4D Task 执行，且每个 Task 最多一次。

### 6.3 Retry 与 Cancel

- 不新增另一套 Task/retry 状态机；
- 复用 Stage 4D 已冻结的 cancel、retry-prepare 和 retry API；
- link 关联 Request，因此同 Request 下的新 lineage Task 自动出现在 Requirement 履约历史中；
- retry 仍要求用户重新输入与原请求 hash 一致的 Prompt，并再次显式确认；
- 自动 retry 保持为 0。

### 6.4 Adopt

输入：

```ts
interface ShotRequirementImageAdoptInput {
  generation_link_id: ShotRequirementImageGenerationLinkId;
  task_id: MediaGenerationTaskId;
  asset_id: AssetId;
  expected_current_adoption_id: ShotRequirementImageAdoptionId | null;
  confirmed: true;
}
```

Adopt 在单个 `BEGIN IMMEDIATE` 事务中执行资格、当前 adoption CAS、Task/Asset/Provenance 校验和 append。

## 7. SQLite v15

### 7.1 迁移原则

- v1–v14 SQL 与 checksum 保持逐字不变；
- v15 只追加表、索引和触发器；
- 不回填任何历史 Request、Asset 或 Requirement；
- 不保存 Prompt、Provider payload、响应、绝对路径或原始异常；
- 升级前沿用既有数据库备份机制；
- fresh、v14→v15、重启恢复、FK 与 integrity 必须真实验收。

### 7.2 表草案

```sql
CREATE TABLE shot_requirement_image_generation_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  request_id TEXT NOT NULL REFERENCES media_generation_requests(id),
  requirement_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(shot_requirement_id, request_id)
);

CREATE TABLE shot_requirement_image_adoptions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  shot_list_revision_id TEXT NOT NULL REFERENCES shot_list_revisions(id),
  shot_requirement_id TEXT NOT NULL REFERENCES shot_requirements(id),
  generation_link_id TEXT NOT NULL
    REFERENCES shot_requirement_image_generation_links(id),
  task_id TEXT NOT NULL REFERENCES media_generation_tasks(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  adoption_ordinal INTEGER NOT NULL CHECK(adoption_ordinal >= 1),
  previous_adoption_id TEXT NULL
    REFERENCES shot_requirement_image_adoptions(id),
  created_at TEXT NOT NULL,
  UNIQUE(shot_requirement_id, adoption_ordinal)
);
```

### 7.3 数据库约束

v15 触发器必须 fail-closed 校验：

- link 的 Project/Revision/Requirement 关系；
- link 创建时 Revision 为当前 confirmed Revision；
- link Request 为同 Project 的 `image/provider_image_v1`，且 Request Profile 精确为当前冻结的 `apikey_fun_images / apikey_fun_images_sse_v1 / gpt-image-2 / protocol 1`；
- link 与 adoption 均禁止 UPDATE/DELETE；
- adoption link 属于同一 Requirement；
- Task 属于 link Request 且 succeeded；
- Asset 等于 Task 输出，并属于同 Project 的 available managed image；
- Provenance 同时匹配 Request/Task/Asset；
- first adoption 的 ordinal=1 且 previous=null；
- 后续 adoption 的 previous 为当前最大 ordinal 事件，ordinal=previous+1。

应用层仍须在 `BEGIN IMMEDIATE` 内执行相同校验；数据库触发器是第二道防线。

## 8. API / DTO / IPC

### 8.1 Core API

```text
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/links
GET  /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adoptions
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/prepare
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/create
POST /api/v1/projects/{project_id}/shot-requirements/{requirement_id}/image-fulfillment/adopt
```

links/adoptions 使用 `limit=1–100` 和不透明 cursor。Task 详情、cancel/retry 与 Asset presentation 复用既有 Stage 4D API。

### 8.2 新 DTO

- `ShotRequirementImageFulfillmentPreparedPreview`
- `ShotRequirementImageGenerationLink`
- `ShotRequirementImageAdoption`
- `ShotRequirementImageFulfillmentState`
- `ShotRequirementImageFulfillmentCreateResponse`
- `ShotRequirementImageGenerationLinkPage`
- `ShotRequirementImageAdoptionPage`
- 对应 input、guard 与 parser

公开 DTO 只包含 IDs、hash、枚举、状态、价格、安全 Asset 摘要和时间；不包含 Requirement 正文副本、Prompt、payload、路径、URI、SSE/base64 或原始异常。

### 8.3 契约版本

```text
CONTRACT_VERSION = "stage4e-v1"
API prefix        = /api/v1
protocol_version  = 1
SQLite            = v15
```

Stage 4D DTO 结构与 parser 不变；Stage 4E 组合并复用其 request/task/result DTO。

### 8.4 IPC / preload

新增独立 `stage4e-ipc.ts`，只暴露上述六类窄操作。禁止通用 invoke、任意 URL、任意 Header、文件路径和 secret 进入 Renderer。

## 9. 稳定错误码

建议新增：

```text
SHOT_REQUIREMENT_IMAGE_INELIGIBLE
SHOT_REQUIREMENT_REVISION_STALE
SHOT_REQUIREMENT_FULFILLMENT_NOT_FOUND
SHOT_REQUIREMENT_FULFILLMENT_CONFIRMATION_INVALID
SHOT_REQUIREMENT_GENERATION_LINK_CONFLICT
SHOT_REQUIREMENT_ADOPTION_INVALID
SHOT_REQUIREMENT_ADOPTION_CONFLICT
```

Provider、Task、凭据和图片安全失败继续使用 Stage 4D 既有稳定错误。Electron 只透传白名单安全 code/message，未知异常投影为 `Core request failed`。

## 10. 隐私、安全与费用

1. Requirement 正文可按 Stage 4C 既有契约存在于 SQLite 与 Renderer，但 Stage 4E link/adoption DTO 不重复正文；
2. 生成 Prompt 明文只存在于 Renderer 当前表单、Stage 4D Prompt vault 和一次出站请求；
3. 允许 Renderer 本地复制 `visual_direction` 到表单，但只有用户点击 Prepare 并随后 Create 才形成外传授权；
4. Prepare、查询和 Adopt 的 Provider 调用数均为 0；
5. Create 对 fresh Task 最多授权一次 dispatch；reused Request/Task 不新增调用；
6. API key、Authorization、payload、SSE/base64、原始异常、真实绝对路径不得进入数据库、DTO、日志或证据；
7. Stage 4D 产品价格继续为 CNY 0.10 / 1K；独立真实验收硬停止线经用户授权调整为 USD 4；
7a. `size='1024x1024'` 是 Stage 4D 已冻结的 1K 请求意图，不是 Provider 实际输出必须精确等于 1024×1024 的验收条件；实际输出只沿用 Stage 4D 的 PNG、可解码、尺寸元数据一致和安全上限校验；
8. Gate 4E-4 已在逐次明确授权下完成 10 次相互隔离的 fresh dispatch；Gate 4E-4 通过后不得再调用 Provider，Gate 4E-5 增量必须为 0；
9. Gate 4E-4 完成后的保守累计为 USD 2.05 / USD 4.00；
10. 任何未知 dispatch 结果不得自动补发。

### 10.1 Provider SSE 防御性结构兼容

Gate 4E-4 的安全诊断从未记录真实事件名，只证明完整 SSE 中稳定存在一个且仅一个严格的 `data=[{b64_json:string}]` 图片候选。因此冻结以下最小兼容：

- 保留既有 `type='image_generation.completed'` 路径；
- 未知事件名只有在 payload 严格等于单元素 `data` 数组，且该元素含字符串 `b64_json` 时，才可作为候选；
- 零候选、多候选、URL-only、无效 base64 均失败；
- 候选仍必须通过单帧 PNG、大小、尺寸元数据、安全上限和 SHA-256 校验；
- 不记录或暴露事件名、响应正文、SSE、base64 或原始异常；
- 安全诊断只在进程内按 task identity 暂存、容量最多 64 条并一次性读取，不进入 SQLite、API、DTO、Renderer 或生产日志。

不得从安全计数推导 Provider 的具体事件名，也不得把 Provider Usage 成功替代本地 Asset 成功事实。该修订不改变公开 API/DTO、Request hash、retry、图片尺寸或失败语义。

## 11. Desktop / Electron / Windows

- 在 Shot Requirement 工作台的 image 卡片增加“图片履约”区域；
- 只允许当前 confirmed Revision 写入，历史 Revision 为只读；
- 创建区展示 Requirement 标题/视觉说明、可编辑 Prompt、Provider、1K、价格和外传提示；
- Prepare 后显示 hash、Provider/模型、价格、到期时间和确认按钮，不回显 Prompt；
- 历史区按 Link 展示 Request 和 Stage 4D Tasks；
- succeeded Task 可安全预览并显式采用；
- 当前 adoption 与历史 adoption 分开显示；
- retry/cancel 复用既有控件和语义；
- safeStorage、Provider 配置和凭据 UI 不复制实现；
- Windows/NSIS 验收须覆盖 fresh、v14→v15、离线恢复、卸载保留数据库；
- 安装态离线验收不得调用 Provider。

## 12. 兼容性与迁移

- 新数据库：按 v1→v15 顺序建立；
- v14 数据库：备份后只追加空 v15 表；
- 历史 Stage 4D Request/Task/Asset：不自动关联；
- 历史 Request 若在 Stage 4E 中通过相同 Prompt/config/size 发生 Stage 4D 幂等复用，可在用户显式确认后建立 link；
- 历史 Stage 4C Revision：可查看；只有当前 confirmed Revision 可写；
- confirmed Revision 切换：旧 links/adoptions 保留且只读，新 Revision 不继承 adoption；
- Stage 1–4D 的 Preview、Render、Export、Batch、Timeline、simulation 和 Provider 行为不变；
- v15 是前向迁移；旧二进制不承诺打开已升级数据库。

## 13. 角色与文件所有权

角色定义只描述职责和互斥写入边界，不约束顺序、并行方式或是否使用 subagent。

### LiuWei（架构）

- 范围、领域不变式、API/DTO、隐私/费用边界、Gate 与变更控制；
- 所有者：`docs/STAGE4E_CONTRACT_FREEZE.md`、`docs/STAGE4E_DETAILED_DESIGN.md`；
- 负责跨域集成审查，不替代实现角色的文件所有权。

### ZhangSan（Core / SQLite / Jobs）

建议独占写入：

- `services/core/src/aivs_core/shot_requirement_image_fulfillment.py`；
- `services/core/src/aivs_core/database_v15.py`；
- `services/core/src/aivs_core/database.py`；
- `services/core/src/aivs_core/provider_image_generation.py` 的内部事务 hook；
- `services/core/src/aivs_core/app.py`、`bootstrap.py` 的 Core wiring；
- Stage 4E Core migration/unit/integration tests。

不得修改 Stage 4D Provider adapter 协议、安全尺寸和公开行为。

### YeJing（Contracts / Desktop / Electron / Windows）

建议独占写入：

- `packages/contracts/src/index.ts`；
- `apps/desktop/src/app/shot-requirements/` 下 Stage 4E UI；
- `apps/desktop/electron/main/stage4e-ipc.ts`；
- preload、Core client、App/styles 的 Stage 4E 接线；
- Desktop/IPC/E2E 测试与 Windows 验收脚本。

不得在 Renderer 暴露 Prompt 历史、secret、路径或原始异常。

### LiuKeAi（独立验收）

- 不参与生产实现；
- 独立复核范围冲突、迁移、幂等、CAS、零隐式调用、隐私、重启恢复和 Windows 制品；
- 独立验收文档建议为 `docs/STAGE4E_INDEPENDENT_ACCEPTANCE.md`；
- 若发现阻塞缺陷，门禁失败，不修改事实以迎合预期。

## 14. LiuKeAi 独立验收清单

1. v1–v14 checksum 不变；fresh 与 v14→v15 通过；
2. v15 FK、trigger、`foreign_key_check`、`integrity_check` 通过；
3. 非 confirmed Revision、非 image Requirement、跨 Project 均 fail-closed；
4. Prepare 写库增量、Job/Task/Request 增量与 Provider 调用均为 0；
5. Create 发生 Revision race 时所有生成与 link 增量为 0；
6. fresh Create 的 Request/Task/Invocation/Job/link 原子提交；
7. link 写入失败时不留下 fresh queued Job，不发生 Provider 调用；
8. 同 Requirement+Request 幂等复用，不重复 link；
9. 同 Request 可经独立确认关联多个 Requirement；
10. retry lineage 仍属于相同 link Request，自动 retry=0；
11. 失败 Task 不可 Adopt；跨 Request/Project Asset 不可 Adopt；历史非当前 Provider Profile 的 Request 不可 link；
12. succeeded Task/Asset/Provenance 一致时可 Adopt；
13. 两窗口 stale `expected_current_adoption_id` 返回冲突；
14. 切换 adoption 追加事件，旧事件不可变；已采用 Asset 变为不可用时 state 安全降级且历史不丢失；
15. Revision 切换后旧历史只读且不继承到新 Revision；
16. Timeline/Preview/Render/Export/Batch delta 均为 0；
17. DTO/IPC/日志/证据无 key、Prompt、Requirement 正文副本、payload、路径、base64、traceback；
18. 重启恢复不新增 Provider 调用；
19. Windows/NSIS fresh、v14→v15、重启、卸载与数据库保留通过；
20. 全量 Core/Contracts/Desktop 回归通过。

## 15. Gate

### Gate 4E-1：范围与契约冻结（已通过）

- 完成现状盘点、三候选比较、唯一推荐、v15/API/DTO/状态机与角色边界；
- 用户确认第 17 节事项后通过；
- Provider 调用必须为 0；
- 不编码生产功能、不提交。

### Gate 4E-2：隔离原型（已通过）

- 验证 v15 FK/trigger、原子 link、幂等复用、adoption CAS 和 Renderer 状态模型；
- 不修改用户数据库，不接真实 Provider；
- Provider 调用必须为 0。

### Gate 4E-3：生产实现与离线验证（已通过）

- 实现 Core/SQLite/Contracts/Desktop/Electron；
- 完成定向与全量回归、离线 Electron；
- Provider 网络关闭，调用必须为 0。

### Gate 4E-4：独立真实验收（已通过）

- 各轮均另获用户明确授权，并使用全新隔离目录、confirmed image Requirement 与 fresh Task；
- R10 以单次 dispatch、零 retry 闭合 Requirement→Request→Task→Invocation→managed Asset/Provenance→immutable link→append-only Adoption；
- SQLite v15、FK/integrity、Timeline 0、隐私隔离与零网络重启恢复通过；
- 保守累计 USD 2.05 / USD 4.00；完整记录见 `docs/STAGE4E_INDEPENDENT_ACCEPTANCE.md`。

### Gate 4E-5：收尾门禁（已通过）

- Core 全量 `444 passed / 1 skipped / 1 warning`，Ruff 与 compileall 通过；
- Contracts build、Desktop lint/typecheck、`26 files / 194 tests` 与 production build 通过；
- Stage 4E 开发态 fresh、开发态 v14→v15、安装态 fresh、安装态 v14→v15 四个离线 Electron 场景均通过；
- Prepare 零 Request/Task/Invocation/Link/Adoption/Timeline 副作用，Provider dispatch 增量为 0；
- 当前源码 Windows x64/NSIS 构建与包体校验、静默安装、重启、静默卸载通过；
- v14→v15 migration checksum、备份、历史事实保留、FK 与 integrity 通过；
- fresh 与升级数据库在卸载后均保留且 SHA-256 不变；
- 12 个公开安全 JSON、桌面日志与 Stage 4E 文档的 10 类隐私检查命中 0；
- 当前保守累计仍为 USD 2.05 / USD 4.00，README 未修改；
- Stage 4E 已完成；本冻结文档随 Stage 4E 完成变更集收口。

## 16. 变更控制
以下任一变化必须退回契约 Gate：

- TTS、视频或第二图片 Provider；
- 2K、参考图、编辑、Batch 或自动 Prompt；
- 自动 dispatch、自动 retry 或自动 adoption；
- Timeline 装配、替换、Preview/Render/Export；
- 修改 v1–v14 migration/checksum；
- 向 Stage 4C Requirement 或 Stage 4D Request 追加可变关联字段；
- 超出第 10.1 节唯一严格结构候选的 Provider 协议扩张，或放宽 Prompt、路径、正文、响应、SSE/base64、事件名或原始异常隐私边界；
- 允许旧 Revision 写入；
- adoption 不使用追加事实或取消 CAS。

## 17. 已确认冻结项

以下事项已由用户全部确认，并作为 Stage 4E 冻结边界：

1. 唯一范围为“图片 Requirement 履约与生成关联”；
2. 选择候选 B：独立 immutable link + append-only adoption ledger；
3. 仅当前 confirmed Revision 的 image Requirement 可写；
4. 每次一条 Requirement，不支持 Batch；
5. Stage 4D Request 可被多个 Requirement 经独立确认复用；
6. 生成成功不自动采用，采用不自动写 Timeline；
7. SQLite v15 只追加两张事实表，不回填历史；
8. `CONTRACT_VERSION=stage4e-v1`，Stage 4D DTO/Provider 契约不变；
9. retry/cancel 复用 Stage 4D，不新增状态机；
10. 当前采用结果由最大 adoption ordinal 派生，并使用 CAS；
11. Gate 4E-1 至 4E-3 Provider 调用均为 0；Gate 4E-4 另行授权；
12. README 暂不处理；
13. link 只接受当前冻结的 `apikey_fun_images / apikey_fun_images_sse_v1 / gpt-image-2 / protocol 1` Profile；
14. 已采用 Asset 后续不可用时派生为 `adopted_unavailable`，历史 adoption 不删除；
15. Create 已提交后若 confirmed Revision 切换，已授权 Task 不自动取消或补发，但旧 Revision 结果不可 Adopt。






