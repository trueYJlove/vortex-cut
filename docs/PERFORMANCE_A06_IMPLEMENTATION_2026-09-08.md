# A06 实施进度与自检报告（2026-09-09）

## 1. 状态与范围

**A06（Canvas 最小失效范围）代码完成 + 功能验证完成。**
独立验收：**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A06，在 A05
（`16f1509`）之上实施，单次本地提交。未 push、未打包。

## 2. 修改单（模板）

```text
修改单：A06 Canvas 最小失效范围
基线HEAD / 工作树标识：16f1509（A05b）；本单单次提交
目标与不修改范围：
  目标——播放头拆独立 DOM 覆盖层（播放期间主画布零重绘）；canvas 尺寸
  赋值前比较 backing size；用户 seek 独立 command（source + 递增请求 ID）；
  App 传 TimelinePanel/SyntheticPreview 的数组/Map 稳定化（useMemo）。
  不修改——时间轴编辑语义、命中测试几何、缩略图/波形管线、固定标尺
  交互、右键菜单语义、预览会话生命周期。
实际修改文件（绝对路径）：
  apps/desktop/src/app/timeline/playhead-store.ts（新增）
  apps/desktop/src/app/timeline/TimelinePlayheadLayer.tsx（新增）
  apps/desktop/src/app/timeline/TimelineCanvas.tsx
  apps/desktop/src/app/App.tsx
  apps/desktop/src/app/preview/SyntheticPreview.tsx
  apps/desktop/src/styles.css
  apps/desktop/tests/timeline-redraw.test.tsx（新增）
  apps/desktop/tests/timeline-panel-interactions.test.tsx（props 适配）
  apps/desktop/tests/track-head.test.tsx（props 适配）
前置Gate与接口版本：A01–A05 已合入；无跨进程契约变化。
算法/状态机变化：
  - playhead-store：每编辑器实例（App useRef 持有；TimelinePanel 未注入时
    自建兜底）。getSnapshot 返回缓存 primitive；set 值不变不通知，变化经
    微任务合并派发（一帧多次 set 只通知一次）。dispatch 携带 source
    （playback/user/external）与递增 requestId。
  - 播放头绘制从 drawTimeline/drawRulerStrip 移除（含 drawPlayheadHandle
    常量），改为 TimelinePlayheadLayer（absolute + transform:translateX，
    pointer-events:none，z-index 7 位于固定标尺之上）；坐标约定 = 主画布
    语义 + headerWidth（覆盖层原点在 timeline-body，与固定标尺的
    2*headW 对齐规则一致）。
  - SyntheticPreview session.onTimeUs：每帧直写 store（覆盖层按帧率跟随），
    React 上报仍 10Hz 节流（App commit 频率不随 rAF 提升——验收指标）。
  - App：seekFromUser（立即同步 React + dispatch user）/seekFromPlayback
    （store 直写 + 10Hz React）/dispatchPlayhead；交互预览 100ms 时钟改走
    store 读取（不再 setState 闭包链）；方向键/进度条 seek 走 user 源。
  - 尺寸守卫：主画布与固定标尺 backing width/height/style 赋值前逐一比较，
    值相同跳过（避免等值赋值清空画布状态）。
  - 几何稳定化：clipRects/captionRects/transitionRects/ticks 改 useMemo；
    drawTimeline 的 playheadUs 参数移除；播放头相关交互（吸附候选、右键
    拆分校验）改 store 即时读取。
授权、取消、资源所有权、缓存失效规则：
  store 生命周期 = 编辑器实例（App 卸载随之释放，无全局单例泄漏面）；
  覆盖层无事件监听；无新增 IPC/权限面。
新增/修改测试与命令：
  tests/timeline-redraw.test.tsx（8 项）：store 通知合并/幂等/请求 ID、
  覆盖层位移与素材终点钳制、头列外不渲染、播放 300 帧主画布 draw ≤2
  （模拟"静态时间轴播放 10 秒"验收）、同尺寸重渲不重赋 backing size。
  既有 timeline-panel-interactions / track-head 测试移除 playheadUs props。
  命令：vitest run（desktop 全量）、tsc --noEmit、pnpm lint/build、
  pytest services/core/tests/unit -m 'not real_provider'。
功能回归结果（含跳过）：
  Desktop 54 文件 446 项全绿（+8 新增）；Core 470 项全绿；lint(tsc) 与
  vite build 通过。无跳过新增项。
before / after / 同机环境：
  jsdom 计数断言：播放 300 帧期间主画布 drawTimeline 调用 0 次（≤2 门内）
  ——改造前每 10Hz playhead 变化触发一次全量重绘（含 clipRects/ticks 重算
  + 全部缩略图重画）。App 层正式 p95 拖动/绘制延迟指标按计划由 B00 诊断
  入口在性能验证阶段采集（本单完成代码与功能验证）。
质量与失败路径验证：
  测试发现并修正 1 处期望值错误（timeToX 头列偏移双计）；尺寸守卫的
  setter 拦截在 jsdom 属性描述符缺失时跳过（不阻塞）。
开关、兼容与回退验证：
  TimelinePanel 的 playheadStore 为可选 prop（未传自建）——旧调用方/测试
  行为自洽；SyntheticPreview 的 playheadStore 可选（未传回落 10Hz-only
  上报，与 A05 前行为一致）。
已知限制、未解决问题：
  - 字幕条的"播放头驻留高亮"不再随播放逐帧重绘（isActive 收敛为
    isSelected）；选中字幕仍保留较强外观。按计划"播放头变化不重建几何"
    的取舍，正式视觉裁决留 UI 评审；如需驻留态可在 B17 分层时以轻量层
    恢复。
  - 覆盖层与固定标尺共享 2*headerWidth 坐标约定（drawRulerStrip 既有
    规则），未做常量提取；B17 二维分层时统一。
  - 1000 clip 拖动/滚动 trace 对比、DPR 矩阵实测属性能验证阶段（B00 入口），
    本单以计数断言覆盖结构语义。
  - 交互预览 100ms 时钟手势冻结（gestureHold）语义保留在 App 播放通道；
    store 写入不经手势判定（合成预览手势期间 session 自身暂停上报）。
开发者自测：通过（见上）。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步：A07（probe/编码能力缓存，Core）按计划推进。
```

## 3. 测试证据摘要

- `tests/timeline-redraw.test.tsx`：8 项通过（含 300 帧播放 draw≤2 断言）。
- Desktop 全量：54 文件 / 446 项通过（36.9s）。
- Core 全量 `-m 'not real_provider'`：470 项通过（119.9s）。
- `pnpm typecheck`、`pnpm lint`（tsc noEmit）、`pnpm build`（vite 产物正常）通过。

## 4. 与实施计划的偏差

- 计划第 2 条"PlayheadStore 在每编辑器实例创建"落地为 App 拥有 + 组件可选
  自建兜底（保持测试/独立使用零成本），非全局单例要求满足。
- 计划第 3 条"预览每帧写轻量层；App 时间文本/外部状态仍 10Hz"落地为
  store 直写 + onTimeUs 10Hz 节流双通道；交互预览（无合成会话）维持
  100ms 时钟直写 store+React（本身即 10Hz）。
- 计划第 4 条"用户 seek 为独立 command，不与播放回传互相触发"实现为
  source 语义 + requestId 单调递增；播放回传作废判定依赖请求 ID 比较，
  App 侧当前消费者为进度显示（无回环写），作废逻辑主要服务后续模块
  （A08/B15 拖动优先级）。
- 字幕播放头高亮语义调整（见已知限制第 1 条）——计划未明示该细节，按
  "播放头变化不重建几何"目标取舍并披露。
