# Stage 4B 独立真实验收记录（LiuKeAi）

> 状态：Gate 4B-4 通过
> 日期：2026-08-18
> 基线：`master` / `38eb2f4 Merge pull request #1 from trueYJlove/codex/stage4a-production`
> 验收方式：真实 Electron + Core Sidecar、全新 Windows x64 NSIS 构建、实际安装、原位重装、重启与卸载；未提交
> Provider 调用数：0

## 1. 验收结论

Gate 4B-4 **通过**。

冻结的 `simulation_only` 工作台已在开发环境和实际 NSIS 安装版本中完成真实交互。空历史、Image、TTS、快速终态、取消、重试 lineage、项目切换、重启恢复均通过；安装版本还完成了原位重装兼容和实际卸载边界验证。

独立 SQLite、磁盘和日志取证确认：Provider invocation 为 0，没有生成媒体，没有生成 Asset 或 Artifact，没有 Timeline Revision，数据库未持久化验收 Prompt，生成 Request/Task/Job 载荷不含真实媒体路径。SQLite 保持 v11，公开 API/DTO/IPC/Preload 和 `CONTRACT_VERSION` 未变化。

## 2. 环境与产物

- 操作系统：Windows 11 专业版 x64，build 26200；
- Node.js：24.16.0；
- 安装包：`VortexCut-Setup-0.0.1-x64.exe`；
- 安装包大小：386,545,696 bytes；
- 安装包 SHA-256：`d34125ffc1f04bafe919d5852da6afe8a35a5d3bf8526c3439a9144c5cefb34a`；
- 打包 Sidecar SHA-256：`8a7fae9292c1926bf76a0b87d59f3ce7df21e827f1ef82ad236c7ac7362dee65`；
- 安装包资源校验：Sidecar、FFmpeg/FFprobe、licenses、component manifest、fonts、model manifests、recipes、platform presets、renditions 全部通过；
- 验收证据根：`test-results/stage4b-gate4-20260818-184844/`。

证据只记录合成 ID、状态、计数和 hash；不记录 Prompt、真实媒体绝对路径、Provider 凭据/载荷、原始异常、stderr、command 或 traceback。

## 3. 开发态真实 Electron + Sidecar

专用 E2E 使用正式 Electron Main、正式 Preload、正式 Renderer、Python Core Sidecar 和隔离 user-data，结果：`1 passed`。

覆盖：

- [x] 新项目的工作台历史为空；
- [x] Image 模拟请求经 Prepare → Confirm → Create 完成；
- [x] TTS 模拟请求经 Prepare → Confirm → Create 完成；
- [x] 确认页仅显示字符数/hash，不回显 Prompt；
- [x] 快速终态可由权威 Task 回读观察；
- [x] queued Task 可取消；
- [x] cancelled Task 可重试，attempt 递增且 retry parent、Task ID 均正确；
- [x] 项目切换关闭工作台并清除表单正文；
- [x] 应用关闭并重启后 Request/Task 历史恢复；
- [x] Provider invocation 计数为 0；
- [x] 用户数据目录无生成媒体；
- [x] 数据库无 Prompt 和生成载荷绝对路径。

开发态证据摘要：3 个 Request、4 个 Task、1 个 cancelled、1 个 retry；无媒体、无输出 Asset、无 Artifact、无 Timeline Revision。

## 4. Windows NSIS 安装态

### 4.1 构建与安装

- [x] 从当前工作树重新构建 Sidecar 和 Desktop；
- [x] electron-builder 生成全新 Windows x64 NSIS 安装包；
- [x] package verify 通过；
- [x] NSIS 静默实际安装退出码为 0；
- [x] 安装目录存在正式应用、Sidecar 与卸载器；
- [x] 安装应用启动，正式 Sidecar 握手并报告 Runtime ready。

### 4.2 安装版本业务交互

安装态专用 E2E 结果：`1 passed`。

- [x] 空历史、Image、TTS、快速终态通过；
- [x] cancel/retry 与 lineage 通过；
- [x] 项目切换清理通过；
- [x] 第一次关闭后使用同一安装包原位重装，退出码为 0；
- [x] 原位重装后重新启动，历史和 retry lineage 均恢复；
- [x] Renderer 公开状态不含 Prompt、真实路径或禁止字段。

安装态证据摘要：4 个 Request、5 个 Task、1 个 cancelled、1 个 retry；原位重装前后的用户事实保持可读。

### 4.3 实际卸载

- [x] NSIS 卸载器实际执行，退出码为 0；
- [x] 安装目录中的正式应用被移除；
- [x] 隔离 user-data 下的项目数据库仍存在；
- [x] 卸载前后数据库 SHA-256 相同；
- [x] 符合 `deleteAppDataOnUninstall: false` 的既有打包契约。

## 5. SQLite、磁盘与隐私取证

安装态数据库事实：

| 检查项 | 结果 |
|---|---:|
| v11 migration 存在 | 是 |
| Request | 4 |
| Task | 5 |
| cancelled Task | 1 |
| retry lineage | 1 |
| Provider invocation | 0 |
| generation output Asset | 0 |
| generation Artifact | 0 |
| Timeline Revision | 0 |
| 用户数据目录生成媒体 | 0 |
| Prompt 命中 | 0 |
| 生成载荷真实媒体路径命中 | 0 |
| Desktop 日志敏感哨兵命中 | 0 |

项目中唯一 Asset 是为模拟输入导入的验收素材，不是生成结果；`media_generation_tasks.output_asset_id` 全部为空，且生成 Job 没有 Artifact。

## 6. Stage 1–4A 回归

- Core：`354 passed, 1 deselected, 1 warning`；deselected 为明确排除的 `real_provider`；
- Desktop/Contracts：17 个测试文件、`138 passed`；
- Ruff：通过；
- Pyright：0 errors / 0 warnings；
- `pnpm lint`：通过；
- `pnpm typecheck`：通过；
- `pnpm build`：通过；
- `git diff --check`：通过。

Core pytest 在退出清理 Windows 临时符号链接时出现既有 `PermissionError` 提示；进程退出码为 0，354 个断言通过，不影响 Gate 判定。

## 7. 冻结边界复核

- [x] Provider 调用数为 0；
- [x] 未读取或输出 Provider token、API key、Authorization 或请求载荷；
- [x] 未生成媒体、未注册生成 Asset、未写 Timeline；
- [x] 未触发 Stage 3 Preview、Render、Export 或 Batch；
- [x] SQLite 保持 v11；
- [x] API/DTO/Core Client/IPC/Preload 零新增；
- [x] `CONTRACT_VERSION` 保持 `stage3b-v1`；
- [x] README 未修改；
- [x] 未修改 Stage 4A Core 和 Stage 1–3B 冻结实现；
- [x] 本轮未提交。

## 8. Gate 判定与后续限制

Gate 4B-4 最终判定：**通过**。

本结论只证明 Stage 4B 的模拟工作台、任务生命周期、安装兼容和隐私边界可在真实 Windows 应用中落地，不代表任何真实图片或 TTS 生成质量已经验证。真实 Provider、真实媒体生成、Asset 注册、Timeline 集成继续标记为 `UNVERIFIED`，不得因本 Gate 通过获得隐式授权。

用户已于 2026-08-18 明确授权进入 Gate 4B-5；最终差异、隐私和冻结边界审查通过后，允许完成提交、推送、PR/MR 与合并。本次 Stage 4B PR 合并主干后，Gate 4B-5 通过。
