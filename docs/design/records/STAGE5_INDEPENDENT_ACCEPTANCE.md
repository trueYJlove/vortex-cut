# Stage 5 独立离线真实验收

> 独立验收角色：LiuKeAi
> 架构与 Gate 判定：LiuWei
> 日期：2026-08-20
> 基线提交：`f484256`（Stage 4E 完成基线）
> 对应契约：`stage5-v1`
> 数据库：SQLite v16
> 验收范围：Gate 5-R5
> 结论：Stage 5-R 当前源码独立验收通过；历史记录经 Gate 5-R1–R5 重验后恢复有效
> Stage 5-R 说明：因原始 Stage 5 新增文件漏提交，历史记录曾临时作废；当前源码已经 Gate 5-R1–R5 重新独立验收，历史记录恢复有效。
> Provider、网络与费用增量：0
> README：未修改

## 1. 独立性与执行边界

本轮由 LiuKeAi 按独立验收职责执行，只新增或调整隔离验收工具、Electron E2E 和安全证据文档。验收期间未修改 Stage 5 生产业务逻辑；发现的问题均先按“生产缺陷或验收夹具缺陷”分类，确认属于夹具或宿主环境后才修正验收侧文件。

角色文档只定义职责、边界和文件所有权，不规定串行或并行执行拓扑。后续可由单会话或多个子智能体在相同契约下执行。

固定安全边界：

- Stage 5 Provider dispatch、网络调用和费用增量严格为 0；
- 不读取 Provider token、API key、Authorization、原始请求/响应或流式/base64 内容；
- 公开 DTO、Renderer、日志和安全证据不包含 Requirement/Prompt/字幕/转写正文、媒体绝对路径、URI 或原始异常；
- 生产数据库只验证 ID、hash、枚举、计数、时间和不可变事实；
- README 不在本阶段处理；
- Gate 5-4 不提交代码。

## 2. 验收对象

唯一验收主链：

```text
confirmed image Requirement
→ current Stage 4E Adoption
→ 本地确定性 Assembly Preview
→ 用户显式确认
→ 新 TimelineDocument v1 Revision
→ immutable Assembly fact
→ 用户另行触发现有 Preview / Render / Export
```

不验收也不引入 TTS、资产库、Batch、自动装配、替换/删除、自动 Preview/Render/Export、TimelineDocument v2、RenderPlan v2、新 TimelinePatch operation 或任何 Provider 调用。

## 3. Core 离线真实验收

独立工具：`tools/verify_stage5_offline_real.py`。

工具支持自检和全新隔离目录运行，并使用 fail-on-call Provider 边界。最终 fresh v16 与 v15→v16 报告均为：

```json
{"schema_version":1,"status":"passed","safe_code":"STAGE5_ACCEPTANCE_PASSED"}
```

### 3.1 SQLite v16 与迁移

- fresh 数据库最终 migration 数为 16，v16 checksum 匹配；
- v15→v16 原位升级后 v1–v15 checksum 全部保留；
- 升级备份存在；
- 历史 Project、Adoption 与 Timeline 事实保留；
- `foreign_key_check` 无违规，`integrity_check=ok`。

### 3.2 Prepare / Apply / 幂等

- Prepare 只新增一条不可变 Assembly Preview；
- Prepare 的 Timeline Revision、Assembly、Render Job 和 Artifact 增量均为 0；
- Apply 由用户显式确认后，Timeline Revision 与 Assembly 增量各为 1；
- Request、Task、media-generation Job、Invocation、Provenance、Link、Adoption 和 Asset 增量均为 0；
- 同一 Preview 重放不创建第二条 Revision 或 Assembly；
- Timeline 最终只新增一个 image Clip，时长 2 秒、layout=`fit`；
- Undo/Redo 可用，且不可变 Assembly 历史不被删除；
- 重启后 Preview、Assembly、Timeline Revision 和 Clip 均可恢复。

### 3.3 真实本地媒体与权威渲染

验收使用本地生成的真实 PNG，不调用图片 Provider。该图片进入既有权威 Preview/Render 链后验证：

- 视频编码 H.264；
- 音频编码 AAC；
- 输出 540×960；
- 像素格式 yuv420p；
- 30 fps；
- 音频采样率 48 kHz；
- 输出 SHA-256 与记录一致；
- `ffprobe` 可正常解析。

Stage 5 不自动创建 Render Job 或 Artifact；上述渲染由验收端在 Apply 后另行显式触发，符合冻结边界。

## 4. Electron 开发态真实 E2E

四类目标中的开发态两类均通过：

```text
development_fresh：1 passed
development_upgrade_v15：1 passed
```

覆盖：

- Requirement 图片履约面板正确识别 current Adoption；
- 用户设置时长和布局后 Prepare 展示“新增 1 个图片 Clip”；
- Prepare 不创建 Timeline Revision、Assembly、Render Job 或 Artifact；
- 显式 Apply 后 Timeline Revision 与 Assembly 各新增 1 条；
- Timeline Clip 的 Asset、位置、时长和布局符合 Preview；
- 不自动 Preview、Render 或 Export；
- 应用重启后 Assembly 和 Clip 恢复；
- v15→v16 checksum、备份、FK 和 integrity 均通过；
- Provider call 与生成事实增量为 0；
- 安全报告不包含正文、凭据、路径、URI 或原始异常。

## 5. Windows / NSIS 安装态真实验收

### 5.1 当前源码制品

基于当前 Stage 5 源码重新构建 PyInstaller Sidecar、Desktop、Electron Builder 与 NSIS，未复用 Stage 4E 旧制品。

```text
Windows x64 / NSIS：built
正式 package:verify：通过
NSIS 静默安装：exit code 0
主程序与卸载器：存在
```

正式包校验确认 Sidecar、FFmpeg、FFprobe、许可证、组件 manifest、字体、字幕 preset/filter、模型 manifest 和 recipe 完整，模型权重未误打包。

### 5.2 安装态 E2E

```text
installed_fresh：1 passed
installed_upgrade_v15：1 passed
```

两类安装态均覆盖 UI Prepare/Apply、单 Clip、原子事实、重启恢复、SQLite v16、零自动渲染和零 Provider/生成事实增量。升级场景另外验证 v15 历史 checksum 保留与迁移备份存在。

### 5.3 卸载保留

```text
NSIS 静默卸载：exit code 0
主程序移除：通过
卸载器移除：通过
fresh 用户数据库保留：通过
upgrade 用户数据库保留：通过
两份数据库卸载前后 SHA-256 不变：通过
```

### 5.4 Gate 5-R5 当前源码重验

- 当前源码重建 PyInstaller Sidecar、Desktop、Electron Builder 与 NSIS 制品，package report 为 `built`；
- installed_fresh 与 installed_upgrade_v15 Stage 5 E2E 均为 `1 passed`；
- 独立 Windows package verify 通过；
- 真实 NSIS 静默安装与静默卸载均 exit code 0；
- fresh 与 v15→v16 专用用户数据库卸载后均保留，且卸载前后 SHA-256 不变；
- Provider 调用、网络外传与费用增量均为 0；
- 验收期间生产业务逻辑保持只读；
- Stage 5-R 恢复验收通过，历史记录恢复有效；版本控制、推送和 PR/MR 仍需用户授权。
## 6. 隐私、Provider 与费用

最终安全事实：

- Stage 5 Provider dispatch 增量：0；
- Stage 5 网络调用增量：0；
- Stage 5 费用增量：0；
- media-generation Request/Task/Job/Invocation/Provenance/Link/Adoption/Asset 增量：0；
- Prepare/Apply 不读取 Provider 凭据；
- 桌面日志未命中 Requirement 正文哨兵；
- Core 与 Electron 安全报告仅保留状态、布尔值、枚举、计数和 SHA-256；
- 机器本地 package report 含制品定位信息，仅保留在 gitignored 的本机验收目录，不作为公开证据；
- README 未修改。

历史 Stage 4D/4E 夹具中存在一条已完成 Provider 调用事实，用于构造 current Adoption；这不属于 Gate 5-4 新调用。验收判断始终使用前后增量，而不是错误宣称数据库历史总调用数为 0。

## 7. 验收过程中的非生产问题

### 7.1 历史夹具 DTO 不符合严格 Contracts

首轮 Electron E2E 中，Fulfillment、Link 和 Provider Config 可读，但历史 Request/Task 被 Desktop Contracts 拒绝。安全接口诊断仅输出成功状态、枚举和计数，不输出 DTO 或异常。

根因是验收夹具使用非 64 位十六进制伪 hash、空 `parameters` 和空成功结果摘要。修正为严格 SHA-256、冻结尺寸参数和合法成功摘要后通过。该问题只存在于验收夹具，生产 API、Contracts 和 UI 无需修改。

### 7.2 v15 基线提前查询 v16 表

升级 E2E 首轮在启动 Electron 前直接统计 v16 新表，因 v15 尚无该表而失败。验收脚本改为“表不存在时计数为 0”后通过；生产迁移未发生失败，也未修改。

### 7.3 本机缺少 uv 命令

仓库虚拟环境已有锁定依赖和 PyInstaller，但当前 PATH 没有 `uv.exe`。验收在 gitignored 的 `build` 目录创建离线兼容入口，只把既有构建脚本的 `uv run ... pyinstaller` 转发到项目虚拟环境；没有下载依赖，也没有修改生产打包脚本。

两次前置失败分别来自兼容入口参数转发和版本查询不完整，均发生在正式制品产生前。完善入口后，以全新输出目录重新构建成功。

### 7.4 宿主 PSModulePath 差异

正式 `package:verify` 首次重跑未注入离线 uv 入口而在 preflight 停止；第二次受到宿主注入 `PSModulePath` 影响，嵌套 Windows PowerShell 无法发现内置 `Get-FileHash`。移除当前进程的该覆盖后，对同一制品重跑通过。未修改系统配置、包体或生产脚本。

## 8. LiuKeAi 独立验收清单

- [x] 单条 current Adoption，非 Batch；
- [x] Preview/Apply 分离并要求显式确认；
- [x] Preview 持久化、不可变并可重启读取；
- [x] Apply 时 current Requirement/Adoption/Timeline CAS 复验；
- [x] Timeline Revision 与 Assembly 同事务；
- [x] 同 Preview 重放幂等；
- [x] 单 image Clip，时长与布局正确；
- [x] Undo/Redo 不删除 Assembly 历史；
- [x] 不自动 Render/Export；
- [x] 真实本地 PNG 与既有权威 FFmpeg 渲染通过；
- [x] SQLite v16 fresh；
- [x] v15→v16 原位升级、备份和历史事实保留；
- [x] 开发态 fresh 与 upgrade；
- [x] Windows/NSIS 安装态 fresh 与 upgrade；
- [x] 安装态重启恢复；
- [x] 卸载保留数据库且哈希不变；
- [x] Provider、网络和费用增量为 0；
- [x] DTO、Renderer、日志和公开证据隐私隔离；
- [x] 验收期间生产业务逻辑保持只读；
- [x] README 未修改。

## 9. Gate 判定

**Gate 5-R5：当前源码 Windows/NSIS 安装态与卸载保留独立验收通过；历史 Gate 5-4 记录恢复有效。**

Stage 5 已在 Core、Electron 开发态和当前源码 Windows/NSIS 安装态完成独立离线真实验收。SQLite v16、显式装配、原子 Revision/Assembly、幂等、Undo/Redo、重启、真实本地 PNG 渲染、v15→v16、卸载保留和隐私边界均满足冻结契约；Provider、网络和费用增量严格为 0。

本结论不等于版本控制收口已完成。下一步是 Gate 5-5 收尾门禁：执行最终全量回归、隐私与差异检查、文档一致性检查，并在用户授权后进行版本控制、推送和 PR/MR 操作。
