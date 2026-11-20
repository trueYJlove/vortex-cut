# C20-T1(seek 取窗调优)实施报告(2026-09-12)

依据:`PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md` §2 C20-T1(已批准)。
前置:S1 已交付(`PERFORMANCE_S1_SMALLFIX_IMPLEMENTATION_2026-09-12.md`)。

## 1. 交付内容

### 1.1 缓存预算参数化(档位表)

`resource-budget.ts` `BudgetTable` 新增三字段并按档位给值:

| 档位 | windowCacheMiB | prefetchWindows | maxInFlightWindows |
|---|---:|---:|---:|
| conservative | 16 | 1 | 2 |
| balanced | 32 | 2 | 3 |
| high | 64 | 2 | 4 |

- 新增 `windowSourceBudget(tier)` 统一出口,受全局上限夹紧
  （`MAX_PREFETCH_WINDOWS=2`、`MAX_IN_FLIGHT_WINDOWS=4`——表值失配不得
  放大在途/预取风暴）。
- `SyntheticPreview` 构造 `windowedFrameSource` 时接档位
  （cacheBytes/maxInFlight）;**无档位 = 帧源内建默认 8MiB/2,语义不变**,
  既有帧源单测不动即过。
- 口径注明:v2 窗缓存记账对象是 IR 帧元数据(~500B/帧实值),预算放大
  的 JS 堆代价与解码驻留（Chromium 池,16.6GiB 主因）正交——与 B13-R
  判别结论一致,报告对比时须分列。

### 1.2 seek 落定后方向性预取(±span,去抖)

- `frame-source.ts` 新增纯函数 `windowPrefetchStarts(target, span,
  windowFrames, totalFrames)`:对称 ±k、同距对内先正向(顺播更常见,
  在途上限下先到先得)、起点去重、夹紧合法窗口范围、目标窗自身剔除
  (seek 路径已取)。
- `preview-session.ts` 新增 `scheduleWindowPrefetch`:
  - 门控:`prefetchSpan ≥ 1` 且 `externalFrames`(仅 v2 注入帧源);
  - 去抖 200ms,拖拽/连点风暴中定时器持续重置,落定才发起;
  - 逐窗发起(近目标优先),受帧源 `maxInFlight` 约束,满载窗口不排队
    （既有 window_fetch -1 遥测语义）;fire-and-forget——loadWindow 自吞
    错误,promise 不 reject;
  - dispose 清定时器;预取只取 IR 元数据窗口,不触发解码/上传;
  - 预取请求走既有 ensureRange/loadWindow,window_fetch 遥测自动覆盖
    （A/B 轮可直接分析预取命中率/取消率）。

## 2. 验证

| 项 | 判定 |
|---|---|
| typecheck | 通过 |
| Desktop 单测 | **69 文件 625 项全过**(622+3 新增:预取窗序 2 项、档位出口 1 项;档位表全量 toEqual 同步更新) |
| 默认语义 | 无档位路径帧源默认 8MiB/2 不变;v1 数据面零改动 |
| 行为正确性 | 预取不触碰 getFrame/引用稳定性契约;ensureRange 既有 abort/single-flight 语义复用 |

## 3. 验收对照(Gate §3 C20-T1)

| 项 | 判定 |
|---|---|
| seek p95 退化收敛 ≤20% | **待 A/B 实测**——需 B00 harness F01/F03 ×5 轮 ×off/on 基准轮(机制上:随机 seek 未缓存窗口由预取覆盖;实测为准,不先验宣称) |
| window_fetch 命中率/取消率入报告 | 随 A/B 轮产出(遥测已自动覆盖预取请求) |
| 命中缓存 seek 不劣化 | 结构上不受影响(预取只新增缓存请求);以 A/B off/on 对照确认 |
| 行为正确性 | 达标(625 单测;v1/v2 帧内容对拍不涉及——预取不改变帧数据) |

## 4. 遗留

- A/B 基准轮(含 T2 ready 改造后一并跑,避免两轮机器时):F01/F03/F02
  ×5 轮 ×off/on ×100 seek ×300s 播放,对照 v1 G0 与 c20v2-ab-v2 基线。
- 预取在 maxInFlight 满载时被丢弃不重试(机会性,下次 seek 重试)——
  如 A/B 显示丢弃率高,再评估排队预算。
