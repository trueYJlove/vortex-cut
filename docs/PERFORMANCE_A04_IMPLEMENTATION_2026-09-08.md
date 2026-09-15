# A04 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**A04（IR 扫线与手势索引）代码完成 + 功能验证完成 + 同机基准达标；**
**Core 纯投影 900seg/900cap 中位数 2701ms → 189ms（目标 ≤350ms）。**
独立验收：**待验收**（单执行者自检，不冒充独立 Gate；目标值待 G0 冻结复核）。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A04 修改单，在
A03（`b75e96c`）之上实施，Core 与 Desktop 分两个提交。未 push、未打包。

## 2. 修改单（模板）

```text
修改单：A04 IR 扫线与手势索引
基线HEAD / 工作树标识：b75e96c（A03）；Core 与 Desktop 分两次本地提交
目标与不修改范围：
  目标——投影期主轨 region 命中/overlays/captions 查找从每帧全表扫描改
  扫线索引；转场锚点预映射；Desktop PiP 手势 clipId 索引 + 几何合并补丁。
  不修改——regions 构造逻辑、segment_frame/_pip_box/_source_frame_n、
  端点语义（主轨半开 [t0,t1)；overlay/字幕含 end）、输出字段与顺序、
  known_approximations、v1 协议、MAX_IR_FRAMES 护栏。
实际修改文件（绝对路径）：
  Core：
    C:\DataFolder\codes\AI-Vidio\services\core\src\aivs_core\rendering\interval_index.py（新增）
    C:\DataFolder\codes\AI-Vidio\services\core\src\aivs_core\rendering\ir.py
    C:\DataFolder\codes\AI-Vidio\services\core\tests\unit\test_render_ir_index.py（新增）
  Desktop：
    C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\preview-session.ts
    C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\SyntheticPreview.tsx
    C:\DataFolder\codes\AI-Vidio\apps\desktop\tests\preview-ir-patch.test.ts（新增）
前置Gate与接口版本：无跨进程契约变化；IR schema/projector_version 不变。
算法/状态机变化：
  Core：
  - RegionSweep：主轨 regions 排序事件扫线（enter/exit 事件 + 活跃集，
    命中 = 活跃集中原 order 最大者 = 原倒序遍历首命中；同刻 exit 先于
    enter 保持半开语义）；转场锚 _anchor_of 的倒序扫描在构造期预映射。
  - IntervalLookup：overlays/captions 含端区间的事件扫线收集（enter 在
    start≤t 生效、exit 在 end<t 才退场——含端语义的边界修正；有序活跃集
    insort → 输出天然按构造原序，v1 协议稳定）。
  - ir.py 帧循环：region 扫描/overlay 全扫/caption 全扫替换为三个索引
    的 next_region/next_batch 单调推进；regions 构造与逐帧计算主体不动。
  Desktop：
  - pipOverlayIndex（clipId→overlay 引用表）：create 尾部与 replaceIr
    原子重建；setPipCenter/setPipBox/setPipRotation 从全帧双重循环改为
    索引列表遍历。
  - setPipGeometry（cx/cy/w/h/rotation 合并补丁）：move+rotate 手势一次
    遍历 + 一次 recomposeSoon（原 setPipBox+setPipRotation 两次遍历两次
    调度）；SyntheticPreview 手势层改调合并接口。
授权、取消、资源所有权、缓存失效规则：
  纯算法替换，无授权/取消/缓存变更；索引生命周期 = 会话/投影单次调用。
新增/修改测试与命令：
  Core 新增 test_render_ir_index.py（8 项）：
  - RegionSweep vs 倒序遍历 oracle：200 组随机重叠区间 × 1001 时刻逐点一致
    （含"原 order 最大而非 start 最大"的 tie 断言）；半开边界
  - IntervalLookup：含端语义边界 + 乱序构造原序输出；300 区间 × 2001 时刻
    vs 全表扫描 oracle
  - 3 种子随机密集 timeline（主轨链+转场+间隙+V2 覆盖+字幕）全帧结构
    断言；转场 blend 窗口 overlap 语义（倒序命中 b-blend → transition 帧，
    锚 = a 段预映射）
  Desktop 新增 tests/preview-ir-patch.test.ts（4 项）：合并补丁全窗口
  生效/窗外不动、未命中静默、replaceIr 索引原子重建、rAF 合帧单次调度。
  命令：pytest services/core/tests/unit/test_render_ir*.py -q；
  vitest run tests/preview-ir-patch.test.ts；两端全量。
功能回归结果（含跳过）：
  Core 全量单测 458 项通过（含新增 8 项；real_provider 标记除外）；
  Desktop 全量 53 文件 / 438 项通过（含新增 4 项）；两端 tsc/ruff 通过
  （ir.py 的 20 处 E501 为仓库既有，非本次引入）。无跳过新增项。
before / after / 同机环境：
  同机（i7-1165G7 / Python 3.13.1）复刻 evidence/performance-2026-09-08
  基准口径（runpy 加载 test helpers、3 次中位数、gc.collect）：
    60s/1seg/0cap：    10.0ms → 10.2ms（持平，单段无扫描收益）
    900s/1seg/0cap：   154ms → 184ms（+19ms：单段 27k 帧仍建事件表，
                       长段无重叠时扫线开销略高于原线性首中即停——见已知限制）
    300s/300seg/300cap：344ms → 67ms（−80%）
    900s/900seg/900cap：2701ms → 189ms（−93%，≤350ms 目标达成）
质量与失败路径验证：
  profile 驱动两轮优化：首轮 RegionSweep 后剩余热点 active_at（0.44s，
  每帧候选窗全扫）→ 改扫线收集含端事件（enter ≤t / exit <t）再测达标。
  含端边界缺陷由测试发现并修正（end == t 仍活跃）。
开关、兼容与回退验证：
  无新开关；IR 输出与旧实现逐帧等价（oracle 对比 + 现有 27 项 IR 测试
  全绿）；Desktop 手势接口向后兼容（setPipBox/Rotation 保留）。
已知限制、未解决问题：
  - 单段超长（900s/1seg）投影 154→184ms：无重叠区间时事件表构造 +
    逐帧活跃集维护略高于原"倒序首个命中即停"；该场景收益主体（多段密集）
  达标。剩余成本 = segment_frame 逐帧计算（0.31s 中的大头），属 C20
  窗口化范围，不在本单扩大。
  - 随机密集 timeline 的"深度对比"实现为结构级断言 + 扫线单元 oracle
    （ir.py 帧循环整体替换无法在运行期双跑旧实现）；等价性由
    RegionSweep/IntervalLookup 单元级 oracle + 现有行为测试交叉保障。
  - 350ms 目标待 G0 用代表夹具冻结复测；本机数字不冒充跨机门槛。
开发者自测：通过（见上）。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步：A05（Core 哈希/IR 后台执行）按计划推进。
```

## 3. 测试证据摘要

- `test_render_ir_index.py`：8 项全通过（0.45s，与 test_render_ir 合跑 35 项）。
- `tests/preview-ir-patch.test.ts`：4 项全通过（13ms）。
- Core 全量 `-m 'not real_provider'`：458 项通过（114s）。
- Desktop 全量：53 文件 / 438 项通过（33s）；两端 typecheck 通过。
- 基准：900seg/900cap 2701.4ms → 189.3ms（3 次中位数，同机同口径复刻）。

## 4. 与实施计划的偏差

- 计划"Core：保留旧投影器为测试 oracle（从改动前版本提取测试模块）"——
  实现为单元级 oracle（RegionSweep/IntervalLookup 各自对倒序扫描/全表扫描
  的随机逐点对比）而非整体双跑：ir.py 的 regions 构造与逐帧计算未动，
  帧循环替换的等价性由单元 oracle + 既有 27 项行为测试交叉保障（在工作单
  已知限制中披露）。
- 计划步骤 6"输出字段、known_approximations、顺序与浮点舍入一致，完整 IR
  深比较"——浮点路径未触碰（t_exact_us、round 位数不变），由现有测试
  （含精确数值断言）全绿佐证。
- A04 Desktop 第 4 步"单 clip 覆盖全部长项目仍耗时则记录剩余成本"——
  手势遍历 = 该 clip 的 overlay 数（不再是全帧×全 overlay），剩余成本
  记录于 preview-session 注释；transient override 留 B17/C20。
