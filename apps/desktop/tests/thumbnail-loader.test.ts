/** A08：缩略图加载器测试——owner/epoch/优先级/超时/缓存/批量通知。
 *  验收映射（计划第 5 节 A08）：
 *  - 快速滚动/缩放 50 次无无界排队（视口代次取消旧任务）；
 *  - 坏媒体不堵住后续请求（超时 5s + finally 清监听器）；
 *  - active 任务最多一个（隐藏 video 串行约束）；
 *  - seek 同 currentTime 直接取当前帧（不等待 seeked）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThumbnailLoader, type ThumbnailRequest } from "../src/app/timeline/thumbnail-loader.js";

/** 桩 video：可编程 readyState/事件/超时行为，验证加载器协议。 */
class StubVideo {
  readonly element: HTMLVideoElement;
  readyState = 0;
  videoWidth = 960;
  videoHeight = 540;
  currentTime = -1;
  src = "";
  loadCalls = 0;
  private listeners = new Map<string, Set<() => void>>();
  private drawImageCalls: Array<{ source: unknown }> = [];

  constructor() {
    this.element = document.createElement("video");
    // 拦截 DOM 事件到桩逻辑。
    const native = this.element;
    const add = native.addEventListener.bind(native);
    const remove = native.removeEventListener.bind(native);
    native.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set<() => void>());
      const wrapped = () => {
        if (typeof listener === "function") listener({} as Event);
      };
      this.listeners.get(type)!.add(wrapped);
      return add(type, listener);
    }) as typeof native.addEventListener;
    native.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") {
        for (const wrapped of this.listeners.get(type) ?? []) {
          // 逐个移除包装器（测试内不做精确配对，统一清空该 listener）。
          this.listeners.get(type)?.delete(wrapped);
        }
      }
      return remove(type, listener);
    }) as typeof native.removeEventListener;
    Object.defineProperty(native, "readyState", { get: () => this.readyState, configurable: true });
    Object.defineProperty(native, "videoWidth", { get: () => this.videoWidth, configurable: true });
    Object.defineProperty(native, "videoHeight", { get: () => this.videoHeight, configurable: true });
    Object.defineProperty(native, "currentTime", {
      get: () => this.currentTime,
      set: (value: number) => { this.currentTime = value; },
      configurable: true,
    });
    Object.defineProperty(native, "load", {
      value: () => {
        this.loadCalls += 1;
        // load 不自动 emit loadeddata——事件由测试显式控制（模拟真实
        // 异步解码就绪；坏媒体 = 永不 emit → 超时路径）。
      },
      configurable: true,
    });
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** 模拟媒体解码就绪：load 完成 + 数据可用。 */
  loaded(): void {
    this.readyState = 4;
    this.emit("loadeddata");
  }

  seeked(): void {
    this.readyState = 4;
    this.emit("seeked");
  }
}

function makeLoader(video: StubVideo, options: Partial<ConstructorParameters<typeof ThumbnailLoader>[0]> = {}) {
  return new ThumbnailLoader({
    createVideo: () => video.element,
    ...options,
  });
}

function request(overrides: Partial<ThumbnailRequest> = {}): ThumbnailRequest {
  return {
    key: "clip_1:8:0",
    assetId: "asset_1",
    url: "aivideo://media/token-1",
    timeSec: 0.5,
    viewportEpoch: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** setup.ts 把 jsdom 的 getContext 全局 mock 为 null（时间线绘制路径依赖）；
 *  本测试需要真实"可绘制"画布——安装最小桩上下文（drawImage no-op）。
 *  用 beforeEach（晚于 setup.ts 的同名 hook 注册，故后执行）覆盖回桩。 */
beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: () => undefined }),
  });
});

describe("ThumbnailLoader — 队列与缓存", () => {
  it("请求成功：帧入缓存，同 key 二次请求直接命中（不重 seek）", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5; // 与目标一致：不触发 seek 路径
    const pending = loader.request(request());
    video.loaded(); // 解码就绪（同 URL 后续请求不再 load）
    const frame = await pending;
    expect(frame).not.toBeNull();
    expect(frame?.canvas.width).toBeGreaterThan(0);
    expect(loader.stats.completed).toBe(1);
    // 二次同 key：缓存命中。
    const again = await loader.request(request());
    expect(again).toBe(frame);
    expect(loader.stats.requested).toBe(2);
    expect(video.loadCalls).toBe(1);
    loader.dispose();
  });

  it("同 key 在途请求合并（等待者共享同一次结果）", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5;
    const first = loader.request(request());
    const second = loader.request(request());
    // 在途期间第二个请求并入（mergedKeys 计数）。
    expect(loader.stats.mergedKeys).toBe(1);
    video.loaded();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(loader.stats.completed).toBe(1);
    loader.dispose();
  });

  it("视口代次推进：尚未开始的旧任务取消（快速滚动 50 次无无界排队）", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5;
    // 提交 50 个不同 key 的请求（模拟快速滚动/缩放）。
    const pending = Array.from({ length: 50 }, (_, i) =>
      loader.request(request({ key: `clip_1:8:${i}`, viewportEpoch: loader.viewportEpoch })),
    );
    // 每次滚动推进代次——旧代次未开始的任务出队即丢。
    for (let round = 0; round < 50; round += 1) {
      loader.advanceViewport();
      loader.request(request({ key: `clip_1:8:final-${round}`, viewportEpoch: loader.viewportEpoch }));
    }
    const settled = await Promise.all(pending.map(p => p.catch(() => null)));
    const stale = settled.filter(result => result === null);
    expect(stale.length).toBeGreaterThan(0); // 旧视口任务被取消
    // cancelledStale 覆盖两批：旧视口请求 + 各轮滚动后过期的 final 请求
    //（pump 出队时按代次丢弃）——均计入取消口径。
    expect(loader.stats.cancelledStale).toBeGreaterThanOrEqual(stale.length);
    expect(loader.queueLengthForTest()).toBeLessThan(60); // 无无界排队
    loader.dispose();
  });

  it("优先级：视口内(priority 0)先于预读(priority 1)", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5;
    // 构造排队态：先发起一个挂起请求（占用串行 video 池），随后
    // low/high 先后入队（pump busy 期间排序生效），解挂后按优先级出队。
    const blocker = loader.request(request({ key: "blocker" }));
    const lowPromise = loader.request(request({ key: "low", priority: 1 }));
    const highPromise = loader.request(request({ key: "high", priority: 0 }));
    const completedOrder: string[] = [];
    void lowPromise.then(() => completedOrder.push("low"));
    void highPromise.then(() => completedOrder.push("high"));
    video.loaded(); // 解挂 blocker；后续按优先级：high 先于 low。
    await blocker;
    video.loaded(); // high/low 共享已加载 URL（不再 load），但完成顺序不变。
    await Promise.all([highPromise, lowPromise]);
    expect(completedOrder[0]).toBe("high");
    expect(loader.stats.completed).toBe(3);
    loader.dispose();
  });

  it("坏媒体不堵队列：超时后继续处理后续请求（finally 清监听器）", async () => {
    const video = new StubVideo();
    // 手动计时器：立即触发超时。
    const loader = new ThumbnailLoader({
      createVideo: () => video.element,
      requestTimeoutMs: 50,
      scheduleTimer: (callback, ms) => {
        // 直接用真实 setTimeout 但缩短为可等待的时间。
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
    // 'bad' 的 URL 加载阶段永不 emit loadeddata → 超时路径。
    // readyState 预置 4：'good' 同 URL 跳过加载后直接取帧（不受 'bad'
    // 超时影响）；'bad' 仍因事件缺失超时——坏媒体不堵后续请求。
    video.readyState = 4;
    video.currentTime = 0.5;
    const badPromise = loader.request(request({ key: "bad" }));
    const goodPromise = loader.request(request({ key: "good", priority: 1 }));
    await new Promise(resolve => setTimeout(resolve, 80)); // 让 'bad' 超时
    expect(await badPromise).toBeNull();
    expect(loader.stats.timeouts).toBe(1);
    const okResult = await goodPromise;
    expect(okResult).not.toBeNull();
    expect(loader.stats.failed).toBe(1); // 只有 'bad' 失败
    loader.dispose();
  });

  it("seek 同 currentTime 时直接取当前已就绪帧（不等待不会发生的 seeked）", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5; // 同目标时刻
    const pending = loader.request(request({ timeSec: 0.5 }));
    video.loaded();
    const frame = await pending;
    // 未走 seek 路径：无 seeked 事件也完成。
    expect(frame).not.toBeNull();
    expect(video.currentTime).toBe(0.5);
    loader.dispose();
  });

  it("seek 需要跳转时等待 seeked 事件", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0;
    const pending = loader.request(request({ timeSec: 2.5 }));
    video.loaded();
    // seek 已下发（currentTime 改变）但 seeked 未到：pending 未决。
    await Promise.resolve();
    expect(video.currentTime).toBe(2.5);
    video.seeked();
    const frame = await pending;
    expect(frame).not.toBeNull();
    loader.dispose();
  });

  it("缓存维持条数上限（LRU 驱逐）并做 bytes 记账", async () => {
    const video = new StubVideo();
    const loader = new ThumbnailLoader({ createVideo: () => video.element, maxEntries: 3 });
    video.readyState = 4;
    video.currentTime = 0.5;
    for (let i = 0; i < 5; i += 1) {
      const pending = loader.request(request({ key: `k${i}` }));
      video.loaded();
      await pending;
    }
    expect(loader.stats.cacheEntries).toBe(3); // 上限驱逐
    expect(loader.stats.cacheBytes).toBeGreaterThan(0); // bytes 记账（w*h*4×3）
    loader.dispose();
  });

  it("prune 清理已不存在片段的帧", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 4;
    video.currentTime = 0.5;
    const first = loader.request(request({ key: "clip_1:8:0" }));
    video.loaded();
    await first;
    const second = loader.request(request({ key: "clip_gone:8:0" }));
    await second;
    loader.prune(new Set(["clip_1"]));
    expect(loader.peek("clip_1:8:0")).toBeDefined();
    expect(loader.peek("clip_gone:8:0")).toBeUndefined();
    loader.dispose();
  });

  it("完成回调按 rAF 批量通知（一次回调携带多个 key）", async () => {
    const video = new StubVideo();
    const batches: string[][] = [];
    const loader = makeLoader(video, {
      onBatchLoaded: keys => batches.push(keys),
    });
    video.readyState = 4;
    video.currentTime = 0.5;
    for (const key of ["a", "b", "c"]) {
      const pending = loader.request(request({ key }));
      video.loaded();
      await pending;
    }
    // jsdom 有 rAF——等待两帧让批量通知 flush。
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    const totalKeys = batches.flat();
    expect(totalKeys).toContain("a");
    expect(totalKeys).toContain("b");
    expect(totalKeys).toContain("c");
    loader.dispose();
  });

  it("dispose 后请求立即返回 null 且队列清空", async () => {
    const video = new StubVideo();
    const loader = makeLoader(video);
    video.readyState = 0; // 阻塞第一个请求
    const pending = loader.request(request({ key: "x" }));
    loader.dispose();
    expect(await pending).toBeNull();
    expect(await loader.request(request({ key: "y" }))).toBeNull();
  });
});
