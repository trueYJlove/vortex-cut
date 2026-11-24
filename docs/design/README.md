# 设计文档索引

本目录收录现行系统架构设计、活跃特性方案、核心模块设计及 ADR 决策。当前状态统一见 [`../STATUS.md`](../STATUS.md)；历史实施总结与被代码引用的旧契约见 [`../archive/README.md`](../archive/README.md)。

## 系统与决策

- [系统架构](../../ARCHITECTURE.md)
- [ADR 决策记录索引](adr/README.md)
- [AI 能力总纲](AI_CAPABILITY_MASTER_PLAN_2026-09-24.md)

## 当前活跃设计（OpenFilm 对齐与工作区架构）

- [P236 时间线数据解耦与 Agent 协作工作区架构方案](TIMELINE_DATA_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md)
- [P235 OpenFilm 时间线视觉/交互/功能/性能完整对齐计划](P235_OPENFILM_TIMELINE_PARITY_PLAN.md)
- [品牌素材与规范](BRANDING_ASSETS.md)
- [弹窗系统 v2 原型与设计](ui-mockups/dialog-system-v2/DESIGN.md)（[2026-11-09 规格审计](ui-mockups/dialog-system-v2/SPEC-AUDIT-2026-11-09.md)）
- [属性面板原型](ui-mockups/property-panel/DESIGN.md) / [Wave 1 剪辑工具原型](ui-mockups/wave1-editing-tools/DESIGN.md)

## 编辑核心与 M2 设计

- [M2 多轨时间线](M2_MULTI_TRACK_TIMELINE_DESIGN.md)
- [M2 自由定位](M2_V1_FREE_POSITIONING_DESIGN.md)
- [M2 转场](M2_B2_TRANSITIONS_DESIGN.md)
- [M2 关键帧](M2_B3_KEYFRAMES_DESIGN.md)
- [M2 字幕、气泡花字与多字体设计](M2_B4_CAPTIONS_DESIGN.md)

## AI 工作包与专项设计

- [W4.1 工作单编排与 Captions 设计规格](WORKLIST_AND_CAPTIONS_DESIGN.md)（整合编排、本地装配、Provider 文本生成、Egress 与适配器阶梯）
- [W2.1 多机位同步设计门](W2_1_CAMERA_SYNC_DESIGN_GATE_2026-10-10.md)
- [W3.3 关键帧理解设计门](W3_3_KEYFRAME_UNDERSTANDING_DESIGN_GATE_2026-10-21.md)
