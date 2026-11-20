# Vortex Cut 全链路性能评估（2026-09-08）

## 0. 结论与审计边界

当前实现已具备正确的实时预览架构基础，不建议因性能问题立即重写为原生引擎或整体迁移 WebGPU。优先改善的是**长素材的数据读取、音频重复解码、长时间轴计算复杂度、主线程刷新范围、后台任务优先级和资源预算**，而非单独追求 shader 更快。

本次基线：HEAD `b15015b`。只读检查业务代码，新增本报告、纯合成 IR 基准脚本和结果；未修改产品代码、真实项目数据库或媒体，未调用 Provider、未启动真实打包。本轮结合架构、Core、Desktop、Reviewer 检查视角由单一审计者完成，不声称已完成独立多方 Gate 验收。

证据分类：
- **代码确认**：实现路径/复杂度可直接确认；不代表已在用户工作负载测得卡顿时长。
- **本次实测**：纯 CPU IR 基准和指定单元测试。
- **历史证据**：已有探针结果与交接记录，不作为当前版本全应用实测。
- **待验证**：GPU/磁盘/整机争用、长时内存及不同驱动，需要专项探针。

README 的 Stage 2C 描述落后于当前代码；阶段判断以当前代码与 `docs/design/records/PHASE2_HANDOFF.md` 为准。

## 1. 当前架构全貌

```text
React 编辑器（素材、字幕、任务、属性、Canvas 时间轴）
  ├─ 交互预览：HTMLVideoElement / DOM 图层
  ├─ 合成预览：SyntheticPreview → PreviewSession
  │    ├─ Core RenderPlan → 全量逐帧 IR → Main HTTP/IPC → Renderer
  │    ├─ 每 input 一个 Worker：整文件 MP4 demux + WebCodecs VideoDecoder
  │    ├─ VideoFrame transfer → OffscreenCanvas WebGL2 Worker → 画布
  │    └─ 每 clip 音频：fetch + decodeAudioData → AudioWorklet/legacy
  └─ Preload 白名单 → Electron Main → Python FastAPI Core
       ├─ SQLite 项目/Revision/任务/产物
       ├─ JobService 队列 → FFmpeg / ASR / AI Provider 等
       └─ 权威预览 / 最终导出：RenderPlan → FFmpeg filter graph → 校验 → 发布

本地媒体由受控 aivideo:// 票据提供，协议已支持 Range 流式读取。
```

实时合成与最终导出不是同一条执行管线：播放顺畅不代表导出快，导出一致性也不代表交互帧预算达标。蒙版/抠像等实时预览近似或缺失应单列能力矩阵，不能用功能更少的预览证明完整效果性能。

### 已有且应保留的优化

- WebCodecs 解码 Worker 与 WebGL OffscreenCanvas Worker 隔离；VideoFrame transfer。
- 生产 GL Worker 已优先 direct VideoFrame 上传，失败回退 copyTo；不能将旧 compositor.ts 的 copyTo 路径误当当前唯一生产路径。
- 每输入顺序预读链、深度受控的上传、8 槽环形池、seek 纪元作废过期结果。
- 同输入 revision 使用 replaceIr 保留解码器/GL，会话不因每次编辑重建。
- 播放头向 React 上报节流到 10Hz；渲染后备缓冲有 2048 上限。
- 时间轴已有可见区缩略图请求、200ms 防抖、串行取帧与 600 条缓存上限。
- IR 最近 4 条缓存、媒体 probe 缓存、SQLite WAL、硬件编码器真实 smoke test 与软件回退。
- FFmpeg 进程树管理、取消流程、输出校验和原子发布，不应为加速随意删除。

## 2. 本次运行结果

### 2.1 合成 IR 扩展性基准

入口：`evidence/performance-2026-09-08/benchmark_ir.py`。
结果：`evidence/performance-2026-09-08/ir-benchmark.json`。
Python 3.13.1，每案例重复 3 次，报告中位数。单视频 input、顺序 V1，无转场/关键帧/叠加；字幕为合成文本。

| 时间线 | 片段 | 字幕 | 帧数 | IR 投影 | compact JSON 序列化 | JSON 大小（十进制 MB） |
|---|---:|---:|---:|---:|---:|---:|
| 1 分钟 | 1 | 0 | 1,800 | 10.0ms | 7.4ms | 0.47 |
| 15 分钟 | 1 | 0 | 27,000 | 154.0ms | 94.7ms | 7.15 |
| 5 分钟 | 300 | 300 | 9,000 | 344.2ms | 35.7ms | 2.56 |
| 15 分钟 | 900 | 900 | 27,000 | **2,701.4ms** | 104.2ms | 7.70 |

不包括：计划编译、数据库、ffprobe、实际 API 序列化实现、HTTP、IPC 克隆、JS 解析、GPU、视频读取。不把该结果冒充整应用端到端延迟。最后一行每秒一个切段/字幕是密集压力案例，不代表所有用户项目。

但代码明确在 async preview_ir 内直接同步投影，因此 2.7 秒级 CPU 工作确实会占用调用它的 Core 事件循环。7.70MB 也只是线上的紧凑 JSON，不能当成 Python/JS 对象堆的内存大小。

### 2.2 功能回归抽查

- Core：test_render_ir、test_encoders、test_jobs、test_render_ass_ffmpeg_stage1c：**61 passed**。
- Desktop：timeline-geometry、timeline-filmstrip、varispeed-worklet、restricted-media：**70 passed**。
- 未运行整套测试、Electron 全应用性能测试或真实媒体长时压力测试。

### 2.3 历史性能证据的正确解读

`docs/design/records/PHASE2_HANDOFF.md` 记录生产会话探针：1x/1.25x 短项目 composed 319/320、报告丢帧 0、间隔 p95 约 34ms；2x 音频项目约 3 秒。seek p95 约 103–110ms，超过原 100ms 门限。

这些足以证明之前播放编排重构有价值，但不能证明 15–60 分钟、数百素材、多轨及导出/ASR 并行下达标。历史探针直接挂载 PreviewSession，不等价于完整 App 和时间轴一起运行。

## 3. 优先级排序与改进建议

P1：建议进入第一轮性能工程；P2：随后完善。此处是优化优先级，不代表产品发布缺陷分级。

### P1-A 音频按 clip 全文件解码，且在途请求没有去重

**代码确认**：
- `apps/desktop/src/app/preview/preview-session.ts:246-258` 为启用音频的每个 segment 预热。
- `:588-603` fetch 整媒体、arrayBuffer、decodeAudioData；只判断 buffer/workletBuffer，没有 loading Promise。
- `:686-700` 播放 tick 中 buffer 未就绪会再次调用 ensureAudioBuffer。
- `:612-627` 每 clip 建立 worklet 并复制/转移频道数据。
- `apps/desktop/src/app/timeline/TimelineCanvas.tsx:1920-1967` 波形另按 clip fetch + 整段解码，`:477-499` 在 Renderer JS 扫描 PCM 峰值。

后果：同一长素材切成多个 clip，会重复读取和解码；播放开始时音频未就绪又可能每 tick 叠加请求。波形还会再做一次。48kHz、双声道、Float32 的一小时 PCM 约 **1.382GB（1.287GiB）**，不含压缩媒体和工作缓冲；这是容量推算，不是本次内存实测。

建议：立即增加在途 Promise 去重、取消/失效管理、有限并发；按 asset+fingerprint 共享音频源；预热仅覆盖当前和邻近段。长期将音频改为分块 PCM/流式环形缓冲，波形由后台按素材生成持久化多分辨率 peaks。简单共享整段 AudioBuffer 只是过渡，不足以解决长素材内存问题。

### P1-B 视频整文件加载、全输入 eager 初始化，缺少会话级内存预算

**代码确认**：
- `decode-worker.worker.ts:321-323` response.arrayBuffer 后 dataBytes 保留整媒体。
- `preview-session.ts:215-245` 顺序初始化所有视觉 inputs，非当前窗口按需启用。
- `compositor-worker.worker.ts:242-245` 每输入建环槽；上传过的旧输入纹理直到会话结束仍保留。
- `restricted-media.ts:69-82` 已具备 Range，可利用而非重写不受控文件访问。

后果：首帧要等全部输入初始化；更多素材意味着更多 Worker/压缩字节驻留；已播放输入逐渐积累显存。direct RGBA 下仅 8 张 1920×1080 纹理约 63.3MiB/输入，4K 约 253MiB/输入，另有解码表面、影子槽等。槽内存随实际上传分配，不是初始化瞬间已分配全部像素。

建议：索引/媒体体拆分，Range 分段缓存；当前输入+换段预热窗口的 Worker 池；按压缩缓存、PCM、解码帧、GPU 纹理分设 byte budget 和 LRU。预览源按负载选择 540p/720p/1080p 代理，最终导出仍用原片。降低画布尺寸本身不会降低原片解码分辨率。

### P1-C 每次解码定位从头扫描 sample 表

**代码确认**：`decode-worker.worker.ts:438-451` 每请求从 samples[0] 找最接近 PTS，直到目标之后才 break。

后果：顺播后半段单次查找成本随源文件位置增长；整段播放累计可接近二次复杂度。Worker 隔离避免直接占用 UI，但会延迟解码喂入。

建议：demux 一次生成 PTS 排序索引（保留 PTS→decode/sample 索引）；随机 seek 二分、顺播使用游标。必须覆盖 B 帧 CTS 非单调、VFR、同 PTS、关键帧回退；不能直接对 DTS 顺序数组盲目二分。

### P1-D 全量逐帧 IR 及同步 Core CPU 工作

**代码确认 + 本次实测**：
- `rendering/ir.py:372-431` 每帧反向扫描 regions、扫描全部 overlays 和 captions。
- `rendering/service.py:203-234` 即使命中 IR 缓存也先 compile；未命中时同步投影。
- `preview-session.ts:305-338` PiP 手势每次遍历全帧 overlays；SyntheticPreview 的一次几何更新同时调用 box 和 rotation 两次扫描。
- `rendering/ir.py:24` 当前硬上限 27,000 帧（30fps 下 15 分钟）。

建议分层处理：
1. 保留现有语义，先为 region/字幕/overlay 建时间区间索引和扫线游标；PiP 建 clip→overlay 引用索引或 transient 覆盖层。
2. 单独工作线程/进程执行耗时 compile/投影；纯 Python CPU 密集计算优先评估进程或更紧凑算法，不能把 to_thread 当作消除 GIL 的方案。
3. 受控窗口 IR、增量 dirty-range 投影、取消过期 revision；减少跨进程全表传输。
4. 保留 IR 权威源和 worker 执行器边界，遵守现有交接设计，不因优化引入多份互相漂移的时间轴。

### P1-E 时间轴全画布重置与 React 高层刷新耦合

**代码确认**：
- `TimelineCanvas.tsx:1972-2011` 绘制 effect 依赖 playhead/hover/interaction 等，每次都赋 canvas.width/height 并 drawTimeline。
- `:1825-1827` 多个几何数组每 render 新建；`:1990` 附近全量绘图。
- `App.tsx:1751,1799` 每 render 新建 Map、数组、回调；播放头在 App 顶层 state。
- `SyntheticPreview.tsx:103-110` 已节流至 10Hz，但每次仍穿过编辑器树。

建议：把底图、缩略图/波形、选择/拖动、播放头分层；仅尺寸真实变化时改 canvas.width/height；播放头使用轻量独立层+rAF。按横向可见区和纵向轨道虚拟化，避免 Canvas 高度随全部轨道增长；稳定 props、memo/selector 化编辑器状态，缩略图完成通知按帧合并。

不是“Canvas 天生慢”，而是失效与重绘粒度过大。收益必须以完整 App 的 trace 验证。

### P1-F Core async 路径内存在同步整文件 I/O

**代码确认**：
- `projects.py:194-202` async 导入中同步 sha256_file；refresh/relocate 也有相似路径。
- `rendering/validation.py:69` 返回前同步计算文件 SHA256。
- `database.py:905-913` 每次连接新建并执行 PRAGMA；SQLite 同步操作可能等待 busy_timeout 5 秒。

建议：哈希/大文件复制进有界后台工作单元，分块进度与取消；不要为了快删除完整性验证。DB 设置尽量在初始化阶段完成，连接复用须明确线程归属；事务保持短小，测量锁等待及事件循环延迟。不建议当前就换数据库。

### P1-G 统一 FIFO 单任务队列导致用户急需的任务排在长任务后

**代码确认**：`jobs.py:568-582` 仅 self.tasks 为空时取最早 queued 作业；不是无限并发。

后果：长导出、转录或下载可让后续权威预览/代理排队。另一方面，实时预览、波形和缩略图不在此队列内，仍会与正在运行的重任务竞争。

建议：按交互预览/代理、导出、ASR、网络任务分优先级和资源配额；有界 CPU/IO/GPU 调度，播放时主动收紧后台任务预算。不能简单把全局并发从 1 调到 8；硬件编码也会与播放共享 GPU/内存带宽。

### P1-H 导出按片段建立输入、重复 probe，从文件开头解码到 trim 位置

**代码确认**：
- `rendering/service.py:304-310` segment_paths 与 segment_probes 按 segment 建立，同资产重复 probe。
- `rendering/ffmpeg.py:208-212` 每 segment 一个 -i，未设置 input-side -ss/-t。
- `:255-262,712-718` trim 在滤镜中；倒放使用 reverse，长区间有帧缓存风险。
- `:519-550` 可用硬件 encoder，但滤镜仍主要是普通 CPU scale/overlay/等，不是端到端 GPU 链。

建议：先按唯一素材去重 probe、加有限并发；对深源区间使用粗定位+精确 trim，重新核对转场借用、变速、音视频同步；对多段同源评估区间聚合/分块编译与中间缓存。盲目共享一个输入再 split 可能造成缓冲增长，不应当成无条件优化。

测量实际 decode/filter/encode 占比后，才选 GPU scale/合成路径；保留字体、混合、色彩和导出一致性 golden tests。长倒放建议分块缓存/预渲染。

### P2-I 探测/最终校验额外成本和取消覆盖

**代码确认**：`media/encoders.py:30-104` choose 会重新探测与真实 smoke test，无结果缓存；`rendering/service.py:570-591` 在尝试复用预览前仍先 choose 和读取 toolchain。

`rendering/validation.py:51-69` 导出后完整解码，再遍历产物哈希；`rendering/ffmpeg.py` decode_validate 使用固定 120s 超时，未传 cancel_event。取消只能在后续阶段检查，长产物可能校验超时或响应慢。

建议：按 FFmpeg 构建/驱动/编码参数缓存能力，失败时失效并重测；校验仍保留完整性门槛，但移入可取消资源配额任务，超时按时长/吞吐合理配置。UI 分开展示编码/校验/发布进度，避免“99% 卡住”。

### P2-J 缩略图任务生命周期和轮询/初始化请求

**代码确认**：
- `TimelineCanvas.tsx:242-335` 全局单 video FIFO 队列；loadeddata/seeked 无超时，已离开视口的任务不撤销。
- `App.tsx:317-331` 打开项目对全部素材及全部就绪转录做嵌套 Promise.all。
- `App.tsx:489-494` 每 1.5s 刷新 projects/jobs/models，无 in-flight guard；项目已有部分任务订阅机制。

建议：缩略图请求用视口 epoch、超时与重排，可取消旧请求；缓存按 asset/time/尺寸/指纹而非 clip 共享。大项目分页和按需加载转录；轮询改为事件驱动+低频兜底，后台窗口退避，同一请求 single-flight，内容未变不更新大 state。

### P2-K 初始化失败的资源回收

**代码确认**：`DecodeWorker.create:66-83` 初始化拒绝没有 terminate；`PreviewSession.create:194-245` 多 input 初始化中途异常没有统一 finally 清理，尚未 return 的 session 无法由外部持有并 dispose。

建议：create 失败统一释放已建 Worker/GL/canvas/audio，fetch 支持 AbortSignal；验证导入不支持媒体、15s 超时、快速切项目 100 次后 Worker 数/RSS 回落。不可把这种异常路径资源积累当成正常 ring cache。

## 4. 测量体系问题：当前指标不足以代表“流畅”

`preview-session.ts:883-886` task_ms 测量 compose 命令构造/发送，不是 GPU 实际完成或屏幕呈现时间。
`compositor-worker.worker.ts:616` gl.flush 也不是 GPU 完成栅栏。
`preview-session.ts:892-904` dropped 按 rAF 中落后次数计数，不是唯一源帧丢失数；饥饿重锚会放慢内容时间，因此“零丢帧”不等于实时速度达标。
`metrics()` 的 composed_frames 来自最多 1200 项的 taskTimes 长度，不是无限会话累计总数。

建议建立事件链：输入→请求→读盘→demux→decode→upload→compose→present，携带 request/frame/input/epoch ID。
至少记录：
- 首帧、播放启动、seek-to-visible 的 p50/p95/p99；
- 实际内容进度/墙钟、重锚次数、冻结时长、唯一展示/跳过帧；
- A/V drift、AudioWorklet underrun、重启音源次数；
- Renderer 长任务与 React commit 时间、Canvas 重绘面积；
- 各进程 RSS/堆、压缩缓存/PCM/纹理估算、GPU 引擎、磁盘吞吐；
- 队列等待、后台任务占用和取消完成延迟。

优先采用浏览器 trace/presentation 信息与 GPU timer query（能力允许时）补充采样，而非每帧同步 readPixels/gl.finish 来“精确计时”，后者会污染性能。

## 5. 推荐实施顺序与阶段门

### 第一步：建立基线并止住明显放大器
- 音频在途去重/并发上限/可取消；sample PTS 索引。
- IR 扫线索引；同步哈希移出事件循环。
- Canvas 仅尺寸变化时重置；播放头独立刷新。
- 能力/probe 缓存、轮询 single-flight、create 失败清理。
- 同时补完整 App 性能基线，避免只跑独立会话探针。

### 第二步：让内存和后台竞争可控
- 代理分辨率与短 GOP 策略、Range demux、按窗口加载素材/Worker。
- 素材级波形、多分辨率磁盘缓存、分块音频。
- 统一资源配额，交互任务优先，播放和导出并发压测。
- 时间轴分层/虚拟化与稳定状态订阅。

### 第三步：提升长项目与导出吞吐
- 窗口/增量 IR 与 revision dirty-range 缓存。
- 输入深 seek、区间级导出编译/缓存、分块倒放。
- 以实测瓶颈选择 GPU 滤镜路径，而非先全面改造引擎。

每轮按 AGENTS.md 执行范围/契约评审、实施、独立验证和 Gate；本报告只是立项建议，不是变更授权或验收通过。

## 6. 建议性能验收矩阵（目标，不是当前已达成）

固定硬件档位（8/16/32GB、Intel/AMD/NVIDIA、集显/独显）、媒体与代理规格后制定门限：

| 场景 | 建议初始目标 |
|---|---|
| 60Hz UI 拖动/滚动 | UI 帧时间 p95 ≤16.7ms；无持续 >50ms 主线程任务 |
| 30fps 播放 | 内容速度接近 1.0x；唯一跳帧率 <1%；记录冻结/重锚而非隐藏 |
| seek 拖动粗预览 | p95 ≤100ms；松手后精确帧 p95 ≤250ms |
| 播放启停 | 热态可见/可听反馈 p95 ≤100ms |
| 音视频同步 | 持续偏差尽量 ≤40ms，明确变速/转场单独指标 |
| 长时间使用 | 连续编辑/切项目 30–60 分钟内存可回收，不随访问素材无界增长 |
| 导出/ASR 后台工作 | 播放和 UI 仍满足对应档位指标；明确必要的代理降级 |

媒体矩阵：短片、15 分钟、60 分钟；1/100/1000 片段；1/4/8 视频层；4K 长 GOP、60fps、VFR、H.264/HEVC/MKV；同源深切段、0.5x/2x、转场、字幕、模糊背景；无音轨/坏文件/非对齐宽度；cold/hot、热降频及不同刷新率。

超过 15 分钟当前 IR 会拒绝，应记录为现有能力边界，不能假装它已参与性能验收。HEVC/MKV 等需验证代理/回退，而不是假设当前手写 AVC demux 原生支持。

## 最终建议

第一批优先做 **音频去重与分块、样本索引、IR 扫线与异步隔离、时间轴分层刷新**。这四组覆盖用户感知最强的播放、seek、拖拽、编辑生效延迟，并能避免长项目把短片阶段已经做好的 GPU 优化抵消掉。随后解决素材按需加载/代理/内存预算和后台调度，最后再对导出图与 GPU 路径做有证据的专项优化。
