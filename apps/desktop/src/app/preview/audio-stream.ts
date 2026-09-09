/** B15 音频流加载策略（会话作用域）：位置窗口驱动的块请求调度。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B15 加载策略）：
 * - 当前音频位置前后窗口覆盖至少 2 秒播放时间；4x 速度按源时间扩大
 *  需求（源时间窗 = 播放窗 × speed）。
 * - seek 增加 generation/epoch：旧块不能接入新位置（PcmChunkCache 按
 *  generation 键隔离；invalidateGeneration 归还旧代字节）。
 * - 同 key single-flight 由缓存承载；本层只做窗口计算与在途上限
 *  （并发 ensure ≤2——块生成是 FFmpeg 子进程，避免解码风暴）。
 * - 补零/underrun 决策不在本层（worklet 侧 underrun 事件 + 会话统一
 *  决策——计划"音频线程不私自倒退时钟"）。
 * - dispose 清理在途引用与端口监听（消费方 audio-stream 持有的 port
 *  由会话 dispose 关闭）。
 */
import { PCM_CHUNK_SAMPLES, PcmChunkCache, type PcmChunk } from "./pcm-chunk-cache.js";

/** 播放时间窗口（秒）：当前位前后各 2 秒。 */
const WINDOW_S = 2;
/** 并发 ensure 上限（FFmpeg 子进程数）。 */
const MAX_ENSURE_INFLIGHT = 2;

export interface AudioStreamWindow {
  /** 覆盖窗口的块起点列表（源采样网格，升序）。 */
  startSamples: number[];
}

/** 播放位置窗口 → 源块集合（speed 扩源需求）。纯函数（单测对象）。 */
export function windowChunks(
  positionSample: number,
  speed: number,
  sampleRate: number,
): number[] {
  const srcWindowSamples = Math.max(WINDOW_S, WINDOW_S) * sampleRate * Math.max(1, speed);
  const from = positionSample - srcWindowSamples;
  const to = positionSample + srcWindowSamples;
  const first = Math.max(0, Math.floor(from / PCM_CHUNK_SAMPLES) * PCM_CHUNK_SAMPLES);
  const last = Math.max(first, Math.floor(to / PCM_CHUNK_SAMPLES) * PCM_CHUNK_SAMPLES);
  const result: number[] = [];
  for (let start = first; start <= last; start += PCM_CHUNK_SAMPLES) {
    result.push(start);
  }
  return result;
}

export class AudioStreamLoader {
  private generation = 0;
  private inFlightEnsure = 0;
  private disposed = false;
  /** 已请求过的块（本轮窗口内不重复 ensure——缓存 single-flight 之外
   *  的第二层去重：pending 描述也计入）。 */
  private requested = new Set<string>();

  constructor(
    private readonly cache: PcmChunkCache,
    private readonly projectId: string,
    private readonly sampleRate: number,
  ) {}

  get currentGeneration(): number {
    return this.generation;
  }

  get inflightCount(): number {
    return this.inFlightEnsure;
  }

  /** seek/换表：新位置新世代（旧块不再接入；字节由缓存 LRU/作废归还）。 */
  reseek(): number {
    this.generation += 1;
    this.requested.clear();
    return this.generation;
  }

  /** 驱动一轮窗口：返回本轮需要喂给 worklet 的 ready 块（升序）。
   *  未就绪块触发 ensure（并发 ≤2，超出顺延下轮 tick）。 */
  drive(assetId: string, positionSample: number, speed: number): PcmChunk[] {
    if (this.disposed) return [];
    const generation = this.generation;
    const wanted = windowChunks(positionSample, speed, this.sampleRate);
    const ready: PcmChunk[] = [];
    for (const startSample of wanted) {
      const chunk = this.cache.readyChunk(assetId, generation, startSample);
      if (chunk) {
        ready.push(chunk);
        continue;
      }
      const dedupeKey = `${assetId}|${generation}|${startSample}`;
      if (this.requested.has(dedupeKey)) continue;
      if (this.inFlightEnsure >= MAX_ENSURE_INFLIGHT) continue;
      this.requested.add(dedupeKey);
      this.inFlightEnsure += 1;
      void this.cache.chunkFor(assetId, generation, startSample)
        .catch(() => null)
        .finally(() => { this.inFlightEnsure -= 1; });
    }
    return ready;
  }

  /** 直接请求一个块（启动/重锚即时路径）。 */
  requestChunk(assetId: string, startSample: number): Promise<PcmChunk | null> {
    if (this.disposed) return Promise.resolve(null);
    const generation = this.generation;
    this.requested.add(`${assetId}|${generation}|${startSample}`);
    return this.cache.chunkFor(assetId, generation, startSample);
  }

  /** 旧位置块释放（worklet releaseBefore 之后归还 pin）。 */
  releaseBefore(assetId: string, generation: number, startSample: number): void {
    this.cache.unpin(assetId, generation, startSample);
  }

  dispose(): void {
    this.disposed = true;
    this.requested.clear();
    this.cache.dispose();
  }
}
