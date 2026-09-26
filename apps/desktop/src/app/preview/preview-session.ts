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

/** 片段音频配置（编辑态：App 从时间线文档透传）。 */
export interface SegmentAudioConfig { enabled: boolean; gainDb: number }

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
  /** 当前在途解码请求数（全部输入合计，含影子槽）。 */
  decode_in_flight: number;
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
  /** 播放/seek 共用的环形簿记：槽位按 ringSeq 轮转，srcN=-1 表示空。 */
  ring: Array<RingSlot | null>;
  ringSeq: number;
  /** 顺序解码链游标：已向 worker 请求的最大 src_n（seek 上传后同步）。 */
  fed: number;
  /** 在途链请求的 src_n（深度 1）。 */
  inFlightCount: number;
  /** 转场共享输入第二帧槽位（影子槽，ack 后置值）。 */
  shadowUploaded: number;
  /** 影子槽在途请求 src_n。 */
  shadowInFlight: number | null;
  /** 同一输入的上传串行尾（ack 顺序保证槽位标记不被乱序覆盖）。 */
  uploadTail: Promise<void>;
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
    streaming: false, streamGeneration: 0, streamFed: new Set<number>(),
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
  /** A02 音频预热窗口（微秒）：播放态预取未来 2s 内入窗段；暂停态为 0。 */
  private static readonly AUDIO_WARMUP_US = 2_000_000;
  /** 自然播放到片尾时回调（UI 复位播放按钮；会话已内部 pause）。 */
  onEnded: (() => void) | null = null;

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
  private static readonly IN_FLIGHT = 2;
  /** 新输入入场提前量：首次入窗的输入提前 ~1.5s 冷启。 */
  private static readonly LEAD_ENTER = 45;
  /** 合成落后目标超过该帧数 → 重锚时钟。 */
  private static readonly LAG_REANCHOR = 12;
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
        if (resolved && resolved.isProxy) {
          tickets = new Map(tickets);
          tickets.set(input.asset_id, resolved.url);
        }
      }
    }
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
        inFlightCount: 0,
        shadowUploaded: -1,
        shadowInFlight: null,
        uploadTail: Promise.resolve(),
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
        const factory = session.decoderFactory ?? new MediaDecoderFactoryImpl(await probeDecodeCapability());
        session.decoderFactory = factory;
        const desktopApi = typeof window !== "undefined"
          ? (window as unknown as { desktop?: { decodeFrames?: (input: { project_id: string; asset_id: string; frame_numbers: number[]; fps: number }) => Promise<ArrayBuffer> } }).desktop
          : undefined;
        const decodeFrames = pcmProjectId && desktopApi?.decodeFrames
          ? (req: { frameNumbers: number[]; fps: number }) => desktopApi.decodeFrames!({
              project_id: pcmProjectId,
              asset_id: input.asset_id,
              frame_numbers: req.frameNumbers,
              fps: req.fps,
            })
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

  /** 编辑态音频配置更新（静音/增益实时生效；增益直接写 GainNode，无重建）。 */
  setAudioByClip(audioByClip: Map<string, SegmentAudioConfig> | null): void {
    this.audioByClip = audioByClip;
    if (!this.audioCtx) return;
    for (const [clipId, rig] of this.audioRigs) {
      const cfg = audioByClip?.get(clipId);
      if (rig.gain && cfg) rig.gain.gain.value = Math.pow(10, cfg.gainDb / 20);
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
        inFlight: rig.inFlightCount,
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
        void rig?.worker?.dispose(); // 解码器保温让位（重入时 pump 冷启重建）
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
   *  pump 冷启重建（worker 冷启路径实证干净）。 */
  private resetChains(): void {
    for (const [, rig] of this.rigs) {
      rig.fed = -1;
      rig.inFlightCount = 0;
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
    });
  }

  /** 环形槽位上传（经每输入串行尾；worker 上传 ack 后才标记 srcN 就绪）。
   *  过期作废：任务排队期间到来新 seek（seekEpoch 变化）→ 预取目标已失效，
   *  直接作废（解码前后双重检查；作废帧 close 释放）——否则 scrub 时新 seek
   *  的上传会排在整条过期预取队尾（worker 化后每任务含双跳 RTT，实测 seek
   *  p95 翻倍的根因）。 */
  /** 解码超时/看门狗 → 降级 ffmpeg 后端重试一次（WebCodecs 对长 GOP HEVC 可能过慢）。 */
  private async maybeFallBackToFfmpeg(rig: InputRig, error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout|watchdog|key frame is required/i.test(message)) return false;
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
      return true;
    } catch {
      return false;
    }
  }

  private uploadRing(rig: InputRig, inputId: string, srcN: number): Promise<void> {
    if (!rig.worker) return Promise.reject(new Error(`no worker for input`));
    const slotIndex = rig.ringSeq % this.ringDepth;
    rig.ringSeq += 1;
    const epoch = this.seekEpoch;
    const task = async (): Promise<void> => {
      if (this.disposed || epoch !== this.seekEpoch) { this.skippedUploads += 1; return; }
      const decodeStart = performance.now();
      const perfRequest = ++this.perfRequest;
      const perfInput = editorPerf.enabled ? this.ir.inputs.findIndex(item => item.input_id === inputId) : -1;
      this.decodeInFlight += 1;
      let decoded: DecodedFrame;
      try {
        try {
          decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        } catch (error) {
          if (this.disposed || !(await this.maybeFallBackToFfmpeg(rig, error))) throw error;
          decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        }
        this.decodeTimes.push(performance.now() - decodeStart);
        editorPerf.record("decode", performance.now() - decodeStart, this.perfId, perfRequest, epoch, srcN, perfInput);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
      } finally {
        this.decodeInFlight -= 1;
      }
      if (epoch !== this.seekEpoch) { this.skippedUploads += 1; decoded.release(); return; }
      const uploadStart = performance.now();
      await this.compositor!.uploadDecoded(inputId, slotIndex, srcN, decoded);
      if (this.disposed || epoch !== this.seekEpoch) return;
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
    const task = async (): Promise<void> => {
      if (epoch !== this.seekEpoch) return;
      const decodeStart = performance.now();
      const perfRequest = ++this.perfRequest;
      const perfInput = editorPerf.enabled ? this.ir.inputs.findIndex(item => item.input_id === inputId) : -1;
      this.decodeInFlight += 1;
      try {
        const decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        this.decodeTimes.push(performance.now() - decodeStart);
        editorPerf.record("decode", performance.now() - decodeStart, this.perfId, perfRequest, epoch, srcN, perfInput);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
        if (epoch !== this.seekEpoch) { decoded.release(); return; }
        await this.compositor!.uploadShadowDecoded(inputId, srcN, decoded);
        if (this.disposed || epoch !== this.seekEpoch) return;
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

  /** 目标帧全部输入是否就绪（环形槽/影子槽/静图）。 */
  private frameReady(frame: IrFrame): boolean {
    const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
    for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
    return needs.every(([inputId, srcN, shadow]) => {
      const rig = this.rigs.get(inputId);
      if (!rig) return false;
      if (rig.kind === "image") return true;
      return shadow ? rig.shadowUploaded === srcN : this.ringSlotIndex(rig, srcN) >= 0;
    });
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
    for (const [inputId, needs] of needsByInput) {
      const rig = this.rigs.get(inputId);
      if (!rig || rig.kind !== "video") continue;
      let sorted: number[];
      if (rig.fed < 0) {
        sorted = [...(enterNeeds.get(inputId) ?? needs)].sort((a, b) => a - b);
      } else {
        sorted = [...needs].sort((a, b) => a - b);
      }
      // 变速防卡顶（2x 播放冻结根修）：链游标超前「展示需求」的 src 距离受环形
      // 池深度硬约束（RING=8，槽位先进先出覆盖）。speed>1 时 src 每输出帧前进
      // speed 帧，旧 max = src(target+LEAD) 允许游标超前当前展示需求
      // LEAD×speed 帧——2x 时超前 10 帧 > 8 槽，链追平钟点后展示帧纹理**必然**
      // 已被淘汰：合成永远找不到 ≤ target 的就绪帧 → 画面冻结 + 时钟重锚风暴
      // （重锚后游标不可回退，冻结固化）→ 播放卡死不前进。以 ≤target 帧的最大
      // 展示需求（无则窗口内最小需求，即将入场的输入）+ RING-3 封顶游标：
      // speed=1 时 anchor+5 ≡ 旧 max（1x 行为逐位不变）；speed=2 时游标最多
      // 超前展示需求 5 帧，展示帧就绪后在环内保有 ≥3 槽余量，合成始终能在
      // ≤ target 找到就绪帧。代价仅是 speed>1 时的预读跑道收窄（仍有
      // (RING-3)/speed 个输出帧），换段冷启尖峰由链完成即续吸收。
      const anchor = displayMaxByInput.get(inputId) ?? sorted[0]!;
      const max = Math.min(sorted[sorted.length - 1]!, anchor + this.ringDepth - 3);
      // 正向单调推进（冷启动首个请求直达入场点）。
      // 向后跳转只发生在用户动作（回卷重播/回退 seek）——由 resetChains() 显式
      // 重置链游标，pump 本身不做启发式回跳（避免深窗口陈旧需求引发震荡）。
      let next = rig.fed < 0 ? sorted[0]! : rig.fed + 1;
      while (next <= max && this.ringSlotIndex(rig, next) >= 0) {
        rig.fed = next;
        next += 1;
      }
      if (next > max || rig.inFlightCount >= PreviewSession.IN_FLIGHT || rig.shadowInFlight !== null) continue;
      rig.fed = next;
      rig.inFlightCount += 1;
      void this.uploadRing(rig, inputId, next)
        .catch(error => this.noteDecodeError(inputId, next, error))
        .finally(() => {
          rig.inFlightCount = Math.max(0, rig.inFlightCount - 1);
          if (!this.disposed && this.playing) this.pump(this.latestTarget);
        });
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
  private startAudioSource(rig: AudioRig, gainDb: number, offset: number, speed: number): void {
    if (!this.audioCtx) return;
    this.stopAudioSource(rig);
    // B15 流式路径：worklet stream 模式（块按需喂入；缺口静默+underrun 观测）
    if (rig.streaming) {
      if (!rig.worklet && !this.ensureStreamingWorklet(rig, this.assetOfRig(rig))) return;
      if (!rig.worklet) return;
      rig.gain ??= this.audioCtx.createGain();
      rig.gain.gain.value = Math.pow(10, gainDb / 20);
      rig.worklet.port.postMessage({ type: "play", position: Math.max(0, offset), speed });
      rig.workletActive = true;
      rig.source = null;
      rig.startedAt = this.audioCtx.currentTime;
      rig.startOffset = offset;
      rig.speed = speed;
      this.feedStreamingChunks(rig, this.assetOfRig(rig));
      return;
    }
    const useWorklet = rig.workletBuffer || this.ensureWorkletNode(rig);
    if (useWorklet && rig.worklet) {
      rig.gain!.gain.value = Math.pow(10, gainDb / 20);
      rig.worklet.port.postMessage({ type: "play", position: Math.max(0, offset), speed });
      rig.workletActive = true;
      rig.source = null;
    } else {
      if (!rig.buffer) return;
      const source = this.audioCtx.createBufferSource();
      source.buffer = rig.buffer;
      source.playbackRate.value = speed;
      rig.gain ??= this.audioCtx.createGain();
      rig.gain.gain.value = Math.pow(10, gainDb / 20);
      source.connect(rig.gain);
      rig.gain.connect(this.audioCtx.destination);
      source.start(0, Math.max(0, offset));
      rig.source = source;
      rig.workletActive = false;
      source.onended = () => { if (rig.source === source) rig.source = null; };
    }
    rig.startedAt = this.audioCtx.currentTime;
    rig.startOffset = offset;
    rig.speed = speed;
  }

  /** rig → asset_id（IR 段表反查；流式喂块用）。 */
  private assetOfRig(rig: AudioRig): string {
    const segment = this.ir.segments.find(item => this.audioRigs.get(item.clip_id) === rig);
    const input = this.ir.inputs.find(item => item.input_id === segment?.input_id);
    return input?.asset_id ?? "";
  }

  private stopAudioSource(rig: AudioRig): void {
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
        rig.gain!.gain.value = Math.pow(10, cfg.gainDb / 20);
        continue;
      }
      // 无音源（入场/解码完成/出段后重入）或实质漂移（时钟重锚）→ 对齐重启。
      this.startAudioSource(rig, cfg.gainDb, expected, speed);
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
    /** 纹理来源解析：ring 槽位 / 影子槽 / 静图；未就绪返回 null（跳过绘制）。 */
    const sourceOf = (inputId: string, srcN: number, shadow: boolean): DrawCommand | null => {
      const rig = this.rigs.get(inputId);
      if (!rig) return null;
      if (rig.kind === "image") return { op: "draw", inputId, image: true };
      if (shadow) {
        return rig.shadowUploaded === srcN ? { op: "draw", inputId, shadow: true } : null;
      }
      const index = this.ringSlotIndex(rig, srcN);
      return index >= 0 ? { op: "draw", inputId, slot: index } : null;
    };
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
      if (target - this.currentFrame > PreviewSession.LAG_REANCHOR) {
        editorPerf.record("reanchor", 0, this.perfId, 0, this.seekEpoch, this.currentFrame);
        this.anchorFrame = this.currentFrame;
        this.anchorWall = now;
      } else if (target - this.currentFrame > 1 && target > this.currentFrame) {
        // 丢帧口径 = 展示落后时钟 ≥2 帧（持续 1 帧滞后是 60Hz 时钟对 30fps
        // 内容的正常管线延迟，观感无损——此前按 tick 计成 303"丢帧"）。
        this.dropped += 1;
        this.droppedLifetime += 1;
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
      if (this.currentFrame >= last || (target >= last && now - this.lastAdvanceWall > 2000)) {
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
    return {
      task_ms_p50: p(times, 0.5),
      task_ms_p95: p(times, 0.95),
      dropped_frames: this.dropped,
      composed_frames: this.taskTimes.length,
      last_error: this.lastError,
      decode_ms_p50: p(decodes, 0.5),
      decode_ms_p95: p(decodes, 0.95),
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
