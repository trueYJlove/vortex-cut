import { throwIfAborted, workerReady } from "./worker-lifecycle.js";
/** 合成预览解码客户端：每输入一个 worker（decode-worker.worker.ts，Range
 * 源 moov 解析 + VideoDecoder），decode(frameN) 返回解码帧，由 compositor
 * 上传后关闭。B12：初始化只读 moov 元数据（整文件下载已移除）；媒体票据
 * TTL 由 RangeSource 受控续票（refreshTicket 注入，有限一次）。 */

export interface DecodeWorkerMessage {
  type: "ready" | "frame" | "done" | "error" | "ticket-refresh-request";
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
  /** P33 分段计时（worker 时钟内时长；decodeTiming 开启时随 frame 捎带）：
   *  feedMs = 出队→最后一批喂包提交；outputMs = 喂包提交→匹配输出到达。
   *  客户端残差 = 自测 RTT − feedMs − outputMs（排队等待 + 双跳传输）。 */
  timing?: { feedMs: number; outputMs: number } | null;
}

/** 最近一次解码回执的取证信息（worker 附带；播放诊断用）。 */
export interface DecodeFrameInfo {
  frameN: number;
  timestampUs: number;
  fromCache: boolean;
  samplesFed: number;
  fromKeyframe: number;
}

/** P33 分段计时单样本（残差 = 客户端 RTT − worker feed/output 两段；缓存
 *  命中路径 worker 段为 null，残差即全 RTT）。 */
export interface DecodeTimingSample {
  rttMs: number;
  feedMs: number;
  outputMs: number;
  residualMs: number;
  fromCache: boolean;
}

/** B13-R：decode worker 驻留计数（stats 往返取回；-1 = 未取样）。 */
export interface DecodeResidencyInfo {
  decoded: number;
  posted: number;
  cached: number;
  closed: number;
  live: number;
  cacheBytes: number;
  cacheSize: number;
}

export class DecodeWorker {
  private readonly worker: Worker;
  private nextId = 0;
  private disposed = false;
  private refreshTicket: (() => Promise<string>) | null = null;
  private readonly pending = new Map<number, { resolve: (frame: VideoFrame) => void; reject: (error: Error) => void }>();
  /** B13-R：stats 往返的挂起（done 消息按 id=null 广播 → 单飞行限流）。 */
  private statsPromise: Promise<DecodeResidencyInfo> | null = null;
  private statsSettle: { resolve: (info: DecodeResidencyInfo) => void; reject: (error: Error) => void } | null = null;  hardware: string | null = null;
  width = 0;
  height = 0;
  hasBFrames = false;
  lastFrameInfo: DecodeFrameInfo | null = null;
  /** P33 分段计时环形样本（decodeTiming 开启时填充；容量 512）。 */
  timingSamples: DecodeTimingSample[] = [];
  private timingOn = false;
  /** decode 请求 postMessage 时刻（残差段计算用；id → performance.now ms）。 */
  private readonly postedAt = new Map<number, number>();

  private constructor() {
    this.worker = new Worker(new URL("./decode-worker.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", this.onMessageError);
  }

  private readonly onMessage = (event: MessageEvent<DecodeWorkerMessage>): void => {
      const data = event.data;
      if (this.disposed) { data.frame?.close(); return; }
      if (data.type === "ticket-refresh-request" && data.id !== undefined) {
        // B12 续票桥：Worker 不能持有主线程闭包（postMessage 无法克隆函数），
        // 401/403 时经此往返——客户端执行主线程 refreshTicket 并回发新 URL。
        const requestId = data.id;
        if (!this.refreshTicket) {
          this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshError: "no refresh callback" });
          return;
        }
        this.refreshTicket().then(
          url => this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshUrl: url }),
          error => this.worker.postMessage({ type: "ticket-refresh-response", id: requestId, refreshError: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }
      if ((data as { type?: string; event?: string }).type === "trace") {
        (window as unknown as { __TRACE?: unknown[] }).__TRACE?.push(data);
        return;
      }
      if (data.type === "frame" && data.id !== undefined) {
        const pending = this.pending.get(data.id);
        this.pending.delete(data.id);
        const posted = this.postedAt.get(data.id);
        this.postedAt.delete(data.id);
        this.lastFrameInfo = {
          frameN: data.frameN ?? -1,
          timestampUs: data.timestampUs ?? -1,
          fromCache: data.fromCache ?? false,
          samplesFed: data.samplesFed ?? 0,
          fromKeyframe: data.fromKeyframe ?? -1,
        };
        // P33：残差段 = 客户端自测 RTT − worker 两段（同源时钟内不做跨钟合成；
        // 未开启计时/无 post 时刻时跳过）。容量 512 环形，会话侧聚合分位数。
        if (this.timingOn && posted !== undefined) {
          const rttMs = performance.now() - posted;
          const feedMs = data.timing?.feedMs ?? 0;
          const outputMs = data.timing?.outputMs ?? 0;
          this.timingSamples.push({
            rttMs: Math.round(rttMs * 1000) / 1000,
            feedMs,
            outputMs,
            residualMs: Math.round((rttMs - feedMs - outputMs) * 1000) / 1000,
            fromCache: data.fromCache ?? false,
          });
          if (this.timingSamples.length > 512) this.timingSamples.splice(0, this.timingSamples.length - 512);
        }
        if (data.frame) {
          if (pending) pending.resolve(data.frame);
          else data.frame.close(); // 迟到的结果（客户端已超时放弃）：关闭防泄漏
        } else pending?.reject(new Error("worker returned no frame"));
      } else if (data.type === "error" && data.id === undefined) {
        // Handshake error is consumed by workerReady; a runtime failure is fatal.
        if (this.pending.size) this.terminate(new Error(data.message ?? "worker error"));
      } else if (data.type === "done" && data.id === null && data.note) {
        // B13-R：stats 往返（decodeResidency JSON）
        if (this.statsSettle) {
          const settle = this.statsSettle;
          this.statsPromise = null;
          this.statsSettle = null;
          try {
            const parsed = JSON.parse(data.note) as { residency?: DecodeResidencyInfo };
            if (parsed.residency) settle.resolve(parsed.residency);
            else settle.reject(new Error("stats note missing residency"));
          } catch (error) { settle.reject(error instanceof Error ? error : new Error(String(error))); }
        }
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
    instance.refreshTicket = refreshTicket ?? null;
    // B13-R 判别诊断开关：强制软件解码（perf 诊断构建环境变量；缺省 undefined）
    let forceSwDecode: boolean | undefined;
    try { forceSwDecode = import.meta.env.VITE_AIVS_FORCE_SW_DECODE === "1" || undefined; } catch { /* 无 env */ }
    // P33 分段计时开关（VITE_AIVS_DECODE_TIMING=1；默认关，生产零开销）
    try { instance.timingOn = import.meta.env.VITE_AIVS_DECODE_TIMING === "1"; } catch { /* 无 env */ }
    try {
      const data = await workerReady<DecodeWorkerMessage>(instance.worker, data => {
        if (data.type === "error") throw new Error(data.message ?? "worker init error");
        return data.type === "ready" ? data : undefined;
      }, () => instance.worker.postMessage({ type: "init", url: ticket,
          // 解码帧 LRU（2026-09-28 真机定位启用）：3 路并发客户端会对同一
          // src_n 发出重复请求（窗口重发/seek 回退/重锚），无缓存时第二发
          // 永远等不到输出（首个输出已被消费/释放）→ 45s 看门狗 → 降级
          // 慢路径。cap=4 帧（720p≈5MB GPU）即可覆盖并发重复窗口。
          cacheFrames: 3,
          refreshTicket: Boolean(refreshTicket), ...(forceSwDecode ? { forceSwDecode: true } : {}), ...(instance.timingOn ? { decodeTiming: true } : {}), ...(cacheCapBytes !== undefined ? { cacheCapBytes } : {}) }), signal);
      throwIfAborted(signal);
      instance.hardware = data.hardware ?? null;
      instance.width = data.width ?? 0;
      instance.height = data.height ?? 0;
      instance.hasBFrames = Boolean((data as { hasBFrames?: boolean }).hasBFrames);
      return instance;
    } catch (error) { instance.terminate(); throw error; }
  }

  decode(frameN: number, fps: number): Promise<VideoFrame> {
    if (this.disposed) return Promise.reject(new Error("decode worker disposed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // 客户端兜底期限 = worker 看门狗（45s）+ 传播余量：worker 在处理请求时
      // 它的看门狗错误（类型化 message）是权威信号；客户端先到期会制造
      // "假超时"（主线程 GC/忙导致 postMessage 延迟、worker 其实健康），
      // 并被 maybeFallBackToFfmpeg 的 /timeout/ 正则误判 → 整输入永久降级
      // 到慢速 FFmpeg IPC 路径（2026-09-28 真机"丢帧不多但持续卡"的一环）。
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`decode timeout for frame ${frameN}（worker 侧无匹配输出或长 GOP 冷启超时）`));
      }, 50_000);
      this.pending.set(id, {
        resolve: frame => { window.clearTimeout(timeout); resolve(frame); },
        reject: error => { window.clearTimeout(timeout); reject(error); },
      });
      if (this.timingOn) this.postedAt.set(id, performance.now());
      try { this.worker.postMessage({ type: "decode", id, frameN, fps }); }
      catch (error) {
        this.postedAt.delete(id);
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      }
    });
  }

  /** B13-R：查询 worker 驻留计数（单飞行；在途时复用同一 promise）。 */
  queryResidency(): Promise<DecodeResidencyInfo> {
    if (this.disposed) return Promise.reject(new Error("decode worker disposed"));
    if (this.statsPromise) return this.statsPromise;
    this.statsPromise = new Promise<DecodeResidencyInfo>((resolve, reject) => {
      this.statsSettle = { resolve, reject };
      try { this.worker.postMessage({ type: "stats" }); }
      catch (error) { this.statsPromise = null; this.statsSettle = null; reject(error instanceof Error ? error : new Error(String(error))); }
    });
    window.setTimeout(() => {
      if (this.statsSettle) {
        const settle = this.statsSettle;
        this.statsPromise = null;
        this.statsSettle = null;
        settle.reject(new Error("residency query timeout"));
      }
    }, 5000);
    return this.statsPromise;
  }

  terminate(reason = new Error("decode worker disposed")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshTicket = null;
    this.postedAt.clear();
    // B13-R：挂起的 stats 往返随 terminate 落定
    if (this.statsSettle) {
      const settle = this.statsSettle;
      this.statsPromise = null;
      this.statsSettle = null;
      settle.reject(reason);
    }
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
