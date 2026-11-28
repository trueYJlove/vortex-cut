/** OpenFilm viewer-zoom 交互口径的纯函数层（S1/S2）。
 *  坐标全部是 viewer 客户区 CSS px；view.z 是 fittedSize 的倍数，cx/cy 是画面中心点份额。
 *  画面按布局尺寸绘制（width/height），父容器不做 transform:scale —— 手柄保持屏幕 px。
 */
import { clamp } from "../math.js";

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type ViewerView = { z: number; cx: number; cy: number };

export const FIT_VIEW: ViewerView = Object.freeze({ z: 1, cx: 0.5, cy: 0.5 });
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX_PX = 8;
export const ZOOM_SETTLE_MS = 700;
const WHEEL_STEP_MAX = 25;
const WHEEL_PX_PER_E = 100;

export const isFit = (v: ViewerView): boolean => v.z === FIT_VIEW.z && v.cx === FIT_VIEW.cx && v.cy === FIT_VIEW.cy;
export const zoomMax = (fitK: number): number => Math.max(1, ZOOM_MAX_PX / Math.max(1e-6, fitK));
export const wheelPx = (e: { deltaMode: number }, d: number): number => e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * 400 : d;
export const wheelZoomFactor = (deltaPx: number): number => Math.exp(-clamp(deltaPx, -WHEEL_STEP_MAX, WHEEL_STEP_MAX) / WHEEL_PX_PER_E);

export function fittedSize(viewer: Size, frame: Size): Size {
  return viewer.w / viewer.h < frame.w / frame.h
    ? { w: viewer.w, h: (viewer.w * frame.h) / frame.w }
    : { w: (viewer.h * frame.w) / frame.h, h: viewer.h };
}

/** 绕 viewer 内 at 缩放：指针下那一点在缩放前后保持不动。 */
export function zoomAt(view: ViewerView, factor: number, at: Point, viewer: Size, fitted: Size, max: number): ViewerView {
  const z = clamp(view.z * factor, ZOOM_MIN, Math.max(ZOOM_MIN, max, view.z));
  if (z === view.z) return view;
  const pw = fitted.w * view.z, ph = fitted.h * view.z;
  const ux = (at.x - viewer.w / 2) / pw + view.cx;
  const uy = (at.y - viewer.h / 2) / ph + view.cy;
  return {
    z,
    cx: clamp(ux - (at.x - viewer.w / 2) / (fitted.w * z), 0, 1),
    cy: clamp(uy - (at.y - viewer.h / 2) / (fitted.h * z), 0, 1),
  };
}

export function panBy(view: ViewerView, dx: number, dy: number, fitted: Size): ViewerView {
  const next = {
    z: view.z,
    cx: clamp(view.cx + dx / (fitted.w * view.z), 0, 1),
    cy: clamp(view.cy + dy / (fitted.h * view.z), 0, 1),
  };
  return next.cx === view.cx && next.cy === view.cy ? view : next;
}

/** 布局尺寸缩放：返回画面显式像素宽高与其在 viewer 中居中/偏移后的左上角。
 *  S2：绝不使用 transform:scale；容器按布局尺寸摆放，手柄尺寸不随 z 变化。 */
export function zoomLayout(view: ViewerView, fitted: Size, viewer: Size): Size & Point {
  const w = fitted.w * view.z, h = fitted.h * view.z;
  return {
    w, h,
    x: viewer.w / 2 - view.cx * w,
    y: viewer.h / 2 - view.cy * h,
  };
}

/** rAF 合帧：一帧内的多个 wheel 事件累乘缩放因子、累加平移量，帧末一次性提交。 */
export function createWheelCoalescer(
  raf: (fn: () => void) => number,
  cancel: (id: number) => void,
  apply: (factor: number, dx: number, dy: number, anchor: Point) => void,
) {
  let frameId = 0;
  let factor = 1, dx = 0, dy = 0;
  let anchor: Point = { x: 0, y: 0 };
  const flush = () => {
    frameId = 0;
    const f = factor, ax = dx, ay = dy, at = anchor;
    factor = 1; dx = 0; dy = 0;
    apply(f, ax, ay, at);
  };
  return {
    pushZoom(next: number, at: Point) { factor *= next; anchor = at; if (!frameId) frameId = raf(flush); },
    pushPan(nextX: number, nextY: number) { dx += nextX; dy += nextY; if (!frameId) frameId = raf(flush); },
    dispose() { if (frameId) cancel(frameId); frameId = 0; factor = 1; dx = 0; dy = 0; },
  };
}

/** 缩放静止后的单次重绘调度（S1/S2）：连续变化只保留最后一个定时器，
 *  静止满 ZOOM_SETTLE_MS 才触发一次 onSettle，绝不提前重绘。 */
export function createZoomSettle(
  delayMs: number,
  schedule: (fn: () => void, ms: number) => number,
  cancel: (id: number) => void,
  onSettle: () => void,
) {
  let timer: number | null = null;
  return {
    schedule(): void {
      if (timer !== null) cancel(timer);
      timer = schedule(() => { timer = null; onSettle(); }, delayMs);
    },
    dispose(): void { if (timer !== null) { cancel(timer); timer = null; } },
    get pending(): boolean { return timer !== null; },
  };
}

/** 15ms 门控只用于 interactive HTMLMediaElement 的 seek 路径（S7）。 */
export function createScrubTellGate(intervalMs: number, now: () => number) {
  let last = -Infinity;
  return {
    allow(): boolean {
      const t = now();
      if (t - last < intervalMs) return false;
      last = t;
      return true;
    },
    reset() { last = -Infinity; },
  };
}
