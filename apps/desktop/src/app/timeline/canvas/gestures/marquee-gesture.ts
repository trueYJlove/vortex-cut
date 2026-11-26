import type { TimelineClip, TimelineClipId, TimelinePatchOperation } from "@aivideo/contracts";
import { hasLiftedTimelineDrag } from "../../drag-threshold.js";
import {
  clampScrollX,
  clipsInTimelineMarquee,
  marqueeRect,
  scrollBounds,
  xToTime,
  type TrackRowLayout,
} from "../../geometry.js";
import { expandLinkedClipIds, mergeLinkedMarqueeSelection } from "../../linked-clips.js";
import type { ClipRenderRect, TimelineInteraction, TimelineSelection, TimelineViewState } from "../../types.js";
import { clampRulerTime } from "./ruler-scrub.js";

export type MarqueeInteraction = Extract<TimelineInteraction, { kind: "marquee" }>;

export function checkInteractionDragLifted(
  active: TimelineInteraction,
  x: number,
  y: number,
  clientX: number,
): { liftedNow: boolean; stillBelowThreshold: boolean } {
  if (active.kind === "move" || active.kind === "group-move" || active.kind === "caption-move") {
    if (!hasLiftedTimelineDrag("move", x - active.startX, y - active.startY)) {
      return { liftedNow: false, stillBelowThreshold: true };
    }
    return { liftedNow: true, stillBelowThreshold: false };
  }
  if (active.kind === "marquee") {
    if (!hasLiftedTimelineDrag("marquee", clientX - active.startClientX, 0)) {
      return { liftedNow: false, stillBelowThreshold: true };
    }
    return { liftedNow: true, stillBelowThreshold: false };
  }
  if (active.kind === "trim" || active.kind === "speed" || active.kind === "edge-edit" || active.kind === "caption-trim") {
    if (!hasLiftedTimelineDrag("edge", x - active.startX, 0)) {
      return { liftedNow: false, stillBelowThreshold: true };
    }
    return { liftedNow: true, stillBelowThreshold: false };
  }
  return { liftedNow: false, stillBelowThreshold: false };
}

export function stepScrollbarDrag(opts: {
  startX: number;
  startScrollX: number;
  x: number;
  view: TimelineViewState;
  totalUs: number;
  canvasWidth: number;
}): number {
  const { startX, startScrollX, x, view, totalUs, canvasWidth } = opts;
  const { maxScrollX } = scrollBounds(view, totalUs, canvasWidth);
  return clampScrollX(startScrollX + (x - startX), maxScrollX);
}

export function stepMarqueeGesture(
  active: MarqueeInteraction,
  x: number,
  y: number,
  scrollX: number,
): MarqueeInteraction {
  return {
    ...active,
    currentX: x + scrollX,
    currentY: y,
  };
}

export function commitMarqueeGesture(opts: {
  active: MarqueeInteraction;
  dragLifted: boolean;
  shiftClicked: boolean;
  contentClipRects: ClipRenderRect[];
  trackRows: TrackRowLayout[];
  clips: readonly TimelineClip[];
  selection: TimelineSelection;
  view: TimelineViewState;
  totalUs: number;
  setSelection: (selection: TimelineSelection) => void;
  onSeekCommit?: (timeUs: number) => void;
  onSeek?: (timeUs: number) => void;
}): void {
  const {
    active,
    dragLifted,
    shiftClicked,
    contentClipRects,
    trackRows,
    clips,
    selection,
    view,
    totalUs,
    setSelection,
    onSeekCommit,
    onSeek,
  } = opts;
  const rect = marqueeRect(active.startX, active.startY, active.currentX, active.currentY);
  if (dragLifted) {
    const hits = clipsInTimelineMarquee(rect, contentClipRects, trackRows);
    const merged = shiftClicked
      ? mergeLinkedMarqueeSelection(selection, hits, clips as TimelineClip[])
      : expandLinkedClipIds(hits, clips as TimelineClip[]);
    setSelection(merged.length > 0 ? { kind: "clips", ids: merged } : null);
  } else {
    const viewportX = active.currentX - view.scrollX;
    (onSeekCommit ?? onSeek)?.(clampRulerTime(xToTime(viewportX, view), totalUs));
    if (!shiftClicked) setSelection(null);
  }
}

export function buildGroupMovePatchOperations(opts: {
  clipIds: readonly TimelineClipId[];
  targetStartUsByClip: Record<string, number>;
  clips: readonly TimelineClip[];
}): TimelinePatchOperation[] {
  const { clipIds, targetStartUsByClip, clips } = opts;
  return clipIds
    .map((id) => ({
      clip: clips.find((c) => c.clip_id === id),
      targetUs: Math.round(targetStartUsByClip[id] ?? 0),
    }))
    .filter(
      (item): item is { clip: TimelineClip; targetUs: number } =>
        Boolean(item.clip) && Math.abs(item.targetUs - item.clip!.timeline_start_us) >= 1000,
    )
    .map((item) => ({
      op: "position_clip" as const,
      clip_id: item.clip.clip_id,
      timeline_start_us: item.targetUs,
    }));
}
