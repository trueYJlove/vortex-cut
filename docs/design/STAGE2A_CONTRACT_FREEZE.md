# 阶段 2A 契约冻结：AI 候选粗剪规划

> 负责人：LiuWei（架构师）
> 状态：已冻结，stage2a-v1
> 日期：2026-08-12
> 基线：1e7d90a feat(stage1c): 完成时间线编辑与权威渲染闭环
> 依据：ARCHITECTURE.md、阶段 1 详细设计、阶段 1C 契约及最终验收报告

2026-08-12，用户确认按契约草案及阶段 2A 详细设计草案冻结设计。本次确认只批准设计冻结，
未在当前会话发出开发交接；开发工作由后续新会话依据冻结文档启动。

## 1. 已确认决策

1. 2A 先生成多个可审阅候选，不允许 AI 直接修改正式 Timeline。
2. 首期只支持 OpenAI-compatible 文本 Provider，不接视觉模型，不上传任何媒体。
3. 每次成功生成固定产出 3 个候选：稳妥版、紧凑版、高能版。
4. 默认仅外传本地预筛后的转录片段、时间戳、Brief 和必要元数据，不发送完整转录。
5. 验收闭环为：真实转录素材、显式外传确认、生成候选、比较采用、权威预览、最终导出。
6. 自然语言 TimelinePatch、镜头锁定、正式版本比较和局部重算延后到 2B。

本文确认后成为 ZhangSan、YeJing 和 LiuKeAi 的共享契约。实现期间如需改变 DTO、
错误码、安全边界、候选采用语义或验收要求，必须先由 LiuWei 组织变更确认。

## 2. 范围

- 项目级 Brief v1。
- 4 个内置文本规划 Recipe 及不可变 RecipeSnapshot v1。
- OpenAI-compatible 文本 Provider 配置、凭据状态和连接测试。
- 本地确定性转录预筛、EgressPreview v1 和逐次外传确认。
- 可取消、可追踪的 candidate_generation Job 和 ProviderInvocation 审计。
- 固定 3 个不可变 CandidatePlan v1，包含片段理由、顺序、来源和模型参考分。
- 候选并排比较、逐片段播放和连续试播。
- 通过 Core 编译、校验并采用一个候选为新的不可变 Timeline Revision。
- 采用后复用阶段 1C 的时间线编辑、权威预览和最终导出。
- Provider 错误分类、Token 用量和可选费用估算。

## 3. 非目标

- 上传视频、音频、图片、关键帧、代理、缩略图或波形。
- 视觉理解、OCR、游戏事件识别、声音高光检测或多模态推理。
- 完整转录外传、后台默认外传、永久授权或自动重试外传。
- Azure 专用鉴权、厂商 SDK、第三方插件或自定义请求脚本。
- AI 直接写数据库、Timeline、Render Plan、FFmpeg 参数或系统命令。
- 自然语言修改、TimelinePatch 生成、镜头锁定和局部重算。
- BGM、旁白、转场、特效、标题卡或阶段 3 的平台专用规则。
- 保证估算费用与供应商实际账单一致。

## 4. 兼容性与通用规则

- 确认后 CONTRACT_VERSION 从 stage1c-v1 升至 stage2a-v1。
- API 前缀保持 /api/v1，Sidecar protocol_version 保持 1。
- 阶段 1 的 Project、Asset、Transcript、Timeline、Render 和 Export 语义保持兼容。
- TimelineDocument v1、TimelinePatch v1 和 RenderPlan v1 不升级 schema。
- 候选属于 Planning 领域，不是 Timeline Revision，也不能作为 Render Plan 输入。
- Provider 不持有项目状态，只接收一次调用所需的路径无关 DTO。
- AI 声称的素材 ID 和时间不是事实。Core 只接受本次外传白名单中的 Segment ID，
  并从本地数据库重新派生 Asset、Transcript 和源时间范围。
- 正式采用必须校验 Timeline 基线、候选哈希、素材 fingerprint 和 Transcript 状态。
- Renderer 不得获得 API Key、Authorization、绝对路径、数据库位置或 Provider 原始响应。
- 日志、Job DTO 和验收报告不得包含转录正文、完整 Brief、组合 Prompt 或 API Key。

## 5. 标识、枚举和 Job

新增 ID：

- BriefId
- ProviderConfigId
- EgressPreviewId
- EgressConsentId
- CandidateGenerationId
- ProviderInvocationId
- CandidatePlanId
- CandidateAdoptionId

新增枚举：

| 名称 | 值 |
|---|---|
| ProviderKind | openai_compatible_text |
| ProviderCapability | connection_test, candidate_planning |
| ProviderCredentialStatus | configured, missing, unavailable |
| ProviderInvocationStatus | queued, running, succeeded, failed, cancelled, interrupted |
| CandidateGenerationStatus | queued, running, succeeded, failed, cancelled, interrupted |
| CandidateVariant | balanced, compact, bold |
| OriginalAudioPolicy | preserve, mute |
| CaptionPolicy | auto_from_transcript, none |
| TargetPlatform | generic_vertical |

JobKind 新增 candidate_generation。Job input 对 Renderer 只暴露
candidate_generation_id 和 egress_payload_sha256。

candidate_generation 的 stage 至少包括：

1. queued
2. loading_inputs
3. building_payload
4. calling_provider
5. validating_response
6. persisting_candidates
7. completed、failed、cancelled 或 interrupted

## 6. Brief v1

每个 Project 最多有一个当前 Brief。更新采用完整替换并重算哈希；每次生成另外保存不可变快照，
后续编辑不得改变历史候选的输入语义。

Brief 字段：

| 字段 | 约束 |
|---|---|
| schema_version | 固定 1 |
| brief_id、project_id | 合法实体 ID |
| topic、audience | 各 1-200 字符 |
| target_platform | 首版固定 generic_vertical |
| target_duration_us | 15-180 秒 |
| narrative_goal | 1-500 字符 |
| style_notes | 0-1000 字符 |
| must_keep、forbidden | 各 0-20 项，每项 1-100 字符 |
| original_audio_policy | preserve 或 mute |
| caption_policy | auto_from_transcript 或 none |
| caption_preset_id | 复用阶段 1C 冻结值 |
| default_layout | 复用阶段 1C 冻结值 |
| document_sha256 | 规范化文档哈希 |

所有文本拒绝 NUL、非法代理字符和不可显示控制字符；数组规范化后不得重复。

API：

- GET /api/v1/projects/{project_id}/brief
- PUT /api/v1/projects/{project_id}/brief

## 7. RecipeSnapshot v1

2A 内置以下基于转录文本的规划配方：

| Recipe ID | 用途 |
|---|---|
| balanced-narrative-v1 | 普通叙事混剪 |
| energetic-highlight-v1 | 高能片段 |
| funny-mistake-v1 | 搞笑或失误 |
| tutorial-explainer-v1 | 攻略或讲解 |

生成任务必须保存完整配方 JSON、版本和 SHA-256 的不可变快照，不得只保存全局 Recipe ID。
2A Recipe 只能表达文本召回和剪辑节奏规则；HUD、视觉事件、BGM 和平台码率等未实现能力
不得出现在 Provider Prompt 或 UI 承诺中。

API：

- GET /api/v1/recipes
- GET /api/v1/recipes/{recipe_id}

## 8. ProviderConfig 与密钥边界

公开 ProviderConfig 字段包括：ID、kind、display_name、base_url、model、enabled、
credential_status、可选 Token 单价、created_at 和 updated_at。

规则：

1. Core SQLite 只保存非秘密配置，不保存 API Key、加密 Key 或 Authorization。
2. API Key 由 Electron Main 使用 safeStorage 在 OS 用户上下文中加密保存。
3. Electron Main 通过仅 admin token 可访问的 internal API 将密钥注入 Core 内存 SecretVault。
4. Renderer 只可提交新密钥，永远不能读回；公开 API 只返回 credential_status。
5. safeStorage 不可用时禁止明文持久化，可选择仅在本次进程内使用。
6. 删除密钥必须同时删除加密存储和 Core 内存副本。
7. base_url 禁止 userinfo、query 和 fragment；HTTPS 可访问，HTTP 只允许 loopback。
8. TLS 校验保持开启，不跟随重定向，不信任环境代理，响应体上限 2 MiB。
9. 首期只支持 Bearer API Key 和 /chat/completions 的严格 JSON Schema 输出。
10. Provider 不支持严格结构化输出时返回能力不兼容，不降级到自由文本解析。

公开 API：

- GET /api/v1/providers
- POST /api/v1/providers
- PATCH /api/v1/providers/{provider_config_id}
- POST /api/v1/providers/{provider_config_id}/test

Renderer 设置或删除凭据必须调用 Electron Main 白名单 IPC；Main 写入或删除 safeStorage 密文后，
再调用下面的 internal API 同步 Core 内存。Core 不提供 UI token 可调用的凭据接口。

Internal API：

- PUT /api/v1/internal/provider-secrets/{provider_config_id}
- DELETE /api/v1/internal/provider-secrets/{provider_config_id}

连接测试只发送固定非项目文本，必须由用户点击触发并记录 connection_test Invocation；
不得附带 Brief、转录或素材元数据。

## 9. 本地预筛与外传确认

用户选择 1-20 个属于同一 Project 的 ready Transcript。对应 Asset 必须 available，
且当前 fingerprint 与 Transcript 的 source_fingerprint 一致。

本地预筛采用确定性算法：

1. 从 Brief、must_keep 和 Recipe 提取规范化关键词。
2. 为 Segment 及相邻上下文计算关键词、must_keep、置信度、语速和时长分。
3. 对不同 Asset 和时间区间做稳定去重与分散。
4. must_keep 命中项优先，且不得被静默丢弃。
5. 最多 160 个 Segment、32000 个 Unicode 字符和 20 分钟源片段总时长。
6. must_keep 本身超限时要求用户缩小范围，不改传完整转录。

2A 不使用本地 LLM、Embedding 服务或网络检索完成预筛，保证确认前没有隐式 Provider 调用。

Provider 可见字段仅限：

- 规范化 Brief 和 Recipe
- 3 个 CandidateVariant
- 脱敏 asset_ref、transcript_ref、segment_ref
- Segment start_us、end_us 和 text

禁止外传绝对路径、文件 URI、素材显示名、fingerprint、Word 明细、未入选转录、完整
Transcript DTO、数据库字段、用户令牌、API Key 和媒体内容。

EgressPreview 必须展示 Provider 名称、HTTPS origin、模型、Prompt 模板版本、发送字段、
Transcript/Segment 数量、字符数、估算 Token、精确片段文本、payload SHA-256 和过期时间。

API：

- POST /api/v1/projects/{project_id}/candidate-generations/prepare
- POST /api/v1/projects/{project_id}/candidate-generations

准备请求只进行本地计算。创建请求必须提交 egress_preview_id 和 payload_sha256。

确认规则：

1. Preview 15 分钟过期，只可消费一次。
2. Provider、Brief、Recipe、Transcript、Asset fingerprint 或 payload hash 变化即失效。
3. 一次确认只授权一次 HTTP 请求，不授权自动重试、模型回退或 Provider 回退。
4. 网络失败、限流、超时、无效输出或 Core 重启后的重试都必须重新准备并确认。
5. 请求发出后取消只能尽力中止连接，供应商仍可能处理并计费，审计必须记录该事实。

## 10. ProviderInvocation

每次调用保存 Provider/模型快照、能力、Prompt 模板版本、输出 Schema 版本、输入/输出哈希、
起止时间、耗时、状态、供应商请求 ID、Token 用量、估算费用和统一错误分类。

禁止保存完整 Prompt、完整响应、Authorization 或密钥。成功响应只保存经 Core 校验后的
CandidatePlan，Provider 原始响应在当前进程内校验后释放。

统一错误至少包括：

- PROVIDER_CREDENTIAL_MISSING、PROVIDER_AUTH_FAILED
- PROVIDER_RATE_LIMITED、PROVIDER_QUOTA_EXCEEDED
- PROVIDER_TIMEOUT、PROVIDER_NETWORK_ERROR、PROVIDER_TLS_ERROR
- PROVIDER_UNAVAILABLE、PROVIDER_CONTENT_REJECTED
- PROVIDER_CAPABILITY_UNSUPPORTED、PROVIDER_RESPONSE_TOO_LARGE
- PROVIDER_INVALID_RESPONSE、PROVIDER_SCHEMA_MISMATCH
- PROVIDER_CANCELLED、PROVIDER_UNKNOWN_ERROR

Token 用量以 Provider usage 为准，缺失时为 null。只有配置单价且用量完整时才计算
estimated_cost；actual_cost 首期固定为 null，UI 必须明确标为估算。

## 11. CandidatePlan v1

Provider 输出只允许 CandidateVariant、Segment ID 顺序、理由、标题建议和 0-1 参考分。
Core 从白名单 Segment 重新构造完整 CandidatePlan。

CandidatePlan 字段包括：schema_version、ID、generation_id、project_id、ordinal、variant、
title_suggestion、summary、duration_us、clips、warnings、document_sha256 和 created_at。

每个 CandidateClip 包含：ID、order_index、asset_id、transcript_id、segment_ids、本地派生的
source_start_us/source_end_us、reason、可空 model_score 和可空 caption_text。

校验规则：

1. 成功批次恰好包含 balanced、compact、bold 各一个，ordinal 为 0-2。
2. 每个候选包含 1-30 个 Clip；Segment ID 必须在本次 Egress 白名单内。
3. 同一 Clip 的 Segment 必须属于同一 Transcript、按时间连续且不重复。
4. Core 忽略模型声称的 Asset 和时间，从本地 Segment 派生并验证源范围。
5. 候选总时长由 Core 重算，需在 Brief 目标正负 20% 内，绝对范围仍为 15-180 秒。
6. reason 为 1-300 字符；标题和摘要分别不超过 200 和 500 字符。
7. model_score 是未经校准的参考值，可为 null，UI 不得称为准确率。
8. 任一候选不合法时整批失败，不保存部分候选，也不发起隐藏修复 Prompt。
9. CandidatePlan 创建后不可更新或删除。

API：

- GET /api/v1/projects/{project_id}/candidate-generations
- GET /api/v1/candidate-generations/{candidate_generation_id}
- GET /api/v1/projects/{project_id}/candidate-plans
- GET /api/v1/candidate-plans/{candidate_plan_id}

## 12. 候选采用

API：

- POST /api/v1/projects/{project_id}/candidate-plans/{candidate_plan_id}/adopt

请求提交 schema_version、candidate_document_sha256 和可空 base_revision_id。项目尚无 Timeline
时 base_revision_id 必须为 null。

采用语义：

1. 验证 CandidatePlan 归属、哈希和采用状态。
2. 验证生成时 Timeline 基线仍等于当前基线，否则要求重新生成。
3. 存在未处理 Timeline Draft 时阻止采用，避免静默覆盖编辑。
4. 重新验证 Asset、fingerprint、Transcript 和 Segment。
5. Core 编译完整 TimelineDocument v1，并复用 TimelineService 的规范化和完整校验。
6. 单事务创建 Timeline Revision、CandidateAdoption、更新 Project 指针并清空 redo 栈。
7. Revision created_by 仍为 user；AI 来源由 CandidateAdoption 关系记录。
8. 已有 Timeline 时新 Revision 的 parent 为当前 Revision，Undo 可恢复采用前版本。
9. CandidatePlan 不能直接进入 Render Plan，采用成功后才可 Preview/Export。

候选只能采用一次；重复采用返回 CANDIDATE_ALREADY_ADOPTED。撤销后应使用既有 Redo 恢复。

## 13. 安全不变量

以下任一项违反即 2A 验收失败：

- 未经本次精确 EgressPreview 确认即发生项目数据外传。
- Provider 收到媒体、路径、素材显示名、fingerprint 或完整转录。
- API Key 明文出现在 SQLite、文件、日志、Job、Renderer、诊断或验收证据。
- Provider 输出可直接修改数据库、Timeline、Render Plan、FFmpeg 或系统命令。
- 候选采用绕过哈希、引用、fingerprint、基线或 Timeline 校验。
- 失败批次留下部分成功候选，或取消/中断被标记成功。
- 自动重试或回退造成未再次确认的外传与费用。

## 14. 退出条件

LiuKeAi 必须独立验证：

1. 真实视频完成本地 ASR，EgressPreview 显示精确发送内容。
2. 真实 OpenAI-compatible Provider 生成 3 个可区分候选。
3. 用户比较并采用候选，生成可撤销的正式 Timeline Revision。
4. 采用结果通过权威预览并成功导出 1080x1920 H.264/AAC。
5. 认证失败、超时、限流、无效 JSON、Schema 不符、取消和重启状态正确。
6. 数据迁移、密钥持久化、外传边界、日志脱敏和安装包链路通过。
7. 阶段 1 的转录、文本剪辑、预览、导出和安装包回归无阻塞退化。

没有真实 Provider 凭据或网络时，第 2-4 项必须标记未验证，阶段 2A 不得宣称完成。
