import type { TimelineClip } from "@aivideo/contracts";
import { timeToX, xToTime } from "../../geometry.js";
import type { ClipRenderRect, TimelineViewState } from "../../types.js";
import { CLIP_ROW_INSET } from "./theme.js";

/** Legacy frame-count tiers used by reverse playback strips and sprite fallbacks. */
const FRAME_COUNT_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 24, 29, 35, 42, 50, 58, 64];

/** Thumbnail cell target width (px), shared by request, render, and eviction paths. */
export const THUMB_CELL_PX = 80;

/** Legacy reverse-strip cache tier. Forward strips use a source-time ladder instead. */
export function frameTierFor(clipDurationUs: number, pixelsPerSecond: number): number {
  if (clipDurationUs <= 0) return 1;
  return quantizeFrameCount(Math.round(((clipDurationUs / 1_000_000) * pixelsPerSecond) / THUMB_CELL_PX));
}

/** Keep cached cells tied to the source window, even while zoom and placement change. */
export function filmstripCachePrefix(clip: TimelineClip): string {
  return [
    clip.clip_id,
    clip.asset_id,
    clip.source_start_us,
    clip.source_end_us,
    clip.speed_milli ?? 1000,
    Number(Boolean(clip.reverse_playback)),
    clip.timeline_end_us - clip.timeline_start_us,
  ].join(":");
}

export function cachedFilmstripFallback<T>(
  cache: ReadonlyMap<string, T>,
  prefix: string,
  count: number,
  index: number,
): T | undefined {
  const position = (index + 0.5) / count;
  let closest: T | undefined;
  let minDistance = Infinity;
  for (const tier of FRAME_COUNT_STEPS) {
    if (tier === count) continue;
    const cell = Math.min(tier - 1, Math.floor(position * tier));
    const distance = Math.abs((cell + 0.5) / tier - position);
    if (distance >= minDistance) continue;
    const frame = cache.get(`${prefix}:${tier}:${cell}`);
    if (frame !== undefined) {
      closest = frame;
      minDistance = distance;
    }
  }
  return closest ?? cache.get(`${prefix}:preview`);
}

export function quantizeFrameCount(raw: number): number {
  const capped = Math.max(1, Math.min(64, raw));
  let best = FRAME_COUNT_STEPS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of FRAME_COUNT_STEPS) {
    const distance = Math.abs(step - capped);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = step;
    }
  }
  return best;
}

/** Source timestamp (sec) for the center of filmstrip cell i. */
export function cellSourceTimeSec(
  clip: {
    timeline_start_us: number;
    timeline_end_us: number;
    source_start_us?: number | null;
    source_end_us?: number | null;
    speed_milli?: number | null;
    reverse_playback?: boolean | null;
  },
  index: number,
  frameCount: number,
): number {
  const timelineDurUs = clip.timeline_end_us - clip.timeline_start_us;
  const count = Math.max(1, frameCount);
  const fromUs = clip.timeline_start_us + (index * timelineDurUs) / count;
  const toUs = clip.timeline_start_us + ((index + 1) * timelineDurUs) / count;
  const offsetUs = (fromUs + toUs) / 2 - clip.timeline_start_us;
  const speed = (clip.speed_milli ?? 1000) / 1000;
  const srcUs = clip.reverse_playback
    ? (clip.source_end_us ?? 0) - offsetUs * speed
    : (clip.source_start_us ?? 0) + offsetUs * speed;
  return Math.max(0, srcUs) / 1_000_000;
}

const THUMB_TIME_LADDER = [1, 2, 2.5, 5] as const;

/** OpenFilm keeps thumbnail cells at 80 CSS px and snaps source seeks to this ladder. */
export function thumbnailStepMs(rawMs: number): number {
  if (!(rawMs > 0) || !Number.isFinite(rawMs)) return rawMs;
  let scale = 10 ** Math.floor(Math.log10(rawMs));
  for (;;) {
    for (const factor of THUMB_TIME_LADDER) {
      const step = factor * scale;
      if (step >= rawMs - 1e-9) return step;
    }
    scale *= 10;
  }
}

export interface FilmstripSprite {
  bitmap: ImageBitmap;
  stepMs: number;
  cellW: number;
  cellH: number;
  count: number;
}

export interface CachedSourceFrame {
  timeMs: number;
  canvas: HTMLCanvasElement;
}

export function indexCachedSourceFrames(
  cache?: Map<string, HTMLCanvasElement>,
): Map<string, CachedSourceFrame[]> {
  const result = new Map<string, CachedSourceFrame[]>();
  if (!cache) return result;
  for (const [key, canvas] of cache) {
    const marker = key.lastIndexOf(":source:");
    if (marker < 0) continue;
    const timeMs = Number(key.slice(marker + ":source:".length));
    if (!Number.isFinite(timeMs)) continue;
    const prefix = key.slice(0, marker);
    const frames = result.get(prefix) ?? [];
    frames.push({ timeMs, canvas });
    result.set(prefix, frames);
  }
  for (const frames of result.values()) frames.sort((a, b) => a.timeMs - b.timeMs);
  return result;
}

export function nearestSourceFrame(
  frames: readonly CachedSourceFrame[],
  targetMs: number,
): HTMLCanvasElement | undefined {
  if (!frames.length) return undefined;
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid]!.timeMs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  const before = frames[Math.max(0, lo - 1)];
  const after = frames[Math.min(frames.length - 1, lo)];
  if (!before) return after?.canvas;
  if (!after) return before.canvas;
  return targetMs - before.timeMs <= after.timeMs - targetMs ? before.canvas : after.canvas;
}

export interface FilmstripOverlayCell {
  key: string;
  x: number;
  width: number;
  height: number;
  source: CanvasImageSource;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface FilmstripOverlayGroup {
  clipId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  filter?: string;
  cells: FilmstripOverlayCell[];
}

/**
 * Build only the filmstrip cells visible in the canvas viewport.
 */
export function buildFilmstripOverlayGroups(
  clipRects: readonly ClipRenderRect[],
  view: TimelineViewState,
  viewport: { top: number; bottom: number; width: number },
  cache: Map<string, HTMLCanvasElement>,
  sprites: ReadonlyMap<string, FilmstripSprite>,
  hiddenTrackIds: ReadonlySet<string>,
): FilmstripOverlayGroup[] {
  if (view.pixelsPerSecond <= 0) return [];
  const framesByPrefix = indexCachedSourceFrames(cache);
  const groups: FilmstripOverlayGroup[] = [];
  const infoHeight = 15; // OpenFilm Timeline.tsx INFO_H
  for (const sourceRect of clipRects) {
    const clip = sourceRect.clip;
    if (clip.asset_kind !== "video" && clip.asset_kind !== "image") continue;
    if (
      sourceRect.width <= 10
      || sourceRect.x + sourceRect.width < view.headerWidth - THUMB_CELL_PX
      || sourceRect.x > viewport.width + THUMB_CELL_PX
    ) {
      continue;
    }
    const clipHeight = Math.max(4, sourceRect.height - CLIP_ROW_INSET * 2);
    const clipY = sourceRect.y + CLIP_ROW_INSET;
    if (clipY + clipHeight <= viewport.top || clipY >= viewport.bottom) continue;

    const contentLeft = sourceRect.x + view.scrollX;
    const x = Math.round(contentLeft) - view.scrollX;
    const right = Math.round(contentLeft + sourceRect.width) - view.scrollX;
    const width = Math.max(1, right - x - 1);
    const height = clipHeight;
    const soundBandHeight = clip.asset_kind === "video"
      ? Math.max(15, Math.round((height - infoHeight) * 0.3))
      : 0;
    const bodyHeight = Math.max(0, height - infoHeight - soundBandHeight);
    if (bodyHeight <= 0) continue;

    const clipDurationUs = clip.timeline_end_us - clip.timeline_start_us;
    if (clipDurationUs <= 0) continue;
    const speed = Math.max(0.001, (clip.speed_milli ?? 1000) / 1000);
    const sourceStartUs = Math.max(0, clip.source_start_us ?? 0);
    const sourceEndUs = Math.max(sourceStartUs, clip.source_end_us ?? sourceStartUs + clipDurationUs);
    const prefix = filmstripCachePrefix(clip);
    const frames = framesByPrefix.get(prefix) ?? [];
    const sprite = sprites.get(clip.asset_id);
    const visibleFromUs = Math.max(clip.timeline_start_us, xToTime(view.headerWidth - THUMB_CELL_PX, view));
    const visibleToUs = Math.min(clip.timeline_end_us, xToTime(viewport.width + THUMB_CELL_PX, view));
    const stepUs = THUMB_CELL_PX * 1_000_000 / view.pixelsPerSecond * speed;
    const sourceAtVisibleFromUs = sourceStartUs + (visibleFromUs - clip.timeline_start_us) * speed;
    const sourceAtVisibleToUs = sourceStartUs + (visibleToUs - clip.timeline_start_us) * speed;
    const firstCell = Math.floor(sourceAtVisibleFromUs / stepUs) - 1;
    const lastCell = Math.ceil(sourceAtVisibleToUs / stepUs) + 1;
    const cells: FilmstripOverlayCell[] = [];
    for (let cell = firstCell; cell <= lastCell; cell += 1) {
      const sourceCellFromUs = cell * stepUs;
      const sourceCellToUs = sourceCellFromUs + stepUs;
      const cellFromUs = clip.timeline_start_us + (sourceCellFromUs - sourceStartUs) / speed;
      const cellToUs = clip.timeline_start_us + (sourceCellToUs - sourceStartUs) / speed;
      if (cellToUs <= clip.timeline_start_us || cellFromUs >= clip.timeline_end_us) continue;
      const cellX = timeToX(cellFromUs, view);
      const cellRight = timeToX(cellToUs, view);
      if (cellRight <= view.headerWidth || cellX >= viewport.width) continue;

      const wantedSourceUs = Math.max(sourceStartUs, Math.min(sourceEndUs, sourceCellFromUs));
      const frame = nearestSourceFrame(frames, Math.round(wantedSourceUs / 1000));
      let source: CanvasImageSource | undefined = frame;
      const sourceX = 0;
      let sourceY = 0;
      let sourceWidth = frame?.width ?? 0;
      let sourceHeight = frame?.height ?? 0;
      if (!source && sprite && sprite.count > 0 && sprite.stepMs > 0) {
        source = sprite.bitmap;
        sourceWidth = sprite.cellW;
        sourceHeight = sprite.cellH;
        sourceY = Math.max(0, Math.min(sprite.count - 1, Math.round(wantedSourceUs / 1000 / sprite.stepMs))) * sprite.cellH;
      }
      if (!source || sourceWidth <= 0 || sourceHeight <= 0) continue;
      cells.push({
        key: `${clip.clip_id}:${cell}:${Math.round(wantedSourceUs / 1000)}`,
        x: cellX - x,
        width: Math.max(1, cellRight - cellX),
        height: bodyHeight,
        source,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
      });
    }
    if (cells.length) {
      groups.push({
        clipId: clip.clip_id,
        x,
        y: clipY + infoHeight,
        width,
        height: bodyHeight,
        filter: hiddenTrackIds.has(clip.track_id) ? "grayscale(1)" : undefined,
        cells,
      });
    }
  }
  return groups;
}
