import { describe, expect, it } from "vitest";
import { CORNERS, EDGES, FRAME_COLOR, GESTURE_HINT, HANDLE_BOX_MIN, cornerHitRect, cursorBucket, edgeHitRect, gestureHintText, handleInset, resizeCursor, rotateCellRect, rotateCursor, showEdgeMark } from "../src/app/preview/stage-interaction.js";

/** S5：手柄命中/光标/边条/四角旋转格。 */
describe("handle geometry S5", () => {
  it("常量与边条门槛 47=false / 48=true", () => {
    expect(HANDLE_BOX_MIN).toBe(28);
    expect(FRAME_COLOR).toBe("#0fa596");
    expect(showEdgeMark("n", 47, 100)).toBe(false);
    expect(showEdgeMark("n", 48, 100)).toBe(true);
    expect(showEdgeMark("e", 100, 47)).toBe(false);
    expect(showEdgeMark("e", 100, 48)).toBe(true);
    expect(handleInset(28)).toBe(7);
    expect(handleInset(100)).toBe(8);
    expect(GESTURE_HINT).toEqual({ dx: 14, dy: 16, background: "rgba(30,30,30,.92)", fontSizePx: 10.5 });
  });

  it("8px 边命中带与 14×14 角命中格", () => {
    const edge = edgeHitRect("n", { x: 0, y: 0, w: 100, h: 60 });
    expect(edge.h).toBe(8);
    expect(edge.y).toBe(-4);
    expect(edge.w).toBe(84); // inset = min(8, 100/4) 两侧
    const corner = cornerHitRect("nw", { x: 0, y: 0, w: 100, h: 60 });
    expect(corner).toEqual({ x: -7, y: -7, w: 14, h: 14 });
    // 小盒：手柄环至少 28×28，角格仍是 14×14
    const tiny = cornerHitRect("se", { x: 0, y: 0, w: 4, h: 4 });
    expect(tiny.w).toBe(14);
    expect(tiny.h).toBe(14);
  });

  it("四角外 20×20 旋转格且不与缩放格相交", () => {
    const w = 100, h = 60;
    for (const corner of CORNERS) {
      const cell = rotateCellRect(corner, { x: 0, y: 0, w, h });
      expect(cell.w).toBe(20);
      expect(cell.h).toBe(20);
      const hit = cornerHitRect(corner, { x: 0, y: 0, w, h });
      const overlap = cell.x < hit.x + hit.w && cell.x + cell.w > hit.x && cell.y < hit.y + hit.h && cell.y + cell.h > hit.y;
      expect(overlap).toBe(false);
    }
    expect(EDGES).toHaveLength(4);
  });

  it("computed cursors：15° 量化 + 四象限", () => {
    expect(resizeCursor(0)).toBe("ew-resize");
    expect(resizeCursor(90)).toBe("ns-resize");
    expect(resizeCursor(45)).toBe("nwse-resize");
    expect(resizeCursor(135)).toBe("nesw-resize");
    expect(cursorBucket(7)).toBe(0);
    expect(cursorBucket(23)).toBe(30);
    expect(rotateCursor(0)).toBe(rotateCursor(7)); // 15° 缓存同一桶
    expect(rotateCursor(0)).not.toBe(rotateCursor(90));
  });

  it("手势提示文本：宽 × 高 / 角度", () => {
    expect(gestureHintText("scale", { w: 400, h: 200, rotate: 0 })).toBe("400 × 200");
    expect(gestureHintText("rotate", { w: 400, h: 200, rotate: 45 })).toBe("45°");
  });
});
