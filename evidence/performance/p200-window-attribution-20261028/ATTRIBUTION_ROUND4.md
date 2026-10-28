# P200 第四轮：重锚 → missingStuck 的仿真验证（2026-10-28）

> 状态源一律引用 `docs/STATUS.md` §4 **P200**；本文只记录验证事实。

## 0. 结论

**因果链在仿真中成立，且「无重锚时零重建」已被证实。** 但这是**仿真**结论，
不是实机 trace 结论——后者仍未取得，理由见 §4。

## 1. 为什么走仿真而不是 e2e（成本决策，如实记录）

先尝试了真机验证（`e2e/p200-reanchor-correlation.electron.spec.ts`）：

| 素材 | 观察窗 | `trace_total` | `cold_start` | `reanchor` |
|---|---|---|---|---|
| 165.6s / 4964 帧 | 90s | 9516 | **0** | **0** |
| 165.6s / 4964 帧 | 45s | 4781 | **0** | **0** |

事件分布正常（`feed:1358` / `output:1358` 一一对应、`take_hit_exact:315`），
证明**遥测链路是通的**，只是这个规模**根本不触发**。

要触发需拉到 P196 的 869s 量级 ⇒ 约 8.7GB 夹具 + 15 分钟 e2e，且不保证一次收敛
（P196 那轮跑了 965 秒墙钟）。**决策：先做仿真验证机制自洽性，实机留待真机复现。**

## 2. 仿真模型

沿用 `tests/decode-linear-pipeline-hold.test.ts`（**同一素材**：3440×1440 H.264
无 B 帧、GOP=150、D3D11 输出管线深度 11），**只加一个维度**：重锚。

关键：重锚把 `cursor` 回退，但**不回退 `emittedMax`**——精确对齐
`preview-session.ts:2147`（reanchor 只挪三个指针）与
`decode-worker.worker.ts:497/:538`（`emittedRankMax` 只增不减）。

## 3. 结果

| 场景 | `cold_start` 重建次数 |
|---|---|
| 4000 帧，**无重锚** | **0** |
| 4000 帧，有重锚（每 500 推进 / 回退 30） | **8** |
| 8000 帧 @ 26000 规模，每 400 推进 / 回退 300 | **257** |
| **P196 长跑组真实数据** | **1808** |

量级同档（257 vs 1808，差约 7 倍）——比第三轮那个仿真的 2.7×10⁵ 失真小了三个数量级。

## 4. 变异验证（两组，还原后 sha256 逐字节一致）

- **M1：重锚时也回退 `emittedMax`**（假设台账跟随播放头）⇒ **1 例红**
- **M2：重锚不回退**（=重锚不生效）⇒ **3 例红**

## 5. 过程中我犯的三个错，全部当场修正

1. **死循环**：内层「喂包 + 排空」循环里 `fedTo >= end` 就 `+1` 再 `break`，
   两者互相抵消 ⇒ 跑满 90s 不返回。加了硬上界 `outer > 500_000` 显式抛错。
2. **参数导致发散**：最初写「每 200 次推进、回退 300 帧」——**回退量 > 前进量**，
   必然自激。改为「回退量 < 间隔」后才收敛。这不是逻辑错，是参数不合理。
3. **假变异（最值得记）**：M2 第一次写成对 `sinceRe` 做 replace，而真实变量名是
   `sinceReanchor` ⇒ **replace 静默无匹配**，M2 测的是未变异的原文件、**"存活"是假象**。
   发现方式：在纯 node 里跑同一逻辑，`重锚不生效 = 0` 而 vitest 报全绿，两者矛盾才回头查。
   **教训：变异脚本必须断言 `replaced !== original`，否则假的绿会冒充真的红。**

## 6. 仍未证

- 仿真结论 ≠ 实机成因。`reanchor` 与 `missingStuck` 在真机 trace 中的
  **时间相关性仍未取得**（素材规模不够，见 §1）。
- 该机制能否解释 `output_p50` 1.9ms → 45.6ms 未知。
- 单机、单素材、无多次运行方差。

## 7. 实机验证已就绪，随时可跑

`e2e/p200-reanchor-correlation.electron.spec.ts` 已写好并跑通（能正确报告
`cold_start_total` / `reanchor_total` / `correlated_within_window`）。
只需一条 ≥869s 的夹具：

```bash
./resources/ffmpeg/win-x64/ffmpeg.exe -stream_loop 21 -i "<41.4s 原素材>" \
  -c copy -movflags +faststart -y .tmp/p200/p200-max.mp4
cd apps/desktop && pnpm build:e2e
AIVS_P33_MEDIA="$PWD/../../.tmp/p200/p200-max.mp4" AIVS_P33_LABEL=p200-max \
  AIVS_P200_OBSERVE_MS=900000 npx playwright test --config=tests/playwright.config.ts \
  e2e/p200-reanchor-correlation.electron.spec.ts
```

trace 里 `cold_start.backDistance > 0` 的事件若在 `reanchor` 后 2s 内大量出现，
则因果成立；否则本机制虽结构成立但不是现场成因。
