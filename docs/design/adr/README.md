# 架构决策记录（ADR）索引

本目录收录 Vortex Cut 项目关键架构与方向裁决。当前状态、已冻结范围与解冻条件统一以 [STATUS.md](../../STATUS.md) 为准。

| 编号 | 日期 | 状态 | 标题与核心裁决摘要 |
|---|---|---|---|
| [ADR-0001](0001-stage0-exit-and-stage1-entry.md) | 2026-08-09 | 已批准 | **阶段 0 退出与阶段 1 准入**：基于本机可用基线推进阶段 1，将环境缺口转为阶段 1 前置收尾项 |
| [ADR-0002](0002-architecture-review-structure-debt.md) | 2026-09-05 | 已批准 | **架构结构债评审与 Stage 3 前整改方向**：对照 `ARCHITECTURE.md` 排查主进程/Preload/Core 边界结构债 |
| [ADR-0003](0003-ai-direction-and-privacy-hard-commitment.md) | 2026-09-20 | 已批准 | **AI 方向决策与隐私硬承诺**：云端永不默认/永不静默，默认纯本地自立，确定外传审计与程序化接口原则 |
| [ADR-0004](0004-ai-capability-master-plan-decisions.md) | 2026-09-24 | 已批准 | **AI 能力总纲九项架构裁决**：固化 `AI_CAPABILITY_MASTER_PLAN.md` 的九项关键技术决策 |
| [ADR-0005](0005-cv-sampling-density-policy.md) | 2026-09-24 | 已批准 | **CV 采样密度策略**：预算约束下的三杠杆自适应采样与密度旋钮策略（解决 4K60 长 GOP 退化） |
| [ADR-0006](0006-w22-speaker-direction-ruling.md) | 2026-10-14 | 已批准 | **W2.2 说话人分离方向裁决**：区分表达能力与判别能力（部分结论后续由 ADR-0007/0008 修正） |
| [ADR-0007](0007-w22-a-path-recheck.md) | 2026-10-14 | 已批准 | **W2.2 重新裁决 A 路径**：部分反转 ADR-0006 D2，明确特征/分段模型路径立项条件 |
| [ADR-0008](0008-w22-o2-rerecheck.md) | 2026-10-14 | 已批准 | **W2.2 O2 再裁决**：将问题重心从可达域/聚类形态收束至选割准则与判别依据 |
| [ADR-0009](0009-w22-diarization-closeout.md) | 2026-10-17 | 已批准 | **W2.2 说话人层收口（冻结多机位线）**：W2.2 停在降级交付形态，W2.3 冻结，明确 U1–U3 解冻条件 |
