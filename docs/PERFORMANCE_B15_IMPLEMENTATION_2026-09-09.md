# B15 实施进度与自检报告(2026-09-09)

## 1. 状态与范围

**B15(分块 PCM 与流式 AudioWorklet)代码完成 + 功能验证完成。**
独立验收:**通过**(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)

依据 `docs/PERFORMANCE_IMPLEMENTATION_PLAN_2026-09-08.md` 第 6 节 B15 与
第 6.1 节跨进程契约规则,在 B14(`7ed5235` 报告)之上实施,按
"Core 分块生成 → 契约/IPC → Renderer 数据层 → worklet 流式+会话接入"
四个可审查提交推进。

四个提交(单一目标,均本地,未 push):
- `da235b4` B15-A Core 分块 PCM(流式 stdout 生成 + 拼接对拍金标准)
- `df5d8fb` B15-B 契约与 IPC 贯通(performance.ts B15 段 + 10 通道)
- `992bf6d` B15-C Renderer 数据层(pcm-chunk-cache + audio-stream)
- (本提交)B15-D worklet 流式模式 + preview-session 接入 + 本报告

## 2. 修改单(模板)

```text
修改单:B15 分块 PCM 与流式 AudioWorklet
基线HEAD / 工作树标识:7ed5235(B14 报告);四个本地提交
目标与不修改范围:
  目标——数据契约:采样率 48000、channels=2、f32le;每块有效区 2 秒
  (96000 样本/声道);块 key 用整数 sample offset;服务返回
  {cache_key, status, start_sample, valid_samples, sample_rate, channels};
  尾块长度精确,EOF 显式标记(valid_samples=0)。FFmpeg 粗定位+精确采样
  裁切+统一 resample;相邻块拼接以整段同参数参考 PCM 对拍(计划验收门,
  真实 FFmpeg 集成测试 max|Δ|≤1e-4)。worklet 协议:configure/appendChunk/
  play/setSpeed/stop/releaseBefore → needRange/underrun/consumed/drained;
  transfer 块为消费者副本;render 回调不 fetch 不 await;WSOLA
  window2048/delta240 语义保留,跨块边缘数据拼接连续。加载策略:位置
  前后窗口≥2 秒播放时间,4x 按源时间扩需求;缓存按字节限制,全局同 key
  single-flight;seek 增 generation,旧块不接入新位置。A02 整段模式保留
  为小素材回退(阈值 30 秒——48k 双声道 30s PCM≈11MiB,计划 ≤32MiB 限内)。
  不修改——set-buffer 全量模式语义(A02 回退原样保留,单测回归全绿);
  SharedArrayBuffer/跨源隔离(计划:不以 SAB 为前置);legacy
  AudioBufferSourceNode 回退路径;B16 调度(块生成同步内联——低延迟
  PCM 不排长导出后,计划 B16 前语义);时钟决策(音频线程不倒退时钟)。
实际修改文件(绝对路径):
  services/core/src/aivs_core/media/audio_chunks.py(新增)
  services/core/src/aivs_core/app.py(PcmChunkService 装配 + 2 端点 +
    PcmChunkRequest/MediaRequest 模型 + PcmChunkError→DomainError 映射)
  services/core/tests/unit/test_pcm_chunks.py(新增,10 项)
  services/core/tests/integration/test_pcm_chunks_real.py(新增,4 项)
  packages/contracts/src/performance.ts(B15 段:类型 + 校验器)
  apps/desktop/electron/main/performance-ipc.ts(pcm-chunk:ensure/media)
  apps/desktop/electron/main/core-admin-client.ts(resolvePcmChunkMedia)
  apps/desktop/electron/main/index.ts(接线)
  apps/desktop/electron/preload/index.ts(DesktopApi +2)
  apps/desktop/src/app/preview/pcm-chunk-cache.ts(新增)
  apps/desktop/src/app/preview/audio-stream.ts(新增)
  apps/desktop/src/app/preview/varispeed-worklet.ts(流式模式扩展)
  apps/desktop/src/app/preview/preview-session.ts(流式 rig/喂块/世代/
    dispose;create 加 pcmProjectId 参数)
  apps/desktop/src/app/preview/SyntheticPreview.tsx(透传 projectId)
  测试:tests/performance-ipc.test.ts(B15 describe 5 项)、
    preload.test.ts(+2 行)、tests/pcm-chunk-cache.test.ts(新增 11 项)、
    tests/varispeed-worklet.test.ts(+6 项流式)、
    tests/pcm-streaming-session.test.ts(新增 3 项)、
    app/editor-commands/editor-shell mock +2 方法。
前置Gate与接口版本:B10 派生缓存(audio_pcm_chunk 枚举已存在);
  B13/B14 预算表与通道模式;A02 音频 rig 结构。
算法/状态机变化:
  - Core chunk_args:-ss(块起点减半块预滚) + aresample=48000:async=1:
    first_pts=0 + atrim(start..end) + asetnsamples(n=2×96000:pad=0) →
    f32le pipe:1。产物 = 12B 头(u32 start_sample + u32 valid_samples +
    u16 sr_khz + u16 ch) + 交错 f32。samples>96000 → TOO_LARGE 拒绝;
    越界起点 → 空块(valid=0 = EOF)。
  - PcmChunkService.ensure_chunk:同步内联(不排 jobs——计划"PCM 低延迟
    任务不能排在几分钟不可中断导出后");begin_build single-flight 防
    并发重复;源失效由 fingerprint 键承载(内容寻址)。
  - Renderer PcmChunkCache:块键 = asset|generation|start;解析时头与
    ensure 描述一致性校验(start/sr/channels/valid——不符按损坏 null
    降级);字节上限 LRU(无 pin 最旧先逐;worklet 持有块正确性优先);
    invalidateGeneration 世代作废;失败 retry 门。
  - AudioStreamLoader:windowChunks = 位置±2s 播放窗×max(1,speed)(源
    需求);drive 返回 ready 块并触发未就绪块 ensure(并发≤2 超额顺延
    下轮 tick);reseek 世代递增。
  - worklet 流式核心:chunks 有序数组(appendChunk 按世代过滤+幂等+
    按插入序定位);readAt 绝对样本跨块查找(无覆盖→NaN);placeGrain
    缺口(读窗起点 NaN)→ 静默颗粒+underrun 去重+needRange(from,to)
    上抛;越过 streamEnd(尾块终点)→ drained;releaseBefore 保留
    window+delta 回读余量;WSOLA bestOffset 流式无 srcLen 上界(块按需
    到达)、NaN 候选不参与评分。消息:configure/append-chunk/
    release-before(入)/need-range/underrun/drain(出)。
  - 会话:useStreamingFor(输入 duration≥30s 且 loader 就绪)分派;
    ensureStreamingWorklet(configure + needRange 端口回喂 + underrun 计数
    观测);feedStreamingChunks(位置推进窗口 drive → 双声道副本 transfer
    + pin);startAudioSource 流式分支(play 消息同语义);seekToFrame →
    reseekStreaming(世代递增+各 rig configure 重置+喂块簿记清零);
    dispose → loader/cache 释放。
授权、取消、资源所有权、缓存失效规则:
  - 块请求网格对齐(96000)四层强制:contracts is 校验器/Main asRecord
    前置/服务层 PcmChunkError/端点 400。
  - 块产物授权复用 B10 链:admin resolve + refs 表;Renderer 只见票据。
  - transfer 副本:缓存本体只读;每 worklet 双声道独立 Float32Array
    transfer(独占所有权;缓存本体不 transfer)。
  - 世代:seek 递增;旧代 appendChunk 一律丢弃(迟到块不接入新位置);
    旧代缓存条目 invalidateGeneration 归还字节。
  - underrun 只计数观测——不驱动视频时钟(计划硬约束:暂停/等待决策
    由会话统一,音频线程不私自倒退)。
新增/修改测试与命令:
  Core:pytest services/core/tests/unit/test_pcm_chunks.py(10);
    integration/test_pcm_chunks_real.py(4,真实 FFmpeg)
  Desktop:pnpm typecheck;vitest run(65 文件 581 项)
功能回归结果(含跳过):
  Core unit 全量 572 通过;B15 集成 4 通过(含拼接对拍金标准)。
  Desktop 65 文件 581 项通过(2 个 jsdom HTMLMediaElement stderr 噪声
  为既有基线);typecheck 通过;A02 既有 8 项 worklet 回归全绿
  (buffer 模式语义未变)。
before / after / 同机环境:
  "60 分钟源只播 10 秒,PCM 驻留不随源总长增长"——长素材不再整段
  decodeAudioData(块窗口 ±2s 播放时间 × 档位字节上限);F03 端到端
  同机量化列 F 场景复测轮。会话级链路(configure→请求→append)以
  mock IPC/AudioContext 测试覆盖;2s 块边界无新增点击/空洞以真实
  FFmpeg 拼接对拍金标准覆盖(相邻块 vs 整段参考 max|Δ|≤1e-4,前 4 秒
  逐样本)。
质量与失败路径验证:
  - 块损坏(头/载荷不一致)→ 解析 null → 静默降级(underrun 路径,
    不抛错阻塞预览);fetch 失败 → 条目 failed(不自动重试)。
  - 无音轨 MEDIA_NO_AUDIO;网格未对齐 400;未授权 401;跨项目
    ASSET_NOT_FOUND(集成测试覆盖)。
  - 世代:旧代块丢弃(worklet 单测 + loader 单测);releaseBefore 后
    继续推进不退化为缺口(worklet 单测)。
  - 流式缺口:一次缺口一次 underrun + needRange 从窗口起点请求;
    数据到达恢复出声(worklet 单测)。
开关、兼容与回退:
  - 流式启用条件 = create 传 pcmProjectId 且 desktop.ensurePcmChunk
    可用(Electron 环境)且素材≥30s;任一不满足 → A02 整段模式
    (行为与 B15 前完全一致——短素材/非 Electron/测试环境)。
  - worklet set-buffer 全量模式与流式共存(rig.streaming 分派);
    AudioWorklet 不可用仍回退 legacy playbackRate 变调路径。
  - 会话 dispose:loader/cache 全量释放,无在途引用泄漏。
已知限制、未解决问题:
  - 48kHz AudioContext 假设:块采样率 48000 与 AudioContext.sampleRate
    相等是流式路径前提(计划:非 48k context 必须重采样或拒绝)——当前
    会话以 audioCtx.sampleRate 构造 loader,非 48k 设备(罕见)下块时间
    域不匹配;该路径回退 A02(实测 Chromium AudioContext 默认 48k,
    列实机验证项)。
  - seek 后重喂:重锚由 syncAudio 漂移判定驱动(既有 80ms 阈值),
    极端 seek 风暴下块请求经 loader 并发闸门顺延(缺口静默+underrun
    观测,不阻塞交互)。
  - 跨块 WSOLA prevTail 语义:参考尾段取流存储(块边界数据连续时
    与整段等价);块边界恰逢缺口的交叉淡化由相邻颗粒 COLA 补(听感
    门 F07 人声/鼓点验收未跑——列 F 场景轮)。
  - consumed(range) 消息未上抛(计划协议字段)——render 侧按
    needRange/位置驱动已足够;consumed 语义在 B16 预算调度接入时一并
    落地(避免双通道冗余)。
  - B15-B ensure 描述的 valid_samples=null(缓存命中路径)在 Renderer
    解析时以 fetch 后块头为准(一致性校验兜底)。
开发者自测:通过(见上)。
独立Reviewer结论:通过(2026-09-15 集中独立验收,PERFORMANCE_G1G2_C20_C21_C22_CENTRALIZED_ACCEPTANCE_2026-09-15.md)
Gate决策与下一步:F 场景复测轮(F03 长源 10 秒播放 PCM 驻留量化 +
  F07 全速域听感门;B10-B15 能力就绪);或 B16(资源配额调度——
  consumed/lease 协议接入)。
```

## 3. 测试证据摘要

| 层 | 文件 | 项数 | 覆盖 |
|---|---|---:|---|
| Core 单测 | test_pcm_chunks.py | 10 | 网格对齐/键稳定(换 build 换键)/头 roundtrip/decode 值/生成+缓存命中/尾块/越界空块/缺文件/失败 mark_failed |
| Core 集成(真实 FFmpeg) | test_pcm_chunks_real.py | 4 | **相邻块拼接 vs 整段参考 PCM 逐样本对拍(max\|Δ\|≤1e-4)**/尾块+EOF 空块/端点 ensure+media roundtrip(refs)/网格+授权+未生成 404 拒绝 |
| 契约/IPC | performance-ipc.test.ts(B15 段) | 5 | 10 通道白名单/ensure 请求形状与网格拒绝/rendererSafe/票据换发不泄路径/未就绪+错误码+非法偏移 |
| preload | preload.test.ts | +2 行 | ensurePcmChunk/pcmChunkMediaUrl 固定 channel |
| Renderer 数据层 | pcm-chunk-cache.test.ts | 11 | 解析一致/损坏拒绝/single-flight/重试门/LRU+pin+如实超限/世代作废/窗口 1x-4x-0/drive 世代隔离与并发 ≤2 |
| worklet | varispeed-worklet.test.ts(+6) | 14 | 旧 8 项全绿(buffer 语义不变)+ 流式:拼接 ≈ buffer 模式对拍/2x 不变调(过零率)/缺口静默+underrun 去重+needRange+恢复/世代丢弃+drained/releaseBefore 继续/模式切换共存 |
| 会话 | pcm-streaming-session.test.ts | 3 | 长素材流式链路(configure+请求+append transfer)/短素材不流式(ensure 不被调)/无 IPC 回退 |

- Core 全量 unit:**572 通过**;Desktop 全量:**65 文件 / 581 项通过**,
  typecheck(tsc)通过。
- B14 时为 63 文件 / 556 项。

## 4. 与实施计划的偏差

- 数据契约的 `generation`/`consumed` 字段:服务返回未含 generation
  (块键即内容地址,世代是 Renderer 会话侧概念——seek 世代由 loader
  本地递增);consumed(range) 上抛暂缓(见已知限制,B16 接入)。
- 计划"开发验证用整段同参数参考 PCM 对相邻块拼接比较"——已按验收
  门落地为真实 FFmpeg 集成测试(test_pcm_chunks_real.py,前 4 秒逐样本
  max|Δ|≤1e-4;尾块区因 atrim 边界与参考解码器的预滚差异单列容差)。
- 计划 worklet 协议 `play(positionSample, speed, playbackEpoch)`:
  实现为 play(positionSec, speed)(沿用既有消息语义;世代经 configure
  通道传递——迟到块按世代丢弃,语义等效)。
- A02 整段模式回退阈值:计划"30 秒且预计 PCM≤32MiB"——以 30 秒时长
  判定(48k 双声道 30s≈11MiB,在限内;更保守的字节判定在素材采样率
  异常场景由 F 场景轮验证后收紧)。
- 会话流式集成测试以 mock AudioContext/worklet/IPC 驱动(jsdom 无
  WebAudio);真实音频线程行为由 worklet 单测(同源码求值)+ m3p5
  探针既有通道覆盖。

## 5. 复现命令

```powershell
.\.venv\Scripts\python.exe -m pytest services/core/tests/unit/test_pcm_chunks.py services/core/tests/integration/test_pcm_chunks_real.py -q
pnpm --filter @aivideo/desktop test          # 65 文件 581 项
npx vitest run tests/pcm-chunk-cache.test.ts tests/varispeed-worklet.test.ts tests/pcm-streaming-session.test.ts tests/performance-ipc.test.ts
pnpm --filter @aivideo/desktop lint
```
