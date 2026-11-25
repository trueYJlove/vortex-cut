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



> 本节仅保留**未闭环、待裁决与持续跟踪项**；已核销（✅）、已取代（⏭️）、已否决（❌）与 ADR-0009 冻结项完整归档于 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md)。所有行核销日期与证据不删改。

| # | 承诺 | 出处 | 类型 | 状态 |
|---|---|---|---|---|
| P236 | **时间线数据解耦与 Agent 协作工作区（Core 权威 + 声明式工作区投影/双向摄入 + MCP/CLI）** | [架构方案（最终版）](plans/P236_TIMELINE_DECOUPLING_AND_AGENT_WORKSPACE_PLAN_2026-11-24.md) | 工作包 | ⏳ **2026-11-24 已立项，待规划门与实施切片拆解**——采用 Core 领域权威 + SQLite 不可变 Revision 账本 + 声明式无损工作区投影/双向摄入（整数微秒）+ MCP/CLI 优先暴露层；明确否决删 SQLite 时间线表、浮点秒持久化与 Electron Main 校验器反模式。 |
| P235 | **OpenFilm 时间线视觉/交互/功能/性能完整收口（接续 P234）** | [设计计划与可重复验收口径](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) / P234 [阶段性取证](archive/P234_OPENFILM_TIMELINE_2026-11-23.md) | 工作包 | 🟡 **2026-11-24 持续实现与验收，尚未收口。** 固定参照为本地 OpenFilm commit `b125a3d9`；受控 Chromium 配对夹具已改为与 Vortex 相同的 52s 片段终点，每轮从当前源码重建，视口 2130×1120、DPR 1、相同四轨八片段与本地合成媒体。最新 capture：初始缩放两侧均为 28.000000 px/s；固定标题状态两侧均为 40.000000 px/s、scrollX=133、标题 x=138/y=105；trusted wheel 覆盖对角触控板、普通垂直、Alt 垂直、Shift 横移；基础跨轨拖动 preview/commit 均落在 18s、页面错误 0；Alt+Insert 提交后 8/8 片段的轨道与开始时间和 OpenFilm 完全相等，验收容差 0µs。新增 V3-B 从 26s 拖至 60s 并延长项目的双端对照：两端均落在 59.993s、项目时长从 52s 到 72.993s，同时保持 28px/s，双端起点差 0µs；像素落点在 1px 内。本轮 Desktop 几何/拖动规划器/TimelinePanel 定向测试 178/178 通过（几何 82、规划器 37、面板 59），Desktop TypeScript noEmit 通过；时长缩放组件验收覆盖扩展/缩短/清空/空线首个短片/长项目首次载入，其中当前视图尺度规则通过 4 项组件测试；此前 Desktop 时间线几何/拖动/素材放置/编辑器回归套件 209/209、Core status/timeline/request-body limit unit 64 项通过（72.48s），本轮未重跑全套。规划器独立 10k 合成微基准（每场景 5 次预热、21 样本）p95：Place 1.48ms、Insert 3.04ms、V1 copy 2.25ms、V1 group(128) 3.32ms、10k rider carry 4.97ms；不等同于 P1 产品级性能门。最新区域像素比较共 46 区：4 个视频片段 perimeter 仍未达 99%（97.48%–98.93%），文字轮廓 33/39 通过、6 项仍失败；整体视觉接受为 failed。针对用户附件复核发现两图使用的片段/时长不同（上方多轨素材、下方含 155.5s 长片），不可作为同状态像素验收；已用相同四轨八片段受控夹具对照。修复 Place→Insert→Place 预览：后续片段跟随计划位置绘制；Insert 落点标记与 OpenFilm 同为宽 3px、x=1022，标记矩形偏差不超过 0.5px；去掉 OpenFilm 不存在的选中片段标尺色带。夹具使用真实选择状态，确保手势预览检查交互状态而非空回调。status consistency 10/10 通过；native Electron 截图未覆盖；夹具使用合成媒体且 stub filmstrip worker，不能证明真实解码或性能。完整双端手势矩阵、Core revision/undo、Replace、未知时长、素材文件放置、转场/page、冷/热/播放/解码性能与原生运行对照等仍未通过，故 P235 总包及 P235-R1–R4 继续开放；P235-R5 批量位置风险已按下行单独闭环。此前速度范围、播放合速、音频流隔离等实现细节及其定向验证仍按本计划跟踪，不作为整包通过依据。 |
| P235-R1 | **P235 Replace 语义｜无音轨 video 与未知时长** | [P235 设计计划：Replace 源码差异及 G2/F1 用例](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / OpenFilm `clip-replace.ts` | 风险对策 | 🟡 **实现与证据未闭环**——无音轨 video 替换 sound 目标需映射为静音片段并保持 preview/export 成功；有限源时长未知时按 OpenFilm 的目标需求长度 fallback 规划，不能因探测结果缺失改变目标时长或直接拒绝；需覆盖时间线校验、预览与成片遇到源 EOF 的结果。原 HTML 拒绝边界已撤销，页面功能单列在 P235-R4。 |
| P235-R2 | **P235 Replace 时长保留与 audio-only 导出尺寸/解码成本** | [P235 设计计划：>30s still / audio-only video 渲染规则](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2–§3 / Core review 2026-11-23 | 风险对策 | 🟡 **设计经 Core/独立复审通过；实现和证据未闭环**——Vortex 原 30s image 上限会让 OpenFilm 允许的长 still Replace 失败；移除上限、统一 100ms 到 `Number.MAX_SAFE_INTEGER` 微秒且校验精确结束点，并验证 >30s still 替换保留长度。视频作为音频使用时，不得进入 `resolution="original"` 的视觉源分辨率计算，也不得产生视觉 decoded frame；RenderPlan/IR `video_required`/`audio_required` 字段、Desktop rig/source resolve 过滤、原始音频票据与 proxy 分离、FFmpeg input-side `-vn`、按 input 计数的 renderer decode submission/output 与 FFmpeg decoder-return counter、插桩/正式 binary 分开采样及配对资源数字均须实现和取证。G2/F1/P1 需验证合同、TimelineDocument、RenderPlan/IR、预览与成片结果。 |
| P235-R3 | **OpenFilm 转场来源事实与最终布局投影** | [P235 计划：转场投影要求](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / Independent Review 2026-11-23 | 风险对策 | 🟡 **设计架构已冻结，source facts、43rd patch op、旧 transition dormancy 与最终布局 projector 均已纳入；实现及投影测试未闭环**——active pair 必须供 Timeline、预览、RenderPlan/FFmpeg 和编辑校验共用，旧 `{after_clip_id, kind, duration}` 不得重新绑定到新后继。migration 45 只从不可变历史修订/操作快照唯一恢复原 incoming identity；不可恢复时保留 null/dormant，不能从当前邻接推断。 |
| P235-R4 | **OpenFilm HTML page 时间线功能与隔离渲染** | [P235 计划：HTML page 功能要求](plans/P235_OPENFILM_TIMELINE_PARITY_PLAN.md) §2 / OpenFilm `clip-replace.ts`、`pageframes.mjs` | 风险对策 | 🟡 **page 架构已冻结；资产 migration、导入/拖入/Replace、有限/无限时长和共用确定性帧服务尚未实现/取证**——合同包括 `asset_kind=page` 的安全源窗、OpenFilm `page_overrides[]` 校验与 Replace 清理、entrypoint 参与 bundle/cache hash；执行用户 HTML 前仍必须通过独立安全复核，覆盖 sandbox、资源白名单、网络/导航边界、超时/取消与越权负例；实时预览、authoritative preview、final export 必须使用同一页面帧源。 |
| P81 | **W2.1 风险 R1｜设备时钟漂移**：单一偏移在长素材上不成立 | `docs/requirements/CAMERA_SYNC_SPEC.md` §4 R1 | **风险对策** | 🟡 **2026-10-10 取证已实现，分段偏移待真实素材**——远距窗口（相隔 20s）残差差 >10ms ⇒ `unavailable(clock_drift)`，**不返回两端各错一半的单值**；测试：0.1% 重采样素材（低频主导，避免宽带噪声先撞 low_confidence）+ **分支锁**（近窗一致/远窗偏 50ms ⇒ 必走 clock_drift），共 2 项。**分段偏移/线性拟合按 D4 待真实多机位素材取证后再定**；素材短于 ≈22s 时远距漂移检查**未取证**（`drift_us=None`，短视频跨度内漂移有界 ⇒ 照常 ready，属已声明限制） |
| P84 | **W2.1 风险 R4｜无真实多机位素材** | `docs/requirements/CAMERA_SYNC_SPEC.md` §4 R4 | **风险对策** | ⏳ 待实施——向用户索取样片；未取得前**验收项 9** 显式标记「未取证」，禁止以合成素材顶替 |
| P89 | **W2.2 风险 R1｜无真实多说话人素材 → 精度轴无法取证** | 同上 §4 R1 / §5 D3 | **风险对策** | 🟡 **2026-10-11 部分解除**——改用**公开带标注语料**（AMI，CC BY 4.0）取得精度轴（见 P88 ⑩）：**公开语料带官方参考标注，比"用户随手给一段没标注的素材"更能算出真 DER**。**仍未取证**：跨语言 / 重叠 / 远场单麦 / 用户自有素材。**W2.1 验收 9 的同源缺口另有替代路径**（见 P93）。原纪律保留：**禁止以合成 / 易化构造用例顶替**（本机 `eval_set` 的 `spoken-multi-*` 经核实是**纯音调夹具、不含语音**） |
| W2.2-ADR0009 | **W2.2 说话人层冻结项（P90 / P91 / P104 / P131 / P133 / P134 / P137 / P138）** | [ADR-0009](design/adr/0009-w22-diarization-closeout.md) / [STATUS_ARCHIVE.md](STATUS_ARCHIVE.md#adr-0009-冻结项w22-说话人层) | 工作包/风险（冻结） | ❄️ **已按 ADR-0009 停止推进（2026-10-17）**——W2.2 停在降级交付形态，W2.3 冻结；解冻条件见 ADR-0009 §3 U1–U3。8 项原始记录完整归档于 [STATUS_ARCHIVE.md](STATUS_ARCHIVE.md#adr-0009-冻结项w22-说话人层)。 |
| P132 | **W2.2 降级交付验收项 A4｜下游（W2.3）拒绝未验证轮次必须有测试** | `docs/archive/W2_2_DEGRADATION_DESIGN_GATE_2026-10-14.md` §2 / §3 A4（实施记录 `W2_2_DEGRADATION_IMPLEMENTATION_2026-10-16.md` 见 Git 历史） | 验收项 | ⏳ **待实施（2026-10-16 独立登记）；2026-10-17 因 ADR-0009 D1 冻结 W2.3 而暂时无交付对象，但明确不撤销**——**为什么独立登记**：门 §3 的 A4 原被写在 P130 行**内部**，而 P130 是 ✅ ⇒ **一个未完成的验收项被埋在一个标记为完成的行里**，违反 AGENTS.md Rule 3「验收项必须可追踪」。本轮补实施记录时把它拆出来。**约束内容（门 §2 冻结）**：W2.3 机位切换规划器**读 speaker turn 前必须校验 `quality_status`**，非 `validated` 即**拒绝或降级为不切换**；该拒绝**必须有测试**，且**负向对照**为：把标注改成 `validated` 则测试**变红**（否则判据恒真）。**不得**写「可用低置信部分」类软约束（§5.21 已证没有能区分「可信段」的判据）。**交割条件**：随 **W2.3 立项门**落地（门 §7 第 2 项）；**在本行关闭前，W2.3 不得开工消费 speaker turn**——当前**全部**说话人轮次的 `quality_status` 恒为 `unvalidated`（精度门 S3 不过，P128），故拒绝路径就是**唯一**合法路径。 |
| P147 | **W4.2 风险 R1｜融合排序无 ground truth ⇒ 无法证明「比单源更好」** | `docs/requirements/SIGNAL_FUSION_SPEC.md` §5 R1 | **风险对策** | 🟡 **2026-10-19 登记**——总纲 W4.2 验收项原文要求「融合排序相对单源的可断言提升」，但**不存在客观真值**（什么算「更好的粗剪」需要人工判断）⇒ 本门**明确不承诺该断言**，改以结构正确性 F1–F6 + 人工盲评协议（另立门）替代。**理由**：本仓已多次因「拍一个没有依据的判据」翻车（W2.2 的 S1/ARI 门槛、v2 的 NC1 spread 门槛），不重复第三次 |
| P148 | **W4.2 风险 R2｜融合权重无依据** | 同上 §5 R2 | **风险对策** | 🟡 **2026-10-19 登记**——权重靠人为设定时无客观依据。**对策**：权重表**显式化 + 版本化**（写入契约，不得内联魔数，由 F6 测试断言），允许将来据评测调整；**本门明确不声称当前权重最优**。初始值建议等权但须登记为「未调优」 |
| P149 | **W4.1 未实现步骤种类（`roughcut` / `style`）—— 延后 + 写死触发条件** | `WORKLIST_ORCHESTRATION_DESIGN_GATE_2026-10-01.md` §2 / :162、:97 / `WORKLIST_ORCHESTRATION_ACCEPTANCE_2026-10-02.md` :24 / `worklist.py` :13,:55-56,:72-73,:109-110 / `test_worklist_service.py` | 工作包（延后） | 🟡 **2026-10-20 补登记与守卫；结论 = 维持延后、不立项，触发条件已写死**——**为什么要补登记**：设计门 §2 末条 :162 明确「暂不实现 roughcut/captions/style 的执行器；它们返回明确的 `WORKLIST_STEP_UNAVAILABLE`，并且不得产生 job 副作用」，验收表 :24 亦记为 ✅，但 `STATUS.md` 此前**零登记**（`grep roughcut` 命中 0），且该「明确拒绝」**没有任何测试守卫**——实测删除 `worklist.py` :55-56 或 :72-73 **不会让改动前任何用例变红**。**本轮补上守卫**：新增 3 个参数化用例（`roughcut` / `style` × prepare/create/advance），`test_worklist_service.py` 6 → **10 项**，与 `test_worklist.py` 合计 **12 passed**。**负向对照（实测）**：移除 `prepare` :55-56 → **2 failed**；移除 `_start_next_step` :72-73 → **2 failed**；移除 `create` :109-110 → **仍全绿**。**⚠️ 自曝一处**：create 的守卫与 `_start_next_step` 在可观测行为上**完全等价**（同一错误码，且都在任何状态变更前抛出——实测拒绝后 worklist 仍 `prepared`、step 仍 `pending`）⇒ 该行是冗余防御，**不存在能让它变红的测试**；已在用例注释中如实标注，不谎称其为独立锁；create 用例改为断言设计门真正承诺的「拒绝 + **零副作用**」。**为什么维持延后（不立项）**：① 瓶颈是**需求**而非成本——`worklist apply` 的 {base_revision_id, proposed_document_sha256} 与 `planning.adopt` 的 {schema_version, candidate_document_sha256, base_revision_id} **字段一一对应**，`roughcut` 步骤无需新建 proposal 层；② 但 worklist **无任何真实使用证据**（Desktop e2e 零用例、`worklist-panel.test.tsx` 5 例全为隔离与参数校验、无一真正调用 Core）⇒ 此时加第三种步骤是给无人使用的功能加能力面；③ 反方向「废除」代价更大——SQLite 不支持修改 CHECK，只能重建 `worklist_steps` 表并新增迁移，且会毁掉契约向前兼容；而「声明 4 / 放行 2 / 有登记 / 有守卫」本身即设计门本意。**触发条件（写死，防悬空）**：**`roughcut`** —— 出现「一次跑完全链而非分三次手点」的**真实需求**时立项，**先决约束：`apply` 必须转调 `planning.adopt()` 复用其全部校验，不得重造**（`adopt` 含 document_sha256 一致、`candidate_adoptions` 去重、`timeline_drafts` 冲突、基线漂移、素材可用性、转录指纹等七道校验；重造两份必然漂移，而「重复采用」与「草稿冲突」均有实际后果）。**`style`** —— 必须先有独立设计门（现仅 `DESIGN_GATE:97` 一行意向，无任何实现、无契约、无设计）。**边界**：本行**不承诺** `roughcut` / `style` 可用；未实现执行器。**零迁移 / 零契约 / 零 egress / 生产代码零改动** |
| P161 | **中文模型分发与许可未闭环**（P144 追记的承接项；对最终用户的实际阻塞） | `resources/model-manifests/chinese-clip-vit-base-patch16.json` / P144 / P153 / P159 | 风险对策 | 🟡 **2026-10-20 登记，未解决**——**两个独立阻塞**：① **分发**：交付体 fp32 中文双塔 719 MB 由本仓自行导出，清单 `download_url: null`、三个文件均指向 `file://${AIVS_MODEL_SOURCE_ROOT}/...` ⇒ **装机用户拿不到模型**（本机导出需 torch/onnx/cn-clip + 1.5GB 上游 .pt，而 GitHub 在本机不可达）。P159 已实测 fp32 查询快 2.97×、量化版体积小三 4×、两者效果无差异（P158/P160），但**选型解决不了「谁来托管」**。② **许可**：`license.id = upstream-undeclared`（上游无 LICENSE 文件、README 无声明），清单以 `acceptance_required: true` 强制显式接受——用户 2026-10-19 明确决定承担该风险；**但「自己机器上跑」与「对外分发权重」的暴露面不同**，后者需用户重新确认。**解除条件**：给出可公网访问的 https 托管点（或决定不分发、仅限自建）；许可风险由用户书面确认或改用许可明确的替代模型（后者需重跑 P151/P152/P158/P160 全部评测） **2026-10-24 进展（可配置化已完成，commit 见下）**：② 许可维持已知风险（用户裁决：标记不处理、继续提供下载）。① **分发通道已做成配置项**——新增 `AIVS_MODEL_CDN`：设为 https 基址即从该基址按 `files[].path` 下载，未设置则保持原 `file://` 本机来源不变；非 https 与远程明文 http 一律拒绝（既有来源白名单不被绕过）。**新增 4 项单测**（覆盖优先取值、尾斜杠归一、未设置时回落、scheme 白名单），`test_model_local_source.py` **11 passed**；model-registry/manifest-integrity/semantic-selection/status-doc 回归 **58 passed**。**仍未完成**：实际产物尚未上传到任何托管点（需选定 tag 与上传），故「装机用户拿不到模型」**现状未变**——但已从「必须改代码」变为「只需填一个环境变量」；**2026-10-25 上传已完成，但 Private 仓库不构成最终用户分发**——产物已上传 GitHub Release `models-chinese-clip-vit-b16-zh-export-2026-10-19`（三资产合计 **754,137,398 字节，与清单一致**：vision 345,198,002 / text 408,500,272 / tokenizer 439,124）；端到端实测经 API 资产端点下载 tokenizer.json，**sha256 与清单完全一致**。**但实测发现**：`releases/download/` 直链在 **Private 仓库下返回 404（带 token 亦然）**，只有 `api.github.com/.../releases/assets/{id}` + `Accept: application/octet-stream` 可取；而该方式要求每个用户持有仓库访问 token，**对装机用户不现实**。⇒ **Private Release 的真实价值是异地备份与团队内部获取，不解除「装机用户拿不到」**。**用户 2026-10-25 裁决：接受现状**，待自有云服务器后再迁移下载地址。**迁移成本已实测为零代码改动**：`AIVS_MODEL_CDN` 指向任意 https 基址即可（已验证 `https://cdn.example.com/models/cc-clip/v1` 与 OSS 形式均正确拼接 `<基址>/<files[].path>`），未设置时仍回落本机 `file://` |
| P165 | **W3.3 验收项 A9/D6｜打标质量人工盲评（工具交付、评分待完成）** | 同上 §1 D3/D6、§4 A9 | 验收项 | 🟡 **2026-10-21 登记，交付物随本包产出、评分由用户事后完成**——**为什么不并入 P162**：本条是**唯一需要人参与**的验收项，本仓这类项有**两次永久挂账前科**（P84 真实多机位素材、P132 下游拒绝测试），故独立登记防「工作包标 ✅ 就以为质量已证」。**交付口径**：我产离线盲评包（图片 + 评分表 + 统计脚本），**评分口径先于看数预登记**（照 `evidence/2026-10-20-w31-zh-fp32-eval/PRE_REGISTRATION.md` 范式，评审 M4 要求）。**关闭条件**：用户完成盲评并回填结论。**在此之前**：门与本登记均**不得**出现任何优越性表述，A9 以正则负向检查钉死。**⚠️ 2026-10-21 收口追记**：A9 的第二半（正则负向检查）此前**零实现**，已在 **P182** 补齐（`test_keyframe_wording.py` 6 项）。**✅ 2026-10-22 核销（用户完成评分）**——评分者：用户本人（口述「全都合理」，调度方按口述代录勾选，**代录不含调度方判断**）。**结果（口径受预登记 §6 约束，只能用这一句）**：「在 **9 帧**的人工盲评中，合理 **9** 帧、部分合理 0 帧、不合理 0 帧」；`unscored_or_ambiguous` 为空（9 行各恰好勾选一档）。证据 `evidence/2026-10-21-w33-keyframe-blind-eval/`：`PRE_REGISTRATION.md`（先于评分落盘）→ `score-sheet-done.md` → `result.json` + `RESULT.md`。**样本 9 而非预登记设想的 15**：12 行落库标签中第 2 个素材文件已不在盘、按 §1 如实排除到 12；再因两个 asset 行指向同一物理文件而按指纹去重到 **9**（P186）。**⚠️ 以下不得由此推翻**：① 不得写成「准确率 100%」（9 帧 95% CI 约 ±25pp）；② 不得用于模型间比较（无对照）；③ 不得据此宣称「可用于生产」（一次性盲评，非持续回归集）；④ **A9 的关闭条件是「用户完成评分」，不是「分数高」**——本轮分数高不能反过来当作质量已证的证据 |
| P192 | **e2e 共享 helper 选择器失灵（缺陷链的公共上游）** | `apps/desktop/e2e/project-switcher.ts` / `stage1b` / `stage1c-editor` / `stage2a` / `stage4b` / `stage4c` / 承接 P191 | 工作包 | 🟡 **2026-10-23 部分完成（3 类选择器失效已修，缺陷链下游另计）**。**为什么单列一行**：这不是 9 个独立缺陷，而是**一个共享 helper 变坏**——`selectProject()` 用 `[data-project-id="${id}"]` 定位，而该属性在 `apps/desktop/src/` 里 **0 处出现**（grep 实测），`App.tsx:2579-2591` 的真实标记是 `aria-label="切换项目"` 按钮 + `role="listbox" aria-label="选择项目"` 容器 + `<button role="option">` 项。`selectProject` 被 **9 个 spec 共 27 处**调用 ⇒ 一坏俱坏。 |
| P194 | **e2e 缺陷地图与分批处置（承接 P191/P192）** | `tools/verify_stage6r_offline_real.py` / `e2e/stage6r` / e2e 其余 13 项 / 承接 P192 | 工作包 | 🟡 **2026-10-23/24 分批处置中（族1/族2/族4 与 stage2a/stage2b/m5-timeline/p33-eof-replay 已修或定性，仍余少量待办）。** 当前剩余：`stage4d:323` 真实生图受本地网关不支持 `/images/generations` 阻塞（环境前提缺口）、`stage4d` env-gate 相关用例待配齐凭据后处理、`p33-seek-play` 仍为 `test.fixme`。全量实测、负向对照与各轮提交记录见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p194)。 |
| P196 | **设计门与状态源对账：6 项「承诺了但未落地」的遗留补齐登记** | 42 份设计门全量审计（2026-10-24）/ 承接 P194 | 工作包 | 🟡 **2026-10-24/27 处置中（6 项门内遗留中 (1)(3)(4)(5)(6) 已实施或取证，第 (2) 项转入 P200）。** 第 (1) 项缓冲态 UI 与第 (3) 项 manifest IR 冷/热实测（`evidence/performance/manifest-ir-disk-cache-20261024/`）已完成；第 (4)/(5)/(6) 项图片代理与错误上下文已落地；第 (2) 项「30 分钟跨窗无卡顿」因 `MAX_IR_FRAMES=27_000` 结构上限收口为决策阻塞，后续长时线退化跟踪转移至 **P200**。各轮实测与变异验证见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p196)。 |
| P197 | **B13-R 驻留工作包整包在状态源不可见 + 门内两项遗留未关闭** | `docs/archive/PERFORMANCE_B13_RESIDENCY_PLANNING_GATE_2026-09-11.md` / `docs/archive/PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md` | 工作包 | 🟡 **2026-10-24 登记，待处理**——**为什么单列**：`grep B13 docs/STATUS.md` = **0**，即整包（含已通过的独立验收）在本单一状态源中**完全不可见**，违反 Rule 1/Rule 3；这不是「某项没做」，而是「一整包工作从未入表」。**遗留一**：门 `:50-51` §2 R2-2 要求「direct 模式下 `textureBytesOf` 记账改随 `frameUploadMode` 实况」——**未实施**，`compositor-worker.worker.ts:678-680` 仍恒定 `width*height*1.5*(4/3)`（NV12×mip 口径），三处调用 `:345/:702/:757` 均不读 uploadMode；实施记录自认「已在 Gate §2 登记，随 Chromium 层归因一并**挂起**」，但该挂起**从未进本表**。**遗留二**：`:89-91` 与独立验收 §8 同列的「Chromium 上游方向」**未立项**，故无跟踪行。**已交付部分（据实记录，勿误读为未做）**：判别+护栏已交付并通过 2026-09-13 独立验收。**2026-10-24 治理处置（用户裁决）**——**遗留一正式挂起（非遗忘）**：`textureBytesOf`（`compositor-worker.worker.ts:678-680`）实测仍恒定 `w* h*1.5*(4/3)`，而 `frameUploadMode` 在 `:365/:383/:393/:403/:906` 处真实影响上传路径，记账口径确实未随模式实况变化；改动它需 Chromium 层归因一并处理，收益不确定，故**显式挂起**并把「挂起」本身记入状态源（此前只写在实施记录里，等于没记）。**遗留二正式标注不立项**：门 `:89-91` 与独立验收 §8 的「Chromium 上游方向」**不单独立项**——解冻条件=上游 Chromium 修复该驻留问题或我方确认需要自建上游补丁；在此之前无可执行的本地工作项。 |
| P198 | **能力矩阵中「规划了但未开展」的工作包 —— 状态源零覆盖的补齐登记** | `docs/design/AI_CAPABILITY_MASTER_PLAN.md` §4 能力矩阵 / §5 Wave 工作包列表 | 工作包 | 🟡 **2026-10-24 登记，全部未开展（按总纲冻结，非本轮新增决定）**——**为什么单列一行**：这些项**没有设计门、也没有 P 行**，因此在唯一状态源中完全不可见（实测 grep：`W3.4`=0、`W4.3`=0、`W5.1`=0、`E7`=0），违反 Rule 1；而「未开展」与「没做」不同，需显式声明以免被误读为遗漏。**注意编号撞车**：能力矩阵的 `D2`/`O5` 与 ADR-0006/0007/Design Gate 的 `D2`/`O5` **同名不同义**（前者指数逐张 egress 审计 / MCP 暴露层，后者指 ADR 决策序号 / W2.2 BLOB 备份开放项），引用时必须写明来源。**(1) W3.4 蒙太奇 / 匹配剪辑增强（E6/E7）——未开展**：交付=基于 U7/U8 的语义分组 + 叙事排序提示词升级、匹配剪辑（构图/运动方向相似度）；验收=叙事连贯性人工评分相对基线提升 + 相似度阈值可断言；**依赖 W3.1 或 W3.3**。优先级 E6=P1、E7=P2。**(2) W4.3 MCP 适配层（O5，能力矩阵）——未开展**：交付=冻结契约之上的暴露层，工具清单=REST 端点 + patch op + 语法层规划器（复用 W1.1 工具描述）；验收=MCP 客户端可完成一次粗剪、无新数据模型、无新 egress 面；依赖 W1.1。优先级 **P2（可选/远期）**。**(3) W5.1 全能力对标验收——未开展（该项最关键）**：交付=§1 七条维度逐项证据包 + §4 矩阵 P0 项逐项 e2e + C4 质量基线复测；判定=**P0 全绿 + C4 达标 ⇒ 方可宣称「与成熟软件基本对齐」**；**依赖 Wave 0–4 全部完成**。即：在当前 Wave 仍有未闭合项时，本项按定义为不可执行。**(4) U8 云端关键帧理解——未立项**（P1，opt-in，需显式 consent）；承载 W3.3。**(5) 能力矩阵 D2 逐张 egress 审计（帧级）——帧级待建**：文本级已交付，**帧级尚未建**，标 P0（差异化）；承载 W3.3。**（勿与 ADR-0006/0007 的 D2 决策序号混淆）**。**已确认有覆盖、无需重登的项（避免重复）**：`W2.3 机位切换` 已在 §3 `:58` 显式登记「❄️ 冻结（不立项/不实现/零代码）」+ ADR-0009 解冻条件；`E8 响度归一` 已有 **P187**；`W4.1 工作单编排` 的 `roughcut`/`style` 两类步骤延后已有 **P149**。**本行不改动任何既有决定**，仅把「已规划但未开展」的事实补进单一状态源 |
| P200 | **长时线合成预览退化：约 8 分钟以上时间线每 ~10s 冻结 2–11s（P196 门在其下）** | `evidence/performance/P196_CROSSWINDOW_30MIN_MEASUREMENT_2026-10-27.md` / 承接 P196 第 (2) 项收口 | 缺陷修复 | 🟡 **2026-10-27 登记、经 7 轮归因排查仍待修（现象已实证、触发量未定）。** 14.49 分钟长时线首轮出现约 0.4fps 近停摆（`window_fetch` p50 2512.6ms / p95 8733.1ms）；后续排除了 Core/IPC 慢、主线程长任务、`reanchor → missingStuck` 等假设，第 7 轮重复测得不确定（判据 C）但确认 `window_fetch` 延迟仍约 2.2s 且 96% 尖峰落在其 2s 内。详细 7 轮实测与更正记录见 `evidence/performance/p200-window-attribution-20261028/` 与 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p200)。 |
| P203 | **iPhone HDR（10-bit HLG HEVC）素材点「播放」即挂死渲染进程** | 用户提供素材 `c992c92d…_raw.mp4`（iPhone 13 Pro）/ 证据 `evidence/2026-11-01-iphone-hevc-blockers/README.md` / 2026-11-05 复测 `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` | 缺陷修复 | 🟡 **2026-11-05 复测判定 C：挂死已不复现（走 FFmpeg 软解兜底），但根因未修故未关闭。** 真根因定案为 Intel Iris Xe D3D11 的 `p010OverlaySupport: "SOFTWARE"` 导致 WebCodecs 产出 `fmt:null` 坏帧（升级 Electron 至 45.2.1/Chromium 156 亦无法修复）。已交付 HDR 检测告知、`DECODE_FRAME_FORMAT_NULL` 首次降级、`-noautorotate` 修复花屏与白屏崩溃修复；仍缺「代理就绪后是否仍挂死」及冷却回切安全验证。证据见 `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` 与 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p203)。 |
| P204 | **含 edit list（`elst`）偏移的素材全帧 `no sample`，时间码永远停在 00:00:00:00**（demuxer 不应用 `media_time`；已由 worker 实测索引定案） | 同素材的 8-bit SDR 转码版 / 同上证据文档 §2 | 缺陷修复 | 🟡 **2026-11-01 登记；同日修复并由 remux 对照实机验证（首帧 85000→0），但「完整播放」仍被 P203 阻断**——**现象**：8-bit SDR 版（不挂死）播放时 20 次采样 **`tc` 恒为 `00:00:00:00`**，每帧报 `解码失败 I0#N: no sample for frame N (best diff 558333–625000us)`。**抛错点**：`decode-worker.worker.ts:1309,1328`，`targetUs = (frameN / fps) * 1e6`，`fps` 由 `preview-session.ts:1116` 传入 `ir.canvas.fps`（画布 30）。**⭐ 根因（成立，2026-11-01 经实测索引定稿）**：**demuxer 不应用 edit list 的 `media_time`，导致索引首帧 PTS 偏移 0.625s**。**决定性实测**（本次给 worker 加 `sample_index_built` 诊断 trace 后取得）： |
| P206 | **iPhone 竖拍（display matrix `rotation=-90`）素材画面横置：解码平面已正确，但「呈现方向」无人补** | `services/core/src/aivs_core/rendering/ir.py`（`geometry` / `rotation_deg`）/ `services/core/src/aivs_core/media/frame_decode.py`（`-noautorotate`）/ 由 P203 撤回旋转改动时拆出（用户裁决 2026-11-02） | 缺陷修复 | 🟡 **2026-11-02 单独立项；2026-11-05 复核后仍未关闭——缺少「出帧铺满」内容判据回归锁。** `frame_decode.py` 已带 `-noautorotate`，`ir.py` 已补 `display_width/display_height/rotation`（P212 第⑤条），`test_frame_decode_rotation.py` 3 项已守住不花屏；但 `App.tsx` 的 `assetOriginalRatio` 在下拉选「适应」时不读 `rotation`，且缺「竖拍画面铺满画布而非只占局部」的内容包围盒回归锁。详情见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p206)。 |
| P207 | **预览代理（B11）从未被生成：链路早已建好，缺「谁调用 createPreviewSourceJob」这一环；且代理失败后永久不可重试** | `services/core/src/aivs_core/app.py`（2536/2571 两处路由门）/ `apps/desktop/src/app/App.tsx`（importAsset）/ `app/preview/source-resolver.ts` / 由用户「剪映能流畅、我们不行」追问触发 | 缺陷修复 | 🟡 **2026-11-02 已完成导入自动生代理、暂停自然切换与弱提示，保留两项非阻塞限制待收口。** 未闭环边界：ⓐ PiP 手势期间 `playing && !gestureHoldRef.current` 传 false 会被当作自然切换点重建会话；ⓑ 就绪切换仅认本会话 `importAsset` 登记的素材（早前会话素材需切项目/重启生效）。实测数据与修复过程见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p207)。 |
| P216 | **解码能力探测答的是「写死的合成 codec string 支不支持」，不是「这条素材的 hvcC 支不支持」** | `apps/desktop/src/app/preview/decode-capability.ts:23-28`（`PROBE_CODEC_STRINGS` 注释与取值）/ `:47-57`（`probeWebCodecsRow` 只用该串调 `isConfigSupported`）/ 承 `P203_ENVIRONMENT.md` §5.2 方向 2，从未实施 | 缺陷修复 | 🟡 **2026-11-05 登记，未修，也未测量（只登记，不修）**——**事实（读码）**：`PROBE_CODEC_STRINGS.hevc` 写死 `["hvc1.1.6.L120.B0", "hev1.1.6.L120.B0"]`（Main / Level 120），`:47-57` 直接拿这两个串问 `VideoDecoder.isConfigSupported`，**与该素材 `hvcC` 里的实际 profile/tier/level 无关**；`:23` 注释自认可疑 **「profile/tier/level 可能与实配 hvcC 错位」**。**⇒ 探测回答的是「这个合成串支不支持」，而实配是 10-bit（Main 10 / Level 150）** ⇒ 「报 `supported` 而实际解不了」这种错位**在当前能力表结构下无法发现**（P203 的 `fmt:null` 坏帧正是「判为支持、实际产不出可用帧」的实例）。**影响面**：能力表决定是否走 WebCodecs（`preferBackend` / `downgradeRow`）；探测偏乐观会把素材送进一条本机产不出可用帧的路，只能靠运行时坏帧检测 + 降级兜底（见 P215 之外的这条运行期兜底）。**未做的测量（不得越读）**：用真实 `hvcC`（`hvc1.2.4.L150.B0` 一类）与合成串各跑一次 `isConfigSupported` 对照，量化「探测结论是否随 codec string 改变」；再决定改为读 IR/`ffprobe` 的真实 profile，还是把「探测只作粗筛」写进契约。**为什么单列**：它不是「少个字段」，是**测量对象不是被测对象**——与 P215 同型（判据不测它自称在测的东西），但机制不同、修法不同。**2026-11-05 核实补充（只读码，未改代码）**：`p010OverlaySupport` 在 `apps/desktop/src` 与 `apps/desktop/electron` 全树**只出现在 `preview-session.ts:1118` 的一行注释里，代码从不读取它**（`grep -rn p010OverlaySupport apps/desktop/src apps/desktop/electron` 仅 1 处命中，且是 `//` 注释）；`apps/desktop/electron/main/probe-ipc.ts:104` 的 `gpu_info: await app.getGPUInfo("complete")` 是**纯透传**——该值经 `electron/preload/probe-bridge.ts:17` 与 `src/probes/common/bridge.ts:20`（类型 `unknown`）只落进探针证据（`src/probes/common/shell.ts:108`、`src/probes/m3p1.ts:242`），**没有任何能力表 / 解码决策读它**；且 `probe-ipc.ts` 整模块受 `probeActive()` 门控（`:24-28`，`app.isPackaged` 为真即返回 null，`registerProbeIpc` 在 `:47` 直接 `return null`）⇒ **生产构建根本不注册该 handler**。**⇒ 唯一能判定「这条素材解不了」的真实信号（`overlayInfo.p010OverlaySupport === "SOFTWARE"` 且素材为 10-bit）在探测层根本没被用上**：`probeWebCodecsRow`（`decode-capability.ts:43-57`）仍然只听 `VideoDecoder.isConfigSupported` 对写死串（`:24-28`）的回答。**可执行入口三条，按代价排序**：ⓐ **最便宜**：把 `getGPUInfo("complete")` 的 `overlayInfo` 接进能力表——调用本身已存在于 `probe-ipc.ts:104`，但当前只对探针可见，需一条生产可用的读取路径（开机一次或新 IPC），并据此在 `preferBackend`（`decode-capability.ts:158`）之前把 10-bit 素材预判到 FFmpeg；ⓑ **中等**：把探测对象从写死串换成素材真实 `hvcC` 的 profile/tier/level——**但后端当前没有这个字段**：`ffprobe.py:59-77` 的 video 流字典只采 `codec/width/height/sar/fps/rotation/pixel_format/color_transfer/color_primaries/color_space`，**无 `profile`、无 `level`**（`grep -n profile services/core/src/aivs_core/media/ffprobe.py` 零命中，`grep -n level` 同为零）⇒ 这条路必须先改 `services/core`，代价高于 ⓐ；ⓒ **维持现状**：在契约里写明「探测只作粗筛，真实判据是运行时坏帧检测 + 降级」（现状即如此，兜底见 `preview-session.ts:1124` 降级正则与 `:1151` 确定性失败判定）。 |
| P217 | **弹窗视觉系统重设计（Graphite Precision）——外壳已统一，内容级组件仍缺 30 个弹窗** | `apps/desktop/src/app/Dialog.tsx` / `apps/desktop/src/styles.css`（末尾 LAYER 1–9 追加层）/ 34 个业务弹窗组件 / `docs/design/ui-mockups/dialog-system-v2/`（设计源） | 工作包 | 🟡 **2026-11-09 进展：已登记 28 个弹窗 100% 处理完毕（24 个改动 + 4 个审计确认健康），待最终整体核销确认。** 已完成四批重构与 C 族 10 弹窗原型对照（`evidence/2026-11-09-dialog-family-c/`），Desktop 141 文件 / 1311 用例通过；全过程记录与各弹窗逐项对照见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p217)。 |
| P220 | **旧 `--vc-*` 令牌体系与 Graphite 令牌并存，两套强调色不一致** | `apps/desktop/src/styles.css`（`--vc-accent` 等 29 处引用）/ 待迁移清单未立 | 技术债（未开工） | ⏳ **2026-11-09 登记，尚未开工**——发现于 E 族（双栏工作台）样式审计：旧 `.vc-*` 体系与 Graphite 并存，**强调色有两个值**：`--vc-accent: #25d3ac`（旧，29 处引用）与 `--dlg-primary: #35d6ae`（Graphite）。二者肉眼相近但不同，同一界面里强调色可能来自两套令牌。**为什么单列而不顺手改**：① 影响**整个应用**（时间线、属性面板、工具栏等，不止弹窗），属产品级视觉决策而非局部清理；② 改动会**改变视觉**（`#25d3ac → #35d6ae`），需明确接受；③ 本轮 E 族已尝试顺手迁移并**全部回滚**——教训：**「令牌化」不等于「新增规则」，也不等于「跨体系合并」**，后者必须单独决策。**用户裁决（2026-11-09）**：E 族只做弹窗内可见部分、不碰 `--vc-*`；本项作为独立任务另排。**开工前需明确**：迁移后旧色是否整体变成新色、是否需要保留 `#25d3ac` 作为某个局部语义、以及 `--vc-accent-soft` 等派生变量如何换算。 |
| P227 | **WP-P227 预览丝滑收口（WebGPU 零拷贝合成器 + 软解实测推断）**：①compositor-worker 新增 WebGPU 路径（`importExternalTexture` 零拷贝采样硬解帧，flag 门控 + probe→external→rgba→copyTo 四级回退，`DrawCommand` 协议不动，WebGL2 路径原样保留）；②解码硬解「请求≠承诺」推断：`prefer-hardware` 配置成功不代表真机走硬解，实测解码 p95 持续超预算时提示「疑似实际软解」并建议转代理（现有提示只覆盖 `no-preference` 显式软解，漏掉本机实测 192ms 的「假硬解」形态） | `docs/requirements/PREVIEW_ENGINE_SPEC.md` §3 | 工作包 | ⏳ **2026-11-17 Implementation 完成（commit d7b45ec），待真机验收核销**——Slice 2（WebGPU `importExternalTexture` 零拷贝合成器，`VITE_AIVS_GPU=1` 门控 + init 失败整体回退 WebGL2 + 运行期降级 extFail）与 Slice 3（`suspected_software_decode` 假硬解推断 + UI 提示）已合入；自动化：新增 `preview-gpu-backend.test.ts` 6 项，全量 **148 文件 / 1359 用例全过**，tsc 0 错，build 通过且产物含两个转译后的 worker chunk（**构建陷阱两轮实测已记入 commit message**：worker 实例化必须是完整 `new Worker(new URL('<literal>'))` 字面量形态）；STATUS 守卫 10 passed。Slice 1（fps 感知预算）经核查否证（Core `FPS=30` 恒定）。**核销条件（真机）**：① `VITE_AIVS_GPU=1` 下 4K 素材 decode/upload/compose p95 对照（预期 upload p95 42ms → ≈0）；② WebGPU init 失败回退 WebGL2 无黑屏；③ Slice 3 提示在假硬解形态下真实出现且不误伤显式软解 |
| P230 | **WP-P230 时间线/预览五项 OpenFilm 对齐（用户 2026-11-17 截图指认）**：①多轨分隔不明显；②帧缩略图消失（回归）+ 选中背景异常；③刻度上方「粗线」；④预览画布模型改黑色公共背景+全部素材自由排版；⑤左栏到底、时间线右移 | `apps/desktop/src/styles.css`（①轨头泳道断裂修复 + ⑤网格重构）/ `apps/desktop/src/app/timeline/TimelineCanvas.tsx`（③删内容范围条 + ②b 选中框改纯描边）/ `apps/desktop/src/app/timeline/thumbnail-loader.ts`（②a filmstrip 帧级连续失败降级 video seek）/ `apps/desktop/src/app/App.tsx`（⑤ JSX 重构） | 工作包 | ⏳ **2026-11-17 ①②③⑤ 已实施，④ 单独立项**——①根因=轨头列被 `.editor-shell` 覆盖成 `--ws-inset(#101012)`，比泳道带(≈31.6)更深，带子在轨头断裂；已改回 `--bg-panel` 与参照一致（Timeline.tsx:4243 head ground = --tl-gap）。②b 根因=选中框旧实现 70% alpha **整面填充**外扩矩形（罩了一层背景板），参照 SelectFrame 是纯描边（borderWidth 1px/3px 上下 70% 左右实色）；已改逐边画。②a 静态测试全绿但真机空白 → 运行期失败路径（demux/解码/票据）静默 null 且只有 init 失败才降级；新增 filmstrip 帧级连续 3 次失败 → degradedAssets + video seek 兜底（真机若仍空白，降级路径会出图 + dev 控制台 `[filmstrip]`/`[thumbnails]` 给出根因日志）。③根因=标尺顶 3px 内容范围条——参照无此元素，删除。⑤根因=布局树形态不同（参照 workspace-dock.ts defaultDockTree：library 是最左 x 分栏纵贯全高，viewer+inspector+timeline 都在右列堆叠）；已重构 `editor-workspace`（library \| stack）两层网格。**④ 预览画布模型**：确认是一项跨 Core 投影（ir.py visual/overlays 分流）+ 权威渲染（ffmpeg.py 合并循环）+ 预览合成器三处的数据模型改造，牵动转场锚定（仅 V1 相邻段）、关键帧（V1-only 白名单）、变速借用窗口等既有契约——**不在本包内赶工**，另立 P231 规划门后实施（避免破坏权威/预览一致性契约）。回归：tsc 0 错；全量 **148 文件 / 1359 用例全过**；**2026-11-17 二轮修复（用户复验反馈）**：①上轮参照读错——参照轨头行自己 paint laneTone（Timeline.tsx:2731 heads map background=laneTone），行间 GAP=2 露出列地面；我上轮把轨头改成 --bg-panel 与缝同色反而抹掉分隔。已改：列地面 --bg-panel、轨头行 --tl-row、选中行 --tl-lane-on（左右两列亮度节奏一致）。②「时有时无」两处根因：a) 同素材 busy 互斥的请求被**丢弃**且「effect 重跑会补」不成立（丢弃无帧到达→无重绘触发→该格空到下次视口变化）——pump 改主循环、busy 请求重排队尾；b) 视口余量 ±160px 过窄，拖动中 epoch 取消风暴——放宽到 ±400px。遗留：首格延迟（防抖 200ms + 解码）治本需素材级预抽（参照 MediaPool 是导入时批量抽好静态 URL 表，时间线零运行时解码）——另立 P232。 |
| P232 | **WP-P232 素材级缩略图预抽（治「拖上去就有」）**：方案=结合两参照（OpenFilm 磁盘 JPEG 缓存 + Concat 导入即抽/低优先级批量）贴合本仓资产——Core ffmpeg `select+tile` 单 pass 产 sprite JPEG（160px 格宽）+ 旁挂 JSON 元数据；`derived_media_cache kind="filmstrip"`（B10 基建复用：内容寻址键/状态机/disk budget/refs）；导入成功即登记作业（jobs.py 分派，waveform 同构）；时间线查表优先（ImageBitmap 一次解码常驻 + 格采样零解码），运行时补抽兜底 | `services/core/src/aivs_core/media/filmstrip.py`（新增：阶梯/args/生成/服务层）/ `services/core/src/aivs_core/media/derived_cache.py`（KINDS 加 filmstrip）/ `database_v44.py`（新增：kind CHECK 放宽，重建型迁移含 refs 表+触发器/索引重建）/ `database.py`（v44 注册+rebuild 集合）/ `services/core/src/aivs_core/jobs.py`（filmstrip 分派）/ `app.py`（ensure+internal/media 两路由+模型）/ `packages/contracts/src/index.ts`（JobKind+DTO 纯增量）/ `apps/desktop/electron/main/{performance-ipc,core-admin-client,index}.ts`（ensure/media 两通道）/ `preload/index.ts` / `apps/desktop/src/app/App.tsx`（导入即登记）/ `thumbnail-loader.ts`（sprite 表+查表优先）/ `TimelineCanvas.tsx`（sprite 装载）/ `test_filmstrip.py`（5 项纯函数+变异） | 工作包 | ⏳ **2026-11-17 Implementation 完成，回归验证中**——Core 直连验证通过（作业→ffmpeg tile→sprite 落盘→entry ready，像素级确认格内容非黑）；黑格根因=ceil 修正（int+1 在整倍时长必多黑格）；迁移链修复链：v44 注册 rebuild 集合/refs 表与触发器索引同建（RENAME 悬空外键三连）/v18 测试种子与 checksum 断言对 v44 排除。已知：`STATUS` §1 latest_migration 43→44。**遗留待完成**：全量 Python 单测在本会话环境反复超时（1662 用例历史 ~24 分钟，后台 4% 卡位为既有慢测试文件、非本轮代码；分域已过 filmstrip/status/migrations/waveform/derived/jobs 82+23 passed）；Desktop 全量 1359 过（并行抖动 4 例单跑全绿=P224 既有）；**2026-11-17 用户报「导入素材后拖上时间线仍不显示抽帧」→ 已复现并修复三处缺陷**：①**契约构建红**——`packages/contracts/src/index.ts` 的 `JobKind` 联合类型漏了 `filmstrip`，而 `JOB_KINDS` 运行期数组已含它，`pnpm --filter @aivideo/contracts build` 直接 TS2322 失败；`dist/` 因此停留在旧产物，`isJob` 拒收 filmstrip 作业 → 任务页 `job:list` 报 `ContractValidationError`（用户看不到 filmstrip 作业就是这么来的）。②**sprite 装载只试一次**（主根因）——装载 effect 先把 assetId 写进 `spriteLoadedRef` 再查，首个 `filmstripMediaUrl` 必抛「未就绪」（导入→拖上轨道只隔几百毫秒，真机大素材作业要 6~75s），catch 静默后 ref 已置位 ⇒ sprite 永不登记，预抽整条链路等于没生效，只剩运行时补抽兜底。改为 `loadFilmstripsOnce`（可测纯调度体）：ensure 非 ready 退避重试（250/500/1000/2000×n，上界 20 次），failed/无视频流立刻落负缓存；在途链跨 effect 轮次存活（按素材差集取消），修掉「cleanup 无条件 cancel 反复打断重试链」这一同症状的第二种写法。③**档位清理常数不同源**——清理侧写死 `/44` 而请求/绘制侧是 `/80`，两侧档位永远对不上，3 轮（≈600ms）后把所有帧当陈旧档清空（缩略图闪一下就没）。抽出 `THUMB_CELL_PX`/`frameTierFor`/`currentFrameTiers` 三个唯一真源，清理侧改走同一函数。画布绘制期**同步兜底**（`drawTimeline` 增 `spriteLookup`：缓存未命中时直接查 sprite 表，`cellSourceTimeSec` 与请求侧逐位同源并含变速/倒放）——预抽作业异步（真机 6~75s），sprite 迟到登记后请求 effect 已不再重跑，只有绘制期同步取格才能让下一帧铺满；sprite 权威库 `spriteStoreRef` 跨 loader 换代存续并自动重新登记。④`job_scheduler.py` 补 `filmstrip: light/3` 策略——未登记则落 unknown ⇒ 保守独占 cpu+gpu+disk heavy 单槽，一条导入即抽的缩略图作业会把导出全挡住。**验证**：真机直连（用户原素材 `lwd12.mp4` 1080x1920）——修复前 11.9s 片段只有首 2 格有图、其余整条平涂；修复后整条铺满 12 格。单测 16 项（新增 preshoot 6 + 档位单源 3），并对 ①policy 移除 ②`/44` 回退 ③去掉重试 三个变异逐一确认断言会红（分辨力已证）。Desktop 全量 1369/1370 过（1 例 preview-revision-swap 并行抖动，单跑 6/6 绿 = P224 既有）；Core 分域 scheduler/filmstrip/status 28 项过。**遗留**：全量 Python 单测仍在本会话超时，待用户本机 `pnpm test:python` 收尾 |
| P231 | **WP-P231 预览画布模型重构（黑色公共背景 + 全轨道素材自由排版，P230-④ 分立）**：Core ir.py 的 visual/overlays 分流从「track_id==V1」改为「全部非音频非隐藏轨」；V1 主轨语义降级为普通盒子；权威端 ffmpeg 合并循环同步；预览合成器 main/overlay 双路径统一；转场锚定/关键帧白名单/变速借用窗口三处契约随迁 | 待规划 | 工作包 | 🟡 **2026-11-17–22 S1–S7 实施、画布比例语义再裁决与隐藏视觉轨不入帧已落地；仍缺 A2 ffmpeg/IR 逐像素对拍独立补证。** 全视觉轨 layers、同轨转场与 `IR_PROJECTOR_VERSION=7` 已交付，A1/A3/A6/A7/A10 与隐藏轨真机 E2E 已通过（[隐藏轨实现记录](archive/P231_HIDDEN_TRACK_PREVIEW_IMPLEMENTATION_2026-11-22.md)）；仅余 A2 逐像素对拍待补证。全轮修订与核查见 [详细排查流水](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md#p231)。 |

> 📦 **已归档承诺**：193 项已核销（✅）、3 项已取代/否决（⏭️/❌）与 8 项 ADR-0009 冻结项（共 204 项）已完整迁入 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md)。8 项长篇未闭环项的逐轮排查原文归档于 [`OPEN_ISSUES_DETAILED_LOG_2026-11.md`](archive/OPEN_ISSUES_DETAILED_LOG_2026-11.md)。

## 5. 已知未完成工作（**不是过期，是真实待办**）

| 项 | 说明 | 出处 |
|---|---|---|
| 4K60 常态约 1.0s 未归因差异 | 同素材同路径三次复跑一致（7.3/7.8/7.5 vs 原 5.4），已归因约 19% 为机器变慢、**剩余约 1.0s 未归因**。仍远低于 10 门限 | `CV_SAMPLING_SPEC.md` |
| json_schema 适配器被网关拒 | provider 兼容面窄于设计，script 类适配器为唯一通路 | `docs/archive/AI_VALIDATION_REPORT_2026-09-20.md` §实验 B |
| Provider 域独立工作单 | 代理与探测总预算**均已交付**；本条保留用于跟踪 provider 域后续 | — |
| Wave1 剪辑手法收尾 | **L1/L2 已核销（2026-10-10）**：L1 词戳自动拉取 = Core `_signals_for` 注入（既有）+ 面板词戳来源徽标（新）；L2 = 注入半边既有，**产出半边补齐**（此前 `BeatGridService` 零调用方、`beat_grids` 生产永远为空 → 卡点必失败）——新增 `POST …/assets/{a}/beat-analysis`（generate 登记作业）+ jobs `beat_analysis` 派发（waveform 同型）+ 面板「分析节拍」按钮与轮询 + `_signals_for` 补 algorithm_version 过滤；测试 单元 8（含 110BPM 真实素材全链 + 负向对照）+ API 5 + 面板 5。**L3 真机手测**：机器可判定部分已由自动化执行并留证（P78；执行中发现并修复 P74–P77），**人工签字项（听感/审美）待用户**——清单 `docs/archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md`、证据 `docs/archive/WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md` | `docs/archive/WAVE1_MANUAL_CHECKLIST_2026-10-10.md` |
| **中文模型分发与许可（W3.1）** | fp32 中文双塔 719 MB 无托管点、`download_url: null` ⇒ 装机用户无法安装；许可 `upstream-undeclared` 对外分发风险未确认。详见 §4 **P161** | P161 / P144 追记 |
| **W3.3 探测路由需 project_id** | `POST /providers/{id}/vision-capability` 取 `project_id` query 参数——设计门 §5.1 未规定，属实现下沉细节；若将来收紧为纯 Provider 级探测，需要能承载探测载荷的非项目级载体 | §4 P181 |

---

## 6. 历史状态文档索引（点时间记录，**引为现状前必须先读本文件**）

> **登记规则**：本表只收**点时间记录**（某一时刻的快照/验证数据/交接）；`docs/archive/` 下全部只读历史档案亦自动豁免过期黑名单。
> **活文档不得登记在此**——活文档过期应当**修正**，而不是豁免。

| 文档 | 性质 | 注意 |
|---|---|---|
| `docs/archive/P234_OPENFILM_TIMELINE_2026-11-23.md` | P234 阶段性取证快照（已由 P235 接续） | 滚轮数字仅是双轨四片段合成缩放；不得引作整体视觉、功能或拖动对齐证据 |
| `docs/archive/W3_3_VERIFICATION_GATE_2026-10-21.md` | W3.3 Verification Gate 点时间记录 | A1–A14 逐项落点 + 独立复核；**A9 评分开放**，被后续运行取代时加横幅 |
| `docs/archive/W3_3_IMPLEMENTATION_SUMMARY_2026-10-21.md` | W3.3 S1a–S5a 切片实施摘要 | 浓缩自 S1a–S5a 实施记录；总验收复核见 `W3_3_VERIFICATION_GATE_2026-10-21.md` |
| `docs/archive/W3_1_SEMANTIC_SEARCH_IMPLEMENTATION_2026-10-19.md` | W3.1 语义检索 A1–A8 验收记录 | 含 C2 门限缺口注记；中文模型分发见 §4 P161 |
| `evidence/2026-10-21-w33-keyframe-blind-eval/RESULT.md` | A9 盲评结果（9 帧）点时间记录 | **不得**引作「质量已证」；样本 9 帧、±25pp、无对照、一次性 —— 边界见文件 §4 |
| `evidence/2026-10-21-w33-a13-packaged/EVIDENCE.md` | A13 打包产物取证点时间记录 | 只证 PyInstaller 产物（未打 NSIS、未跑 Electron e2e）；sidecar 重建不可复现，发布前 pin 需重签 |
| `docs/archive/AI_VALIDATION_REPORT_2026-09-20.md` | 2026-09-20 真实验证数据 | **性能门"未过"已于次日修复达标**；全仓最易被误引为现状的一份 |
| `docs/archive/EDITOR_UI_REFRESH_2026-11_SUMMARY.md` | 2026-11-10 UI 多轮实施与验收汇总 | — |
| `docs/archive/PERFORMANCE_A01_A08_SUMMARY.md` | 2026-09-08 至 09-09 性能第一轮 A01–A08 实施汇总 | — |
| `docs/archive/PERFORMANCE_B10_B17_SUMMARY.md` | 2026-09-09 至 09-10 性能 B10–B17 实施汇总；独立验收以集中复核报告为准 | — |
| `docs/archive/PIP_MASK_KEYING_IMPLEMENTATION_SUMMARY.md` | PIP/蒙版/抠像早期实现记录；原计划中的限制清单已被后续预览画布方案取代，现状只看 §2–§4 | — |
| `docs/archive/WAVE1_L3_AUTOMATION_EVIDENCE_2026-10-10.md` | 2026-10-10 Wave1 手测清单自动化执行证据 | 点时间证据（本轮运行 + P74–P77 现场）；状态口径引用本文件，被后续运行取代时加横幅 |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND4.md` | P200 第四轮仿真验证点时间记录 | **已被推翻**（第五轮）：仿真内置自适应扩容，把真机主因（驱逐）消灭在模型里；不得引作真机因果证据。现行结论见 `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND5.md` |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND5.md` | P200 第五轮否证分析（纯只读）点时间记录 | 基于已入库 `app-drop-p196-*.json` 复核；推翻第四轮因果、改判主因为暂存帧驱逐。**未证明**提高容量即可消除退化（下一轮） |
| `evidence/performance/p200-window-attribution-20261028/ATTRIBUTION_ROUND6.md` | P200 第六轮：立项判据复核（纯只读）点时间记录 | 推翻「时间线长度驱动」（对照组仅 40.6s、未覆盖 53.6s 冻结点）；现象为**近停摆**而非变慢。**未证明**触发状态量与修法 |
| `evidence/performance/p200-window-attribution-20261028/ROUND7_PREREGISTRATION.md` | P200 第七轮：重复运行测量（判据预注册） | 三次同配置 = 147/0/0 ⇒ 判据 C（不确定）；**未复现 P196 的持续停摆形态**。不得引作成因证据 |
| `docs/archive/CI_REMOTE_VERIFICATION_2026-11-05.md` | 2026-11-05 CI 远端验证补齐实施记录（run `41949321912` @ `0d939f7`） | 点时间记录；只证该 run 的逐项核对，**不声明当前 CI 状态**（引用 `docs/STATUS.md` §4 P190） |
| `evidence/2026-11-05-p203-recheck/P203_RECHECK_2026-11-05.md` | 2026-11-05 P203 复测（判定 C）点时间记录 | 只证该 HEAD 上「不挂死 + 走 FFmpeg + 代理未生效」；**根因未修**，代理 ready 后是否仍挂死**未测**；历史 `EVAL_BLOCKED` 读数不得引作堵死证据（见 §4 P215） |
| `docs/STATUS_ARCHIVE.md` | §4 已闭环/冻结承诺逐字历史归档 | 自本文件 §4 迁出的历史台账原文，仅用于追溯 |
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
6. **§4 活性表只留开放项**——一旦核销/关闭（✅/❌/⏭️），在同一次提交内将整行原文迁入 [`STATUS_ARCHIVE.md`](STATUS_ARCHIVE.md) 并按 `AGENTS.md` Rule 7 清理临时过程文档；§4 单元格保持简明摘要，长篇排查日志写入 `docs/archive/` 或 `evidence/` 并回链。
