# Stage 7：发布加固与发布收口计划

> 状态：Stage 7 发布收口已完成，Gate 7-R0–R5 全部通过
> 架构与 Gate 判定：LiuWei
> 独立验收：LiuKeAi
> 阶段起始基线：`d9bd1a3`；发布合并提交：`4e2a7db`；发布后收口提交：`38bdcfd`
> 当前版本：`0.0.1`
> 目标：形成可交付的 Windows 桌面应用发布基线

## 1. 阶段边界

Stage 7 不新增业务功能，只做发布级加固与收口。

仅覆盖：

- 主线基线核对；
- 发布版全量回归；
- Windows 打包与安装验证；
- 隐私与安全终审；
- 发布文档与版本信息收口；
- 最终版本控制操作。

不覆盖：

- 新 Timeline / Assembly 能力；
- 新 Provider 或网络能力；
- README 重写；
- 自动更新；
- 云服务；
- 跨平台发布；
- 新的数据库 schema；
- 新的契约版本。

## 2. Gate 7-R0：主线同步与现状审查

- [x] `origin/master` 已包含 PR #12；
- [x] 本地 `master` 已快进到 `d9bd1a3`；
- [x] `liuwei-dev` 已快进到 `d9bd1a3`；
- [x] 工作区 clean；
- [x] `stash@{0}` 未应用、未弹出、未删除；
- [x] 发布收口缺口已盘点。

> Gate 7-R0 记录：Stage 6-R 已进入 `origin/master`，发布收口缺 Stage 7 文档、最终发布报告、最终主线全量回归和最终发布级 Windows 验证。

## 3. Gate 7-R1：发布文档冻结

- [x] 新增本文件；
- [x] 明确 Stage 7 只做发布收口，不新增业务功能；
- [x] 明确最终发布检查清单；
- [x] 记录当前版本号仍为 `0.0.1`；
- [x] 记录 README 在本阶段保持不修改；
- [x] 修正 Stage 6-R 独立验收文档最终状态。

## 4. Gate 7-R2：主线最终回归

- [x] Core 全量测试通过；
- [x] Contracts build/typecheck 通过；
- [x] Desktop typecheck/tests/build 通过；
- [x] Stage 5 E2E 通过；
- [x] Stage 6-R E2E 通过；
- [x] Ruff 全仓通过；
- [x] `git diff --check` 通过；
- [x] README 未修改；
- [x] 无未授权 Provider 调用；
- [x] 无网络外传；
- [x] 无敏感数据输出。

## 5. Gate 7-R3：Windows 发布验证

- [x] 使用当前主线源码重新打包；
- [x] package verify 通过；
- [x] bootstrap verify-only 通过；
- [x] development fresh E2E 通过；
- [x] development upgrade E2E 通过；
- [x] installed fresh E2E 通过；
- [x] installed upgrade E2E 通过；
- [x] 静默安装验证通过；
- [x] 静默卸载验证通过；
- [x] 卸载后用户数据保留策略验证通过；
- [x] 包内组件 SHA-256 校验通过；
- [x] Sidecar / FFmpeg / Electron 组件验证通过。

> Gate 7-R3 记录：r9 Windows 安装包完成发布验证。development / installed 的 fresh 与 upgrade E2E 均通过；静默安装、10 项关键组件校验、静默卸载与用户数据保留由用户在 PowerShell 中手动验证通过。Electron GPU 环境异常已通过 E2E 测试专用降级参数规避；同时显式隔离外部 `AIVS_E2E_MODEL_DIR`，避免 Sidecar 启动被无关环境变量干扰。Provider 调用、网络外传与费用增量均为 0。

## 6. Gate 7-R4：隐私与安全终审

- [x] Provider 调用增量 0；
- [x] 网络外传增量 0；
- [x] 费用增量 0；
- [x] 不读取、不输出 token / API key / Authorization；
- [x] 不读取、不输出原始请求 / 响应；
- [x] 不读取、不输出媒体绝对路径；
- [x] 不输出 Prompt / Requirement 正文；
- [x] 不输出字幕 / 转写正文；
- [x] 不输出原始异常对象；
- [x] 日志与公开证据隐私扫描通过；
- [x] 数据库持久化字段隐私扫描通过。

## 7. Gate 7-R5：版本控制与发布判定
- [x] 发布验收预检报告完成；
- [x] 文档状态一致；
- [x] 工作区 clean；
- [x] 用户明确授权 commit；
- [x] 用户明确授权 push；
- [x] 用户明确授权 PR / MR；
- [x] 用户明确授权合并；
- [x] 最终发布判定通过。

> Gate 7-R5 收口记录：发布验收预检通过后，用户已依次授权 commit、push、PR 与合并。PR #13 合并提交为 `4e2a7db`。发布后用户授权将本地 `master` 快进到 `origin/master`，并通过 `38bdcfd` 将 `.tmp/` 与 `apps/desktop/.cache/` 加入 `.gitignore` 后推送。当前 `master` 与 `origin/master` 均为 `38bdcfd`，工作区 clean，`stash@{0}` 保留且未应用、未弹出、未删除。最终发布判定通过。

## 8. 证据要求

建议证据路径：

```text
build/reports/stage7-core-full.json
build/reports/stage7-contracts.json
build/reports/stage7-desktop.json
build/reports/stage7-stage5-electron.json
build/reports/stage7-stage6r-electron.json
build/reports/stage7-ruff.json
build/reports/stage7-windows-package.json
build/reports/stage7-bootstrap-verify.json
build/reports/stage7-privacy-scan.json
build/reports/stage7-release-acceptance.json
```

证据必须记录：

- 基线提交；
- 目标环境；
- 测试范围；
- 通过 / 失败计数；
- 数据库 schema version；
- Provider delta；
- 网络 delta；
- 费用 delta；
- 隐私扫描结果；
- 失败时的稳定错误码。

## 9. 发布硬约束

- 不调用真实 AI Provider；
- 不启用 Provider 网络；
- 不产生费用增量；
- 不新增业务功能；
- 不修改 README；
- 不引入新的数据库 schema 或契约版本；
- 不引入 Alembic / SQLAlchemy / `services/web`；
- 不输出敏感数据或原始异常；
- 不执行未授权版本控制操作。

## 10. 通过标准

Stage 7 只有在以下条件全部满足时才可判定发布收口完成：

1. Gate 7-R0–R5 全部通过；
2. 主线全量回归通过；
3. Windows 发布验证通过；
4. 隐私与安全终审通过；
5. 文档与实现一致；
6. 工作区 clean；
7. 用户明确授权所有版本控制与发布操作。
