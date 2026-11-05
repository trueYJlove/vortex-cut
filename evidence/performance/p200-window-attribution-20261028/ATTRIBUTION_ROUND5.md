# P200 第五轮：对第四轮「重锚 → missingStuck」因果的否证（2026-10-28）

> 状态源一律引用 `docs/STATUS.md` §4 **P200**；本文只记录分析事实，不声明工程状态。
> **本轮零成本**：完全基于已入库的 `app-drop-p196-*.json`，未跑任何新测量。

## 0. 结论先说

**第四轮认定的机制「重锚回退 → `emittedRankMax` 不回退 → `missingStuck`」
在 P196 真机 trace 上不成立。`backDistance` 量到的不是重锚回退深度，
而是解码器管线深度 / 回扫窗宽度。**

真机冷启的真实主因是**暂存帧被自身容量驱逐**（82.4% 驱逐率），
重锚是同一饥饿状态下的**共因症状**，不是原因。

## 1. 第四轮的核心假设，以及它需要成立的条件

第四轮的链条（`ATTRIBUTION_ROUND4.md` §2）：

```
reanchor 把播放头回退 → emittedRankMax 只增不减 → targetRank <= emittedRankMax
→ missingStuck → 冷启整 GOP
```

该链条要成为现场成因，`backDistance = emittedRankMax - targetRank` 必须
**由重锚的回退量决定**。这给出三条可判伪的推论：

- **T1**：`emittedRankMax` 应显著大于「已喂游标」，因为它是历史最高水位。
- **T2**：`backDistance` 的上界应由实际重锚跳过量决定。
- **T3**：重锚越频繁/越大，`backDistance` 应越大。

三条全部被否证。

## 2. T1 否证：`emittedRankMax` ≈ 已喂游标（18/20）

`decisions.coldStarts` 的 20 条采样（该字段上限 20，是 1808 次冷启的**样本**）：

| target | lastFedSample | emittedRankMax | backDistance | lastFed − target |
|---|---|---|---|---|
| 2997 | 3006 | 3006 | 9 | 9 |
| 3298 | 3309 | 3309 | 11 | 11 |
| 7194 | 7205 | 7205 | 11 | 11 |
| 7685 | 7693 | 7693 | 8 | 8 |
| 7688 | 7692 | 7692 | 4 | 4 |
| 7682 | 7699 | 7696 | 14 | 17 |

**18/20 条满足 `emittedRankMax == lastFedSample`（或恰差 1）。**

即：台账记录的是「解码器已经吐到哪」，不是「播放头曾经到过哪」。
两序列统计量几乎重合（`backDistance` 均值 9.3、`lastFed − target` 均值 9.6）。

**这一点单独就否掉了链条的前提**：如果重锚回退是驱动因素，
`emittedRankMax` 必须**独立于**当前喂包游标并持续高于它——实测没有。

## 3. T2 否证：`backDistance` 的上界对不上重锚，却正好对上回扫窗

| 量 | 分布 |
|---|---|
| 实际重锚跳过量（`skippedByReanchor`） | `{1:17, 2:27, 3:76, 4:7, 5:19, 6:16, 7:35, 8:28, 9:27}`，**峰值 3、上限 9** |
| 实测 `backDistance` | **min 4 / max 14 / mean 9.3** |

两者**形态完全不同**：重锚跳过量的峰值在 3，而 `backDistance` 的下界就是 4。

而产品侧有两个量精确覆盖 `backDistance` 的值域：

- `PreviewSession.BACKSCAN = 15`（`preview-session.ts:333`），
  `pump()` 的请求起点是 `from = max(0, currentFrame, target - BACKSCAN)`（`:1399`）
  ⇒ 请求天然可落后回扫窗最多 15 帧。
- 解码器输出管线深度 **11**（`decode-worker.worker.ts:205-225` 记录的 2026-09-30
  真机实测：3440×1440 H.264「喂到 target+11 才吐第一帧」）。

`backDistance ∈ [4, 14]` 完完整整落在 `[0, 15]` 内。

## 4. T3 否证：72% 的重锚根本没有移动播放头

P196 长跑 trace 中 `reanchor` 共 **895** 次，`duration` 分布：

```
-1 : 643 次   ← findHoleSkipCandidate 返回 from：未找到洞，播放头原地不动
 1 :  17
 2 :  27
 3 :  76
 4 :   7
 5 :  19
 6 :  16
 7 :  35
 8 :  28
 9 :  27
```

**643/895 = 71.9% 的重锚只重设了 `anchorWall`（`preview-session.ts:2159-2160`），
没有跳转。** 真实跳转 252 次，最大跳过 9 帧。

即便全部按最大跳过 9 计，也无法解释 `backDistance = 14`。

## 5. 真机主因：暂存帧被自身容量驱逐

P196 长跑组 vs 对照组的同口径计数：

| 计数 | 长跑组（26083 帧） | 对照组（1241 帧） |
|---|---|---|
| `stash_put` | 137,347 | 884 |
| `evict_stale` | **113,176（占 stash_put 82.4%）** | **0（无该计数）** |
| `take_hit_exact` / `output` | 6,407 / 146,934 = **4.4%** | 286 / 1245 = **23.0%** |
| `cold_start` | 1,808 | 1 |
| `budget_raise_evicted_miss` | 1,384（**占冷启 76.5%**） | — |
| `near_repeat_substitute` | 15,181（被近邻替代救回、未冷启） | — |
| `backpressure_shrink` | 709 | — |

`budget_raise_evicted_miss` 是产品自己为「被驱逐导致的 miss」设的计数
（`recoverBudgetAfterEvictedMiss`，`decode-worker.worker.ts:395-404`），
它占全部冷启的 **76.5%**——这是产品自身对该归因的独立确认，不是本轮的推断。

**与第四轮结论的关系**：`reanchor` 的触发条件是
`target - currentFrame > LAG_REANCHOR(4)`（`preview-session.ts:2149`），
而 `currentFrame` 落后的成因正是帧被驱逐后的合成饥饿。
**两者共因**，所以相关性必然出现——但方向与第四轮相反。

## 6. 为什么第四轮仿真没抓到驱逐

`apps/desktop/tests/p200-reanchor-simulation.test.ts:102`：

```ts
holdCap = Math.min(16, Math.max(6, fedTo - target + 2));
```

这是**自适应扩容**——恰恰就是驱逐问题的修法。仿真把这个主因**消灭在模型里**，
剩下的自然只有重锚。故第四轮的 257 vs 1808 只证明「模型内该链条成立」，
**不能外推到真机**。

（第四轮报告 §6 已自认「仿真结论 ≠ 实机成因」，本轮是把它确证到具体原因。）

## 7. 附带发现：`p200-reanchor-correlation` spec 目前无判别力

`e2e/p200-reanchor-correlation.electron.spec.ts:36`：`REANCHOR_WINDOW_MS = 2000`。

实测重锚间隔：**p50 = 1000ms、mean = 1005ms**（895 次事件，跨度 898.8s）。

滑动零基线（任取一时刻，落在某次重锚之后 W 内的概率，n=17,976）：

| W | 零基线 |
|---|---|
| 2000ms（**当前值**） | **77.9%** |
| 1000ms | 73.9% |
| 500ms | 39.7% |
| 250ms | 22.5% |
| 100ms | 10.0% |

即 `correlated_within_window` 在**随机时序下也会报约 78%**。
秩口径同样偏软（reanchor 落点 ±12 的零基线 51.7%、±30 为 58.2%、±2 为 17.9%）。

**即使造出 ≥869s 夹具并跑满 15 分钟，当前 spec 得到的数字也不能支持任何结论。**
本轮的「不造夹具」决策由此获得第二个独立理由。

## 8. 本轮的边界（不得越读）

- 20 条采样是 1808 次冷启的**样本**，且分布不均（target 7596 重复 14 次）；
  结论依赖的是**字段语义与代码路径**，不是这 20 条的统计量。
- 单机、单素材、单次长跑；未做多次运行方差。
- **未证明**「提高 `readyByPtsMax`/`unclosedBudget` 就能消除退化」——
  那是下一轮的事，本轮只证明「驱逐是主因、重锚不是」。
- 未解释 `output_p50` 1.9ms → 45.6ms 的成因；该问题与本轮结论正交。

## 9. 复现

纯只读，无新测量：

```bash
cd evidence/performance/preview-smoothness-baseline && node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("app-drop-p196-crosswindow-max.json","utf8"));
const c=j.decisions.counts;
console.log("evict/stash =", (100*c.evict_stale/c.stash_put).toFixed(1)+"%");
console.log("hit rate    =", (100*c.take_hit_exact/c.output).toFixed(1)+"%");
console.log("evicted-miss cold starts =", (100*c.budget_raise_evicted_miss/c.cold_start).toFixed(1)+"%");
const re=j.perf_events.filter(e=>e.kind==="reanchor");
console.log("reanchor no-jump =", re.filter(e=>e.duration===-1).length, "/", re.length);
for (const s of j.decisions.coldStarts)
  console.log("backDistance =", s.detail.emittedRankMax - s.detail.targetRank,
              " lastFed-target =", s.detail.lastFedSample - s.detail.targetRank);
'
```
