# Stage 4D 契约冻结：受控真实图片生成与 Asset 注册

> 负责人：LiuWei（架构师）
> 当前基线：`master` / `799ef8e`
> 契约版本：`stage4d-v3`（原生尺寸兼容修订）
> 数据库目标版本：SQLite v14
> 状态：Gate 4D-5 收尾门禁已通过；Stage 4D 已完成，等待版本控制收口
> README：本阶段暂不处理

## 1. 唯一冻结范围

Stage 4D 只交付一个受控闭环：**使用一个固定第三方图片协议，根据单条文本指令请求一张 1K PNG，保留 Provider 返回的原生像素尺寸，并注册为项目受管 Asset，保存可审计 provenance**。

冻结边界：

1. 一个逻辑 Task 最多一次 Provider dispatch，禁止自动 retry；
2. 一次请求固定 `n=1`，只接受一张完成图片；
3. 首个真实 Gate 只开放 `size=1024x1024` 请求意图（Provider 价格档位 `1K`）；该参数不再承诺输出严格等于 1024×1024；
4. 不支持 2K 像素规格、参考图、局部编辑、Batch、第二 Provider、任意 URL/Header、TTS、视频生成或 Timeline 自动装配；
5. 不修改 Stage 1–3A 及 Stage 4A/4B/4C 已冻结行为；
6. Stage 4A/4B 的 `simulation_only` 仍保持 Provider 调用数为 0；
7. 成功结果必须先完成防御性解码、原生尺寸安全上限/hash 校验、原子落盘和事务注册，才能进入 `succeeded`；
8. Provider 或本地处理失败不得产生伪 Asset、伪 Provenance 或 Timeline 副作用。

## 2. 固定 Provider 协议

### 2.1 身份

```text
provider_kind      = apikey_fun_images
adapter_id         = apikey_fun_images_sse_v1
capability         = image_generation
protocol_version   = 1
model              = gpt-image-2
endpoint_identity  = apikey_fun_images_generations
```

`endpoint_identity` 是可持久化身份；Renderer DTO 不暴露可编辑 endpoint。新 adapter 不得伪装成官方 OpenAI，也不得作为“OpenAI-compatible”通用入口。

### 2.2 出站请求

```text
POST https://api.apikey.fun/v1/images/generations
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <仅在内存中取得的凭据>

model           = gpt-image-2
prompt          = <瞬时明文>
n               = 1
size            = 1024x1024
stream          = true
response_format = b64_json
```

冻结要求：

- 禁止 redirect、环境代理和自动 retry；
- connect timeout 为 15 秒，总 timeout 为 900 秒；
- dispatch 前取消时调用数为 0；dispatch 后出现连接、超时或传输异常时，保守记录 `provider_may_have_processed=true`；
- 只有 `Content-Type: text/event-stream` 可进入解析；
- 只接受唯一一个 `image_generation.completed` 事件；
- 图片字段兼容 `event.b64_json` 与 `event.data[0].b64_json`；
- SSE envelope 与解码图片均有大小上限，响应仅增量 hash，不保存原始 envelope、事件或 base64；
- Provider request ID 与 usage 只保存白名单安全字段；未知字段一律丢弃。

### 2.3 输出

仅接受有效、单帧 PNG。`size=1024x1024` 是请求意图，不是输出尺寸等式。Core 必须在完整解码前从 PNG IHDR 检查宽高：宽、高均须为正整数且不超过 4096，总像素不超过 16,777,216；解码后尺寸必须与 IHDR 一致。图片最大 25 MiB。接受边界内的原生宽高且不执行 resize、crop、pad、拉伸、重编码或格式转换。公开 DTO 返回最终受管 Asset 标识、实际格式、实际宽高、字节数和原始 Provider 图片 SHA-256，不返回路径、URI、原始响应或 base64。

## 3. 价格与验收预算

Provider 公示价格事实按人民币记录：

```text
1K：CNY 0.10 / 张
2K：CNY 0.15 / 张
```

本阶段只开放 1K。`CNY 0.15 / 2K` 仅作为供应商公示信息保存在配置/展示层；在供应商没有明确像素映射前，不允许把 2K 猜测成某个尺寸，也不允许创建 2K Task。

Provider 配置、Prepared DTO 和 Invocation 中的价格语义：

```text
price_per_image           = 0.10
price_2k_per_image        = 0.15
price_currency            = CNY
estimated_cost            = 0.10
estimated_cost_currency   = CNY
price_tier                = 1K
```

Gate 4D-4 的 USD 2 是独立验收预算，不是 Provider 报价币种，不进入产品价格 DTO。验收台账冻结为：

```text
此前官方端点失败 dispatch 的保守历史估算：USD 0.25
既有 apikey.fun 失败 dispatch 的保守估算：USD 0.15
D2 全新 apikey.fun 成功 dispatch 的保守估算：USD 0.15
当前保守累计：USD 0.55 / USD 2
```

每次调用前必须验证“预计调用后累计不超过 USD 2”。调用次数无固定上限不代表允许自动 retry、循环调用或无验收价值的重复调用。

## 4. Prompt、凭据和隐私

1. Prompt 明文只允许存在于 Renderer 当前表单、Core 有界 TTL 内存 vault 和一次出站请求；
2. SQLite 只保存 `prompt_sha256`，不得保存 Prompt、字幕/转写正文或请求 JSON；
3. Prepared DTO 不回显 Prompt，只返回 hash、Provider 身份、尺寸、价格、安全外传说明和过期时间；
4. 凭据只允许经 Electron `safeStorage` 保存，并通过 Admin 通道重注入 Core 内存；Renderer DTO 只能看到 `configured/missing`；
5. API key、Authorization、payload、原始 SSE、base64、原始异常和真实绝对路径不得进入日志、DTO、数据库、截图、trace 或验收证据；
6. E2E 真实模式关闭 screenshot、video 和 trace；
7. Provider 输出一律按不可信字节处理；
8. Provider 内容政策、版权和商业使用条件由用户与供应商协议决定，产品不作自动可商用承诺。

## 5. Request、Task、Invocation 与 Retry

### 5.1 新请求

新第三方请求必须固化完整运行时身份：Provider kind、adapter、protocol、model、endpoint identity、SSE transport、`stream=true`、`response_format=b64_json`、尺寸和 output format，并纳入 canonical profile/payload hash。

### 5.2 单次 dispatch 不变式

- `provider_call_count ∈ {0,1}`；
- `provider_may_have_processed <= provider_call_count`；
- Task 成功必须满足 `provider_call_count=1`、图片验证事实齐全、无错误、无 cleanup debt；
- dispatch 后任何未知终态不得在同一 Task 自动补发；
- 用户显式 retry 必须创建新的 lineage Task，且仍然最多一次 dispatch。

### 5.3 历史兼容

SQLite v13 中历史官方身份只读保留：

```text
openai_images / openai_images_generations_v1 / gpt-image-1
```

这些历史配置、Request、Task、Invocation 和 Provenance 不进入新的第三方工作台列表，不得被 `apikey_fun_images_sse_v1` 接管或 retry。历史失败事实保留原错误、调用计数和费用未知语义。

## 6. SQLite v14

v14 是在 v13 之上的兼容迁移，不修改 v1–v13 migration 文本或 checksum。

### 6.1 表变更

- `image_provider_configs`
  - 兼容保留 v13 官方历史身份；
  - 新增第三方身份与固定 `CNY 0.10/1K`、`CNY 0.15/2K` 价格约束；
- `provider_image_request_profiles`
  - 兼容保留 v13 官方历史 profile；
  - 新第三方 profile 只允许 `1024x1024`；
- `provider_image_invocations`
  - 新增 `estimated_cost_currency`；
  - 新增 `price_tier`；
- `generated_asset_provenance`
  - 兼容两套冻结身份，但每条记录必须匹配自身 kind/adapter/model 组合。

### 6.2 迁移不变式

- v13→v14 前自动备份；
- 迁移在单事务中执行，任一步失败整体回滚；
- v1–v13 checksum 全部不变，v14 checksum 固定；
- 历史项目、Asset、Timeline、Export、simulation、Shot List 和官方图片事实的行数/hash 保持；
- `PRAGMA foreign_key_check` 为空，`PRAGMA integrity_check=ok`；
- 旧 Core 对未知 v14 必须 fail-closed，不得降级打开；回退只能恢复升级前备份。

## 7. Contracts / API / DTO

`CONTRACT_VERSION = stage4d-v2` 保持不变；Gate 4D-4A 不改变 API/DTO 结构，只修订输出尺寸语义。文档契约标记为 `stage4d-v3`。

核心新增或冻结类型：

```text
ProviderImageSize = "1024x1024"
ImageProviderKind = "apikey_fun_images"
ImageProviderAdapterId = "apikey_fun_images_sse_v1"
ProviderImageFormat = "png"
ProviderPriceCurrency = "CNY"
ProviderPriceTier = "1K"
```

API 保持 Prepare→确认→Create/Retry→查询的窄流程：

- Provider config 创建只接受 `display_name`、`enabled`；endpoint、model、价格和 adapter 不由 Renderer 提交；
- Prepare 返回 `preview_id`、hash、固定身份、尺寸、`estimated_cost=0.10`、`estimated_cost_currency=CNY`、`price_tier=1K`；
- Create 必须校验 preview 未过期、payload hash 一致、配置与凭据可用；
- Request/Task/List 只返回安全投影；
- Result 不含 Prompt、payload、路径、URI、Provider 原始内容或原始异常；
- 所有 guard 对未知 union、额外字段、旧身份混入新列表均 fail-closed。

## 8. Desktop / Electron / Windows

- 工作台固定显示 `APIKEY.FUN Images / gpt-image-2`、`1K ¥0.10` 和供应商公示 `2K ¥0.15`；
- 请求尺寸只开放 `1024×1024（1K 请求意图）`，成功历史明确展示 Provider 实际输出宽高；
- 用户不能编辑 endpoint、model、adapter、价格或任意 Header；
- 确认弹窗显示 `CNY 0.10 · 1K` 和一次 Task 最多一次调用；
- safeStorage 的保存、删除、重启重注入保持 fail-closed；
- 图片预览只能通过受限 Asset ticket，不能把文件路径暴露给 Renderer；
- Windows 验收覆盖开发态、正式包体、NSIS fresh、v13→v14 原位升级、重启恢复和真实卸载保留。

## 9. 错误与停止线

公开错误只允许稳定安全码和固定安全文案，包括鉴权、限流、不可用、网络、超时、无效响应、图片过大、解码失败、格式错误、取消、发布或注册失败。不得把 `repr(exception)`、响应 body 或 Provider message 原样投影。

遇到以下任一情况立即停止真实调用，不 retry：

- 鉴权、网络、超时或协议异常；
- 费用未知或预计累计超过 USD 2；
- Prompt/key/path/raw payload/raw SSE 泄漏风险；
- 调用计数不精确或无法证明 Task 单次 dispatch；
- 图片验证、原子落盘、Asset/Provenance 事务不一致；
- Timeline 出现非零副作用。

## 10. 角色与所有权边界

角色定义不约束串行或并行，也不固化 subagent 使用方式。

- **LiuWei（架构）**：范围、契约、变更控制、费用/隐私停止线和最终 Gate 判定；
- **ZhangSan（Core / SQLite / Provider / Asset）**：Provider adapter、Prompt vault、v14、Request/Task/Invocation、图片校验、原子落盘、Asset/Provenance；
- **YeJing（Contracts / Desktop / Electron / Windows）**：DTO guards、工作台、IPC/preload、safeStorage、受限预览、打包安装交互；
- **LiuKeAi（独立验收）**：独立复跑迁移、单次 dispatch、隐私、恢复、Windows 与回归证据。

交叉只通过冻结 API/DTO、错误码、adapter result、Asset 内部注册接口和证据 schema 对接。同一文件如需多人修改，由文件所有者集成，禁止并发写同一文件。

## 11. Gate 状态

- **Gate 4D-1**：范围与首版契约确认，已通过；
- **Gate 4D-2**：隔离协议/图片/SQLite/Asset 原型，已通过；历史原型真实 Provider 调用为 0；
- **Gate 4D-3**：生产实现与开发验证，已通过；
- **Gate 4D-4 历史严格尺寸尝试**：已执行一次 `apikey.fun / gpt-image-2` 真实 dispatch，并按当时契约以 `GENERATED_IMAGE_DIMENSION_MISMATCH` 失败；该 Task、Invocation、调用计数和零副作用作为不可变历史保留，不追溯改判；
- **Gate 4D-4A 离线修订**：D2 原生尺寸兼容契约、最小实现和离线门禁已通过。`size=1024x1024` 仅表示 1K 请求意图；输出按 4096 最大单边、16,777,216 最大像素和 25 MiB 最大文件 fail-closed 校验，不做本地规范化；
- **Gate 4D-4 D2 独立真实复验**：已用全新 Task 完成一次真实 dispatch。Task 成功，`provider_call_count=1`，Provider 原生 PNG 为 1254×1254、1,862,105 字节；managed Asset、Invocation、Provenance 字节数与 SHA-256 一致，Timeline delta=0，SQLite v14/FK/integrity、零网络重启恢复、历史与受限预览、脱敏隐私扫描均通过；自动 retry=0，本次恢复验证新增调用=0；
- **Gate 4D-5**：收尾门禁已通过。当前源码全量回归、开发态零调用 E2E、全新 Windows x64/NSIS 包体、安装态 fresh、v13→v14 升级、重启恢复、真实卸载、隐私与证据一致性均通过；本 Gate Provider 调用增量为 0。

## 12. Gate 4D-4A 修订后独立验收清单

1. 全量 Core、Contracts、Desktop、Electron、构建与离线 E2E 先通过；
2. SQLite fresh v1→v14、v13→v14、备份、checksum、回滚、FK、integrity 全通过；
3. 只检查凭据是否存在，不打印值；
4. 调用前预算为 USD 0.40 / USD 2；
5. 新建一个隔离 Task，固定发送 `size=1024x1024` 请求意图，至多一次 dispatch；
6. SSE 唯一 completed、单帧 PNG 防御性解码、原生尺寸安全边界、字节数和 hash 通过；
7. 文件原子落盘，managed Asset 和不可变 Provenance 成功；
8. 新 Task 的 `provider_call_count=1`，调用后保守累计预算为 USD 0.55 / USD 2；
9. 受限预览和应用/Core 重启后成功事实可恢复；
10. Request/Task/Invocation/Provenance 增量精确，Timeline delta=0；
11. 扫描 DTO、日志、数据库和证据，不含 Prompt、key、payload、SSE、base64、路径或原始异常；
12. 任何失败立即停止且不 retry，并按真实事实判定 Gate，不以 fake 或单测替代成功闭环。

### 12.1 D2 独立真实复验结果（2026-08-19）

- 固定 Provider：`apikey.fun / gpt-image-2`；全新 Task 1 个，真实 dispatch 1 次，自动 retry 0；
- Task `succeeded`，`provider_call_count=1`，`provider_may_have_processed=true`；
- Provider 原始单帧 PNG：1254×1254，1,862,105 字节，满足 D2 全部安全边界；
- 文件保持 Provider 原始字节，不 resize/crop/pad/重编码；Asset、Invocation、Provenance 的大小与 SHA-256 一致；
- managed Asset 可用，Timeline Revision 增量 0，SQLite v14、FK 与 integrity 通过；
- 既有成功数据库在 Provider 网络关闭、凭据环境变量清空的条件下完成重启恢复，历史与受限预览可见，数据库前后投影一致，本次新增调用 0；
- 首次真实 E2E 的落盘断言因 Windows `file://` URI 被错误传给 `Path(...)` 而产生假阴性；只读复核证明生产落盘正确。修复验收脚本后仅复用既有数据库完成零调用恢复，未执行第二次 dispatch；
- 隐私扫描未发现 Prompt、明文凭据、payload、SSE、base64、原始异常或绝对路径进入公开证据、日志或数据库明文字段；
- 调用后保守累计 USD 0.55 / USD 2，硬停止线未触发。

**Gate 4D-4 D2 独立真实成功闭环：通过。** 旧严格尺寸失败 Task 仍保持原失败事实，不 retry、不回写、不改判。
## 12.2 Gate 4D-5 收尾门禁结果（2026-08-19）

- Core 全量：404 passed / 1 skipped / 1 个既有 Starlette 弃用 warning；Ruff 与 Python 编译检查通过；
- Contracts build、Desktop typecheck、22 个测试文件 / 171 个测试、Desktop production build 全部通过；
- 当前源码开发态 Electron 离线验收通过；Provider 网络关闭，Request/Task/Invocation/Provenance/Timeline 增量均为 0，SQLite v14/FK/integrity 与 safeStorage 恢复通过；
- 基于当前 D2 源码重新生成 Windows x64/NSIS 包，包体校验通过；NSIS 静默安装 exit code 0；
- 安装态 fresh 与 v13→v14 原位升级各 1 passed；迁移备份与历史事实保留通过，Provider 调用增量 0；
- 真实静默卸载 exit code 0；主程序与卸载器移除，隔离用户数据库保留且卸载前后 SHA-256 不变；
- 13 个公开验收 JSON/日志文件脱敏扫描失败计数 0；未发现明文 token/key、base64 data URI、原始 traceback、`file://` URI 或绝对路径形态；
- 文档契约 `stage4d-v3`、API/DTO `CONTRACT_VERSION=stage4d-v2`、SQLite v14 保持一致；README 未修改；
- Gate 4D-5 Provider 新增调用 0，当前保守累计仍为 USD 0.55 / USD 2。

**Gate 4D-5：通过。Stage 4D 功能、真实闭环、Windows 制品与独立验收已完成。**

### 12.3 尺寸契约决策沿革（历史）

Gate 4D-4 首次真实调用时，D1 将 `size=1024x1024` 按严格输出尺寸解释；Provider 返回可解码图片但不匹配，Task fail-closed，且证据没有保存实际宽高。为避免从单次失败猜测尺寸，D1 禁止重试、切换端点或本地规范化。离线修订 D2 将该参数明确为 1K 请求意图，接受安全上限内的 Provider 原生 PNG；不 resize/crop/pad/重编码，并以实际尺寸、原始字节 hash 和 provenance 留证。D2 的真实复验结论与安全边界见本契约 §11–§12.2。
## 13. 变更控制

以下变化必须退回契约 Gate：开放 2K 或新增尺寸、第二 Provider/adapter、任意 endpoint/header、Batch、参考图/编辑、Timeline 自动装配、修改 Stage 4A/4B simulation 语义、修改 v1–v13 migration/checksum，或放宽敏感信息边界。
