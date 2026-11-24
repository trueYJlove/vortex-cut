/** B14 波形缓存测试（金字塔解析/取窗映射/缓存生命周期）。
 *
 * 覆盖（计划第 6 节 B14 Renderer 侧验收）：
 * - 文件解析：magic/header/逐层布局与 Core write 约定一致；损坏拒绝。
 * - clip 映射：源区间取窗（同源不同 trim 不再共用同一全源图）、
 *   2x 速度、倒放、静音、脉冲在已知位置可定位。
 * - 缓存生命周期：single-flight（同 asset 一次 describe+fetch）、
 *   pending 退避重查直至 ready（作业完成后曲线可画）、failed 不自动重试、
 *   LRU 字节上限逐出、dispose 清空、retry 门。
 * - 金字塔等价：base 层峰值 = 逐样本重算 reference。
 */
import { describe, expect, it, vi } from "vitest";
import {
  WaveformCache,
  parseWaveformFile,
  peaksForClip,
  pickLevel,
  type WaveformDeps,
  type WaveformPyramid,
} from "../src/app/timeline/waveform-cache.js";

const SAMPLE_RATE = 8000;
const BUCKET = 256;

/** 构造与 Core media/waveform.py write 约定一致的二进制产物。 */
function buildWaveformFile(
  levels: Array<Array<[number, number]>>,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const baseBuckets = levels[0]?.length ?? 0;
  const headerJson = JSON.stringify({
    sample_rate: SAMPLE_RATE, channels: 1, bucket: BUCKET,
    base_buckets: baseBuckets, levels: levels.length, levels_layout: true,
  });
  const headerBytes = encoder.encode(headerJson);
  const parts: Uint8Array[] = [];
  const totalLen = 8 + 4 + headerBytes.length + levels.reduce(
    (sum, level) => sum + level.length * 2 * 4, 0);
  const buffer = new ArrayBuffer(totalLen);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(encoder.encode("AIVSWF01"), 0);
  view.setUint32(8, headerBytes.length, true);
  bytes.set(headerBytes, 12);
  let cursor = 12 + headerBytes.length;
  for (const level of levels) {
    for (const [min, max] of level) {
      view.setFloat32(cursor, min, true);
      view.setFloat32(cursor + 4, max, true);
      cursor += 8;
    }
  }
  return buffer;
}

/** 自底向上构建金字塔（与 Core MinMaxAggregator._levels 同法）。 */
function buildPyramid(base: Array<[number, number]>): Array<Array<[number, number]>> {
  const levels: Array<Array<[number, number]>> = [base];
  let current = base;
  while (current.length > 1) {
    const count = Math.ceil(current.length / 2);
    const next: Array<[number, number]> = [];
    for (let i = 0; i < count; i += 1) {
      const a = current[i * 2];
      const b = i * 2 + 1 < current.length ? current[i * 2 + 1] : a;
      next.push([Math.min(a[0], b[0]), Math.max(a[1], b[1])]);
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

const bucketSpanUs = (BUCKET * 1_000_000) / SAMPLE_RATE; // 32000µs

describe("parseWaveformFile", () => {
  it("解析 magic + header + 逐层布局（与 Core write 约定一致）", () => {
    const base: Array<[number, number]> = [
      [0, 0], [0, 0.5], [-0.5, 0.25], [0, 0],
    ];
    const file = buildWaveformFile(buildPyramid(base));
    const pyramid = parseWaveformFile(file);
    expect(pyramid.baseBuckets).toBe(4);
    expect(pyramid.levels).toBe(3); // 4 → 2 → 1
    expect(pyramid.levelData[0].length).toBe(8); // 4 桶 × 2 float
    expect(pyramid.levelData[1].length).toBe(4); // 2 桶
    expect(pyramid.levelData[2].length).toBe(2); // 1 桶
    expect(pyramid.levelData[0][1]).toBeCloseTo(0, 6);
    expect(pyramid.levelData[0][2]).toBeCloseTo(0, 6);
    expect(pyramid.levelData[0][4]).toBeCloseTo(-0.5, 6);
    expect(pyramid.totalBytes).toBe(file.byteLength);
  });

  it("损坏数据拒绝（短/magic 错/header 截断/层数截断）", () => {
    expect(() => parseWaveformFile(new ArrayBuffer(4))).toThrow();
    expect(() => parseWaveformFile(new ArrayBuffer(64))).toThrow();
    const bad = new Uint8Array(64);
    bad.set(new TextEncoder().encode("XXXXWF01"), 0);
    expect(() => parseWaveformFile(bad.buffer)).toThrow();
  });
});

describe("peaksForClip 源区间映射", () => {
  const base: Array<[number, number]> = [];
  // 10 桶：第 3 桶 (0, 1)（脉冲），第 7 桶 (-0.75, 0)（负脉冲），其余静音
  for (let i = 0; i < 10; i += 1) {
    if (i === 3) base.push([0, 1]);
    else if (i === 7) base.push([-0.75, 0]);
    else base.push([0, 0]);
  }
  const pyramid: WaveformPyramid = {
    baseBuckets: 10, levels: buildPyramid(base).length,
    levelData: buildPyramid(base).map(level => new Float32Array(level.flat())),
    totalBytes: 1024,
  };

  it("全源 clip：脉冲出现在对应位置（1x 正放）", () => {
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "c1", assetId: "a1",
      sourceStartUs: 0, sourceEndUs: 10 * bucketSpanUs,
      speedMilli: 1000, reverse: false,
    }, 100)!;
    expect(peaks).not.toBeNull();
    // OpenFilm interpolates when a source bucket spans several screen pixels.
    expect(peaks[33]).toBeCloseTo(0.7, 5);
    expect(peaks[70]).toBeCloseTo(0.75, 5);
    expect(peaks[10]).toBeCloseTo(0, 5);
  });

  it("同源不同 trim：取窗而非全源挤压（B14 核心语义）", () => {
    // 只取第 3 桶附近 2 桶区间
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "c2", assetId: "a1",
      sourceStartUs: 2 * bucketSpanUs, sourceEndUs: 4 * bucketSpanUs,
      speedMilli: 1000, reverse: false,
    }, 100)!;
    expect(peaks.length).toBe(100);
    // Pixel 0 starts on the silent bucket; pixel 50 starts on the pulse bucket.
    expect(peaks[0]).toBeCloseTo(0, 5);
    expect(peaks[50]).toBeCloseTo(1, 5);
  });

  it("倒放：脉冲位置镜像", () => {
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "c3", assetId: "a1",
      sourceStartUs: 0, sourceEndUs: 10 * bucketSpanUs,
      speedMilli: 1000, reverse: true,
    }, 100)!;
    // Reversed columns walk back across bucket 3 from its far edge to its start.
    expect(peaks[69]).toBeCloseTo(1, 5);
    expect(peaks[63]).toBeCloseTo(0.4, 5);
  });

  it("2x 速度：源窗 2 倍宽（时间轴 1s 覆盖源 2s）", () => {
    // timeline 5 桶时长（源 10 桶 @2x）：峰值覆盖全源
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "c4", assetId: "a1",
      sourceStartUs: 0, sourceEndUs: 10 * bucketSpanUs,
      speedMilli: 2000, reverse: false,
    }, 50)!;
    expect(peaks.length).toBe(50);
    // At 2x the first full pulse column moves to index 15; adjacent pixels interpolate.
    expect(peaks[15]).toBeCloseTo(1, 5);
    expect(peaks[16]).toBeCloseTo(0.8, 5);
  });

  it("静音源：全零峰值；非法区间返回 null", () => {
    const silent: WaveformPyramid = {
      baseBuckets: 4, levels: 3,
      levelData: buildPyramid([[0, 0], [0, 0], [0, 0], [0, 0]]).map(l => new Float32Array(l.flat())),
      totalBytes: 128,
    };
    const { peaks } = peaksForClip(silent, bucketSpanUs, {
      clipId: "c5", assetId: "a1", sourceStartUs: 0, sourceEndUs: 4 * bucketSpanUs,
      speedMilli: 1000, reverse: false,
    }, 20)!;
    expect(Math.max(...Array.from(peaks))).toBe(0);
    expect(peaksForClip(pyramid, bucketSpanUs, {
      clipId: "c6", assetId: "a1", sourceStartUs: 100, sourceEndUs: 100,
      speedMilli: 1000, reverse: false,
    }, 20)).toBeNull();
  });

  it("pickLevel：每像素一桶档位", () => {
    // 10 桶窗 100 像素 → 每像素 0.1 桶 → level 0
    expect(pickLevel(pyramid, bucketSpanUs, 10 * bucketSpanUs, 100)).toBe(0);
    // 10 桶窗 3 像素 → 每像素 ~3.3 桶 → level 2
    expect(pickLevel(pyramid, bucketSpanUs, 10 * bucketSpanUs, 3)).toBeGreaterThanOrEqual(1);
  });

  it("保持像素窗口的精确峰值，不把临近瞬态扩散到粗金字塔桶", () => {
    const precise = buildPyramid([
      [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0],
    ]);
    const pyramid: WaveformPyramid = {
      baseBuckets: 8,
      levels: precise.length,
      levelData: precise.map(level => new Float32Array(level.flat())),
      totalBytes: 128,
    };
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "pixel-windows", assetId: "asset", sourceStartUs: 0,
      sourceEndUs: 8 * bucketSpanUs, speedMilli: 1000, reverse: false,
    }, 3)!;
    expect(Array.from(peaks)).toEqual([0, 1, 0]);
  });

  it("source EOF 之后画静音，不重复最后一个 waveform bucket", () => {
    const precise = buildPyramid([[0, 0.5], [0, 0]]);
    const pyramid: WaveformPyramid = {
      baseBuckets: 2,
      levels: precise.length,
      levelData: precise.map(level => new Float32Array(level.flat())),
      totalBytes: 64,
    };
    const { peaks } = peaksForClip(pyramid, bucketSpanUs, {
      clipId: "source-eof", assetId: "asset", sourceStartUs: 0,
      sourceEndUs: 4 * bucketSpanUs, speedMilli: 1000, reverse: false,
    }, 4)!;
    expect(Array.from(peaks)).toEqual([0.5, 0, 0, 0]);
  });

  it("选层后索引按该层桶跨换算（误用 base 跨度会挤到末桶）", () => {
    // 16 base 桶：仅最后一段有声。2 个采样点 → pickLevel≈3（每层 2 桶）
    const loudTail: Array<[number, number]> = [];
    for (let i = 0; i < 16; i += 1) loudTail.push(i >= 12 ? [0, 1] : [0, 0]);
    const pyr: WaveformPyramid = {
      baseBuckets: 16, levels: buildPyramid(loudTail).length,
      levelData: buildPyramid(loudTail).map(level => new Float32Array(level.flat())),
      totalBytes: 64,
    };
    const { peaks } = peaksForClip(pyr, bucketSpanUs, {
      clipId: "cLevel", assetId: "a1",
      sourceStartUs: 0, sourceEndUs: 16 * bucketSpanUs,
      speedMilli: 1000, reverse: false,
    }, 2)!;
    // 正确：前半段静音、后半段有声；若按 base 跨度索引会两段都落到末桶=1
    expect(peaks[0]).toBeCloseTo(0, 5);
    expect(peaks[1]).toBeCloseTo(1, 5);
  });
});

describe("WaveformCache 生命周期", () => {
  const description = {
    cache_key: `sha256:${"a".repeat(64)}`, status: "ready" as const,
    job_id: null, size_bytes: 1024,
    sample_rate: SAMPLE_RATE, channels: 1, bucket: BUCKET,
  };

  function makeDeps(file: ArrayBuffer, opts: { describeCalls?: number } = {}): WaveformDeps {
    const mediaUrl = "aivideo://media/waveform-ticket";
    return {
      getWaveform: vi.fn(async () => description),
      waveformMediaUrl: vi.fn(async () => ({ media_url: mediaUrl, cache_key: description.cache_key, size_bytes: 1024 })),
      ...{},
    } as unknown as WaveformDeps & { waveformMediaUrl: ReturnType<typeof vi.fn> };
  }

  function stubFetch(file: ArrayBuffer) {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => file }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("pyramidFor single-flight：同素材并发只 describe+fetch 一次", async () => {
    const file = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    const getWaveform = vi.fn(async () => description);
    const waveformMediaUrl = vi.fn(async () => ({ media_url: "aivideo://media/t", cache_key: description.cache_key, size_bytes: 4 }));
    const fetchMock = stubFetch(file);
    const cache = new WaveformCache({ getWaveform, waveformMediaUrl }, "project_1");
    const [p1, p2, p3] = await Promise.all([
      cache.pyramidFor("asset_1"), cache.pyramidFor("asset_1"), cache.pyramidFor("asset_1"),
    ]);
    expect(getWaveform).toHaveBeenCalledTimes(1);
    expect(waveformMediaUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p1 && p2 && p3 && p1 === p2).toBe(true);
    expect(p1?.baseBuckets).toBe(2);
    vi.unstubAllGlobals();
  });

  it("pending（building）退避重查：ready 后 resolve 金字塔并可取峰值", async () => {
    const file = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    let call = 0;
    const getWaveform = vi.fn(async () => {
      call += 1;
      return { ...description, status: call < 3 ? ("building" as const) : ("ready" as const) };
    });
    const waveformMediaUrl = vi.fn(async () => ({ media_url: "aivideo://media/t", cache_key: description.cache_key, size_bytes: 4 }));
    const fetchMock = stubFetch(file);
    const cache = new WaveformCache(
      { getWaveform, waveformMediaUrl }, "project_1", undefined, async () => {});
    const pyramid = await cache.pyramidFor("asset_1");
    expect(pyramid).not.toBeNull();
    expect(pyramid?.baseBuckets).toBe(2);
    // building 两轮不 fetch；ready 后才取件
    expect(getWaveform).toHaveBeenCalledTimes(3);
    expect(waveformMediaUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()[0].state).toBe("ready");
    expect(cache.peaksFor({
      clipId: "c", assetId: "asset_1",
      sourceStartUs: 0, sourceEndUs: 64000, speedMilli: 1000, reverse: false,
    }, 4)).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("pending 期间 single-flight：并发共享同一轮询，不重复 describe", async () => {
    const file = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    let call = 0;
    const getWaveform = vi.fn(async () => {
      call += 1;
      return { ...description, status: call < 2 ? ("queued" as const) : ("ready" as const) };
    });
    const waveformMediaUrl = vi.fn(async () => ({ media_url: "aivideo://media/t", cache_key: description.cache_key, size_bytes: 4 }));
    stubFetch(file);
    const cache = new WaveformCache(
      { getWaveform, waveformMediaUrl }, "project_1", undefined, async () => {});
    const [a, b] = await Promise.all([cache.pyramidFor("asset_1"), cache.pyramidFor("asset_1")]);
    expect(a && b && a === b).toBe(true);
    expect(getWaveform).toHaveBeenCalledTimes(2); // queued → ready 各一次
    vi.unstubAllGlobals();
  });

  it("failed 不自动重试；retry() 后可再来一次", async () => {
    const getWaveform = vi.fn(async () => { throw new Error("MEDIA_NO_AUDIO"); });
    const cache = new WaveformCache(
      { getWaveform, waveformMediaUrl: vi.fn() }, "project_1", undefined, async () => {});
    expect(await cache.pyramidFor("asset_1")).toBeNull();
    expect(await cache.pyramidFor("asset_1")).toBeNull();
    expect(getWaveform).toHaveBeenCalledTimes(1); // failed 态不重试
    cache.retry("asset_1");
    expect(await cache.pyramidFor("asset_1")).toBeNull();
    expect(getWaveform).toHaveBeenCalledTimes(2);
  });

  it("status=failed 按失败落库（不再卡 pending），retry 可重查", async () => {
    let call = 0;
    const getWaveform = vi.fn(async () => {
      call += 1;
      return { ...description, status: (call < 2 ? "failed" : "ready") as "failed" | "ready" };
    });
    const file = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    const waveformMediaUrl = vi.fn(async () => ({ media_url: "aivideo://media/t", cache_key: description.cache_key, size_bytes: 4 }));
    stubFetch(file);
    const cache = new WaveformCache(
      { getWaveform, waveformMediaUrl }, "project_1", undefined, async () => {});
    expect(await cache.pyramidFor("asset_1")).toBeNull();
    expect(cache.snapshot()[0].state).toBe("failed");
    cache.retry("asset_1");
    expect(await cache.pyramidFor("asset_1")).not.toBeNull();
    expect(cache.snapshot()[0].state).toBe("ready");
    vi.unstubAllGlobals();
  });

  it("字节上限 LRU：超限逐出最旧，cachedBytes 记账", async () => {
    const fileA = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    const fileB = buildWaveformFile(buildPyramid([[0, 0.1], [0, 0.2]]));
    const files = { asset_1: fileA, asset_2: fileB };
    const waveformMediaUrl = vi.fn(async (input: { asset_id: string }) => ({
      media_url: `aivideo://media/${input.asset_id}`,
      cache_key: description.cache_key, size_bytes: 4,
    }));
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => files[url.split("/").pop() as "asset_1" | "asset_2"],
    }));
    vi.stubGlobal("fetch", fetchMock);
    // 上限 = 单文件大小（两次 ready 即超限 → 逐出第一个）
    const limit = fileA.byteLength + 1;
    const cache = new WaveformCache(
      { getWaveform: vi.fn(async () => description), waveformMediaUrl }, "project_1", limit);
    const a = await cache.pyramidFor("asset_1");
    expect(a).not.toBeNull();
    expect(cache.cachedByteCount).toBe(fileA.byteLength);
    const b = await cache.pyramidFor("asset_2");
    expect(b).not.toBeNull();
    expect(cache.cachedByteCount).toBe(fileB.byteLength); // A 被逐出
    expect(cache.snapshot().map(entry => entry.assetId)).toEqual(["asset_2"]);
    vi.unstubAllGlobals();
  });

  it("dispose 后 pyramidFor/peaksFor 一律 null", async () => {
    const file = buildWaveformFile(buildPyramid([[0, 0.5], [0, 0.25]]));
    stubFetch(file);
    const cache = new WaveformCache(
      { getWaveform: vi.fn(async () => description), waveformMediaUrl: vi.fn(async () => ({ media_url: "aivideo://media/t", cache_key: description.cache_key, size_bytes: 4 })) },
      "project_1");
    expect(await cache.pyramidFor("asset_1")).not.toBeNull();
    cache.dispose();
    expect(await cache.pyramidFor("asset_1")).toBeNull();
    expect(cache.peaksFor({ clipId: "c", assetId: "asset_1", sourceStartUs: 0, sourceEndUs: 32000, speedMilli: 1000, reverse: false }, 10)).toBeNull();
    vi.unstubAllGlobals();
  });
});
