# 阶段 0 实施交接与所有权

> 负责人：LiuWei（架构师）  
> 依据：`ARCHITECTURE.md`、`docs/STAGE0_DETAILED_DESIGN.md`

## 共享契约冻结

- 协议版本：`1`。
- API 前缀：`/api/v1`。
- Sidecar 就绪消息：`AIVS_READY {json}`。
- 管理认证：`admin_token`，仅 Electron 主进程与 Core 持有。
- UI 认证：`ui_token`，只允许系统读取、媒体探测和任务读写。
- Renderer 只持有 `grant_id`、`media_id`、`job_id` 和 `artifact_id`，不得持有输入绝对路径。
- 时间单位：持久化和 API 使用整数微秒。
- 任务状态：`queued/running/succeeded/failed/cancelling/cancelled/interrupted`。
- WebSocket 断线时由 UI 轮询恢复，以 Core 当前状态为准。
- 外部进程必须使用参数数组启动，不允许 shell 拼接。

契约变更必须由 LiuWei 批准并同步修改详细设计，不允许任一开发人员单边改变协议。

## ZhangSan 所有权

负责且优先修改：

- `apps/desktop/**`
- `packages/contracts/**`
- 根目录 Node/pnpm workspace 文件
- Electron/React 测试
- `electron-builder`、NSIS 和最终安装包资源装配
- 根级开发、CI 和打包命令入口

不得修改 `services/core/**` 内部实现；需要接口变化时向 LiuWei 提出。

## YeJing 所有权

负责且优先修改：

- `services/core/**`
- Python 测试、锁文件和 PyInstaller Sidecar 构建
- FFprobe/FFmpeg、编码器探测、任务状态与 SQLite
- `tools/fixtures/**` 中媒体样本生成逻辑
- `tools/dependencies/**` 中 FFmpeg 组件清单与准备逻辑

不得修改 `apps/desktop/**`；需要桌面侧行为变化时向 LiuWei 提出。

## 共享文件

- `package.json`、`pnpm-workspace.yaml`：ZhangSan 主责。
- `pyproject.toml`、`uv.lock`：YeJing 主责。
- `tools/packaging/**`：按脚本功能分工，Sidecar 构建由 YeJing，安装包检查入口由 ZhangSan。
- `resources/ffmpeg/**` 与许可证：YeJing 提供清单，ZhangSan 负责装入安装包。
- 设计文档：仅 LiuWei 根据已批准变更更新。

两名开发人员共享同一工作区，不得回滚他人修改，发现并发变化时应调整自己的实现。

## 集成里程碑

1. 空 Sidecar 输出就绪协议，Electron 完成真实握手。
2. Electron 注册文件，Core 完成真实 FFprobe 探测。
3. Core 创建代理任务，UI 显示持久化状态和进度。
4. 取消任务后 Core 清理进程树，UI 正确展示取消。
5. 竖屏样片、产物解析与桌面播放贯通。
6. Sidecar onedir 被 Electron/NSIS 实际装配。
7. 安装构建、验证命令和阶段 0 验收清单闭环。

## 禁止事项

- 不扩大到项目、正式时间线、Whisper、OCR、AI Provider 或自动发布。
- 不引入 Redis、PostgreSQL、Docker、n8n、Halo 或多 Agent 产品架构。
- 不以 Mock API 替代最终真实集成验收。
- 不隐瞒未验证的硬件、干净机或许可证风险。
