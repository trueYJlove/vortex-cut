# A01 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**A01（创建失败与异步生命周期）代码完成 + 功能验证完成；性能验证不适用（本单为正确性/生命周期修复，无性能指标门）。**
独立验收：**待验收**（单执行者自检，不冒充独立 Gate）。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A01 修改单，在
B00 部分基线（HEAD `6f4c531`）之上实施。未 push、未打包、未触碰真实 Provider/用户数据库。

## 2. 修改单（模板）

```text
修改单：A01 创建失败与异步生命周期
基线HEAD / 工作树标识：6f4c531（b00 checkpoint），工作树含本单未提交改动
目标与不修改范围：
  目标——预览创建/销毁全链路的失败与取消清理：握手超时统一、AbortSignal 贯穿、
  资源栈逆序 dispose、组件 generation 防旧结果、帧所有权单次 close。
  不修改——时间轴编排语义、replaceIr 保活语义、转场/音频行为、IR 协议、
  解码/合成 worker 的媒体处理逻辑。
实际修改文件（绝对路径）：
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\worker-lifecycle.ts（新增）
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\decode-worker.ts
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\compositor-worker.ts
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\preview-session.ts
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\SyntheticPreview.tsx
  C:\DataFolder\codes\AI-Vidio\apps\desktop\tests\preview-lifecycle.test.tsx（新增）
前置Gate与接口版本：B00 计数接口已就位（editorPerf）；无新增跨进程契约。
算法/状态机变化：
  - worker-lifecycle.ts：统一握手 workerReady（15s 上限，PREVIEW_INIT_TIMEOUT_MS）、
    throwIfAborted；listener/timer/signal 监听统一清理。
  - DecodeWorker/CompositorWorkerClient.create 接受可选 AbortSignal；创建失败
    自 terminate（幂等）后抛错；运行期 error/messageerror 事件 → terminate 并
    拒绝全部 pending（不再只拒绝 init）；迟到消息在 disposed 下帧直接 close。
  - PreviewSession.create：try/catch 资源栈——任一输入失败 → dispose()（逆序
    terminate decode workers → compositor → 移除 canvas）后重抛；AbortSignal
    中止走同一路径。dispose 后 onTimeUs/onEnded 摘除、seekEpoch++（在途任务
    作废）、contextLostResolvers 全部释放。
  - SyntheticPreview：generation + AbortController；projectId 变更立即销毁旧
    会话（sessionProjectRef）；create 完成前卸载/换代 → creating.dispose()；
    字体 fetch 挂 signal、非 2xx 抛错；每步 stale() 检查，旧代结果只释放不上报。
授权、取消、资源所有权、缓存失效规则：
  - AbortSignal 仅由组件层持有（generation 生命周期）；会话内部 lifetime
    controller 负责 image fetch/audio fetch 的跟随取消。
  - 帧所有权：upload/uploadShadow 的 VideoFrame 在 disposed 或 postMessage 抛错
    时恰好 close 一次；transfer 成功后所有权在 worker（terminate 即回收）。
新增/修改测试与命令：
  新增 tests/preview-lifecycle.test.tsx（21 项）：
  - 握手错误/超时/abort 前/abort 中途（decode + compositor + session 三层）
  - 第 2 个输入失败逆序清理；create 成功后 dispose 幂等/回调摘除/静默 seek
  - seek 在途 dispose（不 compose、上传任务作废）
  - 组件 create 中卸载、font fetch 失败、连续切项目 100 次、
    同项目 revision 保活（worker 不重建）、切换项目旧会话立即销毁
  - 帧所有权：disposed upload/readback/compose/resize 不触达 worker、
    postMessage 抛错时帧单次 close
  命令：apps/desktop 下 vitest run tests/preview-lifecycle.test.tsx；
  全量 vitest run；根 pnpm typecheck。
功能回归结果（含跳过）：
  Desktop vitest 全量 50 文件 / 408 项全部通过（含新增 21 项）；
  根 pnpm typecheck（contracts build + desktop tsc）通过；无跳过项。
before / after / 同机环境：
  性能口径不适用——本单为失败路径正确性修复，不宣称性能收益；
  会话创建成功路径行为等价（现有 408 项回归全绿为等价性证据）。
质量与失败路径验证：
  jsdom 环境以 ScriptedWorker（可控握手脚本：ready/error/timeout/fatal/hang）
  驱动全部失败路径；真机失败路径（WebGL 丢失、真实网络失败）由 B00 诊断
  构建与后续 E2E 覆盖，本单不冒充。
开关、兼容与回退验证：
  纯生命周期等价修复，无新开关；create() 新增参数均为可选（AudioContext
  环境不变），向后兼容（现有调用点已全部核对）。
已知限制、未解决问题：
  - B00 报告中的"reload 后 no ticket for asset"竞态未在本单修复（独立调查项）。
  - workerReady 握手超时 15s 维持原值（计划允许），未做按环境分档。
  - 迟到 frame 消息在 disposed 后不 close（监听器已摘除，帧所有权在
    已 terminate 的 worker 侧）——与实现语义一致，测试注释已说明。
开发者自测：通过（见上）。
独立Reviewer结论：待验收
Gate决策与下一步：A02（音频在途去重与有限预热）按计划推进。
```

## 3. 测试证据摘要

- `tests/preview-lifecycle.test.tsx`：21 项全通过（约 15.5s，其中握手超时
  类用例以 fake timers 快进 15s 上限）。
- 全量 `vitest run`：50 文件 / 408 项通过（32s）。
- `pnpm typecheck`：contracts build + desktop tsc 通过。

## 4. 与实施计划的偏差

- 新增测试文件名为 `preview-lifecycle.test.tsx`（计划写 `.ts`）：组件级
  用例需要 JSX，vitest include 同时覆盖两种后缀，无行为差异。
- 计划测试清单中"font fetch 失败"覆盖 `!response.ok`（非 2xx）与 fetch
  网络异常两态；`stale()` 分支由"create 中卸载"用例覆盖。
- 其余步骤 1–5 全部落地；worker-lifecycle.ts 抽出为共享模块（计划允许的
  "统一握手超时"实现载体）。
