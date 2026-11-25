# 文档入口

项目文档分为**需求规格（`requirements/`）**、**系统与模块设计（`design/`）**与**在研方案（`plans/`）**三大活跃目录；唯一当前状态源见 [`STATUS.md`](STATUS.md)，已核销台账见 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md)，只读历史记录见 [`archive/`](archive/README.md)，实验与测量依据见根目录 [`evidence/`](../evidence/README.md)。

## 新读者阅读顺序

1. 仓库根目录 [`README.md`](../README.md)：产品介绍、开发环境与常用命令。
2. [`STATUS.md`](STATUS.md)：唯一当前状态源（工作线、已交付能力边界、未闭环承诺与待办）。
3. [`ARCHITECTURE.md`](../ARCHITECTURE.md)：进程边界、核心模块、数据模型与架构原则。
4. [`VORTEX_CUT_USER_MANUAL.md`](requirements/VORTEX_CUT_USER_MANUAL.md)：从用户视角了解编辑器操作。
5. 按工作域查找下表专题地图，或进入 [`requirements/`](requirements/README.md)、[`design/`](design/README.md) 与 [`plans/`](plans/README.md)。

## 专题地图（Topic Map）

| 主题域 | 需求规格（`requirements/`） | 设计 / 契约 / 活跃计划 | 历史记录与证据 |
|---|---|---|---|
| **编辑核心与剪辑语法** | [产品路线图](requirements/PRODUCT_ROADMAP.md)、[剪辑语法与手法](requirements/EDITING_TOOLS_SPEC.md)、[质量评测](requirements/QUALITY_EVAL_SPEC.md) | [多轨时间线](design/TIMELINE_MULTI_TRACK_DESIGN.md)、[自由定位](design/FREE_POSITIONING_DESIGN.md)、[转场](design/TRANSITIONS_DESIGN.md)、[关键帧](design/KEYFRAMES_DESIGN.md)、[字幕与花字](design/CAPTIONS_RENDERING_DESIGN.md) | [Wave 1 手测清单](archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md)、[Wave 1 自动化取证](archive/WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md)、`evidence/quality_eval/` |
| **桌面 UI、OpenFilm 对齐与工作区** | [用户手册](requirements/VORTEX_CUT_USER_MANUAL.md)、[品牌基线](requirements/BRAND_BASELINE.md) | [属性面板设计](design/PROPERTY_PANEL_DESIGN.md)、[弹窗视觉规范 v2](design/ui-mockups/dialog-system-v2/DESIGN.md)、[P236 解耦与 Agent 工作区（计划）](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md)、[P235 OpenFilm 对齐（计划）](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) | [UI 改造汇总](archive/EDITOR_UI_REFRESH_2026-11_SUMMARY.md)、[P231/P233/P234 归档](archive/README.md)、`evidence/p235-openfilm-timeline-parity-*` |
| **预览引擎、解码与性能** | [预览引擎、缩略图与合成流畅度](requirements/PREVIEW_ENGINE_SPEC.md) | [M3 IR 契约归档](archive/STAGE_M3_0_IR_CONTRACT_DRAFT.md)、[B13 驻留门归档](archive/PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md) | [未闭环排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md)、[性能与 HEVC 汇总](archive/README.md)、[`evidence/performance/`](../evidence/performance/README.md) |
| **AI 能力线与隐私** | [CV 采样与预算](requirements/CV_SAMPLING_SPEC.md)、[多机位同步](requirements/CAMERA_SYNC_SPEC.md)、[语义检索](requirements/SEMANTIC_SEARCH_SPEC.md)、[关键帧理解](requirements/KEYFRAME_UNDERSTANDING_SPEC.md)、[信号融合](requirements/SIGNAL_FUSION_SPEC.md) | [AI 能力总纲](design/AI_CAPABILITY_MASTER_PLAN.md)、[AI 工作单与字幕生成](design/AI_WORKLIST_DESIGN.md)、[多机位设计](design/CAMERA_SYNC_DESIGN.md)、[关键帧理解设计](design/KEYFRAME_UNDERSTANDING_DESIGN.md)、[ADR 索引](design/adr/README.md) | [W3.3 实施摘要](archive/W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md)、[W3.3 验收](archive/W3_3_VERIFICATION_GATE_2026-10-21.md)、[W3.1 验收](archive/W3_1_SEMANTIC_SEARCH_IMPLEMENTATION_2026-10-19.md) |
| **工程治理、CI 与契约** | [`AGENTS.md`](../AGENTS.md) | [Stage 1B 错误码契约](archive/STAGE1B_CONTRACT_FREEZE.md) | [远端 CI 验证](archive/CI_REMOTE_VERIFICATION_2026-11-05.md) |

## 文档维护约定

1. **单模块单活文档 + 领域命名**：活跃规格按业务模块原地演进，文件名不带日期、迭代代号（`M2/W*/P*`）与过程门后缀；进行中方案放 [`plans/`](plans/README.md)（见 [`AGENTS.md`](../AGENTS.md) Rule 6–8）。
2. **关门即清理**：承诺在 [`STATUS.md`](STATUS.md) §4 核销时，同提交迁入 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md) 并清理临时过程文件。
3. **提交前必跑门禁**：
   ```powershell
   uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py services/core/tests/unit/test_keyframe_wording.py
   ```
