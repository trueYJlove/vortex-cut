# 文档入口

项目文档采用纯 Markdown 分层组织：唯一现状源见 [`STATUS.md`](STATUS.md)，未闭环追踪明细见 [`BACKLOG.md`](BACKLOG.md)，子系统需求与设计活规格见 [`specs/`](specs/README.md)，在研提案见 [`plans/`](plans/README.md)，不可逆架构裁决见 [`adr/`](adr/README.md)，用户与品牌指南见 [`guides/`](guides/README.md)，实验测量证据见 [`../evidence/README.md`](../evidence/README.md)。

## 新读者阅读顺序

1. [`../README.md`](../README.md)：仓库总览、开发环境与常用构建/测试命令。
2. [`STATUS.md`](STATUS.md)：唯一当前状态源（工作线、已交付能力边界、开放项索引）。
3. [`../ARCHITECTURE.md`](../ARCHITECTURE.md)：进程边界、安全模型、核心数据结构与真实代码分层。
4. [`guides/user-manual.md`](guides/user-manual.md)：从创作者视角了解编辑器操作。
5. 按主题域查阅下表或进入 [`specs/`](specs/README.md)、[`BACKLOG.md`](BACKLOG.md)、[`plans/`](plans/README.md) 与 [`adr/`](adr/README.md)。

## 专题地图（Topic Map）

| 主题域 | 活规格（`specs/`） | 在研计划 / 决策 / 指南 | 证据与追踪 |
|---|---|---|---|
| **产品基线与编辑核心** | [产品与编辑能力基线](specs/product-baseline.md)、[时间线与核心剪辑](specs/timeline-and-editing.md) | [P235 OpenFilm 时间线对齐](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md)、[P236 解耦与 Agent 工作区](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md) | `evidence/quality_eval/`、[`BACKLOG.md`](BACKLOG.md) |
| **预览、渲染与性能** | [预览与权威渲染引擎](specs/preview-and-rendering.md) | — | [`evidence/performance/`](../evidence/performance/README.md)、[`evidence/m3_0/`](../evidence/m3_0/liukeai_acceptance/ACCEPTANCE_REPORT.md) |
| **桌面 UI 与品牌指南** | [桌面端 UI 与弹窗视觉规范](specs/desktop-ui.md) | [用户使用手册](guides/user-manual.md)、[品牌与图标资产](guides/branding.md) | `apps/desktop/tests/fixtures/dialog-system-v2/`、`evidence/2026-11-09-dialog-family-c/` |
| **AI 平台、感知与同步** | [AI 平台与工作单](specs/ai-platform.md)、[本地智能与评测](specs/local-intelligence.md)、[多机位同步](specs/camera-sync.md)、[关键帧理解](specs/keyframe-understanding.md) | [ADR 架构决策索引](adr/README.md)（`ADR-0003`–`0009`） | `evidence/2026-10-*` |
| **工程治理与状态** | [`../AGENTS.md`](../AGENTS.md) | [`STATUS.md`](STATUS.md)、[`BACKLOG.md`](BACKLOG.md) | `test_status_doc_consistency.py`、`test_keyframe_wording.py` |

## 文档维护约定

1. **单模块单活规格 + 领域命名**：现行需求与设计合入 [`specs/`](specs/README.md) 对应领域文件；在研提案放 [`plans/`](plans/README.md)，核销后结论并入 `specs/` 并删除计划文件（由 Git 历史追溯过程）。
2. **状态与明细分离**：[`STATUS.md`](STATUS.md) 保持 `< 25 KiB` 仅保留核心事实与一行开放索引，详细上下文与风险追踪放 [`BACKLOG.md`](BACKLOG.md)，均严禁滞留 `✅` 已关闭条目。
3. **提交前门禁**：
   ```powershell
   uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py services/core/tests/unit/test_keyframe_wording.py
   ```
