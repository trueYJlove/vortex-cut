# C20-T2(ready 并行化)实施报告(2026-09-12)

依据:`PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md` §2 C20-T2(已批准)。
前置:S1、C20-T1 已交付。契约零改动(首选无契约方案落实)。

## 1. 根因回顾

C20 v2 A/B §3b:F01 ready 2386→3200ms(+34%)——v2 装配链为
manifest 请求 →(串行)首窗请求 → 契约解析 → 会话创建 → 字体拉取 →
seek,全部串行。"ready <2s" 绝对目标 v1 基线即未达(F02 5.78s),归因
从未分解——本报告交付分段遥测,把分解变成实测可产出的东西。

## 2. 交付内容(全在 Renderer,契约/IPC 零改动)

### 2.1 三层并行化(SyntheticPreview v2 装配块)

1. **窗 0 与 manifest 并行**:窗口请求的**入参不含 manifest_id**(响应
   才携带、仅用于 loadWindow 失配校验)→ 窗 0 请求可在 manifest 前发出。
   只预热窗 0——窗 1 盲发在小源(<300 帧)会越界 400(Core
   `start_frame>=total` 拒绝,`service.py preview_ir_window`);count 固定
   300 由 Core 夹紧到实际帧数。预热请求挂孤儿 catch(装配中断时无人
   消费不产生 unhandled rejection);命中时 fetchWindow 直接复用该在途
   promise,manifest_id 失配校验语义不变。
2. **字幕字体与 manifest 并行**(独立资源,原为装配尾段串行;失败传播
   语义与原实现一致——非 2xx 仍抛 `caption font fetch failed`)。
3. **首窗 ensureRange 与 PreviewSession.create 并行**:ensureRange 只
   **发起**不等待,装配尾部统一 `await ensureReady` 后再 seek;
   seekToFrame 内部的目标窗取窗 await 兜底同步(create 不消费帧数据,
   已核对其无 getFrame/compose 调用)。

安全前提核实:`preview_ir_window` 对 `start_frame>=total` 返回 400、
`frame_count` 夹紧;`windowedFrameSource.loadWindow` 按响应容差装填
(不校验请求/响应 count 相等);manifest_id 失配整体丢弃语义保留。

### 2.2 ready 分段遥测(PerfKind 四段)

`perf-metrics.ts` PerfKind 新增 `ready_manifest` / `ready_parse` /
`ready_window` / `ready_inject`(纯 Renderer 遥测,不动契约文件):

| 段 | 口径 |
|---|---|
| ready_manifest | getPreviewIrV2Manifest IPC 往返耗时 |
| ready_parse | manifest 契约解析耗时 |
| ready_window | ensureRange 发起 → 首屏窗口(0+预取窗)就绪的墙钟(与 manifest/create 段重叠) |
| ready_inject | PreviewSession.create(worker/GL/池装配)耗时 |

**分段有重叠,相加 ≠ ready_ms**——A/B 报告用四段 + ready_ms 定位
F02 5.7s(v1 同样存在)的主导项;遥测关闭时为 no-op。

### 2.3 配套修正(并行化的必要补齐)

- **pip 索引增量并入补齐 seekToFrame**:原装配保证"create 前窗口已就绪",
  pip 索引在 create 时一次建全;并行化后 create 时窗口可能未就绪——
  seekToFrame 取窗完成链 `extendPipOverlayIndex(0, frameCount)`(与播放
  pump 路径 line 845 同型,游标扫描 O(新就绪帧))。v1 路径该调用为
  等价重扫,行为不变。
- 中断路径 `frameSource.dispose()` 补齐(create 后 stale 分支原先只
  dispose session,外部帧源泄漏一次机会)。

## 3. 验证

| 项 | 判定 |
|---|---|
| typecheck / 生产构建(electron-vite build) | 通过 |
| Desktop 单测 | 69 文件 625 项全过(无新增——装配块为 e2e 路径,单测层验证其构成组件:帧源/预算/会话;A/B 轮为行为正确性门) |
| 契约/IPC | 零改动(无契约方案;合并端点未提请,按 Gate 仅在实测不达标时另议) |
| 语义保持 | manifest_id 失配校验、abort/stale、字体失败传播均不变 |

## 4. 验收对照(Gate §3 C20-T2)

| 项 | 判定 |
|---|---|
| v2 ready 相对 v1 退化 ≤5% | **待 A/B 实测**(与 T1 合并一轮;机制上 manifest 与窗 0 重叠 + create 与取窗重叠 + 字体并行,串行链剩余段为 manifest→(max(窗N,create))→seek) |
| ready 分段遥测四段贯通 | 达标(PerfKind 四段;A/B 轮采数) |
| F02 5.7s 归因分解报告 | **待分段遥测实测数据产出**(与 A/B 轮同机产出) |

## 5. 遗留

- v1 路径的字体串行拉取可用同法并行(未动——本轮不动 v1 数据面,
  收益预期 <200ms,登记待 A/B 后按需另立)。
- 契约级合并端点(manifest+窗 0 一次往返)未实施:按 Gate,仅在无契约
  方案 A/B 实测仍 >+5% 时提请契约 Gate。
- 预热的窗 0 请求在 Core 侧与 manifest 各自命中"同源投影缓存"
  (`_ir_v2_bundle`),Core 端投影只算一次;两请求并发到达的投影缓存
  竞争(single-flight 与否)未审——如 A/B 显示 Core 端重复投影开销,
  登记后另行处理。
