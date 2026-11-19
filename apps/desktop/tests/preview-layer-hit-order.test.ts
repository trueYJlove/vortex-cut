import { describe, expect, it } from "vitest";
import { MARQUEE_MIN_PX, pickTopmostBox, rankForHit, rectCoversBox, zRankByTracks, type HitBox } from "../src/app/preview/stage-interaction.js";

const tracks = [{ id: "V2" }, { id: "V1" }]; // 0 = 最上层
const rank = (id: string) => zRankByTracks(tracks, id);

function box(clipId: string, trackId: string, x: number, y: number, w: number, h: number, rotate = 0): HitBox & { trackId: string } {
  return { clipId, trackId, x, y, w, h, rotate };
}

/** S3/S8：命中序与 Core layers 绘制序同源（zRank 取 tracks 数组索引）。 */
describe("layer hit order S3/S8", () => {
  it("zRank(top) < zRank(bottom)", () => {
    expect(rank("V2")).toBe(0);
    expect(rank("V1")).toBe(1);
    expect(rank("unknown")).toBe(2);
    expect(rank("V2")).toBeLessThan(rank("V1"));
  });

  it("重叠旋转盒返回 top_clip；反转 layers 插入序结果不变", () => {
    const bottom = box("bottom", "V1", 100, 100, 200, 100, 30);
    const top = box("top_clip", "V2", 100, 100, 200, 100, 30);
    const point = { x: 200, y: 150 };
    const z = (b: HitBox & { trackId: string }) => rank(b.trackId);
    expect(pickTopmostBox([bottom, top], point, z)?.clipId).toBe("top_clip");
    // 负向对照：文档/绘制顺序反转不得改变命中（Core layers 下层先画上层后画）。
    expect(pickTopmostBox([top, bottom].reverse(), point, z)?.clipId).toBe("top_clip");
  });

  it("翻转 clips 插入序后仍选中 V2（不得依赖 document.clips 顺序）", () => {
    const v1 = box("V1_clip", "V1", 100, 100, 200, 100);
    const v2 = box("V2_clip", "V2", 150, 120, 200, 100);
    const z = (b: HitBox & { trackId: string }) => rank(b.trackId);
    const drawOrder = rankForHit([v1, v2], (b) => -z(b));
    // draw order 下层先画 = V1 在前、V2 在后
    expect(drawOrder.map(b => b.clipId)).toEqual(["V1_clip", "V2_clip"]);
    expect(pickTopmostBox(drawOrder, { x: 180, y: 150 }, z)?.clipId).toBe("V2_clip");
    expect(pickTopmostBox([v2, v1], { x: 180, y: 150 }, z)?.clipId).toBe("V2_clip");
  });

  it("同 rank 小面积胜，再并列后绘制者胜", () => {
    const big = box("big", "V2", 0, 0, 200, 200);
    const small = box("small", "V2", 50, 50, 60, 60);
    const z = () => 0;
    expect(pickTopmostBox([big, small], { x: 80, y: 80 }, z)?.clipId).toBe("small");
    const later = { ...small, clipId: "later", renderOrder: 9 };
    expect(pickTopmostBox([big, small, later], { x: 80, y: 80 }, z)?.clipId).toBe("later");
  });

  it("insideFrame 90° 旋转盒命中（逆旋转指针）", () => {
    const rotated = box("r", "V1", 100, 100, 200, 100, 90);
    // 90° 旋转后纵向半高 = 100（逆旋转命中），横向半宽 = 50。
    expect(pickTopmostBox([rotated], { x: 200, y: 150 }, () => 0)?.clipId).toBe("r");
    expect(pickTopmostBox([rotated], { x: 200, y: 90 }, () => 0)?.clipId).toBe("r");
    expect(pickTopmostBox([rotated], { x: 200, y: 320 }, () => 0)?.clipId).toBeUndefined();
  });

  it("框选覆盖盒中心；7px 未达门槛 / 8px 达标", () => {
    const b = box("a", "V1", 0, 0, 100, 100);
    expect(rectCoversBox({ x: 0, y: 0, w: 8, h: 8 }, b)).toBe(false);
    expect(rectCoversBox({ x: 0, y: 0, w: 60, h: 60 }, b)).toBe(true);
    expect(MARQUEE_MIN_PX).toBe(8);
  });
});
