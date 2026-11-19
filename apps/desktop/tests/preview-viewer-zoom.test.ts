import { describe, expect, it, vi } from "vitest";
import { FIT_VIEW, ZOOM_MAX_PX, ZOOM_MIN, ZOOM_SETTLE_MS, createScrubTellGate, createWheelCoalescer, createZoomSettle, fittedSize, isFit, panBy, wheelPx, wheelZoomFactor, zoomAt, zoomLayout, zoomMax } from "../src/app/preview/viewer-zoom.js";

/** S1：OpenFilm viewer-zoom.ts 字面口径 + 负向对照。 */
describe("viewer-zoom S1", () => {
  it("常量与 wheel 因子", () => {
    expect(FIT_VIEW).toEqual({ z: 1, cx: 0.5, cy: 0.5 });
    expect(ZOOM_MIN).toBe(0.25);
    expect(ZOOM_MAX_PX).toBe(8);
    expect(ZOOM_SETTLE_MS).toBe(700);
    expect(zoomMax(0.5)).toBe(16);
    expect(wheelZoomFactor(-10)).toBeCloseTo(Math.exp(0.1));
    // 负向对照：单次 wheel 因子被 ±25px 夹住，放大不会随 100px 增量失控。
    expect(wheelZoomFactor(-100)).toBe(wheelZoomFactor(-25));
    expect(wheelZoomFactor(100)).toBe(wheelZoomFactor(25));
    expect(wheelPx({ deltaMode: 1 }, 3)).toBe(48);
    expect(wheelPx({ deltaMode: 2 }, 2)).toBe(800);
    expect(wheelPx({ deltaMode: 0 }, -7)).toBe(-7);
    expect(isFit(FIT_VIEW)).toBe(true);
  });

  it("zoomAt 绕指针锚定；中心 3× 不改变中心份额", () => {
    const viewer = { w: 1000, h: 800 };
    const fitted = fittedSize(viewer, { w: 16, h: 9 });
    expect(zoomAt(FIT_VIEW, 3, { x: 500, y: 400 }, viewer, fitted, 16)).toEqual({ z: 3, cx: 0.5, cy: 0.5 });
    const off = zoomAt(FIT_VIEW, 2, { x: 750, y: 400 }, viewer, fitted, 16);
    expect(off.z).toBe(2);
    expect(off.cx).toBeGreaterThan(0.5); // 右侧锚点把画面中心往左推
    expect(off.cy).toBeCloseTo(0.5);
  });

  it("panBy 钳制在 0..1；zoomLayout 返回显式布局尺寸", () => {
    const fitted = { w: 1000, h: 562.5 };
    expect(panBy(FIT_VIEW, 100000, 0, fitted).cx).toBe(1);
    expect(panBy(FIT_VIEW, -100000, 0, fitted).cx).toBe(0);
    const layout = zoomLayout({ z: 2, cx: 0.5, cy: 0.5 }, fitted, { w: 1000, h: 800 });
    expect(layout.w).toBe(2000);
    expect(layout.h).toBe(1125);
    expect(layout.x).toBe(-500);
  });

  it("rAF 合帧：同一帧的多个 wheel 累乘后只提交一次", () => {
    let queued: (() => void) | null = null;
    const apply = vi.fn();
    const c = createWheelCoalescer(fn => { queued = fn; return 1; }, () => {}, apply);
    c.pushZoom(2, { x: 10, y: 20 });
    c.pushZoom(3, { x: 30, y: 40 });
    c.pushZoom(1.5, { x: 50, y: 60 });
    expect(apply).not.toHaveBeenCalled();
    queued!();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(9, 0, 0, { x: 50, y: 60 });
  });

  it("ZOOM_SETTLE_MS=700：静止满 700ms 才重绘一次；连续变化不提前重绘", () => {
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;
    const onSettle = vi.fn();
    const settle = createZoomSettle(
      ZOOM_SETTLE_MS,
      (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
      id => timers.delete(id),
      onSettle,
    );
    const fireDue = () => {
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    };
    // 连续缩放：0/100/300/600ms 各变化一次，都不足以静止 700ms。
    for (const t of [0, 100, 300, 600]) { now = t; settle.schedule(); fireDue(); expect(onSettle).not.toHaveBeenCalled(); }
    expect(settle.pending).toBe(true);
    now = 1299; fireDue();
    expect(onSettle).not.toHaveBeenCalled(); // 1299 < 600 + 700：负向对照，不提前重绘
    now = 1300; fireDue();
    expect(onSettle).toHaveBeenCalledTimes(1); // 静止满 700ms 恰好一次重绘调度
    now = 2500; fireDue();
    expect(onSettle).toHaveBeenCalledTimes(1); // 不重复重绘
    expect(settle.pending).toBe(false);
  });

  it("S7 15ms 门控：0/5/10/20ms 只放行 2 次，reset 后立即放行", () => {
    let now = 0;
    const gate = createScrubTellGate(15, () => now);
    const allowed = [0, 5, 10, 20].map(t => { now = t; return gate.allow(); });
    expect(allowed).toEqual([true, false, false, true]);
    gate.reset();
    expect(gate.allow()).toBe(true);
  });
});
