# 设计与实施记录

这里集中保存点时间的技术设计、实施、验收、验证、性能测量和交接记录。它们用于追溯当时的方案与结果，不作为项目当前状态源；当前状态见 [STATUS.md](../../STATUS.md)。

## 按文件名前缀查找

- `STAGE*`：Stage 0–8 与 M3 阶段设计、契约、评审及验证记录。
- `AI_*`、`CV_*`、`W*`、`WORKLIST_*`：AI、CV、Worklist 等工作线的规划实施与验收记录。
- `PERFORMANCE_*`：性能方案、实施、测量与验收记录；实验原始材料仍在仓库根目录 `evidence/performance/`。
- A01–A08 八份逐项自检已合并为[第一轮汇总](PERFORMANCE_A01_A08_SUMMARY.md)；统一复测见设计目录中的 G1 报告。
- B10–B17 八份实施自检已合并为[工作包汇总](PERFORMANCE_B10_B17_SUMMARY.md)；逐项独立验收见集中复核报告。
- D11 驻留上限与 Electron 升版两份实测稿已合并为[验证摘要](PERFORMANCE_D11_RESIDENCY_SUMMARY.md)，原始测量留在 `evidence/performance/d11-*`。
- HEVC 预览 H1–H3 四份实施稿已合并为[实现汇总](MEDIA_DECODER_HEVC_IMPLEMENTATION_SUMMARY.md)；P29 真机性能定档保留为独立记录。
- PIP、蒙版、抠像旧实施计划已精简为[历史实现摘要](PIP_MASK_KEYING_IMPLEMENTATION_SUMMARY.md)；旧限制不作为当前状态。
- 2026-11-10 的 UI Round 与阶段验收稿已合并为[编辑器 UI 改造汇总](EDITOR_UI_REFRESH_2026-11_SUMMARY.md)；P221/P224 正式记录仍单独保留。
- `DESKTOP_*`、`TIMELINE_*`、`PREVIEW_*`、`GATE*`、`LIGHT_THEME_*`：桌面、时间线、预览和视觉实现记录。
- `PROJECT_RELEASE_STATUS.md`、`WORKLIST_*_DECISION_*` 等：历史发布状态与工作流决策，仅用于追溯；当前状态以 STATUS.md 为准。
- `MEDIA_*`、`QUALITY_*`、`CI_*`：媒体、质量评估与 CI 记录。

如记录已被取代，顶部横幅和 `STATUS.md` §6 会说明替代关系。删除候选需先确认结论已合并、无未关闭承诺或有效引用，也无独立证据价值。
