# 阶段 1A 独立验收记录

- 验收日期：2026-08-09
- 架构师：LiuWei
- 独立验收：LiuKeAi
- 契约基线：`docs/STAGE1A_CONTRACT_FREEZE.md`，版本 `stage1a-v1`
- 环境：Windows 11、Python 3.13.1、uv 0.12.3、Node.js 24.16.0、pnpm 10.12.1

## 总体结论

阶段 1A **通过**，所有阻塞项已关闭；本记录不启动阶段 1B。

## 验收结果

| 验收项 | 结论 | 结果 |
|---|---|---|
| Core 测试与质量 | 通过 | 45 passed，覆盖率 89.52%；Ruff、Pyright 通过 |
| 项目生命周期 | 通过 | 创建、重命名、归档、重新打开通过 |
| 四类素材 | 通过 | video/audio/image/text 导入、指纹去重通过 |
| 素材状态 | 通过 | missing、changed、relocate 和原始素材只读引用通过 |
| Job 持久化 | 通过 | project_id 持久化、项目 Job 列表、取消通过 |
| 重启恢复 | 通过 | running/cancelling 重启后变为 interrupted，项目 Job 列表仍可见 |
| SQLite migration v1 | 通过 | schema_migrations、备份、Stage 0 接管、未知版本保护、事务回滚通过 |
| Contracts/Desktop | 通过 | contracts build、lint、typecheck、12 个 Vitest 测试通过 |
| 真实 Electron E2E | 通过 | 真实 Electron、源码 Core、FFmpeg/FFprobe 和真实文件授权链路通过 |
| 自动打包链 | 通过 | package:win 自动构建当前 Sidecar，不依赖人工预构建 |
| 包内 Core 黑盒 | 通过 | 项目、四类素材、Job project_id、项目 Job 列表、取消、migration v1 通过 |
| 安全隔离 | 通过 | Renderer 未暴露绝对路径、管理令牌、数据库路径 |
| LiuKeAi 独立验收 | 通过 | 基于独立命令、真实 E2E、包内黑盒和 hash 审计 |

## 关键命令

```text
uv run --extra dev pytest services/core/tests --cov=services/core/src --cov-report=term-missing --cov-fail-under=80
uv run ruff check services/core/src services/core/tests
uv run pyright services/core/src
pnpm --filter @aivideo/contracts build
pnpm --filter @aivideo/desktop lint
pnpm --filter @aivideo/desktop typecheck
pnpm --filter @aivideo/desktop test
pnpm --filter @aivideo/desktop test:e2e
pnpm run ci
pnpm package:win
pnpm package:verify
```

## 证据

- Core 重启恢复：`test-results/stage1a-acceptance/core-job-final2-20260810000051/core-job-final2-evidence.json`
- migration：`test-results/stage1a-acceptance/migration-20260810000112`
- Electron E2E：`test-results/stage1a-electron-7324-1786291279537`
- E2E SQLite：`test-results/stage1a-electron-7324-1786291279537/user-data/data-v2/app.db`
- 包内 Core 黑盒：`test-results/stage1a-acceptance/packaged-core-final-20260810000517/packaged-core-final-evidence.json`
- Bootstrap：`build/reports/bootstrap-windows.json`
- 安装包：`apps/desktop/release/AIVideoStudio-Setup-0.0.1-x64.exe`
- 安装包 SHA-256：`2efcea70e506061ffb964c1f41919703f009d9512f612a7beb61d4e117da88d6`
- Core hash：`3a02bbb422fcd6e11eb2cc0ba3891b7e09fb20a50167b896b843d8909c486470`

## 剩余风险

- electron-builder 提示 `package.json` 缺少 description/author，不阻塞阶段 1A。
- PyInstaller 提示可选 hidden import `tzdata`，当前阶段 1A 黑盒验证不受影响，建议发布前处理。
- FastAPI/httpx 存在弃用警告，不影响本阶段结论。

ASR、Timeline/TimelinePatch、Render Plan、最终 Export 按范围保持未实现，不作为阶段 1A 验收项。
