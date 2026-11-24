/**
 * Timeline Phase 4 — pure geometry / interaction helpers.
 *
 * These functions are deliberately side-effect free so they can be unit
 * tested without a canvas or DOM. Pixel coordinates are relative to the
 * canvas element (x already excludes the left header gutter only via the
 * view state's headerWidth).
 */
import type { ActiveTimelineTransition, TimelineClip, TimelineClipId, TimelineTrack, TimelineTransition, TimelineTransitionId } from "@aivideo/contracts";
import type {
  ActiveTransitionRenderRect,
  ClipRenderRect,
  MarqueeRect,
  TickMark,
  TimelineViewState,
  TransitionRenderRect,
  TrimEdge,
} from "./types.js";
import {
  TIMELINE_EMPTY_VIEW_US,
  TIMELINE_MAX_VIEW_FACTOR,
  TIMELINE_MAX_VIEW_FLOOR_US,
  TIMELINE_MIN_VIEW_US,
  TIMELINE_ZOOM_DEFAULT,
  TIMELINE_ZOOM_STEP,
} from "./types.js";

/** Minimum clip duration enforced by the backend/contracts (µs). */
export const MIN_CLIP_US = 100_000;
/** Snap threshold in canvas pixels. */
export const SNAP_PX = 8;
/** Width of the hoverable trim handle zone in pixels.
 *  T11 参照 Timeline.tsx:790-791：trimHit = min(8, max(2, w/4))——窄片段收缩，宽片段更易命中。 */
export const TRIM_HANDLE_PX = 6;
export function trimHitPx(clipWidthPx: number): number {
  return Math.min(8, Math.max(2, Math.floor(clipWidthPx / 4)));
}
/** Height of the bottom scrollbar strip drawn on the canvas. */
// 横向滚动条高（2026-11-16 对齐 OpenFilm H_SCROLL_H = 10，Timeline.tsx:202）；原 8。
export const SCROLLBAR_HEIGHT_PX = 10;
/** Pointer distance from the canvas edge that triggers drag auto-scroll. */
export const EDGE_AUTOSCROLL_ZONE_PX = 48;
/** OpenFilm scrolls 6–24 CSS px per frame as the pointer moves into the edge. */
export const EDGE_AUTOSCROLL_MIN_STEP_PX = 6;
export const EDGE_AUTOSCROLL_MAX_STEP_PX = 24;

/** Convert a captured screen-space pointer into timeline motion, including scroll accumulated mid-gesture. */
export function timelineGestureDeltaUs(
  pointerX: number,
  startX: number,
  scrollX: number,
  startScrollX: number,
  pixelsPerSecond: number,
): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 0;
  return ((pointerX - startX + scrollX - startScrollX) / pixelsPerSecond) * 1_000_000;
}

/** Clip duration on the timeline (µs). Positions are authoritative under
 * free positioning, so the timeline span (not the source span) is canonical. */
export function clipDuration(clip: TimelineClip): number {
  return clip.timeline_end_us - clip.timeline_start_us;
}

/**
 * Align a clip's painted horizontal bounds to OpenFilm's content-pixel grid.
 * Rounding before subtracting scroll keeps the same edge and width through
 * fractional scroll positions. Hit testing and edit planning keep the original
 * fractional geometry; the one-pixel trailing inset is paint-only. The Canvas
 * body stays on integer rows for raster parity; the DOM label overlay keeps
 * OpenFilm's separate half-pixel title inset.
 */
export function snapClipPaintRect(rect: ClipRenderRect, scrollX = 0): ClipRenderRect {
  const contentLeft = rect.x + scrollX;
  const x = Math.round(contentLeft) - scrollX;
  const right = Math.round(contentLeft + rect.width) - scrollX;
  return { ...rect, x, y: Math.ceil(rect.y), width: Math.max(2, right - x - 1), height: Math.max(4, rect.height) };
}

/** Keep a long clip's title inside the visible timeline head, as OpenFilm's
 *  `data-pin` / `data-pin-max` label pair does while the clip is scrolled. */
export function clipLabelPinShift(clipX: number, clipWidth: number, contentLeft: number): number {
  return Math.min(Math.max(0, contentLeft - clipX), Math.max(0, clipWidth - 48));
}

/** Horizontal wheel input follows OpenFilm: any deltaX wins; Shift maps deltaY. */
export function timelineWheelPanDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  shiftKey: boolean,
): number {
  const units = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const horizontal = deltaX !== 0 ? deltaX : shiftKey ? deltaY : 0;
  return horizontal * units;
}

/**
 * Convert a timeline time (µs) to viewport x (pixels), accounting for the
 * horizontal scroll offset. Content x = viewport x + scrollX.
 */
export function timeToX(us: number, view: TimelineViewState): number {
  return view.headerWidth + (us / 1_000_000) * view.pixelsPerSecond - view.scrollX;
}

/** Convert viewport x (pixels) to timeline time (µs), clamped to >= 0. */
export function xToTime(x: number, view: TimelineViewState): number {
  return Math.max(0, ((x + view.scrollX - view.headerWidth) / view.pixelsPerSecond) * 1_000_000);
}

/** Snap timeline positions to the nearest project frame using its rational frame rate. */
export function snapTimeToFrame(timeUs: number, fpsNum: number, fpsDen: number): number {
  const numerator = Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 30;
  const denominator = Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1;
  const frame = Math.max(0, Math.round((Math.max(0, timeUs) * numerator) / (1_000_000 * denominator)));
  return Math.round((frame * 1_000_000 * denominator) / numerator);
}

/** 一条轨道的像素布局（自上而下，顺序 = document.tracks 数组顺序）。 */
export interface TrackRowLayout {
  track: TimelineTrack;
  y: number;
  height: number;
}

export type TimelineDropBand = "above" | "body" | "below";
export type TimelineClipDropZone = "replace" | "above" | "below" | "before" | "after";

export interface TimelineDropHit {
  /** Index in the rendered row list; -1 and rows.length mean outside the track stack. */
  rowIndex: number;
  trackId: string | null;
  band: TimelineDropBand;
  clipId: TimelineClipId | null;
  zone: TimelineClipDropZone | null;
}

/** Clips that OpenFilm keeps out of the destination hit test for a move gesture. */
export function timelineDragDropExcludedClipIds(
  movingClipIds: readonly string[],
  linkedRiderClipIds: readonly string[],
  linkageEnabled: boolean,
): Set<string> {
  return new Set(linkageEnabled ? [...movingClipIds, ...linkedRiderClipIds] : movingClipIds);
}

/** The narrow lane edge used by OpenFilm to create a lane above/below a row. */
export function trackDropEdgePx(height: number): number {
  return Math.min(4, height / 6);
}

/** Resolve the track and clip zone directly under the pointer, including row gaps and outer drop bands. */
export function timelineDropHit(
  x: number,
  y: number,
  rows: readonly TrackRowLayout[],
  clipRects: readonly ClipRenderRect[],
  excludedClipIds: ReadonlySet<string> = new Set(),
): TimelineDropHit {
  if (rows.length === 0 || y < rows[0]!.y) {
    return { rowIndex: -1, trackId: null, band: "above", clipId: null, zone: null };
  }

  let rowIndex = rows.length;
  let band: TimelineDropBand = "below";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const next = rows[index + 1];
    if (y >= row.y && y < row.y + row.height) {
      rowIndex = index;
      const within = y - row.y;
      const edge = trackDropEdgePx(row.height);
      band = within < edge ? "above" : within >= row.height - edge ? "below" : "body";
      break;
    }
    if (next && y >= row.y + row.height && y < next.y) {
      rowIndex = index + 1;
      band = "above";
      break;
    }
  }

  const row = rows[rowIndex];
  if (!row || band !== "body") {
    return { rowIndex, trackId: row?.track.id ?? null, band, clipId: null, zone: null };
  }

  const hit = clipRects.find((rect) =>
    rect.clip.track_id === row.track.id &&
    !excludedClipIds.has(rect.clip.clip_id) &&
    x >= rect.x && x < rect.x + rect.width &&
    y >= rect.y && y < rect.y + rect.height,
  );
  if (!hit) return { rowIndex, trackId: row.track.id, band, clipId: null, zone: null };

  const localX = x - hit.x;
  const localY = y - hit.y;
  const horizontalEdge = Math.min(12, hit.width / 4);
  let zone: TimelineClipDropZone;
  if (localX < horizontalEdge) zone = "before";
  else if (localX >= hit.width - horizontalEdge) zone = "after";
  else {
    const verticalEdge = trackDropEdgePx(hit.height);
    zone = localY < verticalEdge ? "above" : localY >= hit.height - verticalEdge ? "below" : "replace";
  }
  const clipBand = zone === "above" ? "above" : zone === "below" ? "below" : "body";
  return { rowIndex, trackId: row.track.id, band: clipBand, clipId: hit.clip.clip_id, zone };
}

/**
 * 由轨道数组构建行布局（y 自标尺底部开始累计）。
 * OpenFilm track-heights.ts：主轨 68、普通视频 52、文本 24、音频 42；
 * 用户调整 trackHeight 时，普通视频和主轨仍会随之缩放，字幕/音频保留专用高度。
 */
/**
 * 行间间隙（2026-11-10，对齐 OpenFilm 的 `GAP = 2`）。
 * 相邻两轨之间露出 2px 面板底色，才读得出"这是两条轨"而不是"一整块区域"。
 * 只在**行与行之间**加，不占首行之前与末行之后——上下留白由调用方负责。
 */
export const TRACK_GAP = 2;

/**
 * 行组在轨道区内的上内边距（2026-11-11，对齐 OpenFilm 的 TL_VPAD = 10）。
 * 至少留 10px：行贴着标尺下沿或面板底边都像被切掉一截。
 */
export const TRACK_VIEW_PAD = 10;

/* 参照的行高常量（openfilm lib/track-heights.ts:24-26）：
   主轨比其他轨高一档；覆盖轨是矮的。 */
export const MAIN_TRACK_H = 68;
export const OVERLAY_TRACK_H = 28;
export const TRACK_SIZES = {
  small: { visual: 36, audio: 30 },
  medium: { visual: 52, audio: 42 },
  large: { visual: 96, audio: 80 },
} as const;
/* T4 参照 Timeline.tsx:311,323-325：字幕/文本轨窄行 */
export const CAPTION_ROW_H = 24;
/* T5 参照 Timeline.tsx:1239：标记行 16px 浮层 + 2px 呼吸 = 首行之上至少让出 18px */
export const MARKER_ROW_PAD = 18;

export function computeTrackRows(
  tracks: TimelineTrack[],
  rulerHeight: number,
  rowHeight: number,
  /** 可视区高度（标尺以下的部分）。给出时行组在其中垂直居中，与 OpenFilm 的
   *  `padTop = max(MARKER_ROW_H+2, (view.height - tracksH)/2)` 一致：面板拉高后
   *  行组跟着居中，而不是全部贴着顶部、底下空出一大片（实测截图差异）。
   *  不给则按老行为从标尺下沿开始排——测试与离屏渲染不依赖居中。 */
  viewportHeight?: number,
  trackHeightOverrides: Readonly<Record<string, number>> = {},
): TrackRowLayout[] {
  /* OpenFilm lib/track-heights.ts roles: main visual 68, regular visual 52,
     caption/text 24, audio 42. The existing single height preference acts as
     a compact adjustment around the 56px regular visual baseline. */
  const heights = tracks.map((track) => {
    const defaultHeight = track.kind === "audio"
      ? 42
      : track.kind === "text"
        ? CAPTION_ROW_H
        : track.id === "V1"
          ? Math.max(64, rowHeight + 12)
          : Math.max(OVERLAY_TRACK_H, rowHeight - 4);
    const override = trackHeightOverrides[track.id];
    if (!Number.isFinite(override)) return defaultHeight;
    return Math.max(28, Math.min(160, Math.round(override)));
  });
  const tracksH = heights.reduce((sum, h) => sum + h, 0) + Math.max(0, tracks.length - 1) * TRACK_GAP;
  const padTop =
    viewportHeight === undefined
      ? 0
      // T5 参照 Timeline.tsx:1239：标记行 16px 浮在首行上方，padTop 至少让出 18px
      // The measured OpenFilm row surface sits 1 CSS px below the prior Vortex baseline.
      : Math.max(MARKER_ROW_PAD, Math.floor((viewportHeight - tracksH) / 2)) + 1;
  let y = rulerHeight + padTop;
  return tracks.map((track, index) => {
    const height = heights[index];
    // 首行贴 padTop 之后，之后每行之前留一道间隙
    const gap = index === 0 ? 0 : TRACK_GAP;
    const row: TrackRowLayout = { track, y: y + gap, height };
    y += gap + height;
    return row;
  });
}

/** 全部轨道行的总高（不含标尺与滚动条）。 */
export function trackRowsTotalHeight(rows: TrackRowLayout[]): number {
  return rows.reduce((sum, row) => sum + row.height, 0);
}

/** 指定轨道的行布局；未知轨道返回 null。 */
export function trackRowOf(
  rows: TrackRowLayout[],
  trackId: string,
): TrackRowLayout | null {
  return rows.find((row) => row.track.id === trackId) ?? null;
}

/** (x, y) 命中的轨道行；空白/标尺区域返回 null。 */
export function trackRowAt(rows: TrackRowLayout[], x: number, y: number): TrackRowLayout | null {
  if (x < 0) return null;
  for (const row of rows) {
    if (y >= row.y && y < row.y + row.height) return row;
  }
  return null;
}

/** Compute pixel rectangles for all clips (rows come from the track layout). */
export function computeClipRects(
  clips: TimelineClip[],
  rows: TrackRowLayout[],
  view: TimelineViewState,
): ClipRenderRect[] {
  const yById = new Map(rows.map((row) => [row.track.id, row]));
  return clips.map((clip, index) => {
    const row = yById.get(clip.track_id);
    const y = row?.y ?? view.rulerHeight;
    const height = row?.height ?? view.trackHeight;
    return {
      x: timeToX(clip.timeline_start_us, view),
      y,
      width: Math.max(2, (clipDuration(clip) / 1_000_000) * view.pixelsPerSecond),
      height,
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

/** 同轨首尾相接处（无空隙）的转场标记矩形（居中于锚点片段的终点）。
 *  P231 Q5：转场同轨邻接（每条视觉轨独立判定；V1 轨 = 同轨特例）。
 *  自由定位下留有空隙的转场休眠：不渲染标记。 */
export function computeTransitionRects(
  clips: TimelineClip[],
  transitions: TimelineTransition[],
  rows: TrackRowLayout[],
  view: TimelineViewState,
): TransitionRenderRect[] {
  const transitionable = (clip: TimelineClip) =>
    clip.asset_kind === "video" || clip.asset_kind === "image";
  // P231 Q5：转场同轨邻接（每条视觉轨独立时间序；V1 轨 = 同轨特例）。
  const byTrack = new Map<string, TimelineClip[]>();
  for (const clip of clips) {
    const list = byTrack.get(clip.track_id);
    if (list) list.push(clip);
    else byTrack.set(clip.track_id, [clip]);
  }
  const actualIncomingByOutgoing = new Map<string, TimelineClip>();
  for (const trackClips of byTrack.values()) {
    const sorted = [...trackClips].sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const left = sorted[index];
      const right = sorted[index + 1];
      if (transitionable(left) && transitionable(right) && right.timeline_start_us === left.timeline_end_us) {
        actualIncomingByOutgoing.set(left.clip_id, right);
      }
    }
  }
  const rowOfTrack = (trackId: string) => {
    const row = trackRowOf(rows, trackId);
    return { y: row?.y ?? view.rulerHeight, height: row?.height ?? view.trackHeight };
  };
  const endById = new Map(clips.map((clip) => [clip.clip_id, clip.timeline_end_us]));
  return transitions
    .map((transition) => {
      // Compatibility markers are tied to their original pair. Missing or
      // stale incoming identities stay dormant; never rebind to a new successor.
      if (!transition.incoming_clip_id || actualIncomingByOutgoing.get(transition.after_clip_id)?.clip_id !== transition.incoming_clip_id) return null;
      const anchorEndUs = endById.get(transition.after_clip_id);
      if (anchorEndUs === undefined) return null;
      // P231：转场标记钉在锚点所属轨道行（不再固定 V1 行）。
      const anchor = clips.find(clip => clip.clip_id === transition.after_clip_id);
      if (!anchor) return null;
      const { y: rowY, height: rowHeight } = rowOfTrack(anchor.track_id);
      const centerX = timeToX(anchorEndUs, view);
      const width = Math.max(
        6,
        Math.min(80, (transition.duration_us / 1_000_000) * view.pixelsPerSecond),
      );
      return {
        x: centerX - width / 2,
        y: rowY,
        width,
        height: rowHeight,
        transition,
      };
    })
    .filter((rect): rect is TransitionRenderRect => rect !== null);
}

/** Place Core's already-paired source-fact transition projections on their `on_clip_id` row. */
export function computeActiveTransitionRects(
  transitions: readonly ActiveTimelineTransition[],
  clips: readonly TimelineClip[],
  rows: TrackRowLayout[],
  view: TimelineViewState,
): ActiveTransitionRenderRect[] {
  const clipsById = new Map(clips.map(clip => [clip.clip_id, clip]));
  const rowsByTrack = new Map(rows.map(row => [row.track.id, row]));
  return transitions.flatMap(transition => {
    const onClip = clipsById.get(transition.on_clip_id);
    if (!onClip || !Number.isFinite(transition.start_us) || !Number.isFinite(transition.end_us) || transition.end_us <= transition.start_us) return [];
    const row = rowsByTrack.get(onClip.track_id);
    if (!row) return [];
    const x1 = timeToX(transition.start_us, view);
    const x2 = timeToX(transition.end_us, view);
    return [{
      x: x1,
      y: row.y,
      width: Math.max(10, x2 - x1),
      height: row.height,
      transition,
      // White dips need Core's trusted page-frame role. Move/rest resize needs
      // OpenFilm's paired head/rest planner; audio crossfades use audio facts.
      // Only the source-fact edits implemented by TimelineCanvas expose edges.
      editable: transition.kind === "dissolve" || transition.kind === "dip-black",
    }];
  });
}

/** Active source-fact transition hit test. This returns only an active transition id. */
export function hitTestActiveTransitions(
  x: number,
  y: number,
  transitionRects: readonly ActiveTransitionRenderRect[],
): ActiveTimelineTransition["transition_id"] | null {
  for (let index = transitionRects.length - 1; index >= 0; index -= 1) {
    const rect = transitionRects[index]!;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.transition.transition_id;
    }
  }
  return null;
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
 * (x, y) 落在两个首尾相接的同轨视频/图片片段的边界容差内时，返回左侧片段
 * id（转场锚点），否则 null。自由定位下片段间可能有空隙：只有两侧贴齐的
 * 边界才提供"添加转场"热点。P231 Q5：转场同轨邻接。
 */
export function hitTestTransitionGap(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
  tolerancePx = 8,
): TimelineClipId | null {
  // P231 Q5：转场同轨邻接（每条视觉轨独立判定；V1 轨 = 同轨特例）。
  const byTrack = new Map<string, typeof clipRects>();
  for (const rect of clipRects) {
    const list = byTrack.get(rect.clip.track_id);
    if (list) list.push(rect);
    else byTrack.set(rect.clip.track_id, [rect]);
  }
  const transitionable = (clip: TimelineClip) =>
    clip.asset_kind === "video" || clip.asset_kind === "image";
  for (const trackRects of byTrack.values()) {
    const v1 = [...trackRects].sort((a, b) => a.x - b.x);
    for (let index = 0; index < v1.length - 1; index += 1) {
      const left = v1[index];
      const right = v1[index + 1];
      if (!transitionable(left.clip) || !transitionable(right.clip)) continue;
      const boundary = left.x + left.width;
      if (Math.abs(right.x - boundary) > tolerancePx) continue; // 有空隙：不是相邻边界
      if (Math.abs(x - boundary) <= tolerancePx && y >= left.y && y <= left.y + left.height) {
        return left.clip.clip_id;
      }
    }
  }
  return null;
}

/**
 * Detect whether (x, y) lands on a trimmable edge of a clip.
 * Video/audio clips trim their source window; still images trim their timeline duration.
 */
export function hitTestTrimHandle(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
): { clipId: TimelineClipId; edge: TrimEdge } | null {
  for (const rect of clipRects) {
    const trimmable = rect.clip.asset_kind === "video" || rect.clip.asset_kind === "audio" || rect.clip.asset_kind === "image";
    if (!trimmable) continue;
    // OpenFilm only exposes edge handles when a block is wider than 6px. On
    // narrower clips the body remains a move/select target.
    if (rect.width <= 6) continue;
    const withinY = y >= rect.y && y <= rect.y + rect.height;
    if (!withinY) continue;
    // T11 参照 Timeline.tsx:790-791,863-871：命中带宽随片段宽自适应（窄片段收缩防重叠）。
    const hit = trimHitPx(rect.width);
    if (x >= rect.x - hit && x <= rect.x + hit) {
      return { clipId: rect.clip.clip_id, edge: "left" };
    }
    if (x >= rect.x + rect.width - hit && x <= rect.x + rect.width + hit) {
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
  excludeClipIds?: TimelineClipId | Set<TimelineClipId>,
): number[] {
  const excluded =
    excludeClipIds instanceof Set
      ? excludeClipIds
      : excludeClipIds
        ? new Set([excludeClipIds])
        : null;
  const times = new Set<number>([0, playheadUs]);
  for (const rect of clipRects) {
    if (excluded?.has(rect.clip.clip_id)) continue;
    times.add(rect.clip.timeline_start_us);
    times.add(rect.clip.timeline_end_us);
  }
  return [...times].sort((a, b) => a - b);
}

/** Build the cached move-snap list in OpenFilm's priority order: origin, playhead slot, markers, then clip edges. */
export function orderedMoveSnapTargets(
  clipRects: readonly ClipRenderRect[],
  markerTimesUs: readonly number[],
  excludeClipIds?: ReadonlySet<TimelineClipId>,
): { times: number[]; orderByTime: ReadonlyMap<number, number> } {
  const orderByTime = new Map<number, number>([[0, 0]]);
  let order = 2; // the live playhead occupies priority 1 and is supplied per pointer frame
  for (const timeUs of markerTimesUs) {
    if (!orderByTime.has(timeUs)) orderByTime.set(timeUs, order);
    order += 1;
  }
  for (const rect of clipRects) {
    if (excludeClipIds?.has(rect.clip.clip_id)) continue;
    for (const timeUs of [rect.clip.timeline_start_us, rect.clip.timeline_end_us]) {
      if (!orderByTime.has(timeUs)) orderByTime.set(timeUs, order);
      order += 1;
    }
  }
  return {
    times: [...orderByTime.keys()].sort((a, b) => a - b),
    orderByTime,
  };
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
  return snapResult(valueUs, candidates, thresholdUs).valueUs;
}

/**
 * 同 snapValue，但同时告诉调用方**吸附到了哪条线**（没吸上时为 null）。
 *
 * 2026-11-10：画布需要在拖动时画出那条提示线（对齐 OpenFilm 的吸附引导）。
 * 原 snapValue 只回报结果值，调用方无从得知"是哪个候选赢的"——于是只能
 * 靠结果是否等于原值来猜，而候选恰好等于原值时就会误判。
 * 这里把命中候选一并带出，语义唯一。
 */
export function snapResult(
  valueUs: number,
  candidates: number[],
  thresholdUs: number,
): { valueUs: number; snappedTo: number | null } {
  let best = valueUs;
  let bestDistance = thresholdUs;
  let snappedTo: number | null = null;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - valueUs);
    // OpenFilm retains the first target when two targets are equally near.
    if (distance < bestDistance || (distance === bestDistance && snappedTo === null)) {
      bestDistance = distance;
      best = candidate;
      snappedTo = candidate;
    }
  }
  return { valueUs: best, snappedTo };
}

/**
 * Snap against a pre-sorted, unique candidate list in O(log n). `extraCandidateUs`
 * is for a value that can change during a gesture (the playhead). When an
 * OpenFilm target order is supplied, exact-distance ties use its original
 * priority instead of numeric order.
 */
export function snapResultSorted(
  valueUs: number,
  candidates: readonly number[],
  thresholdUs: number,
  extraCandidateUs?: number,
  targetOrder?: ReadonlyMap<number, number>,
): { valueUs: number; snappedTo: number | null } {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candidates[middle]! < valueUs) low = middle + 1;
    else high = middle;
  }

  let best = valueUs;
  let bestDistance = thresholdUs;
  let bestOrder = Number.POSITIVE_INFINITY;
  let snappedTo: number | null = null;
  const consider = (candidate: number | undefined, extra = false) => {
    if (candidate === undefined) return;
    const distance = Math.abs(candidate - valueUs);
    const order = extra ? 1 : (targetOrder?.get(candidate) ?? Number.POSITIVE_INFINITY);
    if (distance < bestDistance || (distance === bestDistance && (snappedTo === null || (targetOrder !== undefined && order < bestOrder)))) {
      bestDistance = distance;
      bestOrder = order;
      best = candidate;
      snappedTo = candidate;
    }
  };
  consider(candidates[low - 1]);
  consider(candidates[low]);
  consider(extraCandidateUs, true);
  return { valueUs: best, snappedTo };
}

/**
 * 同轨自由定位：把 rawStart 钳制到不与 others（目标轨道上的其他片段）重叠
 * 的最近合法起点。合法起点包括每个间隙的两端（与邻居贴齐），以及 0；重叠
 * 被禁止但允许留空隙。
 */
export function clampMoveStart(
  others: TimelineClip[],
  durationUs: number,
  rawStart: number,
): number {
  const candidates = new Set<number>([0, Math.max(0, rawStart)]);
  for (const other of others) {
    candidates.add(other.timeline_start_us - durationUs);
    candidates.add(other.timeline_end_us);
  }
  const overlapsAt = (start: number) =>
    others.some(
      (other) =>
        start < other.timeline_end_us && other.timeline_start_us < start + durationUs,
    );
  let best = Math.max(0, rawStart);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate < 0 || overlapsAt(candidate)) continue;
    const distance = Math.abs(candidate - rawStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
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

/** OpenFilm's marquee selects blocks intersecting a horizontal time span in
 *  the swept track rows; it does not require the drawn rectangle to have height. */
export function clipsInTimelineMarquee(
  rect: MarqueeRect,
  clipRects: ClipRenderRect[],
  rows: TrackRowLayout[],
): TimelineClipId[] {
  if (rect.width <= 0) return [];
  const rowAt = (y: number): number => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const previous = rows[index - 1];
      const gapStart = previous ? previous.y + previous.height : row.y;
      if (y >= gapStart && y < row.y + row.height) return index;
    }
    return y < (rows[0]?.y ?? 0) ? -1 : rows.length;
  };
  const firstRow = rowAt(rect.y);
  const lastRow = rowAt(rect.y + rect.height);
  const fromRow = Math.min(firstRow, lastRow);
  const toRow = Math.max(firstRow, lastRow);
  const rowIndex = new Map(rows.map((row, index) => [row.track.id, index]));
  return clipRects.flatMap((item) => {
    const index = rowIndex.get(item.clip.track_id);
    return index !== undefined && index >= fromRow && index <= toRow &&
      item.x < rect.x + rect.width && item.x + item.width > rect.x
      ? [item.clip.clip_id]
      : [];
  });
}

/**
 * Compute the visual position of a moved clip during drag.
 * 剪映式拖拽：片段 1:1 跟随鼠标（允许视觉上压过邻居），无吸附无钳制。
 * 磁吸吸附 + 无重叠钳制在松手时由 finishInteraction 完成。
 */
export function ghostPosition(
  clips: TimelineClip[],
  clip: TimelineClip,
  targetStartUs: number,
  targetTrackId?: string,
): { startUs: number; endUs: number } {
  const duration = clipDuration(clip);
  const rawStart = Math.max(0, targetStartUs);
  return { startUs: rawStart, endUs: rawStart + duration };
}

// ── Timeline Round 4 — scrolling, anchored zoom, grid snap, group move ──────

/** Total scrollable content width in pixels (gutter + timeline; ends at the
 *  last clip's end — 标尺/滚动不超过素材片段的长度，到终点即不能再往后拖). */
export function contentWidthPx(view: TimelineViewState, totalUs: number): number {
  return view.headerWidth + (totalUs / 1_000_000) * view.pixelsPerSecond;
}

/** Scrollable range for the current view. */
export function scrollBounds(
  view: TimelineViewState,
  totalUs: number,
  viewportWidth: number,
): { contentWidthPx: number; maxScrollX: number } {
  const content = contentWidthPx(view, totalUs);
  return { contentWidthPx: content, maxScrollX: Math.max(0, content - viewportWidth) };
}

/** Clamp a scroll offset into [0, maxScrollX]. */
export function clampScrollX(scrollX: number, maxScrollX: number): number {
  return Math.max(0, Math.min(maxScrollX, scrollX));
}

/** The longest view OpenFilm allows for a project, in microseconds. */
export function maxTimelineViewUs(totalUs: number): number {
  return Math.max(Math.max(0, totalUs) * TIMELINE_MAX_VIEW_FACTOR, TIMELINE_MAX_VIEW_FLOOR_US);
}

/** Relative zoom limits. Empty timelines are fixed at the 18s OpenFilm opening view. */
export function timelineZoomLimits(totalUs: number): { min: number; max: number } {
  if (!(totalUs > 0)) return { min: 0.25, max: 0.25 };
  const basisUs = totalUs;
  return {
    min: basisUs / maxTimelineViewUs(totalUs),
    max: basisUs / TIMELINE_MIN_VIEW_US,
  };
}

export function clampTimelineZoom(zoom: number, totalUs: number): number {
  const { min, max } = timelineZoomLimits(totalUs);
  return Math.max(min, Math.min(max, Number.isFinite(zoom) ? zoom : TIMELINE_ZOOM_DEFAULT));
}

export function stepTimelineZoom(zoom: number, totalUs: number, direction: -1 | 1): number {
  return clampTimelineZoom(zoom * TIMELINE_ZOOM_STEP ** direction, totalUs);
}

/** Time displayed across the timeline viewport for a relative project zoom. */
export function timelineViewSpanUs(totalUs: number, zoom: number): number {
  if (!(totalUs > 0)) return TIMELINE_EMPTY_VIEW_US;
  return Math.max(TIMELINE_MIN_VIEW_US, Math.min(maxTimelineViewUs(totalUs), totalUs / clampTimelineZoom(zoom, totalUs)));
}

/** Convert relative zoom to pixels per second. `timeWidthPx` excludes the cover rail. */
export function timelineZoomToPps(totalUs: number, timeWidthPx: number, zoom: number): number {
  if (!(timeWidthPx > 0)) return 0;
  return timeWidthPx * 1_000_000 / timelineViewSpanUs(totalUs, zoom);
}

/** Inverse of timelineZoomToPps for the current project and viewport width. */
export function timelinePpsToZoom(totalUs: number, timeWidthPx: number, pps: number): number {
  if (!(timeWidthPx > 0) || !(pps > 0)) return TIMELINE_ZOOM_DEFAULT;
  if (!(totalUs > 0)) return TIMELINE_ZOOM_DEFAULT;
  return clampTimelineZoom(totalUs * pps / (timeWidthPx * 1_000_000), totalUs);
}

/** Match OpenFilm when the timeline's content span changes: preserve the
 * visible time scale for edits to an existing timeline, and for a first clip
 * that fits inside the empty 18s opening view. Long first loads keep the
 * project-relative default zoom. */
export function timelineZoomAfterDurationChange(
  previousTotalUs: number,
  nextTotalUs: number,
  timeWidthPx: number,
  projectZoom: number,
): number {
  if (!(nextTotalUs > 0) || !(timeWidthPx > 0)) return clampTimelineZoom(projectZoom, nextTotalUs);
  const preserveScale = previousTotalUs >= 1_000_000
    || (previousTotalUs <= 0 && nextTotalUs <= TIMELINE_EMPTY_VIEW_US);
  if (!preserveScale) return clampTimelineZoom(projectZoom, nextTotalUs);
  const previousPps = timelineZoomToPps(previousTotalUs, timeWidthPx, projectZoom);
  return timelinePpsToZoom(nextTotalUs, timeWidthPx, previousPps);
}

export function timelineZoomToSlider(zoom: number, totalUs: number): number {
  const limits = timelineZoomLimits(totalUs);
  if (limits.max <= limits.min) return 0;
  return Math.log(clampTimelineZoom(zoom, totalUs) / limits.min) / Math.log(limits.max / limits.min);
}

export function timelineSliderToZoom(position: number, totalUs: number): number {
  const limits = timelineZoomLimits(totalUs);
  return limits.min * (limits.max / limits.min) ** Math.max(0, Math.min(1, position));
}

/**
 * Zoom keeping the timeline time under `anchorX` fixed while applying OpenFilm's
 * project-relative zoom limits. `viewportWidth` is the canvas viewport (the
 * fixed 132px track head is outside it); the 51px cover rail is removed once
 * here to get the actual time width.
 */
export function zoomAtAnchor(
  view: TimelineViewState,
  anchorX: number,
  viewportWidth: number,
  factor: number,
  totalUs: number,
): TimelineViewState {
  const anchorUs = xToTime(anchorX, view);
  const timeWidth = Math.max(0, viewportWidth - view.headerWidth);
  const currentZoom = timelinePpsToZoom(totalUs, timeWidth, view.pixelsPerSecond);
  const projectZoom = clampTimelineZoom(currentZoom * factor, totalUs);
  const pps = timelineZoomToPps(totalUs, timeWidth, projectZoom);
  const rawScrollX = view.headerWidth + (anchorUs / 1_000_000) * pps - anchorX;
  const { maxScrollX } = scrollBounds({ ...view, pixelsPerSecond: pps }, totalUs, viewportWidth);
  return { ...view, projectZoom, pixelsPerSecond: pps, scrollX: clampScrollX(rawScrollX, maxScrollX) };
}

/**
 * Grid snap candidates (µs), step chosen from the current zoom level:
 * frame grid at high zoom, then 0.5s / 1s / 2s / 5s / 10s.
 */
export function gridSnapCandidates(
  view: TimelineViewState,
  totalUs: number,
  frameRate: number,
): number[] {
  if (totalUs <= 0) return [];
  const pps = view.pixelsPerSecond;
  const stepUs =
    pps >= 200
      ? 1_000_000 / Math.max(1, frameRate)
      : pps >= 100
        ? 500_000
        : pps >= 50
          ? 1_000_000
          : pps >= 25
            ? 2_000_000
            : pps >= 10
              ? 5_000_000
              : 10_000_000;
  const count = Math.min(2000, Math.floor(totalUs / stepUs));
  const candidates: number[] = [];
  for (let i = 0; i <= count; i += 1) candidates.push(Math.round(i * stepUs));
  return candidates;
}

/** Build the same clock-anchored ruler grid as OpenFilm's rulerSteps/rulerMarks. */
export function computeTimelineTicks(
  pps: number,
  headerWidth: number,
  fpsNum: number,
  fpsDen: number,
  scrollX: number,
  viewportWidth = 800,
): TickMark[] {
  if (!(pps > 0)) return [];
  const safeNum = Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 30;
  const safeDen = Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1;
  const rate = safeNum / safeDen;
  const nominalFps = Math.max(1, Math.round(safeNum / safeDen));
  const secondsLadder = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const frameStepLadder = (from: number): number[] => {
    const frames: number[] = [];
    for (let step = from; step < nominalFps; step += 1) {
      if (nominalFps % step === 0) frames.push(step);
    }
    return [...frames, ...secondsLadder.map(seconds => seconds * nominalFps)];
  };
  const labelSteps = frameStepLadder(2).filter(frames =>
    frames >= nominalFps || (frames / nominalFps) * pps >= 150);
  const labelFrames = labelSteps.find(frames => (frames / nominalFps) * pps >= 96)
    ?? labelSteps.at(-1)!;
  const tickLadder = frameStepLadder(1);
  const wantedTickFrames = tickLadder.find(frames => (frames / nominalFps) * pps >= 12)
    ?? tickLadder.at(-1)!;
  const tickFrames = labelFrames % wantedTickFrames === 0
    ? wantedTickFrames
    : tickLadder.find(frames => frames >= wantedTickFrames && labelFrames % frames === 0) ?? labelFrames;
  const fromMs = Math.max(0, ((scrollX - headerWidth) / pps) * 1000);
  const toMs = ((scrollX - headerWidth + viewportWidth) / pps) * 1000;
  const formatTime = (ms: number): string => {
    const totalSeconds = ms / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };
  const formatLabel = (ms: number): string => {
    const seconds = Math.max(0, Math.floor(ms / 1000 + 1e-6));
    const frames = Math.round(ms * rate / 1000) - Math.ceil(seconds * rate - 1e-9);
    return ms - seconds * 1000 >= 0.5 && frames > 0 ? `${frames}f` : formatTime(ms);
  };
  const ticks: TickMark[] = [];
  const addTick = (ms: number, labeled: boolean) => {
    ticks.push({
      x: headerWidth + ms / 1000 * pps - scrollX,
      label: labeled ? formatLabel(ms) : "",
      major: labeled,
    });
  };
  if (tickFrames >= nominalFps) {
    const tickSeconds = Math.max(1, Math.round(tickFrames / nominalFps));
    const labelSeconds = Math.max(1, Math.round(labelFrames / nominalFps));
    for (let second = Math.floor(Math.max(0, fromMs) / 1000 / tickSeconds) * tickSeconds;
      second * 1000 <= toMs; second += tickSeconds) {
      addTick(second * 1000, second % labelSeconds === 0);
    }
  } else {
    const labelSeconds = labelFrames >= nominalFps ? Math.max(1, Math.round(labelFrames / nominalFps)) : 0;
    for (let second = Math.floor(Math.max(0, fromMs) / 1000); second * 1000 <= toMs; second += 1) {
      const firstFrame = Math.ceil(second * rate - 1e-9);
      const frameCount = Math.ceil((second + 1) * rate - 1e-9) - firstFrame;
      for (let offset = 0; offset < frameCount; offset += tickFrames) {
        const ms = offset === 0 ? second * 1000 : ((firstFrame + offset) * 1000) / rate;
        if (ms < fromMs) continue;
        if (ms > toMs) break;
        addTick(ms, labelSeconds ? offset === 0 && second % labelSeconds === 0 : offset % labelFrames === 0);
      }
    }
  }
  return ticks;
}

/**
 * Move a group of clips by `deltaUs`, keeping relative offsets and clamping
 * the group as a whole at the timeline origin (A1 free-position semantics).
 */
export function resolveGroupMove(
  startsUs: number[],
  deltaUs: number,
): { targetStartsUs: number[]; actualDeltaUs: number } {
  if (startsUs.length === 0) return { targetStartsUs: [], actualDeltaUs: 0 };
  const minStart = Math.min(...startsUs);
  const anchor = Math.max(0, minStart + deltaUs);
  const actualDeltaUs = anchor - minStart;
  return {
    targetStartsUs: startsUs.map((startUs) => startUs + actualDeltaUs),
    actualDeltaUs,
  };
}

/**
 * Per-frame auto-scroll step while dragging near the canvas edge (ported from
 * OpenCut classic's edge auto-scroll pattern, MIT): zero in the middle, grows
 * towards ±MAX as the pointer approaches either edge.
 */
export function dragEdgeAutoScrollStep(pointerX: number, viewportWidth: number): number {
  const leftDist = pointerX;
  const rightDist = viewportWidth - pointerX;
  if (leftDist < EDGE_AUTOSCROLL_ZONE_PX) {
    const ratio = Math.max(0, 1 - leftDist / EDGE_AUTOSCROLL_ZONE_PX);
    return -Math.ceil(EDGE_AUTOSCROLL_MIN_STEP_PX + (EDGE_AUTOSCROLL_MAX_STEP_PX - EDGE_AUTOSCROLL_MIN_STEP_PX) * ratio);
  }
  if (rightDist < EDGE_AUTOSCROLL_ZONE_PX) {
    const ratio = Math.max(0, 1 - rightDist / EDGE_AUTOSCROLL_ZONE_PX);
    return Math.ceil(EDGE_AUTOSCROLL_MIN_STEP_PX + (EDGE_AUTOSCROLL_MAX_STEP_PX - EDGE_AUTOSCROLL_MIN_STEP_PX) * ratio);
  }
  return 0;
}

// ── Timeline Round 5 — volume line, fit zoom, V1 free-position clamps ───────

// ── 剪映式片段布局 ────────────────────────────────────────────────────────────

/** 剪映式片段顶部名称条高度（px）：名称 + 时长码。绘制与命中测试共用。 */
// 参照名称条 15px（openfilm Timeline.tsx:227 INFO_H = 15）；原 16px。
export const CLIP_HEADER_H = 15;

/**
 * 片段内音频（波形/分贝线）所在区域：
 * - 纯音频片段 = 名称条以下的整个区域（占比作用于波形振幅）；
 * - 视频片段 = 底部原声带，高度 = 名称条以下区域的 ratio（剪映式：30% 时
 *   是贴底的窄带，100% 时撑满名称条以下全部；关闭原声时为 null）。
 */
export function clipAudioBand(
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  ratio = 0.3,
): { top: number; height: number } | null {
  const isAudio = clip.asset_kind === "audio";
  const hasBand = clip.asset_kind === "video" && clip.audio.enabled && rect.width > 20;
  if (!isAudio && !hasBand) return null;
  const headerH = Math.min(CLIP_HEADER_H, rect.height);
  const area = Math.max(0, rect.height - headerH);
  if (isAudio) return { top: rect.y + headerH, height: Math.max(3, area) };
  // OpenFilm keeps a 15px minimum sound band, then grows it with the clip row.
  const bandH = Math.max(15, Math.round(area * Math.max(0.1, Math.min(1, ratio))));
  return { top: rect.y + rect.height - bandH, height: Math.max(6, bandH) };
}

/** Gain range (dB) exposed by the draggable clip volume line. */
export const VOLUME_MIN_DB = -30;
export const VOLUME_MAX_DB = 12;
/** Tolerance for grabbing the volume line, in pixels. T11 参照 Timeline.tsx:3434：7px 命中带。 */
export const VOLUME_HIT_PX = 7;
/** 音量线上下留白（px），保证线/点不贴 band 边缘。 */
const VOLUME_BAND_PAD = 4;

/**
 * Map a gain value onto the clip's audio band: +12 dB sits near the band top,
 * −30 dB sits near the band bottom (剪映式分贝线在音频区域内移动)。
 */
export function volumeToY(gainDb: number, band: { top: number; height: number }): number {
  const clamped = Math.max(VOLUME_MIN_DB, Math.min(VOLUME_MAX_DB, gainDb));
  const norm = (clamped - VOLUME_MIN_DB) / (VOLUME_MAX_DB - VOLUME_MIN_DB);
  const usable = Math.max(1, band.height - VOLUME_BAND_PAD * 2);
  return band.top + VOLUME_BAND_PAD + (1 - norm) * usable;
}

/** Inverse of volumeToY, clamped to the visible band. */
export function yToVolume(y: number, band: { top: number; height: number }): number {
  const usable = Math.max(1, band.height - VOLUME_BAND_PAD * 2);
  const norm = Math.max(0, Math.min(1, 1 - (y - band.top - VOLUME_BAND_PAD) / usable));
  return VOLUME_MIN_DB + norm * (VOLUME_MAX_DB - VOLUME_MIN_DB);
}

/**
 * Top-most audio-carrying clip whose volume line passes within VOLUME_HIT_PX
 * of (x, y). Locked clips are excluded via the predicate.
 */
export function hitTestVolumeLine(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
  isLocked: (clipId: TimelineClipId) => boolean,
  ratio = 0.3,
): TimelineClipId | null {
  for (const rect of clipRects) {
    const clip = rect.clip;
    const hasAudio =
      (clip.asset_kind === "video" || clip.asset_kind === "audio") && clip.audio.enabled;
    if (!hasAudio || rect.width < 30 || isLocked(clip.clip_id)) continue;
    const band = clipAudioBand(clip, rect, ratio);
    if (!band) continue;
    const lineY = volumeToY(clip.audio.gain_db, band);
    if (
      Math.abs(y - lineY) <= VOLUME_HIT_PX &&
      x >= rect.x + 4 &&
      x <= rect.x + rect.width - 4
    ) {
      return clip.clip_id;
    }
  }
  return null;
}

// ── 剪映式拖放落点解析（拖动预览与松手落位共用同一套逻辑，保证所见即所得） ──

/** 拖动落点解析结果。 */
export interface MoveTargetResolution {
  /** 拖动片段的落点时间（µs）。 */
  startUs: number;
  /** 落点轨道。 */
  trackId: string;
  /** 落点方式：free = 空档/贴齐邻居；before/after = 目标片段前/后方；swap = 与目标片段交换位置；append = 目标轨尾部。 */
  mode: "free" | "before" | "after" | "swap" | "append";
  /** swap 时被交换片段的去向。 */
  displaced?: { clipId: TimelineClipId; trackId: string; startUs: number };
}

/**
 * 解析一次拖动的最终落位。拖动途中用它的返回值画落点预览，
 * 松手时用同一函数的结果提交 position_clip —— 预览即结果，自动吸附。
 *
 * 规则（剪映式）：
 * - 同轨拖动：钳制到最近的不重叠位置（贴齐邻居边缘，允许空隙）；
 * - 跨轨落到空档：原地放置；
 * - 跨轨压住目标轨片段 C：按光标在 C 上的左右半边优先"放在 C 前方/后方"
 *   （该空档容得下时），否则尝试与 C 交换位置（C 能无损放进原拖动位时），
 *   再不行放到目标轨内容末尾。
 */
export function resolveMoveTarget(
  clips: TimelineClip[],
  clip: TimelineClip,
  rawStartUs: number,
  targetTrackId?: string,
  pointerRatio = 0,
): MoveTargetResolution {
  const durationUs = clipDuration(clip);
  const trackId = targetTrackId ?? clip.track_id;
  const rawStart = Math.max(0, rawStartUs);
  const fitsAt = (start: number, track: string, ignoreIds: Set<string>) =>
    start >= 0 &&
    !clips.some(
      (other) =>
        other.track_id === track &&
        !ignoreIds.has(other.clip_id) &&
        start < other.timeline_end_us &&
        other.timeline_start_us < start + durationUs,
    );

  if (trackId !== clip.track_id) {
    const overlapped = clips.find(
      (other) =>
        other.track_id === trackId &&
        other.clip_id !== clip.clip_id &&
        rawStart < other.timeline_end_us &&
        other.timeline_start_us < rawStart + durationUs,
    );
    if (overlapped) {
      const slotBefore = overlapped.timeline_start_us - durationUs;
      const slotAfter = overlapped.timeline_end_us;
      const ignoreDragged = new Set([clip.clip_id]);
      const preferBefore = pointerRatio < 0.5;
      const slots: Array<[number, "before" | "after"]> = preferBefore
        ? [[slotBefore, "before"], [slotAfter, "after"]]
        : [[slotAfter, "after"], [slotBefore, "before"]];
      for (const [slot, mode] of slots) {
        if (fitsAt(slot, trackId, ignoreDragged)) {
          return { startUs: Math.max(0, slot), trackId, mode };
        }
      }
      // 前后方都放不下：尝试交换（对端回到拖动片段的原位）。
      const overlappedDuration = clipDuration(overlapped);
      const swapFits = !clips.some(
        (other) =>
          other.track_id === clip.track_id &&
          other.clip_id !== clip.clip_id &&
          other.clip_id !== overlapped.clip_id &&
          clip.timeline_start_us < other.timeline_end_us &&
          other.timeline_start_us < clip.timeline_start_us + overlappedDuration,
      );
      if (swapFits) {
        return {
          startUs: overlapped.timeline_start_us,
          trackId,
          mode: "swap",
          displaced: { clipId: overlapped.clip_id, trackId: clip.track_id, startUs: clip.timeline_start_us },
        };
      }
      const tail = clips
        .filter((other) => other.track_id === trackId && other.clip_id !== clip.clip_id)
        .reduce((max, other) => Math.max(max, other.timeline_end_us), 0);
      return { startUs: tail, trackId, mode: "append" };
    }
    return { startUs: rawStart, trackId, mode: "free" };
  }

  // 同轨：最近合法位置（允许视觉上压过邻居，松手贴齐）。
  return {
    startUs: clampMoveStart(
      clips.filter((other) => other.track_id === trackId && other.clip_id !== clip.clip_id),
      durationUs,
      rawStart,
    ),
    trackId,
    mode: "free",
  };
}

/** Pixels-per-second that fits the whole timeline into the viewport. */
export function fitZoomPps(totalUs: number, viewportWidth: number, headerWidth: number): number {
  return timelineZoomToPps(totalUs, Math.max(0, viewportWidth - headerWidth), TIMELINE_ZOOM_DEFAULT);
}

/** Test whether translating every member by `deltaUs` keeps the group clear
 * of all obstacle clips (touching boundaries are allowed). */
function groupDeltaFeasible(
  members: TimelineClip[],
  obstacles: TimelineClip[],
  deltaUs: number,
): boolean {
  return !members.some((member) =>
    obstacles.some(
      (obstacle) =>
        member.timeline_start_us + deltaUs < obstacle.timeline_end_us &&
        obstacle.timeline_start_us < member.timeline_end_us + deltaUs,
    ),
  );
}

/**
 * 同轨组移动：把整组平移量钳制到"组内成员与静止片段均不重叠"的最近合法值。
 * 组作为刚体平移（保持成员相对位置）；候选值取每个"成员×障碍"冲突区间的
 * 两个端点（端点表示贴齐，合法）与时间原点下界。
 */
export function clampGroupDelta(
  members: TimelineClip[],
  obstacles: TimelineClip[],
  rawDeltaUs: number,
): number {
  if (members.length === 0) return rawDeltaUs;
  const minStart = Math.min(...members.map((member) => member.timeline_start_us));
  const lowerBound = -minStart;
  const candidates = new Set<number>([lowerBound, rawDeltaUs]);
  for (const member of members) {
    for (const obstacle of obstacles) {
      candidates.add(obstacle.timeline_start_us - member.timeline_end_us);
      candidates.add(obstacle.timeline_end_us - member.timeline_start_us);
    }
  }
  let best = Math.max(lowerBound, rawDeltaUs);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate < lowerBound || !groupDeltaFeasible(members, obstacles, candidate)) continue;
    const distance = Math.abs(candidate - rawDeltaUs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
