# 文档入口

项目文档按**需求（`requirements/`）**与**设计（`design/`）**两类活跃目录组织；当前状态统一见 [`STATUS.md`](STATUS.md)，已核销台账归档见 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md)，只读历史规范与验收汇总见 [`archive/`](archive/README.md)，实验与测量依据见根目录 [`evidence/`](../evidence/README.md)。

## 新读者阅读顺序

1. 仓库根目录 [`README.md`](../README.md)：产品介绍、开发环境与常用命令。
2. [`STATUS.md`](STATUS.md)：唯一当前状态源（工作线、已交付能力边界、未闭环承诺与待办）。
3. [`ARCHITECTURE.md`](../ARCHITECTURE.md)：进程边界、核心模块、数据模型与架构原则。
4. [`VORTEX_CUT_USER_MANUAL.md`](requirements/VORTEX_CUT_USER_MANUAL.md)：从用户视角了解编辑器操作。
5. 按工作域查找下表专题地图，或进入 [`requirements/`](requirements/README.md) 与 [`design/`](design/README.md) 索引。

## 专题地图（Topic Map）

| 主题域 | 需求规格 | 设计 / 契约 / 裁决 | 历史记录与证据 |
|---|---|---|---|
| **编辑核心与剪辑语法** | [M2 路线图](requirements/M2_ROADMAP.md)、[Wave 1 剪辑语法与手法](requirements/WAVE1_EDITING_TOOLS_SPEC.md)、[Wave 1 手测清单](requirements/WAVE1_MANUAL_CHECKLIST_2026-10-10.md)、[质量评测门](requirements/QUALITY_EVAL_PLANNING_GATE_2026-09-24.md) | [M2 多轨/自由定位/转场/关键帧/字幕](design/README.md#编辑核心与-m2-设计) | [Wave 1 自动化取证](archive/WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md)、`evidence/quality_eval/` |
| **桌面 UI、OpenFilm 对齐与工作区** | [用户手册](requirements/VORTEX_CUT_USER_MANUAL.md)、[品牌基线](requirements/BRAND_BASELINE.md) | [P236 解耦与 Agent 工作区](design/TIMELINE_DATA_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md)、[P235 OpenFilm 对齐](design/P235_OPENFILM_TIMELINE_PARITY_PLAN.md)、[界面原型](design/ui-mockups/) | [UI 改造汇总](archive/EDITOR_UI_REFRESH_2026-11_SUMMARY.md)、[P231/P233/P234 归档](archive/README.md)、`evidence/p235-openfilm-timeline-parity-*` |
| **预览引擎、解码与性能** | [P231 画布模型](requirements/P231_PREVIEW_CANVAS_PLANNING_GATE_2026-11-17.md)、[P232 缩略图](requirements/FILMSTRIP_PRESHOOT_PLANNING_GATE_2026-11-17.md)、[预览流畅度](requirements/PREVIEW_SMOOTHNESS_PLANNING_GATE_2026-11-17.md) | [M3 IR 契约归档](archive/STAGE_M3_0_IR_CONTRACT_DRAFT.md)、[B13 驻留门归档](archive/PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md) | [未闭环排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md)、[性能与 HEVC 汇总](archive/README.md)、[`evidence/performance/`](../evidence/performance/README.md) |
| **AI 能力线与隐私** | [CV 采样与预算](requirements/CV_SAMPLING_SPEC.md)、[W2.1 同步](requirements/W2_1_CAMERA_SYNC_PLANNING_GATE_2026-10-10.md)、[W3.1 检索](requirements/W3_1_SEMANTIC_SEARCH_PLANNING_GATE_2026-10-18.md)、[W3.3 关键帧](requirements/W3_3_KEYFRAME_UNDERSTANDING_PLANNING_GATE_2026-10-21.md)、[W4.2 融合](requirements/W4_2_SIGNAL_FUSION_PLANNING_GATE_2026-10-19.md) | [AI 能力总纲](design/AI_CAPABILITY_MASTER_PLAN_2026-09-24.md)、[Worklist & Captions 设计](design/WORKLIST_AND_CAPTIONS_DESIGN.md)、[W2.1/W3.3 设计门](design/README.md#ai工作包与专项设计)、[ADR 索引](design/adr/README.md) | [W3.3 实施摘要](archive/W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md)、[W3.3 验收](archive/W3_3_VERIFICATION_GATE_2026-10-21.md)、[W3.1 验收](archive/W3_1_SEMANTIC_SEARCH_IMPLEMENTATION_2026-10-19.md) |
| **工程治理、CI 与契约** | [`AGENTS.md`](../AGENTS.md) | [Stage 1B 错误码契约](archive/STAGE1B_CONTRACT_FREEZE.md) | [远端 CI 验证](archive/CI_REMOTE_VERIFICATION_2026-11-05.md) |

## 文档维护约定

1. **单模块单活文档**：按模块原地更新，禁止在 `requirements/` 或 `design/` 堆积按日期/切片命名的过程稿（见 [`AGENTS.md`](../AGENTS.md) Rule 6–8）。
2. **关门即清理**：承诺在 [`STATUS.md`](STATUS.md) §4 核销时，同提交迁入 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md) 并清理临时过程文件。
3. **提交前必跑门禁**：
   ```powershell
   uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py services/core/tests/unit/test_keyframe_wording.py
   ```
