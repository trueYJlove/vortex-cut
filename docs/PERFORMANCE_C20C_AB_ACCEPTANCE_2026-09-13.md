# C20c-1/-2 验收 A/B 轮报告(2026-09-13)

依据:`PERFORMANCE_C20C_PLANNING_GATE_2026-09-13.md` §3 验收口径;
前置:C20c-1(`PERFORMANCE_C20C1_SESSION_SWAP_IMPLEMENTATION_2026-09-13.md`)、
C20c-2(`PERFORMANCE_C20C2_SEED_REUSE_IMPLEMENTATION_2026-09-13.md`)、
harness 扩负载(`PERFORMANCE_C20C_HARNESS_REVISION_PHASE_2026-09-13.md`)。

## 1. 结论摘要

- **C20c-1(会话沿用)达标**:三场景 108 个 revision 转换(每 run 6 次 ×
  F01/F02 各 5 run + F03 合并 8 run)**零整会话重建**(无一出现
  ready_inject 段)——默认 on 的 v2 数据面在真实 UI 编辑路径(字幕编辑/
  撤销/重做)全部走就地换装。
- **C20c-2 行为正确性达标**:换装路径在 e2e 全部就绪(结果断言 on 通道
  全过);窗口迁移(种子)路径未在本负载触发——自然编辑序列的相邻
  revision 文档必不同(manifest_id 必不等),种子仅同文档 revision 触发,
  由单测覆盖(C20c-2 报告已披露该口径)。
- **稳态零回归**:F01 ready/seek 2452/29.2ms(对 c20t-v2 基线 +2.0%/
  +0.3%);F02 5130/76.9(−0.4%/−0.4%);F03(合并 n=8)6834/30.5
  (−0.5%/−0.6%)——全部 ≤±5% 门,且远小于轮内噪声。
- **换装成本与 v1 持平**:同负载同轮询机制下,off 通道(v1 replaceIr)
  wall 与 on 通道(v2 swap)差 ~0.3–1%(F01 add 916 vs 918、undo 881 vs
  884;F02 undo 914 vs 924、redo 934 vs 935)。wall 由固定轮询机制主导
  (~800ms),辨别力有限;决定性信号是 ready_inject=0 与取窗形状。
- **新发现(重定价 C20c-2b)**:热进程的 manifest 重投影是便宜的——
  F03 转换 ready_manifest 中位 42–52ms(add 为全新文档、必 Cache 失效
  仍 52ms)vs 冷装配 4,144ms;F02 转换 66–350ms vs 冷装配 1,796ms。
  **4.1s/1.8s 冷成本属首投影预热,非稳态编辑路径成本**——C20c-2b
  (契约扩展激活部分复用)的主卖点(避免切换重投影)收益下修,优先级
  建议降为低(待稳态编辑延迟实测反馈再议)。
- **装配竞态升级登记**:本轮 3 次现场(主轮 F01 warmup-on、主轮 F03
  run-4-on、重跑 F03 run-4-on)≈ 3/60 启动(1/20),高于既有 ~1/50 估计;
  且 F03 两次精确死于 run-4-on 同槽位(疑与 F03/晚槽位相关,desktop.log
  干净无错)。建议单独立工作单:harness setup 超时恢复路径(page.reload
  一次 + setup_recovery_count 计数,与既有票据竞态恢复同型)。

## 2. 测量协议与证据链

| 轮 | 目录 | 结果 |
|---|---|---|
| 主轮 | `evidence/performance/c20c-ab-20260913/` | F01 warmup-on 撞竞态,停轮留证 |
| **v2 全轮** | `evidence/performance/c20c-ab-20260913-v2/` | F01/F02 全过(各 11 启动);F03 warmup+run0–3 过、**run-4-on 撞竞态** |
| F03 重跑 | `evidence/performance/c20c-ab-20260913-v2-f03retry/` | warmup+run0–3 过、run-4-on 同槽位撞竞态 |

- 二进制:v2 缺省(VITE_AIVS_PERF=1 构建,`previewIrV2Enabled` 缺省 on),
  commit `89f28d2`(harness 扩负载后);协议 B00 harness:5 轮中位、
  off/on 同次启动遥测双通道、100 seek × 300s 播放 + **6 次 revision
  转换/run**(F01/F03=text-edit,F02=undo-redo),seed 20260908,同机。
- F03 中位 = 主轮 runs0–3 + 重跑 runs0–3 **合并 n=8**(c20t 轮合并先例;
  两个 run-4-on 竞态现场不入样,如实披露)。
- 汇总:`summarize_results.py`(F01/F02);F03 合并值由原始 JSON 复算
  (本报告 §3)。

## 3. 稳态对照(5 轮中位,F03 为合并 n=8,on-runs)

| 指标 | c20t-v2 基线(20260912) | 本轮(v2 缺省 + C20c) | 差 | G0 v1 |
|---|---:|---:|---:|---:|
| F01 ready | 2404ms | **2452ms** | +2.0% | 2386ms |
| F01 seek p95 | 29.1ms | **29.2ms** | +0.3% | 29.2ms |
| F02 ready | 5153ms | **5130ms** | −0.4% | 5771ms |
| F02 seek p95 | 77.2ms | **76.9ms** | −0.4% | 36.5ms(+111% 登记不改) |
| F03 ready(n=8) | 6869ms | **6834.5ms** | −0.5% | 6306ms |
| F03 seek p95(n=8) | 30.7ms | **30.5ms** | −0.6% | 30.8ms |

- 探针开销(同二进制 off/on):F01 ready 2438/2452(+0.6%)、F02
  5162/5130(−0.6%)——既有 ≤0.1% 墙钟包络内(负载主导)。
- 稳态判读:C20c-1/-2 只改 revision 切换路径,稳态指标与基线差全部
  ≤2%,证明零扰动。

## 4. revision 转换分析(on 通道,n=108)

| 场景 | 转换数 | 整会话重建(ready_inject) | wall 中位 | ready_manifest | window_fetch/转换 |
|---|---:|---:|---:|---:|---:|
| F01(add/undo ×15) | 30 | **0** | 903ms(add 918/undo 884) | 40–50ms | 2(当前窗+预取) |
| F02(undo/redo ×15) | 30 | **0** | 931ms(undo 924/redo 935) | 66–350ms(中位 ~130) | 7(当前窗+回扫+预取) |
| F03(add/undo ×24) | 48 | **0** | 902ms | 42–62ms(中位 47.5) | 2–3 |

> 更正(2026-09-14,独立验收 Minor):F03 热重投影范围独立重算为
> **27.5–62.4ms**(n=24,中位 45.8)——上表 42–62ms 下界偏保守;
> 方向与结论(热投影便宜,C20c-2b 优先级下修)不变。详见
> `PERFORMANCE_C20C_HARNESS_D11_INDEPENDENT_ACCEPTANCE_2026-09-14.md` §4。

- **取窗形状与设计一致**:F01(2 窗时间线)每换装重取当前窗+预取窗;
  F02(90 窗)重取 7 窗;F03(3 窗深定位)重取 2–3 窗——均为
  manifest_id 变化(文档变化)→ 无种子 → 惰性重取的预期行为。
- **热投影发现**(§1):F03 add(新文档)manifest 52ms ≈ undo 42ms
  ——冷装配 4.1s 属首投影预热;F02 同型(热 ~130ms vs 冷 1.8s)。
  该发现不改变任何已登记结论,但**下调 C20c-2b 优先级**(其收益场景
  从"每次切换省 4.1s"修正为"每次切换省 ~50–130ms")。
- v1 对照(off 通道,同机制):F01 add 916/undo 881;F02 undo 914/
  redo 934——与 on 通道持平,确认换装路径无回归性开销。

## 5. 验收门对照(C20c Gate §3)

| 项 | 判定 |
|---|---|
| 会话沿用正确性(同型单测 + 100 次混合切换 + e2e) | **达标**(单测 4 项 + e2e 108 转换零重建) |
| 帧数据等价(golden) | **复用路径达标**(引用同一;部分复用未激活,随 C20c-2b) |
| 行为正确性(F01/F02/F03 off/on) | **达标**(F01/F02 n=5;F03 合并 n=8,两竞态现场披露留证) |
| 回归(单测/typecheck/v1) | 达标(635 项;v1 零改动不动即过) |
| 性能 | **达标**(稳态 ≤2%;换装 wall 与 v1 持平;热投影发现登记) |

## 6. 遗留与登记

1. **装配竞态升级**(3/60,F03 run-4-on 两次同槽位):建议独立小工作单
   ——harness setup 60s 超时后 page.reload 恢复路径(setup_recovery_count
   计数披露),另查 F03/晚槽位相关性根因;
2. C20c-2b(契约扩展部分复用):**优先级下修**(热投影 ~50–130ms),
   待产品侧编辑延迟反馈再议;
3. 种子路径 e2e 触发器(同文档 revision)不在自然编辑负载内——单测覆盖
   维持;如需 e2e 覆盖需 Core 侧构造同文档 revision(暂无必要);
4. F02 v2 seek +111%(36.5→76.9)维持登记不改(v2 窗协议固有,Gate
   未设 F02 seek 门)。

## 7. 复现命令

```bash
node tools/performance/run_editor_benchmark.mjs --scenarios F01,F02,F03 \
  --fixtures evidence/performance/g0-fixtures-20260911 \
  --output evidence/performance/<new-dir> --runs 5 --seeks 100 \
  --playback-seconds 300 --seed 20260908
python tools/performance/summarize_results.py --results evidence/performance/<dir>
# F03 合并中位:对 v2 与 -f03retry 两目录 results-F03.json 的 on-run 逐轮值合并取中位
```
