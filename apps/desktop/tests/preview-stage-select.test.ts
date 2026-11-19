import { describe, expect, it } from "vitest";
import { IDLE_PRESS, MARQUEE_MIN_PX, isMarquee, marqueeRect, reducePreviewPress, selectionFromOutcome, type HitBox } from "../src/app/preview/stage-interaction.js";

/** S4：空白按下 → rAF move → pointerup release 判定；绝不定位播放头。 */
const boxes: HitBox[] = [
  { clipId: "a", x: -10, y: -10, w: 20, h: 20 }, // center (0,0) inside 8×8 rect
  { clipId: "b", x: -2, y: -2, w: 20, h: 20 },  // center (8,8) on rect corner
  { clipId: "c", x: 500, y: 500, w: 40, h: 40 },
];
const rank = () => 0;

describe("preview stage select S4", () => {
  it("7×9 release = click（两轴同时 >=8px 才算框选）", () => {
    const down = reducePreviewPress(IDLE_PRESS, { type: "down", x: 10, y: 10, hitClipId: "top_clip" });
    const move = reducePreviewPress(down.state, { type: "move", x: 17, y: 19 });
    expect(move.marquee).toBeNull();
    expect(move.outcome).toBeNull(); // 负向对照：pointerdown+7px 不产生任何选择
    const up = reducePreviewPress(move.state, { type: "up", x: 17, y: 19 });
    expect(up.outcome).toEqual({ kind: "click", clipId: "top_clip", additive: false });
  });

  it("8×8 release 成框，选中 [a,b]", () => {
    const down = reducePreviewPress(IDLE_PRESS, { type: "down", x: 0, y: 0 });
    const move = reducePreviewPress(down.state, { type: "move", x: 8, y: 8 });
    expect(move.marquee).toEqual({ x: 0, y: 0, w: 8, h: 8 });
    const up = reducePreviewPress(move.state, { type: "up", x: 8, y: 8 });
    expect(up.outcome?.kind).toBe("marquee");
    if (up.outcome?.kind === "marquee") {
      expect(selectionFromOutcome(up.outcome, boxes, rank)).toEqual(["a", "b"]);
    }
  });

  it("8×7 / 7×8 都不成框（负向对照）", () => {
    expect(isMarquee(marqueeRect({ x: 0, y: 0 }, { x: 8, y: 7 }))).toBe(false);
    expect(isMarquee(marqueeRect({ x: 0, y: 0 }, { x: 7, y: 8 }))).toBe(false);
    expect(isMarquee(marqueeRect({ x: 0, y: 0 }, { x: 8, y: 8 }))).toBe(true);
    expect(MARQUEE_MIN_PX).toBe(8);
  });

  it("Shift/⌘ 加选；单击空处清选", () => {
    const down = reducePreviewPress(IDLE_PRESS, { type: "down", x: 0, y: 0, additive: true, hitClipId: "a" });
    const up = reducePreviewPress(down.state, { type: "up", x: 0, y: 0 });
    expect(up.outcome).toEqual({ kind: "click", clipId: "a", additive: true });
    if (up.outcome) expect(selectionFromOutcome(up.outcome, boxes, rank, ["b"])).toEqual(["b", "a"]);
    const blank = reducePreviewPress(reducePreviewPress(IDLE_PRESS, { type: "down", x: 900, y: 900, hitClipId: null }).state, { type: "up", x: 900, y: 900 });
    if (blank.outcome) expect(selectionFromOutcome(blank.outcome, boxes, rank, ["a"])).toEqual([]);
  });

  it("cancel 不产生选择；release 后状态回 idle", () => {
    const down = reducePreviewPress(IDLE_PRESS, { type: "down", x: 0, y: 0, hitClipId: "a" });
    const move = reducePreviewPress(down.state, { type: "move", x: 20, y: 20 });
    const cancel = reducePreviewPress(move.state, { type: "cancel", x: 20, y: 20 });
    expect(cancel.outcome).toBeNull();
    expect(cancel.marquee).toBeNull();
    expect(cancel.state.phase).toBe("idle");
  });

  it("release 判定不触碰播放头：状态机无 seek 字段", () => {
    const result = reducePreviewPress(IDLE_PRESS, { type: "down", x: 5, y: 5, hitClipId: "a" });
    expect(Object.keys(result)).not.toContain("seek");
    expect(Object.keys(result.state)).not.toContain("seek");
  });
});
