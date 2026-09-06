/** 合成预览会话：持有解码 worker、纹理状态与 WebGL2 合成器，对外提供
 * play/pause/seek 与时间/指标回调。vsync 锁定合成循环（rAF）；播放时解码
 * 流水线深度 1（目标帧未就绪保持最新帧并计丢帧）；seek 为同步解码后合成。 */
import { Compositor, assertHardwareRenderer } from "./compositor.js";
import type { Ir, IrFrame } from "./ir.js";
import { DecodeWorker } from "./decode-worker.js";

export interface PreviewSessionMetrics {
  task_ms_p50: number;
  task_ms_p95: number;
  dropped_frames: number;
  composed_frames: number;
  last_error: string | null;
}

interface SlotState { uploaded: number; pending: number | null }

interface InputRig {
  kind: "video" | "image";
  worker: DecodeWorker | null;
  handle: import("./compositor.js").VideoHandle;
  main: SlotState;
  shadow: SlotState;
}

function neededInputs(frame: IrFrame): string[] {
  const ids = new Set<string>();
  const main = frame.main;
  if (main.kind === "segment") ids.add(main.input_id);
  if (main.kind === "transition") { ids.add(main.left.input_id); ids.add(main.right.input_id); }
  for (const overlay of frame.overlays) ids.add(overlay.input_id);
  return [...ids];
}

function sourceFrameAt(frame: IrFrame, inputId: string): number | null {
  const main = frame.main;
  if (main.kind === "segment" && main.input_id === inputId) return main.src_n;
  if (main.kind === "transition") {
    if (main.left.input_id === inputId) return main.left.src_n;
    if (main.right.input_id === inputId) return main.right.src_n;
  }
  for (const overlay of frame.overlays) {
    if (overlay.input_id === inputId) return overlay.src_n;
  }
  return null;
}

export class PreviewSession {
  private readonly compositor: Compositor;
  private readonly rigs = new Map<string, InputRig>();
  private rafId = 0;
  private playing = false;
  private clockStartWall = 0;
  private clockStartFrame = 0;
  private currentFrame = 0;
  private taskTimes: number[] = [];
  private dropped = 0;
  private disposed = false;
  private seekEpoch = 0;
  private lastSeekWall = 0;
  private lastSeekMs = 0;
  private dragMode = false;
  lastError: string | null = null;
  onTimeUs: ((us: number) => void) | null = null;

  private constructor(readonly ir: Ir, canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas, ir);
  }

  static async create(canvas: HTMLCanvasElement, ir: Ir,
                      tickets: Map<string, string>): Promise<PreviewSession> {
    const session = new PreviewSession(ir, canvas);
    for (const input of ir.inputs) {
      const ticket = tickets.get(input.asset_id);
      if (!ticket) throw new Error(`no ticket for ${input.asset_id}`);
      const rig: InputRig = {
        kind: input.asset_kind === "image" ? "image" : "video",
        worker: null,
        handle: session.compositor.registerTextureOnly(input.input_id),
        main: { uploaded: -1, pending: null },
        shadow: { uploaded: -1, pending: null },
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
        rig.main.uploaded = 0;
      } else {
        rig.worker = await DecodeWorker.create(ticket);
      }
      session.rigs.set(input.input_id, rig);
    }
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

  /** 解码并上传一个（输入, 源帧）到指定槽位；frame 在上传后由 compositor 关闭。 */
  private async upload(inputId: string, srcN: number, shadow: boolean): Promise<void> {
    const rig = this.rigs.get(inputId)!;
    if (rig.kind === "image") { rig.main.uploaded = 0; return; } // 静图已上传
    if (!rig.worker) throw new Error(`no worker for ${inputId}`);
    try {
      const decoded = await rig.worker.decode(srcN, this.ir.canvas.fps);
      this.compositor.uploadVideoFrame(rig.handle, decoded, shadow);
    } catch (error) {
      // 可观测性（M3-2）：解码失败不再静默——记录最近错误供 UI 呈现
      this.lastError = `解码失败 ${inputId}#${srcN}: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
    const slot = shadow ? rig.shadow : rig.main;
    slot.uploaded = srcN;
  }

  /** 目标帧的全部输入纹理是否已就绪（主/影子槽位按需）。 */
  private frameReady(frame: IrFrame): boolean {
    const main = frame.main;
    const checks: Array<[string, number, boolean]> = [];
    if (main.kind === "segment") checks.push([main.input_id, main.src_n, false]);
    if (main.kind === "transition") {
      const shared = main.left.input_id === main.right.input_id;
      checks.push([main.left.input_id, main.left.src_n, shared]);
      checks.push([main.right.input_id, main.right.src_n, false]);
    }
    for (const overlay of frame.overlays) checks.push([overlay.input_id, overlay.src_n, false]);
    return checks.every(([inputId, srcN, shadow]) => {
      const rig = this.rigs.get(inputId);
      if (!rig) return false;
      const slot = shadow ? rig.shadow : rig.main;
      return slot.uploaded === srcN;
    });
  }

  /** 为目标帧发起全部缺失解码（深度 1：同一槽位不重复在途请求）。 */
  private requestMissing(frame: IrFrame): void {
    const main = frame.main;
    const requests: Array<Promise<void>> = [];
    const issue = (inputId: string, srcN: number, shadow: boolean) => {
      const rig = this.rigs.get(inputId)!;
      const slot = shadow ? rig.shadow : rig.main;
      if (slot.uploaded === srcN || slot.pending === srcN) return;
      slot.pending = srcN;
      requests.push(this.upload(inputId, srcN, shadow).finally(() => {
        if (slot.pending === srcN) slot.pending = null;
      }));
    };
    if (main.kind === "segment") issue(main.input_id, main.src_n, false);
    if (main.kind === "transition") {
      const shared = main.left.input_id === main.right.input_id;
      issue(main.left.input_id, main.left.src_n, shared);
      issue(main.right.input_id, main.right.src_n, false);
    }
    for (const overlay of frame.overlays) issue(overlay.input_id, overlay.src_n, false);
    void Promise.all(requests);
  }

  /** 同步合成一帧（纹理必须已就绪）。 */
  private compose(frame: IrFrame): void {
    const main = frame.main;
    this.compositor.beginFrame();
    if (main.kind === "segment") this.compositor.drawMainSegment(main);
    else if (main.kind === "transition") {
      this.compositor.drawTransitionTextures(main, main.left.input_id === main.right.input_id, false);
    }
    this.compositor.drawOverlays(frame);
    this.compositor.drawCaptionsOf(frame);
    this.compositor.endFrame();
  }

  /**
   * seek（暂停态/播放头跳转）：并行解码目标帧 → 合成。
   * - latest-wins（epoch）：新 seek 到来时旧结果的合成被跳过（解码仍完成，
   *   上传结果无害保留）；连续快速 seek 进入拖拽快速档——仅解码主轨输入、
   *   跳过 PiP/转场影子槽，停止 250ms 后由调用方触发全量精修。
   * - 返回实际渲染的帧号（被更新的 seek 取代时为 -1）。
   */
  async seekToFrame(target: number): Promise<number> {
    if (this.disposed) return -1;
    const epoch = ++this.seekEpoch;
    const now = performance.now();
    this.dragMode = now - this.lastSeekWall < 250;
    this.lastSeekWall = now;
    const index = Math.max(0, Math.min(target, this.ir.frames.length - 1));
    const frame = this.ir.frames[index]!;
    this.currentFrame = index;
    const main = frame.main;
    const requests: Array<Promise<void>> = [];
    if (main.kind === "segment") {
      if (this.rigs.get(main.input_id)!.main.uploaded !== main.src_n) {
        requests.push(this.upload(main.input_id, main.src_n, false));
      }
    } else if (main.kind === "transition") {
      const shared = main.left.input_id === main.right.input_id;
      requests.push(this.upload(main.left.input_id, main.left.src_n, shared));
      requests.push(this.upload(main.right.input_id, main.right.src_n, false));
    }
    if (!this.dragMode) {
      for (const overlay of frame.overlays) {
        requests.push(this.upload(overlay.input_id, overlay.src_n, false));
      }
    }
    await Promise.all(requests);
    if (epoch !== this.seekEpoch) return -1; // 已被更新的 seek 取代
    this.lastSeekMs = performance.now() - now;
    this.compose(frame);
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
    this.playing = true;
    this.clockStartWall = performance.now();
    this.clockStartFrame = this.currentFrame;
    const tick = () => {
      if (!this.playing || this.disposed) return;
      const now = performance.now();
      const target = Math.min(this.ir.canvas.duration_frames - 1,
        Math.floor(this.clockStartFrame + (now - this.clockStartWall) / (1000 / this.ir.canvas.fps)));
      const frame = this.ir.frames[target]!;
      this.requestMissing(frame);
      if (this.frameReady(frame)) {
        const taskStart = now;
        this.compose(frame);
        this.taskTimes.push(performance.now() - taskStart);
        this.currentFrame = target;
        this.onTimeUs?.(frame.t_us);
      } else if (target > this.currentFrame + 1) {
        this.dropped += 1; // 目标帧未就绪且已落后超过 1 帧：计丢帧，保持最新画面
      }
      if (target >= this.ir.canvas.duration_frames - 1) {
        this.pause();
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
    const p = (q: number) => times.length ? Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] * 1000) / 1000 : 0;
    return {
      task_ms_p50: p(0.5),
      task_ms_p95: p(0.95),
      dropped_frames: this.dropped,
      composed_frames: this.taskTimes.length,
      last_error: this.lastError,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    for (const [, rig] of this.rigs) rig.worker?.terminate();
    this.rigs.clear();
  }
}
