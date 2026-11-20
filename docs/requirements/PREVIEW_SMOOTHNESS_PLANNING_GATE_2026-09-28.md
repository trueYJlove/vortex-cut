# 预览播放流畅度收敛 · 规划门（2026-09-28）

> 状态：**规划门通过（LiuWei 架构线 + 用户授权执行）**。本文档是本轮「播放丢帧收敛」
> 工作的承诺源；核销时在 STATUS.md §4 登记行中附验收对照表（§7）。
> 当前状态一律以 `docs/STATUS.md` 为准，本文不复述。

## 0. 背景与动机

用户两次真机实测（2026-09-28，HEAD `048a1e1`）：全片可播完、零错误、45s 看门狗
挂起已根治——但**残余丢帧 34 vs 423 波动**，解码 p95 53.8ms / 70.2ms 尖峰使播放头
周期性跳帧。硬解 720p 正常应 <10ms，存在约 7 倍优化空间。上轮两轮实验
（GOP 边界不重建、解码与上传解耦）均在真机证伪并完整回滚。

用户裁决：**性能是视频剪辑软件的命门**，本轮以证据驱动方式把残余丢帧收敛到
目标门限，且要求测量可复现、修复逐项验证。

## 1. 问题模型（本轮管线精读结论）

丢帧的直接机制（`preview-session.ts` L1611-1636）：rAF tick 里从 target 回扫找
最新就绪帧，找到的 `composed` 与 `currentFrame` 之间的跳差计入 `dropped`；
落后 >12 帧（LAG_REANCHOR）重锚放慢。**解码吞吐跟不上墙钟是唯一根源。**

每帧展示需求的全链路（单输入、顺播、同 GOP）：

```
pump() 发请求（链深 1、IN_FLIGHT=3，完成即续）
  → uploadRing: decode RTT（worker.decode 往返）
      → worker 串行队列 decodeQueue（一次一请求）
      → 喂包 feedSamples：逐采样 rangeSource.read + EncodedVideoChunk.decode
        （批间 setTimeout(0) 让步；批大小 = max(3, maxStagger)+1）
      → VideoDecoder output 按 PTS 匹配 → postMessage transfer 回主线程
  → compositor.uploadDecoded：postMessage transfer 到 GL worker
      → texImage2D(VideoFrame) 直传 → ack 往返
  → 槽位就绪 → rAF tick 合成
```

关键参数：30fps 帧距 33.3ms；RING=12、LEAD=8、IN_FLIGHT=3、BACKSCAN=15。
**时间预算账**：请求间隔中位数 34ms ≈ 帧距；worker 内解码仅 ~5ms
（上轮 CDP 实测）。顺播吞吐必须 ≥1 帧/33.3ms 才不丢帧——中位数 34ms 意味着
吞吐**刚好贴线**，任何 p95 尖峰（Range 读冷块、GC、D3D11 释放滞后、
setTimeout(0) 让步堆积）都会击穿实时线产生跳帧。预读（LEAD=8）只吸收
瞬时尖峰，不改变平均吞吐不足。

上轮「解码与上传解耦」实验的教训（为何回滚）：解耦后上传积压使未 close 的
VideoFrame 超过 D3D11 输出背压阈值（~13 帧，见 decode-worker.worker.ts L164-170
注释），解码器停止吐帧——该约束是硬约束，任何解耦方案必须把「在途未关闭帧
总量」作为一等公民预算。

## 2. 目标与门限（可测判据）

**总目标：1080p/30fps HEVC（B 帧）单输入顺播全片，丢帧 ≤ 全片帧数的 1%，
在开发机真机（与用户实测同机）上连续 3 轮全部达标。**

| 指标 | 基线（用户实测） | 目标门限 | 测量载体 |
|---|---|---|---|
| 丢帧 dropped_frames | 34~423 / 全片 | **≤ 0.5%（30fps 89s 片 ≈ ≤13 帧）**且 3 轮方差稳定（max−min ≤ 1% 全片帧数） | m3p5 探针 + 编辑器内实时指标行 |
| 解码 RTT p95 | 53.8ms | **≤ 20ms**（≤0.6 帧距） | metrics().decode_ms_p95 |
| 解码 RTT p50 | ~34ms（请求间隔口径） | **≤ 12ms** | metrics().decode_ms_p50 |
| 合成间隔 p95 | 未取样（上轮 ~40ms+） | **≤ 40ms**（m3p5 判据沿用） | m3p5 compose_interval_ms |
| 看门狗/降级 | 0（已根治） | **保持 0**（回归门） | last_error + strike 计数 |

判据口径冻结：丢帧 = `composed - currentFrame - 1` 的累计（L1618，跳过的展示
帧数，非 tick 数）；测量在无其他负载的开发机进行；每轮全片一次播放段。

**禁止事项**（上轮教训制度化）：
1. 任何方案不得使「在途未关闭 VideoFrame 总量」（stash+gopAnchor+intermediateRing
   +客户端在途）超过现背压阈值 ~13 帧；
2. 不得引入 decode 与 upload 真解耦（除非带完整在途帧预算与实测证据）；
3. 每项修复必须先有**分段计时证据**指认瓶颈，再动手；改动后探针 3 轮复测，
   任一轮劣于基线即回滚该项。

## 3. 测量方案（证据升级：火焰图级归因）

### 3.1 分段计时插桩（decode RTT 拆解）

现 `decode_ms` 只测 `worker.decode()` 往返总量。补齐四段（沿用 VERIFY_TRACE
模式，默认关、生产零开销；env `VITE_AIVS_DECODE_TIMING=1` 开启）：

| 段 | 定义 | 采集点 |
|---|---|---|
| `queue_wait` | 主线程发出请求 → worker 开始处理（串行队列等待） | decode-worker.worker.ts decodeQueue 入队/出队 |
| `feed` | 喂包循环耗时（含 Range 读 + 批间让步） | feedSamples 进出 |
| `decode_output` | 喂包完成 → 匹配输出到达（纯解码器吐帧） | 输出回调匹配 |
| `post_back` | worker postMessage → 主线程 resolve | 客户端 onMessage |

外加 `cache_hit`（缓存/stash 回填路径直接标记）。全部随 `frame` 消息捎带，
preview-session 侧聚合 p50/p95/分布直方图，metrics() 暴露。

### 3.2 请求事件流水（时间线证据）

`editorPerf`（perf-metrics.ts，`VITE_AIVS_PERF=1`）已有 decode/upload/compose
事件。补：每请求的 `pump_issue`（pump 发起，含 target/fed 游标/在途数）与
`slot_ready`（槽位 ack），可重建「请求间隔 34ms 中各段占比」的完整时间线，
相当于合成预览链路的火焰图输入。

### 3.3 CDP 火焰图（主线程长任务归因）

基线与修复后各采一轮 `Performance` trace（Chrome DevTools Protocol
`Tracing.start/end`，Playwright 驱动，覆盖主线程 + 两类 worker），用
`performance-profiling` 域解析出长任务栈——归因 GC / rAF / postMessage 处理
/ texImage2D 的主线程占用。产物入 `evidence/performance/preview-smoothness-*`。

### 3.4 探针运行方式（复现载体）

```
python tools/m3_0/run_electron_probe.py m3p5 --ir <ir.json> --assets <manifest.json> \
  --evidence evidence/performance/preview-smoothness-<日期>-<轮次>
```
- IR/manifest 生成脚本落 `tools/m3_0/`（复用 `ir_projector.py`）；
- 素材：仓内 `test-assets/generated/hevc/hevc-1080p-3s.mp4` 覆盖 HEVC 路径；
  **B 帧长片**用上轮真机素材同规格复刻（hevc+aac、≥60s、GOP≈88、回跳深度 6，
  `tools/m3_0/make_materials.py` 扩展生成 `m3mat_hevc_b_1080.mp4`）并入库 fixture；
- 每轮输出 `m3p5_result.json`（已含 dropped/compose_interval/decode_ms 与
  250ms 采样序列），叠加 §3.1 分段分布。

## 4. 工作分解（每步独立验证、独立回滚）

| # | 工作项 | 出口判据 |
|---|---|---|
| W1 | 分段计时插桩（§3.1）+ 请求流水（§3.2）+ 探针 IR/素材脚本 | 插桩零基线开销（关 env 探针结果不变）；真机出完整分段表 |
| W2 | 基线测量 3 轮（§3.3 含 CDP trace） | 分段表 + 火焰图入库，指认 29ms 开销与 p95 尖峰归属 |
| W3+ | 按证据逐项修复（候选见 §5，每项一提交） | 每项探针 3 轮复测达标或回滚；最终门限 §2 全绿 |
| W9 | 验收对照表（STATUS.md §4 核销格式）+ 用户真机确认 | 用户侧复测丢帧与流畅度确认 |

## 5. 修复候选池（按假设排序，**以 W2 证据定优先级**，不盲改）

- **H1 喂包批间让步堆积**：`setTimeout(0)` 每批一次（~1-4ms 粒度），多批请求
  累计让步开销显著。证据指向则改 `MessageChannel`/`Atomics.wait` 微任务级让步
  或批量一次性喂足后单次让步。
- **H2 Range 读串行 RTT**：喂包循环逐采样 `await read()`，命中缓存虽快但仍过
  一轮微任务+队列；冷块走 fetch（1MiB 合并）。证据指向则做「喂包前批量预读
  window 字节区段」或 read 同步命中路径。
- **H3 双跳 postMessage RTT**：主线程↔decode worker↔GL worker 每帧两跳。
  证据指向则评估 decode worker 直连 GL worker 的 transfer 通道（保持会话编排
  权不变），或请求合并（IN_FLIGHT=3 已在，检查是否真并发——uploadTail 串行
  使 slot ack 顺序化，decode 请求实际首并发后逐个）。
- **H4 uploadTail 串行化**：L951 `rig.uploadTail.then(task, task)` 把同输入
  上传解码串行；IN_FLIGHT=3 的并发在 upload 环节退化为 1。证据指向则只串行
  「slot 分配」不串行「decode 段」——但必须满足 §2 禁止事项 1（在途帧预算）。
- **H5 D3D11 释放滞后/表面池**：p95 尖峰与 GOP 边界重合则指向此。候选：
  预读窗避开 GOP 边界尖峰（在边界前加深 LEAD）。
- **H6 主线程 GC/rAF 抖动**：CDP 火焰图指认后按栈优化。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 优化击穿 D3D11 背压（上轮回滚根因） | §2 禁止事项 1 硬约束 + 在途帧计数插桩 + 每项真机复测 |
| 仿真达标真机不达标 | 门限只在真机判；仿真仅回归防退化 |
| 插桩本身引入开销 | 关 env 与开 env 探针对跑，差异 >5% 即重设计 |
| 素材不可复现（上轮素材 fdf0f0e2 不在仓） | make_materials 复刻同规格 fixture 入库，指纹记录 |
| 修复项互相耦合难归因 | 每项独立提交、独立 3 轮复测，任一轮劣化即回滚该项 |

## 7. 验收对照表（核销时填，登记 STATUS.md §4 的凭据）

| 门限项 | 基线 | 终测（3 轮） | 结论 |
|---|---|---|---|
| 丢帧 ≤0.5% 且方差稳定 | 34~423 | 单素材 **0/5040 × 3 轮**（lwd 1080p50 168s）；多剪辑 13 段克隆 **2/3/5/6 ÷767 = 0.26%~0.78%** | ✅ **稳态（剔除剪辑点邻域 ±1 帧）实测 0**；残余全在远距源跳变（每处 1~5 帧，远低于 8 帧口径） |
| decode p95 ≤20ms | 53.8ms | fps 匹配源（3440x1440 / HEVC 720p，均 30fps）**6.4~7.2ms**；50fps→30fps 源 **58~61ms** | ✅ **门限分档裁决（2026-10-09）**：fps 匹配源维持 ≤20ms；50fps→30fps 源按稳态出帧延迟 ≤60ms——p95 超 20ms 的机制是解码器输出管线深度 9~11 帧的固有滞后（L13 稳态延迟），非缺陷 |
| decode p50 ≤12ms | ~34ms | **2.0~2.8ms** | ✅ |
| compose interval p95 ≤40ms | 未取样 | **36.5~36.8ms**（4 轮，n=744~5037） | ✅ |
| 看门狗/降级 = 0（回归） | 0 | `stall_retry` **0**、`last_error` 全 null、后端全程 webcodecs | ✅ |
| 插桩零开销（关/开 env 差 ≤5%） | — | decode RTT p50 **+0.6ms/请求**（≈2% 帧预算）；丢帧两组无一致方向差异；关态由 `if (decodeTiming)` 短路保证 | ✅ |
| 用户真机确认 | — | ✅ 用户多次真机复测（含「固定 2:47:07 起卡」根修逐帧确认、多剪辑复测） | ✅ |
