# Vortex Cut 状态源（Single Source of Truth）

> **本文件是唯一声明「项目当前状态」的地方。**
> 其他文档**不得复述**当前阶段、迁移版本、能力边界或完成状态，只能**引用本文件**（纪律见 [`../AGENTS.md`](../AGENTS.md)）。
> 机器校验：`services/core/tests/unit/test_status_doc_consistency.py` 校验 §1 事实块、正文数字复述、开放项约束与过期表述黑名单。

---

## 1. 机器可校验字段

<!-- STATUS-FACTS-BEGIN -->
```json
{
  "protocol_version": 1,
  "latest_migration": 44,
  "patch_operations": 43,
  "ai_patch_operations": 23,
  "cv_algorithm_version": 3
}
```
<!-- STATUS-FACTS-END -->

| 字段 | 含义 | 校验源（改这些代码必须同步改上方 JSON） |
|---|---|---|
| `protocol_version` | 契约协议版本 | `packages/contracts/src/index.ts` `PROTOCOL_VERSION` |
| `latest_migration` | 最新 SQLite 迁移版本 | `aivs_core.database.MIGRATIONS` 最大版本号 |
| `patch_operations` | TimelinePatch 操作总数 | `aivs_core.timeline.PATCH_OPERATIONS` |
| `ai_patch_operations` | **AI 白名单操作数**（显式冻结集合） | `aivs_core.timeline.AI_PATCH_OPERATIONS` |
| `cv_algorithm_version` | CV 信号算法版本 | `aivs_core.media.cv_signals.CV_ALGORITHM_VERSION` |

---

## 2. 当前阶段

**本项目按并行工作线推进**（Stage 0–8 与 M2 已历史完成）：

| 工作线 | 状态 | 说明 |
|---|---|---|
| Stage 0–8 / M2 | ✅ 已交付 | 基础编辑、B1 变速 / B2 转场 / B3 关键帧 / B4 字幕均已交付 |
| M3 里程碑（预览引擎） | 部分交付 | M3-0 预览引擎、M3-2 播放重构已交付；M3-3 A1 混音代码与测试已交付（缺独立人工听测档案） |
| **0.1.0 发布门（P237）** | **已立项（2026-11-28）** | 阶段 0 收口 → P235 R1–R3 → iPhone 素材兼容包；P236 为 0.2.0 主题，见 [`plans/P237`](plans/P237_RELEASE_0_1_0_AND_ROADMAP_PLAN.md) |
| **时间线重构与工作区** | **进行中（当前主投入）** | OpenFilm 时间线对齐（P235）、全视觉轨合成收尾（P231）与 P236 解耦/Agent 工作区已立项 |
| **AI 能力线** | **进行中** | AI-1 多步会话、AI-2 CV 信号层、Wave 1 剪辑手法、W4.1 工作单与 W3.3 关键帧理解（opt-in）已合入 |
| **W2.2 说话人层** | **降级长期态** | 精度门未过（S3），依据 [`ADR-0009`](adr/0009-w22-diarization-closeout.md) 以 `quality_status='unvalidated'` / `usable_for=['reference']` 交付 |
| **W2.3 机位切换** | **❄️ 冻结** | 依赖 W2.2 轮次且准入未满足，按 [`ADR-0009`](adr/0009-w22-diarization-closeout.md) D1 冻结（解冻条件 U1–U3） |
| **W3.1 语义检索** | **代码已交付；分发阻塞** | 中文 CLIP ViT-B/16 本地检索实测可用，但缺公网托管点导致装机用户不可用（[`BACKLOG.md`](BACKLOG.md#p161)） |

- **主干**：`master`；**固定开发分支**：`liuwei-dev`；**发布版本**：`0.0.1`（`package.json`）。
- 不要再用 "Stage 2C" 描述当前状态（历史过期表述已由 CI 黑名单拦截）。

---

## 3. 能力边界（已交付，可对外）

**编辑核心**：多轨时间线、同轨转场、全视觉轨关键帧、字幕（含样式/气泡/花字/多字体包）、变速与倒放、蒙版/抠像、PiP 自由定位、A1 音频混音、音频淡入/淡出（`afade`，Interactive 路径暂不淡）、响度归一规划（单片段入口）、权威预览（代理为可选加速项）、H.264/AAC 导出与多平台 Profile、封面设置。

**AI 能力线（本地优先）**：
- **本地 ASR 转录**（`faster-whisper`，词级时间戳，按需下载）；
- **AI 候选粗剪与修改提案**（Stage 2A/2B）+ **有界多步 agent 会话**（AI-1，迁移 v20，步数 ≤6 / 不可变 Revision）；
- **本地 CV 信号层**（AI-2 Layer 0，迁移 v21，混合自适应采样算法版本 3）；
- **剪辑语法与手法**（Wave 1：声画链接、`editing_grammar` 三段式、节拍网格、卡点、L/J cut、去停顿，全本地零 egress）；
- **多机位音频同步**（W2.1，迁移 v36，纯 numpy 样本级对齐与时钟漂移拒绝）；
- **素材池语义检索**（W3.1，迁移 v39，英文/中文 CLIP 本地推理，当前因中文模型分发未闭环仅限自建环境）；
- **工作单编排**（W4.1，迁移 v27，已交付 `editing_grammar`/`captions` 步骤，`roughcut`/`style` 延后守卫）；
- **关键帧理解**（W3.3 Layer 2，迁移 v40/v41，opt-in，逐张可见审阅 + fail-closed 探测 + 12 词表，质量未经完整盲评）；
- **AI 操作白名单**：23 种显式冻结 + 「白名单 + schema + 字段清单」三处同步准入。

**隐私边界（[`ADR-0003`](adr/0003-ai-direction-and-privacy-hard-commitment.md) D4）**：云端永不默认、永不静默；egress preview 可逐张审计；本地信号零 egress；默认纯本地体验自立。能力规划见 [`specs/ai-platform.md`](specs/ai-platform.md)，不在本文件重复。

---

## 4. 开放承诺与待办索引

> 本表仅保留**未闭环、待裁决与持续跟踪项**（严禁滞留 `✅` 行）；详细上下文、根因与核销条件统一见 [`BACKLOG.md`](BACKLOG.md)。

| # | 主题 | 类型 | 状态摘要 | 详情 |
|---|---|---|---|---|
| P237 | 0.1.0 发布门与后续路线图 | 工作包 | ⏳ 2026-11-28 已立项，按阶段逐步执行 | [`P237 计划`](plans/P237_RELEASE_0_1_0_AND_ROADMAP_PLAN.md) / [`BACKLOG#p237`](BACKLOG.md#p237) |
| P236 | 时间线数据解耦与 Agent 工作区 | 工作包 | ⏳ 2026-11-24 已立项，待规划门与切片拆解 | [`P236 方案`](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md) / [`BACKLOG#p236`](BACKLOG.md#p236) |
| P235 | OpenFilm 时间线完整对齐 | 工作包 | 🟡 持续实现与验收中（固定参照 `b125a3d9`） | [`P235 计划`](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) / [`BACKLOG#p235`](BACKLOG.md#p235) |
| P235-R1 | Replace 无音轨 video 与未知时长 | 风险对策 | 🟡 实现与证据未闭环 | [`BACKLOG#p235-r1`](BACKLOG.md#p235-r1) |
| P235-R2 | >30s still 与 audio-only 解码成本 | 风险对策 | 🟡 复审通过，实现与计数证据未闭环 | [`BACKLOG#p235-r2`](BACKLOG.md#p235-r2) |
| P235-R3 | 转场来源事实与最终布局投影 | 风险对策 | 🟡 架构已冻结，实现及测试未闭环 | [`BACKLOG#p235-r3`](BACKLOG.md#p235-r3) |
| P235-R4 | HTML `page` 时间线功能与隔离渲染 | 风险对策 | ⏸ 2026-11-28 用户裁决挂起：保留架构与 Schema 预留，移出 P235 验收（P237 D2） | [`BACKLOG#p235-r4`](BACKLOG.md#p235-r4) |
| P231 | 全视觉轨画布盒模型重构 | 工作包 | 🟡 主体已落地，缺 A2 ffmpeg/IR 逐像素对拍补证 | [`BACKLOG#p231`](BACKLOG.md#p231) |
| P230 | 时间线/预览五项 OpenFilm 观察 | 工作包 | 🟡 ①②③⑤ 已落地，④ 已分立 P231 | [`BACKLOG#p230`](BACKLOG.md#p230) |
| P227 | WebGPU 合成器与假硬解提示 | 工作包 | ⏳ 代码已合入（`VITE_AIVS_GPU=1` 门控），待真机矩阵核销 | [`BACKLOG#p227`](BACKLOG.md#p227) |
| P196 | 42 份设计门遗留对账收口 | 工作包 | 🟡 5 项已落实，长时线项转 P200 | [`BACKLOG#p196`](BACKLOG.md#p196) |
| P197 | B13-R `textureBytesOf` 记账口径 | 工作包 | 🟡 显式挂起（待 Chromium 上游修复或自建补丁） | [`BACKLOG#p197`](BACKLOG.md#p197) |
| P200 | 长时线（~8m+）每 ~10s 冻结退化 | 缺陷修复 | 🟡 7 轮排查已排除 IPC/主线程假说，根因待定位；P237 并行线 B 限期 3 个工作日，未果则降级为已知边界 | [`BACKLOG#p200`](BACKLOG.md#p200) |
| P203 | iPhone HDR（10-bit HLG HEVC）播放挂死 | 缺陷修复 | 🟡 已走软解兜底不挂死，缺代理就绪复测 | [`BACKLOG#p203`](BACKLOG.md#p203) |
| P204 | 含 `elst` 偏移素材全帧 `no sample` | 缺陷修复 | 🟡 已修并通过 remux 验证，完整播放受 P203 关联 | [`BACKLOG#p204`](BACKLOG.md#p204) |
| P206 | iPhone 竖拍（`rotation=-90`）呈现方向 | 缺陷修复 | 🟡 已防花屏，缺「适应」读 rotation 与铺满回归锁 | [`BACKLOG#p206`](BACKLOG.md#p206) |
| P207 | 预览代理自动生成与切换边界 | 缺陷修复 | 🟡 主链路已交付，保留两项非阻塞边界 | [`BACKLOG#p207`](BACKLOG.md#p207) |
| P216 | 解码探测写死合成 codec string | 缺陷修复 | 🟡 暂走坏帧降级兜底，待定探测改造路线 | [`BACKLOG#p216`](BACKLOG.md#p216) |
| P187/P188 | 响度全片入口 / 预览淡入淡出 | 能力边界 | ⏳ 权威渲染已对齐，Interactive 淡入与全片入口待补 | [`BACKLOG#p187`](BACKLOG.md#p187) |
| P161 | 中文 CLIP 模型分发与许可（W3.1） | 风险对策 | 🟡 2026-11-28 用户裁决：路线中暂按可用对待，许可核实与托管延后、不阻塞 0.1.0（P237 D1） | [`BACKLOG#p161`](BACKLOG.md#p161) |
| P165 | W3.3 关键帧打标质量人工盲评 | 验收项 | 🟡 仅 9 帧非生产记录，未证质量达标 | [`BACKLOG#p165`](BACKLOG.md#p165) |
| P181 | W3.3 探测路由 `project_id` 耦合 | 架构待办 | ⏳ 现行路由强依赖 `project_id` query 参数 | [`BACKLOG#p181`](BACKLOG.md#p181) |
| P149 | W4.1 `roughcut`/`style` 步骤延后 | 工作包 | 🟡 已设 `WORKLIST_STEP_UNAVAILABLE` 守卫，暂不立项 | [`BACKLOG#p149`](BACKLOG.md#p149) |
| P147/P148 | W4.2 融合排序真值与权重版本 | 风险对策 | 🟡 结构测试 F1–F6 闭环，权重未调优且不承诺更优 | [`BACKLOG#p147`](BACKLOG.md#p147) |
| P198 | AI 能力矩阵远期未开展项 | 工作包 | 🟡 按总纲定位暂未开展（W3.4 / W4.3 / W5.1 等） | [`BACKLOG#p198`](BACKLOG.md#p198) |
| P81 / P84 | W2.1 时钟漂移与真实多机位素材 | 风险对策 | 🟡 / ⏳ 远距拒绝已落地，缺真实多机位样片取证 | [`BACKLOG#p81`](BACKLOG.md#p81) |
| P89/ADR0009 | W2.2 说话人语料限制与 W2.3 冻结 | 冻结项 | ❄️ W2.2 停在 D3，W2.3 冻结（解冻条件 U1–U3） | [`ADR-0009`](adr/0009-w22-diarization-closeout.md) / [`BACKLOG#p132`](BACKLOG.md#p132) |
| P132 | W2.3 消费 turn 前须校验 `quality_status` | 验收项 | ⏳ 随未来 W2.3 立项门一并落地与测试 | [`BACKLOG#p132`](BACKLOG.md#p132) |
| P220 | 旧 `--vc-*` 与 Graphite 令牌并存 | 技术债 | ⏳ 已裁决（P237 D3）：Graphite `--dlg-primary` 单源，先别名后逐步替换 | [`BACKLOG#p220`](BACKLOG.md#p220) |
| P192/P194 | E2E 选择器与剩余缺陷收口 | 工作包 | 🟡 主链已修，余 `stage4d` 网关/凭据与 `p33-seek-play` | [`BACKLOG#p194`](BACKLOG.md#p194) |
| Wave1-L3 | Wave 1 剪辑手法真机听感签字 | 人工验收 | ⏳ 自动化已覆盖机器可判项，待人工听感确认 | [`BACKLOG#wave1-l3`](BACKLOG.md#wave1-l3) |
| AI-Misc | 4K60 1.0s 差异 / `json_schema` 兼容 | 已知边界 | 🟡 4K60 远低于 10s 门；`script` 适配器为主通路 | [`BACKLOG#ai-misc`](BACKLOG.md#ai-misc) |
| TD-WaveD | 代码与测试结构债（TD-01..TD-05 延后专题） | 技术债 | ⏳ 2026-11-28 审计登记，按需分专题推进 | [BACKLOG#td-wave-d](BACKLOG.md#td-wave-d) |

---

## 5. 历史点时间证据索引（引为现状前必须先读本文件）

> 本表仅登记被归档为只读证据的**点时间记录**（自动豁免过期黑名单）；活文档严禁登记在此。

| 文档 | 性质 | 注意 |
|---|---|---|
| `evidence/2026-10-21-w33-keyframe-blind-eval/RESULT.md` | A9 盲评结果（9 帧）点时间记录 | 不得引作质量已证（样本 9 帧、±25pp、无对照） |
| `evidence/2026-10-21-w33-a13-packaged/EVIDENCE.md` | A13 打包产物取证点时间记录 | 只证 PyInstaller 产物；未跑 Electron E2E |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND4.md` | P200 第四轮仿真点时间记录 | **已被推翻**（第五轮）；不得引作真机因果证据 |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND5.md` | P200 第五轮否证分析 | 改判主因为暂存帧驱逐；未证提高容量即可消除 |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND6.md` | P200 第六轮立项判据复核 | 推翻「长度驱动」假设；未证明触发状态量 |
| `evidence/performance/p200-window-attribution-20261028/ROUND7_PREREGISTRATION.md` | P200 第七轮重复运行测量 | 三次同配置 = 147/0/0（不确定）；不得引作成因 |
| `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` | P203 2026-11-05 复测点时间记录 | 只证走 FFmpeg 不挂死；根因未修、代理就绪未测 |

**活文档清单（过期即修正，不在此表豁免）**：`README.md`、`ARCHITECTURE.md`、`docs/BACKLOG.md`、`docs/guides/branding.md`、`docs/guides/user-manual.md`、`docs/specs/product-baseline.md`、`docs/specs/ai-platform.md` 及 `docs/specs/` 其余活跃规格。

---

## 6. 维护本文件的规则

1. **改代码改了 §1 字段 → 立刻改 §1 JSON**；正文复述数字（「算法版本 3」「23 种显式冻结」）须与 §1 一致。
2. **新增承诺/缺陷 → 在 §4 加一行索引并在 `docs/BACKLOG.md` 记明细**；核销关闭时同提交从两处移除（Git 历史追溯）并将长期结论并入 `docs/specs/`。
3. **本文件保持精简（< 25 KiB）**，长篇排查过程放入 `evidence/` 或本地 `.tmp/`，不再在 `docs/` 堆积过程日志。
