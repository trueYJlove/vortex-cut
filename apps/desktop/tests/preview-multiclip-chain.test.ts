/**
 * 同素材多剪辑片段顺播的顺序解码链回归（用户实测：「存在多个剪辑片段时播放会
 * 很卡顿，甚至直接卡住不播放了」）。
 *
 * ## 病根
 *
 * `plan.py` 按 **asset** 去重分配 input_id（`input_by_asset`），因此同一素材的
 * 多个剪辑片段共享一个 input → 一个 decode worker → **一条顺序解码链**
 * （`preview-session.pump` 的 `rig.fed` 单调游标）。自动粗剪正是这个形状：
 * 同一素材被切成几十段，源窗口散布。
 *
 * `pump` 旧实现把链游标稠密步进（`next = rig.fed + 1`），并把超前上限锚在
 * **当前展示需求**（`max = anchor + LEAD`，anchor = 目标帧的 src_n）：
 *
 * 1. **前跳**（新片段源位置更靠后）：`max` 立刻跳到新片段处，`fed+1` 便从旧
 *    位置**逐帧空走**整段无需求区间——每帧一次「解码 + 上传」往返。源距离
 *    3000 帧即 3000 次往返，期间新片段帧永不就绪，播放头在剪辑点假死。
 * 2. **回跳**（新片段源位置更靠前，自动粗剪里极常见）：`max` 变成旧位置
 *    **之前**的值，`next = fed + 1 > max` → **一个请求都不发**。目标帧永远
 *    不就绪 → `compose` 无法推进 → 播放头冻结，最终由 2s 停滞兜底结束播放。
 *
 * 本用例覆盖两种跳变，并断言链推进是**按展示需求**而不是按稠密整数步进。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";
import type { Ir } from "../src/app/preview/ir.js";

const FPS = 30;
const CLIP_FRAMES = 30;
/** 源窗口起点（帧号）：故意前跳 / 回跳交替——自动粗剪的真实形状。 */
const CLIP_SOURCE_STARTS = [0, 3000, 30, 6000, 100, 9000];
const CLIP_COUNT = CLIP_SOURCE_STARTS.length;
const TOTAL_FRAMES = CLIP_FRAMES * CLIP_COUNT;

const us = (frame: number): number => Math.round((frame * 1_000_000) / FPS);

/** 单素材、多片段、源窗口前后跳变（全部共享 input in_1）。 */
function scatteredClipsIr(options: { speedMilli?: number } = {}): Ir {
  const speedMilli = options.speedMilli ?? 1000;
  const frames = Array.from({ length: TOTAL_FRAMES }, (_, n) => {
    const clipIndex = Math.floor(n / CLIP_FRAMES);
    const srcN = CLIP_SOURCE_STARTS[clipIndex]! + (n % CLIP_FRAMES) * (speedMilli / 1000);
    return {
      n,
      t_us: us(n),
      main: {
        kind: "segment" as const,
        clip_id: `clip_${clipIndex}`,
        input_id: "in_1",
        src_n: Math.round(srcN),
        src_t_us: us(Math.round(srcN)),
        content: { x: 0, y: 0, w: 960, h: 540 },
        shift: { dx: 0, dy: 0 },
        alpha: 1,
      },
      overlays: [],
      captions: [],
    };
  });
  return {
    schema: "preview-ir-v1",
    projector_version: "test-fixture",
    canvas: {
      width: 960, height: 540, fps: FPS,
      duration_frames: TOTAL_FRAMES, duration_us: us(TOTAL_FRAMES), background: "#000000",
    },
    inputs: [{
      input_id: "in_1", asset_id: "asset_video", asset_kind: "video",
      duration_us: us(9000 + CLIP_FRAMES * (speedMilli / 1000)), has_audio: false,
      geometry: { width: 960, height: 540, sar: 1 },
    }],
    segments: CLIP_SOURCE_STARTS.map((sourceStart, clipIndex) => ({
      clip_id: `clip_${clipIndex}`,
      track_id: "V1",
      input_id: "in_1",
      source_start_us: us(sourceStart),
      source_end_us: us(sourceStart + CLIP_FRAMES * (speedMilli / 1000)),
      timeline_start_us: us(clipIndex * CLIP_FRAMES),
      timeline_end_us: us((clipIndex + 1) * CLIP_FRAMES),
      layout: "fit",
      speed_milli: speedMilli,
    })),
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames,
  };
}

/** decode / upload 立即应答（微任务）：把「链推进」与真实解码耗时解耦。 */
function wireInstantWorkers(): ScriptedWorker {
  const compositor = ScriptedWorker.instances[0]!;
  const decode = ScriptedWorker.instances[1]!;
  const compositorPost = compositor.postMessage.bind(compositor);
  compositor.postMessage = (message: any) => {
    if (message.type === "upload") {
      queueMicrotask(() => compositor.reply({ type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }));
      return;
    }
    if (message.type === "uploadShadow") {
      queueMicrotask(() => compositor.reply({ type: "uploadedShadow", seq: message.seq, copyToMs: 0, texMs: 0 }));
      return;
    }
    compositorPost(message);
  };
  const decodePost = decode.postMessage.bind(decode);
  decode.postMessage = (message: any) => {
    decode.messages.push(message);
    if (message.type === "decode") {
      queueMicrotask(() => decode.reply({
        type: "frame", id: message.id, frameN: message.frameN, fromCache: true,
        frame: { close: () => undefined },
      }));
      return;
    }
    if (message.type !== "init") decodePost(message);
  };
  return decode;
}

describe("同素材多剪辑片段：顺序解码链必须按展示需求推进", () => {
  let virtualNow = 0;
  let rafQueue: Array<(time: number) => void> = [];

  beforeEach(() => {
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
    virtualNow = 0;
    rafQueue = [];
    // 播放时钟由 performance.now + rAF 驱动：换成可控虚拟时钟，使断言不受
    // CI 负载影响（rAF 每步 16.7ms，与真实 60Hz 一致）。
    vi.spyOn(performance, "now").mockImplementation(() => virtualNow);
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 推进虚拟时钟并冲刷微任务（链在微任务内推进）。 */
  const step = async (steps: number): Promise<void> => {
    for (let index = 0; index < steps; index++) {
      virtualNow += 1000 / 60;
      const due = rafQueue.splice(0);
      for (const callback of due) callback(virtualNow);
      for (let flush = 0; flush < 8; flush++) await Promise.resolve();
    }
  };

  /** 播放整片并收集请求/播放头状态（供各用例断言）。 */
  const playThrough = async (options: { speedMilli?: number; steps?: number } = {}) => {
    const container = document.createElement("div");
    const session = await PreviewSession.create(
      container, scatteredClipsIr({ speedMilli: options.speedMilli }),
      new Map([["asset_video", "aivideo://media/one"]]),
    );
    const decode = wireInstantWorkers();
    session.play();
    // 180 帧 @30fps = 6s；虚拟时钟 16.7ms/步 → 360 步。留 3 倍余量。
    await step(options.steps ?? 1100);
    const requested = decode.messages
      .filter(message => message.type === "decode")
      .map(message => message.frameN as number);
    const result = {
      session,
      requested,
      requestedSet: new Set(requested),
      currentFrame: (session as unknown as { currentFrame: number }).currentFrame,
      dropped: session.metrics().dropped_frames,
    };
    return result;
  };

  it("源窗口前跳/回跳交替：播放头走完全片、每个片段源位置都被请求到、无空走", async () => {
    const { session, requested, requestedSet, currentFrame, dropped } = await playThrough();

    // 1. 每个片段的**首帧**都必须被请求到——回跳片段尤其（旧实现回跳时
    //    `next = fed + 1 > max` → 一个请求都不发，该片段永不就绪 → 冻结）。
    for (let clipIndex = 0; clipIndex < CLIP_COUNT; clipIndex++) {
      expect(requestedSet.has(CLIP_SOURCE_STARTS[clipIndex]!)).toBe(true);
    }

    // 2. 播放头必须走完全片（旧实现冻结在回跳剪辑点）。
    expect(currentFrame).toBe(TOTAL_FRAMES - 1);
    expect(dropped).toBe(0);

    // 3. 无空走/无重发风暴：请求数应与「展示需求数 + 预读余量」同量级，
    //    而不是与源距离（累计约 1.8 万帧）或重发次数同量级。
    expect(requested.length).toBeLessThan(TOTAL_FRAMES * 4);
    expect(requestedSet.size).toBeLessThan(TOTAL_FRAMES * 4);

    session.dispose();
  }, 30_000);

  it("远距前跳不逐帧空走：源距离 3000 帧时请求数与源距离无关", async () => {
    const { session, requested, currentFrame } = await playThrough();
    // 若逐帧空走，仅第一个剪辑点就要 3000 次请求；这里整片（含 5 个剪辑点、
    // 累计约 1.8 万帧源距离）总请求数必须远小于单个剪辑点的源距离。
    expect(requested.length).toBeLessThan(3000);
    expect(currentFrame).toBe(TOTAL_FRAMES - 1);
    session.dispose();
  }, 30_000);

  it("变速 2x 片段同样按需求推进（不空走、不因环深收窄冻结）", async () => {
    const { session, requested, currentFrame } = await playThrough({ speedMilli: 2000 });
    expect(currentFrame).toBe(TOTAL_FRAMES - 1);
    // 2x 下源步进 2 帧/输出帧：请求集合仍应是需求的量级而非源距离量级。
    expect(requested.length).toBeLessThan(TOTAL_FRAMES * 4);
    session.dispose();
  }, 30_000);
});
