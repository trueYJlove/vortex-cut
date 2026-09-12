# C20-T1/T2 验收 A/B 实测报告(2026-09-12)

依据:`PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md` §3 验收口径。
前置:S1、C20-T1、C20-T2 已交付(`PERFORMANCE_S1_SMALLFIX_IMPLEMENTATION_2026-09-12.md`、
`PERFORMANCE_C20T1_WINDOW_TUNE_IMPLEMENTATION_2026-09-12.md`、
`PERFORMANCE_C20T2_READY_IMPLEMENTATION_2026-09-12.md`)。T1/T2 合并
一轮 A/B(避免两轮机器时,T1 报告 §4 既定)。同机同日产出 B11-D1 spike
(判定见 `PERFORMANCE_B11D_PROXY_DECISION_MEMO_2026-09-12.md` §2.1)。

## 1. 结论摘要

- **C20-T1(F01/F03 seek p95 退化 ≤20%)达标**:F01 seek p95 中位
  29.7→29.1ms(**-0.4%**,T1 前为 38.2/+31%);F03 32.0→30.8ms
  (**-3.8%**)。方向性预取 + 缓存预算调参把 v2 的 seek 退化全部消除。
- **C20-T2(ready 退化 ≤5%)F01/F02 达标、F03 超线但非 T1/T2 引入**:
  F01 ready 2343→2404ms(**+2.6%**);F02 5771→5153ms(**-10.7%,
  反而更快**);F03 6378→6869ms(**+7.7%**,主目录 3 轮 + 重跑 5 轮
  合并)——与 T1/T2 之前的 c20v2 轮(6888ms)持平(-0.3%),增量全部
  来自 v2 数据面固有成本(Core manifest 投影 4.1–4.3s),本轮改动对
  F03 ready 中性;严格口径如实报超线,交独立复核(不重定门)。
- **F02 ready 归因分解交付**(§5):ready 主导项是 **Core manifest 投影
  IPC(1.8s@900s 源,4.1s@3600s 源,随源大小缩放)**;SyntheticPreview
  装配四段合计仅 ~2.2s,段外 ~2.9s 在重载/项目恢复/启动链(未分段)。
- **F02 v2 seek p95 +111%(36.5→77.2ms)如实登记**:与 T1 前持平
  (78.3),90 窗随机 seek ~94% 落在预取邻域外,属 v2 窗协议固有成本
  (Gate 只设 F01/F03 门);窗口级缓解(更大预算)对"随机全谱 seek"
  无效,属窗口尺寸/契约层议题,本轮不动。
- **off 复测 ±5% 门通过**:新 v1 轮对完整 G0 基线三场景全部指标偏差
  ≤±3.9%(§3)。
- **B11-D1 spike 判定落锤**:320×180 代理解码输入的 Tab WS 平台
  16,649MB vs 640×360 的 16,707MB(-0.35%)——**代理降档对 F02 类
  解码驻留无效,缩放律证伪**(备忘录 §2.1,D2 三问推荐"不实施")。
- 独立验收与"默认 on"决策:待 LiuKeAi 复核;v2 默认 off 维持(Gate §3)。

## 2. 测量协议与证据链

| 轮次 | 目录 | 二进制 | 说明 |
|---|---|---|---|
| v1 基线 | `evidence/performance/c20t-ab-20260912-v1/` | v1(默认 off),指纹 `04c5997a6dd7` | F01/F02/F03 各 11 次启动全过,零 failure.json |
| v2 处理组 | `evidence/performance/c20t-ab-20260912-v2/` | v2(`VITE_AIVS_PREVIEW_IR_V2=1`),指纹 `42585dad8c9d` | F01/F02 完整;F03 run-3-off 起遇装配竞态中止(§8) |
| v2 F03 重跑 | `evidence/performance/c20t-ab-20260912-v2-f03retry/` | 同 v2 | 单场景 5 轮(c20v2-f02-retry-01 同款处置) |
| B11-D1 spike | `evidence/performance/b11d-spike-20260912/` | v1 | F02P 5/5,58.2min |
| 失败现场 | `c20t-ab-20260912-v1-fail01/-fail02/`、`b11d-spike-20260912-fail01/` | — | 归档保留(§7/§8) |

- 协议:B00 harness,5 轮中位,off/on 为同次启动内遥测双通道,100
  seek × 300s 播放,seed 20260908,同机插电;run-config 记录 commit
  `fd8d7ed`(工作树含本报告 §7 的两处 spec 修正,已如实指纹)。
- **harness 版本差登记**:v1 轮指纹早于 spike/v2 轮一个 spec 修正
  (F02P 项目名注入,§7.1)。两处 spec 修正均为测量中性(ready 捕获在
  readyMs 之后;项目名注入在装配前、不影响任何被测路径),app 二进制
  不受 spec 影响。
- 统一口径:全部指标 = per-run 值的 5 轮中位(seek p95 = 每轮 seek 相
  位事件 p95 再取中位),与 `summarize_results.py` 一致。

## 3. 关键实测对照(5 轮中位,on-runs)

| 指标 | G0 v1(20260911-v2) | fresh v1(本轮) | v2+T1+T2(本轮) | v2 vs v1 | c20v2(T1/T2 前) |
|---|---:|---:|---:|---:|---:|
| F01 seek p95 | 29.2ms | 29.7ms | **29.1ms** | **-0.4%** | 38.2ms(+31%) |
| F01 ready | 2386ms | 2343ms | **2404ms** | **+2.6%** | 3200ms(+34%) |
| F02 ready | 5780ms | 5771ms | **5153ms** | **-10.7%** | 5738ms* |
| F02 seek p95 | 38.2ms | 36.5ms | 77.2ms(+111%) | — | 78.3ms(同型) |
| F03 seek p95 | 30.8ms | 32.0ms | **30.7ms**(合并 n=8) | **-4.1%** | 31.1ms(†) |
| F03 ready | 6306ms | 6378ms | 6869ms(合并 n=8) | +7.7% | 6888ms |
| F02 Tab WS | 16,706MB | 16,707MB | 16,702MB | 持平 | 16,689MB |
| F02 播放 compose | 26.2/s | 26.6/s | 26.6/s | 持平 | 27.4/s |

\* c20v2 F02 来自单场景重跑 `c20v2-f02-retry-01`(原 A/B 轮崩溃无中位)。
† c20v2 F03 seek 39.7ms 与其证据目录不可复算,勘误候选见 §8.2。

**off 复测 ±5%(本轮 fresh v1 vs G0)**:F01 ready -1.8%/seek +1.7%/
Tab -0.2%;F02 ready -0.2%/seek -4.5%/Tab +0.0%;F03 ready +1.1%/
seek +3.9%/Tab -0.9%——**全部 ≤±5%,机器状态与 G0 可比性成立**。

## 4. 验收门对照(Gate §3)

| 项 | 判定 | 结果 |
|---|---|---|
| C20-T1:F01/F03 v2 seek p95 相对 v1 ≤20% | F01 -0.4%、F03 -3.8% | **达标**(T1 前为 +31%/+9%*) |
| C20-T1:命中缓存 seek 不劣化 | F01 seek 相期 window_fetch = 0(双窗装配期全预载),p95 与 v1 持平 | **达标** |
| C20-T1:window_fetch 命中率/取消率入报告 | §6(取消率 ≤2%,48–61ms p50) | **达标** |
| C20-T1:行为正确性 | 全程可播可 seek;F01/F02/F03 off/on 全部断言过;v1 轮零失败 | **达标** |
| C20-T2:v2 ready 相对 v1 ≤5% | F01 +2.6%、F02 -10.7% 达标;F03 +7.7%(合并 n=8)超线——与 T1/T2 前 c20v2(6888ms)持平(-0.3%),增量来自 v2 manifest 投影,本轮改动中性 | **F01/F02 达标;F03 超线归因明确(v2 固有,非 T1/T2 引入),交复核裁决** |
| C20-T2:ready 分段遥测四段贯通 | 四段全场景落库(F01 m378/i137/w138;F02 m1796/i201/w202;F03 m4299/i164/w165,parse≈0) | **达标** |
| C20-T2:F02 5.7s 归因分解报告 | §5 交付 | **达标** |
| B11-D1:spike 报告(±25% 允差) | 实测 16,649MB 落入"≈16GiB"分支(备忘录 §2.1) | **判定落锤:代理降档无效** |

\* F03 的 T1 前对照:c20v2 轮 per-run 中位 31.1(+1%)——上一轮报告的
"+29%(39.7ms)"与其目录不可复算,见 §8.2。F03 的 seek 门实际从未紧张;
真正的退化在 F01,已由 T1 消除。

## 5. F02 ready 归因分解(5.15s 的构成)

ready_ms 口径 = 冷启动装配(导入 234MB + 900 段/字幕 patch)→ 重载 →
项目恢复 → 合成预览就绪 → 播放头前进的全程墙钟。分段遥测只覆盖重载后
SyntheticPreview 装配段:

| 段 | 中位 | 占比 | 说明 |
|---|---:|---:|---|
| ready_manifest | 1,796ms | ~35% | **Core manifest 投影 IPC——最大单项**;随源大小缩放(F03 3600s 源 = 4,299ms) |
| ready_parse | ~1ms | ~0% | 契约解析可忽略 |
| ready_inject | 201ms | ~4% | PreviewSession.create(worker/GL/池) |
| ready_window | 202ms | ~4% | 与 create 重叠(并行化生效——串行链下应为 +200ms) |
| **段外残差** | **~2.9s** | ~56% | 重载前的导入+装配 patch、页面重载、项目恢复、播放头起步——**未分段,是后续 <2s 目标的主战场** |

结论:上一轮"manifest+首窗串行"归因只解释了小头;**ready 的大头在
SyntheticPreview 之外**(56%),装配段内的大头是 Core manifest 投影
(随源大小缩放)。若未来立项"ready <2s",优先级应为:① 段外启动链
分段测量与优化;② Core manifest 投影缓存/增量(契约层)。本轮不实施。

## 6. window_fetch 遥测(T1 预取评估)

| 场景 | seek 相期取窗/轮 | 成功:拒绝 | p50 耗时 | 解读 |
|---|---:|---|---:|---|
| F01(2 窗) | 0 | — | — | 装配期 ensureRange(0,600) 预载双窗,seek 全命中——预取使 seek 相期零取窗 |
| F02(90 窗) | 116 | 115:1~2 | 48–61ms | 随机 seek ~94% 落在预取 ±span 之外(90 窗下邻域命中率 ~6%),每 miss 现场取窗;**取消率 ≤2% 证明预取不与用户目标抢在途额度** |
| F03(360 窗) | 1 | 1:0 | 2,039ms | 30s 时间线只触 3 个内容窗,装配期预载覆盖;唯一一取是深窗(900MB 文件磁盘寻道) |

结论:T1 预取在"邻域 seek"场景(F01/F03)完全消除取窗等待;F02 类
"随机全谱 seek"的取窗等待是 v2 窗协议固有成本,预取/预算参数(8→32MiB)
不能缓解,登记为窗口尺寸/契约层议题。

## 7. 本轮 harness 修正(随本报告提交)

1. **F02P 项目名注入**(上一轮 B11-D 提交的潜伏缺陷,首次 E2E 实跑暴
   露):`assembleF02` 项目名硬编码 `"B00 F02"`,F02P 复用时
   `expectCurrentProject("B00 F02P")` 断言失败。修复:测试体经
   `window.__benchProjectName` 注入 `B00 <scenario>`,装配函数读取
   (F02 缺省值不变)。教训:F02P 上轮只过了单测,未跑 E2E。
2. **ready 分段捕获**:`PerfRecorder.reset()` 清空事件流,分段遥测须在
   reset 前捕获进样本(`ready_segments` 字段)。v1 轮指纹含此修正,
   spike/v2 轮指纹另含 §7.1(差异测量中性,§2 已登记)。

## 8. 勘误、偶发与登记

1. **装配竞态偶发(登记,非本轮引入)**:约每 ~50 次启动 1 次,"预览
   状态已 synthetic 但 canvas 不可见/不存在"达 60s——本日 4 次现场
   (fail01/fail02/spike-fail01* /v2-F03-run3-off)。干净机器重跑即过;
   harness 对该状态无恢复路径(recovery 按钮只在显式回退时出现),
   **登记为 harness 已知脆点**。*spike-fail01 实为 §7.1 的确定性缺陷,
   非竞态。
2. **勘误候选(c20v2 A/B 报告 §3)**:F03 seek p95 "30.8→39.7ms
   (+29%)"与其引用目录 `c20v2-ab-20260911-v2` 不可复算(per-run 中位
   31.1ms、跨轮合并 p95 33.1ms,39.7 疑为混入修复前目录
   `c20v2-ab-20260911` 的数值)。F03 的 seek 退化从未成立,不影响该报
   告的 F01 结论(+31%,可复算)。
3. **F02 v2 seek +111%(36.5→77.2ms)**:非 T1 回归(与 T1 前 78.3 持
   平),v2 窗协议对"随机全谱 seek"的固有成本(Gate 未设 F02 seek 门)。
   缓解需窗口尺寸/契约层改动,如需推进另立工作单。
4. **F03 ready +7.7%**:v2 manifest 投影成本(T2 前 c20v2 6888ms 与本轮
   6869ms 持平,-0.3%——本轮改动对 F03 ready 中性);per-run 分布双构建
   重叠(v1 6311–7417ms,v2 6815–7937ms,manifest 段稳定在 4.1–4.3s,
   波动来自导入/投影路径)。严格口径超 ≤5% 线 2.7pt,连同 §5 的段外
   残差发现一并交独立复核;若未来立项压缩,方向见 §5 结论。

## 9. 复现命令

```bash
# v1(off)
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03 \
  --fixtures evidence/performance/g0-fixtures-20260911 \
  --output evidence/performance/c20t-ab-20260912-v1 \
  --runs 5 --seeks 100 --playback-seconds 300 --seed 20260908
# v2(on)
VITE_AIVS_PERF=1 VITE_AIVS_PREVIEW_IR_V2=1 pnpm --filter @aivideo/desktop build
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03 \
  --fixtures evidence/performance/g0-fixtures-20260911 \
  --output evidence/performance/c20t-ab-20260912-v2 \
  --runs 5 --seeks 100 --playback-seconds 300 --seed 20260908
# F03 单场景重跑(v2 二进制不动)
node tools/performance/run_editor_benchmark.mjs --scenarios F03 ... \
  --output evidence/performance/c20t-ab-20260912-v2-f03retry ...
# 汇总
python tools/performance/summarize_results.py --results evidence/performance/<dir>
# B11-D1 spike(备忘录 §2)
```
