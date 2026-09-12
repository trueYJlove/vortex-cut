/** B17 时间轴二维可见区索引（viewport culling 的纯函数核心）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B17）：
 * - DOM 滚动空间保持全内容尺寸；Canvas backing 仅覆盖 viewport+overscan
 *   ——本模块只做"哪些元素可见"的判定，不改变几何计算本身。
 * - 区间索引按 track 检索可见 clip/caption：纵向按行 y 区间（行连续、
 *   行内 y 单调——线性扫行，行数 ≤ 轨道数，天然 O(行)）；横向按渲染
 *   rect x 交叠（rects 已是 useMemo 缓存的全量数组，O(n) 单趟精滤，
 *   draw 访问量随可见元素而非文档总量增长）。
 * - overscan 初值：水平 400 CSS px、纵向 2 轨（视口外缓冲——滚动时
 *   已画内容先于检索更新出现，减少白屏闪动）。
 * - 命中/框选不依赖本索引（hit-test 仍全量几何——"不能因为不画就丢
 *   文档元素"）；索引只服务绘制与派生请求（缩略图/波形/预热）。
 */

/** 水平 overscan（CSS px）。 */
export const OVERSCAN_X_PX = 400;
/** 纵向 overscan（轨）。 */
export const OVERSCAN_ROWS = 2;

export interface ViewportWindow {
  /** 视口左缘的文档 x（含 scrollX；不含 headerWidth——调用方传画布内坐标）。 */
  left: number;
  /** 视口右缘。 */
  right: number;
  /** 视口顶部的文档 y（含 scrollTop）。 */
  top: number;
  /** 视口底部。 */
  bottom: number;
}

export interface RowLike {
  y: number;
  height: number;
}

export interface RectLike {
  x: number;
  width: number;
  y: number;
  height: number;
}


/** 纵向可见行（含 overscan 行）：行连续排列——首个越界行即停止。
 * 返回 [fromIndex, toIndexExclusive)。空行集/零高视口 → 空。 */
export function visibleRowRange(rows: RowLike[], viewport: ViewportWindow): [number, number] {
  if (rows.length === 0) return [0, 0];
  // overscan 距离 = 2 轨 ≈ 用行高度均值近似（行高不一：按首行高估宽，
  // 宁多不少——保守可见比漏画安全）
  const overscanY = rows.length > 0
    ? OVERSCAN_ROWS * rows[0]!.height
    : 0;
  const top = viewport.top - overscanY;
  const bottom = viewport.bottom + overscanY;
  let from = -1;
  let to = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowBottom = row.y + row.height;
    if (from < 0 && rowBottom > top) from = i;
    if (row.y >= bottom) { to = i; break; }
  }
  if (from < 0) from = rows.length;
  if (to < from) to = from;
  return [from, to];
}

/** 水平可见判定（x 区间与视口交叠，含 overscan px）。 */
export function horizontallyVisible(rect: RectLike, viewport: ViewportWindow): boolean {
  return rect.x + rect.width >= viewport.left - OVERSCAN_X_PX
    && rect.x <= viewport.right + OVERSCAN_X_PX;
}

/** 矩形二维可见（纵 y 交叠 + 横 x 交叠，各自含 overscan）。 */
export function rectVisible(
  rect: RectLike,
  viewport: ViewportWindow,
  overscanYPx?: number,
): boolean {
  const overscanY = overscanYPx ?? OVERSCAN_ROWS * 64; // 行高未知时的兜底
  const yVisible = rect.y + rect.height >= viewport.top - overscanY
    && rect.y <= viewport.bottom + overscanY;
  return yVisible && horizontallyVisible(rect, viewport);
}

/**
 * 可见 rect 过滤（rects 已含 x/y/width/height 的渲染矩形——clipRects/
 * captionRects 通用）。O(n) 单趟（渲染矩形缓存后 n 与文档等长）。
 * overscanYPx 缺省用 2 轨 × 64px 兜底；调用方已知行高时传入精确值
 * （宁多不少——多画会被画布裁剪，漏画才是错误）。
 */
export function filterVisibleRects<T extends RectLike>(
  rects: T[],
  viewport: ViewportWindow,
  overscanYPx?: number,
): T[] {
  return rects.filter(rect => rectVisible(rect, viewport, overscanYPx));
}
