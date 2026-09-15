# B13 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B13(活跃输入与 GPU 资源预算)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B13 与
第 6.1 节跨进程契约规则,在 B12(`1bb0028` 及此前三提交)之上实施,按
"预算档位+输入池 → Worker 输入协议 → Main 注入与会话联动 → 回归"
三个可审查提交推进。

三个提交(单一目标,均本地,未 push):
- `7c23dda` B13-A 预算档位 + 输入池(resource-budget/input-pool + 17 单测)
- `85d10bd` B13-B Worker 输入协议(registerInput/releaseInput + 4 单测)
- `dbf1c8e` B13-C Main 档位注入 + 会话环深联动(2 项生命周期级测试)

## 2. 修改单(模板)

```text
修改单:B13 活跃输入与 GPU 资源预算
基线HEAD / 工作树标识:1bb0028(B12 报告);三个本地提交
目标与不修改范围:
  目标——三档位预算表(conservative/balanced/high:Range 64/128/256MiB、
  PCM 64/128/256MiB、纹理 128/256/512MiB、保温 1/2/2);输入状态机
  (cold→initializing→warm→active→idle→evicting→cold,另有 failed)与
  压力降级顺序(清 idle→缩预热→缩环深→超预算明确回退,不静默删层);
  compositor Worker registerInput/releaseInput 协议(generation 作废旧代
  上传 + 纹理字节记账 + allYuvTextures 簿记同步);Main 档位判定
  (totalmem → 离散 resource_tier,getRuntime 注入,不暴露主机信息);
  会话环深档位联动(ringDepth 决策 + LEAD=min(LEAD, ringDepth-3))。
  不修改——WebCodecs 解码器保温的既有行为(环池保活 = 隐式保温;
  显式 decoder terminate 保温管理未引入——见已知限制)、音频 PCM 缓存
  (A02 已有 release 语义;PCM 预算表先落值不接线)、ir/合成绘制路径。
实际修改文件(绝对路径):
  apps/desktop/src/app/preview/resource-budget.ts(新增)
  apps/desktop/src/app/preview/input-pool.ts(新增)
  apps/desktop/src/app/preview/compositor-worker.worker.ts(协议+记账)
  apps/desktop/src/app/preview/compositor-worker.ts(客户端 register/release)
  apps/desktop/src/app/preview/preview-session.ts(ringDepth 档位联动)
  apps/desktop/src/app/preview/SyntheticPreview.tsx(resourceTier 透传)
  apps/desktop/src/app/App.tsx(getRuntime 档位状态)
  apps/desktop/electron/main/index.ts(resourceTier 离散注入)
  apps/desktop/electron/preload/index.ts(DesktopRuntime.resource_tier)
  测试:tests/resource-budget.test.ts(17)、input-pool-protocol.test.ts(4)、
    preview-lifecycle.test.tsx(+2 → 23)。
前置Gate与接口版本:B12 完整(Range 源就绪);B10-B12 代理/源选择/
  Range 三件套可用。
算法/状态机变化:
  - BUDGET_TABLES 三档位(计划表原值);tierForTotalMemory:≤8GiB/未知
    → conservative、>16GiB → high、其余 balanced(未知按保守策略)。
  - InputPool 状态机:register(generation 递增,环深按注册输入总数决策)
    /release(generation 匹配才移除)/mark(evicting 只接受 cold)/pin
    (current/next 窗口,L 不可淘汰)/pressure(顺序降级决策,active 需求
    单独计算——超预算仍回退而不是删层)。
  - Worker 协议:registerInput(inputId,generation,geometry,ringDepth,
    shadow,seq) → inputRegistered ack(携带 textureBytes 总量);
    releaseInput(inputId,generation) → inputReleased ack;上传前置代
    校验(未注册/已换代 → uploadError + frame.close 防泄漏);
    handleInit 输入记为第 1 代 + 环池字节计账;releaseInputTextures
    删 ring/影子/静图纹理并同步 allYuvTextures 簿记(防悬挂引用累积);
    模糊垫底为共享资源不随输入释放。
  - 纹理字节估算:w*h*1.5*(4/3)*(ringDepth+shadow)(NV12+mipmap 口径,
    记账为估算非精确)。
  - 会话联动:create(resourceTier) → ringDepth = ringDepthFor(tier,
    视频输入数)(conservative 4+ 输入收 5)→ compositor init.ringDepth/
    rig.ring/slotIndex/pump 封顶全部实例化;pump LEAD =
    min(LEAD, ringDepth-3)(写深不覆盖未展示槽位)。
  - Main:resourceTier() 由 os.totalmem() 判定,经 getRuntime 返回
    离散 resource_tier(Renderer 无 totalmem 等主机信息)。
授权、取消、资源所有权、缓存失效规则:
  - 档位只在 Main 判定,Renderer 收离散值(计划硬约束)。
  - releaseInput generation 语义:旧代请求作废不删新代纹理;上传
    帧在作废路径显式 close(防泄漏)。
  - 字节记账:创建记正/删除记负;init 环池与 registerInput 一致计账。
新增/修改测试与命令:
  Desktop:pnpm typecheck / lint / test(62 文件 532 项)
功能回归结果(含跳过):
  Desktop 全量 62 文件 532 项(B12 时 60/508);typecheck/lint 通过;
  Core 无改动。首轮全量 1 例 editor-commands 偶发超时(单跑通过;
  vitest 配置注释已记录 jsdom 并行负载抖动),复跑全绿。
before / after / 同机环境:
  B13 为能力建设(预算/协议基座);F04 显存估算保持预算内的量化
  验收需 Electron 实机(30-60 分钟工作集平台化)——列 F 场景轮。
质量与失败路径验证:
  - 压力降级链四步单测覆盖(含 over-budget 携带 activeIds 不静默删层)。
  - 旧代上传作废:协议测试 + worker 帧关闭路径。
  - 状态机:failed/evicting 语义、pin 保护、generation 释放语义单测。
开关、兼容与回退:
  - 纯增量:不传 tier = 默认行为不变(balanced 环深 8);Worker 不收
    registerInput 即旧行为(init 记账不影响既有流程)。
  - input-pool 为独立模块:会话尚未全量接线(见已知限制)——协议与
    决策层已就绪。
已知限制、未解决问题:
  - (已清偿,342175a)InputPool 状态机/pressure 的播放循环驱动、
    dispose 释放、Range 缓存档位接线均已落地——见 4.1 补录。
  - 显式解码器保温(decoderKeepWarm)的周期性 terminate 管理未实现:
    压力降级路径已实现 evict-idle → terminate(保温让位),常规态环池
    保活 = 会话内隐式保温;周期性保温回收留实机调优(行为不劣于现状)。
  - PCM 缓存预算表值已定未接线(A02 AudioSourceCache 的容量参数语义
    与 MiB 预算不同——需 A02 改造,归 B14 波形单一起做)。
  - idle 识别用固定 1.5s 时间窗(不含 active 输入的未来入窗预测);
    LEAD_ENTER 预读会先于 1.5s 触发 warm——预测式 idle 留实机调优。
  - slotToken(每上传引用 generation+slot)简化为 generation 校验:
    ring 槽位复用语义下 token 冗余,generation 已作废旧代(计划原意
    为防"释放等待当前引用完成"——worker 内上传为同步队列,generation
    校验即等待语义)。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:F 场景复测轮(B10-B13 能力就绪,F01-F04 量化
  验收);或 B14(波形移出 Renderer 整音频解码——PCM 预算接线一并做)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| 预算 | resource-budget.test.ts | 17 | 三档位表、tier 判定(8/16GiB 边界/未知)、纹理估算(NV12+mipmap/影子)、ringDepthFor、状态机(register/mark/failed/evicting/release generation/pin)、压力顺序(清 idle 保 keepWarm→缩预热→缩环深 8→5→over-budget)、setTier、cold 不计账 |
| 协议 | input-pool-protocol.test.ts | 4 | registerInput/releaseInput 消息形状 + ack resolve、generation 递增、disposed 拒绝 |
| 会话 | preview-lifecycle.test.tsx(+2) | 23 | conservative 4 输入 init.ringDepth=5 / balanced 保持 8(真实 PreviewSession.create + FakeWorker 断言 compositor init 消息) |

- Desktop 全量:`pnpm test` → 62 文件 / 532 项;`pnpm lint`(=tsc)通过。
- Core 侧零改动。

## 4. 与实施计划的偏差

- 计划 Worker 协议 `registerInput(inputId,generation,geometry,ringDepth)`
  + "每个上传/compose 引用 generation+slot token":实现为 generation
  校验(上传前置检查+帧关闭);slot token 简化(理由见已知限制)。
- 计划"未激活解码器保温数"(1/2/2):表值已定;压力降级路径已实现
  evict-idle → worker terminate(保温让位),常规保温为环池隐式保活
  (行为不劣于现状;显式周期性 terminate 留实机调优)。
- 计划状态机六态全量驱动:已接线(`342175a` 接线收尾)——create 注册、
  播放/seek tick 驱动活跃集合与 idle 判定(1.5s 不活跃)、pressure 决策
  执行(evict-idle → releaseInput + terminate;shrink-ring → 下一会话
  生效;over-budget → lastError 一次性提示)、dispose 全量释放、
  replaceIr 活跃时间窗重置;Range 缓存预算按档位贯通
  (64/128/256MiB → DecodeWorker init → HttpRangeSource)。
- Main 注入经 getRuntime 扩展(resource_tier 字段):计划未指定通道,
  该通道为既有 Renderer↔Main 握手,离散值语义符合"不暴露主机信息"。

## 4.1 接线收尾(2026-09-09 补录,提交 342175a)

- 会话池驱动:poolRegister(create)/poolDrive(compose 推进 + seek 完成
  时,活跃 = 当前帧 + 下一帧输入并集)/poolDispose(dispose 全量释放,
  compositor releaseInput + generation)。
- 压力降级执行:evict-idle 时 rig.worker.terminate(解码器保温让位,
  重入时 pump 冷启重建) + compositor.releaseInput(纹理删除 + 记账);
  shrink-ring 降会话环深(下一会话生效——运行中环池不撕裂,与计划
  "pause/seek 边界原子切换"换源语义一致);over-budget 一次性
  lastError 提示,不静默删层。
- Range 缓存预算:session(resourceTier) → DecodeWorker.create(cacheCapBytes)
  → worker init → HttpRangeSource cacheCapBytes(档位 64/128/256MiB)。
- 测试:preview-lifecycle +2(池注册/dispose 释放断言 + conservative
  64MiB init 断言)→ 25 项;全量 62 文件 / 534 项全绿。

## 5. 复现命令

```powershell
pnpm --filter @aivideo/desktop test     # 62 文件 534 项
npx vitest run tests/resource-budget.test.ts tests/input-pool-protocol.test.ts
pnpm --filter @aivideo/desktop lint
```
