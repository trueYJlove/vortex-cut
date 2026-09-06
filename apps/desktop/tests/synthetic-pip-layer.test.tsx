/** 合成画布画中画手势层组件测试：选中 / 拖拽移动 / 8 向缩放手柄 / 旋转手柄。
 *  纯 props 组件（无会话依赖），live/commit 回调用 mock 断言。 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntheticPipLayer, type PipBoxItem } from "../src/app/preview/SyntheticPipLayer.js";

const BOX: PipBoxItem = {
  clipId: "clip_pip",
  x: 200, y: 150, w: 200, h: 100, // 左上角语义 → 中心 (300,200)，2:1 宽盒
  canvasW: 600, canvasH: 400,
  scale: 0.5,
  rotate: 0,
};

const VIEW = { scale: 1, offsetX: 0, offsetY: 0, width: 600, height: 400 };

function setup(overrides: Partial<Parameters<typeof SyntheticPipLayer>[0]> = {}) {
  const onLiveGeometry = vi.fn();
  const onCommitTransform = vi.fn();
  const onSelect = vi.fn();
  const onGestureStart = vi.fn(() => false);
  const onGestureEnd = vi.fn();
  const props = {
    boxes: [BOX], view: VIEW, selectedClipId: "clip_pip", locked: false,
    onSelect, onLiveGeometry, onCommitTransform, onGestureStart, onGestureEnd,
    ...overrides,
  };
  render(<SyntheticPipLayer {...props} />);
  return { onLiveGeometry, onCommitTransform, onSelect, onGestureStart, onGestureEnd };
}

afterEach(() => cleanup());

/** jsdom 无 PointerEvent（RTL 会退化为普通 Event、丢掉 clientX/Y）——
 *  用 MouseEvent 构造同名 pointer 事件（React 按事件类型分发，坐标可用）。 */
function firePointer(element: Element, type: "pointerdown" | "pointermove" | "pointerup", client: { clientX: number; clientY: number }): void {
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, ...client }));
}

describe("SyntheticPipLayer", () => {
  it("拖拽移动：live 增量回调 + 提交归一化中心点", () => {
    const h = setup();
    const box = screen.getByRole("button", { name: "画中画 clip_pip" });
    firePointer(box, "pointerdown", { clientX: 300, clientY: 200 });
    expect(h.onSelect).toHaveBeenCalledWith("clip_pip");
    expect(h.onGestureStart).toHaveBeenCalled();
    firePointer(box, "pointermove", { clientX: 340, clientY: 230 });
    expect(h.onLiveGeometry).toHaveBeenLastCalledWith("clip_pip", { cx: 340, cy: 230, w: 200, h: 100, rotate: 0 });
    firePointer(box, "pointerup", { clientX: 340, clientY: 230 });
    // 提交：中心 (340,230) → 归一化 (340/600, 230/400)；scale/rotate 保持原值。
    expect(h.onCommitTransform).toHaveBeenCalledWith("clip_pip", { x: 340 / 600, y: 230 / 400, scale: 0.5, rotate: 0 });
    expect(h.onGestureEnd).toHaveBeenCalledWith(false);
  });

  it("se 缩放手柄：对侧锚定 + 提交换算 scale（scale1 = scale0 × ratio）", () => {
    const h = setup();
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", { clientX: 400, clientY: 250 });
    // 外拉到 (500,350)：spanX=300/200=1.5，spanY=200/100=2 → ratio 2。
    firePointer(handle, "pointermove", { clientX: 500, clientY: 350 });
    expect(h.onLiveGeometry).toHaveBeenLastCalledWith("clip_pip", { cx: 400, cy: 250, w: 400, h: 200, rotate: 0 });
    firePointer(handle, "pointerup", { clientX: 500, clientY: 350 });
    expect(h.onCommitTransform).toHaveBeenCalledWith("clip_pip", { x: 400 / 600, y: 250 / 400, scale: 1, rotate: 0 }); // 0.5 × 2
  });

  it("旋转手柄：按指针方位角换算度数", () => {
    const h = setup();
    const knob = document.querySelector(".sp-rotate")!;
    // 手柄初始位于盒中心 (300,200) 正上方 26px（客户 CSS 空间）→ 方位角 ≈ -90°。
    firePointer(knob, "pointerdown", { clientX: 300, clientY: 174 });
    // 拖到正右方 (400,200)：方位角 0° → Δ=+90° → rotate 90。
    firePointer(knob, "pointermove", { clientX: 400, clientY: 200 });
    expect(h.onLiveGeometry).toHaveBeenLastCalledWith("clip_pip", expect.objectContaining({ rotate: 90 }));
    // 拖到正下方 (300,226) → 方位角 90° → Δ=180° → 归一化边界 ±180。
    firePointer(knob, "pointermove", { clientX: 300, clientY: 226 });
    const last = h.onLiveGeometry.mock.calls.at(-1)![1] as { rotate: number };
    expect(Math.abs(Math.abs(last.rotate) - 180)).toBeLessThan(1e-6);
    firePointer(knob, "pointerup", { clientX: 300, clientY: 226 });
    expect(h.onCommitTransform).toHaveBeenCalledWith("clip_pip", expect.objectContaining({ rotate: last.rotate, scale: 0.5 }));
  });

  it("手势期间盒子渲染跟随 live 几何（含旋转 transform）", () => {
    setup();
    const box = screen.getByRole("button", { name: "画中画 clip_pip" }) as HTMLElement;
    const knob = document.querySelector(".sp-rotate")!;
    firePointer(knob, "pointerdown", { clientX: 300, clientY: 174 });
    firePointer(knob, "pointermove", { clientX: 400, clientY: 200 });
    expect(box.style.transform).toContain("rotate(90deg)");
  });

  it("未选中盒子无手柄；locked 时手柄不渲染且手势不启动", () => {
    setup({ selectedClipId: null, locked: false });
    expect(document.querySelectorAll(".sp-handle").length).toBe(0);
    expect(document.querySelectorAll(".sp-rotate").length).toBe(0);
    cleanup();
    const h = setup({ locked: true });
    const box = screen.getByRole("button", { name: "画中画 clip_pip" });
    firePointer(box, "pointerdown", { clientX: 300, clientY: 200 });
    expect(h.onGestureStart).not.toHaveBeenCalled();
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("蒙版边界：拖动平移 x/y（片段画面归一化）", () => {
    const onDraftMask = vi.fn();
    const onCommitMask = vi.fn();
    setup({ boxes: [{ ...BOX, mask: { kind: "rect", x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }], onDraftMask, onCommitMask });
    const boundary = document.querySelector(".sp-mask")! as HTMLElement;
    // 盒子 200×100（画布 px），view.scale=1：蒙版中心 (300,200)。拖 20px → dx=0.1。
    firePointer(boundary, "pointerdown", { clientX: 300, clientY: 200 });
    firePointer(boundary, "pointermove", { clientX: 320, clientY: 180 });
    firePointer(boundary, "pointerup", { clientX: 320, clientY: 180 });
    expect(onDraftMask).toHaveBeenCalledWith("clip_pip", { kind: "rect", x: 0.6, y: 0.3, width: 0.5, height: 0.5 });
    expect(onCommitMask).toHaveBeenCalledWith("clip_pip", { kind: "rect", x: 0.6, y: 0.3, width: 0.5, height: 0.5 });
  });

  it("蒙版角点缩放：以蒙版中心为锚换算 width/height，保留其他字段", () => {
    const onDraftMask = vi.fn();
    const onCommitMask = vi.fn();
    setup({ boxes: [{ ...BOX, mask: { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0.2 } }], onDraftMask, onCommitMask });
    const knob = document.querySelector(".sp-mask-knob")! as HTMLElement;
    // 蒙版中心 (300,200)，角点初始在其右下；拖到 (350,200)：width = 2×50/200 = 0.5→…取 50/200×2=0.5？
    // width = |350−300|×2/200 = 0.5，height = |200−200|×2/100 = 0 → 钳到 0.02。
    firePointer(knob, "pointerdown", { clientX: 350, clientY: 250 });
    firePointer(knob, "pointermove", { clientX: 400, clientY: 200 });
    firePointer(knob, "pointerup", { clientX: 400, clientY: 200 });
    expect(onCommitMask).toHaveBeenCalledWith("clip_pip", { kind: "ellipse", x: 0.5, y: 0.5, width: 1, height: 0.02, feather: 0.2 });
  });

  it("蒙版提交走 mask 回调而非 transform 提交", () => {
    const onDraftMask = vi.fn();
    const onCommitMask = vi.fn();
    const h = setup({ boxes: [{ ...BOX, mask: { kind: "linear", y: 0.5 } }], onDraftMask, onCommitMask });
    const boundary = document.querySelector(".sp-mask")! as HTMLElement;
    firePointer(boundary, "pointerdown", { clientX: 300, clientY: 200 });
    firePointer(boundary, "pointermove", { clientX: 300, clientY: 220 });
    firePointer(boundary, "pointerup", { clientX: 300, clientY: 220 });
    expect(h.onCommitTransform).not.toHaveBeenCalled();
    expect(onCommitMask).toHaveBeenCalledWith("clip_pip", expect.objectContaining({ kind: "linear", y: 0.7 }));
  });
});
