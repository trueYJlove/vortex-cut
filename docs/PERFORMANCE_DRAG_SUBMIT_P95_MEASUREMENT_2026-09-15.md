# 拖动/缩放输入至下一次绘制提交 p95 实测报告(2026-09-15)

**性质**:性能专题审查(2026-09-15)处置建议第 2 项落地——补齐计划第 8 节
验收矩阵"拖动/缩放输入至下一次绘制提交"行的真实测量。该行此前从未
测量(A06 报告自认"App 层正式 p95 拖动/绘制延迟由 B00 诊断入口采集
(本单未做)",G0 harness 只有 seek/decode/upload/submitted 指标)。

## 1. 结论

**矩阵行达标(F01,诊断通道 on,5 轮 × ~344 事件/轮,合并 n=1,719)**:

| 指标 | 矩阵门 | 实测(合并 n=1719) | 判定 |
|---|---|---|---|
| p50 | — | **4.8ms** | — |
| p95 | ≤50ms | **31.3ms** | **达标** |
| p99 | ≤100ms | **40.9ms** | **达标** |
| max | — | 51.0ms | 单样本贴 p95 门,不构成门判定 |

分轮(逐轮 p95 28.7–34.5ms,n=339–346/轮,轮间离散小):
run-0 29.8 / run-1 34.5 / run-2 31.3 / run-3 31.0 / run-4 28.7(中位 31.0)。
off 通道零事件(探针关闭不记录,既有断言语义不变)。

## 2. 测量口径

**事件链路**(与既有 submitted 遥测同口径,GL 命令已提交、非 GPU 完成/
呈现——产品侧一致的诚实边界,timing_semantics 字段声明不变):

1. **起点**:`PreviewSession.seekToFrame` 入口(用户拖动进度条 →
   playhead → 预览组件 effect → 此处)——覆盖"输入事件 → React 状态 →
   store dispatch → seek 发起"的完整输入侧链路;
2. **终点**:结果帧 `compose()` 调用返回(绘制命令组装 + postMessage
   提交到 GL worker 完成);
3. **探针**:新 PerfKind `drag_to_submit`(`perf-metrics.ts`),起点经
   `pendingDragSubmitT0` 携带到 compose 内落样;探针关闭(off 通道)
   零记录;播放 pump 的常规 compose 不落样(仅 seek 链路)。

**拖拽负载形状**(harness 新增相位,置于 seek 相位后、播放相位前):
每轮 100 次拖拽——真实 pointer 事件序列(mouse.down → 拖动 move×3
(每步 30ms 间隔、±60px 随机轨迹) → mouse.up)+ 固定 300ms 落定间隔
(与 seek 相位同形状,负载可比);每次拖拽风暴中的中间帧由 epoch
latest-wins 语义作废(latest-wins 即用户所见),落定的完整链路全部落样
(每轮 ~344 事件 = 100 次拖拽 × 平均 3.4 次落定 seek:拖动 move 每步
经 0.5s 偏差门触发一次外部 seek)。

**证据**:`evidence/performance/drag-p95-f01-20260915-v4/`
(v4 = 探针二进制;同日 v2/v3 为二进制指纹校准轮——v2 撞已知装配竞态
1 次(1/22 启动,与 3/60 登记同形态,warmup 失败留证),v3 = HEAD 二进制
对照全过,证明 v2 失败非新代码回归)。运行配置与 G0 同源(同夹具
g0-fixtures-20260911/manifest.json、同 seed 20260908、playback 60s
——拖拽相位不依赖播放时长,采样形状与全轮一致)。

## 3. 变更清单

- `apps/desktop/src/app/preview/perf-metrics.ts`:PerfKind 增加
  `drag_to_submit`;
- `apps/desktop/src/app/preview/preview-session.ts`:seekToFrame 置
  起点(`pendingDragSubmitT0`),compose 提交后落样并清零;
- `apps/desktop/e2e/performance-editor.spec.ts`:新增拖拽相位
  (pointer 序列 + drag/drag_action_wall 字段入样本),超时预算
  +45s/run,unavailable 登记"timeline-zoom drag(canvas-only 路径)";
- `apps/desktop/tests/perf-metrics.test.ts`:drag_to_submit 落样
  形状单测。

**已知限制(如实登记)**:
- 时间线缩放(Ctrl+wheel)只落 timeline 层绘制,不触发合成预览
  compose——不在本事件口径内,unavailable 数组披露;矩阵行"缩放"维
  的合成侧路径实际不存在(缩放不改变预览画面);
- "真实呈现"(presentation)仍为既有 unavailable 维度(submitted
  ≠ presented,与 G0 冻结口径一致)。

## 4. 复现

```powershell
# 构建(诊断二进制)+ 运行(约 28 分钟,playback 60s 折短)
cd apps\desktop; $env:VITE_AIVS_PERF="1"; npx electron-vite build
cd ..\..
node tools/performance/run_editor_benchmark.mjs --scenarios F01 `
  --fixtures evidence/performance/g0-fixtures-20260911 `
  --output evidence/performance/drag-p95-f01-20260915-v4 `
  --runs 5 --seeks 100 --playback-seconds 60
# 汇总:results-F01.json 的 drag.events 中 kind=drag_to_submit 的
# duration 字段,5 轮 on 通道合并 p95(runner 同款 p95 算法)。
```

单测:`apps/desktop/tests/perf-metrics.test.ts`(drag_to_submit 形状)。
