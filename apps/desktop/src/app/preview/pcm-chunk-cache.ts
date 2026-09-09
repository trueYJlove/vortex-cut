/** B15 分块 PCM 块缓存（会话作用域）：块级 single-flight + 字节上限 LRU。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B15 加载策略）：
 * - 块 key = asset_id + generation + start_sample（整块键，不做半块窗口）；
 *   全局同 key single-flight：并发请求共享一次 ensure+fetch。
 * - 缓存按字节限制（B13 预算表 pcmCacheMiB 经会话注入）；LRU 逐出最旧
 *   未活跃（refCount=0）块——正在喂给 worklet 的块绝不逐出。
 * - 块字节 = 头 12B + 交错 f32 载荷；fetch 经票据 URL（ensure → media 两跳）。
 * - 失败不自动重试（retry 门语义同 A02）；generation 变更（seek epoch）
 *   使旧块不再接入新位置（消费侧释放，缓存条目待 LRU）。
 * - transfer 语义：块 PCM 为 Float32Array 消费者副本（每 worklet 独占——
 *  同源双位置混音不共享同一 buffer 引用 transfer 两次；缓存本体只读）。
 */
import type { PcmChunkDescription } from "@aivideo/contracts";

export const PCM_CHUNK_SAMPLES = 96_000;
export const PCM_CHANNELS = 2;
export const PCM_HEADER_BYTES = 12;

export interface PcmChunkDeps {
  ensurePcmChunk: (input: { project_id: string; asset_id: string; start_sample: number }) => Promise<PcmChunkDescription>;
  pcmChunkMediaUrl: (input: { project_id: string; asset_id: string; start_sample: number }) => Promise<{ media_url: string; cache_key: string; size_bytes: number }>;
}

export interface PcmChunk {
  /** 每声道有效样本数；< 96000 = 尾块/EOF；0 = 越界空块。 */
  validSamples: number;
  /** 交错 f32 PCM（缓存本体；transfer 前由消费方 slice 副本）。 */
  pcm: Float32Array;
  totalBytes: number;
}

type Entry = {
  state: "pending" | "ready" | "failed";
  promise: Promise<PcmChunk | null>;
  chunk: PcmChunk | null;
  /** 活跃消费者计数（worklet 持有中 = 不可 LRU 逐出）。 */
  users: number;
};

/** 字节上限默认 128MiB（B13 balanced 档；conservative/high 由会话注入）。 */
export const DEFAULT_PCM_CHUNK_CACHE_BYTES = 128 * 1024 * 1024;

export class PcmChunkCache {
  private readonly entries = new Map<string, Entry>();
  private cachedBytes = 0;
  private disposed = false;

  constructor(
    private readonly deps: PcmChunkDeps,
    private readonly projectId: string,
    private readonly maxCacheBytes = DEFAULT_PCM_CHUNK_CACHE_BYTES,
  ) {}

  get cachedByteCount(): number {
    return this.cachedBytes;
  }

  snapshot(): Array<{ key: string; state: Entry["state"]; users: number; bytes: number }> {
    return [...this.entries].map(([key, entry]) => ({
      key, state: entry.state, users: entry.users, bytes: entry.chunk?.totalBytes ?? 0,
    }));
  }

  /** 块键（generation 使 seek/换表后的旧块不再被新位置命中）。 */
  private keyFor(assetId: string, generation: number, startSample: number): string {
    return `${assetId}|${generation}|${startSample}`;
  }

  /** 取块（single-flight；null = 失败/未就绪——静默降级，由会话决策补零/暂停）。 */
  chunkFor(assetId: string, generation: number, startSample: number): Promise<PcmChunk | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = this.keyFor(assetId, generation, startSample);
    const existing = this.entries.get(key);
    if (existing) {
      return existing.state === "ready" ? Promise.resolve(existing.chunk) : existing.promise;
    }
    const task = (async (): Promise<PcmChunk | null> => {
      try {
        const description = await this.deps.ensurePcmChunk({
          project_id: this.projectId, asset_id: assetId, start_sample: startSample,
        });
        if (!description || description.status !== "ready") return null;
        // ensure 命中与生成路径都要取件（块 PCM 本体在派生缓存文件里）
        return await this.fetchChunk(assetId, generation, startSample, description);
      } catch {
        this.settle(key, "failed", null);
        return null;
      }
    })();
    this.entries.set(key, { state: "pending", promise: task, chunk: null, users: 0 });
    return task;
  }

  private async fetchChunk(
    assetId: string, generation: number, startSample: number,
    description: PcmChunkDescription,
  ): Promise<PcmChunk | null> {
    const key = this.keyFor(assetId, generation, startSample);
    try {
      const media = await this.deps.pcmChunkMediaUrl({
        project_id: this.projectId, asset_id: assetId, start_sample: startSample,
      });
      if (!media || typeof media.media_url !== "string") throw new Error("pcm media invalid");
      const response = await fetch(media.media_url);
      if (!response.ok) throw new Error(`pcm fetch failed: ${response.status}`);
      const data = await response.arrayBuffer();
      const chunk = parsePcmChunkFile(data, description);
      if (!chunk) throw new Error("pcm chunk parse failed");
      this.evictFor(chunk.totalBytes);
      this.settle(key, "ready", chunk);
      return chunk;
    } catch {
      this.settle(key, "failed", null);
      return null;
    }
  }

  /** 消费者登记（worklet appendChunk 前 pin；releaseBefore 后归还）。 */
  pin(assetId: string, generation: number, startSample: number): void {
    const entry = this.entries.get(this.keyFor(assetId, generation, startSample));
    if (entry) entry.users += 1;
  }

  unpin(assetId: string, generation: number, startSample: number): void {
    const entry = this.entries.get(this.keyFor(assetId, generation, startSample));
    if (entry && entry.users > 0) entry.users -= 1;
  }

  /** 同步取已 ready 块（喂 worklet 路径；未就绪 null）。 */
  readyChunk(assetId: string, generation: number, startSample: number): PcmChunk | null {
    if (this.disposed) return null;
    const entry = this.entries.get(this.keyFor(assetId, generation, startSample));
    return entry?.state === "ready" ? entry.chunk : null;
  }

  /** 失败重试门（票据刷新/用户动作后）。 */
  retry(assetId: string, generation: number, startSample: number): void {
    const entry = this.entries.get(this.keyFor(assetId, generation, startSample));
    if (entry && entry.state === "failed") this.entries.delete(this.keyFor(assetId, generation, startSample));
  }

  /** generation 作废：旧代块整体出缓存（字节归还；正在消费的引用由
   *  消费方 releaseBefore 自行清理——缓存侧不再被新位置命中）。 */
  invalidateGeneration(assetId: string, generation: number): void {
    const prefix = `${assetId}|${generation}|`;
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(prefix)) continue;
      if (entry.chunk) this.cachedBytes -= entry.chunk.totalBytes;
      this.entries.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.cachedBytes = 0;
  }

  private settle(key: string, state: Entry["state"], chunk: PcmChunk | null): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.state = state;
    entry.chunk = chunk;
    if (chunk) this.cachedBytes += chunk.totalBytes;
  }

  private evictFor(incomingBytes: number): void {
    while (this.cachedBytes + incomingBytes > this.maxCacheBytes) {
      let victimKey: string | null = null;
      let victimBytes = 0;
      for (const [key, entry] of this.entries) {
        if (entry.state !== "ready" || !entry.chunk) continue;
        if (entry.users > 0) continue; // 活跃消费者：正确性优先
        victimKey = key;
        victimBytes = entry.chunk.totalBytes;
        break;
      }
      if (victimKey === null) return;
      this.cachedBytes -= victimBytes;
      this.entries.delete(victimKey);
    }
  }
}

/** 解析块文件（12B 头 + 交错 f32）。头/描述不一致 → null（损坏降级）。 */
export function parsePcmChunkFile(data: ArrayBuffer, description: PcmChunkDescription): PcmChunk | null {
  if (data.byteLength < PCM_HEADER_BYTES) return null;
  const view = new DataView(data);
  const startSample = view.getUint32(0, true);
  const validSamples = view.getUint32(4, true);
  const sampleRateKhz = view.getUint16(8, true);
  const channels = view.getUint16(10, true);
  if (startSample !== description.start_sample) return null;
  if (sampleRateKhz !== description.sample_rate / 1000) return null;
  if (channels !== description.channels) return null;
  if (description.valid_samples !== null && validSamples !== description.valid_samples) return null;
  const floats = Math.floor((data.byteLength - PCM_HEADER_BYTES) / 4);
  const samples = Math.floor(floats / PCM_CHANNELS);
  if (validSamples !== samples && validSamples !== PCM_CHUNK_SAMPLES) return null;
  const pcm = new Float32Array(floats);
  for (let i = 0; i < floats; i += 1) {
    pcm[i] = view.getFloat32(PCM_HEADER_BYTES + i * 4, true);
  }
  return { validSamples: Math.min(validSamples, samples), pcm, totalBytes: data.byteLength };
}
