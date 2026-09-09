# B16 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B16(优先级和资源配额调度)代码完成 + 功能验证完成。**
独立验收:**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B16,在
B15(`ce16305` 报告)之上实施,按"调度器核心 + jobs 接入 → lease 心跳
贯通 → 回归报告"两个可审查提交推进(调度器与 lease 在同一模块
job_scheduler.py,按 B16a/B16b 语义分述)。

提交(均本地,未 push):
- (提交 1)B16a+B16b Core:job_scheduler.py(资源令牌/分级/lease)+
  jobs._loop 调度接入 + app.py 装配/lease 端点/观测端点
- (提交 2)B16b Desktop:editor-load-lease.ts 心跳 + Main/Preload/
  App 推送链 + 本报告

## 2. 修改单(模板)

```text
修改单:B16 优先级和资源配额,不承诺无代价抢占
基线HEAD / 工作树标识:ce16305(B15 报告);两个本地提交
目标与不修改范围:
  目标(B16a)——有界并发网络与轻量任务(network=2、light=2 并行),
  CPU/GPU/Disk heavy 仍严格单个;任务描述由服务端 kind→policy 决定
  (Renderer 不传任意优先级);多资源一次原子申请(锁内整体判定,
  无部分持有——无死锁);同级 FIFO + aging(每等待 30s 等效提升一级,
  boost 封顶 3 级);unknown kind 保守独占(行为不劣于现状单槽);
  保留全部 kind 状态机、special generation 回调与 batch recovery。
  目标(B16b)——编辑器负载 lease:playing/scrubbing/idle(Main 注入
  window owner,TTL 3s,1s 心跳);无 lease 视 idle(Renderer 崩溃不
  永久饿死任务);播放/拖动时暂缓新的低优先级(≥4 级)重任务入队执行,
  已运行任务不受影响(准入只在启动前判定=不可抢占语义)。
  不修改——最终导出不强杀、不暗中重启(取消仍走既有 cancel 语义);
  用户暂停导出的显式 UI(计划:默认不实现无损导出暂停);
  B15 PCM ensure_chunk 内联路径(低延迟任务不走 jobs 队列——其容量
  由 ensure 并发闸门保留);A05 后台池/A07 probe 池既有并发;
  legacy 单槽构造(scheduler=None 时 jobs._loop 行为与 B16 前完全一致)。
实际修改文件(绝对路径):
  services/core/src/aivs_core/job_scheduler.py(新增)
  services/core/src/aivs_core/jobs.py(_loop 调度接入 + _spawn 令牌
    归还 + scheduler 构造参数)
  services/core/src/aivs_core/app.py(JobScheduler 装配 + lease/stats
    端点 + EditorLoadLeaseRequest 模型)
  services/core/tests/unit/test_job_scheduler.py(新增,13 项)
  services/core/tests/integration/test_job_scheduler_api.py(新增,5 项)
  apps/desktop/electron/main/editor-load-lease.ts(新增,心跳模块)
  apps/desktop/electron/main/core-admin-client.ts(reportEditorLoadLease)
  apps/desktop/electron/main/index.ts(心跳启动/停止 + editor-load:update)
  apps/desktop/electron/preload/index.ts(updateEditorLoad)
  apps/desktop/src/app/App.tsx(负载推送:转换即时 + 1s 保活)
  测试:tests/editor-load-lease.test.ts(新增,4 项)、
    preload.test.ts(+1 行)、app/editor-commands/editor-shell mock +1。
前置Gate与接口版本:jobs 队列结构(B10-B15 全部 kind 就绪);
  admin 内部通道模式(B12-B15 同链)。
算法/状态机变化:
  - 资源表:cpu_heavy=1、gpu_heavy=1、disk_heavy=1、network=2、
    light=2(final_export 三 heavy 合计 1 槽;transcription/
    candidate_generation/timeline_patch_generation/model_download/
    media_generation = network;waveform/proxy/vertical_sample = light)。
  - kind→policy 分级:waveform=2(用户视野)> proxy=3(当前项目)>
    导出/ASR/生成=4 > sample 预热=5;unknown=保守独占(5 级 + heavy)。
  - jobs._loop:queued 候选(LIMIT 128)按(effective_priority,
    created_ts, job_id)排序逐个 admit(高优先级资源不足不阻塞低
    优先级可运行任务——防头阻塞);admit 成功即 _spawn(任务 finally
    归还令牌——异常/取消/retry 路径统一恰好一次);总在途上限 4
    (jobs 表风暴护栏)。scheduler=None 走旧单槽分支(兼容)。
  - lease(B16b):EditorLoadLease(TTL 3s,heartbeat/过期回 idle);
    admit 前置判定——mode∈{playing,scrubbing} 且 policy 含 heavy 且
    priority≥4 → 暂缓(返回 None,下轮 poll 重试;已运行任务不受
    影响——release 只在任务结束时发生)。
  - Desktop 心跳:EditorLoadLeaseHeartbeat(1s 自重调度——上次请求
    结束后再 setTimeout,失败退避 1s×n 封顶 5s,恢复回 1s);
    Main startRuntime 末尾启动/shutdownRuntime 停止(停止=Core TTL
    3s 过期回 idle,不显式上报);Renderer 推送 editor-load:update
    (playing/scrubbing/idle——App 在 playing/progressDragging 转换
    即时推送 + 1s 保活;Renderer 崩溃=无推送=心跳维持最后值,Core
    TTL 兜底)。
授权、取消、资源所有权、缓存失效规则:
  - lease/stats 端点仅 admin 通道(UI token 401——集成测试覆盖);
    mode 枚举白名单(bogus 400);window_id 只作 owner 标识(不含
    路径/敏感数据)。
  - 令牌所有权:admit 凭据(_Admission)绑定 job_id;release 幂等
    (恰好一次);_spawn 包装器 finally 归还——取消/异常/retry 不漏。
  - 调度器无持久状态:重启后容量全量可用(queued 行由 _loop 重新
    拾取,既有恢复链路不变——单测覆盖)。
新增/修改测试与命令:
  Core:pytest services/core/tests/unit/test_job_scheduler.py -q(13);
    integration/test_job_scheduler_api.py -q(5)
  Desktop:pnpm typecheck;vitest run(66 文件 585 项);
    tests/editor-load-lease.test.ts(4)
功能回归结果(含跳过):
  Core unit 全量 585 通过(B15 时 572;+13 调度器)。jobs 既有 8 项
  回归通过(scheduler=None 兼容路径)。Desktop 66 文件 585 项通过
  (B15 时 65/581),typecheck 通过。
before / after / 同机环境:
  调度语义变化:旧全局单槽(任何 kind 排队)→ network/light 有界并行
  (波形/代理不再排在长导出后)+ heavy 单槽。F06(播放+导出并发)p95
  提交延迟量化列 F 场景轮——本报告不宣称实测数字。
质量与失败路径验证:
  - 混合 100 任务 admit/release 循环:任意时刻 held ≤ capacity、
    清空后归零(无令牌泄漏)——单测覆盖。
  - 多资源原子性:任一资源不足 → 整体 None,held 无残留(单测)。
  - lease:playing/scrubbing 暂缓新 heavy、light 不拦、TTL 过期恢复
    准入、无心跳 idle(单测);端点 401/400/快照贯通(集成)。
  - 心跳:失败退避序列 1s→2s→3s→4s→5s 封顶、恢复回 1s、stop 不再
    调度、非法模式拒绝(Desktop 单测)。
开关、兼容与回退:
  - 纯增量:JobService 不传 scheduler = 旧单槽行为(全部既有测试
    不改即过);Desktop 心跳在 Core 无 lease 端点时退避重试
    (5s 封顶,静默——不影响任何功能通道)。
  - Renderer 推送失败静默(辅助通道);preload 白名单 +1。
已知限制、未解决问题:
  - PCM 低延迟保留容量:B15 ensure_chunk 不走 jobs 队列(内联 FFmpeg,
    每 HTTP 请求一进程,begin_build single-flight 按 key 去重)——
    计划"为其保留有界轻量 CPU/IO 容量"现状=不走队列即不受调度饥饿;
    跨 key 并行 FFmpeg 的进程数上限未加(列 F 场景轮观察项)。
  - "限制新 FFmpeg 线程参数"(播放时)未实现:当前重任务准入即暂缓
    (不启动新 FFmpeg)——线程参数收紧留实测证明必要后再做(行为
    保守方向正确:播放中不新增重任务)。
  - 同 project/revision 重复派生合并:现状由 B10 派生缓存
    single-flight(同 cache_key 一次生成)承担——不同 job 行可能
    重复排队但执行时 already-ready 短路;不合并不同外传确认/目的
    路径的 Provider/导出(各走独立 kind,天然不合并)。
  - F06 完整 App 并发场景实测未跑(计划要求"不仅检查 scheduler 单测")
    ——列 F 场景复测轮。
  - aging 计时基于 DB created_at ISO 串转 epoch(毫秒精度,容差足够);
    测试环境时钟与 DB 时钟同源。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:F 场景复测轮(F06 播放+后台任务 p95 量化;B10-B16
  能力就绪);或 B17(时间轴二维可见区——第二轮最后一个大项)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 调度器单测 | test_job_scheduler.py | 13 | kind 分级表/unknown 保守独占/admit+release 恰好一次(幂等)/容量不超订/多资源原子无部分持有/FIFO+分级顺序/aging(30s 级+boost 封顶 3)/lease 模式与 TTL/lease 暂缓 heavy 不拦 light/过期恢复/混合 100 任务无超订无死锁/重启无持久状态 |
| Core 端点 | test_job_scheduler_api.py | 5 | lease 心跳生效+window 透传/UI 401/非法 mode 400/未知字段 422/400/stats 快照形状(admin) |
| Desktop 心跳 | editor-load-lease.test.ts | 4 | 1s 心跳模式即时生效/失败退避 1→5s 封顶恢复回 1s/stop 不再调度+start 幂等/非法模式拒绝默认 idle |
| preload | preload.test.ts | +1 行 | updateEditorLoad 固定 channel |

- Core 全量 unit:**585 通过**;Desktop 全量:**66 文件 / 585 项**,
  typecheck 通过;jobs 既有 8 项回归(scheduler=None 兼容)全绿。
- B15 时为 Core 572 / Desktop 65 文件 581 项。

## 4. 与实施计划的偏差

- 计划资源表 "轻量 probe 线程池 2":A07 probe 池现状为 async
  single-flight(无独立线程池)——本实现把 light=2 落在 jobs 调度
  (waveform/proxy/sample 类并行 2);probe 池不动(A05 池=2 已在限内)。
- 计划"consumed(range)"(B15 协议遗留)与 B16 lease 的联动:未接
  (B15 报告已知限制维持——PCM 不走队列即无饥饿,consumed 冗余)。
- 计划分级第 1 级"已授权当前 seek 所需 PCM/媒体块":该类任务
  (B12 Range/B15 ensure)均为内联 HTTP 路径不走 jobs 队列——第 1 级
  在调度器中无对应 kind,语义以"不走队列"保留(表值与分级文件中
  注释声明)。
- lease 心跳通道选择:计划"预览负载 IPC"未指定形态——实现为
  admin 内部端点 + Main 1s 心跳(Main 是唯一拥有 admin token 的进程,
  Renderer 只推 Main;符合"Main 注入 window owner"的分工)。
- B16a/B16b 拆分:计划分两阶段提交;实现按模块内聚合并为两个提交
  (Core 调度+lease 端点 / Desktop 心跳贯通)——B16a 语义(有界并发
  + heavy 单槽)与 B16b 语义(lease 暂缓)均独立可测、分别有单测。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_job_scheduler.py services/core/tests/integration/test_job_scheduler_api.py services/core/tests/unit/test_jobs.py -q
pnpm --filter @aivideo/desktop test          # 66 文件 585 项
npx vitest run tests/editor-load-lease.test.ts tests/preload.test.ts
pnpm --filter @aivideo/desktop lint
```
