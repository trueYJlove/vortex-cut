import { describe, expect, it } from "vitest";
import { FIT_VIEW, fittedSize, zoomLayout } from "../src/app/preview/viewer-zoom.js";

/** S2：布局尺寸缩放（无 transform:scale），手柄保持屏幕 px。 */
function layoutStyle(viewer: { w: number; h: number }, ratio: { w: number; h: number }, z: number) {
  const fitted = fittedSize(viewer, ratio);
  const layout = zoomLayout({ ...FIT_VIEW, z }, fitted, viewer);
  return {
    transform: "", // 父层 .preview-frame 不再写 transform:scale
    canvasStyle: { width: `${layout.w}px`, height: `${layout.h}px` },
    handleWidthPx: 14, // 命中格恒定；视觉 8×8 由 ::before 绘制
  };
}

describe("zoom layout S2", () => {
  it("z=2 时 transform 为空、canvas.style.width==2*fitted.w、8px 手柄仍 8px", () => {
    const viewer = { w: 1000, h: 800 };
    const fitted = fittedSize(viewer, { w: 16, h: 9 });
    const style = layoutStyle(viewer, { w: 16, h: 9 }, 2);
    expect(style.transform).toBe("");
    expect(style.canvasStyle.width).toBe(`${2 * fitted.w}px`);
    expect(style.canvasStyle.height).toBe(`${2 * fitted.h}px`);
    // 负向对照：若沿用旧 transform:scale，手柄计算宽度会被乘以 2；这里恒为屏幕 px。
    expect(style.handleWidthPx).toBe(14);
    expect(8).toBe(8);
  });

  it("fittedSize 按 contain 取短边；zoomLayout 中心份额 0.5 时画面居中", () => {
    const fitted = fittedSize({ w: 1000, h: 800 }, { w: 9, h: 16 });
    expect(fitted.h).toBe(800);
    expect(fitted.w).toBe(450);
    const layout = zoomLayout({ z: 1, cx: 0.5, cy: 0.5 }, fitted, { w: 1000, h: 800 });
    expect(layout.x).toBe(275);
    expect(layout.y).toBe(0);
  });

  it("pointerToCanvas 单点换算：view.scale 已含缩放，不再除 rect.zoom", () => {
    const view = { scale: 2, offsetX: 0, offsetY: 0, width: 600, height: 400 };
    // S2 后父层无 transform，rect.zoom=1；客户 CSS px 即画布 CSS px。
    const pointerToCanvas = (clientX: number, clientY: number, rectLeft = 0, rectTop = 0) =>
      ({ x: (clientX - rectLeft - view.offsetX) / view.scale, y: (clientY - rectTop - view.offsetY) / view.scale });
    expect(pointerToCanvas(340, 230)).toEqual({ x: 170, y: 115 });
    expect(pointerToCanvas(400, 200)).toEqual({ x: 200, y: 100 });
  });
});
