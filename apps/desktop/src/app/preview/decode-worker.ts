import { throwIfAborted, workerReady } from "./worker-lifecycle.js";
/** 合成预览解码客户端：每输入一个 worker（decode-worker.worker.ts，Range
 * 源 moov 解析 + VideoDecoder），decode(frameN) 返回解码帧，由 compositor
 * 上传后关闭。B12：初始化只读 moov 元数据（整文件下载已移除）；媒体票据
 * TTL 由 RangeSource 受控续票（refreshTicket 注入，有限一次）。 */

export interface DecodeWorkerMessage {
  type: "ready" | "frame" | "done" | "error";
  id?: number;
  frameN?: number;
  frame?: VideoFrame;
  timestampUs?: number;
  fromCache?: boolean;
  samplesFed?: number;
  fromKeyframe?: number;
  allocationSize?: number;
  hardware?: string | null;
  width?: number;
  height?: number;
  message?: string;
  note?: string;
}

/** 最近一次解码回执的取证信息（worker 附带；播放诊断用）。 */
export interface DecodeFrameInfo {
  frameN: number;
  timestampUs: number;
  fromCache: boolean;
  samplesFed: number;
  fromKeyframe: number;
}

export class DecodeWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<number, { resolve: (frame: VideoFrame) => void; reject: (error: Error) => void }>();
  hardware: string | null = null;
  width = 0;
  height = 0;
  lastFrameInfo: DecodeFrameInfo | null = null;

  private constructor() {
    this.worker = new Worker(new URL("./decode-worker.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", this.onMessageError);
  }

  private readonly onMessage = (event: MessageEvent<DecodeWorkerMessage>): void => {
      const data = event.data;
      if (this.disposed) { data.frame?.close(); return; }
      if (data.type === "frame" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        this.lastFrameInfo = {
          frameN: data.frameN ?? -1,
          timestampUs: data.timestampUs ?? -1,
          fromCache: data.fromCache ?? false,
          samplesFed: data.samplesFed ?? 0,
          fromKeyframe: data.fromKeyframe ?? -1,
        };
        if (data.frame) {
          if (pending) pending.resolve(data.frame);
          else data.frame.close(); // 迟到的结果（客户端已超时放弃）：关闭防泄漏
        } else pending?.reject(new Error("worker returned no frame"));
      } else if (data.type === "error" && data.id === undefined) {
        // Handshake error is consumed by workerReady; a runtime failure is fatal.
        if (this.pending.size) this.terminate(new Error(data.message ?? "worker error"));
      } else if (data.type === "error" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        pending?.reject(new Error(data.message ?? "worker error"));
      }
  };
  private readonly onError = (event: ErrorEvent): void => { this.terminate(new Error(event.message || "decode worker error")); };
  private readonly onMessageError = (): void => { this.terminate(new Error("decode worker message error")); };

  static async create(ticket: string, signal?: AbortSignal, refreshTicket?: () => Promise<string>, cacheCapBytes?: number): Promise<DecodeWorker> {
    throwIfAborted(signal);
    const instance = new DecodeWorker();
    try {
      const data = await workerReady<DecodeWorkerMessage>(instance.worker, data => {
        if (data.type === "error") throw new Error(data.message ?? "worker init error");
        return data.type === "ready" ? data : undefined;
      }, () => instance.worker.postMessage({ type: "init", url: ticket, cacheFrames: 0, ...(refreshTicket ? { refreshTicket } : {}), ...(cacheCapBytes !== undefined ? { cacheCapBytes } : {}) }), signal);
      throwIfAborted(signal);
      instance.hardware = data.hardware ?? null;
      instance.width = data.width ?? 0;
      instance.height = data.height ?? 0;
      return instance;
    } catch (error) { instance.terminate(); throw error; }
  }

  decode(frameN: number, fps: number): Promise<VideoFrame> {
    if (this.disposed) return Promise.reject(new Error("decode worker disposed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`decode timeout for frame ${frameN}`));
      }, 15000);
      this.pending.set(id, {
        resolve: frame => { window.clearTimeout(timeout); resolve(frame); },
        reject: error => { window.clearTimeout(timeout); reject(error); },
      });
      try { this.worker.postMessage({ type: "decode", id, frameN, fps }); }
      catch (error) {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
    });
  }

  terminate(reason = new Error("decode worker disposed")): void {
    if (this.disposed) return;
    this.disposed = true;
    // B12：先关 Range 源（释放字节缓存/在途请求），再终结 worker
    try { this.worker.postMessage({ type: "close" }); } catch { /* 已终止 */ }
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.worker.terminate();
  }
}
