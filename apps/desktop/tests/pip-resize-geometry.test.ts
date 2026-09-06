import { describe, expect, it } from "vitest";
import { PIP_SCALE_MAX, PIP_SCALE_MIN, boxResizeFromHandle, pipResizeFromHandle } from "../src/app/pipResizeGeometry.js";

/**
 * P1 画中画：手柄缩放几何（中心点语义 + 对侧锚定）。
 *
 * 基准盒子：画布 500×400，start = {x:0.6, y:0.5, scale:0.4}
 * → 尺寸 200×160，左上角 (200,120)，右下角 (400,280)，中心 (300,200)。
 */
const START = { x: 0.6, y: 0.5, scale: 0.4 };
const CW = 500;
const CH = 400;

describe("pipResizeFromHandle", () => {
  it("se 手柄外拉放大，左上角锚定不动", () => {
    // 指针 (400,360)：spanX=200/500=0.4，spanY=240/400=0.6 → 取大者 0.6。
    const r = pipResizeFromHandle("se", { x: 400, y: 360 }, START, CW, CH);
    expect(r.scale).toBeCloseTo(0.6);
    // 中心 = 锚点(200,120) + 新尺寸一半。
    expect(r.x).toBeCloseTo(0.7); // (200 + 0.6*500/2) / 500
    expect(r.y).toBeCloseTo(0.6); // (120 + 0.6*400/2) / 400
  });

  it("se 手柄内拉到锚点附近缩小，钳到最小缩放", () => {
    const r = pipResizeFromHandle("se", { x: 202, y: 122 }, START, CW, CH);
    expect(r.scale).toBe(PIP_SCALE_MIN);
    expect(r.x).toBeCloseTo(0.425); // 200 + 0.05*500/2 = 212.5
    expect(r.y).toBeCloseTo(0.325); // 120 + 0.05*400/2 = 130
  });

  it("nw 手柄以右下角为锚，向锚点拖动缩小", () => {
    const r = pipResizeFromHandle("nw", { x: 350, y: 230 }, START, CW, CH);
    expect(r.scale).toBeCloseTo(0.125); // max(50/500, 50/400)
    // 盒子向左上生长：右缘/下缘仍钉在锚点 (400,280)。
    expect(r.x).toBeCloseTo(0.7375); // 400 − 0.125*500/2 = 368.75
    expect(r.y).toBeCloseTo(0.6375); // 280 − 0.125*400/2 = 255
  });

  it("e 手柄只改水平：锚定左缘，y 中心不变", () => {
    const r = pipResizeFromHandle("e", { x: 450, y: 9999 }, START, CW, CH);
    expect(r.scale).toBeCloseTo(0.5); // (450−200)/500
    expect(r.x).toBeCloseTo(0.65); // 200 + 0.5*500/2 = 325
    expect(r.y).toBeCloseTo(0.5);
  });

  it("n 手柄只改垂直：锚定下缘，x 中心不变", () => {
    const r = pipResizeFromHandle("n", { x: -9999, y: 180 }, START, CW, CH);
    expect(r.scale).toBeCloseTo(0.25); // (280−180)/400
    expect(r.x).toBeCloseTo(0.6);
    expect(r.y).toBeCloseTo(0.575); // 280 − 0.25*400/2 = 230
  });

  it("结果钳制在 0..1 与缩放范围内", () => {
    const big = pipResizeFromHandle("se", { x: 5000, y: 5000 }, START, CW, CH);
    expect(big.scale).toBe(PIP_SCALE_MAX);
    expect(big.x).toBeLessThanOrEqual(1);
    expect(big.y).toBeLessThanOrEqual(1);
    const tiny = pipResizeFromHandle("nw", { x: 400, y: 280 }, START, CW, CH);
    expect(tiny.scale).toBe(PIP_SCALE_MIN);
    expect(tiny.x).toBeGreaterThanOrEqual(0);
    expect(tiny.y).toBeGreaterThanOrEqual(0);
  });
});

/**
 * boxResizeFromHandle（合成层变体）：任意宽高比像素盒（中心点语义）。
 * 基准盒子：start = {cx:300, cy:200, w:200, h:100}（2:1 宽盒）
 * → 左上角 (200,150)，右下角 (400,250)。
 */
const RECT_START = { cx: 300, cy: 200, w: 200, h: 100 };

describe("boxResizeFromHandle", () => {
  it("se 手柄外拉放大，左上角锚定不动，宽高比锁定", () => {
    // 指针 (500,350)：spanX=300/200=1.5，spanY=200/100=2.0 → 取大者 2.0。
    const r = boxResizeFromHandle("se", { x: 500, y: 350 }, RECT_START, PIP_SCALE_MIN, PIP_SCALE_MAX);
    expect(r.ratio).toBeCloseTo(2);
    expect(r.w).toBeCloseTo(400);
    expect(r.h).toBeCloseTo(200);
    // 中心 = 锚点(200,150) + 新尺寸一半；锚点保持不动。
    expect(r.cx).toBeCloseTo(400); // 200 + 400/2
    expect(r.cy).toBeCloseTo(250); // 150 + 200/2
  });

  it("越过锚点向另一侧镜像翻转", () => {
    // 指针越过左上锚点 (200,150) 到 (100,50)：
    // spanX=100/200=0.5，spanY=100/100=1.0 → ratio 1.0，side 全为负 → 向左上生长。
    const r = boxResizeFromHandle("se", { x: 100, y: 50 }, RECT_START, PIP_SCALE_MIN, PIP_SCALE_MAX);
    expect(r.ratio).toBeCloseTo(1);
    expect(r.cx).toBeCloseTo(100); // 200 − 200/2
    expect(r.cy).toBeCloseTo(100); // 150 − 100/2
  });

  it("e 手柄只由水平轴驱动，垂直中心不变", () => {
    const r = boxResizeFromHandle("e", { x: 450, y: 99999 }, RECT_START, PIP_SCALE_MIN, PIP_SCALE_MAX);
    expect(r.ratio).toBeCloseTo(1.25); // (450−200)/200
    expect(r.w).toBeCloseTo(250);
    expect(r.h).toBeCloseTo(125); // 宽高比锁定
    expect(r.cy).toBeCloseTo(200);
    expect(r.cx).toBeCloseTo(325); // 200 + 250/2
  });

  it("n 手柄锚定下缘：由垂直距离换算统一比例", () => {
    const r = boxResizeFromHandle("n", { x: -99999, y: 100 }, RECT_START, PIP_SCALE_MIN, PIP_SCALE_MAX);
    expect(r.ratio).toBeCloseTo(1.5); // (250−100)/100
    expect(r.h).toBeCloseTo(150);
    expect(r.w).toBeCloseTo(300);
    expect(r.cx).toBeCloseTo(300);
    expect(r.cy).toBeCloseTo(175); // 250 − 150/2
  });

  it("ratio 钳制在调用方换算的界限内", () => {
    const big = boxResizeFromHandle("se", { x: 99999, y: 99999 }, RECT_START, 0.1, 2);
    expect(big.ratio).toBe(2);
    // 指针几乎贴住 nw 的锚点（右下角 400,250）→ ratio 触底钳到 minRatio。
    const tiny = boxResizeFromHandle("nw", { x: 401, y: 251 }, RECT_START, 0.1, 2);
    expect(tiny.ratio).toBe(0.1);
    expect(tiny.w).toBeCloseTo(20);
    expect(tiny.h).toBeCloseTo(10);
  });
});
