# Vortex Cut 状态源（Single Source of Truth）

> **本文件是唯一声明"项目当前状态"的地方。**
> 其他文档**不得复述**当前阶段、迁移版本、能力边界或完成状态，只能**引用本文件**。
> 纪律条文见 `AGENTS.md`「文档同步纪律」。
>
> **机器校验**：`services/core/tests/unit/test_status_doc_consistency.py` 会解析
> §1 的字段块并与代码实际值比对——**字段漂移即测试红**。这是本文件不腐烂的保证：
> 改了迁移/白名单/算法版本却忘了改这里，CI 会拦住。
>
> 建立：2026-09-24（W0.1）。来源：2026-09-24 文档过期审计（17 份文档、约 80 条过期）。

---

## 1. 机器可校验字段

<!-- STATUS-FACTS-BEGIN -->
```json
{
  "protocol_version": 1,
  "latest_migration": 26,
  "patch_operations": 37,
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
| M3 里程碑（预览引擎） | 部分交付 | M3-0 预览引擎、M3-2 播放重构、M3-3 A1 音频混音已有文档与验收 |
| **AI 能力线** | **进行中（当前主投入）** | AI-1 多步 agent 会话、AI-2 本地 CV 信号层（Layer 0）已合入；总纲与 ADR-0004 已立 |

- **当前活跃分支**：`ai/stability-polish`（HEAD 持续前进，不在此处绑定具体提交号）
- **发布版本**：`0.0.1`（`package.json`）；下一版维护范围见历史发布文档

> **⚠️ 不要再用 "Stage 2C" 描述当前状态。** 该表述自 Stage 3B 起即已过期
> （`STAGE3B_DETAILED_DESIGN.md:47` 曾记录并搁置），是 2026-09-24 审计中最高危的过期项。

---

## 3. 能力边界（已交付，可对外）

> 这一节用于纠正历史文档中"Stage 3 尚未实现"类表述造成的**对外口径压制**
> （`BRAND_BASELINE.md` 曾据此禁止宣传已交付能力）。

**编辑核心**：多轨时间线、转场、关键帧、字幕（含样式/花字）、变速与倒放、蒙版/抠像、
PiP 自由定位、A1 音频混音、代理与权威预览、H.264/AAC 导出与多平台 Profile、封面设置。

**AI 能力线（本地优先）**：
- 本地 ASR 转录（faster-whisper，词级时间戳），模型按需下载、不随包分发；
- **AI 候选粗剪**（Stage 2A）：转录或 CV 场景段召回 → 外部 Provider 出三候选 → 采纳；
- **AI 修改提案**（Stage 2B）：自然语言 → TimelinePatch → 差异预览 → 显式应用；
- **AI 多步 agent 会话**（AI-1，迁移 v20）：有界循环（步数 ≤6 / token 预算 / 结构化失败反馈 /
  基线漂移中止），每步落不可变 Revision，Desktop 面板含每步 diff 浏览与费用聚合；
- **本地 CV 信号层**（AI-2 Layer 0，迁移 v21）：镜头边界 / 运动能量 / 清晰度 / 亮度 /
  音频能量 / YuNet 人脸；`skip_frame` 混合自适应采样（算法版本 2）；
- **AI 操作白名单**：22 种显式冻结 + "白名单 + schema + 字段清单"三处同步准入；
- Desktop 设置 UI（含代理三选）、CV 分析入口。

**隐私边界（ADR-0003 D4 硬承诺）**：云端永不默认、永不静默；egress preview 可逐张审计；
本地信号计算零 egress；默认（纯本地）体验自立。

> 能力**规划**（尚未交付的部分）见 `AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` §4 能力矩阵，
> **不在本文件重复**——本文件只声明"已交付"，规划声明属于总纲。

---

## 4. 未闭环承诺（**验收项 + 风险对策**）

> **为什么两类都要登记**：五门流程只追踪验收项，风险对策写完就无人再看。
> 2026-09-24 审计发现的 5 项欠账中，有 1 项正是"风险对策"型。
>
> **纪律**：规划门写下的**任何**承诺（验收项、风险对策、开放问题裁决）在此登记；
> 完成时核销并注明证据。**未在此登记的承诺视为不存在。**

| # | 承诺 | 出处 | 类型 | 状态 |
|---|---|---|---|---|
| P1 | sha256 对拍锁（非回退素材双路径逐字节一致） | `CV_SKIP_FRAME_PLANNING_GATE` §3.1 | 验收项 | ✅ **2026-09-24 核销**——`test_short_gop_fast_and_full_paths_are_byte_identical`（**含反向对照**，证明相等断言有区分力而非恒真） |
| P2 | 合成长 GOP fixture 的回退触发测试 | `CV_SKIP_FRAME_PLANNING_GATE` §3.2 | 验收项 | ✅ **2026-09-24 核销**——`test_long_gop_triggers_full_decode_fallback`（三段断言：触发条件成立 → 进入 `cv:video-full` 阶段 → 密度确实恢复） |
| P3 | 更新 AI-1 规划门"13 种"记载为准入纪律 + 显式清单 | `AI_WHITELIST_EXPANSION_PLANNING_GATE` §3.5 | 验收项 | ✅ **2026-09-24 核销**（W0.1 补做） |
| P4 | 真实 deepseek 两步会话（"剪短并加一个转场"） | `AI_WHITELIST_EXPANSION_PLANNING_GATE` §3.2 | 验收项 | ❓ **仓内无证据**，按"未取证"登记 |
| P5 | 本地 forward proxy 验证 provider 经代理可达 | `PROXY_SUPPORT_PLANNING_GATE` §3.2 | 验收项 | ❓ **未见明确取证** |
| P6 | `pyproject` 显式声明 numpy / onnxruntime 版本下限 | `AI_2_CV_SIGNALS_PLANNING_GATE` §4 风险表 | **风险对策** | ✅ **2026-10-01 核销**——`pyproject.toml` 已声明 `numpy>=2.0,<3` 与 `onnxruntime>=1.18,<2`，`uv.lock` 已同步；未改变迁移/协议字段 |
| P34 | **W4.1 工作单编排 MVP 规划门**：固定步骤链、逐步 Diff/Apply、取消/基线漂移/项目隔离 | `WORKLIST_ORCHESTRATION_PLANNING_GATE_2026-10-01.md` | 工作包 | ⏳ **规划门已建立，待 Design Gate 冻结契约与存储方案** |
| P7 | **4K60 长 GOP 密度策略** | `ADR-0005`（三杠杆：预算约束下的密度旋钮 + 诚实降级 + 硬件解码；**定点补洞经实测否决**） | 裁决项 | ✅ **2026-09-24 已裁决**，分三阶段实施（阶段 1 成本模型+诚实降级 / 阶段 2 密度旋钮 / 阶段 3 硬件解码） |
| P8 | **ADR-0005 阶段 1 实施**：CV 采样预算 + 诚实降级 | `CV_SAMPLING_BUDGET_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `CV_SAMPLING_BUDGET_IMPLEMENTATION_2026-09-24.md` §2 验收核对表各项落实；Core 全量 **913 passed + 2 skipped, 0 failed** |
| P9 | **W0.4 质量评测体系骨架** | `QUALITY_EVAL_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `QUALITY_EVAL_IMPLEMENTATION_2026-09-24.md` §2 验收核对表全项；Core 全量 **930 passed + 1 skipped, 0 failed** |
| P10 | 评测样本不足 → harness `insufficient` 诚实语义 + 分档缺口表（禁止假分） | 同上 §4 风险表 / §7 | **风险对策** | ✅ **2026-09-24 核销**——`test_insufficient_not_fake_score` + 首基线 `gaps`（五档缺口如实暴露） |
| P11 | 评测指标口径冻结（容差/k/公式入快照；禁止静默改口径救指标） | 同上 §2.3 / §7 | **风险对策** | ✅ **2026-09-24 核销**——快照 `params` 含容差/k/tolerance；公式写死于 `tools/quality_eval/metrics.py` |
| P12 | **W0.3 声画链接模型**：链接组 + 联动 trim/move/remove/position + 解除联动 | `CLIP_LINKAGE_PLANNING_GATE_2026-09-24` §1.1 / §3（ADR-0004 D1/D8） | 工作包 | ✅ **2026-09-24 核销**——实施记录 `CLIP_LINKAGE_IMPLEMENTATION_2026-09-24.md` §2；`test_clip_linkage.py` 10 项；旧文档零行为用例通过 |
| P13 | **W1.1 剪辑语法层骨架**：editing_grammar + 参考规划器 + 三段式零 egress 采纳链 | `EDITING_GRAMMAR_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `EDITING_GRAMMAR_IMPLEMENTATION_2026-09-24.md` §2；`test_editing_grammar.py` 6 项 + 迁移 v24 |
| P14 | **W1.5 跳切/去停顿**：静音检测 + remove_pauses 规划器 | `REMOVE_PAUSES_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `REMOVE_PAUSES_IMPLEMENTATION_2026-09-24.md` §2；`test_remove_pauses.py` 9 项；迁移 v25（拟议文档落盘） |
| P15 | **W1.2 节拍网格**：纯 numpy 检测 + beat_grids 存储 | `BEAT_GRID_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `BEAT_GRID_IMPLEMENTATION_2026-09-24.md` §2；`test_beat_grid.py` 8 项；迁移 v26 |
| P16 | **W1.3 卡点规划器** beat_sync：切点吸附 beat + 强拍重镜头 | `BEAT_SYNC_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `BEAT_SYNC_IMPLEMENTATION_2026-09-24.md` §2；`test_beat_sync.py` 6 项 |
| P17 | **W1.4 L/J cut**：`split_edit` + lj_cut 规划器（DEC-7 准入） | `SPLIT_EDIT_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-24 核销**——实施记录 `SPLIT_EDIT_IMPLEMENTATION_2026-09-24.md` §2；`test_split_edit.py` 9 项；三处同步绿 |
| P18 | **ADR-0005 阶段 2 密度旋钮**：`select_sampling_plan` + `budget_capped_full` 合并 + 旋钮暴露 + `algorithm_version` 2→3 | `CV_DENSITY_KNOB_PLANNING_GATE_2026-09-24` §1.1 / §3 | 工作包 | ✅ **2026-09-25 核销**——实施记录 `CV_DENSITY_KNOB_IMPLEMENTATION_2026-09-24.md` §2 验收核对表全项；Core 全量 **811 unit + 150 integration passed** |
| P19 | **W0.4 补素材 + Wave 1 真实验收**：五档缺口清零 + 去停顿/节拍/卡点/L-J e2e | `W0_4_MATERIALS_WAVE1_E2E_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——缺口表 shortfall 全 0；`test_wave1_real_media.py` 10 项 |
| P20 | **Desktop 接剪辑语法层**：提案列表 / 干跑 / Diff / 采纳 UI | `DESKTOP_EDITING_GRAMMAR_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——Desktop 707 tests + typecheck 绿；工具菜单「剪辑语法」 |
| P21 | **W0.4 评测预测接入**：CV/节拍真实输出写 predictions，beat_hit_rate 可测 | `W0_4_PREDICTIONS_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——基线 `20260925T040102Z`：cut_pr 出数、music beat≈0.91 |
| P22 | **Desktop 密度旋钮呈现**：CV 分析选项 + 密度状态可见 | `DESKTOP_DENSITY_KNOB_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——Desktop 708 tests；摘要含 full/sparse |
| P23 | **lj_offset_accuracy 出数**：auto_lj_mode + 预测/指标接通 | `W0_4_LJ_OFFSET_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——spoken 档 acc=1.0（规则一致性，非审美分） |
| P24 | **recall_ndcg 真实预测**：窗口能量排序 + spoken 档出数 | `W0_4_RECALL_NDCG_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——W0.4 四项可测指标全部出数 |
| P25 | **L/J 词戳 ASR 优先**：faster-whisper 路径 + 能量回退 + word_source | `W0_4_ASR_WORDS_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——产品 Whisper Tiny 自动发现；当前预测 `word_source=asr` |
| P26 | **Desktop Wave 1 剪辑手法 UI**：三页壳 + 属性/素材入口 | `DESKTOP_WAVE1_EDITING_TOOLS_2026-09-25.md` §2 | 工作包 | ✅ **2026-09-25 核销**——设计稿确认后落地；Desktop 708 tests |
| P27 | **MediaDecoder 双后端 + HEVC 合成预览**：能力表 + WebCodecs/FFmpeg 旁路 + 帧回传 F1 + 后端 B Core 端点契约 | `MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md` §1 / §3 / §4（含 §7 评审修订） | 工作包 | ⏳ **H1–H3 核心 + session 接线已落地**（四份 `MEDIA_DECODER_HEVC_H*_IMPLEMENTATION/…CLOSEOUT_2026-09-26.md`）；**真机 HEVC e2e 与 p95 门限定档待收口（P29）**；执行序 H1→H5 |
| P28 | 能力表探测 + 实配失败回写降级（防每素材反复试错）；软解为合法 A 路径 | `MEDIA_DECODER_HEVC_PLANNING_GATE_2026-09-26.md` §5 风险表 | **风险对策** | ⏳ 未落地 |
| P29 | F1 帧回传带宽/延迟达门限；A/B 同素材同帧号取帧一致（VFR 对拍） | 同上 §5 风险表 | **风险对策** | ⏳ A/B PTS 对拍已过（`test_a_b_same_frame_number_same_pts`）；p95 小夹具初值 2s 过门，**真机 1080p/HEVC 门限定档待收口** |
| P30 | 后端 B Core 端点复用票据鉴权 + 路径不下发渲染进程 + 窗口上限；能力表按 FFmpeg build 指纹失效重探 | 同上 §5 风险表 | **风险对策** | ⏳ 未落地 |
| P31 | 手写 demux 扩 hev1 仅覆盖主流 MP4，异常容器强制 B 后端；色彩钉死 BT.709 | 同上 §5 风险表 | **风险对策** | ⏳ 未落地 |
| P32 | 代理与能力表解耦：代理只加速，能力表不读代理状态（H5 收口） | 同上 §5 风险表 | **风险对策** | ⏳ 未落地 |
| P33 | **预览播放流畅度收敛**：残余丢帧 ≤0.5% 全片帧数（3 轮稳定）+ decode p95 ≤20ms / p50 ≤12ms + compose interval p95 ≤40ms + 看门狗/降级保持 0；测量载体 m3p5 探针 + 分段计时插桩（VITE_AIVS_DECODE_TIMING=1）+ CDP trace + **App 内量化（W4 起：`__aivsPreviewMetrics` / `e2e/p33-user-drop.electron.spec.ts`）**；硬约束：在途未关闭 VideoFrame 总量不超背压阈值 ~13 帧、解码与上传不真解耦（除非带在途帧预算证据） | `PREVIEW_SMOOTHNESS_PLANNING_GATE_2026-09-28.md` §2 / §3 / §5 | 工作包 | ⏳ **实现 + 探针 3 轮 + App 内 3 轮 × 2 素材达成**（skip2-r1..r3 探针：丢帧 0/1800、decode p95 1.6-2.2ms、compose p95 33.6ms；**2026-09-30 W4 根修 —— 无 B 帧直线流的「解码器输出管线深度 vs 持有窗容量」错配**：探针 dropped 242→1、冷启 154→4；**App 内 3440x1440 丢帧 452→0/1241 × 3 轮**、decode p95 83.1→6.4-7.2ms；**App 内 HEVC 720p 丢帧 211→0/1777 × 3 轮**；**W5 根修 —— 未 close 持有帧全局预算**（解码器表面池被持有帧占满后静默停摆：`dq` 单调攀升、目标永不吐）；**W6 根修 —— 「越修越卡」**（单帧停摆兜底的 `watchdog` 文案误触降级闸门 → 整条输入被永久钉在 FFmpeg IPC 软解 ~180ms/帧 → 丢帧 95；已排除该类误触 + 降级可回退 + 单请求喂包总预算 6s + 首尾帧越界钳制 + **解码后端上界面可见**）；**W7 —— 持有帧预算按编解码分档**（HEVC 8 / 其余 12；单一水位会导致 H.264 起播丢帧或 HEVC 整段停摆）；**最终 App 内复测：两素材各 3 轮全 0 丢帧、后端全程 webcodecs、`last_error` 全 null**；跳转风暴 `e2e/p33-seek-play` 多数轮次六档全部推进但**未稳定**，以 `test.fixme` 挂起）；**W9/W10 —— dev 卡顿归因并收口**（React 提交风暴：dev 丢帧 112/135 → 3、longtask 295 → 1~2、rAF p95 51.8 → 14ms）；**W11 根修（2026-09-30 用户第三次复测）—— 「背压收缩」变成单向棘轮**：`backpressureSeen` 一旦置位就永不上调持有帧预算，对「解码器输出管线深度 11」的 3440x1440 H.264 素材 ⇒ 窗被压在 5~7 ⇒ 顺序请求连环 miss ⇒ 每帧冷启整 GOP ⇒ 整段幻灯片（用户实测 `解码 p50 30.7 / p95 194.6ms · 出帧 p95 204.3 · 上传 p95 11.9 · 丢帧 35`），重启才复位；改为**可恢复**（收缩仍即时激进，回升要求「安静 ≥1.5s + 连续健康交付」，并对**被驱逐导致的 miss**——目标帧曾吐出、损失全由自身驱逐造成——立即抬水位，按 codec 档位封顶）⇒ 真机 dev 强制降级起点（预算 6/窗 5）自愈：冷启 176 → **0**、解码 p50 53~107ms → **1.8~2.6ms**、出帧 p95 173 → **4.6~17ms**、时间码 10× 慢 → 实时；App 内（用户同画布 1132×637）H.264 3 轮 **2/0/3 ÷1241**、HEVC 3 轮 **3/4/0 ÷1777**（全 ≤0.24%），`p33-eof-replay` 通过，全量 **753 tests + typecheck** 绿；`residency` 快照新增 `budget/cap/windowCap/feedAheadPeak/shrinks`（状态性卡顿当场可判）；**W12 根修（2026-09-30 用户第四次复测：换 1080p50 素材又成幻灯片）—— 「源帧率 ≠ 画布帧率」素材的陈旧帧驱逐 + 重发容忍**：客户端只请求约 3/5 的源帧（30fps 画布 ↔ 50fps 源），其余帧解码后永不被请求却占满持有窗，旧策略只丢「展示序最新」⇒ 丢掉的恰是下一步要的帧 ⇒ 每个请求 miss ⇒ 冷启整 GOP（实测 `cold_start` 2251、解码器吐出 73837 帧而只交付 3459 = 21×、丢帧 1.19%、解码 p50 64ms）；叠加客户端**同帧重发**（22 个冷启目标里 19 个）而交付帧 LRU 被预算清空。改为：驱逐阈值取**最旧未服务请求**（不是「已请求最大 rank」——泵会提前预读 ~13 源帧，按前沿判会丢掉正在等待的帧）＋**近邻替代**（目标刚吐出/刚被越过且手里有 ≤3 个展示序位内的帧时直接交付，不再整 GOP 重解；远距 miss 与真回退 seek 仍走冷启）⇒ 解码 p50 64→**2.4ms**、丢帧 1.19%→**0.50~0.54%**、`cold_start` 2251→**0**、`backpressure_shrink` 950→1；三条「抬高持有量」的尝试（LRU 保留额度 / 按峰值前摄喂包 / 扩容每次重试）全部因撞表面池恶化，已回退并记录。回归：3440x1440 3/1241、HEVC 0/1777、`p33-eof-replay` 通过；全量 **755 tests + typecheck** 绿（新增 50fps×30fps 驱逐策略回归 2 例）；实施记录 §2 W4–W12 + §4 L6–L13（L12 = 客户端重发来源未定位、L13 = 50fps 稳态延迟残留））；⏳ 剩：插桩零开销对跑（L1）+ **用户复测确认**；⚠️ 已记录未修：overlay-only 时间线 IR total_frames=0 静默（实施记录 §2 W2.6 末条）+ **跳转风暴下的解码器表面池停摆（§4 L8，顺播不受影响）** |

---

## 5. 已知未完成工作（**不是过期，是真实待办**）

| 项 | 说明 | 出处 |
|---|---|---|
| **4K60 长 GOP 性能** | ✅ **已解决（2026-09-24，ADR-0005 阶段 1）**：预算准入使付不起的回退**根本不启动**——4K60 HEVC 长 GOP 由 **40.5 → 5.4 s/分**（样本回落为 12 个 I 帧，`density_status='sparse'` 如实标记）。常态 GOP 1s 保持 `full`。见 `CV_SAMPLING_BUDGET_IMPLEMENTATION_2026-09-24.md` | 同上 §4.2 + 实施记录 §3 |
| CV 采样密度参数暴露 | ✅ **已落地（2026-09-25，ADR-0005 阶段 2 + Desktop）**：契约旋钮 + 分析选项 UI + 摘要密度标记 | `CV_DENSITY_KNOB_IMPLEMENTATION_2026-09-24.md` / `DESKTOP_DENSITY_KNOB_2026-09-25.md` |
| 4K60 常态约 1.0s 未归因差异 | 同素材同路径三次复跑一致（7.3/7.8/7.5 vs 原 5.4），已归因约 19% 为机器变慢、**剩余约 1.0s 未归因**。仍远低于 10 门限 | 实施记录 §4 L1 |
| **HEVC/B 帧预览播放卡顿** | ✅ **已解决（2026-09-28）**：三层修复——① Core `decode_nv12_frames` 加 `-frames:v`（select 不停输入，旧实现把窗口后全部帧解完：真机素材实测 2033ms/30 帧窗 → 320ms）；② decode-worker GOP 锚改 `lastTargetKey` + 暂存容量按重排深度自适应 + 输出匹配容差整帧→半帧 + 回跳冷启救援（防看门狗挂起）；③ 降级门控连续 2 次超时才落 FFmpeg（防单次抖动钉死慢路径）。仿真回归 `tests/decode-reorder-playback.test.ts`（真实采样表 6 项）。真机复测待用户侧确认 | 本会话定位记录（B 帧素材 fdf0f0e2：回跳深度 6 / GOP 88） |
| 细粒度进度仍缺失 | `analyze_video` 的死参数已删除，但未实现替代；长分析无中途进度 | 实施记录 §4 L2 |
| json_schema 适配器被网关拒 | provider 兼容面窄于设计，script 类适配器为唯一通路 | `AI_VALIDATION_REPORT_2026-09-20.md` §实验 B |
| Provider 域独立工作单 | 代理与探测总预算**均已交付**；本条保留用于跟踪 provider 域后续 | — |
| Wave1 剪辑手法收尾 | L1/L2 自动注入（词戳/beat）与 L3 真机手测签字未闭环 | `DESKTOP_WAVE1_EDITING_TOOLS_2026-09-25.md` §4 |

---

## 6. 历史状态文档索引（点时间记录，**引为现状前必须先读本文件**）

> **登记规则**：本表只收**点时间记录**（某一时刻的快照/验证数据/交接）。
> **活文档不得登记在此**——活文档过期应当**修正**，而不是豁免。
> 把文档登记在此即自动豁免机器校验的过期表述黑名单（见 `test_status_doc_consistency.py`），
> 因此**误登记等于放行漂移**。

| 文档 | 性质 | 注意 |
|---|---|---|
| `docs/PROJECT_RELEASE_STATUS.md` | Stage 7/8 发布时点记录 | **已过期**（v17 / 旧分支）；现仅作发布历史 |
| `docs/PROJECT_STATUS_AND_NEXT_STAGE.md` | 2026-08-20 阶段总结快照 | **整篇结论已被推翻**；其中"从 stash 恢复"指引**已失效**（stash 不存在） |
| `docs/AI_VALIDATION_REPORT_2026-09-20.md` | 2026-09-20 真实验证数据 | **性能门"未过"已于次日修复达标**；全仓最易被误引为现状的一份 |
| `docs/PHASE2_HANDOFF.md` | 2026-09-06 预览线交接快照 | "下一步"条目已部分完成 |

**不在此表的活文档**（过期即修正，不得豁免）：`README.md`、`ARCHITECTURE.md`、
`docs/BRAND_BASELINE.md`、`docs/M2_ROADMAP.md`、`docs/VORTEX_CUT_USER_MANUAL.md`、
`docs/AI_CAPABILITY_MASTER_PLAN_2026-09-24.md` 及各规划门/实施记录。

---

## 7. 维护本文件的规则

1. **改代码改了 §1 的字段 → 立刻改 §1 的块**。忘了也没关系，测试会红。
2. **规划门新增任何承诺 → 在 §4 加一行**。完成时把状态改为 ✅ 并注明证据与日期。
3. **交付了新能力 → 在 §3 加一条**；规划中的能力**不加**（属于总纲）。
4. **发现某个历史文档被取代 → 在 §6 加一行**，并给该文档加"已被 X 取代"横幅。
5. **其他文档不要复述状态**——复述即漂移的起点。
