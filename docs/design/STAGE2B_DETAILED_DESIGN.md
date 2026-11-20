# 阶段 2B 详细设计：锁定、自然语言修改与版本比较

> 角色：LiuWei（架构师）  
> 状态：开发交接基线  
> 日期：2026-08-12  
> 冻结契约：`docs/design/STAGE2B_CONTRACT_FREEZE.md`

## 1. 交付目标

在阶段 2A 的候选采用闭环之后，用户可以锁定不希望 AI 改动的镜头，输入自然语言局部修改要求，
查看一次精确外传内容并触发受控 Provider 调用。Provider 只返回严格 TimelinePatch，Core 将其校验
为不可变提案并计算新旧差异；只有用户确认应用后，系统才创建新的正式 Timeline Revision。

完成后的本地闭环为：

```text
Adopt Candidate / Existing Timeline
  -> Lock Clips
  -> Enter Natural-language Instruction
  -> Inspect Exact Egress
  -> Confirm One Provider Request
  -> Review Deterministic Diff
  -> Apply Proposal
  -> Authoritative Preview
  -> Final Export
```

## 2. 设计边界

- 延续模块化单体、SQLite 唯一事实来源和不可变 Timeline Revision。
- AI 负责建议，Core 负责约束、引用派生、差异和事务应用。
- 复用 Stage 2A ProviderSecretVault、safeStorage 和 ProviderConfig，不建立第二套密钥系统。
- 2B Provider payload 只包含当前 Timeline 的路径无关摘要，不读取媒体、不上传完整 Transcript。
- 不升级 TimelinePatch v1 或 RenderPlan v1 schema；兼容增加可选锁定字段和 Patch 操作。
- 不实现依赖图和局部渲染；正式 Revision 变化继续整体使旧预览 stale。

## 3. 数据流

```text
Renderer lock command
  -> Preload allowlist
  -> Electron Main
  -> Core TimelinePatch(set_clip_locked)
  -> immutable TimelineRevision

Renderer instruction
  -> Preload allowlist
  -> Electron Main
  -> Core prepare_patch_generation
  -> local sanitized timeline payload + hash in PendingEgressStore
  -> redacted TimelinePatchEgressPreview metadata
  -> user confirms exact payload
  -> Core creates Job + one-use consent
  -> authenticated Responses/Chat adapter and probe protocol frozen at prepare
  -> local strict TimelinePatch v1 parse and validation
  -> Core validates schema/references/locks/ranges
  -> normalized proposed document + TimelineDiff
  -> immutable TimelinePatchProposal
  -> Renderer comparison
  -> explicit apply
  -> transaction creates TimelineRevision + Application
  -> existing Preview/Export path
```

## 4. Contracts 设计

文件所有权：YeJing 独占 `packages/contracts/**`。

新增或扩展：

- `CONTRACT_VERSION = "stage2b-v1"`。
- `TimelineDocument.locked_elements?: TimelineClipId[]`。
- `TimelinePatchOperation.set_clip_locked`。
- `ProviderCapability` 增加 `timeline_patch_planning`。
- `TimelinePatchEgressPreview`、`TimelinePatchGeneration`、`TimelinePatchProposal`。
- `TimelineDiff`、Clip/Caption/Lock change DTO。
- prepare/create/apply/revision-diff 请求与响应 DTO。
- `JobKind` 增加 `timeline_patch_generation`，Job stage 增加本地准备、Provider 调用、校验和持久化阶段。
- 冻结契约中的错误码。

Guard 必须使用精确字段白名单，递归拒绝 path、URI、token、authorization、api_key、secret、prompt、
raw_response 等敏感键。历史 TimelineDocument 缺少 `locked_elements` 时必须通过；字段存在时必须是
唯一且合法的 Clip ID 数组。

## 5. Core Timeline 与 Diff

文件所有权：ZhangSan 独占 `services/core/src/aivs_core/timeline.py` 及对应 Core 测试。

### 5.1 锁定

在 `TimelineService._apply_operation` 中增加 `set_clip_locked`，并在每个现有修改操作前调用统一的
锁定保护函数。关联 Caption 通过 `source_clip_id` 继承锁定保护。规范化阶段验证锁定 ID，不修改
历史 Revision JSON；新 Revision 总是写出稳定排序的 `locked_elements`。

手工 Patch 与 AI Patch 共用相同底层校验。AI 层另加操作白名单，不能依赖 Renderer 禁用按钮
实现安全。

### 5.2 差异

建议在 `timeline.py` 内新增纯函数或紧邻模块 `timeline_diff.py`，由 ZhangSan 独占。输入两个已规范化
TimelineDocument，输出稳定 TimelineDiff。Proposal 使用 `target_revision_id=null`；正式 Revision 比较
返回真实 target ID。

Clip 以 ID 比对属性；split 通过 base Clip 消失及多个连续、相同 Asset/相接源范围的新 Clip 识别，
无法确定时保守报告 removed + added，不进行模糊猜测。Caption 与锁定差异按 ID 比较。

### 5.3 应用

抽取“在内存中应用并规范化 Patch”的无副作用入口，供普通 Patch 和 AI Proposal 共用。普通 Patch
保持现有事务；Proposal apply 在 Planning 服务持有的同一 SQLite 事务中调用 Timeline 内部边界，
创建 Revision、清空 redo、删除旧 Draft 并写 Application。

## 6. Provider 与 Planning

文件所有权：ZhangSan 独占：

- `services/core/src/aivs_core/providers.py`
- `services/core/src/aivs_core/planning.py`，或由其拆出的专用 `timeline_planning.py`
- `services/core/src/aivs_core/jobs.py`
- `services/core/src/aivs_core/app.py`
- 对应 `services/core/tests/**`

`TextReasoningProvider` 抽象为显式 adapter 请求/提取端口。候选生成保持既有
`candidate-plan-output-v1`；2B 的领域输出继续是本地严格 `TimelinePatch v1`。完整 Structured
Outputs 是增强，不是默认 Provider 门槛。实现四个固定 adapter：

1. `openai_responses_json_schema_v1`：`POST /responses` + `text.format` 完整 Schema。
2. `openai_responses_patchscript_v1`：`POST /responses` 普通 output text + `AIVS-PATCH/1`。
3. `openai_chat_completions_json_schema_v1`：保持现有 `POST /chat/completions` 严格 Schema。
4. `openai_chat_completions_patchscript_v1`：`POST /chat/completions` 普通 content + `AIVS-PATCH/1`。

Responses PatchScript 是默认广兼容适配器，Chat PatchScript 是旧网关兼容适配器。每个 adapter
独占请求构造、标准 API 信封提取和响应大小限制；不得接受 Provider 私有 envelope。Responses
普通文本请求固定为 `POST {base_url}/responses`，只包含 model、固定 instructions 和单一文本 input，
不得附带 `text.format`、`response_format`、tools 或 Provider 私有字段。它只接受一个标准 output message
中的一个 `{ type: "output_text", text: string }` 项；Responses Structured 在同一标准请求/响应骨架上增加
完整 `text.format` JSON Schema。Chat adapter 只接受单一 `choices[0].message.content` 字符串，choices、
message 和 content 的类型必须精确匹配。`json_object`、普通 Prompt JSON、Tool Calling 和任意自由文本
提取都不是 fallback；不得由 payload、ProviderConfig、Prompt 或 Provider 响应动态猜测 adapter。

PatchScript parser 先精确匹配首行 `AIVS-PATCH/1` 和末行 `AIVS-END`，逐行用重复键拒绝 JSON decoder
读取 operation object。它拒绝空行、围栏、注释、前后文本、未知/缺失字段、错类型和超过 100 行；
每个 operation 再经现有白名单、锁定、引用、范围和原子重放校验。Parser 不恢复/抽取/修复模型文本。
由 Core 生成固定 proposal summary，并将合法 operation 列表编译到本地 `TimelinePatch v1`；模型不能
注入 summary 或其他领域字段。

Provider 测试新增无业务 2B 能力探针，按 Contract §7.1 顺序每个候选仅请求一次，在首个完整成功
的适配器停止。探针仅发送固定说明、随机 nonce 和合成最小场景；不含项目、媒体、转录、真实
Timeline 或用户 instruction。每次候选均必须同时通过 HTTP、该 adapter 提取、Strict JSON/PatchScript
语法、TimelinePatch Schema 和领域校验才可 `supported`。HTTP 200 但内容无效只视为该候选失败，
可继续下一个预定义候选；全部失败才为 `unsupported`。`supported` 只保存首个成功 adapter、protocol
`"1"`、时间和 probe hash；`unsupported` 的 adapter/protocol 必须为空，只保存时间、最终安全 failure
code 和本次探测的聚合安全 hash，不保存正文或逐候选材料。v7 扩展数据库 trigger/约束白名单为四种
adapter，v6 既有 chat structured 支持状态保持；Desktop 显示非技术性的可用状态，Core prepare 重复检查
adapter 白名单和版本。

自然语言 prepare 必须在一致性读中加载 Provider、凭据状态和正式 Revision，生成稳定 payload、
允许操作及锁定集合；准备过程不得实例化网络请求。待发送 payload 进入 Core 进程内
`PendingTimelinePatchEgressStore`，最长保留 15 分钟；SQLite 只保存 hash、统计和快照元数据，禁止
保存 instruction、Caption 正文、Timeline 摘要、组合 Prompt 或实际 HTTP body。Core 重启后未消费
预览失效。公开 prepare DTO 只返回 Provider、字段类别、各类数量、字符/Token 统计、hash 和有效期，
不得回显 instruction、Caption 正文或 Timeline payload。创建 generation 时从内存 seam 取回并重新
验证快照和 hash，消费一次性 consent 后进入 Job。

创建 Generation 后，待发送 payload 继续由仅 Core 可访问的短生命周期内存 GenerationPayloadStore
持有到 Job 开始；不得复制到 `jobs.input_json`、Generation 表或日志。Job 启动前必须重新验证当前
Provider 配置/凭据状态、Project 当前 Revision、base hash 与内存 payload hash，再消费 consent；任一
变化均在网络调用前失败且不得外传。

Job runner 固定顺序：

```text
loading_snapshot
  -> calling_provider
  -> validating_response
  -> applying_patch_in_memory
  -> computing_diff
  -> persisting_proposal
```

取消发生在 HTTP 发送前时不得外传；发送后取消必须记录 `provider_may_have_processed=true`。不自动
重试，不复用 consent。外部错误只保存统一 code 和安全消息。

## 7. SQLite v5、v6 与 v7

文件所有权：ZhangSan 独占 `services/core/src/aivs_core/database.py` 和迁移测试。

新增表建议字段：

```text
timeline_patch_egress_previews
  id, project_id, provider_config_id, base_revision_id, base_document_sha256,
  provider_snapshot_json, provider_config_sha256, payload_sha256,
  stats_json, expires_at, created_at

timeline_patch_egress_consents
  id, egress_preview_id UNIQUE, payload_sha256, created_at, consumed_at NULL

timeline_patch_generations
  id, project_id, egress_preview_id, egress_consent_id, provider_config_id,
  base_revision_id, base_document_sha256, status, payload_sha256,
  created_at, updated_at, finished_at NULL

timeline_patch_proposals
  id, generation_id UNIQUE, project_id, base_revision_id, base_document_sha256,
  provider_config_id, patch_json, patch_sha256, proposed_document_sha256,
  diff_json, created_at

timeline_patch_applications
  id, proposal_id UNIQUE, project_id, timeline_revision_id UNIQUE, created_at
```

`provider_invocations` 与 `jobs` 增加 `timeline_patch_generation_id`。v5 沿用当前迁移框架；v6
向 `provider_configs` 加入 TimelinePatch capability status、response adapter ID、probe protocol
version、测试时间、失败 code 和 probe hash；v7 必须替换 v6 trigger/CHECK，将 adapter 白名单扩展为
Responses/Chat 四种固定 adapter，并强制 supported 与 unsupported 的字段组合契约。对 v4/v5/v6
真实副本升级、失败回滚、备份、checksum、幂等和未知版本拒绝分别测试。

数据库与公开 Job/Generation DTO 均不得保存或返回 instruction、Caption 正文、Timeline payload、
完整组合 Prompt、system message 或 Provider HTTP body。

## 8. Core API

保持 `app.py` 当前集中路由风格，但领域逻辑留在服务中。新增严格 Pydantic Request：

- `TimelinePatchPrepareRequest`
- `TimelinePatchGenerationCreateRequest`
- `TimelinePatchProposalApplyRequest`
- `TimelineRevisionDiffRequest`

路由严格使用冻结契约第 11 节。所有 UI 路由使用 UI token；SecretVault 仍仅允许 admin token 写入。
Proposal/Generation 的项目归属、哈希和状态必须在 Core 校验，不能信任 URL 外的 Renderer 数据。

## 9. Electron Main 与 Preload

文件所有权：YeJing 独占 `apps/desktop/electron/**` 和对应 Desktop 测试。

在独立 `stage2b-ipc.ts` 注册白名单 IPC：

```text
planning-patch:prepare
planning-patch:test-provider-capability
planning-patch:create
planning-patch:generation-get
planning-patch:proposal-list
planning-patch:proposal-get
planning-patch:proposal-apply
timeline:revision-diff
```

`planning-patch:test-provider-capability` 是能力测试的唯一 Renderer 入口：仅接收严格 Provider ID，
由用户显式触发，调用无业务合成 probe；它不接受 instruction、Timeline、URL、adapter、模型、
请求正文或任意动态参数，也不返回候选请求/响应正文。其余通道不具有测试或动态网络代理语义。

锁定继续通过现有 `timeline:patch`。IPC 必须精确校验 ID、SHA-256、指令长度和对象键；错误返回不得
包含 Core 原始响应、Prompt、用户指令回显、路径或密钥。`rendererSafe` 的递归敏感字段过滤继续
生效，并增加 2B DTO 测试。

Preload 只暴露具体方法，不暴露通用 fetch、任意 channel、任意 URL 或内部管理 API。

## 10. Desktop UI

文件所有权：YeJing 独占 `apps/desktop/src/**`、`apps/desktop/tests/**` 和
`apps/desktop/e2e/**`。

在现有工作台内增加：

1. Clip 属性区和时间线工具栏中的锁定/解锁图标按钮，带 tooltip 和可访问名称。
2. 锁定 Clip 的清晰状态；被锁定时禁用直接编辑控件并说明状态，不隐藏内容。
3. “AI 修改”命令，输入指令并选择已有可用 Provider。
4. 外传确认对话框，显示用户本地输入的指令、目标 origin、模型、发送字段类别、Clip/Caption/锁定
   数量、hash、Token/费用提示和逐次确认；Core DTO 不回显 Egress 正文。
5. 可取消 Job 进度。
6. Proposal 比较面板，以分组列表显示 Clip、Caption、锁定和时长变化；明确标出间接导致的锁定
   Clip 时间平移。
7. “应用修改”和“放弃”命令。放弃只关闭面板；应用成功后刷新正式 Timeline。
8. Revision 历史比较入口，可选择同项目两个正式 Revision，只读展示相同 TimelineDiff。

不得把完整 Prompt、Provider 原始响应、路径、API Key 或 Authorization 放入 React state、DOM 属性、
可复制诊断信息或错误详情。用户自然语言指令只在本次 prepare/create 流程所需的短生命周期 state
中保留。

## 11. 打包与资源

2B 不新增模型、字体、FFmpeg 或 Recipe 资源。现有 Core sidecar 打包必须包含新的迁移、Provider
Schema 和服务模块。`electron-builder.yml` 原则上不修改；若拆出新 Python 模块，由 PyInstaller
自动收集验证，不新增动态下载代码。

安装包验证同时补验 2A 债务：safeStorage 重启注入、真实 Provider、真实 ASR 模型目录和测试媒体。
测试环境通过本机环境变量或 safeStorage 注入，禁止把凭据和敏感路径写入报告或 Git。

## 12. 实施顺序与所有权

冻结 Contracts 与 API 已给出不可变接口边界后，Core 与 Desktop 切片可以并行；两人不得修改对方文件、
不得改变冻结 DTO/API，接口疑义必须回到 LiuWei 裁定。

### 12.1 ZhangSan：Core 锁定、Diff 与 AI Patch

与 YeJing 并行执行，独占：

- `services/core/src/aivs_core/**`
- `services/core/tests/**`
- `pyproject.toml`、`uv.lock` 仅在确有依赖变化时

交付 SQLite v5/v6/v7、锁定规则、Diff、四 adapter、PatchScript、Egress、Generation、Proposal、Apply、Job、API 和
Core 测试。不得修改 Contracts、Desktop、冻结文档、缓存或验收产物。

### 12.2 YeJing：Contracts、Electron 与 UI

与 ZhangSan 并行执行，独占：

- `packages/contracts/**`
- `apps/desktop/src/**`
- `apps/desktop/electron/**`
- `apps/desktop/tests/**`
- `apps/desktop/e2e/**`
- Desktop 打包脚本仅在 2B 验证确有需要时

交付 stage2b-v1 Contracts、guards、白名单 IPC、锁定 UI、Egress 确认、Proposal/Revision Diff 和
Electron E2E。不得修改 Core、冻结文档或重新定义 API。

两人均不得提交 Git，除非 LiuWei 后续明确要求；共享工作区中不得回退或覆盖用户及其他工程师修改。

## 13. 测试策略

### 13.1 Core 单元与集成

- 历史 TimelineDocument 无 `locked_elements` 的兼容读取和 hash 不变。
- 锁定/解锁、全部受保护操作、关联 Caption、原子顺序和悬空锁拒绝。
- AI 操作白名单、未知 ID、锁定绕过、非法范围、空 Patch、大 Patch 和空时间线。
- TimelineDiff 全部变化类型、稳定排序和间接锁定时间平移。
- prepare 零网络、预览失效、consent 一次消费、取消和 Provider may-have-processed。
- SQLite/Job/Generation 不含 instruction、Caption 正文和 Timeline payload；Core 重启后预览安全失效。
- create 后到 Job 调用前 Provider 或 Timeline 变化时，在消费/外传前安全失败。
- Provider 严格 Schema、响应上限、错误分类、无隐藏重试。
- Proposal 不改变 Timeline；apply 的基线/hash/重复应用/事务回滚。
- migration v5 从真实 v4 副本升级及既有数据完整性。
- v6/v7 从真实副本升级；迁移后的 Provider 为既有状态，`supported` 的组合字段完整性、四 adapter
  白名单与 protocol version 均受校验；未测试或不支持 Provider 不能 prepare 或生成。
- 四种认证 adapter 的无业务探针必须通过各自 API 信封提取，并通过 JSON Schema 或 PatchScript
  语法及本地 TimelinePatch 校验。HTTP 200 但任一层失败只判当前 adapter 失败；Markdown、前后文本、
  重复键、未知字段、错类型、越权操作、锁定绕过、超长响应与非法 JSON/PatchScript 均安全失败，
  不得自动修复或重试。
- Provider 状态在 Desktop 中可见且不可用项不可选择；绕过 UI 直接调用 prepare 必须返回安全错误。
- 日志、SQLite、Job/Event、API DTO 和错误扫描无哨兵密钥、完整 Prompt 或原始响应。

Timeline、Diff、Planning 关键模块覆盖率不低于 85%，Core 全局不低于 80%。

### 13.2 Contracts 与 Desktop

- 全部新增 DTO、枚举、可选兼容字段和错误响应 guard。
- Renderer DTO 无 path、URI、token、authorization、secret、prompt、raw_response。
- IPC 精确白名单、参数上限和安全错误。
- 锁定状态、禁用编辑、外传确认、取消、差异、应用、冲突和 Revision 比较 UI。
- 长中文指令、长 Caption、窄窗口和三列差异不重叠、不跳动。
- Stage 1 编辑、Preview/Export 和 Stage 2A Candidate UI 回归。

### 13.3 Electron E2E 与打包

- 受控 loopback Provider：锁定 -> prepare 零外传 -> confirm 单次请求 -> Proposal -> Diff -> Apply。
- Provider 返回锁定目标、未知 ID、非法操作和错误 JSON 时安全失败。
- 应用后旧 Preview stale，重新权威预览和导出成功。
- 两轮真实 Electron E2E，覆盖重启后 safeStorage 注入和状态恢复。
- `pnpm run ci`、Python lint/typecheck/test、Desktop coverage、sidecar build、静态包验证。

loopback 和静态包只证明本地实现，不替代最终外部补验。

## 14. LiuKeAi 独立验收清单

LiuKeAi 不修改生产代码或正式测试，逐项记录命令、环境、证据路径和通过/未通过/未验证：

1. 审查全部 diff、Contracts、SQLite v5/v6/v7、Provider capability 状态、四种认证响应适配器、
   PatchScript parser/compiler、IPC 和打包清单。
2. 验证历史 v4 数据升级及 Timeline/2A 数据兼容。
3. 验证锁定的直接保护、关联 Caption、原子回滚和间接时间位移差异。
4. 用网络记录证明 prepare 零外传、confirm 仅一次且字段与 EgressPreview 完全一致。
5. 验证 Provider 输出不能插入素材/Caption、不能改锁、不能引用未知或锁定元素。
6. 验证 Proposal 不改变正式 Timeline，显式 apply 才生成单一 Revision。
7. 验证任意正式 Revision 比较只读、稳定且不影响 undo/redo、草稿和预览。
8. 扫描 SQLite、日志、Job/Event/Renderer DTO、崩溃证据和报告中的敏感信息。
9. 运行 Core、Contracts、Desktop、覆盖率、Electron E2E、Stage 1/2A 回归和打包验证。
10. 独立运行无业务 2B 能力探针：验证固定顺序、单候选单请求、首个成功停止、仅四个白名单 adapter
    可写 `supported`，Responses/Chat Structured 与 PatchScript 的请求、信封提取、JSON/语法和领域校验
    均精确执行；HTTP 200 但任一层失败均只使当前候选失败；扫描 SQLite、日志、DTO 与证据，不含正文或凭据。
11. 验证 `untested`/`unsupported` Provider 被 Desktop 禁用且被 Core prepare 拒绝；业务调用没有降级、
    适配器切换、JSON 修复或重试。
12. 使用真实外部 Provider 完成 2A Candidate 与 2B TimelinePatch Proposal，不记录凭据或正文。
13. 使用真实 Windows 安装包、受控模型目录和媒体完成
    ASR -> Transcript -> Candidate -> Adopt -> Lock -> Proposal -> Apply -> Preview -> Export。

第 12 或 13 项缺少外部前置时必须标记“未验证”。本地验收可以给出“本地可验证实施通过”，但
LiuWei 不得据此宣布 Stage 2B 最终完成。

## 15. 返工与阶段门禁

- ZhangSan 完成后由 LiuWei 复核 API、迁移和安全边界，未稳定前不启动 YeJing。
- YeJing 完成后由 LiuWei 检查 Contracts/Core/Desktop 接口一致性，再启动 LiuKeAi。
- LiuKeAi 发现问题时，返工发回原文件负责人；修复后必须再次独立复验。
- 未取得 LiuKeAi 报告、阻塞项未关闭或外部补验未完成前，不宣称 Stage 2B 最终完成。
