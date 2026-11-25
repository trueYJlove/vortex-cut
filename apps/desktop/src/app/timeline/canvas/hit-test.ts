import type { TimelineClip, TimelineClipId } from "@aivideo/contracts";
import {
  SCROLLBAR_HEIGHT_PX,
  hitTestActiveTransitions,
  hitTestClips,
  hitTestTransitionGap,
  hitTestTransitions,
  hitTestTrimHandle,
  hitTestVolumeLine,
  scrollBounds,
  trackRowAt,
  type TrackRowLayout,
} from "../geometry.js";
import type {
  ActiveTransitionRenderRect,
  CaptionRenderRect,
  ClipRenderRect,
  TimelineHover,
  TimelineViewState,
  TransitionRenderRect,
  TrimEdge,
} from "../types.js";
import type { CanvasContextMenuTarget } from "./contextMenuBuilder.js";

/** Edge tolerance (px) for C1 caption trim handles. */
export const CAPTION_EDGE_PX = 8;

const canChangeClipSpeed = (clip: TimelineClip): boolean =>
  (clip.asset_kind === "video" || clip.asset_kind === "audio")
  && clip.source_start_us != null
  && clip.source_end_us != null
  && clip.source_end_us > clip.source_start_us;

export function hitTestCaptions(
  x: number,
  y: number,
  rects: readonly CaptionRenderRect[],
): string | null {
  for (const rect of rects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.caption.caption_id;
    }
  }
  return null;
}

export function hitTestCaptionEdge(
  x: number,
  y: number,
  rects: readonly CaptionRenderRect[],
): { captionId: string; edge: TrimEdge } | null {
  const captionId = hitTestCaptions(x, y, rects);
  if (!captionId) return null;
  const rect = rects.find((item) => item.caption.caption_id === captionId);
  if (!rect) return null;
  if (x <= rect.x + CAPTION_EDGE_PX) return { captionId, edge: "left" };
  if (x >= rect.x + rect.width - CAPTION_EDGE_PX) return { captionId, edge: "right" };
  return null;
}

export function detectCanvasHover(opts: {
  x: number;
  y: number;
  clipRects: readonly ClipRenderRect[];
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
  waveformRatio: number;
}): { hover: TimelineHover; cursor: "ew-resize" | "ns-resize" | "grab" | "default" } {
  const { x, y, clipRects, isClipLocked, waveformRatio } = opts;
  const handle = hitTestTrimHandle(x, y, clipRects as ClipRenderRect[]);
  const volumeHoverId = handle
    ? null
    : hitTestVolumeLine(x, y, clipRects as ClipRenderRect[], isClipLocked, waveformRatio);
  const clipId = handle ? null : hitTestClips(x, y, clipRects as ClipRenderRect[]);
  const hover: TimelineHover = handle
    ? { clipId: handle.clipId, edge: handle.edge }
    : { clipId: volumeHoverId ?? clipId, edge: null };

  if (handle) return { hover, cursor: "ew-resize" };
  if (volumeHoverId) return { hover, cursor: "ns-resize" };
  const locked = clipId ? isClipLocked(clipId) : false;
  return { hover, cursor: clipId && !locked ? "grab" : "default" };
}

export function hitTestSpeedHandle(opts: {
  x: number;
  y: number;
  speedModeActive: boolean;
  selectedSpeedClipIds: readonly string[];
  clips: readonly TimelineClip[];
  clipRects: readonly ClipRenderRect[];
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
}): { clipId: TimelineClipId; edge: TrimEdge } | null {
  const { x, y, speedModeActive, selectedSpeedClipIds, clips, clipRects, isClipLocked } = opts;
  if (!speedModeActive) return null;
  for (const id of selectedSpeedClipIds) {
    const candidate = clips.find((clip) => clip.clip_id === id);
    if (!candidate || !canChangeClipSpeed(candidate) || isClipLocked(candidate.clip_id)) continue;
    const candidateRect = clipRects.find((rect) => rect.clip.clip_id === id);
    if (!candidateRect) continue;
    const hit = hitTestTrimHandle(x, y, [candidateRect]);
    if (hit) return hit;
  }
  return null;
}

export type CanvasPointerDownHit =
  | { kind: "header-rail" }
  | { kind: "scrollbar" }
  | { kind: "ruler" }
  | { kind: "active-transition"; transitionId: string }
  | { kind: "transition"; transitionId: string }
  | { kind: "speed-handle"; clipId: TimelineClipId; edge: TrimEdge }
  | { kind: "trim-handle"; clipId: TimelineClipId; edge: TrimEdge }
  | { kind: "volume-line"; clipId: TimelineClipId }
  | { kind: "clip"; clipId: TimelineClipId }
  | { kind: "caption-edge"; captionId: string; edge: TrimEdge }
  | { kind: "caption"; captionId: string }
  | { kind: "transition-gap"; afterClipId: string }
  | { kind: "empty" };

export function hitTestCanvasPointerDown(opts: {
  x: number;
  y: number;
  view: TimelineViewState;
  totalUs: number;
  canvasWidth: number;
  canvasHeight: number;
  scrollTop: number;
  clips: readonly TimelineClip[];
  clipRects: readonly ClipRenderRect[];
  captionRects: readonly CaptionRenderRect[];
  transitionRects: readonly TransitionRenderRect[];
  activeTransitionRects: readonly ActiveTransitionRenderRect[];
  speedModeActive: boolean;
  selectedSpeedClipIds: readonly string[];
  isClipLocked: (clipId: TimelineClipId, alone?: boolean) => boolean;
  waveformRatio: number;
}): { hit: CanvasPointerDownHit; speedHandleMiss: boolean } {
  const {
    x,
    y,
    view,
    totalUs,
    canvasWidth,
    canvasHeight,
    scrollTop,
    clips,
    clipRects,
    captionRects,
    transitionRects,
    activeTransitionRects,
    speedModeActive,
    selectedSpeedClipIds,
    isClipLocked,
    waveformRatio,
  } = opts;

  if (x < view.headerWidth) {
    return { hit: { kind: "header-rail" }, speedHandleMiss: speedModeActive };
  }

  const speedHandle = hitTestSpeedHandle({
    x,
    y,
    speedModeActive,
    selectedSpeedClipIds,
    clips,
    clipRects,
    isClipLocked,
  });
  const speedHandleMiss = speedModeActive && !speedHandle;

  const { maxScrollX } = scrollBounds(view, totalUs, canvasWidth);
  const scrollbarBandTop = scrollTop + canvasHeight - SCROLLBAR_HEIGHT_PX;
  if (maxScrollX > 0 && y >= scrollbarBandTop) {
    return { hit: { kind: "scrollbar" }, speedHandleMiss };
  }

  if (y <= view.rulerHeight) {
    return { hit: { kind: "ruler" }, speedHandleMiss };
  }

  const activeTransitionId = hitTestActiveTransitions(x, y, activeTransitionRects as ActiveTransitionRenderRect[]);
  if (activeTransitionId) {
    return { hit: { kind: "active-transition", transitionId: activeTransitionId }, speedHandleMiss };
  }

  const transitionId = hitTestTransitions(x, y, transitionRects as TransitionRenderRect[]);
  if (transitionId) {
    return { hit: { kind: "transition", transitionId }, speedHandleMiss };
  }

  if (speedHandle) {
    return { hit: { kind: "speed-handle", clipId: speedHandle.clipId, edge: speedHandle.edge }, speedHandleMiss: false };
  }

  const handle = hitTestTrimHandle(x, y, clipRects as ClipRenderRect[]);
  if (handle) {
    return { hit: { kind: "trim-handle", clipId: handle.clipId, edge: handle.edge }, speedHandleMiss };
  }

  const volumeId = hitTestVolumeLine(x, y, clipRects as ClipRenderRect[], isClipLocked, waveformRatio);
  if (volumeId) {
    return { hit: { kind: "volume-line", clipId: volumeId }, speedHandleMiss };
  }

  const clipId = hitTestClips(x, y, clipRects as ClipRenderRect[]);
  if (clipId) {
    return { hit: { kind: "clip", clipId }, speedHandleMiss };
  }

  const captionEdge = hitTestCaptionEdge(x, y, captionRects);
  if (captionEdge) {
    return { hit: { kind: "caption-edge", captionId: captionEdge.captionId, edge: captionEdge.edge }, speedHandleMiss };
  }

  const captionId = hitTestCaptions(x, y, captionRects);
  if (captionId) {
    return { hit: { kind: "caption", captionId }, speedHandleMiss };
  }

  const gapAnchor = hitTestTransitionGap(x, y, clipRects as ClipRenderRect[]);
  if (gapAnchor) {
    return { hit: { kind: "transition-gap", afterClipId: gapAnchor }, speedHandleMiss };
  }

  return { hit: { kind: "empty" }, speedHandleMiss };
}

export function hitTestCanvasContextMenuTarget(opts: {
  x: number;
  y: number;
  transitionRects: readonly TransitionRenderRect[];
  clipRects: readonly ClipRenderRect[];
  captionRects: readonly CaptionRenderRect[];
  trackRows: readonly TrackRowLayout[];
}): CanvasContextMenuTarget {
  const { x, y, transitionRects, clipRects, captionRects, trackRows } = opts;
  const transitionId = hitTestTransitions(x, y, transitionRects as TransitionRenderRect[]);
  if (transitionId) return { kind: "transition", transitionId };

  const clipId = hitTestClips(x, y, clipRects as ClipRenderRect[]);
  if (clipId) return { kind: "clip", clipId };

  const captionId = hitTestCaptions(x, y, captionRects);
  if (captionId) return { kind: "caption", captionId };

  return { kind: "empty", trackId: trackRowAt(trackRows as TrackRowLayout[], x, y)?.track.id ?? null };
}
