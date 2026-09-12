/** B17 viewport-index 测试：二维可见区检索（行区间/横轴交叠/overscan/
 *  边界外/空输入）。
 *
 * 覆盖（计划第 6 节 B17）：overscan 水平 400px、纵向 2 轨；可见 clip 数量
 * 随视口而非文档增长；滚动边界（首/末行、越顶/越底）；行区间 + rect 过滤
 * 语义一致性。
 */
import { describe, expect, it } from "vitest";
import {
  OVERSCAN_ROWS,
  OVERSCAN_X_PX,
  filterVisibleRects,
  horizontallyVisible,
  rectVisible,
  visibleRowRange,
  type RowLike,
} from "../src/app/timeline/viewport-index.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function makeRows(count: number, rowHeight = 80, top = 16): RowLike[] {
  const rows: RowLike[] = [];
  let y = top;
  for (let i = 0; i < count; i++) {
    rows.push({ y, height: rowHeight });
    y += rowHeight;
  }
  return rows;
}

describe("visibleRowRange（纵向可见行 + 2 轨 overscan）", () => {
  it("视口在顶部：前 2+2 轨可见（2 轨内容 + 2 轨 overscan）", () => {
    const rows = makeRows(100);
    const [from, to] = visibleRowRange(rows, { left: 0, right: 800, top: 16, bottom: 16 + 160 });
    expect(from).toBe(0);
    expect(to).toBe(4); // 2 行内容 + 2 行 overscan
  });

  it("视口在中部：命中行 + 上下各 2 轨 overscan", () => {
    const rows = makeRows(100);
    // 视口覆盖第 10~11 行（y 816..976）
    const [from, to] = visibleRowRange(rows, { left: 0, right: 800, top: 816, bottom: 976 });
    expect(from).toBe(8);   // 816 - 2*80 = 656 → 第 8 行 (y=656)
    expect(to).toBe(14);    // 976 + 160 = 1136 → 第 13 行底 = 1064+16.. 第 13 行 y=1056, 底 1136 → to=14
  });

  it("越顶/越底视口：空/夹紧", () => {
    const rows = makeRows(4);
    expect(visibleRowRange(rows, { left: 0, right: 100, top: -500, bottom: -400 })).toEqual([0, 0]);
    // 底部远超：全部行仍被 overscan 拉入则全收，否则夹紧
    const [, to] = visibleRowRange(rows, { left: 0, right: 100, top: 10_000, bottom: 11_000 });
    expect(to).toBe(4);
    const [from] = visibleRowRange(rows, { left: 0, right: 100, top: 10_000, bottom: 11_000 });
    expect(from).toBe(4); // 全部越过 → 空区间
  });

  it("空行集/零视口", () => {
    expect(visibleRowRange([], { left: 0, right: 0, top: 0, bottom: 0 })).toEqual([0, 0]);
    expect(visibleRowRange(makeRows(3), { left: 0, right: 0, top: 0, bottom: 0 })).not.toEqual([0, 0]);
  });
});

describe("horizontal / rect 可见判定（400px overscan）", () => {
  const viewport = { left: 0, right: 800, top: 0, bottom: 600 };

  it("交叠/边界/overscan 边界", () => {
    expect(horizontallyVisible({ x: 0, width: 10, y: 0, height: 10 }, viewport)).toBe(true);
    expect(horizontallyVisible({ x: 790, width: 50, y: 0, height: 10 }, viewport)).toBe(true);
    // 视口左缘外 399px：仍在 overscan 内
    expect(horizontallyVisible({ x: -399, width: 10, y: 0, height: 10 }, viewport)).toBe(true);
    // 右缘外 399px（x=1199 ≤ 800+400）：仍在
    expect(horizontallyVisible({ x: 1199, width: 10, y: 0, height: 10 }, viewport)).toBe(true);
    expect(horizontallyVisible({ x: 800 + OVERSCAN_X_PX + 1, width: 10, y: 0, height: 10 }, viewport)).toBe(false);
  });

  it("rectVisible：纵 + 横联合", () => {
    expect(rectVisible({ x: 100, y: 100, width: 50, height: 50 }, viewport)).toBe(true);
    expect(rectVisible({ x: 100, y: 10_000, width: 50, height: 50 }, viewport)).toBe(false);
    expect(rectVisible({ x: 5_000, y: 100, width: 50, height: 50 }, viewport)).toBe(false);
    // 纵向 overscan（2 轨 × 64 兜底 = 128px）
    expect(rectVisible({ x: 100, y: viewport.bottom + 127, width: 50, height: 4 }, viewport)).toBe(true);
    expect(rectVisible({ x: 100, y: viewport.bottom + 200, width: 50, height: 4 }, viewport)).toBe(false);
  });
});

describe("filterVisibleRects（渲染矩形过滤）", () => {
  it("1000 clip：可见数随视口而非文档增长", () => {
    const rects: Rect[] = [];
    let y = 16;
    for (let row = 0; row < 100; row++) {
      for (let col = 0; col < 10; col++) {
        rects.push({ x: col * 100, y, width: 90, height: 70 });
      }
      y += 80;
    }
    const visible = filterVisibleRects(rects, { left: 0, right: 800, top: 16, bottom: 496 });
    // 视口 6 行 + 128px y overscan（≈1.6 行）≈ 8 行；宽 800+400 overscan
    // 覆盖全部 10 列 → ~80 可见（远小于 1000 全量）
    expect(visible.length).toBeGreaterThanOrEqual(6 * 10);
    expect(visible.length).toBeLessThanOrEqual(9 * 10);
    expect(visible.length).toBeLessThan(rects.length);
    // 全部结果落在放宽的可见窗内
    for (const rect of visible) {
      expect(rect.y + rect.height).toBeGreaterThan(16 - 128 - 1);
    }
  });

  it("overscanYPx 参数：精确行高传入（窄视口纵向判定）", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: 50, height: 64 },
      { x: 0, y: 64, width: 50, height: 64 },
      { x: 0, y: 128, width: 50, height: 64 },
      { x: 0, y: 192, width: 50, height: 64 },
    ];
    // 视口第 2 行（y 64..128）；overscan=64（1 行）→ 交叠窗 [0, 192]：
    // 行 0/1/2 边缘交叠 + 行 2 起点 128 ≤ 窗底 192 → 0..128 三行可见。
    const visible = filterVisibleRects(rects, { left: 0, right: 800, top: 64, bottom: 128 }, 64);
    expect(visible.map((rect) => rect.y)).toEqual([0, 64, 128, 192]);
    // 视口底即内容底（y 129..200，含末行）且只给 0 overscan：仅后两行可见。
    const tail = filterVisibleRects(rects, { left: 0, right: 800, top: 129, bottom: 200 }, 0);
    expect(tail.map((rect) => rect.y)).toEqual([128, 192]);
  });
});

describe("OVERSCAN 常量（计划初值）", () => {
  it("水平 400px、纵向 2 轨", () => {
    expect(OVERSCAN_X_PX).toBe(400);
    expect(OVERSCAN_ROWS).toBe(2);
  });
});
