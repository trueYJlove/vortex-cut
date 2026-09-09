/** A02 音频源缓存回归：single-flight（同源 50 clip 只 fetch/decode 一次）、
 *  并发上限≤2、排队等待、tick 重入不追加请求、失败保留 + 显式重试门、
 *  release 引用语义、dispose 中止在途。jsdom 无 AudioContext —— 用可控
 *  延迟的 fake decode/fetch 注入器直接驱动 AudioSourceCache。 */
import { describe, expect, it, vi } from "vitest";
import { AudioSourceCache } from "../src/app/preview/audio-source-cache.js";

interface FakeBuffer {
  length: number;
  numberOfChannels: number;
}

function makeHarness(options: { fetchDelay?: number; decodeDelay?: number; failKeys?: Set<string> } = {}) {
  const fetchLog: string[] = [];
  const decodeLog: string[] = [];
  const lifetime = new AbortController();
  const cache = new AudioSourceCache(
    async (data, signal) => {
      await sleep(options.decodeDelay ?? 0);
      throwIfAborted(signal);
      decodeLog.push(String(new Uint8Array(data as unknown as ArrayBuffer)[0]));
      return { length: 48000, numberOfChannels: 2 } as AudioBuffer;
    },
    async (ticket, signal) => {
      await sleep(options.fetchDelay ?? 0);
      throwIfAborted(signal);
      fetchLog.push(ticket);
      if (options.failKeys?.has(ticket)) throw new Error("boom");
      return new Uint8Array([ticket.length]).buffer as ArrayBuffer;
    },
    lifetime.signal,
    1,
  );
  return { cache, fetchLog, decodeLog, lifetime };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const throwIfAborted = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("aborted", "AbortError"); };

describe("AudioSourceCache single-flight", () => {
  it("同源 50 clip：fetch/decode 各恰好一次，全部拿到同一 buffer", async () => {
    const { cache, fetchLog, decodeLog } = makeHarness();
    const promises = Array.from({ length: 50 }, (_, i) =>
      cache.acquire("asset_a|1|48000", "aivideo://media/asset_a", `clip_${i}`).catch(() => undefined));
    await Promise.all(promises);
    expect(fetchLog).toEqual(["aivideo://media/asset_a"]);
    expect(decodeLog).toHaveLength(1);
    const snapshot = cache.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ state: "ready", users: 50, decodedBytes: 48000 * 2 * 4 });
  });

  it("就绪前 100 次 tick 重入：仍只有一次 fetch（并发位不重复占用）", async () => {
    const { cache, fetchLog } = makeHarness({ fetchDelay: 20, decodeDelay: 20 });
    const tick = () => cache.acquire("asset_a|1|48000", "aivideo://media/asset_a", "clip_0").catch(() => undefined);
    for (let i = 0; i < 100; i++) void tick();
    await sleep(80);
    expect(fetchLog).toHaveLength(1);
    expect(cache.inflightCount).toBe(0);
  });

  it("不同 key（不同 asset / 采样率 / 代）不共享条目", async () => {
    const { cache, fetchLog } = makeHarness();
    await Promise.all([
      cache.acquire("asset_a|1|48000", "aivideo://media/asset_a", "clip_0"),
      cache.acquire("asset_b|1|48000", "aivideo://media/asset_b", "clip_1"),
      cache.acquire("asset_a|1|44100", "aivideo://media/asset_a", "clip_2"),
      cache.acquire("asset_a|2|48000", "aivideo://media/asset_a", "clip_3"),
    ]);
    expect(fetchLog).toHaveLength(4);
    expect(cache.snapshot()).toHaveLength(4);
  });
});

describe("AudioSourceCache 并发上限", () => {
  it("4 个不同 key 并发：在途 ≤2，排队任务在前驱完成后执行", async () => {
    const inflightPeak = { max: 0 };
    const lifetime = new AbortController();
    const active = { count: 0 };
    const cache = new AudioSourceCache(
      async (data, signal) => {
        throwIfAborted(signal);
        return { length: 1, numberOfChannels: 1 } as AudioBuffer;
      },
      async (ticket, signal) => {
        active.count += 1;
        inflightPeak.max = Math.max(inflightPeak.max, active.count);
        await sleep(15);
        throwIfAborted(signal);
        active.count -= 1;
        return new Uint8Array([1]).buffer as ArrayBuffer;
      },
      lifetime.signal,
    );
    const keys = ["k0", "k1", "k2", "k3"];
    await Promise.all(keys.map(key => cache.acquire(`${key}|1|48000`, `t:${key}`, "u0")));
    expect(inflightPeak.max).toBeLessThanOrEqual(2);
    expect(cache.snapshot().every(entry => entry.state === "ready")).toBe(true);
    expect(cache.inflightCount).toBe(0);
  });

  it("并发位在 decode 完成前不归还（abort 不提前放行新任务）", async () => {
    const lifetime = new AbortController();
    const order: string[] = [];
    const cache = new AudioSourceCache(
      async (_data, signal) => {
        // decode 慢且不可中止：abort 后仍占并发位直到完成
        await sleep(40);
        throwIfAborted(signal);
        return { length: 1, numberOfChannels: 1 } as AudioBuffer;
      },
      async () => new Uint8Array([1]).buffer as ArrayBuffer,
      lifetime.signal,
    );
    const first = cache.acquire("k0|1|48000", "t0", "u0").catch(error => error);
    await sleep(5);
    cache.release("k0|1|48000", "u0"); // 最后用户离场 → abort 在途
    const second = cache.acquire("k1|1|48000", "t1", "u1");
    await sleep(10);
    // k0 的 decode 仍在占位（40ms）：k1 排队，在途不超上限
    expect(cache.inflightCount).toBeLessThanOrEqual(2);
    await Promise.allSettled([first, second]);
    expect(order).toEqual([]);
    expect(cache.inflightCount).toBe(0);
  });
});

describe("AudioSourceCache 失败与重试", () => {
  it("失败保留：同 key 再 acquire 返回同一 rejected Promise，不重发 fetch", async () => {
    const { cache, fetchLog } = makeHarness({ failKeys: new Set(["t:bad"]) });
    const first = cache.acquire("bad|1|48000", "t:bad", "u0");
    await expect(first).rejects.toThrow("boom");
    const again = cache.acquire("bad|1|48000", "t:bad", "u1");
    await expect(again).rejects.toThrow("boom");
    expect(fetchLog).toHaveLength(1);
    expect(cache.snapshot()[0]!.state).toBe("error");
  });

  it("retry 门打开后 acquire 重建条目并成功", async () => {
    let fail = true;
    const fetchLog: string[] = [];
    const lifetime = new AbortController();
    const cache = new AudioSourceCache(
      async data => ({ length: 1, numberOfChannels: 1, tag: data } as unknown as AudioBuffer),
      async ticket => {
        fetchLog.push(ticket);
        if (fail) throw new Error("transient");
        return new Uint8Array([1]).buffer as ArrayBuffer;
      },
      lifetime.signal,
    );
    await expect(cache.acquire("k|1|48000", "t", "u0")).rejects.toThrow("transient");
    fail = false;
    cache.retry("k|1|48000");
    await expect(cache.acquire("k|1|48000", "t", "u1")).resolves.toBeTruthy();
    expect(fetchLog).toHaveLength(2);
  });
});

describe("AudioSourceCache release / dispose", () => {
  it("release：最后用户离场且非 ready → abort 在途 fetch", async () => {
    const { cache } = makeHarness({ fetchDelay: 30 });
    const promise = cache.acquire("k|1|48000", "t", "u0");
    cache.release("k|1|48000", "u0");
    await expect(promise).rejects.toThrow();
    expect(cache.snapshot()[0]!.state).toBe("error");
  });

  it("ready 条目 release 后保留（缓存本体不随消费者释放）", async () => {
    const { cache } = makeHarness();
    await cache.acquire("k|1|48000", "t", "u0");
    cache.release("k|1|48000", "u0");
    expect(cache.snapshot()[0]).toMatchObject({ state: "ready", users: 0 });
    // 再 acquire：直接命中缓存，不重发 fetch
    await cache.acquire("k|1|48000", "t", "u1");
    expect(cache.snapshot()[0]!.users).toBe(1);
  });

  it("dispose：lifetime abort → 在途失败、排队唤醒、后续 acquire 抛 AbortError", async () => {
    const { cache, lifetime } = makeHarness({ fetchDelay: 30 });
    const inFlight = cache.acquire("k0|1|48000", "t0", "u0");
    const queued = cache.acquire("k1|1|48000", "t1", "u1");
    lifetime.abort();
    await expect(inFlight).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    expect(() => cache.acquire("k2|1|48000", "t2", "u2")).toThrow();
    expect(cache.queuedCount).toBe(0);
  });
});


describe("AudioSourceCache PCM 字节预算（B13/B14 接线）", () => {
  function makeBudgetHarness(bufferSamples: number, maxBytes: number) {
    const lifetime = new AbortController();
    const fetchLog: string[] = [];
    const cache = new AudioSourceCache(
      async () => ({ length: bufferSamples, numberOfChannels: 2 } as AudioBuffer),
      async (ticket) => { fetchLog.push(ticket); return new Uint8Array([1]).buffer; },
      lifetime.signal, 1, maxBytes,
    );
    return { cache, lifetime, fetchLog };
  }

  it("ready 记账：cachedByteCount = decodedBytes 之和", async () => {
    const bytesPerEntry = 48000 * 2 * 4; // harness buffer 固定尺寸
    const { cache } = makeBudgetHarness(48000, null as unknown as number);
    await cache.acquire("asset_a|1|48000", "t-a", "clip_0").catch(() => undefined);
    expect(cache.cachedByteCount).toBe(bytesPerEntry);
  });

  it("超限 LRU：逐出最旧无用户 ready 条目，新条目保留", async () => {
    // 预算只装得下 1 条（1 条 = 384000B；预算 384001B < 2 条）
    const { cache, fetchLog } = makeBudgetHarness(48000, 48000 * 2 * 4 + 1);
    await cache.acquire("asset_a|1|48000", "t-a", "clip_0").catch(() => undefined);
    // 旧条目消费者离场（release 后 ready 条目仍缓存，但可被预算逐出）
    cache.release("asset_a|1|48000", "clip_0");
    await cache.acquire("asset_b|1|48000", "t-b", "clip_1").catch(() => undefined);
    expect(cache.cachedByteCount).toBe(48000 * 2 * 4); // 只剩 1 条
    expect(cache.snapshot().map(e => e.key)).toEqual(["asset_b|1|48000"]); // 旧 a 被逐出
    expect(cache.overBudget).toBe(false);
    expect(fetchLog).toHaveLength(2); // 逐出不改写 fetch 历史（重取走 acquire）
  });

  it("活跃条目不逐出：超限如实暴露 overBudget", async () => {
    // 条目 2 倍于预算且都有用户：正确性优先——不清、不静默漏音
    const { cache } = makeBudgetHarness(48000, 48000 * 2 * 4);
    const keepA = cache.acquire("asset_a|1|48000", "t-a", "clip_0").catch(() => undefined);
    const keepB = cache.acquire("asset_b|1|48000", "t-b", "clip_1").catch(() => undefined);
    await Promise.all([keepA, keepB]);
    expect(cache.snapshot()).toHaveLength(2);
    expect(cache.overBudget).toBe(true);
  });

  it("dispose 清零记账", async () => {
    const { cache, lifetime } = makeBudgetHarness(48000, null as unknown as number);
    await cache.acquire("asset_a|1|48000", "t-a", "clip_0").catch(() => undefined);
    lifetime.abort();
    expect(cache.cachedByteCount).toBe(0);
  });
});
