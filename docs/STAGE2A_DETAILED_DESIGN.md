# 阶段 2A 详细设计：AI 候选粗剪规划

> 负责人：LiuWei（架构师）
> 状态：已冻结，stage2a-v1
> 日期：2026-08-12
> 契约：docs/STAGE2A_CONTRACT_FREEZE.md

2026-08-12，用户确认冻结本设计。当前会话不发出开发交接；后续新会话应从 Core 切片开始，
待 Core API 稳定后再启动 Desktop 切片，最后由 LiuKeAi 独立验收。

## 1. 交付目标

阶段 2A 在阶段 1 的本地剪辑闭环上增加受控 Planning 层：用户填写 Brief、选择 Recipe 和
转录素材，在查看精确外传内容后触发一次文本 Provider 调用，得到 3 个独立候选。候选可以
本地审阅，但只有用户明确采用后，Core 才生成正式 Timeline Revision，之后继续使用现有
权威预览和导出链路。

成功标准不是“模型返回 JSON”，而是候选来源可追踪、失败可解释、外传可审计、采用可撤销，
并能在安装包中真实走通 Preview 和 Export。

## 2. 阶段 2 拆分

| 子阶段 | 范围 |
|---|---|
| 2A | Brief、Recipe、Provider、Egress、3 Candidates、Adopt、Preview、Export |
| 2B | Timeline Lock、自然语言 TimelinePatch、正式版本差异、确认应用 |
| 2C | 依赖失效、局部预览重算、成本策略、更多恢复场景和阶段 2 总验收 |

2A 不提前实现 2B，避免候选生成、TimelinePatch 和锁定语义同时变化。

## 3. 当前代码约束

- Core 位于 services/core/src/aivs_core，采用 FastAPI、Pydantic、SQLite 和集中式 app.py。
- SQLite 已有 v1-v3，不可变 Timeline Revision 由 timeline.py 管理。
- JobService 已支持落盘、取消、中断恢复、ASR runner 和 Render runner。
- TypeScript 契约由 packages/contracts/src/index.ts 维护，Desktop 侧有严格解析。
- Electron Main 是 Renderer 与 Core 的安全边界，Preload 只暴露白名单 IPC。
- 受限媒体协议可复用来审阅 Candidate Clip，无须暴露绝对路径。
- 当前没有 Provider 抽象、系统凭据存储或运行时 httpx 依赖。
- .pnpm-store/ 和 tools/fix_mojibake.py 与本阶段无关，不纳入提交。

## 4. 总体数据流

数据流依次为：Renderer 的 Brief 与候选工作区，经 Preload 白名单 IPC 到 Electron Main；
Electron Main 管理 safeStorage 密文并将密钥注入 Core 内存 SecretVault；Core 本地预筛后生成
带 SHA-256 的 EgressPreview；用户逐次确认后才创建 candidate_generation Job；Provider
只返回受限结构化结果；Core 完成 Schema、引用、时间和哈希校验后持久化 3 个 CandidatePlan；
用户本地比较并采用一个候选；Core 创建 Timeline Revision，最后复用阶段 1C 渲染链路。

事务边界：

1. prepare 只读项目事实并创建本地 EgressPreview，不触发网络。
2. confirm、Generation、Invocation 和 Job 在一个事务中创建。
3. Provider 响应只有在 3 个候选全部验证通过后才一次性持久化。
4. adopt 在一个事务中创建 Revision、Adoption 并移动 Project 当前指针。

## 5. Contracts 设计

修改 packages/contracts/src/index.ts：

- 新增 Brief、Recipe、ProviderConfig、EgressPreview、Generation、Invocation、CandidatePlan
  和 CandidateAdoption 的品牌 ID、DTO、枚举、守卫和 parse 函数。
- JobKind 增加 candidate_generation，并扩展 stage。
- 敏感键检测增加 api_key、secret、authorization、prompt 和 raw_response。
- Candidate 与 Egress DTO 使用精确键白名单。
- 正文只允许出现在明确的 EgressPreview 和 Transcript DTO，不允许进入 Job、
  ProviderConfig 和 Invocation DTO。
- 契约版本升至 stage2a-v1，保留阶段 1 DTO 兼容性测试。

更新 apps/desktop/tests/contracts.test.ts，覆盖合法/非法 DTO、额外字段、敏感键、候选数量、
变体唯一性、正文泄漏和阶段 1 回归。

## 6. Brief、Recipe 与 Planning

新增 services/core/src/aivs_core/planning.py，承载 Planning 领域规则和应用服务；
不得导入 FastAPI、Electron 或具体 Provider SDK。

职责：

- Brief 规范化、严格校验、哈希和快照。
- Recipe 加载、版本/哈希校验和能力过滤。
- 确定性预筛与 Egress payload 规范化。
- Provider 结果转换、CandidatePlan 校验和持久化。
- CandidatePlan 到 TimelineDocument 的受控编译。

新增 resources/recipes 下的 manifest.json，以及 balanced-narrative-v1、
energetic-highlight-v1、funny-mistake-v1、tutorial-explainer-v1 四个 JSON 配方。
Settings 新增 recipe_dir 资源解析；PyInstaller 和 Electron Builder 必须纳入这些资源。

## 7. Provider 端口和适配器

新增 services/core/src/aivs_core/providers.py。Planning 只依赖 TextReasoningProvider 能力接口，
接口接收 StructuredTextRequest 和 cancel_event，返回 StructuredTextResult。

OpenAICompatibleTextProvider 的冻结行为：

1. 使用运行时 httpx.AsyncClient。
2. 固定 POST 到规范化 base URL 的 /chat/completions。
3. 使用 response_format.type=json_schema 和 candidate-plan-output-v1 Schema。
4. System 消息把 Transcript 标记为不可信数据，禁止执行其中的指令。
5. 禁止自定义 Header、任意模板、脚本、代理、重定向和关闭 TLS。
6. 单次调用超时 90 秒，响应体上限 2 MiB。
7. 不做隐藏重试，不做 Provider 或模型回退。
8. 只返回解析 JSON、usage、request ID 和错误分类，不接触数据库或 TimelineService。

pyproject.toml 将 httpx 从开发依赖调整为运行时依赖；打包验收检查证书和依赖完整性。

## 8. SecretStore 与 SecretVault

新增 apps/desktop/electron/main/provider-secrets.ts：

- 使用 Electron safeStorage.encryptString 和 decryptString。
- 密文写入 userData/provider-secrets.v1.json，使用临时文件、flush 和原子替换。
- 文件只含版本、ProviderConfigId 和 base64 密文。
- Core ready 且 admin session 建立后注入已配置密钥。
- 更新、删除和解密失败不得把明文放入 Error、日志或 IPC 返回。

Core 新增内存 ProviderSecretVault：

- 只允许 admin internal API set/delete，UI token 请求返回 403。
- 不提供 get API，不持久化，不进入诊断 DTO。
- Provider 调用通过短生命周期局部变量读取。
- Core 重启后 Electron 未成功注入时返回 PROVIDER_CREDENTIAL_MISSING。

测试使用固定哨兵密钥，扫描日志、IPC、SQLite、Job 和诊断输出，证明无明文泄漏。

## 9. Egress 服务

PlanningService.prepare_generation 在 SQLite 一致性读中：

1. 加载 Project、Brief、Recipe 和所选 Transcript。
2. 验证 Asset available、fingerprint 未变、Transcript ready 且未 stale。
3. 执行纯本地预筛，构建规范化 Provider payload。
4. 用 canonical JSON 计算 SHA-256，并估算字符和 Token 数。
5. 保存 Brief/Recipe/Provider 快照、Segment 白名单、统计和 15 分钟有效期。
6. 返回精确 EgressPreview，不返回密钥、路径或 fingerprint。

create_generation 再次重建 payload 并比对哈希，然后原子创建 Consent、Generation、
Invocation 和 Job。Job input_json 只保存 Generation ID 与 payload hash。

Prompt 不落盘。Worker 根据不可变快照和 Segment 白名单重建同一 canonical payload；
哈希不一致时在网络调用前失败。

## 10. Planning Job runner

扩展 JobService 注入 planning_runner，保持现有 runner 模式：

- candidate_generation 使用 resource_class=network。
- 开始前再次检查 Consent、凭据和 payload hash。
- 即将发送请求时，将 Consent 标记 consumed、Invocation 标记 running。
- 收到响应后先限制大小、解析 JSON，再由 PlanningService 完整校验。
- 3 个候选全部成功后，在一个事务中完成 CandidatePlan、Invocation 和 Generation。
- 外部错误只保存统一 code 和安全消息，响应正文不得进入 error_message。
- 取消 HTTP task，并记录 provider_may_have_processed=true。
- 重启时 running Job 变 interrupted。
- AI Job 禁止通过通用 retry 直接重发，必须重新 prepare 和 confirm。

JobService.get 和事件归一化增加泄漏测试，确保正文、Prompt、Provider 响应和密钥不进入 DTO。

## 11. SQLite v4

database.py 新增 V4_SQL，沿用现有备份、checksum 和事务迁移规则。

| 表 | 作用 |
|---|---|
| project_briefs | 当前 Brief，可更新 |
| provider_configs | 非秘密 Provider 配置 |
| recipe_snapshots | 每次生成的不可变 Recipe |
| egress_previews | 本地外传快照、白名单、哈希、过期时间 |
| egress_consents | 一次性授权和消费状态 |
| candidate_generations | 生成批次、Brief/Provider 快照和 Timeline 基线 |
| provider_invocations | 调用审计、usage、费用和错误分类 |
| candidate_plans | 不可变候选文档和哈希 |
| candidate_adoptions | 候选到 Timeline Revision 的不可变关系 |

jobs 表新增 provider_invocation_id 和 candidate_generation_id 可空外键。禁止把 Egress 正文
或 Provider 原始响应写入 jobs.input_json。不可变表增加 no_update/no_delete trigger；索引覆盖
Project 时间顺序、Generation 关系、Invocation 状态和 Egress 过期清理。

迁移测试覆盖空库 v1-v4、真实 v3 数据副本升级、备份、checksum、幂等、未知版本拒绝、
不可变 trigger 和失败回滚。

## 12. Core API

短期保持现有 app.py 路由风格，但领域规则必须留在 PlanningService 和 Provider 端口。

新增严格 Pydantic Request：BriefPutRequest、ProviderCreateRequest、ProviderPatchRequest、
ProviderTestRequest、EgressPrepareRequest、CandidateGenerationCreateRequest、
CandidateAdoptRequest 和 InternalProviderSecretRequest。

CoreState 注入 RecipeRegistry、ProviderRepository、ProviderSecretVault、PlanningService、
PlanningCoordinator，并将 planning_runner 注入 JobService。

错误映射遵循契约：本地输入 400/422，冲突 409，外部 Provider 错误 502/503。
任何上游响应正文和 Header 都不得进入 detail。

## 13. Electron Main 与 Preload

修改：

- apps/desktop/electron/main/index.ts
- apps/desktop/electron/main/core-admin-client.ts
- apps/desktop/electron/preload/index.ts
- apps/desktop/src/env.d.ts

新增白名单 IPC：

- brief:get、brief:put
- recipe:list、recipe:get
- provider:list、provider:create、provider:update、provider:set-secret、provider:delete-secret、
  provider:test
- planning:prepare、planning:create、planning:list、planning:get、planning:adopt

Provider secret 在 Renderer 到 Main IPC 后直接进入 safeStorage 和 internal API；Main 只返回
credential_status，不回显 secret。

Candidate Clip 播放复用 RestrictedMediaRegistry 的 asset ticket。Renderer 得到短期 media_url
和 source_start_us/source_end_us，不得到原始路径。

## 14. Desktop UI

在现有工作台增加“AI 粗剪”视图，不做营销式落地页。

工作流：

1. Brief 编辑区：主题、受众、时长、目标、风格、保留/禁止项、原声、字幕和布局。
2. Recipe 选择：紧凑列表或单选菜单，展示名称和规则摘要。
3. Provider 设置：配置表、凭据状态、连接测试、错误状态和可选单价。
4. 素材范围：选择 ready Transcript；缺失或 stale 时引导回转录流程。
5. 外传确认对话框：精确数据、目标 origin、字符/Token 数和费用提示。
6. 生成进度：可取消，显示可理解 stage；失败保留可执行原因。
7. 候选比较：3 列摘要，选择后在同一播放器和片段列表中审阅，避免嵌套卡片。
8. 采用确认：说明将替换当前 Timeline、可以 Undo，草稿冲突时必须先处理。
9. 采用后切回编辑视图，并沿用当前 Preview/Export 控件。

候选名称显示为“稳妥版、紧凑版、高能版”，不暴露 balanced/compact/bold。
model_score 只显示为“模型参考”，不显示虚假的百分比准确率。

状态必须覆盖：无 Brief、无 Provider、无 Key、连接失败、无 ready Transcript、准备中、待确认、
调用中、取消中、失败、无效响应、成功、候选 stale、采用冲突和采用成功。

## 15. 候选采用编译

PlanningService.adopt_candidate 不直接接受模型 Timeline 或公开 TimelinePatch。

1. 校验 Project、Candidate hash、Generation Timeline 基线和 adoption 唯一性。
2. 拒绝存在未处理 Timeline Draft 的项目。
3. 从数据库重新加载 Segment、Transcript、Asset 和 fingerprint。
4. 按 Candidate Clip 顺序构造视频 Clip。
5. 按 Brief 的布局、原声和字幕策略构造 Caption。
6. 调用 TimelineService 新增的内部 create_revision_from_document 方法。
7. 复用 Timeline 完整校验、canonical hash 和时间规范化。
8. 单事务创建 Revision 与 Adoption，更新 current pointer 并清空 redo。

TimelineService 的公开 Patch v1 不增加 AI 专用 operation，避免污染已冻结契约。

## 16. 测试策略

### 16.1 单元测试

- Brief 规范化、边界、哈希和恶意控制字符。
- Recipe manifest、版本、hash 和能力约束。
- 中文/中英混合预筛、稳定排序、must_keep、去重和上限。
- canonical payload 与 hash 稳定性。
- Provider URL 安全、JSON Schema、响应上限、错误分类和取消。
- Candidate 引用、连续性、时长、3 变体和整批原子性。
- adopt 基线、draft、fingerprint、stale、重复采用和 Undo。
- SecretVault 不持久化和日志脱敏。

### 16.2 契约与集成

- TypeScript/Pydantic DTO 对齐和敏感键拒绝。
- SQLite v4 迁移及 v3 真实库升级。
- prepare 不产生网络请求。
- confirm hash 变化、过期和重复消费。
- Mock Provider 的成功、认证、限流、超时、断网、大响应和错误 JSON。
- Job 取消、中断、重启、禁止直接 retry 和无部分候选。
- Candidate adopt 后 Timeline、Preview、Export API 继续工作。

### 16.3 真实 Electron 和安装包

- safeStorage 持久化后重启，Key 仍可用于连接但不可读回。
- 真实 Provider 生成 3 个候选，记录请求 origin、字段清单、usage 和估算费用。
- 逐片段和连续试播使用受限 URL，不暴露路径。
- 采用候选、Undo、Redo、权威预览和最终导出。
- 安装包包含 Recipe、httpx/证书和 Core v4 迁移。
- 日志、SQLite 可公开字段、Renderer DTO 和验收产物扫描不到哨兵 Key。

### 16.4 阶段 1 回归

- Desktop Vitest 全量。
- Core Pytest 全量与覆盖率门禁。
- 阶段 1A、1B、1C 真实 Electron 顺序回归。
- 安装包 ASR 到 Timeline 到 Preview 到 Export。

## 17. 开发任务拆分

任务按安全边界拆成两个顺序切片。两名开发职责对等，但为避免共享契约和 API 文件冲突，
先完成 Core API，再开始 Desktop 对接。

### 17.1 ZhangSan：Core Planning 与 Provider

文件所有权：

- services/core/src/aivs_core/planning.py
- services/core/src/aivs_core/providers.py
- services/core/src/aivs_core/database.py
- services/core/src/aivs_core/jobs.py
- services/core/src/aivs_core/timeline.py
- services/core/src/aivs_core/config.py
- services/core/src/aivs_core/app.py
- services/core/tests/**
- resources/recipes/**
- pyproject.toml、uv.lock

责任：SQLite v4、Brief/Recipe、Egress、Provider 端口、Invocation、Candidate、adopt、
Planning Job runner、错误分类、取消/中断和 Core 安全测试。

禁止：不修改 Desktop UI 或 Electron safeStorage；不更改阶段 1 TimelinePatch 和 Render Plan；
不保存密钥、Prompt、原始响应或 Egress 正文到 Job。

### 17.2 YeJing：Contracts、Electron 安全桥与 UI

Core API 稳定后开始。文件所有权：

- packages/contracts/src/index.ts
- apps/desktop/electron/main/provider-secrets.ts
- apps/desktop/electron/main/index.ts
- apps/desktop/electron/main/core-admin-client.ts
- apps/desktop/electron/preload/index.ts
- apps/desktop/src/env.d.ts
- apps/desktop/src/app/App.tsx
- apps/desktop/src/styles.css
- apps/desktop/tests/**
- apps/desktop/e2e/**
- 打包脚本和清单中仅与新资源相关的部分

责任：契约守卫、safeStorage、internal secret 注入、白名单 IPC、完整 AI 粗剪 UI、
受限 Candidate 播放、Job 状态、采用和阶段 1 UI 回归。

禁止：不在 Renderer 保存或读取明文 Key；不绕开 Core 校验生成 Timeline；
不重新定义 API、错误码或候选采用语义。

### 17.3 集成约束

- packages/contracts/src/index.ts 归 YeJing；ZhangSan 依据冻结文档实现 Pydantic。
- app.py 和 Electron main/index.ts 不允许交叉修改。
- ZhangSan 先交付可由 Mock Provider 验证的 Core API；YeJing 再对接。
- 两人不得回退用户修改或提交 .pnpm-store/、fix_mojibake.py 和生成产物。
- 集成后各自运行模块测试，再由 LiuKeAi 独立验收。

## 18. LiuKeAi 验收清单

LiuKeAi 不修改生产代码或正式测试，逐项输出通过、未通过或未验证：

1. 审查全部 diff、迁移、依赖、打包清单和敏感信息边界。
2. 运行 Core、Contracts、Desktop 全量测试和覆盖率。
3. 用网络记录证明 prepare 阶段零外传，confirm 只发送预览中的字段。
4. 用真实 Provider 生成 3 个候选，核对 Invocation、usage、费用和内容差异。
5. 故障注入认证、限流、超时、断网、大响应、无效 JSON、Schema 错误、取消和重启。
6. 扫描 SQLite、日志、Job/Event/Renderer DTO、崩溃证据和密钥文件，确认无明文 Key。
7. 采用候选后核对 Timeline 引用、Undo/Redo、Preview 和 Export。
8. 顺序执行阶段 1 真实 Electron 回归。
9. 构建安装包，验证 v3 升 v4、safeStorage、Recipe、Provider、Preview 和 Export。
10. 记录环境、命令、版本、证据绝对路径、SHA-256 和剩余风险。

真实 Provider、真实网络、真实 Electron 或安装包任一闭环未执行时，不得用 Mock 或局部测试
替代“完整通过”结论。

## 19. 实施门禁

进入编码前必须满足：

- [x] 用户确认 STAGE2A_CONTRACT_FREEZE.md。
- [x] 用户确认本详细设计的阶段拆分、外传策略、Provider 范围和 adopt 语义。
- [x] 文档状态和文件名已冻结为 stage2a-v1。
- [ ] 后续新会话由 LiuWei 向 ZhangSan 发出完整 Core 开发交接。
- [ ] Core API 稳定后，由 LiuWei 向 YeJing 发出 Desktop 开发交接。
- 未取得 LiuKeAi 独立验收报告前，不宣称阶段 2A 开发完成。
