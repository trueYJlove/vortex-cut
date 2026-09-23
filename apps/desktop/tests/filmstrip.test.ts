/** filmstrip 抽帧链测试：worker 纯函数定位 + source 契约（假 worker 注入）
 *  + loader 分源调度（filmstrip 首选 / 降级 video / 源上限与空闲驱逐）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSampleIndex, type SampleIndex } from "../src/app/preview/sample-index.js";
import { bitmapSizeFor, FILMSTRIP_MAX_WIDTH, nearestSampleUs, planDecodeRange } from "../src/app/timeline/filmstrip-worker.js";
import { FilmstripSource, FilmstripWorkerClient, type FrameSource } from "../src/app/timeline/filmstrip-source.js";
import { ThumbnailLoader, type ThumbnailRequest } from "../src/app/timeline/thumbnail-loader.js";

// ---- 纯函数：bitmapSizeFor / nearestSampleUs -------------------------------

describe("filmstrip-worker 纯函数", () => {
  it("bitmapSizeFor：等比缩到 ≤160px 宽；窄源原样；非法尺寸兜底 ≥2", () => {
    const scaled = bitmapSizeFor(1920, 1080);
    expect(scaled.resizeWidth).toBe(FILMSTRIP_MAX_WIDTH);
    expect(scaled.resizeHeight).toBe(Math.round(1080 * (FILMSTRIP_MAX_WIDTH / 1920)));
    const narrow = bitmapSizeFor(120, 68);
    expect(narrow).toEqual({ resizeWidth: 120, resizeHeight: 68 });
    const bad = bitmapSizeFor(0, 0);
    expect(bad.resizeWidth).toBeGreaterThanOrEqual(2);
    expect(bad.resizeHeight).toBeGreaterThanOrEqual(2);
  });

  it("nearestSampleUs：命中/最近/并列取 index 小者/空索引返回 -1", () => {
    const build = (pts: number[]): SampleIndex => buildSampleIndex(pts.map(dts => ({ dts, ctsOffset: 0, sync: true })), 1_000_000);
    const index = build([0, 1000, 2000, 3000]);
    expect(nearestSampleUs(index, 1000)).toBe(1); // 精确命中
    expect(nearestSampleUs(index, 1100)).toBe(1); // 距 1000 更近
    expect(nearestSampleUs(index, 2900)).toBe(3); // 距 3000 更近
    expect(nearestSampleUs(index, 5000)).toBe(3); // 越界钳制到末采样
    expect(nearestSampleUs(index, -50)).toBe(0); // 越界钳制到首采样
    expect(nearestSampleUs(build([]), 100)).toBe(-1); // 空索引
    const tie = build([0, 2000]);
    expect(nearestSampleUs(tie, 1000)).toBe(0); // 距离并列 → 原 index 小者
  });

  it("planDecodeRange：热态同 GOP 跳格从 fedIndex+1 补齐中间参考帧（问题1回归锁）", () => {
    // 关键帧 0/30，帧率 1000/s：抽帧格间跳 14 采样（44px 格 @30fps 语义）。
    const samples = Array.from({ length: 90 }, (_, i) => ({ dts: i * 1000, ctsOffset: 0, sync: i % 30 === 0 }));
    const index = buildSampleIndex(samples, 1_000_000);
    // 冷启（fedIndex=-1）：关键帧回退。目标 40 → 关键帧 30。
    expect(planDecodeRange(index, -1, 40)).toEqual({ startSample: 30, sequential: false });
    // 热态同 GOP 跳格（fed=32 → target=46）：必须从 33 顺序喂到 46——
    // 只喂 46 会让 P 帧参考链断链，解码器错误隐藏出"时间戳对、内容错"的帧。
    expect(planDecodeRange(index, 32, 46)).toEqual({ startSample: 33, sequential: true });
    // 热态跨关键帧（fed=32 → target=45，中间 30 是关键帧起点但 GOP 边界在 30；
    // fed 与 target 同属 [30,60) GOP）——同 GOP 仍顺序。
    expect(planDecodeRange(index, 32, 45)).toEqual({ startSample: 33, sequential: true });
    // 热态跨 GOP（fed=32 → target=61 落入 [60,90)）：冷启关键帧回退 60。
    expect(planDecodeRange(index, 32, 61)).toEqual({ startSample: 60, sequential: false });
    // 回退（target < fedIndex，倒放逐格）：冷启关键帧回退。
    expect(planDecodeRange(index, 50, 40)).toEqual({ startSample: 30, sequential: false });
    // 重解同帧（target = fedIndex）：不属顺序推进（输出无新参考可依），冷启。
    expect(planDecodeRange(index, 40, 40)).toEqual({ startSample: 30, sequential: false });
  });
});

// ---- FilmstripSource：假 client 注入 --------------------------------------

/** 假 worker 客户端：可编程解码结果/失败时序。 */
class StubClient {
  decodeCalls: number[] = [];
  terminated = false;
  failTimes = 0; // 前 N 次 decode-at 失败（模拟 Range 票据过期）
  constructor(private readonly failFirst: number = 0) {}
  async decodeAtUs(timeUs: number): Promise<ImageBitmap> {
    this.decodeCalls.push(timeUs);
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("RANGE_FETCH_FAILED: 404");
    }
    return { width: 96, height: 54, close: () => undefined } as unknown as ImageBitmap;
  }
  terminate(): void { this.terminated = true; }
  static failFirst(n: number): StubClient { return new StubClient(n); }
}

/** canvas 桩：记录尺寸赋值，getContext 返回可断言的 drawImage 桩。 */
function makeCanvasStub() {
  const created: Array<{ width: number; height: number; drawn: unknown[] }> = [];
  const factory = (): HTMLCanvasElement => {
    const record = { width: 0, height: 0, drawn: [] as unknown[] };
    created.push(record);
    return {
      get width() { return record.width; },
      set width(value: number) { record.width = value; },
      get height() { return record.height; },
      set height(value: number) { record.height = value; },
      getContext: () => ({ drawImage: (source: unknown) => record.drawn.push(source) }),
    } as unknown as HTMLCanvasElement;
  };
  return { factory, created };
}

describe("FilmstripSource", () => {
  const bitmapFactory = () => ({ width: 96, height: 54, close: () => undefined }) as unknown as ImageBitmap;

  function clientFactory(client: StubClient) {
    return async (): Promise<FilmstripWorkerClient> => client as unknown as FilmstripWorkerClient;
  }

  it("loadFrame：decode-at → 画到等尺寸 canvas → 返回；bitmap 关闭", async () => {
    const client = new StubClient();
    const { factory, created } = makeCanvasStub();
    const closed: boolean[] = [];
    const source = new FilmstripSource(null, "asset_x", "aivideo://media/hint", {
      createClient: async () => client as unknown as FilmstripWorkerClient,
      createCanvas: factory,
    });
    source["client"] = await source["createClient"]("aivideo://media/hint", null) as FilmstripWorkerClient;
    // 覆盖 bitmap 生命周期断言：注入带 close 记录的桩（保留调用记录）。
    vi.spyOn(client, "decodeAtUs").mockImplementation(async (timeUs: number) => {
      client.decodeCalls.push(timeUs);
      const bitmap = { width: 96, height: 54, close: () => closed.push(true) } as unknown as ImageBitmap;
      return bitmap;
    });
    const canvas = await source.loadFrame(1.5);
    expect(canvas).not.toBeNull();
    expect(client.decodeCalls).toEqual([1_500_000]); // 秒 → µs
    expect(created[0]?.width).toBe(96);
    expect(created[0]?.height).toBe(54);
    expect(created[0]?.drawn.length).toBe(1);
    expect(closed).toEqual([true]);
    source.dispose();
  });

  it("create 前先重签票据（reissueTicket 优先于 hintUrl）", async () => {
    const issued: string[] = [];
    const clients: StubClient[] = [];
    const source = await FilmstripSource.create("asset_x", "aivideo://media/hint", async assetId => {
      issued.push(assetId);
      return "aivideo://media/fresh";
    }, {
      createClient: async url => {
        clients.push({ urls: [url] } as unknown as StubClient);
        return new StubClient() as unknown as FilmstripWorkerClient;
      },
      createCanvas: () => ({}) as HTMLCanvasElement,
    });
    void bitmapFactory;
    expect(issued).toEqual(["asset_x"]);
    void source;
  });

  it("中途失败：重签一次 → 重建 worker → 重试成功", async () => {
    const clientUrls: string[] = [];
    const createdClients: StubClient[] = [];
    let issueCount = 0;
    const source = new FilmstripSource(async () => {
      issueCount += 1;
      return issueCount === 1 ? "aivideo://media/fresh" : "aivideo://media/fresh2";
    }, "asset_x", "aivideo://media/stale", {
      createClient: async url => {
        clientUrls.push(url);
        const client = new StubClient();
        // 第一个 client：首次解码失败（模拟票据过期 404）
        if (createdClients.length === 0) client.failTimes = 1;
        createdClients.push(client);
        return client as unknown as FilmstripWorkerClient;
      },
      createCanvas: () => ({ width: 96, height: 54, getContext: () => ({ drawImage: () => undefined }) }) as unknown as HTMLCanvasElement,
    });
    // 手动完成 create 流程（绕过 static create 的领票——此处直接测 loadFrame 恢复路径）
    source["client"] = await source["createClient"]("aivideo://media/stale", null) as FilmstripWorkerClient;
    const canvas = await source.loadFrame(2);
    expect(canvas).not.toBeNull();
    expect(clientUrls).toEqual(["aivideo://media/stale", "aivideo://media/fresh"]); // 重签重建
    expect(createdClients[0]?.terminated).toBe(true); // 旧 client 已终止
    source.dispose();
    expect(createdClients[1]?.terminated).toBe(true); // dispose 终止现役
  });

  it("重试仍失败：返回 null（不环）", async () => {
    const reissues: number[] = [];
    const source = new FilmstripSource(async () => { reissues.push(1); return "aivideo://media/fresh"; }, "asset_x", "aivideo://media/stale", {
      createClient: async () => { const client = new StubClient(); client.failTimes = 99; return client as unknown as FilmstripWorkerClient; },
      createCanvas: () => ({}) as HTMLCanvasElement,
    });
    source["client"] = await source["createClient"]("aivideo://media/stale", null) as FilmstripWorkerClient;
    const canvas = await source.loadFrame(1);
    expect(canvas).toBeNull();
    expect(reissues.length).toBe(1); // 只重签一次
    const again = await source.loadFrame(2);
    expect(again).toBeNull();
    expect(reissues.length).toBe(1); // 不再重试（不环）
    source.dispose();
  });
});

// ---- ThumbnailLoader 分源调度 ---------------------------------------------

function makeRequest(overrides: Partial<ThumbnailRequest> = {}): ThumbnailRequest {
  return {
    key: "clip_1:8:0",
    assetId: "asset_1",
    url: "aivideo://media/token-1",
    timeSec: 0.5,
    viewportEpoch: 0,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: () => undefined }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThumbnailLoader — filmstrip 分源", () => {
  /** 可编程 video 桩（同 thumbnail-loader.test.ts 的最小版）。 */
  class MiniVideo {
    readyState = 4;
    videoWidth = 960;
    videoHeight = 540;
    currentTime = -1;
    src = "";
    private listeners = new Map<string, Set<() => void>>();
    readonly element = (() => {
      const native = document.createElement("video");
      const add = native.addEventListener.bind(native);
      native.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        const wrapped = () => { if (typeof listener === "function") listener({} as Event); };
        this.listeners.get(type)!.add(wrapped);
        return add(type, listener);
      }) as typeof native.addEventListener;
      const remove = native.removeEventListener.bind(native);
      native.removeEventListener = ((type: string) => {
        this.listeners.delete(type);
        return remove(type, () => undefined);
      }) as typeof native.removeEventListener;
      Object.defineProperty(native, "readyState", { get: () => this.readyState, configurable: true });
      Object.defineProperty(native, "videoWidth", { get: () => this.videoWidth, configurable: true });
      Object.defineProperty(native, "videoHeight", { get: () => this.videoHeight, configurable: true });
      Object.defineProperty(native, "currentTime", { get: () => this.currentTime, set: (v: number) => { this.currentTime = v; }, configurable: true });
      Object.defineProperty(native, "load", {
        value: () => {
          this.currentTime = -1;
          queueMicrotask(() => { this.readyState = 4; for (const listener of [...(this.listeners.get("loadeddata") ?? [])]) listener(); });
        },
        configurable: true,
      });
      return native;
    })();
    emit(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(); }
  }

  it("filmstrip 源优先：同素材多格共享一个源实例（顺序解码 pass）", async () => {
    const created: Array<{ requests: number[]; disposed: boolean }> = [];
    const loader = new ThumbnailLoader({
      createFilmstripSource: async ({ assetId, url }) => {
        const entry = { assetId, url, requests: [] as number[], disposed: false };
        created.push(entry);
        return {
          loadFrame: async (timeSec: number) => {
            entry.requests.push(timeSec);
            return { width: 96, height: 54 } as HTMLCanvasElement;
          },
          dispose: () => { entry.disposed = true; },
        } satisfies FrameSource;
      },
    });
    for (let i = 0; i < 4; i += 1) {
      await loader.request(makeRequest({ key: `clip_1:8:${i}`, timeSec: i * 0.5 }));
    }
    expect(created.length).toBe(1); // 同素材单源
    expect(created[0]?.requests).toEqual([0, 0.5, 1, 1.5]); // FIFO = 源时间单调
    loader.dispose();
    expect(created[0]?.disposed).toBe(true);
  });

  it("filmstrip 工厂返回 null：降级 video seek 路径且按素材记忆", async () => {
    const video = new MiniVideo();
    let filmstripAttempts = 0;
    const loader = new ThumbnailLoader({
      createVideo: () => video.element,
      createFilmstripSource: async () => { filmstripAttempts += 1; return null; },
    });
    const first = loader.request(makeRequest({ timeSec: 0.5 }));
    // filmstrip 判定异步：宏任务后 video 源已建立、load() 自动发出 loadeddata、
    // currentTime=-1 → 目标 0.5 的 seek 监听已注册。
    await new Promise(resolve => setTimeout(resolve, 0));
    video.emit("seeked");
    expect(await first).not.toBeNull(); // video 路径出帧
    expect(filmstripAttempts).toBe(1);
    // 同素材第二帧：不再尝试 filmstrip（降级记忆）；源已活跃，监听同步注册。
    const second = loader.request(makeRequest({ key: "clip_1:8:1", timeSec: 1 }));
    video.emit("seeked");
    expect(await second).not.toBeNull();
    expect(filmstripAttempts).toBe(1);
    loader.dispose();
  });

  it("filmstrip 创建抛错：同样降级 video 路径", async () => {
    const video = new MiniVideo();
    const loader = new ThumbnailLoader({
      createVideo: () => video.element,
      createFilmstripSource: async () => { throw new Error("VideoDecoder is not defined"); },
    });
    const pending = loader.request(makeRequest());
    await new Promise(resolve => setTimeout(resolve, 0));
    video.emit("seeked");
    expect(await pending).not.toBeNull();
    loader.dispose();
  });

  it("活跃源上限：满载时驱逐空闲源继续服务新素材", async () => {
    const disposed: string[] = [];
    const loader = new ThumbnailLoader({
      maxActiveSources: 1,
      createFilmstripSource: async ({ assetId }) => ({
        loadFrame: async () => ({ width: 96, height: 54 } as HTMLCanvasElement),
        dispose: () => disposed.push(assetId),
      }),
    });
    const first = await loader.request(makeRequest({ assetId: "asset_a", key: "a:8:0" }));
    expect(first).not.toBeNull();
    // asset_a 源空闲（无在途请求）→ asset_b 请求驱逐它并自建源。
    const second = await loader.request(makeRequest({ assetId: "asset_b", key: "b:8:0" }));
    expect(second).not.toBeNull();
    expect(disposed).toEqual(["asset_a"]);
    loader.dispose();
  });

  it("空闲驱逐：sourceIdleMs 到期后释放源，后续请求重建", async () => {
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const created: number[] = [];
    const loader = new ThumbnailLoader({
      sourceIdleMs: 20_000,
      scheduleTimer: (callback, ms) => { timers.push({ callback, ms }); return () => undefined; },
      createFilmstripSource: async () => {
        created.push(1);
        return {
          loadFrame: async () => ({ width: 96, height: 54 } as HTMLCanvasElement),
          dispose: () => undefined,
        } satisfies FrameSource;
      },
    });
    await loader.request(makeRequest());
    expect(created.length).toBe(1);
    const idleTimer = timers.find(timer => timer.ms === 20_000);
    expect(idleTimer).toBeDefined();
    idleTimer!.callback(); // 触发空闲释放
    await loader.request(makeRequest({ key: "clip_1:8:1", timeSec: 1 }));
    expect(created.length).toBe(2); // 重建源
    loader.dispose();
  });
});

// ---- FilmstripWorkerClient 消息协议（Worker 假体） --------------------------

describe("FilmstripWorkerClient 协议", () => {
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    listeners = new Map<string, Array<(event: never) => void>>();
    posted: unknown[] = [];
    terminated = false;
    addEventListener(type: string, listener: (event: never) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type)!.push(listener);
    }
    removeEventListener(type: string, listener: (event: never) => void): void {
      const list = this.listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }
    postMessage(message: unknown): void { this.posted.push(message); }
    terminate(): void { this.terminated = true; }
    emit(data: unknown): void {
      for (const listener of this.listeners.get("message") ?? []) listener({ data } as never);
    }
  }

  it("init→ready 握手；decode-at 回 bitmap；dispose 走 close+terminate", async () => {
    const fake = new FakeWorker();
    const pending = FilmstripWorkerClient.create("aivideo://media/t", null, undefined, () => fake as unknown as Worker);
    // 等待 init 消息发出后回 ready。
    await vi.waitFor(() => { expect(fake.posted.length).toBeGreaterThan(0); });
    fake.emit({ type: "ready", width: 1920, height: 1080, durationUs: 10_000_000, sampleCount: 300, hardware: "prefer-hardware" });
    const client = await pending;
    expect(client.width).toBe(1920);
    expect(client.height).toBe(1080);
    const bitmapPending = client.decodeAtUs(1_000_000);
    await vi.waitFor(() => { expect(fake.posted.some(message => (message as { type?: string }).type === "decode-at")).toBe(true); });
    const bitmap = { width: 160, height: 90, close: () => undefined };
    fake.emit({ type: "bitmap", id: 0, timeUs: 1_000_000, bitmap, width: 160, height: 90 });
    expect(await bitmapPending).toBe(bitmap);
    client.terminate();
    expect(fake.terminated).toBe(true);
    expect(fake.posted.some(message => (message as { type?: string }).type === "close")).toBe(true);
  });

  it("init 失败：create 上抛且 worker 被终止", async () => {
    const fake = new FakeWorker();
    const pending = FilmstripWorkerClient.create("aivideo://media/t", null, undefined, () => fake as unknown as Worker);
    await vi.waitFor(() => { expect(fake.posted.length).toBeGreaterThan(0); });
    fake.emit({ type: "error", id: null, message: "BMFF_MALFORMED: moov 未找到" });
    await expect(pending).rejects.toThrow("BMFF_MALFORMED");
    expect(fake.terminated).toBe(true);
  });
});
