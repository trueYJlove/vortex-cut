/** C20a FrameSource 测试：v1 数组适配与 ir.frames 直访逐点等价
 *  （getFrame 引用稳定性——就地补丁语义依赖；越界 undefined；ensureRange
 *  立即完成；dispose 无操作——数组归 Ir 所有）。 */
import { describe, expect, it } from "vitest";
import { arrayFrameSource } from "../src/app/preview/frame-source.js";
import type { Ir, IrFrame } from "../src/app/preview/ir.js";

function makeIr(frameCount: number): Ir {
  const frames: IrFrame[] = Array.from({ length: frameCount }, (_, n) => ({
    n,
    t_us: n * 33_333,
    main: { kind: "black" },
    overlays: [],
    captions: [],
  }));
  return {
    schema: "preview-ir-v1",
    projector_version: 1,
    canvas: { width: 960, height: 540, fps: 30, duration_frames: frameCount, duration_us: frameCount * 33_333, background: "#000000" },
    inputs: [],
    segments: [],
    captions: [],
    caption_styles: {},
    transition_windows: [],
    known_approximations: [],
    frames,
  } as unknown as Ir;
}

describe("C20a arrayFrameSource（v1 等价适配）", () => {
  it("getFrame 与数组下标逐点一致（含引用身份——就地补丁语义）", () => {
    const ir = makeIr(300);
    const source = arrayFrameSource(ir);
    expect(source.frameCount).toBe(300);
    for (const n of [0, 1, 42, 149, 299]) {
      expect(source.getFrame(n)).toBe(ir.frames[n]); // 同一对象引用
    }
  });

  it("越界返回 undefined（与数组语义一致）", () => {
    const source = arrayFrameSource(makeIr(10));
    expect(source.getFrame(-1)).toBeUndefined();
    expect(source.getFrame(10)).toBeUndefined();
    expect(source.getFrame(9999)).toBeUndefined();
  });

  it("空帧表：frameCount=0，getFrame 恒 undefined", () => {
    const source = arrayFrameSource(makeIr(0));
    expect(source.frameCount).toBe(0);
    expect(source.getFrame(0)).toBeUndefined();
  });

  it("ensureRange 立即完成（v1 全量在场）；dispose 无操作不破坏数组", async () => {
    const ir = makeIr(5);
    const source = arrayFrameSource(ir);
    await expect(source.ensureRange!(0, 5)).resolves.toBeUndefined();
    source.dispose?.();
    expect(source.getFrame(2)).toBe(ir.frames[2]); // dispose 不影响数组所有权
  });

  it("帧对象就地修改经 source 可见（setPipGeometry 类手势路径的前提）", () => {
    const ir = makeIr(3);
    const source = arrayFrameSource(ir);
    const frame = source.getFrame(1)!;
    frame.captions = ["cap-1"];
    expect(source.getFrame(1)!.captions).toEqual(["cap-1"]);
    expect(ir.frames[1]!.captions).toEqual(["cap-1"]);
  });
});
