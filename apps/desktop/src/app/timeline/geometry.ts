/**
 * Timeline Phase 4 — pure geometry / interaction helpers.
 *
 * These functions are deliberately side-effect free so they can be unit
 * tested without a canvas or DOM. Pixel coordinates are relative to the
 * canvas element (x already excludes the left header gutter only via the
 * view state's headerWidth).
 */
import type { TimelineClip, TimelineClipId, TimelineTransition, TimelineTransitionId } from "@aivideo/contracts";
import type {
  ClipRenderRect,
  MarqueeRect,
  TimelineViewState,
  TransitionRenderRect,
  TrimEdge,
} from "./types.js";

/** Minimum clip duration enforced by the backend/contracts (µs). */
export const MIN_CLIP_US = 100_000;
/** Snap threshold in canvas pixels. */
export const SNAP_PX = 8;
/** Width of the hoverable trim handle zone in pixels. */
export const TRIM_HANDLE_PX = 6;

/** Clip duration on the timeline (µs), matching backend normalization. */
export function clipDuration(clip: TimelineClip): number {
  if (clip.asset_kind === "image") {
    return clip.timeline_end_us - clip.timeline_start_us;
  }
  return (clip.source_end_us ?? 0) - (clip.source_start_us ?? 0);
}

/** Convert a timeline time (µs) to canvas x (pixels). */
export function timeToX(us: number, view: TimelineViewState): number {
  return view.headerWidth + (us / 1_000_000) * view.pixelsPerSecond;
}

/** Convert canvas x (pixels) to timeline time (µs), clamped to >= 0. */
export function xToTime(x: number, view: TimelineViewState): number {
  return Math.max(0, ((x - view.headerWidth) / view.pixelsPerSecond) * 1_000_000);
}

/** Compute pixel rectangles for all clips (V1 row 0, A1 row 1). */
export function computeClipRects(
  clips: TimelineClip[],
  view: TimelineViewState,
): ClipRenderRect[] {
  return clips.map((clip, index) => {
    const trackIndex = clip.track_id === "A1" ? 1 : 0;
    return {
      x: timeToX(clip.timeline_start_us, view),
      y: view.rulerHeight + trackIndex * view.trackHeight,
      width: Math.max(2, (clipDuration(clip) / 1_000_000) * view.pixelsPerSecond),
      height: view.trackHeight,
      clip,
      index,
    };
  });
}

/** Top-most clip under (x, y), or null. */
export function hitTestClips(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
): TimelineClipId | null {
  for (const rect of clipRects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.clip.clip_id;
    }
  }
  return null;
}

/** V1 相邻两片段之间的转场标记矩形（居中于锚点片段的终点）。 */
export function computeTransitionRects(
  clips: TimelineClip[],
  transitions: TimelineTransition[],
  view: TimelineViewState,
): TransitionRenderRect[] {
  const endTimeById = new Map(clips.map((clip) => [clip.clip_id, clip.timeline_end_us]));
  return transitions
    .map((transition) => {
      const anchorEndUs = endTimeById.get(transition.after_clip_id);
      if (anchorEndUs === undefined) return null;
      const centerX = timeToX(anchorEndUs, view);
      const width = Math.max(
        6,
        Math.min(80, (transition.duration_us / 1_000_000) * view.pixelsPerSecond),
      );
      return {
        x: centerX - width / 2,
        y: view.rulerHeight,
        width,
        height: view.trackHeight,
        transition,
      };
    })
    .filter((rect): rect is TransitionRenderRect => rect !== null);
}

/** Top-most transition marker under (x, y), or null. Checked before clips. */
export function hitTestTransitions(
  x: number,
  y: number,
  transitionRects: TransitionRenderRect[],
): TimelineTransitionId | null {
  for (const rect of transitionRects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.transition.transition_id;
    }
  }
  return null;
}

/**
 * (x, y) 落在两个相邻 V1 视频/图片片段的边界容差内时，返回左侧片段 id
 * （转场锚点），否则 null。
 */
export function hitTestTransitionGap(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
  tolerancePx = 8,
): TimelineClipId | null {
  const v1 = clipRects.filter((rect) => rect.clip.track_id === "V1");
  const transitionable = (clip: TimelineClip) =>
    clip.asset_kind === "video" || clip.asset_kind === "image";
  for (let index = 0; index < v1.length - 1; index += 1) {
    const left = v1[index];
    const right = v1[index + 1];
    if (!transitionable(left.clip) || !transitionable(right.clip)) continue;
    const boundary = left.x + left.width;
    if (Math.abs(x - boundary) <= tolerancePx && y >= left.y && y <= left.y + left.height) {
      return left.clip.clip_id;
    }
  }
  return null;
}

/**
 * Detect whether (x, y) lands on a trimmable edge of a clip.
 * Only clips with a source range (video/audio) are trimmable; images are not.
 */
export function hitTestTrimHandle(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
): { clipId: TimelineClipId; edge: TrimEdge } | null {
  for (const rect of clipRects) {
    const trimmable = rect.clip.asset_kind === "video" || rect.clip.asset_kind === "audio";
    if (!trimmable) continue;
    const withinY = y >= rect.y && y <= rect.y + rect.height;
    if (!withinY) continue;
    if (x >= rect.x - TRIM_HANDLE_PX && x <= rect.x + TRIM_HANDLE_PX) {
      return { clipId: rect.clip.clip_id, edge: "left" };
    }
    if (x >= rect.x + rect.width - TRIM_HANDLE_PX && x <= rect.x + rect.width + TRIM_HANDLE_PX) {
      return { clipId: rect.clip.clip_id, edge: "right" };
    }
  }
  return null;
}

/**
 * Candidate timeline positions (µs) that dragging/snapping may align to:
 * every clip edge (excluding the dragged clip's own edges), the playhead
 * and the timeline origin.
 */
export function snapCandidates(
  clipRects: ClipRenderRect[],
  playheadUs: number,
  excludeClipId?: TimelineClipId,
): number[] {
  const times = new Set<number>([0, playheadUs]);
  for (const rect of clipRects) {
    if (rect.clip.clip_id === excludeClipId) continue;
    times.add(rect.clip.timeline_start_us);
    times.add(rect.clip.timeline_end_us);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Snap `valueUs` to the closest candidate within `thresholdUs`.
 * Returns the snapped value, or the original value when nothing is close.
 */
export function snapValue(
  valueUs: number,
  candidates: number[],
  thresholdUs: number,
): number {
  let best = valueUs;
  let bestDistance = thresholdUs;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - valueUs);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Simulate the backend's V1 packing (sequential from 0, in mixed-list order)
 * and return the packed position of each clip.
 */
export function packV1Clips(
  v1Clips: TimelineClip[],
): Array<{ clip: TimelineClip; startUs: number; endUs: number }> {
  let offset = 0;
  return v1Clips.map((clip) => {
    const duration = clipDuration(clip);
    const startUs = offset;
    offset += duration;
    return { clip, startUs, endUs: offset };
  });
}

/**
 * Compute the V1-order insertion index for a dragged V1 clip whose left edge
 * would land at `targetStartUs`. Other V1 clips are packed first; the dragged
 * clip inserts before the first clip whose midpoint lies to the right of the
 * target (i.e. the landing slot matches where the ghost would appear).
 */
export function computeV1TargetIndex(
  v1Clips: TimelineClip[],
  draggedClipId: TimelineClipId,
  targetStartUs: number,
): number {
  const others = v1Clips.filter((clip) => clip.clip_id !== draggedClipId);
  let offset = 0;
  let index = 0;
  for (const clip of others) {
    const midpoint = offset + clipDuration(clip) / 2;
    if (targetStartUs < midpoint) break;
    offset += clipDuration(clip);
    index += 1;
  }
  return index;
}

/**
 * Convert a V1-order insertion index into the mixed-list `to_index` that the
 * backend `move_clip` op needs so the V1 subsequence gets the desired order.
 */
export function v1ReorderToMixedIndex(
  mixedClips: TimelineClip[],
  draggedClipId: TimelineClipId,
  targetV1Index: number,
): number {
  const others = mixedClips.filter((clip) => clip.clip_id !== draggedClipId);
  const v1Positions: number[] = [];
  others.forEach((clip, mixedIndex) => {
    if (clip.track_id === "V1") v1Positions.push(mixedIndex);
  });
  if (targetV1Index >= v1Positions.length) {
    const last = v1Positions[v1Positions.length - 1];
    return last === undefined ? 0 : last + 1;
  }
  return v1Positions[targetV1Index];
}

/** Normalize a marquee rect from possibly-negative deltas. */
export function marqueeRect(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): MarqueeRect {
  return {
    x: Math.min(startX, currentX),
    y: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

/** Clip ids whose rects intersect the marquee rect. */
export function clipsInRect(
  rect: MarqueeRect,
  clipRects: ClipRenderRect[],
): TimelineClipId[] {
  return clipRects
    .filter(
      (r) =>
        r.x < rect.x + rect.width &&
        r.x + r.width > rect.x &&
        r.y < rect.y + rect.height &&
        r.y + r.height > rect.y,
    )
    .map((r) => r.clip.clip_id);
}

/**
 * Compute the visual ghost position of a moved clip.
 * - V1 clips: simulate the packed sequence with the clip re-inserted at the
 *   computed V1 order, so the ghost matches where the backend will land it.
 * - A1 clips: freely positioned at `targetStartUs`.
 */
export function ghostPosition(
  clips: TimelineClip[],
  clip: TimelineClip,
  targetStartUs: number,
): { startUs: number; endUs: number } {
  const duration = clipDuration(clip);
  if (clip.track_id !== "A1") {
    const v1Clips = clips.filter((c) => c.track_id === "V1");
    const targetIndex = computeV1TargetIndex(v1Clips, clip.clip_id, targetStartUs);
    const reordered = [...v1Clips.filter((c) => c.clip_id !== clip.clip_id)];
    reordered.splice(targetIndex, 0, clip);
    const packed = packV1Clips(reordered);
    const landed = packed.find((p) => p.clip.clip_id === clip.clip_id);
    return landed ? { startUs: landed.startUs, endUs: landed.endUs } : { startUs: targetStartUs, endUs: targetStartUs + duration };
  }
  return { startUs: Math.max(0, targetStartUs), endUs: Math.max(0, targetStartUs) + duration };
}
