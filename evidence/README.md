# 验证与实验证据索引（`evidence/`）

本目录集中存放可追溯的实验预登记、评测结果、真机截图、性能采样与独立验收材料。
当前项目状态与未闭环结论统一见 [`docs/STATUS.md`](../docs/STATUS.md)；历史承诺归档见 [`docs/STATUS_ARCHIVE.md`](../docs/STATUS_ARCHIVE.md)。

## 命名与存放约定

- 新实验按日期命名：`YYYY-MM-DD-<topic>/`，目录内至少包含 `README.md` 或成对的 `PRE_REGISTRATION.md` + `RESULT.md`（先写预登记、后落结果）。
- 性能采样归入 `performance/`；早期专题目录（如 `m3_0/`、`m3_2/`、`cv_sampling/`、`quality_eval/`）按原路径保留以维持引用稳定。
- 清理或删改任何证据目录前，先核对 `docs/STATUS.md`、`docs/STATUS_ARCHIVE.md` 与 `docs/design/adr/` 中的引用。

## 主要证据族导航

| 主题域 | 路径 / 前缀 | 说明 |
|---|---|---|
| **OpenFilm UI / 时间线对齐** | `p235-openfilm-timeline-parity-2026-11-23/`、`p235-openfilm-timeline-parity-2026-11-24/`、`2026-11-18-p231-preview-canvas/`、`2026-11-11-light-theme/`、`2026-11-11-timeline-parity/`、`2026-11-09-dialog-family-c/` | OpenFilm 对齐截图、像素对照、浅色主题与弹窗 C 族重构前后对比 |
| **预览与性能测量** | [`performance/README.md`](performance/README.md)、`performance-2026-09-08/`、`m3_0/liukeai_acceptance/`、`m3_2/` | 长时线卡顿归因（P196/P200）、IR 磁盘缓存冷热对照、M3-0 独立复算验收（[报告](m3_0/liukeai_acceptance/ACCEPTANCE_REPORT.md)） |
| **iPhone HDR / HEVC 兼容性** | `2026-11-01-iphone-hevc-blockers/`、`2026-11-05-p203-recheck/` | P203/P204 根因定位、环境验证与降级复测记录（[诊断](2026-11-01-iphone-hevc-blockers/P203_DIAGNOSIS.md) / [环境](2026-11-01-iphone-hevc-blockers/P203_ENVIRONMENT.md) / [复测](2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md)） |
| **W3.3 关键帧理解** | `2026-10-21-w33-keyframe-blind-eval/`、`2026-10-21-w33-a13-packaged/` | 人工盲评预登记与评分表（[结果](2026-10-21-w33-keyframe-blind-eval/RESULT.md)）、PyInstaller 打包取证（[证据](2026-10-21-w33-a13-packaged/EVIDENCE.md)） |
| **W3.1 中文语义检索** | `2026-10-18-w31-semantic-eval/` ～ `2026-10-20-w31-zh-fp32-eval/` | CLIP / Chinese-CLIP 分词、查询、长句与真机视频双塔评测预登记及结果 |
| **W2.1 / W2.2 多机位与说话人（已冻结）** | `2026-10-10-angle-sync/`、`2026-10-10-w22-speaker-spike/` ～ `2026-10-17-w22-embedding-swap/` | 多机位同步负控与 W2.2 七轮说话人分离否证实验（ADR-0009 收口） |
| **其他早期专项** | `2026-10-08-transcript-ui/`、`cv_sampling/`、`quality_eval/` | 转录面板重构截图、CV 采样与质量评测原始证据 |
