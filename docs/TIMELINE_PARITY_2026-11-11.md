# 时间线体验对齐 OpenFilm 录屏：实现记录（2026-11-11）

## 0. 来源与范围

用户在 2026-11-11 提供录屏 `C:\Users\trueY\20261111_085041.mp4`
（54.75s，2560×1440，EV 录屏 4.2.4），内容是 OpenFilm 的时间线操作，并指出
「实际实现的效果和这个体验差特别特别多」。

**范围裁决（用户选定）**：对齐体验，不整块搬。渲染仍用我们的 canvas，
不引 Tailwind、不写 `film.html`↔Core 适配层、不动可访问名称与既有测试结构。

**为什么不能整块搬**（实测数据，非估计）：

| | OpenFilm | 本仓 |
|---|---|---|
| 时间线主组件 | `Timeline.tsx` **5092 行 DOM + Tailwind** | `TimelineCanvas.tsx` 4091 行 canvas |
| 依赖闭包 | **74 文件 / 33894 行**（`.tmp/deps.mjs` 实测） | 绑 Python Core 37 个 patch 操作 |
| 样式体系 | Tailwind v4（`@tailwindcss/vite`） | 纯 CSS，**未装 Tailwind** |
| 文档模型 | `film.html` | Core timeline document |

法律上可行（OpenFilm 为 MIT，`LICENSE` 首行确认），代价上不可行。

## 1. 录屏逐帧解析方法

```
ffmpeg -i 录屏.mp4 -vf "fps=2,crop=2560:330:0:960"  `  # 2fps 时间线裁剪，109 帧
ffmpeg -i 录屏.mp4 -vf "fps=1,crop=2560:250:0:985"   `  # 1fps 原生分辨率
ffmpeg -i 录屏.mp4 -frames:v 1 -f image2 -vcodec ppm `  # 单帧 PPM，供像素扫描
```

像素读数用自写的 PNG/PPM 解码器（`.tmp/px.mjs` / `.tmp/scan*.mjs`），
不依赖图像库。**先量后改**——本轮所有结论都有像素坐标或计算样式支撑。

## 2. 差距清单与改动

### 2.1 面板高度：230px → 视口 34%（最大的一处）

**实测**：OpenFilm 时间线 y≈945..1440 = **490px / 1440px = 34%**；
本仓默认 `useState(230)`，1440 高窗口上只有 **230/1440 = 16.5%**。
差距整整一倍——这是「观感差特别多」的主因，超过其他所有细节之和。

**改动**（`apps/desktop/src/app/App.tsx`）：
- 新增 `defaultTimelineHeight()`：`max(220, innerHeight * 0.34)`
- `useState(() => defaultTimelineHeight())`
- 监听 `window resize` 重算；用户一旦拖动过（`timelineHeightPinnedRef`）就不再覆盖
- `beginResize("timeline", …)` 置位 pin 标记

**验证**：2560×1440 实测 `pane = 490px`，比值 **0.34**，与参照逐像素同值。

**为什么不是写死 490**：固定值在窗口缩放后立刻与参照脱节，而上一次的目标
恰恰是「照搬这种效果」而不是「照搬某个数字」。

### 2.2 标尺：标签贴底 → 顶部对齐，小刻度自上沿下垂

**实测**（OpenFilm `Timeline.tsx:3565-3582` `tickMarks`）：
- 主刻度：`border-l` 贯通，标签 `top-0 pl-1 leading-[14px]`（**顶部对齐**）
- 小刻度：`top-[9px]`（**从标尺上沿往下挂**）

本仓原来是反的：小刻度从 `height*0.45` 起，标签 `fillText(…, height-2)`（贴底）。
贴底的文字被顶部内容条 + 贯通主刻度 + 标尺下边框围成一个方框，看起来像输入框。

**改动**（`TimelineCanvas.tsx` `drawRulerFace`）：
- `textBaseline: "bottom"` → `"top"`
- 小刻度起点 `height*0.45` → `RULER_MINOR_TICK_TOP = 9`
- 标签 `(tickX+5, height-2)` → `(tickX + RULER_LABEL_PAD_X, RULER_LABEL_TOP)`，即 `+4, +1`

**证据**：`.tmp/ba3/ruler-before.png` vs `ruler-after.png`（同 6× 放大、同裁剪窗）。

### 2.3 轨道头：图标徽章 → 纯文字轨号

**实测**（OpenFilm `Timeline.tsx:295-305` `LaneMark`）：轨道头左侧是
**10.5px 纯文字** `V2`，`width:21 height:14`，`color: var(--text-faint)`，
无图标、无色块底、无方框。右侧才是开关图标列。

本仓是「图标 + 轨号」的小徽章，占 30px，且带图标同色的方框。

**改动**：
- `TimelineCanvas.tsx` 轨道头 JSX 去掉 `<Video/>`/`<TypeIcon/>`/`<Music/>`
- 删除随之不再使用的 3 个 lucide 导入
- `styles.css` `align-items: center` → `flex-start`，`padding: 0 6px` → `5px 6px 0`

**为什么改 align-items**：行高 56、内容 18 时，居中会把轨号与开关放到行的
垂直中段；参照软件里这一排贴着行顶，与片段名称条同一水平线。行拉高后差别明显
（这是改完 2.1 才暴露的——面板变高后行变高，问题才看得见）。

**证据**：`.tmp/ba3/head-before.png` vs `head-after.png`（同 4× 放大）。

### 2.4 行组：贴顶排列 → 垂直居中 + 上下 10px 内边距

**实测**（OpenFilm `Timeline.tsx:1239`）：
`padTop = max(MARKER_ROW_H + 2, floor((view.height - tracksH) / 2))`，
另有 `TL_VPAD = 10` 的上下内边距（`:243`）。

本仓 `computeTrackRows` 从 `rulerHeight` 直接往下排，面板拉高后全部贴顶、
底下空出一大片（改完 2.1 后截图里非常明显）。

**改动**（`geometry.ts`）：
- 新增 `TRACK_VIEW_PAD = 10`
- `computeTrackRows` 增加可选参数 `viewportHeight`；给出时
  `padTop = max(TRACK_VIEW_PAD, floor((viewport - tracksH) / 2))`
- 不给则保持老行为（从标尺下沿排），**测试与离屏渲染不依赖居中**

**配套**（`TimelineCanvas.tsx`）：
- `trackRows` 传入 `canvasSize.height - view.rulerHeight`
- `contentHeight` 改为按「末行底边 + TRACK_VIEW_PAD + 滚动条」算，并以
  `canvasSize.height` 兜底——居中的行会下移，按行高相加算会让它掉到内容区外；
  行数少时内容仍铺满面板，底下那片空白才是可点击的轨道区

### 2.5 空态：首行一条带 → 铺满整个轨道区

**实测**（OpenFilm `Timeline.tsx:4344-4356` `data-timeline-empty`）：
虚线框 `h-[60px] w-full` 在整片轨道区里居中，语义是「整片区域都能接住拖放」。

本仓虚线框高度写死 `view.trackHeight`，只框住首行——用户会以为只有那一行能放。

**改动**：`top: rulerHeight` + `bottom: SCROLLBAR_HEIGHT_PX` + `margin: TRACK_VIEW_PAD`，
并加 `Film` 图标（对应 OpenFilm 的 `<Film size={15}/>`）。

**验证**：2560×1440 空项目实测 `empty = 2440×401`，pane `490`，铺满。

### 2.6 播放头图钉：核对为一致，未改

`.tmp/knobcal.mjs` 与像素图确认两边同为 12×17 的 pin 路径：
`M1.9 3.4a2 2 0 0 1 2-2h4.2a2 2 0 0 1 2 2v5.3a4.1 4.1 0 0 1-8.2 0z`。
本仓 `TimelinePlayheadLayer.tsx` 已按 `scrubbing` 切空心/实心。
**这一项不改**——已一致，改了反而偏离。

## 3. 验收

### 3.1 回归

| 项 | 结果 |
|---|---|
| `pnpm --filter @aivideo/desktop test` | **143 文件 / 1327 用例全过** |
| `pnpm typecheck` | 通过（两包均干净） |
| `pnpm build` | 通过 |
| `pnpm test:python`（全量） | **1622 passed, 29 skipped, exit 0**（本轮 Python 一行未改，`git status -- services/core` 仅前一轮的 3 个文件） |

### 3.2 改了一条测试（说明理由）

`apps/desktop/tests/track-head.test.tsx` 第 65 行断言封面入口 `top === 196`，
即 `20 + 3*(56+2) + 2`。行组居中后绝对位置随面板高度变，这个常数只是
「行组无上内边距」这一实现细节的快照。

**该测试的意图是**「封面入口跟随 V1 行，而不是写死首行」（原注释明写）。
改为直接取 `[data-track-id="V1"]` 的实际 `top` 作基准断言相对关系——
**意图不变、可访问名称不变、断言更贴近意图**，且不再被布局常量变化误伤。

### 3.3 Python 测试

本轮所有改动都在 `apps/desktop`（TypeScript/CSS）。`services/core` 下
3 个文件是上一轮遗留的未提交改动，本轮未触碰。

**全量已跑完**：`uv run --locked --extra dev pytest services/core/tests/unit -q`
→ **1622 passed, 29 skipped, 1 warning in 1510.15s（25分10秒），exit 0**。

过程中先单跑了两条关键用例（`test_status_doc_consistency.py` +
`test_render_ir.py` = 48 passed）作为快速确认，再等全量。
**记录成稿时全量尚未结束，当时如实写成「未跑完」；结束后回填为上面的实际结果**——
不在没跑完时写「通过」，也不在跑完后把过程抹掉。
