# 阶段 2B 契约冻结：锁定、自然语言修改与版本比较

> 角色：LiuWei（架构师）  
> 状态：冻结，供 ZhangSan、YeJing 与 LiuKeAi 共同执行  
> 日期：2026-08-12  
> 基线：`2dcd4c9 feat(stage2a): 完成AI候选粗剪规划闭环`  
> 依据：`ARCHITECTURE.md`、阶段 1C 契约、阶段 2A 契约与详细设计

## 1. 已确认决策

1. 2B 只交付 Timeline Clip 锁定、自然语言 TimelinePatch 提案、正式版本差异和显式确认应用。
2. AI 不能直接修改正式 Timeline。Provider 输出必须先成为不可变 Patch 提案，经 Core 校验、
   规范化和差异计算后，用户显式确认才可创建新的不可变 Timeline Revision。
3. 自然语言修改继续使用 2A 的 OpenAI-compatible 文本 Provider、Electron safeStorage、Core
   内存 SecretVault 和逐次精确 Egress 确认；每次确认只授权一次请求，不允许隐藏重试或回退。
4. TimelineDocument、TimelinePatch 和 RenderPlan 的 `schema_version` 均保持 1；Contracts 版本升为
   `stage2b-v1`，API 前缀和 Sidecar protocol_version 保持 1。
5. Clip 锁定是内容锁，不是绝对时间位置锁。锁定 Clip 的素材引用、源范围、时长、布局、音频、
   自身顺序操作和关联 Caption 不得被直接修改；编辑其前方的未锁定内容可导致其绝对时间平移，
   差异必须明确展示该间接位移。
6. 局部预览重算仍属于 2C。2B 中任何正式 Revision 变化继续使旧权威预览整体 stale。
7. 用户已批准将 2A 的真实外部 Provider 和真实 Windows 安装包 ASR 全链路补验延后到 2B
   开发完成后合并执行；补验完成前两项始终标记“未验证”。

本文是 2B 的唯一需求来源。实现期间如需改变 DTO、锁定语义、AI 可用操作、外传字段、错误码、
迁移、确认应用或验收要求，必须先由 LiuWei 组织变更确认。

## 2. 范围

- Clip 级锁定、解锁及锁定约束校验。
- 基于当前正式 Revision 的路径无关只读 Timeline 摘要。
- 自然语言修改的精确 EgressPreview、逐次确认和可取消 Job。
- Provider 严格结构化 TimelinePatch 提案。
- Core 对提案的引用、范围、锁定、基线、时间线和安全校验。
- 不可变 TimelinePatchProposal v1 及 ProviderInvocation 审计。
- 任意两个同项目正式 Revision 的确定性差异。
- 提案基线与哈希一致时的显式确认应用。
- Desktop 锁定控件、外传确认、提案差异、应用/放弃和版本比较界面。
- SQLite v5 迁移、Contracts、Core、Desktop、Electron E2E、打包与安全回归。

## 3. 非目标

- 局部 Render Plan、局部权威预览或缓存依赖图重算。
- AI 自动应用、后台应用、批量应用、定时应用或无确认应用。
- AI 插入新素材、转录选段、Caption、BGM、旁白、转场、特效或标题卡。
- AI 创建、解除或绕过锁定。
- 视觉模型、媒体上传、完整转录外传、网络检索或 Provider/模型回退。
- Track 级锁定、多种锁定模式、绝对时间位置锁或协作锁。
- 三方合并、分支合并、任意历史 Revision 恢复为当前版本的新接口。
- 修改 CandidatePlan v1、候选 adopt 语义、RenderPlan v1 或 Stage 1 导出规格。

## 4. 兼容性与安全不变量

- `CONTRACT_VERSION` 从 `stage2a-v1` 升至 `stage2b-v1`。
- `TimelineDocument.schema_version` 保持 1，新增可选 `locked_elements`。历史文档缺失时语义为 `[]`，
  不重写历史 `document_json`，不改变历史 `document_sha256`。
- 新 Revision 必须规范化写入 `locked_elements`，按 Clip 当前顺序排列且不得重复或引用不存在的 ID。
- `TimelinePatch.schema_version` 保持 1，新增 `set_clip_locked` 操作。旧操作字段和语义不变。
- `tracks[].locked` 继续保留且固定为 `false`，2B 不复用该字段表达 Clip 锁定。
- Render Plan 编译忽略 `locked_elements`；锁定元数据不得进入 FFmpeg argv、filter graph 或输出内容。
- CandidatePlan v1 仍不是 Timeline Revision；2A adopt 创建的新 Revision 默认无锁定元素。
- Provider 不持有项目状态，只接收本次调用所需的路径无关 DTO。
- Renderer 不得获得 API Key、Authorization、绝对路径、文件 URI、数据库位置、管理令牌或 Provider
  原始响应。
- SQLite、日志、Job/Event DTO、崩溃证据和验收报告不得包含 API Key、Authorization、完整组合
  Prompt、Provider 原始响应或 Egress 正文。
- EgressPreview 公开 DTO 只返回 Provider 目标、字段类别、数量、字符/Token 统计、hash 和有效期，
  不返回用户指令、Caption 正文、Timeline 摘要、Provider HTTP 请求体、system message 或组合 Prompt。
  用户本地输入的指令由 Desktop 自身显示，不由 Core 回显。待发送 payload 只可存在于 15 分钟
  Core 进程内存中。
- 未经当前精确 EgressPreview 确认，不得向 Provider 发送用户指令或 Timeline 内容。
- Provider 输出不得直接写数据库、Timeline、Render Plan、FFmpeg 参数或系统命令。

## 5. Timeline 锁定契约

`TimelineDocument v1` 兼容增加：

```ts
locked_elements?: TimelineClipId[];
```

`TimelinePatchOperation v1` 兼容增加：

```ts
{ op: "set_clip_locked"; clip_id: TimelineClipId; locked: boolean }
```

规则：

1. 锁定目标必须是当前文档中的 V1 Clip。
2. 对已锁定 Clip，禁止 `remove_clip`、`move_clip`、`trim_clip`、`split_clip`、`set_layout`、
   `set_audio` 和 `set_image_duration`。
3. 对 `source_clip_id` 指向已锁定 Clip 的 Caption，禁止删除、修改文本、修改时间或修改预设。
4. `set_clip_locked` 是唯一可直接作用于已锁定 Clip 的操作；同一原子 Patch 中先解锁后编辑合法，
   先编辑后解锁失败并整体回滚。
5. AI 提案禁止包含 `set_clip_locked`，因此不能用同一提案解除锁定后继续修改。
6. 编辑其他 Clip 导致锁定 Clip 的 `timeline_start_us/timeline_end_us` 等量平移不视为直接修改，
   但 TimelineDiff 必须列入 `indirect_locked_timing_shifts`。
7. 删除或拆分 Clip 时必须清理已经失效的锁定 ID；禁止留下悬空引用。

## 6. 自然语言修改与外传

2B 新增 ProviderCapability：`timeline_patch_planning`。

准备请求至少包含：`base_revision_id`、`provider_config_id` 和 `instruction`。Core 在一致性读中生成
精确 EgressPreview，Provider 可见内容仅限：

- 用户本次自然语言指令。
- Project ID 的调用内不透明别名，不发送项目名称。
- 当前 Timeline 的 Clip/Caption 不透明 ID、顺序、种类、源时间范围、时间线范围、布局、音频状态、
  Caption 文本与预设。
- `locked_elements` 及允许的 Patch 操作名称。
- Canvas 尺寸、目标总时长和 Prompt/输出 Schema 版本。

禁止发送：绝对路径、文件 URI、素材显示名、fingerprint、媒体、代理、缩略图、波形、完整
Transcript DTO、未进入当前 Timeline 的转录正文、Word 明细、数据库字段、令牌、密钥和历史
Provider 响应。

EgressPreview 必须展示 Provider 名称、HTTPS origin、模型、Prompt 模板版本、发送字段类别、Clip/
Caption/锁定项数量、字符数、估算 Token、可选费用上限提示、payload SHA-256 和 15 分钟有效期。
Core 返回的确认 DTO 不得包含 instruction、Caption 正文、Timeline 内容、实际 HTTP body、system
message 或组合 Prompt。Desktop 可以显示用户当前本地输入的 instruction，但不得将它写入日志、
诊断、测试报告或持久化状态。

待发送 payload 由 Core 的进程内 PendingEgressStore 保存，键为 preview ID，最长 15 分钟。SQLite
只保存 preview ID、Project/Provider/base Revision、快照 hash、payload hash、统计、过期
时间和创建时间，不保存用户指令、Caption 正文、Timeline 摘要或任何 Egress payload。Core 重启后
尚未消费的预览统一失效，用户必须重新 prepare 和确认。

以下任一变化使预览失效：Provider 配置或凭据状态、Timeline Revision/hash、锁定集合、payload hash，
或 PendingEgressStore 中不存在对应 payload。
一次确认只授权一次 HTTP 请求；连接测试因不发送项目数据，不使用本确认流程。

## 7. Provider 输出和 AI 可用操作

### 7.1 兼容性修订：受认证的 Provider 适配器

`TimelinePatch v1` 仍是唯一正式领域对象；锁定校验、原子重放、Proposal、Diff 和显式 Apply
语义全部不变。完整 JSON Schema Structured Outputs 是可靠性增强能力，不是 2B AI 修改的
准入门槛。2B 默认广兼容基线是标准 OpenAI Responses API 的普通文本输出；旧式 Chat
Completions 普通文本是次级兼容路径。Provider、模型、用户或响应均不得自行选择适配器。

ProviderConfig 为 `timeline_patch_planning` 保存显式测试得到的能力状态和已认证适配器 ID。
代码白名单及固定探测顺序如下；每个候选至多一次无业务请求，首个完整通过者停止探测：

| 顺序 | adapter ID | API 与输出 | 定位 |
| --- | --- | --- | --- |
| 1 | `openai_responses_json_schema_v1` | `POST /responses` + 完整 `text.format` JSON Schema | Responses 高可靠增强通道 |
| 2 | `openai_responses_patchscript_v1` | `POST /responses` + 普通文本 `AIVS-PATCH/1` | 默认广兼容通道 |
| 3 | `openai_chat_completions_json_schema_v1` | `POST /chat/completions` + 完整 `response_format.json_schema` | 旧式高可靠通道，保留现有 v6 语义 |
| 4 | `openai_chat_completions_patchscript_v1` | `POST /chat/completions` + 普通文本 `AIVS-PATCH/1` | 旧式广兼容通道 |

`/responses` 支持不等同于 Structured Outputs 支持。Responses PatchScript 适配器必须以标准
Responses 请求/响应语义构造：请求固定为 `POST {base_url}/responses`，包含已冻结的 `model`、固定
`instructions` 和单一文本 `input`，普通文本路径不得携带 `text.format`、`response_format`、tools 或
Provider 私有字段；响应必须有且仅有一个 `output` message，其 `content` 必须有且仅有一个
`{ type: "output_text", text: string }` 项，文本是唯一可交给 PatchScript parser 的值。Responses
Structured 路径使用同一标准信封，并额外固定 `text.format` 为完整 JSON Schema。Chat 适配器必须只从
单一 `choices[0].message.content` 字符串提取，且 choices、message 和 content 的类型必须精确符合
代码固定信封。每个适配器的信封、content 类型、响应上限和拒绝行为
由代码固定；不得接受 Provider 私有 envelope、Tool 调用参数、数组 content、Markdown 围栏、
前后文本或 JSON 子串。

能力测试必须由用户显式启动，使用固定系统说明、随机 nonce 和合成的最小白名单场景；不得发送
Project、素材、Transcript、真实 Timeline、用户 instruction、路径或任何业务 Egress。完整通过是指
HTTP 传输、该候选适配器提取、输出语法和本地 `TimelinePatch v1` 严格/领域校验均通过。HTTP 200
但任一层失败均不是成功；测试继续下一个固定候选，全部失败才写 `unsupported`。`supported` 只保存
首个完整通过的 adapter ID、protocol version `"1"`、时间和 probe hash；`unsupported` 必须清空
adapter ID 与 protocol version，只保存时间、最终安全 failure code 和本次探测的聚合安全 hash。不得保存
正文、逐候选请求/响应内容或足以还原候选顺序以外的 Provider 细节。

PatchScript v1 是普通文本适配器唯一接受的语言，不是自由文本，也不是从文本中提取 JSON：

```text
AIVS-PATCH/1
{"op":"...","...":"..."}
...
AIVS-END
```

第一行和最后一行必须精确匹配；中间每一非空行必须是单一 JSON object operation，最多 100 行，
禁止空行、Markdown、注释、额外文本、重复 JSON 键、未知键、类型转换和自动修复。Core 仅接受
本阶段 AI 操作白名单的精确字段集合，并从本地固定字符串生成 Proposal summary，再确定性编译为
`TimelinePatch v1`；模型不能通过 PatchScript 提供或影响其他 TimelinePatch 字段。随后仍执行所有
ID 白名单、锁定、关联 Caption、范围、时长、引用、原子重放和 Diff 校验。任何错误均安全失败，
不得创建 Proposal 或 Revision。

Renderer 只显示“AI 修改可用 / 未测试 / 当前 Provider 不支持 AI 修改”及必要的安全状态；不显示
Responses、Chat、Schema、PatchScript、adapter 或网关细节。未测试/不支持 Provider 在选择器禁用，
Core prepare 也必须拒绝，防止绕过 UI。手动 Timeline 编辑、Candidate、Preview、Export 等其他功能
不受影响。

业务 Generation 必须冻结 prepare 时的已认证 adapter ID、probe protocol version 和 Provider 配置 hash。
运行时失败不得静默降级、切换适配器、切换 API、切换模型、猜测/修复输出或自动重试。用户必须
重新测试 Provider、重新 prepare 并重新确认新的 EgressPreview，才可用新的认证状态发起新请求。
新增适配器只能由代码白名单注册，并同时提交无业务探针、正负夹具、严格解析测试和独立验收；
不得由 ProviderConfig、Desktop、Prompt 或 Provider 响应动态注册或选择。

### 7.2 本地严格解析与编译

JSON Schema 适配器只在内存中接受完整 JSON object，并以 `TimelinePatch v1` 严格解析器验证根键、
操作键、字段类型、操作白名单、每种 `op` 的精确必填/禁止字段、ID 白名单、锁定、时间范围、
最大操作数和总时长。PatchScript 适配器先按 §7.1 严格语法解析每行 operation，再由同一领域
校验和编译路径生成本地 `TimelinePatch v1`。两类适配器都禁止 JSON 修复、提取子串、补字段、
类型转换、自动重排、模型自纠错或第二次请求。

任一信封、语法、JSON、Schema 或领域校验失败都使 Generation 安全失败；不得创建 Proposal 或
Revision。Provider 原始响应只在当前进程内完成长度限制、hash、解析和校验后释放，不持久化、不返回
Renderer。

AI 可用操作白名单：

- `remove_clip`
- `move_clip`
- `trim_clip`
- `split_clip`
- `set_layout`
- `set_audio`
- `set_image_duration`
- `remove_caption`
- `update_caption`
- `set_caption_timing`
- `set_caption_preset`

AI 不得使用 `insert_asset_clip`、`insert_transcript_segments`、`add_caption` 或 `set_clip_locked`。
所有 ID 必须来自本次 EgressPreview 白名单。Core 必须重新应用 TimelinePatch 校验，拒绝未知 ID、
越界时间、锁定目标、空操作、超过 100 个操作、空时间线和非法总时长。Provider 原始响应只在当前
进程内完成 Schema 校验后释放，不持久化、不返回 Renderer。

## 8. TimelinePatchProposal v1

公开字段：

```text
schema_version = 1
timeline_patch_proposal_id
timeline_patch_generation_id
project_id
base_revision_id
base_document_sha256
provider_config_id
provider_display_name
model
prompt_template_version
output_schema_version
patch
patch_sha256
proposed_document_sha256
diff
created_at
applied_revision_id | null
```

提案创建后不可更新或删除。`patch` 是经过 Core 规范化和锁定校验的 TimelinePatch v1；提案不是真正
Revision，不能直接 Preview/Export，也不能成为后续 TimelinePatch 的 base。

生成成功必须在单一事务中写入 Proposal、ProviderInvocation 成功结果和 Generation 成功状态。
三个对象只保存安全摘要、哈希、usage、费用和请求 ID，不保存完整 Prompt 或原始响应。

## 9. TimelineDiff v1

Core 必须提供同一项目任意两个正式 Revision 的确定性比较，并为每个 Proposal 计算相同格式的差异。

```text
schema_version = 1
project_id
base_revision_id
target_revision_id | null
base_document_sha256
target_document_sha256
summary
duration_delta_us
clip_changes[]
caption_changes[]
lock_changes[]
indirect_locked_timing_shifts[]
```

Clip 差异至少区分 added、removed、moved、trimmed、split、layout_changed、audio_changed、
duration_changed；Caption 至少区分 added、removed、text_changed、timing_changed、preset_changed；
锁定差异区分 locked、unlocked。排序必须稳定，不能依赖字典遍历或数据库未指定顺序。

正式 Revision 比较只读，不改变当前 Revision、undo/redo 栈、草稿、预览或导出记录。

## 10. 确认应用

应用请求必须包含 `base_revision_id` 和 `proposed_document_sha256`。Core 在单一事务中：

1. 验证 Proposal、Project、ProviderInvocation 和 Generation 均成功且一致。
2. 验证 Proposal 未应用、当前 Timeline 仍等于 base Revision/hash。
3. 重新加载当前 Revision，重新执行 Patch、锁定校验、引用校验和规范化。
4. 验证结果 hash 与 `proposed_document_sha256` 一致。
5. 创建新的不可变 Timeline Revision，清空 redo 栈并删除同项目旧 Draft。
6. 创建不可变 TimelinePatchApplication，关联 Proposal 与新 Revision。
7. 提交后按现有规则令旧权威预览 stale。

任一步失败必须整体回滚。重复应用返回冲突，不得幂等地返回旧结果；用户放弃提案只关闭 UI，
不删除审计记录。

## 11. HTTP API v1

```text
POST /api/v1/projects/{project_id}/timeline-patch-generations/prepare
POST /api/v1/projects/{project_id}/timeline-patch-generations
GET  /api/v1/projects/{project_id}/timeline-patch-generations
GET  /api/v1/timeline-patch-generations/{generation_id}
GET  /api/v1/projects/{project_id}/timeline-patch-proposals
GET  /api/v1/timeline-patch-proposals/{proposal_id}
POST /api/v1/projects/{project_id}/timeline-patch-proposals/{proposal_id}/apply
POST /api/v1/projects/{project_id}/timeline/revision-diffs
```

锁定/解锁继续使用现有 `POST /projects/{project_id}/timeline/patches` 和新增的
`set_clip_locked` 操作，不建立旁路可变状态 API。

Internal Secret API、ProviderConfig API、Timeline Revision API、Preview/Export API 和 Candidate adopt
API 路径保持不变。

## 12. SQLite migrations v5, v6 and v7

v5 的 Timeline Patch 表、既有字段和历史数据保持不变。兼容修订新增 v6：在
`provider_configs` 增加 `timeline_patch_capability_status TEXT NOT NULL DEFAULT 'untested'`、
`timeline_patch_response_adapter_id TEXT NULL`、`timeline_patch_probe_protocol_version TEXT NULL`、
`timeline_patch_capability_tested_at TEXT NULL`、`timeline_patch_capability_failure_code TEXT NULL`
和 `timeline_patch_capability_probe_sha256 TEXT NULL`。只有用户显式测试 Provider 后才写入测试结果；
迁移后的历史 Provider 均为 `untested`，不能用于 2B Generation。`supported` 行必须同时具有
当前代码白名单中的 adapter ID、当前 probe protocol version、测试时间和 probe hash；其他任一
组合均按 `unsupported` 安全处理。

v6 不保存 API Key、Authorization、Prompt、探针正文、Provider 原始响应或业务 payload。迁移必须
保留所有 v4/v5 Provider、Timeline、Proposal、Job、Invocation 和 Candidate 数据；升级、幂等、回滚、
备份和未知版本拒绝必须新增覆盖。

兼容修订新增 v7：迁移必须替换 v6 对 `timeline_patch_response_adapter_id` 的 CHECK/trigger 白名单，允许
§7.1 的四个固定值，且 `timeline_patch_probe_protocol_version` 为字符串 `"1"`。`supported` 行只允许
四个值之一、protocol `"1"`、非空测试时间和 probe hash，且 failure code 必须为空；`unsupported` 行
必须 adapter/protocol 为空并同时具有测试时间、failure code 和 probe hash。v6 中已支持的
`openai_chat_completions_json_schema_v1` 保持已支持状态；其他 v6 Provider 状态和所有历史数据保持不变。
v7 只修改 capability 状态约束/白名单，不新增业务正文、Prompt、原始响应或新的公开敏感 DTO。
对 v6 真实副本升级、幂等、失败回滚、备份和未知版本拒绝必须覆盖。

新增：

```text
timeline_patch_egress_previews
timeline_patch_egress_consents
timeline_patch_generations
timeline_patch_proposals
timeline_patch_applications
```

`timeline_patch_egress_previews` 不得包含 payload、instruction、Caption 正文或 Timeline JSON 字段。
`provider_invocations` 和 `jobs` 增加可空 `timeline_patch_generation_id`。不得改变 2A 表、历史
CandidatePlan、Timeline Revision 或 RenderArtifact 内容。Preview、Consent、Proposal、Application
使用不可变触发器；Consent 只允许一次性写入 `consumed_at`。

Migration v5 必须沿用迁移前备份、事务、checksum、未知版本拒绝和失败回滚语义，并验证真实 v4
副本升级后 Project、Asset、Transcript、Timeline、Render、Export、Provider、Invocation、Candidate
和 SecretVault 非秘密配置全部保持可读。

## 13. 错误码

新增至少包括：

```text
TIMELINE_LOCKED
TIMELINE_DIFF_INVALID
TIMELINE_PATCH_EGRESS_EXPIRED
TIMELINE_PATCH_EGRESS_MISMATCH
TIMELINE_PATCH_GENERATION_NOT_FOUND
TIMELINE_PATCH_GENERATION_INVALID
TIMELINE_PATCH_PROPOSAL_NOT_FOUND
TIMELINE_PATCH_PROPOSAL_INVALID
TIMELINE_PATCH_PROPOSAL_CONFLICT
TIMELINE_PATCH_PROPOSAL_APPLIED
TIMELINE_PATCH_PROVIDER_UNTESTED
TIMELINE_PATCH_PROVIDER_UNSUPPORTED
TIMELINE_PATCH_PATCHSCRIPT_INVALID
```

HTTP 映射沿用既有规则：输入错误 400/422，认证 401，授权 403，不存在 404，基线、锁定、状态和
重复应用冲突 409，外部 Provider 错误 502/503。程序只能依据 `code` 分支。

## 14. 验收退出条件

1. 历史 TimelineDocument v1 无迁移重写即可读取、编辑、预览和导出。
2. Clip 锁定、解锁、关联 Caption 保护、原子回滚和间接时间位移差异符合本契约。
3. prepare 阶段零网络；确认后仅发送 EgressPreview 精确字段且只发送一次。
4. Provider 只能生成白名单 TimelinePatch；未知引用、锁定绕过和非法范围均被 Core 拒绝。
5. 提案不会改变正式 Timeline；应用前可查看确定性差异，显式应用才创建一个新 Revision。
6. 基线、锁定、Provider、payload 或提案 hash 变化均安全失败，不发生静默覆盖。
7. 任意两个正式 Revision 可比较，比较不改变项目状态。
8. SQLite v5/v6/v7、Contracts、Core、Desktop、覆盖率、Electron E2E、Stage 1/2A 回归和打包验证通过。
9. Responses/Chat Structured 与 PatchScript 适配器的无业务能力探针、严格提取/编译/失败行为和未测试/不支持 Provider 的
   UI 与 Core 双重拒绝均已验证；业务调用不得静默降级或重试。API Key、完整 Prompt、Provider 原始响应、Egress 正文、路径和敏感正文未泄漏到禁止边界；
   SQLite 不保存 2B 的用户指令、Caption 正文或 Timeline payload。
10. 真实外部 Provider 完成 2A 候选生成及 2B Patch 提案；真实 Windows 安装包完成
    ASR -> Transcript -> Candidate -> Adopt -> Lock -> Natural-language Proposal -> Apply -> Preview -> Export。

缺真实 Provider、网络、模型目录或测试媒体时，第 10 项必须标记“未验证”，不得用 loopback、Mock、
开发服务器、页面 smoke 或静态包验证替代，也不得宣称 Stage 2B 最终完成。
