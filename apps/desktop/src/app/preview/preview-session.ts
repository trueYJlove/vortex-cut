/** 合成预览会话：持有解码 worker、纹理状态与 WebGL2 合成器，对外提供
 * play/pause/seek 与时间/指标回调。
 *
 * 播放架构（M3-2.2 重构，修复"每 tick 反应式请求 + 单 pendingResolve 覆盖 +
 * 只合成精确目标帧"导致的冻结/丢帧/僵尸解码）：
 * - 每输入一条顺序解码链（prefetch chain）：按 IR 帧序单调推进 src_n，深度 1
 *   在途、完成后立刻续链（不等 rAF tick），解码器保持热态（每帧喂下个采样）；
 * - 每输入一个环形纹理池（RING）：解码帧上传到独立槽位，链超前 LEAD 帧也不
 *   覆盖当前合成所需内容；上传 await 完成后才标记就绪（修复"Y 已传/UV 未传
 *   → 合成出绿块"的竞态）；
 * - 合成取 ≤ 墙钟目标的最新就绪帧（不丢已就绪帧）；落后超过 LAG_REANCHOR 帧
 *   时重锚时钟（播放放慢而非画面冻结 + 丢帧暴涨）；
 * - seek（暂停态）仍走并行解码后合成，但同样经环形/影子槽位（await 后就绪），
 *   并同步链游标（回播放不触发无谓冷启）。 */
import { Compositor, assertHardwareRenderer } from "./compositor.js";
import type { Ir, IrContent, IrFrame } from "./ir.js";
import { DecodeWorker } from "./decode-worker.js";

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
}

type TexPair = { y: WebGLTexture; uv: WebGLTexture | null };

interface RingSlot { y: WebGLTexture; uv: WebGLTexture; srcN: number }

interface InputRig {
  kind: "video" | "image";
  worker: DecodeWorker | null;
  handle: import("./compositor.js").VideoHandle;
  /** 播放/seek 共用的环形纹理池：解码帧按序占用槽位，srcN=-1 表示空。 */
  ring: RingSlot[];
  ringSeq: number;
  /** 顺序解码链游标：已向 worker 请求的最大 src_n（seek 上传后同步）。 */
  fed: number;
  /** 在途链请求的 src_n（深度 1）。 */
  inFlightN: number | null;
  /** 转场共享输入第二帧槽位（单槽，await 完成后才置值）。 */
  shadowUploaded: number;
  /** 影子槽在途请求 src_n。 */
  shadowInFlight: number | null;
  /** 同一输入的纹理上传串行尾（杜绝同槽 copyTo/texImage2D 交错）。 */
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

export class PreviewSession {
  private readonly compositor: Compositor;
  private readonly rigs = new Map<string, InputRig>();
  private rafId = 0;
  private playing = false;
  private anchorWall = 0;
  private anchorFrame = 0;
  private currentFrame = 0;
  private latestTarget = 0;
  private taskTimes: number[] = [];
  private decodeTimes: number[] = [];
  private decodeInFlight = 0;
  private dropped = 0;
  private disposed = false;
  private seekEpoch = 0;
  private lastSeekWall = 0;
  private lastSeekMs = 0;
  private dragMode = false;
  lastError: string | null = null;
  onTimeUs: ((us: number) => void) | null = null;
  /** 自然播放到片尾时回调（UI 复位播放按钮；会话已内部 pause）。 */
  onEnded: (() => void) | null = null;

  /** 环形纹理池深度：LEAD 超前 + 当前合成 + 在途 1，取 6 留余量。 */
  private static readonly RING = 6;
  /** 预读超前帧数（吸收转场/换段冷启路径的解码尖峰）。 */
  private static readonly LEAD = 5;
  /** 合成落后目标超过该帧数 → 重锚时钟（放慢播放，禁止目标无限狂奔）。 */
  private static readonly LAG_REANCHOR = 10;
  /** 合成时向历史回溯的最大帧数（starving 后取最近就绪帧）。 */
  private static readonly BACKSCAN = 15;

  private constructor(readonly ir: Ir, canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas, ir);
  }

  static async create(canvas: HTMLCanvasElement, ir: Ir,
                      tickets: Map<string, string>): Promise<PreviewSession> {
    const session = new PreviewSession(ir, canvas);
    const sourceWidth = new Map<string, number>();
    for (const input of ir.inputs) {
      const ticket = tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      const rig: InputRig = {
        kind: input.asset_kind === "image" ? "image" : "video",
        worker: null,
        handle: session.compositor.registerTextureOnly(input.input_id),
        ring: [],
        ringSeq: 0,
        fed: -1,
        inFlightN: null,
        shadowUploaded: -1,
        shadowInFlight: null,
        uploadTail: Promise.resolve(),
      };
      if (rig.kind === "image") {
        // 静图：Image 元素解码 → RGBA 纹理一次上传，src_n 恒 0 全程复用
        const image = new Image();
        image.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`image load failed: ${input.asset_id}`));
          image.src = ticket;
        });
        session.compositor.uploadImageFrame(rig.handle, image);
      } else {
        rig.worker = await DecodeWorker.create(ticket);
        sourceWidth.set(input.input_id, input.geometry.width);
      }
      session.rigs.set(input.input_id, rig);
    }
    // LOD 依据真实源宽（此前恒 1920：682 宽画中画被过度降采样模糊）
    session.compositor.setSourceWidthScale(sourceWidth);
    const adapter = session.compositor.gpuRendererInfo();
    if (assertHardwareRenderer(adapter.adapter).software) {
      throw new Error(`software rendering detected: ${adapter.adapter}`);
    }
    return session;
  }

  get adapterDescription(): string {
    return this.compositor.gpuRendererInfo().adapter;
  }

  async loadCaptionFont(buffer: ArrayBuffer): Promise<void> {
    await this.compositor.ensureCaptionFont(buffer, "AppCaptionCJK");
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 诊断快照：各输入解码链游标/在途/环形内容 + 最近解码回执（m3p5 探针）。 */
  chainState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const [inputId, rig] of this.rigs) {
      state[inputId] = {
        fed: rig.fed,
        inFlight: rig.inFlightN,
        ring: rig.ring.filter(slot => slot).map(slot => slot.srcN),
        shadow: rig.shadowUploaded,
        last_decode: rig.worker?.lastFrameInfo ?? null,
      };
    }
    return state;
  }

  /** 用户驱动的向后跳转（回卷重播/回退 seek）后重置解码链：游标回 -1，
   * pump 冷启重建（worker 冷启路径实证干净）。 */
  private resetChains(): void {
    for (const [, rig] of this.rigs) {
      rig.fed = -1;
      rig.inFlightN = null;
      rig.shadowInFlight = null;
    }
  }

  /** 预览框尺寸变化（CSS px）：后备缓冲随盒子、IR 画布 contain 居中。 */
  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.compositor.setViewportBacking(cssWidth * dpr, cssHeight * dpr);
    // 画布尺寸变化会清空绘制缓冲：立即重呈现当前帧（纹理已在环形槽内，零解码）
    const frame = this.ir.frames[Math.min(this.currentFrame, this.ir.frames.length - 1)];
    if (frame && this.frameReady(frame)) this.compose(frame);
  }

  /** 环形槽位上传（经每输入串行尾；await 完成后才标记 srcN 就绪）。 */
  private uploadRing(rig: InputRig, srcN: number): Promise<void> {
    if (!rig.worker) return Promise.reject(new Error(`no worker for input`));
    const slotIndex = rig.ringSeq % PreviewSession.RING;
    rig.ringSeq += 1;
    const task = async (): Promise<void> => {
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
      const slot = rig.ring[slotIndex] ??= {
        y: this.compositor.createYuvTexture(), uv: this.compositor.createYuvTexture(), srcN: -1,
      };
      await this.compositor.uploadVideoFrameToTextures(decoded, slot.y, slot.uv);
      slot.srcN = srcN; // Y+UV 上传全部完成后才可被合成/就绪判定看见
      rig.fed = srcN; // 与 worker 热态游标同步（回退 seek/冷启后 worker 游标亦回退）
    };
    const run = rig.uploadTail.then(task, task);
    rig.uploadTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 影子槽上传（转场共享输入第二帧；单槽，同样 await 后就绪）。 */
  private uploadShadow(rig: InputRig, srcN: number): Promise<void> {
    if (!rig.worker) return Promise.reject(new Error(`no worker for input`));
    const task = async (): Promise<void> => {
      const decodeStart = performance.now();
      this.decodeInFlight += 1;
      try {
        const decoded = await rig.worker!.decode(srcN, this.ir.canvas.fps);
        this.decodeTimes.push(performance.now() - decodeStart);
        if (this.decodeTimes.length > 600) this.decodeTimes.splice(0, this.decodeTimes.length - 600);
        await this.compositor.uploadVideoFrameToTextures(decoded,
          this.compositor.shadowYTexture(rig.handle.inputId), this.compositor.shadowUVTexture(rig.handle.inputId));
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

  /** 环形池中查找已就绪槽位。 */
  private ringSlot(rig: InputRig, srcN: number): RingSlot | null {
    for (const slot of rig.ring) if (slot && slot.srcN === srcN) return slot;
    return null;
  }

  /** 目标帧全部输入是否就绪（环形槽/影子槽/静图）。 */
  private frameReady(frame: IrFrame): boolean {
    const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
    for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
    return needs.every(([inputId, srcN, shadow]) => {
      const rig = this.rigs.get(inputId);
      if (!rig) return false;
      if (rig.kind === "image") return true;
      return shadow ? rig.shadowUploaded === srcN : this.ringSlot(rig, srcN) !== null;
    });
  }

  /** 为帧解析可绘制纹理对；静图返回 RGBA 主纹理（uv=null 走 RGBA 模式）。 */
  private texturesFor(inputId: string, srcN: number, shadow: boolean): TexPair | null {
    const rig = this.rigs.get(inputId);
    if (!rig) return null;
    if (rig.kind === "image") return { y: rig.handle.textureY, uv: null };
    if (shadow) {
      return rig.shadowUploaded === srcN
        ? { y: this.compositor.shadowYTexture(inputId), uv: this.compositor.shadowUVTexture(inputId) }
        : null;
    }
    const slot = this.ringSlot(rig, srcN);
    return slot ? { y: slot.y, uv: slot.uv } : null;
  }

  /**
   * 顺序预读链：对每个输入把解码游标单调推进到 [前沿, target+LEAD] 窗口内的
   * 展示需求 src_n；展示需求之间的跳帧采样由 worker 热态连续喂入内部消化
   * （输出延迟关闭），链深度 1、完成即续（不等 rAF tick）。
   * - 冷启动（fed=-1，输入首次入窗）直接请求首个展示需求（worker 回退最近
   *   关键帧，一个请求直达）；
   * - 展示前沿回跳：回卷重播/回头后前沿帧所需采样已被消费且不在环内
   *   → 向后跳（worker 冷启承接）。常规播放前沿贴合目标，不触发。
   * 跳帧喂入 + 中间输出关闭的组合在部分硬件解码器上会破坏 GOP 参考链——
   * 已用中间帧延迟关闭环 + GOP 锚持有抑制（evidence/m3_2/playback-repro）。
   */
  private pump(target: number): void {
    const from = Math.max(0, this.currentFrame, target - PreviewSession.BACKSCAN);
    const to = Math.min(target + PreviewSession.LEAD, this.ir.frames.length - 1);
    const needsByInput = new Map<string, Set<number>>();
    for (let n = from; n <= to; n++) {
      const frame = this.ir.frames[n]!;
      const needs: Array<[string, number, boolean]> = [...mainNeeds(frame)];
      for (const [inputId, srcN] of overlayNeeds(frame)) needs.push([inputId, srcN, false]);
      for (const [inputId, srcN, shadow] of needs) {
        if (shadow) continue;
        let set = needsByInput.get(inputId);
        if (!set) { set = new Set<number>(); needsByInput.set(inputId, set); }
        set.add(srcN);
      }
    }
    for (const [inputId, needs] of needsByInput) {
      const rig = this.rigs.get(inputId);
      if (!rig || rig.kind !== "video") continue;
      const sorted = [...needs].sort((a, b) => a - b);
      const max = sorted[sorted.length - 1]!;
      // 正向单调推进（fed=-1 冷启动：从首个展示需求起，worker 回退最近关键帧）。
      // 向后跳转只发生在用户动作（回卷重播/回退 seek）——由 resetChains() 显式
      // 重置链游标，pump 本身不做启发式回跳（避免深窗口陈旧需求引发震荡）。
      let next = rig.fed < 0 ? sorted[0]! : rig.fed + 1;
      while (next <= max && this.ringSlot(rig, next)) {
        rig.fed = next;
        next += 1;
      }
      if (next > max || rig.inFlightN !== null || rig.shadowInFlight !== null) continue;
      rig.fed = next;
      rig.inFlightN = next;
      void this.uploadRing(rig, next)
        .catch(error => this.noteDecodeError(inputId, next, error))
        .finally(() => {
          if (rig.inFlightN === next) rig.inFlightN = null;
          if (!this.disposed && this.playing) this.pump(this.latestTarget);
        });
    }
    // 转场影子槽（共享输入第二帧）：直发（await 后就绪；窗口内单帧）
    for (let n = target; n <= to; n++) {
      for (const [inputId, srcN, shadow] of mainNeeds(this.ir.frames[n]!)) {
        if (!shadow) continue;
        const rig = this.rigs.get(inputId);
        if (!rig || rig.kind !== "video" || rig.shadowUploaded === srcN || rig.shadowInFlight !== null) continue;
        rig.shadowInFlight = srcN;
        void this.uploadShadow(rig, srcN)
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

  /** 同步合成一帧（纹理必须已就绪）。 */
  private compose(frame: IrFrame): void {
    const main = frame.main;
    this.compositor.beginFrame();
    if (main.kind === "segment") {
      const pair = this.texturesFor(main.input_id, main.src_n, false);
      if (pair) {
        this.compositor.drawTextures(main.input_id, pair.y, pair.uv,
          shiftedRect(main.content, main.shift), main.alpha, main.rotation_deg ?? 0);
      }
    } else if (main.kind === "transition") {
      const shared = main.left.input_id === main.right.input_id;
      const left = this.texturesFor(main.left.input_id, main.left.src_n, shared);
      const right = this.texturesFor(main.right.input_id, main.right.src_n, false);
      if (left && right) this.compositor.drawTransitionWithPairs(left, right, main);
    }
    for (const overlay of frame.overlays) {
      const pair = this.texturesFor(overlay.input_id, overlay.src_n, false);
      if (pair) this.compositor.drawTextures(overlay.input_id, pair.y, pair.uv, overlay.box, overlay.alpha, overlay.rotation_deg);
    }
    this.compositor.drawCaptionsOf(frame);
    this.compositor.endFrame();
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
      const ready = shadow ? rig.shadowUploaded === srcN : this.ringSlot(rig, srcN) !== null;
      if (!ready) requests.push(shadow ? this.uploadShadow(rig, srcN) : this.uploadRing(rig, srcN));
    }
    if (!this.dragMode) {
      for (const [inputId, srcN] of overlayNeeds(frame)) {
        const rig = this.rigs.get(inputId);
        if (!rig || rig.kind === "image") continue;
        if (this.ringSlot(rig, srcN)) continue;
        requests.push(this.uploadRing(rig, srcN));
      }
    }
    await Promise.all(requests);
    if (epoch !== this.seekEpoch) return -1; // 已被更新的 seek 取代
    this.lastSeekMs = performance.now() - now;
    if (this.frameReady(frame)) this.compose(frame);
    this.onTimeUs?.(frame.t_us);
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
    this.anchorWall = performance.now();
    this.anchorFrame = this.currentFrame;
    const frameDur = 1000 / this.ir.canvas.fps;
    const tick = () => {
      if (!this.playing || this.disposed) return;
      const now = performance.now();
      const target = Math.min(last, Math.floor(this.anchorFrame + (now - this.anchorWall) / frameDur));
      this.latestTarget = target;
      this.pump(target);
      // 合成 ≤ 目标的最新就绪帧：已就绪帧绝不丢弃；starving 时保持最后画面
      let composed = -1;
      const floor = Math.max(0, Math.max(this.currentFrame - 1, target - PreviewSession.BACKSCAN));
      for (let n = target; n >= floor; n--) {
        if (this.frameReady(this.ir.frames[n]!)) { composed = n; break; }
      }
      if (composed >= 0 && composed >= this.currentFrame) {
        const taskStart = performance.now();
        this.compose(this.ir.frames[composed]!);
        this.taskTimes.push(performance.now() - taskStart);
        if (this.taskTimes.length > 1200) this.taskTimes.splice(0, this.taskTimes.length - 1200);
        this.currentFrame = composed;
        this.onTimeUs?.(this.ir.frames[composed]!.t_us);
      }
      // 饥饿护栏：落后过多 → 重锚时钟（播放按解码吞吐放慢），而不是让目标
      // 无限狂奔、丢帧按 tick 线性堆积（旧实现冻结+丢帧 404 的直接根源）。
      if (target - this.currentFrame > PreviewSession.LAG_REANCHOR) {
        this.anchorFrame = this.currentFrame;
        this.anchorWall = now;
      } else if (composed < target && target > this.currentFrame) {
        this.dropped += 1; // 目标帧未按时就绪：诚实计一次丢帧
      }
      if (target >= last) {
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
  }

  metrics(): PreviewSessionMetrics {
    const times = [...this.taskTimes].sort((a, b) => a - b);
    const decodes = [...this.decodeTimes].sort((a, b) => a - b);
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
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    for (const [, rig] of this.rigs) rig.worker?.terminate();
    this.rigs.clear();
  }
}
