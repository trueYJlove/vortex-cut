// WP-P232 预抽 sprite 装载的回归契约。
//
// 真机故障（用户 2026-11-17 报「导入素材后拖上时间线仍不显示抽帧」）根因：
// 装载 effect 把 assetId 一次性写进「已装载」集合就再也不试，而导入→拖上轨道
// 只隔几百毫秒——那时 filmstrip 作业还在 queued/running，filmstripMediaUrl 必抛
// 「未就绪」，catch 静默后 sprite 永不登记。预抽链路整体失效。
//
// 这里锁三件事：①未就绪会重试并最终登记；②failed / 非视频素材立刻放弃且负缓存；
// ③取消后不再登记（StrictMode 重挂载不留悬挂定时器）。
import { describe, expect, it, vi } from "vitest";
import { loadFilmstripsOnce, SPRITE_RETRY_BACKOFF_MS } from "../src/app/timeline/TimelineCanvas.js";

function fakeBitmap(): ImageBitmap {
  return { width: 160, height: 900, close: () => undefined } as unknown as ImageBitmap;
}

function harness(options: {
  statuses: string[];
  mediaOk?: boolean;
  mediaThrows?: boolean;
  fetchOk?: boolean;
}) {
  const registered: Array<{ assetId: string; count: number; cellH: number }> = [];
  const loaded = new Set<string>();
  const skipped = new Set<string>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const statuses = [...options.statuses];
  let ensureCalls = 0;

  const deps = {
    loader: {
      registerSprite: (assetId: string, entry: { count: number; cellH: number }) => {
        registered.push({ assetId, count: entry.count, cellH: entry.cellH });
      },
    },
    projectId: () => "project_1",
    isDone: (assetId: string) => loaded.has(assetId) || skipped.has(assetId),
    markLoaded: (assetId: string) => { loaded.add(assetId); },
    markSkipped: (assetId: string) => { loaded.delete(assetId); skipped.add(assetId); },
    unmarkLoaded: (assetId: string) => { loaded.delete(assetId); },
    onLoaded: () => undefined,
    desktopApi: {
      ensureFilmstrip: async () => {
        const status = statuses[Math.min(ensureCalls, statuses.length - 1)];
        ensureCalls += 1;
        if (status === "throw") throw new Error("CoreHttpError: MEDIA_NO_VIDEO");
        return { status };
      },
      filmstripMediaUrl: async () => {
        if (options.mediaThrows) throw new Error("DERIVED_NOT_FOUND");
        return { media_url: "aivideo://media/x", step_ms: 1000, cell_w: 160, cell_h: 90, count: 12 };
      },
    },
    fetchImpl: async () => ({
      ok: options.fetchOk ?? true,
      status: options.fetchOk === false ? 404 : 200,
      blob: async () => ({}) as Blob,
    }),
    createBitmap: async () => fakeBitmap(),
    scheduleTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length - 1; },
    cancelTimer: (handle: number) => { timers[handle] = { fn: () => undefined, ms: -1 }; },
  };

  return {
    deps, registered, loaded, skipped, timers,
    get ensureCalls() { return ensureCalls; },
    /** 让已排队的微任务跑完（async run 链在 await 处让出）。 */
    async flush(times = 12) {
      for (let i = 0; i < times; i += 1) await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      for (let i = 0; i < times; i += 1) await Promise.resolve();
    },
    /** 依次触发所有挂起定时器，直到没有新的或达到上界。 */
    async drain(limit = 60) {
      let guard = 0;
      await this.flush();
      while (guard < limit) {
        const idx = timers.findIndex(t => t.ms >= 0);
        if (idx < 0) break;
        const timer = timers[idx];
        timers[idx] = { fn: () => undefined, ms: -1 };
        timer.fn();
        await this.flush();
        guard += 1;
      }
    },
  };
}

describe("WP-P232 预抽 sprite 装载", () => {
  it("生成中（queued）不取件、按退避重试，ready 后登记 sprite", async () => {
    const h = harness({ statuses: ["queued", "building", "ready"] });
    loadFilmstripsOnce([{ asset_id: "asset_1", kind: "video" }], h.deps);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // 首次 ensure 报 queued：不登记、不取件，只排重试。
    expect(h.registered).toHaveLength(0);
    expect(h.timers.filter(t => t.ms >= 0)).toHaveLength(1);
    await h.drain();
    expect(h.registered).toEqual([{ assetId: "asset_1", count: 12, cellH: 90 }]);
    expect(h.loaded.has("asset_1")).toBe(true);
    expect(h.skipped.has("asset_1")).toBe(false);
  });

  it("作业 failed：立刻放弃并落负缓存，不再重试", async () => {
    const h = harness({ statuses: ["failed"] });
    loadFilmstripsOnce([{ asset_id: "asset_2", kind: "video" }], h.deps);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.skipped.has("asset_2")).toBe(true);
    expect(h.loaded.has("asset_2")).toBe(false);
    expect(h.registered).toHaveLength(0);
    expect(h.timers.filter(t => t.ms >= 0)).toHaveLength(0);
  });

  it("无视频流（ensure 抛 MEDIA_NO_VIDEO）/非视频素材：不登记且不无限重试", async () => {
    const h = harness({ statuses: ["throw"] });
    loadFilmstripsOnce(
      [{ asset_id: "asset_3", kind: "video" }, { asset_id: "asset_img", kind: "image" }],
      h.deps,
    );
    await h.drain();
    expect(h.registered).toHaveLength(0);
    // 图片素材直接落负缓存（连 ensure 都不必发）。
    expect(h.skipped.has("asset_img")).toBe(true);
    // 抛错路径退避耗尽后也会放弃（不永久空转）。
    expect(h.skipped.has("asset_3")).toBe(true);
  });

  it("重试次数有上界（不会无限重排）", async () => {
    const h = harness({ statuses: ["queued"] });
    loadFilmstripsOnce([{ asset_id: "asset_4", kind: "video" }], h.deps);
    await h.drain();
    expect(h.skipped.has("asset_4")).toBe(true);
    expect(h.ensureCalls).toBe(SPRITE_RETRY_BACKOFF_MS.length);
  });

  it("取件成功但 fetch 404：重试而不是当场放弃", async () => {
    const h = harness({ statuses: ["ready"], fetchOk: false });
    loadFilmstripsOnce([{ asset_id: "asset_5", kind: "video" }], h.deps);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.registered).toHaveLength(0);
    expect(h.timers.filter(t => t.ms >= 0)).toHaveLength(1);
  });

  it("取消后不再登记、并清掉悬挂定时器", async () => {
    const h = harness({ statuses: ["queued"] });
    const stop = loadFilmstripsOnce([{ asset_id: "asset_6", kind: "video" }], h.deps);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    stop();
    await h.drain();
    expect(h.registered).toHaveLength(0);
  });
});
