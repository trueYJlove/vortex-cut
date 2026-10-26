/** 窗口请求「在途但永不返回」——最后一条"冻结但无声"的路径。
 *
 * 缺陷形态：loadWindow 发起 fetchWindow 后把 promise 放进 inFlight，.finally
 * 负责摘除。若 fetchWindow 永不落定，这条记录就**永久**留在 inFlight 里：
 *  1. 该窗口的帧永远取不到（画面定格）；
 *  2. 它还长期占着 maxInFlight 的并发额度（默认 2），后续 seek 被直接拒绝
 *     排队——一个悬挂窗口会把整条预览一起拖垮。
 * 旧 isBuffering 把"在途"一律判为**不缓冲**（语义：请求已经在路上，马上就到），
 * 于是 (1) 这条路径上帧源层不出声。本文件把"在途"按**时长**一分为二：
 *
 *  - 阈值内（正常取窗 ~50-70ms）：不缓冲——这是抗闪烁的底线，任何回归都会让
 *    每次普通 seek 闪一下指示条，比没有提示更差（第 1 条用例钉的就是它）；
 *  - 超过阈值：缓冲——请求已经悬挂，永远不会自己兑现，"在途"与"根本没有请求"
 *    对用户是同一件事。
 *
 * 计时用 performance.now()，假定时器下随 advanceTimersByTime 推进（已实测），
 * 故三条用例都是确定性的，不需要真等 3s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowedFrameSource } from "../src/app/preview/frame-source.js";
import type { FrameSource } from "../src/app/preview/frame-source.js";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import type { Ir } from "../src/app/preview/ir.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";
import { installWorkers, ScriptedWorker, stubOffscreenCanvas } from "./fixtures/preview-worker-stubs.js";

const MANIFEST = "sha256:" + "a".repeat(64) + "@mode@ratio";
/** 窗口粒度 = 契约常量（PREVIEW_IR_V2_MAX_WINDOW_FRAMES）。 */
const W = 300;
/** 与 frame-source.ts 的 WINDOW_IN_FLIGHT_STALL_MS 同值：此处按**契约**断言，
 *  不 import 私有常量——常量改了而语义没变，用例不该跟着改。 */
const STALL_MS = 3_000;

/** 可控窗口源：请求一律悬挂，由 settleNext()/settleAll() 兑现。 */
function stalledSource(totalFrames: number, opts: { cacheBytes?: number; maxInFlight?: number } = {}) {
  const calls: number[] = [];
  const resolvers: Array<() => void> = [];
  const source = windowedFrameSource(MANIFEST, totalFrames, {
    cacheBytes: opts.cacheBytes,
    maxInFlight: opts.maxInFlight,
    fetchWindow: (start, count) => {
      calls.push(start);
      return new Promise(resolve => {
        resolvers.push(() => resolve({
          manifest_id: MANIFEST,
          start_frame: start,
          frame_count: count,
          frames: Array.from({ length: count }, (_, i) => {
            const n = start + i;
            return { n, t_us: n * 33_333, main: { kind: "black" }, overlays: [], captions: [] } as unknown as Record<string, unknown>;
          }),
        }));
      });
    },
  });
  /** 兑现一笔在途请求，并把 .then/.finally 链跑干净。 */
  const settleNext = async (): Promise<void> => {
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { source, calls, settleNext };
}

describe("窗口请求悬挂判定（在途时长阈值）", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("在途但未超阈值：isBuffering 保持 false（正常取窗不得闪烁——最重要的一条）", async () => {
    const { source } = stalledSource(2 * W);
    expect(source.isBuffering!(0)).toBe(true); // 尚未发起：未就绪 = 缓冲（既有语义）
    void source.ensureRange!(0, W);
    expect(source.isBuffering!(0)).toBe(false); // 已在途：请求在路上，不算缓冲
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    // 阈值内一律 false——这条是"别把正常取窗误报成缓冲"的回归闸门
    expect(source.isBuffering!(0)).toBe(false);
    expect(source.isBuffering!(W - 1)).toBe(false);
  });

  it("在途超过阈值：isBuffering 变为 true（悬挂 = 缓冲）", async () => {
    const { source } = stalledSource(2 * W);
    void source.ensureRange!(0, W);
    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(source.isBuffering!(0)).toBe(false); // 门槛前一刻仍是 false
    await vi.advanceTimersByTimeAsync(1);
    expect(source.isBuffering!(0)).toBe(true); // 越过门槛：悬挂成立
    expect(source.isBuffering!(W - 1)).toBe(true); // 同一窗口内的任意帧同结论
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.isBuffering!(0)).toBe(true); // 一直悬挂就一直报，不随时间退火
  });

  it("请求落定后状态清除：isBuffering 回到 false，且不残留旧时间戳", async () => {
    // cacheBytes 极小：窗 W 就绪后窗 0 必被逐出，可再次发起请求
    const { source, calls, settleNext } = stalledSource(2 * W, { cacheBytes: 1 });
    void source.ensureRange!(0, W);
    await vi.advanceTimersByTimeAsync(STALL_MS + 500);
    expect(source.isBuffering!(0)).toBe(true); // 前提：已悬挂

    await settleNext(); // 窗口到达
    expect(source.getFrame(0)).toBeDefined();
    expect(source.isBuffering!(0)).toBe(false); // 落定即恢复（边沿的另一端）

    void source.ensureRange!(W, 2 * W); // 取窗 W → 窗 0 被 LRU 逐出
    await settleNext();
    expect(source.getFrame(0)).toBeUndefined(); // 前提：窗 0 确实已被逐出

    void source.ensureRange!(0, 1); // 重新发起窗 0
    // 若 .finally 漏删时间戳，这里会**立刻**被判成悬挂（旧起点 > 阈值）——
    // 一次正常的重取被误报成缓冲，正是"两张表必须成对收摊"的那道闸门。
    expect(source.isBuffering!(0)).toBe(false);
    expect(calls.filter(start => start === 0)).toHaveLength(2); // 确有第二次请求
  });

  it("dispose 清空在途簿记：销毁后一律按未就绪报告，不残留任何窗口记录", async () => {
    const { source } = stalledSource(2 * W);
    void source.ensureRange!(0, W);
    await vi.advanceTimersByTimeAsync(STALL_MS + 500);
    expect(source.isBuffering!(0)).toBe(true); // 销毁前：已悬挂
    source.dispose!();
    expect(source.isBuffering!(0)).toBe(true);
    expect(source.buffered()).toEqual([]);
    expect(source.snapshotWindows()).toEqual([]);
    expect(source.getFrame(0)).toBeUndefined();

    // 关键的第二段：在**门槛之内**销毁。若 dispose 漏清在途条目，条目仍在，
    // 判定会走"在途但还没到阈值"分支返回 false——即已销毁的帧源仍自称
    // "有个请求马上就来"。销毁后不存在任何在途请求，必须恒为 true。
    const fresh = stalledSource(2 * W);
    void fresh.source.ensureRange!(0, W);
    await vi.advanceTimersByTimeAsync(100); // 远早于阈值
    expect(fresh.source.isBuffering!(0)).toBe(false); // 销毁前：正常在途
    fresh.source.dispose!();
    expect(fresh.source.isBuffering!(0)).toBe(true); // 销毁后：不得再自称在途
  });
});

/** 端到端：暂停态 + 目标窗口请求悬挂。会话侧 targetBuffering 对"取不到帧"
 *  直接判 true（getFrame 缺失分支），300ms 去抖后点亮指示条——这条用例证明
 *  悬挂窗口在**暂停、无人操作**时也不会无声冻结，且窗口到达后提示自行消失。
 *  （注：这条路径不需要窗口时长的额外采样，详见实现报告。） */
describe("端到端：暂停态悬挂窗口点亮缓冲指示", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ScriptedWorker.instances = [];
    installWorkers();
    stubOffscreenCanvas();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** 黑帧 IR：main.kind="black" 不需要任何输入解码，判定只剩帧源层。 */
  function blackIr(totalFrames: number): Ir {
    const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
    ir.inputs = [];
    ir.segments = [];
    ir.frames = [] as Ir["frames"];
    ir.canvas = { ...ir.canvas, duration_frames: totalFrames, duration_us: Math.round((totalFrames * 1_000_000) / 30) };
    return ir;
  }

  it("目标窗永不返回：300ms 去抖后出提示，远超阈值仍亮着；窗口到达后消失", async () => {
    const total = 900;
    const resolvers: Array<() => void> = [];
    const source: FrameSource = windowedFrameSource(MANIFEST, total, {
      fetchWindow: (start, count) => new Promise(resolve => {
        resolvers.push(() => resolve({
          manifest_id: MANIFEST, start_frame: start, frame_count: count,
          frames: Array.from({ length: count }, (_, i) => {
            const n = start + i;
            return { n, t_us: Math.round((n * 1_000_000) / 30), main: { kind: "black" }, overlays: [], captions: [] } as unknown as Record<string, unknown>;
          }),
        }));
      }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const session = await PreviewSession.create(container, blackIr(total), new Map(), undefined, undefined, null, undefined, null, source);
    const onBuffering = vi.fn();
    session.onBuffering = onBuffering;

    void session.seekToFrame(5); // 取窗悬挂：seek 停在 await 上
    await vi.advanceTimersByTimeAsync(299);
    expect(onBuffering).not.toHaveBeenCalled(); // 300ms 门槛内静默（抗闪烁）
    await vi.advanceTimersByTimeAsync(2);
    expect(onBuffering.mock.calls).toEqual([[true]]); // 悬挂窗口出声

    await vi.advanceTimersByTimeAsync(STALL_MS); // 远超阈值：边沿触发不得重复报
    expect(onBuffering).toHaveBeenCalledTimes(1);
    // 注意：这里**不断言** isBuffering(5)。实测（见实现报告）会话侧对"取不到帧"
    // 在 isBuffering 之前就返回 true，故本用例的指示灯路径**不依赖**本次改动；
    // 把它写进断言只会造出一条"与实现无关却恰好变绿"的假证据。帧源层口径由
    // 上面 4 条用例单独钉。

    resolvers.shift()?.(); // 窗口终于到达
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onBuffering.mock.calls).toEqual([[true], [false]]); // 恢复：提示消失
    expect(source.isBuffering!(5)).toBe(false);
    session.dispose();
  });
});