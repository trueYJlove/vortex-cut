# 时间线/预览交互对齐 OpenFilm（2026-11-10 · Round 7）

## 参照来源
OpenFilm（MIT）`packages/openfilm/studio/ui/src/components/Timeline.tsx`（5092 行）。
它是 Tailwind + 浅色主题，我们是原生 CSS + 深色，故移植的是**交互行为与几何**，
色值取我们的令牌。

## 本轮照搬的三处细节

### 1. 播放头旋钮：图钉形 + 按下实心
OpenFilm 的 `PlayheadKnob`（Timeline.tsx:4655）：12x17 SVG 图钉，
`fill` 在按下时用 `--tl-playhead`（实心）、常态用 `--bg-panel`（空心）；
命中区 24x20，比图形大——『人手瞄准的是那根线，差几像素就抓不到』。

我们原来是：6px 宽、18px 高的渐变色圆角矩形，且**没有按下态**。

改造后实测：
| 项 | 值 |
|---|---|
| 命中区 | 24x20 |
| 图形 | 12x17 SVG |
| 常态 fill | `--tl-playhead-rest`（空心）|
| 按住拖动 | `--tl-playhead-fill`（实心）|
| 松手 | 恢复空心 |

新增 `.timeline-playhead-layer` 的 `--tl-playhead-*` 令牌，
`TimelineCanvas` 的 `rulerScrubbingRef` 旁增加 `scrubbing` state 驱动该态。

### 2. 标尺上的选中区段：实心强调块
OpenFilm 在标尺带内用 `color-mix(--accent 28%, transparent)` 铺出范围段，
下方整体 13%，左右带 accent 边框（Timeline.tsx:4560-4575）。

我们原来只有『内容范围条』（3px 渐变细条，表达素材总长），**不表达选中**。

改造：选中片段的时间范围在标尺带上铺 `rgba(53,214,174,.28)` 实心块，
上下各 1.5px 描边。两种绘制路径（主画布 + 固定标尺覆盖层）都接入。
实测像素采样 `[37,85,75]`、`[79,131,130]`，确认为青色混合。

### 3. 缩放滑块：已走过段点亮
OpenFilm `.tl-zoom`（globals.css:446-460）：轨道用 `linear-gradient` 在
`calc(var(--pos,0)*100%)` 处从 accent 切到灰。

我们原来是纯灰轨道。改造后组件写入 `--pos`（当前缩放百分比 0..1），
轨道左段品牌青、右段灰。实测 `--pos = 0.34`，截图确认左段点亮。

## 验证
- 桌面 143 文件 / 1327 测试通过（`timeline-assembly-recovery` 与
  `editor-commands` 在全量并发下偶发失败，单独运行时全部通过，判定为并发抖动）
- typecheck 通过

## 尚未照搬（需评估）
1. **区间选取（range band）**：OpenFilm 在标尺上可拖出一个范围、两端带把手、
   可拖到聊天引用。这是**新功能**而非样式，我们目前没有区间概念。
2. **播放头附近 col-resize 光标**：`tl-playhead-hot` 类，靠近线时整片区域变
   列宽光标。低成本，可补。
3. **轨道头拖拽排序、双击改轨高**：我们已有轨道增删，形态不同。
4. **整条时间线密度**：OpenFilm 标尺 20px、轨高 56/44、轨道带之间有间隙
   （`--tl-gap`）。我们的标尺 28px、轨高 54。属整体密度取舍，需整体评估。