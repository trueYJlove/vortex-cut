# Vortex Cut

Vortex Cut 是 Vortex 旗下的本地优先、AI 驱动的视频剪辑与多平台创作工具。桌面应用在本机运行，Electron 负责桌面壳与受控 IPC，Python Core sidecar 负责领域逻辑与持久化，SQLite 保存项目状态；FFmpeg、模型运行时和可选 AI Provider 通过受控接口接入。

当前用户可见品牌已经切换为 **Vortex Cut**。仓库内部兼容标识暂时保留：`@aivideo/*` workspace 包名、`aivideo-core` Python distribution、`aivs_core`/`aivs-core`、`AIVS_*`/`AIVS_READY`、`aivideo://`，以及既有 SQLite schema、协议、API 与历史冻结/验收文档。此次品牌切换不迁移旧 AIVideo Studio 开发安装的数据，也不执行卸载、清理或覆盖安装操作；旧版可由用户按需正常卸载。

## 当前能力与阶段

> **当前阶段、迁移版本与能力边界统一声明在 [`docs/STATUS.md`](docs/STATUS.md)。**
> 本文件不再复述——状态在多处独立复述正是漂移的起点（纪律见 `AGENTS.md`
> 「Documentation Sync Discipline」）。
>
> **历史教训**：本节曾长期写着"项目当前处于 Stage 2C 实现与验收阶段 / Stage 3 尚未实现"。
> 该表述自 Stage 3B 起即已过期（`docs/design/STAGE3B_DETAILED_DESIGN.md` 当时已记录并搁置），
> 直到 2026-09-24 文档审计才修正——期间它使 README 读者低估项目约六个 Stage。

可选外部 Provider 只会在用户明确触发的受控流程中调用；常规开发、单元测试、静态验证与受控 loopback 测试不需要真实 Provider。

## 文档导航

- [AI Agent 入口 (CLAUDE.md)](CLAUDE.md)：AI Agent 开工前必读索引，指向工程纪律、状态源与系统架构。
- [文档总入口](docs/README.md)：按专题查找需求、设计与研究材料。
- [项目状态源 (`docs/STATUS.md`)](docs/STATUS.md)：唯一声明当前阶段、能力边界与未闭环承诺。
- [系统架构](ARCHITECTURE.md)：进程边界、核心模块、数据模型与真实代码分层。
- [用户使用手册](docs/guides/user-manual.md)：编辑器操作说明。
- [工程纪律与文档同步规范](AGENTS.md)：权威文档分工、代码→文档映射、执行门禁与文档同步规则。

## 本地架构

```text
React Renderer
  -> Preload 白名单 API
  -> Electron Main 受控 IPC
  -> Python Core sidecar (127.0.0.1)
  -> SQLite / 本地项目数据 / 受控任务
  -> FFmpeg、模型运行时与可选 Provider
```

Renderer 不直接访问 SQLite、系统凭据或任意网络 URL。Provider 凭据由桌面端安全存储流程管理，Provider 原始响应、Prompt 与媒体正文不应进入 Renderer 状态、日志或验收证据。

## 开发环境

要求：Node.js 24、pnpm 10、Python 3.12–3.13，以及 Windows 本地构建所需工具链。

```powershell
pnpm install --frozen-lockfile
uv sync --extra dev
pnpm dev
```

常用检查与构建入口：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:python
pnpm build
pnpm run ci
pnpm run ci:release
pnpm test:e2e
pnpm contracts:generate
pnpm sidecar:build
pnpm package:win
pnpm package:verify
pnpm package:verify:real
```

> 执行 CI 聚合检查必须写 `pnpm run ci`（或 `pnpm run ci:release`），不能写 `pnpm ci`（`ci` 为 pnpm 内置保留字）。`package:verify:real` 是需要受控本地模型和媒体夹具的真实 Windows 包验证入口；仅在明确准备好隔离环境后执行。它不是日常开发测试，也不应在未经授权时调用真实 Provider。

## 品牌与安装身份

品牌基线、兼容标识和本次不迁移旧开发安装数据的边界见 [docs/guides/branding.md](docs/guides/branding.md)。当前工作树的 Windows Builder 配置已使用新安装身份 `io.github.trueyjlove.vortexcut`、产品名 `Vortex Cut` 和产物名 `VortexCut-Setup-${version}-x64.exe`。真实 Windows 包的交付与验收状态统一见 [docs/STATUS.md](docs/STATUS.md)。
