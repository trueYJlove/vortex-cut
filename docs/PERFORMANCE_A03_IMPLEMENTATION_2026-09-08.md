# A03 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**A03（解码 PTS 与关键帧定位索引）代码完成 + 功能验证完成；性能验证待完成
（真机 seek 延迟对比与 m3p4 复测未跑）。**
独立验收：**待验收**（单执行者自检，不冒充独立 Gate）。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A03 修改单，在
A02（`b855278`）之上实施。未 push、未打包。

## 2. 修改单（模板）

```text
修改单：A03 PTS 与关键帧定位索引
基线HEAD / 工作树标识：b855278（A02），工作树含本单未提交改动
目标与不修改范围：
  目标——demux 后一次性构建 PTS 排序索引 + 关键帧索引；随机 seek 定位与
  关键帧回退从 O(N)/O(GOP) 线性扫描改二分；顺播游标局部推进；保留解码
  队列/热态 GOP 喂入/输出帧寿命/驱动规避逻辑不变。
  不修改——目标容差 33_334us 与错误返回语义、喂包顺序、output 半帧容差
  匹配、gopAnchor/intermediateRing 生命周期、ready 消息协议字段。
实际修改文件（绝对路径）：
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\sample-index.ts（新增）
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\decode-worker.worker.ts
  C:\DataFolder\codes\AI-Vidio\apps\desktop\tests\sample-index.test.ts（新增）
前置Gate与接口版本：B00 计数接口；A01 worker 生命周期（不涉）。
算法/状态机变化：
  - buildSampleIndex：ptsUs（原始顺序 Float64Array µs）、sampleByPts
    （PTS 升序排列的原始索引，tie-break = 原 index 小者）、sortedPtsUs、
    keyframes（sync 升序 Uint32Array）。一次性 O(N log N)。
  - locateByPts：lowerBound 二分 + 左右邻居比较（距离并列选原 index 小者，
    并列 PTS 组全组展开 tie-break——组内只看相邻位会漏组首，测试发现并
    修复）；顺播游标：目标 ≥ 游标 PTS 时局部推进（>64 步回二分防退化）；
    回退目标自动走二分。
  - keyframeAtOrBefore：二分找 ≤ sample 的最大关键帧（无 ≤ 者返回 0，
    与原"startSample 退到 0"语义一致）。
  - decode-worker.worker：decodeFrame 的 O(N) 扫描（含 ptsUs>target+100ms
    提前 break——B 帧非单调 CTS 流会漏更优解）替换为 locateByPts；
    decodeSamples 的关键帧线性回退替换为 keyframeAtOrBefore；sequential
    判定（跨关键帧检查）改为两次 keyframeAtOrBefore 比较。喂包循环不变。
新增/修改测试与命令：
  新增 tests/sample-index.test.ts（16 项）：
  - 构建：CFR 升序/关键帧序列、相同 PTS tie-break、无 stss 全关键帧回退
  - vs oracle（完整扫描不提前退出）：CFR/B 帧非单调/VFR/负 cts/重复 PTS
    各 1000 种子化随机目标逐点一致；旧提前 break 漏更优解的构造用例
  - 最后一帧/范围外/空索引；108k 样本比较次数 ≤ 2×log2+8；游标单调
    推进均摊 <4 次比较/查询；回退自动回二分
  - keyframeAtOrBefore vs 线性回退 oracle（500 随机目标）
  - 喂包顺序不变式：sampleByPts 是 0..N-1 的排列、ptsUs 原始顺序直译
  命令：apps/desktop 下 vitest run tests/sample-index.test.ts；全量。
功能回归结果（含跳过）：
  Desktop vitest 全量 52 文件 / 434 项通过（含新增 16 项）；desktop tsc
  通过。无跳过项。
before / after / 同机环境：
  性能验证待完成：seek p95 对比需真机 m3p4（100 随机 seek）复测；本次
  以比较次数断言（O(log N)、游标 O(1) 均摊）替代 CI 毫秒阈值（计划要求）。
质量与失败路径验证：
  发现并修复 1 个实现缺陷：并列 PTS 组的 pickNeighbor 只看相邻位漏组首
  （B 帧流 1000 随机目标第 331 个即命中）——修复后全场景与 oracle 一致。
开关、兼容与回退验证：
  纯 worker 内部算法替换，无新开关、无协议变化；错误消息与容差语义
  保持（no sample for frame / best diff）。
已知限制、未解决问题：
  - 索引构建成本 O(N log N)（108k 样本 <10ms 量级）在 init 期一次性支付；
    F03（60 分钟源）整文件加载的主成本仍在"整文件 fetch"（B12 范围）。
  - locateByPts 游标推进上限 64 步后回二分——超长跳变（如 4x 变速跨段）
    退化为一次二分，非缺陷。
  - 真机 seek 延迟收益（m3p4 p95 复测）待性能验证阶段执行。
开发者自测：通过（见上）。
独立Reviewer结论：待验收
Gate决策与下一步：A04（IR 扫线与手势索引，Core + Desktop 跨端）按计划推进。
```

## 3. 测试证据摘要

- `tests/sample-index.test.ts`：16 项全通过（179ms）。
- 全量 `vitest run`：52 文件 / 434 项通过（33s）。
- desktop `tsc --noEmit`：通过。

## 4. 与实施计划的偏差

- 计划第 4 步"顺播维护最近 PTS 游标，目标单调时局部推进；反向/跨段跳转
  回二分"——游标推进加 64 步上限后回二分（防长推进退化），其余语义一致。
- 计划第 6 步"原算法提前 break 不能当正确性金标准；用完整扫描不提前退出的
  oracle 比较"——已按此实现（locateByPtsOracle），并构造了旧 break 漏更优解
  的显式用例；该旧 break 随线性扫描一并移除。
- 计划测试清单中 m3p4/m3p5 与像素校验列为真机复测项（性能验证阶段）；
  本次单测以 oracle 等价性 + 比较次数断言覆盖算法语义。
