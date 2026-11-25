import type { TimelineCaption } from "@aivideo/contracts";
import type { TrackRowLayout } from "../../geometry.js";
import type {
  CaptionRenderRect,
  ClipRenderRect,
  TimelineHover,
  TimelineInteraction,
  TimelineSelection,
  TimelineViewState,
} from "../../types.js";
import { filterVisibleRects } from "../../viewport-index.js";
import type { WaveformCache } from "../../waveform-cache.js";
import {
  drawCaptionsAndKeyframesLayer,
  drawClipsLayer,
  type ClipDrawEnv,
  type PendingKeepPreview,
} from "./clips-layer.js";
import { indexCachedSourceFrames, type FilmstripSprite } from "./filmstrip-index.js";
import { drawInteractionOverlays } from "./overlays-layer.js";
import { cssColor, drawScrollbar } from "./theme.js";

export function drawTimelineFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  trackRows: TrackRowLayout[],
  clipRects: ClipRenderRect[],
  captionRects: CaptionRenderRect[],
  captions: TimelineCaption[],
  selection: TimelineSelection,
  speedModeActive: boolean,
  interaction: TimelineInteraction | null,
  hover: TimelineHover,
  playheadUs: number,
  totalUs: number,
  lockedElements: string[],
  _clipNames: Map<string, string>,
  _frameRate: number,
  pendingKeep: PendingKeepPreview | null,
  thumbnailCache?: Map<string, HTMLCanvasElement>,
  sprites?: ReadonlyMap<string, FilmstripSprite>,
  waveformCache?: WaveformCache | null,
  waveformRatio?: number,
  viewportHeight?: number,
  contentTopY?: number,
  contentScrollTop?: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const cachedSourceFrames = indexCachedSourceFrames(thumbnailCache);
  const topY = contentTopY ?? 0;
  const scrollTopRaw = contentScrollTop ?? 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, -topY * dpr);
  ctx.clearRect(0, topY, width, height);

  // Canvas background
  ctx.fillStyle = cssColor("--tl-canvas-bg", "#161618");
  ctx.fillRect(0, topY, width, height);

  const selectedTrackId = selection?.kind === "clip"
    ? clipRects.find((rect) => rect.clip.clip_id === selection.id)?.clip.track_id
    : undefined;
  const laneTone = (row: (typeof trackRows)[number]): string => {
    if (row.track.id === selectedTrackId) return cssColor("--tl-lane-on", "#232323");
    return cssColor("--tl-row", "#1d1d1d");
  };
  for (const row of trackRows) {
    if (row.y + row.height <= topY || row.y >= topY + height) continue;
    ctx.fillStyle = laneTone(row);
    ctx.fillRect(view.headerWidth, row.y, Math.max(0, width - view.headerWidth), row.height);
  }

  // Timeline content scrolls behind the fixed cover column.
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.headerWidth, topY, Math.max(0, width - view.headerWidth), height);
  ctx.clip();

  const viewport = height > 0
    ? { left: 0, right: width, top: topY, bottom: topY + height }
    : null;
  const drawClipRects = viewport ? filterVisibleRects(clipRects, viewport, 0) : [];
  const drawCaptionRects = viewport ? filterVisibleRects(captionRects, viewport, 0) : [];

  const selectedIds = selection?.kind === "clip"
    ? [selection.id]
    : selection?.kind === "clips"
      ? selection.ids
      : [];

  const hiddenTrackIds = new Set(
    trackRows.filter((row) => row.track.hidden).map((row) => row.track.id),
  );

  const movingId = interaction?.kind === "move" && !interaction.copyOnStart ? interaction.clipId : null;
  const movingClip = movingId ? clipRects.find((item) => item.clip.clip_id === movingId)?.clip : undefined;
  const movePreviewPositions = interaction?.kind === "move" && !interaction.copyOnStart && !interaction.dragPlan?.reason
    ? interaction.dragPlan?.placements ?? []
    : [];
  const movePreviewFollowerIds = new Set(
    movePreviewPositions
      .filter((position) => position.clipId !== movingId && clipRects.some((rect) => {
        const clip = rect.clip;
        return clip.clip_id === position.clipId
          && (clip.track_id !== position.trackId || clip.timeline_start_us !== position.startUs);
      }))
      .map((position) => position.clipId),
  );

  const env: ClipDrawEnv = {
    ctx,
    width,
    height,
    view,
    trackRows,
    selectedIds,
    speedModeActive,
    interaction,
    hover,
    lockedElements,
    hiddenTrackIds,
    movingId,
    movingClip,
    pendingKeep,
    thumbnailCache,
    cachedSourceFrames,
    sprites,
    waveformCache,
    waveformRatio,
  };

  drawClipsLayer(env, clipRects, drawClipRects, movePreviewPositions, movePreviewFollowerIds);
  drawCaptionsAndKeyframesLayer(ctx, view, clipRects, drawCaptionRects, selection);
  drawInteractionOverlays(
    env,
    clipRects,
    captions,
    playheadUs,
    interaction,
    trackRows,
    view,
    width,
    height,
    waveformRatio,
  );

  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const viewportBottom = Math.min(height, scrollTopRaw + (viewportHeight ?? height) - topY);
  drawScrollbar(ctx, width, viewportBottom, view, totalUs);
}
