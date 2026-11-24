/** B14 素材级持久化波形缓存（Renderer 侧）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B14）：
 * - 移除生产 fetch 完整媒体 → decodeAudioData → 主线程扫描链；波形
 *   峰值来自 Core 派生缓存（kind=waveform 金字塔二进制产物）。
 * - key 按 asset（内容寻址 cache_key 由服务端按 fingerprint+算法参数
 *   生成——Renderer 侧以 assetId 为会话内索引，票据仅作一次性取件）。
 * - 同 asset single-flight：并发调用共享一次 describe/fetch。
 * - pending（queued/building/running）**退避重查直至 ready/failed**——
 *   否则作业完成后客户端永远停在 null，时间轴画不出波形（2026-09 现场）。
 *   失败不每帧重试，仅显式 retry()。
 * - clip 显示映射使用 source_start/end、speed、reverse（对齐
 *   computeFrameRequests 的映射公式）；同源不同 trim 各自正确取窗。
 * - 渲染端按可见像素投影源峰值，保留 OpenFilm 的 max-window 与插值规则；
 *   相同源区间/像素宽度跨画布重绘时复用有界 LRU 投影缓存。
 * - 内存记账：金字塔总字节（文件大小）计入 entries 缓存上限（MiB，
 *   默认 64MiB——B13 预算表的 PCM/波形缓存档位可由调用方注入）。
 */
import type { WaveformDescription } from "@aivideo/contracts";

export interface WaveformDeps {
  getWaveform: (input: { project_id: string; asset_id: string; generate?: boolean }) => Promise<WaveformDescription>;
  waveformMediaUrl: (input: { project_id: string; asset_id: string }) => Promise<{ media_url: string; cache_key: string; size_bytes: number }>;
}

export interface WaveformPyramid {
  /** level 0（最细）桶数；level k 桶数 = ceil(base / 2^k)。 */
  baseBuckets: number;
  levels: number;
  /** 逐层 [min,max] 桶（低层在前；与 Core write 约定一致）。 */
  levelData: Float32Array[];
  totalBytes: number;
}

export interface WaveformRequest {
  clipId: string;
  assetId: string;
  /** 源区间（µs，1x 源时间域）。 */
  sourceStartUs: number;
  sourceEndUs: number;
  /** 1000 = 1x。 */
  speedMilli: number;
  reverse: boolean;
}

export interface WaveformPeaks {
  /** 每桶峰值（0..1，= max(|min|,|max|)）。 */
  peaks: Float32Array;
}

/** 解析 Core 波形二进制产物（magic + JSON header + 逐层 float32）。 */
export function parseWaveformFile(data: ArrayBuffer): WaveformPyramid {
  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();
  if (bytes.length < 12) throw new Error("waveform file too short");
  const magic = decoder.decode(bytes.subarray(0, 8));
  if (magic !== "AIVSWF01") throw new Error("waveform magic mismatch");
  const headerLen = new DataView(data).getUint32(8, true);
  const headerEnd = 12 + headerLen;
  if (headerEnd > bytes.length) throw new Error("waveform header truncated");
  const header = JSON.parse(decoder.decode(bytes.subarray(12, headerEnd))) as {
    base_buckets: number; levels: number;
  };
  const baseBuckets = Number(header.base_buckets);
  const levelCount = Number(header.levels);
  if (!Number.isInteger(baseBuckets) || baseBuckets < 0 || !Number.isInteger(levelCount) || levelCount < 1) {
    throw new Error("waveform header fields invalid");
  }
  const view = new DataView(data);
  const levelData: Float32Array[] = [];
  let cursor = headerEnd;
  for (let level = 0; level < levelCount; level += 1) {
    const buckets = level === 0
      ? baseBuckets
      : Math.max(1, Math.ceil(baseBuckets / 2 ** level));
    const floats = buckets * 2;
    if (cursor + floats * 4 > bytes.length) throw new Error("waveform level truncated");
    // float32 桶序列：[min0, max0, min1, max1, ...]
    const values = new Float32Array(floats);
    for (let i = 0; i < floats; i += 1) {
      values[i] = view.getFloat32(cursor + i * 4, true);
    }
    cursor += floats * 4;
    levelData.push(values);
    if (buckets <= 1) break; // 顶层到 1 桶为止（levels 冗余保护）
  }
  return { baseBuckets, levels: levelData.length, levelData, totalBytes: bytes.length };
}

/** 选层：每像素约一桶（clip 像素宽 × 速度因子 → 源时间窗桶数）。 */
export function pickLevel(pyramid: WaveformPyramid, bucketSpanUs: number, sourceWindowUs: number, pixelWidth: number): number {
  if (pixelWidth <= 0 || sourceWindowUs <= 0 || pyramid.baseBuckets === 0) return pyramid.levels - 1;
  // 源窗内 base 桶数 / 像素 ≈ 每像素 base 桶数；向上取 2^k 层级
  const bucketsPerPixel = (sourceWindowUs / bucketSpanUs) / pixelWidth;
  if (bucketsPerPixel <= 0 || !Number.isFinite(bucketsPerPixel)) return 0;
  let level = 0;
  while (level + 1 < pyramid.levels && 2 ** level < bucketsPerPixel) level += 1;
  return level;
}

/** clip 源区间 → 峰值数组（映射含速度/倒放，对齐 filmstrip 公式）。 */
export function peaksForClip(
  pyramid: WaveformPyramid,
  bucketSpanUs: number,
  request: WaveformRequest,
  peakCount: number,
): WaveformPeaks | null {
  const speed = request.speedMilli / 1000;
  const timelineDurUs = (request.sourceEndUs - request.sourceStartUs) / (speed > 0 ? speed : 1);
  if (peakCount <= 0 || timelineDurUs <= 0 || pyramid.baseBuckets === 0) return null;
  // OpenFilm projects the source envelope into each screen pixel with a max over
  // the exact source window. A coarser pyramid level can pull a nearby transient
  // into an adjacent pixel (visible as a smoother, wider waveform), so use the
  // base buckets here. The UI cache memoizes this projection across redraws.
  const values = pyramid.levelData[0];
  if (!values) return null;
  const buckets = values.length / 2;
  const peaks = new Float32Array(peakCount);
  const srcSpanUs = request.sourceEndUs - request.sourceStartUs;
  const sourceDurationUs = Math.min(pyramid.baseBuckets, buckets) * bucketSpanUs;
  const bucketsPerPixel = srcSpanUs / bucketSpanUs / peakCount;
  for (let i = 0; i < peakCount; i += 1) {
    if (bucketsPerPixel < 1) {
      // OpenFilm interpolates adjacent envelope samples when the zoom shows
      // more than one pixel per source bucket; do the same instead of repeating
      // each bucket across several columns.
      const atUs = request.reverse
        ? request.sourceEndUs - ((i + 1) / peakCount) * srcSpanUs
        : request.sourceStartUs + (i / peakCount) * srcSpanUs;
      const at = atUs / bucketSpanUs;
      if (at < 0 || at >= buckets) continue;
      const left = Math.floor(at);
      const right = Math.min(buckets - 1, left + 1);
      const mix = at - left;
      const leftPeak = Math.max(Math.abs(values[left * 2]), Math.abs(values[left * 2 + 1]));
      const rightPeak = Math.max(Math.abs(values[right * 2]), Math.abs(values[right * 2 + 1]));
      peaks[i] = Math.min(1, leftPeak * (1 - mix) + rightPeak * mix);
      continue;
    }
    // 第 i 个显示柱覆盖源窗 [i/n, (i+1)/n)；倒放则时间轴正向对应源尾→头。
    // 窗内取 max（包络）——单点采样会漏掉窗内瞬时峰值，显得“缺块”。
    const t0 = i / peakCount;
    const t1 = (i + 1) / peakCount;
    let srcFromUs: number;
    let srcToUs: number;
    if (request.reverse) {
      srcFromUs = request.sourceEndUs - t1 * srcSpanUs;
      srcToUs = request.sourceEndUs - t0 * srcSpanUs;
    } else {
      srcFromUs = request.sourceStartUs + t0 * srcSpanUs;
      srcToUs = request.sourceStartUs + t1 * srcSpanUs;
    }
    const clippedFromUs = Math.max(0, srcFromUs);
    const clippedToUs = Math.min(sourceDurationUs, srcToUs);
    if (clippedToUs <= clippedFromUs) continue;
    const b0 = Math.min(buckets - 1, Math.max(0, Math.floor(clippedFromUs / bucketSpanUs)));
    const b1 = Math.min(buckets - 1, Math.max(0, Math.ceil(clippedToUs / bucketSpanUs) - 1));
    let peak = 0;
    for (let b = b0; b <= b1; b += 1) {
      const min = values[b * 2];
      const max = values[b * 2 + 1];
      const v = Math.max(Math.abs(min), Math.abs(max));
      if (v > peak) peak = v;
    }
    peaks[i] = Math.min(1, peak);
  }
  return { peaks };
}

type EntryState = "pending" | "ready" | "failed";

interface CacheEntry {
  state: EntryState;
  pyramid: WaveformPyramid | null;
  bucketSpanUs: number;
  promise: Promise<WaveformPyramid | null>;
  /** 世代号：retry/重建后旧 in-flight settle 不得写入新条目。 */
  seq: number;
}

/** 轨道波形缓存上限（字节；金字塔文件量级——1 小时源全金字塔 ≈ 8.6MiB）。 */
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** pending 重查退避（ms）：400 → 800 → 1600 → 封顶 2000。 */
const PENDING_POLL_BASE_MS = 400;
const PENDING_POLL_MAX_MS = 2000;

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WaveformCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Exact pixel projections reused while the canvas redraws during pointer/zoom gestures. */
  private readonly projections = new Map<string, Float32Array>();
  private projectionBytes = 0;
  private readonly maxProjectionBytes = 4 * 1024 * 1024;
  private cachedBytes = 0;
  private disposed = false;
  private nextSeq = 1;

  constructor(
    private readonly deps: WaveformDeps,
    private readonly projectId: string,
    private readonly maxCacheBytes = DEFAULT_MAX_CACHE_BYTES,
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  /** 条目快照（诊断/测试断言）。 */
  snapshot(): Array<{ assetId: string; state: EntryState; bytes: number }> {
    return [...this.entries].map(([assetId, entry]) => ({
      assetId, state: entry.state, bytes: entry.pyramid?.totalBytes ?? 0,
    }));
  }

  get cachedByteCount(): number {
    return this.cachedBytes;
  }

  /**
   * 素材 → 金字塔（null = 失败/已释放；不抛错——波形缺失静默降级）。
   * 同 asset single-flight。queued/building/running 期间退避重查，ready 后
   * 解析取件并 resolve 金字塔（调用方 `.then` 可 bump 重绘）。
   */
  pyramidFor(assetId: string): Promise<WaveformPyramid | null> {
    if (this.disposed) return Promise.resolve(null);
    const cached = this.entries.get(assetId);
    if (cached?.state === "ready") return Promise.resolve(cached.pyramid);
    if (cached) return cached.promise;
    const seq = this.nextSeq++;
    // 先落条目再启动 load：isCurrent 依赖条目已存在（否则首轮直接判失败）。
    const entry: CacheEntry = {
      state: "pending", pyramid: null, bucketSpanUs: 0,
      promise: Promise.resolve(null), seq,
    };
    this.entries.set(assetId, entry);
    entry.promise = this.loadUntilSettled(assetId, seq);
    return entry.promise;
  }

  /** 同步取已 ready 的峰值（绘制路径用——无 await，未就绪返回 null）。 */
  peaksFor(request: WaveformRequest, peakCount: number): Float32Array | null {
    if (this.disposed) return null;
    const entry = this.entries.get(request.assetId);
    if (!entry || entry.state !== "ready" || !entry.pyramid) return null;
    const key = [request.assetId, entry.seq, request.clipId, request.sourceStartUs, request.sourceEndUs,
      request.speedMilli, request.reverse ? 1 : 0, peakCount].join("\0");
    const cached = this.projections.get(key);
    if (cached) {
      this.projections.delete(key);
      this.projections.set(key, cached);
      return cached;
    }
    const result = peaksForClip(entry.pyramid, entry.bucketSpanUs, request, peakCount);
    if (result && result.peaks.byteLength <= this.maxProjectionBytes) {
      while (this.projectionBytes + result.peaks.byteLength > this.maxProjectionBytes) {
        const oldestKey = this.projections.keys().next();
        if (oldestKey.done) break;
        const oldest = this.projections.get(oldestKey.value);
        if (oldest) this.projectionBytes -= oldest.byteLength;
        this.projections.delete(oldestKey.value);
      }
      this.projections.set(key, result.peaks);
      this.projectionBytes += result.peaks.byteLength;
    }
    return result?.peaks ?? null;
  }

  /** 显式重试门（清 failed/pending 后允许再查；ready 不动）。 */
  retry(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (!entry || entry.state === "ready") return;
    this.clearProjections(assetId);
    if (entry.pyramid) this.cachedBytes -= entry.pyramid.totalBytes;
    this.entries.delete(assetId);
  }

  /** 释放全部（卸载/切项目）；在途 load 见 disposed 后尽快落定。 */
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.projections.clear();
    this.projectionBytes = 0;
    this.cachedBytes = 0;
  }

  /** describe/fetch 轮询直至 ready 或 failed；pending 按退避重查。 */
  private async loadUntilSettled(assetId: string, seq: number): Promise<WaveformPyramid | null> {
    let delay = PENDING_POLL_BASE_MS;
    while (!this.disposed) {
      if (!this.isCurrent(assetId, seq)) return null;
      let description: WaveformDescription | undefined;
      try {
        description = await this.deps.getWaveform({
          project_id: this.projectId, asset_id: assetId, generate: true,
        });
      } catch {
        this.settle(assetId, seq, "failed", null, 0);
        return null;
      }
      if (!this.isCurrent(assetId, seq)) return null;
      // 假件/异常解析结果（undefined 或缺字段）一律按失败降级——波形缺失
      // 静默跳过，不抛错阻塞时间轴。
      if (!description || typeof description !== "object" || !("status" in description)) {
        this.settle(assetId, seq, "failed", null, 0);
        return null;
      }
      if (description.status === "failed") {
        this.settle(assetId, seq, "failed", null, 0);
        return null;
      }
      if (description.status === "ready") {
        try {
          const media = await this.deps.waveformMediaUrl({
            project_id: this.projectId, asset_id: assetId,
          });
          if (!media || typeof media.media_url !== "string") throw new Error("waveform media invalid");
          const response = await fetch(media.media_url);
          if (!response.ok) throw new Error(`waveform fetch failed: ${response.status}`);
          const data = await response.arrayBuffer();
          const pyramid = parseWaveformFile(data);
          const bucketSpanUs = (description.bucket * 1_000_000) / description.sample_rate;
          if (!this.isCurrent(assetId, seq)) return null;
          this.evictFor(pyramid.totalBytes);
          this.settle(assetId, seq, "ready", pyramid, bucketSpanUs);
          return pyramid;
        } catch {
          this.settle(assetId, seq, "failed", null, 0);
          return null;
        }
      }
      // queued / building / running / null：生成在途——退避后重查
      // （generate:true 对已有 queued/building 条目幂等，不会重复登记作业）。
      if (this.disposed) return null;
      await this.sleep(delay);
      if (this.disposed || !this.isCurrent(assetId, seq)) return null;
      delay = Math.min(delay * 2, PENDING_POLL_MAX_MS);
    }
    return null;
  }

  private isCurrent(assetId: string, seq: number): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(assetId);
    return entry !== undefined && entry.seq === seq;
  }

  private settle(
    assetId: string, seq: number, state: EntryState,
    pyramid: WaveformPyramid | null, bucketSpanUs: number,
  ): void {
    const entry = this.entries.get(assetId);
    if (!entry || entry.seq !== seq) return;
    entry.state = state;
    entry.pyramid = pyramid;
    entry.bucketSpanUs = bucketSpanUs;
    if (pyramid) this.cachedBytes += pyramid.totalBytes;
  }

  private evictFor(incomingBytes: number): void {
    // LRU（Map 插入序）逐出直到装得下；不逐正在写入的 entry 自身
    while (this.cachedBytes + incomingBytes > this.maxCacheBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      if (entry?.pyramid) this.cachedBytes -= entry.pyramid.totalBytes;
      this.clearProjections(oldest.value);
      this.entries.delete(oldest.value);
    }
  }

  private clearProjections(assetId: string): void {
    for (const [key, values] of this.projections) {
      if (!key.startsWith(`${assetId}\0`)) continue;
      this.projectionBytes -= values.byteLength;
      this.projections.delete(key);
    }
  }
}
