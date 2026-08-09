# 阶段 0 技术验证验收记录

- 验收日期：2026-08-08
- 验收角色：LiuWei（架构师）
- 设计基线：`ARCHITECTURE.md`、`docs/STAGE0_DETAILED_DESIGN.md`

## 环境与证据边界

- 开发调试阶段优先使用本机已有的 Node.js、Python、pnpm/uv 和 FFmpeg；只有本机缺少必要工具时才安装或下载。开发机版本只要能够完成项目命令、测试和调试即可。
- 发布构建仍使用仓库锁文件和推荐版本复现；安装包运行不依赖用户机器上的 Node.js、Python 或系统 FFmpeg。
- 当前只有这一台开发机，因此已执行的安装、启动、Sidecar 握手、Core/FFmpeg 链路和卸载只能记为“本机集成验证”。它们不能证明“无开发环境 Windows x64 机器”或“干净 Windows 机器”验收。
- “干净 Windows 机器”必须在 Windows Sandbox、虚拟机、重置后的独立系统或另一台没有开发工具的 Windows x64 机器上执行，并保存安装、启动、覆盖安装/升级、卸载和数据保留记录。新建普通用户、关闭终端或在本机卸载部分工具均不等价于干净机。

## 已通过

- Python Core：`uv run pytest services/core/tests -q`，19 passed；`uv run ruff check services/core/src services/core/tests` 和 `uv run pyright services/core/src` 均通过。按第 20 节覆盖率门槛执行 `uv run --extra dev pytest services/core/tests --cov=services/core/src --cov-fail-under=80` 时为 78.10%，因此覆盖率验收未通过。
- 桌面端：`pnpm run ci` 通过，包含 lint、TypeScript typecheck、Vitest 和生产构建。
- 真实媒体链路：FFprobe 探测成功；真实竖屏输出为 H.264/AAC、`1080x1920`、CFR 30fps；软件编码回退为 `libopenh264`，背景模糊使用 `gblur`。
- Renderer E2E：`pnpm --filter @aivideo/desktop test:e2e` 当前为页面级 smoke/mock，覆盖页面加载、`Generate portrait sample` 和 `Artifact validation`；不等同于真实导入、转码、取消和产物 E2E。
- Sidecar 与资源：`pnpm package:verify` 通过；Sidecar、FFmpeg、FFprobe、许可证和 `components.json` 哈希均存在且已校验。
- 安装包：`apps/desktop/release/AIVideoStudio-Setup-0.0.1-x64.exe`，大小 190,974,875 bytes，SHA-256 `DB4DE4310CD59EC7F6AC4F41A6B1C8FC553703BA6B9CFDE412E6356F44B0BC6A`。
- 安装后校验：对实际安装目录执行 `node apps/desktop/scripts/verify-package.mjs`，通过。
- 安装后启动：实际安装版本运行超过 8 秒，进程正常存在并可关闭。
- 卸载：使用 `Uninstall AIVideo Studio.exe /S`，退出码 0，安装目录已清理。
- 打包命令：`pnpm package:win` 无需手工环境变量即可完成；脚本自动探测已校验的 NSIS、NSIS resources 和 7zip 工具，并准备 electron-builder 兼容性补丁。
- Sidecar 真实启动：安装包内 Core 已生成 `ready.json`，FastAPI 启动完成；Electron 日志已完成 `ready file received`、健康检查和 `Core UI session ready`；使用同一 SQLite 数据库重启后遗留 `running` 任务已恢复为 `interrupted`。
- PyInstaller 入口修正：使用独立 `services/core/entrypoint.py`，避免将带相对导入的 `bootstrap.py` 作为顶层脚本打包。
- `git diff --check`：通过。

## 未完成或不应宣称已通过

- **干净机验收未执行**：当前只有本机，不能提供无开发环境 Windows x64 或干净 Windows 机器的证据。已完成的只是本机安装器集成验收。
- 尚未验证 NVIDIA、AMD、Intel 硬件编码器；当前只验证了软件 `libopenh264` 路径。
- 已形成打包版独立运行目录下 Electron 完成 Sidecar 认证并写入 `Core UI session ready` 的稳定记录；仍需干净机复核。
- 尚未完成 VFR、无音轨和中文路径四类媒体的逐项真实输出验收；`pnpm run verify:stage0:real` 已提供可重复入口，但当前工具会话无法可靠回传其子进程输出，需在普通 PowerShell 中执行并保存 JSON 报告。
- 当前桌面 E2E 尚未覆盖真实 UI 到 Core 的导入、任务、取消和产物操作链路。

## 本轮复核（2026-08-09）

- `uv run pytest services/core/tests -q`：19 passed。
- `uv run ruff check services/core/src services/core/tests`：通过。
- `pnpm run ci`：通过（桌面 lint、contracts typecheck、desktop typecheck、Vitest 5 tests、production build）。
- `python -m py_compile tools/verify_stage0_real.py`：通过。真实验收脚本已增强为独立运行目录、分步 `report.json` checkpoint、竖屏输出规格断言，以及取消后 FFmpeg PID 清理断言。
- 当前 Codex 工具宿主在启动带子进程的长时间 Windows 验收时会提前关闭 stdout 或终止父进程；因此 `tools/verify_stage0_real.py` 尚未形成可采信的完整通过报告。本限制不能视为产品验收通过。应在普通 PowerShell 中运行脚本并读取 `%TEMP%\aivideo-stage0-real-py\report.json`。
- 本轮仍未获得 ZhangSan、YeJing 的实际 subagent 完成记录：协作工具调用持续返回 `failed to parse function arguments: EOF while parsing a value`。不能将本地修改归因给两名工程师或伪造其完成证据。

## 验收结论

### 本轮补充证据（2026-08-09）

- `pnpm --filter @aivideo/desktop test:e2e`：1 passed。Playwright 配置已自动探测本机 Chrome；该用例仍是页面 smoke/mock，不作为真实 UI 到 Core 集成证据。
- `pnpm --filter @aivideo/desktop package:verify`：通过。
- `tools/verify_stage0_real.py` 已增加独立运行目录、分步报告 checkpoint、竖屏规格断言及取消后 FFmpeg 进程清理断言；当前 Codex 宿主仍无法为长时间子进程提供可靠 stdout/完整报告。
- 真实打包 Core 验收报告已通过：健康检查、CFR 有音轨、无音轨、奇数尺寸、损坏文件探测、proxy、竖屏样片、产物规格和取消后 5 秒内 FFmpeg 进程清理均通过。
- 真实验收发现并修复 proxy API 对短素材默认 10 秒导致 `MEDIA_RANGE_INVALID` 的缺陷；现在未指定时长时使用媒体剩余时长，并增加 API 回归测试。
- 修复后重新构建 Sidecar 和 Windows 安装包：`apps/desktop/release/AIVideoStudio-Setup-0.0.1-x64.exe`，190,976,122 bytes，SHA-256 `FEB7AB3F22DF631C678E9A9A37199AAA6C2053FDB9A4C8C3C765F8471679307F`。
- 真实打包 Core 验收报告已通过：健康检查、CFR 有音轨、无音轨、奇数尺寸、损坏文件探测、proxy、竖屏样片、产物规格和取消后 5 秒内 FFmpeg 进程清理均通过。
- 真实验收发现并修复 proxy API 对短素材默认 10 秒导致 `MEDIA_RANGE_INVALID` 的缺陷；现在未指定时长时使用媒体剩余时长，并增加 API 回归测试。
- 修复后重新构建 Sidecar 和 Windows 安装包：`apps/desktop/release/AIVideoStudio-Setup-0.0.1-x64.exe`，190,976,122 bytes，SHA-256 `FEB7AB3F22DF631C678E9A9A37199AAA6C2053FDB9A4C8C3C765F8471679307F`。

## 最新复核证据（2026-08-09，当前构建）

- `python tools/verify_stage0_real.py`：退出码 0，`%TEMP%\aivideo-stage0-real-py\report.json` 状态为 `passed`。报告覆盖 health/ready、CFR 有音轨、无音轨、奇数尺寸、损坏素材、proxy、竖屏样片、H.264/AAC、`1080x1920`、CFR 30fps、`yuv420p`、产物规格及 SHA-256；取消任务前记录 FFmpeg PID `19676`，取消后 5 秒内残留 PID 为空。取消场景使用临时 45 秒素材，未修改产品取消语义。
- `pnpm run verify:desktop:real`：退出码 0。真实打包 Electron 窗口启动成功，页面显示 `Core connected`，选择真实 `cfr-landscape-av.mp4` 后完成 `Generate proxy`，任务状态为 `succeeded`，并通过 `Validated artifact`；测试结束后 Electron/Core 进程已回收。
- 当前安装包文件大小为 190,977,489 bytes，SHA-256 为 `C2E052559CF47AFE2475D7545713BFAB7A238F78493F01B82847B5BDD2ACFDCA`；以该哈希为当前构建证据，历史哈希仅保留作历史记录。
- `pnpm run package:verify` 和 `pnpm run ci` 均通过；`uv run --extra dev pytest services/core/tests -q` 为 19 passed，但覆盖率门槛命令结果为 78.10%（低于 80%），该项未通过。
- `resources/manifests/components.json` 中 `aivs-core` 的 SHA-256 已更新为当前 Sidecar 构建值 `577c0afc94171878d76a8763ce9f5ec69d37740711b749ba07843034396bc59a`。

阶段 0 的桌面端、Core、Sidecar、真实 FFmpeg 链路、真实打包 Electron E2E、安装包和本机安装生命周期已形成可运行基线。当前仍未满足第 20 节全部验收条件：Python 核心覆盖率为 78.10%，只有一台开发机无法完成无开发环境/干净 Windows 书面验收；NVIDIA/AMD/Intel 硬件编码器、VFR、中文路径等兼容矩阵尚未完整验证；且 `package:win` 仍依赖构建前置资源准备而非完全从空 checkout 自举。因此当前结论为：**阶段 0 本机集成验收通过，阶段 0 全量验收未通过，暂不应将阶段 0 标记为 complete。**
