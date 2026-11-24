/**
 * Timeline Phase 1 — UI-specific rendering types.
 * Extends the canonical contract types with pixel-space computed values.
 */
import type { ActiveTimelineTransition, TimelineClip, TimelineCaption, TimelineClipId, TimelineDocument, AssetKind, TimelineTransition, TimelineTransitionId } from "@aivideo/contracts";
import type { MoveTargetResolution, TimelineDropHit } from "./geometry.js";
import type { ClipDragPlan } from "./clip-drag-plan.js";
import type { AdvancedEditMode, AdvancedEditTarget } from "./advanced-edit.js";

/** Viewport / view state for the timeline canvas. */
export interface TimelineViewState {
  /** Pixels per microsecond-second (i.e. pixels per second of timeline time). */
  pixelsPerSecond: number;
  /** Relative project zoom: 1 fits the project, values above 1 zoom in. */
  projectZoom: number;
  /** Horizontal scroll offset in pixels. */
  scrollX: number;
  /** Height of each track row in pixels. */
  trackHeight: number;
  /** Width of the left header gutter in pixels. */
  headerWidth: number;
  /** Height of the ruler strip in pixels. */
  rulerHeight: number;
}

/** Geometry copied from OpenFilm's Studio timeline chrome. With Solo controls
 *  visible, the fixed track head is 108+24=132px; the canvas owns a separate
 *  51px cover rail. Keeping
 *  the two dimensions independent avoids doubling the track head as a fake
 *  cover rail, which shifted every clip and ruler label by 57px. */
export const TIMELINE_HEAD_EXPANDED_WIDTH = 132;
export const TIMELINE_HEAD_COLLAPSED_WIDTH = 28;
export const TIMELINE_HEAD_EMPTY_WIDTH = 12;
/** Expanded editor head includes the 108px control strip and 24px solo column. */
export const TIMELINE_HEAD_WIDTH = TIMELINE_HEAD_EXPANDED_WIDTH;
export const TIMELINE_COVER_RAIL_WIDTH = 51;
export const TIMELINE_TOOLBAR_HEIGHT = 34;
export const TIMELINE_RULER_HEIGHT = 20;
export const TIMELINE_ZOOM_SLIDER_WIDTH = 78;
export const TIMELINE_ZOOM_DEFAULT = 0.8;
export const TIMELINE_ZOOM_STEP = 1.6;
export const TIMELINE_MIN_VIEW_US = 1_000_000;
export const TIMELINE_EMPTY_VIEW_US = 18_000_000;
export const TIMELINE_MAX_VIEW_FACTOR = 4;
export const TIMELINE_MAX_VIEW_FLOOR_US = 30_000_000;

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

/** Computed pixel rect for a transition marker between two adjacent V1 clips. */
export interface TransitionRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  transition: TimelineTransition;
}

/** Geometry for Core-projected source-fact transitions. Kept separate from
 *  legacy compatibility transition IDs so their edits cannot reach old ops. */
export interface ActiveTransitionRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  transition: ActiveTimelineTransition;
  editable: boolean;
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
  /** 素材文件名（剪映式片段名称条显示用）。 */
  display_name: string;
  duration_us?: number | null;
  /** Source-level audio stream availability; false suppresses empty waveform work. */
  has_audio?: boolean;
}

/** A single, shared decision for native/library asset dragover and drop. */
export interface TimelineAssetDropIntent {
  targetClipId: TimelineClipId | null;
  /** Original pointer row/band, retained so imported files can be re-planned with their probed durations. */
  hitTrackId: string | null;
  hasCoordinates: boolean;
  band: "above" | "body" | "below";
  zone: "before" | "center" | "after" | "lane";
  boundary: "before" | "after" | null;
  trackId: string | "new" | null;
  newTrackKind: "video" | "audio" | null;
  newTrackAnchorId: string | null;
  newTrackSide: "before" | "after" | null;
  mode: "place" | "insert" | "overwrite";
  locked: boolean;
  accepts: boolean;
  /** Frame-snapped pointer time, or the exact clip edge for before/after. */
  atUs: number;
  /** Original pointer timeline time, used when imported media becomes available for final planning. */
  pointerUs: number;
  /** Total ghost length for the dropped run, using OpenFilm's placeholder duration when metadata is unknown. */
  previewDurationUs: number;
  /** In-lane insertion slot resolved from the same snapped time. */
  slot: number;
}

/** Selection state (mirrors App.tsx Selection type). */
export type TimelineSelection =
  | { kind: "clip"; id: string }
  | { kind: "clips"; ids: string[] }
  | { kind: "caption"; id: string }
  | { kind: "transition"; id: string }
  | { kind: "active-transition"; id: string }
  | null;

/** Edge of a clip that can be trimmed. */
export type TrimEdge = "left" | "right";

/** A clip shown at its planned geometry while an OpenFilm speed-edge drag is active. */
export interface SpeedPreviewTarget {
  clipId: TimelineClipId;
  trackId: string;
  startUs: number;
  endUs: number;
  speedMilli: number;
  originalStartUs: number;
  originalEndUs: number;
}

/**
 * Active pointer interaction on the timeline canvas (Phase 4).
 * Only one interaction is live at a time; committed on pointer-up.
 */
export type TimelineInteraction =
  | {
      kind: "move";
      clipId: TimelineClipId;
      /** Alt-drag edits this member without moving its linked partners. */
      ignoreLink?: boolean;
      /** Pointer x at mousedown (canvas pixels). */
      startX: number;
      /** Pointer y at mousedown (canvas pixels)——用于按片段中心判定目标轨。 */
      startY: number;
      /** Pointer 当前位置（canvas 像素）——拖拽中片段 1:1 浮动跟随。 */
      currentX: number;
      currentY: number;
      /** 当前落点解析结果（剪映式放置预览；松手按它提交，预览即结果）。 */
      resolution: MoveTargetResolution | null;
      /** Timeline start of the clip at mousedown (µs). */
      startUs: number;
      /** Raw pointer-following start used by the visible clip while dragging (µs). */
      previewStartUs: number;
      /** Current target timeline start (µs), after snapping/clamping. */
      targetStartUs: number;
      /** 跨轨拖动的目标轨道 id；null 表示保持原轨道。 */
      targetTrackId: string | null;
      /** Snap guide position (µs) when currently snapped, else null. */
      snapUs: number | null;
      /** Alt held from pointerdown copies; later Alt changes only the Place/Insert mode. */
      copyOnStart: boolean;
      moveMode: "place" | "insert";
      /** Frozen source group and destination ids captured at pointerdown. */
      clipIds: TimelineClipId[];
      /** Writable clips riding on V1 sources at pointerdown; used to filter snap targets when linkage is on. */
      linkedRiderClipIds: TimelineClipId[];
      copyIds: TimelineClipId[];
      /** Pure final plan shared by the drop preview and commit. */
      dragPlan: ClipDragPlan | null;
      /** The row/clip zone under the actual pointer, not the dragged clip's center. */
      dropHit: TimelineDropHit | null;
    }
  | {
      /** Timeline Round 4: multi-selection group move (rigid translate).
       * 视频组平移受同轨无重叠钳制；音频组自由平移。 */
      kind: "group-move";
      clipIds: TimelineClipId[];
      startX: number;
      startY: number;
      /** Timeline start of each member at mousedown (µs). */
      startUsByClip: Record<string, number>;
      /** Current target start of each member (µs). */
      targetStartUsByClip: Record<string, number>;
      snapUs: number | null;
    }
  | {
      /** Timeline Round 5: dragging a clip's volume line. */
      kind: "volume";
      clipId: TimelineClipId;
      startY: number;
      startGainDb: number;
      targetGainDb: number;
    }
  | {
      kind: "trim";
      clipId: TimelineClipId;
      /** Unlocked linked members shown with the same edge preview; Alt captures only the lead clip. */
      linkedClipIds: TimelineClipId[];
      /** Alt was held on pointerdown, so this trim must leave explicit link partners in place. */
      ignoreLink: boolean;
      edge: TrimEdge;
      startX: number;
      startScrollX: number;
      originalStartUs: number;
      originalEndUs: number;
      targetStartUs: number;
      targetEndUs: number;
      originalTimelineStartUs: number;
      originalTimelineEndUs: number;
      targetTimelineStartUs: number;
      targetTimelineEndUs: number;
      snapUs: number | null;
    }
  | {
      kind: "speed";
      clipId: TimelineClipId;
      linkedClipIds: TimelineClipId[];
      ignoreLink: boolean;
      edge: TrimEdge;
      startX: number;
      startScrollX: number;
      originalSpeedMilli: number;
      targetSpeedMilli: number;
      originalTimelineStartUs: number;
      originalTimelineEndUs: number;
      targetTimelineStartUs: number;
      targetTimelineEndUs: number;
      targets: SpeedPreviewTarget[];
      operations: import("@aivideo/contracts").TimelinePatchOperation[];
      snapUs: number | null;
    }
  | {
      kind: "edge-edit";
      mode: AdvancedEditMode;
      clipIds: TimelineClipId[];
      startX: number;
      startScrollX: number;
      deltaUs: number;
      targets: AdvancedEditTarget[];
      operations: import("@aivideo/contracts").TimelinePatchOperation[];
      snapUs: number | null;
    }
  | {
      /** B4：C1 轨字幕端点拖拽（松手提交 set_caption_timing）。 */
      kind: "caption-trim";
      captionId: string;
      edge: TrimEdge;
      startX: number;
      startScrollX: number;
      originalStartUs: number;
      originalEndUs: number;
      targetStartUs: number;
      targetEndUs: number;
    }
  | {
      /** B4 追加：C1 轨字幕整体拖拽（松手提交 set_caption_timing 平移）。 */
      kind: "caption-move";
      captionId: string;
      startX: number;
      startScrollX: number;
      startY: number;
      originalStartUs: number;
      originalEndUs: number;
      targetStartUs: number;
      targetEndUs: number;
    }
  | {
      kind: "marquee";
      startX: number;
      startClientX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | { kind: "playhead"; startX: number; startTimeUs: number }
  | {
      /** Timeline Round 4: dragging the bottom scrollbar strip. */
      kind: "scrollbar";
      startX: number;
      startScrollX: number;
    };

/** 单片段移动交互（剪映式 1:1 跟手 + 落点预览）。 */
export type MoveInteraction = Extract<TimelineInteraction, { kind: "move" }>;

/** Marquee coords are in content space (viewport x + scrollX) so that an
 * auto-scrolling viewport keeps the selection rect anchored to content. */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Hover state used to show trim handles and cursor feedback. */
export interface TimelineHover {
  clipId: string | null;
  edge: TrimEdge | null;
}

export const DEFAULT_VIEW_STATE: TimelineViewState = {
  pixelsPerSecond: 60,
  projectZoom: TIMELINE_ZOOM_DEFAULT,
  scrollX: 0,
  // 56px baseline maps to OpenFilm's 52px regular visual lane; V1, text and
  // audio use role-specific lane heights.
  trackHeight: 56,
  // Canvas 轨道的封面条带（OpenFilm coverInset = 51px）；轨头列宽独立为 108px。
  headerWidth: TIMELINE_COVER_RAIL_WIDTH,
  // 20px（对齐 OpenFilm 的 RULER_H）。原 16px 放不下 10.5px 的刻度文字
  // 与 3px 的内容范围条，实际渲染时文字被裁。
  rulerHeight: TIMELINE_RULER_HEIGHT,
};

/** 最小缩放：10s 一格（剪映最小档的刻度密度，图1）。 */
export const ZOOM_MIN_PPS = 10;
/** 最大缩放：约 66px/帧（30fps 下 2f ≈ 133px，帧级剪辑，图2）。 */
export const ZOOM_MAX_PPS = 2000;

/** Editor-level timeline preferences persisted across sessions. */
export interface TimelineRuntimePrefs {
  /** Magnetic snapping to clip edges / playhead / grid. */
  snappingEnabled: boolean;
  /** OpenFilm-style main track gap closing and insert behavior. */
  mainTrackMagnet: boolean;
  /** Move short overlays and captions together with their main-track footage. */
  linkageEnabled: boolean;
  /** 轨道行高（px），固定不随窗口压缩；40-96。 */
  trackHeight: number;
  /** OpenFilm-style per-track row height overrides, keyed by stable track id. */
  trackHeights: Record<string, number>;
  /** 音频波形占片段高度的比例（1 = 100%，0.6 = 60%，0.3 = 30%）。 */
  waveformRatio: number;
}

export const DEFAULT_RUNTIME_PREFS: TimelineRuntimePrefs = {
  snappingEnabled: true,
  mainTrackMagnet: true,
  linkageEnabled: true,
  // 与 DEFAULT_VIEW_STATE.trackHeight 保持一致；geometry maps it to role heights.
  trackHeight: 56,
  trackHeights: {},
  /** OpenFilm's default video sound band is max(15px, 30% of picture area). */
  waveformRatio: 0.3,
};
export const TIMELINE_PREFS_STORAGE_KEY = "vortex-cut.timeline.prefs.v1";
