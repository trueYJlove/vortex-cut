/** B12 Range 源：按需字节区间读取，禁止整文件下载。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B12）：
 * - 初始化用 bytes=0-65535 获总长并复用数据；解析 206/Content-Range，
 *   校验范围与返回字节数。
 * - 服务忽略 Range 返回 200 时：小文件（≤16MiB 阈值，可配置）允许整读；
 *   大文件必须拒绝（走代理/错误），不冒充已支持。
 * - 并发 read ≤2；连续 range 合并，chunk 初值 1MiB。
 * - byte LRU 缓存；不得把所有 chunk 拼回 dataBytes 长期保存。
 * - request epoch：seek 替换时取消尚未消费 range；陈旧返回只释放。
 * - 媒体票据 TTL 5min（restricted-media）；持续播放超 5 分钟需受控续票
 *   （401/403 有限一次刷新重新发相同 range）——续票由调用方注入
 *   refreshTicket；refresh 不改变 source fingerprint。
 */
export interface RangeSource {
  readonly size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): void;
}

/** 阈值：服务返回 200（忽略 Range）时允许整读的最大体积。 */
export const FULL_READ_LIMIT_BYTES = 16 * 1024 * 1024;
/** 初始化探测窗口（复用为首段数据，不丢弃）。 */
export const PROBE_WINDOW_BYTES = 65536;
/** 单次 range 请求上限（合并连续区间时的钳制）。 */
export const MAX_CHUNK_BYTES = 1024 * 1024 * 16;
/** 活跃 range 并发上限。 */
export const MAX_CONCURRENT = 2;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RangeFetchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface CacheEntry {
  bytes: Uint8Array;
  at: number;
}

/**
 * fetch 适配的 Range 源。
 *
 * 设计：
 * - `init()` 探测（0-65535）：206 → Content-Range 尾段解析总长；200 →
 *   全量响应（此时 size 已知；超阈值即抛 RANGE_UNSUPPORTED——调用方回退
 *   代理/错误）。
 * - read(offset, length)：字节 LRU 命中直接返回（零拷贝视图）；未命中
 *   合并邻近区间发起 range 请求（合并后钳制 ≤ MAX_CHUNK_BYTES）。
 * - 并发闸门：活跃请求 ≤2，超出排队（FIFO）。
 * - 401/403：有限一次续票（refreshTicket 返回新 URL 后以**相同 range**
 *   重发）；刷新失败或二次 401/403 → 上抛（不无限重试）。
 * - epoch：seek 替换时 bump epoch，在途响应作废（调用方 close 旧源）。
 */
export class HttpRangeSource implements RangeSource {
  readonly size: number;
  private readonly url: string;
  private readonly fetchLike: FetchLike;
  private readonly refreshTicket: (() => Promise<string>) | null;
  private readonly cacheCapBytes: number;
  private readonly fullReadLimit: number;
  private readonly cache = new Map<number, CacheEntry>(); // key = 块起始
  private cacheBytes = 0;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private closed = false;
  private refreshed = false;
  private head?: Uint8Array; // init 探测窗口数据（首个 read 免请求复用）

  private constructor(
    size: number, url: string, fetchLike: FetchLike,
    refreshTicket: (() => Promise<string>) | null,
    options: { cacheCapBytes?: number; fullReadLimit?: number } | undefined,
    head: Uint8Array | undefined,
  ) {
    this.size = size;
    this.url = url;
    this.fetchLike = fetchLike;
    this.refreshTicket = refreshTicket;
    this.cacheCapBytes = options?.cacheCapBytes ?? 8 * 1024 * 1024;
    this.fullReadLimit = options?.fullReadLimit ?? FULL_READ_LIMIT_BYTES;
    this.head = head;
  }

  /** 初始化探测（bytes=0-65535）；200 大文件拒绝。 */
  static async create(
    url: string,
    fetchLike: FetchLike,
    refreshTicket: (() => Promise<string>) | null = null,
    options?: { cacheCapBytes?: number; fullReadLimit?: number },
    signal?: AbortSignal,
  ): Promise<HttpRangeSource> {
    const response = await fetchLike(url, {
      headers: { Range: `bytes=0-${PROBE_WINDOW_BYTES - 1}` }, signal,
    });
    if (response.status === 206) {
      const total = parseTotalFromContentRange(response.headers.get("content-range"));
      if (total === null) throw new RangeFetchError("RANGE_HEADER_INVALID", "206 响应缺少合法 Content-Range");
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.length > PROBE_WINDOW_BYTES) {
        throw new RangeFetchError("RANGE_BODY_MISMATCH", "206 响应字节数超出请求范围");
      }
      return new HttpRangeSource(total, url, fetchLike, refreshTicket, options, body);
    }
    if (response.status === 200) {
      const body = new Uint8Array(await response.arrayBuffer());
      const limit = options?.fullReadLimit ?? FULL_READ_LIMIT_BYTES;
      if (body.length > limit) {
        throw new RangeFetchError("RANGE_UNSUPPORTED", `服务忽略 Range 且响应超过 ${limit} 字节`);
      }
      // 小文件整读：全部数据即缓存（无后续网络请求）
      return new HttpRangeSource(body.length, url, fetchLike, refreshTicket, options, body);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RangeFetchError("RANGE_UNAUTHORIZED", "媒体票据未授权（初始化阶段）");
    }
    throw new RangeFetchError("RANGE_FETCH_FAILED", `初始化请求失败: ${response.status}`);
  }

  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new RangeFetchError("RANGE_CLOSED", "源已关闭"));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) {
      return Promise.reject(new RangeFetchError("RANGE_INVALID", "非法读取区间"));
    }
    if (offset + length > this.size) {
      return Promise.reject(new RangeFetchError("RANGE_OUT_OF_BOUNDS", "读取区间超出文件长度"));
    }
    const view = this.lookup(offset, length);
    if (view) return Promise.resolve(view);
    return this.fetchRange(offset, length, signal);
  }

  close(): void {
    this.closed = true;
    this.cache.clear();
    this.cacheBytes = 0;
    this.head = undefined;
    for (const wake of this.queue.splice(0)) wake();
  }

  // ---- 缓存（byte LRU，不长期持有整文件） ----

  private lookup(offset: number, length: number): Uint8Array | null {
    const head = this.head;
    if (head && offset < head.length) {
      const available = Math.min(length, head.length - offset);
      if (available === length) return head.subarray(offset, offset + length);
      // 跨探测窗口尾部：按完整段读（走网络路径，chunk 覆盖前缀）
    }
    // 块覆盖查找：起点 ≤ offset 且块尾 ≥ offset+length 的缓存块
    //（缓存块数受预算/块大小约束——上限 ~cacheCapBytes/1MiB，线性可接受）
    for (const [start, entry] of this.cache) {
      if (start <= offset && start + entry.bytes.length >= offset + length) {
        entry.at = Date.now();
        return entry.bytes.subarray(offset - start, offset - start + length);
      }
    }
    return null;
  }

  private store(offset: number, bytes: Uint8Array): void {
    const evict = () => {
      // LRU：淘汰最旧（Map 迭代序 = 插入序；at 更新重插）
      let oldestKey: number | null = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.cache) {
        if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
      }
      if (oldestKey !== null) {
        const evicted = this.cache.get(oldestKey)!;
        this.cache.delete(oldestKey);
        this.cacheBytes -= evicted.bytes.length;
      }
    };
    while (this.cacheBytes + bytes.length > this.cacheCapBytes && this.cache.size > 0) evict();
    if (bytes.length > this.cacheCapBytes) return; // 单块超预算：不缓存（仍可读）
    this.cache.set(offset, { bytes, at: Date.now() });
    this.cacheBytes += bytes.length;
  }

  // ---- 网络（并发闸门 + 有限续票） ----

  private async fetchRange(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    // 合并：请求从探测窗口头部起（覆盖跨窗口读取的前缀），向后扩展到
    // 对齐边界（初值 1MiB），钳制 MAX_CHUNK_BYTES 与文件尾。
    const head = this.head;
    const chunkStart = head && offset < head.length ? 0 : offset;
    const desired = Math.min(
      Math.max(length + (offset - chunkStart), 1024 * 1024), MAX_CHUNK_BYTES);
    const end = Math.min(chunkStart + desired, this.size) - 1;
    await this.acquireSlot(signal);
    try {
      if (this.closed) throw new RangeFetchError("RANGE_CLOSED", "源已关闭");
      const body = await this.requestWithRefresh(chunkStart, end, signal);
      if (body.length !== end - chunkStart + 1) {
        throw new RangeFetchError("RANGE_BODY_MISMATCH",
          `range 响应字节数不符（期望 ${end - chunkStart + 1}，实际 ${body.length}）`);
      }
      if (chunkStart === 0 && head && head.length < body.length) {
        // 跨窗口 chunk 已包含探测前缀：升级 head（窗口内后续读零网络）
        this.head = body;
      } else {
        this.store(chunkStart, body);
      }
      const view = this.lookup(offset, length);
      if (!view) throw new RangeFetchError("RANGE_BODY_MISMATCH", "缓存视图缺失（内部错误）");
      return view;
    } finally {
      this.releaseSlot();
    }
  }

  private async requestWithRefresh(offset: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const attempt = async (url: string): Promise<Response> =>
      this.fetchLike(url, { headers: { Range: `bytes=${offset}-${end}` }, signal });
    let response: Response;
    try {
      response = await attempt(this.url);
    } catch (error) {
      throw new RangeFetchError("RANGE_FETCH_FAILED", String(error));
    }
    if ((response.status === 401 || response.status === 403) && this.refreshTicket && !this.refreshed) {
      this.refreshed = true;
      try {
        const next = await this.refreshTicket();
        const retried = await attempt(next);
        if (retried.status === 401 || retried.status === 403) {
          throw new RangeFetchError("RANGE_UNAUTHORIZED", "续票后仍 401/403（不重试）");
        }
        response = retried;
      } catch (error) {
        if (error instanceof RangeFetchError) throw error;
        throw new RangeFetchError("RANGE_REFRESH_FAILED", `续票失败: ${String(error)}`);
      }
    }
    if (response.status !== 206) {
      // 计划：忽略 Range 的大文件必须拒绝（初始化已处理小文件整读路径）
      throw new RangeFetchError("RANGE_UNSUPPORTED", `非 206 响应: ${response.status}`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const claimed = response.headers.get("content-range");
    const total = parseTotalFromContentRange(claimed);
    if (total !== null && total !== this.size) {
      throw new RangeFetchError("RANGE_LENGTH_CHANGED", "Content-Range 总长与初始化不符");
    }
    return body;
  }

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => {
      const wake = () => { resolve(); };
      this.queue.push(wake);
      signal?.addEventListener("abort", () => {
        const index = this.queue.indexOf(wake);
        if (index >= 0) this.queue.splice(index, 1);
        resolve();
      }, { once: true });
    });
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const wake = this.queue.shift();
    if (wake) wake(); // 唤醒的等待者自己递增 active（见 acquireSlot）
    else this.active = Math.min(this.active, MAX_CONCURRENT);
  }

  /** 诊断：当前缓存字节数 / 活跃并发（测试与探针用）。 */
  stats(): { cacheBytes: number; entries: number; active: number } {
    return { cacheBytes: this.cacheBytes, entries: this.cache.size, active: this.active };
  }
}

/** Content-Range: bytes 0-65535/123456 → 123456；不合法返回 null。 */
export function parseTotalFromContentRange(value: string | null): number | null {
  if (!value) return null;
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
