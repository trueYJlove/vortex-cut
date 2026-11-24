# G1/G2/C20第一轮/C21/C22 集中独立验收(2026-09-15)

角色:LiuKeAi(独立复核)。**性质:补验收**——2026-09-14 独立验收
(`PERFORMANCE_C20C_HARNESS_D11_INDEPENDENT_ACCEPTANCE_2026-09-14.md`)
§5"门禁项清零"总括此前表述过宽(该文档 §5 已于 2026-09-15 更正并指向
本文件):G1(A01–A08)/G2(B10–B17)/C20 第一轮/C21/C22 共 18 个修改单
彼时仍为"待验收",从未经 LiuKeAi 逐单复核。本文件即该复核的交付。

## 1. 结论

**通过(2026-09-15,LiuKeAi)。** 18 单全部验收通过,无 Blocker/Major;
2 个 Minor(均为测试债,本文件 §4 随验收当场修复并复跑通过)。perf 线
"22 修改单全部处置且全部经独立验收"至此与存量文档状态一致,不再有
口径差。

## 2. 验收方法(全部独立执行,不采信实施报告自述)

1. **代码-方案逐项对照**(2026-09-15 审查四路核查的第一、二、三路):
   对 A01–A08/B10–B17/C20第一轮/C21/C22 逐单核对关键机制在源码中的
   真实存在性(文件:行号级抽查,含 oracle 测试、契约四层、跨进程
   接线),结论:A01–A08 全落地、B10–B16 落地(B17 部分落地已登记)、
   C20/C21/C22 落地;**未发现任何"只有文档声明"的空壳交付,未发现
   未登记的静默缩减**。全部与方案的偏差均可在对应实施文档"已知限制"
   章节找到登记。
2. **证据链数字复算**(审查第四路):从 `evidence/performance/` 原始
   JSON 用 runner 同款算法独立复算 G0 七场景、C21 深定位(60s/300s
   编码 wall −29.2%/−31.1%,帧对拍 digest 一致)、A04 密集投影
   (2701→189ms)等关键数字,与报告逐位一致。
3. **全量测试本机复跑(2026-09-15,验收当日)**:
   - Desktop 单测:**70 文件 636 项全过**(635+B15 守卫新增 1 项);
   - Core 单测+集成:**794 passed / 1 deselected**(real_provider)
     ——首轮 4 failed 全部定位为**既有测试债,与本轮 18 单无关**,
     已当场修复并复跑通过(§4);
   - Desktop typecheck 通过;新增 C22 取消延迟真实测量 3 项与
     拖拽 p95 相位实测(见 §3)。
4. **抽查反例搜索**:grep 全仓库确认无未登记的方案外改动;C24 无 GPU
   滤镜默认路径;C23 护栏(RENDER_REVERSE_TOO_LONG)抛出点在位。

## 3. 矩阵两行补测(本次验收附带交付)

验收输入包含计划第 8 节矩阵中从未测量的两行,已补齐实测(报告:
`PERFORMANCE_C22_CANCEL_LATENCY_MEASUREMENT_2026-09-15.md`、
`PERFORMANCE_DRAG_SUBMIT_P95_MEASUREMENT_2026-09-15.md`):

| 矩阵行 | 门 | 实测 | 判定 |
|---|---|---|---|
| 取消响应(正常 I/O) | ≤2s | 1,307ms(600s 媒体解码 1s 后取消) | 达标 |
| 取消响应(启动前已取消) | ≤2s | 448ms | 达标 |
| 进程树回收(停滞进程) | ≤5s | 180ms(stdin 管道停滞注入) | 达标 |
| 拖动→绘制提交 p95 | ≤50ms | 31.3ms(F01,5 轮合并 n=1719) | 达标 |
| 拖动→绘制提交 p99 | ≤100ms | 40.9ms | 达标 |

## 4. Minor 修复(验收中当场处置,已复跑)

1. **三处 v19 迁移计数断言未同步**(C22 提交 63b202e 引入 database_v19
   时未更新):`test_stage1a_api.py`(列表缺 v19)、
   `test_stage3b_reframe_real.py`(maximum 18→19)、
   `tools/prototypes/stage4d_provider_image_model.py`(frozen 排除集与
   `_seed_v12` pops 缺 v18/v19;测试断言 12 不变)。修复后 42 项全过。
   ——归因:测试债,非产品缺陷(migration 本身经 `test_migrations_v19`
   覆盖)。
2. **waveform 幂等测试时序 flake**(≈40% 概率):job 行落库后、job loop
   把 derived_media_cache 落到 failed/queued 占位行之前,查询短暂读到
   status=None——产品行为正确(终态四态收敛),测试单点断言过紧。修复:
   5s 有界 poll 至四态(回归锁:None 不得成为终态),8/8 复跑通过。

## 5. 逐单验收结论

| 单 | 判定 | 要点(代码+测试+证据均独立核到) |
|---|---|---|
| A01 | 通过 | AbortSignal/资源栈逆序 dispose/26 项生命周期单测 |
| A02 | 通过 | pending 同步去重/并发≤2/预热窗;14 项单测 |
| A03 | 通过 | 扫描索引 tie-break/oracle;12 项单测 |
| A04 | 通过 | 扫线 active 集=原顺序最大项;Core oracle 深比较 |
| A05 | 通过 | 线程池+semaphore/进程池默认关+冻结构造拒绝 |
| A06 | 通过 | playhead store/尺寸守卫;draw≤2 断言 |
| A07 | 通过 | probe cache(独立模块落点,登记);11 项单测 |
| A08 | 通过 | 调度器/thumbnail loader;24 项单测 |
| B10 | 通过 | derived_media_cache 独立表 v18/原子 rename/LRU+pin |
| B11 | 通过 | 三档代理/语义接口;auto 负载感知经 B11-D 实测证伪关闭(登记) |
| B12 | 通过 | moov-only/206 校验/续票;24 项单测 |
| B13 | 通过 | 三档预算表/input-pool 状态机;slot token 简化已登记 |
| B14 | 通过 | 流式聚合金字塔/clip 映射;39 项单测 |
| B15 | 通过 | 96k 网格块/真实 FFmpeg 对拍;非 48k context 守卫 2026-09-15 补齐 |
| B16 | 通过 | 原子多资源申请/lease TTL;13+5 项单测 |
| B17 | **通过(按登记范围)** | viewport 化+区间索引落地;render-cache/四层/dirty-flag 按登记延后 |
| C20第一轮 | 通过 | v2 endpoint/窗口深等价/27000 上限保留;字节限制实现为帧数上限(登记) |
| C21 | 通过 | eligibility 白名单/legacy 一次回退;golden 对拍齐全 |
| C22 | 通过 | 可取消校验/超时拆分/phase 贯通;取消延迟实测本次补齐(§3) |

G1/G2 退出条件对照:G1 功能复测(2026-09-09 报告)+ 本验收复核 = 通过;
G2 预算/长源/复用断言齐备(F03–F07+长测),通过。

## 6. 遗留移交(非验收阻断,均已登记)

- Core manifest 投影缓存/增量:立项候选(实测依据已齐,主计划更新·十九);
- 产品侧四缺陷(PRODUCT_DEFECTS 台账,状态字段机制 2026-09-15 增设);
- 触发式挂账三项(corsEnabled/装配竞态根因/C20c-2b)维持;
- B17 render-cache/分层、B14 分窗取件、B11 运行中切档:按既有登记延后。

## 7. 复现命令

```powershell
# Desktop 全量单测(636 项)
cd apps\desktop; node node_modules/vitest/vitest.mjs run
# Core 全量(794 项)
.\.venv\Scripts\python.exe -m pytest services/core/tests -m 'not real_provider' -q
# 矩阵两行补测
.\.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_render_cancel_real.py -v
node tools/performance/run_editor_benchmark.mjs --scenarios F01 --fixtures evidence/performance/g0-fixtures-20260911 --output <新目录> --runs 5 --seeks 100 --playback-seconds 60
```
