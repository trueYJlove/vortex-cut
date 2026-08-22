# 项目发布状态与下一阶段

> 日期：2026-08-22
> 主线基线：`0194c44`；Stage 8 规划分支：`codex/stage8-post-release-planning`
> 当前分支：`codex/stage8-post-release-planning`
> 当前版本：`0.0.1`
> 当前阶段：Stage 8 收口完成，待实施 `0.0.2` 维护版

## 1. 当前结论

Stage 7 发布加固与发布收口已完成。PR #13 已合并到 `master`，合并提交为 `4e2a7db`；发布后 `.gitignore` 收口提交为 `38bdcfd`，并已推送到 `origin/master`。

当前主线包含：

- 阶段 0–4 历史实现；
- Stage 5：单条已采用图片的显式 Timeline 装配；
- Stage 6-R：多条当前已采用图片的显式 Timeline 批量装配；
- SQLite v17；
- Desktop / Electron / Contracts / Core 对应实现；
- Windows r9 安装包及安装态验证证据；
- 发布加固后的 E2E 环境隔离与依赖修复。

当前不进入新功能开发。下一阶段是 Stage 8 发布后收口与下一版规划。

## 2. Stage 7 已完成的主线验证

- Core 全量回归：478 passed / 1 skipped；
- Contracts build/typecheck 通过；
- Desktop typecheck / 219 tests / build 通过；
- Stage 5 E2E 通过；
- Stage 6-R E2E 通过；
- Ruff 受管源码范围通过；
- `git diff --check` 通过；
- Windows r9 package verify 通过；
- bootstrap verify-only 通过；
- development fresh / upgrade E2E 通过；
- installed fresh / upgrade E2E 通过；
- 静默安装、静默卸载、关键组件与用户数据保留验证通过；
- 包内组件 SHA-256 校验通过；
- 隐私与安全专项测试及扫描通过；
- README 未修改；
- Provider 调用、网络外传、费用增量均为 0。

## 3. Stage 7 最终版本控制状态

- PR #13：已合并；
- PR #13 合并提交：`4e2a7db`；
- 发布验收提交：`8b0b3b4`；
- 发布后 `.gitignore` 收口提交：`38bdcfd`；
- 本地 `master`：`38bdcfd`；
- `origin/master`：`38bdcfd`；
- `liuwei-dev`：`8b0b3b4`；
- `origin/liuwei-dev`：`8b0b3b4`；
- `stash@{0}`：保留，未应用、未弹出、未删除；
- 工作区：clean。

## 4. Stage 8 完成状态

- Gate 8-R1：发布后收口审计与文档一致性修复，通过；
- Gate 8-R2：遗留项处置计划，通过；
- Gate 8-R3：`0.0.2` 维护版范围冻结，通过；
- Gate 8-R4：独立验收与阶段收口，通过。

## 5. 发布判断

Stage 7 发布判定通过。当前代码基线 `38bdcfd` 可作为 Windows 桌面应用 `0.0.1` 的发布基线。下一阶段不新增业务功能，只实施 `0.0.2` 版本号升级，并按 Stage 8 冻结的回归与发布验证范围执行验证。