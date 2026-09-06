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
import type { DrawCommand } from "./compositor-worker.worker.js";
import type { Ir, IrContent, IrFrame } from "./ir.js";
import { DecodeWorker } from "./decode-worker.js";

/** 片段音频配置（编辑态：App 从时间线文档透传）。 */
export interface SegmentAudioConfig { enabled: boolean; gainDb: number }

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
}

interface RingSlot { srcN: number }

interface InputRig {
  kind: "video" | "image";
  worker: DecodeWorker | null;
  /** 播放/seek 共用的环形簿记：槽位按 ringSeq 轮转，srcN=-1 表示空。 */
  ring: Array<RingSlot | null>;
  ringSeq: number;
  /** 顺序解码链游标：已向 worker 请求的最大 src_n（seek 上传后同步）。 */
  fed: number;
  /** 在途链请求的 src_n（深度 1）。 */
  inFlightN: number | null;
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
  private lastAdvanceWall = 0;
  lastError: string | null = null;
  /** 诊断：seek 纪元作废的上传任务数（scrub 开销定位用）。 */
  skippedUploads = 0;
  /** 诊断：worker 上传分步采样（copyTo/tex 毫秒）。 */
  get uploadSplitDebug(): Array<{ copyToMs: number; texMs: number }> {
    return this.compositor?.uploadSplit ?? [];
  }
  onTimeUs: ((us: number) => void) | null = null;
  private tickets: Map<string, string> | null = null;
  private audioByClip: Map<string, SegmentAudioConfig> | null = null;
  private audioCtx: AudioContext | null = null;
  private readonly audioRigs = new Map<string, { buffer: AudioBuffer | null; source: AudioBufferSourceNode | null; gain: GainNode | null; startedAt: number; startOffset: number; speed: number }>();
  /** 音频漂移硬校正阈值（秒）：WebAudio 自身不漂，只有时钟重锚才触达。 */
  private static readonly AUDIO_REANCHOR_S = 0.08;
  /** 自然播放到片尾时回调（UI 复位播放按钮；会话已内部 pause）。 */
  onEnded: (() => void) | null = null;

  /** 视口适配（等比 contain）：IR 画布 → 后备缓冲（会话侧权威，resize 下发 worker）。 */
  private fitX = 0;
  private fitY = 0;
  private fitScale = 1;
  private backing = { width: 2, height: 2 };
  /** 尺寸变化 rAF 合帧重呈现（连续拖拽窗口不逐帧重建）。 */
  private recomposeRaf = 0;

  /** 环形纹理池深度：LEAD 超前 + 当前合成 + 在途 1 + 提前入场 1，取 8 留余量。 */
  private static readonly RING = 8;
  /** 预读超前帧数（吸收转场/换段冷启路径的解码尖峰）。 */
  private static readonly LEAD = 5;
  /** 新输入入场提前量：首次入窗的输入提前 ~1.5s 冷启。 */
  private static readonly LEAD_ENTER = 45;
  /** 合成落后目标超过该帧数 → 重锚时钟。 */
  private static readonly LAG_REANCHOR = 10;
  /** 合成时向历史回溯的最大帧数（starving 后取最近就绪帧）。 */
  private static readonly BACKSCAN = 15;

  ir: Ir;
  private constructor(ir: Ir) {
    this.ir = ir;
  }

  static async create(container: HTMLElement, ir: Ir,
                      tickets: Map<string, string>,
                      audioByClip?: Map<string, SegmentAudioConfig>): Promise<PreviewSession> {
    const session = new PreviewSession(ir);
    session.container = container;
    session.tickets = tickets;
    session.audioByClip = audioByClip ?? null;
    const canvas = document.createElement("canvas");
    canvas.className = "synthetic-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.textContent = "";
    container.appendChild(canvas);
    session.canvasEl = canvas;
    const { CompositorWorkerClient } = await import("./compositor-worker.js");
    const client = await CompositorWorkerClient.create(canvas, {
      inputs: ir.inputs.filter(input => input.asset_kind !== "audio").map(input => ({
        inputId: input.input_id,
        sourceWidth: input.geometry.width || 1920,
        width: input.geometry.width || 16,
        height: input.geometry.height || 9,
      })),
      ringDepth: PreviewSession.RING,
      canvasWidth: ir.canvas.width,
      canvasHeight: ir.canvas.height,
      captionStyles: ir.caption_styles,
    });
    session.compositor = client;
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
        ring: Array.from({ length: PreviewSession.RING }, () => null),
        ringSeq: 0,
        fed: -1,
        inFlightN: null,
        shadowUploaded: -1,
        shadowInFlight: null,
        uploadTail: Promise.resolve(),
      };
      if (rig.kind === "image") {
        // 静图：解码为 ImageBitmap → transfer 到 worker 一次上传，src_n 恒 0 全程复用
        const image = new Image();
        image.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`image load failed: ${input.asset_id}`));
          image.src = ticket;
        });
        const bitmap = await createImageBitmap(image);
        client.uploadImage(input.input_id, bitmap);
      } else {
        rig.worker = await DecodeWorker.create(ticket);
      }
      session.rigs.set(input.input_id, rig);
    }
    // 片段音频：AudioContext + 整段解码（eager 预热，运行中才解码会缺席整段）。
    if (audioByClip && audioByClip.size && typeof window !== "undefined" && "AudioContext" in window) {
      session.audioCtx = new AudioContext();
      for (const segment of ir.segments) {
        if (!audioByClip.get(segment.clip_id)?.enabled) continue;
        session.audioRigs.set(segment.clip_id, { buffer: null, source: null, gain: null, startedAt: 0, startOffset: 0, speed: Math.max(0.25, Math.min(4, segment.speed_milli / 1000)) });
        void session.ensureAudioBuffer(segment.clip_id, segment.input_id);
      }
    }
    return session;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.canvasEl;
  }

  private readonly contextLostResolvers: Array<() => void> = [];

  /** 字幕字体（transfer 到 worker 的 FontFaceSet；worker 侧字体就绪后强制重绘字幕层）。 */
  async loadCaptionFont(buffer: ArrayBuffer): Promise<void> {
    this.compositor?.setFont(buffer, "AppCaptionCJK");
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
      if (rig.source && (!cfg || !cfg.enabled)) this.stopAudioSource(rig);
    }
  }

  /** 当前帧画中画几何（IR 画布坐标）——合成画布手势层消费。 */
  pipBoxes(): Array<{ clipId: string; x: number; y: number; w: number; h: number }> {
    const frame = this.ir.frames[Math.min(this.currentFrame, this.ir.frames.length - 1)];
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
   *  输入集合变化（加删素材）返回 false，调用方走整会话重建。 */
  replaceIr(nextIr: Ir): boolean {
    const sig = (ir: Ir) => JSON.stringify(ir.inputs.map(item => [item.input_id, item.asset_id, item.asset_kind, item.geometry]));
    if (sig(this.ir) !== sig(nextIr)) return false;
    this.ir = nextIr;
    this.resetChains();
    this.recomposeSoon();
    return true;
  }

  /** 画中画中心点就地补丁：直改 IR 帧几何并重呈现（免会话重建，拖拽实时跟随）。
   *  静态 transform 作用于片段全区间——范围内所有含该 overlay 的帧一并更新。 */
  setPipCenter(clipId: string, x: number, y: number): void {
    const overlay = this.ir.frames.flatMap(frame => frame.overlays).find(item => item.clip_id === clipId);
    if (!overlay) return;
    const w = this.ir.canvas.width;
    const h = this.ir.canvas.height;
    this.setPipBox(clipId, x * w, y * h, overlay.box.w, overlay.box.h);
  }

  /** 画中画几何就地补丁（缩放手势）：中心点 + 尺寸均为画布像素，作用于片段
   *  全区间帧。move 手势可复用（仅改中心、尺寸取当前值）。 */
  setPipBox(clipId: string, cx: number, cy: number, w: number, h: number): void {
    for (const frame of this.ir.frames) {
      for (const overlay of frame.overlays) {
        if (overlay.clip_id !== clipId) continue;
        overlay.box = { x: cx - w / 2, y: cy - h / 2, w, h };
      }
    }
    this.recomposeSoon();
  }

  /** 画中画旋转就地补丁（旋转手势）：度数作用于片段全区间帧。 */
  setPipRotation(clipId: string, deg: number): void {
    for (const frame of this.ir.frames) {
      for (const overlay of frame.overlays) {
        if (overlay.clip_id !== clipId) continue;
        overlay.rotation_deg = deg;
      }
    }
    this.recomposeSoon();
  }

  /** 诊断快照：各输入解码链游标/在途/环形内容 + 最近解码回执（m3p5 探针）。 */
  chainState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const [inputId, rig] of this.rigs) {
      state[inputId] = {
        fed: rig.fed,
        inFlight: rig.inFlightN,
        ring: rig.ring.filter(slot => slot).map(slot => slot!.srcN),
        shadow: rig.shadowUploaded,
        last_decode: rig.worker?.lastFrameInfo ?? null,
      };
    }
    return state;
  }

  /** 用户驱动的向后跳转（回卷重播/回退 seek）后重置解码链：游标回 -1，
   *  pump 冷启重建（worker 冷启路径实证干净）。 */
  private resetChains(): void {
    for (const [, rig] of this.rigs) {
      rig.fed = -1;
      rig.inFlightN = null;
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
      const frame = this.ir.frames[Math.min(this.currentFrame, this.ir.frames.length - 1)];
      if (frame && this.frameReady(frame)) this.compose(frame);
    });
  }

  /** 环形槽位上传（经每输入串行尾；worker 上传 ack 后才标记 srcN 就绪）。
   *  过期作废：任务排队期间到来新 seek（seekEpoch 变化）→ 预取目标已失效，
   *  直接作废（解码前后双重检查；作废帧 close 释放）——否则 scrub 时新 seek
   *  的上传会排在整条过期预取队尾（worker 化后每任务含双跳 RTT，实测 seek
   *  p95 翻倍的根因）。 */
  private uploadRing(rig: InputRig, inputId: string, srcN: number): Promise<void> {
    if (!rig.worker) return Promise.reject(new Error(`no worker for input`));
    const slotIndex = rig.ringSeq % PreviewSession.RING;
    rig.ringSeq += 1;
    const epoch = this.seekEpoch;
    const task = async (): Promise<void> => {
      if (epoch !== this.seekEpoch) { this.skippedUploads += 1; return; }
      const decodeStart = performance.now();
      this.decodeInFlight += 1;
      let decoded: VideoFrame;
      try {
        decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        this.decodeTimes.push(performance.now() - decodeStart);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
      } finally {
        this.decodeInFlight -= 1;
      }
      if (epoch !== this.seekEpoch) { this.skippedUploads += 1; decoded.close(); return; }
      const uploadStart = performance.now();
      await this.compositor!.upload(inputId, slotIndex, srcN, decoded);
      this.uploadTimes.push(performance.now() - uploadStart);
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
      this.decodeInFlight += 1;
      try {
        const decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        this.decodeTimes.push(performance.now() - decodeStart);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
        if (epoch !== this.seekEpoch) { decoded.close(); return; }
        await this.compositor!.uploadShadow(inputId, srcN, decoded);
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
    const from = Math.max(0, this.currentFrame, target - PreviewSession.BACKSCAN);
    const to = Math.min(target + PreviewSession.LEAD, this.ir.frames.length - 1);
    const toEnter = Math.min(target + PreviewSession.LEAD_ENTER, this.ir.frames.length - 1);
    const needsByInput = new Map<string, Set<number>>();
    const enterNeeds = new Map<string, Set<number>>();
    const collectNeeds = (fromN: number, toN: number, into: Map<string, Set<number>>) => {
      for (let n = fromN; n <= toN; n++) {
        const frame = this.ir.frames[n]!;
        const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
        for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
        for (const [inputId, srcN, shadow] of needs) {
          if (shadow) continue;
          let set = into.get(inputId);
          if (!set) { set = new Set<number>(); into.set(inputId, set); }
          set.add(srcN);
        }
      }
    };
    collectNeeds(from, to, needsByInput);
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
      const max = sorted[sorted.length - 1]!;
      // 正向单调推进（冷启动首个请求直达入场点）。
      // 向后跳转只发生在用户动作（回卷重播/回退 seek）——由 resetChains() 显式
      // 重置链游标，pump 本身不做启发式回跳（避免深窗口陈旧需求引发震荡）。
      let next = rig.fed < 0 ? sorted[0]! : rig.fed + 1;
      while (next <= max && this.ringSlotIndex(rig, next) >= 0) {
        rig.fed = next;
        next += 1;
      }
      if (next > max || rig.inFlightN !== null || rig.shadowInFlight !== null) continue;
      rig.fed = next;
      rig.inFlightN = next;
      void this.uploadRing(rig, inputId, next)
        .catch(error => this.noteDecodeError(inputId, next, error))
        .finally(() => {
          if (rig.inFlightN === next) rig.inFlightN = null;
          if (!this.disposed && this.playing) this.pump(this.latestTarget);
        });
    }
    // 转场影子槽（共享输入第二帧）：直发（ack 后就绪；窗口内单帧）
    for (let n = target; n <= to; n++) {
      for (const [inputId, srcN, shadow] of mainNeeds(this.ir.frames[n]!)) {
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

  /** 解码片段素材的整段音频（aivideo:// 票据 → fetch → decodeAudioData）。 */
  private async ensureAudioBuffer(clipId: string, inputId: string): Promise<void> {
    if (!this.audioCtx || this.disposed) return;
    const rig = this.audioRigs.get(clipId);
    if (!rig || rig.buffer) return;
    const input = this.ir.inputs.find(item => item.input_id === inputId);
    const ticket = input ? this.tickets?.get(input.asset_id) : undefined;
    if (!ticket) return;
    try {
      const data = await (await fetch(ticket)).arrayBuffer();
      if (this.disposed || !this.audioCtx) return;
      rig.buffer = await this.audioCtx.decodeAudioData(data);
      this.recomposeSoon(); // 解码完成：若片段正活跃，下次 tick 启动音源
    } catch (error) {
      if (!this.disposed) this.lastError = `音频解码失败 ${clipId}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 启动/重启一个片段音源：从缓冲 offset 起以 speed 播放（ctx 时间锚定）。 */
  private startAudioSource(rig: { buffer: AudioBuffer | null; source: AudioBufferSourceNode | null; gain: GainNode | null; startedAt: number; startOffset: number; speed: number }, gainDb: number, offset: number, speed: number): void {
    if (!this.audioCtx || !rig.buffer) return;
    this.stopAudioSource(rig);
    const source = this.audioCtx.createBufferSource();
    source.buffer = rig.buffer;
    source.playbackRate.value = speed;
    rig.gain ??= this.audioCtx.createGain();
    rig.gain.gain.value = Math.pow(10, gainDb / 20);
    source.connect(rig.gain);
    rig.gain.connect(this.audioCtx.destination);
    source.start(0, Math.max(0, offset));
    rig.source = source;
    rig.startedAt = this.audioCtx.currentTime;
    rig.startOffset = offset;
    rig.speed = speed;
    source.onended = () => { if (rig.source === source) rig.source = null; };
  }

  private stopAudioSource(rig: { source: AudioBufferSourceNode | null }): void {
    const source = rig.source;
    rig.source = null;
    if (!source) return;
    try { source.stop(); } catch { /* 已停止 */ }
    source.disconnect();
  }

  /** 片段音频跟随时钟（WebAudio 调度）：音源运行在音频线程时钟上，本函数只做
   *  节拍管理——进段启动、出段停止、漂移超阈值（时钟重锚）才硬校正。播放中
   *  由合成 tick 以**墙钟目标时间**驱动节拍（合成滞后不影响音频推进）。
   * 段窗口用 IR 的 output_*（转场借用重映射后的输出时间轴）；速度经
   * playbackRate；gainDb → 线性增益（无 1.0 上限）。 */
  private syncAudio(tUs: number): void {
    if (!this.audioByClip || !this.audioCtx) return;
    const active = new Set<string>();
    for (const segment of this.ir.segments) {
      const cfg = this.audioByClip.get(segment.clip_id);
      if (!cfg || !cfg.enabled) continue;
      const startUs = segment.output_start_us ?? segment.timeline_start_us;
      const endUs = segment.output_end_us ?? segment.timeline_end_us;
      if (tUs < startUs || tUs > endUs) continue;
      active.add(segment.clip_id);
      const speed = Math.max(0.25, Math.min(4, segment.speed_milli / 1000));
      let rig = this.audioRigs.get(segment.clip_id);
      if (!rig) { rig = { buffer: null, source: null, gain: null, startedAt: 0, startOffset: 0, speed }; this.audioRigs.set(segment.clip_id, rig); }
      if (!rig.buffer) { void this.ensureAudioBuffer(segment.clip_id, segment.input_id); continue; }
      if (!this.playing) { this.stopAudioSource(rig); continue; }
      const expected = clamp(segment.source_start_us / 1e6 + ((tUs - startUs) / 1e6) * speed, segment.source_start_us / 1e6, segment.source_end_us / 1e6);
      const position = rig.source ? rig.startOffset + (this.audioCtx.currentTime - rig.startedAt) * rig.speed : null;
      const drift = position === null ? Infinity : position - expected;
      if (rig.source && Math.abs(drift) <= PreviewSession.AUDIO_REANCHOR_S) {
        if (rig.speed !== speed) { rig.speed = speed; rig.source.playbackRate.value = speed; }
        rig.gain!.gain.value = Math.pow(10, cfg.gainDb / 20);
        continue;
      }
      // 无音源（入场/解码完成/出段后重入）或实质漂移（时钟重锚）→ 对齐重启。
      this.startAudioSource(rig, cfg.gainDb, expected, speed);
    }
    for (const [clipId, rig] of this.audioRigs) {
      if (!active.has(clipId) && rig.source) this.stopAudioSource(rig);
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
        cmds.push({ ...source, rect: overlay.box, alpha: overlay.alpha, rotationDeg: overlay.rotation_deg });
      }
    }
    if (frame.captions.length > 0) {
      const items = frame.captions.map(captionId => {
        const entry = this.ir.captions.find(item => item.caption_id === captionId);
        return entry ? { caption_id: entry.caption_id, text: entry.text, preset_id: entry.preset_id } : null;
      }).filter((item): item is { caption_id: string; text: string; preset_id: string } => item !== null);
      cmds.push({ op: "captions", items });
    }
    compositor.compose(cmds);
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
    // seek 是用户驱动的位置跳变：重置解码链游标（后续 pump/播放冷启重建；环内
    // 已就绪采样仍可直接复用，±1 步进零解码路径保持不变）。
    this.resetChains();
    const now = performance.now();
    this.dragMode = now - this.lastSeekWall < 250;
    this.lastSeekWall = now;
    const index = Math.max(0, Math.min(target, this.ir.frames.length - 1));
    const frame = this.ir.frames[index]!;
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
    await Promise.all(requests);
    if (epoch !== this.seekEpoch) return -1; // 已被更新的 seek 取代
    this.lastSeekMs = performance.now() - now;
    if (this.frameReady(frame)) this.compose(frame);
    this.onTimeUs?.(frame.t_us);
    // 暂停态预热预读链：预解码后续 LEAD 帧——再按播放即有热跑道
    //（消除 seek 后播放头几百毫秒的冷启丢帧）。**拖拽快速档跳过预热**：
    // scrub 风暴中预热解码与下一 seek 的目标解码争抢解码器（实测 seek p95
    // 翻倍）；最终落定（refineAfterDrag，dragMode=false）才预热。
    if (!this.playing && !this.dragMode) this.pump(index);
    return frame.n;
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
    const last = this.ir.frames.length - 1;
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
        if (this.frameReady(this.ir.frames[n]!)) { composed = n; break; }
      }
      if (composed >= 0 && composed > this.currentFrame) {
        const taskStart = performance.now();
        this.compose(this.ir.frames[composed]!);
        this.taskTimes.push(performance.now() - taskStart);
        if (this.taskTimes.length > 1200) this.taskTimes.splice(0, this.taskTimes.length - 1200);
        this.currentFrame = composed;
        this.lastAdvanceWall = now;
        this.onTimeUs?.(this.ir.frames[composed]!.t_us);
      }
      // 饥饿护栏：落后过多 → 重锚时钟（播放按解码吞吐放慢），而不是让目标
      // 无限狂奔、丢帧按 tick 线性堆积（旧实现冻结+丢帧 404 的直接根源）。
      if (target - this.currentFrame > PreviewSession.LAG_REANCHOR) {
        this.anchorFrame = this.currentFrame;
        this.anchorWall = now;
      } else if (target - this.currentFrame > 1 && target > this.currentFrame) {
        // 丢帧口径 = 展示落后时钟 ≥2 帧（持续 1 帧滞后是 60Hz 时钟对 30fps
        // 内容的正常管线延迟，观感无损——此前按 tick 计成 303"丢帧"）。
        this.dropped += 1;
        this.droppedLifetime += 1;
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
    };
  }

  /** 全画布 PNG 回读（worker convertToBlob → ArrayBuffer transfer；探针取证用
   *  ——transfer 后主线程 canvas.toBlob 不可用）。 */
  async readbackPng(): Promise<ArrayBuffer> {
    if (!this.compositor) throw new Error("compositor unavailable");
    return await this.compositor.readback();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    for (const [, rig] of this.audioRigs) this.stopAudioSource(rig);
    this.audioRigs.clear();
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    if (this.recomposeRaf) cancelAnimationFrame(this.recomposeRaf);
    this.recomposeRaf = 0;
    this.compositor?.terminate();
    this.compositor = null;
    for (const [, rig] of this.rigs) rig.worker?.terminate();
    this.rigs.clear();
    this.canvasEl?.remove();
    this.canvasEl = null;
  }
}
