# A02 实施进度与自检报告（2026-09-08）

## 1. 状态与范围

**A02（音频在途去重与有限预热）代码完成 + 功能验证完成；性能验证待完成（播放长测/真机听感未跑）。**
独立验收：**待验收**（单执行者自检，不冒充独立 Gate）。

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 5 节 A02 修改单，在
A01（`fbacaf3`）之上实施。未 push、未打包、未触碰真实 Provider/用户数据库。

## 2. 修改单（模板）

```text
修改单：A02 音频止血，不提前实现流式引擎
基线HEAD / 工作树标识：fbacaf3（A01），工作树含本单未提交改动
目标与不修改范围：
  目标——同素材多 clip 的 fetch/decodeAudioData single-flight、并发上限 2、
  有限预热（播放态当前段 + 未来 2s；暂停态仅当前段）、失败保留 + 显式重试、
  replaceIr 音频 rigs 同步。
  不修改——worklet WSOLA 算法语义、AudioBufferSourceNode legacy 回退、
  段音频调度模型（startedAt/startOffset/speed）、票据访问方式、B15 流式契约。
实际修改文件（绝对路径）：
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\audio-source-cache.ts（新增）
  C:\DataFolder\codes\AI-Vidio\apps\desktop\src\app\preview\preview-session.ts
  C:\DataFolder\codes\AI-Vidio\apps\desktop\tests\preview-audio-cache.test.ts（新增）
前置Gate与接口版本：A01 生命周期（lifetime AbortSignal/dispose 语义）；
  无新增跨进程契约（缓存为 session 内部模块）。
算法/状态机变化：
  - AudioSourceCache（session 作用域）：entry = queued/loading/ready/error；
    acquire 同步登记 pending Promise（single-flight）；同 key 返回同一 Promise；
    并发门 MAX_CONCURRENT=2（fetch+decode 全程占位，decode 完成前不归还——
    decodeAudioData 不可中止）；排队 drain 一次性放行与空位数相等的队头任务
    （修复同步循环在唤醒者占位前的重查竞态）；failed 状态保留，仅 retry()
    打开后下一次 acquire 重建条目；release 引用计数，最后用户离场且非 ready
    → abort 在途；dispose（lifetime abort）→ 在途失败、排队唤醒、条目清空。
  - 缓存 key = asset_id + binding generation + AudioContext.sampleRate
    （票据字符串不作内容标识；replaceIr 换表时 generation+1）。
  - preview-session：create 期移除全 segments eager fetch（改为仅建 rigs）；
    ensureAudioBuffer 走缓存；syncAudio 有限预热窗口 AUDIO_WARMUP_US=2s
    （播放态未来 2s 入窗段触发一次 ensure——single-flight 去重；暂停态 0）；
    replaceIr 同步音频 rigs（删除 clip 停声清理；input/源窗口/变速变化重置
    播放位置模型；未变 clip 保留）；dispose 时 audioCache.dispose()。
授权、取消、资源所有权、缓存失效规则：
  - 缓存 AudioBuffer 多 clip 共享读取；worklet 迁移仍由消费方 slice 副本
    transfer（ensureWorkletNode 原语义不变，缓存本体不 transfer）。
  - decodeAudioData 无法中止：abort 只挡结果安装；完成前并发位不归还，
    防止"取消后新任务"突破上限（测试覆盖）。
新增/修改测试与命令：
  新增 tests/preview-audio-cache.test.ts（10 项）：同源 50 clip 单次
  fetch/decode、100 tick 重入单次、不同 key 不共享、4 key 并发峰值≤2、
  decode 期并发位不归还、失败保留 + retry 门、release 语义、ready 条目
  release 后保留、dispose 三态（在途失败/排队唤醒/后续 acquire 抛错）。
  命令：apps/desktop 下 vitest run tests/preview-audio-cache.test.ts；全量。
功能回归结果（含跳过）：
  Desktop vitest 全量 51 文件 / 418 项通过（含新增 10 项）；desktop tsc 通过；
  varispeed-worklet 9 项不回退。无跳过项。
before / after / 同机环境：
  性能验证待完成：同源 50 clip 只解码一次的收益需 F04（100 短素材多层混音
  夹具）在真机复测；jsdom 单测只证明语义不证明延迟收益。
质量与失败路径验证：
  单测覆盖并发竞态（drain 唤醒占位竞态已修）、abort 后新任务不超限、
  失败重试门。真机听感（0.5x/2x 变速不变调、双位置同源混音）待 E2E/
  手工验收——varispeed-worklet 单测全绿是算法语义不变的证据。
开关、兼容与回退验证：
  纯 session 内部模块，无新开关；行为变化 = create 不再 eager 解码全部
  音频段（首个活跃段解码时机从 create 期推迟到首个 syncAudio tick）。
  暂停态打开项目：预览静音至播放开始（原 eager 路径在 create 期即预热
  全部段）——A02 计划接受的取舍（见计划"限制"节）。
已知限制、未解决问题：
  - 第一轮仍解码整个源文件（内存只改善不承诺有界）；B15 完成前不宣传
    "支持任意长度音频"（计划原文）。
  - create 期预热移除后，暂停态首帧音频起播会经历一次解码延迟
    （原为 create 期已就绪）；播放中 2s 预热窗口覆盖转场接续。
  - audioRigs 中 clip 被静音（enabled=false）时 rigs 不建立——静音开启
    需等下次 syncAudio tick 建 rig 并触发解码（延迟一帧，行为等价）。
开发者自测：通过（见上）。
独立Reviewer结论：待验收
Gate决策与下一步：A03（解码 PTS/关键帧索引）按计划推进；性能验证项
  （F04 真机对比、长测）在 B00 补全夹具后统一执行。
```

## 3. 测试证据摘要

- `tests/preview-audio-cache.test.ts`：10 项全通过（380ms）。
- 全量 `vitest run`：51 文件 / 418 项通过（31s）。
- desktop `tsc --noEmit`：通过。

## 4. 与实施计划的偏差

- 计划的 `AudioSourceEntry` 接口形状（state/promise/controller/buffer/
  decodedBytes/users/generation）完全落地；预热策略的 seek epoch 优先级
  调度简化为"预热窗口 + single-flight 去重"（tick 重入不追加请求满足
  计划测试要求；完整 epoch 优先级队列留给 B15 流式引擎）。
- `release` 语义按计划第 6 步实现（最后消费者离场才 abort）；"不再预热才
  abort"的预热位登记由 users 集合统一承载（预热调用也带 user 标识）。
- 计划测试清单中"移除 clip、静音开启、同源双位置混音"的部分断言由
  replaceIr 音频 rigs 同步逻辑 + 现有 varispeed/worklet 回归承担；
  组件级（SyntheticPreview）音频行为无 UI 变化，沿用 A01 生命周期回归。
