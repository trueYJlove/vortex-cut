# Stage 4D Gate 4D-4 独立真实验收

> 负责人：LiuWei（架构师）
> Core / SQLite / Provider / Asset 审查：ZhangSan
> Contracts / Desktop / Electron / Windows 审查：YeJing
> 独立门禁审查：LiuKeAi
> 日期：2026-08-19
> 基线：`master` / `799ef8e`
> 测试执行模型：`gpt-5.6-luna`
> 当前图片 Provider：`apikey.fun / gpt-image-2`
> 当前状态：Gate 4D-5 收尾门禁已通过；Stage 4D 已完成，等待版本控制收口

## 1. 验收范围与判定原则

Gate 4D-4 验证“固定第三方 SSE 图片生成→防御性图片校验→原子落盘→managed Asset/Provenance→受限预览→重启恢复”的真实闭环，覆盖：

- 正式 Electron Main/Preload/Renderer 与 Python Core Sidecar；
- SQLite v14 fresh 初始化、v13→v14 原位升级、备份、失败回滚与历史事实兼容；
- Electron `safeStorage` 凭据保存、Core 内存重注入和 Renderer 隔离；
- 单 Task 最多一次 Provider dispatch、无自动 retry；
- Windows x64 构建、正式包体、NSIS fresh/upgrade、启动、重启和卸载；
- Prompt、凭据、payload、SSE、base64、路径和原始异常的隐私边界；
- Core、Contracts、Desktop、Electron 与既有阶段全量回归。

真实 Provider 调用次数无固定上限，但累计费用 USD 2 是硬停止线。每次调用都必须有新增验收价值；“不限”不允许自动 retry、循环调用或重复消耗。

## 2. Provider 与价格事实

当前冻结协议：

```text
endpoint：POST https://api.apikey.fun/v1/images/generations
provider_kind：apikey_fun_images
adapter_id：apikey_fun_images_sse_v1
model：gpt-image-2
n：1
size：1024x1024
stream：true
response_format：b64_json
Accept：text/event-stream
完成事件：image_generation.completed
```

Provider 公示价格使用 CNY：

```text
1K：CNY 0.10 / 张
2K：CNY 0.15 / 张
```

当前产品只开放 1K；2K 没有明确像素映射，因此不创建 2K Task。USD 仅用于独立验收预算，不是产品 DTO 或 Provider 报价币种。

## 3. 历史真实调用与预算台账

此前对官方 `gpt-image-1` 端点执行过一次真实 dispatch，并以 `PROVIDER_TIMEOUT` 安全失败。该事实属于 SQLite v13 官方历史和预算基线，**不是** `apikey.fun / gpt-image-2` 的调用结果。

历史安全事实：

```text
历史官方 dispatch：1
历史 Task dispatch：1
自动 retry：0
error_code：PROVIDER_TIMEOUT
provider_call_count：1
provider_may_have_processed：true
保守历史估算：USD 0.25
```

当前第三方调用台账：

```text
严格尺寸失败 dispatch：1（保守估算 USD 0.15）
D2 全新成功 dispatch：1（保守估算 USD 0.15）
apikey.fun 真实 dispatch 累计：2
自动 retry：0
D2 调用前累计：USD 0.40 / USD 2
D2 调用后保守累计：USD 0.55 / USD 2
硬停止线：未触发
```

## 4. 历史官方失败验收（已完成、只读保留）

此前官方端点所在主机环境出现 TCP/HTTPS 连接超时。失败数据库证明：Request/Task/Invocation 各一条，调用计数为 1，`provider_may_have_processed=1`，Provenance 与 Timeline 增量为 0，且无伪成功。失败态重启后 safeStorage 可重新注入，调用数不增加。

该历史证据用于验证安全失败、单次 dispatch 与 v13→v14 兼容，不用于证明当前第三方 Provider 连通、协议或成功闭环。

## 5. SQLite v14 调用前门禁

必须通过：

- fresh v1→v14；
- v13→v14 原位升级；
- v1–v13 checksum 不变、v14 checksum 正确；
- v13 官方 config/request/task/invocation/provenance 原样保留；
- 第三方身份、模型、CNY 价格和尺寸 CHECK；
- v13 历史官方记录不进入新第三方列表；
- 新 adapter 拒绝历史官方 Task retry；
- 迁移备份、故障回滚；
- `foreign_key_check` 为空、`integrity_check=ok`。

## 6. 离线和回归门禁

真实调用前依次完成：

1. Python 编译和 Ruff；
2. Core 全量 pytest；
3. Contracts build；
4. Desktop unit/integration tests；
5. Desktop lint/typecheck/build；
6. Stage 4D Electron E2E 离线模式，Provider 调用数必须为 0；
7. `git diff --check`；
8. 敏感字段静态/运行证据扫描。

离线失败时不得读取凭据或执行真实调用。
### 6.1 最终离线回归结果（2026-08-19）

```text
Core：404 passed / 1 skipped / 1 既有 Starlette 弃用 warning
Ruff：通过
Python py_compile：通过
Contracts build：通过
Desktop typecheck：通过
Desktop：22 files / 171 tests passed
Desktop production build：通过
开发态离线 Electron E2E：1 passed / 2 skipped
Windows 安装态 fresh：1 passed / 2 skipped
Windows 安装态 v13→v14：1 passed / 2 skipped
git diff --check：通过（仅行尾转换 warning）
精确敏感信息扫描：通过
最终离线与 Windows 验收 Provider 调用增量：0
```

Core 唯一 warning 为既有 Starlette/httpx TestClient 弃用提示；pytest 完成后宿主临时目录清理出现权限提示，但测试进程返回成功，且不影响任何验收断言或工作区数据。

## 7. 第三方真实调用步骤

全部前门禁通过后：

1. 使用新的隔离 run root；
2. 仅检查 `AIVS_REAL_PROVIDER_API_KEY` 是否存在，绝不输出值；
3. 验证 `AIVS_REAL_PROVIDER_ENABLED=true`；
4. 确认调用前保守累计为 USD 0.40，下一次调用后为 USD 0.55，且不超过 USD 2；
5. 创建一个全新 Task，固定发送 `size=1024x1024` 请求意图；
6. 只允许一次 dispatch，不 retry；
7. 验证唯一 SSE completed、单帧 PNG、原生尺寸安全边界、字节数和原始字节 hash；
8. 验证原子落盘、managed Asset、不可变 Provenance、受限预览；
9. 验证 SQLite v14、`provider_call_count=1`、Timeline delta=0；
10. 重启应用/Core 并验证成功事实与预览恢复；
11. 扫描 DTO、日志、SQLite 和证据，不含敏感内容；
12. 更新本报告为真实结果。

任何鉴权、网络、协议、费用、隐私或一致性异常立即停止，不创建第二 Task，不 retry。

## 7.1 第三方真实调用结果（2026-08-19）

调用前 Core、Contracts、Desktop、构建、开发态离线 E2E、精确敏感信息扫描、凭据存在性、TCP 443 与预算门禁均通过。随后在新的隔离 run root 中按当时严格尺寸契约创建一个请求参数为 `size=1024x1024` 的 Task，并执行本 Gate 唯一一次第三方真实 dispatch。

稳定结果：

```text
provider：apikey.fun / gpt-image-2
Task.status：failed
error_code：GENERATED_IMAGE_DIMENSION_MISMATCH
provider_call_count：1
provider_may_have_processed：true
estimated_cost：CNY 0.10
price_tier：1K
自动 retry：0
Asset 增量：0
Provenance 增量：0
Timeline Revision 增量：0
SQLite：v14 / foreign_key_check 通过 / integrity_check=ok
调用后保守预算：USD 0.40 / USD 2
```

公开 Provider 文档仍明确示例 `size=1024x1024`、`stream=true`、`response_format=b64_json`，价格页明确 `gpt-image-2 / 1K / ¥0.10`。因此不能把本次失败归因于本地使用了未公开的尺寸写法，也不能为追求通过而接受未知尺寸、执行隐式 resize/crop 或猜测 2K 映射。

失败证据扫描确认：API key、Prompt、原始 payload、原始 SSE/base64、原始异常和绝对媒体路径均未进入 SQLite、Desktop 日志或 Playwright 错误证据。失败后没有创建第二 Task，也没有自动或人工 retry。

本次结果证明单次 dispatch、失败隔离、预算与隐私停止线有效，但**不能证明**新 D2 契约下的原生尺寸 PNG、managed Asset、Provenance、受限预览和成功重启恢复闭环。上述成功项保持未验证。

## 8. Windows 验收

2026-08-19 使用本轮全新生成并通过正式包体验证的 Windows x64 / NSIS 制品，在彼此隔离的安装目录和 user-data 中完成以下验收：

```text
NSIS 静默安装：通过，exit code 0
安装态 fresh：1 passed / 2 skipped
安装态 v13→v14：1 passed / 2 skipped
safeStorage 跨重启恢复：通过
SQLite v14 / migration checksum / FK / integrity：通过
v13→v14 迁移备份：通过
历史官方 config/request/task/invocation：原样保留
当前第三方 Request/Task/Invocation 增量：0
Provenance / Timeline Revision 增量：0
真实静默卸载：通过，exit code 0
主程序与卸载器移除：通过
隔离用户数据库保留且卸载前后 SHA-256 不变：通过
Provider 调用增量：0
```

安装态验收全程移除了 `AIVS_ENABLE_IMAGE_PROVIDER_NETWORK`、`AIVS_REAL_PROVIDER_ENABLED` 与 Provider key 子进程环境，未产生第二次 dispatch。因真实 Provider Task 已在图片尺寸校验处安全失败，本轮不存在成功 managed Asset；因此卸载验收只能证明数据库保留，不能虚构或替代 managed Asset 保留证据。

上述 Windows 结果属于 D2 前的历史安装态离线证据。D2 真实成功闭环随后已在开发态完成；Gate 4D-5 又基于当前 D2 源码重新生成包体并复验 Windows 离线路径，结果见第 12 节。安装态未再次调用 Provider，不把开发态真实调用伪装为安装态调用。

## 9. 隐私与安全审查

- Prompt 仅在 Renderer 当前表单、Core 瞬时 vault 和一次请求中存在；
- 凭据只通过 UI→Electron safeStorage→Admin API→Core 内存；
- Renderer DTO 不含凭据、Prompt、payload、SSE、base64、绝对路径、URI 或原始异常；
- E2E 禁用 trace、截图和视频；
- endpoint/model/adapter/header 不允许 Renderer 任意配置；
- Provider 网络默认关闭，只有显式真实验收模式开启；
- Provider response 只增量 hash，不保存原始 envelope；
- 每 Task 调用计数只能是 0 或 1；
- 不引入第二 Provider、参考图、Batch 或 Timeline 自动装配。

## 10. 角色审查边界

### LiuWei（架构）

判定范围未扩大，区分 CNY Provider 价格与 USD 验收预算，执行异常、安全和费用停止线，最终决定 Gate。

### ZhangSan（Core / SQLite / Provider / Asset）

复核 SSE adapter、单次 dispatch、v14 migration、历史身份隔离、图片校验、文件补偿和 Asset/Provenance 一致性。

### YeJing（Contracts / Desktop / Electron / Windows）

复核 `stage4d-v2` API/DTO guards、`stage4d-v3` 原生尺寸展示语义、固定身份/价格 UI、safeStorage、窄 IPC、受限预览及 Windows/NSIS 行为。

### LiuKeAi（独立门禁）

独立复跑门禁和证据扫描；不以 mock、单测或历史官方失败替代当前第三方真实成功闭环。

上述角色只定义职责和边界，不规定串行、并行或 subagent 使用方式。

## 10.1 Gate 4D-4A 原生尺寸兼容修订

用户已确认不再等待无法取得的 Provider 尺寸说明，改用 D2 原生尺寸兼容契约。离线验收必须证明：

- `size=1024x1024` 只作为固定请求意图；
- 合法非 1024×1024 单帧 PNG 可成功，实际宽高进入 Invocation、Asset 与 DTO；
- 受管文件字节和 SHA-256 与 Provider 原始 PNG 完全一致；
- 最大单边 4096、最大总像素 16,777,216、最大文件 25 MiB；
- IHDR 超限在完整解码前 fail-closed；
- 不执行 resize、crop、pad、拉伸、重编码或格式转换；
- SQLite v14 和 API/DTO 结构不变；
- 旧失败 Task 不回写、不 retry、不改判；
- 本 Gate 离线验证期间 Provider 调用增量为 0。

本节完成后，Gate 4D-4 仍不能直接改判通过；必须使用全新 Task 完成一次 D2 下的独立真实成功闭环。

### 10.2 Gate 4D-4A 离线验收结果（2026-08-19）

```text
Core 定向：37 passed / 1 既有 warning
Core 全量：404 passed / 1 skipped / 1 既有 warning
Ruff：通过
Python py_compile：通过
Contracts build：通过
Desktop typecheck：通过
Desktop：22 files / 171 tests passed
Desktop production build：通过
开发态离线 Electron E2E：1 passed / 2 skipped
SQLite：v14 / foreign_key_check 通过 / integrity_check=ok
API/DTO CONTRACT_VERSION：stage4d-v2 保持不变
本轮 Provider 调用增量：0
当前保守累计：USD 0.40 / USD 2
```

离线 Electron 证据确认 Provider 网络关闭，Request、Task、Invocation、Provenance 与 Timeline Revision 增量均为 0；safeStorage 重启恢复、SQLite v14、FK 和 integrity 均通过。历史失败 Task、Invocation、调用计数和失败码未回写、未 retry、未改判。

**Gate 4D-4A 离线门禁：通过。** 已具备申请一次全新 Task 真实复验的技术条件；下一次调用后保守累计预计为 USD 0.55 / USD 2，但本轮未获得也未执行该调用授权。

## 10.3 Gate 4D-4 D2 独立真实复验结果（2026-08-19）

### 调用与预算

```text
Provider：apikey.fun / gpt-image-2
全新 Task：1
真实 dispatch：1
自动 retry：0
Task：succeeded
provider_call_count：1
provider_may_have_processed：true
调用前保守累计：USD 0.40 / USD 2
本次新增保守估算：USD 0.15
调用后保守累计：USD 0.55 / USD 2
硬停止线：未触发
```

### 输出、Asset 与数据库

```text
格式：单帧 PNG
Provider 原生尺寸：1254×1254
文件大小：1,862,105 字节
D2 安全边界：通过
原始字节保留：通过
Asset / Invocation / Provenance 大小与 SHA-256：一致
Asset availability：available
Timeline Revision delta：0
SQLite v14：通过
foreign_key_check：通过
integrity_check：ok
```

本次没有 resize、crop、pad、拉伸、重编码或格式转换。旧严格尺寸失败 Task 保持原错误码、调用计数和零 Asset/Provenance，不 retry、不回写、不改判。

### 验收脚本假阴性与零调用恢复

首次真实 E2E 在生成成功后报告 `asset_file_exists=false`。根因是验收脚本在 Windows 上把数据库中的标准 `file://` URI 直接交给 `Path(...)`，而不是先进行 URI 解码；这是验收脚本错误，不是生产落盘、Asset 注册或数据库错误。

独立只读复核确认受管文件存在、大小与 SHA-256 一致。修复 URI 解析后，复用同一个既有成功数据库并强制关闭 Provider 网络、清空凭据环境变量，完成零调用重启恢复：

```text
Electron 恢复 E2E：1 passed
本次新增 Provider 调用：0
provider_call_count 前后：1 → 1
数据库前后投影：完全一致
成功历史恢复：通过
safeStorage 配置状态恢复：通过
受限预览：通过
受管文件与 hash：通过
Timeline delta：0
FK / integrity：通过
```

没有执行第二次真实 dispatch，也没有重试旧 Task。

### 隐私扫描

脱敏扫描仅输出布尔结果和失败计数。结果为 11 项检查全部通过、失败计数 0：

- recovery evidence 为合法 JSON，且不含绝对路径或敏感字段；
- 日志、数据库文本和证据中未检出测试 Prompt 形态；
- 日志、数据库和证据中未检出明文 token/key 形态；
- 未检出 payload、原始 SSE、base64 data URI、原始 traceback 或绝对路径；
- safeStorage 文件只含 `provider_config_id` 与非空 `ciphertext`；
- 数据库 Prompt 相关字段仅为 hash 或模板版本；
- 恢复证据明确记录 Provider 网络关闭且本次调用数为 0。

不在本文或证据中保存/输出真实 Prompt、凭据、请求载荷、SSE/base64、原始异常、数据库路径或媒体绝对路径。

## 11. 当前 Gate 结论

**Gate 4D-4 D2 独立真实成功闭环：通过。**

已确认：

- D2 下的全新 Task 真实成功，调用精确为 1、自动 retry 为 0；
- Provider 原生 1254×1254 PNG 满足安全边界，原始字节已注册为 managed Asset；
- Asset、Invocation、Provenance、文件大小与 SHA-256 一致；
- Timeline 无副作用，SQLite v14、FK 与 integrity 通过；
- 成功历史、safeStorage 状态和受限预览可在零网络重启后恢复；
- 隐私扫描通过；
- 调用后保守累计 USD 0.55 / USD 2；
- 原严格尺寸失败事实保持不变。

## 12. Gate 4D-5 收尾门禁（2026-08-19）

### 最终回归

```text
Core：404 passed / 1 skipped / 1 个既有 Starlette 弃用 warning
Ruff：通过
Python py_compile：通过
Contracts build：通过
Desktop typecheck：通过
Desktop：22 files / 171 tests passed
Desktop production build：通过
开发态 Electron 离线 E2E：1 passed
Provider 调用增量：0
```

pytest 进程成功；退出后的宿主临时目录权限提示仅发生于既有 atexit 清理，不影响测试断言或工作区。

### 当前源码 Windows / NSIS

基于 D2 当前源码重新执行 PyInstaller、Electron Builder 与包体校验，并在全新隔离目录完成：

```text
Windows x64 / NSIS 包体：built
NSIS 静默安装：通过，exit code 0
安装态 fresh：1 passed
安装态 v13→v14：1 passed
safeStorage 跨重启恢复：通过
SQLite v14 / migration checksum / backup / FK / integrity：通过
历史 v13 事实保留：通过
Request / Task / Invocation / Provenance / Timeline 增量：0
真实静默卸载：通过，exit code 0
主程序与卸载器移除：通过
隔离用户数据库保留且卸载前后 SHA-256 不变：通过
Provider 调用增量：0
```

全程显式关闭 Provider 网络与真实调用开关，不读取或输出凭据。

### 最终隐私和一致性审查

- 13 个公开验收 JSON/日志文件扫描：明文 token/key、base64 data URI、原始 traceback、`file://` URI、绝对路径形态均为 0；
- 包体内部 SBOM 中存在依赖工具自己的 `file://` 元数据，不属于 Renderer、日志或公开验收证据，不含用户媒体或 Provider 信息；
- 文档契约 `stage4d-v3`、API/DTO `CONTRACT_VERSION=stage4d-v2`、SQLite v14 一致；
- `git diff --check` 通过；README 未修改；
- Gate 4D-5 新增 Provider 调用 0，当前保守累计保持 USD 0.55 / USD 2。

## 13. 最终结论

**Gate 4D-5：通过。Stage 4D 已完成。**

Stage 4D 已形成受控真实图片生成、D2 原生尺寸安全校验、managed Asset/Provenance、受限预览、重启恢复、SQLite v14、Windows/NSIS 和隐私证据闭环。旧严格尺寸失败 Task 继续保持不可变历史事实。

README 未修改。当前等待版本控制收口；尚未在本 Gate 内创建提交、推送或 PR/MR。
