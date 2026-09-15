# A05 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**A05（Core 后台执行与事件循环）A05a 完成；A05b 代码完成 + 功能验证完成。**
- A05a：哈希后台线程池——代码完成 + 功能验证完成。
- A05b：IR 投影后台执行——代码完成 + 功能验证完成；**进程模式默认关闭**
  （冻结未验证，按计划"不能默认启用进程模式"条款）。
独立验收：**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A05，在 A04
（`2751e89`/`307a19e`）之上实施，a/b 两次本地提交。未 push、未打包。

## 2. 修改单（模板）

```text
修改单：A05 Core 后台执行与事件循环（A05a + A05b）
基线HEAD / 工作树标识：307a19e（A04 Desktop）；a/b 两次提交
目标与不修改范围：
  目标——大文件哈希/IR 投影搬离事件循环；哈希取消令牌 + stat 前后比对；
  IR 投影 single-flight + 后台执行 + 可选进程池。
  不修改——sha256_file 本体语义、ASSET_CHANGED/MEDIA_CHANGED 域错误路径、
  IR 投影纯函数语义、数据库写入时机（结果校验后才写）。
实际修改文件（绝对路径）：
  A05a（提交 326735c）：
    services/core/src/aivs_core/background_work.py（新增）
    services/core/src/aivs_core/projects.py
    services/core/tests/unit/test_background_work.py（新增）
  A05b：
    services/core/src/aivs_core/ir_process.py（新增）
    services/core/src/aivs_core/rendering/service.py（preview_ir 接入）
    services/core/tests/unit/test_ir_process.py（新增）
前置Gate与接口版本：A04 扫线（投影 CPU 已降至 189ms 级）；无契约变化。
算法/状态机变化：
  A05a：
  - BackgroundExecutor：ThreadPoolExecutor(max_workers=2) +
    asyncio.Semaphore(8) 提交队列护栏（超限等待而非无限排队）。
  - run_hashed：分块喂入 + 分块边界取消令牌（task done callback 置 Event；
    线程内系统调用不可中断——诚实口径）；stat 前后比对（size/mtime_ns）
    不一致 → AssetChangedError（projects 层翻译为 ASSET_CHANGED）。
  - projects.py：import_asset / refresh_asset / relocate_asset 三个 async
    入口改 await self._hash(path)（后台执行）。
  - current_source / resolve_asset_path 为 sync 方法（plan.py 与 rendering
    预检的同步调用方）——保留同步哈希并注记；签名改造不在本单（见偏差）。
  A05b：
  - IrProjectExecutor：single-flight（键 = content fingerprint，完成前后
    两个窗口的并发等待者共享同一 future）；默认后台线程（复用 A05a 池）；
    AIVS_IR_PROCESS_POOL=1 显式开启 spawn ProcessPoolExecutor(max_workers=1)；
    冻结构建（sys.frozen）构造期拒绝（不静默换路径）；shutdown 有界回收。
  - rendering/service.preview_ir：project_preview_ir 直调改
    await ir_project_executor().project(...)（compile/probe 段保持原位——
    见已知限制）。
  - worker 入参仅 plan/probes/styles（纯 JSON 字典），不传 service/连接。
授权、取消、资源所有权、缓存失效规则：
  哈希取消 = 合作式令牌（分块边界）；投影取消 = 不抢占（运行中任务完成
  后由 fingerprint 缓存层淘汰旧结果）；线程池/进程池 atexit/显式回收。
新增/修改测试与命令：
  test_background_work.py（6 项）：哈希正确性、事件循环不阻塞（心跳 50
  tick 全跑完）、stat 变化 → AssetChangedError、有界队列 24 任务全完成、
  本池 worker ≤ max_workers（实例内部线程集合统计）、Windows 句柄自管理
  （哈希后文件可删）。
  test_ir_process.py（6 项）：worker 函数与直调一致、默认线程模式心跳
  不饿死、AIVS_IR_PROCESS_POOL=1 spawn 进程真实执行（Windows 开发模式，
  结果一致 + 子进程无递归 sidecar 副作用）、sys.frozen 拒绝、
  single-flight 并发只计算一次（barrier 对齐 + worker 层计数）、
  generation bump 语义。
  命令：pytest services/core/tests/unit -m 'not real_provider' -q（470 项）。
功能回归结果（含跳过）：Core 全量单测 470 项全绿（+12 新增）；ruff 干净
  （projects.py 2 处 E501 为既有）。无跳过新增项。
before / after / 同机环境：
  事件循环口径：900 段密集计划投影 187ms 期间，并发 1ms ping 探测最大
  间隔 47.5ms、200 ping 全部推进（改造前同步投影会完全阻塞循环 ~1.9s
  量级[2701ms 基准]）；p95<20ms 与长测留性能验证阶段（B00 诊断入口）。
质量与失败路径验证：
  测试发现并修正 2 处实现缺陷：single-flight 的 done 竞态（完成后重投）、
  冻结检查的 sys.frozen 属性缺失（getattr 兜底）。
开关、兼容与回退验证：
  无默认行为破坏：AIVS_IR_PROCESS_POOL 默认未设 → 线程模式（与原同步
  路径行为等价，仅执行位置变化）；设 1 且非冻结 → 进程池；冻结 → 拒绝。
已知限制、未解决问题：
  - preview_ir 的 compile 与 ffprobe 段仍在事件循环内（compile 未剖析
    残余成本——计划要求"先剖析再搬"，本单只搬已确认的投影段；A04 后
    投影 189ms 是主要段）。probe 已是 async（measured 装饰 + to_thread
    基建未确认——留 A07 probe 缓存一并处理）。
  - current_source/resolve_asset_path 的同步哈希（快速校验路径）未后台化
    ——调用方含 sync 代码路径，签名改造需单独 PR（不与本单混入）。
  - PyInstaller 冻结模式的 spawn 验证未做（需受控构建 Gate）——进程模式
    在冻结环境明确拒绝，不假装支持。
  - 进程模式"最多一个运行 + 一个最新等待请求"简化为 max_workers=1 池
    （排队深度未显式截断为 1；fingerprint single-flight 已合并同键等待，
    不同键的等待队列由池自然串行）。
开发者自测：通过（见上）。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步：A06（Canvas 最小失效范围，Desktop）按计划推进。
```

## 3. 测试证据摘要

- `test_background_work.py`：6 项通过；`test_ir_process.py`：6 项通过。
- Core 全量 `-m 'not real_provider'`：470 项通过（115s）。
- 事件循环验证：900 段投影 187ms，期间 1ms ping 探测 max gap 47.5ms、
  200 ping 全推进（脚本见工作单记录；正式 event-loop lag p95 由
  B00 诊断入口在性能验证阶段采集）。

## 4. 与实施计划的偏差

- A05a"哈希分块检查取消令牌"落地为合作式令牌（线程内系统调用不可中断
  ——与计划"明确不能强制终止已开始的系统调用"一致）。
- A05a 计划含"大文件复制使用专用线程池"——当前仓库 import 路径无应用内
  大文件复制（导入 = 挂载外部文件，jobs.py 的 shutil.move 属发布原子
  操作且在任务线程内）；background_work.run() 已提供通用入口，复制接入
  在实际出现时挂上（避免为不存在的调用点写空代码）。
- A05b"先剖析 A04 之后 compile/project/序列化残余成本"——projection 段
  A04 基准已确认（189ms 主导）；compile 段剖析未单独执行（短项目 <10ms
  量级），把 compile/probe 段搬移列为后续项而非本单盲改（记录于已知限制）。
- A05b 计划要求 spawn 进程池 max_workers=1 默认路径——实施为默认线程 +
  显式环境开关的进程池：计划同段明确"冻结支持未验证不能默认启用进程
  模式；临时保留优化后的旧执行路径并披露"。线程模式即"优化后的执行
  路径"（事件循环同样不阻塞），进程池按计划保留实验位。
