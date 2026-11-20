# 设计文档

本目录收录系统、产品交互和技术设计。当前状态统一见 [STATUS.md](../STATUS.md)。阶段实施、验收、验证和测量快照集中在[设计记录](records/README.md)。

## 系统与决策

- [系统架构](../../ARCHITECTURE.md)
- [ADR 决策记录](adr/)
- [AI 能力总纲](AI_CAPABILITY_MASTER_PLAN_2026-09-24.md)

## 阶段设计索引

- **Stage 0–1**：[Stage 0 技术设计](STAGE0_DETAILED_DESIGN.md)、[Stage 1 基础设计](STAGE1_DETAILED_DESIGN.md)、[1A 契约](STAGE1A_CONTRACT_FREEZE.md)、[1B 契约](STAGE1B_CONTRACT_FREEZE.md)、[1C 契约](STAGE1C_CONTRACT_FREEZE.md)
- **Stage 2**：2A [契约](STAGE2A_CONTRACT_FREEZE.md) / [详细设计](STAGE2A_DETAILED_DESIGN.md)；2B [契约](STAGE2B_CONTRACT_FREEZE.md) / [详细设计](STAGE2B_DETAILED_DESIGN.md)；2C [契约](STAGE2C_CONTRACT_FREEZE.md) / [详细设计](STAGE2C_DETAILED_DESIGN.md)
- **Stage 3**：3A [契约](STAGE3A_CONTRACT_FREEZE.md) / [详细设计](STAGE3A_DETAILED_DESIGN.md)；3B [契约](STAGE3B_CONTRACT_FREEZE.md) / [详细设计](STAGE3B_DETAILED_DESIGN.md)
- **Stage 4**：4A [契约](STAGE4_CONTRACT_FREEZE.md) / [详细设计](STAGE4_DETAILED_DESIGN.md)；4B [契约](STAGE4B_CONTRACT_FREEZE.md) / [详细设计](STAGE4B_DETAILED_DESIGN.md)；4C [契约](STAGE4C_CONTRACT_FREEZE.md) / [详细设计](STAGE4C_DETAILED_DESIGN.md)；4D [契约](STAGE4D_CONTRACT_FREEZE.md) / [详细设计](STAGE4D_DETAILED_DESIGN.md)；4E [契约](STAGE4E_CONTRACT_FREEZE.md) / [详细设计](STAGE4E_DETAILED_DESIGN.md)。Stage 4 的需求基线见[需求索引](../requirements/STAGE4_REQUIREMENTS.md)。
- **Stage 5–6R**：Stage 5 [契约](STAGE5_CONTRACT_FREEZE.md) / [详细设计](STAGE5_DETAILED_DESIGN.md)；Stage 6-R [契约](STAGE6R_CONTRACT_FREEZE.md) / [详细设计](STAGE6R_DETAILED_DESIGN.md)。旧 Stage 6 草案已移除，以 6-R 为保留设计线。
- **M3 预览引擎**：[M3-0 IR 契约](STAGE_M3_0_IR_CONTRACT_DRAFT.md)、[M3-0 ADR-1](STAGE_M3_0_ADR_1_P2_GATE.md)、[启动建议](STAGE_M3_0_M3_INITIATION_RECOMMENDATION.md)、[M3-1 IR 端点设计](STAGE_M3_1_IR_ENDPOINT_DETAILED_DESIGN.md)、[M3-2 播放重构](STAGE_M3_2_PLAYBACK_REFACTOR_2026-09-06.md)。验收与实施记录见[设计记录索引](records/README.md)。
- **发布历史设计**：[Stage 7 加固](STAGE7_RELEASE_HARDENING.md)、[Stage 8 收口](STAGE8_POST_RELEASE_CLOSURE.md)；当前版本状态只见 [STATUS.md](../STATUS.md)。

## 产品与交互设计

- [品牌素材与规范](BRANDING_ASSETS.md)
- [UI/UX 设计方案](ui-ux-design.md)
- [视频编辑器 UI/UX 研究](VIDEO_EDITOR_UIUX_RESEARCH.md)
- [开源视频编辑器调研](research/open-source-video-editors-survey.md)
- [相似开源项目调研](research/github-similar-projects-survey.md)
- [界面原型](ui-mockups/)
- [M2 多轨时间线](M2_MULTI_TRACK_TIMELINE_DESIGN.md)
- [M2 自由定位](M2_V1_FREE_POSITIONING_DESIGN.md)
- [M2 转场](M2_B2_TRANSITIONS_DESIGN.md)
- [M2 关键帧](M2_B3_KEYFRAMES_DESIGN.md)
- [M2 字幕](M2_B4_CAPTIONS_DESIGN.md)
- [M2 气泡特效](M2_B4_BUBBLE_FX_DESIGN_2026-09-18.md)
- [M2 多字体](M2_B4_MULTI_FONT_DESIGN_2026-09-18.md)
- [画中画 / 蒙版 / 抠像实施历史摘要](records/PIP_MASK_KEYING_IMPLEMENTATION_SUMMARY.md)

## 工作包设计与历史方案

- **多机位与说话人**：[W2.1 同步](W2_1_CAMERA_SYNC_DESIGN_GATE_2026-10-10.md)、[W2.2 说话人层](W2_2_SPEAKER_LAYER_DESIGN_GATE_2026-10-11.md)、[W2.2 降级策略](W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md)。
- **Worklist 与 Provider captions**：[编排](WORKLIST_ORCHESTRATION_DESIGN_GATE_2026-10-01.md)、[本地 captions](WORKLIST_CAPTIONS_DESIGN_GATE_2026-10-02.md)、[Provider captions](WORKLIST_CAPTIONS_PROVIDER_DESIGN_GATE_2026-10-03.md)、[egress](WORKLIST_CAPTIONS_PROVIDER_EGRESS_DESIGN_GATE_2026-10-03.md)、[Provider 适配器](WORKLIST_CAPTIONS_PROVIDER_ADAPTER_DESIGN_GATE_2026-10-05.md)。
- **关键帧理解**：[W3.3 设计门](W3_3_KEYFRAME_UNDERSTANDING_DESIGN_GATE_2026-10-21.md)。

设计与契约按主题浏览本目录；点时间实施、验收与测量记录见[设计记录索引](records/README.md)。被 STATUS.md §6 登记、承载未关闭承诺或被有效决策引用的记录不得因文件名带日期而删除。
