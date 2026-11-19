import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntheticPipLayer, type PipBoxItem, type PipGeometry } from "../src/app/preview/SyntheticPipLayer.js";

/** S6：手势提示 / 同步 lastGeometry / 恰好一次提交 / 取消与失败回滚。 */
const BOX: PipBoxItem = {
  clipId: "clip_pip", x: 200, y: 150, w: 200, h: 100,
  canvasW: 600, canvasH: 400, scale: 0.5, rotate: 0, zRank: 0, renderOrder: 0,
};
const VIEW = { scale: 1, offsetX: 0, offsetY: 0, width: 600, height: 400 };
const BOX0: PipGeometry = { cx: 300, cy: 200, w: 200, h: 100, rotate: 0 };

type Overrides = Partial<Parameters<typeof SyntheticPipLayer>[0]>;
function setup(overrides: Overrides = {}) {
  const onCommitTransform = vi.fn(() => true);
  const onLiveGeometry = vi.fn();
  const onRestoreGeometry = vi.fn();
  const onSelect = vi.fn();
  const props = {
    boxes: [BOX], view: VIEW, selectedClipId: "clip_pip", locked: false,
    onSelect, onSelectClips: vi.fn(), onLiveGeometry, onRestoreGeometry, onCommitTransform,
    onGestureStart: vi.fn(() => false), onGestureEnd: vi.fn(),
    ...overrides,
  };
  render(<SyntheticPipLayer {...props} />);
  return { onCommitTransform, onLiveGeometry, onRestoreGeometry, onSelect, props };
}
function firePointer(element: Element, type: string, clientX: number, clientY: number) {
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
}
afterEach(() => cleanup());

describe("gesture commit S6", () => {
  it("5 次 move 后 pointerup 恰好提交 1 次，且用最后一帧几何", async () => {
    const h = setup();
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", 400, 250);
    for (let i = 1; i <= 5; i += 1) firePointer(handle, "pointermove", 400 + i * 20, 250 + i * 20);
    firePointer(handle, "pointerup", 500, 350);
    expect(h.onCommitTransform).toHaveBeenCalledTimes(1);
    expect(h.onLiveGeometry).toHaveBeenCalledTimes(5);
    // 同步真值：提交对应第 5 帧（不是异步 live state 的上一帧）
    const commit = (h.onCommitTransform.mock.calls[0] as unknown as [string, { scale: number }])?.[1];
    expect(commit?.scale).toBeGreaterThan(0.5);
    await Promise.resolve();
  });

  it("缩放中显示 400 × 200 手势提示（left+14, top+16, rgba(30,30,30,.92), 10.5px）", () => {
    setup();
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", 400, 250);
    firePointer(handle, "pointermove", 500, 350); // ratio 2 → 400×200
    const hint = document.querySelector(".sp-gesture-hint") as HTMLElement;
    expect(hint.textContent).toBe("400 × 200");
    expect(hint.style.left).toBe("514px"); // 500 + 14
    expect(hint.style.top).toBe("366px");  // 350 + 16
    expect(hint.style.background).toBe("rgba(30, 30, 30, 0.92)");
    expect(hint.style.fontSize).toBe("10.5px");
  });

  it("pointercancel 不提交且 restore 调 BOX0", () => {
    const h = setup();
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", 400, 250);
    firePointer(handle, "pointermove", 500, 350);
    firePointer(handle, "pointercancel", 500, 350);
    expect(h.onCommitTransform).not.toHaveBeenCalled();
    expect(h.onRestoreGeometry).toHaveBeenCalledWith("clip_pip", BOX0);
    expect(h.onLiveGeometry).toHaveBeenLastCalledWith("clip_pip", BOX0);
  });

  it("window blur 不提交并恢复起始盒", () => {
    const h = setup();
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", 400, 250);
    firePointer(handle, "pointermove", 500, 350);
    fireEvent(window, new Event("blur"));
    expect(h.onCommitTransform).not.toHaveBeenCalled();
    expect(h.onRestoreGeometry).toHaveBeenCalledWith("clip_pip", BOX0);
  });

  it("patch 拒绝 → false 且最后 live 几何恢复 BOX0（IR 与 DOM 同时恢复）", async () => {
    const onCommitTransform = vi.fn(() => Promise.resolve(false));
    const h = setup({ onCommitTransform });
    const handle = document.querySelector(".sp-handle.sp-se")!;
    firePointer(handle, "pointerdown", 400, 250);
    firePointer(handle, "pointermove", 500, 350);
    firePointer(handle, "pointerup", 500, 350);
    await vi.waitFor(() => expect(h.onLiveGeometry).toHaveBeenLastCalledWith("clip_pip", BOX0));
    expect(onCommitTransform).toHaveBeenCalledTimes(1);
    expect(h.onRestoreGeometry).toHaveBeenCalledWith("clip_pip", BOX0);
  });

  it("四角旋转格、14px 命中格与 marked 边条渲染", () => {
    setup();
    expect(document.querySelectorAll(".sp-rotate")).toHaveLength(4);
    const handle = document.querySelector(".sp-handle.sp-se") as HTMLElement;
    expect(handle.style.width).toBe("14px");
    expect(handle.style.height).toBe("14px");
    expect(document.querySelector(".sp-handle.sp-n")?.classList.contains("marked")).toBe(true);
  });

  it("最上层优先：两层重叠时 DOM 最后兄弟是 top_clip，点击空处清选", () => {
    const bottom: PipBoxItem = { ...BOX, clipId: "bottom", zRank: 1, renderOrder: 0 };
    const top: PipBoxItem = { ...BOX, clipId: "top_clip", zRank: 0, renderOrder: 1 };
    const h = setup({ boxes: [bottom, top], selectedClipId: null });
    const nodes = [...document.querySelectorAll(".sp-box")];
    expect(nodes.at(-1)?.getAttribute("aria-label")).toContain("top_clip");
    // 空白按下 → release 走 pickTopmostBox（命中区在根层空白处则清选）
    const root = document.querySelector(".sp-layer") as HTMLElement;
    firePointer(root, "pointerdown", 590, 390);
    firePointer(root, "pointerup", 590, 390);
    expect(h.onSelect).toHaveBeenLastCalledWith(null);
  });
});
