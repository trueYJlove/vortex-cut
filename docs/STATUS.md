# Vortex Cut 状态源（Single Source of Truth）

> **本文件是唯一声明"项目当前状态"的地方。**
> 其他文档**不得复述**当前阶段、迁移版本、能力边界或完成状态，只能**引用本文件**。
> 纪律条文见 `AGENTS.md`「文档同步纪律」。
>
> **机器校验**：`services/core/tests/unit/test_status_doc_consistency.py` 会解析
> §1 的字段块并与代码实际值比对——**字段漂移即测试红**。这是本文件不腐烂的保证：
> 改了迁移/白名单/算法版本却忘了改这里，测试会红——而这个红现在**会被自动拦住**：
> CI（`.github/workflows/ci.yml`，经根级 `pnpm test:python`）执行 `services/core/tests/unit`，
> 本检查随之自动运行；本地等价命令见下。CI 的覆盖范围与收口状态见 **§4 P190**，
> 显式运行：`uv run --locked --extra dev pytest services/core/tests/unit/test_status_doc_consistency.py`。
>
> 建立：2026-09-24（W0.1）。来源：2026-09-24 文档过期审计（17 份文档、约 80 条过期）。

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

| 字段 | 含义 | 校验源（改这些代码就必须改上面的块） |
|---|---|---|
| `protocol_version` | 契约协议版本 | `packages/contracts/src/index.ts` 的 `PROTOCOL_VERSION` |
| `latest_migration` | 最新 SQLite 迁移版本 | `aivs_core.database.MIGRATIONS` 的最大版本号 |
| `patch_operations` | TimelinePatch 操作总数 | `aivs_core.timeline.PATCH_OPERATIONS` |
| `ai_patch_operations` | **AI 白名单操作数**（显式冻结集合） | `aivs_core.timeline.AI_PATCH_OPERATIONS` |
| `cv_algorithm_version` | CV 信号算法版本 | `aivs_core.media.cv_signals.CV_ALGORITHM_VERSION` |

> **为什么是这几个**：它们全部满足两个条件——①会被代码改动而改变；②能从代码确定性地读出来。
> 只有同时满足这两条的字段才值得机器校验。其余状态（如"某功能是否可用"）无法自动判定，
> 依赖 §4 的人工核销纪律。

---

## 2. 当前阶段

**本项目已不再用单一编号描述当前阶段。** Stage 0–8 是历史阶段，已全部收口；
其后工作按**并行工作线**推进：

| 工作线 | 状态 | 说明 |
|---|---|---|
| Stage 0–8 | ✅ 历史完成 | 各有独立验收记录；Stage 7/8 为发布加固与收口 |
| M2 里程碑（交互与编辑能力） | ✅ 已交付 | B1 变速 / B2 转场 / B3 关键帧 / B4 字幕均有设计与验收；B2 视觉验收已声明自动化可验部分全满足 |
| M3 里程碑（预览引擎） | 部分交付 | M3-0 预览引擎、M3-2 播放重构已交付并各有独立验收；**M3-3 A1 音频混音：代码与单测/集成测试已交付，但规划门 §3.3 的「对齐验收」（人工听测 + 电平抽样，要求记入独立验收）从未执行，`evidence/m3_3` 不存在，亦无实施记录文档**——故「已有文档与验收」的表述已于 2026-10-24 更正（见 P196） |
| **AI 能力线** | **进行中（当前主投入）** | AI-1 多步 agent 会话、AI-2 本地 CV 信号层（Layer 0）已合入；总纲与 ADR-0004 已立 |
| **W2.2 说话人层** | **停在降级交付（D3）形态 = 长期态** | 精度门未过（S3），七轮方法研究全部否证，且已无可盲测素材 ⇒ **ADR-0009** 收口。以 `quality_status='unvalidated'` / `usable_for=['reference']` 交付 |
| **W2.3 机位切换** | **❄️ 冻结（不立项/不实现/零代码）** | 依赖 W2.2 turn 且准入未满足 ⇒ ADR-0009 D1 冻结；解冻条件见 **ADR-0009 §3 的 U1–U3** |
| **W3.1 素材池语义检索** | **代码链路已交付；分发未闭环（P161）** | 中文 CLIP 双塔本地 embedding + 抽帧索引 + 项目内余弦检索，零 egress；用户 2026-10-19 裁决「中文优先」后接入 Chinese CLIP ViT-B/16（WordPiece 分词 + context 52），效果实测真实素材 top1 **0.90**（随机 0.12，P160）、物体描述类 5/5。**⚠️ 对最终用户仍不可用**：模型由本仓自行导出、无 https 托管点，装机用户装不上（P161）；许可为 `upstream-undeclared` |

- **主干**：`master`——只接收**已完成的开发分支**（快进或合并），代表"最全最新"的可发布状态
- **开发分支（固定）**：`liuwei-dev`——日常开发一律在此分支；开工前先变基到最新 `master`（2026-10-10 起，替代 `ai/stability-polish`）
- **发布版本**：`0.0.1`（`package.json`）；下一版维护范围见历史发布文档

> **⚠️ 不要再用 "Stage 2C" 描述当前状态。** 该表述自 Stage 3B 起即已过期
> （`STAGE3B_DETAILED_DESIGN.md:47` 曾记录并搁置），是 2026-09-24 审计中最高危的过期项。

---

## 3. 能力边界（已交付，可对外）

> 这一节用于纠正历史文档中"Stage 3 尚未实现"类表述造成的**对外口径压制**
> （`BRAND_BASELINE.md` 曾据此禁止宣传已交付能力）。

**编辑核心**：多轨时间线、转场、关键帧、字幕（含样式/花字）、变速与倒放、蒙版/抠像、
PiP 自由定位、A1 音频混音、权威预览（代理为**可选加速项**：预览与解码准入不依赖代理，H5）、H.264/AAC 导出与多平台 Profile、封面设置。

**AI 能力线（本地优先）**：
- 本地 ASR 转录（faster-whisper，词级时间戳），模型按需下载、不随包分发；
- **AI 候选粗剪**（Stage 2A）：转录或 CV 场景段召回 → 外部 Provider 出三候选 → 采纳；
- **AI 修改提案**（Stage 2B）：自然语言 → TimelinePatch → 差异预览 → 显式应用；
- **AI 多步 agent 会话**（AI-1，迁移 v20）：有界循环（步数 ≤6 / token 预算 / 结构化失败反馈 /
  基线漂移中止），每步落不可变 Revision，Desktop 面板含每步 diff 浏览与费用聚合；
- **本地 CV 信号层**（AI-2 Layer 0，迁移 v21）：镜头边界 / 运动能量 / 清晰度 / 亮度 /
  音频能量 / YuNet 人脸；`skip_frame` 混合自适应采样（算法版本 3）；
- **素材池语义检索**（W3.1，迁移 v39）：CLIP 双塔本地 embedding + 抽帧索引 + 项目内余弦检索，零 egress；
  中文优先模型（Chinese CLIP ViT-B/16）已接入（WordPiece 分词 + context 52），
  真实素材实测 top1 **0.90**（随机 0.12，P160）。**⚠️ 模型分发未闭环**：英文 CLIP 走受信清单按需下载；
  **中文模型由本仓自行导出、无 https 托管点，装机用户无法安装**（§4 P161）——因此本能力当前
  **只在自建/开发者环境可用**，不作为对最终用户的已交付承诺。
- **工作单编排**（W4.1，迁移 v27）：固定步骤链 + 逐步 Diff/Apply + 取消/基线漂移/项目隔离；
  当前切片只实现 `editing_grammar` / `captions` 两类步骤，`roughcut` / `style` 返回
  `WORKLIST_STEP_UNAVAILABLE`（设计门有意延后，见 §4 P149）；
- **关键帧理解（W3.3 Layer 2，迁移 v40/v41，opt-in）**：帧级外传审阅（逐张可见、可单张移除、
  缩略图 ≠ 外传字节）+ consent 一次性消费 + 真实 vision 打标（受控词表 12 标签，词表外改道
  `notes`）+ 按画面标签过滤。**隐私口径（ADR-0003 D4）**：默认关闭；`create` 为 **fail-closed**
  ——Provider 必须已探测为 `supported` 才允许建立 consent，未探测/探测失败一律拒绝且**零字节外传**
  （连同意书都不签）。**⚠️ 打标质量未经人工盲评**（§4 P165 保持开放），本边界不声称任何质量结论；
- **音频淡入 / 淡出**（零迁移）：`fade_in_us` / `fade_out_us` 两个可选字段（渲染走随包 ffmpeg 的
  `afade`），面板滑块可调。**0/缺省不生成滤镜**（既有导出的滤镜链逐字节不变）；
  超限（淡入+淡出 > 段时长）按比例收缩到恰好占满而非导出失败。**预览已对齐**（同一份算术，
  有跨语言对拍）；**⚠️ Interactive 预览路径（HTMLMediaElement）仍不淡**（见 §4 P188）；
- **响度归一 / 音量统一**（E8，零迁移）：随包 ffmpeg 的 **EBU R128** 实测（`ebur128` 滤镜，
  口径版本 `ebu-r128-ebur128-v1`）+ `unify_loudness` 规划器，经既有三段式提案
  （干跑 → Diff → 显式采纳）产出 `set_audio`。**cap 命中不产 op**、在 rationale 点名
  （`gain_db` 契约上限 +12，钳到上限后假装成功会让文档「看起来改过了」而实际差几十 dB）；
  静音/过短如实报 `unmeasurable` 而非谎报 0。**⚠️ 当前入口是单片段**（片段属性面板），
  「全片一键统一」的独立入口未交付（§4 P187）；
- **AI 操作白名单**：23 种显式冻结 + "白名单 + schema + 字段清单"三处同步准入；
- Desktop 设置 UI（含代理三选）、CV 分析入口。

**隐私边界（ADR-0003 D4 硬承诺）**：云端永不默认、永不静默；egress preview 可逐张审计；
本地信号计算零 egress；默认（纯本地）体验自立。

> 能力**规划**（尚未交付的部分）见 `AI_CAPABILITY_MASTER_PLAN.md` §4 能力矩阵，
> **不在本文件重复**——本文件只声明"已交付"，规划声明属于总纲。

---

## 4. 未闭环承诺（**验收项 + 风险对策**）

> **为什么两类都要登记**：五门流程只追踪验收项，风险对策写完就无人再看。
> 2026-09-24 审计发现的 5 项欠账中，有 1 项正是"风险对策"型。
>
> **纪律**：规划门写下的**任何**承诺（验收项、风险对策、开放问题裁决）在此登记；
> 完成时核销并注明证据。**未在此登记的承诺视为不存在。**



> 本节仅保留**未闭环、待裁决与持续跟踪项**；已核销闭环项在将长期结论并入对应活文档后即从本表移除（由 Git 历史追溯）。

| # | 承诺 | 出处 | 类型 | 状态 |
|---|---|---|---|---|
| P236 | **时间线数据解耦与 Agent 协作工作区（Core 权威 + 声明式工作区投影/双向摄入 + MCP/CLI）** | [架构方案（最终版）](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md) | 工作包 | ⏳ **2026-11-24 已立项，待规划门与实施切片拆解**——采用 Core 领域权威 + SQLite 不可变 Revision 账本 + 声明式无损工作区投影/双向摄入（整数微秒）+ MCP/CLI 优先暴露层；明确否决删 SQLite 时间线表、浮点秒持久化与 Electron Main 校验器反模式。 |
| P235 | **OpenFilm 时间线视觉/交互/功能/性能完整收口** | [设计计划与可重复验收口径](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) | 工作包 | 🟡 **2026-11-24 持续实现与验收，尚未收口（固定参照 OpenFilm commit `b125a3d9`）。** 初始缩放、固定标题、`trusted wheel`、跨轨拖动、V3-B 延长与 `Place→Insert→Place` 预览已对齐；区域像素验收 46 区尚未达标（4 片段 perimeter 97.48%–98.93%、文字轮廓 33/39），仍待补齐完整双端手势矩阵、`Replace`/未知时长、Core revision/undo、转场/`page` 与冷热性能对照。逐轮取证与定量细节见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p235)。 |
| P235-R1 | **P235 Replace 语义｜无音轨 video 与未知时长** | [P235 设计计划：Replace 源码差异及 G2/F1 用例](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / OpenFilm `clip-replace.ts` | 风险对策 | 🟡 **实现与证据未闭环**——无音轨 video 替换 sound 目标需映射为静音片段并保持 preview/export 成功；有限源时长未知时按 OpenFilm 的目标需求长度 fallback 规划，不能因探测结果缺失改变目标时长或直接拒绝；需覆盖时间线校验、预览与成片遇到源 EOF 的结果。原 HTML 拒绝边界已撤销，页面功能单列在 P235-R4。 |
| P235-R2 | **P235 Replace 时长保留与 audio-only 导出尺寸/解码成本** | [P235 设计计划：>30s still / audio-only video 渲染规则](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2–§3 / Core review 2026-11-23 | 风险对策 | 🟡 **设计经 Core/独立复审通过；实现和证据未闭环**——Vortex 原 30s image 上限会让 OpenFilm 允许的长 still Replace 失败；移除上限、统一 100ms 到 `Number.MAX_SAFE_INTEGER` 微秒且校验精确结束点，并验证 >30s still 替换保留长度。视频作为音频使用时，不得进入 `resolution="original"` 的视觉源分辨率计算，也不得产生视觉 decoded frame；RenderPlan/IR `video_required`/`audio_required` 字段、Desktop rig/source resolve 过滤、原始音频票据与 proxy 分离、FFmpeg input-side `-vn`、按 input 计数的 renderer decode submission/output 与 FFmpeg decoder-return counter、插桩/正式 binary 分开采样及配对资源数字均须实现和取证。G2/F1/P1 需验证合同、TimelineDocument、RenderPlan/IR、预览与成片结果。 |
| P235-R3 | **OpenFilm 转场来源事实与最终布局投影** | [P235 计划：转场投影要求](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / Independent Review 2026-11-23 | 风险对策 | 🟡 **设计架构已冻结，source facts、43rd patch op、旧 transition dormancy 与最终布局 projector 均已纳入；实现及投影测试未闭环**——active pair 必须供 Timeline、预览、RenderPlan/FFmpeg 和编辑校验共用，旧 `{after_clip_id, kind, duration}` 不得重新绑定到新后继。migration 45 只从不可变历史修订/操作快照唯一恢复原 incoming identity；不可恢复时保留 null/dormant，不能从当前邻接推断。 |
| P235-R4 | **OpenFilm HTML page 时间线功能与隔离渲染** | [P235 计划：HTML page 功能要求](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / OpenFilm `clip-replace.ts`、`pageframes.mjs` | 风险对策 | 🟡 **page 架构已冻结；资产 migration、导入/拖入/Replace、有限/无限时长和共用确定性帧服务尚未实现/取证**——合同包括 `asset_kind=page` 的安全源窗、OpenFilm `page_overrides[]` 校验与 Replace 清理、entrypoint 参与 bundle/cache hash；执行用户 HTML 前仍必须通过独立安全复核，覆盖 sandbox、资源白名单、网络/导航边界、超时/取消与越权负例；实时预览、authoritative preview、final export 必须使用同一页面帧源。 |
| P81 | **W2.1 风险 R1｜设备时钟漂移**：单一偏移在长素材上不成立 | `docs/requirements/CAMERA_SYNC_SPEC.md` §4 R1 | **风险对策** | 🟡 **2026-10-10 取证已实现，分段偏移待真实素材**——远距窗口（相隔 20s）残差差 >10ms ⇒ `unavailable(clock_drift)`，**不返回两端各错一半的单值**；测试：0.1% 重采样素材（低频主导，避免宽带噪声先撞 low_confidence）+ **分支锁**（近窗一致/远窗偏 50ms ⇒ 必走 clock_drift），共 2 项。**分段偏移/线性拟合按 D4 待真实多机位素材取证后再定**；素材短于 ≈22s 时远距漂移检查**未取证**（`drift_us=None`，短视频跨度内漂移有界 ⇒ 照常 ready，属已声明限制） |
| P84 | **W2.1 风险 R4｜无真实多机位素材** | `docs/requirements/CAMERA_SYNC_SPEC.md` §4 R4 | **风险对策** | ⏳ 待实施——向用户索取样片；未取得前**验收项 9** 显式标记「未取证」，禁止以合成素材顶替 |
| P89 | **W2.2 风险 R1｜无真实多说话人素材 → 精度轴无法取证** | 同上 §4 R1 / §5 D3 | **风险对策** | 🟡 **2026-10-11 部分解除**——改用**公开带标注语料**（AMI，CC BY 4.0）取得精度轴（见 P88 ⑩）：**公开语料带官方参考标注，比"用户随手给一段没标注的素材"更能算出真 DER**。**仍未取证**：跨语言 / 重叠 / 远场单麦 / 用户自有素材。**W2.1 验收 9 的同源缺口另有替代路径**（见 P93）。原纪律保留：**禁止以合成 / 易化构造用例顶替**（本机 `eval_set` 的 `spoken-multi-*` 经核实是**纯音调夹具、不含语音**） |
| W2.2-ADR0009 | **W2.2 说话人层冻结项（P90 / P91 / P104 / P131 / P133 / P134 / P137 / P138）** | [ADR-0009](design/adr/0009-w22-diarization-closeout.md) | 工作包/风险（冻结） | ❄️ **已按 ADR-0009 停止推进（2026-10-17）**——W2.2 停在降级交付形态，W2.3 冻结；解冻条件见 [ADR-0009](design/adr/0009-w22-diarization-closeout.md) §3 U1–U3（8 项原始明细见 Git 历史）。 |
| P132 | **W2.2 降级交付验收项 A4｜下游（W2.3）拒绝未验证轮次必须有测试** | `docs/archive/W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md` §2 / §3 A4（实施记录 `W2_2_DEGRADATION_IMPLEMENTATION_2026-10-16.md` 见 Git 历史） | 验收项 | ⏳ **待实施（2026-10-16 独立登记）；2026-10-17 因 ADR-0009 D1 冻结 W2.3 而暂时无交付对象，但明确不撤销**——**为什么独立登记**：门 §3 的 A4 原被写在 P130 行**内部**，而 P130 是 ✅ ⇒ **一个未完成的验收项被埋在一个标记为完成的行里**，违反 AGENTS.md Rule 3「验收项必须可追踪」。本轮补实施记录时把它拆出来。**约束内容（门 §2 冻结）**：W2.3 机位切换规划器**读 speaker turn 前必须校验 `quality_status`**，非 `validated` 即**拒绝或降级为不切换**；该拒绝**必须有测试**，且**负向对照**为：把标注改成 `validated` 则测试**变红**（否则判据恒真）。**不得**写「可用低置信部分」类软约束（§5.21 已证没有能区分「可信段」的判据）。**交割条件**：随 **W2.3 立项门**落地（门 §7 第 2 项）；**在本行关闭前，W2.3 不得开工消费 speaker turn**——当前**全部**说话人轮次的 `quality_status` 恒为 `unvalidated`（精度门 S3 不过，P128），故拒绝路径就是**唯一**合法路径。 |
| P147 | **W4.2 风险 R1｜融合排序无 ground truth ⇒ 无法证明「比单源更好」** | `docs/requirements/SIGNAL_FUSION_SPEC.md` §5 R1 | **风险对策** | 🟡 **2026-10-19 登记**——总纲 W4.2 验收项原文要求「融合排序相对单源的可断言提升」，但**不存在客观真值**（什么算「更好的粗剪」需要人工判断）⇒ 本门**明确不承诺该断言**，改以结构正确性 F1–F6 + 人工盲评协议（另立门）替代。**理由**：本仓已多次因「拍一个没有依据的判据」翻车（W2.2 的 S1/ARI 门槛、v2 的 NC1 spread 门槛），不重复第三次 |
| P148 | **W4.2 风险 R2｜融合权重无依据** | 同上 §5 R2 | **风险对策** | 🟡 **2026-10-19 登记**——权重靠人为设定时无客观依据。**对策**：权重表**显式化 + 版本化**（写入契约，不得内联魔数，由 F6 测试断言），允许将来据评测调整；**本门明确不声称当前权重最优**。初始值建议等权但须登记为「未调优」 |
| P149 | **W4.1 未实现步骤种类（`roughcut` / `style`）延后与拒收守卫** | [AI 工作单设计](design/AI_WORKLIST_DESIGN.md) / `worklist.py` / `test_worklist_service.py` | 工作包（延后） | 🟡 **2026-10-20 已补测试守卫并维持延后，暂不立项。** `prepare`/`create`/`advance` 对 `roughcut` 与 `style` 拒绝并返回 `WORKLIST_STEP_UNAVAILABLE` 且零副作用；触发条件：`roughcut` 需出现真实全链一键需求并复用 `planning.adopt()` 七道校验，`style` 需先有独立设计门。细节与负向对照见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p149)。 |
| P161 | **中文模型分发与许可未闭环**（W3.1 对最终用户阻塞） | `resources/model-manifests/chinese-clip-vit-base-patch16.json` / `AIVS_MODEL_CDN` | 风险对策 | 🟡 **2026-10-25 通道已可配置（`AIVS_MODEL_CDN`），但无公网托管点导致装机用户仍不可用。** 仅 `https://` 基址与本机 `file://` 放行；产物暂存于 Private GitHub Release 备援，上游许可 `upstream-undeclared` 对外分发风险需重新确认或改换替代模型并重跑评测。细节与实测见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p161)。 |
| P165 | **W3.3 验收项 A9/D6｜打标质量人工盲评（工具与小样本评分记录）** | [关键帧理解需求规格](requirements/KEYFRAME_UNDERSTANDING_SPEC.md) §1 D6 / §4 A9 | 验收项 | 🟡 **盲评工具与 9 帧评分（9/9 合理）已于 2026-10-22 归档于 `evidence/2026-10-21-w33-keyframe-blind-eval/`，但仅作非生产小样本记录（§3 仍标未证）。** 正则负向守卫 `test_keyframe_wording.py` 已接入 CI；因样本仅 9 帧、无对照、CI ±25pp，不得据此宣称生产质量达标。细节见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p165)。 |
| P192 | **e2e 共享 helper 选择器失灵（缺陷链的公共上游）** | `apps/desktop/e2e/project-switcher.ts` / `stage1b` / `stage1c-editor` / `stage2a` / `stage4b` / `stage4c` / 承接 P191 | 工作包 | 🟡 **2026-10-23 部分完成（3 类选择器失效已修，缺陷链下游另计）**。**为什么单列一行**：这不是 9 个独立缺陷，而是**一个共享 helper 变坏**——`selectProject()` 用 `[data-project-id="${id}"]` 定位，而该属性在 `apps/desktop/src/` 里 **0 处出现**（grep 实测），`App.tsx:2579-2591` 的真实标记是 `aria-label="切换项目"` 按钮 + `role="listbox" aria-label="选择项目"` 容器 + `<button role="option">` 项。`selectProject` 被 **9 个 spec 共 27 处**调用 ⇒ 一坏俱坏。 |
| P194 | **e2e 缺陷地图与分批处置（承接 P191/P192）** | `tools/verify_stage6r_offline_real.py` / `e2e/stage6r` / e2e 其余 13 项 / 承接 P192 | 工作包 | 🟡 **2026-10-23/24 分批处置中（族1/族2/族4 与 stage2a/stage2b/m5-timeline/p33-eof-replay 已修或定性，仍余少量待办）。** 当前剩余：`stage4d:323` 真实生图受本地网关不支持 `/images/generations` 阻塞（环境前提缺口）、`stage4d` env-gate 相关用例待配齐凭据后处理、`p33-seek-play` 仍为 `test.fixme`。全量实测、负向对照与各轮提交记录见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p194)。 |
| P196 | **设计门与状态源对账：6 项「承诺了但未落地」的遗留补齐登记** | 42 份设计门全量审计（2026-10-24）/ 承接 P194 | 工作包 | 🟡 **2026-10-24/27 处置中（6 项门内遗留中 (1)(3)(4)(5)(6) 已实施或取证，第 (2) 项转入 P200）。** 第 (1) 项缓冲态 UI 与第 (3) 项 manifest IR 冷/热实测（`evidence/performance/manifest-ir-disk-cache-20261024/`）已完成；第 (4)/(5)/(6) 项图片代理与错误上下文已落地；第 (2) 项「30 分钟跨窗无卡顿」因 `MAX_IR_FRAMES=27_000` 结构上限收口为决策阻塞，后续长时线退化跟踪转移至 **P200**。各轮实测与变异验证见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p196)。 |
| P197 | **B13-R 驻留工作包两项遗留（`textureBytesOf` 口径与 Chromium 上游）** | [B13 驻留规划门](archive/PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md) / [独立验收](archive/PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md) | 工作包 | 🟡 **2026-10-24 裁决处置：遗留一显式挂起、遗留二暂不立项（已交付判别与护栏不变）。** `textureBytesOf`（`compositor-worker.worker.ts:678-680`）仍恒按 `w*h*1.5*(4/3)` 记账而非随 `frameUploadMode` 变化，需待 Chromium 上游修复驻留问题或确需自建补丁时再解冻。细节见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p197)。 |
| P198 | **AI 能力矩阵中「规划了但未开展」的工作包补齐登记** | [AI 能力总纲](design/AI_CAPABILITY_MASTER_PLAN.md) §4 / §5 | 工作包 | 🟡 **2026-10-24 登记，当前均未开展（按总纲定位，非遗漏）。** 覆盖：`W3.4` 蒙太奇/匹配剪辑、`W4.3` MCP 暴露层（远期 P2）、`W5.1` 全能力对标验收、`U8` 云端关键帧理解、`D2` 帧级 egress 审计扩展（另注 `W2.3` 已冻结、`E8` 在 P187、`W4.1` 延后项在 P149）。明细见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p198)。 |
| P200 | **长时线合成预览退化：约 8 分钟以上时间线每 ~10s 冻结 2–11s（P196 门在其下）** | `evidence/performance/P196_CROSSWINDOW_30MIN_MEASUREMENT_2026-10-27.md` / 承接 P196 第 (2) 项收口 | 缺陷修复 | 🟡 **2026-10-27 登记、经 7 轮归因排查仍待修（现象已实证、触发量未定）。** 14.49 分钟长时线首轮出现约 0.4fps 近停摆（`window_fetch` p50 2512.6ms / p95 8733.1ms）；后续排除了 Core/IPC 慢、主线程长任务、`reanchor → missingStuck` 等假设，第 7 轮重复测得不确定（判据 C）但确认 `window_fetch` 延迟仍约 2.2s 且 96% 尖峰落在其 2s 内。详细 7 轮实测与更正记录见 `evidence/performance/p200-window-attribution-20261028/` 与 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p200)。 |
| P203 | **iPhone HDR（10-bit HLG HEVC）素材点「播放」即挂死渲染进程** | 用户提供素材 `c992c92d…_raw.mp4`（iPhone 13 Pro）/ 证据 `evidence/2026-11-01-iphone-hevc-blockers/README.md` / 2026-11-05 复测 `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` | 缺陷修复 | 🟡 **2026-11-05 复测判定 C：挂死已不复现（走 FFmpeg 软解兜底），但根因未修故未关闭。** 真根因定案为 Intel Iris Xe D3D11 的 `p010OverlaySupport: "SOFTWARE"` 导致 WebCodecs 产出 `fmt:null` 坏帧（升级 Electron 至 45.2.1/Chromium 156 亦无法修复）。已交付 HDR 检测告知、`DECODE_FRAME_FORMAT_NULL` 首次降级、`-noautorotate` 修复花屏与白屏崩溃修复；仍缺「代理就绪后是否仍挂死」及冷却回切安全验证。证据见 `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` 与 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p203)。 |
| P204 | **含 edit list（`elst`）偏移的素材全帧 `no sample`，时间码永远停在 00:00:00:00**（demuxer 不应用 `media_time`；已由 worker 实测索引定案） | 同素材的 8-bit SDR 转码版 / 同上证据文档 §2 | 缺陷修复 | 🟡 **2026-11-01 登记；同日修复并由 remux 对照实机验证（首帧 85000→0），但「完整播放」仍被 P203 阻断**——**现象**：8-bit SDR 版（不挂死）播放时 20 次采样 **`tc` 恒为 `00:00:00:00`**，每帧报 `解码失败 I0#N: no sample for frame N (best diff 558333–625000us)`。**抛错点**：`decode-worker.worker.ts:1309,1328`，`targetUs = (frameN / fps) * 1e6`，`fps` 由 `preview-session.ts:1116` 传入 `ir.canvas.fps`（画布 30）。**⭐ 根因（成立，2026-11-01 经实测索引定稿）**：**demuxer 不应用 edit list 的 `media_time`，导致索引首帧 PTS 偏移 0.625s**。**决定性实测**（本次给 worker 加 `sample_index_built` 诊断 trace 后取得）： |
| P206 | **iPhone 竖拍（display matrix `rotation=-90`）素材画面横置：解码平面已正确，但「呈现方向」无人补** | `services/core/src/aivs_core/rendering/ir.py`（`geometry` / `rotation_deg`）/ `services/core/src/aivs_core/media/frame_decode.py`（`-noautorotate`）/ 由 P203 撤回旋转改动时拆出（用户裁决 2026-11-02） | 缺陷修复 | 🟡 **2026-11-02 单独立项；2026-11-05 复核后仍未关闭——缺少「出帧铺满」内容判据回归锁。** `frame_decode.py` 已带 `-noautorotate`，`ir.py` 已补 `display_width/display_height/rotation`（P212 第⑤条），`test_frame_decode_rotation.py` 3 项已守住不花屏；但 `App.tsx` 的 `assetOriginalRatio` 在下拉选「适应」时不读 `rotation`，且缺「竖拍画面铺满画布而非只占局部」的内容包围盒回归锁。详情见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p206)。 |
| P207 | **预览代理（B11）从未被生成：链路早已建好，缺「谁调用 createPreviewSourceJob」这一环；且代理失败后永久不可重试** | `services/core/src/aivs_core/app.py`（2536/2571 两处路由门）/ `apps/desktop/src/app/App.tsx`（importAsset）/ `app/preview/source-resolver.ts` / 由用户「剪映能流畅、我们不行」追问触发 | 缺陷修复 | 🟡 **2026-11-02 已完成导入自动生代理、暂停自然切换与弱提示，保留两项非阻塞限制待收口。** 未闭环边界：ⓐ PiP 手势期间 `playing && !gestureHoldRef.current` 传 false 会被当作自然切换点重建会话；ⓑ 就绪切换仅认本会话 `importAsset` 登记的素材（早前会话素材需切项目/重启生效）。实测数据与修复过程见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p207)。 |
| P216 | **解码能力探测使用写死合成 codec string 而非素材真实 `hvcC`** | `apps/desktop/src/app/preview/decode-capability.ts:23-57` | 缺陷修复 | 🟡 **2026-11-05 登记，暂依赖运行时坏帧降级兜底，待决定探测策略改造路线。** `probeWebCodecsRow` 只探测固定 Main/Level120 串且 `probe-ipc` 仅探针可见，`p010OverlaySupport` 未接入生产决策；可执行出路：ⓐ 接入 `getGPUInfo` `overlayInfo`、ⓑ 从 `ffprobe.py` 补全 `profile/level`、ⓒ 契约明定探测仅作粗筛。详细取证见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p216)。 |
| P217 | **弹窗视觉系统重设计（Graphite Precision）——外壳已统一，内容级组件仍缺 30 个弹窗** | `apps/desktop/src/app/Dialog.tsx` / `apps/desktop/src/styles.css`（末尾 LAYER 1–9 追加层）/ 34 个业务弹窗组件 / `docs/design/ui-mockups/dialog-system-v2/`（设计源） | 工作包 | 🟡 **2026-11-09 进展：已登记 28 个弹窗 100% 处理完毕（24 个改动 + 4 个审计确认健康），待最终整体核销确认。** 已完成四批重构与 C 族 10 弹窗原型对照（`evidence/2026-11-09-dialog-family-c/`），Desktop 141 文件 / 1311 用例通过；全过程记录与各弹窗逐项对照见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p217)。 |
| P220 | **旧 `--vc-*` 令牌体系与 Graphite 令牌并存，两套强调色不一致** | `apps/desktop/src/styles.css`（`--vc-accent` 等 29 处引用）/ 待迁移清单未立 | 技术债（未开工） | ⏳ **2026-11-09 登记，尚未开工**——发现于 E 族（双栏工作台）样式审计：旧 `.vc-*` 体系与 Graphite 并存，**强调色有两个值**：`--vc-accent: #25d3ac`（旧，29 处引用）与 `--dlg-primary: #35d6ae`（Graphite）。二者肉眼相近但不同，同一界面里强调色可能来自两套令牌。**为什么单列而不顺手改**：① 影响**整个应用**（时间线、属性面板、工具栏等，不止弹窗），属产品级视觉决策而非局部清理；② 改动会**改变视觉**（`#25d3ac → #35d6ae`），需明确接受；③ 本轮 E 族已尝试顺手迁移并**全部回滚**——教训：**「令牌化」不等于「新增规则」，也不等于「跨体系合并」**，后者必须单独决策。**用户裁决（2026-11-09）**：E 族只做弹窗内可见部分、不碰 `--vc-*`；本项作为独立任务另排。**开工前需明确**：迁移后旧色是否整体变成新色、是否需要保留 `#25d3ac` 作为某个局部语义、以及 `--vc-accent-soft` 等派生变量如何换算。 |
| P227 | **预览丝滑收口（WebGPU 零拷贝合成器 + 软解实测推断提示）** | [预览引擎需求规格](requirements/PREVIEW_ENGINE_SPEC.md) §3 | 工作包 | ⏳ **2026-11-17 代码已合入（默认 WebGL2，`VITE_AIVS_GPU=1` 门控），待真机矩阵核销。** 已完成 WebGPU `importExternalTexture` 路径、四级回退、`suspected_software_decode` 提示及单测；待补真机 4K 对照、`VITE_AIVS_GPU=1` 回退无黑屏与假硬解提示验证。细节见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p227)。 |
| P230 | **时间线/预览五项 OpenFilm 对齐遗留观察** | `styles.css` / `TimelineCanvas.tsx` / `thumbnail-loader.ts` / `App.tsx` | 工作包 | 🟡 **①②③⑤ 与二轮修正（轨头节奏、busy 重排与 ±400px 余量）已落地，④ 已分立并推进；P232 接续缩略图预抽。** 完整排查与两轮改动详情见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p230)。 |
| P232 | **素材级缩略图预抽（Filmstrip Sprite + 迁移 v44）** | [预览引擎需求规格](requirements/PREVIEW_ENGINE_SPEC.md) §2 / `filmstrip.py` / `database_v44.py` | 工作包 | ⏳ **2026-11-17 已实现并与真机对齐（修复 `JobKind`、轮询退避、档位单源 `/80`、`job_scheduler` 轻量调度），待全量 `pnpm test:python` 收尾。** 详尽排查与回归明细见 [详细记录](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p232)。 |
| P231 | **WP-P231 预览画布模型重构（黑色公共背景 + 全轨道素材自由排版，P230-④ 分立）**：Core ir.py 的 visual/overlays 分流从「track_id==V1」改为「全部非音频非隐藏轨」；V1 主轨语义降级为普通盒子；权威端 ffmpeg 合并循环同步；预览合成器 main/overlay 双路径统一；转场锚定/关键帧白名单/变速借用窗口三处契约随迁 | 待规划 | 工作包 | 🟡 **2026-11-17–22 S1–S7 实施、画布比例语义再裁决与隐藏视觉轨不入帧已落地；仍缺 A2 ffmpeg/IR 逐像素对拍独立补证。** 全视觉轨 layers、同轨转场与 `IR_PROJECTOR_VERSION=7` 已交付，A1/A3/A6/A7/A10 与隐藏轨真机 E2E 已通过；仅余 A2 逐像素对拍待补证。全轮修订与核查见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p231)。 |

> 📦 **详细排查流水**：开放工作包与缺陷的多轮实测流水原文统一收录于 [`OPEN_ISSUES_DETAILED_LOG_2026-11.md`](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md)。

## 5. 已知未完成工作（**不是过期，是真实待办**）

| 项 | 说明 | 出处 |
|---|---|---|
| 4K60 常态约 1.0s 未归因差异 | 同素材同路径三次复跑一致（7.3/7.8/7.5 vs 原 5.4），已归因约 19% 为机器变慢、**剩余约 1.0s 未归因**。仍远低于 10 门限 | `CV_SAMPLING_SPEC.md` |
| json_schema 适配器被网关拒 | provider 兼容面窄于设计，script 类适配器为唯一通路 | 2026-09 网关兼容性实测结论 |
| Provider 域独立工作单 | 代理与探测总预算**均已交付**；本条保留用于跟踪 provider 域后续 | — |
| Wave1 剪辑手法收尾 | **L1/L2 已核销（2026-10-10）**：L1 词戳自动拉取 = Core `_signals_for` 注入（既有）+ 面板词戳来源徽标（新）；L2 = 注入半边既有，**产出半边补齐**（此前 `BeatGridService` 零调用方、`beat_grids` 生产永远为空 → 卡点必失败）——新增 `POST …/assets/{a}/beat-analysis`（generate 登记作业）+ jobs `beat_analysis` 派发（waveform 同型）+ 面板「分析节拍」按钮与轮询 + `_signals_for` 补 algorithm_version 过滤；测试 单元 8（含 110BPM 真实素材全链 + 负向对照）+ API 5 + 面板 5。**L3 真机手测**：机器可判定部分已由自动化执行并留证（P78；执行中发现并修复 P74–P77），**人工签字项（听感/审美）待用户**——清单 `docs/archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md`；自动化用例见 `apps/desktop/e2e/wave1-editing-tools.electron.spec.ts` | `docs/archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md` |
| **中文模型分发与许可（W3.1）** | fp32 中文双塔 719 MB 无托管点、`download_url: null` ⇒ 装机用户无法安装；许可 `upstream-undeclared` 对外分发风险未确认。详见 §4 **P161** | P161 / P144 追记 |
| **W3.3 探测路由需 project_id** | `POST /providers/{id}/vision-capability` 取 `project_id` query 参数——设计门 §5.1 未规定，属实现下沉细节；若将来收紧为纯 Provider 级探测，需要能承载探测载荷的非项目级载体 | §4 P181 |

---

## 6. 历史状态文档索引（点时间记录，**引为现状前必须先读本文件**）

> **登记规则**：本表只收**点时间记录**（某一时刻的快照/验证数据/交接）；`docs/archive/` 下全部只读历史档案亦自动豁免过期黑名单。
> **活文档不得登记在此**——活文档过期应当**修正**，而不是豁免。

| 文档 | 性质 | 注意 |
|---|---|---|
| `docs/archive/W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md` | W3.3 S1a–S5a 切片实施摘要 | 浓缩自 S1a–S5a 实施记录；总验收复核见 `W3_3_VERIFICATION_GATE_2026-10-21.md` |
| `evidence/2026-10-21-w33-keyframe-blind-eval/RESULT.md` | A9 盲评结果（9 帧）点时间记录 | **不得**引作「质量已证」；样本 9 帧、±25pp、无对照、一次性 —— 边界见文件 §4 |
| `evidence/2026-10-21-w33-a13-packaged/EVIDENCE.md` | A13 打包产物取证点时间记录 | 只证 PyInstaller 产物（未打 NSIS、未跑 Electron e2e）；sidecar 重建不可复现，发布前 pin 需重签 |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND4.md` | P200 第四轮仿真验证点时间记录 | **已被推翻**（第五轮）：仿真内置自适应扩容，把真机主因（驱逐）消灭在模型里；不得引作真机因果证据。现行结论见 `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND5.md` |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND5.md` | P200 第五轮否证分析（纯只读）点时间记录 | 基于已入库 `app-drop-p196-*.json` 复核；推翻第四轮因果、改判主因为暂存帧驱逐。**未证明**提高容量即可消除退化（下一轮） |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND6.md` | P200 第六轮：立项判据复核（纯只读）点时间记录 | 推翻「时间线长度驱动」（对照组仅 40.6s、未覆盖 53.6s 冻结点）；现象为**近停摆**而非变慢。**未证明**触发状态量与修法 |
| `evidence/performance/p200-window-attribution-20261028/ROUND7_PREREGISTRATION.md` | P200 第七轮：重复运行测量（判据预注册） | 三次同配置 = 147/0/0 ⇒ 判据 C（不确定）；**未复现 P196 的持续停摆形态**。不得引作成因证据 |
| `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` | 2026-11-05 P203 复测（判定 C）点时间记录 | 只证该 HEAD 上「不挂死 + 走 FFmpeg + 代理未生效」；**根因未修**，代理 ready 后是否仍挂死**未测**；历史 `EVAL_BLOCKED` 读数不得引作堵死证据（见 §4 P215） |
| `docs/archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md` | 未闭环项逐轮排查流水原文（2026-11） | 自本文件 §4 抽离的详细调查日志，当前结论以本文件 §4 为准 |

**不在此表的活文档**（过期即修正，不得豁免）：`README.md`、`ARCHITECTURE.md`、
`docs/requirements/BRAND_BASELINE.md`、`docs/requirements/PRODUCT_ROADMAP.md`、`docs/requirements/VORTEX_CUT_USER_MANUAL.md`、
`docs/design/AI_CAPABILITY_MASTER_PLAN.md` 及各活跃规格文档。

---

## 7. 维护本文件的规则

1. **改代码改了 §1 的字段 → 立刻改 §1 的块**。忘了也没关系，测试会红。**正文散文里复述的数字（如「算法版本 3」「23 种显式冻结」）同样被测试比对**——写死数字时必须与 §1 一致，或改为引用 §1。
2. **规划门新增任何承诺 → 在 §4 加一行**。完成时把状态改为 ✅ 并注明证据与日期。
3. **交付了新能力 → 在 §3 加一条**；规划中的能力**不加**（属于总纲）。
4. **发现某个历史文档被取代 → 迁入 `docs/archive/` 并在 §6 加一行**，或直接删除（由 Git 历史追溯）。
5. **其他文档不要复述状态**——复述即漂移的起点。
6. **§4 活性表只留开放项**——一旦核销/关闭，在同一次提交内将长期结论并入对应活文档并从 §4 移除该行（由 Git 历史追溯），并按 `AGENTS.md` Rule 7 清理临时过程文件；§4 单元格保持简明摘要，长篇排查日志写入 `docs/archive/` 或 `evidence/` 并回链。
