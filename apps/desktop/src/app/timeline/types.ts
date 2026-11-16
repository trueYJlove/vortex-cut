/**
 * Timeline Phase 1 — UI-specific rendering types.
 * Extends the canonical contract types with pixel-space computed values.
 */
import type { TimelineClip, TimelineCaption, TimelineClipId, TimelineDocument, AssetKind, TimelineTransition, TimelineTransitionId } from "@aivideo/contracts";
import type { MoveTargetResolution } from "./geometry.js";

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

/** Computed pixel rect for a transition marker between two adjacent V1 clips. */
export interface TransitionRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  transition: TimelineTransition;
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
}

/** Selection state (mirrors App.tsx Selection type). */
export type TimelineSelection =
  | { kind: "clip"; id: string }
  | { kind: "clips"; ids: string[] }
  | { kind: "caption"; id: string }
  | { kind: "transition"; id: string }
  | null;

/** Edge of a clip that can be trimmed. */
export type TrimEdge = "left" | "right";

/**
 * Active pointer interaction on the timeline canvas (Phase 4).
 * Only one interaction is live at a time; committed on pointer-up.
 */
export type TimelineInteraction =
  | {
      kind: "move";
      clipId: TimelineClipId;
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
      /** Current target timeline start (µs), after snapping/clamping. */
      targetStartUs: number;
      /** 跨轨拖动的目标轨道 id；null 表示保持原轨道。 */
      targetTrackId: string | null;
      /** Snap guide position (µs) when currently snapped, else null. */
      snapUs: number | null;
    }
  | {
      /** Timeline Round 4: multi-selection group move (rigid translate).
       * 视频组平移受同轨无重叠钳制；音频组自由平移。 */
      kind: "group-move";
      clipIds: TimelineClipId[];
      startX: number;
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
      edge: TrimEdge;
      startX: number;
      originalStartUs: number;
      originalEndUs: number;
      targetStartUs: number;
      targetEndUs: number;
      snapUs: number | null;
    }
  | {
      /** B4：C1 轨字幕端点拖拽（松手提交 set_caption_timing）。 */
      kind: "caption-trim";
      captionId: string;
      edge: TrimEdge;
      startX: number;
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
      originalStartUs: number;
      originalEndUs: number;
      targetStartUs: number;
      targetEndUs: number;
    }
  | {
      kind: "marquee";
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | { kind: "playhead"; startX: number }
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
  scrollX: 0,
  // 56px（2026-11-10，对齐 OpenFilm 的 TRACK_H.visual）。
  // 原 80px 偏高：一屏只放得下三轨，长项目要频繁滚动；56px 在同样高度里
  // 多容纳一轨，且片段信息条（名称+时长）与缩略带仍放得下。
  trackHeight: 56,
  // 轨道头列宽（2026-11-16 对齐 OpenFilm HEAD_W = 108，Timeline.tsx:179）；原 120。
  headerWidth: 108,
  // 20px（对齐 OpenFilm 的 RULER_H）。原 16px 放不下 10.5px 的刻度文字
  // 与 3px 的内容范围条，实际渲染时文字被裁。
  rulerHeight: 20,
};

/** 最小缩放：10s 一格（剪映最小档的刻度密度，图1）。 */
export const ZOOM_MIN_PPS = 10;
/** 最大缩放：约 66px/帧（30fps 下 2f ≈ 133px，帧级剪辑，图2）。 */
export const ZOOM_MAX_PPS = 2000;

/** Editor-level timeline preferences persisted across sessions. */
export interface TimelineRuntimePrefs {
  /** Magnetic snapping to clip edges / playhead / grid. */
  snappingEnabled: boolean;
  /** 轨道行高（px），固定不随窗口压缩；40-96。 */
  trackHeight: number;
  /** 音频波形占片段高度的比例（1 = 100%，0.6 = 60%，0.3 = 30%）。 */
  waveformRatio: number;
}

export const DEFAULT_RUNTIME_PREFS: TimelineRuntimePrefs = {
  snappingEnabled: true,
  // 与 DEFAULT_VIEW_STATE.trackHeight 保持一致（56，对齐 OpenFilm）。
  trackHeight: 56,
  /** 剪映默认 40% 波形占比。 */
  waveformRatio: 0.4,
};
export const TIMELINE_PREFS_STORAGE_KEY = "vortex-cut.timeline.prefs.v1";