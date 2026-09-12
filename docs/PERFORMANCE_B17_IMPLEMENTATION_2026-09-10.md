# B17 实施进度与自检报告(2026-09-10)

## 1. 状态与范围

**B17(时间轴二维可见区与精细状态)代码完成 + 功能验证完成。**
独立验收:**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B17,在
B16(`d70a2f0` 报告)之上实施。开工时工作树已有 B17 半成品(画布 viewport 化
骨架 + viewport-index 初稿,未提交),本次收尾:修复半成品中的坐标/摆位
缺陷、接通可见区裁剪、补齐测试并全量回归。

提交(本地,未 push):
- (提交 1)B17 画布 viewport 化 + 可见区索引——viewport-index.ts +
  TimelineCanvas viewport 化/裁剪/交互坐标 + 本报告

## 2. 修改单(模板)

```text
修改单:B17 时间轴二维可见区和精细状态
基线HEAD / 工作树标识:d70a2f0(B16 报告);一个本地提交
目标与不修改范围:
  目标——DOM 滚动空间保持全内容尺寸(.timeline-left 高与画布容器高均
  = contentHeight),Canvas backing 仅覆盖 viewport + 2 轨 overscan
  (初值 160px),不分配等于所有轨道高度的大位图;ctx 平移 -canvasTopY
  使内容坐标绘制照常;clip/caption 绘制循环按 viewport-index 过滤,
  draw 访问量随可见元素而非文档总量增长;命中/框选仍走全量几何
  ("不能因为不画就丢文档元素")。
  不修改——四层分层中"底图/轨道/叠加/播放头"的后三层结构维持现状
  (轨道行背景/网格仍全行绘制——行数=轨道数,量级 O(轨道) 本就有界;
  播放头 A06 已拆独立覆盖层;选中/拖动叠加本来只画交互涉及的元素);
  static tile 缓存(计划"先测需要再引入复杂 tile")未引入——draw 裁剪
  后静态层成本已 O(可见),tile 缓存列为实测驱动项;editing store
  slice 订阅维持现状(播放头不进 React 状态的 A06 架构已满足"不把
  播放头写入可撤销文档");undo/redo 仍用权威 timeline revision。
实际修改文件(绝对路径):
  apps/desktop/src/app/timeline/viewport-index.ts(新增:行区间/横轴
    交叠/rect 过滤纯函数;OVERSCAN_X_PX=400、OVERSCAN_ROWS=2)
  apps/desktop/src/app/timeline/TimelineCanvas.tsx(画布 viewport 化 +
    可见区裁剪 + scrollTop 状态/ref + canvasCoords 内容坐标 + 滚动条/
    右键菜单可视区判定)
  apps/desktop/tests/viewport-index.test.ts(新增,9 项)
  apps/desktop/tests/timeline-viewport.test.tsx(新增,4 项)
前置Gate与接口版本:A06(播放头覆盖层/尺寸守卫/稳定几何)、A08
  (缩略图视口请求)、B14(波形取窗)——全部就绪。
算法/状态机变化:
  - 画布生命周期:canvasSize={width:容器宽,height:滚动容器可视高}
    (ResizeObserver);scrollTop 每滚动事件更新 state+ref;
    canvasTopY=max(0,scrollTop-160);画布高=min(contentHeight-
    canvasTopY, 可视高+320);画布在容器内 absolute 定位(top=
    canvasTopY,render 内联写 style——与绘制 effect 同帧,无滞后);
    backing 尺寸赋值仍走 A06 比较守卫(滚动只改 top,不重分配位图)。
  - 绘制:ctx.setTransform(dpr,0,0,dpr,0,-topY*dpr) 一步完成内容坐标
    →画布坐标平移;clearRect/fillRect/标尺引导线以内容空间 [topY,
    topY+height) 为界;底部滚动条带为画布固定 UI——先复位变换再画
    (画布坐标 y = scrollTop + 可视高 - topY)。
  - 可见区裁剪:viewport={left:0,right:width,top:topY,bottom:
    topY+height};drawClipRects/drawCaptionRects = filterVisibleRects
    (全量 rect, viewport, 2×trackHeight);clip 体/字幕循环只遍历
    裁剪结果;拖动 ghost/放置预览/关键帧面板等交互反馈仍从全量
    clipRects 按 id 查找(语义不裁剪)。height=0(内容不足/极端缩放)
    时裁剪结果为空数组,不产生越界绘制。
  - 交互坐标:canvasCoords 的 y = event.clientY - rect.top +
    canvasTopY(闭包捕获——与 render 写入 style.top 同一来源,逐事件
    取最新渲染闭包);滚动条命中带与右键菜单上翻判定改为内容空间
    (scrollTop + 可视高);scrollTopRef 供 rAF/即时路径读 DOM 先行值。
授权、取消、资源所有权、缓存失效规则:不涉及新 IPC/权限;缩略图
  (A08)与波形(B14)请求仍按既有视口逻辑,画布 viewport 化不改变其
  key/失效规则;裁剪仅影响绘制输入,不影响任何缓存所有权。
新增/修改测试与命令:
  vitest run tests/viewport-index.test.ts tests/timeline-viewport.test.tsx
  vitest run(全量 68 文件 598 项)
  pnpm lint(= tsc --noEmit)
功能回归结果(含跳过):Desktop 全量 68 文件 598 项通过(B16 时
  66 文件 585 项;+2 文件 +13 项);timeline 相关 7 文件 100 项通过
  (geometry/filmstrip/panel-interactions/redraw/thumbnail-loader/
  viewport-index/timeline-viewport);typecheck/lint 通过。
  已知噪音:tests/input-pool-protocol.test.ts 报 2 个 unhandled
  rejection("compositor worker disposed")——在干净 HEAD(d70a2f0
  stash 后)同样复现,为 B13 遗留测试噪音,非本次引入,测试本身通过。
before / after / 同机环境:
  结构性收益(jsdom 断言,非性能实测):100 轨 99 clip 场景画布
  backing 高 ≈520px(视口 200 + 2×overscan)vs 旧全内容 ≈5595px
  (位图面积 ≈1/10);draw 访问量:100 轨文档单视口只画 ≤12 个 clip
  体(全量 99),滚到底部两次视口合计 ≤24(≪ 2×99)。
  滚动路径:每滚动事件 = setState(scrollTop) → render(画布 top
  内联更新)+ 绘制 effect 重跑(裁剪后 O(可见)绘制)——backing 不
  重分配(尺寸守卫),无逐帧大位图重绘。
质量与失败路径验证:
  - 越顶滚动 scrollTop<overscan:画布顶钳 0(单测);
  - 滚动不重分配 backing(单测:两次滚动 canvas.height 不变);
  - 内容不足视口(画布高=contentHeight-0 钳制)与 0 高画布(height
    ≤0 → 裁剪空数组,不崩);
  - 半成品缺陷修复:canvasCoords 不再解析 style.top 字符串
    ("840px"→Number=NaN 陷阱)改闭包坐标源;画布 top 摆位从绘制
    effect 提前到 render(消除滚动后一帧画布位置滞后导致的命中错位);
    标尺悬停引导线画到画布覆盖内容底(不再用旧全内容高度)。
  - 交互等价:17 项 panel-interactions(右键菜单/磁吸/拖拽/框选/
    空区定位)+ 8 项 timeline-redraw(A06 播放期间零重绘、尺寸守卫)
    全部不改断言通过——命中几何在内容空间语义下不变。
开关、兼容与回退:
  纯 Renderer 内部改动,无跨层契约/开关;回退 = revert 单提交即回到
  旧全内容画布(几何/交互代码路径未删)。
已知限制、未解决问题:
  - draw 裁剪为 O(全量 rect) 单趟过滤(rects 已是 useMemo 缓存)——
    计划中的"行内时间二分"在 clipRects 含跨轨全序时无直接单调性可
    依,第一轮用线性精滤(量级=文档 rect 数,绘制成本已 O(可见));
    行区间二分 + 行内有序二分列为实测驱动优化(需先按 track 分组
    索引,收益取决于超长项目场景,与 C20 IR v2 一并评估)。
  - static tile 缓存(计划"key=revision 局部版本+scaleBucket+DPR
    +theme")未引入——现状滚动重绘 = 裁剪后 O(可见) 一次全量重画,
    实测显示不足时再引入,避免过度缓存(计划原文要求)。
  - 四层分层中"选中/拖动叠加"与"底图"仍在同一画布(分层结构由
    A06 的播放头覆盖层 + 本次的画布 viewport 化实质达成:播放期间
    主画布零重绘已有单测锁定);独立叠加画布列为渲染压力实测后的
    后续项。
  - 100 轨 1000 clip 真实拖动/滚动 trace 对比(计划验收句)未跑
    E2E 实测——jsdom 断言覆盖结构性指标(draw 访问量/位图尺寸),
    真实 GPU/合成器耗时列 F 场景复测轮(与 B13/B16 的 F04/F06 同批)。
  - .timeline-left 轨道头列仍全内容渲染(DOM 元素=轨道数,量级有界;
    计划只要求画布不分配全内容位图,头列不在约束内)。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:第二轮(B10–B17)编码全部完成——G2 退出条件中
  "长源首帧/PCM/GPU 预算/同源复用/F03–F07 回归/30–60 分钟压力"仍待
  F 场景复测轮量化;或进入第三轮 C20(窗口化 IR v2)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 索引单测 | viewport-index.test.ts | 9 | 行区间(顶部/中部/越界/空集)、横轴交叠与 400px overscan 边界、rect 二维联合、1000 rect 可见数随视口增长、overscanYPx 参数语义、常量初值 |
| 画布 viewport | timeline-viewport.test.tsx | 4 | backing 高=视口+2×overscan(100 轨不分配全内容位图,≈520 vs ≈5595)、滚动 top 跟随且不重分配、越顶钳 0、draw 访问量随可见区(单视口 ≤12 clip 体 vs 全量 99) |
| 既有回归 | timeline 系列 5 文件 | 87 | geometry/filmstrip/panel-interactions(17)/redraw(8)/thumbnail-loader——不改断言全过 |
| 全量 | vitest run | 598 | 68 文件全绿(+13 项 vs B16 585) |

## 4. 与实施计划的偏差

- 计划"四层:底图/轨道、clip 缩略图与波形、选中/拖动叠加、播放头;
  dirty flags 决定重画哪些层":实现未拆四个画布——现有架构播放头已
  独立(A06)、叠加元素本就随交互状态按需绘制、本项把"重画哪些"收敛为
  空间可见性(二维裁剪)而非 dirty flags。残余收益(静态层完全不重画)
  依赖 tile 缓存,按计划"先测需要再引入"延后。
- 计划"区间索引按 track 检索可见 clip/caption(行内二分)":第一轮
  落地为全量 rect 单趟精滤(见已知限制)——draw 访问量目标(随可见
  元素增长)已达成,索引数据结构(按 track 分组+行内有序)延后到
  实测证明必要时。
- 计划"editing store 只对订阅 slice 通知":现状 A06 playhead-store
  (useSyncExternalStore 微任务合并)+ App 10Hz 分频已满足播放头零
  主画布重绘/零 App commit 放大(单测锁定);未新增 editing store。
- 滚动条/菜单等"可视区底部"判定从画布高改为内容空间 scrollTop+可视
  高——这是 viewport 化的必然对齐,非行为变化(画布高=视口高时二者等价)。

## 5. 复现命令

```powershell
Push-Location -LiteralPath 'C:\DataFolder\codes\AI-Vidio\apps\desktop'
node node_modules/vitest/vitest.mjs run tests/viewport-index.test.ts tests/timeline-viewport.test.tsx
node node_modules/vitest/vitest.mjs run
pnpm lint
Pop-Location
```
