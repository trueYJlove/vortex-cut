# Stage 4B 契约冻结草案：生成任务验证工作台

> 负责人：LiuWei（架构师）
> 状态：已确认冻结；Gate 4B-1 至 Gate 4B-4 通过；Gate 4B-5 已授权，随本次 PR 合并主干后通过
> 日期：2026-08-18
> 基线：`38eb2f4 Merge pull request #1 from trueYJlove/codex/stage4a-production`
> 上位契约：`docs/design/STAGE4_CONTRACT_FREEZE.md`、`docs/design/STAGE4_DETAILED_DESIGN.md`

## 1. 冻结建议

Stage 4B 推荐只把 Stage 4A 已完成的 `simulation_only` 生成领域接入正式 Desktop 交互，形成可操作、可恢复、可验收的“生成任务验证工作台”。本阶段不是实际媒体生成阶段。

冻结建议如下：

- 复用 Stage 4A 的 `image | tts`、不可变 Request、Task/Job、retry lineage 和七个 API；
- Renderer 提供准备、确认、创建、历史、任务状态、取消与重试交互；
- `execution_mode` 继续且只能为 `simulation_only`；
- Provider 调用数必须为 `0`，成功结果只能显示“校验完成，未生成媒体”；
- 不创建文件，不注册 Asset，不写 Timeline，不触发 Preview、Render 或 Export；
- 不新增 API、DTO、IPC channel、Preload 方法或 SQLite 迁移；数据库版本保持 v11；
- 不改变 `CONTRACT_VERSION = "stage3b-v1"`；
- 不改变 Stage 1–3B 与 Stage 4A 已冻结行为；
- README 继续不在范围内。

“正式工作台”只表示进入产品 Renderer 和 Windows 安装包的正式可达交互，不表示真实 Provider 或真实媒体已经可用。所有界面必须持续显示“模拟验证、Provider 0 次、不生成媒体”的边界提示。

## 2. 现状盘点

Stage 4A 已提供：

1. SQLite v11 的 `media_generation_requests` 与 `media_generation_tasks`；
2. prepare/create/list/get/tasks/retry/cancel 七个 Core API；
3. 对应 Contracts DTO、guards、Core Client、七个 Electron IPC channel 和七个 Preload 方法；
4. `simulation_only` runner、Task/Job 原子终态、漂移恢复和重试谱系；
5. Provider=0、无媒体、无 Asset 的安全边界。

尚未提供：

- Renderer 正式入口和交互状态机；
- 用户可见的 Request/Task 历史、取消和重试；
- 安装包内的 Stage 4A/4B 业务操作验收；
- 真实图片、TTS、Provider、费用和 Asset 注册。

Stage 4B 只关闭前三项中的 UI 与安装包验证缺口，不提前关闭真实生成缺口。

## 3. 候选方向比较

### 3.1 候选 A：`simulation_only` 生成任务验证工作台（推荐）

**用户价值与问题**

- 用户可以从正式桌面界面验证一条生成请求如何准备、确认、排队、完成、取消和重试；
- 重启后可查看历史及 interrupted 状态，不再只能通过 API 或测试操作 Stage 4A；
- 提前验证隐私文案、状态表达和失败恢复交互，为真实 Provider 接入降低返工风险。

**与 Stage 4A 的边界**

- Stage 4A 是领域与接口生产骨架；Stage 4B 仅增加正式 Renderer 编排和真实 Windows 交互验收；
- 不修改 Request/Task/Job 语义，不把模拟成功解释为媒体生成成功。

**技术影响**

- Core：原则上零变更；发现 Stage 4A 缺陷时必须单独登记并最小修复；
- SQLite：零变更，保持 v11；
- Contracts：零公开类型变更；Renderer 可定义私有 view state；
- Desktop/Electron：复用现有 Core Client、IPC 和 Preload，新增 Renderer 组件、样式与测试；
- Windows 打包：不改变构建配置，增加安装后正式交互验收。

**迁移与兼容**

- 无数据迁移；已有 v11 项目直接显示历史；空历史项目显示空状态；
- 老项目在现有迁移器升级到 v11 后可使用；未知版本仍 fail-closed；
- 不修改既有 Stage 1–3B 页面和操作。

**隐私、安全与 Provider 边界**

- Prompt 只存在于当前受控表单内存和一次命令参数中；不进入响应 DTO、日志、持久 store、截图证据或历史卡片；
- UI 只展示 Prompt hash、Request hash、白名单参数和 input ref 数量；
- 不显示绝对路径、字幕/转写正文、原始异常、stderr、command 或 traceback；
- Provider 调用数固定为 0。

**验收成本与风险**

- 成本：中等，集中在复杂单页应用中的状态隔离、快速任务完成竞态、重启恢复和 Windows 安装验证；
- 风险：用户误解为真实生成；通过命名、固定警示和结果文案控制；
- 可拆分为 Renderer 状态机、历史/操作、测试、Windows 验收四个切片。

**推荐理由**

以最小架构增量关闭 Stage 4A 最大的未验收面，不同时引入网络、凭据、计费、文件和 Asset 生命周期。

### 3.2 候选 B：接入单一真实图片或 TTS Provider（不推荐本阶段）

**用户价值与问题**

可真正产出图片或音频，是阶段 4 的直接业务价值。

**与 Stage 4A 的边界**

会把 `simulation_only` 扩展为真实执行，并要求输出媒体和来源溯源；这不是 Stage 4A 的 UI 收尾，而是新的高风险能力面。

**技术影响**

- Core：新增 Provider adapter、网络超时/取消/重试、文件原子落盘、内容校验和 Asset 注册；
- SQLite：至少需要 Provider/模型/费用/输出溯源设计，可能进入 v12；
- Contracts：扩展执行模式、结果摘要、外传确认、能力探测和费用 DTO；
- Desktop/Electron：凭据配置、外传确认、Provider 状态和生成结果预览；
- Windows：网络、证书、代理、防火墙、凭据保护和安装升级真实验收。

**迁移与兼容**

需要明确 v11 模拟记录与真实记录共存规则；不得原地改变既有 Request 的执行模式；真实 retry 还涉及费用和幂等语义。

**隐私、安全与 Provider 边界**

必须处理密钥、Prompt 外传、参考素材上传、供应商保留策略、费用和版权溯源，Provider 调用数不再为 0。

**验收成本与风险**

高；真实账号、配额、网络故障、内容质量、媒体格式、费用和安装环境必须全部验证，预计至少拆成 Provider 契约、隔离原型、生产适配、Asset 注册、Renderer、独立真实验收六个 Gate。

**不推荐理由**

与正式 UI、Asset 注册和 Provider 安全同时推进会把多个大功能捆绑在一个阶段，不符合适中范围原则。

### 3.3 候选 C：脚本/分镜到资产需求清单（不推荐本阶段）

**用户价值与问题**

把创作意图拆成可审阅的镜头与资产需求，为后续漫剧/短剧工作流奠定基础。

**与 Stage 4A 的边界**

它是 Stage 4 的上游规划领域，不直接验证 Stage 4A 的 Request/Task 正式交互；若同时连接生成任务，会产生新的跨领域依赖。

**技术影响**

- Core/SQLite：新增不可变需求清单、版本、镜头顺序、状态与生成请求引用；
- Contracts：新增清单、镜头、资产需求和应用 API；
- Desktop：新增编辑、排序、确认和差异交互；
- Electron/Windows：新增一组正式入口与大规模 UI 验收；
- 若自动生成脚本，还会再次引入文本 Provider 和外传确认。

**迁移与兼容**

需要与 Brief、candidate plan、TimelineRevision、Asset 和 MediaGenerationRequest 明确归属，不得复用或污染既有 Stage 2 表。

**隐私、安全与 Provider 边界**

脚本、分镜和角色设定可能是敏感创作正文；必须重新冻结持久化、Renderer 和外传策略。若仅手工编辑可保持 Provider=0，但业务闭环有限。

**验收成本与风险**

中高；领域建模和 UI 规模显著高于候选 A，且易与真实生成、Timeline 自动装配一起范围膨胀。

**不推荐理由**

应在生成任务正式交互稳定后作为独立阶段规划，不能作为 Stage 4B 的附带功能。

## 4. Stage 4B 范围

### 4.1 包含

1. 当前项目下的独立“生成任务验证”入口；
2. `image | tts` 两种模拟请求表单；
3. 使用项目内已有 Asset ID 作为 `input_refs`，至少 1 项、最多 32 项；
4. prepare 后的本地确认步骤；
5. create 后的 Request/Task 状态展示；
6. Request 历史分页与其 Task 尝试列表；
7. 合法状态下的 cancel 和 retry；
8. 创建后立即回读、Job 事件触发刷新以及可见期间的受控轮询；
9. 项目切换、关闭工作台和组件卸载时清除 Prompt 与未提交确认；
10. Renderer 单元测试、IPC/Contracts 回归、Core 回归、Windows 打包安装与启动交互验收。

### 4.2 不包含

- 真实图片、真实 TTS、视频生成或 Batch；
- 任何真实 Provider、SDK、网络请求、能力探测、密钥、费用或配额；
- 新建或扩展 `provider_configs`、`provider_invocations`；
- 媒体文件、Asset 注册、`assets.storage_mode` 扩展或 Timeline 装配；
- Prompt 历史、Prompt 模板库、脚本/分镜、角色/场景/风格资产管理；
- 新 API、DTO、IPC channel、Preload 方法或 SQLite v12；
- Stage 3A/3B Batch、Snapshot、Preview、Retry 或导出行为修改；
- README 修改。

## 5. 用户交互契约

### 5.1 入口与命名

- 入口名称必须包含“生成验证”或同等明确含义，不得只写“生成素材”；
- 工作台标题固定表达“模拟验证”；
- 首屏、确认页和结果页均显示：`Provider 调用 0 次，不生成媒体，不注册素材`；
- 未选择项目时入口禁用或显示“请先选择项目”，不得创建游离请求。

### 5.2 表单

- 图片：Prompt、1–32 个 input refs、width、height、可选 style preset ID、可选 seed；
- TTS：Prompt、1–32 个 input refs、voice preset ID、language、speed；
- Renderer 限制必须与现有 Contracts guard 一致，但 Core 始终是最终校验权威；
- input refs 只能从当前项目已加载的 Asset 中选择；Renderer 不提交路径或媒体正文；
- 不自动读取字幕、转写或文件内容填充 Prompt。

### 5.3 Prepare 与确认

- 点击准备后调用既有 `prepareMediaGeneration`；
- 确认页只显示 kind、`simulation_only`、input ref 数量/显示名、安全参数、`prompt_sha256` 和 `request_sha256`；
- Prepare 响应不得回显 Prompt；Prompt 只保留在当前表单内存，以便一次 create；
- 任一表单字段变化都使旧确认失效，必须重新 prepare；
- 项目切换、关闭工作台或创建结束后，旧确认失效并清除 Prompt；
- create 必须提交原字段与 Core 返回的 `request_sha256`，Core 继续执行 hash 复核。

### 5.4 状态与结果

- UI 状态映射覆盖 `queued | running | succeeded | failed | cancelled | interrupted`；
- succeeded 且 `validated_without_media` 显示“验证完成，未生成媒体”；
- `output_asset_id` 与 `output_sha256` 必须为空；若响应违反该不变式，Contracts guard 拒绝，UI 显示安全通用错误；
- UI 不自行推导或写入权威 Task 状态；Task 列表响应是生成状态权威；
- Job 订阅只用于触发刷新，不作为生成 Task 的最终事实来源；
- 创建后必须立即回读 Task，避免快速终态事件在订阅建立前丢失；
- 轮询仅在工作台可见且存在非终态 Task 时运行，终态、关闭、项目切换或卸载后立即停止。

### 5.5 Cancel 与 Retry

- 只有 `queued | running` 显示可用取消操作；重复取消按 Core 当前契约处理；
- 只有 `failed | cancelled | interrupted` 显示可用重试操作；
- retry 创建新 Task/Job 和新 attempt，不覆盖原任务；
- `succeeded` 不允许 retry；
- 操作后立即刷新对应 Task 列表；UI 不乐观伪造终态。

### 5.6 历史与空状态

- 历史按既有 API 顺序和 cursor 分页，不在 Renderer 重排为另一权威顺序；
- Request 卡片不显示 Prompt 正文、路径、转写/字幕正文或原始异常；
- 同一 canonical Request 重用时，UI 明确显示“复用既有请求”；
- 空历史、加载失败和项目不存在均有可恢复、安全、不泄密的提示。

## 6. API / DTO / SQLite 冻结

### 6.1 API

Stage 4B 不新增路由，完整复用：

- `POST /api/v1/projects/{project_id}/media-generation-requests/prepare`
- `POST /api/v1/projects/{project_id}/media-generation-requests`
- `GET /api/v1/projects/{project_id}/media-generation-requests`
- `GET /api/v1/media-generation-requests/{request_id}`
- `GET /api/v1/media-generation-requests/{request_id}/tasks`
- `POST /api/v1/media-generation-tasks/{task_id}/retry`
- `POST /api/v1/media-generation-tasks/{task_id}/cancel`

不得为 UI 便利添加聚合、Prompt 回读或 Task 单项详情 API。

### 6.2 DTO / Contracts

- 公开 DTO 变更：无；
- 枚举变更：无；`GenerationExecutionMode` 仍只有 `simulation_only`；
- Renderer 私有状态不得从 `packages/contracts` 对外导出；
- `CONTRACT_VERSION` 保持 `stage3b-v1`；
- 现有 guard 继续拒绝额外字段、敏感键和不一致终态。

### 6.3 SQLite

- 数据库版本保持 v11；
- 表、列、索引、触发器和既有 migration checksum 零变更；
- 不新增 UI 偏好表，不持久化 Prompt、表单草稿或确认对象；
- 不直接从 Renderer/Electron 访问 SQLite。

### 6.4 Electron / Preload

- 继续复用七个 `media-generation:*` channel；
- 不开放通用 fetch、文件路径、数据库或 Provider 能力；
- 所有响应保持 `rendererSafe` 后再经 Contracts parser；
- 不把原始异常对象传入 Renderer。

## 7. 隐私与安全

1. Provider 调用数必须为 0；测试使用 fail-on-call 哨兵；
2. 不读取、输出或记录 Provider token、API key、Authorization 或 Provider 请求载荷；
3. Prompt 不写 SQLite、日志、持久 store、错误、历史、测试快照或验收证据；
4. 面向 Renderer 的响应不得包含绝对媒体路径、字幕/转写正文、原始异常、stderr、command 或 traceback；
5. UI 可在受控输入框中显示用户正在输入的 Prompt，但不得复制到 DOM data attribute、隐藏字段、URL、title、aria-label 或日志；
6. 测试使用合成非敏感文本，截图和 trace 不包含真实用户内容；
7. 项目切换、关闭和卸载必须清理表单与订阅，避免跨项目数据残留；
8. CSP、context isolation、固定 IPC 白名单和现有 Sidecar 鉴权保持不变。

## 8. 兼容与迁移计划

- **v11 直接兼容**：不迁移，读取既有 Stage 4A Request/Task；
- **v1–v10 项目**：仍由现有初始化流程升级至 v11，Stage 4B 不修改迁移器；
- **未来真实生成**：不得把既有 `simulation_only` Request 原地升级；应新建执行模式和新请求事实，并另行冻结；
- **降级行为**：旧版本应用忽略新 UI 代码，不存在新数据格式；数据库仍为 v11；
- **回滚**：因无数据迁移，可回退应用版本；Stage 4B 创建的记录仍是合法 Stage 4A v11 记录。

## 9. 角色职责与文件所有权

角色定义不约束串行或并行执行方式；恢复 subagent 后可按互斥写集并行推进。

### LiuWei（架构与集成）

- 维护范围、契约、Gate、跨域边界和最终集成决策；
- 负责 `docs/STAGE4B_*.md`；
- 不以架构便利为由扩大 Provider、Asset、Timeline 或数据库范围。

### ZhangSan（Core / SQLite / Jobs）

- 核对现有七个 API、v11、恢复、取消和 retry 是否足以支持 UI；
- 生产阶段默认只读 Core；只有独立复现出 Stage 4A 契约缺陷时才提交最小修复；
- 若需修复，独占 `services/core/src/aivs_core/**` 与对应 Core 测试，不修改 Desktop 文件。

### YeJing（Contracts / Desktop / Electron / Windows）

- 负责 Renderer 工作台、私有 view state、样式、组件测试、E2E 与 Windows 交互验证；
- 预计独占 `apps/desktop/src/app/App.tsx`、可新增的 Renderer 组件目录、`apps/desktop/src/styles.css`、Desktop 测试和 E2E；
- 默认不修改 Contracts、`stage4-ipc.ts` 和 Preload；若发现契约缺口必须返回 Gate 重新冻结，不得自行加 channel。

### LiuKeAi（独立审查与验收）

- 独立验证范围、隐私、竞态、重启、安装包和 Stage 1–4A 回归；
- 不参与生产实现写集；验收记录写入独立文档；
- 对 Provider 非零、媒体/Asset 出现、Prompt 泄漏或契约扩张拥有阻断权。

## 10. 门禁

### Gate 4B-1：范围与契约冻结（已通过）

通过条件：

- 唯一范围确认为模拟生成任务工作台；
- API/DTO/SQLite 变更均为 0；
- 用户确认 UI 命名、边界提示、历史范围与 Windows 验收要求；
- 两份文档一致且工作区只有预期文档变化。

当前状态：2026-08-18 用户已接受第 12 节全部七项建议，Gate 4B-1 通过。

### Gate 4B-2：隔离交互原型（已通过）

通过条件：

- 使用 fake `window.desktop` 验证 form→prepare→confirm→create→terminal；
- 验证字段变化/项目切换使确认失效；
- 验证快速终态不会因订阅竞态丢失；
- 验证 Prompt 不进入响应、历史、日志、快照；
- 不连接真实 Provider，不产生媒体。

当前状态：2026-08-18 隔离交互模型、8 个定向用例、全量回归与隐私扫描通过；详见 `docs/design/records/STAGE4B_PROTOTYPE_VALIDATION.md`。

### Gate 4B-3：生产实现与开发验证（已通过）

当前状态：2026-08-18 正式 Renderer 入口、独立工作台、历史、状态刷新、cancel/retry、隐私防护与开发验证通过；详见 `docs/design/records/STAGE4B_PRODUCTION_VALIDATION.md`。

通过条件：

- 正式 Renderer 入口、工作台、历史、cancel/retry 完成；
- Core、SQLite、Contracts、IPC/Preload 冻结边界未变化；
- 定向、全量、lint、typecheck、build 和隐私扫描通过；
- Provider=0，无媒体、无 Asset。

### Gate 4B-4：独立真实验收（已通过）

当前状态：2026-08-18 开发态真实 Electron + Sidecar、全新 NSIS 构建、实际安装、原位重装、重启恢复、卸载及隐私取证通过；详见 `docs/design/records/STAGE4B_INDEPENDENT_ACCEPTANCE.md`。

通过条件:

- 开发环境和真实 Windows 安装包均可完成模拟流程；
- 覆盖重启恢复、快速完成、取消、重试、项目切换和空历史；
- 安装、启动、升级兼容和卸载边界可复核；
- Provider=0，磁盘中无生成媒体，数据库无 Prompt，Renderer/日志无禁止字段；
- Stage 1–4A 全量回归通过。

### Gate 4B-5：收尾（已授权；合并主干后通过）

通过条件：

- 独立验收通过；
- 文档记录与实现一致；
- 经授权后提交、推送、PR/MR、合并并同步主干；
- 真实 Provider 仍标记 `UNVERIFIED`，不得随 Stage 4B 合并获得隐式授权。

## 11. 变更控制

以下任一变化必须停止实施并重新确认契约：

- Provider 调用数从 0 变为非 0；
- 增加真实媒体、Asset、Timeline、Batch 或视频生成；
- 修改 API、DTO、IPC、Preload、SQLite v11 或 `CONTRACT_VERSION`；
- 持久化 Prompt 或增加 Prompt 历史；
- 修改 Stage 1–3B 或 Stage 4A 冻结行为；
- 把脚本/分镜或角色/场景/风格管理并入 Stage 4B。

## 12. 已确认冻结项

2026-08-18，以下建议已全部确认并冻结：

1. 接受候选 A 作为 Stage 4B 唯一范围；
2. 工作台使用“生成任务验证（模拟）”的明确命名；
3. API、DTO、IPC、Preload 零新增，SQLite 保持 v11；
4. Prompt 仅保留在当前表单内存，不提供草稿恢复或历史回显；
5. Windows 安装包真实交互属于 Gate 4B-4 必验项；
6. Provider 调用数继续固定为 0；
7. README 暂不处理。
