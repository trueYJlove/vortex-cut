# C20c-1/-2 + harness 恢复路径 + D11 独立验收评审(2026-09-14)

角色:LiuKeAi(独立复核,不对开发者自测背书,全部关键数字独立重算)。
评审依据(验收条款来源):
- C20c Planning Gate §3(`PERFORMANCE_C20C_PLANNING_GATE_2026-09-13.md`):
  会话沿用正确性/帧数据等价/行为正确性/性能/回归五项判定;
- C20c 验收 A/B 报告 §1:"独立验收:待验收"(B13+C20-T 独立验收 2026-09-13
  完成后,C20c 为其后续交付);
- harness 恢复路径报告(`PERFORMANCE_HARNESS_SETUP_RECOVERY_2026-09-13.md`):
  机会性验证口径(恢复分支由真实轮次计数审计);
- D11 两步交付(更新·十四/·十五/·十六):用户 2026-09-14 已裁决关闭,
  本次复核其证据链(裁决本身属 LiuWei 权限,不在复核范围)。

## 1. 结论

**通过(2026-09-14,LiuKeAi)。**

- 无 Blocker,无 Major。1 个 Minor 为报告数值更正(F03 热重投影范围下界,
  §4),不改变任何判定,已按登记更正落实。
- **C20c-1(revision 换 manifest 沿用会话)、C20c-2(缓存窗口迁移)、
  C20c A/B harness 扩负载(revision 相位)、harness setup 恢复路径、
  D11 两步(显式天花板+预警验证/升版对拍 spike)验收通过。**
- perf 线至此无未闭环的门禁项;后续工作全部为立项候选/产品侧/触发式
  挂账(§5)。

## 2. 范围、方法与证据链

| 交付物 | 报告 | 关键证据目录 |
|---|---|---|
| C20c-1 | `PERFORMANCE_C20C1_SESSION_SWAP_IMPLEMENTATION_2026-09-13.md` | `c20c-smoke-f01-01/02/03`、`c20c-smoke-f02-01/02` |
| C20c-2 | `PERFORMANCE_C20C2_SEED_REUSE_IMPLEMENTATION_2026-09-13.md` | 同上(单测层) |
| C20c A/B 验收 | `PERFORMANCE_C20C_AB_ACCEPTANCE_2026-09-13.md` | `c20c-ab-20260913`(竞态留证)、`-v2`、`-v2-f03retry` |
| harness 恢复路径 | `PERFORMANCE_HARNESS_SETUP_RECOVERY_2026-09-13.md` | F01 冒烟(recovery=0)+ 后续各轮 recovery 计数 |
| D11 第一步/第二步 | `PERFORMANCE_D11_RESIDENCY_CEILING_*`、`PERFORMANCE_D11_ELECTRON44_SPIKE_*` | `d11-residency-warn-20260914`、`d11-residency-warn-f01-20260914`、`d11-electron44-20260914`、`d11-e44-smoke-f01` |

方法(全部本机独立执行,不采信报告表格):
1. `summarize_results.py` 重跑(c20c-ab-v2 全场景);
2. 原始 JSON 重算(runner 同款 p95 算法 + 轮中位/合并中位);
3. Desktop 单测套件复跑(70 文件 635 项);
4. 代码抽查(replaceIr/frame-source/预警采集);
5. 指纹一致性核对(run-config vs git 历史);
6. 竞态现场留证核对(failure.json + user-data)。

## 3. 逐项复核结果(报告值 vs 独立重算)

| 项 | 报告值 | 独立重算 | 判定 |
|---|---|---|---|
| 稳态回归 F01 ready | ≤±2% 对 c20t-v2 | 2404→2452ms(**+2.00%**,恰在门上) | **达标** |
| 稳态回归 F01 seek | ≤±2% | 29.1→29.2ms(+0.34%) | **达标** |
| 稳态回归 F02 ready/seek | ≤±2% | 5153→5130ms(−0.45%)/77.2→76.9ms(−0.39%) | **达标** |
| 稳态回归 F03 ready | ≤±2%(合并 n=8 对 n=8) | 6870→6834ms(**−0.51%**);合并中位 6834 与报告声明逐位一致 | **达标** |
| 零重建(ready_inject=0) | 108 转换零重建 | 实测 on 通道 15 样本 ×6 = **90 转换 ready_inject>0 计数=0**(108 = 含 warmup 18;口径如报告) | **达标** |
| 换装 wall 与 v1 持平 ±1% | 持平 | F01 **+0.06%**/F02 **+0.92%**/F03 **−0.11%** | **达标** |
| 取窗形状 | F01=2/F02=7/F03=2–3 | window_fetch 中位逐场景一致(F01=2、F02=7) | **符合** |
| 热投影 F02 | 66–350ms | 66.5–350.5ms(n=30,中位 130.4) | **符合** |
| 热投影 F03 | 42–62ms | **27.5–62.4ms**(n=24,中位 45.8)——报告范围下界偏保守 | **符合(Minor,§4)** |
| 单测复跑 | 635 项全过 | 70 文件 **635 项全过**,零 unhandled rejection(36.2s) | **符合** |
| 竞态 3/60 登记 | F01 warmup-on + F03 run-4-on ×2 | 三处 failure.json 逐处核对一致(synthetic + canvas 不可见形态),user-data/desktop.log 留证在位 | **符合** |
| 指纹 | 两轮同二进制 | 同 commit `89f28d2c` + 同 fingerprint + dirty 互指对方输出目录;spec 五个 C20c 特征点(revision 相位两模式/HEAD 轮询/refine 收敛/SCENARIOS 守卫)在该提交全部在位 | **一致** |
| 代码抽查:replaceIr | sig 校验/音频窗口重置/原子索引重建 | `preview-session.ts:479–514` 逐点命中(输入签名不等拒绝换装→整会话重建;windowChanged 五元组重置;rebuildPipOverlayIndex 原子重建) | **命中** |
| 代码抽查:frame-source | seedWindows/snapshotWindows/LRU 记账 | `frame-source.ts:32/67/99/127/239` 逐点命中 | **命中** |
| D11 预警采集 | F02 3/3 触发/F01 3/3 不触发 | `d11-residency-warn-20260914` 与 `-f01` 样本字段核对一致;F02 分段轮 6/7 样本预警在位 | **符合** |
| D11 对拍判定 | −0.40% 未命中 | (复核口径:同 fixture sha256/同 seed/同形状;判定门 ±5% 余量 5 倍于噪声,结论稳健) | **复核无误** |
| 恢复路径 | recovery 计数审计口径 | c20c 三轮 recovery=3 处 failure 现场均被 reload 恢复后重跑(计入计数);D11/分段轮 recovery=0 常规路径透明 | **符合**(机会性验证口径如报告,无夸大) |

## 4. Minor 更正(已落实)

1. **F03 热重投影范围**:报告 §5 声明"42–62ms",独立重算 n=24 范围为
   **27.5–62.4ms**(中位 45.8)。下界 42 → 27.5 为更正;方向与结论
   (热投影便宜,C20c-2b 优先级下修)不变。原报告不要求重采样。

## 5. 遗留清点(验收后 perf 线状态)

- **门禁项清零**:22 个修改单全部处置(20 交付 + C23/C24 裁定不实施),
  各轮独立验收全部完成,无"待验收"遗留。
- **立项候选**(实测依据已齐,待排期):Core manifest 投影缓存/增量
  (命中收益 ≈1.8s/冷启动,用户口径 ready 可达 ~0.7s)。
- **产品侧并行**(非 perf 范围):DEFECT-4K60-SEEK、DEFECT-4K60-SESSION-HANG
  (高优)、GAP-LIST-ASSETS-PAGING、GAP-CROSS-TRACK-OVERLAP;
  corsEnabled:true(Electron 升级触发式)。
- **触发式挂账**:装配竞态根因排查(等现场;本轮 0/22 次启动无新现场)、
  C20c-2b(等产品编辑延迟反馈)、F02 v2 seek +111%(等产品反馈)。

## 6. 复现命令

```bash
python tools/performance/summarize_results.py --results evidence/performance/c20c-ab-20260913-v2
cd apps/desktop && node node_modules/vitest/vitest.mjs run
```
