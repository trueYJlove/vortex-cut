/** A04 Desktop 手势索引回归：clipId→overlay 引用表 + setPipGeometry 合并补丁。
 *  jsdom 无 worker/GL——直接构造 PreviewSession 实例（绕过 create 的 worker
 *  装配）验证 IR 就地补丁语义：索引重建（create/replaceIr）、单次遍历、
 *  未命中 clipId 静默、几何与旋转同时更新。 */
import { describe, expect, it, vi } from "vitest";
import { PreviewSession } from "../src/app/preview/preview-session.js";
import type { Ir, IrOverlay } from "../src/app/preview/ir.js";
import { fixturePreviewIr } from "./fixtures/preview-ir.js";

/** 带 overlay 的 IR：pip clip 覆盖帧 [50,150)，主轨 in_1 全程。 */
function irWithPip(): Ir {
  const ir = JSON.parse(JSON.stringify(fixturePreviewIr())) as Ir;
  ir.inputs.push({ ...ir.inputs[0]!, input_id: "in_2", asset_id: "asset_pip" });
  ir.segments.push({
    ...ir.segments[0]!,
    clip_id: "clip_pip",
    input_id: "in_2",
    timeline_start_us: 50 / 30 * 1e6,
    timeline_end_us: 150 / 30 * 1e6,
  });
  const overlay = (n: number): IrOverlay => ({
    clip_id: "clip_pip", input_id: "in_2", src_n: n, src_t_us: n / 30 * 1e6,
    box: { x: 100, y: 80, w: 200, h: 120 }, rotation_deg: 0, alpha: 1,
  });
  for (let n = 50; n < 150; n++) ir.frames[n]!.overlays = [overlay(n)];
  return ir;
}

/** 绕过 worker 装配的裸会话（反射访问私有构造/索引路径，规避交叉类型收窄）。 */
function bareSession(ir: Ir): PreviewSession {
  const SessionCtor = PreviewSession as unknown as new (ir: Ir) => PreviewSession;
  const session = new SessionCtor(ir);
  (session as unknown as { rebuildPipOverlayIndex: () => void }).rebuildPipOverlayIndex();
  return session;
}

/** 反射读会话的 IR（私有字段只读访问）。 */
function sessionIr(session: PreviewSession): Ir {
  return (session as unknown as { ir: Ir }).ir;
}

describe("A04 PiP 手势索引", () => {
  it("setPipGeometry：中心/尺寸/旋转一次补丁全部生效（单次遍历）", () => {
    const session = bareSession(irWithPip());
    session.setPipGeometry("clip_pip", { cx: 400, cy: 300, w: 300, h: 200, rotation: 45 });
    for (let n = 50; n < 150; n++) {
      const overlay = (sessionIr(session).frames[n]!.overlays[0]!)!;
      expect(overlay.box).toEqual({ x: 400 - 150, y: 300 - 100, w: 300, h: 200 });
      expect(overlay.rotation_deg).toBe(45);
    }
    // 窗口外帧不受影响（夹具共 150 帧：窗口 [50,150)，0 在窗外）
    expect(sessionIr(session).frames[0]!.overlays).toEqual([]);
    expect(sessionIr(session).frames[49]!.overlays).toEqual([]);
  });

  it("未命中 clipId 静默；rotation 缺省不动既有旋转", () => {
    const session = bareSession(irWithPip());
    expect(() => session.setPipGeometry("clip_absent", { cx: 0, cy: 0, w: 10, h: 10 })).not.toThrow();
    session.setPipBox("clip_pip", 400, 300, 300, 200);
    session.setPipGeometry("clip_pip", { cx: 500, cy: 400, w: 300, h: 200 }); // 无 rotation
    const overlay = sessionIr(session).frames[100]!.overlays[0]!;
    expect(overlay.rotation_deg).toBe(0); // 旋转未被清零
  });

  it("replaceIr 后索引原子重建：补丁作用于新 IR", () => {
    const session = bareSession(irWithPip());
    const nextIr = irWithPip();
    nextIr.frames[100]!.overlays[0]!.box = { x: 1, y: 2, w: 3, h: 4 };
    expect(session.replaceIr(nextIr)).toBe(true);
    session.setPipGeometry("clip_pip", { cx: 0, cy: 0, w: 8, h: 6, rotation: 10 });
    expect(nextIr.frames[100]!.overlays[0]!.box).toEqual({ x: -4, y: -3, w: 8, h: 6 });
    // 旧 IR 不被写（引用已切换）
    expect(sessionIr(session).frames[100]!.overlays[0]!.box).toEqual({ x: -4, y: -3, w: 8, h: 6 });
  });

  it("recomposeSoon 每 rAF 合帧：连续 setPipGeometry 只调度一次重呈现", () => {
    const session = bareSession(irWithPip());
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    session.setPipGeometry("clip_pip", { cx: 1, cy: 1, w: 10, h: 10, rotation: 1 });
    session.setPipGeometry("clip_pip", { cx: 2, cy: 2, w: 10, h: 10, rotation: 2 });
    session.setPipGeometry("clip_pip", { cx: 3, cy: 3, w: 10, h: 10, rotation: 3 });
    expect(rafSpy).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });
});
