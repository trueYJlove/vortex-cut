# 子系统活规格索引（`docs/specs/`）

> 本目录按稳定子系统合并维护现行**需求边界 + 模块设计 + 契约**。项目当前交付状态统一见 [`../STATUS.md`](../STATUS.md)；未闭环待办明细见 [`../BACKLOG.md`](../BACKLOG.md)；在研提案见 [`../plans/README.md`](../plans/README.md)；架构决策见 [`../adr/README.md`](../adr/README.md)。

| 规格文档 | 覆盖范围 |
|---|---|
| [product-baseline.md](product-baseline.md) | 产品定位（人机共享、程序化对等）与 A1–A4 / B1–B4 / C1–C4 编辑能力基线 |
| [timeline-and-editing.md](timeline-and-editing.md) | 多轨时间线、自由定位、转场、关键帧、字幕/气泡花字/多字体与 Wave 1 剪辑手法 |
| [preview-and-rendering.md](preview-and-rendering.md) | 统一盒模型画布、权威合成 IR 契约、Filmstrip 预抽、WebGPU 合成与 A07/C20/C23/L8 护栏 |
| [desktop-ui.md](desktop-ui.md) | 属性面板 IA 与 Graphite Precision 弹窗视觉系统 v2 规范（含控件与字号档位） |
| [ai-platform.md](ai-platform.md) | AI 架构不变量、分层组合路径、Worklist 编排、Captions 生成与 Stage 1B 稳定错误码 |
| [local-intelligence.md](local-intelligence.md) | CV 自适应采样与预算、本地语义检索、多信号融合粗剪与 W0.4 质量评测体系 |
| [camera-sync.md](camera-sync.md) | W2.1 多机位音频同步设计与 W2.2 说话人层 D3 降级交付契约 |
| [keyframe-understanding.md](keyframe-understanding.md) | Layer 2 云端关键帧理解（帧级审阅审计、fail-closed 探测、词表与数据/接口契约） |
