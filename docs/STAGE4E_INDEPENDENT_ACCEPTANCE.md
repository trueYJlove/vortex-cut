# Stage 4E Gate 4E-4 独立真实验收记录

> 日期：2026-08-20  
> 角色：LiuKeAi（独立验收）  
> 结论：**Gate 4E-5 已通过；Stage 4E 已完成**  
> 版本控制：本验收记录纳入 Stage 4E 完成变更集；README 未修改。

## 1. 验收目标与冻结边界

本 Gate 使用彼此隔离的全新数据目录、Project、confirmed image Requirement 和 fresh Task，验证：

```text
Requirement
→ Request
→ Task
→ Invocation
→ managed Asset
→ Provenance
→ immutable link
→ explicit append-only Adoption
```

冻结边界：

- Provider：`apikey_fun_images`；
- Adapter：`apikey_fun_images_sse_v1`；
- Model：`gpt-image-2`；
- 请求意图：`1024x1024`，输出接受 Stage 4D D2 契约允许的安全原生单帧 PNG 尺寸；
- 每轮只允许一个 fresh Task、最多一次真实 dispatch；
- 失败不 retry，不创建第二 Task；
- Prepare、重启恢复和后续离线门禁必须关闭 Provider 网络，调用增量为 0；
- Provider Usage 成功记录不能替代本地 managed Asset 成功事实；
- 真实验收费用硬停止线经用户授权提升为 USD 4。

## 2. 调用与预算账本

Stage 4D 后的保守累计为 USD 0.55。Stage 4E 每轮按 USD 0.15 保守估算：

| 轮次 | 安全结果 | 新增估算 | 累计估算 |
|---|---|---:|---:|
| 首轮 | HTTP 5xx / `PROVIDER_UNAVAILABLE` | USD 0.15 | USD 0.70 |
| R2 | HTTP 429 / `PROVIDER_RATE_LIMITED` | USD 0.15 | USD 0.85 |
| R3 | `PROVIDER_INVALID_RESPONSE` | USD 0.15 | USD 1.00 |
| R4 | `PROVIDER_INVALID_RESPONSE` | USD 0.15 | USD 1.15 |
| R5 | 安全协议诊断，不产生本地 Asset | USD 0.15 | USD 1.30 |
| R6 | 安全协议诊断 v2，不产生本地 Asset | USD 0.15 | USD 1.45 |
| R7 | 防御性兼容复验，未闭合成功链 | USD 0.15 | USD 1.60 |
| R8 | 防御性兼容复验，未闭合成功链 | USD 0.15 | USD 1.75 |
| R9 | 防御性兼容复验，未闭合成功链 | USD 0.15 | USD 1.90 |
| R10 | 本地完整成功闭环 | USD 0.15 | USD 2.05 |

最终保守累计：

```text
USD 2.05 / USD 4.00
```

每轮都使用全新隔离身份和 fresh Task，精确 dispatch 一次，自动 retry 为 0。临时无凭据请求只得到 HTTP 401，未生成图片，不作为成功 Provider dispatch 或图片费用计入；该请求与正式验收失败无关，相关不合规临时脚本和原始响应文件已删除。

Provider 配置中的产品价格仍按冻结契约以 CNY 表达；以上 USD 仅用于真实验收的保守停止线，不与产品价格混写为实际账单。

## 3. 零调用前门禁

一次性入口 `tools/verify_stage4e_real_once.py` 在各次获授权的真实调用前执行：

- Python 语法检查；
- Ruff；
- `git diff --check`；
- 零网络 self-test；
- 凭据只检查“是否存在”，不读取或输出其值；
- Core 默认关闭 Provider 网络；
- 检查预算不会越过硬停止线；
- 检查对应隔离 run root 在执行前不存在。

每轮真实验收进程先创建全新 Project、Shot List Revision 和 confirmed image Requirement，再创建固定 Provider config，并仅在进程内注入既有安全凭据。Prepare 的共同结果为：

```text
数据库事实表增量：0
Provider 调用增量：0
```

## 4. R1–R4 失败隔离

前四轮均未伪造成功事实：

- 首轮：Provider HTTP 5xx，安全映射为 `PROVIDER_UNAVAILABLE`；
- R2：Provider HTTP 429，安全映射为 `PROVIDER_RATE_LIMITED`；
- R3、R4：Provider 端 Usage 显示生成成功，但本地没有取得满足冻结协议的有效图片字节，安全映射为 `PROVIDER_INVALID_RESPONSE`。

各轮均满足：

```text
Project / Revision / Requirement：各 1
Request / Task / Job / Invocation / immutable link：各 1
managed Asset / Provenance / Adoption：各 0
Timeline Revision：0
第二 Task：0
retry：0
```

Provider Usage 只能证明中转站或上游记录了生成与用量；在本地完成 base64、PNG、尺寸、大小、hash、Asset 和 Provenance 校验前，Task 不得改判成功。

## 5. R5–R9 安全协议诊断与纠偏

### 5.1 诊断约束

为定位“上游可能已生成、本地未取得可接受图片”的边界，只加入进程内安全结构诊断：

- 最多保留 64 条，以 task identity 关联并一次性读取；
- 不进入 SQLite、API、DTO、Renderer 或生产日志；
- 只记录布尔值、计数、安全枚举与字段形状分类；
- 不记录事件名、字段值、响应正文、SSE frame、base64、Prompt、凭据、请求载荷、URI、绝对路径或原始异常。

诊断 schema v2 的候选编码枚举为：

```text
not_observed | base64_like | data_image_uri | remote_url | other | mixed
```

候选大小枚举为：

```text
not_observed | under_4k | 4k_to_256k | 256k_to_1m | 1m_to_36m | over_36m | mixed
```

### 5.2 安全结构事实

R5 证明 HTTP 2xx、SSE 流完整结束并出现一次 DONE marker，但冻结事件路径下没有 completed candidate。随后诊断 v2 在相关复验中稳定观察到：

```text
唯一严格 nested-data 图片形状候选：1
候选编码分类：base64_like
候选大小分类：1m_to_36m
冻结事件名候选：0
其他事件：存在
```

这些事实只证明完整 SSE 中存在唯一的 `data=[{b64_json:string}]` 结构候选，**不证明任何具体事件名称**。

R5–R9 安全诊断从未记录真实事件名，因此不得从 `unclassified` 或其他计数推导 Provider 使用了 `image.completed`、`image.completed.v2` 或任何其他名称。不得声称正式失败由缺失 Authorization 导致；正式验收入口始终通过既有安全凭据链携带 secret。

### 5.3 最终防御性兼容

Adapter 保留冻结的 `type='image_generation.completed'` 路径，同时允许一个且仅一个严格的 `data=[{b64_json:string}]` 候选进入同一安全链。该兼容以结构事实为依据，不以未经证实的事件名为依据。

后置安全条件没有放宽：

- 零候选失败；
- 多候选失败；
- URL-only 失败；
- base64 无效失败；
- 图片必须是有效、可解码、单帧 PNG；
- 大小、尺寸元数据、安全上限和 SHA-256 必须通过；
- 不 resize、crop、pad 或重编码 Provider 原始字节；
- 不保存事件名、SSE、base64 或原始响应。

对应离线协议专项测试为 `28 passed`。

## 6. R10 唯一真实 dispatch 结果

R10 在重新通过零调用前门禁后，使用第十个全新隔离目录、Project、confirmed image Requirement 和 fresh Task，仅执行一次真实 dispatch，未复用或 retry 历史失败 Task。

安全结果：

```text
status：passed
safe_code：STAGE4E_ACCEPTANCE_PASSED
provider_dispatches：1
自动 retry：0
```

数据库事实基数：

```text
Request：1
Task：1
Job：1
Invocation：1
immutable link：1
managed Asset：1
Asset Provenance：1
Adoption：1
Provider call：1
Timeline Revision：0
```

Provider 输出通过本地验证：

```text
format：png
width：1254
height：1254
size_bytes：2,235,214
managed Asset：available
```

Asset、Invocation 与 Provenance 的 SHA-256 一致；文档不记录具体 Asset ID、Provenance ID 或 hash。

## 7. SQLite、采用与无网络重启恢复

R10 安全报告中的检查全部通过：

- SQLite migration v15；
- `foreign_key_check`；
- `integrity_check`；
- fresh isolated data；
- confirmed image Requirement；
- Prepare 数据库增量 0、Provider 增量 0；
- single fresh Task、single provider dispatch；
- immutable link；
- managed Asset available；
- Asset / Invocation / Provenance hash 一致；
- append-only Adoption ordinal=1；
- Timeline Revision delta 0；
- Prompt 与 secret 不存在于 SQLite；
- 安全报告脱敏；
- 重启时网络关闭，Provider 调用增量 0。

使用同一隔离数据库重建 Core 后，Requirement link、成功 Task、managed Asset、Provenance、当前 adoption 及历史 adoption 均从 SQLite 恢复；没有新 Task、retry 或 Provider 调用。

## 8. 隐私与安全审查

独立复核确认：

- API key、Authorization 和 secret 未进入 SQLite、DTO、Renderer、日志或证据；
- Prompt/Requirement 正文未进入 Stage 4E link/adoption 数据、验收报告或控制台；
- Provider payload、原始响应、SSE、base64 和原始异常未被记录；
- 媒体绝对路径、URI 未进入 DTO、Renderer 或公开证据；
- 安全协议诊断仍只存在于进程内并一次性消费；
- 恢复和 Gate 4E-5 必须保持 Provider 网络关闭；
- 隔离运行数据与机器安全报告位于 gitignored 的 `test-results`，文档不记录宿主绝对路径。

## 9. 独立结论

**Gate 4E-4：通过。**

完整真实成功链已经闭合：

```text
confirmed image Requirement
→ Prepare（数据库/Provider 增量 0）
→ Create
→ Request
→ fresh Task
→ Invocation（一次 dispatch）
→ managed PNG Asset
→ Provenance
→ immutable Requirement link
→ explicit append-only Adoption ordinal=1
→ 零网络重启恢复
```

通过的核心门禁包括：单 fresh Task、单 dispatch、零 retry、SQLite v15、FK/integrity、Timeline 0、隐私隔离、Provider 原始 PNG 安全验证、显式采用和重启零调用恢复。

Gate 4E-4 之后不得再次调用 Provider。下一步进入 Gate 4E-5，只执行全量回归、当前源码 Windows/NSIS、fresh 与 v14→v15、重启/卸载/数据库保留、隐私扫描和文档收口，Provider 调用增量必须严格为 0。
## 10. Gate 4E-5 收尾门禁

### 10.1 全量离线回归

```text
Core：444 passed / 1 skipped / 1 个 Starlette 弃用 warning
Ruff：通过
compileall：通过
Contracts build：通过
Desktop lint / typecheck：通过
Desktop：26 files / 194 tests passed
Desktop production build：通过
Provider dispatch 增量：0
```

Core 全量测试的退出码为 0。pytest 完成后的既有 Windows 临时目录清理提示发生在 atexit，不影响测试断言或返回码。

### 10.2 Stage 4E Electron 离线 E2E

新增独立 Stage 4E E2E，仅执行到 Prepare 确认页，不点击 Create，不创建图片 Task，不访问 Provider。四个隔离场景全部通过：

```text
开发态 fresh：1 passed
开发态 v14→v15：1 passed
安装态 fresh：1 passed
安装态 v14→v15：1 passed
```

覆盖事实：

- confirmed image Requirement 可进入图片履约页；
- Prepare 展示固定 Provider/模型、1K 请求意图、费用、Prompt hash 与 Requirement hash；
- Prepare 后 Request、Task、Invocation、Provenance、Link、Adoption 与 Timeline Revision 增量均为 0；
- Prompt 只保留于当前表单与短期 preview，重启后 preview 消失；
- SQLite v15 两张新增表存在，migration checksum、FK 与 integrity 通过；
- v14→v15 创建备份并保留历史 Project 与 Provider config；
- safeStorage 凭据状态可在零网络重启后恢复，明文凭据不进入数据库或桌面日志；
- Renderer 返回的 fulfillment/link/adoption DTO 不含 Prompt、Requirement 正文、路径、URI 或原始异常；
- Provider dispatch 增量严格为 0。

首次在受限沙箱执行开发态 E2E 时，Python 虚拟环境无法创建 sidecar 进程；改用受控宿主执行后通过。v14 升级场景首次因 E2E 种子使用旧列名而在应用启动前失败，修正测试种子后通过，生产 migration 无需修改。两次均未创建 Provider Task 或 dispatch。

### 10.3 当前源码 Windows / NSIS

基于 Gate 4E-4 后的当前源码重新执行 PyInstaller sidecar、Desktop build、Electron Builder、NSIS 和包体校验，并使用同一份全新制品在隔离目录完成安装态验收：

```text
Windows x64 / NSIS 制品：built
包体校验：通过
NSIS 静默安装：exit code 0
安装态 fresh：1 passed
安装态 v14→v15：1 passed
safeStorage 跨重启恢复：通过
SQLite v15 / checksum / backup / FK / integrity：通过
v14 历史事实保留：通过
Provider dispatch 增量：0
NSIS 静默卸载：exit code 0
主程序与卸载器移除：通过
fresh 与 upgrade 用户数据库保留：通过
两个数据库卸载前后 SHA-256 不变：通过
```

一次前置打包尝试直接以 Node 启动打包脚本，未注入 pnpm 的本地命令路径，因找不到 electron-builder 命令而在构建器启动前失败；改用项目规定的 `pnpm package:win` 入口后成功。该失败不属于源码、构建配置或包体失败，也没有 Provider 调用。

### 10.4 隐私、预算与一致性

最终扫描覆盖 12 个公开安全 JSON、桌面日志与 Stage 4E 文档，对以下 10 类敏感形态逐项检查，失败计数为 0：

- 离线凭据、Prompt 与 Requirement 测试哨兵；
- Authorization Bearer 与 key/secret/token 赋值形态；
- base64 图片 data URI；
- 原始 traceback；
- `file://` URI；
- Windows 与 Unix 宿主绝对路径形态。

机器本地 package report 由既有打包脚本记录制品位置，仅位于 gitignored 验收目录，不作为公开安全证据；公开安全报告只保留布尔结果、计数、状态和哈希，不包含宿主路径、媒体 URI、正文、凭据或 Provider 原始数据。

```text
Gate 4E-5 新增 Provider dispatch：0
当前保守累计：USD 2.05 / USD 4.00
README：未修改
```

### 10.5 最终结论

**Gate 4E-5：通过。Stage 4E 已完成。**

Stage 4E 已形成 confirmed image Requirement → Stage 4D Request/Task → managed Asset/Provenance → immutable link → append-only Adoption 的完整闭环，并完成 SQLite v15、离线重启、当前源码 Windows/NSIS、fresh 与 v14→v15、卸载保留数据库、全量回归和隐私证据收口。

Gate 4E-4 后未再次调用 Provider，预算保持 USD 2.05 / USD 4.00。本验收记录随 Stage 4E 完成变更集收口。


