/**
 * P1 画中画（PIP）：画布手柄缩放的纯几何计算。
 *
 * 坐标语义与渲染管线的中心点定案一致：transform.x/y 是 PIP 盒子**中心点**的
 * 归一化位置（0..1），scale 统一缩放（宽高按画布比例锁定）。手柄缩放以被拖
 * 方向的**对边/对角为锚点**：指针内拉缩小、外拉放大；越过锚点时盒子向另一侧
 * 镜像翻转（与常规编辑器一致）。位置结果钳制到 0..1，缩放钳制到
 * [PIP_SCALE_MIN, PIP_SCALE_MAX]。
 */

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type HandleDir = (typeof HANDLES)[number];

/**
 * 缩放手柄的锚定几何：ax/ay 是「保持不动的锚边」位于初始盒子的哪条边
 * （null = 该轴不参与缩放，中心保持不变）。
 */
const RESIZE_GEOM: Record<HandleDir, { ax: "left" | "right" | null; ay: "top" | "bottom" | null }> = {
  nw: { ax: "right", ay: "bottom" },
  n: { ax: null, ay: "bottom" },
  ne: { ax: "left", ay: "bottom" },
  e: { ax: "left", ay: null },
  se: { ax: "left", ay: "top" },
  s: { ax: null, ay: "top" },
  sw: { ax: "right", ay: "top" },
  w: { ax: "right", ay: null },
};

export const PIP_SCALE_MIN = 0.05;
export const PIP_SCALE_MAX = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type PipBox = { x: number; y: number; scale: number };

/**
 * 由手柄方向 + 指针位置计算缩放后的盒子（中心点语义）。
 *
 * @param dir     被拖拽的手柄方向
 * @param pointer 指针位置（与 start 同一坐标系，如画布客户区像素）
 * @param start   手势起点时的盒子（中心点语义）
 * @param canvasW canvasW 画布尺寸（像素）
 */
export function pipResizeFromHandle(
  dir: HandleDir,
  pointer: { x: number; y: number },
  start: PipBox,
  canvasW: number,
  canvasH: number,
): PipBox {
  const cw = Math.max(1, canvasW);
  const ch = Math.max(1, canvasH);
  const w0 = start.scale * cw;
  const h0 = start.scale * ch;
  const left0 = start.x * cw - w0 / 2;
  const top0 = start.y * ch - h0 / 2;
  const geom = RESIZE_GEOM[dir];
  const anchorX = geom.ax === "left" ? left0 : geom.ax === "right" ? left0 + w0 : null;
  const anchorY = geom.ay === "top" ? top0 : geom.ay === "bottom" ? top0 + h0 : null;
  let scale: number;
  if (anchorX !== null && anchorY !== null) {
    // 角手柄：统一缩放比取两轴中「指针到锚点」更远的那个。
    scale = Math.max(Math.abs(pointer.x - anchorX) / cw, Math.abs(pointer.y - anchorY) / ch);
  } else if (anchorX !== null) {
    scale = Math.abs(pointer.x - anchorX) / cw;
  } else if (anchorY !== null) {
    scale = Math.abs(pointer.y - anchorY) / ch;
  } else {
    scale = start.scale;
  }
  scale = clamp(scale, PIP_SCALE_MIN, PIP_SCALE_MAX);
  const w1 = scale * cw;
  const h1 = scale * ch;
  // 盒子从锚点向「指针所在侧」生长：锚点在盒子左/上缘时正常向右/下生长，
  // 指针越过锚点则翻到另一侧（side 取指针相对锚点的符号，两向自动成立）。
  // 自由轴（anchor 为 null）中心保持不变。
  const sideX = anchorX !== null ? (pointer.x >= anchorX ? 1 : -1) : 0;
  const sideY = anchorY !== null ? (pointer.y >= anchorY ? 1 : -1) : 0;
  const cx = anchorX !== null ? anchorX + (sideX * w1) / 2 : start.x * cw;
  const cy = anchorY !== null ? anchorY + (sideY * h1) / 2 : start.y * ch;
  return { x: clamp(cx / cw, 0, 1), y: clamp(cy / ch, 0, 1), scale };
}

export type PipRectPx = { cx: number; cy: number; w: number; h: number };

/**
 * 画布手柄缩放（合成层变体）：作用于**任意宽高比**的像素盒（IR 覆盖段几何，
 * 画布像素空间、中心点语义），而非 pipResizeFromHandle 假定的「scale × 画布」
 * 等比盒。锚定语义相同：被拖方向的对边/对角保持不动，内拉缩小、外拉放大，
 * 越过锚点镜像翻转到另一侧；角/边手柄均输出**统一缩放**（宽高比锁定，与
 * transform.scale 语义一致——单轴手柄取该轴距离换算比例）。
 *
 * @param dir           被拖拽的手柄方向
 * @param pointer       指针位置（画布像素，与 start 同一空间）
 * @param start         手势起点时的盒子（画布像素，中心点语义）
 * @param minRatio/maxRatio 统一缩放比界限（调用方由 PIP_SCALE_MIN/MAX ÷ 起始 scale 换算）
 * @returns 新盒子（画布像素）+ 相对起始盒的统一缩放比 ratio（提交时 scale1 = scale0 × ratio）
 */
export function boxResizeFromHandle(
  dir: HandleDir,
  pointer: { x: number; y: number },
  start: PipRectPx,
  minRatio: number,
  maxRatio: number,
): { cx: number; cy: number; w: number; h: number; ratio: number } {
  const w0 = Math.max(1, start.w);
  const h0 = Math.max(1, start.h);
  const left0 = start.cx - w0 / 2;
  const top0 = start.cy - h0 / 2;
  const geom = RESIZE_GEOM[dir];
  const anchorX = geom.ax === "left" ? left0 : geom.ax === "right" ? left0 + w0 : null;
  const anchorY = geom.ay === "top" ? top0 : geom.ay === "bottom" ? top0 + h0 : null;
  let ratio: number;
  if (anchorX !== null && anchorY !== null) {
    // 角手柄：两轴各自「指针到锚点 / 初始边长」，取更远（拖动量更大）的轴。
    ratio = Math.max(Math.abs(pointer.x - anchorX) / w0, Math.abs(pointer.y - anchorY) / h0);
  } else if (anchorX !== null) {
    ratio = Math.abs(pointer.x - anchorX) / w0;
  } else if (anchorY !== null) {
    ratio = Math.abs(pointer.y - anchorY) / h0;
  } else {
    ratio = 1;
  }
  ratio = clamp(ratio, minRatio, maxRatio);
  const w1 = w0 * ratio;
  const h1 = h0 * ratio;
  const sideX = anchorX !== null ? (pointer.x >= anchorX ? 1 : -1) : 0;
  const sideY = anchorY !== null ? (pointer.y >= anchorY ? 1 : -1) : 0;
  const cx = anchorX !== null ? anchorX + (sideX * w1) / 2 : start.cx;
  const cy = anchorY !== null ? anchorY + (sideY * h1) / 2 : start.cy;
  return { cx, cy, w: w1, h: h1, ratio };
}
