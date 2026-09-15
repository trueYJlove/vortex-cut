# A08 实施进度与自检报告（2026-09-09）

## 1. 状态与范围

**A08（轮询、缩略图和转录加载）代码完成 + 功能验证完成。**
独立验收：**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A08，在 A07
（`eb6ab3a`）之上实施，单次本地提交。未 push、未打包。至此第一轮 A01–A08
全部完成，进入 G1 退出条件复测点。

## 2. 修改单（模板）

```text
修改单：A08 轮询、缩略图和转录加载
基线HEAD / 工作树标识：eb6ab3a（A07）；本单单次提交
目标与不修改范围：
  目标——setInterval 轮询改「结束后再 setTimeout」+ 同 endpoint
  single-flight + 内容未变不写 state + 无任务/后台退避 + 前后台恢复即刷；
  转录正文按需加载（摘要优先，并发≤4，项目代次作废迟到写入）；缩略图
  loader 组件作用域化（viewport epoch 取消旧任务、优先级、5s 超时清理、
  rAF 批量通知、bytes 记账）。
  不修改——端点契约、任务订阅优先语义、素材/渲染数据加载、波形管线、
  缩略图绘制（含档位量化与 :any: 兜底）。
实际修改文件（绝对路径）：
  apps/desktop/src/app/request-scheduling.ts（新增）
  apps/desktop/src/app/timeline/thumbnail-loader.ts（新增）
  apps/desktop/src/app/App.tsx
  apps/desktop/src/app/timeline/TimelineCanvas.tsx
  apps/desktop/tests/app-request-scheduling.test.tsx（新增，10 项）
  apps/desktop/tests/thumbnail-loader.test.ts（新增，11 项）
  apps/desktop/tests/app.test.tsx（轮询注入点 + 转录按需加载断言适配）
前置Gate与接口版本：A01/A06 已合入；无跨进程契约变化。
算法/状态机变化：
  - RequestScheduler：端点注册（key/fetch/apply/enabled）；轮询 = 上一轮
    全部结束后再 setTimeout 下一轮（在途期间 timer 到期被 running 守卫
    重排——不叠加请求）；同 endpoint 在途合并（merged 计数）；
    apply 返回 false = 内容未变不写 state（浅比较由调用方签名串承担）；
    间隔 = active(1.5s)/idle(6s) × 失败退避(2^n 封顶 idle)；visibilitychange
    恢复前台立即 refresh 一轮；dispose 停排程。
  - BoundedTaskQueue<T>：FIFO + maxConcurrent（转录 4）+ generation 作废
    （push 捕获代次，执行前/完成时双重拦截）+ dispose 推进代次拦截在途。
  - App 轮询接入：projects/jobs 两端点（models 退出快频——按计划"模型
    列表只在模型事件或较低频刷新"；模型下载进度由任务状态驱动 jobs 端
    点间接刷新）。项目列表签名 = id:updated_at 串；任务签名含 progress。
  - loadProjectData：素材/任务先落 state；转录只取摘要（listTranscripts
    逐素材）；正文不再全量预取——viewTranscript 选中时经队列按需
    getTranscript，已加载内容缓存复用；切项目 advanceGeneration +
    清空 transcripts/viewingTranscript（旧项目迟到结果不写入新项目）。
    AI 粗剪表单"就绪转录"下拉改由 transcriptSummaries(ready) 驱动
    （原依赖全量预取的 transcripts）。
  - ThumbnailLoader（从 TimelineCanvas 抽出的 VideoThumbnailExtractor）：
    组件作用域实例（非全局单例）；请求含 key/url/timeSec/priority/
    viewportEpoch；advanceViewport 取消未开始的旧代次任务（出队时同样
    拦截）；active 任务一个（串行 video 池）；同 key 在途合并（activeJob
    等待者）；loadeddata/seeked 超时 5s（finally 无条件清监听器，坏媒体
    不堵队列）；seek 同 currentTime 直接取帧；完成回调 rAF 批量通知；
    缓存 LRU ≤600 + bytes 记账（w*h*4）；prune 按有效 clipId 清理。
授权、取消、资源所有权、缓存失效规则：
  scheduler/queue/loader 生命周期 = 组件/会话（dispose 全清）；无新增
  IPC/权限面；票据 URL 只进内存不落盘。
新增/修改测试与命令：
  app-request-scheduling（10）：single-flight 不叠加、结束后再排程、
  内容未变不写 state、idle/后台慢频 + 失败退避单调封顶、enabled=false
  跳过（模型退出快频）、dispose 停排程、并发≤4、代次作废（旧项目转录
  不写入）、dispose 清队、异常不堵队列。
  thumbnail-loader（11）：缓存命中不重 seek、在途合并共享结果、视口
  代次取消（50 次滚动无无界排队）、优先级出队、坏媒体超时不堵后续、
  同 currentTime 直取帧、seek 等待 seeked、LRU 上限 + bytes 记账、
  prune、rAF 批量通知、dispose 立即 null。
  旧测试适配：app.test 轮询用例改 setTimeout 注入点；404 用例补
  "查看转录"chip 点击（按需加载）；AI 粗剪下拉断言随 summaries 驱动。
  命令：vitest run（desktop 全量）、tsc --noEmit、pnpm lint/build。
功能回归结果（含跳过）：
  Desktop 56 文件 467 项全绿（+21 新增）；pnpm typecheck/lint/build 通过。
before / after / 同机环境：
  计数断言：慢后端下同端点在途恒 1（旧行为每 1.5s 无条件叠加新请求）；
  转录正文加载数 = 用户查看次数（旧行为 = 每素材每 ready 全量）；快速
  滚动 50 次缩略图在途 ≤1 + 队列有界。p95 轮询延迟/字节节省正式数据由
  B00 诊断入口在性能验证阶段采集。
质量与失败路径验证：
  测试驱动发现并修复 3 处实现/语义缺陷：BoundedTaskQueue dispose 未拦
  在途结果（补代次推进）；ThumbnailLoader 同 key 在途合并在 activeJob
  上失效（queue.find 之外的等待者接入）；超时测试暴露 awaitEvent 的
  load 阶段与就绪恢复时序（runJob 同 URL 跳过 load 的正确性得到验证）。
开关、兼容与回退验证：
  RequestScheduler/BoundedTaskQueue 均为纯增量模块（不使用即旧行为）；
  转录正文按需加载为行为变化（旧全量预取移除）——UI 断言已随新语义
  适配；缩略图绘制路径（drawTimeline 消费端）未变。
已知限制、未解决问题：
  - AI 粗剪候选轮询（listCandidatePlans 1.5s）保留原 setTimeout 链
    （任务订阅 + 短期轮询语义，A08 调度器未接入——该路径有 job 订阅
    主导，轮询仅兜底；统一接入待后续需要时扩展）。
  - 波形加载（fetch + decodeAudioPeaks）仍内联在 TimelineCanvas
    （B14 素材级持久化波形将整体迁移，本单不动）。
  - jobs 轮询端点在项目切换时随 effect 重建（1.5s 内的新项目首轮可能
    多一次 listJobs——single-flight 与签名短路保证无状态污染）。
  - visibilitychange 兜底在 jsdom 不触发（测试以手动 refresh 覆盖语义）。
开发者自测：通过（见上）。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步：G1 第一轮退出条件复测（A01–A08 功能断言齐全；
F01 短项目回归 + F02 IR 同机复测 + 探针开销对照由 B00 诊断入口执行）
——复测通过后进入第二轮 B10。
```

## 3. 测试证据摘要

- `app-request-scheduling.test.tsx`：10 项通过（FakeClock 驱动的调度语义）。
- `thumbnail-loader.test.ts`：11 项通过（StubVideo 协议桩）。
- Desktop 全量：56 文件 / 467 项通过（43.3s）。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。

## 4. 与实施计划的偏差

- 计划"任务订阅优先，1.5s 轮询保留为活跃任务兜底"落地为 jobs 端点常驻
  调度（活跃任务时快频 1.5s，无任务/后台退避 6s）；任务完成推送仍走
  subscribeJob（未改）。
- 计划"模型列表只在模型事件或较低频刷新"落地为完全退出轮询（模型数据
  静态于会话内；下载进度经 jobs 端点间接可见）——比计划更保守。
- 计划"loadProjectData 首先返回素材/任务/摘要"落地为摘要优先（素材/
  任务/转录摘要同轮返回）；转录正文选中加载。
- 计划"seek同currentTime时允许直接取当前已就绪帧"在 loader 的 runJob
  中实现（阈值 1e-4 秒）。
- 缩略图请求字段中的 assetKey/sourceTime/sizeBucket 由组合键 key 与
  timeSec 承载（档位帧数已含于 key）；content generation 由 media URL
  （票据变更即重建）承担。
