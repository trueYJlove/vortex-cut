# WP-P231 预览画布模型重构（黑色公共背景 + 全轨道自由排版）· Planning Gate

> 角色：LiuWei（架构师）｜日期：2026-11-17
> 状态口径一律引用 docs/STATUS.md（Rule 1/5）；本文件只声明**本门冻结什么**。
> 来源：P230-④（用户 2026-11-17 指认「预览区画布模型」对齐 OpenFilm：黑色公共背景 + 全部素材自由排版）。
> 本门裁的是：IR 投影/权威渲染/预览合成器三处数据模型的统一盒模型、转场/关键帧契约的随迁范围、UI 门控的放开边界。
> 本门不裁：转场扩展到多轨（已裁决不扩展，见 §5 Q5）。
> **裁决状态**：Q1–Q5 已于 2026-11-17 由用户全部采纳推荐并冻结（§5）。

---

## 0. 现状走读结论（代码级，2026-11-17 勘察，含 file:line）

| # | 事实 | 位置 |
|---|---|---|
| 0.1 | **IR 投影按 track_id == "V1" 二分**：visual（main 链）只收 V1 段，overlays（浮层）收非 V1 段——V1 片段被当"底板"，非 V1 片段才有盒子 | services/core/src/aivs_core/rendering/ir.py:396-404 |
| 0.2 | **权威渲染同构二分**：visual_items 只收 V1（:177-185），overlay_segments 收非 V1（:623-633）走 _pip_overlay_chain；V1 段的静态 transform 在 visual_chain 内联（:326-377） | services/core/src/aivs_core/rendering/ffmpeg.py |
| 0.3 | **IR 白名单三处 V1 特权**：mask/keying 仅非 V1 放行（V1 拒绝，ir.py:112-115）；关键帧仅 V1（:132-133）；转场仅 V1（:140-141） | ir.py:106-141 |
| 0.4 | **转场锚定 V1 邻接**：_transition_successor 在 V1 时间序取后继（timeline.py:3207-3222）；_transition_neighbors 拒绝非 V1 锚点（:2063-2064）；转场 GC 同口径（:2384、:2818-2832） | services/core/src/aivs_core/timeline.py |
| 0.5 | **Desktop 预览合成器已是盒模型**：compositor.ts / compositor-worker.worker.ts / compositor-webgpu.worker.ts 消费 IR main/overlays 条目，无 track_id 语义（main = IrMainSegment 或 IrMainTransition 或 black，overlays = IrOverlay[]） | apps/desktop/src/app/preview/ir.ts:29-97 |
| 0.6 | **PIP 手势层已是盒模型**：PreviewPipOverlays.tsx（fit_w/fit_h 内容盒 + move/scale/rotate/mask）与 SyntheticPipLayer.tsx（IR overlay box 画布像素）均不区分轨道 | apps/desktop/src/app/PreviewPipOverlays.tsx:20-31、SyntheticPipLayer.tsx:14-38 |
| 0.7 | **App.tsx 六处 V1 门控**：v1Clips（:1196）、clipAtPlayhead 仅 V1（:1211）、syntheticPipClips 排除 V1/A1（:1552）、overlayPips 跳过 V1/A1（:1735）、overlayClipSelected（:1773）、assetOriginalRatio 取 V1 首片段（:2484）、copy/cut 仅 V1（:2654/:2671）、changePreviewRatio 仅改 V1 layout（:2511） | apps/desktop/src/app/App.tsx |
| 0.8 | **PropertyPanels 门控**：overlay = track_id !== "V1" && !== "A1"（:122）控制 mask/keying 警告文案与动画提示 | apps/desktop/src/app/PropertyPanels.tsx |
| 0.9 | **geometry.ts 转场几何仅 V1**：computeTransitionRects 过滤 V1（:211）、hitTestTransitionGap 同口径（:272）；MAIN_TRACK_H 仅 V1 行高（:121） | apps/desktop/src/app/timeline/geometry.ts |
| 0.10 | **contracts 校验器与文档模型不一致**：isTimelineClip 限定 track_id ∈ ["V1","A1"]（packages/contracts/src/index.ts:1952），图片片段额外限定 track_id === "V1"（:1979）；而 isTimelineDocument 允许动态 V2/T1 轨（:2088-2115） | packages/contracts/src/index.ts |
| 0.11 | **IR 版本**：IR_PROJECTOR_VERSION = 5（ir.py:36）；磁盘缓存按 projector_version 失效（ir_disk_cache.py:87）；IR_SCHEMA = "preview-ir-v1"（ir.py:24），桌面端 parseIr 接受该 schema（apps/desktop/src/app/preview/ir.ts:138） | — |
| 0.12 | **input_window 放行集**：V1 段 transform 保守不放行（input_window.py:113-119），覆盖轨 PiP 段放行（:130） | services/core/src/aivs_core/rendering/input_window.py |
| 0.13 | **service._rendered_duration_us 仅 V1**（service.py:1399-1411）：V1 空时取全部段最大终点，V1 非空时只算 V1 链长 | services/core/src/aivs_core/rendering/service.py |
| 0.14 | **timeline.py 其余 V1 特权**：_asset_clip 视频/图片默认落 V1（:2106/:2155）；set_image_duration 仅 V1 涟漪（:1629）；转场后继/GC 全 V1 口径（:2384/:2818-2832） | timeline.py |
| 0.15 | **测试面**：Python 侧 V1 夹具集中在 test_timeline.py（12 处）、test_render_ir.py（2 处）、test_render_ass_ffmpeg_stage1c.py（6 处 V1 + 5 处 V2 夹具）、test_render_input_window.py / test_render_ir_window.py / test_render_plan_stage1c.py / test_main_track_transform.py / test_audio_fade.py / test_as_audio_render_gate.py / test_ai_whitelist_consistency.py 各 1-4 处；Desktop 侧 19 个测试文件含 track_id: "V1" 夹具（含 contracts.test.ts 的 isTimelineDocument 负向断言） | 见勘察记录 |

---

## 1. 冻结设计（核心裁决）

### 1.1 统一盒模型（本门核心）

**裁决**：IR 投影不再按 track_id == "V1" 二分。改为：

- **visual（帧装配层）= 全部非音频、非隐藏轨的段**（含 V1、V2、T1……），按 timeline_start_us 排序；
- **overlays（浮层层）= 保留为空集或删除该层**——所有段统一走"盒"路径（transform × 内容盒 × 布局），V1 段降级为普通盒子；
- **黑底 = 公共背景**：画布背景恒黑（canvas.background 既有字段），空档渲染黑填充段（既有 kind: "black" 语义不变）；
- **z 序 = 轨道序**：tracks 数组顺序（自上而下）即绘制顺序——**上层轨道盖下层**（剪映/OpenFilm 同语义）；同轨段按时间排序。

**IR 帧条目形状（v6）**：
    IrFrame {
      n, t_us,
      main: { kind: "black" } | { kind: "segment", ... } | { kind: "transition", ... },  // 保持形状，语义放宽为"时间序首段/链"
      layers: Array<IrLayer>,      // 新增：全部非首段的可见段，按轨道序（上→下）排列，逐条带 box/transform/effects
      captions: string[],
    }
> **兼容策略**：main 保留（过渡期 = 时间序第一个视觉段或 black），layers 为新增数组；旧客户端忽略 layers 仍能渲染 main 链。**最终态**（后续门）：main 并入 layers，overlays 字段删除。本门**先落 layers + 保留 main/overlays 兼容字段**，避免一次性破坏 IR 消费者。

### 1.2 转场契约随迁（V1 邻接 → 同轨邻接）

- 转场锚定从「V1 时间序邻接」改为「**同一轨道内**时间序邻接」（_transition_successor 按 track_id 分组排序取后继）；
- 转场仍仅限相邻（首尾相接）；跨轨道/跨段间隙仍休眠；
- IR 白名单 ALLOWED_TRANSITIONS 不变（fade/fadeblack）；
- ffmpeg _pip_overlay_chain 的 xfade 分支仅对**同轨相邻段**生效（与 IR transition_windows 口径一致）。

### 1.3 关键帧契约随迁（V1-only → 全视觉轨）

- IR 白名单移除「非 V1 轨关键帧」拒绝（ir.py:132-133）：**全部视觉段**允许 position/scale/rotate/opacity 关键帧；
- 关键帧渲染路径已存在（_keyframe_animation_filters，ffmpeg.py:71-142），只需把调用从 V1 段扩到所有段；
- mask/keying 同理放开（ir.py:112-115 的 V1 拒绝移除）：全视觉段可挂 mask/keying（合成器 shader 已逐像素支持）。

### 1.4 权威渲染同步（ffmpeg.py）

- visual_items 与 overlay_segments 合并为单一 visual_items（全部非音频非隐藏段，按时间排序）；
- _pip_overlay_chain 语义并入 visual_chain：每段统一「源 trim → 布局滤镜 → 内容盒 × transform →（可选 mask/keying alpha）→ 叠加到黑底」；
- MAINPIP 链式叠加改为**按轨道序逐层 overlay**（上层盖下层）；
- 空档黑填充、转场借用（xfade/acrossfade）、A1 混音、变速/倒放预算护栏**全部保持不变**。

### 1.5 UI 门控放开（Desktop）

- App.tsx：v1Clips/clipAtPlayhead/assetOriginalRatio/changePreviewRatio/copy/cut 的 V1-only 过滤改为「全部视觉轨」口径（或按产品语义保留部分，见 §5 待裁决）；
- syntheticPipClips/overlayPips 的 !== "V1" 过滤移除（所有视觉轨片段均可上 PIP 手势层）；
- PropertyPanels.tsx：overlay 门控改为恒 false（或删除），mask/keying/动画警告文案随之更新；
- geometry.ts：computeTransitionRects/hitTestTransitionGap 改为按轨分组（每轨独立邻接判定）；MAIN_TRACK_H 行高特权保留（V1 行仍是主视觉行，产品语义）。

### 1.6 contracts 校验器修正

- isTimelineClip 的 track_id 限定改为「存在于 tracks 数组中且 kind 与 asset_kind 兼容」（视频/图片 → video 轨；音频 → audio 轨）；
- 图片片段的 track_id === "V1" 限定移除（图片可落任意 video 轨）；
- PROTOCOL_VERSION **不变**（纯校验放宽，向后兼容）。

### 1.7 IR 版本升级

- IR_PROJECTOR_VERSION **5 → 6**（投影语义变更，磁盘缓存自动失效）；
- IR_SCHEMA 保持 "preview-ir-v1"（形状向后兼容，layers 为新增可选字段）；
- known_approximations 更新：删除「PiP overlay 忽略 transform.opacity」（统一盒模型后 opacity 全段生效）。

---

## 2. 实施切片（供 Design Gate 细化）

| 切片 | 内容 | 边界 |
|---|---|---|
| **S1（Core IR）** | ir.py：visual/overlays 二分改全段 layers；白名单三处 V1 特权移除；IR_PROJECTOR_VERSION = 6；ir_window.py manifest/window 同步 | services/core/src/aivs_core/rendering/ir.py、ir_window.py、ir_disk_cache.py（版本比对自动） |
| **S2（Core 权威）** | ffmpeg.py：visual_items 合并 + _pip_overlay_chain 并入 visual_chain + 轨道序 overlay 链；input_window.py transform 放行（全段）；service.py _rendered_duration_us 改全段口径 | ffmpeg.py、input_window.py、service.py |
| **S3（Core 时间线）** | timeline.py：_transition_successor/_transition_neighbors/_gc_unreachable_transitions 改同轨邻接；set_image_duration 涟漪改全轨；_asset_clip 默认轨语义（保留 V1 默认，允许 track_id 指定） | timeline.py |
| **S4（contracts）** | isTimelineClip track_id 放宽 + 图片轨限定移除 | packages/contracts/src/index.ts |
| **S5（Desktop 预览）** | ir.ts 类型加 layers；compositor/preview-session 消费 layers（绘制顺序 = 轨道序）；SyntheticPreview.tsx/SyntheticPipLayer.tsx 手势层接 layers | apps/desktop/src/app/preview/ |
| **S6（Desktop UI）** | App.tsx 六处 V1 门控放开；PropertyPanels.tsx overlay 门控；geometry.ts 转场按轨分组 | App.tsx、PropertyPanels.tsx、geometry.ts |
| **S7（测试）** | Python：test_render_ir/test_render_ass/test_timeline/test_render_input_window 等 V1 夹具随迁；Desktop：19 个测试文件夹具 + contracts.test.ts 负向断言更新 | 两侧 tests |

---

## 3. 验收（可断言，逐项给证据）

> 每项须配**负向对照**（还原实现即红）。

| # | 验收项 | 判据 | 证据形式 |
|---|---|---|---|
| **A1** | 全轨盒模型 | V2 轨片段（带 transform/mask/keying）在 IR layers 中出现且带 box/effects；V1 段同样走盒路径（main 或 layers 均可，但**渲染结果一致**） | pytest（test_render_ir） |
| **A2** | 权威/预览一致 | 同一时间线：ffmpeg 渲染帧与 IR 合成帧的段盒子几何逐像素一致（抽样 N 帧比对） | pytest + 真实 ffmpeg 对拍 |
| **A3** | 转场同轨邻接 | V2 轨内相邻段可加转场；跨轨段不可加；V1 轨转场行为不变 | pytest（test_timeline） |
| **A4** | 关键帧全轨 | V2 段关键帧生效（IR 与 ffmpeg 双侧）；V1 段关键帧行为不变 | pytest |
| **A5** | mask/keying 全轨 | V1 段 mask/keying 不再被白名单拒绝且渲染生效 | pytest（负向对照：恢复拒绝即红） |
| **A6** | 黑底公共背景 | 空档/空时间线渲染黑；z 序 = 轨道序（上层盖下层） | pytest + 真机截图 |
| **A7** | UI 手势全轨 | V2 段在预览画布上可 move/scale/rotate/mask（与 V1 段同手势） | Desktop vitest + 真机 |
| **A8** | contracts 放宽 | isTimelineClip 接受任意 video 轨上的图片/视频片段；音频仍限 A1 | contracts.test.ts |
| **A9** | IR 缓存失效 | IR_PROJECTOR_VERSION = 6，旧缓存条目自动不采信 | pytest（ir_disk_cache） |
| **A10** | 回归锁 | 全量 Python + Desktop 测试通过；P232 缩略图、P230 时间线 UI 不回归 | pnpm test:python + npx vitest run |
| **A11（2026-11-22 增补）** | 隐藏视觉轨预览 | 隐藏层不进入 IR 帧 layers；仍保留时间线尾长；隐藏片段上的倒放等不可见效果不触发整条预览回退 | Core IR 单测 + Electron E2E |

---

## 4. 风险与对策（逐条登记 STATUS §4）

| # | 风险 | 对策 |
|---|---|---|
| **R1** | **IR 形状变更破坏消费者**（compositor/preview-session/手势层均消费 main/overlays） | §1.1 兼容策略：layers 新增、main/overlays 保留过渡期；S5 先让 compositor 同时消费两层，验证后再删 |
| **R2** | **权威/预览几何漂移**（盒模型统一后 ffmpeg overlay 坐标与 IR box 可能不一致） | A2 对拍测试钉死；_pip_box/_pip_overlay_chain/segment_frame 三处坐标计算抽出同一函数 |
| **R3** | **转场语义回归**（V1 邻接 → 同轨邻接后，既有 V1 转场文档可能失效） | S3 保留 V1 轨邻接判定（V1 轨 = 同轨特例）；旧文档转场不迁移（GC 自然清理失效锚点） |
| **R4** | **z 序歧义**（轨道序 vs 时间序重叠段的覆盖关系） | §1.1 冻结「轨道序优先、同轨时间序」；A6 截图证据 |
| **R5** | **测试面爆炸**（19+ Desktop 测试文件、12+ Python 测试文件含 V1 夹具） | S7 分批随迁；夹具改动最小化（多数仅改 track_id 字符串） |
| **R6** | **性能回归**（全段 layers 逐帧条目数增加，IR 体积/合成开销上升） | MAX_IR_FRAMES 护栏不变；layers 条目数 ≤ 轨道数 × 活跃段数（实际项目 ≤ 10）；压测（P230 复用） |

---

## 5. 裁决记录（2026-11-17 用户采纳全部推荐，已冻结）

| # | 问题 | 裁决（冻结） | 影响 |
|---|---|---|---|
| **Q1** | assetOriginalRatio（"适应"比例）取哪个轨的首片段？ | **取最上层视觉轨的首片段**（OpenFilm 语义：画布比例跟随主视觉内容） | "适应"模式下画布比例 |
| **Q2** | copy/cut/paste 的片段快照是否扩展到全视觉轨？ | **扩展到全视觉轨**（用户在任意轨复制/粘贴）；paste 位置按目标轨序号 | 剪贴板语义 |
| **Q3** | changePreviewRatio 切换比例时，是否把**所有**视觉轨的 blurred_background layout 改为 crop_fill？ | **是**（全轨一致，剪映语义） | 批量 layout patch |
| **Q4** | MAIN_TRACK_H（V1 行高特权）是否保留？ | **保留**（V1 仍是"主视觉行"的产品概念，仅渲染语义降级为普通盒子） | 时间线 UI 行高 |
| **Q5** | 转场是否扩展到多轨（不同轨道相邻段间）？ | **不扩展**（本门仅同轨邻接）；跨轨转场留待后续门 | 转场契约范围 |

---

## 6. 门禁状态与关门路径

- **Planning Gate（本门）**：起草完成 → 独立评审（LiuKeAi）→ 用户批准 → Design Gate 细化切片 schema/DDL/端点 → Implementation → Verification Gate（对照 §3 逐项核验 + STATUS §4 登记/核销）。
- **关门条件**：§3 A1–A11 全部有证据 + 负向对照已证伪 + pnpm test:python 与 npx vitest run 全绿 + 真机截图（黑底 + 全轨盒子 + z 序）。
- **Rule 3 登记**：本门作为**一行工作包**登记 STATUS §4（P231）；风险对策 R1–R6 **逐条独立登记**。
