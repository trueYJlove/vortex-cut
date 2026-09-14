# F02 段外启动链残差分段测量工作单报告(2026-09-14)

依据:独立验收 `PERFORMANCE_B13_C20T_INDEPENDENT_ACCEPTANCE_2026-09-13.md`
§6.2(裁定原文:"段外链当前未分段,**先补分段测量再立项**——登记为下一工作
包候选输入")与 C20-T2 A/B 报告 §5(段外 ~2.9s/~56% 未分段)。**仅 harness
改动,产品代码零改动。**

## 1. 交付内容(`performance-editor.spec.ts`)

- **inPage 时间线分段**(F02/F02P 装配函数):`assemble_timings` 记录
  createProject / importFixture / createTimeline / patch 批次(逐批数组)/
  captions patch 各段耗时——`performance.now()` 记账,调用序列零改动。
- **node 侧相位分段**:`ready_phases_outside` 记录 inPage 结束前
  (t0_to_inpage_end)/ 项目断言 / 重载+状态收敛 / 播放头起步四段,与
  `ready_ms` 同窗对齐,进 `scene_extra`(键新增,历史形状兼容)。
- **harness 修正**:终态 `editor.png` 截图改为显式 10s timeout + 失败不弃
  样本(`screenshot_failed` 字段披露)——首轮 warmup 出现 screenshot 30s
  默认超时把已完整测量完的样本整轮作废,纯取证动作不应有否决权。

## 2. 测量结果(证据 `evidence/performance/f02-segmented-20260914/`,
F02 runs=3×off/on + warmup,seeks=100,playback=300s,seed 20260908)

**ready_ms 中位 5,225ms**(5,139–6,140;recovery=0,预警字段 6/7 样本
在位)。逐段中位:

| 段 | 中位 | 占比 | 内容 |
|---|---:|---:|---|
| ① inPage 时间线装配链 | 1,686ms | 32.3% | createProject 32 + **导入 fixture 428** + createTimeline 25 + **9×patch 批合计 1,038** + captions 151 |
| ② 重载+状态收敛段 | 2,433ms | 46.6% | 页面重载+App 启动+项目恢复+React 挂载(**内嵌装配段**:manifest 投影 1,806 为主干,inject/window 211 并行已收敛其中) |
| ③ 播放头起步 | 986ms | 18.9% | 播放点击→播放头 >500ms |
| ④ 项目断言 | 22ms | 0.4% | expectCurrentProject |
| **合计** | **5,127ms** | 98.1% | 与 ready_ms 5,225 差 ~100ms(轮询粒度) |

**patch 批次斜率**:44ms(第 1 批)→ 171ms(第 9 批)线性增长——与
累积段数/字幕数的增量索引成本一致(1,800 段+字幕规模下每批多 ~14ms)。

**两报告口径拼接校验**:T2 报告的"段外 ~2.9s"= 本轮 ①+②中 ②减装配段
+③+④ ≈ (2,433−1,806) + 986 + 22 + 轮询残差 ≈ 2.9s ✓——历史归因闭合。

## 3. 归因结论与 <2s 可行性初判(供立项决策,本轮不实施优化)

ready 5,225ms 的构成按"可优化性"分三类:

1. **Core manifest 投影 1,806ms(35%)**——随源大小缩放,契约层
   投影缓存/增量为对应解法(C20c Gate §2 排除项,独立候选)。分段轮给出
   其冷/热边界的进一步证据:同一投影在 revision 切换时仅 42–62ms
   (C20c 轮实测),说明 1.8s 几乎全是首投影预热——**缓存命中场景下此项
   可视为可消除**。
2. **harness 负载自设项 ~2.6s(50%)**——导入 fixture(428ms,基准固有的
   全量导入)+ patch 批(1,038ms,9 批串行 patch 本身)+ 播放头起步
   (986ms,含 5 帧播放推进)。这些是**测量负载的构成**,不是产品启动链
   的病:真实用户"重开项目到预览可播"不经历 234MB 导入与 1,800 条 patch。
   即 ready_ms 门若要 <2s,先要定义清楚**用户口径**(重开已有项目)与
   **基准口径**(含装配)的分离——前者 = ②段(2,433ms)≈ 已接近目标,
   其再压缩空间在 manifest 投影缓存(命中后 ≈600ms)。
3. **真·产品启动链 ~400–600ms**——页面重载+App 启动+项目恢复+React
   挂载,量级健康,无独立工作单价值。

**初判**:"ready <2s"在**用户口径(重开已有项目)**下经 manifest 投影
缓存可达(2,433 − 1,806 + ~50ms 命中 ≈ 0.7s);在**基准口径**下受
harness 负载构成支配,不应设绝对值门。→ Core manifest 投影缓存/增量
(C20c Gate §2 排除项第 1 条)的立项依据从"按实测另立"升级为
**实测已齐:命中收益 ≈1.8s/冷启动**,待排期决策。

## 4. 验证矩阵

| 项 | 判定 |
|---|---|
| 产品代码/契约/Core | **零改动**(仅 e2e spec) |
| typecheck | 通过 |
| 全轮 | F02 runs=3 off/on + warmup 全过(38.9min);首轮 screenshot 超时已修复且口径登记 |
| 历史口径闭合 | 本轮分段与 T2 报告"段外 ~2.9s"核算一致 ✓ |
| ready_ms 回归 | 中位 5,225 vs c20c-v2 轮 5,130 = +1.9%(≤±5% off 复测线;分段记账开销可忽略) |

## 5. 复现命令

```bash
node tools/performance/run_editor_benchmark.mjs --scenarios F02 \
  --fixtures evidence/performance/g0-fixtures-20260911 \
  --output evidence/performance/<new-dir> --runs 3 --seeks 100 \
  --playback-seconds 300 --seed 20260908
python - <<'EOF'
import json, statistics
d = json.load(open('<dir>/results-F02.json', encoding='utf-8'))
for s in d:
    if s['enabled'] and s['run'] >= 0:
        print(s['run'], s['ready_ms'], s['scene_extra']['ready_phases_outside'])
EOF
```
