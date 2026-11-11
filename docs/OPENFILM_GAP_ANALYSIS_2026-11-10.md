# 与 OpenFilm 的差距清单（2026-11-10 · Round 8 调研）

## 一、主题系统：我们没有，它完整

OpenFilm（settings/theme.ts）：
- 三态 light / dark / system，默认 dark
- 存在 localStorage 的 openfilm.theme
- 通过 html data-theme 生效，index.html 在首帧前就应用（无闪白）
- system 态监听 prefers-color-scheme 变化实时跟随，不只在启动时判定
- 跨窗口同步：storage 事件广播到所有打开的页面
- globals.css 有 6 个 data-theme 主题块

我们（实测 grep）：
- data-theme：0 命中
- prefers-color-scheme：0 命中
- 只有一套写死的深色

## 二、设置页：结构差异

OpenFilm（SettingsModal.tsx）：
- 左侧固定 264px 导航 + 右侧内容
- 导航分两组：settings（general/agents/models）、help（shortcuts/advanced/developer）
- 每项带 18px 图标，选中项文字提亮
- 顶部有搜索框，可按分区名与短语过滤
- 底部有外链

我们（SettingsDialog.tsx）：
- 单页堆叠 fieldset：Provider 代理 / 预览播放 / Provider 配置
- 无导航、无搜索、无分区，约 200 行

## 三、预览播放：机制差异

OpenFilm（LiveTime.tsx + player.ts）：
- PlaybackClock 是外部 store（get/subscribe/line）
- 播放时只有订阅的叶节点更新：播放头、时间码、字幕、舞台轮廓
- 整个编辑器在播放期间不重渲染
- useSteppedPlaybackTime：只有 step(ms) 值变化时才重渲染
- 音频由 Web Audio 主时钟驱动，画面跟随音频时钟的缓动线（easedLead）
- 时间码用 LiveText 直接写 DOM

我们：
- 有 playheadStore（A06 命令式 DOM 跟随，播放期零 React 提交）
- 时间码/进度条走 applyPlayheadDom 直接写 DOM（同思路）
- 差异：我们的 clock 是播放头本身，OpenFilm 是音频时钟；
  我们没有 line() 概念（按时间轴外推的直线）
- 没有 useSteppedPlaybackTime 那样的值变化才渲染语义

## 四、时间线视觉规格差异（实测常量）

| 项 | OpenFilm | 我们 |
|---|---|---|
| 标尺高度 | 20px | 28px |
| 视频轨高 | 56px | 54px |
| 音频轨高 | 44px | 54px |
| 行间间隙 | 2px（露出面板底色） | 0（相邻相接） |
| 时间线上下留白 | 10px | 0 |
| 片段信息条 | 15px | 高度不同 |
| 播放跟随边缘 | 24px | 实现不同 |
| 缩放预热 | 120ms 停顿后重排，超 1.5 倍强制重排 | 无 |
| 新建轨判定带 | 5px 边缘 | 不同 |

## 五、它独有而我们没有的交互

1. 区间选取（range band）：标尺拖出范围、两端把手、状态高亮、可拖到聊天引用
2. 标记（markers）：标尺下方 16px 标记行，带颜色、可拖、贯穿全线的虚线引导
3. 轨道头拖拽排序 + 双击改轨高
4. 框选（marquee）、边缘自动滚动（edgeAutoScroll）
5. 播放头附近整片区域变列宽光标（tl-playhead-hot）
6. 滚轮/捏合缩放：以指针为锚点，先缩放绘制、停顿后重排
7. 吸附提示：拖动时显示吸附目标线

## 六、实施顺序（按 ROI）

1. 主题系统（独立、低风险）：先令牌层，再加 light/dark/system
2. 设置页重构（独立、纯前端）：左侧导航 + 分区 + 搜索
3. 时间线视觉规格对齐：标尺 20 / 轨高 56-44 / 行间隙 2 / 留白 10
4. 时间线交互补齐：吸附提示 → 热光标 → 滚轮缩放 → 框选 → 轨道排序
5. 区间选取与标记：新功能，需先定语义

## 说明
本清单基于逐项阅读 OpenFilm 源码（Timeline.tsx 5092 行、ViewerBar.tsx、LiveTime.tsx、
theme.ts、SettingsModal.tsx、globals.css）。数值均为源码常量，非估计。

---

## 更正（Round 3 · 2026-11-10）

上表"它独有而我们没有的交互"一节**不准确**。逐项 grep 核实后：

| 交互 | 我们是否有 | 证据 |
|---|---|---|
| 框选（marquee） | **有** | TimelineCanvas.tsx:1507 / 2487 / 2944 |
| 边缘自动滚动 | **有** | geometry.ts:492 + TimelineCanvas.tsx:2999 |
| 滚轮缩放 | **有** | TimelineCanvas.tsx:2105-2118（zoomAtAnchor） |
| 轨道锁定/显隐/静音/独奏 | **有** | track-flag 相关 |
| 播放头热光标 | **有** | col-resize 相关 |
| 轨道拖拽排序 | **有** | move_track 相关 |
| 磁吸吸附 | **有** | snapValue / snapCandidates |
| **吸附提示线** | **没有** | 0 命中 |
| **区间选取（range band）** | **没有** | 0 命中 |
| **标记行（markers）** | **没有** | 0 命中 |

**结论：真正缺失的只有吸附提示线、区间选取、标记行三项**，其中前两项是交互
细节与视觉反馈，第三项是新功能。

这条更正的意义：此前把"已有"误记为"缺失"，会导致重复劳动与错误优先级。
凡声称缺失的项，必须先 grep 确认。

---

## 二次更正（Round 3）

上一节「真正缺失只有三项」仍然有误。进一步核实后：

### 吸附提示线：早已完整实现
TimelineCanvas.tsx:1482-1505 在画布上画虚线 + 时间标签（#ffd76e），
覆盖 move / trim / group-move 三种交互，比一度加入的 DOM 覆盖层更完整。
实测：拖动第一次移动即出现，像素检测确认。

### 本轮实际发生的事（如实记录）
1. 误判它缺失 → 实现了 snapResult + DOM 覆盖层；
2. 测试两次都是 0 次触发 → 才去查已有实现；
3. 发现 interaction.snapUs 早已存在于三个交互分支，且画布已在绘制；
4. 回退了自己加的 DOM 层与 CSS，仅保留 snapResult 纯函数
   （无副作用、向后兼容，snapValue 现在委托给它）。

净效果：产品行为无变化，代码里多了一个可用的 snapResult。

## 最终核实状态

| 能力 | 状态 | 证据 |
|---|---|---|
| 磁吸吸附 + 提示线 | 完整 | geometry.ts snapValue / TimelineCanvas.tsx:1482 |
| 框选 | 完整 | TimelineCanvas.tsx:1507 |
| 边缘自动滚动 | 完整 | geometry.ts:492 + Canvas:2999 |
| 滚轮缩放（指针锚定） | 完整 | TimelineCanvas.tsx:2105 |
| 轨道锁定/显隐/静音/独奏 | 完整 | track-flag |
| 轨道拖拽排序 | 完整 | move_track |
| 区间选取（range band） | 缺 | 0 命中 |
| 标记行（markers） | 缺 | 0 命中 |

真正缺的只有区间选取与标记行，两者都是新功能而非体验缺失。

## 方法论教训（第三次）
grep 关键词 → 0 命中 → 判定缺失 这条推理链在本项目反复出错，
因为实现用的名字与设计术语不同（吸附提示线在代码里叫 snap guide、
画在 canvas 而非 DOM）。正确做法：先跑一次真实交互并观察像素/DOM，
再判断是否缺失。本轮最终靠截图像素检测确认它存在。