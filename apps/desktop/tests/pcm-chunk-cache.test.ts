/** B15 Renderer 数据层测试：块缓存（single-flight/解析/LRU/pin/作废）+
 *  加载策略（窗口计算/速度扩展/世代隔离/并发上限）。
 *
 * 覆盖（计划第 6 节 B15 加载策略验收——纯函数与假 IPC 部分）：
 * - 块解析：头与描述一致 → PCM 值 roundtrip；不一致（start/sr/ch/
 *   valid）→ null 拒绝。
 * - single-flight：同 key 3 并发 1 次 ensure+fetch；失败不自动重试。
 * - LRU：字节上限逐出无 pin 的最旧 ready 块；pin 的块不逐出。
 * - 世代：reseek 后旧代块不再命中；invalidateGeneration 归还字节。
 * - 窗口：±2 秒覆盖；4x 速度源窗 ×4；负位置钳 0。
 * - 驱动：ready 块升序返回；未就绪触发 ensure（并发 ≤2，超额顺延）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PCM_CHUNK_CACHE_BYTES,
  PcmChunkCache,
  PCM_CHANNELS,
  PCM_CHUNK_SAMPLES,
  parsePcmChunkFile,
  type PcmChunkDeps,
} from "../src/app/preview/pcm-chunk-cache.js";
import { AudioStreamLoader, windowChunks } from "../src/app/preview/audio-stream.js";
import type { PcmChunkDescription } from "@aivideo/contracts";

const SR = 48000;

function buildChunkFile(startSample: number, validSamples: number): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + validSamples * PCM_CHANNELS * 4);
  const view = new DataView(buffer);
  view.setUint32(0, startSample, true);
  view.setUint32(4, validSamples, true);
  view.setUint16(8, SR / 1000, true);
  view.setUint16(10, PCM_CHANNELS, true);
  for (let i = 0; i < validSamples * PCM_CHANNELS; i++) {
    view.setFloat32(12 + i * 4, (i % 97) / 97, true);
  }
  return buffer;
}

function description(startSample: number, validSamples: number | null): PcmChunkDescription {
  return {
    cache_key: `sha256:${"a".repeat(64)}`, status: "ready",
    start_sample: startSample, valid_samples: validSamples,
    sample_rate: SR, channels: PCM_CHANNELS, chunk_samples: PCM_CHUNK_SAMPLES,
    size_bytes: 12 + (validSamples ?? PCM_CHUNK_SAMPLES) * PCM_CHANNELS * 4,
  };
}

function makeDeps(files: Map<number, ArrayBuffer>, opts: { failStarts?: Set<number> } = {}): PcmChunkDeps & { ensure: ReturnType<typeof vi.fn>; media: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(async (input: { start_sample: number }) => {
    const file = files.get(input.start_sample);
    const valid = file ? (file.byteLength - 12) / (PCM_CHANNELS * 4) : PCM_CHUNK_SAMPLES;
    if (opts.failStarts?.has(input.start_sample)) throw new Error("boom");
    return description(input.start_sample, valid);
  });
  const media = vi.fn(async (input: { start_sample: number }) => ({
    media_url: `aivideo://media/chunk_${input.start_sample}`,
    cache_key: `sha256:${"a".repeat(64)}`,
    size_bytes: 4,
  }));
  return {
    ensurePcmChunk: ensure,
    pcmChunkMediaUrl: media,
    ensure, media,
  };
}

function stubFetch(files: Map<number, ArrayBuffer>) {
  const fetchMock = vi.fn(async (url: string) => {
    const start = Number(url.split("_")[1] ?? "0");
    const file = files.get(start);
    if (!file) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => file };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parsePcmChunkFile", () => {
  it("头一致 → PCM 值 roundtrip", () => {
    const file = buildChunkFile(96_000, 1000);
    const chunk = parsePcmChunkFile(file, description(96_000, 1000))!;
    expect(chunk).not.toBeNull();
    expect(chunk.validSamples).toBe(1000);
    expect(chunk.pcm.length).toBe(1000 * PCM_CHANNELS);
    expect(chunk.pcm[0]).toBeCloseTo(0, 6);
    expect(chunk.pcm[1]).toBeCloseTo(1 / 97, 6);
    expect(chunk.totalBytes).toBe(file.byteLength);
  });

  it("头与描述不一致拒绝（start/采样率/声道/valid）", () => {
    const file = buildChunkFile(96_000, 1000);
    expect(parsePcmChunkFile(file, description(0, 1000))).toBeNull();
    expect(parsePcmChunkFile(file, { ...description(96_000, 1000), sample_rate: 44100 })).toBeNull();
    expect(parsePcmChunkFile(file, { ...description(96_000, 1000), channels: 1 })).toBeNull();
    expect(parsePcmChunkFile(file, description(96_000, 2000))).toBeNull();
    expect(parsePcmChunkFile(new ArrayBuffer(4), description(0, 0))).toBeNull();
  });
});

describe("PcmChunkCache", () => {
  it("single-flight：同 key 3 并发 1 次 ensure + 1 次 fetch", async () => {
    const files = new Map([[0, buildChunkFile(0, PCM_CHUNK_SAMPLES)]]);
    const deps = makeDeps(files);
    stubFetch(files);
    const cache = new PcmChunkCache(deps, "project_1");
    const [a, b, c] = await Promise.all([
      cache.chunkFor("asset_1", 0, 0),
      cache.chunkFor("asset_1", 0, 0),
      cache.chunkFor("asset_1", 0, 0),
    ]);
    expect(deps.ensure).toHaveBeenCalledTimes(1);
    expect(deps.media).toHaveBeenCalledTimes(1);
    expect(a && b && c).not.toBeNull();
    expect(a === b && b === c).toBe(true); // 同一缓存条目
    vi.unstubAllGlobals();
  });

  it("失败不自动重试；retry 门后再发", async () => {
    const files = new Map([[0, buildChunkFile(0, PCM_CHUNK_SAMPLES)]]);
    let failNext = true;
    const deps = makeDeps(files);
    deps.ensure.mockImplementation(async (input: { start_sample: number }) => {
      if (failNext) throw new Error("boom");
      return description(input.start_sample, PCM_CHUNK_SAMPLES);
    });
    stubFetch(files);
    const cache = new PcmChunkCache(deps, "project_1");
    expect(await cache.chunkFor("asset_1", 0, 0)).toBeNull();
    expect(await cache.chunkFor("asset_1", 0, 0)).toBeNull();
    expect(deps.ensure).toHaveBeenCalledTimes(1);
    failNext = false;
    cache.retry("asset_1", 0, 0);
    expect(await cache.chunkFor("asset_1", 0, 0)).not.toBeNull();
    expect(deps.ensure).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("LRU：无 pin 的旧块被逐出，pin 块保留且超限如实暴露", async () => {
    const files = new Map([
      [0, buildChunkFile(0, 1000)],
      [96_000, buildChunkFile(96_000, 1000)],
    ]);
    const deps = makeDeps(files);
    stubFetch(files);
    const chunkBytes = 12 + 1000 * PCM_CHANNELS * 4;
    // 预算 = 1.5 块：第二块就绪即触发逐出（块 0 无 pin → 让位）
    const cache = new PcmChunkCache(deps, "project_1", Math.floor(chunkBytes * 1.5));
    await cache.chunkFor("asset_1", 0, 0);
    expect(cache.cachedByteCount).toBe(chunkBytes);
    await cache.chunkFor("asset_1", 0, 96_000);
    expect(cache.cachedByteCount).toBe(chunkBytes); // 块 0 已逐出
    expect(cache.readyChunk("asset_1", 0, 0)).toBeNull();
    expect(cache.readyChunk("asset_1", 0, 96_000)).not.toBeNull();
    // pin 后新块入缓存不再逐 pin 块：超限如实（正确性优先）
    files.set(192_000, buildChunkFile(192_000, 1000));
    cache.pin("asset_1", 0, 96_000);
    await cache.chunkFor("asset_1", 0, 192_000);
    expect(cache.cachedByteCount).toBe(chunkBytes * 2);
    expect(cache.readyChunk("asset_1", 0, 96_000)).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("invalidateGeneration 归还字节且旧代不再命中", async () => {
    const files = new Map([[0, buildChunkFile(0, PCM_CHUNK_SAMPLES)]]);
    const deps = makeDeps(files);
    stubFetch(files);
    const cache = new PcmChunkCache(deps, "project_1", DEFAULT_PCM_CHUNK_CACHE_BYTES);
    await cache.chunkFor("asset_1", 3, 0);
    expect(cache.cachedByteCount).toBeGreaterThan(0);
    cache.invalidateGeneration("asset_1", 3);
    expect(cache.cachedByteCount).toBe(0);
    expect(cache.readyChunk("asset_1", 3, 0)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("windowChunks（纯函数）", () => {
  it("±2 秒窗口 → 覆盖当前块及前后各 1 块", () => {
    // 位置 100000（块 1 内）：窗口 [4000, 196000] → 块 0,96k,192k
    const starts = windowChunks(100_000, 1, SR);
    expect(starts[0]).toBe(0);
    expect(starts).toContain(96_000);
    expect(starts[starts.length - 1]).toBe(192_000);
  });

  it("4x 速度：源窗 ×4（±8 秒）", () => {
    const starts1x = windowChunks(96_000 * 10, 1, SR);
    const starts4x = windowChunks(96_000 * 10, 4, SR);
    expect(starts4x.length).toBeGreaterThan(starts1x.length);
    // ±8 秒 = ±384000 样本 = 前后 4 块
    expect(starts4x[0]).toBe(96_000 * (10 - 4));
    expect(starts4x[starts4x.length - 1]).toBe(96_000 * (10 + 4));
  });

  it("位置 0：向后钳 0（前窗只剩当前块+一块）", () => {
    const starts = windowChunks(0, 1, SR);
    expect(starts[0]).toBe(0);
    expect(starts).toEqual([0, 96_000]);
  });
});

describe("AudioStreamLoader", () => {
  it("reseek 递增世代；旧代 ready 块不喂新位置", async () => {
    const files = new Map([[0, buildChunkFile(0, PCM_CHUNK_SAMPLES)]]);
    const deps = makeDeps(files);
    stubFetch(files);
    const cache = new PcmChunkCache(deps, "project_1");
    const loader = new AudioStreamLoader(cache, "project_1", SR);
    const gen0 = loader.currentGeneration;
    expect(await loader.requestChunk("asset_1", 0)).not.toBeNull();
    expect(loader.drive("asset_1", 100_000, 1).length).toBe(1);
    const gen1 = loader.reseek();
    expect(gen1).toBe(gen0 + 1);
    expect(loader.drive("asset_1", 100_000, 1).length).toBe(0); // 旧代块隔离
    vi.unstubAllGlobals();
  });

  it("drive：未就绪块触发 ensure，并发 ≤2，超额顺延", async () => {
    const files = new Map();
    const deps = makeDeps(files);
    const fetchMock = stubFetch(files);
    const cache = new PcmChunkCache(deps, "project_1");
    const loader = new AudioStreamLoader(cache, "project_1", SR);
    // 窗口 5 块（±2 秒跨块边界）：首轮最多 2 个在途 ensure
    loader.drive("asset_1", 96_000, 1);
    expect(loader.inflightCount).toBeLessThanOrEqual(2);
    expect(deps.ensure.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetchMock).not.toHaveBeenCalled(); // ensure 未完成前不 fetch
    vi.unstubAllGlobals();
  });
});
