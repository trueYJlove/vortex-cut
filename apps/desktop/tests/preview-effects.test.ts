import { describe, expect, it } from "vitest";
import { keyingAlpha, keyingColorRgb, maskAlpha, type IrEffectKeying, type IrEffectMask } from "../src/app/preview/effects.js";

/** 权威语义参考值（与 services/core/tests/unit/test_effects_reference.py 同参数
 *  网格逐点一致——双端同式即一致；阈值 1/255 对齐 8bit alpha 量化）。 */

describe("maskAlpha（镜像 ffmpeg._mask_alpha_expr）", () => {
  const PW = 336, PH = 188;

  it("ellipse：feather=0 真硬边——形状内 1、形状外 0，一步跳变（边界 d=1 形状外）", () => {
    const mask: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0 };
    // 中心与内部：全不透明
    expect(maskAlpha(mask, 0.5, 0.5, PW, PH)).toBe(1.0);
    expect(maskAlpha(mask, 0.625, 0.5, PW, PH)).toBe(1.0);  // d=0.5（旧公式此处 0.5——修正后硬边）
    // d<1 仍内部
    expect(maskAlpha(mask, 0.74, 0.5, PW, PH)).toBe(1.0);
    // 边界外（d≥1，与权威端 if(lt(d,1)) 一致）
    expect(maskAlpha(mask, 0.75, 0.5, PW, PH)).toBe(0.0);
    expect(maskAlpha(mask, 0.76, 0.5, PW, PH)).toBe(0.0);
    expect(maskAlpha(mask, 0.0, 0.0, PW, PH)).toBe(0.0);
  });

  it("ellipse feather 单调：0 硬边 < 0.1 窄羽化 < 1 全径渐变（用户观测的三档关系）", () => {
    // 采样点固定 d=0.95（过渡带敏感区）：f=0 → 1（硬边内部全实）；
    // f=0.1 → (1−0.95)/0.1 = 0.5（窄带中点）；f=1 → (1−0.95)/1 = 0.05（全径渐变近贴地）
    const base: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    const at = (feather: number) => maskAlpha({ ...base, feather }, 0.7375, 0.5, PW, PH); // d=0.95
    const a0 = at(0), a1 = at(0.1), a2 = at(1);
    expect(a0).toBe(1.0);
    expect(a1).toBeCloseTo(0.5, 3);
    expect(a2).toBeCloseTo(0.05, 3);
    expect(a0).toBeGreaterThan(a1);
    expect(a1).toBeGreaterThan(a2);
  });

  it("ellipse feather>0：过渡带收进边界内侧（[1−feather,1] 线性），边界恒 0 不外溢", () => {
    const mask: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0.5 };
    // d=0.5 < 1−feather=0.5 边界 → 内侧全实
    expect(maskAlpha(mask, 0.5, 0.5, PW, PH)).toBeCloseTo(1.0, 5);
    // d=0.75：过渡带中点 → 0.5
    expect(maskAlpha(mask, 0.6875, 0.5, PW, PH)).toBeCloseTo(0.5, 3);
    // 边界 d=1 → 0（不外溢）
    expect(maskAlpha(mask, 0.75, 0.5, PW, PH)).toBeCloseTo(0.0, 5);
    expect(maskAlpha(mask, 0.9, 0.5, PW, PH)).toBe(0.0);
  });

  it("rect：feather=0 真硬边（盒内 1、盒外 0）；feather>0 过渡带内收", () => {
    const hard: IrEffectMask = { kind: "rect", x: 0.5, y: 0.5, width: 0.5, height: 0.5, feather: 0 };
    expect(maskAlpha(hard, 0.5, 0.5, PW, PH)).toBe(1.0);
    expect(maskAlpha(hard, 0.6, 0.5, PW, PH)).toBe(1.0);    // norm=0.4（旧公式此处 0.6——修正后硬边）
    expect(maskAlpha(hard, 0.74, 0.5, PW, PH)).toBe(1.0);   // 边界内
    expect(maskAlpha(hard, 0.75, 0.5, PW, PH)).toBe(0.0);   // 边界（norm=1 形状外，与权威端 if(lt(norm,1)) 一致）
    expect(maskAlpha(hard, 0.9, 0.5, PW, PH)).toBe(0.0);
    // feather=0.5：norm∈[0.5,1] 线性；norm=0.75 → (1−0.75)/0.5 = 0.5
    const soft: IrEffectMask = { ...hard, feather: 0.5 };
    expect(maskAlpha(soft, 0.5, 0.5, PW, PH)).toBeCloseTo(1.0, 5);
    expect(maskAlpha(soft, 0.6875, 0.5, PW, PH)).toBeCloseTo(0.5, 3);
    expect(maskAlpha(soft, 0.75, 0.5, PW, PH)).toBeCloseTo(0.0, 5);
  });

  it("linear：分界线过中心，feather·pw 为软边带宽（中心恒 0.5）", () => {
    const mask: IrEffectMask = { kind: "linear", x: 0.5, y: 0.5, rotation: 0, feather: 0.1 };
    expect(maskAlpha(mask, 0.5, 0.5, PW, PH)).toBeCloseTo(0.5, 5);
    // ux = +0.1·pw 处 → 0.5+1 = 1.5 → clamp 1
    expect(maskAlpha(mask, 0.6, 0.5, PW, PH)).toBeCloseTo(1.0, 5);
    // ux = −0.1·pw 处 → 0.5−1 = −0.5 → clamp 0
    expect(maskAlpha(mask, 0.4, 0.5, PW, PH)).toBeCloseTo(0.0, 5);
  });

  it("invert：alpha 反转（蒙版 invert 权威端 geq 消费）", () => {
    const mask: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5, invert: true };
    expect(maskAlpha(mask, 0.5, 0.5, PW, PH)).toBeCloseTo(0.0, 5);
    expect(maskAlpha(mask, 0.9, 0.9, PW, PH)).toBeCloseTo(1.0, 5);
  });

  it("rotation：90° 蒙版方向生效（椭圆长轴随旋转；feather=0 硬边值域）", () => {
    const unrotated: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.8, height: 0.2 };
    const rotated: IrEffectMask = { ...unrotated, rotation: 90 };
    // 点 (0.65, 0.5)：未旋转时长轴内（ux=50.4px < halW=134.4px → d=0.375 → 硬边全 1）；
    // 旋转 90° 后该点落在短轴方向（|uy|=50.4px > halH=18.8px → d=2.68 → 0）
    const a1 = maskAlpha(unrotated, 0.65, 0.5, PW, PH);
    const a2 = maskAlpha(rotated, 0.65, 0.5, PW, PH);
    expect(a1).toBe(1.0);
    expect(a2).toBe(0.0);
  });

  it("缺省值：x/y=0.5、width/height=0.5、rotation=0、feather=0（硬边）", () => {
    const bare: IrEffectMask = { kind: "ellipse" };
    const full: IrEffectMask = { kind: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0 };
    for (const [nx, ny] of [[0.3, 0.4], [0.5, 0.5], [0.7, 0.8]]) {
      expect(maskAlpha(bare, nx, ny, PW, PH)).toBeCloseTo(maskAlpha(full, nx, ny, PW, PH), 6);
    }
  });
});

describe("keyingAlpha（镜像 ffmpeg colorkey+alphaextract）", () => {
  const keying: IrEffectKeying = { color: "00FF00", similarity: 0.3, blend: 0.1 };

  it("键色处全透明", () => {
    expect(keyingAlpha(keying, 0, 1, 0)).toBe(0.0);
  });

  it("远离键色不透明", () => {
    expect(keyingAlpha(keying, 1, 0, 0)).toBe(1.0);
    expect(keyingAlpha(keying, 0, 0, 1)).toBe(1.0);
  });

  it("过渡带线性（similarity..similarity+blend）", () => {
    // 手算：dist((0,0.85,0),(0,1,0)) = 0.15/√3 ≈ 0.0866 < 0.3 → 0
    expect(keyingAlpha(keying, 0, 0.85, 0)).toBe(0.0);
    // 边界外 dist ≥ 0.4 → 1
    expect(keyingAlpha(keying, 0.4, 0, 0)).toBe(1.0); // dist=√(0.16+1+1)/√3≈1.046>0.4
  });

  it("缺省值：color=00FF00、similarity=0.3、blend=0.1", () => {
    const bare: IrEffectKeying = {};
    const full: IrEffectKeying = { color: "00FF00", similarity: 0.3, blend: 0.1 };
    for (const [r, g, b] of [[0, 1, 0], [1, 0, 0], [0.2, 0.9, 0.1]]) {
      expect(keyingAlpha(bare, r, g, b)).toBeCloseTo(keyingAlpha(full, r, g, b), 6);
    }
  });

  it("keyingColorRgb：hex → 归一化 RGB；非法值回绿幕", () => {
    expect(keyingColorRgb({ color: "FF0000" })).toEqual([1, 0, 0]);
    expect(keyingColorRgb({ color: "zzzzzz" })).toEqual([0, 1, 0]);
    expect(keyingColorRgb({})).toEqual([0, 1, 0]);
  });
});
