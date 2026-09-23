/** 时间线抽帧源（filmstrip 客户端侧）：FilmstripWorkerClient 包装专用 worker
 *  （filmstrip-worker.ts），FilmstripSource 实现缩略图 loader 的 FrameSource
 *  契约——请求帧（canvas）→ 失败返回 null（不堵队列）。
 *
 * 票据策略：create 时先经注入的 reissueTicket 领**全新**票据（5min TTL 对准
 * 抽帧任务窗）；hintUrl 仅作无 reissueTicket 时的回退。任务中途 Range 失败
 * （含过期 404/401/403）：重签一次 → 重建 worker → 整体重试该请求一次，再
 * 失败按失败处理（不环）。
 */

import { throwIfAborted, workerReady } from "../preview/worker-lifecycle.js";
import type { FilmstripInbound, FilmstripOutbound } from "./filmstrip-worker.js";

/** dev 诊断：抽帧链路失败静默返回 null（A08 韧性设计），现场无从定位；
 *  dev 构建下落 console（主进程 console-message 转发可采集）。
 *  生产构建被 import.meta.env.DEV 静态替换为 false → 恒 false 不输出。 */
const FILMSTRIP_DIAG: boolean = import.meta.env.DEV;
function diagWarn(message: string): void {
  if (FILMSTRIP_DIAG) console.warn(`[filmstrip] ${message}`);
}

/** 解码超时（对齐 DecodeWorker 15s）。 */
export const FILMSTRIP_DECODE_TIMEOUT_MS = 15_000;

type FilmstripClientMessage = FilmstripOutbound;

/** worker ready 回执（init 握手成功成员）。 */
interface FilmstripReady { type: "ready"; width: number; height: number; durationUs: number; sampleCount: number; hardware: string | null }

/** worker 客户端：init 握手 + decodeAt + terminate（可注入 worker 工厂供测试）。 */
export class FilmstripWorkerClient {
  private readonly worker: Worker;
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<number, { resolve: (bitmap: ImageBitmap) => void; reject: (error: Error) => void }>();
  private refreshTicket: (() => Promise<string>) | null = null;
  readonly width: number;
  readonly height: number;
  readonly hardware: string | null;

  private constructor(worker: Worker, width: number, height: number, hardware: string | null) {
    this.worker = worker;
    this.width = width;
    this.height = height;
    this.hardware = hardware;
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", () => this.terminate(new Error("filmstrip worker message error")));
  }

  private readonly onMessage = (event: MessageEvent<FilmstripClientMessage>): void => {
    const data = event.data;
    if (this.disposed) { data.type === "bitmap" && data.bitmap?.close(); return; }
    if (data.type === "ticket-refresh-request" && data.id !== undefined) {
      const requestId = data.id;
      if (!this.refreshTicket) {
        this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshError: "no refresh callback" } satisfies FilmstripInbound);
        return;
      }
      this.refreshTicket().then(
        url => this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshUrl: url } satisfies FilmstripInbound),
        error => this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshError: error instanceof Error ? error.message : String(error) } satisfies FilmstripInbound),
      );
      return;
    }
    if (data.type === "bitmap" && data.id !== undefined) {
      const pending = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (pending) pending.resolve(data.bitmap);
      else data.bitmap.close(); // 迟到结果：关闭防泄漏
    } else if (data.type === "error" && typeof data.id === "number") {
      const pending = this.pending.get(data.id);
      this.pending.delete(data.id);
      pending?.reject(new Error(data.message ?? "filmstrip worker error"));
    } else if (data.type === "error" && data.id === null && this.pending.size) {
      this.terminate(new Error(data.message ?? "filmstrip worker error"));
    }
  };

  private readonly onError = (event: ErrorEvent): void => { this.terminate(new Error(event.message || "filmstrip worker error")); };

  static async create(
    url: string,
    refreshTicket: (() => Promise<string>) | null,
    signal?: AbortSignal,
    createWorker: () => Worker = () => new Worker(new URL("./filmstrip-worker.ts", import.meta.url), { type: "module" }),
  ): Promise<FilmstripWorkerClient> {
    throwIfAborted(signal);
    const worker = createWorker();
    try {
      const ready = await workerReady<FilmstripReady>(worker, data => {
        if (data.type === "error") throw new Error(data.message ?? "filmstrip worker init error");
        return data.type === "ready" ? data : undefined;
      }, () => worker.postMessage({ type: "init", url, refreshTicket: Boolean(refreshTicket) } satisfies FilmstripInbound), signal);
      throwIfAborted(signal);
      const instance = new FilmstripWorkerClient(worker, ready.width, ready.height, ready.hardware);
      instance.refreshTicket = refreshTicket;
      return instance;
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  decodeAtUs(timeUs: number): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(new Error("filmstrip worker disposed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`filmstrip decode timeout for ${timeUs}us`));
      }, FILMSTRIP_DECODE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: bitmap => { window.clearTimeout(timeout); resolve(bitmap); },
        reject: error => { window.clearTimeout(timeout); reject(error); },
      });
      try { this.worker.postMessage({ type: "decode-at", id, timeUs } satisfies FilmstripInbound); }
      catch (error) {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
    });
  }

  terminate(reason = new Error("filmstrip worker disposed")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshTicket = null;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    try { this.worker.postMessage({ type: "close" } satisfies FilmstripInbound); } catch { /* 已终止 */ }
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
  }
}

/** 缩略图帧源契约（thumbnail-loader 调度；视频帧统一 canvas 形态）。 */
export interface FrameSource {
  /** 请求一帧：成功返回 canvas；失败（解码/超时/票据不可恢复）返回 null。 */
  loadFrame(timeSec: number): Promise<HTMLCanvasElement | null>;
  dispose(): void;
}

/** reissueTicket 注入签名：按 assetId 重签票据（主进程纯内存签发）。 */
export type ReissueTicket = (assetId: string) => Promise<string>;

export interface FilmstripSourceOptions {
  /** 测试注入：worker 客户端工厂（缺省走真实 FilmstripWorkerClient.create）。 */
  createClient?: (url: string, refreshTicket: (() => Promise<string>) | null) => Promise<FilmstripWorkerClient>;
  /** 测试注入：canvas 工厂（jsdom 无 2D context 时仍可断言调用时序）。 */
  createCanvas?: () => HTMLCanvasElement;
}

/** 默认 worker 客户端工厂（生产路径；refreshTicket 传 null——续票由 source
 *  层"失败重签重建"统一处理，worker 内消息桥仅作协议完整性保留）。 */
function defaultCreateClient(url: string, refreshTicket: (() => Promise<string>) | null): Promise<FilmstripWorkerClient> {
  return FilmstripWorkerClient.create(url, refreshTicket);
}

function defaultCreateCanvas(): HTMLCanvasElement {
  return window.document.createElement("canvas");
}

export class FilmstripSource implements FrameSource {
  private client: FilmstripWorkerClient | null = null;
  private ticketUrl: string;
  private retried = false;
  private disposed = false;
  private readonly createClient: (url: string, refreshTicket: (() => Promise<string>) | null) => Promise<FilmstripWorkerClient>;
  private readonly createCanvas: () => HTMLCanvasElement;

  /** 直接构造（测试注入用）：生产路径一律走 static create（含领票时序）。 */
  constructor(
    private readonly reissueTicket: ReissueTicket | null,
    private readonly assetId: string,
    hintUrl: string,
    options: FilmstripSourceOptions | undefined,
  ) {
    this.ticketUrl = hintUrl;
    this.createClient = options?.createClient ?? defaultCreateClient;
    this.createCanvas = options?.createCanvas ?? defaultCreateCanvas;
  }

  /** 创建源：优先重签新票（无 reissueTicket 时用 hintUrl），init 失败上抛
   *  （调用方降级 video seek 路径）。 */
  static async create(
    assetId: string,
    hintUrl: string,
    reissueTicket: ReissueTicket | null,
    options?: FilmstripSourceOptions,
  ): Promise<FilmstripSource> {
    const source = new FilmstripSource(reissueTicket, assetId, hintUrl, options);
    if (reissueTicket) {
      try { source.ticketUrl = await reissueTicket(assetId); }
      catch (error) {
        diagWarn(`reissue ticket failed asset=${assetId}: ${error instanceof Error ? error.message : String(error)}（回退 hintUrl）`);
        /* 重签失败：回退 hintUrl（素材列表签发的票，≤5min 内有效） */
      }
    }
    source.client = await source.createClient(source.ticketUrl, null);
    return source;
  }

  loadFrame(timeSec: number): Promise<HTMLCanvasElement | null> {
    return this.loadFrameOnce(timeSec).catch(() => this.retryOnce(timeSec));
  }

  private async loadFrameOnce(timeSec: number): Promise<HTMLCanvasElement | null> {
    if (this.disposed || !this.client) return null;
    const bitmap = await this.client.decodeAtUs(Math.max(0, Math.round(timeSec * 1_000_000)));
    try {
      const canvas = this.createCanvas();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      diagWarn(`frame ok t=${timeSec.toFixed(4)}s asset=${this.assetId} → ${bitmap.width}x${bitmap.height}`);
      return canvas;
    } finally {
      bitmap.close();
    }
  }

  /** 一次性恢复路径：Range 失败（票据过期 404/401/403 等）→ 重签新票 →
   *  重建 worker → 重试本请求；再失败返回 null（不环）。 */
  private async retryOnce(timeSec: number): Promise<HTMLCanvasElement | null> {
    if (this.disposed || this.retried || !this.reissueTicket) return null;
    this.retried = true;
    diagWarn(`decode failed at ${timeSec}s asset=${this.assetId}，重签重建重试一次`);
    try {
      this.client?.terminate();
      this.ticketUrl = await this.reissueTicket(this.assetId);
      this.client = await this.createClient(this.ticketUrl, null);
    } catch (error) {
      diagWarn(`rebuild after failure failed asset=${this.assetId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    try {
      return await this.loadFrameOnce(timeSec);
    } catch (error) {
      diagWarn(`retry failed asset=${this.assetId} at ${timeSec}s: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.client?.terminate();
    this.client = null;
  }
}
