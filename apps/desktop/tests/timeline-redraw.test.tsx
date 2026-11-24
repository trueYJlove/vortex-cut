/** A06：Canvas 最小失效范围——播放头分离 + 尺寸守卫 + 稳定几何。
 *  断言核心：播放期间（store 连续写入）主画布 drawTimeline 调用次数 ≤2，
 *  播放头由独立 DOM 覆盖层跟随；canvas 尺寸未变时不重赋 backing size。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { TimelineDocument } from "@aivideo/contracts";
import { TimelinePanel } from "../src/app/timeline/TimelineCanvas.js";
import { TimelinePlayheadLayer } from "../src/app/timeline/TimelinePlayheadLayer.js";
import { createPlayheadStore } from "../src/app/timeline/playhead-store.js";

const doc = (): TimelineDocument => ({
  schema_version: 1,
  project_id: "p1" as never,
  canvas: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, background_color: "#000000" },
  tracks: [
    { id: "C1", kind: "text", locked: false, hidden: false, muted: false, solo: false },
    { id: "V1", kind: "video", locked: false, hidden: false, muted: false, solo: false },
    { id: "A1", kind: "audio", locked: false, hidden: false, muted: false, solo: false },
  ],
  clips: [
    {
      clip_id: "clip_1" as never,
      track_id: "V1",
      order_index: 0,
      asset_id: "a1" as never,
      asset_kind: "video",
      source_start_us: 0,
      source_end_us: 2_000_000,
      timeline_start_us: 0,
      timeline_end_us: 2_000_000,
      layout: "fit",
      audio: { enabled: true, gain_db: 0 },
    },
  ],
  captions: [],
  transitions: [],
  provenance: { created_by: "user", source_transcript_ids: [] },
});

const baseProps = () => ({
  selection: null,
  setSelection: vi.fn(),
  onPatch: vi.fn().mockResolvedValue(undefined),
  onDropAsset: vi.fn(),
  canUndo: false,
  canRedo: false,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  assetMedia: [],
  onSeek: vi.fn(),
  onCommand: vi.fn(),
});

/** jsdom 无 2D 上下文：替身记 drawTimeline 入口（清屏+底色即可断言次数），
 *  并对 canvas backing 赋值做尺寸守卫拦截。 */
interface FakeCanvas2D {
  drawCount: number;
  mainDrawCount: number;
  widthSetCount: number;
  heightSetCount: number;
}
function installCanvas2DStub(): FakeCanvas2D {
  const state: FakeCanvas2D = { drawCount: 0, mainDrawCount: 0, widthSetCount: 0, heightSetCount: 0 };
  const stub = {
    /* 「一次绘制」按 setTransform 计数：drawTimeline 每次绘制的第一件事就是它，
       与配色无关。原来靠比对画布底色的字面量 "#181c1f" 判定——那是脆的，
       一次纯粹的颜色令牌调整（2026-11-16 把偏蓝的画布底中性化为 #161618）
       就让计数恒为 0，测试报「没有绘制」而不是「颜色变了」（实测踩中）。 */
    setTransform: () => { state.drawCount += 1; },
    clearRect: () => undefined,
    fillRect: () => undefined,
    measureText: () => ({ width: 10 }) as TextMetrics,
    fillText: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    roundRect: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    arc: () => undefined,
    closePath: () => undefined,
    setLineDash: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    drawImage: () => undefined,
    strokeRect: () => undefined,
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(function getContext(this: HTMLCanvasElement, kind: string) {
      if (kind !== "2d") return null;
      // 拦截 backing 尺寸赋值：A06 尺寸守卫——值不变不重赋（重赋会整幅清空）。
      const target = this;
      return new Proxy(stub as unknown as CanvasRenderingContext2D, {
        set(obj, prop, value) {
          return Reflect.set(obj, prop, value);
        },
        get(obj, prop) {
          if (prop === "canvas") return target;
          if (prop === "setTransform" && target.getAttribute("aria-label") === "时间线画布") {
            return () => { state.mainDrawCount += 1; obj.setTransform(); };
          }
          return Reflect.get(obj, prop);
        },
      });
    }),
  });
  // canvas.width/height 属性赋值计数（A06 尺寸守卫：值未变不重赋）。
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height");
  const nativeWidthSet = widthDesc?.set;
  const nativeHeightSet = heightDesc?.set;
  if (nativeWidthSet && nativeHeightSet) {
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      configurable: true,
      set(this: HTMLCanvasElement, value: number) {
        state.widthSetCount += 1;
        nativeWidthSet.call(this, value);
      },
      get: widthDesc.get,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "height", {
      configurable: true,
      set(this: HTMLCanvasElement, value: number) {
        state.heightSetCount += 1;
        nativeHeightSet.call(this, value);
      },
      get: heightDesc.get,
    });
  }
  return state;
}

let store: ReturnType<typeof createPlayheadStore> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  store = createPlayheadStore();
});

afterEach(() => {
  cleanup();
  store = null;
});

it("redraws the ruler without repainting the tracks on pointer hover", () => {
  const state = installCanvas2DStub();
  const { container } = render(<TimelinePanel document={doc()} {...baseProps()} />);
  const ruler = container.querySelector(".timeline-ruler-pin")!;
  const before = { ...state };
  for (let x = 230; x < 250; x++) {
    fireEvent(ruler, new MouseEvent("pointermove", { bubbles: true, clientX: x }));
  }
  expect(state.drawCount).toBeGreaterThan(before.drawCount);
  expect(state.mainDrawCount).toBe(before.mainDrawCount);
});

describe("A06 — 播放头 store", () => {
  it("set 值未变化不通知；变化后微任务合并通知（一帧多次只派发一次）", async () => {
    const s = createPlayheadStore();
    expect(s.getSnapshot()).toBe(0);
    let notifications = 0;
    const unsubscribe = s.subscribe(() => { notifications += 1; });
    s.set(0); // 值不变 → 不通知
    s.set(1_000_000);
    s.set(2_000_000);
    s.set(3_000_000);
    await Promise.resolve(); // 微任务合并
    expect(s.getSnapshot()).toBe(3_000_000);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("dispatch 递增 requestId 并记录来源；命令语义可回溯", () => {
    const s = createPlayheadStore();
    s.dispatch({ source: "playback", timeUs: 500 });
    s.dispatch({ source: "user", timeUs: 900 });
    expect(s.getRequestId()).toBe(2);
    expect(s.getLastCommand()).toEqual({ source: "user", timeUs: 900, requestId: 2 });
    expect(s.get()).toBe(900);
  });

  it("非有限值拒绝写入（防御性）", () => {
    const s = createPlayheadStore();
    s.set(Number.NaN);
    s.set(Number.POSITIVE_INFINITY);
    expect(s.getSnapshot()).toBe(0);
  });
});

describe("A06 — TimelinePlayheadLayer 覆盖层", () => {
  it("store 写入直接驱动覆盖层位移（不经过 TimelinePanel 渲染）", async () => {
    const s = store!;
    const { container } = render(
      <TimelinePlayheadLayer store={s} view={{ pixelsPerSecond: 100, scrollX: 0, headerWidth: 60, rulerHeight: 24, trackHeight: 80 } as never} totalUs={2_000_000} contentHeight={300} />,
    );
    const line = container.querySelector<HTMLElement>(".timeline-playhead-line");
    expect(line).not.toBeNull();
    act(() => { s.set(1_000_000); });
    await act(async () => { await Promise.resolve(); });
    // pps=100、headW=60：1s → 60px(时间) + 60px(头列) = 160px。
    expect(line?.style.transform).toBe("translateX(160px)");
  });

  it("播放头显示位置钳制在素材终点内", async () => {
    const s = store!;
    const { container } = render(
      <TimelinePlayheadLayer store={s} view={{ pixelsPerSecond: 100, scrollX: 0, headerWidth: 60, rulerHeight: 24, trackHeight: 80 } as never} totalUs={2_000_000} contentHeight={300} />,
    );
    const line = container.querySelector<HTMLElement>(".timeline-playhead-line");
    act(() => { s.set(5_000_000); });
    await act(async () => { await Promise.resolve(); });
    expect(line?.style.transform).toBe("translateX(260px)"); // 钳制 2s：60 + 2×100
  });

  it("位于头列左缘外时线不可见（与旧 Canvas 可视判据一致）", () => {
    const s = store!;
    const { container } = render(
      <TimelinePlayheadLayer store={s} view={{ pixelsPerSecond: 100, scrollX: 800, headerWidth: 60, rulerHeight: 24, trackHeight: 80 } as never} totalUs={2_000_000} contentHeight={300} />,
    );
    // P33 L9：覆盖层改为命令式跟随（播放期零 React 提交），可视判据由「条件渲染」
    // 变为「display 切换」——语义不变（不可见），断言随之改为检查隐藏态。
    const layer = container.querySelector<HTMLElement>(".timeline-playhead-layer");
    expect(layer?.style.display).toBe("none");
  });
});

describe("A06 — 播放期间主画布零重绘", () => {
  it("store 连续推进 300 帧期间，主画布 drawTimeline 次数 ≤2（验收：静态时间轴播放 10 秒 ≤2 次绘制）", async () => {
    const state = installCanvas2DStub();
    const s = store!;
    const { unmount } = render(
      <TimelinePanel document={doc()} {...baseProps()} playheadStore={s} />,
    );
    // 初次绘制（挂载 + 可能的 effects）。
    const initialDraws = state.drawCount;
    expect(initialDraws).toBeGreaterThanOrEqual(1);
    // 播放 10 秒（30fps × 10s = 300 帧连续写入——覆盖层跟随，主画布静止）。
    for (let frame = 0; frame < 300; frame += 1) {
      act(() => { s.set(frame * 33_333); });
    }
    await act(async () => { await Promise.resolve(); });
    expect(state.drawCount - initialDraws).toBeLessThanOrEqual(2);
    unmount();
  });

  it("canvas backing 尺寸未变化时不重赋值（尺寸守卫）", () => {
    const state = installCanvas2DStub();
    const s = store!;
    const { unmount, rerender } = render(
      <TimelinePanel document={doc()} {...baseProps()} playheadStore={s} />,
    );
    const initialWidthSets = state.widthSetCount;
    // 同尺寸重渲（播放头 store 推进触发的覆盖层更新不进组件，这里用等值 props 重渲）。
    rerender(<TimelinePanel document={doc()} {...baseProps()} playheadStore={s} />);
    rerender(<TimelinePanel document={doc()} {...baseProps()} playheadStore={s} />);
    expect(state.widthSetCount).toBe(initialWidthSets); // 尺寸未变 → 不重赋
    unmount();
  });
});
