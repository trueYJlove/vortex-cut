/** 时间线缩略图加载器（A08 → filmstrip WebCodecs 化 2026-09-22）：从
 *  TimelineCanvas 抽出的帧请求调度。
 *
 *  - 组件/项目作用域 owner：每个 TimelinePanel 实例一个 loader（非全局
 *    单例——旧实现共享全局 video 元素，跨项目切换会串状态）。
 *  - 请求含 owner、viewportEpoch、priority、assetKey、sourceTime、
 *    sizeBucket；尚未开始的旧 viewport 任务取消（epoch 失配即丢），
 *    active 任务最多一个（解码器串行约束）。
 *  - 帧来源按素材分源（FrameSource）：首选 FilmstripSource（专用 worker，
 *    WebCodecs 硬解 + Range 字节源，FIFO 出队 = 源时间单调 → 近似一次线性
 *    解码 pass，每 GOP 只解一遍）；worker/编解码不可用时降级
 *    VideoSeekFrameSource（隐藏 video 元素串行 seek，原 A08 路径）。
 *  - 活跃源上限 2（LRU 驱逐）；空闲 20s 自动释放（解码器内存不常驻）。
 *  - 超时初值 5 秒（video seek 路径；filmstrip 路径自持 15s 解码超时）；
 *    finally 无条件清监听器并继续队列（坏媒体不堵住后续请求）。
 *  - seek 同 currentTime 时直接取当前已就绪帧，不等待不会发生的 seeked。
 *  - 完成回调按 rAF 批量通知（一帧多次到达只触发一次上层重渲）。
 *  - 缓存按 key（asset+帧序/档位+content generation）共享，维持条数上限
 *    并做 bytes 记账（width*height*4 估算）。
 */
import { FilmstripSource, type FrameSource, type ReissueTicket } from "./filmstrip-source.js";

/** dev 诊断（同 filmstrip-source.diagWarn；生产恒 false）。 */
const LOADER_DIAG: boolean = import.meta.env.DEV;
function diagWarn(message: string): void {
  if (LOADER_DIAG) console.warn(`[thumbnails] ${message}`);
}

export interface ThumbnailRequest {
  /** 帧缓存键（调用方组合 asset/帧序/档位）。 */
  key: string;
  /** 素材 id（分源：同素材共享一个解码源）。 */
  assetId: string;
  /** 媒体 URL（票据 URL；filmstrip 源的 hint——开工前会重签新票）。 */
  url: string;
  /** 目标源时刻（秒）。 */
  timeSec: number;
  /** 优先级：0 = 当前视口，1 = 预读。低值先出队。 */
  priority?: number;
  /** 视口代次：请求创建时的 viewport epoch；不匹配的任务在出队时丢弃。 */
  viewportEpoch: number;
}

export interface ThumbnailFrame {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** 每素材帧源契约（filmstrip-source.ts 实现 + video 回退实现）。 */
export type ThumbnailFrameSource = FrameSource;

export interface ThumbnailLoaderOptions {
  /** 帧缓存条数上限（默认 600，与旧实现一致）。 */
  maxEntries?: number;
  /** 单请求超时（ms，默认 5000；video seek 路径用）。 */
  requestTimeoutMs?: number;
  /** 完成通知节流（rAF；jsdom 无 rAF 时直接同步）。 */
  onBatchLoaded?: (keys: string[]) => void;
  /** 供测试注入的隐藏 video 工厂（video 回退路径）。 */
  createVideo?: () => HTMLVideoElement | null;
  /** 供测试注入的计时函数。 */
  scheduleTimer?: (callback: () => void, ms: number) => () => void;
  /** 供测试注入的 filmstrip 源工厂；返回 null = 该素材降级 video 路径。 */
  createFilmstripSource?: (input: { assetId: string; url: string }) => Promise<FrameSource | null>;
  /** 活跃源上限（默认 2）。 */
  maxActiveSources?: number;
  /** 源空闲释放时长（ms，默认 20_000）。 */
  sourceIdleMs?: number;
}

/** 计数口径（测试与诊断）。 */
export interface ThumbnailLoaderStats {
  requested: number;
  completed: number;
  failed: number;
  cancelledStale: number;
  timeouts: number;
  mergedKeys: number;
  cacheBytes: number;
  cacheEntries: number;
}

interface QueueItem extends ThumbnailRequest {
  resolve: (value: ThumbnailFrame | null) => void;
}

const ESTIMATED_BYTES_PER_PIXEL = 4;
const DEFAULT_MAX_ACTIVE_SOURCES = 2;
const DEFAULT_SOURCE_IDLE_MS = 20_000;

/** video 回退帧源：原 A08 隐藏 video 串行 seek 抽帧（runJob 逻辑原样迁入）。 */
class VideoSeekFrameSource implements FrameSource {
  private video: HTMLVideoElement | null = null;
  private currentUrl: string | null = null;

  constructor(
    private readonly url: string,
    private readonly requestTimeoutMs: number,
    private readonly createVideo: () => HTMLVideoElement | null,
    private readonly scheduleTimer: (callback: () => void, ms: number) => () => void,
    private readonly onTimeout: () => void,
  ) {}

  async loadFrame(timeSec: number): Promise<HTMLCanvasElement | null> {
    const video = (this.video ??= this.createVideo());
    if (!video) return null;
    try {
      if (this.currentUrl !== this.url) {
        await this.awaitEvent(
          video,
          ["loadeddata"],
          () => { video.src = this.url; this.currentUrl = this.url; video.load(); },
        );
      }
      if (video.readyState < 2) return null;
      const target = Math.max(0, timeSec);
      if (Math.abs(video.currentTime - target) > 1e-4) {
        await this.awaitEvent(video, ["seeked"], () => { video.currentTime = target; });
      }
      const width = Math.max(2, Math.min(160, video.videoWidth || 96));
      const height = Math.max(2, Math.round((width * (video.videoHeight || 54)) / (video.videoWidth || 96)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      return canvas;
    } catch {
      return null; // 解码/寻址/超时失败：跳过该帧（不堵队列）。
    }
  }

  dispose(): void {
    this.video = null;
    this.currentUrl = null;
  }

  /** 事件等待 + 超时：finally 无条件清理监听器（坏媒体不泄漏监听）。 */
  private awaitEvent(target: HTMLVideoElement, successEvents: string[], begin: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const cancelTimer = this.scheduleTimer(() => {
        if (done) return;
        done = true;
        cleanup();
        this.onTimeout();
        reject(new Error("thumbnail request timed out"));
      }, this.requestTimeoutMs);
      const onSuccess = () => { if (done) return; done = true; cancelTimer(); cleanup(); resolve(); };
      const onError = () => { if (done) return; done = true; cancelTimer(); cleanup(); reject(new Error("media failed")); };
      function cleanup() {
        for (const name of successEvents) target.removeEventListener(name, onSuccess);
        target.removeEventListener("error", onError);
      }
      for (const name of successEvents) target.addEventListener(name, onSuccess);
      target.addEventListener("error", onError);
      try {
        begin();
      } catch (error) {
        done = true;
        cancelTimer();
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

interface SourceEntry {
  source: FrameSource;
  busy: boolean;
  lastUsedAt: number;
  idleTimerCancel: (() => void) | null;
}

export class ThumbnailLoader {
  private readonly cache = new Map<string, ThumbnailFrame>();
  private readonly pendingKeys = new Set<string>();
  private readonly queue: QueueItem[] = [];
  private busy = false;
  private disposed = false;
  private readonly maxEntries: number;
  private readonly requestTimeoutMs: number;
  private readonly onBatchLoaded: ((keys: string[]) => void) | undefined;
  private readonly createVideo: () => HTMLVideoElement | null;
  private readonly scheduleTimer: (callback: () => void, ms: number) => () => void;
  private readonly createFilmstripSource: ((input: { assetId: string; url: string }) => Promise<FrameSource | null>) | null;
  private readonly maxActiveSources: number;
  private readonly sourceIdleMs: number;
  /** 每素材帧源（filmstrip 首选 / video 回退）；LRU 上限 + 空闲释放。 */
  private readonly sources = new Map<string, SourceEntry>();
  private readonly degradedAssets = new Set<string>();
  private batchNotifyScheduled = false;
  private batchLoadedKeys: string[] = [];
  readonly stats: ThumbnailLoaderStats = {
    requested: 0,
    completed: 0,
    failed: 0,
    cancelledStale: 0,
    timeouts: 0,
    mergedKeys: 0,
    cacheBytes: 0,
    cacheEntries: 0,
  };

  constructor(options: ThumbnailLoaderOptions = {}) {
    this.maxEntries = options.maxEntries ?? 600;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.onBatchLoaded = options.onBatchLoaded;
    this.createVideo = options.createVideo ?? (() => {
      if (typeof document === "undefined") return null;
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.playsInline = true;
      return video;
    });
    this.scheduleTimer = options.scheduleTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
    this.createFilmstripSource = options.createFilmstripSource ?? null;
    this.maxActiveSources = options.maxActiveSources ?? DEFAULT_MAX_ACTIVE_SOURCES;
    this.sourceIdleMs = options.sourceIdleMs ?? DEFAULT_SOURCE_IDLE_MS;
  }

  /** 当前视口代次：滚动/缩放后由调用方递增；旧代次任务出队即丢。 */
  viewportEpoch = 0;

  /** 队列长度（测试/诊断：断言无无界排队用）。 */
  queueLengthForTest(): number {
    return this.queue.length + (this.activeJob ? 1 : 0);
  }

  /** 当前在途任务（pump 已出队正在执行）：同 key 后续请求并入其等待者。 */
  private activeJob: QueueItem | null = null;

  /** 请求一帧：已缓存直接返回（同 key 在途则并入等待）。 */
  request(frame: ThumbnailRequest): Promise<ThumbnailFrame | null> {
    if (this.disposed) return Promise.resolve(null);
    this.stats.requested += 1;
    const cached = this.cache.get(frame.key);
    if (cached) return Promise.resolve(cached);
    if (this.pendingKeys.has(frame.key)) {
      // 在途同 key：并入（队列中未开始的项或正在执行的 activeJob）。
      const existing = this.queue.find(item => item.key === frame.key)
        ?? (this.activeJob?.key === frame.key ? this.activeJob : undefined);
      if (existing) {
        this.stats.mergedKeys += 1;
        return new Promise(resolve => {
          const originalResolve = existing.resolve;
          existing.resolve = (value) => { originalResolve(value); resolve(value); };
        });
      }
    }
    return new Promise(resolve => {
      this.queue.push({ ...frame, priority: frame.priority ?? 0, resolve });
      this.pendingKeys.add(frame.key);
      void this.pump();
    });
  }

  /** 缓存读取（不动 LRU 顺序的零开销查询）。 */
  peek(key: string): ThumbnailFrame | undefined {
    return this.cache.get(key);
  }

  /** 通知视口变化：旧代次未开始的任务将不再执行。 */
  advanceViewport(): void {
    this.viewportEpoch += 1;
    const stale = this.queue.filter(item => item.viewportEpoch !== this.viewportEpoch);
    if (stale.length === 0) return;
    for (const item of stale) {
      const index = this.queue.indexOf(item);
      if (index >= 0) this.queue.splice(index, 1);
      this.pendingKeys.delete(item.key);
      this.stats.cancelledStale += 1;
      item.resolve(null);
    }
  }

  /** 清理已不存在片段的帧；保留条数上限（LRU 驱逐 + bytes 记账）。 */
  prune(validClipIds: Set<string>): void {
    for (const key of [...this.cache.keys()]) {
      const clipId = key.split(":")[0];
      if (!validClipIds.has(clipId)) this.cache.delete(key);
    }
    this.evictOverLimit();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.splice(0).forEach(item => item.resolve(null));
    this.pendingKeys.clear();
    this.cache.clear();
    for (const entry of this.sources.values()) {
      if (entry.idleTimerCancel) entry.idleTimerCancel();
      entry.source.dispose();
    }
    this.sources.clear();
    this.recalculateStats();
  }

  private evictOverLimit(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.recalculateStats();
  }

  private recalculateStats(): void {
    let bytes = 0;
    for (const frame of this.cache.values()) {
      bytes += frame.width * frame.height * ESTIMATED_BYTES_PER_PIXEL;
    }
    this.stats.cacheBytes = bytes;
    this.stats.cacheEntries = this.cache.size;
  }

  private async pump(): Promise<void> {
    if (this.busy || this.disposed) return;
    // 出队顺序：优先级低值优先；同优先级 FIFO。
    this.queue.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const job = this.queue.shift();
    if (!job) return;
    if (job.viewportEpoch !== this.viewportEpoch) {
      // 排队期间视口已滚动：尚未开始的任务取消（陈旧返回 null）。
      this.pendingKeys.delete(job.key);
      this.stats.cancelledStale += 1;
      job.resolve(null);
      void this.pump();
      return;
    }
    this.busy = true;
    this.activeJob = job;
    try {
      const frame = await this.runJob(job);
      if (frame) {
        this.cache.set(job.key, frame);
        this.evictOverLimit();
        this.stats.completed += 1;
        this.scheduleBatchNotify(job.key);
      } else {
        this.stats.failed += 1;
      }
      job.resolve(frame);
    } finally {
      this.activeJob = null;
      this.pendingKeys.delete(job.key);
      this.busy = false;
      void this.pump();
    }
  }

  private createVideoSource(job: ThumbnailRequest): SourceEntry {
    const source = new VideoSeekFrameSource(job.url, this.requestTimeoutMs, this.createVideo, this.scheduleTimer, () => { this.stats.timeouts += 1; });
    const entry: SourceEntry = { source, busy: false, lastUsedAt: Date.now(), idleTimerCancel: null };
    this.sources.set(job.assetId, entry);
    this.armIdleTimer(job.assetId, entry);
    return entry;
  }

  /** LRU 驱逐一个非在用源（未在用时关其空闲计时器并 dispose）。 */
  private evictIdleSource(): void {
    for (const [assetId, entry] of this.sources) {
      if (entry.busy) continue;
      if (entry.idleTimerCancel) entry.idleTimerCancel();
      entry.source.dispose();
      this.sources.delete(assetId);
      return;
    }
  }

  private armIdleTimer(assetId: string, entry: SourceEntry): void {
    if (entry.idleTimerCancel) entry.idleTimerCancel();
    entry.idleTimerCancel = this.scheduleTimer(() => {
      if (entry.busy) { this.armIdleTimer(assetId, entry); return; }
      if (this.sources.get(assetId) === entry) {
        entry.source.dispose();
        this.sources.delete(assetId);
      }
    }, this.sourceIdleMs);
  }

  /** 取（或创建）素材帧源并执行请求。同步序言直达 loadFrame（video 回退
   *  路径的事件监听必须在 pump 的同步栈内注册——测试/真实 load 事件都依赖
   *  "请求发出后、事件到达前监听就绪"）；filmstrip 源创建才走异步。 */
  private runJob(job: QueueItem): Promise<ThumbnailFrame | null> {
    const entry = this.sources.get(job.assetId);
    if (entry) {
      if (entry.busy) return Promise.resolve(null); // 同素材上一帧仍在途：丢弃本轮（effect 重跑会补）
      return this.invokeSource(job, entry);
    }
    if (this.degradedAssets.has(job.assetId) || !this.createFilmstripSource) {
      const created = this.createVideoSource(job);
      return this.invokeSource(job, created);
    }
    if (this.sources.size >= this.maxActiveSources) this.evictIdleSource();
    if (this.sources.size >= this.maxActiveSources) {
      // 上限已满且无空闲可逐：丢弃本轮（effect 重跑会再请求）。
      return Promise.resolve(null);
    }
    return this.createFilmstripAndRun(job);
  }

  /** filmstrip 源异步创建后执行（init 失败降级 video 路径，按素材记忆）。 */
  private async createFilmstripAndRun(job: QueueItem): Promise<ThumbnailFrame | null> {
    let source: FrameSource | null = null;
    try {
      source = await this.createFilmstripSource!({ assetId: job.assetId, url: job.url });
    } catch (error) {
      diagWarn(`filmstrip init failed asset=${job.assetId}: ${error instanceof Error ? error.message : String(error)} → video 回退`);
      // init 失败（WebCodecs 不可用/编解码不支持/BMFF 解析失败）。
    }
    if (this.disposed) return null;
    if (!source) {
      this.degradedAssets.add(job.assetId);
      const created = this.createVideoSource(job);
      return this.invokeSource(job, created);
    }
    const entry: SourceEntry = { source, busy: false, lastUsedAt: Date.now(), idleTimerCancel: null };
    this.sources.set(job.assetId, entry);
    this.armIdleTimer(job.assetId, entry);
    if (entry.busy) return null;
    return this.invokeSource(job, entry);
  }

  /** P230-②a：filmstrip 帧级连续失败计数（每素材）。真机回归形态：demux/
   *  解码/票据在运行期失败 → loadFrame 静默 null → 缩略图永久空白且**无兜底**
   *  （旧实现只对 init 失败降级）。连续 3 次失败（3 个不同请求）→ 判定该素材
   *  filmstrip 不可用，降级 video seek 并记忆（会话级，与 degradedAssets 同语义）。
   *  成功即清零——瞬时抖动不触发降级。 */
  private readonly filmstripFailures = new Map<string, number>();
  private static readonly FILMSTRIP_FAIL_LIMIT = 3;

  private noteFilmstripResult(assetId: string, ok: boolean): void {
    if (ok) { this.filmstripFailures.delete(assetId); return; }
    const count = (this.filmstripFailures.get(assetId) ?? 0) + 1;
    this.filmstripFailures.set(assetId, count);
    if (count >= ThumbnailLoader.FILMSTRIP_FAIL_LIMIT) {
      diagWarn(`filmstrip failed ${count}× asset=${assetId} → 降级 video seek`);
      this.filmstripFailures.delete(assetId);
      this.degradedAssets.add(assetId);
      const entry = this.sources.get(assetId);
      if (entry) {
        if (entry.idleTimerCancel) entry.idleTimerCancel();
        if (!entry.busy) { entry.source.dispose(); this.sources.delete(assetId); }
      }
    }
  }

  /** 源互斥执行：同素材串行（解码器状态机约束）。loadFrame 在本异步函数的
   *  同步序言内调用（见 runJob 注释）。 */
  private async invokeSource(job: QueueItem, entry: SourceEntry): Promise<ThumbnailFrame | null> {
    entry.busy = true;
    try {
      const canvas = await entry.source.loadFrame(job.timeSec);
      // P230-②a：只有 filmstrip 源计入失败统计（video seek 失败有自己的
      // timeout 统计，且不应升级降级——它已是兜底）。
      if (!(entry.source instanceof VideoSeekFrameSource)) {
        this.noteFilmstripResult(job.assetId, canvas !== null);
      }
      return canvas ? { canvas, width: Math.max(2, canvas.width), height: Math.max(2, canvas.height) } : null;
    } finally {
      entry.busy = false;
      entry.lastUsedAt = Date.now();
      this.armIdleTimer(job.assetId, entry);
    }
  }

  /** 完成回调按 rAF 批量通知：一帧多次完成只通知一次上层。 */
  private scheduleBatchNotify(key: string): void {
    this.batchLoadedKeys.push(key);
    if (this.batchNotifyScheduled) return;
    this.batchNotifyScheduled = true;
    const flush = () => {
      this.batchNotifyScheduled = false;
      const keys = this.batchLoadedKeys;
      this.batchLoadedKeys = [];
      this.onBatchLoaded?.(keys);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else flush();
  }
}

/** 默认 filmstrip 源工厂（生产路径）：reissueTicket 走主进程轻量重签 IPC。 */
export function defaultFilmstripSourceFactory(reissueTicket: ReissueTicket) {
  return async ({ assetId, url }: { assetId: string; url: string }): Promise<FrameSource | null> => {
    return await FilmstripSource.create(assetId, url, reissueTicket);
  };
}
