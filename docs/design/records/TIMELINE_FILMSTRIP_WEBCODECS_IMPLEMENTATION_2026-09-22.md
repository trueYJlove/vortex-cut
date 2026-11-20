# 时间线抽帧 WebCodecs 化（filmstrip 解码链）实施报告

日期：2026-09-22 ｜ 分支：ai/stability-polish ｜ 状态：已完成（Desktop 701 测试全绿）

## 1. 动机

时间线轨道上视频素材的抽帧条（filmstrip）原实现（A08）用一个隐藏 `<video>`
元素串行 seek 抽帧：每帧一次完整 seek 管线（关键帧间隔 2–5s 的长 GOP 素材
单帧 seek 极慢），且无流水线——大素材首次挂上时间线时肉眼可见"一帧一帧蹦"。

本次将视频抽帧切换到 WebCodecs 硬解 + Range 字节源（复用合成预览已验证的
底层件），对同一素材的连续抽帧形成近似一次线性解码 pass（每 GOP 只解一遍），
预期常见场景 10–50 倍提速。

附带修复（同分支前一提交）：`ThumbnailLoader` 以渲染期 ref 惰性初始化 +
effect dispose 的组合在 React StrictMode（dev）双挂载下会把唯一实例 dispose
掉——dev 模式视频抽帧永不显示而安装版正常。持有方式已改为 state + effect
创建/清理。

## 2. 架构

```
TimelineCanvas（绘制不动；request 补传 assetId）
  └─ ThumbnailLoader（调度骨架保留：队列/优先级/epoch/合并/prune/批量通知）
       └─ 每素材 FrameSource（上限 2，LRU 驱逐 + 空闲 20s 释放）
            ├─ FilmstripSource（首选）→ FilmstripWorkerClient → filmstrip-worker.ts
            │    共享 preview 的 bmff-demux / sample-index / range-source；
            │    WebCodecs prefer-hardware；worker 内缩图 ≤160px 回传 ImageBitmap
            └─ VideoSeekFrameSource（回退）→ 隐藏 video 串行 seek（原 A08 路径）
```

### 关键设计决策

- **专用 worker 而非复用 decode-worker.worker.ts**：预览 worker 按"帧号×fps"
  寻址且有 33ms 容差拒绝、回传全分辨率 VideoFrame——直接复用要么改预览协议
  （回归风险）要么浪费主线程缩放开销。filmstrip-worker 按缩略图语义设计：
  按微秒寻址（`decode-at {timeUs}`，最近采样、无容差拒绝）、worker 内
  `createImageBitmap` 缩图回传（VideoFrame 不出 worker）。
- **解码器状态机纪律照搬**：GOP 锚帧持有、中间帧延迟关闭环（D3D11 表面池
  复用竞态）、冷启整例重建（reset 残留花屏）——全部来自
  decode-worker.worker.ts 的实证结论（evidence/m3_2/playback-repro）。
- **免费的线性 pass**：不改调度——FIFO 出队顺序 = 单片段格子从左到右 =
  源时间单调递增，解码器顺流而下（顺播游标 O(1) 均摊）。倒放片段源时间
  递减，逐格按 GOP 冷启（与旧路径成本相同，无回归）。
- **纯函数定位**（`nearestSampleUs`）导出供单测；worker 内串行队列一次一个
  请求（单解码器状态机约束，与预览 worker 相同）。

## 3. 票据策略

素材票据（aivideo://）TTL 5 分钟。抽帧任务的票据保障：

1. **开工前领新票**：`FilmstripSource.create` 经新 IPC `asset:media-ticket`
   重签（主进程 `restrictedMediaUrl`：已注册路径纯内存签发零网络，未注册才
   走带退避的 Core resolve）。5min 窗口对准抽帧任务。
2. **中途失败恢复**：Range 失败（含过期 404/401/403）→ 重签一次 → 重建
   worker → 重试该请求一次；再失败按失败处理（不环，`retried` 一次性标志）。
3. video 回退路径沿用素材列表签发的票据（行为与旧版一致）。

新 IPC：`asset:media-ticket`（main `index.ts` + preload `assetMediaTicket`）。
与 `asset:refresh` 的区别：不触发 Core 侧素材重扫，纯票据重签。

## 4. 降级矩阵

| 场景 | 行为 |
| --- | --- |
| Worker/VideoDecoder 不可用（环境缺失） | 工厂抛错 → video seek 路径（按素材记忆，不反复尝试） |
| 编解码不支持（BMFF 解析失败/非 AVC 等） | init error → 同上 |
| filmstrip 工厂返回 null（测试/显式禁用） | 同上 |
| Range 源 401/403/404（票据过期） | source 层重签一次重建重试；仍失败该帧跳过 |
| 解码器运行时错误 | worker 内 reset+reconfigure，该帧返回 error → null（不堵队列） |
| 同素材并发请求 | 上一帧在途时丢弃本轮（上层 effect 重跑会补） |

## 5. 内存与资源

- 帧缓存不变：仍为 ≤160px canvas（每帧 ≈57KB，600 条上限 ≈35MB）。
- worker 内无帧缓存；ImageBitmap 画到 canvas 后立即 `close()`。
- 活跃源上限 2（LRU 驱逐非在用源）；空闲 20s 自动 terminate
  （解码器 + Range 字节缓存 8MiB/源 不常驻）。
- 与预览会话并存时同素材最多双解码器（各自独立 Range 源），可接受。

## 6. 测试与验证

- `tests/filmstrip.test.ts`（新增 13 条）：纯函数（bitmapSizeFor/
  nearestSampleUs 的命中/最近/并列/越界/空索引）、FilmstripSource 契约
  （decode-at→canvas、领票时序、失败重签重建重试一次、不环）、loader 分源
  （同素材单源顺序 pass、降级记忆、创建抛错降级、上限驱逐、空闲驱逐）、
  FilmstripWorkerClient 消息协议（init→ready 握手、bitmap 回传、init 失败
  终止）。
- `tests/thumbnail-loader.test.ts` 既有 11 条全绿（调度骨架未变；video 回退
  路径行为保持）。
- 全量：`pnpm typecheck` 通过；desktop `pnpm test` 80 文件 701 测试全绿。

### 手工验证要点（待用户 `pnpm dev`）

- 大素材首次拖入时间线：抽帧应"整条快速出完"而非逐帧蹦。
- 缩放/滚动：命中帧缓存即时渲染；跨档位重抽可见渐进替换（`:any:` 兜底）。
- 预览播放/AI 助手无回归（预览路径零改动）。

## 6.1 遗留问题修复（2026-09-23）

用户实测反馈三项问题，前两项本次修复：

1. **抽帧内容与实际不匹配（问题1，根因在 worker 喂包区间）**：
   `decodeSamples` 热态顺序路径把喂包起点设成 `startSample = target`——
   只喂目标采样本身。抽帧格间跳 ~14 采样（44px 格 @94pps/30fps），目标
   P 帧的中间参考帧从未进解码器 → 错误参考上做错误隐藏，产出"时间戳对、
   内容错"的帧，整条抽帧与实际内容错位。预览 worker 同构代码在 1x 播放
   下 target 恒等于 fedIndex+1（无跳格）所以从未暴露——注释设计意图本就是
   "顺序喂入中间采样"，filmstrip 复刻时只带了条件、丢了喂区间。
   修复：抽出纯函数 `planDecodeRange`——顺序路径喂 [fedIndex+1, target]
   闭区间（中间参考帧逐个进解码器，中间输出仍走延迟关闭环，成本不变：
   字节读取与解码本是每帧必经）；跨 GOP/回退路径不变（关键帧冷启重建）。
   单测锁：`tests/filmstrip.test.ts` planDecodeRange 条目。
2. **拖标尺触发抽帧刷新（问题2，根因是上一轮加的 :ph 机制）**：scrub
   落定 250ms 后把播放头所在格重抽为播放头精确帧并覆写缓存——慢拖时每次
   停顿都逐格替换，观感即"标尺拖过去之后那个位置刷新"。剪映无此机制：
   格内容恒为格中心采样。修复：整体移除 `:ph` 重抽 effect 与
   `playheadSettledVersion` settle 信号。
3. **缩放后抽帧消失只剩一帧（问题3，上轮已修，本次复核确认）**：档位
   淘汰按轮次计票（连续 3 轮非当前档才淘汰，缩放动画期间不误删新档帧）；
   `:any:` 别名带档位（clipId:any:frameCount:fi，跨档位不再错误复用）。

## 7. Follow-up 登记

1. **restricted-media 404/401 语义失配**：过期票据返回 404，而 B12 续票链
   （range-source `requestWithRefresh`）只对 401/403 触发——预览长会话
   （>5min）票据过期实际不会续票。本次抽帧用"主动重签 + 失败重建"绕开，
   预览路径的原问题仍在，建议后续统一（过期返回 401 或改主动续签）。
2. **Core 派生 filmstrip 产物**（推荐路线第 2 点）：仿 waveform 模式加一种
   派生 kind，ffmpeg 生成缩略帧序列内容寻址持久化——冷启动首轮即有图。
   本方案的 Renderer 侧缓存与其共存（WebCodecs 先出图、产物落地后下次秒开）。
3. `preview/range-source.ts` 头注释声称"401/403 有限一次刷新"覆盖 TTL 过期
   场景，与实际 404 行为不符（见 1），注释待统一修正。

## 8. 变更清单

| 文件 | 变更 |
| --- | --- |
| `src/app/timeline/filmstrip-worker.ts` | 新增：抽帧专用 worker（demux/解码/缩图/续票桥） |
| `src/app/timeline/filmstrip-source.ts` | 新增：FilmstripWorkerClient + FilmstripSource（FrameSource 契约、重签重试） |
| `src/app/timeline/thumbnail-loader.ts` | 重构：FrameSource 分源调度（骨架保留）、VideoSeekFrameSource 迁入、源上限/空闲驱逐 |
| `src/app/timeline/TimelineCanvas.tsx` | request 补传 assetId；loader 接默认 filmstrip 工厂；StrictMode 修复（前一提交） |
| `electron/main/index.ts` | 新增 `asset:media-ticket` IPC |
| `electron/preload/index.ts` | 新增 `assetMediaTicket` 通道 + 类型 |
| `tests/filmstrip.test.ts` | 新增 13 条 |
| `tests/thumbnail-loader.test.ts`、`tests/{app,editor-shell,editor-commands}.test.tsx` | 适配（assetId 必填、mock 补通道） |
