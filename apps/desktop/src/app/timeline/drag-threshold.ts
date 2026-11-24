/**
 * OpenFilm's timeline drag lift rules (timeline-drag.ts: dragLifted).
 * A block move needs a 5px change on either axis; edge edits follow after
 * 1px horizontally and ignore vertical pointer motion.
 */
export function hasLiftedTimelineDrag(
  kind: "move" | "marquee" | "edge",
  deltaX: number,
  deltaY: number,
): boolean {
  return kind === "move"
    ? Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5
    : kind === "marquee"
      ? Math.abs(deltaX) >= 5
      : Math.abs(deltaX) >= 1;
}
