import { throwIfAborted, workerReady } from "./worker-lifecycle.js";
/** 合成预览 GL 执行器客户端：持有 transferControlToOffscreen 后的 worker 生命周期，
 * 提供类型化 RPC（upload 带 ack、compose 顺序投递、resize/readback 往返）。
 * 会话侧只与本类对话；GL 状态全部在 compositor-worker.worker.ts。 */
import { editorPerf } from "./perf-metrics.js";
import type { DrawCommand, FrameResidency, WorkerRequest, WorkerResponse } from "./compositor-worker.worker.js";

export interface CompositorClientInit {
  inputs: Array<{ inputId: string; sourceWidth: number; width: number; height: number }>;
  ringDepth: number;
  canvasWidth: number;
  canvasHeight: number;
  captionStyles: Record<string, { font_size: number; primary_rgb: [number, number, number]; outline_rgb: [number, number, number]; outline: number; shadow: number; border_style: number; margin_v: number }>;
  /** B13-R 判别诊断开关：强制 copyTo（perf 诊断构建经 runtime 注入）。 */
  forceCopyTo?: boolean;
}

export interface GpuInfo { adapter: string; vendor: string }

export class CompositorWorkerClient {
  private readonly worker: Worker;
  private nextSeq = 1;
  perfSession = 0;
  private readonly submissions = new Map<number, { at: number; generation: number; epoch: number; frame: number }>();
  private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  private disposed = false;
  readonly canvas: HTMLCanvasElement;
  /** upload/uploadShadow 的 ack 期限（与 decode 超时同量级）：worker 存活但
   *  ack 不回时调用方挂起即"事件不齐"的形态（DEFECT-4K60-SEEK 登记路径）。 */
  private static readonly UPLOAD_TIMEOUT_MS = 15_000;
  /** worker 侧 webglcontextlost（会话据此停摆并等待重建）。 */
  onContextLost: (() => void) | null = null;
  /** 就绪信息（探针取证用）。 */
  gpuInfo: GpuInfo = { adapter: "unknown", vendor: "unknown" };
  /** 上传分步采样（copyTo/tex 毫秒，尾随 600 条；探针定位用）。 */
  readonly uploadSplit: Array<{ copyToMs: number; texMs: number }> = [];
  /** B13-R：worker 最近一次驻留计数（ack 捎带 + residencyQuery 主动查询）。 */
  lastResidency: FrameResidency | null = null;
  private lastResidencyAt = 0;

  private constructor(canvas: HTMLCanvasElement) {
    // transferControlToOffscreen 每元素仅可一次，由 create() 统一调用；
    // jsdom 无此 API → 抛错（合成预览回退路径，测试环境确定性）。
    this.canvas = canvas;
    this.worker = new Worker(new URL("./compositor-worker.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", this.onMessageError);
  }

  private readonly onMessage = (event: MessageEvent<WorkerResponse>): void => {
      if (this.disposed) return;
      const data = event.data;
      switch (data.type) {
        case "submitted": {
          const sent = this.submissions.get(data.seq);
          this.submissions.delete(data.seq);
          if (sent && sent.generation === editorPerf.generation) editorPerf.record("submitted", performance.now() - sent.at, this.perfSession, data.seq, sent.epoch, sent.frame);
          break;
        }
        case "uploaded":
        case "uploadedShadow": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          if (data.type === "uploaded") {
            const split = data as { copyToMs: number; texMs: number };
            this.uploadSplit.push({ copyToMs: split.copyToMs, texMs: split.texMs });
            if (this.uploadSplit.length > 600) this.uploadSplit.shift();
          }
          // B13-R：最新驻留计数进 perf 快照 + 事件时间线（限流 1Hz 防事件洪泛）
          const residency = (data as { residency?: FrameResidency }).residency;
          if (residency && editorPerf.enabled) {
            this.lastResidency = residency;
            const now = performance.now();
            if (now - this.lastResidencyAt >= 1000) {
              this.lastResidencyAt = now;
              editorPerf.record("residency", 0, this.perfSession);
              editorPerf.residency = { at: now, decode: { decoded: -1, posted: -1, cached: -1, closed: -1, live: -1, cacheBytes: -1, cacheSize: -1 }, compositor: residency };
            }
          }
          pending?.resolve(data as never);
          break;
        }
        case "inputRegistered":
        case "inputReleased": {
          // B13 ack：纹理字节总量随响应携带（预算统计）
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          pending?.resolve(data as never);
          break;
        }
        case "readback": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          pending?.resolve((data as { buffer: ArrayBuffer }).buffer as never);
          break;
        }
        case "residency": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          this.lastResidency = (data as { residency: FrameResidency }).residency;
          pending?.resolve(this.lastResidency as never);
          break;
        }
        case "uploadError": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          pending?.reject(new Error(data.message));
          break;
        }
        case "initError": {
          // init 的 pending 用 reject 通道（create 期唯一请求）
          const pending = this.pending.get(0);
          this.pending.delete(0);
          pending?.reject(new Error(data.message));
          break;
        }
        case "contextLost": {
          this.onContextLost?.();
          break;
        }
        case "ready": {
          // ready 在 create 的 init 往返中经 readyPromise 处理
          break;
        }
      }
  };
  private readonly onError = (event: ErrorEvent): void => { this.terminate(new Error(event.message || "compositor worker error")); };
  private readonly onMessageError = (): void => { this.terminate(new Error("compositor worker message error")); };

  /** 创建 worker 并完成 init 握手；worker 侧 WebGL2 不可用/初始化失败 → 抛错。
   *  transferControlToOffscreen 每元素仅可一次：canvas 由会话新建并随会话销毁。 */
  static async create(canvas: HTMLCanvasElement, init: CompositorClientInit, signal?: AbortSignal): Promise<CompositorWorkerClient> {
    throwIfAborted(signal);
    const client = new CompositorWorkerClient(canvas);
    try {
      const info = await workerReady<GpuInfo>(client.worker, data => {
        if (data.type === "initError") throw new Error(data.message);
        return data.type === "ready" ? { adapter: data.adapter, vendor: data.vendor } : undefined;
      }, () => {
    const offscreen = canvas.transferControlToOffscreen();
    const request: WorkerRequest = {
      type: "init",
      canvas: offscreen,
      inputs: init.inputs,
      ringDepth: init.ringDepth,
      canvasWidth: init.canvasWidth,
      canvasHeight: init.canvasHeight,
      captionStyles: init.captionStyles,
      ...(init.forceCopyTo ? { forceCopyTo: true } : {}),
    };
    client.worker.postMessage(request, [offscreen]);
      }, signal);
      throwIfAborted(signal);
      client.gpuInfo = info;
      return client;
    } catch (error) { client.terminate(); throw error; }
  }

  /** 上传解码帧到输入的环形槽位（frame transfer，零拷贝）；解析 = worker 完成上传。 */
  upload(inputId: string, slot: number, srcN: number, frame: VideoFrame): Promise<void> {
    if (this.disposed) { frame.close(); return Promise.reject(new Error("compositor worker disposed")); }
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "upload", inputId, slot, srcN, frame, seq };
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // ack 期限内未回：迟到的 uploaded 项已删，optional 链无操作不误标槽位
        if (this.pending.delete(seq)) reject(new Error(`compositor upload timeout (seq ${seq})`));
      }, CompositorWorkerClient.UPLOAD_TIMEOUT_MS);
      this.pending.set(seq, { resolve: (value: never) => { clearTimeout(timeout); resolve(value); }, reject });
      try { this.worker.postMessage(request, [frame]); }
      catch (error) { this.pending.delete(seq); clearTimeout(timeout); frame.close(); reject(error); }
    });
  }

  /** 上传转场共享输入的第二帧（影子槽）。 */
  uploadShadow(inputId: string, srcN: number, frame: VideoFrame): Promise<void> {
    if (this.disposed) { frame.close(); return Promise.reject(new Error("compositor worker disposed")); }
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "uploadShadow", inputId, srcN, frame, seq };
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(seq)) reject(new Error(`compositor uploadShadow timeout (seq ${seq})`));
      }, CompositorWorkerClient.UPLOAD_TIMEOUT_MS);
      this.pending.set(seq, { resolve: (value: never) => { clearTimeout(timeout); resolve(value); }, reject });
      try { this.worker.postMessage(request, [frame]); }
      catch (error) { this.pending.delete(seq); clearTimeout(timeout); frame.close(); reject(error); }
    });
  }

  /** 静图一次上传（ImageBitmap transfer；worker 侧 RGBA 纹理全程复用）。 */
  uploadImage(inputId: string, bitmap: ImageBitmap): void {
    if (this.disposed) { bitmap.close(); return; }
    const request: WorkerRequest = { type: "uploadImage", inputId, bitmap };
    try { this.worker.postMessage(request, [bitmap]); }
    catch (error) { bitmap.close(); throw error; }
  }

  /** B13：注册/换代表输入（generation 递增；环池按 ringDepth 重建 + 字节
   *  记账）。resolve = worker ack（inputRegistered）。 */
  registerInput(inputId: string, generation: number, geometry: { width: number; height: number }, ringDepth: number, shadow: boolean): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("compositor worker disposed"));
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "registerInput", inputId, generation, geometry, ringDepth, shadow, seq };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      try { this.worker.postMessage(request); }
      catch (error) { this.pending.delete(seq); reject(error); }
    });
  }

  /** B13：释放输入（纹理删除 + 字节记账；generation 不匹配时作废）。 */
  releaseInput(inputId: string, generation: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("compositor worker disposed"));
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "releaseInput", inputId, generation, seq };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      try { this.worker.postMessage(request); }
      catch (error) { this.pending.delete(seq); reject(error); }
    });
  }

  /** 下发绘制命令列表（顺序投递；worker 内同步执行，呈现按消息序保证）。 */
  compose(cmds: DrawCommand[], epoch = 0, frame = -1): void {
    if (this.disposed) return;
    const seq = editorPerf.enabled ? this.nextSeq++ : undefined;
    if (seq !== undefined) {
      if (this.submissions.size >= 512) this.submissions.delete(this.submissions.keys().next().value!);
      this.submissions.set(seq, { at: performance.now(), generation: editorPerf.generation, epoch, frame });
      editorPerf.record("compose", 0, this.perfSession, seq, epoch, frame);
    }
    const request: WorkerRequest = { type: "compose", payload: { cmds }, ...(seq === undefined ? {} : { seq }) };
    this.worker.postMessage(request);
  }

  /** 后备缓冲尺寸 + 视口适配（会话计算 fit，worker 只应用）。 */
  resize(backingWidth: number, backingHeight: number, fitX: number, fitY: number, fitScale: number): void {
    if (this.disposed) return;
    const request: WorkerRequest = { type: "resize", backingWidth, backingHeight, fitX, fitY, fitScale };
    this.worker.postMessage(request);
  }

  /** 字幕字体（transfer 到 worker 的 FontFaceSet）。 */
  setFont(buffer: ArrayBuffer, family: string): void {
    if (this.disposed) return;
    const request: WorkerRequest = { type: "font", buffer, family };
    this.worker.postMessage(request, [buffer]);
  }

  /** 全画布 PNG 回读（worker convertToBlob → ArrayBuffer transfer 回主线程）。 */
  readback(): Promise<ArrayBuffer> {
    if (this.disposed) return Promise.reject(new Error("compositor worker disposed"));
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "readback", seq };
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      try { this.worker.postMessage(request); }
      catch (error) { this.pending.delete(seq); reject(error); }
    });
  }

  /** B13-R：主动查询 worker 驻留计数（无上传 ack 的静止期也可取样）。 */
  queryResidency(): Promise<FrameResidency> {
    if (this.disposed) return Promise.reject(new Error("compositor worker disposed"));
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "residencyQuery", seq };
    return new Promise<FrameResidency>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      try { this.worker.postMessage(request); }
      catch (error) { this.pending.delete(seq); reject(error); }
    });
  }

  terminate(reason = new Error("compositor worker disposed")): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, pending] of this.pending) pending.reject(reason);
    this.pending.clear();
    this.submissions.clear();
    this.onContextLost = null;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.worker.terminate();
  }
}
