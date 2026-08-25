# Vortex Cut UI/UX 交互设计方案

**项目：** Vortex Cut (AI-Vidio)
**技术栈：** React 19 + Electron + TypeScript + electron-vite
**产品定位：** 渐进式（简洁模式 + 专业模式可切换），本地优先、AI 驱动
**日期：** 2026-08-25
**关联文档：** `research/open-source-video-editors-survey.md`

---

## 目录

1. [设计原则](#1-设计原则)
2. [整体布局](#2-整体布局)
3. [各区域详细设计](#3-各区域详细设计)
4. [推荐复用的 React 组件清单](#4-推荐复用的-react-组件清单)
5. [需要自研的核心组件](#5-需要自研的核心组件)
6. [Timeline 组件技术实现方案](#6-timeline-组件技术实现方案)
7. [VideoPreview 组件技术实现方案](#7-videopreview-组件技术实现方案)
8. [CurveEditor 组件技术实现方案](#8-curveeditor-组件技术实现方案)
9. [键盘快捷键规范](#9-键盘快捷键规范)
10. [渐进式模式切换策略](#10-渐进式模式切换策略)

---

## 1. 设计原则

### 1.1 AI 是一等公民，不是附加功能
- 每个区域都有 AI 入口（素材面板的语义搜索、时间线的转录轨道、Inspector 的 AI 建议、全局命令面板）
- AI 操作结果可撤销（纳入统一 Undo/Redo 栈）
- AI 任务显示进度条 + 中间结果预览

### 1.2 渐进式披露
- 新用户看到的不超过 CapCut 级别的复杂度
- 专业功能通过模式切换或面板展开获得，不需要重新学习
- 默认隐藏高级面板，但提供明确的发现路径

### 1.3 键盘优先 + 鼠标增强
- 所有核心操作有快捷键（J/K/L 播放、I/O 入出点、C/V 剃刀/选择）
- 鼠标操作提供视觉反馈（吸附线、拖拽预览、裁剪手柄高亮）
- 支持自定义快捷键绑定

### 1.4 即时反馈
- 预览采用代理/低分辨率快速响应
- 时间线操作（拖拽、裁剪）目标 60fps 流畅
- 所有状态变化有视觉过渡动画

---

## 2. 整体布局

### 2.1 经典三栏 + 底部时间线

```
┌─────────────────────────────────────────────────────┐
│  Menu Bar / AI Command Palette (Ctrl+K)             │
├──────────┬──────────────────────┬───────────────────┤
│          │                      │                   │
│  素材面板  │     预览播放器        │   属性/检查器面板   │
│  (Media   │     (Preview)        │   (Inspector)     │
│   Bin)    │                      │                   │
│          │                      │                   │
├──────────┴──────────────────────┴───────────────────┤
│                                                     │
│              时间线区域 (Timeline)                    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 响应式约束
- 最小窗口尺寸：1280×720
- 左侧面板最小宽度：200px，最大 400px
- 右侧 Inspector 最小宽度：240px，最大 360px
- 时间线最小高度：200px
- 面板之间用可拖拽分隔条调整大小

### 2.3 参考来源
- **Shotcut**：单窗口简洁布局
- **DaVinci Resolve**：页面式专业模式切换
- **CapCut/剪映**：AI 优先简洁模式
- **Diffusion Studio**：Web 端编辑器布局

---

## 3. 各区域详细设计

### 3.1 顶部：AI 命令面板

| 元素 | 说明 | 可复用组件 |
|---|---|---|
| AI Command Palette | `Ctrl+K` 唤起，支持自然语言指令如"去掉所有静音片段"、"加字幕" | [cmdk](https://github.com/pacocoursey/cmdk) |
| 传统菜单栏 | 文件/编辑/视图等，简洁模式下可隐藏到汉堡菜单 | 自研（简单） |
| 导出按钮 | 右上角主 CTA | `lucide-react` Upload/Share2 |
| 模式切换 | 简洁/专业模式 toggle | 自研 Toggle 组件 |

### 3.2 左侧：素材面板（Media Bin）

| 元素 | 说明 | 可复用组件 |
|---|---|---|
| 标签页切换 | 素材 / 转场 / 特效 / 文字 / AI生成 | `@radix-ui/react-tabs` |
| 素材缩略图网格 | 支持拖拽到时间线，hover 预览 | 自研 + `@tanstack/react-virtual` |
| 搜索/筛选 | AI 语义搜索（"找到所有笑脸镜头"） | 自研输入框 + Agent API |
| 导入区 | 拖放文件/文件夹导入 | HTML5 Drag & Drop API |
| 素材信息 | 选中素材显示元数据（时长、分辨率、编码） | 自研详情面板 |

### 3.3 中央：预览播放器

| 元素 | 说明 | 可复用组件 |
|---|---|---|
| 视频画布 | Canvas/WebGL 渲染，保持宽高比 | 自研 `<VideoPreview>` |
| 播放控制 | 播放/暂停/逐帧/循环/速率 | `lucide-react` + 自研控制条 |
| 时间码显示 | 当前时间/总时长，可点击跳转 | 自研 |
| 分辨率/质量切换 | 预览质量 vs 性能 | 下拉选择器 |
| AI 标注叠加层 | 人脸框、字幕预览、场景分割标记 | Canvas overlay 自研 |
| 安全区域参考线 | 各平台比例参考线（9:16, 1:1 等） | SVG overlay |

### 3.4 右侧：属性检查器（Inspector）

| 元素 | 说明 | 可复用组件 |
|---|---|---|
| 上下文感知 | 选中 clip → 变换/速度/滤镜；选中轨道 → 音量/效果链 | 自研状态驱动面板 |
| 关键帧编辑器 | 曲线编辑器，参数动画 | 自研 Canvas 曲线组件 |
| AI 建议面板 | "AI 建议：这段可以用交叉溶解过渡" | 自研卡片组件 |
| 颜色校正 | 色轮/曲线/LUT | `react-colorful` 改造 |
| 变换控件 | 位置/缩放/旋转/不透明度 | `@radix-ui/react-slider` |

> 简洁模式下此面板隐藏，双击 clip 弹出浮动属性面板代替。

### 3.5 底部：时间线

| 元素 | 说明 | 可复用/参考 |
|---|---|---|
| 多轨轨道头 | 轨道名/静音/独奏/锁定/可见性 | 自研 |
| Clip 块 | 缩略图波形 + 拖拽移动/裁剪/分割 | **自研** |
| 播放头 | 红色竖线 + 时间标尺 | 自研 Canvas/SVG |
| 缩放控制 | 滚轮缩放 + 滑块 + 适应全部 | 自研 |
| 对齐/吸附 | 边缘吸附、播放头吸附 | 自研逻辑 |
| 波纹/滚动编辑 | 拖动 clip 边缘时联动后续 clip | 自研 |
| AI 转录轨道 | Whisper 文字轨道，点击文字跳转 | 自研 |
| 场景分割标记 | AI 检测的场景边界竖线 | 自研 overlay |

---

## 4. 推荐复用的 React 组件清单

| 需求 | 推荐库 | 用途 | 备注 |
|---|---|---|---|
| 命令面板 | `cmdk` | Ctrl+K AI 命令面板 | Diffusion Studio 也用类似模式 |
| 虚拟滚动 | `@tanstack/react-virtual` | 素材列表/长轨道 clip 列表 | 高性能 |
| 拖拽 | `@dnd-kit/core` | 素材拖入时间线、clip 排序 | 无障碍友好 |
| 弹窗/对话框 | `@radix-ui/react-dialog` | 导出设置、偏好设置 | 无样式原语 |
| 下拉菜单 | `@radix-ui/react-dropdown-menu` | 右键菜单、轨道操作 | 无样式原语 |
| Tooltip | `@radix-ui/react-tooltip` | 工具栏按钮提示 | 无样式原语 |
| Slider | `@radix-ui/react-slider` | 音量、不透明度、缩放 | 无样式原语 |
| Tabs | `@radix-ui/react-tabs` | 素材面板标签页 | 无样式原语 |
| 图标 | `lucide-react` | 全局图标 | ✅ 已安装 |
| 状态管理 | `zustand` | 时间线状态、选中状态、UI 模式 | 轻量、TS 友好 |
| 键盘快捷键 | `tinykeys` | 全局快捷键绑定 | 极小体积 |
| 波形可视化 | `wavesurfer.js` | 音频波形渲染 | 成熟稳定 v7 |
| 颜色选择 | `react-colorful` | 轻量级颜色选择器 | 5KB gzipped |
| 数值输入 | `@radix-ui/react-number-field` | 精确数值参数 | 无样式原语 |

---

## 5. 需要自研的核心组件

| 组件 | 复杂度 | 参考对象 | 备注 |
|---|---|---|---|
| **Timeline** | 🔴 高 | Diffusion Studio, Shotcut, LosslessCut | 整个产品的核心 |
| **VideoPreview** | 🟡 中 | Diffusion Studio, LosslessCut | 与 sidecar 解码管线对接 |
| **CurveEditor** | 🟡 中 | Kdenlive, After Effects | Canvas 实现 |
| **WaveformRenderer** | 🟢 低→中 | wavesurfer.js 封装 | 集成到 Timeline clip |
| **AITranscriptTrack** | 🟡 中 | RoughCut | AI 差异化功能 |
| **ModeSwitcher** | 🟢 低 | DaVinci Resolve | 简洁/专业模式切换 |
| **DragResizeHandle** | 🟡 中 | 通用面板分隔条 | 面板布局调整 |

---

## 6. Timeline 组件技术实现方案

### 6.1 架构概览

Timeline 是整个产品最复杂的自研组件，采用 **Canvas 渲染 + React 状态管理** 混合架构：

```
┌─────────────────────────────────────────────┐
│           TimelineContainer (React)          │
│  ┌─────────────────────────────────────────┐ │
│  │      TrackHeaders (React/DOM)          │ │
│  │  ┌───────────────────────────────────┐ │ │
│  │  │   TrackHeader: V1 [🔇][🎵][🔒]  │ │ │
│  │  │   TrackHeader: A1 [🔇][🎵][🔒]  │ │ │
│  │  │   TrackHeader: TX [🔇][👁️]      │ │ │
│  │  └───────────────────────────────────┘ │ │
│  ├─────────────────────────────────────────┤ │
│  │   TimelineCanvas (HTML5 Canvas)       │ │
│  │   - 时间标尺                           │ │
│  │   - Clip 块渲染（缩略图/波形/颜色）     │ │
│  │   - 播放头                             │ │
│  │   - 选中框 / 吸附线                    │ │
│  │   - 场景分割标记                        │ │
│  └─────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────┐ │
│  │   ZoomBar + ScrollBar (React/DOM)     │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 6.2 为什么选 Canvas 而非纯 DOM

| 维度 | 纯 DOM | Canvas | 结论 |
|---|---|---|---|
| 100+ clips 渲染 | 大量 DOM 节点，重排昂贵 | 单次 drawCall | ✅ Canvas |
| 拖拽/裁剪 60fps | requestAnimationFrame + reflow | 直接重绘 | ✅ Canvas |
| 缩略图/波形 | img 标签 + CSS | drawImage + 缓存 | ✅ Canvas |
| 无障碍/文本选择 | 原生支持 | 需额外处理 | ⚠️ DOM 优势 |
| 事件处理 | 原生 DOM 事件 | hitTest 自实现 | ⚠️ DOM 优势 |
| 复杂布局（轨道头） | Flex/Grid 天然支持 | 不适合 | ✅ DOM |

**决策**：Clip 渲染区域用 Canvas，轨道头/控制栏/滚动条用 React DOM，两者通过共享 zustand store 同步状态。

### 6.3 数据模型

```typescript
// packages/contracts/src/timeline.ts

interface Timeline {
  id: string;
  tracks: Track[];
  durationMs: number;
  zoomLevel: number;        // px per ms
  scrollX: number;          // horizontal scroll offset in ms
  scrollY: number;          // vertical scroll offset in px
}

interface Track {
  id: string;
  type: 'video' | 'audio' | 'text' | 'transcript' | 'effect';
  name: string;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  visible: boolean;
  height: number;           // px
  clips: Clip[];
}

interface Clip {
  id: string;
  trackId: string;
  startMs: number;          // position on timeline
  durationMs: number;       // duration on timeline
  sourceStartMs: number;    // trim-in point in source media
  sourceEndMs: number;      // trim-out point in source media
  mediaId: string;          // reference to MediaBin asset
  effects: EffectInstance[];
  speed: number;            // playback rate multiplier
  opacity: number;          // 0-1
  metadata: Record<string, unknown>;
}

interface EffectInstance {
  effectId: string;         // e.g. 'crossfade', 'blur', 'color-grade'
  params: Record<string, KeyframeableParam>;
}

interface KeyframeableParam<T = number> {
  value: T;                 // static value or default
  keyframes?: Keyframe<T>[];
}

interface Keyframe<T = number> {
  timeMs: number;           // relative to clip start
  value: T;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'bezier';
  bezierHandles?: [number, number, number, number]; // for custom curves
}
```

### 6.4 状态管理（Zustand Store）

```typescript
// apps/desktop/src/renderer/stores/timelineStore.ts

interface TimelineState {
  // Data
  timeline: Timeline;

  // Selection
  selectedClipIds: Set<string>;
  selectedTrackIds: Set<string>;

  // Playback
  currentTimeMs: number;
  isPlaying: boolean;
  playbackRate: number;
  loopRegion: { startMs: number; endMs: number } | null;

  // Editing mode
  tool: 'select' | 'razor' | 'trim' | 'ripple' | 'roll';
  snapEnabled: boolean;
  snapTargets: number[];  // ms positions to snap to

  // Interaction state (transient, not persisted)
  dragState: DragState | null;
  hoverClipId: string | null;
  resizeHandle: 'left' | 'right' | null;

  // Actions
  selectClip: (id: string, multi: boolean) => void;
  moveClip: (id: string, newStartMs: number) => void;
  trimClip: (id: string, edge: 'left' | 'right', deltaMs: number) => void;
  splitClipAt: (clipId: string, timeMs: number) => void;
  setTool: (tool: Tool) => void;
  seekTo: (timeMs: number) => void;
  togglePlayback: () => void;
  undo: () => void;
  redo: () => void;
}
```

### 6.5 Canvas 渲染管线

```
每帧渲染流程（requestAnimationFrame）：

1. clearRect()
2. drawTimeRuler()           — 时间刻度线 + 数字
3. drawTrackBackgrounds()    — 交替行背景色
4. drawClips()               — 遍历可见 clip：
   a. drawClipBackground()   — 圆角矩形 + 轨道类型颜色
   b. drawThumbnails()       — 从缓存取缩略图 drawImage
   c. drawWaveform()         — 从缓存取波形 Path2D
   d. drawClipName()         — fillText 截断
   e. drawTrimHandles()      — hover/selected 时显示
5. drawSceneMarkers()        — AI 场景分割竖线
6. drawTranscriptOverlay()   — 转录文字（如果展开）
7. drawPlayhead()            — 红色竖线 + 三角头
8. drawSelectionRect()       — 框选虚线框
9. drawSnapGuides()          — 吸附辅助线
10. drawDragGhost()          — 拖拽时的半透明预览
```

### 6.6 性能优化策略

| 策略 | 说明 |
|---|---|
| **视口裁剪** | 只渲染 scrollX ± viewportWidth 范围内的 clip |
| **缩略图缓存** | LRU Map<clipId, ImageBitmap>，离屏预生成 |
| **波形缓存** | 预计算 Path2D，按 zoomLevel 分级缓存 |
| **脏矩形重绘** | 仅重绘变化区域（播放头移动时只重绘竖线区域） |
| **OffscreenCanvas** | 将耗时的缩略图/波形生成移到 Worker |
| **节流渲染** | 非交互状态下降低到 30fps，交互时 60fps |
| **虚拟化轨道** | 垂直方向只渲染可见轨道 |

### 6.7 交互实现

| 交互 | 实现方式 |
|---|---|
| Clip 点击选中 | Canvas mouseDown → hitTest → store.selectClip() |
| Clip 拖拽移动 | mouseDown(hitTest) → mouseMove(更新 dragState + 重绘 ghost) → mouseUp(提交 moveClip) |
| Clip 边缘裁剪 | hitTest 检测到 resizeHandle → 拖拽时更新 trim 值 → mouseUp 提交 |
| 播放头拖拽 | mousedown on ruler/playhead → mouseMove(seekTo) |
| 框选 | mousedown on empty → mouseMove(drawSelectionRect) → mouseUp(hitTest all in rect) |
| 缩放 | wheel event → 以鼠标位置为中心调整 zoomLevel + scrollX |
| 平移 | middle-mouse drag 或 scrollbar |
| 吸附 | dragState 中实时计算最近 snapTarget，距离 < threshold 时吸附 |

### 6.8 分阶段实现计划

| 阶段 | 内容 | 预估工时 |
|---|---|---|
| Phase 1 | 基础 Canvas 渲染：轨道背景 + clip 色块 + 播放头 + 时间标尺 | 3-4 天 |
| Phase 2 | Clip 交互：点击选中 + 拖拽移动 + 边缘裁剪 | 3-4 天 |
| Phase 3 | 缩略图/波形渲染 + 缓存系统 | 2-3 天 |
| Phase 4 | 吸附 + 框选 + 多轨编辑 + 波纹编辑 | 3-4 天 |
| Phase 5 | AI 转录轨道 + 场景标记 + 快捷键 | 2-3 天 |
| Phase 6 | 性能优化 + 测试 | 2-3 天 |

---

## 7. VideoPreview 组件技术实现方案

### 7.1 架构选型

| 方案 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|
| **A: WebCodecs + WebGL** | 纯前端，无 native 依赖 | 编解码支持有限，浏览器兼容差 | 轻量 Web 编辑器 |
| **B: IPC → FFmpeg sidecar → Canvas** | 全编解码支持，与现有 aivs-core 一致 | IPC 带宽开销 | ✅ Vortex Cut |
| **C: SharedArrayBuffer + WASM FFmpeg** | 零拷贝，性能好 | WASM FFmpeg 体积大，SAB 限制多 | 未来优化方向 |

**决策**：Phase 1 采用方案 B，预留方案 C 升级路径。

### 7.2 数据流

```
[Timeline Store] currentTimeMs 变化
       ↓
[PreviewController] 请求帧
       ↓
[Electron IPC] decodeFrame(mediaId, timeMs, width, height)
       ↓
[aivs-core Python sidecar] FFmpeg seek + decode + scale
       ↓
[SharedArrayBuffer / IPC transfer] RGBA pixel data
       ↓
[Canvas 2D] putImageData() 或 createImageBitmap() + drawImage()
       ↓
[AI Overlay Layer] Canvas 叠加标注（人脸框、字幕等）
```

### 7.3 预览性能策略

| 策略 | 说明 |
|---|---|
| **代理模式** | 预览时使用 1/4 或 1/2 分辨率解码 |
| **帧缓存** | 缓存最近 N 帧，回放时避免重复解码 |
| **异步解码** | 解码在 sidecar 进程，不阻塞渲染线程 |
| **丢帧策略** | 如果解码跟不上播放速率，跳过中间帧 |
| **预解码** | 播放时提前解码后续 2-3 帧 |
| **暂停即精确定位** | 暂停时发送精确 seek 请求获取准确帧 |

### 7.4 组件接口

```typescript
interface VideoPreviewProps {
  currentTimeMs: number;
  mediaSource: MediaSource | null;  // 当前预览的媒体
  resolution: 'full' | 'half' | 'quarter';
  showSafeArea?: SafeAreaPreset;
  aiOverlays?: AIOverlay[];
  onFrameReady?: (frame: FrameInfo) => void;
}
```

---

## 8. CurveEditor 组件技术实现方案

### 8.1 功能需求
- 贝塞尔曲线关键帧编辑
- 支持多种缓动类型（linear, ease-in, ease-out, custom bezier）
- 拖拽关键帧点和控制手柄
- 数值范围自适应 Y 轴
- 时间轴与 Timeline 同步
- 支持多参数同时显示

### 8.2 技术方案
- **渲染**：Canvas 2D（曲线路径 + 关键点 + 网格）
- **交互**：hitTest 关键点/手柄 → 拖拽更新 bezierHandles
- **数学**：三次贝塞尔插值 `cubic-bezier(t, p0, p1, p2, p3)`
- **参考**：Kdenlive 参数关键帧 UX + CSS cubic-bezier 编辑器

### 8.3 数据结构

```typescript
interface CurveEditorProps {
  keyframes: Keyframe[];
  durationMs: number;
  valueRange: [number, number];
  onChange: (keyframes: Keyframe[]) => void;
  currentTimeMs?: number;  // 显示播放头位置
}
```

---

## 9. 键盘快捷键规范

### 9.1 行业标准快捷键（必须遵循）

| 快捷键 | 功能 | 来源 |
|---|---|---|
| Space | 播放/暂停 | 通用 |
| J / K / L | 倒放/暂停/正放（连按加速） | Premiere / DaVinci |
| I / O | 设置入点/出点 | 通用 |
| C | 剃刀工具 | Premiere |
| V | 选择工具 | Premiere |
| Ctrl+Z / Ctrl+Shift+Z | 撤销/重做 | 通用 |
| S | 分割当前 clip | Shotcut |
| Delete | 删除选中 clip | 通用 |
| Ctrl+A | 全选 | 通用 |
| Home / End | 跳到开头/结尾 | 通用 |
| ← / → | 逐帧前进/后退 | 通用 |
| Shift+← / Shift+→ | 快进/快退 5 秒 | 通用 |
| M | 添加标记 | Premiere |
| Ctrl+K | AI 命令面板 | VS Code 惯例 |

### 9.2 Vortex Cut 专属快捷键

| 快捷键 | 功能 |
|---|---|
| Ctrl+Shift+A | AI 自动剪辑（基于转录） |
| Ctrl+T | AI 生成字幕 |
| F1 | 切换简洁/专业模式 |
| Tab | 在面板间切换焦点 |

---

## 10. 渐进式模式切换策略

### 10.1 简洁模式（默认）

- 左侧面板折叠为图标栏（hover 展开）
- 右侧 Inspector 隐藏（双击 clip 弹出浮动面板）
- 时间线只显示 2 条轨道（视频 + 音频）
- AI 操作面板突出显示在预览区下方
- 工具栏只显示核心工具（选择、剃刀、分割）
- 菜单简化为汉堡菜单

### 10.2 专业模式

- 完整三栏布局
- 多轨时间线（无限轨道）
- 完整 Inspector 面板
- 调色/音频混合专用面板
- 完整工具栏
- 传统菜单栏

### 10.3 切换机制

```typescript
// stores/uiStore.ts
interface UIState {
  mode: 'simple' | 'pro';
  toggleMode: () => void;
  // 记住用户偏好，下次启动恢复
}
```

- 切换时有平滑过渡动画（面板滑入/滑出）
- 不丢失任何状态（时间线位置、选中状态保持不变）
- 提供引导提示："专业模式已开启，你可以在这里找到更多工具"

---

## 附录：开源项目 UI 参考索引

| 参考点 | 来源项目 | 链接 |
|---|---|---|
| 简洁单窗口布局 | Shotcut | https://www.shotcut.com |
| 页面式模式切换 | DaVinci Resolve | 商业软件 |
| JSON 项目格式 | OpenShot | https://github.com/OpenShot/openshot-qt |
| Web 端时间线实现 | Diffusion Studio | https://github.com/diffusionstudio/editor |
| AI 转录轨道交互 | RoughCut | https://github.com/PaulBratslavsky/roughcut-ai-local-first-editor |
| 参数关键帧 UX | Kdenlive | https://kdenlive.org |
| Electron + FFmpeg 架构 | LosslessCut | https://github.com/mifi/lossless-cut |
| 精确修剪工具 | Flowblade | https://github.com/jliljebl/flowblade |
| MLT XML 时间线模型 | Shotcut | https://shotcut.com/notes/mltxml-annotations/ |

</content>