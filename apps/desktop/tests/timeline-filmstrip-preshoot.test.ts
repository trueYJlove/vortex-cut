// WP-P232 预抽 sprite 装载的回归契约。
//
// 真机故障（用户 2026-11-17 报「导入素材后拖上时间线仍不显示抽帧」）根因：
// 装载 effect 把 assetId 一次性写进「已装载」集合就再也不试，而导入→拖上轨道
// 只隔几百毫秒——那时 filmstrip 作业还在 queued/running，filmstripMediaUrl 必抛
// 「未就绪」，catch 静默后 sprite 永不登记。预抽链路整体失效。
//
// 这里锁三件事：①未就绪会重试并最终登记；②failed / 非视频素材立刻放弃且负缓存；
// ③取消后不再登记（StrictMode 重挂载不留悬挂定时器）。
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel, loadFilmstripsOnce, SPRITE_RETRY_BACKOFF_MS } from "../src/app/timeline/TimelineCanvas.js";

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

describe("P235-R2 audio-only 视频片段不触发 TimelinePanel filmstrip 预抽", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("仅作为音频轨消费的视频素材不调用 ensureFilmstrip，转为视觉消费后触发", async () => {
    const ensureFilmstrip = vi.fn().mockResolvedValue({ status: "failed" });
    const filmstripMediaUrl = vi.fn();
    const previousDesktop = (window as { desktop?: unknown }).desktop;
    Object.defineProperty(window, "desktop", {
      value: { ensureFilmstrip, filmstripMediaUrl },
      configurable: true,
    });
    const baseDoc = (clipAssetKind: "audio" | "video", trackId: "A1" | "V1"): TimelineDocument => ({
      schema_version: 1,
      project_id: "project_1" as never,
      canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
      tracks: [
        { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
        { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
        { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
      ],
      clips: [{
        clip_id: "clip_1" as never,
        track_id: trackId,
        order_index: 0,
        asset_id: "asset_4k_video" as never,
        asset_kind: clipAssetKind,
        source_start_us: 0,
        source_end_us: 2_000_000,
        timeline_start_us: 0,
        timeline_end_us: 2_000_000,
        layout: "fit",
        audio: { enabled: true, gain_db: 0 },
      }],
      captions: [],
      provenance: { created_by: "user", source_transcript_ids: [] },
    });
    const panelProps = (doc: TimelineDocument) => ({
      projectId: "project_1",
      document: doc,
      selection: null,
      setSelection: vi.fn(),
      onPatch: vi.fn().mockResolvedValue(undefined),
      onDropAsset: vi.fn(),
      onReplaceAssetDrop: vi.fn().mockResolvedValue(undefined),
      canUndo: false,
      canRedo: false,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      assetMedia: [{ asset_id: "asset_4k_video", kind: "video" as const, media_url: null, display_name: "4k.mp4", duration_us: 2_000_000 }],
    });

    try {
      const view = render(createElement(TimelinePanel, panelProps(baseDoc("audio", "A1"))));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(ensureFilmstrip).not.toHaveBeenCalled();
      expect(filmstripMediaUrl).not.toHaveBeenCalled();

      view.rerender(createElement(TimelinePanel, panelProps(baseDoc("video", "V1"))));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(ensureFilmstrip).toHaveBeenCalledWith(expect.objectContaining({
        project_id: "project_1",
        asset_id: "asset_4k_video",
      }));
    } finally {
      if (previousDesktop === undefined) {
        delete (window as { desktop?: unknown }).desktop;
      } else {
        Object.defineProperty(window, "desktop", { value: previousDesktop, configurable: true });
      }
    }
  });
});
