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

> **项目当前阶段、能力边界和发布状态只见 [`../STATUS.md`](../STATUS.md)，本文件不复述。**

对外说明只能覆盖 `STATUS.md` §3「能力边界（已交付，可对外）」中列出的能力；
**不得宣传该节未列出的能力**（含 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` 中仍在规划的部分）。

历史版本曾把阶段与能力状态写在此处并造成口径漂移；该旧段落已移除。Windows 包的实现和验收状态统一查 [`../STATUS.md`](../STATUS.md)。
