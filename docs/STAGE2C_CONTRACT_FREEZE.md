# 阶段 2C 契约冻结：Candidate Provider 兼容扩展

> 角色：LiuWei（架构师）  
> 状态：已冻结，stage2c-v1  
> 日期：2026-08-14  
> 基线：`2dcd4c9 feat(stage2a): 完成AI候选粗剪规划闭环`  
> 依据：`ARCHITECTURE.md`、阶段 1C 契约、阶段 2A/2B 冻结契约与详细设计、用户对阶段 2C 新范围的确认

## 1. 已确认决策

1. 阶段 2C 的唯一开发范围调整为 Candidate Provider 兼容扩展：完整 Structured Output
   继续作为增强能力，但不再是 Candidate 功能的唯一准入路径。
2. Candidate 使用四个代码白名单 adapter，按固定顺序执行无业务能力探测；普通文本路径只接受
   严格 `AIVS-CANDIDATE/1` CandidateScript，不接受自由文本或宽松 JSON。
3. HTTP、标准信封提取、输出语法和本地 Candidate 领域校验全部成功才算能力探测成功。
4. 用户确认后的业务 Generation 固定使用 prepare 时认证的 adapter、API、模型、probe protocol、
   probe hash 和 Provider 配置 hash；业务失败不得 fallback、retry、换 API、换模型或换 adapter。
5. CandidatePlan v1、三个变体、Segment 引用、来源、时长、费用、显式 adopt 和后续 TimelinePatch
   语义保持不变。AI 仍不能直接修改正式 Timeline。
6. 原路线图不机械整体顺延：
   - 依赖失效与局部预览重算仍未实现，作为后续独立阶段候选；
   - 2A 已有 Token usage、估算费用和单价配置，未定义的预算/成本策略另行立项；
   - 已实现的中断、consent、Revision、预览和导出恢复不重复开发，剩余恢复缺口按故障矩阵另行立项；
   - 阶段 2 总验收并入本阶段退出门禁，不另行机械顺延。
7. 阶段 2B 外部债务仍存在。2C 改变 Candidate Provider 路径后，必须重新执行一次受控真实
   Candidate Provider 验收，并重新执行真实 Windows 安装包完整链路。

本文是阶段 2C 的唯一需求来源。实现期间如需改变 CandidateScript、adapter 顺序、能力状态、
CandidatePlan/adopt 语义、安全边界、SQLite v8 或退出门禁，必须先由 LiuWei 组织变更确认。

## 2. 目标与范围

- 为 `candidate_planning` 增加独立的显式能力状态与认证 adapter。
- 支持 Responses/Chat Completions 的完整 JSON Schema 和严格 CandidateScript 四种路径。
- 提供用户显式触发、无 Project/Transcript/媒体数据的 Candidate 能力探测。
- 在 Core 中严格解析 CandidateScript，并编译到现有 Candidate 输出对象，再复用同一
  CandidatePlan v1 本地领域校验与持久化路径。
- prepare 阶段保持零业务网络，并冻结已认证能力快照。
- 业务调用一次确认只发送一次，不做隐藏重试或降级。
- Contracts 升级为 `stage2c-v1`，新增 Candidate capability 公开元数据和 guard。
- 新增 SQLite v8，保留 v1-v7 checksum、历史数据和未知版本拒绝语义。
- Desktop 增加非技术化的 Candidate 兼容性测试与可用状态。
- 完成 Core、Contracts、Desktop、Electron E2E、打包、安全扫描和外部补验。

## 3. 非目标

- 依赖图、局部 Render Plan、局部权威预览或局部缓存重算。
- 新预算模型、额度控制、账单对账、Provider 自动择优或成本路由。
- 新 Candidate 变体、视觉理解、媒体上传、完整 Transcript 外传或网络检索。
- 修改 CandidatePlan v1、Candidate adopt、TimelineDocument v1、TimelinePatch v1 或 RenderPlan v1。
- Provider/模型自动回退、业务请求重试、并行竞速或后台自动能力测试。
- Tool Calling、`json_object`、Markdown JSON、自由文本 JSON 提取或 Provider 私有协议。
- 修改阶段 2B 的四 adapter、PatchScript、锁定、Proposal、Diff 或 Apply 语义。
- 自动登录/发布、第三方插件、自定义请求模板、任意 Header 或关闭 TLS。

## 4. 兼容性与安全不变量

- `CONTRACT_VERSION` 从 `stage2b-v1` 升至 `stage2c-v1`；API 前缀和 Sidecar
  `protocol_version` 保持 1。
- CandidatePlan、CandidateClip、Generation、Adoption 的公开 schema_version 和字段保持不变。
- 历史 Provider 升级到 v8 后 Candidate capability 为 `untested`；TimelinePatch capability 原样保留。
- 历史 v4-v7 Candidate、Provider、TimelinePatch、Timeline、Render 和 Export 数据不得重写或删除。
- 新 2C EgressPreview 正文只存在于 Core 短生命周期内存和当前 Renderer 确认界面；不得写入
  SQLite、Job/Event、日志、诊断或验收报告。v4 历史 `payload_json` 不做破坏性清理。
- Prompt、system instructions、Provider 原始响应、API Key、Authorization、完整 URL、完整 Egress
  正文、用户指令、Caption 正文、Timeline payload、媒体内容和 Job error 不得进入禁止边界。
- Provider 输出只提供不透明 Segment ref 和文本说明。Asset、Transcript、源时间、Caption 正文、
  Candidate ID、document hash 和 Timeline 必须由 Core 从本地事实派生。
- prepare 不进行任何 Provider 网络请求。能力探测必须由用户单独显式触发，且只发送合成数据。
- 一次业务 consent 只授权一个固定 adapter 的一次 HTTP 请求；取消、失败或 Core 重启后不得复用。
- Candidate 只能在显式 adopt 后生成正式 Timeline Revision；AI 永不直接写 Timeline、Render Plan、
  FFmpeg、数据库任意字段或系统命令。
- Stage 2B Clip Lock、Caption 保护、Proposal/Diff/Apply、safeStorage、IPC 白名单和受限媒体协议不变。

## 5. Candidate adapter 契约

代码白名单和固定探测顺序如下：

| 顺序 | adapter ID | API 与输出 |
| --- | --- | --- |
| 1 | `openai_responses_json_schema_v1` | `POST /responses` + 完整 `text.format` Candidate JSON Schema |
| 2 | `openai_responses_candidatescript_v1` | `POST /responses` + 普通文本 `AIVS-CANDIDATE/1` |
| 3 | `openai_chat_completions_json_schema_v1` | `POST /chat/completions` + 完整 `response_format.json_schema` |
| 4 | `openai_chat_completions_candidatescript_v1` | `POST /chat/completions` + 普通文本 `AIVS-CANDIDATE/1` |

规则：

1. adapter ID 按 capability 分域；与 TimelinePatch 同名的 JSON Schema adapter 不代表二者共享
   capability 状态或业务输出 Schema。
2. 每个候选最多一次 HTTP 请求，严格串行；首个完整成功立即停止。取消立即停止，不再探测后续项。
3. 每个候选必须同时通过 HTTP、固定标准信封提取、JSON Schema/CandidateScript 语法、固定三变体
   和本地 Candidate 领域校验。HTTP 200 但任一后续层失败仍是该候选失败。
4. 全部失败后状态为 `unsupported`；不得把连接成功或可返回普通文本表述为 Candidate 可用。
5. adapter 只能由代码注册；ProviderConfig、Desktop、Prompt、响应或用户不能指定或动态注册。

### 5.1 请求与响应信封

- Responses CandidateScript 请求只包含 `model`、固定 `instructions` 和单一文本 `input`；禁止
  `text`、`text.format`、`response_format`、tools 和 Provider 私有字段。
- Responses JSON Schema 请求使用相同骨架，只额外携带固定完整 `text.format`。
- Responses 响应复用阶段 2B 的标准严格提取器：只接受唯一 output message 的唯一
  `{type: "output_text", text: string}`；拒绝数组外的替代信封、多个 message/part、tool/function
  调用和非字符串正文。
- Chat CandidateScript 请求只包含 `model` 和固定 system/user 两条文本 message；禁止
  `response_format`、tools、函数、私有字段和多模态 content。
- Chat JSON Schema 请求使用相同骨架，只额外携带固定完整 `response_format.json_schema`。
- Chat 响应只从精确 `choices[0].message.content` 字符串提取；拒绝 content array、tool/function
  调用、非标准私有信封和其他可执行内容。
- 两类普通文本只把提取出的完整字符串交给 CandidateScript parser；不得搜索子串、去围栏或修复。

## 6. `AIVS-CANDIDATE/1` 精确语法

合法文档结构：

```text
AIVS-CANDIDATE/1
{"op":"candidate","variant":"balanced","title_suggestion":"...","summary":"..."}
{"op":"clip","variant":"balanced","segment_refs":["segment_ref"],"reason":"...","model_score":null}
{"op":"candidate","variant":"compact","title_suggestion":"...","summary":"..."}
{"op":"clip","variant":"compact","segment_refs":["segment_ref"],"reason":"...","model_score":0.5}
{"op":"candidate","variant":"bold","title_suggestion":"...","summary":"..."}
{"op":"clip","variant":"bold","segment_refs":["segment_ref"],"reason":"...","model_score":1.0}
AIVS-END
```

### 6.1 字节、行与 JSON 规则

- 响应按严格 UTF-8 解码；禁止 BOM、NUL、非法代理字符和不可显示控制字符。
- 允许全文一致使用 LF 或 CRLF；允许尾行后存在一个终止换行；禁止混合换行、前导/尾随空行。
- 第一行和最后一行必须逐字等于 `AIVS-CANDIDATE/1` 与 `AIVS-END`。
- 中间每行必须是一个完整 JSON object；最少 6 行、最多 93 行。
- 禁止 Markdown 围栏、注释、空行、前后文字、JSON 数组根、多个对象、JSON 子串和尾随垃圾。
- JSON 重复键、未知键、缺失键、非有限数字、类型转换、默认补值和自动修复全部拒绝。
- JSON 合法的对象内部空白和字段顺序不承载语义；解析后按精确键集合验证。

### 6.2 记录白名单

`candidate` 记录只允许：

```text
op               固定 "candidate"
variant          balanced | compact | bold
title_suggestion JSON string，进入既有 1-200 字符领域校验
summary          JSON string，进入既有 1-500 字符领域校验
```

`clip` 记录只允许：

```text
op               固定 "clip"
variant          balanced | compact | bold
segment_refs     1 个以上不重复 JSON string，只能引用本次合成探针或业务 Egress 白名单
reason           JSON string，进入既有 1-300 字符领域校验
model_score      null 或有限 JSON number，范围 0-1；boolean 不视为 number
```

记录顺序固定为 balanced candidate + 其 1-30 个 clip、compact candidate + 其 1-30 个 clip、
bold candidate + 其 1-30 个 clip。每个变体恰好一个 candidate 记录；clip 的 variant 必须与当前
candidate 一致。不得提供 warnings、ID、Asset、Transcript、时间、Caption、费用、来源或 Timeline 字段。

### 6.3 编译与领域校验

Parser 将三组记录确定性编译为现有 `candidate-plan-output-v1` 内存对象：

```text
{"candidates":[
  {"variant", "title_suggestion", "summary", "clips":[
    {"segment_ids": segment_refs, "reason", "model_score"}
  ]}
]}
```

编译后 JSON Schema 和 CandidateScript 两条路径必须进入同一 Stage 2A `_validated_candidates`
领域路径，继续验证三变体、1-30 Clips、Segment 白名单、同 Transcript、连续/不重复引用、目标时长
±20%、15-180 秒、文本边界和参考分。Core 从本地数据库派生 Asset、Transcript、源时间、Caption、
来源、Candidate ID、hash 和总时长。任一 Candidate 无效时整批失败，不保存部分结果，不发起修复请求。

## 7. Candidate capability 状态与探针

ProviderConfig 公开新增独立字段：

```text
candidate_capability_status              untested | supported | unsupported
candidate_response_adapter_id            Candidate adapter ID | null
candidate_probe_protocol_version         "1" | null
candidate_capability_tested_at            timestamp | null
candidate_capability_failure_code         safe code | null
candidate_capability_probe_sha256         sha256 | null
```

- 新增或从 v7 升级的 Provider 默认为 `untested`。
- `supported` 必须同时具有白名单 adapter、protocol `"1"`、测试时间和 probe hash，failure code 为空。
- `unsupported` 必须 adapter/protocol 为空，且具有测试时间、安全 failure code 和 probe hash。
- `untested` 的其余字段全部为空。
- base URL 或 model 变化时 Candidate capability 自动重置为 `untested`；TimelinePatch 现有重置规则不变。
- enabled 或凭据缺失时 prepare 仍拒绝；API Key 不进入 capability 元数据或 probe hash。

能力探针由用户显式调用：

```text
POST /api/v1/providers/{provider_config_id}/candidate-planning-capability-test
```

探针使用固定 system instructions、随机 nonce、不透明合成 Segment refs、合成 15 秒最小场景和三个
固定变体，不包含 Project、Brief、Recipe、真实 Transcript、媒体、路径或用户数据。探针结果必须通过
与业务相同的信封提取、Parser/Schema 和 Candidate 领域验证。只保存首个成功 adapter 的安全元数据，
或全部失败后的聚合安全 hash；不得保存逐候选正文、Prompt 或原始响应。

## 8. prepare、Generation 与冻结规则

- Candidate prepare API 路径、请求和公开 EgressPreview DTO 保持兼容。
- prepare 除既有本地事实检查外，必须要求 Candidate capability 为 `supported`，并冻结 adapter ID、
  protocol version、probe hash、model 和 provider config hash。
- 新 2C Egress payload 进入进程内 `PendingCandidateEgressStore`，最长 15 分钟。SQLite 的历史
  `payload_json` 列为兼容保留，新记录只写固定空对象，不写业务正文。
- create generation 必须从内存取回 payload，重新验证 Preview、Provider、Brief、Recipe、Transcript、
  Asset fingerprint、capability 和 hash，再转移到短生命周期 `CandidateGenerationPayloadStore`。
- Job 发网前再次验证 Provider enabled/credential、adapter 白名单、protocol、probe hash、model、
  provider config hash、payload hash、consent 未消费和 Generation 状态，然后消费 consent。
- 发网后固定一次请求。任何业务失败、取消、中断、无效信封、无效 Script/Schema 或领域失败均不得
  fallback、retry、换 adapter/API/model、JSON 修复或复用 consent。
- Core 重启后未消费 Preview 和内存 payload 失效；用户必须重新 prepare 和确认。已发网任务按现有
  may-have-processed 与 interrupted 语义记录，不能自动重发。

## 9. SQLite v8

v8 只追加迁移，不修改 v1-v7 SQL/checksum。至少新增：

- `provider_configs` 的六个 Candidate capability 字段和状态组合 trigger。
- `egress_previews` 的 Candidate adapter、probe protocol 和 probe hash 快照列。
- `candidate_generations` 的 Candidate adapter、probe protocol、probe hash 和 provider config hash 快照列。
- Provider base URL/model 变化时重置 Candidate capability 的 trigger。

历史行的新增字段允许为空并保持可读；新 2C 行由应用层强制完整快照。迁移必须：

- 从真实 v7 副本升级并保留 Project、Asset、Transcript、Candidate、TimelinePatch、Timeline、Render、
  Export、Provider 和 Invocation 数据。
- 每次迁移前备份，单事务应用；失败回滚到 v7 可打开状态。
- 重复 initialize 幂等，已应用 checksum 不变；未知版本和 checksum 不匹配继续拒绝。
- 不提供破坏性 down migration；旧二进制遇到 v8 必须按未知版本安全拒绝，不能写入。
- 不清理历史 v4 Egress 正文；新 2C 流程不得新增持久化 Egress 正文。

## 10. Contracts、Desktop 与 IPC

- `ProviderConfig` 与 `ProviderCapabilityTestResult` 增加 Candidate capability 精确字段和 guard。
- Candidate adapter ID 类型只接受本契约四个值；敏感键递归拒绝规则继续生效。
- Electron Main 新增唯一 Renderer 入口 `planning:test-provider-capability`，只接受 Provider ID，不能接受
  URL、model、adapter、Prompt、请求体或任意参数。
- Preload 只暴露具体方法，不暴露通用 fetch、任意 channel 或 internal API。
- AI 粗剪 Provider 列表显示“AI 粗剪可用 / 未测试 / 当前 Provider 不支持 AI 粗剪”；只有 supported
  且凭据 configured、enabled 的 Provider 可 prepare。
- UI 不显示 Responses/Chat/Schema/CandidateScript/adapter 等内部细节；能力测试必须由用户点击触发。
- 既有普通连接测试可保留用于诊断，但不能作为 Candidate capability 通过依据。

## 11. 错误码

新增至少包括：

```text
CANDIDATE_PROVIDER_UNTESTED
CANDIDATE_PROVIDER_UNSUPPORTED
CANDIDATE_RESPONSE_ADAPTER_INVALID
CANDIDATE_CAPABILITY_STALE
CANDIDATE_CANDIDATESCRIPT_INVALID
CANDIDATE_EGRESS_PAYLOAD_UNAVAILABLE
```

既有 Provider 网络、认证、限流、响应过大、无效响应和 Schema/领域错误继续复用。输入错误为
400/422，不存在 404，状态/快照冲突 409，外部 Provider 错误 502/503。程序只能依据 `code` 分支；
安全消息不得含上游正文、完整 URL、Prompt、凭据或 Job error。

## 12. 验收退出条件

1. v7 历史数据库升级 v8，既有 Stage 1/2A/2B 数据和行为保持兼容。
2. 四 adapter 固定顺序、单候选单请求、首个完整成功停止和全部失败 unsupported 均通过。
3. CandidateScript 正负夹具覆盖 framing、换行、重复键、未知字段、错类型、越权引用、顺序、行数、
   三变体、Clip 数量和领域校验；不存在提取、修复或二次请求。
4. prepare 零网络；业务 Generation 冻结 adapter/API/model/probe/provider hash，失败绝不降级或重试。
5. Schema 与 CandidateScript 均生成兼容 CandidatePlan v1，并继续显式 adopt、Undo/Redo、Preview、Export。
6. SQLite、日志、Job/Event/Renderer DTO、崩溃证据和报告无密钥、Prompt、原始响应、完整 URL或正文。
7. Contracts、Core、Desktop、覆盖率、Electron E2E、Stage 1/2A/2B 回归和打包验证通过。
8. LiuKeAi 独立执行一次受控真实 Provider Candidate 验收。只允许一次调用；失败后不得自动重试、
   换 API、换模型或换 adapter。
9. 使用真实 Windows 安装包、真实模型目录和真实媒体完成：
   `ASR -> Transcript -> Candidate -> Adopt -> Lock -> Proposal -> Apply -> Preview -> Export`。

缺真实 Provider、网络、`AIVS_E2E_MODEL_DIR` 或 `AIVS_E2E_MIXED_VIDEO` 时，第 8/9 项必须标记
“未验证”。本地实现可以判定通过，但不得声称 Stage 2 外部闭环或 Stage 2C 最终完成。

