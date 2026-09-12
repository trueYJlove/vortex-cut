/** B14 素材级持久化波形缓存（Renderer 侧）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B14）：
 * - 移除生产 fetch 完整媒体 → decodeAudioData → 主线程扫描链；波形
 *   峰值来自 Core 派生缓存（kind=waveform 金字塔二进制产物）。
 * - key 按 asset（内容寻址 cache_key 由服务端按 fingerprint+算法参数
 *   生成——Renderer 侧以 assetId 为会话内索引，票据仅作一次性取件）。
 * - 同 asset single-flight：多次调用共享一次 describe/fetch；失败不每
 *   帧重试（pending 状态期间跳过，由调用方下轮视口变更再触发）。
 * - clip 显示映射使用 source_start/end、speed、reverse（对齐
 *   computeFrameRequests 的映射公式）；同源不同 trim 各自正确取窗。
 * - 渲染端按 clip 宽度选金字塔层（每像素一桶即可——更细层无显示增益），
 *   桶采样取窗内 max(|min|,|max|)。
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
  const level = pickLevel(pyramid, bucketSpanUs, request.sourceEndUs - request.sourceStartUs, peakCount);
  const values = pyramid.levelData[level];
  if (!values) return null;
  const buckets = values.length / 2;
  const peaks = new Float32Array(peakCount);
  const sampleRatePerUs = 1 / bucketSpanUs; // 桶/µs（该层）
  for (let i = 0; i < peakCount; i += 1) {
    // clip 内第 i 桶 → 源时间（1x 源域）；reverse 从 sourceEnd 反向
    const offsetUs = ((i + 0.5) / peakCount) * timelineDurUs * (speed > 0 ? speed : 1);
    const srcUs = request.reverse
      ? request.sourceEndUs - offsetUs
      : request.sourceStartUs + offsetUs;
    const bucket = Math.min(buckets - 1, Math.max(0, Math.floor(srcUs * sampleRatePerUs)));
    const min = values[bucket * 2];
    const max = values[bucket * 2 + 1];
    peaks[i] = Math.min(1, Math.max(Math.abs(min), Math.abs(max)));
  }
  return { peaks };
}

type EntryState = "pending" | "ready" | "failed";

interface CacheEntry {
  state: EntryState;
  pyramid: WaveformPyramid | null;
  bucketSpanUs: number;
  promise: Promise<WaveformPyramid | null>;
}

/** 轨道波形缓存上限（字节；金字塔文件量级——1 小时源全金字塔 ≈ 8.6MiB）。 */
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

export class WaveformCache {
  private readonly entries = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private disposed = false;

  constructor(
    private readonly deps: WaveformDeps,
    private readonly projectId: string,
    private readonly maxCacheBytes = DEFAULT_MAX_CACHE_BYTES,
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

  /** 素材 → 金字塔（null = 不可用/未就绪；不抛错——波形缺失静默降级）。
   * 同 asset single-flight；pending 描述后首次 ready 再取件解析。 */
  pyramidFor(assetId: string): Promise<WaveformPyramid | null> {
    if (this.disposed) return Promise.resolve(null);
    const cached = this.entries.get(assetId);
    if (cached) return cached.state === "ready" ? Promise.resolve(cached.pyramid) : cached.promise;
    const task = (async (): Promise<WaveformPyramid | null> => {
      let description: WaveformDescription | undefined;
      try {
        description = await this.deps.getWaveform({
          project_id: this.projectId, asset_id: assetId, generate: true,
        });
      } catch {
        description = undefined;
      }
      // 假件/异常解析结果（undefined 或缺字段）一律按失败降级——波形缺失
      // 静默跳过，不抛错阻塞时间轴。
      if (!description || typeof description !== "object" || !("status" in description)) {
        this.settle(assetId, "failed", null, 0);
        return null;
      }
      if (description.status !== "ready") {
        // building/queued：留 pending 条目（同轮视口变更不再重复登记作业）
        this.settle(assetId, "pending", null, 0);
        return null;
      }
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
        this.evictFor(pyramid.totalBytes);
        this.settle(assetId, "ready", pyramid, bucketSpanUs);
        return pyramid;
      } catch {
        this.settle(assetId, "failed", null, 0);
        return null;
      }
    })();
    this.entries.set(assetId, { state: "pending", pyramid: null, bucketSpanUs: 0, promise: task });
    return task;
  }

  /** 同步取已 ready 的峰值（绘制路径用——无 await，未就绪返回 null）。 */
  peaksFor(request: WaveformRequest, peakCount: number): Float32Array | null {
    if (this.disposed) return null;
    const entry = this.entries.get(request.assetId);
    if (!entry || entry.state !== "ready" || !entry.pyramid) return null;
    const result = peaksForClip(entry.pyramid, entry.bucketSpanUs, request, peakCount);
    return result?.peaks ?? null;
  }

  /** 显式重试门（票据刷新/用户动作后；pending/ready 不动）。 */
  retry(assetId: string): void {
    const entry = this.entries.get(assetId);
    if (entry && entry.state === "failed") this.entries.delete(assetId);
  }

  /** 释放全部（卸载/切项目）。 */
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.cachedBytes = 0;
  }

  private settle(assetId: string, state: EntryState, pyramid: WaveformPyramid | null, bucketSpanUs: number): void {
    const entry = this.entries.get(assetId);
    if (!entry) return;
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
      this.entries.delete(oldest.value);
    }
  }
}
