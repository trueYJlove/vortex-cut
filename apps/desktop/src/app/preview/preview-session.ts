import { throwIfAborted } from "./worker-lifecycle.js";
import { AudioSourceCache } from "./audio-source-cache.js";
import { AudioStreamLoader } from "./audio-stream.js";
import { PcmChunkCache, PCM_CHUNK_SAMPLES } from "./pcm-chunk-cache.js";
import { activeInputIds } from "./ir.js";
import { arrayFrameSource, windowPrefetchStarts, type FrameSource } from "./frame-source.js";
/** 合成预览会话：持有解码 worker、GL 执行器 worker（OffscreenCanvas）、纹理簿记
 * 与 WebAudio，对外提供 play/pause/seek 与时间/指标回调。
 *
 * 播放架构（M3-2.2 重构 + Phase 2 完全体 worker 化）：
 * - 每输入一条顺序解码链（prefetch chain）：按 IR 帧序单调推进 src_n，深度 1
 *   在途、完成后立刻续链（不等 rAF tick），解码器保持热态（每帧喂下个采样）；
 * - 每输入一个环形纹理池（RING）：解码帧 transfer 到 **GL 执行器 worker**
 *   （OffscreenCanvas，upload p95 14~25ms 的 copyTo/texImage2D/mipmap 不再占
 *   主线程），worker 上传完成 ack 后标记槽位就绪；
 * - 合成取 ≤ 墙钟目标的最新就绪帧；落后超过 LAG_REANCHOR 帧时重锚时钟；
 * - 会话保留全部时间轴编排（IR/时钟/pump/就绪判定），向 worker 下发**绘制
 *   命令列表**（fill=模糊垫底 / draw / captions）——worker 无时间轴语义；
 * - seek（暂停态）仍走并行解码后合成，同样经环形/影子槽位 ack，并同步链游标。 */
import type { CompositorWorkerClient } from "./compositor-worker.js";
import type { DrawCommand, FrameResidency } from "./compositor-worker.worker.js";
import type { Ir, IrContent, IrFrame, IrOverlay } from "./ir.js";
import type { PreviewSourceResolver } from "./source-resolver.js";
import { PREVIEW_IR_V2_MAX_WINDOW_FRAMES, PCM_CHUNK_SAMPLE_RATE } from "@aivideo/contracts";
import { BUDGET_TABLES, ringDepthFor, predictResidencyBytes, windowSourceBudget } from "./resource-budget.js";
import { InputPool } from "./input-pool.js";
import { editorPerf, allocatePerfSession } from "./perf-metrics.js";
import type { DecodeResidencyInfo } from "./decode-worker.js";
import type { DecodedFrame, MediaDecoder, MediaDecoderFactory, MediaDecoderFactoryInput } from "./media-decoder.js";
import { MediaDecoderFactoryImpl, probeDecodeCapability } from "./decode-capability.js";
import { VARISPEED_WORKLET_NAME, createVarispeedWorkletUrl } from "./varispeed-worklet.js";
import { planGainAutomation, resolveAudioFade, type AudioFadeSpan } from "./audio-fade.js";

/** 片段音频配置（编辑态：App 从时间线文档透传）。
 *  fadeInUs/fadeOutUs = 段内淡入/淡出时长（微秒，可选；0/缺省 = 不淡）——
 *  与导出侧 afade 同口径，语义见 audio-fade.ts。 */
export interface SegmentAudioConfig { enabled: boolean; gainDb: number; fadeInUs?: number; fadeOutUs?: number }

/** 片段音频装备：worklet = 变速不变调（OLA 时域拉伸，M3-2.2 验收"声音变了"
 *  对齐项——交互预览 HTMLMediaElement preservesPitch 默认 true，合成预览
 *  playbackRate 直调变调）；legacy = playbackRate 直调（AudioWorklet 不可用
 *  时的回退，变调）。两路径共用 startedAt/startOffset/speed 位置模型：
 *  position = startOffset + 墙钟增量×speed（worklet 输出域消耗速率相同）。 */
interface AudioRig {
  /** 解码完成的整段音频（worklet 路径 transfer 后置 null 释放主线程内存）。 */
  buffer: AudioBuffer | null;
  /** 懒创建的变速不变调节点（buffer 所有权随后迁入音频线程；失败回退 legacy）。 */
  worklet: AudioWorkletNode | null;
  /** 音频对 worklet 就绪（workletBuffer 或 !workletFailed&&buffer = 可出声）。 */
  workletBuffer: boolean;
  /** worklet 路径播放中（stopAudioSource 按此分支）。 */
  workletActive: boolean;
  /** worklet 节点创建/传输失败 → 本会话内该片段固定 legacy。 */
  workletFailed: boolean;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  startedAt: number;
  startOffset: number;
  speed: number;
  /** B15 流式模式：长素材走分块 PCM（rig 的 worklet 配置为 stream）。 */
  streaming: boolean;
  /** 流式已 configure 的世代（seek 递增；喂块按世代隔离）。 */
  streamGeneration: number;
  /** 流式已喂入 worklet 的块（start_sample 集合，避免重复 append）。 */
  streamFed: Set<number>;
  /** 已调度的淡变/增益标识（配置不变则不重排 GainNode 自动化，免得每 tick
   *  cancel+重排；见 scheduleAudioGain）。 */
  gateKey: string;
}

export interface PreviewSessionMetrics {
  task_ms_p50: number;
  task_ms_p95: number;
  dropped_frames: number;
  composed_frames: number;
  last_error: string | null;
  /** 解码往返（请求→VideoFrame 回传）耗时分布；m3p5 播放探针与指标行消费。 */
  decode_ms_p50: number;
  decode_ms_p95: number;
  /** P33 解码 RTT 分段（VITE_AIVS_DECODE_TIMING=1 时出数；否则 null）：
   *  feed = worker 喂包（Range 读+让步）；output = 解码器吐帧滞后；
   *  residual = 总 RTT − 两段（队列等待+双跳传输+主线程处理）。 */
  decode_seg: { feed_p50: number; feed_p95: number; output_p50: number; output_p95: number; queue_p50: number; queue_p95: number; residual_p50: number; residual_p95: number } | null;
  /** 当前在途解码请求数（全部输入合计，含影子槽）。 */
  decode_in_flight: number;
  /** 实际解码后端（各输入逗号分隔）：webcodecs=快路径；**ffmpeg=已降级到 Core
   *  IPC 软解**（~180ms/帧量级，必须立刻可见的异常态）。 */
  decode_backend: string;
  /** 解码器实际模式（各输入逗号分隔）：`prefer-hardware` = 硬解；`no-preference`
   *  = **软解**（3440x1440 上 ~190ms/帧、720p 上 ~50ms/帧，观感幻灯片）；
   *  空串 = 尚未握手。用于把「GPU/硬解不可用」这类环境问题当场暴露出来。 */
  decode_hardware: string;
  /** 纹理上传往返（postMessage+GL+ack）耗时 p95：worker 化后的负载口径。 */
  upload_ms_p95: number;
  /** GAP-RATIO-SWAP 诊断：IR 画布与后备缓冲尺寸（比例切换后应同步换算）。 */
  canvas_w: number;
  canvas_h: number;
  backing_w: number;
  backing_h: number;
  fit_scale: number;
}

interface RingSlot { srcN: number }

interface InputRig {
  kind: "video" | "image";
  /** H1/H3：MediaDecoder（webcodecs=DecodeWorker 包装；ffmpeg=decodeFrames 回调）。 */
  worker: MediaDecoder | null;
  /** 超时后降级重试：preferBackend=ffmpeg 的创建参数快照。 */
  decoderRetry?: { ticket: string; width: number; height: number; cacheCapBytes: number; refreshTicket: () => Promise<string>; decodeFrames?: MediaDecoderFactoryInput["decodeFrames"] };
  /** 连续超时类失败计数（成功解码清零；≥2 才降级 FFmpeg——见 maybeFallBackToFfmpeg）。 */
  timeoutStrikes?: number;
  /** 当前是否落在 FFmpeg 降级路径（用于按冷却期**回退到 WebCodecs 快路径**，
   *  避免一次瞬时抖把整个输入永久钉死在 ~180ms/帧的 IPC 软解上）。 */
  preferFfmpeg?: boolean;
  /** 进入 FFmpeg 路径的时刻（冷却期计时起点）。 */
  ffmpegSince?: number;
  /** 播放/seek 共用的环形簿记：槽位按 ringSeq 轮转，srcN=-1 表示空。 */
  ring: Array<RingSlot | null>;
  ringSeq: number;
  /** 顺序解码链游标：已向 worker 请求的最大 src_n（seek 上传后同步）。
   *  仅作诊断与「是否已冷启过」判定；请求选择不再依赖它（见 pump）。 */
  fed: number;
  /** 在途链请求：src_n → 入队时的 chainGeneration。**必须按 src_n 记账而不是
   *  只计数**：同一输入在同素材多片段场景下会被反复要求同一批展示需求，只有
   *  计数时无法判断「这一帧已经在途」，于是对同一 src_n 重复入队（L12 实锤：
   *  单帧最多被请求 37 次），把 worker 串行队列堵满、拖慢真正需要的帧。
   *  带世代是为了让**被 seek/重建作废**的旧任务收尾时不会误删同 src_n 的新
   *  在途标记（否则会重新引入一次重复请求）。 */
  inFlight: Map<number, number>;
  /** 转场共享输入第二帧槽位（影子槽，ack 后置值）。 */
  shadowUploaded: number;
  /** 影子槽在途请求 src_n。 */
  shadowInFlight: number | null;
  /** 同一输入的上传串行尾（ack 顺序保证槽位标记不被乱序覆盖）。 */
  uploadTail: Promise<void>;
  /** 剪辑跳转/解码器重建世代；使旧片段的在途任务失效。 */
  chainGeneration: number;
  decoderRecreate?: Promise<void>;
}

/** 主轨（段或转场左右）所需的 (输入, 源帧, 是否影子槽)。 */
function mainNeeds(frame: IrFrame): Array<[string, number, boolean]> {
  const main = frame.main;
  if (main.kind === "segment") return [[main.input_id, main.src_n, false]];
  if (main.kind !== "transition") return []; // black
  const shared = main.left.input_id === main.right.input_id;
  return [
    [main.left.input_id, main.left.src_n, shared],
    [main.right.input_id, main.right.src_n, false],
  ];
}

/** overlay 所需的 (输入, 源帧)。 */
function overlayNeeds(frame: IrFrame): Array<[string, number]> {
  return frame.overlays.map(overlay => [overlay.input_id, overlay.src_n] as [string, number]);
}

function shiftedRect(rect: IrContent, shift: { dx: number; dy: number }): IrContent {
  return { x: rect.x + shift.dx, y: rect.y + shift.dy, w: rect.w, h: rect.h };
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** A02：音频 rig 工厂（create 与 syncAudio 入段共用同一形状）。 */
function makeAudioRig(speed: number): AudioRig {
  return {
    buffer: null, worklet: null, workletBuffer: false, workletActive: false,
    workletFailed: false, source: null, gain: null, startedAt: 0, startOffset: 0, speed,
    streaming: false, streamGeneration: 0, streamFed: new Set<number>(), gateKey: "",
  };
}

/** B15 流式阈值：素材时长 ≥30 秒走分块 PCM（A02 整段模式保留为小素材
 *  回退——计划"30 秒且预计 PCM ≤32MiB"；48k 双声道 30 秒 ≈ 11MiB 在限内）。 */
const STREAMING_THRESHOLD_US = 30_000_000;

export function assertHardwareRenderer(adapter: string): { hardware: boolean; software: boolean } {
  const lowered = adapter.toLowerCase();
  const software = lowered.includes("swiftshader") || lowered.includes("llvmpipe")
    || lowered.includes("software") || lowered.includes("basic render");
  const hardware = !software && lowered.length > 0;
  return { hardware, software };
}

export class PreviewSession {
  private container: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private compositor: CompositorWorkerClient | null = null;
  private readonly rigs = new Map<string, InputRig>();
  private rafId = 0;
  private playing = false;
  /** B13-R：上次驻留取样墙钟（1Hz 限流）。 */
  private lastResidencySampleAt = 0;
  private anchorWall = 0;
  private anchorFrame = 0;
  private currentFrame = 0;
  private latestTarget = 0;
  private taskTimes: number[] = [];
  private decodeTimes: number[] = [];
  private uploadTimes: number[] = [];
  private decodeInFlight = 0;
  private dropped = 0;
  /** 会话累计丢帧（诊断/探针用；UI 指标行展示的是本次播放段口径）。 */
  private droppedLifetime = 0;
  private disposed = false;
  private seekEpoch = 0;
  private lastSeekWall = 0;
  private lastSeekMs = 0;
  private dragMode = false;
  /** 矩阵"拖动/缩放输入至下一次绘制提交"测量的活动起点（0=无进行中的
   *  seek 测量；被更新的 seek 覆盖起点，被作废的 seek 不落样）。 */
  private pendingDragSubmitT0 = 0;
  private lastAdvanceWall = 0;
  lastError: string | null = null;
  /** 诊断：seek 纪元作废的上传任务数（scrub 开销定位用）。 */
  skippedUploads = 0;
  /** 诊断：worker 上传分步采样（copyTo/tex 毫秒）。 */
  get uploadSplitDebug(): Array<{ copyToMs: number; texMs: number }> {
    return this.compositor?.uploadSplit ?? [];
  }
  /** 当前合成画面 PNG 截帧（项目封面取帧用）：worker 侧全画布 convertToBlob
   *  回读。返回 PNG 字节 + 内容区几何（IR 画布 contain 居中于后备缓冲的
   *  fit 矩形——调用方据此裁掉留边）。会话已 dispose/无合成器（v1 静态
   *  路径）返回 null。 */
  async snapshotPng(): Promise<{ buffer: ArrayBuffer; contentX: number; contentY: number; contentW: number; contentH: number } | null> {
    if (this.disposed || !this.compositor) return null;
    try {
      const buffer = await this.compositor.readback();
      // 几何防御：fitX/Y 可能是浮点甚至轻微负残差（contain 居中除不尽），
      // 调用方 drawImage 源矩形需非负整数；钳到后备缓冲边界内。
      const maxX = Math.max(0, this.backing.width - 2);
      const maxY = Math.max(0, this.backing.height - 2);
      const contentX = Math.max(0, Math.min(maxX, Math.round(this.fitX)));
      const contentY = Math.max(0, Math.min(maxY, Math.round(this.fitY)));
      return {
        buffer,
        contentX,
        contentY,
        contentW: Math.max(1, Math.min(this.backing.width - contentX, Math.round(this.ir.canvas.width * this.fitScale))),
        contentH: Math.max(1, Math.min(this.backing.height - contentY, Math.round(this.ir.canvas.height * this.fitScale))),
      };
    } catch {
      return null;
    }
  }
  onTimeUs: ((us: number) => void) | null = null;
  private tickets: Map<string, string> | null = null;
  private audioByClip: Map<string, SegmentAudioConfig> | null = null;
  private audioCtx: AudioContext | null = null;
  /** 变速不变调 worklet 模块是否已装入本 AudioContext（失败 → 全片段 legacy 回退）。 */
  private audioWorkletReady = false;
  private readonly audioRigs = new Map<string, AudioRig>();
  /** A02 音频源缓存（session 作用域；audioCtx 存在时创建）。 */
  private audioCache: AudioSourceCache | null = null;
  /** A02：音频绑定代（replaceIr 换表时 +1；缓存 key 组件之一）。 */
  private audioCacheBindingGeneration = 1;
  /** B15 分块 PCM 缓存 + 流加载器（长素材流式；Electron IPC 可用时创建）。 */
  private pcmChunkCache: PcmChunkCache | null = null;
  private streamLoader: AudioStreamLoader | null = null;
  /** B15 流式 underrun 观测计数（诊断/测试断言；不驱动时钟——计划硬约束）。 */
  private streamUnderruns = 0;
  /** 音频漂移硬校正阈值（秒）：WebAudio 自身不漂，只有时钟重锚才触达。 */
  private static readonly AUDIO_REANCHOR_S = 0.08;
  /** 播放中改增益/淡变的过渡时长：足够听不出台阶，又短到滑块拖动像"实时"。 */
  private static readonly AUDIO_GAIN_SETTLE_S = 0.02;
  /** A02 音频预热窗口（微秒）：播放态预取未来 2s 内入窗段；暂停态为 0。 */
  private static readonly AUDIO_WARMUP_US = 2_000_000;
  /** 自然播放到片尾时回调（UI 复位播放按钮；会话已内部 pause）。 */
  onEnded: (() => void) | null = null;
  /** P196：缓冲状态通道（**边沿触发**）——目标帧持续未就绪超过
   *  BUFFERING_NOTICE_MS 才回调一次 true，恢复时立即回调一次 false。
   *  判定挂在既有 compose/seek 路径上，不新增轮询；未订阅（null）的会话
   *  行为与引入前逐字节一致：全路径 `?.` 调用，本字段不参与任何分支。 */
  onBuffering: ((buffering: boolean) => void) | null = null;
  /** 缓冲提示延迟（用户裁决 2026-10-24）：一次快速 seek 的取窗 ~50ms、
   *  拖动/连点风暴里缺帧成串出现——立即提示会让指示条持续闪烁（比没有更差）。
   *  只有连续缺帧超过该时长才算"用户真的在等画面"。 */
  private static readonly BUFFERING_NOTICE_MS = 300;
  /** 延迟计时中的 timer（null = 未在计时）；恢复/销毁都必须清掉。 */
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  /** true = 已向订阅方报告过"缓冲中"（恢复时必须补一次 false，且不重复报）。 */
  private bufferingShown = false;
  /** 本次卡顿的判定帧（-1 = 无）。恢复只认**这一帧**的窗口是否到位：
   *  各路径送来的 target 会前后抖动（tick 目标、seek 索引、重锚回跳），拿
   *  "最近一次传入的 target" 判定会出现"3xx 窗内的旧帧就绪 → 误报恢复 →
   *  计时重来"，300ms 永远攒不满。锁定帧号后判定单调，语义也更直白：
   *  画面要动的下一帧到了，卡顿才算结束。 */
  private bufferingFrame = -1;

  /** 视口适配（等比 contain）：IR 画布 → 后备缓冲（会话侧权威，resize 下发 worker）。 */
  private fitX = 0;
  private fitY = 0;
  private fitScale = 1;
  private backing = { width: 2, height: 2 };
  /** 尺寸变化 rAF 合帧重呈现（连续拖拽窗口不逐帧重建）。 */
  private recomposeRaf = 0;

  /** 环形纹理池深度：LEAD 超前 + 当前合成 + 在途 1 + 提前入场 1，取 8 留余量。
   *  B13：档位/压力可收 5（LEAD 联动 = min(LEAD, ringDepth-3)——写深不覆盖
   *  未展示槽位；实例字段经 create(tier) 决策。 */
  private static readonly RING = 12;
  /** 预读超前帧数（吸收转场/换段冷启路径的解码尖峰）。 */
  private static readonly LEAD = 8;
  /** 每输入在途解码/上传路数（2 路流水：解码 A 时可上传 B）。 */
  private static readonly IN_FLIGHT = 3;
  /** 新输入入场提前量：首次入窗的输入提前 ~1.5s 冷启。 */
  private static readonly LEAD_ENTER = 45;
  /** 合成落后目标超过该帧数 → 重锚时钟。P33 收紧 12→4：起播爬坡期（rAF/GPU
   *  预热 + 预读链淘汰环槽）墙钟目标会领先合成 ~5-8 帧，旧阈值 12 下这段
   *  落后全部计丢帧（final-r1..r3 / fix-cap-r1..r3 六轮一致：起播 0.5s 丢
   *  5-6 帧后满速）。落后 4 帧即重锚=播放按吞吐放慢 0.1s 量级（不可感知），
   *  起播段零丢帧；稳态合成 33ms/帧贴满不触发。 */
  private static readonly LAG_REANCHOR = 4;
  /** 合成时向历史回溯的最大帧数（starving 后取最近就绪帧）。 */
  private static readonly BACKSCAN = 15;

  ir: Ir;
  /** C20a：帧数据访问层（v1 = 全量数组零拷贝适配；v2 窗口化接入点）。 */
  private frames: FrameSource;
  /** B13：本会话环深/预读（档位决策；压力收 5 时 LEAD 联动）。 */
  private ringDepth = PreviewSession.RING;
  /** B13：输入池（状态机 + 压力降级决策；播放 tick 驱动活跃集合）。 */
  private pool: InputPool | null = null;
  private poolTier: "conservative" | "balanced" | "high" | null = null;
  /** B13：输入最近活跃墙钟（idle 判定 = 不活跃超时）。 */
  private readonly inputLastActive = new Map<string, number>();
  private static readonly IDLE_AFTER_MS = 1_500;
  private poolWarned = false;
  /** B13-R 判别诊断开关：强制 copyTo 上传路径（perf 诊断构建注入）。 */
  private forceCopyTo = false;
  /** B13-R R3：驻留平台预警一次性标志。 */
  private residencyWarned = false;
  /** C20-T1：seek 预取去抖窗口——拖拽/连点风暴中持续重置，落定才发起。 */
  private static readonly PREFETCH_DEBOUNCE_MS = 200;
  /** C20-T1：v2 seek 落定预取窗数（档位驱动；0 = 关闭/非 v2 帧源）。 */
  private prefetchSpan = 0;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly perfId = allocatePerfSession();
  private perfRequest = 0;
  private readonly lifetime = new AbortController();
  private decoderFactory: MediaDecoderFactory | null = null;
  private constructor(ir: Ir, frames?: FrameSource) {
    editorPerf.record("session_open", 0, this.perfId);
    this.ir = ir;
    // C20 第二阶段：frames 可由调用方注入（v2 窗口帧源）；缺省 = v1 全量数组
    this.frames = frames ?? arrayFrameSource(ir);
    this.externalFrames = frames !== undefined;
  }

  /** DEFECT-4K60-SESSION-HANG：装配总期限。15s 握手只覆盖 worker init→ready
   *  单跳；create 链上的 IPC/fetch/addModule 等阶段此前无任何看门狗，4K 首次
   *  装配挂起 >4min 无提示（用户只能重载）。45s ≈ 最差实测 ready(≈16s)×3
   *  余量，远小于挂起形态；超时 → dispose（终结已拉起的 worker）+ 类型化抛错，
   *  由既有 UI error 路径兜底展示。测试经 CREATE_DEADLINE_MS 注入短期限。 */
  static CREATE_DEADLINE_MS = 45_000;

  static async create(container: HTMLElement, ir: Ir,
                      tickets: Map<string, string>,
                      audioByClip?: Map<string, SegmentAudioConfig>, signal?: AbortSignal,
                      sourceResolver?: PreviewSourceResolver | null,
                      resourceTier?: "conservative" | "balanced" | "high",
                      pcmProjectId?: string | null,
                      frames?: FrameSource,
                      forceCopyTo?: boolean): Promise<PreviewSession> {
    throwIfAborted(signal);
    const session = new PreviewSession(ir, frames);
    // B13-R 判别诊断开关（perf 诊断构建经 runtime 注入；undefined 时行为不变）
    if (forceCopyTo) session.forceCopyTo = true;
    // B13：档位 → 环深决策（保守档多输入收 5；LEAD 联动防写深覆盖）
    if (resourceTier) {
      session.ringDepth = ringDepthFor(resourceTier, ir.inputs.filter(input => input.asset_kind === "video").length);
      // C20-T1：seek 落定预取窗数（仅 v2 注入帧源时生效，见 scheduleWindowPrefetch）
      session.prefetchSpan = windowSourceBudget(resourceTier).prefetchWindows;
    }
    const abort = () => session.dispose();
    signal?.addEventListener("abort", abort, { once: true });
    // 装配看门狗：挂起阶段无法取消，用 race 让 create 在期限内落定；timer
    // 在正常完成/异常路径的 finally 统一清除。挂起的原 promise 落定后由
    // disposed 检查短路（各阶段 create 后均有）。
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`合成预览装配超时（${PreviewSession.CREATE_DEADLINE_MS / 1000}s）——请重试或刷新；若持续出现请检查素材与 GPU 驱动`)),
        PreviewSession.CREATE_DEADLINE_MS,
      );
    });
    try {
    return await Promise.race([
      PreviewSession.assemble(container, ir, tickets, session, audioByClip, signal, sourceResolver, resourceTier, pcmProjectId),
      deadline,
    ]);
    } catch (error) { session.dispose(); throw error; }
    finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private static async assemble(container: HTMLElement, ir: Ir,
                                tickets: Map<string, string>,
                                session: PreviewSession,
                                audioByClip: Map<string, SegmentAudioConfig> | undefined,
                                signal: AbortSignal | undefined,
                                sourceResolver: PreviewSourceResolver | null | undefined,
                                resourceTier: "conservative" | "balanced" | "high" | undefined,
                                pcmProjectId: string | null | undefined): Promise<PreviewSession> {
    try {
    session.container = container;
    session.tickets = tickets;
    session.audioByClip = audioByClip ?? null;
    // B11：预览源解析（视频输入优先代理票据；失败/未 ready 回退原源票据。
    // 源描述与 IR geometry 分离——代理只替换解码输入，逻辑坐标不变）。
    if (sourceResolver) {
      for (const input of ir.inputs) {
        if (input.asset_kind !== "video") continue;
        const original = tickets.get(input.asset_id);
        if (!original) continue;
        const resolved = await sourceResolver.resolve(input.asset_id, original);
        if (session.disposed || signal?.aborted) {
          throw new DOMException("Session disposed", "AbortError");
        }
        if (resolved && resolved.isProxy) {
          tickets = new Map(tickets);
          tickets.set(input.asset_id, resolved.url);
        }
      }
    }
    if (session.disposed || signal?.aborted) throw new DOMException("Session disposed", "AbortError");
    const canvas = document.createElement("canvas");
    canvas.className = "synthetic-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.textContent = "";
    container.appendChild(canvas);
    session.canvasEl = canvas;
    const { CompositorWorkerClient } = await import("./compositor-worker.js");
    throwIfAborted(signal);
    const client = await CompositorWorkerClient.create(canvas, {
      inputs: ir.inputs.filter(input => input.asset_kind !== "audio").map(input => ({
        inputId: input.input_id,
        sourceWidth: input.geometry.width || 1920,
        width: input.geometry.width || 16,
        height: input.geometry.height || 9,
      })),
      ringDepth: session.ringDepth,
      canvasWidth: ir.canvas.width,
      canvasHeight: ir.canvas.height,
      captionStyles: ir.caption_styles,
      captionOverrideStyles: ir.caption_override_styles ?? {},
      forceCopyTo: session.forceCopyTo,
    }, signal);
    if (session.disposed || signal?.aborted) { client.terminate(); throwIfAborted(signal); throw new Error("session disposed"); }
    session.compositor = client;
    client.perfSession = session.perfId;
    client.onContextLost = () => {
      for (const resolve of session.contextLostResolvers.splice(0)) resolve();
    };
    const adapter = client.gpuInfo.adapter;
    if (assertHardwareRenderer(adapter).software) {
      throw new Error(`software rendering detected: ${adapter}`);
    }
    for (const input of ir.inputs) {
      const ticket = tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      if (input.asset_kind === "audio") continue; // 纯音频输入：无视觉装配，音频走 WebAudio
      const rig: InputRig = {
        kind: input.asset_kind === "image" ? "image" : "video",
        worker: null,
        ring: Array.from({ length: session.ringDepth }, () => null),
        ringSeq: 0,
        fed: -1,
        inFlight: new Map<number, number>(),
        shadowUploaded: -1,
        shadowInFlight: null,
        uploadTail: Promise.resolve(),
        chainGeneration: 0,
      };
      if (rig.kind === "image") {
        // 静图：解码为 ImageBitmap → transfer 到 worker 一次上传，src_n 恒 0 全程复用
        const response = await fetch(ticket, { signal: session.lifetime.signal });
        if (!response.ok) throw new Error("image load failed");
        const bitmap = await createImageBitmap(await response.blob());
        if (session.disposed) { bitmap.close(); throw new DOMException("Session disposed", "AbortError"); }
        client.uploadImage(input.input_id, bitmap);
      } else {
        // B12：媒体票据续票回调（5min TTL 到期时 Range 源受控刷新——
        // refreshAsset 重发同资产新票据；失败由会话错误路径处理）。
        const refreshTicket = (assetId: string) => async (): Promise<string> => {
          const refreshed = await window.desktop.refreshAsset(assetId);
          if (!refreshed?.media_url) throw new Error("ticket refresh failed");
          return refreshed.media_url;
        };
        // B13：Range 字节缓存预算随档位（64/128/256MiB）
        const rangeCacheBytes = (resourceTier ? BUDGET_TABLES[resourceTier].rangeCacheMiB : 128) * 1024 * 1024;
        // H1/H3：MediaDecoderFactory 选 A/B；codec=auto（demux 发现）。
        // 后端 B 的 decodeFrames 经 Main→Core（路径不进 Renderer）。
        const desktopApi = typeof window !== "undefined"
          ? (window as unknown as { desktop?: {
              decodeFrames?: (input: { project_id: string; asset_id: string; frame_numbers: number[]; fps: number; ticket_ref: string }) => Promise<ArrayBuffer>;
              decodeCapability?: () => Promise<{ decoders: Record<string, boolean>; probed_at: string; ffmpeg_fingerprint: string }>;
              assetMediaTicket?: (assetId: string) => Promise<{ media_url: string }>;
            } }).desktop
          : undefined;
        // P30：ffmpeg_supported 数据源 = Core `ffmpeg -decoders`（FFmpeg build
        // 指纹失效重探）。取不到时保持空表——禁止无探测就假定 FFmpeg 可解。
        const ffmpegDecoders = await desktopApi?.decodeCapability?.().then(
          value => value.decoders ?? {},
          () => ({}) as Record<string, boolean>,
        ) ?? ({} as Record<string, boolean>);
        const factory = session.decoderFactory ?? new MediaDecoderFactoryImpl(await probeDecodeCapability({
          avc: ffmpegDecoders.avc === true,
          hevc: ffmpegDecoders.hevc === true,
          av1: ffmpegDecoders.av1 === true,
        }));
        session.decoderFactory = factory;
        const decodeFrames = pcmProjectId && desktopApi?.decodeFrames && desktopApi?.assetMediaTicket
          ? async (req: { frameNumbers: number[]; fps: number }) => {
              // P30：每窗现取 restricted-media 票据随请求出示（§2.5 ticket_ref；
              // 已注册路径纯内存签发，零网络）——长会话不受票据 TTL 影响。
              const fresh = await desktopApi.assetMediaTicket!(input.asset_id);
              return desktopApi.decodeFrames!({
                project_id: pcmProjectId,
                asset_id: input.asset_id,
                frame_numbers: req.frameNumbers,
                fps: req.fps,
                ticket_ref: fresh.media_url,
              });
            }
          : undefined;
        const decoder = await factory.create({
          mediaUrl: ticket,
          codec: "auto",
          width: input.geometry.width,
          height: input.geometry.height,
          cacheCapBytes: rangeCacheBytes,
          refreshTicket: refreshTicket(input.asset_id),
          decodeFrames,
        }, signal);
        if (session.disposed || signal?.aborted) { decoder.dispose(); throw new DOMException("Session disposed", "AbortError"); }
        rig.worker = decoder;
        rig.decoderRetry = {
          ticket,
          width: input.geometry.width,
          height: input.geometry.height,
          cacheCapBytes: rangeCacheBytes,
          refreshTicket: refreshTicket(input.asset_id),
          decodeFrames,
        };
      }
      session.rigs.set(input.input_id, rig);
    }
    // 片段音频：AudioContext + A02 音频源缓存（同素材 single-flight、并发≤2）。
    // 旧 eager 全段预热已移除：运行中由 syncAudio 有限预热（当前段 + 未来 2s
    // 入窗段），暂停态仅当前段（A02 止血语义，整段解码仍会发生——见已知限制）。
    if (audioByClip && audioByClip.size && typeof window !== "undefined" && "AudioContext" in window) {
      session.audioCtx = new AudioContext();
      // 变速不变调 worklet 装载（Blob URL；失败静默回退 playbackRate 直调路径）。
      try {
        await session.audioCtx.audioWorklet.addModule(createVarispeedWorkletUrl());
        session.audioWorkletReady = true;
      } catch { session.audioWorkletReady = false; }
      throwIfAborted(signal);
      if (session.disposed) throw new DOMException("Session disposed", "AbortError");
      session.audioCache = new AudioSourceCache(
        (data, cacheSignal) => session.audioCtx!.decodeAudioData(data).finally(() => { void cacheSignal; }),
        async (ticket, cacheSignal) => {
          const response = await fetch(ticket, { signal: cacheSignal });
          if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`);
          return await response.arrayBuffer();
        },
        session.lifetime.signal,
        1,
        // B13/B14：PCM 缓存字节预算随档位（64/128/256MiB；LRU 逐出无活跃
        // 用户的 ready 条目，超限如实暴露 overBudget——不静默漏音）
        (resourceTier ? BUDGET_TABLES[resourceTier].pcmCacheMiB : 128) * 1024 * 1024,
      );
      // B15：分块 PCM 流式（长素材 ≥30s 走块；Electron IPC 通道可用且调用方
      // 提供 project 时创建。非 Electron/测试环境回退 A02 整段模式；块按契约
      // 固定 48kHz 生成，AudioContext 采样率不匹配时时间域错位——不建流式，
      // 回退 A02（方案 B15"初始化时拒绝该路径"条款））。
      const desktop = typeof window !== "undefined" ? (window as { desktop?: { ensurePcmChunk?: unknown; pcmChunkMediaUrl?: unknown } }).desktop : undefined;
      if (pcmProjectId && desktop && typeof desktop.ensurePcmChunk === "function" && typeof desktop.pcmChunkMediaUrl === "function"
          && session.audioCtx.sampleRate === PCM_CHUNK_SAMPLE_RATE) {
        const api = desktop as { ensurePcmChunk: (input: { project_id: string; asset_id: string; start_sample: number }) => Promise<import("@aivideo/contracts").PcmChunkDescription>; pcmChunkMediaUrl: (input: { project_id: string; asset_id: string; start_sample: number }) => Promise<{ media_url: string; cache_key: string; size_bytes: number }> };
        session.pcmChunkCache = new PcmChunkCache({
          ensurePcmChunk: api.ensurePcmChunk,
          pcmChunkMediaUrl: api.pcmChunkMediaUrl,
        }, pcmProjectId, (resourceTier ? BUDGET_TABLES[resourceTier].pcmCacheMiB : 128) * 1024 * 1024);
        session.streamLoader = new AudioStreamLoader(session.pcmChunkCache, pcmProjectId, session.audioCtx.sampleRate);
      }
      for (const segment of ir.segments) {
        if (!audioByClip.get(segment.clip_id)?.enabled) continue;
        session.audioRigs.set(segment.clip_id, makeAudioRig(Math.max(0.25, Math.min(4, segment.speed_milli / 1000))));
      }
    }
    throwIfAborted(signal);
    // B13：输入池注册（视频输入；后续 tick 驱动活跃/idle/压力降级）
    session.poolTier = resourceTier ?? null;
    session.poolRegister(ir);
    session.rebuildPipOverlayIndex(); // A04：手势路径免全帧扫描
    // B13-R R3：解码驻留平台预警（经验律预测，超档位预算一次性提示；
    // 见 resource-budget.predictResidencyBytes——不阻断，仅告知量级预期）。
    if (resourceTier) {
      const predictedBytes = predictResidencyBytes(
        session.frames.frameCount,
        session.ir.canvas.width,
        session.ir.canvas.height,
      );
      const budgetBytes = BUDGET_TABLES[resourceTier].textureBytesMiB * 1024 * 1024 * 8;
      if (predictedBytes > budgetBytes && !session.residencyWarned) {
        session.residencyWarned = true;
        session.lastError = `长素材解码驻留预警：预计常驻约 ${Math.round(predictedBytes / (1024 * 1024 * 1024) * 10) / 10} GiB（${session.frames.frameCount} 帧，平台化不持续增长）`;
      }
    }
    return session;
    } finally { /* abort 监听由 create wrapper 统一移除 */ }
  }

  get canvas(): HTMLCanvasElement | null {
    return this.canvasEl;
  }

  private readonly contextLostResolvers: Array<() => void> = [];

  /** 字幕字体（transfer 到 worker 的 FontFaceSet；worker 侧字体就绪后强制重绘字幕层）。
   *  多字体：fonts 数组逐个注册（family 名 = 真实族名，与 ASS \fn / Canvas 取名
   *  一致）；旧单 buffer 入参保持兼容（视为单一默认字体 AppCaptionCJK）。 */
  async loadCaptionFont(buffer: ArrayBuffer): Promise<void>;
  async loadCaptionFont(fonts: Array<{ family: string; buffer: ArrayBuffer }>): Promise<void>;
  async loadCaptionFont(input: ArrayBuffer | Array<{ family: string; buffer: ArrayBuffer }>): Promise<void> {
    if (Array.isArray(input)) {
      for (const font of input) {
        this.compositor?.setFont(font.buffer, font.family);
      }
      return;
    }
    this.compositor?.setFont(input, "AppCaptionCJK");
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 编辑态音频配置更新（静音/增益/淡变实时生效）。
   *  **不重建音源**：只重排 GainNode 自动化（setValueAtTime + linearRamp）——
   *  进行中的音源继续播，播放中的修改从当前音量 20ms 滑到新包络，不跳变；
   *  淡变只对**尚未播到的部分**生效（已播过的位置不再回放 ramp）。 */
  setAudioByClip(audioByClip: Map<string, SegmentAudioConfig> | null): void {
    this.audioByClip = audioByClip;
    if (!this.audioCtx) return;
    const segmentOf = new Map(this.ir.segments.map(segment => [segment.clip_id, segment] as const));
    for (const [clipId, rig] of this.audioRigs) {
      const cfg = audioByClip?.get(clipId);
      const segment = segmentOf.get(clipId);
      if (rig.gain && cfg && segment) this.scheduleAudioGain(rig, cfg, segment, true);
      if ((rig.source || rig.workletActive) && (!cfg || !cfg.enabled)) this.stopAudioSource(rig);
    }
  }

  /** 当前帧画中画几何（IR 画布坐标）——合成画布手势层消费。 */
  pipBoxes(): Array<{ clipId: string; x: number; y: number; w: number; h: number }> {
    const frame = this.frames.getFrame(Math.min(this.currentFrame, this.frames.frameCount - 1));
    if (!frame) return [];
    return frame.overlays.map(overlay => ({ clipId: overlay.clip_id, ...overlay.box }));
  }

  /** IR 画布坐标 → 合成画布 CSS 坐标的映射（contain + 后备缓冲换算）。 */
  pipView(): { scale: number; offsetX: number; offsetY: number; width: number; height: number } {
    const el = this.canvasEl;
    const cw = el?.clientWidth || this.backing.width;
    const ch = el?.clientHeight || this.backing.height;
    const kx = cw / this.backing.width;
    const ky = ch / this.backing.height;
    return { scale: this.fitScale * kx, offsetX: this.fitX * kx, offsetY: this.fitY * ky, width: cw, height: ch };
  }

  /** 手势期间冻结合成时钟（画中画拖拽时播放头前进会越出片段区间）。 */
  freezeForGesture(): void {
    this.pause();
  }

  /** revision 变更的就地 IR 换表：输入集合未变（transform/关键帧/时间编辑）时
   *  保留 worker 与 GL 纹理，仅替换帧表/段表并重呈现（零黑屏，~50ms）。
   *  输入集合变化（加删素材）返回 false，调用方走整会话重建。
   *  A02 音频 rigs 同步：删除移除的 clip；输入/源窗口变化的 clip 重置播放
   *  位置；未变 clip 保留（worklet 已迁移的 buffer 不回退）。 */
  replaceIr(nextIr: Ir, nextFrames?: FrameSource): boolean {
    const sig = (ir: Ir) => JSON.stringify(ir.inputs.map(item => [item.input_id, item.asset_id, item.asset_kind, item.geometry]));
    if (sig(this.ir) !== sig(nextIr)) return false;
    const segOf = (ir: Ir) => new Map(ir.segments.map(segment => [segment.clip_id, segment] as const));
    const oldSegs = segOf(this.ir);
    const oldCanvasW = this.ir.canvas.width;
    const oldCanvasH = this.ir.canvas.height;
    this.ir = nextIr;
    // C20a：换表同步换帧源（引用一致性保持）；v2 注入帧源由调用方重建后传入
    this.frames = nextFrames ?? arrayFrameSource(nextIr);
    this.externalFrames = nextFrames !== undefined;
    // B13：换表输入集合不变（sig 已校验）——池注册保持；时间窗重置活跃
    this.inputLastActive.forEach((_at, inputId) => this.inputLastActive.set(inputId, performance.now()));
    this.audioCacheBindingGeneration += 1;
    for (const [clipId, rig] of [...this.audioRigs]) {
      const next = nextIr.segments.find(segment => segment.clip_id === clipId);
      if (!next) { // clip 已删除：停声、断开、清理 rig
        this.stopAudioSource(rig);
        try { rig.worklet?.disconnect(); } catch { /* 已断开 */ }
        this.audioRigs.delete(clipId);
        continue;
      }
      const prev = oldSegs.get(clipId);
      const windowChanged = !prev
        || prev.input_id !== next.input_id
        || prev.source_start_us !== next.source_start_us
        || prev.source_end_us !== next.source_end_us
        || prev.speed_milli !== next.speed_milli;
      if (windowChanged) {
        // 源窗口/输入/变速变化：重置播放位置（buffer 保留可复用，位置模型重建）
        this.stopAudioSource(rig);
        rig.startedAt = 0;
        rig.startOffset = 0;
        rig.speed = Math.max(0.25, Math.min(4, next.speed_milli / 1000));
        // buffer 可能来自旧窗口：worklet 路径需重定位（play 消息按新窗口下发），
        // legacy 路径 buffer 引用不变（解码内容与窗口无关，按 expected 起播）。
      }
    }
    this.resetChains();
    this.rebuildPipOverlayIndex(); // A04：换表后原子重建索引（不保留旧帧引用）
    // GAP-RATIO-SWAP：换比例（如 1:1 → 16:9）时 canvas 尺寸随 IR 变化，而
    // backing/fit 仍是旧画布的适配系数（ResizeObserver 只看容器 CSS 尺寸，
    // 比例切换时容器尺寸不变 → 无人重算）→ 画面按旧系数拉伸。canvas 变更
    // 时按同一容器尺寸重跑一次 resize 语义（含 worker resize 下发）。
    if (oldCanvasW !== nextIr.canvas.width || oldCanvasH !== nextIr.canvas.height) {
      const el = this.canvasEl;
      const cssW = el?.clientWidth || this.backing.width;
      const cssH = el?.clientHeight || this.backing.height;
      this.resize(cssW, cssH);
    }
    this.recomposeSoon();
    return true;
  }

  /** A04 clipId→overlay 引用表（create/replaceIr 后重建；手势路径免全帧扫描）。
   *  一次遍历 O(总 overlay)；手势期每 move 只遍历该 clip 的 overlay 列表。
   *  v2 窗口帧源下"总 overlay"以已就绪帧为准（全帧表不在 Renderer）——
   *  ensureRange 装配新窗口后由 markFramesAvailable 增量并入。 */
  private pipOverlayIndex: Map<string, IrOverlay[]> = new Map();
  /** pip 索引已覆盖的最大帧号（v2 增量构建游标；v1 全量后与 frameCount-1 相等）。 */
  private pipIndexCoveredUpTo = -1;
  /** v2 外部帧源标记（replaceIr 时决定帧源重建责任方）。 */
  private externalFrames = false;

  private rebuildPipOverlayIndex(): void {
    const index = new Map<string, IrOverlay[]>();
    for (let n = 0; n < this.frames.frameCount; n++) {
      const frame = this.frames.getFrame(n);
      if (!frame) continue;
      for (const overlay of frame.overlays) {
        let list = index.get(overlay.clip_id);
        if (!list) { list = []; index.set(overlay.clip_id, list); }
        list.push(overlay);
      }
    }
    this.pipOverlayIndex = index;
    // v2 窗口帧源：只覆盖当前已就绪帧（游标 = 最后一个连续可取帧）；
    // v1 全量：覆盖整表。两种模式共用"游标后增量并入"语义。
    let covered = -1;
    while (covered + 1 < this.frames.frameCount && this.frames.getFrame(covered + 1)) covered += 1;
    this.pipIndexCoveredUpTo = covered;
  }

  /** C20 v2：窗口装配完成后增量并入 pip 索引（只扫新就绪帧区间，免全帧重扫）。 */
  private extendPipOverlayIndex(fromFrame: number, toFrameExclusive: number): void {
    if (!this.externalFrames && toFrameExclusive - 1 <= this.pipIndexCoveredUpTo) return;
    for (let n = Math.max(this.pipIndexCoveredUpTo + 1, fromFrame); n < toFrameExclusive; n++) {
      const frame = this.frames.getFrame(n);
      if (!frame) continue;
      for (const overlay of frame.overlays) {
        let list = this.pipOverlayIndex.get(overlay.clip_id);
        if (!list) { list = []; this.pipOverlayIndex.set(overlay.clip_id, list); }
        list.push(overlay);
      }
      this.pipIndexCoveredUpTo = Math.max(this.pipIndexCoveredUpTo, n);
    }
  }

  /** 画中画中心点就地补丁：直改 IR 帧几何并重呈现（免会话重建，拖拽实时跟随）。
   *  静态 transform 作用于片段全区间——范围内所有含该 overlay 的帧一并更新。 */
  setPipCenter(clipId: string, x: number, y: number): void {
    const overlay = this.pipOverlayIndex.get(clipId)?.[0];
    if (!overlay) return;
    const w = this.ir.canvas.width;
    const h = this.ir.canvas.height;
    this.setPipBox(clipId, x * w, y * h, overlay.box.w, overlay.box.h);
  }

  /** 画中画几何就地补丁（缩放手势）：中心点 + 尺寸均为画布像素，作用于片段
   *  全区间帧。move 手势可复用（仅改中心、尺寸取当前值）。 */
  setPipBox(clipId: string, cx: number, cy: number, w: number, h: number): void {
    for (const overlay of this.pipOverlayIndex.get(clipId) ?? []) {
      overlay.box = { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    this.recomposeSoon();
  }

  /** 画中画旋转就地补丁（旋转手势）：度数作用于片段全区间帧。 */
  setPipRotation(clipId: string, deg: number): void {
    for (const overlay of this.pipOverlayIndex.get(clipId) ?? []) {
      overlay.rotation_deg = deg;
    }
    this.recomposeSoon();
  }

  /** A04 手势几何合并补丁：一次调用同时更新中心/尺寸/旋转（move+rotate 手势
   *  不再分别走 setPipBox + setPipRotation 两次遍历与两次重呈现调度）。 */
  setPipGeometry(clipId: string, geometry: { cx: number; cy: number; w: number; h: number; rotation?: number }): void {
    const overlays = this.pipOverlayIndex.get(clipId);
    if (!overlays?.length) return;
    const { cx, cy, w, h, rotation } = geometry;
    for (const overlay of overlays) {
      overlay.box = { x: cx - w / 2, y: cy - h / 2, w, h };
      if (rotation !== undefined) overlay.rotation_deg = rotation;
    }
    this.recomposeSoon();
  }

  /** 诊断快照：各输入解码链游标/在途/环形内容 + 最近解码回执（m3p5 探针）。 */
  chainState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const [inputId, rig] of this.rigs) {
      state[inputId] = {
        fed: rig.fed,
        inFlight: [...rig.inFlight.keys()],
        ring: rig.ring.filter(slot => slot).map(slot => slot!.srcN),
        shadow: rig.shadowUploaded,
        last_decode: rig.worker?.lastFrameInfo ?? null,
      };
    }
    return state;
  }

  // ---- B13 输入池驱动 ----

  /** 会话输入注册（create/replaceIr 调用；池 + 世代记录）。 */
  private poolRegister(ir: Ir): void {
    if (!this.pool) this.pool = new InputPool(this.poolTier ?? "balanced");
    for (const input of ir.inputs) {
      if (input.asset_kind !== "video") continue; // 静图/纯音频不占解码保温
      this.pool.register({
        inputId: input.input_id,
        width: input.geometry.width || 1920,
        height: input.geometry.height || 1080,
        shadow: false, // 影子槽由转场共享输入按需启用（记账粗粒度可接受）
      });
      this.inputLastActive.set(input.input_id, performance.now());
    }
  }

  /** 播放/seek tick 驱动：活跃集合标记 + idle 识别 + 压力降级执行。
   *
   * - active = 当前帧 + LEAD 窗口的输入（activeInputIds 已按帧算好，
   *   此处取 current/next 两帧并集 + pump 目标帧）。
   * - idle = 1.5s 不活跃且非 pin。
   * - pressure 降级：evict-idle → releaseInput（worker 纹理删除）；
   *   shrink-ring（环深 8→5）→ 会话侧 ringDepth 收缩（下一会话生效，
   *   换档语义与计划"pause/seek 边界原子切换"一致——运行中环池不撕裂）；
   *   over-budget → 一次性提示（lastError），不静默删层。
   */
  private poolDrive(frame: IrFrame): void {
    const pool = this.pool;
    if (!pool) return;
    const now = performance.now();
    const active = new Set<string>(activeInputIds(frame));
    const nextFrame = this.frames.getFrame(frame.n + 1);
    if (nextFrame) for (const id of activeInputIds(nextFrame)) active.add(id);
    for (const inputId of active) {
      this.inputLastActive.set(inputId, now);
      if (pool.stateOf(inputId) !== "active") pool.mark(inputId, "active");
    }
    for (const inputId of pool.activeIds()) {
      if (!active.has(inputId)) {
        pool.mark(inputId, this.inputLastActive.has(inputId)
          && now - (this.inputLastActive.get(inputId) ?? 0) > PreviewSession.IDLE_AFTER_MS
          ? "idle" : "warm");
      }
    }
    const decision = pool.pressure([...active]);
    if (decision.kind === "evict-idle") {
      for (const inputId of decision.inputIds) {
        const entry = pool.entryOf(inputId);
        if (!entry) continue;
        pool.mark(inputId, "evicting");
        const rig = this.rigs.get(inputId);
        if (rig?.worker) {
          const old = rig.worker;
          rig.worker = null;
          void old.dispose();
          if (rig.decoderRetry && this.decoderFactory && !rig.decoderRecreate) {
            rig.decoderRecreate = this.recreateDecoder(rig);
          }
        }
        void this.compositor?.releaseInput(inputId, entry.generation)
          .then(() => pool.release(inputId, entry.generation))
          .catch(() => pool.mark(inputId, "failed"));
      }
    } else if (decision.kind === "shrink-ring") {
      // 环深收缩下一会话生效（换源原子性；本会话 LEAD 联动立即生效）
      this.ringDepth = decision.ringDepth;
    } else if (decision.kind === "over-budget" && !this.poolWarned) {
      this.poolWarned = true;
      this.lastError = `活跃输入纹理预算超限（${decision.activeIds.length} 个输入）——已按保守策略运行`;
    }
  }

  /** dispose/换表：释放全部池输入（worker 纹理删除 + 簿记清零）。 */
  private poolDispose(): void {
    const pool = this.pool;
    if (!pool) return;
    // 释放全部注册输入（idle/active/warm 一视同仁——会话结束）
    for (const inputId of [...this.inputLastActive.keys()]) {
      const entry = pool.entryOf(inputId);
      if (!entry) continue;
      void this.compositor?.releaseInput(inputId, entry.generation).catch(() => undefined);
    }
    this.pool = null;
    this.inputLastActive.clear();
  }

  /** 用户驱动的向后跳转（回卷重播/回退 seek）后重置解码链：游标回 -1，
   *  pump 冷启重建（worker 冷启路径实证干净）。
   *
   *  **不清环形槽**：槽内已 ack 的纹理在合成器侧仍然有效，seekToFrame 会先
   *  查 `ringSlotIndex` 复用（「±1 步进零解码路径保持不变」）；清空会让每次
   *  seek 都重解一遍已就绪帧。chainGeneration 只作废**在途**任务，不影响已
   *  落定槽位。 */
  private resetChains(): void {
    for (const [, rig] of this.rigs) {
      rig.chainGeneration += 1;
      rig.fed = -1;
      rig.inFlight.clear();
      rig.shadowInFlight = null;
    }
  }

  /** 尺寸变化（CSS px）：后备缓冲随盒子（≤2048 上限）、IR 画布 contain 居中；
   *  fit 在会话侧计算（pipView 同源）并下发 worker 应用；rAF 合帧重呈现。 */
  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    const capped = Math.min(backingWidth / this.ir.canvas.width, backingHeight / this.ir.canvas.height,
      2048 / Math.max(this.ir.canvas.width, this.ir.canvas.height));
    const width = Math.max(2, Math.round(this.ir.canvas.width * capped));
    const height = Math.max(2, Math.round(this.ir.canvas.height * capped));
    if (this.backing.width === width && this.backing.height === height) {
      this.recomposeSoon();
      return;
    }
    this.backing = { width, height };
    this.fitScale = capped;
    this.fitX = (width - this.ir.canvas.width * capped) / 2;
    this.fitY = (height - this.ir.canvas.height * capped) / 2;
    this.compositor?.resize(width, height, this.fitX, this.fitY, this.fitScale);
    this.recomposeSoon();
  }

  private recomposeSoon(): void {
    if (this.recomposeRaf || this.disposed) return;
    this.recomposeRaf = requestAnimationFrame(() => {
      this.recomposeRaf = 0;
      const frame = this.frames.getFrame(Math.min(this.currentFrame, this.frames.frameCount - 1));
      if (frame && this.frameReady(frame)) this.compose(frame);
      // P196：窗口装配完成会走 recomposeSoon——这里给出"恢复"结论。判的是
      // **目标帧**而不是当前停留帧：卡顿期间画面正停在上一帧（它是"就绪"的），
      // 拿它判定会在每个 tick 报一次恢复，300ms 计时永远攒不起来。
      this.observeBuffering(this.latestTarget);
    });
  }

  /** 环形槽位上传（经每输入串行尾；worker 上传 ack 后才标记 srcN 就绪）。
   *  过期作废：任务排队期间到来新 seek（seekEpoch 变化）→ 预取目标已失效，
   *  直接作废（解码前后双重检查；作废帧 close 释放）——否则 scrub 时新 seek
   *  的上传会排在整条过期预取队尾（worker 化后每任务含双跳 RTT，实测 seek
   *  p95 翻倍的根因）。 */
  /** 解码超时/看门狗 → 降级 ffmpeg 后端重试一次（WebCodecs 对长 GOP HEVC 可能过慢）。
   *  2026-09-28 收紧：单次超时不再永久降级——降级后整输入落入 FFmpeg IPC 路径
   *  （每窗口 spawn ffmpeg，软解吞吐有限），一次瞬时抖动（主线程 GC、网络读慢、
   *  看门狗误报陈旧请求）就把会话钉死在慢路径，恰是"丢帧不多但持续卡"的形态。
   *  现改为**连续 2 次**超时类失败才降级（计数在成功后清零）；错误类别不变
   *  （timeout/watchdog/key frame is required）。
   *
   *  2026-09-30（真机 dev 运行复现「越修越卡」）：该闸门仍会误伤——worker 侧的
   *  单帧停摆兜底与尾帧不可达都会以含 `watchdog` 的文案报错，连续两次就把整个
   *  输入钉在 FFmpeg IPC 路径上（实测 dev 运行 `解码 p95 180.5ms`、丢帧 95，
   *  而同一素材在同一机器的生产构建里是 5~7ms / 0 帧）。两处收紧：
   *  1. **只认「后端真的不会解」类**：`key frame is required` 与显式 timeout；
   *     worker 已自恢复的单帧停摆（消息带 `FRAME_UNREACHABLE` 前缀）不再计数——
   *     它已被「重置解码器 + 关键帧重锚 + 原地重试」处理过，不代表后端不可用。
   *  2. **降级可回退**：降级后经过 `FFMPEG_RETRY_COOLDOWN_MS` 允许一次回到
   *     WebCodecs 的尝试（成功则彻底恢复快路径），避免一次瞬时抖动永久钉死。 */
  private static readonly FFMPEG_RETRY_COOLDOWN_MS = 45_000;

  private async maybeFallBackToFfmpeg(rig: InputRig, error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    // 已自恢复的单帧停摆：不计入降级判据（见上）。
    if (/FRAME_UNREACHABLE/.test(message)) return false;
    if (!/timeout|watchdog|key frame is required/i.test(message)) return false;
    // 已在 FFmpeg 路径：超过冷却期允许一次回到 WebCodecs（快路径）的尝试。
    if (rig.preferFfmpeg) {
      if (performance.now() - (rig.ffmpegSince ?? 0) < PreviewSession.FFMPEG_RETRY_COOLDOWN_MS) return false;
      const retry = rig.decoderRetry;
      const factory = this.decoderFactory;
      if (!retry || !factory) return false;
      try {
        rig.worker?.dispose();
        rig.worker = await factory.create({
          mediaUrl: retry.ticket, codec: "auto", width: retry.width, height: retry.height,
          cacheCapBytes: retry.cacheCapBytes, refreshTicket: retry.refreshTicket,
          decodeFrames: retry.decodeFrames, preferBackend: "webcodecs",
        });
        rig.preferFfmpeg = false;
        rig.timeoutStrikes = 0;
        this.lastError = null; // 快路径恢复：清掉慢路径期间的错误横幅
        return true;
      } catch {
        rig.ffmpegSince = performance.now(); // 再等一个冷却期
        return false;
      }
    }
    rig.timeoutStrikes = (rig.timeoutStrikes ?? 0) + 1;
    if (rig.timeoutStrikes < 2) return false;
    const retry = rig.decoderRetry;
    const factory = this.decoderFactory;
    if (!retry || !factory || !retry.decodeFrames) return false;
    try {
      rig.worker?.dispose();
      rig.worker = await factory.create({
        mediaUrl: retry.ticket,
        codec: "auto",
        width: retry.width,
        height: retry.height,
        cacheCapBytes: retry.cacheCapBytes,
        refreshTicket: retry.refreshTicket,
        decodeFrames: retry.decodeFrames,
        preferBackend: "ffmpeg",
      });
      rig.preferFfmpeg = true;
      rig.ffmpegSince = performance.now();
      return true;
    } catch {
      return false;
    }
  }

  private async recreateDecoder(rig: InputRig): Promise<void> {
    try {
      const retry = rig.decoderRetry;
      const factory = this.decoderFactory;
      if (!retry || !factory) return;
      const previousWorker = rig.worker;
      const worker = await factory.create({ mediaUrl: retry.ticket, codec: "auto", width: retry.width, height: retry.height, cacheCapBytes: retry.cacheCapBytes, refreshTicket: retry.refreshTicket, decodeFrames: retry.decodeFrames }, this.lifetime.signal);
      if (this.disposed) { worker.dispose(); return; }
      rig.worker = worker;
      previousWorker?.dispose();
      rig.chainGeneration += 1;
      rig.fed = -1;
      rig.inFlight.clear();
      rig.ring = Array.from({ length: this.ringDepth }, () => null);
      rig.ringSeq = 0;
      rig.shadowUploaded = -1;
    } catch (error) {
      if (!this.disposed) this.lastError = `解码器重建失败: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      rig.decoderRecreate = undefined;
      if (!this.disposed && this.playing) this.pump(this.latestTarget);
    }
  }

  private uploadRing(rig: InputRig, inputId: string, srcN: number): Promise<void> {
    if (!rig.worker || rig.decoderRecreate) return Promise.reject(new Error(`no worker for input`));
    const slotIndex = rig.ringSeq % this.ringDepth;
    rig.ringSeq += 1;
    const epoch = this.seekEpoch;
    const generation = rig.chainGeneration;
    const task = async (): Promise<void> => {
      if (this.disposed || epoch !== this.seekEpoch || generation !== rig.chainGeneration) { this.skippedUploads += 1; return; }
      const decodeStart = performance.now();
      const perfRequest = ++this.perfRequest;
      const perfInput = editorPerf.enabled ? this.ir.inputs.findIndex(item => item.input_id === inputId) : -1;
      this.decodeInFlight += 1;
      let decoded: DecodedFrame;
      try {
        try {
          decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // **缺失帧回退到相邻帧**（播放器「定格」语义）：片尾多请求一帧
          // （duration 59.233s vs 末帧 pts 59.2s）或首帧 pts 偏移（真机 HEVC
          // 素材首帧 66.7ms）都会命中 `DECODE_FRAME_NOT_FOUND` / `no sample`。
          // 旧实现把这类素材边界当故障：既刷「最近错误」横幅，又把它算进降级
          // 判据。改为向相邻帧各试一次，拿到就按请求位（srcN）入环——画面定格
          // 在端帧，播放继续，不产生错误状态。
          if (/DECODE_FRAME_NOT_FOUND|no sample for frame/i.test(message)) {
            for (const fallback of [srcN - 1, srcN + 1]) {
              if (fallback < 0) continue;
              if (this.disposed || epoch !== this.seekEpoch || generation !== rig.chainGeneration) break;
              try {
                decoded = await rig.worker!.decode(fallback, this.ir.canvas.fps);
                editorPerf.record("edge_fallback", 0, this.perfId, perfRequest, epoch, srcN, perfInput);
                break;
              } catch { /* 再试下一个邻居 */ }
            }
          }
          if (!decoded!) {
            if (this.disposed || !(await this.maybeFallBackToFfmpeg(rig, error))) throw error;
            decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
          }
        }
        this.decodeTimes.push(performance.now() - decodeStart);
        editorPerf.record("decode", performance.now() - decodeStart, this.perfId, perfRequest, epoch, srcN, perfInput);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
        rig.timeoutStrikes = 0; // 成功解码：连续超时计数清零（偶发抖动不累积降级）
      } finally {
        this.decodeInFlight -= 1;
      }
      if (epoch !== this.seekEpoch || generation !== rig.chainGeneration) { this.skippedUploads += 1; decoded.release(); return; }
      const uploadStart = performance.now();
      await this.compositor!.uploadDecoded(inputId, slotIndex, srcN, decoded);
      if (this.disposed || epoch !== this.seekEpoch || generation !== rig.chainGeneration) return;
      this.uploadTimes.push(performance.now() - uploadStart);
      editorPerf.record("upload", performance.now() - uploadStart, this.perfId, perfRequest, epoch, srcN, perfInput);
      if (this.uploadTimes.length > 600) this.uploadTimes.splice(0, this.uploadTimes.length - 600);
      const slot = rig.ring[slotIndex] ??= { srcN: -1 };
      slot.srcN = srcN; // worker 上传 ack 后才可被合成/就绪判定看见
      rig.fed = srcN; // 与 worker 热态游标同步（回退 seek/冷启后 worker 游标亦回退）
    };
    const run = rig.uploadTail.then(task, task);
    rig.uploadTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 影子槽上传（转场共享输入第二帧；单槽，同样 ack 后就绪）。过期作废同上。 */
  private uploadShadow(rig: InputRig, inputId: string, srcN: number): Promise<void> {
    if (!rig.worker) return Promise.reject(new Error(`no worker for input`));
    const epoch = this.seekEpoch;
    const generation = rig.chainGeneration;
    const task = async (): Promise<void> => {
      if (epoch !== this.seekEpoch || generation !== rig.chainGeneration) return;
      const decodeStart = performance.now();
      const perfRequest = ++this.perfRequest;
      const perfInput = editorPerf.enabled ? this.ir.inputs.findIndex(item => item.input_id === inputId) : -1;
      this.decodeInFlight += 1;
      try {
        const decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        this.decodeTimes.push(performance.now() - decodeStart);
        editorPerf.record("decode", performance.now() - decodeStart, this.perfId, perfRequest, epoch, srcN, perfInput);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
        if (epoch !== this.seekEpoch || generation !== rig.chainGeneration) { decoded.release(); return; }
        await this.compositor!.uploadShadowDecoded(inputId, srcN, decoded);
        if (this.disposed || epoch !== this.seekEpoch || generation !== rig.chainGeneration) return;
        rig.shadowUploaded = srcN;
        rig.fed = srcN;
      } finally {
        this.decodeInFlight -= 1;
      }
    };
    const run = rig.uploadTail.then(task, task);
    rig.uploadTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 环形簿记中查找已就绪槽位的索引（-1 = 未就绪）。 */
  private ringSlotIndex(rig: InputRig, srcN: number): number {
    for (let index = 0; index < rig.ring.length; index++) {
      if (rig.ring[index]?.srcN === srcN) return index;
    }
    return -1;
  }

  /** 纹理就绪判定：ring 槽位 / 影子槽 / 静图。**「这一帧能不能画」只在这里
   *  定义一次**——frameReady（门槛）与 compose 的 sourceOf（取槽位）都走它。
   *  两处各写一份同样的条件必然漂移，而漂移的代价是：门槛说"能画"、compose
   *  说"没纹理"→ 静默跳过绘制，用户看到画面定格却没有任何解释（P196 前半
   *  只堵了帧源层，纹理层正是这条漂移留下的缝）。 */
  private textureReady(inputId: string, srcN: number, shadow: boolean): boolean {
    const rig = this.rigs.get(inputId);
    if (!rig) return false;
    if (rig.kind === "image") return true;
    return shadow ? rig.shadowUploaded === srcN : this.ringSlotIndex(rig, srcN) >= 0;
  }

  /** 纹理来源解析：未就绪返回 null（调用方跳过绘制）。 */
  private sourceOf(inputId: string, srcN: number, shadow: boolean): DrawCommand | null {
    if (!this.textureReady(inputId, srcN, shadow)) return null;
    const rig = this.rigs.get(inputId);
    if (rig?.kind === "image") return { op: "draw", inputId, image: true };
    if (shadow) return { op: "draw", inputId, shadow: true };
    return { op: "draw", inputId, slot: this.ringSlotIndex(rig!, srcN) };
  }

  /** 目标帧全部输入是否就绪（环形槽/影子槽/静图）——注意它只回答"纹理在不在"，
   *  不回答"帧在不在"：帧源层的缺帧由 targetBuffering 单独判定。 */
  private frameReady(frame: IrFrame): boolean {
    const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
    for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
    return needs.every(([inputId, srcN, shadow]) => this.textureReady(inputId, srcN, shadow));
  }

  /** P196：目标帧是否「真正在缓冲」。**两种"没东西可画"，都归到这里**——
   *  否则其中一半的定格在 UI 上永远无声：
   *  1. **帧不在**（源层）：取不到帧对象。帧源显式判定（v2 = 目标窗未就绪且
   *     不在途；v1 全量在场恒 false，缺帧只可能是越界）。画面停在上一帧。
   *  2. **纹理不在**（解码/上传层）：帧对象在，但它要的输入纹理没进环槽/影子
   *     槽。compose 的 sourceOf 因此返回 null → 跳过绘制，症状与 (1) 完全相同
   *     （定格、无解释），只是代码路径不同。判据复用 frameReady，不另写一份。
   *  为什么要靠 300ms 去抖兜住「正常上传抖动」：逐帧解码上传期间
   *  frameReady 短暂 false 是常态（每帧都要走一次），但每次都在几十毫秒内
   *  闭合，落不到阈值上；只有真的停住不动才攒满 300ms。 */
  private targetBuffering(target: number): boolean {
    const n = Math.max(0, Math.min(target, this.frames.frameCount - 1));
    const frame = this.frames.getFrame(n);
    if (!frame) return true;
    if (!this.frameReady(frame)) return true; // 纹理层未就绪（同帧源的"帧不在"同款症状）
    return this.frames.isBuffering ? this.frames.isBuffering(n) : false;
  }

  /** P196：缓冲观测（边沿触发 + 延迟确认）。调用点全是既有路径（seek 落定 /
   *  播放 tick / 重新合成），因此不引入新的轮询或 rAF。
   *
   *  为什么三条路径都要调用：停留帧不再经过合成时若得不到判定，300ms 的
   *  timer 就永远等不到"恢复"结论（提示必须能自己消失）；反过来漏掉
   *  "开始时"的判定会让计时起点凭空晚 300ms。
   *
   *  抗风暴：连续缺帧期间只保留**一个** timer、只报一次 true——拖动/连点
   *  风暴里每次 seek 都会进来，但不会叠加回调。 */
  private observeBuffering(target: number): void {
    const handler = this.onBuffering;
    if (!handler) {
      // 未订阅（也是订阅后又取消的收尾）：不留 timer、不留状态，
      // 否则下次订阅会因 bufferingShown 仍为 true 而永远静默。
      if (this.bufferingTimer) { clearTimeout(this.bufferingTimer); this.bufferingTimer = null; }
      this.bufferingShown = false;
      this.bufferingFrame = -1;
      return;
    }
    if (this.bufferingTimer || this.bufferingShown) {
      // 卡顿进行中：只问"锁定的那一帧到了没"，不受传入 target 抖动影响。
      if (this.targetBuffering(this.bufferingFrame)) return; // 仍在缓冲：不叠加回调
      // 恢复：立即生效（用户裁决"恢复立刻消失"，不设迟滞）
      if (this.bufferingTimer) { clearTimeout(this.bufferingTimer); this.bufferingTimer = null; }
      this.bufferingFrame = -1;
      if (this.bufferingShown) {
        this.bufferingShown = false;
        handler(false);
      }
      // 恢复后直接返回：**不要**在这里用传入的 target 再判一次。播放 tick 的
      // target 每拍前进，它的纹理此刻常常刚被请求、还没上传完——拿它判会让
      // 判定一直留在"缓冲中"，普通播放里指示条反而不灭。这正是"恢复只认锁定
      // 帧"这条设计的用途。
      return;
    }
    if (!this.targetBuffering(target)) return; // 就绪：无事发生
    this.bufferingFrame = Math.max(0, Math.min(target, this.frames.frameCount - 1));
    // 起点不立即回调：短于阈值的缺帧在此被静默丢弃（抗闪烁的全部意义）。
    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = null;
      if (this.disposed || this.bufferingShown) return;
      this.bufferingShown = true;
      this.onBuffering?.(true);
    }, PreviewSession.BUFFERING_NOTICE_MS);
  }

  /** P33 起播追赶：在 (from, to] 中找「洞后第一个就绪帧」。洞 = 某帧的展示
   *  需求不在环内（已被预读淘汰、且 pump 游标单调不回补——永不可展示）。
   *  - 无洞（单纯解码慢）：返回 from（保持旧重锚语义：原地等解码）；
   *  - 有洞：返回洞后第一个 frameReady 帧（没有则 from）。
   *  单输入顺播是最常见形态；多输入下取所有输入洞的并集判定（任一输入
   *  缺帧即该输出帧不可展示）。调用方把 to 延到 target+LAG：洞后的就绪帧
   *  在预读区，必须扫出 (from, target] 才能命中。 */
  private findHoleSkipCandidate(from: number, to: number): number {
    let holeSeen = false;
    for (let n = from + 1; n <= to; n++) {
      const frame = this.frames.getFrame(n);
      if (!frame) continue;
      if (!this.frameReady(frame)) { holeSeen = true; continue; }
      if (holeSeen) return n; // 洞后第一个就绪帧
    }
    return from;
  }

  /**
   * 顺序预读链：对每个输入把解码游标单调推进到 [前沿, target+LEAD] 窗口内的
   * 展示需求 src_n；展示需求之间的跳帧采样由 worker 热态连续喂入内部消化
   * （输出延迟关闭），链深度 1、完成即续（不等 rAF tick）。
   * - 冷启动（fed=-1，输入首次入窗）直接请求首个展示需求（worker 回退最近
   *   关键帧，一个请求直达）；
   * - 展示前沿回跳：回卷重播/回头后前沿帧所需采样已被消费且不在环内
   *   → 向后跳（worker 冷启承接）。常规播放前沿贴合目标，不触发。
   */
  private pump(target: number): void {
    // C20 v2：播放/预热触达新帧前，确保窗口已装配（v1 全量在场 = 无操作）。
    // 预取范围 = 目标窗 + 下一窗（计划次序 4"当前窗口必需、下一窗口预取"）。
    const ensure = this.frames.ensureRange?.(Math.max(0, target - PreviewSession.BACKSCAN),
      Math.min(target + this.ringDepth, this.frames.frameCount - 1) + 1, this.lifetime.signal);
    if (ensure) void ensure.then(() => this.extendPipOverlayIndex(0, this.frames.frameCount));
    const from = Math.max(0, this.currentFrame, target - PreviewSession.BACKSCAN);
    // B13：LEAD 联动环深（环深收 5 时 LEAD=2——写深不覆盖未展示槽位）
    const lead = Math.min(PreviewSession.LEAD, this.ringDepth - 3);
    const to = Math.min(target + lead, this.frames.frameCount - 1);
    const toEnter = Math.min(target + PreviewSession.LEAD_ENTER, this.frames.frameCount - 1);
    const needsByInput = new Map<string, Set<number>>();
    const enterNeeds = new Map<string, Set<number>>();
    /** 每输入在 ≤target 帧的最大展示需求 src_n（升序遍历末次写入即最大；链游标封顶锚点）。 */
    const displayMaxByInput = new Map<string, number>();
    const collectNeeds = (fromN: number, toN: number, into: Map<string, Set<number>>, recordDisplayMax = false) => {
      for (let n = fromN; n <= toN; n++) {
        const frame = this.frames.getFrame(n);
        if (!frame) continue;
        const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
        for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
        for (const [inputId, srcN, shadow] of needs) {
          if (shadow) continue;
          let set = into.get(inputId);
          if (!set) { set = new Set<number>(); into.set(inputId, set); }
          set.add(srcN);
          if (recordDisplayMax && n <= target) displayMaxByInput.set(inputId, srcN);
        }
      }
    };
    collectNeeds(from, to, needsByInput, true);
    if (toEnter > to) collectNeeds(from, toEnter, enterNeeds);
    // P72 剪辑点链预热：同一 input 的**片段切换** = 源链不连续，worker 必须
    // 「关键帧重建 + GOP 重喂」才能接上新片段——这是 H.264 帧间预测的固有成本。
    // 但旧实现让它**从边界那一刻才开始**：请求封顶 `max = anchor + LEAD` 以
    // ≤target 帧的最大展示需求为锚，target 未越过边界时新片段的 src_n 根本不在
    // 允许请求的范围内，于是这段等待完全落在呈现关键路径上（真机多片段实测：
    // 单个剪辑点丢 1~9 帧，远距源跳变最重）。
    // 这里先定位**前方最近一处同输入的片段切换**（边界帧的展示需求 = 新链链头），
    // 真正的提前发起在下方每输入循环里、且要求「旧链到边界为止已就绪/在途」。
    const chainWarmByInput = new Map<string, { frame: number; srcN: number }>();
    {
      let previousClip: string | null = null;
      let previousInput: string | null = null;
      for (let n = from; n <= toEnter; n++) {
        const main = this.frames.getFrame(n)?.main;
        if (!main || main.kind !== "segment") { previousClip = null; previousInput = null; continue; }
        if (previousClip !== null && previousInput === main.input_id && main.clip_id !== previousClip
          && n > target && !chainWarmByInput.has(main.input_id)) {
          chainWarmByInput.set(main.input_id, { frame: n, srcN: main.src_n });
        }
        previousClip = main.clip_id;
        previousInput = main.input_id;
      }
    }
    for (const [inputId, needs] of needsByInput) {
      const rig = this.rigs.get(inputId);
      if (!rig || rig.kind !== "video" || !rig.worker || rig.decoderRecreate) continue;
      // 候选 = 窗口内**真实展示需求**的源帧（升序、去重）。
      //
      // 顺序链只按需求推进，绝不按稠密整数步进。`plan.py` 按 **asset** 去重
      // 分配 input_id，因此同一素材的多个剪辑片段共享一个 input → 一个
      // worker → 一条顺序链；自动粗剪正是这个形状（同一素材被切成几十段、
      // 源窗口散布）。剪辑点的源跳变会让 `[fed+1, anchor)` 之间出现大段
      // **无任何展示需求**的区间：
      //  - 旧实现 `next = rig.fed + 1` 会逐帧空走这段区间——每帧一次
      //    「解码 + 上传」往返，源距离 3000 帧即 3000 次往返，期间新片段的
      //    帧永不就绪 → 播放头在剪辑点假死（用户：「很卡顿」）。
      //  - 源位置**回跳**时（自动粗剪里同样常见）超前上限 `max` 落在旧位置
      //    之前，`next = fed + 1 > max` → **一个请求都不发**，目标帧永不
      //    就绪 → 播放头彻底冻结（用户：「直接卡住不播放了」）。
      // 按需求取帧同时修掉两者：前跳只请求新片段的需求（worker 侧
      // `farForward` 自行决定关键帧重解），回跳直接请求更早的需求（worker
      // 侧 `behindCursor` 自行决定冷启），会话不再做启发式回卷。
      const demanded = [...(rig.fed < 0 ? (enterNeeds.get(inputId) ?? needs) : needs)]
        .sort((a, b) => a - b);
      if (demanded.length === 0) continue;
      // 影子槽在途时不发主环请求（既有串行约束：共享输入的转场两侧经同一条
      // uploadTail，影子 ack 会回写 rig.fed）。
      if (rig.shadowInFlight !== null) continue;
      // 变速防卡顶（2x 播放冻结根修）：链超前「展示需求」的 src 距离受环形池
      // 深度硬约束（槽位先进先出覆盖）。speed>1 时 src 每输出帧前进 speed 帧，
      // 旧 max = src(target+LEAD) 允许超前 LEAD×speed 帧——2x 时超前 10 帧 > 8
      // 槽，展示帧纹理**必然**已被淘汰：合成找不到 ≤ target 的就绪帧 → 画面
      // 冻结 + 重锚风暴。以 ≤target 帧的最大展示需求（无则窗口内最小需求，
      // 即将入场的输入）为锚 + LEAD 封顶：speed=1 时等价旧 max；speed=2 时
      // 最多超前展示需求 5 帧，展示帧就绪后在环内保有 ≥3 槽余量。
      const anchor = displayMaxByInput.get(inputId) ?? demanded[0]!;
      const max = anchor + Math.min(PreviewSession.LEAD, this.ringDepth - 3);
      // 按需求升序补齐「未就绪且未在途」的帧（在途上限内）。ring 命中与
      // 在途去重都必须按 src_n 判定：同一 src_n 在剪辑点会被反复要求，
      // 旧实现只按计数无法识别重复（L12 实锤单帧最多重复请求 37 次），
      // 重复请求把 worker 串行队列堵满、拖慢真正需要的帧。
      for (const srcN of demanded) {
        if (srcN > max) break;
        if (rig.inFlight.size >= PreviewSession.IN_FLIGHT) break;
        if (rig.inFlight.has(srcN)) continue;
        if (this.ringSlotIndex(rig, srcN) >= 0) continue;
        const generation = rig.chainGeneration;
        rig.inFlight.set(srcN, generation);
        rig.fed = Math.max(rig.fed, srcN);
        void this.uploadRing(rig, inputId, srcN)
          .catch(error => this.noteDecodeError(inputId, srcN, error))
          .finally(() => {
            // 仅当在途标记仍是本次入队留下的才删除：被 seek/重建作废的旧任务
            // 收尾时不得误删同 src_n 的新在途标记。
            if (rig.inFlight.get(srcN) === generation) rig.inFlight.delete(srcN);
            if (!this.disposed && this.playing) this.pump(this.latestTarget);
          });
      }
      // P72 剪辑点链预热：边界落在 LEAD_ENTER 内、且**旧链到边界为止的展示需求
      // 都已就绪或在途**（此刻解码器不再需要服务旧链，提前请求新链不会造成
      // 「请求新链 → 又回头要旧链」的来回切换）时，提前发起新链链头**一次**：
      // 链头请求即触发 worker 的链切换（关键帧重建 + GOP 重喂），把这段固有等待
      // 挪到边界到达之前。只占 1 个环槽位（边界前剩余帧 D + 1 ≤ ringDepth−3），
      // 不顶掉待展示帧；链头若在到达前被淘汰，展示时刻的请求仍能命中 worker 缓存
      // ——冷启只需发生一次。
      const warm = chainWarmByInput.get(inputId);
      if (warm && rig.inFlight.size < PreviewSession.IN_FLIGHT
        && this.ringSlotIndex(rig, warm.srcN) < 0 && !rig.inFlight.has(warm.srcN)) {
        let covered = true;
        for (let n = target; n < warm.frame && covered; n++) {
          const main = this.frames.getFrame(n)?.main;
          if (!main || main.kind !== "segment" || main.input_id !== inputId) continue;
          if (this.ringSlotIndex(rig, main.src_n) >= 0) continue;
          if (rig.inFlight.has(main.src_n)) continue;
          covered = false;
        }
        if (covered) {
          const generation = rig.chainGeneration;
          rig.inFlight.set(warm.srcN, generation);
          rig.fed = Math.max(rig.fed, warm.srcN);
          editorPerf.record("chain_warm", 0, this.perfId, 0, this.seekEpoch, warm.srcN,
            editorPerf.enabled ? this.ir.inputs.findIndex(item => item.input_id === inputId) : -1);
          void this.uploadRing(rig, inputId, warm.srcN)
            .catch(error => this.noteDecodeError(inputId, warm.srcN, error))
            .finally(() => {
              if (rig.inFlight.get(warm.srcN) === generation) rig.inFlight.delete(warm.srcN);
              if (!this.disposed && this.playing) this.pump(this.latestTarget);
            });
        }
      }
    }
    // 转场影子槽（共享输入第二帧）：直发（ack 后就绪；窗口内单帧）
    for (let n = target; n <= to; n++) {
      const frame = this.frames.getFrame(n);
      if (!frame) continue;
      for (const [inputId, srcN, shadow] of mainNeeds(frame)) {
        if (!shadow) continue;
        const rig = this.rigs.get(inputId);
        if (!rig || rig.kind !== "video" || rig.shadowUploaded === srcN || rig.shadowInFlight !== null) continue;
        rig.shadowInFlight = srcN;
        void this.uploadShadow(rig, inputId, srcN)
          .catch(error => this.noteDecodeError(inputId, srcN, error))
          .finally(() => {
            if (rig.shadowInFlight === srcN) rig.shadowInFlight = null;
          });
      }
    }
  }

  private noteDecodeError(inputId: string, srcN: number, error: unknown): void {
    if (this.disposed) return;
    this.lastError = `解码失败 ${inputId}#${srcN}: ${error instanceof Error ? error.message : String(error)}`;
  }

  /** 解码片段素材音频（A02：经 session 缓存 single-flight，同素材多 clip 共享
   *  一次 fetch/decode；失败保留 error 状态，仅显式 retry/票据刷新后重试）。 */
  private async ensureAudioBuffer(clipId: string, inputId: string): Promise<void> {
    if (!this.audioCtx || !this.audioCache || this.disposed) return;
    const rig = this.audioRigs.get(clipId);
    if (!rig || rig.buffer || rig.workletBuffer) return;
    const input = this.ir.inputs.find(item => item.input_id === inputId);
    if (!input?.has_audio) return;
    const ticket = this.tickets?.get(input.asset_id);
    if (!ticket) return;
    // 缓存 key：素材 + 绑定代 + 采样率（票据字符串不作内容标识）
    const key = `${input.asset_id}|${this.audioCacheBindingGeneration}|${this.audioCtx.sampleRate}`;
    try {
      const buffer = await this.audioCache.acquire(key, ticket, clipId);
      if (this.disposed || this.audioRigs.get(clipId) !== rig) {
        this.audioCache?.release(key, clipId);
        return;
      }
      if (rig.workletBuffer) return; // 已被 worklet 路径迁移（同源另一 clip 先行）
      rig.buffer = buffer;
      this.recomposeSoon(); // 解码完成：若片段正活跃，下次 tick 启动音源
    } catch (error) {
      if (!this.disposed) this.lastError = `音频解码失败 ${clipId}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 懒创建片段的变速不变调节点并把解码音频迁入音频线程（成功后 buffer 释放）。
   *  任何失败（节点创建/传输）→ workletFailed 固定回退 legacy，不重复尝试。 */
  private ensureWorkletNode(rig: AudioRig): boolean {
    if (!this.audioCtx || !this.audioWorkletReady || rig.workletFailed) return false;
    if (rig.workletBuffer) return true;
    if (!rig.buffer) return false;
    try {
      const node = new AudioWorkletNode(this.audioCtx, VARISPEED_WORKLET_NAME, {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < rig.buffer.numberOfChannels; ch++) {
        channels.push(rig.buffer.getChannelData(ch).slice());
      }
      // 单声道：一份频道数据，worklet 侧双输出复用同引用（只读）。
      node.port.postMessage({ type: "set-buffer", channels }, channels.map(data => data.buffer));
      node.connect(rig.gain ??= this.audioCtx.createGain());
      rig.gain.connect(this.audioCtx.destination);
      rig.worklet = node;
      rig.workletBuffer = true;
      rig.buffer = null; // PCM 已迁入 worklet（slice 副本 transfer），释放主线程持有
      return true;
    } catch {
      rig.workletFailed = true;
      rig.workletBuffer = false;
      return false;
    }
  }

  // ---- B15：流式音频（长素材分块 PCM → worklet stream 模式） ----

  /** 素材是否走流式（≥30s 阈值；loader/IPC 可用；context 采样率 = 块契约
   *  48kHz——不匹配时块时间域与播放时钟错位，拒绝该路径回退 A02）。 */
  private useStreamingFor(input: { duration_us?: number } | undefined): boolean {
    if (!this.streamLoader || !this.pcmChunkCache || !this.audioWorkletReady) return false;
    if (this.audioCtx && this.audioCtx.sampleRate !== PCM_CHUNK_SAMPLE_RATE) return false;
    return (input?.duration_us ?? 0) >= STREAMING_THRESHOLD_US;
  }

  /** 懒创建流式 rig 的 worklet 节点（configure stream + needRange 回喂）。
   *  节点端口事件：need-range → 窗口内块请求；underrun → 计数观测（不驱动
   *  时钟——计划"音频线程不私自倒退时钟"）；drained → 无操作（段末语义由
   *  syncAudio 的出段停声管理）。 */
  private ensureStreamingWorklet(rig: AudioRig, assetId: string): boolean {
    if (!this.audioCtx || !this.streamLoader || rig.workletFailed) return false;
    if (rig.streaming && rig.worklet) return true;
    try {
      const node = new AudioWorkletNode(this.audioCtx, VARISPEED_WORKLET_NAME, {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      const generation = this.streamLoader.currentGeneration;
      node.port.postMessage({ type: "configure", generation });
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; from?: number; to?: number; count?: number; generation?: number };
        if (!data || typeof data.type !== "string") return;
        if (data.type === "need-range" && typeof data.from === "number" && typeof data.to === "number") {
          // 缺口区间 → 立即请求覆盖块（loader 并发闸门内联排队）
          const first = Math.floor(data.from / PCM_CHUNK_SAMPLES) * PCM_CHUNK_SAMPLES;
          for (let start = first; start <= data.to; start += PCM_CHUNK_SAMPLES) {
            if (start < 0) continue;
            void this.streamLoader?.requestChunk(assetId, start).then(() => this.feedStreamingChunks(rig, assetId));
          }
        } else if (data.type === "underrun" && typeof data.count === "number") {
          this.streamUnderruns = Math.max(this.streamUnderruns, data.count);
        }
        // drained：段末/EOF——syncAudio 出段停声已覆盖，无需额外动作
      };
      node.connect(rig.gain ??= this.audioCtx.createGain());
      rig.gain.connect(this.audioCtx.destination);
      rig.worklet = node;
      rig.streaming = true;
      rig.workletBuffer = true; // 流式 rig：worklet 就绪（buffer 语义复用出声判定）
      rig.streamGeneration = generation;
      rig.streamFed.clear();
      return true;
    } catch {
      rig.workletFailed = true;
      rig.streaming = false;
      rig.workletBuffer = false;
      return false;
    }
  }

  /** 把 loader 已 ready 且未喂过的块 transfer 给 rig 的 worklet。 */
  private feedStreamingChunks(rig: AudioRig, assetId: string): void {
    const loader = this.streamLoader;
    if (!loader || !rig.worklet || !rig.streaming || !this.audioCtx) return;
    // 播放推进位置（源域）：startOffset + 播放时长 × speed（源秒）
    const elapsedS = Math.max(0, this.audioCtx.currentTime - rig.startedAt);
    const positionSample = Math.round((rig.startOffset + elapsedS * rig.speed) * this.audioCtx.sampleRate);
    const ready = loader.drive(assetId, positionSample, rig.speed);
    for (const { startSample, chunk } of ready) {
      if (rig.streamFed.has(startSample)) continue;
      // 块 PCM 拷贝成两声道独立副本（缓存本体只读；transfer 独占所有权）
      const samples = chunk.validSamples;
      const left = new Float32Array(samples);
      const right = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        left[i] = chunk.pcm[i * 2] ?? 0;
        right[i] = chunk.pcm[i * 2 + 1] ?? 0;
      }
      rig.worklet.port.postMessage(
        { type: "append-chunk", generation: rig.streamGeneration, start: startSample, valid: samples, channels: [left, right] },
        [left.buffer, right.buffer],
      );
      rig.streamFed.add(startSample);
      this.pcmChunkCache?.pin(assetId, rig.streamGeneration, startSample);
    }
  }

  /** seek/重锚：流式世代递增（旧块不接入新位置），重置喂块簿记。 */
  private reseekStreaming(): void {
    if (!this.streamLoader) return;
    const generation = this.streamLoader.reseek();
    for (const rig of this.audioRigs.values()) {
      if (!rig.streaming) continue;
      rig.streamGeneration = generation;
      rig.streamFed.clear();
      rig.worklet?.port.postMessage({ type: "configure", generation });
    }
  }

  /** 启动/重启一个片段音源：从缓冲 offset 起以 speed 播放（ctx 时间锚定）。
   *  worklet 路径 = 变速不变调（play 消息重定位，OLA 累加器清零 → ~W/2 静音
   *  过渡，仅入场/时钟重锚触达）；legacy 路径 = AudioBufferSourceNode
   *  playbackRate 直调（变调，AudioWorklet 不可用时的回退）。 */
  private startAudioSource(rig: AudioRig, cfg: SegmentAudioConfig, segment: Ir["segments"][number], offset: number, speed: number): void {
    if (!this.audioCtx) return;
    this.stopAudioSource(rig);
    // 位置模型先落定（含淡变调度的段内位置基准），三条路径共用：
    // startedAt/startOffset/speed 一经写入即为本段发声的权威锚点。
    rig.startedAt = this.audioCtx.currentTime;
    rig.startOffset = offset;
    rig.speed = speed;
    // B15 流式路径：worklet stream 模式（块按需喂入；缺口静默+underrun 观测）
    if (rig.streaming) {
      if (!rig.worklet && !this.ensureStreamingWorklet(rig, this.assetOfRig(rig))) return;
      if (!rig.worklet) return;
      rig.gain ??= this.audioCtx.createGain();
      rig.worklet.port.postMessage({ type: "play", position: Math.max(0, offset), speed });
      rig.workletActive = true;
      rig.source = null;
      this.scheduleAudioGain(rig, cfg, segment, false);
      this.feedStreamingChunks(rig, this.assetOfRig(rig));
      return;
    }
    const useWorklet = rig.workletBuffer || this.ensureWorkletNode(rig);
    if (useWorklet && rig.worklet) {
      rig.worklet.port.postMessage({ type: "play", position: Math.max(0, offset), speed });
      rig.workletActive = true;
      rig.source = null;
    } else {
      if (!rig.buffer) return;
      const source = this.audioCtx.createBufferSource();
      source.buffer = rig.buffer;
      source.playbackRate.value = speed;
      rig.gain ??= this.audioCtx.createGain();
      source.connect(rig.gain);
      rig.gain.connect(this.audioCtx.destination);
      source.start(0, Math.max(0, offset));
      rig.source = source;
      rig.workletActive = false;
      source.onended = () => { if (rig.source === source) rig.source = null; };
    }

    // 起播即按"当前段内位置"排包络：seek 到段中间不会重新从 0 淡入
    // （planGainAutomation 只排 now 之后的部分，首步是把现值 set 成此刻包络）。
    this.scheduleAudioGain(rig, cfg, segment, false);
  }

  /** 段内淡变窗口：时长 = `timeline_end_us - timeline_start_us`，与导出侧
   *  `_fade_chain(segment, duration_us)` 传进去的 `duration_us` **逐字同式**
   *  （转场借用只整体平移输出窗口，不改段长，所以两种口径的时长相同——
   *  这里直接取导出侧那条式子，免得日后解释差异）。生效包络 =
   *  resolveAudioFade(...)，与 `ffmpeg.py::_fade_us` 是同一份算术
   *  （parity 由 preview-audio-fade 测试现场对拍 Python）。 */
  private audioFadeOf(cfg: SegmentAudioConfig, segment: Ir["segments"][number]): { span: AudioFadeSpan; durationUs: number } {
    const durationUs = Math.max(0, segment.timeline_end_us - segment.timeline_start_us);
    return { span: resolveAudioFade(cfg.fadeInUs, cfg.fadeOutUs, durationUs), durationUs };
  }

  /** 片段已播的**段内**位置（微秒；输出时间轴口径 = afade 的 st/d 同一时间域）。
   *  源域 offset 换算：段内 = (offset − source_start) / speed + 墙钟增量。
   *  speed 由音源自身消耗（worklet 拉伸 / playbackRate），所以段内时间与墙钟
   *  1:1 推进——按墙钟排 ramp 得到的就是段内包络，与导出侧「先 atempo 再
   *  afade」的时间域一致。 */
  private segmentPositionUs(rig: AudioRig, segment: Ir["segments"][number]): number {
    if (!this.audioCtx) return 0;
    const sourceStartS = segment.source_start_us / 1_000_000;
    const speed = rig.speed || 1;
    const elapsedS = (rig.startOffset - sourceStartS) / speed + (this.audioCtx.currentTime - rig.startedAt);
    return Math.max(0, elapsedS * 1_000_000);
  }

  /** 按"当前段内位置"给 rig.gain 排包络——**只排 now 之后的部分**。
   *  glide=true（播放中改设置）：先用极短斜坡把当前音量滑到新包络值，不硬跳；
   *  glide=false（起播/重锚）：音源与包络同时从 0 起算，直接硬设。
   *  同一配置 + 同一位置锚点重复调用不重排（否则每 tick 的 cancel 会打断 ramp）。 */
  private scheduleAudioGain(rig: AudioRig, cfg: SegmentAudioConfig, segment: Ir["segments"][number], glide: boolean): void {
    const param = rig.gain?.gain;
    const ctx = this.audioCtx;
    if (!param || !ctx) return;
    const { span, durationUs } = this.audioFadeOf(cfg, segment);
    const level = Math.pow(10, cfg.gainDb / 20);
    const key = [level, span.fadeInUs, span.fadeOutUs, durationUs, rig.startedAt, rig.startOffset, rig.speed].join("|");
    if (rig.gateKey === key) return;
    rig.gateKey = key;
    const steps = planGainAutomation({
      span, durationUs, level,
      positionUs: this.segmentPositionUs(rig, segment),
      fromValue: param.value,
      settleS: glide ? PreviewSession.AUDIO_GAIN_SETTLE_S : 0,
    });
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    for (const step of steps) {
      const at = now + Math.max(0, step.atS);
      if (step.kind === "set") param.setValueAtTime(step.value, at);
      else param.linearRampToValueAtTime(step.value, at);
    }
  }

  /** rig → asset_id（IR 段表反查；流式喂块用）。 */
  private assetOfRig(rig: AudioRig): string {
    const segment = this.ir.segments.find(item => this.audioRigs.get(item.clip_id) === rig);
    const input = this.ir.inputs.find(item => item.input_id === segment?.input_id);
    return input?.asset_id ?? "";
  }

  private stopAudioSource(rig: AudioRig): void {
    rig.gateKey = ""; // 停声即作废已排的包络：下次起播必定重排
    if (rig.workletActive && rig.worklet) {
      rig.workletActive = false;
      rig.worklet.port.postMessage({ type: "stop" });
      return;
    }
    const source = rig.source;
    rig.source = null;
    if (!source) return;
    try { source.stop(); } catch { /* 已停止 */ }
    source.disconnect();
  }

  /** 片段音频跟随时钟（WebAudio 调度）：音源运行在音频线程时钟上，本函数只做
   *  节拍管理——进段启动、出段停止、漂移超阈值（时钟重锚）才硬校正。播放中
   *  由合成 tick 以**墙钟目标时间**驱动节拍（合成滞后不影响音频推进）。
   * 段窗口用 IR 的 output_*（转场借用重映射后的输出时间轴）；速度：worklet
   * 路径下发 speed 消息（下一颗粒生效，输入位置连续不变调）；legacy 路径直接
   * 写 playbackRate；gainDb → 线性增益（无 1.0 上限）。 */
  private syncAudio(tUs: number): void {
    if (!this.audioByClip || !this.audioCtx) return;
    const active = new Set<string>();
    /** A02 有限预热窗口：播放态 = 当前段 + 未来 2s 内入窗的段；暂停态仅当前段。 */
    const warmupHorizonUs = this.playing ? PreviewSession.AUDIO_WARMUP_US : 0;
    const warmups = new Set<string>();
    if (warmupHorizonUs > 0) {
      for (const segment of this.ir.segments) {
        const cfg = this.audioByClip.get(segment.clip_id);
        if (!cfg || !cfg.enabled) continue;
        const startUs = segment.output_start_us ?? segment.timeline_start_us;
        if (startUs > tUs && startUs <= tUs + warmupHorizonUs) warmups.add(segment.clip_id);
      }
    }
    for (const segment of this.ir.segments) {
      const cfg = this.audioByClip.get(segment.clip_id);
      if (!cfg || !cfg.enabled) continue;
      const startUs = segment.output_start_us ?? segment.timeline_start_us;
      const endUs = segment.output_end_us ?? segment.timeline_end_us;
      if (tUs < startUs || tUs > endUs) {
        // 未活跃但在预热窗口内：触发一次解码请求（single-flight 去重）
        if (warmups.has(segment.clip_id)) void this.ensureAudioBuffer(segment.clip_id, segment.input_id);
        continue;
      }
      active.add(segment.clip_id);
      const speed = Math.max(0.25, Math.min(4, segment.speed_milli / 1000));
      let rig = this.audioRigs.get(segment.clip_id);
      if (!rig) { rig = makeAudioRig(speed); this.audioRigs.set(segment.clip_id, rig); }
      // B15 流式分派：长素材走块（不触发整段解码；loader 窗口请求）
      if (!rig.buffer && !rig.workletBuffer && this.useStreamingFor(
          this.ir.inputs.find(item => item.input_id === segment.input_id))) {
        if (this.ensureStreamingWorklet(rig, this.assetOfRig(rig))) {
          const assetId = this.assetOfRig(rig);
          if (assetId) void this.streamLoader!.requestChunk(
            assetId, Math.floor(segment.source_start_us / 1e6 * this.audioCtx.sampleRate / PCM_CHUNK_SAMPLES) * PCM_CHUNK_SAMPLES,
          ).then(() => { if (!this.disposed) this.feedStreamingChunks(rig, assetId); });
        }
        // 流式 rig 无需 buffer（workletBuffer=true 已在 ensure 内置位）
      }
      if (!rig.buffer && !rig.workletBuffer) { void this.ensureAudioBuffer(segment.clip_id, segment.input_id); continue; }
      if (!this.playing) { this.stopAudioSource(rig); continue; }
      // B15：流式播放中——每 tick 喂窗口新就绪块（缺口由 worklet 静默+underrun）
      if (rig.streaming && rig.workletActive) {
        this.feedStreamingChunks(rig, this.assetOfRig(rig));
      }
      const expected = clamp(segment.source_start_us / 1e6 + ((tUs - startUs) / 1e6) * speed, segment.source_start_us / 1e6, segment.source_end_us / 1e6);
      const activeSource = rig.workletActive || rig.source !== null;
      const position = activeSource ? rig.startOffset + (this.audioCtx.currentTime - rig.startedAt) * rig.speed : null;
      const drift = position === null ? Infinity : position - expected;
      if (activeSource && Math.abs(drift) <= PreviewSession.AUDIO_REANCHOR_S) {
        if (rig.speed !== speed) {
          rig.speed = speed;
          if (rig.workletActive) rig.worklet!.port.postMessage({ type: "speed", value: speed });
          else rig.source!.playbackRate.value = speed;
        }
        // 增益/淡变：配置与锚点未变时 scheduleAudioGain 直接返回（不打断 ramp）；
        // 变了（例如 speed 变更连带重排）就走滑动过渡，避免任何硬台阶。
        this.scheduleAudioGain(rig, cfg, segment, true);
        continue;
      }
      // 无音源（入场/解码完成/出段后重入）或实质漂移（时钟重锚）→ 对齐重启。
      // 重启按新 offset 重算段内位置，淡变进度由位置决定 ⇒ 不重放淡入。
      this.startAudioSource(rig, cfg, segment, expected, speed);
    }
    for (const [clipId, rig] of this.audioRigs) {
      if (!active.has(clipId) && (rig.source || rig.workletActive)) this.stopAudioSource(rig);
    }
  }

  private pauseAudio(): void {
    if (!this.audioCtx) return;
    for (const [, rig] of this.audioRigs) this.stopAudioSource(rig);
  }

  /** 同步下发一帧的绘制命令（纹理簿记必须已就绪；GL 执行在 worker）。
   *  blurred_background：先画模糊垫底再画 fit 内容（与权威端 gblur 语义对齐，
   *  转场两侧按各自 alpha 口径垫底）。 */
  private compose(frame: IrFrame): void {
    const compositor = this.compositor;
    if (!compositor || this.disposed) return;
    const cmds: DrawCommand[] = [];
    const main = frame.main;
    const sourceOf = (inputId: string, srcN: number, shadow: boolean): DrawCommand | null =>
      this.sourceOf(inputId, srcN, shadow);
    if (main.kind === "segment") {
      const source = sourceOf(main.input_id, main.src_n, false);
      if (source) {
        if (main.layout === "blurred_background") {
          cmds.push({ ...source, op: "fill", alpha: main.alpha });
        }
        cmds.push({ ...source, rect: shiftedRect(main.content, main.shift), alpha: main.alpha, rotationDeg: main.rotation_deg ?? 0 });
      }
    } else if (main.kind === "transition") {
      const shared = main.left.input_id === main.right.input_id;
      const left = sourceOf(main.left.input_id, main.left.src_n, shared);
      const right = sourceOf(main.right.input_id, main.right.src_n, false);
      if (left && right) {
        const alphaL = main.transition === "fadeblack"
          ? main.left.alpha * Math.max(0, 1 - 2 * main.p)
          : main.left.alpha;
        const alphaR = main.transition === "fadeblack"
          ? main.right.alpha * Math.max(0, 2 * main.p - 1)
          : main.right.alpha * main.p;
        if (main.left.layout === "blurred_background") {
          cmds.push({ ...left, op: "fill", alpha: alphaL });
        }
        if (main.right.layout === "blurred_background") {
          cmds.push({ ...right, op: "fill", alpha: alphaR });
        }
        cmds.push({ ...left, rect: shiftedRect(main.left.content, main.left.shift), alpha: alphaL, rotationDeg: main.left.rotation_deg ?? 0 });
        if (!(main.transition === "fadeblack" && main.p < 0.5)) {
          cmds.push({ ...right, rect: shiftedRect(main.right.content, main.right.shift), alpha: alphaR, rotationDeg: main.right.rotation_deg ?? 0 });
        }
      }
    }
    for (const overlay of frame.overlays) {
      const source = sourceOf(overlay.input_id, overlay.src_n, false);
      if (source) {
        cmds.push({ ...source, rect: overlay.box, alpha: overlay.alpha, rotationDeg: overlay.rotation_deg, mask: overlay.effects?.mask, keying: overlay.effects?.keying });
      }
    }
    if (frame.captions.length > 0) {
      const items = frame.captions.map(captionId => {
        const entry = this.ir.captions.find(item => item.caption_id === captionId);
        return entry ? { caption_id: entry.caption_id, text: entry.text, preset_id: entry.preset_id } : null;
      }).filter((item): item is { caption_id: string; text: string; preset_id: string } => item !== null);
      cmds.push({ op: "captions", items });
    }
    compositor.compose(cmds, this.seekEpoch, frame.n);
    // 矩阵"拖动/缩放输入至下一次绘制提交"测量（2026-09-15 补测）：compose
    // 调用返回 = GL 命令组装 + postMessage 提交完成（与既有 submitted 遥测
    // 同口径：命令已提交，非 GPU 完成/呈现）。由 seekToFrame 置起点；播放
    // pump 的常规 compose（pendingDragSubmitT0=0）不落样。
    if (this.pendingDragSubmitT0 > 0) {
      editorPerf.record("drag_to_submit", performance.now() - this.pendingDragSubmitT0, this.perfId, 0, this.seekEpoch, frame.n);
      this.pendingDragSubmitT0 = 0;
    }
  }

  /**
   * seek（暂停态/播放头跳转）：并行解码目标帧 → 合成。
   * - latest-wins（epoch）：新 seek 到来时旧结果的合成被跳过；连续快速 seek 进
   *   入拖拽快速档——仅解码主轨输入、跳过 PiP，停止 250ms 后由调用方触发全量
   *   精修。
   * - 返回实际渲染的帧号（被更新的 seek 取代时为 -1）。
   */
  async seekToFrame(target: number): Promise<number> {
    if (this.disposed) return -1;
    const epoch = ++this.seekEpoch;
    // 矩阵"拖动/缩放输入至下一次绘制提交"测量（2026-09-15 补测）：从
    // seek 入口（用户拖动/点击进度条 → playhead → 此处）起算，到结果帧
    // compose 提交完成止，drag_to_submit 事件在 compose 内落样。拖拽快速档
    // 中被更新的 seek 作废（epoch 失配提前 return，不覆盖起点）——保留的
    // 是每次落定的完整链路；风暴中的 latest-wins 语义即用户所见。
    this.pendingDragSubmitT0 = editorPerf.enabled ? performance.now() : 0;
    // seek 是用户驱动的位置跳变：重置解码链游标（后续 pump/播放冷启重建；环内
    // 已就绪采样仍可直接复用，±1 步进零解码路径保持不变）。
    this.resetChains();
    // B15：流式世代递增（旧块不接入新位置；播放重锚时按新窗口重喂）
    this.reseekStreaming();
    const now = performance.now();
    this.dragMode = now - this.lastSeekWall < 250;
    this.lastSeekWall = now;
    const index = Math.max(0, Math.min(target, this.frames.frameCount - 1));
    // P196：取窗发起前先判定一次——窗口请求若悬挂不返回（网络/磁盘卡死），
    // await 之后的判定永远到不了，画面会无声冻结。提前这一次让"用户真的在
    // 等"照样能出提示；快取窗（~50-70ms）在下方 await 后立刻被判回"恢复"，
    // 300ms 阈值内不会亮。
    this.observeBuffering(index);
    // C20 v2：目标帧所在窗口可能未就绪——先取窗（abort 语义 = 会话生命周期；
    // 单窗 IPC ~50-70ms，拖拽快速档由 epoch latest-wins 兜住）。
    const ensure = this.frames.ensureRange?.(index, index + 1, this.lifetime.signal);
    if (ensure) {
      // 窗口就绪后增量并入 pip 索引（游标扫描,与播放 pump 路径同型——
      // C20-T2 装配并行化后 create 时窗口可能未就绪,这里补齐首窗索引）
      void ensure.then(() => this.extendPipOverlayIndex(0, this.frames.frameCount));
      await ensure.catch(() => undefined); // 取窗失败按缺帧处理（-1），不再向上抛
      // dispose 后抵达：与作废的上传任务同语义（rejected），不产出 compose
      if (this.disposed) throw new Error("session disposed");
    }
    const frame = this.frames.getFrame(index);
    // P196：缓冲判定放在取窗落定之后（此刻的"缺帧"才是用户真的在等）
    this.observeBuffering(index);
    if (!frame) return -1;
    this.currentFrame = index;
    this.latestTarget = index;
    const requests: Array<Promise<void>> = [];
    for (const [inputId, srcN, shadow] of mainNeeds(frame)) {
      const rig = this.rigs.get(inputId);
      if (!rig || rig.kind === "image") continue;
      const ready = shadow ? rig.shadowUploaded === srcN : this.ringSlotIndex(rig, srcN) >= 0;
      if (!ready) requests.push(shadow ? this.uploadShadow(rig, inputId, srcN) : this.uploadRing(rig, inputId, srcN));
    }
    if (!this.dragMode) {
      for (const [inputId, srcN] of overlayNeeds(frame)) {
        const rig = this.rigs.get(inputId);
        if (!rig || rig.kind === "image") continue;
        if (this.ringSlotIndex(rig, srcN) >= 0) continue;
        requests.push(this.uploadRing(rig, inputId, srcN));
      }
    }
    // DEFECT-4K60-SEEK：seek 解码/上传失败在此落定（写 lastError、不向上抛）——
    // 旧实现 Promise.all 的 rejection 无人接（UI 入口是 void 调用），既成
    // unhandled rejection 也让装配期 seek 把整个预览打成 error。
    try {
      await Promise.all(requests);
    } catch (error) {
      if (this.disposed || epoch !== this.seekEpoch) return -1; // 作废/已销毁：静默
      this.lastError = `seek 解码失败 frame ${index}: ${error instanceof Error ? error.message : String(error)}`;
      return -1;
    }
    if (epoch !== this.seekEpoch) return -1; // 已被更新的 seek 取代
    // P196（纹理半场）：上传落定后再判一次。上方第一次判定发生在**发起上传
    // 之前**——那一帧的纹理此刻必然还没进槽（未就绪），计时已经起跑；没有
    // 这一次收尾判定，每次普通 seek 都会在 300ms 后凭空点亮指示条。此处的
    // "恢复"同时也是纹理真的到位的时刻。
    this.observeBuffering(index);
    this.lastSeekMs = performance.now() - now;
    editorPerf.record("seek", this.lastSeekMs, this.perfId, epoch, epoch, index);
    if (this.frameReady(frame)) this.compose(frame);
    this.onTimeUs?.(frame.t_us);
    this.poolDrive(frame); // B13：seek 后立即驱动（pin/换源语义）
    // 暂停态预热预读链：预解码后续 LEAD 帧——再按播放即有热跑道
    //（消除 seek 后播放头几百毫秒的冷启丢帧）。**拖拽快速档跳过预热**：
    // scrub 风暴中预热解码与下一 seek 的目标解码争抢解码器（实测 seek p95
    // 翻倍）；最终落定（refineAfterDrag，dragMode=false）才预热。
    if (!this.playing && !this.dragMode) this.pump(index);
    this.scheduleWindowPrefetch(index);
    return frame.n;
  }

  /** C20-T1：seek 落定后的窗口元数据预取（仅 v2 注入帧源生效）。
   *  拖拽/连点风暴中定时器持续重置 = 自然去抖；落定后对目标窗 ±span 逐窗
   *  发起（近目标优先、正向优先），受帧源 maxInFlight 约束——满载窗口不
   *  排队（window_fetch -1 遥测），fire-and-forget：loadWindow 自吞错误，
   *  promise 不会 reject。预取只影响 IR 元数据缓存，不触发解码/上传。 */
  private scheduleWindowPrefetch(target: number): void {
    if (this.prefetchSpan < 1 || !this.externalFrames) return;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      if (this.disposed) return;
      for (const start of windowPrefetchStarts(target, this.prefetchSpan, PREVIEW_IR_V2_MAX_WINDOW_FRAMES, this.frames.frameCount)) {
        void this.frames.ensureRange?.(start, start + 1, this.lifetime.signal);
      }
    }, PreviewSession.PREFETCH_DEBOUNCE_MS);
  }

  /** 拖拽结束后的全量精修（覆盖 PiP/转场槽位），快速档期间跳过的内容由此补齐。 */
  async refineAfterDrag(): Promise<void> {
    this.dragMode = false;
    await this.seekToFrame(this.currentFrame);
    // seekToFrame 内部的 epoch 自增会置 dragMode=false，二次确认状态
    this.dragMode = false;
  }

  get seekMetrics(): { last_seek_ms: number; drag_mode: boolean } {
    return { last_seek_ms: Math.round(this.lastSeekMs * 1000) / 1000, drag_mode: this.dragMode };
  }

  play(): void {
    if (this.playing || this.disposed) return;
    const last = this.frames.frameCount - 1;
    // 播放头已在片尾：回卷从头再播（标准播放器行为；此前第二次播放立即"到尾"暂停）。
    // 回卷是用户驱动的向后跳转：显式重置各输入解码链（游标回 -1，pump 冷启重建）。
    if (this.currentFrame >= last) { this.currentFrame = 0; this.resetChains(); }
    this.playing = true;
    this.dropped = 0; // 丢帧口径 = 本次播放段（拖拽/seek 冷启尖峰不跨段累计）
    this.anchorWall = performance.now();
    this.anchorFrame = this.currentFrame;
    this.lastAdvanceWall = this.anchorWall;
    void this.audioCtx?.resume().catch(() => undefined); // 自动播放策略：用户手势链内恢复
    const frameDur = 1000 / this.ir.canvas.fps;
    const tick = () => {
      if (!this.playing || this.disposed) return;
      const now = performance.now();
      const target = Math.min(last, Math.floor(this.anchorFrame + (now - this.anchorWall) / frameDur));
      this.latestTarget = target;
      this.observeBuffering(target); // P196：起播/卡顿的提示来源（饿了也得出声）
      this.pump(target);
      // 音频以**墙钟目标**驱动（音频线程自行推进，合成滞后不拖累音频）：
      // 时钟目标 µs = anchorFrame × 1e6/fps + 墙钟增量。
      this.syncAudio(Math.round(this.anchorFrame * (1e6 / this.ir.canvas.fps) + (now - this.anchorWall) * 1000));
      // 合成 ≤ 目标的最新就绪帧：已就绪帧绝不丢弃；starving 时保持最后画面。
      // 同帧不重复合成（命令下发幂等，60Hz tick 对 30fps 内容时减半主线程负载）。
      let composed = -1;
      const floor = Math.max(0, Math.max(this.currentFrame - 1, target - PreviewSession.BACKSCAN));
      for (let n = target; n >= floor; n--) {
        const frame = this.frames.getFrame(n);
        if (frame && this.frameReady(frame)) { composed = n; break; }
      }
      if (composed >= 0 && composed > this.currentFrame) {
        // 丢帧口径 = 本次推进跳过的帧数（不是 rAF tick 数；60Hz 会虚高数倍）
        const skipped = composed - this.currentFrame - 1;
        if (skipped > 0) { this.dropped += skipped; this.droppedLifetime += skipped; }
        const taskStart = performance.now();
        const composedFrame = this.frames.getFrame(composed)!;
        this.compose(composedFrame);
        this.taskTimes.push(performance.now() - taskStart);
        if (this.taskTimes.length > 1200) this.taskTimes.splice(0, this.taskTimes.length - 1200);
        this.currentFrame = composed;
        this.lastAdvanceWall = now;
        this.onTimeUs?.(composedFrame.t_us);
        this.poolDrive(composedFrame); // B13：活跃/idle/压力驱动
      }
      // 饥饿护栏：落后过多 → 重锚时钟（播放按解码吞吐放慢），而不是让目标
      // 无限狂奔、丢帧按 tick 线性堆积（旧实现冻结+丢帧 404 的直接根源）。
      // P33 起播追赶（fix-ttl-r14..r16 / hole-skip-r1..r3 死锁定位）：LAG 收紧
      // 后若 [current+1, target] 存在**已被环槽淘汰的洞**，锚在 currentFrame 的
      // 重锚会让 target 永远爬不出洞区（重锚即归位 → 差值再超 → 再归位），
      // 而预读区（洞后）的就绪帧永远轮不到回扫窗——合成冻结在洞前。把播放头
      // 跳到「洞后第一个就绪帧」：被淘汰帧本就永远无法展示；搜索窗延伸
      // target+LAG（重锚后 target 落在候选附近，且环内就绪区必在预读界内）。
      if (target - this.currentFrame > PreviewSession.LAG_REANCHOR) {
        const reanchorTo = this.findHoleSkipCandidate(this.currentFrame,
          Math.min(target + PreviewSession.LAG_REANCHOR, this.frames.frameCount - 1));
        // **丢帧口径诚实化**（2026-09-30 用户真机复测暴露）：重锚跳过的帧同样是
        // 「未能展示的帧」，必须计入丢帧。旧实现只把播放头挪过去不计数——解码吞吐
        // 不足时界面会显示「丢帧 0」而画面实为幻灯片（用户实测：H.264 素材
        // `解码 p95 192.3ms`、`丢帧 0`、观感幻灯片），指标因此失去诊断价值。
        const skippedByReanchor = reanchorTo - this.currentFrame - 1;
        if (skippedByReanchor > 0) { this.dropped += skippedByReanchor; this.droppedLifetime += skippedByReanchor; }
        editorPerf.record("reanchor", skippedByReanchor, this.perfId, 0, this.seekEpoch, reanchorTo);
        this.currentFrame = reanchorTo;
        this.anchorFrame = reanchorTo;
        this.anchorWall = now;
      }
      // B13-R：1Hz 驻留取样（decode worker 侧计数；compositor 计数随 ack
      // 已进 perf，此处补 decode 侧与主动查询的合成器快照）。
      if (editorPerf.enabled && now - this.lastResidencySampleAt >= 1000) {
        this.lastResidencySampleAt = now;
        const decodeQueries = [...this.rigs.values()]
          .map(rig => rig.worker?.residency().catch(() => null) ?? Promise.resolve(null));
        const compositorQuery = (this.compositor?.queryResidency().catch(() => null) ?? Promise.resolve(null)) as Promise<FrameResidency | null>;
        void Promise.all([...decodeQueries, compositorQuery]).then(results => {
          if (this.disposed || !editorPerf.enabled) return;
          const compositor = results[results.length - 1] as FrameResidency | null;
          const decodeEntries = results.slice(0, -1).filter((entry): entry is DecodeResidencyInfo => entry !== null);
          if (!compositor && decodeEntries.length === 0) return;
          const at = performance.now();
          editorPerf.record("residency", 0, this.perfId);
          editorPerf.residency = {
            at,
            decode: decodeEntries[0] ?? { decoded: -1, posted: -1, cached: -1, closed: -1, live: -1, cacheBytes: -1, cacheSize: -1 },
            compositor: compositor ?? editorPerf.residency?.compositor ?? { framesIn: -1, framesClosed: -1, framesLive: -1, uploadsOk: -1, uploadsErr: -1, closedOnErr: -1, uploadMode: "unknown", textureBytes: -1 },
          };
        });
      }
      // 结束判定 = 合成推进到片尾（而非时钟到达）：时钟先到时等待合成追平，
      // 否则会提前停在片尾、且每次续播止点渐近（用户实测 10.12→10.17→10.19）。
      // 片尾解码长期不可达的兜底：2s 无推进则结束（已知驱动限制场景）。
      // P33 W2.6：停滞兜底结束时把播放头**吸附到末帧**——片尾截断 GOP 的尾帧
      // 永久不可达时 currentFrame 停在 last-3，回卷条件（currentFrame >= last）
      // 永不成立，再点播放 = 从卡死点原地续播再停滞 2s（真机「播放到尾后
      // 再点播放无效」）。吸附后按播放正常回卷从头；画面保持最后定格帧。
      if (this.currentFrame >= last || (target >= last && now - this.lastAdvanceWall > 2000)) {
        this.currentFrame = last;
        this.pause();
        this.onEnded?.();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.pauseAudio();
  }

  metrics(): PreviewSessionMetrics {
    const times = [...this.taskTimes].sort((a, b) => a - b);
    const decodes = [...this.decodeTimes].sort((a, b) => a - b);
    const uploads = [...this.uploadTimes].sort((a, b) => a - b);
    const p = (list: number[], q: number) => list.length ? Math.round(list[Math.min(list.length - 1, Math.floor(q * list.length))] * 1000) / 1000 : 0;
    // P33 分段聚合：全输入 timingSamples 合并后取分位数（m3p5 探针消费）。
    let decodeSeg: PreviewSessionMetrics["decode_seg"] = null;
    {
      const feeds: number[] = [];
      const outputs: number[] = [];
      const queues: number[] = [];
      const residuals: number[] = [];
      for (const rig of this.rigs.values()) {
        for (const sample of rig.worker?.timingSamples ?? []) {
          if (sample.fromCache) continue; // 缓存命中不代表解码路径
          feeds.push(sample.feedMs);
          outputs.push(sample.outputMs);
          queues.push(sample.queueMs ?? 0);
          residuals.push(sample.residualMs);
        }
      }
      if (residuals.length > 0) {
        feeds.sort((a, b) => a - b);
        outputs.sort((a, b) => a - b);
        queues.sort((a, b) => a - b);
        residuals.sort((a, b) => a - b);
        decodeSeg = {
          feed_p50: p(feeds, 0.5), feed_p95: p(feeds, 0.95),
          output_p50: p(outputs, 0.5), output_p95: p(outputs, 0.95),
          queue_p50: p(queues, 0.5), queue_p95: p(queues, 0.95),
          residual_p50: p(residuals, 0.5), residual_p95: p(residuals, 0.95),
        };
      }
    }
    return {
      task_ms_p50: p(times, 0.5),
      task_ms_p95: p(times, 0.95),
      dropped_frames: this.dropped,
      composed_frames: this.taskTimes.length,
      last_error: this.lastError,
      // 解码后端可见化：`ffmpeg` = 已降级到 Core IPC 软解（~180ms/帧量级），
      // 是需要立刻被看见的异常态（2026-09-30 真机「越修越卡」根因即为此路径
      // 被瞬时抖动永久钉死，而界面当时没有任何提示）。
      decode_backend: [...this.rigs.values()].map(rig => rig.preferFfmpeg ? "ffmpeg" : (rig.worker?.backend ?? "?")).join(","),
      decode_hardware: [...this.rigs.values()].map(rig => rig.worker?.hardware ?? "").join(","),
      decode_ms_p50: p(decodes, 0.5),
      decode_ms_p95: p(decodes, 0.95),
      decode_seg: decodeSeg,
      decode_in_flight: this.decodeInFlight,
      upload_ms_p95: p(uploads, 0.95),
      canvas_w: this.ir.canvas.width,
      canvas_h: this.ir.canvas.height,
      backing_w: this.backing.width,
      backing_h: this.backing.height,
      fit_scale: Math.round(this.fitScale * 1000) / 1000,
    };
  }

  /** 全画布 PNG 回读（worker convertToBlob → ArrayBuffer transfer；探针取证用
   *  ——transfer 后主线程 canvas.toBlob 不可用）。 */
  async readbackPng(): Promise<ArrayBuffer> {
    if (!this.compositor) throw new Error("compositor unavailable");
    return await this.compositor.readback();
  }

  /** 音频路径诊断（m3p5 探针取证）：worklet 装载与每片段走的是哪条路径。 */
  audioDebug(): { workletLoaded: boolean; clips: Array<{ clipId: string; mode: "worklet" | "legacy" | "pending"; bufferReady: boolean }> } {
    const clips: Array<{ clipId: string; mode: "worklet" | "legacy" | "pending"; bufferReady: boolean }> = [];
    for (const [clipId, rig] of this.audioRigs) {
      const mode = rig.workletBuffer ? "worklet" : rig.buffer ? "legacy" : "pending";
      clips.push({ clipId, mode, bufferReady: Boolean(rig.buffer || rig.workletBuffer) });
    }
    return { workletLoaded: this.audioWorkletReady, clips };
  }

  dispose(): void {
    if (this.disposed) return;
    editorPerf.record("session_close", 0, this.perfId);
    this.disposed = true;
    this.seekEpoch++;
    if (this.prefetchTimer) { clearTimeout(this.prefetchTimer); this.prefetchTimer = null; }
    this.lifetime.abort();
    this.poolDispose(); // B13：池输入释放（worker 纹理删除 + 簿记清零）
    this.onTimeUs = null;
    this.onEnded = null;
    // P196：销毁后不得再回调——先停 timer 再清订阅（顺序保证回调不会再发生）
    if (this.bufferingTimer) { clearTimeout(this.bufferingTimer); this.bufferingTimer = null; }
    this.bufferingShown = false;
    this.bufferingFrame = -1;
    this.onBuffering = null;
    this.pause();
    for (const [, rig] of this.audioRigs) {
      this.stopAudioSource(rig);
      try { rig.worklet?.disconnect(); } catch { /* 已断开 */ }
    }
    this.audioRigs.clear();
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.audioCache?.dispose();
    this.audioCache = null;
    // B15：流加载器 + 块缓存释放（dispose 清空在途引用与端口监听）
    this.streamLoader?.dispose();
    this.streamLoader = null;
    this.pcmChunkCache = null;
    if (this.recomposeRaf) cancelAnimationFrame(this.recomposeRaf);
    this.recomposeRaf = 0;
    for (const rig of [...this.rigs.values()].reverse()) rig.worker?.dispose();
    this.rigs.clear();
    this.compositor?.terminate();
    this.compositor = null;
    for (const resolve of this.contextLostResolvers.splice(0)) resolve();
    this.canvasEl?.remove();
    this.canvasEl = null;
  }
}
