# 阶段 0 本机收尾验收记录

- 验收日期：2026-08-09
- 架构师：LiuWei
- 独立验收：LiuKeAi
- 设计基线：`ARCHITECTURE.md`、`docs/design/STAGE1_DETAILED_DESIGN.md`、`docs/design/adr/0001-stage0-exit-and-stage1-entry.md`
- 验收环境：Windows 11、Python 3.13.1、uv 0.12.3、Node.js v24.16.0、pnpm 10.12.1、PowerShell 5.1

## 门禁结论

| 门禁 | 结论 | 证据摘要 |
|---|---|---|
| G0-1 Python Core 覆盖率 | 通过 | 40 passed，总覆盖率 95.18%；Ruff 和 Pyright 通过 |
| G0-2 真实媒体兼容 | 通过 | VFR proxy、无音轨 proxy/竖屏、中文路径 proxy/竖屏均使用真实 FFmpeg/FFprobe 通过 |
| G0-3 Windows 构建自举 | 通过 | 清空 node_modules、Electron runtime、Core、FFmpeg 和 release 的隔离副本完成自举并生成安装包 |
| G0-4 独立验收 | 通过 | LiuKeAi 基于独立命令、真实产物、JSON 报告和哈希审计复验通过 |

## G0-1 证据

执行命令：

```text
uv run --extra dev pytest services/core/tests --cov=services/core/src --cov-report=term-missing --cov-fail-under=80
uv run ruff check services/core/src services/core/tests
uv run pyright services/core/src
```

结果：40 个测试通过，总覆盖率 95.18%；Ruff 无错误；Pyright 0 errors、0 warnings。

证据文件：

- `C:/DataFolder/codes/AI-Vidio/test-results/liukeai-g0-1-pytest-20260809.txt`
- `C:/DataFolder/codes/AI-Vidio/test-results/liukeai-g0-1-quality-20260809.txt`

## G0-2 证据

执行命令：

```text
python tools/verify_stage0_real.py
```

真实验证覆盖以下场景：

- VFR proxy
- 无音轨 proxy
- 无音轨竖屏输出
- 中文路径 proxy
- 中文路径竖屏输出

竖屏产物均验证为 1080x1920、H.264、CFR 30fps、yuv420p；取消任务后 5 秒内无残留 FFmpeg 进程。

证据文件：

- JSON 报告：`C:/Users/trueY/AppData/Local/Temp/aivideo-stage0-real-py/report.json`
- FFprobe 证据目录：`C:/Users/trueY/AppData/Local/Temp/aivideo-stage0-real-py/runtime-12336-1786277827410545300/evidence`
- 复验日志：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-2-real-20260809-rerun.txt`

## G0-3 证据

执行命令：

```text
pnpm install --frozen-lockfile
pnpm bootstrap:windows
pnpm package:win
pnpm package:verify
pnpm run ci
pnpm test:bootstrap:windows
```

隔离副本：
`C:/Users/trueY/AppData/Local/Temp/aivideo-g0-3-clean-rerun-20260809`

隔离副本初始不存在 node_modules、apps/desktop/node_modules、resources/core、resources/ffmpeg 和 apps/desktop/release。自举后实际生成并校验 Electron 36.2.1 runtime、Sidecar、FFmpeg/FFprobe、组件 manifest、许可证和 NSIS 安装包。

安装包：

- 路径：`C:/Users/trueY/AppData/Local/Temp/aivideo-g0-3-clean-rerun-20260809/apps/desktop/release/AIVideoStudio-Setup-0.0.1-x64.exe`
- 大小：190,977,823 字节
- SHA-256：`291517eaa7cd3465701bcaaee7eab78d5236eb098e1fd122a09edc8587fc37ff`

负向测试确认 Electron runtime 缺失时 bootstrap 非零退出，并在报告中记录失败原因。

证据文件：

- 安装日志：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-install-20260809.txt`
- Bootstrap 日志：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-bootstrap-20260809.txt`
- 打包日志：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-package-win-20260809.txt`
- 校验日志：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-package-verify-20260809.txt`
- 组件审计：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-audit-20260809.txt`
- 完整 CI：`C:/Users/trueY/AppData/Local/Temp/liukeai-g0-3-clean-rerun-ci-20260809.txt`
- Bootstrap JSON：`C:/Users/trueY/AppData/Local/Temp/aivideo-g0-3-clean-rerun-20260809/build/reports/bootstrap-windows.json`

## 未验证项与准入决策

以下项目仍明确记录为“未验证”，没有使用本机结果替代：

- 干净 Windows、无开发环境安装/升级/卸载生命周期
- NVIDIA、AMD、Intel 硬件编码器矩阵
- 5 GB 以上及 1 至 2 小时长视频性能
- 完全无缓存且无网络环境下的依赖取得

上述项目按阶段 1 设计和 ADR 约定不阻塞本次本机收尾门禁。LiuWei 根据 LiuKeAi 独立验收报告确认 G0-1 至 G0-4 全部通过，阶段 1A 具备本机准入条件。

本记录不宣称阶段 0 在所有外部环境完成，也不启动阶段 1A 编码。
