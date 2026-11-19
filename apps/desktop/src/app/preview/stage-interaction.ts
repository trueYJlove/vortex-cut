/** 预览画布交互纯函数层（S3/S4/S5/S8）：命中、框选状态机、手柄几何与光标。
 *  所有坐标为客户区 CSS px（与 SyntheticPipLayer 的 pointerToCanvas 输出同域）。
 *  S8：zRank 恒取 working.tracks 数组索引（0=最上层），绝不取 document.clips 顺序。
 */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type EdgeDir = "n" | "s" | "e" | "w";
export type CornerDir = "nw" | "ne" | "sw" | "se";

export const FRAME_COLOR = "#0fa596";
export const HANDLE_BOX_MIN = 28;
export const MARQUEE_MIN_PX = 8;
export const GESTURE_HINT = { dx: 14, dy: 16, background: "rgba(30,30,30,.92)", fontSizePx: 10.5 } as const;

export interface HitBox extends Rect {
  clipId: string;
  /** 顺时针角度（度），命中判定需反向旋转指针。 */
  rotate?: number;
  /** 后绘制者在同一 zRank 下胜出；缺省 = 数组序。 */
  renderOrder?: number;
}

/** 轨道数组索引 = z 序（0=最上层）。未知轨道排最后（最下层）。 */
export function zRankByTracks(tracks: readonly { id: string }[], trackId: string): number {
  const index = tracks.findIndex(track => track.id === trackId);
  return index < 0 ? tracks.length : index;
}

/** Core layers 下层先画、上层后画；命中按 zRank 升序取最上层。 */
export function rankForHit<T>(boxes: readonly T[], zRank: (box: T, index: number) => number): T[] {
  return boxes.map((box, index) => ({ box, index, rank: zRank(box, index) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.box);
}

/** 旋转盒命中：把指针绕盒中心反向旋转回未旋转的局部坐标。 */
export function insideFrame(point: Point, box: HitBox, floor = false): boolean {
  const w = floor ? Math.max(box.w, HANDLE_BOX_MIN) : box.w;
  const h = floor ? Math.max(box.h, HANDLE_BOX_MIN) : box.h;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const deg = box.rotate ?? 0;
  const rad = (-deg * Math.PI) / 180;
  const px = point.x - cx, py = point.y - cy;
  const lx = px * Math.cos(rad) - py * Math.sin(rad);
  const ly = px * Math.sin(rad) + py * Math.cos(rad);
  return Math.abs(lx) <= w / 2 + 1e-6 && Math.abs(ly) <= h / 2 + 1e-6;
}

/** 最上层优先：zRank 升序 → 同 rank 小面积胜 → 仍并列则后绘制（renderOrder 大）胜。 */
export function pickTopmostBox<T extends HitBox>(boxes: readonly T[], point: Point, zRank: (box: T) => number): T | null {
  const hits = boxes
    .map((box, index) => ({ box, index }))
    .filter(({ box }) => insideFrame(point, box, true));
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const dz = zRank(a.box) - zRank(b.box);
    if (dz !== 0) return dz;
    const da = a.box.w * a.box.h - b.box.w * b.box.h;
    if (Math.abs(da) > 1e-6) return da;
    const orderA = a.box.renderOrder ?? a.index;
    const orderB = b.box.renderOrder ?? b.index;
    return orderB - orderA;
  });
  return hits[0].box;
}

/** 矩形是否覆盖盒子中心（框选判定用未旋转中心，与 OpenFilm 的 shownBoxOf 一致）。 */
export function rectCoversBox(rect: Rect, box: HitBox): boolean {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

export function marqueeRect(start: Point, end: Point): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
}

export function isMarquee(rect: Rect): boolean {
  return rect.w >= MARQUEE_MIN_PX && rect.h >= MARQUEE_MIN_PX;
}

/* ------------------------------------------------------------------ S4 --- */

export interface PreviewPress {
  phase: "idle" | "press";
  start: Point;
  current: Point;
  additive: boolean;
  hitClipId: string | null;
}

export type PreviewPressEvent = {
  type: "down" | "move" | "up" | "cancel";
  x: number;
  y: number;
  additive?: boolean;
  /** down 时的命中（由 pickTopmostBox 现算）；空处 = null。 */
  hitClipId?: string | null;
};

export type PreviewPressOutcome =
  | { kind: "click"; clipId: string | null; additive: boolean }
  | { kind: "marquee"; rect: Rect; additive: boolean };

export interface PreviewPressResult {
  state: PreviewPress;
  /** 仅在 release 产生；取消/按下/移动都不产生选择动作。 */
  outcome: PreviewPressOutcome | null;
  /** 移动中且已达门槛时给出框（组件用 rAF 直写 DOM）。 */
  marquee: Rect | null;
}

export const IDLE_PRESS: PreviewPress = { phase: "idle", start: { x: 0, y: 0 }, current: { x: 0, y: 0 }, additive: false, hitClipId: null };

/** 空白按下 → rAF move → pointerup 状态机。click 与 marquee 一律在 release 判定；
 *  绝不在这里定位播放头（S4）。 */
export function reducePreviewPress(state: PreviewPress, event: PreviewPressEvent): PreviewPressResult {
  const point = { x: event.x, y: event.y };
  if (event.type === "cancel") return { state: IDLE_PRESS, outcome: null, marquee: null };
  if (event.type === "down") {
    return {
      state: { phase: "press", start: point, current: point, additive: Boolean(event.additive), hitClipId: event.hitClipId ?? null },
      outcome: null, marquee: null,
    };
  }
  if (state.phase !== "press") return { state, outcome: null, marquee: null };
  if (event.type === "move") {
    const next: PreviewPress = { ...state, current: point };
    const rect = marqueeRect(state.start, point);
    return { state: next, outcome: null, marquee: isMarquee(rect) ? rect : null };
  }
  const rect = marqueeRect(state.start, point);
  const additive = state.additive;
  return {
    state: IDLE_PRESS,
    outcome: isMarquee(rect)
      ? { kind: "marquee", rect, additive }
      : { kind: "click", clipId: state.hitClipId, additive },
    marquee: null,
  };
}

/** 由 release 结果解析最终选择：Shift/⌘ 加选；单击空处清选；框选可多选。 */
export function selectionFromOutcome<T extends HitBox>(
  outcome: PreviewPressOutcome,
  boxes: readonly T[],
  zRank: (box: T) => number,
  previous: readonly string[] = [],
): string[] {
  if (outcome.kind === "click") {
    if (outcome.clipId === null) return [];
    return outcome.additive ? [...previous, outcome.clipId] : [outcome.clipId];
  }
  const inside = boxes.filter(box => rectCoversBox(outcome.rect, box)).map(box => box.clipId);
  return outcome.additive ? [...previous, ...inside] : inside;
}

/* ------------------------------------------------------------------ S5 --- */

/** 手柄环的缩进：边长越小缩进越小，避免角/边命中带互相吞掉。 */
export const handleInset = (side: number): number => Math.min(8, side / 4);

/** 边条仅在该边长度 >=48px 时出现（14×4 / 4×14 白色圆角条）。 */
export function showEdgeMark(edge: EdgeDir, w: number, h: number): boolean {
  return (edge === "n" || edge === "s" ? w : h) >= 48;
}

/** 边命中带 8px：n/s 横向内缩 insetX、e/w 纵向内缩 insetY。 */
export function edgeHitRect(edge: EdgeDir, box: Rect): Rect {
  const hw = Math.max(box.w, HANDLE_BOX_MIN);
  const hh = Math.max(box.h, HANDLE_BOX_MIN);
  const insetX = handleInset(hw), insetY = handleInset(hh);
  const x = box.x + (box.w - hw) / 2;
  const y = box.y + (box.h - hh) / 2;
  if (edge === "n") return { x: x + insetX, y: y - 4, w: hw - 2 * insetX, h: 8 };
  if (edge === "s") return { x: x + insetX, y: y + hh - 4, w: hw - 2 * insetX, h: 8 };
  if (edge === "w") return { x: x - 4, y: y + insetY, w: 8, h: hh - 2 * insetY };
  return { x: x + hw - 4, y: y + insetY, w: 8, h: hh - 2 * insetY };
}

/** 角命中格 14×14（内部 8×8 白方由 CSS 画）。 */
export function cornerHitRect(corner: CornerDir, box: Rect): Rect {
  const hw = Math.max(box.w, HANDLE_BOX_MIN);
  const hh = Math.max(box.h, HANDLE_BOX_MIN);
  const x = box.x + (box.w - hw) / 2;
  const y = box.y + (box.h - hh) / 2;
  const left = corner.includes("w") ? x : x + hw;
  const top = corner.includes("n") ? y : y + hh;
  return { x: left - 7, y: top - 7, w: 14, h: 14 };
}

/** 四角外 20×20 隐形旋转格（不覆盖角缩放命中格）。 */
export function rotateCellRect(corner: CornerDir, box: Rect): Rect {
  const hw = Math.max(box.w, HANDLE_BOX_MIN);
  const hh = Math.max(box.h, HANDLE_BOX_MIN);
  const x = box.x + (box.w - hw) / 2;
  const y = box.y + (box.h - hh) / 2;
  const left = corner.includes("w") ? x - 27 : x + hw + 7;
  const top = corner.includes("n") ? y - 27 : y + hh + 7;
  return { x: left, y: top, w: 20, h: 20 };
}

export const CORNERS: readonly CornerDir[] = ["nw", "ne", "sw", "se"];
export const EDGES: readonly EdgeDir[] = ["n", "s", "w", "e"];

/** 15° 量化：一个手势内角度微抖不重算光标，也便于纯函数测试。 */
export const cursorBucket = (angleDeg: number): number => ((Math.round(angleDeg / 15) * 15) % 180 + 180) % 180;

const resizeCursorCache = new Map<number, string>();
/** 计算式缩放光标：0°=ew，90°=ns，45°=nwse，135°=nesw。 */
export function resizeCursor(angleDeg: number): string {
  const bucket = cursorBucket(angleDeg);
  const cached = resizeCursorCache.get(bucket);
  if (cached) return cached;
  const name = bucket <= 22 || bucket >= 158 ? "ew-resize"
    : bucket >= 68 && bucket <= 112 ? "ns-resize"
      : bucket < 90 ? "nwse-resize" : "nesw-resize";
  resizeCursorCache.set(bucket, name);
  return name;
}

const rotateCursorCache = new Map<number, string>();
/** 旋转光标（浏览器无内置弧形双箭头）：15° 缓存的 data-URL SVG。 */
export function rotateCursor(angleDeg: number): string {
  const bucket = cursorBucket(angleDeg);
  const cached = rotateCursorCache.get(bucket);
  if (cached) return cached;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
    + '<g transform="rotate(' + bucket + ' 12 12)" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round">'
    + '<path d="M5 14a7 7 0 0 0 12 3"/><path d="M19 10A7 7 0 0 0 7 7"/>'
    + '<path d="M17 14v3h-3" stroke="black"/><path d="M7 10V7h3" stroke="black"/></g></svg>';
  const value = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 12 12, grab';
  rotateCursorCache.set(bucket, value);
  return value;
}

/** 手势提示文本（OpenFilm：宽 × 高，单位 px；旋转时显示角度）。 */
export function gestureHintText(mode: "move" | "rotate" | "scale", geometry: { w: number; h: number; rotate: number }): string {
  return mode === "rotate" ? Math.round(geometry.rotate) + "°"
    : mode === "move" ? Math.round(geometry.w) + " × " + Math.round(geometry.h)
      : Math.round(geometry.w) + " × " + Math.round(geometry.h);
}
