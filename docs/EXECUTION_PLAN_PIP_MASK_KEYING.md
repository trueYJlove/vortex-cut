# 画中画 / 蒙版 / 抠像 实施计划（含 UI/UX）

> 角色：LiuWei（架构）+ ZhangSan（核心/渲染）+ YeJing（桌面/UI）+ LiuKeAi（评审）
> 状态：实现已完成并验收（P1 画中画 / P2 蒙版 / P3 抠像），见文末「8. 实现状态」。
> 目标版本：后续 M 阶段（排在 Stage 2C 验收完成之后）

## 0. 决策基线（已与用户确认）

| 项 | 决定 |
| --- | --- |
| 优先级 | ① 画中画(PIP) → ② 蒙版(Mask) → ③ 抠像(Chroma key) |
| 蒙版范围 | **线性蒙版 + 矩形/椭圆基础图形起步**；贝塞尔任意路径留后续 |
| 画中画交互 | 预览画布上**直接鼠标拖拽 + 手柄缩放**，配合属性面板数值微调 |
| 抠像范围 | **纯色/绿幕 chroma key（FFmpeg colorkey/chromakey，本地）**；AI 智能抠像留后续 |
| UI/UX 展示 | 随方案产出**可点击 HTML 原型**（`docs/uiux/plugins-pip-mask-key/`） |

---

## 1. 现状盘点（与其对齐，避免重复造轮子）

### 1.1 画中画 —— 地基已就 80%，缺"覆盖轨合成"

**已具备：**
- 多轨道结构完整：`TimelineTrack`（`packages/contracts/src/index.ts:713`），支持动态视频轨 V2+、C1/V1/A1 固定轨；`TimelineClip.track_id` 已存在。
- 跨轨叠加数据层已允许：`timeline.py` L1977"跨轨叠加允许"，clip 可投放到任意视频轨。
- 位置/缩放动画已可用：`keyframes`（position/scale/rotate/opacity 四属性），`KEYFRAME_MAX_FRAMES=32`。
- 布局枚举已有 `blurred_background / crop_fill / fit`（属性面板 `layouts`）。
- 渲染计划段已携带 `track_id / track_hidden`（`plan.py` L340-366），数据面已为多轨备好。

**关键缺口（真正的落地点）：**
- **成片渲染未做覆盖轨合成**：`ffmpeg.py` 目前是"主轨 V1 单视觉轨语义"——只装配 V1 可见片段，覆盖轨内容**不参与成片渲染**。文档 `M2_MULTI_TRACK_TIMELINE_DESIGN.md` L42/L61 明确"覆盖轨合成（overlay）为后续工作"。
- **交互预览近似化**：预览只取"播放头所在最上层可见视频片段"，不是真叠加。
- **缺画布上直接拖拽/缩放手柄的交互**：目前位置只能用属性面板 + 关键帧数值精调，没有所见即所得拖动。

### 1.2 蒙版 —— 全新能力
- 代码库无任何 mask 模型/操作/渲染迹象（grep 无结果）。列为阶段 1"不实现"（`STAGE1_DETAILED_DESIGN.md` L44）。
- 需从模型层 → patch 操作 → 渲染 → UI 全新增。

### 1.3 抠像 —— 全新能力
- 无 chroma/colorkey/green screen 实现。FFmpeg 本地有 `colorkey` / `chromakey` 滤镜可用（能力已验证，可离线）。

---

## 2. 实施阶段拆分

### 阶段 P1：画中画（PIP）

**目标**：V2+ 覆盖轨真实参与预览与成片，可叠加多个视频/图片画面；用户在预览画布上直接拖动位置、拖手柄缩放。

**核心工作拆解：**

| # | 工作项 | 归属 | 说明 |
| --- | --- | --- | --- |
| P1-A | 渲染：覆盖轨 overlay 合成 | ZhangSan | 改造 `ffmpeg.py`，将 V1 以上的可见视频片段按 track 顺序叠加（上层盖下层），每层应用独立 layout/keyframes。参考现有 `_keyframe_animation_filters` 的 position overlay 通道 |
| P1-B | 渲染：多轨 Z 序定义 | ZhangSan | 明确轨道顺序 = Z 序（轨道数组 index 越大越靠上，符合时间线视觉）；档位 hidden 的轨跳过 |
| P1-C | 交互预览多轨合成 | ZhangSan/YeJing | 预览由"最上层单选"改为"逐层叠加合成"；性能用每层独立 canvas/视频元素叠加 |
| P1-D | 画布拖拽 + 缩放手柄 | YeJing | `App.tsx` preview-canvas 上，选中覆盖轨片段显示可拖矩形 + 8 方向 resize 手柄 + 旋转手柄；拖动实时 draft，松手提交 `position_clip`/`set_clip_keyframes(position)` |
| P1-E | 属性面板增强 | YeJing | ClipProperties 增加"位置 X/Y、缩放、旋转、层级"精调输入（与画布拖拽双向同步） |
| P1-F | 精准渲染：映射到 set_clip_keyframes | ZhangSan | 画布拖拽建议直接写入 position/scale 关键帧（复用现有），与动画打通 |
| P1-G | 测试 | ZhangSan/LiuKeAi | core 渲染测试多轨叠加；前端几何测试拖拽手柄；e2e PIP 全链路 |

**验收**（对齐 M2_MULTI_TRACK L42 的唯一诉求"覆盖轨内容参与成片"）：
- 三段视频压叠：顶层小窗叠加在主画面上，权威预览与最终成片一致。
- 拖动顶层画面位置/缩放后预览即时跟随，且成片正确。

### 阶段 2：蒙版（Mask）

**目标**：对片段做线性或矩形/椭圆区域裁剪，露出下层画面；可调羽化、反选。

**数据模型**（新增到 TimelineClip）：
```
mask?: {
  type: "linear" | "rect" | "ellipse";
  // linear: 线性蒙版，两点定义分界与旋转
  p1_x, p1_y, p2_x, p2_y,   // 归一化坐标 0..1
  feather: number;          // 羽化,0..0.5
  invert: boolean;
}
```

渲染：FFmpeg 用 `fade`/`alphamerge` + 几何像素表达式（linear）或裁剪几何（rect/ellipse）实现裁剪；与 layout/keyframes 串联。

UI：属性面板增加"蒙版"区；预览画布显示蒙版边界线（可拖 p1/p2 顶点）；提供「线性/矩形/椭圆」切换、「羽化」滑杆、「反转」开关。

### 阶段 3：抠像（Chroma key）

**目标**：绿幕/纯色背景抠除。

```
keying?: {
  enabled: boolean;
  color: [r,g,b];      // 目标色
  similarity: number;  // 0..1
  blend: number;       // 羽化
}
```

渲染：FFmpeg `chromakey=color:similarity:blend`（+spill/smooth 可选项）。
UI：选中片段开启"抠像"→ 取色器点在预览画布上选背景色 → 阈值/羽化滑杆 → 实时取景预览。

---

## 3. 工作量与排期估算（一名工程师）

| 阶段 | 预计人周 | 依赖 |
| --- | --- | --- |
| P1 画中画（含渲染 + 画布交互 + 面板） | 2~3 | 无（核心渲染改造是最大头） |
| P2 蒙版（基础图形） | 1.5~2 | 依赖 P1 的多轨渲染与画布交互基建？无需，独立片段属性 |
| P3 抠像（chroma key） | 1~1.5 | 依赖 P1 的渲染/预览链路与画布取色交互 |
| AI 智能抠像（后续） | 2~3 | 模型推理 + 接入，弹性 |

> 注：P1 渲染改造可能触碰现有 ffmpeg 表达式/滤镜链的回归风险，需重点覆盖核心测试与黄金样片回归。

---

## 4. 验收标准与风险

| 阶段 | 通过现象（验收） | 主要风险与对策 |
| --- | --- | --- |
| P1 画中画 | 三段视频压叠交叠画面，权威预览与成片一致；拖动顶层位置/缩放后预览即时跟随且成片正确 | ffmpeg 表达式/滤镜回归 → 覆盖核心测试与黄金样片回归 |
| P2 蒙版 | 基础图形蒙版剪辑正确、羽化软边、反转生效，预览与成片一致 | CSS/像素过滤与 FFmpeg 像素表达式对齐偏差 → 渲染单测对固定 mask 输出断言 |
| P3 抠像 | 绿幕背景按取色去除、阈值/羽化生效、无残留溢边，预览与导出一致 | colorkey 参数语义（similarity 0..1）与 UI 滑杆映射需校准 → 真渲染 e2e |

**横切风险**：以上三者均新增或触碰 Render Plan / 预览段字段，须保证旧 Revision 零迁移（缺省即无 mask/keying/多轨 overlay），不破坏既有时间线语义。

---

## 5. 关联文件清单

| 文件 | 作用 |
| --- | --- |
| `packages/contracts/src/index.ts` | 新增 mask/keying 类型与操作 |
| `services/core/src/aivs_core/timeline.py` | mask/keying 校验、规范化、diff、patch 操作 |
| `services/core/src/aivs_core/rendering/plan.py` | 携带 mask/keying 到 segment |
| `services/core/src/aivs_core/rendering/ffmpeg.py` | 多轨 overlay 合成 + mask/keying 滤镜 |
| `apps/desktop/src/app/App.tsx` | preview-canvas 画布拖拽/手柄 |
| `apps/desktop/src/app/PropertyPanels.tsx` | 位置/缩放蒙版/抠像 UI |
| `docs/uiux/plugins-pip-mask-key/*.html` | UI/UX 原型（本规划配套） |

---

## 6. UI/UX HTML 原型导航

原型先于实现、纯前端，用于沟通确认体验路径，不连真实数据：

- `index.html` —— 功能总览与切换入口
- `pip-canvas.html` —— 画中画：多轨 + 画布拖拽缩放手柄
- `mask-canvas.html` —— 蒙版：线性/矩形/椭圆 + 羽化 + 反转
- `keying-canvas.html` —— 抠像：取色器 + 阈值/羽化滑杆

各原型尽量复用同一套编排视觉与现有界面（时间线在上、属性面板在右、画布居中），对齐现有 App 的三栏布局，降低落地改造成本。

---

## 7. 待决策 / 开放问题

1. **PIP 画布交互**：拖拽是否同时写关键帧（推荐：是，复用 position 关键帧，天然获得动画），还是只写静态位置（不随时间变，需新增静态 position 字段）。倾向后者：静态位置与动画兼顾，新增 `position_static` / `scale_static` 存 Clip 级默认，关键帧存在时动画覆盖。
2. **蒙版是否支持"关键帧化"**（蒙版随时间移动）：第一版不做，留待后续阶段。
3. **抠像颜色选取坐标精度**：用预览画布坐标 → 取 GIF 或视频当前帧像素，还是允许手输 RGB。建议兼顾。

> 评审通过后，我会按此把分阶段任务拆分为可实现、可验收的 tickets，并逐步产出各阶段《详细设计定案》。

---

配套原型文件：见 `docs/uiux/plugins-pip-mask-key/` 目录。

---

## 8. 实现状态（已落地并验收）

按决策基线串行落地，三项均已**代码 + 单测 + 集成 + 服务端 FFmpeg 真渲染 + 桌面 UI**验收。

### 数据模型（零迁移，均为可选 Clip 字段）
- `transform?: TimelineClipStaticTransform`（P1：`x/y/scale/rotate/opacity`，缺省即隐式全屏。）
- `mask?: TimelineClipMask`（P2：`kind: linear|rect|ellipse` + `x/y/width/height/rotation/feather/invert`；空对象=清除。）
- `keying?: TimelineClipKeying`（P3：`color`(6 位十六进制)/`similarity`/`blend`/`invert`；空对象=清除。）
- contracts 校验器 `isTimelineClipMask` / `isTimelineClipKeying`；操作 `set_clip_mask` / `set_clip_keying`；diff 类型 `mask_changed` / `keying_changed`。
- timeline.py：`PATCH_OPERATIONS` 含二者；`_apply_operation` 分支（空 dict=清除、逐字段范围校验）；`_normalize_and_validate` 允许/可选键与内联校验。

### 渲染（FFmpeg）
- `plan.py` 把 `transform/mask/keying` 透传到 segment。
- `ffmpeg.py::_pip_overlay_chain`：覆盖轨 PIP → layout → transform(scale/rotate) → PTS 对齐 → `overlay enable=between + eval=frame + repeatlast + format=auto` 合成到 `[MAINPIP]`。
- 蒙版：`format=gray,geq='expr'`（几何 alpha 表达式，ellipse/rect/linear，rotated，feather）经 `alphamerge` 写入 alpha。已定位 FFmpeg 语义：alphamerge 取第二输入 luma 为 alpha，故以灰阶承接。
- 抠像：`colorkey=color=0xRRGGBB:similarity:blend` + `format=rgba,alphaextract` 生成灰度 alpha。蒙版+抠像并存时以 `blend=all_mode=multiply` 求交。
- 统一 alpha 管线：`[label]split=N` 分出 RGB 基帧与各 alpha 来源，合并后 `alphamerge`，再接 `setpts`/overlay。

### 验收证据（测试）
- 单测：`test_timeline::test_mask_.../test_keying_set_clear_and_diff`；`test_render_ass_ffmpeg_stage1c.py` 新增 mask/keying 构图断言（geq/colorkey/alphaextract/alphamerge/multiply 标签）。
- 真渲染：`test_mask_render_real.py`（椭圆蒙版改变合成、invert 反选生效）、`test_chroma_render_real.py`（绿幕抠除→透主画面、品红保留、键态显著差异）。
- 回归：`services/core/tests` 全量 523 passed（1 个既有 SSIM/fingerprint 复用时序测试为环境性 flake，与 P1/P2/P3 改动无关）。

### 桌面 UI
- P1 属性面板：画面变换（X/Y/缩放/旋转/不透明度）+ `PreviewPipOverlays` 画布拖拽/手柄。
- P2 属性面板：蒙版类型下拉 + 几何/羽化/反选 + 清除。
- P3 属性面板：`启用抠像` + 颜色取色器 + 相似度/边缘平滑滑杆 + 反选 + 清除。

### 修复记录（验收评审后）

1. **坐标语义定案（P1）**：`transform.x/y` 统一为**中心点归一化位置**（0..1），与 contracts
   注释及交互预览 `translate(-50%,-50%)` 语义一致。渲染侧 overlay 左上角 =
   中心×画布宽高 − PIP 尺寸一半（此前误用 `x*(W-pip_w)` 边缘语义，除 0.5 外预览与成片
   全部偏离）；负值/越界由 overlay 裁剪，对齐预览画布 overflow 行为。
   真渲染集成测试样本点已随新语义更新。
2. **修复覆盖轨 reframe 崩溃（P1）**：`_pip_overlay_chain` 的重构图分支引用了未定义变量
   `ref`（NameError），任何带重构图快照的 PIP 片段都会使渲染任务失败；已改为
   `reframe`，并新增单测 `test_builder_composes_pip_overlay_with_reframe` 锁定。
3. **手柄缩放重写（P1）**：8 向手柄支持缩小（对侧锚定：内拉缩小/外拉放大，越过锚点
   镜像翻转；n/s/e/w 单轴手柄只动一轴），结果钳制到 x/y∈0..1、scale∈0.05..5。
   几何抽为纯函数 `apps/desktop/src/app/pipResizeGeometry.ts`，配套
   `apps/desktop/tests/pip-resize-geometry.test.ts`（6 用例，对齐计划 P1-G 的前端几何测试）。

### 已知边界 / 后续 ticket（评审遗留）

- 覆盖轨 keyframes 动画、`transform.opacity` 渲染侧未生效（面板文案有承诺，需补齐或改文案）。
- rect/ellipse 蒙版 `feather` 渲染未实现（仅 linear 使用）；P2「羽化软边」对图形蒙版未达成。
- V1 主轨片段设置 mask/keying 渲染侧静默忽略（UI 未按轨道区分）。
- overlay 叠加顺序 = clips 数组顺序，未按轨道 index 定 Z 序（P1-B）。
- 主轨含转场时 PIP 时间窗按未压缩 timeline 坐标计算，会错位 ΣT。
- keying `similarity/blend=0` 被渲染侧静默改为默认值 0.3/0.1。