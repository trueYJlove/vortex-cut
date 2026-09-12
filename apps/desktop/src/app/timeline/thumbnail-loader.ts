/** 时间线缩略图加载器（A08）：从 TimelineCanvas 抽出的帧请求调度。

 *  - 组件/项目作用域 owner：每个 TimelinePanel 实例一个 loader（非全局
 *    单例——旧实现共享全局 video 元素，跨项目切换会串状态）。
 *  - 请求含 owner、viewportEpoch、priority、assetKey、sourceTime、
 *    sizeBucket；尚未开始的旧 viewport 任务取消（epoch 失配即丢），
 *    active 任务最多一个（隐藏 video 元素串行 seek 的固有约束）。
 *  - loadeddata/seeked 超时初值 5 秒；finally 无条件清监听器并继续队列
 *    （坏媒体不堵住后续请求）。
 *  - seek 同 currentTime 时直接取当前已就绪帧，不等待不会发生的 seeked。
 *  - 完成回调按 rAF 批量通知（一帧多次到达只触发一次上层重渲）。
 *  - 缓存按 key（asset+sourceTime+sizeBucket+content generation）共享，
 *    维持条数上限并做 bytes 记账（width*height*4 估算）。
 */
export interface ThumbnailRequest {
  /** 帧缓存键（调用方组合 asset/帧序/档位）。 */
  key: string;
  /** 媒体 URL（票据 URL）。 */
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

export interface ThumbnailLoaderOptions {
  /** 帧缓存条数上限（默认 600，与旧实现一致）。 */
  maxEntries?: number;
  /** 单请求超时（ms，默认 5000）。 */
  requestTimeoutMs?: number;
  /** 完成通知节流（rAF；jsdom 无 rAF 时直接同步）。 */
  onBatchLoaded?: (keys: string[]) => void;
  /** 供测试注入的隐藏 video 工厂。 */
  createVideo?: () => HTMLVideoElement | null;
  /** 供测试注入的计时函数。 */
  scheduleTimer?: (callback: () => void, ms: number) => () => void;
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

export class ThumbnailLoader {
  private readonly cache = new Map<string, ThumbnailFrame>();
  private readonly pendingKeys = new Set<string>();
  private readonly queue: QueueItem[] = [];
  private busy = false;
  private disposed = false;
  private video: HTMLVideoElement | null = null;
  private currentUrl: string | null = null;
  private readonly maxEntries: number;
  private readonly requestTimeoutMs: number;
  private readonly onBatchLoaded: ((keys: string[]) => void) | undefined;
  private readonly createVideo: () => HTMLVideoElement | null;
  private readonly scheduleTimer: (callback: () => void, ms: number) => () => void;
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

  /** seek 同 currentTime 时直接取当前已就绪帧（不等待不会发生的 seeked）。 */
  private async runJob(job: QueueItem): Promise<ThumbnailFrame | null> {
    const video = this.ensureVideo();
    if (!video) return null;
    try {
      if (this.currentUrl !== job.url) {
        await this.awaitEvent(
          video,
          ["loadeddata"],
          "load",
          () => { video.src = job.url; this.currentUrl = job.url; video.load(); },
          this.requestTimeoutMs,
        );
      }
      if (video.readyState < 2) return null;
      const target = Math.max(0, job.timeSec);
      if (Math.abs(video.currentTime - target) > 1e-4) {
        await this.awaitEvent(
          video,
          ["seeked"],
          "seek",
          () => { video.currentTime = target; },
          this.requestTimeoutMs,
        );
      }
      const width = Math.max(2, Math.min(160, video.videoWidth || 96));
      const height = Math.max(2, Math.round((width * (video.videoHeight || 54)) / (video.videoWidth || 96)));
      const frame = document.createElement("canvas");
      frame.width = width;
      frame.height = height;
      const ctx = frame.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, width, height);
      return { canvas: frame, width, height };
    } catch {
      return null; // 解码/寻址/超时失败：跳过该帧（不堵队列）。
    }
  }

  private ensureVideo(): HTMLVideoElement | null {
    if (this.video) return this.video;
    this.video = this.createVideo();
    return this.video;
  }

  /** 事件等待 + 超时：finally 无条件清理监听器（坏媒体不泄漏监听）。 */
  private awaitEvent(
    target: HTMLVideoElement,
    successEvents: string[],
    _phase: string,
    begin: () => void,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const cancelTimer = this.scheduleTimer(() => {
        if (done) return;
        done = true;
        cleanup();
        this.stats.timeouts += 1;
        reject(new Error("thumbnail request timed out"));
      }, timeoutMs);
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
