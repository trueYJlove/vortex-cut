# 阶段 0 技术验证验收记录

- 验收日期：2026-08-08
- 验收角色：LiuWei（架构师）
- 设计基线：`ARCHITECTURE.md`、`docs/STAGE0_DETAILED_DESIGN.md`

## 已通过

- Python Core：`uv run pytest services/core/tests -q`，19 passed；`uv run ruff check services/core/src services/core/tests` 和 `uv run pyright services/core/src` 均通过。
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

- 尚未在一台真正干净、没有开发工具和运行时的独立 Windows x64 机器完成安装、覆盖安装、升级和卸载书面验收。当前结果是本机安装器集成验收。
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

阶段 0 的桌面端、Core、Sidecar、真实 FFmpeg 链路、安装包和本机安装生命周期已形成可运行基线。由于真实媒体矩阵、桌面真实 E2E、干净 Windows、硬件编码器和完整兼容矩阵尚未完成，当前结论为：**阶段 0 集成验收进行中，不能宣称阶段 0 已完成。**
