/** P196 缓冲指示（用户裁决：延迟显示）——会话侧观测 + 组件侧落地。
 *
 * 缺陷形态：v2 窗口帧源的当前目标窗未就绪且不在途时，合成直接跳过（画面
 * 停在上一帧），会话没有任何状态通道，UI 无从知道"用户正在等画面"。
 *
 * 这里守的三件事（任何一条回退都该让本文件变红）：
 *  1. **抗闪烁**：短于 BUFFERING_NOTICE_MS(300ms) 的缺帧不得出提示——快速
 *     seek 的取窗 ~50ms，立即提示会比没有提示更差；
 *  2. **抗风暴**：一次连续卡顿里 N 次 seek/tick 采样只产生一次 started、
 *     恢复时一次 ended（边沿触发 + 单 timer）；
 *  3. 未订阅的会话行为不变。
 *
 * 会话用例用假定时器推进（真等待 300ms 会拖慢并引入抖动），并按
 * preview-lifecycle 的先例装 ScriptedWorker/OffscreenCanvas 桩——jsdom 没有
 * 真 worker。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import { SyntheticPreview } from "../src/app/preview/SyntheticPreview.js";
import type { FrameSource } from "../src/app/preview/frame-source.js";
import type { Ir } from "../src/app/preview/ir.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const TICKETS = new Map([["asset_video", "aivideo://media/one"]]);

/** 黑帧 IR：main.kind="black" 不需要任何输入解码，seek/tick 都能走到判定点。 */
function blackIr(totalFrames = 900): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  ir.inputs = [];
  ir.segments = [];
  ir.frames = Array.from({ length: totalFrames }, (_, n) => ({
    n,
    t_us: Math.round((n * 1_000_000) / 30),
    main: { kind: "black" as const },
    overlays: [],
    captions: [],
  })) as Ir["frames"];
  ir.canvas = { ...ir.canvas, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
  return ir;
}

/** 可控 v2 帧源：stalled = 目标窗未就绪且不在途（帧取不到 → 真正在缓冲）。
 *  ensureRange 默认悬挂——模拟窗口请求迟迟不返回（卡死形态），正是提示必须
 *  能自己冒出来的场景；resolveAll() 让在途取窗落定以验证"恢复"。 */
function controllableSource(totalFrames: number) {
  const state = { stalled: false, settles: [] as Array<() => void> };
  const source: FrameSource = {
    frameCount: totalFrames,
    getFrame: (n: number) => (state.stalled ? undefined : (n >= 0 && n < totalFrames ? { n, t_us: Math.round((n * 1_000_000) / 30), main: { kind: "black" }, overlays: [], captions: [] } as never : undefined)),
    isBuffering: () => state.stalled,
    ensureRange: () => new Promise<void>(resolve => { state.settles.push(() => resolve()); }),
    dispose: () => undefined,
  };
  return { source, state };
}

function newContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("P196 会话缓冲观测（边沿触发 + 300ms 延迟）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
  });

  it("短于 300ms 的缺帧不出提示（快速 seek 的取窗 ~50ms 不得闪烁）", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(120); // 已经在 300ms 门槛之下
    expect(onBuffering).not.toHaveBeenCalled();

    state.stalled = false; // 窗口到位 → 立即恢复（不设迟滞）
    void session.seekToFrame(6);
    await vi.advanceTimersByTimeAsync(1_000); // 越过阈值继续推进：未启动的提示不得迟到补发
    expect(onBuffering).not.toHaveBeenCalled();
    session.dispose();
  });

  it("持续缺帧超过 300ms 出提示，帧可用后立即消失", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5); // 取窗悬挂不返回：判定发生在 await 之前
    await vi.advanceTimersByTimeAsync(299);
    expect(onBuffering).not.toHaveBeenCalled(); // 阈值内静默
    await vi.advanceTimersByTimeAsync(2);
    expect(onBuffering.mock.calls).toEqual([[true]]); // 出现在阈值之后

    state.stalled = false;
    void session.seekToFrame(9);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]); // 恢复立即消失
    session.dispose();
  });

  it("连续拖拽风暴：一次卡顿只报一次 started、恢复只报一次 ended", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    // 30 次连续 seek + 播放 tick 采样叠在同一段卡顿里（真机拖动风暴的形态）
    for (let i = 0; i < 30; i++) {
      void session.seekToFrame(100 + i);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(onBuffering.mock.calls).toEqual([[true]]); // 恰好一次，不随采样次数增长

    await vi.advanceTimersByTimeAsync(2_000); // 长时间保持缓冲：不得重复报
    expect(onBuffering).toHaveBeenCalledTimes(1);

    state.stalled = false;
    void session.seekToFrame(300);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]);
    session.dispose();
  });

  it("dispose 后取消未决计时且不再回调", async () => {
    const ir = blackIr();
    const { source, state } = controllableSource(ir.frames.length);
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    state.stalled = true;
    void session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(100); // 计时中
    session.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  it("没有订阅者的会话行为与引入前一致（v1 帧源不产生任何回调）", async () => {
    const ir = blackIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS);
    expect(session.onBuffering).toBeNull();
    // v1 全量数组在场：多轮 seek 不抛错、不产生任何提示状态
    for (let i = 0; i < 5; i++) void session.seekToFrame(i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.onBuffering).toBeNull();
    session.dispose();
  });
});

/** 纹理半场（本次补的另一半）：**帧对象在、但纹理没进槽**同样让合成跳过绘制
 *  （compose 的 sourceOf 返回 null），用户看到的是同一款定格。P196 前半只堵了
 *  「帧取不到」那条路，这条路径上画面冻着、UI 全程无声。
 *
 * 这里守两件事，方向相反、必须同时成立：
 *  1. 纹理**永远不就绪** → 300ms 后出提示（补上的那一半）；
 *  2. 纹理**逐帧短暂不就绪**（正常解码/上传 churn）→ 提示一次都不许出。
 * 第 2 条才是真门槛：把 frameReady 接进判定最容易写成的形状就是"纹理不在 ⇒
 * 立即算缓冲"，那会在普通播放里把指示条点成常亮；300ms 去抖是唯一防线，而
 * 只有当每次不就绪都在几十毫秒内闭合它才成立——本用例就是钉这条的。
 */
describe("P196 纹理层未就绪（帧在、纹理不在）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
  });

  /** 单输入视频 IR：main 是真实片段（→ frameReady 要求 in_1 的环槽命中），
   *  帧对象由下面的帧源提供（帧永远取得到，纹理由测试脚本决定何时到位）。 */
  function videoIr(totalFrames = 900): Ir {
    const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
    ir.frames = Array.from({ length: totalFrames }, (_, n) => ({
      n,
      t_us: Math.round((n * 1_000_000) / 30),
      main: {
        kind: "segment" as const, clip_id: "clip_1", input_id: "in_1", src_n: n,
        src_t_us: Math.round((n * 1_000_000) / 30),
        content: { x: 0, y: 0, w: 1080, h: 1920 },
        shift: { dx: 0, dy: 0 }, alpha: 1,
      },
      overlays: [], captions: [],
    })) as Ir["frames"];
    ir.canvas = { ...ir.canvas, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
    return ir;
  }

  /** 帧永远在场、**帧源层恒不缓冲**——把判定逼到纹理层（这一半的唯一来源）。
   *  注意必须返回 IR 里的**真实片段帧**：帧对象的 main 决定 frameReady 要看
   *  哪个输入的纹理，用黑帧会把它变成恒真（假绿——初版即栽在这里）。 */
  function alwaysPresentSource(ir: Ir): FrameSource {
    return {
      frameCount: ir.frames.length,
      getFrame: (n: number) => (n >= 0 && n < ir.frames.length ? ir.frames[n] : undefined),
      isBuffering: () => false,
      ensureRange: () => Promise.resolve(),
      dispose: () => undefined,
    };
  }

  /** decode 立即回帧；**upload 何时 ack = 纹理何时到位**，由测试脚本决定：
   *  hold = 全部悬挂（上传卡死）；holdFor(ms) = 每笔悬挂 ms 后 ack（churn）。 */
  function wireTextureControl(options: { holdMs?: number | null } = {}): { hold: () => void; release: () => void } {
    const compositor = ScriptedWorker.instances[0]!;
    const ack = (message: any) => queueMicrotask(() => compositor.reply(message.type === "upload"
      ? { type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }
      : { type: "uploadedShadow", seq: message.seq, copyToMs: 0, texMs: 0 }));
    let holdMs = options.holdMs ?? null; // null = 立即 ack
    const held: any[] = [];
    const post = compositor.postMessage.bind(compositor);
    compositor.postMessage = (message: any) => {
      if (message.type === "upload" || message.type === "uploadShadow") {
        if (holdMs === Infinity) { held.push(message); return; }
        if (holdMs && holdMs > 0) { setTimeout(() => ack(message), holdMs); return; }
        ack(message);
        return;
      }
      post(message);
    };
    const decode = ScriptedWorker.instances[1]!;
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
    return {
      hold: () => { holdMs = Infinity; },
      release: () => { holdMs = 0; for (const message of held.splice(0)) ack(message); },
    };
  }

  const tick = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

  it("纹理永远不就绪（上传卡死）：帧对象在场也必须在 ~300ms 后出提示、纹理到位后消失", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    const texture = wireTextureControl();
    texture.hold(); // 上传永不 ack：帧在、纹理永远不在

    void session.seekToFrame(5);
    await tick(200);
    expect(onBuffering).not.toHaveBeenCalled(); // 阈值内静默（与缺帧同口径）
    await tick(150);
    expect(onBuffering.mock.calls).toEqual([[true]]); // 旧实现这里恒为空

    texture.release(); // 纹理到位 → 立即恢复
    await tick(10);
    void session.seekToFrame(5);
    await tick(10);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]);
    session.dispose();
  });

  it("纹理逐帧短暂不就绪（正常播放上传 churn）：指示条一次都不许出", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    // 正常 churn：**每帧**纹理都要缺席 ~40ms 才到位（解码→上传的真实形态），
    // 缺席窗口远短于 300ms。这就是"frameReady false ⇒ 缓冲"最容易被点亮的
    // 形状——若去抖或判定写错，下面 2s 里会亮成常亮。
    wireTextureControl({ holdMs: 40 });
    // 反空转锁：判定**确实**在此期间反复取到 true（纹理缺席），否则本用例只是
    // 在断言"什么都没发生"，不能证明去抖在起作用。实测约 120 次 true。
    const session_ = session as unknown as { targetBuffering(target: number): boolean };
    const judge = session_.targetBuffering.bind(session_);
    let sawNotReady = 0;
    session_.targetBuffering = (target: number) => {
      const value = judge(target);
      if (value) sawNotReady += 1;
      return value;
    };

    session.play();
    await tick(2_000); // ~60 帧正常播放
    expect(sawNotReady).toBeGreaterThan(20); // 判定确实反复看到"纹理未就绪"
    expect(onBuffering).not.toHaveBeenCalled(); // 但一次提示都不许出
    session.pause();
    session.dispose();
  });

  it("持续播放中纹理卡死：指示条必须出现（播放 tick 路径，非 seek）", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    const texture = wireTextureControl();
    texture.hold(); // 上传永不 ack：画面从第一帧起就画不出来

    session.play();
    await tick(200);
    expect(onBuffering).not.toHaveBeenCalled(); // 阈值内静默
    await tick(400);
    expect(onBuffering.mock.calls).toEqual([[true]]); // 起播卡死从 tick 发声
    session.pause();
    session.dispose();
  });
});


/** 暂停态兜底采样（本轮补的第三半）：**暂停 + 无人操作 + 上传卡死**。
 *
 * 缺陷形态：判定只在三处采样——seek 落定、recomposeSoon、播放 tick。前者要用户
 * 动作、中者全是手势、后者只在播放时跑（rAF 循环）。于是"暂停着、没人碰、后台
 * 上传却卡死"这条路上，画面定格而 onBuffering 一次都不会被调用——用户看到的是
 * 完全无声的冻结。
 *
 * 修法是**只在有在途上传时才跑**的兜底采样 timer：暂停态卡住的唯一物理原因就是
 * 还有东西在路上；零在途时没有任何东西"还可能到"，再采样只会得到同一结论，故
 * 不挂常驻心跳（第 3 条用例专门钉这个边界）。
 *
 * 三条用例的分工（方向各不相同，缺一条就会写成"永远有个 timer"或"timer 永不
 * 停"这两种回归）：
 *  1. 在途上传永不落定 → ~300ms 后必须出提示（本轮的正面路径）；
 *  2. 上传很快落定 → 一次提示都不许出，**且采样必须自己停**（不空转）；
 *  3. 从头到尾没有上传 → **timer 根本不存在**（零开销边界）。
 */
describe("P196 暂停态在途上传兜底采样", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
  });

  /** 单输入视频 IR：main 是真实片段（frameReady 要求 in_1 的环槽命中）。 */
  function videoIr(totalFrames = 900): Ir {
    const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
    ir.frames = Array.from({ length: totalFrames }, (_, n) => ({
      n,
      t_us: Math.round((n * 1_000_000) / 30),
      main: {
        kind: "segment" as const, clip_id: "clip_1", input_id: "in_1", src_n: n,
        src_t_us: Math.round((n * 1_000_000) / 30),
        content: { x: 0, y: 0, w: 1080, h: 1920 },
        shift: { dx: 0, dy: 0 }, alpha: 1,
      },
      overlays: [], captions: [],
    })) as Ir["frames"];
    ir.canvas = { ...ir.canvas, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
    return ir;
  }

  /** 帧永远在场、帧源层恒不缓冲：把判定逼到纹理层。 */
  function alwaysPresentSource(ir: Ir): FrameSource {
    return {
      frameCount: ir.frames.length,
      getFrame: (n: number) => (n >= 0 && n < ir.frames.length ? ir.frames[n] : undefined),
      isBuffering: () => false,
      ensureRange: () => Promise.resolve(),
      dispose: () => undefined,
    };
  }

  /** decode 立即回帧；upload 何时 ack = 纹理何时到位，由测试脚本控制。
   *  hold() = 此后所有上传永不 ack（卡死形态）。 */
  function wireTextureControl(options: { ackDelayMs?: number } = {}): { hold: () => void; release: () => void } {
    const ackDelayMs = options.ackDelayMs ?? 0;
    const held: any[] = [];
    const compositor = ScriptedWorker.instances[0]!;
    const ack = (message: any) => queueMicrotask(() => compositor.reply(message.type === "upload"
      ? { type: "uploaded", seq: message.seq, copyToMs: 0, texMs: 0 }
      : { type: "uploadedShadow", seq: message.seq, copyToMs: 0, texMs: 0 }));
    let hold = false;
    const post = compositor.postMessage.bind(compositor);
    compositor.postMessage = (message: any) => {
      if (message.type === "upload" || message.type === "uploadShadow") {
        if (hold) { held.push(message); return; } // 永不 ack（unless released）
        if (ackDelayMs > 0) { setTimeout(() => ack(message), ackDelayMs); return; }
        ack(message);
        return;
      }
      post(message);
    };
    const decode = ScriptedWorker.instances[1]!;
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
    return {
      hold: () => { hold = true; },
      release: () => { hold = false; for (const message of held.splice(0)) ack(message); },
    };
  }

  /** 采样观测桩：数 observeBuffering 的实际调用次数（它对每一笔采样都恰好一次，
   *  与"是否报告 true"无关）——用它判定采样在跑/已停，而不去窥探 timer 句柄
   *  （句柄是实现细节，重构即碎）。 */
  function countSamples(session: PreviewSession): { count: () => number } {
    const target = session as unknown as { observeBuffering(target: number): void };
    const original = target.observeBuffering.bind(target);
    let count = 0;
    target.observeBuffering = (frame: number) => {
      count += 1;
      original(frame);
    };
    return { count: () => count };
  }

  it("暂停 + 在途上传永不落定：无任何用户操作也必须在 ~300ms 后出提示", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    // 停止态：每笔上传 40ms 才 ack——在途长期非空（这正是"暂停时还有东西在
    // 路上"的真机形态：用户刚落定就暂停，预读链的上传仍在飞）。
    wireTextureControl({ ackDelayMs: 40 });
    const chain = session as unknown as { pump(target: number): void; targetBuffering(target: number): boolean };

    // 1) 暂停态 seek 到第 5 帧并落定：画面就绪、无提示。（这一次 seek 自己也
    //    会判定，所以它给不出"新增覆盖"的证据——证据在下一段。）
    //    上传要 40ms 才 ack，故不能直接 await（假时钟不会自己走）。
    const settled = session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(300);
    await settled;
    expect(onBuffering).not.toHaveBeenCalled();
    expect(chain.targetBuffering(5)).toBe(false); // 停留帧纹理就在环内

    // 2) **此后没有任何用户动作**（无 seek / 无手势 / 无 play）。在途的上传
    //    继续把预读环槽往前推，12 槽轮转把停留帧 5 的纹理冲掉：frameReady
    //    变假 → compose 的 sourceOf 返回 null → 跳过绘制，画面定格。
    //    而暂停态没有播放 tick、没有 seek、没有 recompose——既有三处采样
    //    一个都不会再发生，唯一能出声的就是在途兜底采样。
    for (let i = 0; i < 10; i++) {
      chain.pump(20 + i * 4);
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(chain.targetBuffering(5)).toBe(true); // 前提成立：停留帧纹理已被冲掉
    // 唯一能出声的就是在途兜底采样：本轮之前这里恒为空（无声冻结）。
    expect(onBuffering.mock.calls).toEqual([[true]]);
    // 长时间保持：边沿触发，不得随采样次数重复报。
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onBuffering).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("暂停 + 上传很快落定：一次提示都不许出，且采样必须自己停（不空转）", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    const samples = countSamples(session);
    wireTextureControl(); // decode 立即回帧、upload 立即 ack（正常快路径）

    // 正常暂停 seek：上传立即 ack，纹理几十毫秒内到位（远短于 300ms）
    await session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(50);
    expect(onBuffering).not.toHaveBeenCalled();

    // 在途排空后采样必须停下。取一段"足够跑很多个采样周期"的窗口：
    // 若 timer 没停（空转），这段里采样次数会持续增长。
    await vi.advanceTimersByTimeAsync(120);
    const settled = samples.count();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.count()).toBe(settled); // 排空后不再有任何一次采样
    expect(onBuffering).not.toHaveBeenCalled(); // 且全程静默
    session.dispose();
  });

  it("暂停 + 上传在 300ms 门槛内赶上：提示不得闪出（去抖口径不变），且排空后采样自行停止", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    const texture = wireTextureControl();
    const samples = countSamples(session);

    // 暂停 seek 到 5，但**悬挂**上传：seek 自己的判定起跑 300ms 计时。
    texture.hold();
    void session.seekToFrame(5);
    await vi.advanceTimersByTimeAsync(250); // 门槛未到

    // 250ms 放行：纹理到位、在途排空——远早于 300ms。这就是"快速 seek 的
    // 取窗 ~50ms"的同款形态放大版；提示一次都不许出。
    texture.release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onBuffering).not.toHaveBeenCalled();

    // 排空后采样必须自己停（不空转）。
    const settled = samples.count();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(samples.count()).toBe(settled);
    session.dispose();
  });


  it("全程没有任何上传：暂停会话根本不创建采样 timer（零开销边界）", async () => {
    const ir = videoIr();
    const session = await PreviewSession.create(newContainer(), ir, TICKETS, undefined, undefined, null, undefined, null, alwaysPresentSource(ir));
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;
    const samples = countSamples(session);

    // 会话装配完成后不做任何 seek/play/pump：没有任何上传，也就没有任何
    // 需要等待的东西。这段窗口足以跑几十个采样周期。
    const baseline = samples.count();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(samples.count()).toBe(baseline); // 一次采样都没有
    expect(onBuffering).not.toHaveBeenCalled();
    session.dispose();
  });
});




describe("P196 缓冲指示组件落地", () => {
  const SHA = "b".repeat(64);
  const manifestId = "sha256:" + SHA + "@rev@test";
  const TOTAL = 900;

  function manifestRaw(): Record<string, unknown> {
    const ir = fixturePreviewIr() as Record<string, any>;
    return {
      schema: "preview-ir-v2", projector_version: 1, manifest_id: manifestId,
      timeline_revision_id: "rev_1", content_fingerprint: "sha256:" + SHA,
      fps_num: 30, fps_den: 1, total_frames: TOTAL, duration_us: TOTAL * 33_333,
      canvas: { ...ir.canvas, duration_frames: TOTAL }, inputs: ir.inputs, segments: ir.segments,
      captions: ir.captions, caption_styles: ir.caption_styles, transition_windows: ir.transition_windows,
      known_approximations: ir.known_approximations,
    };
  }

  function windowRaw(startFrame: number, frameCount: number): Record<string, unknown> {
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      n: startFrame + i, t_us: Math.round(((startFrame + i) * 1_000_000) / 30),
      main: { kind: "black" }, overlays: [], captions: [],
    }));
    return { schema: "preview-ir-v2", manifest_id: manifestId, start_frame: startFrame, frame_count: frames.length, frames };
  }

  /** 目标窗（≥600 起始）故意晚 1.1s 返回 = 一次"用户真在等"的连续缓冲；
   *  其余窗立即返回（装配不因此挂住）。 */
  function stubDesktop(): void {
    window.desktop = {
      getPreviewIrV2Manifest: vi.fn(() => Promise.resolve(manifestRaw())),
      getPreviewIrV2Window: vi.fn((input: { start_frame: number; frame_count: number }) =>
        input.start_frame >= 600
          ? new Promise(resolve => setTimeout(() => resolve(windowRaw(input.start_frame, input.frame_count)), 1_100))
          : Promise.resolve(windowRaw(input.start_frame, input.frame_count))),
      captionFontUrl: vi.fn().mockResolvedValue("https://fonts.test/caption.woff2"),
      captionFontUrls: vi.fn().mockResolvedValue([{ family: "Noto Sans CJK SC", media_url: "" }]),
    } as never;
  }

  beforeEach(() => {
    vi.useRealTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
    globalThis.fetch = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as never;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
  });

  const baseProps = () => ({
    projectId: "project_1", revisionId: "rev_1", outputRatio: "916",
    mediaUrls: new Map([["asset_video", "aivideo://media/one"]]),
    playing: false, playheadUs: 0, onTimeUs: vi.fn(), onFallback: vi.fn(),
  });

  /** 从第 startFrame 帧起播（paused→playing 走会话 play()，不经过暂停态外部
   *  seek 的 250ms 精修，避免它取消目标 seek）。 */
  function playFrom(frame: number) {
    const props = baseProps();
    const playingProps = { ...props, playing: true, playheadUs: Math.round((frame * 1_000_000) / 30) };
    const view = render(<SyntheticPreview {...playingProps} />);
    return { ...view, props };
  }

  it("缓冲超过 300ms 渲染指示条，帧到位后移除（不挡指针）", async () => {
    stubDesktop();
    // 从 590 起播：再 10 帧（~0.33s）就到窗 600，而该窗 1.1s 才回——
    // 装配期只取到窗 300（首屏 0..599），这里描述的是真机"播到未装配窗口"。
    playFrom(590);
    const chip = await screen.findByRole("status", {}, { timeout: 8_000 });
    expect(chip).toHaveTextContent("缓冲中");
    expect(chip.className).toBe("synthetic-buffering");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 8_000 });
    // 不挡指针是样式层保证（会话画布上的 PiP 手势必须穿透），jsdom 不加载
    // 样式表，直接对规则文本设卡。
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.synthetic-buffering \{[^}]*pointer-events: none/);
  });

  it("短于 300ms 的缓冲不渲染指示条（抗闪烁，组件侧口径）", async () => {
    stubDesktop();
    // 短暂停滞 120ms：窗口先不回、随后补齐——提示不得闪一下
    (window.desktop as unknown as { getPreviewIrV2Window: ReturnType<typeof vi.fn> }).getPreviewIrV2Window
      .mockImplementation((input: { start_frame: number; frame_count: number }) =>
        input.start_frame >= 600
          ? new Promise(resolve => setTimeout(() => resolve(windowRaw(input.start_frame, input.frame_count)), 120))
          : Promise.resolve(windowRaw(input.start_frame, input.frame_count)));
    playFrom(590);
    // 全程盯住 DOM（含 120ms 停滞窗口内）：不是"最后不在"，而是"一直没出现"
    const seen: boolean[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      seen.push(document.querySelector(".synthetic-buffering") !== null);
    }
    expect(seen.some(Boolean)).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

});
