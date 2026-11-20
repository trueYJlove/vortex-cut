# B13/C20 二阶段/C20-T 独立验收评审(2026-09-13)

角色:LiuKeAi(独立复核,不对开发者自测背书,全部关键数字独立重算)。
评审依据(四份提请材料的验收条款):
- C20-T/B11-D Planning Gate §3(`PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md`):"默认 on 决策仅当 T1/T2 达标**且** B13+C20 二阶段独立验收通过后,作为独立决策项提请(LiuWei)";
- B13-R 实施报告 §7:"B13 独立验收建议与本报告一并提交评审";
- C20 二阶段 A/B 报告 §1:"独立验收:待验收";
- C20-T1/T2 验收 A/B 报告 §1:"独立验收与'默认 on'决策:待 LiuKeAi 复核"。

## 1. 结论

**有条件批准(2026-09-13,LiuKeAi)。**

- 无 Blocker。3 个 Minor 均为报告数值/口径更正(不要求重采样、不改任何
  判定),已在原报告修订落实(§4);勘误候选一项**升级为确认**(§5)。
- 五个交付物验收通过:**S1 小修包、C20-T1、C20-T2、C20 二阶段(v2 数据
  面)、B13/R 判别+护栏**;**B11-D 关闭的证据链复核无误**(裁决本身属
  LiuWei 权限,已签,不在复核范围)。
- 两项上交裁量(F03 ready +7.7% 超线定性、F02 段外残差):**同意原报告
  定性**,均不构成验收阻断(§6)。
- "默认 on"决策的前提(T1/T2 达标 + 独立验收通过)**成立**,按 Gate §3
  提请 LiuWei(§7);v2 默认 off 在裁决前维持。

## 2. 范围、方法与证据链

| 交付物 | 报告 | 关键证据目录 |
|---|---|---|
| S1 小修包 | `PERFORMANCE_S1_SMALLFIX_IMPLEMENTATION_2026-09-12.md` | (单测层,无基准轮) |
| C20-T1 | `PERFORMANCE_C20T1_WINDOW_TUNE_IMPLEMENTATION_2026-09-12.md` | `c20t-ab-20260912-v1/-v2/` |
| C20-T2 | `PERFORMANCE_C20T2_READY_IMPLEMENTATION_2026-09-12.md` | 同上 + `-v2-f03retry` |
| C20 二阶段 | `PERFORMANCE_C20_PHASE2_IMPLEMENTATION_2026-09-11.md` + `PERFORMANCE_C20_PHASE2_AB_2026-09-12.md` | `c20v2-ab-20260911-v2`、`c20v2-f02-retry-01` |
| B13/R | `PERFORMANCE_B13_RESIDENCY_IMPLEMENTATION_2026-09-11.md` + 同名 Planning Gate | `b13r-d01/d02/d04-*`、`g0-memlong-20260911` |
| B11-D(证据复核) | `PERFORMANCE_B11D_PROXY_DECISION_MEMO_2026-09-12.md` | `b11d-spike-20260912` |

方法(全部本机独立执行,不采信报告表格):
1. **汇总工具重跑**:`summarize_results.py` 对 c20t 四目录逐场景复算;
2. **原始 JSON 重算**:按 runner 同款算法(`percentile = sorted[int((n-1)×0.95)]`
   再取轮中位)从 `results-*.json` 重算逐轮/中位/合并值与关键百分比;
3. **ready 分段遥测重算**:v2 样本 `ready_segments.durations.ready_*` 四段;
4. **测试套件复跑**:Desktop 单测 69 文件 **625 项全过**、零 unhandled
   rejection(2026-09-13 本机,35.9s)——与 T1/S1 报告声明(622+3)一致;
5. **代码抽查**:S1(redact/sanitizeErrorDetail/runner 落盘)、T1
   (windowPrefetchStarts 纯函数/windowSourceBudget 夹紧上限)、T2
   (scheduleWindowPrefetch/extendPipOverlayIndex 增量并入)、B13
   (predictResidencyBytes/framesLive 推导/catch-close)逐点命中;
6. **指纹核对**:四证据目录 run-config 与报告声明一致(v1 轮
   `04c5997a…`,v2/spike/f03retry `42585dad…`,commit `fd8d7ed`,spec
   版本差与 AB 报告 §2 登记吻合,app 二进制不受 spec 差异影响)。

## 3. 逐项复核结果(报告值 vs 独立重算)

| 项 | 报告值 | 独立重算 | 判定 |
|---|---|---|---|
| S1:单测/拒绝归零 | 622 项全过、unhandled rejection 归零 | 625 全过(含 T1 +3),零 rejection | **符合** |
| S1:脱敏落地 | redact 补 restricted-media、failure.json 三字段 | logging.ts:10/18 + spec:509–513 命中 | **符合** |
| T1:F01 seek p95 | v2 相对 v1 退化收敛 ≤20% | 29.7→29.1ms(**-2.0%**,fresh v1 基线) | **达标** |
| T1:F03 seek p95 | 同上 | 32.0→30.7ms(**-4.1%**,合并 n=8,逐轮值重算一致) | **达标** |
| T1:F01 seek 相期取窗 | 0(预取全命中) | results-F01 window_fetch 遥测与 §6 一致 | **符合** |
| T2:F01 ready | +2.6% ≤5% | 2343→2404ms(+2.60%) | **达标** |
| T2:F02 ready | -10.7% | 5771→5153ms(-10.71%) | **达标** |
| T2:F03 ready | +7.7% 超线,如实报 | 6378→6869.5ms(+7.71%);vs c20v2 6888 = -0.27% 持平 | **超线定性成立**(§6.1) |
| T2:四段遥测 | F01 m378/i137/w138;F02 m1796/i201/w202 | 重算 378.5/137.2/137.6;1795.8/201.1/201.6 | **符合** |
| off 复测 ±5% | 全部 ≤±3.9% | 逐项复算 F01 -1.8/+1.7/-0.3;F02 -0.2/-4.5/+0.0;F03 +1.1/+3.9/-0.9 | **符合** |
| C20 二阶段:行为正确性 | 停滞修复(31–32fps)、decode 7948/300s | 与 G0 v1(7848)同型;B13 轨迹交叉印证 | **符合** |
| C20 二阶段:归因修正 | IR 帧表 13.5MB 可忽略,F02 内存=解码驻留 | 与 B13 三轴判别(framesLive=0、HW/SW/copyTo 重合)互证 | **成立** |
| B13:判别证据 | 三轴曲线重合、~600KB/帧平台 | d01–d04 目录在档;平台值与 g0-memlong 2400s 一致 | **证据链闭合** |
| B13:R3 预测器 | 常数模型,±2% 级偏差 | resource-budget.ts:101;B11-D1 回填 631KB/帧后偏差 -2.1%/-1.9% | **符合** |
| B11-D1:spike Tab WS | 16,649MB(极差 28MB) | 逐轮 16622/16648/16650/16649/16649,中位 16,649;decode 7938/300s=26.5/s | **复算一致** |
| B11-D1:判定 | 缩放律证伪(≈4.4GiB 预测落空) | 320×180 vs 640×360 = -0.35%,在轮内噪声内 | **判定成立** |

## 4. Minor 更正(3 项,已在本轮修订原报告落实)

1. **F01 seek 百分比基线混用**:AB 报告 §1/§3/§4 的"-0.4%"实为对 G0
   (29.2ms)的偏差;对 fresh v1(29.7ms)为 **-2.0%**。两口径均大余量
   通过 ≤20% 门,不影响判定;已统一为 fresh v1 基线,并同步把 F03 统一
   为合并 n=8 口径(30.7/-4.1%,原稿 -3.8% 用了主目录 3 轮子集)。
2. **F03 ready 分段子集未标注**:§4 的 m4299/i164/w165 为 f03retry 目录
   5 轮中位;合并 n=8 为 **m4144/i165/w166**。已改用合并口径;
   "manifest 随源大小缩放"结论不变(4.06–4.30s 带内)。
3. **spike ready 中位**:备忘录 5,507ms 不可从 `results-F02P.json` 复算
   (on 轮与全 11 启动中位均 = **5,484ms**);非判定指标,已更正。

## 5. 勘误候选裁决:确认

c20v2 A/B 报告 §3 的 F03 seek p95 "39.7ms(+29%)"**确认混入修复前目录**
`c20v2-ab-20260911` 的逐轮中位(40.3/39.7/36.8/36.3/45.8ms);引用目录
`c20v2-ab-20260911-v2` 逐轮 42.2/31.2/29.3/30.8/31.1ms,中位 **31.1ms**
(+1% vs G0 30.8)。正确口径已回填 AB 报告 §8.2 与主计划更新·九;
原"勘误候选"登记销账。F01 的 +31% 结论可复算,不受影响。

## 6. 上交裁量项意见

1. **F03 ready +7.7%(严格口径超 ≤5% 线 2.7pt)**:同意"v2 manifest
   投影固有、非 T1/T2 引入"——独立重算 6869.5ms vs T2 前 c20v2
   6888ms = -0.3%,本轮改动对 F03 ready 中性成立。不重定门、不追溯
   T2;后续压缩方向(投影缓存/增量,契约层)挂 C20c/下一工作包候选。
2. **F02 段外残差 ~2.9s(~56%)**:同意列为"ready <2s"目标的主战场;
   段外链(导入+装配 patch、页面重载、项目恢复、播放头起步)当前未
   分段,先补分段测量再立项——登记为下一工作包候选输入,本轮不实施。
3. **F02 v2 seek +111%(36.5→77.2ms)**:同意"v2 窗协议固有、登记不改"
   (Gate 未设 F02 seek 门;T1 前后持平 78.3→77.2)。绝对增量 <41ms,
   对"默认 on"决策属**已知限制**而非阻断,应随决策材料如实随行(§7)。

## 7. 对"默认 on"决策的评审意见

Gate §3 两项前提(T1/T2 达标、独立验收通过)均已成立。评审者立场:
材料齐备,建议提请 LiuWei 裁决;随行材料须如实包含——F02 类随机全谱
seek 的取窗等待(+111%)、F03 ready manifest 投影成本(+0.5s 量级)、
F02 低频崩溃待查(S1 诊断前提已备,与 v2 无关联证据)三项已知限制,
以及回退开关(`VITE_AIVS_PREVIEW_IR_V2=0`)的保留。裁决与落地见
`PERFORMANCE_C20V2_DEFAULT_ON_DECISION_2026-09-13.md`。

## 8. 遗留(不因本验收关闭,与 B13-R/AB 报告登记一致)

- F02 低频崩溃待查(下次复现经 failure.json 脱敏错误文本取证);
- 装配竞态偶发(~1/50 启动,harness 已知脆点,无恢复路径);
- 4K60 两缺陷(DEFECT-4K60-SEEK/SESSION-HANG)产品侧工作单;
- F04 升回 100 素材口径(前置 GAP-LIST-ASSETS-PAGING 产品修复);
- Chromium 上游方向(未立项)、direct 模式纹理记账口径(随上游挂起);
- F07 双位置混音(跨轨重叠产品缺陷)。

## 9. 复核复现命令

```bash
python tools/performance/summarize_results.py --results evidence/performance/c20t-ab-20260912-v1
python tools/performance/summarize_results.py --results evidence/performance/c20t-ab-20260912-v2
python tools/performance/summarize_results.py --results evidence/performance/c20t-ab-20260912-v2-f03retry
python tools/performance/summarize_results.py --results evidence/performance/b11d-spike-20260912
# 勘误复算:对 c20v2-ab-20260911 与 -v2 两目录的 results-F03.json 逐轮 seek p95 取中位(39.7 vs 31.1)
cd apps/desktop && pnpm test   # 69 文件 625 项
```

**独立 Reviewer 结论:有条件批准**(条件 = §4 三项数值更正,已全部落实)。
Gate 决策与下一步:"默认 on"提请 LiuWei(§7);F02 段外残差与 manifest
投影压缩进下一工作包候选清单。
