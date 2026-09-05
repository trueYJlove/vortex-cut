/** 合成预览解码客户端：每输入一个 worker（decode-worker.worker.ts，手写 BMFF +
 * VideoDecoder），decode(frameN) 返回解码帧，由 compositor 上传后关闭。 */

export interface DecodeWorkerMessage {
  type: "ready" | "frame" | "done" | "error";
  id?: number;
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

export class DecodeWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (frame: VideoFrame) => void; reject: (error: Error) => void }>();
  hardware: string | null = null;
  width = 0;
  height = 0;

  private constructor() {
    this.worker = new Worker(new URL("./decode-worker.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<DecodeWorkerMessage>) => {
      const data = event.data;
      if (data.type === "frame" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.frame) pending?.resolve(data.frame);
        else pending?.reject(new Error("worker returned no frame"));
      } else if (data.type === "error" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        pending?.reject(new Error(data.message ?? "worker error"));
      }
    });
  }

  static async create(ticket: string): Promise<DecodeWorker> {
    const instance = new DecodeWorker();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("worker init timeout")), 15000);
      instance.worker.addEventListener("message", function onReady(event: MessageEvent<DecodeWorkerMessage>) {
        if (event.data.type === "ready") {
          window.clearTimeout(timeout);
          instance.worker.removeEventListener("message", onReady);
          instance.hardware = event.data.hardware ?? null;
          instance.width = event.data.width ?? 0;
          instance.height = event.data.height ?? 0;
          resolve();
        } else if (event.data.type === "error") {
          window.clearTimeout(timeout);
          reject(new Error(event.data.message ?? "worker init error"));
        }
      });
      instance.worker.postMessage({ type: "init", url: ticket, cacheFrames: 0 });
    });
    return instance;
  }

  decode(frameN: number, fps: number): Promise<VideoFrame> {
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
      this.worker.postMessage({ type: "decode", id, frameN, fps });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
