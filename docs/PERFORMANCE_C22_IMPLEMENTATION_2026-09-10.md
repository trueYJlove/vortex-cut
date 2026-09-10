# C22 实施进度与自检报告(2026-09-10)

## 1. 状态与范围

**C22(可取消的最终校验与诚实的阶段进度)代码完成 + 功能验证完成。**
独立验收:**待验收**。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 7 节 C22,在
C21a(`d76280f`)之上实施。C22 十条全部落地:可取消校验(validate_rendered_media
显式 cancel_event + 阶段回调,校验环节完整保留——非抽帧冒充)、decode_validate
可取消子进程执行器(进程树终止复用既有策略)、stderr 有界 ring(末 32KiB,
替换"先整段 read() 再切片")、超时三拆(启动无响应并入停滞门/停滞 120s/
绝对上限 max(300s, 5×媒体时长),可配置常量起步)、哈希走 A05 受限线程池
分块取消、任务细分阶段 preparing/encoding(=rendering)/validating_probe/
validating_decode/hashing/publishing(旧 stage 兼容映射保留,通过可选
phase/phase_progress 扩展)、phase_progress 按解码 out_time/哈希字节计算
(准备/发布显示不定进度)、取消在发布提交点前阻止新成品(进入 publishing
临界区后不再响应取消,完成后不把成功标成已取消)、rename 与 DB 事务非原子
的 orphan 恢复沿用既有 cleanup_orphans(本单验证,未改动语义)、cancel/
timeout 错误码区分且均不触发换编码器重跑。

提交(本地,未 push):
- (提交 1)C22:v19 迁移 + decode_validate 重写 + validation 可取消哈希 +
  service/jobs phase 贯通 + 契约/Desktop UI + 测试 + 本报告

## 2. 修改单(模板)

```text
修改单:C22 可取消的最终校验与诚实的阶段进度
基线HEAD / 工作树标识:d76280f(C21a);一个本地提交
目标与不修改范围:
  目标——validate_rendered_media 增显式 cancel_event 与 on_phase 阶段回调;
  保留"编码规格→时长→完整 decode→SHA→发布"全部校验环节;decode_validate
  改为可取消子进程执行器(复用进程树终止 + WindowsKillJob),超时拆分为
  停滞(120s 无 out_time 推进;定期日志不算媒体进度——-progress pipe:1
  只输出进度行,天然不把日志当进度)与绝对上限 max(300s, 5×媒体时长);
  stderr 有界 ring(末 32KiB);文件哈希走 A05 受限线程池,按 4MiB 块检查
  取消信号(合作式——已进入的 read 不可中断,调用方等待合作退出,不允许
  后台继续写最终状态);任务细分 phase/phase_progress(旧 stage 兼容);
  取消与 timeout 区分错误码,均不进入换编码器重试;发布提交点(finalize
  临界区)后不可取消,完成后不误标已取消。
  不修改——run_timeline_render(编码期取消语义既有,本次未动);最终输出
  规格/校验阈值(时长 83334µs 上限等);rename+DB 事务结构(在提交点语义
  上标注不可取消,orphan 恢复沿用 cleanup_orphans——"跨卷 rename/DB 提交
  失败恢复"既有测试覆盖,扩展的恢复矩阵列已知限制);ASR/模型下载任务
  (已有各自取消语义);B16 调度(取消不涉及资源令牌变化)。
实际修改文件(绝对路径):
  services/core/src/aivs_core/database_v19.py(新增:v19 ALTER jobs ADD
    COLUMN phase/phase_progress,可空、无回填)
  services/core/src/aivs_core/database.py(V19_VERSION 注册 MIGRATIONS)
  services/core/src/aivs_core/rendering/ffmpeg.py(decode_validate 重写:
    可取消子进程执行器 + 停滞/绝对上限 + out_time 进度回调 + _StderrRing
    有界 stderr(末 32KiB))
  services/core/src/aivs_core/rendering/validation.py(validate_rendered_
    media +cancel_event/on_phase;阶段序列 validating_probe→validating_
    decode→hashing;_hash_cancellable:A05 线程池分块 SHA-256 + 取消令牌
    + 校验前后 stat 比对——产物被改→RENDER_VALIDATION_FAILED)
  services/core/src/aivs_core/rendering/service.py(run +phase 可选参数;
    校验期 on_phase=phase 直通;发布前 phase("publishing", None);超时
    RuntimeError→DomainError(RENDER_VALIDATION_TIMEOUT) 不重试)
  services/core/src/aivs_core/jobs.py(RenderRunner +phase 形参;_set_phase
    (只写 running/cancelling 行);_transition_job 清 phase;get() DTO 暴露
    phase/phase_progress;_job_error_message +RENDER_VALIDATION_TIMEOUT)
  packages/contracts/src/index.ts(ERROR_CODES +RENDER_VALIDATION_TIMEOUT;
    Job +phase/phase_progress 可选字段 + isJob 校验 phase 非空串/进度
    0..1;JobStage 为 open union 旧客户端天然兼容)
  apps/desktop/src/lib/core-client.ts(normalizeJob 透传 phase/
    phase_progress)
  apps/desktop/src/app/App.tsx(jobPhaseLabels 中文标签(含"正在完成发布"
    临界区提示);任务行与渲染面板显示 phase+phase_progress;未知 phase
    原样显示,无 phase 时退回 stage 文本)
  services/core/tests/unit/test_render_cancel_validation.py(新增,11 项)
  services/core/tests/unit/test_migrations_v19.py(新增,3 项)
  services/core/tests/unit/test_render_validation_stage1c.py(fake 兼容
    **kwargs)
  services/core/tests/unit/test_migrations_v2/v3/v12/v14/v15/v16/v17/
    v18.py(版本快照断言 v18→v19,共 10 处)
前置Gate与接口版本:render-plan-v1 权威渲染链(Stage1a-1c);A05
  background_work 受限线程池;A07 probe 会话缓存;jobs 状态机
  (state.py TRANSITIONS 未动);contracts stage6r-v1(追加式扩展)。
算法/状态机变化:
  - decode_validate:固定 120s 总超时 → 停滞门 120s(无 out_time 推进)
    + 绝对上限 max(300s, 5×媒体时长);取消 → terminate_process_tree
    (进程树,taskkill /T /F)→ JOB_CANCELLED;超时 → RENDER_VALIDATION_
    TIMEOUT(区分码);stderr 末 32KiB ring(_StderrRing,追加式截断,
    洪泛内存有界);进度 = out_time_us/media_duration_us(0..0.99)。
  - 校验哈希:同步 sha256_file(阻塞事件循环、不可取消)→ A05 线程池
    内 4MiB 分块 SHA-256,分块边界检查取消令牌(合作式),块间上报字节
    进度;前后 stat 比对(size/mtime_ns)——校验期间产物被外部修改 →
    RENDER_VALIDATION_FAILED(不发布无主哈希)。
  - phase 状态:validation 三段(validating_probe[不定]/validating_decode
    [0..0.99]/hashing[0..0.99]) + service 两段(preparing[不定]/
    publishing[不定]);encoding 期沿用既有 stage("rendering")+progress,
    不重复造 phase(诚实口径:编码进度已可观测);_set_phase 只写
    running/cancelling 行(发布临界区后迟到的 phase 写入被状态守卫
    拒绝);终态迁移统一 phase=NULL。
  - 取消语义链:cancel_event 置位 → decode 进程树终止/哈希下一分块边界
    退出 → RuntimeError("JOB_CANCELLED") → service 直通(不重试) →
    jobs _error_target → cancelled。timeout 同链但错误码
    RENDER_VALIDATION_TIMEOUT → failed,同样不触发编码器降级重跑。
授权、取消、资源所有权、缓存失效规则:
  - 无新授权面(校验对象是本 job 的临时产物路径);取消所有权沿用
    JobService.cancel_events;哈希线程自管文件句柄(A05 契约);等待方
    完成/取消后置线程令牌并在 finally 收 watch task——无悬挂线程继续
    写状态。
  - 无缓存(校验是逐次强校验,不缓存结果——不能缓存"最终输出文件验证
    成功",沿用 A07 诫)。
新增/修改测试与命令:
  pytest services/core/tests/unit/test_render_cancel_validation.py(11)
  pytest services/core/tests/unit/test_migrations_v19.py(3)
  pytest services/core/tests/unit/test_render_validation_stage1c.py(3,
    兼容签名)
功能回归结果(含跳过):Core unit 全量 628 通过(C21 时 614;+14);
  渲染集成 real 11 项通过(stage1c/transform/pip/mask/chroma/seek_parity);
  Desktop 全量 69 文件 607 项通过(数量不变——UI 展示行不改断言);
  typecheck 通过。已知噪音:input-pool-protocol 2 个 unhandled rejection
  (B13 遗留,C20 报告已记录,非本次引入)。
before / after / 同机环境:
  结构性断言(jsdom/pytest,非端到端实测):
  - 取消传播:decode 取消 → kill 已调用 + JOB_CANCELLED;哈希期取消
    (decode 返回后置位)→ JOB_CANCELLED 在分块边界生效。
  - 超时分类:停滞门(时间函数前拨 1000s)→ RENDER_VALIDATION_TIMEOUT
    + kill;stderr 洪泛 100KiB → 错误消息 ≤1100 字符(ring 收敛)。
  - 阶段序列:on_phase 收到 validating_probe→validating_decode(0 起)
    →hashing(0→0.99);哈希值与 reference sha256 一致。
  - 发布临界区:_set_phase 状态守卫(非 running/cancelling 不写);
    终态 phase 清空;publishing 可写 None 进度(不定)。
  - 超时不重试:编码器循环里 timeout 直通,attempt_count==1。
  - 迁移:v18→v19 append-only,校验和保留,fk/integrity ok,可空列。
  端到端取消延迟(计划目标:正常 I/O ≤2s、进程树回收 ≤5s)与真实
  FFmpeg 长输出校验超时行为列 F 场景实测轮(单测以 fake 进程覆盖分支,
  不冒充端到端)。
质量与失败路径验证:
  - 校验环节全保留:probe 规格检查/时长容差/完整 decode(-f null 全量,
    非抽帧)/SHA-256 逐项未动——只加取消与进度,不改判定。
  - 哈希期产物被改(touch mtime)→ RENDER_VALIDATION_FAILED。
  - 末尾损坏产物:decode returncode!=0 → RENDER_VALIDATION_FAILED
    (既有语义,ring 带出尾部 stderr)。
  - 取消 vs 超时 vs 编码失败三者错误码互斥;后两者中只有编码失败走
    降级重试(与 C22-10"取消不触发换编码器重跑"一致,timeout 亦不)。
开关、兼容与回退:
  - 纯增量:无开关——取消/进度是行为修复非灰度特性(计划 10.1 开关组
    不含 C22;旧 stage 文本全保留,phase 为可选字段,旧 UI 忽略)。
  - v19 迁移 append-only,旧版本打开新库忽略未知列(未知版本校验只对
    schema_migrations 行,新增列不影响)。
  - 回退 = revert 单提交(含迁移回退:已应用 v19 的库被旧代码打开时,
    多出的列对旧 INSERT/SELECT 兼容——列可空且旧代码不引用)。
已知限制、未解决问题:
  - 端到端取消延迟(≤2s/≤5s 目标)与真实 FFmpeg 停滞注入未实测——
    列 F 场景复测轮;单测 fake 进程覆盖分支语义,不冒充端到端结论。
  - 哈希取消为合作式:已进入的 4MiB read 系统调用不可中断(A05 同
    口径);极端慢盘单块读耗时即取消延迟下界。
  - 停滞门对"无 -progress 输出的校验命令"退化为纯 wall-clock
    (decode_validate 的 -f null 固定输出 out_time,故真实路径不受影响;
    若未来扩展其它校验命令需按计划 C22-4 采用保守 wall timeout)。
  - rename+DB 提交的崩溃恢复:沿用 cleanup_orphans(删除 final_export
    失败/取消/中断任务的 .aivs-tmp 临时文件);计划 C22-9 的"rename 成功
    DB 失败"专项恢复测试未在本单新增(既有 test_cleanup_orphans_* 覆盖
    清理语义;跨卷 rename 场景当前目标盘与临时文件同父目录,os.replace
    同卷成立)。
  - progress(总体 0..0.99)与 phase_progress 的关系:总体进度沿用编码期
    out_time 权重(既有语义),校验期总体进度不再推进(诚实显示——避免
    伪造权重),UI 以 phase 文本+阶段进度补充展示。
  - C23/C24 未动(按计划次序,第三轮剩余两项实验)。
开发者自测:通过(见上)。
独立Reviewer结论:待验收
Gate决策与下一步:第三轮按计划剩余 C23(分块倒放,正确性实验通过再
  上线)/C24(GPU 滤镜,条件实验);或先做 F 场景夹具实测轮(quantify
  C20/C21/C22 的端到端收益与取消延迟)。建议顺序:先 F 实测轮补 G2/G3
  证据,再决定 C23/C24 是否投入。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| C22 单测 | test_render_cancel_validation.py | 11 | decode 成功+进度映射/取消终止进程/失败尾部 stderr 有界/ring 单元/停滞超时分类/校验阶段序列+哈希进度/哈希期取消/哈希期产物被改/超时不重试/phase 写入+终态清空/状态守卫拒绝迟到 phase |
| v19 迁移 | test_migrations_v19.py | 3 | append-only+校验和/可空列/存量行 NULL |
| 既有回归 | test_render_validation_stage1c.py | 3 | fake 签名兼容后全过 |
| 渲染集成 real | stage1c/transform/pip/mask/chroma/seek_parity | 11 | 新校验链路(默认开启)下真实 FFmpeg 渲染零回归 |
| 全量 | Core unit 628 / Desktop 607 / typecheck | — | 全过(input-pool 2 个 unhandled rejection 为 B13 已知遗留) |

## 4. 与实施计划的偏差

- 计划 C22-4"超时拆为:启动无响应、进度停滞、绝对上限"——实现为停滞门
  (120s 无 out_time 推进)+ 绝对上限(max(300s, 5×媒体时长))两段;"启动
  无响应"并入停滞门(启动期间无 out_time 输出即等价无进度,不需要独立
  计时器;两段常量为模块常量,配置化列实测轮)。
- 计划 C22-5"按 1–4MiB 块"——取 4MiB(单值);线程池复用 A05
  BackgroundExecutor(计划"使用 A05 受限线程池"字面执行,不新建池)。
- 计划 C22-6"preparing / encoding / validating_probe / validating_decode /
  hashing / publishing"——encoding 阶段未启用独立 phase(沿用既有
  stage("rendering") + 总进度,编码进度已可观测,重复上报无信息增益);
  其余五段全落地。旧 stage("validating") 保留(兼容映射)。
- 计划 C22-8"取消在发布提交点前必须阻止新成品出现"——实现语义:校验/
  编码期取消照常(提交点前);进入 publishing 后不响应取消(短不可取消
  临界区),完成后不误标已取消(_transition_job 到 succeeded;取消检查点
  均在 publishing 之前)。UI 以"正在完成发布"文案说明。
- 计划 C22-10"记录用户取消至进程终止/线程退出延迟"——分支语义已测
  (kill 被调用、线程令牌置位);延迟计量属端到端指标,列 F 实测轮。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_render_cancel_validation.py services/core/tests/unit/test_migrations_v19.py -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit -m 'not real_provider' -q
.\.venv\Scripts\python.exe -m pytest services/core/tests/integration/test_stage1c_render_real.py services/core/tests/integration/test_transform_render_real.py services/core/tests/integration/test_pip_render_real.py services/core/tests/integration/test_mask_render_real.py services/core/tests/integration/test_chroma_render_real.py services/core/tests/integration/test_render_seek_parity.py -q
Push-Location -LiteralPath 'C:\DataFolder\codes\AI-Vidio\apps\desktop'
node node_modules/vitest/vitest.mjs run
Pop-Location
pnpm typecheck
```
