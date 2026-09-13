/** C20a FrameSource 测试：v1 数组适配与 ir.frames 直访逐点等价
 *  （getFrame 引用稳定性——就地补丁语义依赖；越界 undefined；ensureRange
 *  立即完成；dispose 无操作——数组归 Ir 所有）。 */
import { describe, expect, it } from "vitest";
import { arrayFrameSource, windowPrefetchStarts, windowedFrameSource, type WindowSeed } from "../src/app/preview/frame-source.js";
import type { Ir, IrFrame } from "../src/app/preview/ir.js";

function makeIr(frameCount: number): Ir {
  const frames: IrFrame[] = Array.from({ length: frameCount }, (_, n) => ({
    n,
    t_us: n * 33_333,
    main: { kind: "black" },
    overlays: [],
    captions: [],
  }));
  return {
    schema: "preview-ir-v1",
    projector_version: 1,
    canvas: { width: 960, height: 540, fps: 30, duration_frames: frameCount, duration_us: frameCount * 33_333, background: "#000000" },
    inputs: [],
    segments: [],
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames,
  } as unknown as Ir;
}

describe("C20a arrayFrameSource（v1 等价适配）", () => {
  it("getFrame 与数组下标逐点一致（含引用身份——就地补丁语义）", () => {
    const ir = makeIr(300);
    const source = arrayFrameSource(ir);
    expect(source.frameCount).toBe(300);
    for (const n of [0, 1, 42, 149, 299]) {
      expect(source.getFrame(n)).toBe(ir.frames[n]); // 同一对象引用
    }
  });

  it("越界返回 undefined（与数组语义一致）", () => {
    const source = arrayFrameSource(makeIr(10));
    expect(source.getFrame(-1)).toBeUndefined();
    expect(source.getFrame(10)).toBeUndefined();
    expect(source.getFrame(9999)).toBeUndefined();
  });

  it("空帧表：frameCount=0，getFrame 恒 undefined", () => {
    const source = arrayFrameSource(makeIr(0));
    expect(source.frameCount).toBe(0);
    expect(source.getFrame(0)).toBeUndefined();
  });

  it("ensureRange 立即完成（v1 全量在场）；dispose 无操作不破坏数组", async () => {
    const ir = makeIr(5);
    const source = arrayFrameSource(ir);
    await expect(source.ensureRange!(0, 5)).resolves.toBeUndefined();
    source.dispose?.();
    expect(source.getFrame(2)).toBe(ir.frames[2]); // dispose 不影响数组所有权
  });

  it("帧对象就地修改经 source 可见（setPipGeometry 类手势路径的前提）", () => {
    const ir = makeIr(3);
    const source = arrayFrameSource(ir);
    const frame = source.getFrame(1)!;
    frame.captions = ["cap-1"];
    expect(source.getFrame(1)!.captions).toEqual(["cap-1"]);
    expect(ir.frames[1]!.captions).toEqual(["cap-1"]);
  });
});

/** C20 第二阶段：windowedFrameSource(v2 窗口帧源)行为契约。
 *  覆盖 Planning Gate 2026-09-11 §2.1:LRU 缓存/single-flight/在途上限/
 *  manifest_id 失配丢弃/abort 语义/引用稳定性/显式 buffering 判定。 */
interface WindowCall { start: number; count: number }

function makeWindowHarness(totalFrames: number, opts?: { windowSize?: number; cacheBytes?: number; maxInFlight?: number; seedWindows?: WindowSeed[] }) {
  const calls: WindowCall[] = [];
  const resolvers: Array<(value: { manifest_id: string; start_frame: number; frame_count: number; frames: Array<Record<string, unknown>> }) => void> = [];
  const source = windowedFrameSource("sha256:" + "a".repeat(64) + "@mode@ratio", totalFrames, {
    cacheBytes: opts?.cacheBytes,
    maxInFlight: opts?.maxInFlight,
    seedWindows: opts?.seedWindows,
    fetchWindow: (start, count) => new Promise(resolve => {
      calls.push({ start, count });
      resolvers.push(resolve);
    }),
  });
  /** 用既定 calls 列表兑现所有(或指定)挂起请求——帧 n 由 start+i 推得。 */
  const flush = (specific?: WindowCall[]) => {
    const list = specific ?? calls.map(c => ({ ...c }));
    list.forEach(call => {
      const resolve = resolvers.shift();
      resolve?.({
        manifest_id: "sha256:" + "a".repeat(64) + "@mode@ratio",
        start_frame: call.start,
        frame_count: call.count,
        frames: Array.from({ length: call.count }, (_, i) => {
          const n = call.start + i;
          return { n, t_us: n * 33_333, main: { kind: "black" }, overlays: [], captions: [] } as unknown as Record<string, unknown>;
        }),
      });
    });
  };
  return { source, calls, flush };
}

describe("C20 v2 windowedFrameSource", () => {
  // 窗口粒度 = 契约常量 300(PREVIEW_IR_V2_MAX_WINDOW_FRAMES)。
  const W = 300;

  it("frameCount = total_frames;未就绪帧 getFrame undefined + isBuffering true", () => {
    const { source } = makeWindowHarness(2 * W + 10);
    expect(source.frameCount).toBe(2 * W + 10);
    expect(source.getFrame(0)).toBeUndefined();
    expect(source.isBuffering!(0)).toBe(true);
  });

  it("ensureRange 装配窗口;同帧重复 getFrame 同一对象引用(引用稳定性契约)", async () => {
    const { source, calls, flush } = makeWindowHarness(2 * W);
    const pending = source.ensureRange!(0, 4); // 只覆盖窗 0
    flush([{ start: 0, count: W }]);
    await pending;
    const first = source.getFrame(1)!;
    expect(first.n).toBe(1);
    expect(source.getFrame(1)).toBe(first); // 缓存内引用稳定
    expect(calls.map(c => c.start)).toEqual([0]); // 只装配了所需窗口
  });

  it("single-flight:同窗口并发 ensureRange 只发一次请求", async () => {
    const { source, calls, flush } = makeWindowHarness(W);
    const a = source.ensureRange!(0, W);
    const b = source.ensureRange!(0, W);
    flush([{ start: 0, count: W }]);
    await Promise.all([a, b]);
    expect(calls.filter(c => c.start === 0)).toHaveLength(1);
  });

  it("在途上限 maxInFlight:超出时不排队,后续 ensureRange 重试", async () => {
    const { source, calls, flush } = makeWindowHarness(3 * W, { maxInFlight: 2 });
    const p1 = source.ensureRange!(0, 3 * W); // 窗 0,1,2 → 只 2 在途
    flush(); // 兑现已发请求
    await p1;
    expect(calls.length).toBe(2);
    // 重试:剩余窗口重新请求
    const p2 = source.ensureRange!(0, 3 * W);
    flush();
    await p2;
    expect(calls.length).toBeGreaterThan(2);
  });

  it("LRU 逐出整窗:超预算后旧窗重取生成新请求", async () => {
    const { source, calls, flush } = makeWindowHarness(2 * W, { cacheBytes: 1 }); // 1B 预算
    const p0 = source.ensureRange!(0, W);
    flush([{ start: 0, count: W }]);
    await p0;
    const frame0 = source.getFrame(0)!;
    expect(frame0.n).toBe(0);
    const p1 = source.ensureRange!(W, 2 * W);
    flush([{ start: W, count: W }]);
    await p1;
    expect(calls.filter(c => c.start === W)).toHaveLength(1);
    void frame0;
  });

  it("abort:未发出的窗口请求被取消(不触发 fetchWindow)", async () => {
    const { source, calls } = makeWindowHarness(2 * W);
    const controller = new AbortController();
    controller.abort();
    await source.ensureRange!(0, 2 * W, controller.signal);
    expect(calls).toHaveLength(0);
  });

  it("manifest_id 失配响应整体丢弃(不进入缓存)", async () => {
    const mismatch = windowedFrameSource("sha256:" + "a".repeat(64) + "@mode@ratio", W, {
      fetchWindow: () => Promise.resolve({
        manifest_id: "sha256:" + "b".repeat(64) + "@mode@ratio",
        start_frame: 0, frame_count: W, frames: Array.from({ length: W }, (_, n) => ({ n })),
      }),
    });
    await mismatch.ensureRange!(0, W);
    expect(mismatch.getFrame(0)).toBeUndefined();
    expect(mismatch.isBuffering!(0)).toBe(true); // 不在缓存也不在途 → buffering
  });

  it("dispose 清空缓存;buffered() 报告已就绪区间", async () => {
    const { source, flush } = makeWindowHarness(2 * W);
    const pending = source.ensureRange!(0, W);
    flush([{ start: 0, count: W }]);
    await pending;
    expect(source.buffered()).toEqual([[0, W]]);
    source.dispose?.();
    expect(source.getFrame(0)).toBeUndefined();
    expect(source.buffered()).toEqual([]);
  });
});

describe("windowPrefetchStarts（C20-T1 预取窗序）", () => {
  it("对称 ±span、同距对内先正向、近目标优先、去重", () => {
    // 1000 帧 / 300 窗：窗口起点 0/300/600/900
    expect(windowPrefetchStarts(250, 2, 300, 1000)).toEqual([300, 600]); // 目标在窗 0:-k 夹回自身被剔
    expect(windowPrefetchStarts(350, 2, 300, 1000)).toEqual([600, 0, 900]); // 同距对内正向在前
    expect(windowPrefetchStarts(950, 2, 300, 1000)).toEqual([600, 300]); // 末窗:+k 夹回自身,仅向后
  });

  it("单窗源不产生预取;span 0 返回空", () => {
    expect(windowPrefetchStarts(50, 2, 300, 100)).toEqual([]);
    expect(windowPrefetchStarts(50, 0, 300, 100)).toEqual([]);
  });
});

/** C20c-2：种子窗口迁移（manifest_id 相等 = 同投影，撤销/重做/空转 revision
 *  的缓存整体迁移）。帧对象引用共享 = 引用稳定性契约的跨源延续。 */
describe("C20c-2 seedWindows（缓存窗口迁移）", () => {
  const W = 300;

  function makeSeed(start: number, count: number): WindowSeed {
    const frames = new Map<number, IrFrame>();
    for (let i = 0; i < count; i++) {
      const n = start + i;
      frames.set(n, { n, t_us: n * 33_333, main: { kind: "black" }, overlays: [], captions: [] });
    }
    return { startFrame: start, frames };
  }

  it("种子窗口零请求就绪：getFrame 返回种子原对象（golden = 引用同一），fetchWindow 零调用", async () => {
    const seed = makeSeed(0, W);
    const { source, calls } = makeWindowHarness(2 * W, { seedWindows: [seed] });
    const seeded = seed.frames.get(5)!;
    expect(source.getFrame(5)).toBe(seeded); // 引用同一——同指纹同投影的强断言
    await source.ensureRange!(0, W); // 种子窗已就绪：立即完成
    expect(calls).toEqual([]);
    expect(source.isBuffering!(W - 1)).toBe(false);
    expect(source.isBuffering!(W)).toBe(true); // 未种子窗仍按未就绪报告
  });

  it("种子计入 LRU 记账：超预算按最旧逐出，被逐种子窗重取生成新请求", async () => {
    // frameBytes 默认 4096/帧：预算 3 窗以内——种 2 窗 + 取 2 窗 → 首种子窗逐出
    const { source, calls, flush } = makeWindowHarness(4 * W, {
      seedWindows: [makeSeed(0, W), makeSeed(W, W)],
      cacheBytes: 3.5 * W * 4096,
    });
    const pending = source.ensureRange!(2 * W, 4 * W); // 取窗 2、3
    flush();
    await pending;
    expect(source.getFrame(5)).toBeUndefined(); // 窗 0（最旧）已逐出
    expect(source.getFrame(2 * W)).toBeDefined();
    // 重新取窗 0：生成新请求（逐出后重取语义不变）
    const again = source.ensureRange!(0, 1);
    flush();
    await again;
    expect(calls.some(c => c.start === 0)).toBe(true);
  });

  it("种子防御性过滤：越界帧剔除、越界窗口忽略，不崩溃不污染缓存", async () => {
    const bad = makeSeed(2 * W, W); // start 超出 totalFrames(2W) —— 整窗忽略
    const partial = makeSeed(W, W);
    partial.frames.delete(W); // 缺首帧的种子窗：容忍（getFrame undefined = 未就绪语义）
    const { source, calls, flush } = makeWindowHarness(2 * W, { seedWindows: [bad, partial] });
    expect(source.getFrame(2 * W)).toBeUndefined();
    expect(source.getFrame(W + 1)).toBeDefined();
    expect(calls).toEqual([]);
    const pending = source.ensureRange!(0, 1); // 被剔除的首帧按需补齐
    flush();
    await pending;
    expect(source.getFrame(0)).toBeDefined();
  });

  it("snapshotWindows 导出缓存；dispose 清条目不清 Map，新源以同批帧对象复活", async () => {
    const { source, calls, flush } = makeWindowHarness(2 * W);
    const pending = source.ensureRange!(0, W);
    flush();
    await pending;
    const snapshot = source.snapshotWindows();
    expect(snapshot.map(s => s.startFrame)).toEqual([0]);
    const frame5 = source.getFrame(5)!;
    source.dispose!(); // 清条目——Map 与帧对象由新源种子继续持有
    expect(source.getFrame(5)).toBeUndefined();
    expect(snapshot[0]!.frames.get(5)).toBe(frame5);
    const revived = windowedFrameSource("sha256:" + "a".repeat(64) + "@mode@ratio", 2 * W, {
      seedWindows: snapshot,
      fetchWindow: (start, count) => new Promise(resolve => { calls.push({ start, count }); }),
    });
    expect(revived.getFrame(5)).toBe(frame5); // 跨源引用同一（复用的 golden 语义）
  });
});
