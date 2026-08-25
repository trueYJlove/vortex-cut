/**
 * Timeline Phase 1 — UI-specific rendering types.
 * Extends the canonical contract types with pixel-space computed values.
 */
import type { TimelineClip, TimelineCaption, TimelineDocument, AssetKind } from "@aivideo/contracts";

/** Viewport / view state for the timeline canvas. */
export interface TimelineViewState {
  /** Pixels per microsecond-second (i.e. pixels per second of timeline time). */
  pixelsPerSecond: number;
  /** Horizontal scroll offset in pixels. */
  scrollX: number;
  /** Height of each track row in pixels. */
  trackHeight: number;
  /** Width of the left header gutter in pixels. */
  headerWidth: number;
  /** Height of the ruler strip in pixels. */
  rulerHeight: number;
}

/** Computed pixel rectangle for rendering a clip on canvas. */
export interface ClipRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  clip: TimelineClip;
  index: number;
}

/** Computed pixel rectangle for rendering a caption on canvas. */
export interface CaptionRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  caption: TimelineCaption;
}

/** A single tick mark on the time ruler. */
export interface TickMark {
  x: number;
  label: string;
  major: boolean;
}

/** Asset media lookup entry (mirrors App.tsx assetMedia prop shape). */
export interface AssetMediaEntry {
  asset_id: string;
  media_url: string | null;
  kind: AssetKind;
}

/** Selection state (mirrors App.tsx Selection type). */
export type TimelineSelection =
  | { kind: "clip"; id: string }
  | { kind: "caption"; id: string }
  | null;

export const DEFAULT_VIEW_STATE: TimelineViewState = {
  pixelsPerSecond: 60,
  scrollX: 0,
  trackHeight: 64,
  headerWidth: 120,
  rulerHeight: 28,
};

export const ZOOM_MIN_PPS = 4;
export const ZOOM_MAX_PPS = 400;