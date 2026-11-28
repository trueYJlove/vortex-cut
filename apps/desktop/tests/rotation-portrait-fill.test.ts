import { describe, expect, it } from "vitest";
import { needsTextureAxisSwap } from "../src/app/preview/preview-session.js";

describe("P206 竖拍旋转纹理采样轴交换判定（needsTextureAxisSwap）", () => {
  it("原片 coded 3840×2160 / display 2160×3840 需交换 UV 轴", () => {
    expect(needsTextureAxisSwap(
      { width: 3840, height: 2160, display_width: 2160, display_height: 3840 },
      false,
    )).toBe(true);
  });

  it("代理已将旋转烘焙进编码帧，有代理时不交换 UV 轴", () => {
    expect(needsTextureAxisSwap(
      { width: 3840, height: 2160, display_width: 2160, display_height: 3840 },
      true,
    )).toBe(false);
  });

  it("横拍素材 display 与 coded 一致时不交换", () => {
    expect(needsTextureAxisSwap(
      { width: 3840, height: 2160, display_width: 3840, display_height: 2160 },
      false,
    )).toBe(false);
  });

  it("正方形素材与缺少 display_* 的老 IR 均不交换", () => {
    expect(needsTextureAxisSwap(
      { width: 1080, height: 1080, display_width: 1080, display_height: 1080 },
      false,
    )).toBe(false);
    expect(needsTextureAxisSwap({ width: 3840, height: 2160 }, false)).toBe(false);
  });
});
