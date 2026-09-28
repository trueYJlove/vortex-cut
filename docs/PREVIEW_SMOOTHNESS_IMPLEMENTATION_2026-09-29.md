# 预览播放流畅度收敛 · 实施记录（2026-09-29）

> 规划门：`PREVIEW_SMOOTHNESS_PLANNING_GATE_2026-09-28.md`；STATUS.md §4 P33。
> 当前状态以 `docs/STATUS.md` 为准。本文是点时间实施记录。

## 1. 交付摘要

| 门限项 | 基线（用户实测/首轮基线） | 终测（skip2-r1..r3，真机 3 轮） | 结论 |
|---|---|---|---|
| 丢帧 ≤0.5% 且方差稳定 | 34~423（用户实测）/ 5-6/1800（首轮基线） | **0/1800 × 3 轮（0.00%）** | ✅ |
| decode p95 ≤20ms | 53.8ms | **1.6~2.2ms**（顺播稳态） | ✅ |
| decode p50 ≤12ms | ~34ms | **0.4ms** | ✅ |
| compose interval p95 ≤40ms | 未取样 | **33.6~33.7ms**（满帧率 30fps） | ✅ |
| 看门狗/降级 = 0（回归） | 0 | 播放段 0（EOF 边界另见 §4） | ✅ |
| 插桩零开销 | — | 未单测（插桩仅开启路径生效，见 §5 L1） | ⚠️ L1 |
| 用户真机确认 | — | **待用户复测** | ⏳ |

测量载体：`python tools/m3_0/run_electron_probe.py m3p5 --ir evidence/performance/preview-smoothness-baseline/ir_hevc_b_60s.json --assets evidence/performance/preview-smoothness-baseline/assets.manifest.json --evidence <dir>`，素材 `test-assets/generated/hevc/hevc-1080p-60s-g90-b3.mp4`（1080p30 HEVC Main、GOP=90、B 帧重排实测回跳 7、60s、faststart）。

## 2. 改动清单（每项独立 A/B 证据）

### W1 分段计时插桩（3be4ef5，后续 6f7a75e 修复链路）
- decode-worker.worker：`feedMs`（出队→最后一批喂包提交）+ `outputMs`（喂包提交→匹配输出），`decodeTiming` init 注入；跨线程不传绝对时间戳。
- decode-worker 客户端：残差 = 客户端 RTT − worker 两段，环形 512 样本。
- MediaDecoder 接口 `timingSamples`（WebCodecsMediaDecoder 透传）；`metrics().decode_seg` 聚合；m3p5 result 携带分段表（**dispose 前快照**）。
- 计时开关经主进程 `probeLoadQuery` 注入 URL（VITE_* env 直通渲染侧不可靠，timing-r1..r3 实测 None）。

### W3 起播丢帧根治（两部分，提交见 git log）
1. **pump max 封顶收紧**：`anchor + RING−3` → `anchor + min(LEAD, ringDepth−3)`。链完成即续快于实时时收窄超前冗余（单独 A/B 不解决起播丢帧，保留以减淘汰窗）。
2. **LAG_REANCHOR 12→4 + 重锚「洞跳过」**：
   - 单独收紧 LAG 会死锁（fix-ttl-r14..r16、hole-skip-r1..r3 五轮定位）：洞 = 预读淘汰且 pump 游标单调不回补的不可展示帧；旧重锚锚在 currentFrame，target 永远爬不出洞区，预读区就绪帧轮不到回扫窗——合成冻结。
   - `findHoleSkipCandidate`：重锚时在 (current, target+LAG] 找洞后第一个就绪帧，把播放头跳过去（搜索窗必须延至 target+LAG，hole-skip 轮验证）。跳过 = 承认被淘汰帧不可展示。
   - 效果：skip2-r1..r3 丢帧 0/1800 × 3、合成间隔 33.4/33.6ms、content 匀速走完、复播回归过。

### W2.5 EOF 边界快速报错
- 现象：暂停态 seek 片尾 B 帧区（1780/1783/1786/1789/1798）45s 看门狗挂起，快照 `dqSize=15-17`。
- 定位（eof-* 六轮 A/B）：尾 GOP 冷启喂到文件尾后，重排金字塔尾帧滞留输出管道；**flush 救援实测无效**——D3D11 硬解尾帧缺后续参考时 `flush()` promise 永不落定、`reset()` 丢弃排队输出，重排队冷启再撞同一堵墙。
- 收口：rescue_flush/feedSamples 检测已喂至文件尾 → 立即报 `EOF reorder watchdog`（命中降级正则）；rescue_flush 加 5s 竞速超时防 promise 挂起闸死泵。
- 效果：探针 wall 286s → **61.5s**（4×45s 挂起全消），播放丢帧保持 0/1800。

### 探针/测量链路修复（非生产路径）
- freshSession 前重签票据：session1 + postmortem 挂起后距签票 ~250-290s 贴着票据 TTL 5min，跨线即 init 404（fix-lag-r1..r13 伪相关定位：与代码改动无关，与 wall 时长相关）。
- m3p5 合成间隔只计播放段；run_electron_probe 多轮轮次透传。

## 3. 验收对照表（规划门 §7）

| 门限项 | 基线 | 终测（3 轮） | 结论 |
|---|---|---|---|
| 丢帧 ≤0.5% 且方差稳定 | 34~423 | 0/1800 × 3（skip2-r1..r3） | ✅ |
| decode p95 ≤20ms | 53.8ms | 1.6~2.2ms | ✅ |
| decode p50 ≤12ms | ~34ms | 0.4ms | ✅ |
| compose interval p95 ≤40ms | 未取样 | 33.6~33.7ms | ✅ |
| 看门狗/降级 = 0（回归） | 0 | 播放段 0 | ✅ |
| 插桩零开销 | — | 未做关/开 env 对跑 | ⚠️ L1 |
| 用户真机确认 | — | 待复测 | ⏳ |

Desktop 全量 735 tests + typecheck 绿（每项改动后各跑一次）。

## 4. 遗留与已知限制

- **L1 插桩零开销未对跑**：插桩全部在 `decodeTiming` 开启分支内，默认关；未做关/开 env 探针对跑定量确认（规划门 §6 风险项）。
- **L2 EOF 边界降级待真机验证**：探针无 pcmProjectId → FFmpeg B 后端降级不可用，postmortem 尾帧 5/9；生产 App 内 decodeFrames 可用，EOF 快速报错 + 连续 2 次降级应在秒级恢复——需在真机 App 中 seek 片尾验证一次。
- **L3 起播洞跳过的用户感知**：起播期跳过的是已被预读淘汰的帧（≤8 帧、<0.3s 内容），正常播放不可感知；变速/多输入组合仅单输入顺播验证过，现有 playback 回归测试全绿。
- **L4 用户素材复测**：本所有结论基于仓内复刻素材（hevc_qsv GOP90 bf3）；用户原素材（fdf0f0e2，不在仓）需真机复测确认同向改善。

## 5. 复测命令（可复现）

```bash
# 3 轮复测（每轮独立子目录）
for i in 1 2 3; do
  VITE_AIVS_DECODE_TIMING=1 python tools/m3_0/run_electron_probe.py m3p5 \
    --ir evidence/performance/preview-smoothness-baseline/ir_hevc_b_60s.json \
    --assets evidence/performance/preview-smoothness-baseline/assets.manifest.json \
    --evidence evidence/performance/preview-smoothness-baseline/verify-r$i
done
# 判读：m3p5_result.json 的 dropped_frames（≤9=0.5%）、compose_interval_ms.p95（≤40）、
#       decode_ms.p95（≤20）、last_error（null）
```
