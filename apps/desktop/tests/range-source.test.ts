/** B12 Range 源回归：初始化探测/206-200 语义、区间校验、字节 LRU、
 *  并发≤2、有限一次续票（相同 range 重发）、close 释放。
 *  fetch 以可控注入器驱动（jsdom 无真 aivideo:// 通道；协议层语义由
 *  restricted-media.test.ts 覆盖，此处只测客户端消费行为）。 */
import { describe, expect, it, vi } from "vitest";
import {
  FULL_READ_LIMIT_BYTES,
  HttpRangeSource,
  parseTotalFromContentRange,
  RangeFetchError,
} from "../src/app/preview/range-source.js";

/** range 服务器模拟：文件内容 + Range 处理模式（206 / 忽略 200 / 401）。 */
function makeFetch(file: Uint8Array, mode: "range" | "ignore" | "auth" = "range") {
  const calls: Array<{ range: string | null }> = [];
  let authChallenges = 0;
  const fetchLike = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    calls.push({ range });
    const respond = (status: number, headers: Record<string, string>, body: Uint8Array) =>
      new Response(body as unknown as BodyInit, { status, headers });
    if (mode === "auth" && authChallenges++ === 1 && range) {
      // 首个带 Range 请求（#0）是初始化探测——放行；#1 是首个读取 → 401
      return respond(401, {}, new Uint8Array(0));
    }
    if (mode === "ignore" || !range) {
      return respond(200, { "Content-Length": String(file.length) }, file);
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return respond(416, { "Content-Range": `bytes */${file.length}` }, new Uint8Array(0));
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    if (start >= file.length || end < start) {
      return respond(416, { "Content-Range": `bytes */${file.length}` }, new Uint8Array(0));
    }
    return respond(206, {
      "Content-Range": `bytes ${start}-${end}/${file.length}`,
      "Content-Length": String(end - start + 1),
    }, file.subarray(start, end + 1));
  });
  return { fetchLike, calls, refresh: vi.fn(async () => "aivideo://media/refreshed-ticket") };
}

const file = (length: number): Uint8Array => {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = i % 251;
  return data;
};

describe("HttpRangeSource 初始化", () => {
  it("bytes=0-65535 探测：206 解析总长，探测数据可复用（零额外请求）", async () => {
    const data = file(200_000);
    const { fetchLike: fetchMock } = makeFetch(data);
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock);
    expect(source.size).toBe(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 首 65336 字节内读取：无新请求（探测窗口复用）
    const view = await source.read(100, 500);
    expect(view.length).toBe(500);
    for (let i = 0; i < 500; i++) expect(view[i]).toBe(data[100 + i]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.close();
  });

  it("200 忽略 Range：小文件整读（≤阈值），读取零请求", async () => {
    const data = file(4096);
    const { fetchLike: fetchMock } = makeFetch(data, "ignore");
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock);
    expect(source.size).toBe(4096);
    const view = await source.read(0, 4096);
    expect(Array.from(view)).toEqual(Array.from(data));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.close();
  });

  it("200 忽略 Range：大文件必须拒绝（RANGE_UNSUPPORTED，不冒充支持）", async () => {
    const data = file(FULL_READ_LIMIT_BYTES + 1);
    const { fetchLike: fetchMock } = makeFetch(data, "ignore");
    await expect(HttpRangeSource.create("aivideo://media/t", fetchMock))
      .rejects.toMatchObject({ code: "RANGE_UNSUPPORTED" });
  });

  it("初始化 401 拒绝（票据未授权）", async () => {
    const alwaysAuth = vi.fn(async (): Promise<Response> => new Response(null, { status: 401 }));
    await expect(HttpRangeSource.create("aivideo://media/t", alwaysAuth))
      .rejects.toMatchObject({ code: "RANGE_UNAUTHORIZED" });
  });

  it("206 无合法 Content-Range 拒绝", async () => {
    const broken = vi.fn(async (): Promise<Response> =>
      new Response(new Uint8Array(4), { status: 206, headers: { "Content-Range": "garbage" } }));
    await expect(HttpRangeSource.create("aivideo://media/t", broken))
      .rejects.toMatchObject({ code: "RANGE_HEADER_INVALID" });
  });
});

describe("HttpRangeSource 读取", () => {
  it("区间校验：越界/负数/零长/关闭后拒绝", async () => {
    const data = file(1000);
    const { fetchLike: fetchMock } = makeFetch(data);
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock);
    await expect(source.read(999, 2)).rejects.toMatchObject({ code: "RANGE_OUT_OF_BOUNDS" });
    await expect(source.read(-1, 5)).rejects.toMatchObject({ code: "RANGE_INVALID" });
    await expect(source.read(0, 0)).rejects.toMatchObject({ code: "RANGE_INVALID" });
    source.close();
    await expect(source.read(0, 4)).rejects.toMatchObject({ code: "RANGE_CLOSED" });
  });

  it("跨探测窗口读取：合并 chunk 一次请求满足，字节内容正确", async () => {
    const data = file(300_000);
    const { fetchLike: fetchMock, calls } = makeFetch(data);
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock);
    const view = await source.read(65_530, 8); // 跨 65536 窗口边界
    for (let i = 0; i < 8; i++) expect(view[i]).toBe(data[65_530 + i]);
    // 一次探测 + 一次 range：chunk 从窗口头部起（覆盖前缀）向后扩展
    const rangeCalls = calls.filter(call => call.range?.startsWith("bytes=0-"));
    expect(rangeCalls).toHaveLength(2); // 探测 0-65535 + 数据 chunk 0-…
    const dataCall = rangeCalls[1]!;
    const requested = Number(dataCall.range!.split("-")[1]) + 1;
    expect(requested).toBeGreaterThanOrEqual(Math.min(1024 * 1024, 300_000));
    source.close();
  });

  it("LRU 缓存：邻近重复读零网络；容量受预算钳制", async () => {
    const data = file(4 * 1024 * 1024);
    const { fetchLike: fetchMock } = makeFetch(data);
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock, null,
      { cacheCapBytes: 2 * 1024 * 1024 });
    await source.read(2 * 1024 * 1024, 1024); // 触发一次 range（探测窗口外）
    const afterFirst = fetchMock.mock.calls.length;
    // 同 chunk（1MiB 合并对齐）内的邻近读：零新请求
    await source.read(2 * 1024 * 1024 + 100, 512);
    await source.read(2 * 1024 * 1024 + 900, 100);
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    // 缓存不超预算
    expect(source.stats().cacheBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    source.close();
  });

  it("并发 ≤2：三个并发读最多两个同时在途", async () => {
    const data = file(10 * 1024 * 1024);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight -= 1;
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? "";
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = Math.min(Number(match?.[2] ?? data.length - 1), data.length - 1);
      return new Response(data.subarray(start, end + 1) as unknown as BodyInit, {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` },
      });
    });
    const source = await HttpRangeSource.create("aivideo://media/t", slowFetch);
    await Promise.all([
      source.read(1 * 1024 * 1024, 4),
      source.read(3 * 1024 * 1024, 4),
      source.read(5 * 1024 * 1024, 4),
      source.read(7 * 1024 * 1024, 4),
    ]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    source.close();
  });

  it("401 续票：有限一次，相同 range 重发；初始化期 401 直接拒绝", async () => {
    const data = file(200_000);
    const { fetchLike: fetchMock, refresh } = makeFetch(data, "auth");
    const source = await HttpRangeSource.create("aivideo://media/t", fetchMock, refresh);
    // auth 模式首次带 Range 请求 401 → 续票 → 相同 range 重发（新 URL）
    const view = await source.read(100_000, 16);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 16; i++) expect(view[i]).toBe(data[100_000 + i]);
    // 初始化期 401（无 refresh）→ 直接拒绝
    const alwaysAuth = vi.fn(async (): Promise<Response> => new Response(null, { status: 401 }));
    await expect(HttpRangeSource.create("aivideo://media/t2", alwaysAuth))
      .rejects.toMatchObject({ code: "RANGE_UNAUTHORIZED" });
    source.close();
  });

  it("206 字节数与请求不符拒绝", async () => {
    // 文件远大于探测窗口，读取落在窗口外（必经网络路径）
    const data = file(400_000);
    const lying = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? "";
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? 0);
      // 少返回一半字节
      return new Response(data.subarray(start, start + Math.max(1, (end - start + 1) >> 1)) as unknown as BodyInit, {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` },
      });
    });
    const source = await HttpRangeSource.create("aivideo://media/t", lying);
    await expect(source.read(100_000, 100)).rejects.toMatchObject({ code: "RANGE_BODY_MISMATCH" });
    source.close();
  });
});

describe("parseTotalFromContentRange", () => {
  it("合法头解析总长；非法输入返回 null", () => {
    expect(parseTotalFromContentRange("bytes 0-65535/123456")).toBe(123456);
    expect(parseTotalFromContentRange("bytes 0-0/1")).toBe(1);
    expect(parseTotalFromContentRange(null)).toBeNull();
    expect(parseTotalFromContentRange("bytes 0-65535/*")).toBeNull();
    expect(parseTotalFromContentRange("garbage")).toBeNull();
    expect(parseTotalFromContentRange("bytes 0-65535/abc")).toBeNull();
  });
});

describe("RangeFetchError", () => {
  it("携带错误码供上层白名单透传", () => {
    const error = new RangeFetchError("RANGE_UNSUPPORTED", "x");
    expect(error.code).toBe("RANGE_UNSUPPORTED");
    expect(error.message).toBe("x");
  });
});
/** P70 真机缺陷回归：票据过期模拟——对齐 `restricted-media` 真语义：
 *  过期/未知票据返回 **404**（不是 401/403），服务端从不返回 401。
 *  初始票据可正常探测，`expireAll()` 后旧票一律 404，换票签发的新票正常。 */
function makeExpiringFetch(file: Uint8Array) {
  let seq = 0;
  const issued: string[] = [];
  const expired = new Set<string>();
  const calls: Array<{ url: string; range: string | null }> = [];
  const issue = () => { const u = `aivideo://media/t${++seq}`; issued.push(u); return u; };
  const first = issue();
  const fetchLike = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    calls.push({ url, range });
    if (expired.has(url)) return new Response(null, { status: 404 });
    const respond = (status: number, headers: Record<string, string>, body: Uint8Array) =>
      new Response(body as unknown as BodyInit, { status, headers });
    if (!range) return respond(200, { "Content-Length": String(file.length) }, file);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return respond(416, { "Content-Range": `bytes */${file.length}` }, new Uint8Array(0));
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    if (start >= file.length || end < start) {
      return respond(416, { "Content-Range": `bytes */${file.length}` }, new Uint8Array(0));
    }
    return respond(206, {
      "Content-Range": `bytes ${start}-${end}/${file.length}`,
      "Content-Length": String(end - start + 1),
    }, file.subarray(start, end + 1));
  });
  const refresh = vi.fn(async () => issue());
  const expireAll = () => { for (const u of issued) expired.add(u); };
  return { fetchLike, refresh, calls, expireAll, first };
}

describe("HttpRangeSource 票据过期（P70：服务端过期票返回 404，非 401）", () => {
  it("读取遇 404 触发一次换票并以相同 range 重发", async () => {
    const data = file(300_000);
    const { fetchLike, refresh, calls, expireAll, first } = makeExpiringFetch(data);
    const source = await HttpRangeSource.create(first, fetchLike, refresh);
    expireAll();
    const view = await source.read(100_000, 16);
    expect(view.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(view[i]).toBe(data[100_000 + i]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // 重发必须换成新票（旧票仍是过期态）
    const retry = calls[calls.length - 1]!;
    expect(retry.url).not.toBe(first);
    source.close();
  });

  it("换票成功后持久化新 URL：后续网络 miss 不回退旧票", async () => {
    const data = file(4 * 1024 * 1024);
    const { fetchLike, refresh, expireAll, first } = makeExpiringFetch(data);
    const source = await HttpRangeSource.create(first, fetchLike, refresh);
    expireAll();
    await source.read(100_000, 16);                 // 第一次 miss：换票
    const view = await source.read(3_000_000, 16);  // 第二次 miss：必须用新票
    expect(view.length).toBe(16);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 16; i++) expect(view[i]).toBe(data[3_000_000 + i]);
    source.close();
  });

  it("多次过期各自换票一次（长会话 >2×TTL，而非整源仅一次）", async () => {
    const data = file(4 * 1024 * 1024);
    const { fetchLike, refresh, expireAll, first } = makeExpiringFetch(data);
    const source = await HttpRangeSource.create(first, fetchLike, refresh);
    expireAll();
    await source.read(100_000, 16);
    expireAll();
    const view = await source.read(3_000_000, 16);
    expect(view.length).toBe(16);
    expect(refresh).toHaveBeenCalledTimes(2);
    source.close();
  });

  it("初始化即遇 404（建源时票据已过期）：注入换票回调则重试探测成功", async () => {
    const data = file(200_000);
    const { fetchLike, refresh, expireAll, first } = makeExpiringFetch(data);
    expireAll();
    const source = await HttpRangeSource.create(first, fetchLike, refresh);
    expect(source.size).toBe(data.length);
    expect(refresh).toHaveBeenCalledTimes(1);
    source.close();
  });
});

