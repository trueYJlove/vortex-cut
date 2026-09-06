/** 合成预览 GL 执行器客户端：持有 transferControlToOffscreen 后的 worker 生命周期，
 * 提供类型化 RPC（upload 带 ack、compose 顺序投递、resize/readback 往返）。
 * 会话侧只与本类对话；GL 状态全部在 compositor-worker.worker.ts。 */
import type { DrawCommand, WorkerRequest, WorkerResponse } from "./compositor-worker.worker.js";

export interface CompositorClientInit {
  inputs: Array<{ inputId: string; sourceWidth: number; width: number; height: number }>;
  ringDepth: number;
  canvasWidth: number;
  canvasHeight: number;
  captionStyles: Record<string, { font_size: number; primary_rgb: [number, number, number]; outline_rgb: [number, number, number]; outline: number; shadow: number; border_style: number; margin_v: number }>;
}

export interface GpuInfo { adapter: string; vendor: string }

export class CompositorWorkerClient {
  private readonly worker: Worker;
  private nextSeq = 1;
  private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  private disposed = false;
  readonly canvas: HTMLCanvasElement;
  /** worker 侧 webglcontextlost（会话据此停摆并等待重建）。 */
  onContextLost: (() => void) | null = null;
  /** 就绪信息（探针取证用）。 */
  gpuInfo: GpuInfo = { adapter: "unknown", vendor: "unknown" };
  /** 上传分步采样（copyTo/tex 毫秒，尾随 600 条；探针定位用）。 */
  readonly uploadSplit: Array<{ copyToMs: number; texMs: number }> = [];

  private constructor(canvas: HTMLCanvasElement) {
    // transferControlToOffscreen 每元素仅可一次，由 create() 统一调用；
    // jsdom 无此 API → 抛错（合成预览回退路径，测试环境确定性）。
    this.canvas = canvas;
    this.worker = new Worker(new URL("./compositor-worker.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      switch (data.type) {
        case "uploaded":
        case "uploadedShadow": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          if (data.type === "uploaded") {
            const split = data as { copyToMs: number; texMs: number };
            this.uploadSplit.push({ copyToMs: split.copyToMs, texMs: split.texMs });
            if (this.uploadSplit.length > 600) this.uploadSplit.shift();
          }
          pending?.resolve(data as never);
          break;
        }
        case "readback": {
          const pending = this.pending.get(data.seq);
          this.pending.delete(data.seq);
          pending?.resolve((data as { buffer: ArrayBuffer }).buffer as never);
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
    });
    this.worker.addEventListener("error", event => {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.reject(new Error(event.message || "compositor worker error"));
    });
  }

  /** 创建 worker 并完成 init 握手；worker 侧 WebGL2 不可用/初始化失败 → 抛错。
   *  transferControlToOffscreen 每元素仅可一次：canvas 由会话新建并随会话销毁。 */
  static async create(canvas: HTMLCanvasElement, init: CompositorClientInit): Promise<CompositorWorkerClient> {
    const client = new CompositorWorkerClient(canvas);
    const ready = new Promise<GpuInfo>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponse>): void => {
        if (event.data.type === "ready") { resolve({ adapter: event.data.adapter, vendor: event.data.vendor }); cleanup(); }
        else if (event.data.type === "initError") { reject(new Error(event.data.message)); cleanup(); }
      };
      const onError = (event: ErrorEvent): void => { reject(new Error(event.message || "compositor worker error")); cleanup(); };
      const cleanup = (): void => {
        client.worker.removeEventListener("message", onMessage);
        client.worker.removeEventListener("error", onError);
      };
      client.worker.addEventListener("message", onMessage);
      client.worker.addEventListener("error", onError);
    });
    const offscreen = canvas.transferControlToOffscreen();
    const request: WorkerRequest = {
      type: "init",
      canvas: offscreen,
      inputs: init.inputs,
      ringDepth: init.ringDepth,
      canvasWidth: init.canvasWidth,
      canvasHeight: init.canvasHeight,
      captionStyles: init.captionStyles,
    };
    client.worker.postMessage(request, [offscreen]);
    client.gpuInfo = await ready;
    return client;
  }

  /** 上传解码帧到输入的环形槽位（frame transfer，零拷贝）；解析 = worker 完成上传。 */
  upload(inputId: string, slot: number, srcN: number, frame: VideoFrame): Promise<void> {
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "upload", inputId, slot, srcN, frame, seq };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      this.worker.postMessage(request, [frame]);
    });
  }

  /** 上传转场共享输入的第二帧（影子槽）。 */
  uploadShadow(inputId: string, srcN: number, frame: VideoFrame): Promise<void> {
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "uploadShadow", inputId, srcN, frame, seq };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      this.worker.postMessage(request, [frame]);
    });
  }

  /** 静图一次上传（ImageBitmap transfer；worker 侧 RGBA 纹理全程复用）。 */
  uploadImage(inputId: string, bitmap: ImageBitmap): void {
    if (this.disposed) return;
    const request: WorkerRequest = { type: "uploadImage", inputId, bitmap };
    this.worker.postMessage(request, [bitmap]);
  }

  /** 下发绘制命令列表（顺序投递；worker 内同步执行，呈现按消息序保证）。 */
  compose(cmds: DrawCommand[]): void {
    if (this.disposed) return;
    const request: WorkerRequest = { type: "compose", payload: { cmds } };
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
    const seq = this.nextSeq++;
    const request: WorkerRequest = { type: "readback", seq };
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as never, reject });
      this.worker.postMessage(request);
    });
  }

  terminate(): void {
    this.disposed = true;
    for (const [, pending] of this.pending) pending.reject(new Error("compositor worker disposed"));
    this.pending.clear();
    this.worker.terminate();
  }
}
