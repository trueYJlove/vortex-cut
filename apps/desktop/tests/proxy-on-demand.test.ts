/**
 * 按需生成代理（方案 A 的触发点改造）：**按实测解码耗时超预算才登记**，取代
 * 「仅导入时触发」。
 *
 * ## 问题
 *
 * 旧实现唯一的触发点是 App.importAsset 成功那一刻。用户 pnpm dev 打开一个
 * **早已导入**的 4K 10-bit 项目、等 76 秒也没有「高清代理已就绪」——那一刻已经
 * 过去了，代理永远不会生成。
 *
 * ## 判据（本用例的断言依据）
 *
 * - 阈值 = 30fps 实时预算 33.3ms/帧（REALTIME_FRAME_BUDGET_MS）；
 * - 样本门槛 = 至少 30 个非缓存解码样本（DECODE_BUDGET_MIN_SAMPLES）；
 * - 取 **p95**（抓「明显解不动」，不是「平均较慢」）；
 * - decodeTimes 是会话级聚合、不带 asset_id ⇒ 归因靠 decodeTimesByInput
 *   （按 input_id 记）+ IR 的 input_id→asset_id 映射，再按 **asset_id** 汇总
 *   （同一素材多片段 = 多个 input，取各输入 p95 的最大值）。
 *
 * 验收映射：a) 超预算 ⇒ 为**正确的** asset_id 登记一次；b) 预算内 ⇒ 不登记；
 * c) 样本 <30 ⇒ 不判定；d) 同一素材多次超标 ⇒ 只登记一次；e) 多素材 ⇒ 只给
 * 超标那个，不误伤正常的那个。
 */
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.js";
import {
  DECODE_BUDGET_MIN_SAMPLES, PreviewSession, REALTIME_FRAME_BUDGET_MS,
} from "../src/app/preview/preview-session.js";
import type { Ir } from "../src/app/preview/ir.js";
import { buildDesktopApi } from "./fixtures/desktop-api-factory.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const FPS = 30;
const HALF_FRAMES = 60;
const TOTAL_FRAMES = HALF_FRAMES * 2;
/** 实测本机 4K 10-bit 源 64.1ms/帧；预算 33.3ms ⇒ 超 192%。 */
const OVER_BUDGET_MS = 64;
/** 实测本机 1080p 代理 14.3ms/帧：在预算内，不该转。 */
const WITHIN_BUDGET_MS = 14.3;

const us = (frame: number): number => Math.round((frame * 1_000_000) / FPS);

/** 两个素材各自的输入（in_a → asset_a 占前一半帧，in_b → asset_b 占后一半）。 */
function twoAssetIr(): Ir {
  return {
    schema: "preview-ir-v1",
    projector_version: "test-fixture",
    canvas: {
      width: 960, height: 540, fps: FPS, duration_frames: TOTAL_FRAMES,
      duration_us: us(TOTAL_FRAMES), background: "#000000",
    },
    inputs: [
      { input_id: "in_a", asset_id: "asset_a", asset_kind: "video", duration_us: us(HALF_FRAMES), has_audio: false, geometry: { width: 3840, height: 2160, sar: 1 } },
      { input_id: "in_b", asset_id: "asset_b", asset_kind: "video", duration_us: us(HALF_FRAMES), has_audio: false, geometry: { width: 1920, height: 1080, sar: 1 } },
    ],
    segments: [
      { clip_id: "clip_a", track_id: "V1", input_id: "in_a", source_start_us: 0, source_end_us: us(HALF_FRAMES), timeline_start_us: 0, timeline_end_us: us(HALF_FRAMES), layout: "fit", speed_milli: 1000 },
      { clip_id: "clip_b", track_id: "V1", input_id: "in_b", source_start_us: 0, source_end_us: us(HALF_FRAMES), timeline_start_us: us(HALF_FRAMES), timeline_end_us: us(TOTAL_FRAMES), layout: "fit", speed_milli: 1000 },
    ],
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames: Array.from({ length: TOTAL_FRAMES }, (_, n) => {
      const first = n < HALF_FRAMES;
      const srcN = first ? n : n - HALF_FRAMES;
      return {
        n,
        t_us: us(n),
        main: {
          kind: "segment" as const,
          clip_id: first ? "clip_a" : "clip_b",
          input_id: first ? "in_a" : "in_b",
          src_n: srcN,
          src_t_us: us(srcN),
          content: { x: 0, y: 0, w: 960, h: 540 },
          shift: { dx: 0, dy: 0 },
          alpha: 1,
        },
        overlays: [],
        captions: [],
      };
    }),
  };
}

const TICKETS = new Map([["asset_a", "aivideo://media/a"], ["asset_b", "aivideo://media/b"]]);

/**
 * 按 **init 收到的票据 URL** 给每个解码 worker 定一个每帧耗时（= 归因链路的
 * 输入端）：decode 请求进来就把虚拟时钟推 cost 毫秒再回帧，于是会话侧测到的
 * decode_ms 恰好等于该输入的成本。同一输入的解码由 uploadTail 串行，两个输入
 * 在用例里分阶段驱动（先 in_a 后 in_b），不会交叉推钟。
 */
function wireTimedWorkers(costMsByUrl: Record<string, number>): { advance: (ms: number) => void } {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const compositor = ScriptedWorker.instances[0]!;
  const originalCompositorPost = compositor.postMessage.bind(compositor);
  compositor.postMessage = (message: any) => {
    if (message.type === "upload") {
      queueMicrotask(() => compositor.reply({ type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }));
      return;
    }
    if (message.type === "uploadShadow") {
      queueMicrotask(() => compositor.reply({ type: "uploadedShadow", seq: message.seq, copyToMs: 0, texMs: 0 }));
      return;
    }
    originalCompositorPost(message);
  };
  for (const decoder of ScriptedWorker.instances.slice(1)) {
    const originalPost = decoder.postMessage.bind(decoder);
    // init 在 PreviewSession.create 里就发出去了（本桩在那之后才装）——URL 从
    // 桩自己记下的报文里取，不靠"以后还能看见下一次 init"。
    let url = String(decoder.messages.find((message: any) => message.type === "init")?.url ?? "");
    decoder.postMessage = (message: any) => {
      if (message.type === "init") { url = String(message.url); originalPost(message); return; }
      if (message.type !== "decode") { originalPost(message); return; }
      decoder.messages.push(message);
      now += costMsByUrl[url] ?? 0;
      queueMicrotask(() => decoder.reply({
        type: "frame", id: message.id, frameN: message.frameN, fromCache: false,
        frame: { close: () => undefined },
      }));
    };
  }
  return { advance: (ms: number) => { now += ms; } };
}

/** 冲刷微任务直到在途解码清零（解码链全在微任务内推进）。 */
async function drainDecodes(session: PreviewSession): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    if (session.metrics().decode_in_flight === 0 && round > 3) return;
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  }
}

describe("按需代理：实测解码耗时归因到素材（会话层）", () => {
  beforeEach(() => {
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("p95 归因到正确的 asset_id：慢的那个超预算、正常的那个不超", async () => {
    const session = await PreviewSession.create(document.createElement("div"), twoAssetIr(), TICKETS);
    const clock = wireTimedWorkers({
      "aivideo://media/a": OVER_BUDGET_MS,
      "aivideo://media/b": WITHIN_BUDGET_MS,
    });
    // 阶段一：只驱动 in_a 覆盖的帧（0..59），让 asset_a 攒够样本。
    for (let frame = 0; frame < HALF_FRAMES; frame += 3) {
      await session.seekToFrame(frame);
      await drainDecodes(session);
      clock.advance(1000);
    }
    // 阶段二：只驱动 in_b 覆盖的帧（60..119）。
    for (let frame = HALF_FRAMES; frame < TOTAL_FRAMES; frame += 2) {
      await session.seekToFrame(frame);
      await drainDecodes(session);
      clock.advance(1000);
    }

    const verdicts = session.decodeBudget();
    const a = verdicts.find(item => item.asset_id === "asset_a")!;
    const b = verdicts.find(item => item.asset_id === "asset_b")!;

    // 归因：两个素材各自落在自己的 input 上，没有串到对方头上。
    expect(a.input_ids).toEqual(["in_a"]);
    expect(b.input_ids).toEqual(["in_b"]);
    // a：样本够门槛、p95 越过实时预算（64ms/帧 > 33.3ms）、判定为「解不动」。
    // 不把 p95 钉死在 64：两个输入各自一条解码链，阶段交界处会有一两帧的
    // 区间重叠（一个输入的解码区间盖住了另一个的推钟），p95 因此略高于单帧
    // 成本。判据只关心「超没超预算」，钉死绝对值反而把测试绑在调度细节上。
    expect(a.samples).toBeGreaterThanOrEqual(DECODE_BUDGET_MIN_SAMPLES);
    expect(a.p95_ms).toBeGreaterThan(REALTIME_FRAME_BUDGET_MS);
    expect(a.over_budget).toBe(true);
    // b：同样够样本，但 14.3ms 在预算内 ⇒ 不判定为慢（这就是「不误伤正常素材」）。
    expect(b.samples).toBeGreaterThanOrEqual(DECODE_BUDGET_MIN_SAMPLES);
    expect(b.p95_ms).toBeCloseTo(WITHIN_BUDGET_MS, 1);
    expect(b.p95_ms).toBeLessThan(REALTIME_FRAME_BUDGET_MS);
    expect(b.over_budget).toBe(false);
    // 归因是分开的：慢素材的 p95 数量级上就与正常素材分得开（不是聚合平均）。
    expect(a.p95_ms).toBeGreaterThan(b.p95_ms * 3);

    session.dispose();
  }, 30_000);

  it("样本不足 30 个 ⇒ 不判定（即便单帧实测远超预算）", async () => {
    const session = await PreviewSession.create(document.createElement("div"), twoAssetIr(), TICKETS);
    wireTimedWorkers({ "aivideo://media/a": OVER_BUDGET_MS, "aivideo://media/b": WITHIN_BUDGET_MS });
    // 只一次 seek：预读链只会解出个位数的帧，样本数远不到门槛。
    await session.seekToFrame(0);
    await drainDecodes(session);

    const a = session.decodeBudget().find(item => item.asset_id === "asset_a")!;
    expect(a.samples).toBeGreaterThan(0); // 样本确实采到了（否则是「没测」而不是「不判定」）
    expect(a.samples).toBeLessThan(DECODE_BUDGET_MIN_SAMPLES);
    expect(a.p95_ms).toBeGreaterThan(REALTIME_FRAME_BUDGET_MS); // 单帧看确实慢
    expect(a.over_budget).toBe(false); // 但样本不足 ⇒ 不判定

    session.dispose();
  }, 30_000);
});
/**
 * App 侧：判定结果 → 代理作业登记（验收 a/b/c/d/e 的端到端映射）。
 *
 * 重型子组件照 proxy-auto-generate.test.ts 的先例桥接成"把 onDecodeBudget 转发
 * 出去"的小桩——本用例断言的是 App 拿到判定后「为谁、登记几次」，不是预览渲染。
 */
const budgetSink = vi.hoisted(() => ({ callback: null as null | ((verdicts: unknown[]) => void) }));

vi.mock("../src/app/preview/SyntheticPreview.js", async () => {
  const React = await import("react");
  return {
    SyntheticPreview: (props: { onDecodeBudget?: (verdicts: unknown[]) => void }) => {
      budgetSink.callback = props.onDecodeBudget ?? null;
      return React.createElement("div", { "data-testid": "synthetic-preview-bridge" });
    },
  };
});
vi.mock("../src/app/timeline/TimelineCanvas.js", async () => {
  const React = await import("react");
  return { TimelinePanel: () => React.createElement("div", { "data-testid": "timeline-panel-bridge" }) };
});

const now = "2026-08-11T00:00:00.000Z";
type Id = string & { readonly __brand: never };
const id = (value: string): Id => value as Id;

const appProject = {
  project_id: id("project_on_demand"), name: "按需代理", status: "active" as const,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1 }, root_dir_name: "OnDemand",
  current_timeline_revision_id: "revision_on_demand", created_at: now, updated_at: now, last_opened_at: now,
};
const videoAsset = {
  asset_id: id("asset_a"), project_id: appProject.project_id, kind: "video" as const,
  storage_mode: "external" as const, display_name: "早已导入的4K素材.mp4", fingerprint: "a".repeat(64),
  size_bytes: 10, modified_at: now, availability: "available" as const,
  media_info: { duration_us: 5_000_000 }, created_at: now, updated_at: now,
};
const presentation = { asset: videoAsset, media_url: "aivideo://media/abcdefghijklmnopqrstuvwxyzABCDEFG" };

function makeTimeline() {
  return {
    project_id: appProject.project_id,
    current_revision: {
      timeline_revision_id: id("revision_on_demand"), project_id: appProject.project_id,
      parent_revision_id: null, document_sha256: "a".repeat(64), summary: "fixture",
      created_by: "user", created_at: now, schema_version: 1,
      document: {
        schema_version: 1, project_id: appProject.project_id,
        canvas: { ...appProject.canvas, background_color: "#000000" },
        tracks: [
          { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
          { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
          { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
        ],
        clips: [{
          clip_id: "clip_a", track_id: "V1", order_index: 0, asset_id: id("asset_a"),
          asset_kind: "video", source_start_us: 0, source_end_us: 1_000_000,
          timeline_start_us: 0, timeline_end_us: 1_000_000, layout: "fit",
          audio: { enabled: true, gain_db: 0 },
        }],
        captions: [], provenance: { created_by: "user", source_transcript_ids: [] },
      },
    },
    draft: null, can_undo: false, can_redo: false, current_preview: null,
  };
}

/** 一个素材的判定（默认超预算）；asset_id 决定"为谁登记"。 */
function verdict(assetId: string, over: boolean) {
  return { asset_id: assetId, input_ids: ["in_1"], samples: 60, p95_ms: over ? 64.1 : 14.3, over_budget: over };
}

function setup() {
  const createPreviewSourceJob = vi.fn().mockResolvedValue({ job_id: "job_proxy_1", cache_key: null, status: "queued" });
  const listJobs = vi.fn().mockResolvedValue({ items: [], next_cursor: null });
  window.desktop = buildDesktopApi({
    timeline: makeTimeline() as never,
    overrides: {
      listProjects: vi.fn().mockResolvedValue({ items: [appProject], next_cursor: null }),
      listAssets: vi.fn().mockResolvedValue({ items: [presentation], next_cursor: null }),
      listJobs, createPreviewSourceJob,
    },
  });
  return { createPreviewSourceJob, listJobs };
}

/** 等预览桥接挂上（= App 已把判定回调交给 SyntheticPreview）。 */
async function waitForSink() {
  await waitFor(() => expect(budgetSink.callback).not.toBeNull(), { timeout: 15_000 });
  return budgetSink.callback!;
}

describe("按需代理：实测解不动才登记（App 侧）", () => {
  beforeEach(() => { budgetSink.callback = null; });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
  });

  it("a. 超预算 ⇒ 为正确的 asset_id 登记一次代理作业（档位自动）", async () => {
    const { createPreviewSourceJob, listJobs } = setup();
    render(React.createElement(App));
    const report = await waitForSink();

    report([verdict("asset_a", true)]);
    await waitFor(() => expect(createPreviewSourceJob).toHaveBeenCalledTimes(1));
    // 档位不再写死 1080：默认 auto 交给 Core 按素材尺寸选档。
    expect(createPreviewSourceJob).toHaveBeenCalledWith({
      project_id: appProject.project_id, asset_id: "asset_a",
    });
    // 没有导入动作（素材早已在库里）：这条登记只可能来自实测判定。
    expect(listJobs).toHaveBeenCalled();
  }, 30_000);

  it("b. 实测在预算内 ⇒ 不登记", async () => {
    const { createPreviewSourceJob } = setup();
    render(React.createElement(App));
    const report = await waitForSink();

    report([verdict("asset_a", false)]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(createPreviewSourceJob).not.toHaveBeenCalled();
  }, 30_000);

  it("c. 样本不足 30 个 ⇒ 会话侧给 over_budget=false，App 不登记", async () => {
    const { createPreviewSourceJob } = setup();
    render(React.createElement(App));
    const report = await waitForSink();

    // 会话层对样本 <30 的素材已经给出 over_budget=false（见上面的会话用例），
    // 这里验 App 严格只认 over_budget——不自己再拍一次脑袋。
    report([{ asset_id: "asset_a", input_ids: ["in_1"], samples: 12, p95_ms: 64.1, over_budget: false }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(createPreviewSourceJob).not.toHaveBeenCalled();
  }, 30_000);

  it("d. 同一素材多次超标 ⇒ 只登记一次（去重生效）", async () => {
    const { createPreviewSourceJob } = setup();
    render(React.createElement(App));
    const report = await waitForSink();

    for (let round = 0; round < 5; round += 1) {
      report([verdict("asset_a", true)]);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await waitFor(() => expect(createPreviewSourceJob).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createPreviewSourceJob).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("e. 多素材：只给超标那个登记，不误伤正常的那个", async () => {
    const { createPreviewSourceJob } = setup();
    render(React.createElement(App));
    const report = await waitForSink();

    report([verdict("asset_a", true), verdict("asset_b", false)]);
    await waitFor(() => expect(createPreviewSourceJob).toHaveBeenCalledTimes(1));
    const registered = createPreviewSourceJob.mock.calls.map(call => (call[0] as { asset_id: string }).asset_id);
    expect(registered).toEqual(["asset_a"]);
  }, 30_000);
});
