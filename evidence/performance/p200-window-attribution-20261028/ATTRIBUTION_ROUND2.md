# P200 第二轮：对 P196 原始证据的再分析（2026-10-28）

> 状态源一律引用 `docs/STATUS.md` §4 **P200**；本文只记录分析事实，不声明工程状态。
> **本轮零成本**：完全基于已入库的 `app-drop-p196-*.json`，未跑任何新测量。

## 0. 结论先说

根因**仍未定**。但本轮**排除了四个方向**，并把搜索面收窄到一处
（`unmatched_near` + `near_repeat_substitute` 的产生路径）。

## 1. 排除：主线程饱和（证伪上一轮的假说）

| 指标 | 实测 |
|---|---|
| `long_task` 事件总数 | **2** |
| 时长 | 57ms / 59ms |

主线程若真被占满 2–12 秒，`PerformanceObserver` 的 `longtask` 必然留痕。
⇒ 第一轮提出的「Promise 回调排队导致 `window_fetch` 墙钟被撑大」**不成立**。

## 2. 排除：并发与额度压力

`window_fetch` 事件共 46 条。**`request` 字段实为 `startFrame`**（第一轮我曾误读为
状态码，此处更正）。全部满足 `request == frame`，**没有任何 `-1`（拒发）/
`4`（放弃）/`5`（迟到）**。

⇒ 无并发堆积、无在途额度耗尽。

## 3. 排除：`reanchor` 作为放大器（推翻我自己的假设）

`apps/desktop/src/app/preview/preview-session.ts:2147-2161`：

```ts
this.currentFrame = reanchorTo;
this.anchorFrame = reanchorTo;
this.anchorWall = now;
```

**只挪播放头三行，不触碰任何 worker、不重建解码链。** 其注释写明它是「饥饿护栏」——
用于**避免**「目标无限狂奔、丢帧按 tick 线性堆积（旧实现冻结+丢帧 404 的直接根源）」。

⇒ 第一轮称其「无条件重建解码链」**是错的**。

## 4. 自我更正：绝对次数对比是误导

| | 对照组 | 长跑组 |
|---|---|---|
| 运行时长 | 41.4 s | 862 s |
| `cold_start` 绝对次数 | 1 | 1808 |
| **`cold_start` 速率** | **0.02 /s** | **2.1 /s** |

第一轮写「×1808」——但必须按速率比，**约为 100 倍**。

而 `decode-worker.worker.ts:437` 的注释记载了历史先例：**41s 内 `cold_start` 2251 次
（≈50/s）**。⇒ **长跑组的 `cold_start` 绝对次数并不异常**，用它解释崩溃是错的。

## 5. 真正的异常只剩一个

| | 对照组 | 长跑组 | 倍数 |
|---|---|---|---|
| **`output_p50`**（解码器吐帧滞后） | **1.9 ms** | **45.6 ms** | **×24** |
| `output_p95` | 22.3 ms | 245.6 ms | ×11 |
| `feed_p50/p95` | 0 / 0 | 0 / 0 | — |
| `queue_p50/p95` | 0 / 0.1 | 0 / 0.1 | — |
| `residual_p50/p95` | 1.2 / 3.6 | 0.5 / 6.8 | — |

**同一素材、同一 GOP、同一硬件解码器（`webcodecs` + `prefer-hardware`）。**

码流实测（`ffprobe`）：
- `h264` High，3440×1440，30fps，22.47 Mbps
- **`has_b_frames = 0`** ⇒ 重排深度不是成因
- 关键帧每 **5.000 s（150 帧）** 一个，全片 9 个关键帧

## 6. 搜索面收窄

| 计数 | 对照组 | 长跑组 |
|---|---|---|
| `unmatched_near` | **0** | 17,476 |
| `near_repeat_substitute` | **0** | 15,181 |
| `take_hit_exact` | 286 | 6,407 |
| `evict_stale` | **0** | 113,176 |

即「**请求的帧号与解码器吐出的帧号大量对不上**」。

这与 `decode-worker.worker.ts:437` 记载的同族缺陷形态一致
（「客户端只请求约 3/5 的源帧 ⇒ 每个请求都 miss ⇒ missingStuck 冷启整 GOP」），
**但该修复已存在** ⇒ 长时线上必有**新的**触发路径。

## 7. 明确未证

- §6 完全是**形态相似性推断**，未验证。
- 未测 renderer / decode-worker 的交互时序。
- 未跑多次运行方差、未换素材对照。
- 未复现 P196 的 2.5 秒本身。

## 8. 下一手的入口

要论证 §6，必须**在运行时观察** `unmatched_near` / `near_repeat_substitute` 的产生路径——
那是 renderer 与 worker 的交互，静态数据无法回答。

两条可走的路：
1. 改诊断构建，在 `decode-worker.worker.ts` 的 `near_repeat_substitute` 与
   `unmatched_near` trace 点补上下文（请求 rank / 已持有 rank / 前沿 rank），
   跑 15 分钟 e2e（约 20 分钟/轮）。
2. 或在单元测试里构造「窗口滚动 + 150 帧 GOP」的仿真，看能否复现同样的 miss 形态
   （成本低，但保真度未知——本仓 `tests/decode-reorder-playback.test.ts` 有真实采样表先例）。

**不建议**再从 JSON 做静态分析——已榨干。
