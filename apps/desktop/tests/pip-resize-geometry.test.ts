import { describe, expect, it } from "vitest";
import { PIP_SCALE_MAX, PIP_SCALE_MIN, pipResizeFromHandle } from "../src/app/pipResizeGeometry.js";

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
