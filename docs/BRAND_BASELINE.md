# Vortex Cut 品牌基线

状态：正式冻结

日期：2026-08-14

## 用户可见品牌

| 项目 | 冻结值 |
| --- | --- |
| 母品牌 | Vortex |
| 产品名 | Vortex Cut |
| GitHub 仓库 | `trueYJlove/vortex-cut` |
| 对用户描述 | 本地优先、AI 驱动的视频剪辑与多平台创作工具 |
| Windows 新安装身份 | `io.github.trueyjlove.vortexcut` |

本次品牌切换将用户可见元数据和项目入口描述切换为 Vortex Cut。它是新安装身份：不迁移旧 AIVideo Studio 开发安装的数据，不要求覆盖安装兼容，也不主动卸载旧版本或删除旧数据。旧版可由用户按需正常卸载。

## 内部兼容标识

以下是当前实现依赖的内部兼容标识，不属于本次用户可见品牌替换范围，必须保留：

- npm workspace package names：`@aivideo/*`；
- Python distribution name：`aivideo-core`；
- 运行时与构建标识：`aivs_core`、`aivs-core`、`AIVS_*`、`AIVS_READY`、`aivideo://`；
- 既有 SQLite/schema/protocol/API；
- 历史冻结文档和验收文档正文。

这些标识暂留不代表对外品牌仍为 AIVideo Studio。后续如要替换任何内部标识，必须另行设计兼容边界、数据策略与独立验收，不能在本次品牌元数据变更中隐式实施。

## 当前阶段表述

当前代码处于 Stage 2C 的实现与验收阶段。Stage 3 尚未实现；平台预设、游戏配方、HUD保护、BGM/字幕模板与批量导出仍属于后续规划。对外说明只能覆盖已实现的本地剪辑、转录、时间线、受控 AI 候选/时间线修改、权威预览与导出能力，不得将尚未实现或尚未验收的 Stage 3 功能宣传为已交付。

## Windows 配置交付边界

冻结的 Windows appId 为 `io.github.trueyjlove.vortexcut`。当前工作树的 `apps/desktop/electron-builder.yml` 已落地该 appId、产品名 `Vortex Cut` 和安装包产物名 `VortexCut-Setup-${version}-x64.exe`；相应打包与真实包验证脚本名称也已同步更新。

这表示新的 Windows 安装身份已经在当前工作树的配置中落地，但不等同于最终真实 Windows 包验收通过。后续仍须由 LiuKeAi 对新建安装包执行独立验收；在该验收完成前，不得将 Windows 包验证宣称为通过。
