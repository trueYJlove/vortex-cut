# Stage 4D Gate 4D-2：隔离协议、文件与 Asset 原型验证

> 负责人：LiuWei（架构师）
> 状态：通过；Gate 4D-3 尚未授权
> 日期：2026-08-19
> 基线：`master` / `799ef8e` / SQLite v12 / `CONTRACT_VERSION=stage4c-v1`

## 1. 结论

Gate 4D-2 **通过**。在不修改生产源码、不修改用户数据库、不接 UI/Electron/打包、
不读取凭据且不访问真实 Provider 的条件下，原型证明以下最小闭环可实施：

1. Prompt 可只保存在 Core 进程内短期 vault，并支持限额、TTL、reservation、释放、一次性消费和重启清空；
2. 固定图片协议可由 `httpx.MockTransport` 隔离验证，每个逻辑调用只触发一次 fake request，无自动 retry；
3. PNG/JPEG 可由 PyAV 完整单帧解码；PNG 还需独立校验 chunk、CRC 与 IEND，JPEG 需校验 EOI；
4. 三个目标尺寸可解码，错误尺寸、HTML、非法 base64、截断和超限响应可 fail-closed；
5. SQLite v13 采用 R1 重建既有 Request 表可保持 v1–v12 checksum、历史行、Task 外键和不可变 trigger；
6. 同卷 `.part -> os.replace` 与集中式 Asset registrar 可维持成功不变式，并在数据库事务失败时补偿文件；
7. 输出继续注册为既有 `kind=image + storage_mode=managed`，无需新增 StorageMode；
8. Stage 4A/4C、v11/v12、Stage 1A Asset API 和 Stage 4A API 关键回归通过。

Gate 4D-2 只证明协议形状、安全失败行为和本地一致性设计可行，**不证明**真实服务可用性、
真实模型权限、真实 usage/费用、内容政策结果、代理/证书行为或生成图片审美质量。
这些事项保留到经单独授权的 Gate 4D-4。

## 2. 真实性与隐私边界

| 项目 | 结果 |
|---|---:|
| 真实 Provider 调用 | **0** |
| 受控 fake 调用 | **10** |
| Provider token/API key 读取 | **0** |
| Provider 费用 | **0** |
| 用户数据库修改 | **0** |
| 生产源码修改 | **0** |

受控 fake 次数仅用于证明请求上限和错误矩阵，不得计作真实 Provider 调用。
报告与结构化证据不包含 Prompt、Authorization、原始 payload/response、base64、真实媒体绝对路径、
字幕/转写/Shot List 正文或原始异常。测试使用的 Authorization 仅为固定 fake 占位符，未读取任何环境凭据。

## 3. 原型资产

- `tools/prototypes/stage4d_provider_image_model.py`
- `services/core/tests/prototype/test_stage4d_provider_image_model.py`
- 结构化本地证据：`test-results/stage4d-prototype/evidence/report.json`（git ignored）

原型只写 pytest 临时目录与 `test-results`，没有接入正式服务。

## 4. Prompt Vault

通过项：

- 容量上限；
- TTL 过期；
- `reserve -> release -> reserve`；
- `reserve -> commit` 后一次性失效；
- `repr` 只显示数量和 redacted 标记；
- 新实例/clear 模拟重启清空；
- sentinel 二进制扫描未在临时 SQLite、文件或证据中发现 Prompt。

生产冻结：Create 必须先 reserve，数据库 Create 事务失败必须 release；事务提交后才 commit 并启动 runner。
Prompt 不进入 Request、Task、Job、Invocation、日志、DTO 或证据。

## 5. 固定 Provider 协议

隔离 fixture 使用：

```text
POST https://api.openai.com/v1/images/generations
model = gpt-image-1
n = 1
size = 1024x1024 | 1024x1536 | 1536x1024
output_format = png
response = data[0].b64_json
```

首版 `protocol_version=1` 冻结为以上请求形状。模型与 endpoint 由 adapter 固定，不接受 Renderer 提供；
若正式编码前官方协议已变化，必须返回契约 Gate，不能静默扩为兼容接口。

通过矩阵：success、401/403、429、503、network、timeout、invalid image、invalid base64、
truncated image、wrong dimension。每种模式 fake call count 均为 1，没有 HTTP/SDK/runner 自动 retry。

稳定安全错误只保留分类码；原始 response body、header、URL细节和异常不得跨 adapter。
usage 仅能白名单保存；本原型未证明真实 usage 或费用字段可靠，因此费用仍为 nullable/unknown。

## 6. 图片与性能

冻结项：

- 出站请求固定 `output_format=png`；
- 防御性解码层支持 PNG/JPEG，但响应格式与请求不一致时生产 adapter 必须拒绝；
- 响应硬上限 25 MiB；
- 像素硬上限 16,000,000；
- 仅允许单帧；
- 宽高必须精确匹配请求；
- PNG：magic + chunk 边界 + CRC + IEND + PyAV 完整帧解码；
- JPEG：SOI/EOI + PyAV 完整帧解码；
- 最终字节计算 SHA-256。

三个尺寸均通过：`1024x1024`、`1024x1536`、`1536x1024`。
最后一次 7 次 1024×1024 合成 PNG 完整解码的 p95 为 **7.47 ms**，低于原型门槛 2 秒。
该数字只代表本机合成样本，不代表网络或真实 Provider SLA。

PyAV 当前由 `faster-whisper` 传递安装。Gate 4D-3 若获授权，必须把 `av>=18,<19`
提升为 Core 显式运行依赖并纳入 PyInstaller/NSIS 安装态验证，不能依赖传递关系。

## 7. SQLite v13：R1/R2 结论

### 7.1 R1：重建既有 Request 表（最终推荐）

全部通过：

- v1–v12 migration checksum 12/12 保持；
- 旧 Request/Task 行 canonical hash 不变；
- `media_generation_tasks.request_id` 仍指向 `media_generation_requests`；
- Request UPDATE/DELETE 不可变 trigger 恢复；
- `provider_image_v1` 可插入，`simulation_only` 保持；
- `PRAGMA foreign_key_check` 为空；
- `PRAGMA integrity_check = ok`；
- 故障注入后完整回滚，无 v13 记录和半重建表。

因此 v13 最终选择 R1，并追加四张表：

1. `image_provider_configs`；
2. `provider_image_request_profiles`；
3. `provider_image_invocations`；
4. `generated_asset_provenance`。

生产迁移必须沿用“关 FK 的独占连接、单事务重建、恢复索引/trigger、提交后重新开启 FK并检查”的专用路径；
不能把普通 append-only statement runner 直接用于该重建。

### 7.2 R2：独立真实 Request/Task（不采用）

R2 也能保持旧历史和外键完整，但必然复制 Request/Task/retry lineage、查询和恢复语义。
在 R1 已满足安全证明的前提下，R2 的复杂度没有收益，因此冻结为退路而非生产方案。

## 8. 文件与 Asset 不变式

通过项：

- `.part` 使用 `xb`、flush、fsync；
- 同卷 `os.replace` 发布；
- 最终文件名只含合成 Asset ID，不含 Prompt；
- 成功事务同时具备 Asset、Location、Provenance、succeeded Invocation 与 succeeded Task；
- Asset 为 `image + managed`；
- 明确事务故障点触发后，Asset/Provenance 不存在、最终文件删除、Task 不为 succeeded；
- 重复 fingerprint 命中既有唯一约束时安全失败：不创建/复用 Asset、不留最终文件、Task 不为 succeeded；
- 发布前失败会清除 `.part`；
- 补偿范围不影响生成目录外的 sentinel 文件。

生产代码必须通过 Project/Asset service 的内部 registrar 完成注册；原型中的集中 SQL 仅模拟该能力边界，
不能作为允许生成 runner 散落直插 Asset 表的依据。

Gate 4D-2 已冻结并验证 Invocation 清理字段结构：`cleanup_required INTEGER NOT NULL DEFAULT 0` 与
`output_relative_path TEXT NULL`。删除最终文件本身失败仍属于 Gate 4D-3 的生产故障注入项；届时只能保存 Core 校验后的项目根相对输出标识，并只对 `generated/image/.tmp` 或数据库权威记录的本阶段受管文件进行有界恢复，不得递归扫描或删除项目外路径。清理期间 Task、Job、Invocation 不得为成功，完成后必须清空路径并复位标记。

既有 Asset 可能为 `external`，首版若复用会违反“生成输出为 managed”的语义；因此重复内容不复用、不伪造fingerprint、不自动retry。

## 9. 自动化结果

| 检查 | 结果 |
|---|---:|
| Gate 4D-2 Ruff | 通过 |
| Gate 4D-2 pytest | 3 passed |
| Stage 4A/4C 原型 + v11/v12 迁移 | 8 passed |
| Stage 1A Asset API + Stage 4A API | 6 passed，1 条既有依赖弃用警告 |

一次初始回归命令引用了不存在的 `test_projects.py`，因此未收集测试；随后改用真实存在的
`test_stage1a_api.py` 与 `test_stage4a_media_generation_api.py`，结果为 6 passed。

## 10. 角色审查

### LiuWei（架构）

R1 的条件已满足；Stage 4D 范围继续保持一个 Provider、一个固定图片协议、一次一张、一个 Asset、不装配 Timeline。

### ZhangSan（Core / SQLite / Provider / Jobs / Asset）

R1 专用迁移、Prompt reservation、每 Task 单调用、严格图片校验和跨 SQLite/文件补偿可实现。
Gate 4D-3 必须补齐显式 PyAV 依赖、cleanup 状态与删除失败故障注入。

### YeJing（Contracts / Desktop / Electron）

正式实现仍需独立 Stage 4D API/DTO/IPC；Renderer 只持当前表单 Prompt和安全投影，图片通过 Asset ticket 预览。
本原型没有授权 Desktop/Electron/Windows 改动。

### LiuKeAi（独立审查）

范围未扩入第二 Provider、参考图、Batch、Requirement、Timeline、TTS或视频；真实调用、凭据和费用均为 0。
R1 证据可复现，失败不会产生伪成功。Gate 4D-4 的真实协议、费用与安装态结果仍必须标记 `UNVERIFIED`。

以上角色只定义职责与边界，不规定串行或并行执行方式，也不约束是否使用 subagent。

## 11. Gate 决定

- Gate 4D-1：已确认；
- Gate 4D-2：**通过**；
- Gate 4D-3：**未授权，不得启动生产实现**；
- README：不处理；
- Git：不提交。
