# Stage 4C Gate 4C-4 独立真实验收

> 负责人：LiuWei（架构师）
> Core / SQLite / 任务副作用审查：ZhangSan
> Contracts / Desktop / Electron / Windows 审查：YeJing
> 独立门禁审查：LiuKeAi
> 日期：2026-08-19
> 基线：`master` / `27e5ab5` / SQLite v11
> 结论：**Gate 4C-4 通过；Gate 4C-5 已授权，随本次 PR 合并主干后通过**

## 1. 验收范围与边界

本轮对 Stage 4C“人工结构化镜头与资产需求清单”执行独立真实验收，覆盖：

- 开发态真实 Electron、Main/Preload/Renderer 与 Python Core Sidecar；
- 全新 Windows x64 NSIS 构建、静默安装、安装态启动与真实卸载；
- 全新 SQLite v12 初始化，以及历史 v11 数据库由安装态 Sidecar 原位升级到 v12；
- Shot List 空状态、1 条/24 条、多个不可变 Revision、幂等复用、确认后继续演进、并发冲突、历史详情、项目切换和重启恢复；
- SQLite 完整性、迁移 checksum、升级备份、日志、JSON 证据和磁盘媒体副作用取证；
- Provider/Request/Task/Job/Asset/Timeline 零增量；
- Stage 1–4B 以及 Stage 4C 的 Core、Contracts、Desktop、Electron 和构建回归。

本轮没有调用真实图片、TTS、视频或文本 Provider，没有读取 Provider token/API key/Authorization/真实请求载荷。真实媒体生成、生成 Asset 注册和 Timeline 装配仍为 `UNVERIFIED`，不因本 Gate 通过获得授权。

## 2. 环境与制品

验收环境：

```text
操作系统：Windows x64
Node.js：v24.16.0
pnpm：10.12.1
uv：0.12.3
Electron：36.2.1
SQLite 目标版本：v12
应用版本：0.0.1
安装器：NSIS x64
```

全新构建制品：

| 制品 | 字节数 | SHA-256 |
|---|---:|---|
| `VortexCut-Setup-0.0.1-x64.exe` | 386,565,511 | `ba3ebe748e69653f65f7765db8e1b70a2268d1854312df2e5dbd50961e69191e` |
| `aivs-core.exe` | 123,943,869 | `cba448a39e7176c31015c285c2216c8be0b0ec3d3d6beac29917f7fb854e2f89` |

`package:verify` 最终正式通过，已验证：

- Sidecar、FFmpeg、FFprobe、许可证与组件 manifest；
- 字体包、字幕预设与 FFmpeg 字幕 filters；
- ASR model manifest 存在且模型权重未打包；
- AI recipe manifest 与 recipe 文件；
- Electron runtime、electron-builder、NSIS、NSIS resources、winCodeSign 与 7-Zip。

首次运行包装器时，宿主注入的 `PSModulePath` 使嵌套 Windows PowerShell 无法发现 `Get-FileHash`。清除该宿主环境覆盖后，未修改任何打包脚本即使用同一制品重跑，bootstrap 与正式 `package:verify` 全部通过。因此该现象判定为验收宿主环境差异，不是制品内容缺陷。

## 3. 真实 Electron 与 Shot List 验收

同一套受控 E2E 分别在以下三种真实运行目标执行并通过：

| 目标 | Electron / Sidecar | 结果 |
|---|---|---|
| development | 开发构建 + 真实 Python Sidecar | 通过 |
| installed_fresh | 实际安装程序 + 打包 Sidecar + 全新数据库 | 通过 |
| installed_upgrade_v11 | 实际安装程序 + 打包 Sidecar + v11 数据库 | 通过 |

三种目标均验证：

1. Sidecar ready，Desktop 显示 Core 已连接；
2. 新项目的 Shot List 为纯读空状态，GET 不创建聚合行；
3. 保存包含 1 条 Requirement 的首个 Revision；
4. 相同 canonical document 再次保存时幂等复用，不创建重复 Revision；
5. 保存包含 24 条 Requirement 的 Revision，第 25 条在 UI/Contracts/Core 边界均不可进入；
6. 覆盖 `image`、同项目 `existing_media` 与可选 `tts + 人工正文` 组合；
7. 确认当前 Revision 采用独立两步确认；
8. 已确认 Revision 后继续保存新 current Revision 时，状态回到 `drafted`，旧 confirmed 指针保持；
9. 并发创建新 Revision 后，旧基线保存返回冲突且不覆盖新 current；
10. Renderer 只显示固定安全冲突提示，不显示正文或原始异常；
11. 历史列表只加载 Summary，点击后按需恢复 1 条和 24 条 Detail，并可复制为新草稿；
12. 项目切换关闭工作台并清除未保存正文；
13. 应用完全关闭并重启后，current、confirmed 与历史详情恢复；
14. 最终事实为 1 个 Shot List、3 个不可变 Revision、26 条 Requirement。

## 4. SQLite v11 → v12 与兼容性

安装态升级用例先建立含完整 v1–v11 migration 记录和历史项目事实的数据库，再由安装包内 Sidecar 正常启动并执行 v12 迁移。结果：

```text
schema_migrations 数量        = 12
v12 migration                 = 1
v1–v12 checksum               = 全部匹配
PRAGMA foreign_key_check      = 通过
PRAGMA integrity_check        = ok
升级前备份                    = 已创建（至少 1 份）
历史项目事实                  = 保留
```

迁移没有修改 v1–v11 SQL 或 checksum；v12 只追加 Shot List、Revision 和 Requirement 三张表。fresh、upgrade 与重启后的数据库均通过完整性检查。

生命周期契约经真实流程确认：

```text
empty     = 无 current、无 confirmed
confirmed = confirmed_revision_id == current_revision_id
drafted   = 有 current，且 confirmed 为空或 confirmed_revision_id != current_revision_id
```

因此“确认后继续演进”不会丢失旧 confirmed 事实，也不会把新的未确认 current 错标为 confirmed。

## 5. 零副作用与隐私取证

三种真实运行目标均在 Shot List 流程前后执行数据库与磁盘计数差异检查：

```text
真实 Provider 调用数                 = 0
ProviderInvocation 增量              = 0
MediaGenerationRequest 增量          = 0
MediaGenerationTask 增量             = 0
Job 增量                             = 0
Asset 增量                           = 0
TimelineRevision 增量                = 0
Generated Asset 增量                 = 0
MediaGeneration Artifact 增量        = 0
用户数据目录新增生成媒体文件增量     = 0
```

隐私检查结果：

- Shot List 正文只存在于授权的 Renderer 内存/业务 Detail 与 SQLite 业务事实中；
- Desktop 日志未命中标题、摘要、画面说明、旁白或冲突 sentinel；
- 安全结果 JSON 只保存布尔值、计数、增量和数据库 hash，未保存正文；
- Playwright 明确关闭 trace、screenshot 与 video；
- 两次验收夹具失败产生的错误快照未读取，并已在受控目录中删除；
- DTO/IPC 形状递归拒绝媒体路径、URI、Provider payload、Authorization、secret、token、原始异常、stderr、command 与 traceback 等字段；
- Electron IPC 仅允许固定 Shot List 业务错误码进入 Renderer，其余 Core 异常统一为 `Core request failed`；
- 未读取或输出任何 Provider 凭据和真实 Provider 请求载荷。

## 6. Windows 安装与卸载

实际 NSIS 流程结果：

1. 安装目标在执行前不存在；
2. 安装器以静默模式完成安装，主程序与卸载器均存在；
3. 安装态 fresh 与 v11→v12 E2E 均使用已安装的主程序和打包 Sidecar 完成；
4. 应用进程关闭后运行真实 NSIS 静默卸载；
5. 卸载器退出码为 `0`；
6. 主程序和卸载器均被删除；
7. 隔离用户数据库在卸载后继续存在；
8. 用户数据库卸载前后 SHA-256 完全相同：
   `9b34550f6f8a29044283c15a7c9663611ebdf84f117b3c03f75f5a3abfb7a86c`。

这证明 `deleteAppDataOnUninstall=false` 的实际行为符合冻结要求。

## 7. 回归结果

Core：

```text
python -m ruff check services/core/src services/core/tests
结果：通过

python -m pytest services/core/tests -q --basetemp=.pytest-stage4c-gate4
结果：359 passed, 1 skipped, 1 warning
```

唯一 warning 为既有 Starlette/httpx 弃用提示，不影响断言。

Contracts / Desktop / Electron：

```text
pnpm lint       通过
pnpm typecheck  通过
pnpm test       19 files / 153 tests passed
pnpm build      通过
```

Windows 包验证：

```text
pnpm --filter @aivideo/desktop package:verify
结果：通过
```

`git diff --check` 通过。README 未修改。

## 8. 验收中发现并修复的问题

### 8.1 Contracts 生命周期 guard

真实流程发现：确认某 Revision 后再保存下一 Revision，合法状态应为“新 current 未确认、旧 confirmed 保留”。原 guard 错误要求 `drafted` 的 confirmed 必须为空，与冻结设计冲突。

修复为：

- `drafted` 允许 confirmed 为空；
- 或允许 confirmed 为同一 project/list 的合法 Summary，且 confirmed ID 不等于 current ID；
- `confirmed` 强制 confirmed ID 等于 current ID。

已增加 Contracts 与 Core API“确认后继续演进”回归，并在开发态、fresh 安装态与 v11 升级安装态真实流程中通过。

### 8.2 Electron IPC 安全错误投影

真实并发冲突发现 Electron 包装后的异常不能稳定被 Renderer 识别。Stage 4C IPC 新增窄 `safeInvoke`：

```text
允许投影：
SHOT_LIST_NOT_FOUND
SHOT_LIST_REVISION_NOT_FOUND
SHOT_LIST_INVALID
SHOT_LIST_CONFLICT
SHOT_LIST_CONFIRMATION_CONFLICT

其他异常：
Core request failed
```

这只修复 Stage 4C 自身错误投影，不改变 Stage 1–4B 行为，也不暴露原始异常。

### 8.3 验收夹具问题

v11 升级验收首次发现 Python 夹具把数据库路径字符串直接传给要求 `Path` 的接口；修正为 `Path` 后重新使用全新隔离目录执行。随后项目创建后的立即读取出现异步时序竞争，补充显式轮询后再次使用全新隔离目录执行并通过。

两项均为验收代码问题，不是产品迁移或 UI 功能缺陷；失败时未启动 Provider，失败目录已安全删除。

## 9. 角色审查结论

### LiuWei（架构）

Stage 4C 仍严格限定为人工结构化需求事实层，没有扩张到真实 Provider、媒体生成、Asset 注册或 Timeline 装配；Stage 4A/4B 的 `simulation_only` 行为未修改。

### ZhangSan（Core / SQLite / 任务系统）

SQLite v12、不可变 Revision、复合外键、checksum、备份、并发不覆盖和确认后演进均在真实数据库流程通过。Provider、Request、Task、Job、Asset 与 Timeline 计数保持零增量。

### YeJing（Contracts / Desktop / Electron / Windows）

五个固定 API/IPC、exact DTO、安全错误投影、24 条边界、项目切换、重启恢复、全新安装、安装态升级和实际卸载均可落地。Renderer 权限面没有扩大。

### LiuKeAi（独立验收）

真实 Electron、打包 Sidecar、NSIS 安装/卸载、v11→v12、失败隔离、隐私取证与全量回归证据完整，验收项可重复且不依赖 Provider 凭据。真实图片/TTS Provider、媒体结果、Asset 注册和 Timeline 装配仍未验证，不能从本结论推导其可用。

以上只定义职责和审查边界，不约束角色按固定顺序工作。

## 10. Gate 结论

**Gate 4C-4 判定为通过。**

门禁状态：

- Stage 4C 契约与实现一致；
- Provider 调用数为 `0`；
- README 未修改；
- Stage 4C 最终差异、隐私与冻结边界审查通过；
- Gate 4C-5 收尾、提交、推送、PR/MR 与合并已获授权；
- 本次 Stage 4C PR 合并主干后，Gate 4C-5 通过。
