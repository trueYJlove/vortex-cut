import { editorPerf } from "../preview/perf-metrics.js";
import { ToolButton } from "../../ui/of/ToolButton.js";
import { ModePicker, timelineModeFromKeyEvent, type TimelineMode } from "../../ui/of/ModePicker.js";
import { ContextMenu, type ContextMenuEntry } from "../../ui/of/ContextMenu.js";
import { ASSET_BATCH_DRAG, ASSET_DRAG, SYSTEM_FILE_DROP_ID, assetDropKindFromFile, clearSystemFileDrop, getActiveDraggedAssetIds, hasAssetDrag, peekSystemFileDrop, readAssetDrop, resolveTimelineAssetDropIntent, restoreSystemFileDrop, setActiveDraggedAssetIds } from "./asset-drop.js";
import { splitClipAt, splitSelectionAt } from "./split-point.js";
import { expandLinkedClipIds, mergeLinkedMarqueeSelection, removeLinkedClips } from "./linked-clips.js";
import { closeGapAt } from "./close-gap.js";
import { planCompactMainTrack, planMagneticDelete, planMagneticDrop, planMagneticMove, planMagneticTrim, planMagneticImageTrim, planRippleDelete } from "./magnetic-plan.js";
import { createClipDragPlanner, linkedRiderClipIdsForDrag } from "./clip-drag-plan.js";
import { hasLiftedTimelineDrag } from "./drag-threshold.js";
import { planAdvancedEdit, type AdvancedEditMode } from "./advanced-edit.js";
import { planTimelineSpeedEdge, speedMilliForLength } from "./speed-edge-plan.js";
import { AudioMeters } from "../../ui/of/AudioMeters.js";
/**
 * Timeline — Canvas + DOM hybrid timeline component.
 *
 * Phase 1: basic Canvas rendering (ruler, clip blocks, caption blocks,
 *          playhead, selection highlight)
 * Phase 3: clip drag-reorder (V1 sequence)
 * Phase 4: trim handles, snapping, marquee selection, playhead dragging,
 *          and free positioning for A1 audio clips
 *
 * Architecture:
 * - DOM: toolbar, track headers, drop zones, accessible clip list
 * - Canvas: ruler ticks, clip blocks, caption blocks, playhead, selection
 *           highlight, trim handles, snap guides, marquee, drag ghosts
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Link2,
  Link2Off,
  Magnet,
  MoreHorizontal,
  Paperclip,
  PenLine,
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  SeparatorVertical,
  SquareDashed,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  TimelineCaption,
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
  TimelineTrack,
  TimelineTransition,
  ActiveTimelineTransition,
} from "@aivideo/contracts";
import type { EditorCommand } from "../editorCommands.js";
import {
  DEFAULT_RUNTIME_PREFS,
  DEFAULT_VIEW_STATE,
  TIMELINE_HEAD_COLLAPSED_WIDTH,
  TIMELINE_HEAD_EMPTY_WIDTH,
  TIMELINE_HEAD_EXPANDED_WIDTH,
  TIMELINE_TOOLBAR_HEIGHT,
  TIMELINE_ZOOM_SLIDER_WIDTH,
  TIMELINE_ZOOM_DEFAULT,
  TIMELINE_PREFS_STORAGE_KEY,
  type AssetMediaEntry,
  type CaptionRenderRect,
  type ActiveTransitionRenderRect,
  type ClipRenderRect,
  type TickMark,
  type TimelineHover,
  type TimelineInteraction,
  type MoveInteraction,
  type TimelineRuntimePrefs,
  type TimelineSelection,
  type TimelineAssetDropIntent,
  type TimelineViewState,
  type TransitionRenderRect,
  type TrimEdge,
} from "./types.js";
import { TimelinePlayheadLayer } from "./TimelinePlayheadLayer.js";
import { MarkerLane } from "./MarkerLane.js";
import type { TimelineMarker } from "./markers.js";
import { formatRange, normalizeRange, rangeDuration, MIN_RANGE_US, type TimeRange } from "./time-range.js";
import { createPlayheadStore, type PlayheadStore } from "./playhead-store.js";
import { ThumbnailLoader, defaultFilmstripSourceFactory } from "./thumbnail-loader.js";
import { OVERSCAN_ROWS } from "./viewport-index.js";
import type { WaveformCache } from "./waveform-cache.js";
import {
  CLIP_RADIUS,
  CLIP_ROW_INSET,
  KEYFRAME_LANE_HEIGHT,
  KEYFRAME_ORDER,
  KIND_COLOR_VARS,
  formatTimelineHoverTime,
} from "./canvas/render/theme.js";
import {
  THUMB_CELL_PX,
  buildFilmstripOverlayGroups,
  cachedFilmstripFallback,
  cellSourceTimeSec,
  filmstripCachePrefix,
  frameTierFor,
  quantizeFrameCount,
  thumbnailStepMs,
  type FilmstripOverlayCell,
  type FilmstripSprite,
} from "./canvas/render/filmstrip-index.js";
import { drawRulerStrip } from "./canvas/render/ruler.js";
import { drawTimelineFrame } from "./canvas/render/render-frame.js";

export {
  THUMB_CELL_PX,
  cachedFilmstripFallback,
  cellSourceTimeSec,
  filmstripCachePrefix,
  frameTierFor,
  quantizeFrameCount,
  thumbnailStepMs,
};

/** B2 转场种类（与 core TRANSITION_KINDS 对齐）。 */
const TRANSITION_KINDS = ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "zoomin"] as const;

const canChangeClipSpeed = (clip: TimelineClip): boolean =>
  (clip.asset_kind === "video" || clip.asset_kind === "audio")
  && clip.source_start_us != null
  && clip.source_end_us != null
  && clip.source_end_us > clip.source_start_us;

import {
  MIN_CLIP_US,
  SCROLLBAR_HEIGHT_PX,
  SNAP_PX,
  TRIM_HANDLE_PX,
  CLIP_HEADER_H,
  CAPTION_ROW_H,
  clampGroupDelta,
  clampMoveStart,
  clampScrollX,
  clampTimelineZoom,
  clipAudioBand,
  clipLabelPinShift,
  timelineWheelPanDelta,
  timelineGestureDeltaUs,
  clipDuration,
  computeTimelineTicks,
  clipsInTimelineMarquee,
  computeClipRects,
  computeTrackRows,
  computeTransitionRects,
  computeActiveTransitionRects,
  TRACK_VIEW_PAD,
  TRACK_SIZES,
  dragEdgeAutoScrollStep,
  hitTestClips,
  hitTestTransitionGap,
  hitTestTransitions,
  hitTestActiveTransitions,
  hitTestTrimHandle,
  hitTestVolumeLine,
  marqueeRect,
  orderedMoveSnapTargets,
  resolveGroupMove,
  resolveMoveTarget,
  scrollBounds,
  snapCandidates,
  snapResult,
  snapResultSorted,
  snapValue,
  snapClipPaintRect,
  stepTimelineZoom,
  timeToX,
  timelineSliderToZoom,
  timelineZoomAfterDurationChange,
  timelineZoomLimits,
  timelineZoomToPps,
  timelineZoomToSlider,
  trimHitPx,
  trackRowAt,
  trackRowOf,
  timelineDropHit,
  timelineDragDropExcludedClipIds,
  trackRowsTotalHeight,
  volumeToY,
  xToTime,
  snapTimeToFrame,
  yToVolume,
  zoomAtAnchor,
  type TrackRowLayout,
} from "./geometry.js";
import { clearActiveTransitionOperations, planActiveTransitionResize } from "./active-transition-edit.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const formatTime = formatTimelineHoverTime;

const createTimelineClipId = (): TimelineClipId => {
  const uuid = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  const suffix = uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `clip_${suffix}` as TimelineClipId;
};

const snapUsToFrame = (us: number, fpsNum: number, fpsDen: number) => {
  const safeNum = Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 30;
  const safeDen = Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1;
  const frame = Math.round((us * safeNum) / (1_000_000 * safeDen));
  return Math.max(0, Math.round((frame * 1_000_000 * safeDen) / safeNum));
};

const formatRulerTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0)
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/** 剪映式片段时长码：HH:MM:SS:FF（FF = 帧号）。 */
const formatTimecode = (us: number, frameRate: number) => {
  const fps = Math.max(1, frameRate);
  const totalFrames = Math.max(0, Math.round((us / 1_000_000) * fps));
  const frames = Math.floor(totalFrames % fps);
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames].map((part) => String(part).padStart(2, "0")).join(":");
};

/** 时间线总时长 = 所有片段最大终点（自由定位下允许空隙，列表末尾未必最晚）。 */
const duration = (document?: TimelineDocument) =>
  document?.clips.reduce((max, clip) => Math.max(max, clip.timeline_end_us), 0) ?? 0;

function IconButton({
  label,
  title,
  disabled,
  expanded,
  onClick,
  children,
}: {
  label: string;
  /** Optional tooltip text (defaults to the accessible label). */
  title?: string;
  disabled?: boolean;
  /** aria-expanded state for toggle buttons（如"添加轨道"菜单）。 */
  expanded?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  /* 实现换成参照的 ToolButton（2026-11-16 移植，ui/of/ToolButton.tsx）。
     19 处调用点签名不变，但行为与观感随之变成参照的：
     28×28 / 圆角 6 / muted 字色 / hover 走 --bg-hover / 按下态强调色+柔底；
     鼠标点击不留焦点（否则下一次空格会去按按钮而不是播放）；
     用 aria-disabled 而非原生 disabled（原生 disabled 会吞掉提示，而「为什么不能点」
     恰恰是 disabled 时最需要的）。
     注意：expanded 是 aria-expanded（菜单开合），ToolButton 的 active 是 aria-pressed，
     两者语义不同，故 expanded 单独透传。 */
  void title;
  return (
    <ToolButton label={label} disabled={disabled} active={Boolean(expanded)} menuOpen={expanded} onClick={onClick}>
      {children}
    </ToolButton>
  );
}

function MarkerToolbarGlyph() {
  return <svg aria-hidden="true" width={16} height={16} viewBox="0 0 16 16" fill="none">
    <path d="M4 2.5h8a1 1 0 0 1 1 1v6.3a1 1 0 0 1-.38.78l-4 3.2a1 1 0 0 1-1.24 0l-4-3.2A1 1 0 0 1 3 9.8V3.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>;
}

function SplitToolbarGlyph() {
  return <svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
    <path d="M5 4h4v16H5m14-16h-4v16h4" />
  </svg>;
}

/** OpenFilm-style track head resize target. Pointer dragging edits one row;
 * keyboard arrows resize it too, and Home/double-click restore its role height. */
function TrackResizeHandle({
  trackId,
  height,
  onResize,
}: {
  trackId: string;
  height: number;
  onResize: (height: number | null, done: boolean) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number; lastHeight: number } | null>(null);
  const minimum = 28;
  const clamp = (value: number) => Math.max(minimum, Math.min(160, Math.round(value)));
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, lastHeight: height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clamp(drag.startHeight + event.clientY - drag.startY);
    if (next === drag.lastHeight) return;
    drag.lastHeight = next;
    onResize(next, false);
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onResize(drag.lastHeight, true);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      onResize(null, true);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 4;
    onResize(clamp(height + (event.key === "ArrowDown" ? step : -step)), true);
  };
  return (
    <div
      className="timeline-track-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`调整轨道 ${trackId} 高度`}
      aria-valuemin={minimum}
      aria-valuemax={160}
      aria-valuenow={height}
      aria-valuetext={`${height} 像素`}
      aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Home"
      tabIndex={0}
      title={`拖动调整轨道 ${trackId} 高度；方向键微调；Home 恢复默认`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={event => { event.stopPropagation(); onResize(null, true); }}
      onKeyDown={onKeyDown}
    />
  );
}

// ── WP-P232 预抽 sprite 装载（可测的调度体） ────────────────────────────────

/** 单素材退避档（ms）：首查几乎立刻（已 ready 的素材零延迟），生成中拉到 2s。
 *  真机大素材 filmstrip 作业需 6~75s（ffmpeg tile 单 pass 解码全片），
 *  20 次 ≈ 30s 足够覆盖主流素材；超长素材由画布运行时补抽兜底。 */
export const SPRITE_RETRY_BACKOFF_MS = [250, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000] as const;

export interface FilmstripLoadDeps {
  loader: {
    registerSprite(assetId: string, entry: {
      bitmap: ImageBitmap; stepMs: number; cellW: number; cellH: number; count: number;
    }): void;
  };
  /** 当前项目 id（Core 路由用；null = 尚未加载，整轮跳过）。 */
  projectId: () => string | null;
  /** 已登记/已放弃的素材（跨 effect 轮次存活，来自 ref）。 */
  isDone: (assetId: string) => boolean;
  markLoaded: (assetId: string) => void;
  markSkipped: (assetId: string) => void;
  unmarkLoaded: (assetId: string) => void;
  onLoaded: () => void;
  /** 注入点（测试用）；生产留空走 window.desktop / fetch / createImageBitmap。 */
  stepMs?: number;
  backoffMs?: readonly number[];
  desktopApi?: {
    ensureFilmstrip(input: { project_id: string; asset_id: string; step_ms: number; generate: boolean }): Promise<{ status: string } | null>;
    filmstripMediaUrl(input: { project_id: string; asset_id: string; step_ms: number }): Promise<{
      media_url: string; step_ms: number; cell_w: number; cell_h: number; count: number;
    }>;
  };
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;
  createBitmap?: (blob: Blob) => Promise<ImageBitmap>;
  scheduleTimer?: (callback: () => void, ms: number) => number;
  cancelTimer?: (handle: number) => void;
}

/**
 * 装载素材缩略图 sprite，直到 ready 或放弃；返回取消函数。
 *
 * 为什么不是「查一次就好」（P232 真机缺陷）：导入 → 拖上轨道只隔几百毫秒，
 * 此刻 filmstrip 作业还在 queued/running，filmstripMediaUrl 必抛「未就绪」。
 * 旧实现把 assetId 一次性写进「已装载」集合再 catch 静默，sprite 永不登记
 * ——预抽链路整体失效，只剩运行时补抽兜底（档位不同即空格）。
 *
 * 语义：ensure 报非 ready（queued/building）→ 退避重试，永不取件（必 404）；
 * ensure 报 failed / 无视频流（MEDIA_NO_VIDEO）→ 立即放弃并负缓存；
 * 取件/解码瞬时失败 → 退避重试，耗尽即放弃。
 */
export function loadFilmstripsOnce(
  assetMedia: Array<{ asset_id: string; kind?: string }>,
  deps: FilmstripLoadDeps,
): () => void {
  const backoff = deps.backoffMs ?? SPRITE_RETRY_BACKOFF_MS;
  const stepMs = deps.stepMs ?? 1000;
  const timer = deps.scheduleTimer ?? ((callback, ms) => setTimeout(callback, ms) as unknown as number);
  const cancel = deps.cancelTimer ?? ((handle) => clearTimeout(handle));
  const handles = new Set<number>();
  let cancelled = false;

  const api = deps.desktopApi ?? (window as unknown as { desktop: FilmstripLoadDeps["desktopApi"] }).desktop!;
  const doFetch = deps.fetchImpl ?? ((url: string) => fetch(url));
  const makeBitmap = deps.createBitmap ?? ((blob: Blob) => createImageBitmap(blob));

  const schedule = (fn: () => void, ms: number): void => {
    const handle = timer(() => { handles.delete(handle); if (!cancelled) fn(); }, ms);
    handles.add(handle);
  };

  const run = (assetId: string, attempt: number): void => {
    if (cancelled) return;
    const retryOrGiveUp = (): void => {
      if (cancelled) return;
      const next = attempt + 1;
      if (next >= backoff.length) { deps.markSkipped(assetId); return; }
      schedule(() => run(assetId, next), backoff[next]);
    };
    void (async () => {
      const projectId = deps.projectId();
      if (!projectId) { deps.unmarkLoaded(assetId); return; }
      try {
        const ensured = await api.ensureFilmstrip({
          project_id: projectId, asset_id: assetId, step_ms: stepMs, generate: true,
        });
        const status = ensured?.status;
        if (status !== "ready") {
          // failed = 作业真失败（无视频流/素材变化）：不再重试。
          if (status === "failed") { deps.markSkipped(assetId); return; }
          retryOrGiveUp();
          return;
        }
        const sprite = await api.filmstripMediaUrl({
          project_id: projectId, asset_id: assetId, step_ms: stepMs,
        });
        const response = await doFetch(sprite.media_url);
        if (!response.ok) { retryOrGiveUp(); return; }
        const bitmap = await makeBitmap(await response.blob());
        if (cancelled) { bitmap.close(); return; }
        deps.loader.registerSprite(assetId, {
          bitmap, stepMs: sprite.step_ms, cellW: sprite.cell_w, cellH: sprite.cell_h, count: sprite.count,
        });
        deps.markLoaded(assetId);
        deps.onLoaded();
      } catch {
        retryOrGiveUp();
      }
    })();
  };

  for (const media of assetMedia) {
    if (!media.asset_id || deps.isDone(media.asset_id)) continue;
    if (media.kind && media.kind !== "video") { deps.markSkipped(media.asset_id); continue; }
    deps.markLoaded(media.asset_id); // 本轮单飞占位（成功后保持，失败由 markSkipped 落负缓存）
    run(media.asset_id, 0);
  }

  return () => {
    cancelled = true;
    for (const handle of handles) cancel(handle);
    handles.clear();
  };
}

// ── Thumbnail frame computation（剪映式：抽帧铺满片段） ──────────────────────

export interface FilmstripRequestWindow { fromUs: number; toUs: number }

interface FilmstripFrameRequest {
  url: string;
  timeSec: number;
  fromUs: number;
  toUs: number;
  keySuffix: string;
  sourceTimeUs: number;
}

export function computeFrameRequests(
  mediaUrl: string | null,
  clip: TimelineClip,
  pps: number,
  window?: FilmstripRequestWindow,
): FilmstripFrameRequest[] {
  if (!mediaUrl) return [];
  const isVisual = clip.asset_kind === "video" || clip.asset_kind === "image";
  if (!isVisual || !(pps > 0)) return [];
  const timelineDurUs = clip.timeline_end_us - clip.timeline_start_us;
  if (timelineDurUs <= 0) return [];
  const sourceStartUs = Math.max(0, clip.source_start_us ?? 0);
  const sourceEndUs = Math.max(sourceStartUs, clip.source_end_us ?? sourceStartUs + timelineDurUs);
  const speed = Math.max(0.001, (clip.speed_milli ?? 1000) / 1000);
  const frames: FilmstripFrameRequest[] = [];

  if (clip.asset_kind === "image") {
    return [{ url: mediaUrl, timeSec: sourceStartUs / 1_000_000,
      fromUs: clip.timeline_start_us, toUs: clip.timeline_start_us,
      keySuffix: `:source:${Math.round(sourceStartUs / 1000)}`, sourceTimeUs: sourceStartUs }];
  }

  if (clip.reverse_playback) {
    const count = frameTierFor(timelineDurUs, pps);
    for (let i = 0; i < count; i += 1) {
      const fromUs = clip.timeline_start_us + (i * timelineDurUs) / count;
      const toUs = clip.timeline_start_us + ((i + 1) * timelineDurUs) / count;
      const sourceTimeUs = Math.round(cellSourceTimeSec(clip, i, count) * 1_000_000);
      if (window && (toUs < window.fromUs || fromUs > window.toUs)) continue;
      frames.push({ url: mediaUrl, timeSec: sourceTimeUs / 1_000_000, fromUs, toUs,
        keySuffix: `:${count}:${i}`, sourceTimeUs });
    }
    return frames;
  }

  const stepMs = thumbnailStepMs((THUMB_CELL_PX / pps) * 1000 * speed);
  const stepUs = Math.max(1, Math.round(stepMs * 1000));
  const visibleFromUs = Math.max(clip.timeline_start_us, window?.fromUs ?? clip.timeline_start_us);
  const visibleToUs = Math.min(clip.timeline_end_us, window?.toUs ?? clip.timeline_end_us);
  if (visibleToUs < visibleFromUs) return [];
  const visibleSourceFromUs = sourceStartUs + (visibleFromUs - clip.timeline_start_us) * speed;
  const visibleSourceToUs = sourceStartUs + (visibleToUs - clip.timeline_start_us) * speed;
  const firstGrid = Math.max(0, Math.ceil(sourceStartUs / stepUs));
  const lastGrid = Math.floor(sourceEndUs / stepUs);
  const firstVisible = Math.max(firstGrid, Math.ceil(visibleSourceFromUs / stepUs) - 1);
  const lastVisible = Math.min(lastGrid, Math.floor(visibleSourceToUs / stepUs) + 1);

  for (let index = firstVisible; index <= lastVisible; index += 1) {
    const sourceTimeUs = Math.round(index * stepUs);
    const timelineAtUs = clip.timeline_start_us + (sourceTimeUs - sourceStartUs) / speed;
    frames.push({ url: mediaUrl, timeSec: sourceTimeUs / 1_000_000,
      fromUs: timelineAtUs, toUs: timelineAtUs,
      keySuffix: `:source:${Math.round(sourceTimeUs / 1000)}`, sourceTimeUs });
  }

  // A short clip can sit entirely between two ladder samples. Give it one local shot.
  if (lastGrid < firstGrid) {
    const sourceDurUs = sourceEndUs - sourceStartUs;
    const intoUs = sourceDurUs <= 240_000
      ? sourceDurUs / 2
      : Math.min(Math.max(240_000, sourceDurUs * 0.28), Math.max(0, sourceDurUs - 40_000));
    const sourceTimeUs = Math.round(sourceStartUs + intoUs);
    const timelineAtUs = clip.timeline_start_us + (sourceTimeUs - sourceStartUs) / speed;
    frames.push({ url: mediaUrl, timeSec: sourceTimeUs / 1_000_000,
      fromUs: timelineAtUs, toUs: timelineAtUs,
      keySuffix: `:source:${Math.round(sourceTimeUs / 1000)}`, sourceTimeUs });
  }
  return frames;
}

// ── Caption geometry ─────────────────────────────────────────────────────────

/** Minimum caption duration (µs), mirroring core MIN_CAPTION_US. */
const MIN_CAPTION_US = 200_000;

function computeCaptionRects(
  captions: TimelineCaption[],
  rows: TrackRowLayout[],
  view: TimelineViewState,
): CaptionRenderRect[] {
  const captionRow = trackRowOf(rows, "C1");
  const y = captionRow?.y ?? view.rulerHeight;
  const height = captionRow?.height ?? Math.min(40, view.trackHeight);
  return captions.map((caption) => ({
    x: timeToX(caption.start_us, view),
    y,
    width: Math.max(2, ((caption.end_us - caption.start_us) / 1_000_000) * view.pixelsPerSecond),
    height,
    caption,
  }));
}

/**
 * 剪映式时间刻度：视口驱动——无论缩放大小，刻度始终布满整个时间线窗口
 * （按当前 pps 计算合适的间隔，从可视时间范围向外取整覆盖）；素材范围之外
 * 也照常绘制。帧级标签（2f/4f…）只在放大到足够大时出现（剪映式）。
 */
// ── Audio waveform data ──────────────────────────────────────────────────────

// B14：波形峰值来自 timeline/waveform-cache.ts（Core 派生缓存金字塔产物，
// 按 clip 源区间/速度/倒放取窗）。Renderer 不再保留整媒体 decodeAudioData
// 链路（旧 getAudioDecodeContext/extractPeaks/decodeAudioPeaks 已移除）。

// ── Runtime prefs (magnetic snapping) ────────────────────────────────────────

const projectTrackHeightKey = (projectId: string) => `${TIMELINE_PREFS_STORAGE_KEY}.project.${encodeURIComponent(projectId)}.track-heights`;

function parseTrackHeightOverrides(savedHeights: unknown): Record<string, number> {
  const trackHeights: Record<string, number> = {};
  if (!savedHeights || typeof savedHeights !== "object" || Array.isArray(savedHeights)) return trackHeights;
  for (const [trackId, value] of Object.entries(savedHeights)) {
    const minimum = 28;
    if (Number.isFinite(value) && Number(value) >= minimum && Number(value) <= 160) {
      trackHeights[trackId] = Math.round(Number(value));
    }
  }
  return trackHeights;
}

function loadProjectTrackHeights(projectId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(projectTrackHeightKey(projectId));
    return raw ? parseTrackHeightOverrides(JSON.parse(raw)) : {};
  } catch { return {}; }
}

function persistRuntimePrefs(prefs: TimelineRuntimePrefs, projectId?: string) {
  if (projectId) {
    const { trackHeights, ...globalPrefs } = prefs;
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify(globalPrefs));
    window.localStorage.setItem(projectTrackHeightKey(projectId), JSON.stringify(trackHeights));
  } else {
    window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  }
}

function loadRuntimePrefs(projectId?: string): TimelineRuntimePrefs {
  try {
    const raw = window.localStorage.getItem(TIMELINE_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && typeof (parsed as TimelineRuntimePrefs).snappingEnabled === "boolean") {
        const candidate = parsed as Partial<TimelineRuntimePrefs>;
        const trackHeight =
          typeof candidate.trackHeight === "number" && 40 <= candidate.trackHeight && candidate.trackHeight <= 128
            ? candidate.trackHeight
            : DEFAULT_RUNTIME_PREFS.trackHeight;
        const waveformRatio =
          typeof candidate.waveformRatio === "number" && [1, 0.6, 0.4, 0.3].includes(candidate.waveformRatio)
            ? candidate.waveformRatio
            : DEFAULT_RUNTIME_PREFS.waveformRatio;
        const trackHeights = projectId
          ? loadProjectTrackHeights(projectId)
          : parseTrackHeightOverrides(candidate.trackHeights);
        return {
          snappingEnabled: candidate.snappingEnabled === true,
          mainTrackMagnet: candidate.mainTrackMagnet !== false,
          linkageEnabled: candidate.linkageEnabled !== false,
          trackHeight,
          trackHeights,
          waveformRatio,
        };
      }
    }
  } catch {
    // Corrupted prefs — fall back to defaults.
  }
  return DEFAULT_RUNTIME_PREFS;
}

// ── Canvas drawing (delegated to ./canvas/render/*) ───────────────────────────

const TimelineFilmstripCanvas = memo(function TimelineFilmstripCanvas({ cell }: { cell: FilmstripOverlayCell }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width !== cell.sourceWidth || canvas.height !== cell.sourceHeight) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(cell.source, cell.sourceX, cell.sourceY, cell.sourceWidth, cell.sourceHeight,
      0, 0, canvas.width, canvas.height);
  }, [cell]);
  return (
    <canvas
      ref={canvasRef}
      data-timeline-filmstrip-cell={cell.key}
      width={cell.sourceWidth}
      height={cell.sourceHeight}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: cell.x,
        top: 0,
        width: cell.width,
        height: cell.height,
        objectFit: "cover",
        objectPosition: "center",
        opacity: 0.9,
        pointerEvents: "none",
      }}
    />
  );
});

// ── Component ────────────────────────────────────────────────────────────────

export function TimelinePanel({
  projectId,
  document,
  selection,
  setSelection,
  onPatch,
  onDropAsset,
  onReplaceAssetDrop,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  assetMedia,
  activeTransitions = [],
  waveformCache,
  playheadStore,
  onSeek,
  onSeekCommit,
  onRangeChange,
  onCommand,
  coverUrl,
  onCaptureCover,
  meterLevels,
  playing,
}: {
  /** Track row heights follow OpenFilm's per-project timeline preference scope. */
  projectId?: string;
  document?: TimelineDocument;
  selection: TimelineSelection;
  setSelection: (selection: TimelineSelection) => void;
  onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>;
  onDropAsset: (assetIds: string[], atIndex: number, trackId?: string | "new", edit?: { mode: "overwrite"; atUs: number }, intent?: TimelineAssetDropIntent) => void;
  onReplaceAssetDrop?: (assetIds: string[], targetClipId: TimelineClipId, intent: TimelineAssetDropIntent) => void | Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  assetMedia: AssetMediaEntry[];
  /** Core projected clip-source-fact transitions; kept separate from legacy effects. */
  activeTransitions?: readonly ActiveTimelineTransition[];
  /** B14 波形缓存（App 注入；素材级持久化峰值，Renderer 不再整媒体解码）。
   *  缺省（测试/独立使用）= 不显示波形——与旧链路 fetch 失败时行为一致。 */
  waveformCache?: WaveformCache | null;
  /** 播放头存储（A06，可选——App 拥有跨组件 store 时传入；测试/旧调用方
   *  不传则组件内部自建，行为自洽）。预览每帧写入 store，播放头绘制走
   *  独立 DOM 覆盖层，播放期间不再触发主画布全量重绘。 */
  playheadStore?: PlayheadStore;
  /** 音频电平表的样本供给（参照 AudioMeters 的数据入口）；不传则不显示电平表。 */
  meterLevels?: () => readonly [Float32Array, Float32Array] | null;
  /** 是否在播放（电平表据此决定是否逐帧重绘、停下后回落）。 */
  playing?: boolean;
  /** Optional seek callback invoked when the playhead is dragged or a caption is clicked. */
  onSeek?: (timeUs: number) => void;
  /** 擦洗结束的精确落点（拖动中 onSeek 走节流，松手用这个收尾）。 */
  onSeekCommit?: (timeUs: number) => void;
  onRangeChange?: (range: TimeRange | null) => void;
  /** Optional editor command runner (copy/paste context-menu actions). */
  onCommand?: (id: EditorCommand["id"]) => void;
  /** 项目封面（本地截帧持久化），有值时封面入口显示缩略图。 */
  coverUrl?: string | null;
  /** 截取当前播放头画面设为项目封面（由 App 层从预览画布取帧）。 */
  onCaptureCover?: () => void;
}) {
  const clipDragPlanner = useMemo(() => document ? createClipDragPlanner(document) : null, [document]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 播放头 store：外部拥有（App 跨组件写入）或组件自建（测试/独立使用）。
  const localPlayheadStoreRef = useRef<PlayheadStore | null>(null);
  if (!localPlayheadStoreRef.current && !playheadStore) {
    localPlayheadStoreRef.current = createPlayheadStore();
  }
  const activePlayheadStore = playheadStore ?? localPlayheadStoreRef.current!;
  const [view, setView] = useState<TimelineViewState>(DEFAULT_VIEW_STATE);
  const previousTimelineDurationUsRef = useRef<number | null>(null);
  const [headsCollapsed, setHeadsCollapsed] = useState(false);
  // T3 参照 Timeline.tsx:2090-2110：分割模式刀线。直写 DOM style（每 move 一帧，不走 React state 防重渲卡顿）。
  const bladeRef = useRef<HTMLDivElement | null>(null);
  const hideBlade = useCallback(() => {
    const line = bladeRef.current;
    if (line) line.style.display = "none";
  }, []);
  const aimBlade = useCallback((x: number, y: number, hitClip: { y: number; height: number } | null) => {
    const line = bladeRef.current;
    if (!line) return;
    // 仅当指针悬在**可分割片段**上才画线（看见线 = 这里会切）：无命中或命中点
    // 落在片段边缘 trim 带内都不画（与点击判定同规则）。
    if (!hitClip) { line.style.display = "none"; return; }
    line.style.display = "block";
    line.style.transform = `translateX(${x}px)`;
    line.style.top = `${hitClip.y}px`;
    line.style.height = `${hitClip.height}px`;
  }, []);
  // T9 参照 Timeline.tsx:3518-3526 的左右 6px 拖条：拖动改转场时长，pointerup 提交一条 update_transition。
  const transitionResizeRef = useRef<{ transition: TimelineTransition; side: "start" | "end"; startX: number; baseUs: number; nextUs?: number } | null>(null);
  const beginTransitionResize = (transition: TimelineTransition, side: "start" | "end", event: React.PointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    transitionResizeRef.current = { transition, side, startX: event.clientX, baseUs: transition.duration_us };
  };
  const moveTransitionResize = (event: React.PointerEvent) => {
    const drag = transitionResizeRef.current;
    if (!drag) return;
    const deltaUs = Math.round(((event.clientX - drag.startX) * (drag.side === "end" ? 1 : -1) / Math.max(0.001, view.pixelsPerSecond)) * 1_000_000);
    drag.nextUs = Math.max(100_000, Math.min(2_000_000, drag.baseUs + deltaUs));
  };
  const endTransitionResize = () => {
    const drag = transitionResizeRef.current;
    transitionResizeRef.current = null;
    if (!drag?.nextUs || drag.nextUs === drag.baseUs) return;
    void onPatch([{ op: "update_transition", transition_id: drag.transition.transition_id, duration_us: drag.nextUs }], `转场时长 ${(drag.nextUs / 1_000_000).toFixed(2)}s`);
  };
  /** 主题版本号：切换主题时自增，强制画布重绘。
   *  画布用 ctx.fillStyle 绘制，不吃 CSS 选择器——颜色虽已改为从 CSS 变量读取，
   *  但不重绘就仍是旧填充色（实测：浅色主题下时间线仍是一整块深色）。
   *  用 window.document 避开模块内 TimelineDocument 类型参数对本文件 document 的遮蔽。 */
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const doc = window.document;
    const observer = new MutationObserver(() => setThemeEpoch(value => value + 1));
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Synchronous view mirror so the auto-scroll rAF loop reads fresh values.
  const viewRef = useRef<TimelineViewState>(view);
  viewRef.current = view;
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropIntent, setDropIntent] = useState<TimelineAssetDropIntent | null>(null);
  const [replaceAssetRequest, setReplaceAssetRequest] = useState<{ assetIds: string[]; targetClipId: TimelineClipId; intent: TimelineAssetDropIntent; systemFiles: readonly File[] } | null>(null);
  const replaceAssetRequestRef = useRef(replaceAssetRequest);
  replaceAssetRequestRef.current = replaceAssetRequest;
  const [replaceClipRequest, setReplaceClipRequest] = useState<{
    operations: TimelinePatchOperation[];
    targetClipId: TimelineClipId;
    expected: Array<{ clipId: TimelineClipId; trackId: string; startUs: number; endUs: number }>;
  } | null>(null);
  const dropIntentRef = useRef(dropIntent);
  dropIntentRef.current = dropIntent;
  const dropItemCountRef = useRef(0);
  // B2：点击两片段边界时记录转场锚点（左侧片段 id），弹出添加浮层。
  const [addTransitionAnchor, setAddTransitionAnchor] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 200 });
  // B17：纵向滚动位置（.timeline-scroll 的 scrollTop——画布 viewport 化后
  // 绘制与命中的 y 坐标基准）。同步 ref 供指针路径读即时值（拖拽自动滚动
  // 期间 DOM scrollTop 先变、React 状态后到——ref 为准避免一帧错位）。
  const [scrollTop, setScrollTop] = useState(0);
  const scrollTopRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const onTimelineScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const value = event.currentTarget.scrollTop;
    scrollTopRef.current = value;
    setScrollTop(value);
  }, []);
  // Active pointer interaction (Phase 4): null when idle.
  const [interaction, setInteraction] = useState<TimelineInteraction | null>(null);
  // OpenFilm's clip context-menu Speed toggle is scoped to the current selection.
  const [speedModeKey, setSpeedModeKey] = useState<string | null>(null);
  // 拖拽松手后的"提交态"：补丁在途期间片段继续渲染在目标位置（剪映式无回弹），
  // 文档更新后清除。moved = 主片段去向，displaced = 被交换片段去向（可选）。
  const [pendingKeep, setPendingKeep] = useState<{
    placements: Array<{ clipId: TimelineClipId; trackId: string; startUs: number }>;
    copies: Array<{ clipId: TimelineClipId; sourceClipId: TimelineClipId; trackId: string; startUs: number }>;
  } | null>(null);
  // Synchronous mirror of interaction so pointer handlers always read the latest value.
  const interactionRef = useRef<TimelineInteraction | null>(null);
  const moveSnapTargetsRef = useRef<{
    clipRects: ClipRenderRect[];
    markers: TimelineMarker[];
    withoutRiders: number[];
    withRiders: number[];
    withoutRidersOrder: ReadonlyMap<number, number>;
    withRidersOrder: ReadonlyMap<number, number>;
  } | null>(null);
  const activeCanvasPointerIdRef = useRef<number | null>(null);
  const lastClientPointerRef = useRef<{ clientX: number; clientY: number; pointerId: number; altKey: boolean } | null>(null);
  const pointerDragLiftedRef = useRef(false);
  const collapseSelectedClickRef = useRef<{ clipId: TimelineClipId; alone: boolean } | null>(null);
  const pointerMoveFrameRef = useRef(0);
  const pendingPointerMoveRef = useRef<Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "altKey"> | null>(null);
  useEffect(() => () => {
    if (pointerMoveFrameRef.current) cancelAnimationFrame(pointerMoveFrameRef.current);
    pointerMoveFrameRef.current = 0;
    pendingPointerMoveRef.current = null;
  }, []);
  // Hover state (trim handles + cursor).
  const [hover, setHover] = useState<TimelineHover>({ clipId: null, edge: null });
  // Round 5: hovered time on the ruler (faint guide + label), null when idle.
  const [rulerHoverUs, setRulerHoverUs] = useState<number | null>(null);
  // Round 4: persisted runtime prefs (magnetic snapping / 轨道高度 / 波形占比)。
  const [prefs, setPrefs] = useState<TimelineRuntimePrefs>(() => loadRuntimePrefs(projectId));
  useEffect(() => {
    setPrefs(previous => ({ ...previous, trackHeights: projectId ? loadProjectTrackHeights(projectId) : {} }));
  }, [projectId]);
  const resizeTrack = useCallback((trackId: string, height: number | null, done: boolean) => {
    setPrefs(previous => {
      const trackHeights = { ...previous.trackHeights };
      if (height === null) delete trackHeights[trackId];
      else trackHeights[trackId] = height;
      const next = { ...previous, trackHeights };
      if (done) {
        try { persistRuntimePrefs(next, projectId); } catch { /* Session only. */ }
      }
      return next;
    });
  }, [projectId]);
  const [toolbarFeedback, setToolbarFeedback] = useState("");
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  // 轨道高度偏好同步到视图（行高固定，不随窗口压缩）。
  useEffect(() => {
    setView((value) => (value.trackHeight === prefs.trackHeight ? value : { ...value, trackHeight: prefs.trackHeight }));
  }, [prefs.trackHeight]);
  // Round 4: last pointer position (canvas coords) for edge auto-scroll.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Round 4: whether the in-flight marquee mousedown used Shift (keep selection).
  const shiftClickRef = useRef(false);
  // Round 4: context menu state (null = closed).
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target:
      | { kind: "clip"; clipId: TimelineClipId }
      | { kind: "caption"; captionId: string }
      | { kind: "transition"; transitionId: string }
      | { kind: "active-transition"; transitionId: string }
      | { kind: "empty"; trackId: string | null };
    timeUs: number;
  } | null>(null);
  const [trackMenu, setTrackMenu] = useState<{ trackId: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const trackDragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);
  const [trackDragTarget, setTrackDragTarget] = useState<string | null>(null);

  const clips = document?.clips ?? [];
  const captions = document?.captions ?? [];
  const transitions = document?.transitions ?? [];
  const tracks: TimelineTrack[] = document?.tracks ?? [];
  const totalUs = duration(document);
  const selectedSpeedClipIds = selection?.kind === "clip"
    ? [selection.id]
    : selection?.kind === "clips" ? selection.ids : [];
  const speedSelectionKey = [...selectedSpeedClipIds].sort().join("|");
  const speedModeActive = Boolean(speedModeKey && speedModeKey === speedSelectionKey);
  useEffect(() => {
    if (speedModeKey !== null && speedModeKey !== speedSelectionKey) setSpeedModeKey(null);
  }, [speedModeKey, speedSelectionKey]);
  useEffect(() => {
    if (!speedModeActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || interactionRef.current) return;
      const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null; isContentEditable?: boolean }) | null;
      if (target?.closest?.("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]") || target?.isContentEditable) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSpeedModeKey(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [speedModeActive]);
  useEffect(() => {
    if (!speedModeActive) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest?.("[role=menu], [data-speed-handle], [data-work-mode]")) return;
      if (canvasRef.current?.contains(target)) return;
      setSpeedModeKey(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [speedModeActive]);
  const fpsNum = document?.canvas?.fps_num && document?.canvas?.fps_den ? document.canvas.fps_num : 30;
  const fpsDen = document?.canvas?.fps_num && document?.canvas?.fps_den ? document.canvas.fps_den : 1;
  const frameRate = fpsNum / fpsDen;
  const frameUs = Math.max(1, 1_000_000 * fpsDen / fpsNum);
  // Preserve OpenFilm's absolute time scale when content duration changes; on
  // viewport resize the same relative zoom naturally scales with the width.
  // The canvas starts after the 132/28/12px track head; only its 51px cover rail
  // needs removing to get the time viewport width.
  useLayoutEffect(() => {
    const headerWidth = tracks.length > 0 ? DEFAULT_VIEW_STATE.headerWidth : 0;
    const timeWidth = Math.max(0, canvasSize.width - headerWidth);
    if (timeWidth <= 0) return;
    const previousTotalUs = previousTimelineDurationUsRef.current;
    previousTimelineDurationUsRef.current = totalUs;
    const projectZoom = previousTotalUs === null
      ? view.projectZoom
      : timelineZoomAfterDurationChange(previousTotalUs, totalUs, timeWidth, view.projectZoom);
    const pixelsPerSecond = timelineZoomToPps(totalUs, timeWidth, projectZoom);
    setView(current => {
      if (current.headerWidth === headerWidth && current.projectZoom === projectZoom && Math.abs(current.pixelsPerSecond - pixelsPerSecond) < 1e-7) return current;
      const next = { ...current, headerWidth, projectZoom, pixelsPerSecond };
      const { maxScrollX } = scrollBounds(next, totalUs, canvasSize.width);
      return { ...next, scrollX: clampScrollX(next.scrollX, maxScrollX) };
    });
  }, [canvasSize.width, totalUs, tracks.length, view.projectZoom]);
  const assetDurationById = useMemo(
    () => new Map(assetMedia.flatMap(media => typeof media.duration_us === "number" && Number.isFinite(media.duration_us)
      ? [[media.asset_id, media.duration_us] as const] : [])),
    [assetMedia],
  );
  // 播放头即时值（不触发 React 重渲染）：交互几何在事件发生的那一刻读取
  // store——播放期间组件完全静止，播放头推进只走覆盖层 useSyncExternalStore
  // 通道（不进入本组件的渲染/绘制路径）。
  const playheadUs = activePlayheadStore.get();
  void playheadUs; // 调试镜像值；交互路径一律 activePlayheadStore.get() 即时读取

  // Compute geometry：轨道行自上而下排列，行高固定（不随窗口大小压缩）；
  // 轨道过多时时间线区域纵向滚动。
  // 行数少、面板有余量时，行组在轨道区内垂直居中（2026-11-11，对齐 OpenFilm
  // 的 padTop：面板拉高后行组跟着居中，而不是贴着标尺、底下空一大片）。
  // OpenFilm 用的是标尺之后、底部滚动条之前的可视区高度；本组件的 body
  // canvas 同时覆盖固定标尺与滚动条，因此计算居中时必须扣掉两者。pane 顶部
  // 的 1px 分隔线已体现在 canvasSize.height 中，保留这一像素才能与 OpenFilm
  // 在 380px 时间线视口中的 track row 起点一致。
  const trackRows = useMemo(
    () => computeTrackRows(
      tracks,
      view.rulerHeight,
      view.trackHeight,
      Math.max(0, canvasSize.height - view.rulerHeight - SCROLLBAR_HEIGHT_PX + 1),
      prefs.trackHeights,
    ),
    [tracks, view.rulerHeight, view.trackHeight, canvasSize.height, prefs.trackHeights],
  );
  // 内容总高（标尺 + 行组 + 行间隙 + 横向滚动条条带）；画布与左栏同步按此伸展。
  // 行组居中后首行起点会下移（padTop），所以按「末行底边」算而不是把行高相加——
  // 否则居中的行会掉到内容区之外，canvas 不绘制它。
  // 下限取可视高度：行数少时内容仍铺满面板，底下那片空白才是可点击的轨道区。
  // The expanded head is 108px plus its 24px solo column; empty and collapsed states match OpenFilm.
  const trackHeadWidth = tracks.length === 0
    ? TIMELINE_HEAD_EMPTY_WIDTH
    : headsCollapsed ? TIMELINE_HEAD_COLLAPSED_WIDTH : TIMELINE_HEAD_EXPANDED_WIDTH;
  const rowsBottom = trackRows.reduce((max, row) => Math.max(max, row.y + row.height), view.rulerHeight);
  // 末行之下同样留 TRACK_VIEW_PAD（OpenFilm 的 paddingBottom: TL_VPAD）：
  // 下边距不是装饰——最后一轨贴住滚动条或被面板底边切掉都读不出来。
  const contentHeight = Math.max(
    rowsBottom + TRACK_VIEW_PAD + SCROLLBAR_HEIGHT_PX,
    canvasSize.height,
  );
  // 几何输出改为 useMemo 稳定引用（A06）：hover/播放头等无关状态更新不再
  // 重算 clipRects/captionRects/ticks，绘制 effect 依赖也随之稳定。
  const clipRects = useMemo(
    () => computeClipRects(clips, trackRows, view),
    [clips, trackRows, view],
  );
  // 拖拽提交态：文档仍与目标不一致时保持渲染在目标位置（防松手回弹）；
  // 文档更新到位后自动清除。2s 超时兜底（补丁失败时不残留幻影位置）。
  const keepValid =
    pendingKeep !== null &&
    (pendingKeep.placements.some(({ clipId, trackId, startUs }) => {
      const moved = clips.find(clip => clip.clip_id === clipId);
      return Boolean(moved && (moved.timeline_start_us !== startUs || moved.track_id !== trackId));
    }) || pendingKeep.copies.some(({ clipId, trackId, startUs }) => {
      const copy = clips.find(clip => clip.clip_id === clipId);
      return !copy || copy.timeline_start_us !== startUs || copy.track_id !== trackId;
    }));
  useEffect(() => {
    if (pendingKeep === null) return;
    if (!keepValid) {
      setPendingKeep(null);
      return;
    }
    const timer = window.setTimeout(() => setPendingKeep(null), 2000);
    return () => window.clearTimeout(timer);
  }, [pendingKeep, keepValid]);
  // 剪映式名称条：clip_id -> 素材文件名。
  const mediaById = useMemo(() => new Map(assetMedia.map(media => [media.asset_id, media])), [assetMedia]);
  const clipNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const clip of clips) {
      const name = mediaById.get(clip.asset_id)?.display_name;
      if (name) map.set(clip.clip_id, name);
    }
    return map;
  }, [clips, mediaById]);
  const captionRects = useMemo(
    () => computeCaptionRects(captions, trackRows, view),
    [captions, trackRows, view],
  );
  const transitionRects = useMemo(
    () => computeTransitionRects(clips, transitions, trackRows, view),
    [clips, transitions, trackRows, view],
  );
  const activeTransitionRects = useMemo(
    () => computeActiveTransitionRects(activeTransitions, clips, trackRows, view),
    [activeTransitions, clips, trackRows, view],
  );
  const activeTransitionResizeRef = useRef<{
    transition: ActiveTimelineTransition;
    edge: "start" | "end";
    startX: number;
    deltaUs: number;
  } | null>(null);
  const beginActiveTransitionResize = (
    rect: ActiveTransitionRenderRect,
    edge: "start" | "end",
    event: React.PointerEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (!rect.editable) return;
    const endpoints = [rect.transition.outgoing_clip_id, rect.transition.incoming_clip_id];
    const locked = endpoints.some(id => {
      const clip = clips.find(item => item.clip_id === id);
      return !clip || Boolean(document?.locked_elements?.includes(id) || tracks.find(track => track.id === clip.track_id)?.locked);
    });
    if (locked) return;
    setSelection({ kind: "active-transition", id: rect.transition.transition_id });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    activeTransitionResizeRef.current = { transition: rect.transition, edge, startX: event.clientX, deltaUs: 0 };
  };
  const moveActiveTransitionResize = (event: React.PointerEvent) => {
    const drag = activeTransitionResizeRef.current;
    if (!drag) return;
    drag.deltaUs = (event.clientX - drag.startX) / Math.max(0.001, view.pixelsPerSecond) * 1_000_000;
  };
  const endActiveTransitionResize = () => {
    const drag = activeTransitionResizeRef.current;
    activeTransitionResizeRef.current = null;
    if (!drag || Math.abs(drag.deltaUs) < 1) return;
    const operations = planActiveTransitionResize(
      drag.transition,
      clips,
      drag.edge,
      drag.deltaUs,
      fpsNum,
      fpsDen,
      assetDurationById,
    );
    if (operations?.length) {
      void onPatch(operations, `调整${drag.transition.kind}转场`);
    }
  };
  /* 空时间线不画刻度（用户指出：参照在没有素材时不显示刻度，有素材才显示）。
     手工建一条空时间线时，主轨上还没有任何片段——此时标尺只是一条干净的带子，
     刻度出现即暗示「这里有内容可以对齐」，实际没有。 */
  const ticks = useMemo(
    () => (clips.length === 0
      ? []
      : computeTimelineTicks(view.pixelsPerSecond, view.headerWidth, fpsNum, fpsDen, view.scrollX, canvasSize.width)),
    [clips.length, view.pixelsPerSecond, view.headerWidth, fpsNum, fpsDen, view.scrollX, canvasSize.width],
  );
  // Content-space clip rects (scrollX=0) for marquee selection hit testing.
  const contentClipRects = useMemo(
    () => computeClipRects(clips, trackRows, { ...view, scrollX: 0 }),
    [clips, trackRows, view.pixelsPerSecond, view.headerWidth, view.rulerHeight],
  );

  // Resize observer（B17：宽度取画布容器（flex 剩余宽），高度取滚动容器
  // 可视高（视口高——容器自身已是全内容高度，不再作高度来源））。
  useEffect(() => {
    const container = containerRef.current;
    const scroll = scrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = Math.floor(entry.contentRect.width);
        const height = Math.floor(scroll?.clientHeight ?? entry.contentRect.height);
        setCanvasSize({ width, height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Thumbnail frame cache: key = "clipId:source window:tier:cell" -> captured frame canvas.
  const thumbnailCache = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pendingImageKeys = useRef<Set<string>>(new Set());
  const [thumbnailVersion, setThumbnailVersion] = useState(0); // trigger re-render when frames load

  // A08：缩略图加载器——组件作用域 owner（非全局单例），请求带 viewport
  // epoch/priority；旧视口未开始的任务取消、超时 5s 不堵队列、完成回调
  // rAF 批量通知（详见 timeline/thumbnail-loader.ts）。
  // loader 持有走 state 而非渲染期 ref 惰性初始化：StrictMode（dev）的
  // setup→cleanup→setup 会 dispose 掉 ref 实例且 ref 不重建——之后所有请求
  // 静默返回 null，视频抽帧永不出现（安装版无双跑故不复现）。effect 里创建
  // /清理让 StrictMode 重挂载拿到新实例，生产行为不变。
  const [thumbnailLoader, setThumbnailLoader] = useState<ThumbnailLoader | null>(null);
  const projectIdRef = useRef<string | null>(document?.project_id ?? null);
  useEffect(() => { projectIdRef.current = document?.project_id ?? null; }, [document?.project_id]);
  // WP-P232：预抽 sprite 装载——素材出现在时间线时查 Core 条目，ready 则取
  // sprite（Main 换票）→ ImageBitmap 一次解码 → registerSprite；此后该素材的
  // 缩略格全部查表命中（零解码），运行时路径只兜底未预抽档位。
  //
  // P232 修复（真机复现「拖上时间线仍不显示抽帧」的根因）：旧实现把素材 id
  // 一次性记进 spriteLoadedRef 就再也不试——而导入→拖上轨道通常只隔几百毫秒，
  // 那时 filmstrip 作业还在 queued/running（实测真机大素材 6~75s 才 ready）。
  // 首次 filmstripMediaUrl 抛「未就绪」后 catch 静默、ref 已置位，sprite 永不
  // 登记，整条预抽链路等于没生效（只能靠运行时补抽兜底，档位不对就空格）。
  // 现在：只有真登记成功才置位；未就绪按退避重试（与 WaveformCache 同形态），
  // 作业 failed 或无视频流（ensure 报 MEDIA_NO_VIDEO）才放弃。
  const spriteLoadedRef = useRef<Set<string>>(new Set());
  /** 已放弃的素材（无视频流/作业失败/超时）——负缓存，防 effect 反复空转。 */
  const spriteSkippedRef = useRef<Set<string>>(new Set());
  /** 每素材在途装载的取消器：effect 重跑只取消「已不再需要」的素材，
   *  而不是把所有在途装载一起掐掉。旧写法在 cleanup 里无条件 cancel：
   *  assetMedia 每次引用变化（导入/选中/切轨都会重建数组）就重跑 effect，
   *  于是退避重试链被反复打断，sprite 永远等不到 ready —— 与「只试一次」
   *  是同一个症状的两种写法。 */
  const spriteInflightRef = useRef<Map<string, () => void>>(new Map());
  /** 已解码 sprite 的权威库（跨 loader 换代存活）：loader 只是消费端，
   *  换代时由下面的 effect 把库里所有条目重新登记进去。 */
  const spriteStoreRef = useRef<Map<string, FilmstripSprite>>(new Map());
  /** 当前 loader 的实时引用（装载链异步完成时用它投递，而非捕获启动时的实例）。 */
  const thumbnailLoaderRef = useRef<ThumbnailLoader | null>(null);
  useEffect(() => { thumbnailLoaderRef.current = thumbnailLoader; }, [thumbnailLoader]);
  useEffect(() => {
    if (!thumbnailLoader) return;
    const assetIds = new Set(assetMedia.map(media => media.asset_id));
    // 素材已离开时间线：取消其装载（减少无谓请求），但保留已登记的 sprite。
    for (const [assetId, cancel] of [...spriteInflightRef.current]) {
      if (!assetIds.has(assetId)) { cancel(); spriteInflightRef.current.delete(assetId); }
    }
    // 仍在途的素材不再重复起链（每素材单飞）。
    const pending = assetMedia.filter(media =>
      media.asset_id
      && !spriteInflightRef.current.has(media.asset_id)
      && !spriteLoadedRef.current.has(media.asset_id)
      && !spriteSkippedRef.current.has(media.asset_id),
    );
    if (pending.length === 0) return;
    for (const media of pending) {
      const cancel = loadFilmstripsOnce([media], {
        loader: {
          // 落库 + 投给"当前"loader：装载链可能跨越 loader 换代（StrictMode
          // 重挂载、面板重建），只把 bitmap 交给启动时捕获的实例会让新实例
          // 查表永远 miss——真机表现「sprite 明明 ready 了，格子还是空」。
          registerSprite: (assetId, entry) => {
            spriteStoreRef.current.set(assetId, entry);
            thumbnailLoaderRef.current?.registerSprite(assetId, entry);
          },
        },
        projectId: () => projectIdRef.current,
        isDone: () => false,
        markLoaded: () => spriteLoadedRef.current.add(media.asset_id),
        markSkipped: () => spriteSkippedRef.current.add(media.asset_id),
        unmarkLoaded: () => undefined,
        onLoaded: () => setThumbnailVersion(v => v + 1),
      });
      spriteInflightRef.current.set(media.asset_id, cancel);
    }
    // 注意：不返回清理函数——在途链跨 effect 轮次存活，由上面的差集取消。
  }, [assetMedia, thumbnailLoader]);

  // 卸载时取消全部在途装载：退避定时器若继续跑，会在组件消失后仍发 IPC/fetch，
  // 测试环境里表现为「上一个用例的定时器打断下一个用例」（已实测）。
  useEffect(() => () => {
    for (const cancel of spriteInflightRef.current.values()) cancel();
    spriteInflightRef.current.clear();
  }, []);

  // sprite 库 → 当前 loader：loader 换代后把已解码的 sprite 重新登记进去
  // （ImageBitmap 可重复登记，格采样只是 drawImage 源矩形裁切）。
  useEffect(() => {
    if (!thumbnailLoader) return;
    for (const [assetId, entry] of spriteStoreRef.current) {
      thumbnailLoader.registerSprite(assetId, entry);
    }
    if (spriteStoreRef.current.size > 0) setThumbnailVersion(v => v + 1);
  }, [thumbnailLoader]);

  useEffect(() => {
    const loader = new ThumbnailLoader({
      // 抽帧源：首选 filmstrip worker（WebCodecs 硬解，FIFO 出队 = 源时间
      // 单调 → 近似一次线性解码 pass）；不可用时 loader 内部降级 video seek。
      createFilmstripSource: defaultFilmstripSourceFactory(assetId => window.desktop.assetMediaTicket(assetId).then(result => result.media_url)),
      onBatchLoaded: keys => {
        const cache = thumbnailCache.current;
        if (!loader) return;
        let changed = false;
        for (const key of keys) {
          const frame = loader.peek(key);
          if (!frame) continue;
          cache.set(key, frame.canvas);
          const prefix = key.split(":").slice(0, -2).join(":");
          cache.set(`${prefix}:preview`, frame.canvas);
          changed = true;
        }
        if (changed) setThumbnailVersion(v => v + 1);
      },
    });
    setThumbnailLoader(loader);
    return () => {
      loader.dispose();
      setThumbnailLoader(current => (current === loader ? null : current));
    };
  }, []);

  // B14 波形：素材级金字塔缓存（App 注入；绘制路径按 clip 取窗）。
  // 版本号 = 金字塔 ready/失效信号——驱动主画布重绘（不随播放头变化）。
  const [waveformVersion, setWaveformVersion] = useState(0); // trigger re-render when peaks load

  // 抽帧：可见视频片段按帧时间请求（组件作用域 loader 串行 seek 抽帧）；
  // 图片素材直接用 <img> 加载。缩放只改变帧数档位（量化），旧帧保留兜底，
  // 新帧就绪后逐格替换——缩放时画面不消失。请求防抖
  // 200ms，连续缩放不触发重抽风暴。
  useEffect(() => {
    if (!thumbnailLoader) return; // StrictMode 重挂载间隙：新 loader 到位后再发请求
    const timer = window.setTimeout(() => {
      const cache = thumbnailCache.current;
      const clipIds = new Set(clips.map((clip) => clip.clip_id));
      thumbnailLoader.advanceViewport(); // 旧视口未开始的任务取消
      for (const rect of clipRects) {
        if (rect.x + rect.width < view.headerWidth - 400 || rect.x > canvasSize.width + 400) continue;
        const mediaUrl = mediaById.get(rect.clip.asset_id)?.media_url ?? null;
        const frames = computeFrameRequests(mediaUrl, rect.clip, view.pixelsPerSecond, {
          fromUs: xToTime(view.headerWidth - 400, view),
          toUs: xToTime(canvasSize.width + 400, view),
        });
        const cachePrefix = filmstripCachePrefix(rect.clip);
        for (let fi = 0; fi < frames.length; fi++) {
          // 可视区优先：只抽当前视口（±400px 余量）覆盖的格；平移/缩放后
          // effect 重跑，新进入视野的格按需补抽——seek 负载不随片段总长膨胀。
          // P230-②a 修复v2：余量 160→400。快速拖时间线时旧余量几乎每次
          // advanceViewport 都把刚排队的格取消（epoch 失配），新请求重排——
          // 用户看到的就是「拖动中缩略图时有时无」。400px ≈ 一屏的 1/3，
          // 拖动节奏下队列项大都在余量内存活；seek 负载仍不随总长膨胀。
          const cellLeft = timeToX(frames[fi].fromUs, view);
          const cellRight = timeToX(frames[fi].toUs, view);
          if (cellRight < -400 || cellLeft > canvasSize.width + 400) continue;
          // 键含档位帧数：档位变化 → 重新抽帧（时间点不同）；旧帧保留兜底。
          const key = `${cachePrefix}${frames[fi].keySuffix}`;
          if (cache.has(key) || pendingImageKeys.current.has(`${key}:img`)) continue;
          if (rect.clip.asset_kind === "image") {
            pendingImageKeys.current.add(`${key}:img`);
            const img = new Image();
            img.src = frames[fi].url;
            img.onload = () => {
              const captured = window.document.createElement("canvas");
              captured.width = Math.max(2, img.naturalWidth || 96);
              captured.height = Math.max(2, img.naturalHeight || 54);
              captured.getContext("2d")?.drawImage(img, 0, 0, captured.width, captured.height);
              cache.set(key, captured);
              cache.set(`${cachePrefix}:preview`, captured);
              pendingImageKeys.current.delete(`${key}:img`);
              setThumbnailVersion((v) => v + 1);
            };
            img.onerror = () => pendingImageKeys.current.delete(`${key}:img`);
            continue;
          }
          // 视口内（priority 0）优先，预读余量内（±400px）为 1。
          const inCoreViewport = cellLeft >= 0 && cellRight <= canvasSize.width;
          void thumbnailLoader.request({
            key,
            assetId: rect.clip.asset_id,
            url: frames[fi].url,
            timeSec: frames[fi].timeSec,
            priority: inCoreViewport ? 0 : 1,
            viewportEpoch: thumbnailLoader.viewportEpoch,
          });
        }
      }
      thumbnailLoader.prune(clipIds);
      for (const key of cache.keys()) {
        if (!clipIds.has(key.split(":")[0] as TimelineClipId)) cache.delete(key);
      }
      while (cache.size > 300) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }, 200);
    return () => window.clearTimeout(timer);
    // thumbnailVersion 入依赖：sprite 迟到登记（预抽作业 6~75s 才 ready）后，
    // 本 effect 必须再跑一轮——先前失败的格不在 cache 里，只有重新请求才能
    // 命中刚登记的 sprite 表。收敛性：请求成功的格写入 cache 后 cache.has 为真，
    // 下一轮直接跳过、不再 bump 版本（两轮内静止）；预抽后端为同步查表，
    // 不产生解码负载。
  }, [clipRects, mediaById, clips, view, canvasSize.width, thumbnailLoader, thumbnailVersion]);

  // B14：素材级持久化波形。Renderer 不再 fetch 整媒体 + decodeAudioData——
  // 峰值来自 Core 派生缓存（kind=waveform 金字塔产物，票据 URL 取件）。
  // 每素材 single-flight（waveformCache 内部）；ready 后 bump 触发重绘，
  // 绘制路径按 clip 源区间/速度/倒放从金字塔取窗（peaksFor 同步取）。
  useEffect(() => {
    if (!waveformCache) return;
    const viewLeft = view.headerWidth - 400;
    const viewRight = canvasSize.width + 400;
    for (const rect of clipRects) {
      const clip = rect.clip;
      if (clip.asset_kind === "image") continue;
      const source = mediaById.get(clip.asset_id);
      if (source?.kind === "video" && source.has_audio === false) continue;
      if (rect.x + rect.width <= viewLeft || rect.x >= viewRight) continue;
      void waveformCache.pyramidFor(clip.asset_id).then(pyramid => {
        if (pyramid) setWaveformVersion(v => v + 1);
      });
    }
  }, [clipRects, mediaById, view.scrollX, view.pixelsPerSecond, view.headerWidth, canvasSize.width, waveformCache]);

  // Canvas rendering
  // B17：画布 viewport 化——DOM 滚动空间保持全内容尺寸（.timeline-left 与
  // 容器高度=contentHeight），Canvas backing 仅覆盖 viewport+overscan
  // （纵向 2 轨），不分配等于所有轨道高度的大位图。画布在容器内绝对定位
  // （top 跟随 scrollTop），绘制时 ctx 平移 -canvasTopY 使内容坐标照常。
  const OVERSCAN_Y_PX = Math.max(
    160,
    OVERSCAN_ROWS * trackRows.reduce((max, row) => Math.max(max, row.height), 0),
  );
  const canvasTopY = Math.max(0, scrollTop - OVERSCAN_Y_PX);
  const canvasViewportHeight = Math.min(
    contentHeight - canvasTopY,
    canvasSize.height + 2 * OVERSCAN_Y_PX,
  );
  // Keep reverse strips on the mature Canvas path until their frame-tier mapping is
  // represented by the DOM compositor path as well.
  const filmstripClipRects = useMemo(() => {
    if (interaction?.kind !== "move" || interaction.copyOnStart) return clipRects;
    const positions = new Map((interaction.dragPlan?.reason ? [] : interaction.dragPlan?.placements ?? []).map(item => [item.clipId, item]));
    return clipRects.flatMap(source => {
      const clipId = source.clip.clip_id;
      if (clipId === interaction.clipId) {
        const durationUs = source.clip.timeline_end_us - source.clip.timeline_start_us;
        const rowOffset = interaction.currentY - interaction.startY;
        const previewStartUs = Math.round(interaction.previewStartUs);
        return [{
          ...source,
          clip: {
            ...source.clip,
            timeline_start_us: previewStartUs,
            timeline_end_us: previewStartUs + durationUs,
          },
          x: timeToX(previewStartUs, view),
          y: source.y + rowOffset,
        }];
      }
      const placement = positions.get(clipId);
      if (!placement || (placement.trackId === source.clip.track_id && placement.startUs === source.clip.timeline_start_us)) return [source];
      const row = trackRowOf(trackRows, placement.trackId);
      if (!row) return [source];
      const durationUs = source.clip.timeline_end_us - source.clip.timeline_start_us;
      return [{
        ...source,
        clip: {
          ...source.clip,
          track_id: placement.trackId,
          timeline_start_us: placement.startUs,
          timeline_end_us: placement.startUs + durationUs,
        },
        x: timeToX(placement.startUs, view),
        y: row.y,
        height: row.height,
      }];
    });
  }, [clipRects, interaction, trackRows, view]);
  const filmstripOverlayEnabled = pendingKeep === null
    && (interaction === null || (interaction.kind === "move" && !interaction.copyOnStart))
    && !filmstripClipRects.some(rect => rect.clip.reverse_playback);
  const hiddenTrackIds = useMemo(
    () => new Set(trackRows.filter(row => row.track.hidden).map(row => row.track.id)),
    [trackRows],
  );
  const filmstripOverlayGroups = useMemo(
    () => filmstripOverlayEnabled
      ? buildFilmstripOverlayGroups(
        filmstripClipRects,
        view,
        { top: scrollTop, bottom: scrollTop + canvasSize.height, width: canvasSize.width },
        thumbnailCache.current,
        spriteStoreRef.current,
        hiddenTrackIds,
      )
      : [],
    [filmstripOverlayEnabled, filmstripClipRects, view, scrollTop, canvasSize.width, canvasSize.height, thumbnailVersion, hiddenTrackIds],
  );
  const clipLabelRects = useMemo(() => {
    const visibleTop = scrollTop;
    const visibleBottom = scrollTop + canvasViewportHeight;
    return clipRects.flatMap((source) => {
      const activeMove = interaction?.kind === "move" && !interaction.copyOnStart && !interaction.dragPlan?.reason
        ? interaction
        : null;
      const movePlacement = activeMove?.dragPlan?.placements.find(item => item.clipId === source.clip.clip_id);
      const movingLead = activeMove?.clipId === source.clip.clip_id;
      const movedFollower = movePlacement && !movingLead &&
        (movePlacement.trackId !== source.clip.track_id || movePlacement.startUs !== source.clip.timeline_start_us)
        ? movePlacement
        : null;
      const targetRow = movedFollower ? trackRowOf(trackRows, movedFollower.trackId) : null;
      const moveClip = movedFollower
        ? {
          ...source.clip,
          track_id: movedFollower.trackId,
          timeline_start_us: movedFollower.startUs,
          timeline_end_us: movedFollower.startUs + (source.clip.timeline_end_us - source.clip.timeline_start_us),
        }
        : source.clip;
      const speedTarget = interaction?.kind === "speed" && interaction.linkedClipIds.includes(source.clip.clip_id)
        ? interaction.targets.find(target => target.clipId === source.clip.clip_id)
        : undefined;
      const speedClip = speedTarget ? {
        ...moveClip,
        timeline_start_us: speedTarget.startUs,
        timeline_end_us: speedTarget.endUs,
        speed_milli: speedTarget.speedMilli as TimelineClip["speed_milli"],
      } : moveClip;
      const speedRow = speedTarget ? trackRowOf(trackRows, speedTarget.trackId) : null;
      const leadY = movingLead && activeMove
        ? source.y + CLIP_ROW_INSET + activeMove.currentY - activeMove.startY
        : null;
      const base = {
        ...source,
        clip: speedClip,
        x: movingLead && activeMove
          ? timeToX(activeMove.previewStartUs, view)
          : movedFollower
            ? timeToX(movedFollower.startUs, view)
            : speedTarget ? timeToX(speedTarget.startUs, view) : source.x,
        width: speedTarget ? Math.max(1, ((speedTarget.endUs - speedTarget.startUs) / 1_000_000) * view.pixelsPerSecond) : source.width,
        y: leadY ?? (targetRow?.y ?? speedRow?.y ?? source.y) + CLIP_ROW_INSET,
        height: Math.max(4, (targetRow?.height ?? source.height) - CLIP_ROW_INSET * 2),
      };
      const rect = snapClipPaintRect(base, view.scrollX);
      if (rect.x + rect.width <= view.headerWidth || rect.x >= canvasSize.width ||
        rect.y + rect.height <= visibleTop || rect.y >= visibleBottom) return [];
      const durationUs = speedClip.timeline_end_us - speedClip.timeline_start_us;
      const title = clipNames.get(source.clip.clip_id) ??
        (source.clip.asset_kind === "audio" ? `音频 ${source.clip.order_index + 1}` : `片段 ${source.clip.order_index + 1}`);
      const kindKey = String(source.clip.asset_kind ?? "video");
      const headerColor = KIND_COLOR_VARS[kindKey]?.header ?? KIND_COLOR_VARS.video.header;
      const speedOnClip = speedModeActive && selectedSpeedClipIds.includes(source.clip.clip_id) && canChangeClipSpeed(source.clip);
      const shownSpeedMilli = speedTarget?.speedMilli ?? source.clip.speed_milli ?? 1_000;
      return [{
        id: source.clip.clip_id,
        title,
        headerColor: `var(${headerColor})`,
        hidden: hiddenTrackIds.has(speedClip.track_id),
        duration: `${(durationUs / 1_000_000).toFixed(durationUs < 1_000_000 ? 2 : 1)}s`,
        speed: speedOnClip && rect.width > 96 ? `${Number((shownSpeedMilli / 1_000).toPrecision(3))}×` : undefined,
        x: rect.x,
        // OpenFilm's title begins at the clip's half-pixel inset; the body
        // keeps its integer-row raster alignment.
        y: rect.y - 0.5,
        width: rect.width,
        height: rect.height,
        // rect.x is local to the canvas. The cover rail is already included in
        // rect.x, but OpenFilm pins the label to the viewport edge before that
        // rail, so its local pin boundary is zero.
        pinShift: clipLabelPinShift(rect.x, rect.width, 0),
        showDuration: rect.width > 64,
      }];
    });
  }, [clipRects, clipNames, view, canvasSize.width, scrollTop, canvasViewportHeight, interaction, trackRows, speedModeActive, selectedSpeedClipIds, hiddenTrackIds]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const canvasHeight = Math.max(1, Math.round(canvasViewportHeight));
    // 尺寸赋值前先比较 backing 大小（A06）：赋相同值会整幅清空画布状态并
    // 触发完整重置——播放头悬停等无关更新不再无谓清屏。
    const targetWidth = Math.max(1, Math.round(canvasSize.width * dpr));
    const targetHeight = Math.max(1, Math.round(canvasHeight * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    if (canvas.style.width !== `${canvasSize.width}px`) canvas.style.width = `${canvasSize.width}px`;
    if (canvas.style.height !== `${canvasHeight}px`) canvas.style.height = `${canvasHeight}px`;
    if (canvas.style.position !== "absolute") canvas.style.position = "absolute";
    if (canvas.style.left !== "0px") canvas.style.left = "0px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    editorPerf.record("timeline_draw");
    drawTimelineFrame(
      ctx,
      canvasSize.width,
      canvasHeight,
      view,
      trackRows,
      clipRects,
      captionRects,
      captions,
      selection,
      speedModeActive,
      interaction,
      hover,
      activePlayheadStore.get(),
      totalUs,
      document?.locked_elements ?? [],
      clipNames,
      frameRate,
      pendingKeep,
      filmstripOverlayEnabled ? undefined : thumbnailCache.current,
      filmstripOverlayEnabled ? undefined : spriteStoreRef.current,
      waveformCache ?? null,
      prefs.waveformRatio,
      canvasSize.height,
      // B17：内容 y → 画布 y 平移（画布顶=canvasTopY 内容坐标）
      canvasTopY,
      scrollTop,
    );
    // playheadUs 刻意不在依赖里：播放头绘制已拆到独立覆盖层，caption
    // 高亮按交互语义改由 selection/hover 驱动；播放期间主画布零重绘。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // themeEpoch：主题切换迫使画布重绘（颜色来自 CSS 变量，不重绘不会变）
  }, [canvasSize, view, trackRows, contentHeight, clipRects, captionRects, captions, selection, speedModeActive, interaction, hover, totalUs, thumbnailVersion, waveformVersion, clipNames, frameRate, pendingKeep, scrollTop, canvasTopY, canvasViewportHeight, themeEpoch, filmstripOverlayEnabled]);

  // 固定标尺条带：绘制到覆盖层 Canvas（随纵向滚动钉在可视区顶部）。
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rulerPointerId = useRef<number | null>(null);
  const rulerScrubOrigin = useRef(0);
  const rulerScrubbingRef = useRef(false);
  /** 擦洗态（镜像 rulerScrubbingRef，供旋钮实心/空心渲染）。
   *  ref 用于事件路径同步判断，state 只用于把"按住"这件事画出来。 */
  const [scrubbing, setScrubbing] = useState(false);
  /* 时间线编辑工具：选择、分割以及 OpenFilm 风格的边界/源窗口编辑。 */
  const [scrubMode, setScrubMode] = useState<TimelineMode>("select");
  // T3：离开分割模式即隐藏刀线（mode 切换发生在 ModePicker onPick）。
  useEffect(() => { if (scrubMode !== "split") hideBlade(); }, [scrubMode, hideBlade]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (scrollRef.current?.closest("[inert]")) return;
      const mode = timelineModeFromKeyEvent(event);
      if (!mode) return;
      event.preventDefault();
      setScrubMode(mode);
      setToolbarFeedback(mode === "split"
        ? "分割工具：在片段上单击可按指针位置分割。"
        : "选择工具：拖动片段移动，拖动边缘修剪。");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setToolbarFeedback]);
  /** 标记悬停/拖动时的贯穿引导线（null = 无）。 */
  const [markerGuide, setMarkerGuide] = useState<{ timeUs: number; color: string; held: boolean } | null>(null);
  const markerLaneRef = useRef<{ addAtTime: (timeUs: number) => void }>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() !== "m" || event.ctrlKey || event.metaKey || event.repeat ||
          target?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]") || !document || totalUs <= 0) return;
      event.preventDefault();
      const now = activePlayheadStore.get();
      if (event.shiftKey || event.altKey) {
        const times = markers.map(marker => marker.timeUs).sort((a, b) => a - b);
        const next = event.shiftKey ? times.find(time => time > now + 1_000) : [...times].reverse().find(time => time < now - 1_000);
        if (next !== undefined) { onSeek?.(next); onSeekCommit?.(next); }
      } else markerLaneRef.current?.addAtTime(Math.min(now, totalUs));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePlayheadStore, document, markers, onSeek, onSeekCommit, totalUs]);
  const [rangeButton, setRangeButton] = useState<HTMLButtonElement | null>(null);
  const rangeTrigger = useRef<HTMLButtonElement | null>(null);
  /** 时间区间选取（Shift + 在标尺上拖动）：只做视觉，不接任何操作。
   *  与播放头擦洗共用同一标尺，用 Shift 区分意图——标尺拖动本身是擦洗，
   *  加 Shift 才是框选，两者不抢同一个手势。 */
  const [timeRange, setTimeRange] = useState<TimeRange | null>(null);
  useEffect(() => { onRangeChange?.(timeRange); }, [onRangeChange, timeRange]);
  useEffect(() => { setTimeRange(null); }, [document?.project_id]);
  useEffect(() => {
    setTimeRange(current => {
      if (!current || current.endUs <= totalUs) return current;
      return totalUs - current.startUs >= MIN_RANGE_US ? { ...current, endUs: totalUs } : null;
    });
  }, [totalUs]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const key = event.key.toLowerCase();
      if ((key !== "i" && key !== "o") || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat ||
          target?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]") || !document || totalUs <= 0) return;
      event.preventDefault();
      const at = Math.min(Math.max(activePlayheadStore.get(), 0), totalUs);
      setTimeRange(current => {
        const startUs = key === "i" ? at : current?.startUs ?? 0;
        const endUs = key === "o" ? at : current?.endUs ?? totalUs;
        return endUs - startUs >= MIN_RANGE_US ? { startUs, endUs } : current;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePlayheadStore, document, totalUs]);
  const rangeDragRef = useRef<{ anchorUs: number; previous: TimeRange | null } | null>(null);
  useEffect(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = trackHeadWidth + canvasSize.width;
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(view.rulerHeight * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
    if (canvas.style.height !== `${view.rulerHeight}px`) canvas.style.height = `${view.rulerHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawRulerStrip(ctx, width, view.rulerHeight, trackHeadWidth, view, ticks, totalUs, rulerHoverUs);
  }, [view, canvasSize, trackHeadWidth, ticks, totalUs, rulerHoverUs, themeEpoch]);

  // 纵向滚动时把覆盖层钉在滚动容器可视区顶部（直接写样式，避免重渲染）。
  const rulerPinTimeAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return xToTime(event.clientX - rect.left - trackHeadWidth, view);
  };
  // 标尺寻址不越过素材终点（标尺本身也画到终点为止）。
  const clampRulerTime = (us: number) => (totalUs > 0 ? Math.min(us, totalUs) : us);
  const rulerSeekTime = (us: number) => {
    const clamped = clampRulerTime(us);
    if (!prefs.snappingEnabled) return clamped;
    const edges = [...clipRects.flatMap(({ clip }) => [clip.timeline_start_us, clip.timeline_end_us]), ...markers.map(marker => marker.timeUs), 0, totalUs];
    return clampRulerTime(snapValue(clamped, edges, (SNAP_PX / view.pixelsPerSecond) * 1_000_000));
  };
  const handleRulerPinMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (rulerPointerId.current !== null && rulerPointerId.current !== event.pointerId) return;
    if (rulerPointerId.current === null &&
        event.clientX - event.currentTarget.getBoundingClientRect().left < trackHeadWidth + view.headerWidth) {
      setRulerHoverUs(null);
      return;
    }
    const timeUs = clampRulerTime(rulerPinTimeAt(event));
    setRulerHoverUs(timeUs);
    const rangeDrag = rangeDragRef.current;
    if (rangeDrag) {
      setTimeRange(normalizeRange({ startUs: rangeDrag.anchorUs, endUs: timeUs }, totalUs));
      return;
    }
    if (rulerScrubbingRef.current) onSeek?.(rulerSeekTime(timeUs));
  };
  const handleRulerPinDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || rulerPointerId.current !== null || totalUs <= 0 ||
        event.clientX - event.currentTarget.getBoundingClientRect().left < trackHeadWidth + view.headerWidth) return;
    rulerPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    // Shift + 拖动 = 框选时间区间（不擦洗、不动播放头）。
    // 与普通拖动的区别只在 Shift，因此不会误触。
    if (event.shiftKey) {
      const anchorUs = clampRulerTime(rulerPinTimeAt(event));
      rangeDragRef.current = { anchorUs, previous: timeRange };
      setTimeRange({ startUs: anchorUs, endUs: anchorUs });
      return;
    }
    rulerScrubOrigin.current = activePlayheadStore.get();
    rulerScrubbingRef.current = true;
    setScrubbing(true);
    event.currentTarget.style.cursor = "col-resize";
    onSeek?.(rulerSeekTime(rulerPinTimeAt(event)));
  };
  const finishRulerGesture = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    if (rulerPointerId.current === null || rulerPointerId.current !== event.pointerId) return;
    rulerPointerId.current = null;
    const rangeDrag = rangeDragRef.current;
    rangeDragRef.current = null;
    if (rangeDrag) {
      const range = normalizeRange({ startUs: rangeDrag.anchorUs, endUs: clampRulerTime(rulerPinTimeAt(event)) }, totalUs);
      setTimeRange(commit && range && rangeDuration(range) >= MIN_RANGE_US ? range : rangeDrag.previous);
    } else if (rulerScrubbingRef.current) {
      onSeekCommit?.(commit ? rulerSeekTime(rulerPinTimeAt(event)) : rulerScrubOrigin.current);
    }
    rulerScrubbingRef.current = false;
    setScrubbing(false);
    setRulerHoverUs(null);
    event.currentTarget.style.cursor = "default";
  };
  const handleRulerPinDoubleClick = () => fitToContent();
  const rulerGuideX = rulerHoverUs === null ? null : trackHeadWidth + timeToX(rulerHoverUs, view);


  const timelineBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    let zoomExponent = 0;
    let anchorX: number | null = null;
    let pan = 0;
    const flush = () => {
      frame = 0;
      const factor = Math.exp(Math.max(-8, Math.min(8, zoomExponent)));
      const x = anchorX;
      const delta = pan;
      zoomExponent = 0;
      anchorX = null;
      pan = 0;
      setView(current => {
        const zoomed = x === null ? current : zoomAtAnchor(current, x, canvasSize.width, factor, totalUs);
        const { maxScrollX } = scrollBounds(zoomed, totalUs, canvasSize.width);
        const scrollX = clampScrollX(zoomed.scrollX + delta, maxScrollX);
        return scrollX === current.scrollX && zoomed.pixelsPerSecond === current.pixelsPerSecond
          ? current
          : { ...zoomed, scrollX };
      });
    };
    const onWheel = (event: WheelEvent) => {
      // OpenFilm registers this handler on .tl-scroll, which starts to the
      // right of its fixed track heads. Vortex keeps heads inside
      // .timeline-scroll, so preserve the same horizontal-input boundary.
      const scrollLeft = scroll.getBoundingClientRect().left;
      if (event.clientX < scrollLeft + trackHeadWidth) return;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (!event.deltaY) return;
        const left = canvasRef.current?.getBoundingClientRect().left ?? scrollLeft + trackHeadWidth;
        anchorX = event.clientX - left;
        zoomExponent -= event.deltaY * units / 180;
      } else if (timelineWheelPanDelta(event.deltaX, event.deltaY, event.deltaMode, event.shiftKey) !== 0) {
        // OpenFilm lets a non-Shift trackpad's vertical component continue to
        // scroll the rows while applying deltaX horizontally. Shift+wheel is
        // the only horizontal gesture that consumes the browser default.
        if (event.shiftKey) event.preventDefault();
        pan += timelineWheelPanDelta(event.deltaX, event.deltaY, event.deltaMode, event.shiftKey);
      } else {
        if (event.target instanceof Node && !scroll.contains(event.target)) {
          event.preventDefault();
          scroll.scrollTop += event.deltaY * units;
        }
        return;
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroll.removeEventListener("wheel", onWheel);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [canvasSize.width, totalUs, trackHeadWidth]);

  /** Set relative project zoom while preserving the time at the viewport center. */
  const setZoomAnchored = useCallback(
    (zoomTarget: number) => {
      setView((v) =>
        zoomAtAnchor(
          v,
          canvasSize.width / 2,
          canvasSize.width,
          clampTimelineZoom(zoomTarget, totalUs) / Math.max(1e-9, v.projectZoom),
          totalUs,
        ),
      );
    },
    [canvasSize.width, totalUs],
  );

  const toggleSnapping = useCallback(() => {
    setPrefs((prev) => {
      const next = { ...prev, snappingEnabled: !prev.snappingEnabled };
      try {
        persistRuntimePrefs(next, projectId);
      } catch {
        // Storage unavailable — prefs stay session-only.
      }
      return next;
    });
  }, [projectId]);

  const toggleTimelinePref = useCallback((key: "mainTrackMagnet" | "linkageEnabled") => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { persistRuntimePrefs(next, projectId); } catch { /* Session only. */ }
      return next;
    });
  }, [projectId]);

  const updateTimelinePrefs = useCallback((update: (current: TimelineRuntimePrefs) => TimelineRuntimePrefs) => {
    setPrefs(current => {
      const next = update(current);
      try { persistRuntimePrefs(next, projectId); } catch { /* Session only. */ }
      return next;
    });
  }, [projectId]);

  // ── Pointer interactions (Phase 4) ─────────────────────────────────────────

  const canvasCoords = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // B17：指针 y 以画布内容空间顶（canvasTopY，闭包捕获——与 render 写入
    // style.top 的值同一来源，逐事件取最新渲染的闭包）回加得内容空间 y，
    // 命中/交互几何与 viewport 化之前完全一致。
    return { x: event.clientX - rect.left, y: event.clientY - rect.top + canvasTopY };
  };

  const isClipLocked = (clipId: TimelineClipId, alone = false) => {
    const clip = clips.find((c) => c.clip_id === clipId);
    if (!clip) return false;
    const members = clip.link_group_id && !alone ? clips.filter(item => item.link_group_id === clip.link_group_id) : [clip];
    return members.some(member => Boolean(document?.locked_elements?.includes(member.clip_id) || tracks.find(track => track.id === member.track_id)?.locked));
  };
  const linkedSelection = (clip: TimelineClip): Extract<NonNullable<TimelineSelection>, { kind: "clip" | "clips" }> => {
    const ids = clip.link_group_id ? clips.filter(item => item.link_group_id === clip.link_group_id).map(item => item.clip_id) : [clip.clip_id];
    return ids.length === 1 ? { kind: "clip", id: ids[0] } : { kind: "clips", ids };
  };
  const getAdvancedEditPlan = useCallback((mode: AdvancedEditMode, clipIds: readonly string[], deltaUs: number) => {
    if (!document) return null;
    return planAdvancedEdit(document, mode, clipIds, deltaUs, frameUs, assetDurationById);
  }, [document, frameUs, assetDurationById]);
  const beginAdvancedEdit = useCallback((mode: AdvancedEditMode, clipIds: string[], startX: number, canvas: HTMLCanvasElement) => {
    const plan = getAdvancedEditPlan(mode, clipIds, 0);
    if (!plan || plan.reason) {
      setToolbarFeedback(plan?.reason ?? "时间线尚不可编辑");
      return false;
    }
    const next: TimelineInteraction = {
      kind: "edge-edit", mode, clipIds: clipIds as TimelineClipId[], startX, startScrollX: viewRef.current.scrollX,
      deltaUs: 0, targets: plan.targets, operations: plan.operations, snapUs: null,
    };
    interactionRef.current = next;
    setInteraction(next);
    canvas.style.cursor = "ew-resize";
    return true;
  }, [getAdvancedEditPlan]);
  const toggleClipSelection = (clip: TimelineClip, alone = false): TimelineSelection => {
    const currentIds = selection?.kind === "clip" ? [selection.id] : selection?.kind === "clips" ? selection.ids : [];
    const linked = alone ? { kind: "clip" as const, id: clip.clip_id } : linkedSelection(clip);
    const ids = linked.kind === "clips" ? linked.ids : [linked.id];
    const next = currentIds.includes(clip.clip_id) ? currentIds.filter(id => !ids.includes(id)) : [...new Set([...currentIds, ...ids])];
    return next.length === 0 ? null : next.length === 1 ? { kind: "clip", id: next[0] } : { kind: "clips", ids: next };
  };

  /** Resolve a drop from the pointer's real row and OpenFilm's clip/lane edge zones. */
  const resolveDragTargeting = useCallback(
    (active: MoveInteraction): { targetTrackId: string | null; pointerRatio: number; dropHit: ReturnType<typeof timelineDropHit> } => {
      const draggedClip = clips.find((c) => c.clip_id === active.clipId);
      // OpenFilm removes linked main-track riders from clip-drop hit testing while linkage is on.
      // Their row remains a valid destination; the rider itself cannot become a replace/edge target.
      const excluded = timelineDragDropExcludedClipIds(
        active.clipIds,
        active.linkedRiderClipIds,
        prefs.linkageEnabled,
      );
      const hit = timelineDropHit(active.currentX, active.currentY, trackRows, clipRects, excluded);
      // OpenFilm copy gestures ignore clip edge/replace targets; they still honor the row's lane band.
      const dropHit = active.copyOnStart && hit.band === "body"
        ? { ...hit, clipId: null, zone: null }
        : hit;
      if (!draggedClip) return { targetTrackId: null, pointerRatio: 0, dropHit };
      let pointerRatio = 0;
      const row = dropHit.rowIndex >= 0 ? trackRows[dropHit.rowIndex] : null;
      const targetTrackId = dropHit.band === "body" && row
        ? row.track.id
        : null;
      if (dropHit.clipId) {
        const targetRect = clipRects.find(rect => rect.clip.clip_id === dropHit.clipId);
        if (targetRect?.width) pointerRatio = Math.max(0, Math.min(1, (active.currentX - targetRect.x) / targetRect.width));
      }
      return { targetTrackId, pointerRatio, dropHit };
    },
    [clips, trackRows, clipRects, prefs.linkageEnabled],
  );

  // ── 轨道管理：新增/删除/换位/属性开关 ────────────────────────────────────
  const addTrack = (kind: "video" | "text") => {
    void onPatch(
      [{ op: "add_track", kind }],
      kind === "video" ? "添加视频轨道" : "添加文本轨道",
    );
  };
  const patchTrackFlags = (
    trackId: string,
    flags: { locked?: boolean; hidden?: boolean; muted?: boolean; solo?: boolean },
  ) => {
    void onPatch([{ op: "set_track_flags", track_id: trackId, ...flags }], "调整轨道属性");
  };
  const handleCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      pointerDragLiftedRef.current = false;
      collapseSelectedClickRef.current = null;
      activeCanvasPointerIdRef.current = event.pointerId;
      lastClientPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        altKey: Boolean(event.altKey),
      };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Detached target or test DOM. */ }
      setContextMenu(null);
      const coords = canvasCoords(event);
      if (!coords) return;
      lastClientPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        altKey: Boolean(event.altKey),
      };
      const { x, y } = coords;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (x < view.headerWidth) {
        if (speedModeActive) setSpeedModeKey(null);
        return;
      }
      let speedHandle: ReturnType<typeof hitTestTrimHandle> = null;
      if (speedModeActive) {
        for (const id of selectedSpeedClipIds) {
          const candidate = clips.find(clip => clip.clip_id === id);
          if (!candidate || !canChangeClipSpeed(candidate) || isClipLocked(candidate.clip_id)) continue;
          const candidateRect = clipRects.find(rect => rect.clip.clip_id === id);
          if (!candidateRect) continue;
          speedHandle = hitTestTrimHandle(x, y, [candidateRect]);
          if (speedHandle) break;
        }
        if (!speedHandle) setSpeedModeKey(null);
      }

      // Bottom scrollbar strip → scrollbar drag (Round 4)
      // B17：滚动条钉在可视区底部——内容空间 y 带 = scrollTop + 视口高。
      const { maxScrollX } = scrollBounds(view, totalUs, canvasSize.width);
      const scrollbarBandTop = scrollTopRef.current + canvasSize.height - SCROLLBAR_HEIGHT_PX;
      if (maxScrollX > 0 && y >= scrollbarBandTop) {
        const next: TimelineInteraction = {
          kind: "scrollbar",
          startX: x,
          startScrollX: view.scrollX,
        };
        interactionRef.current = next;
        setInteraction(next);
        canvas.style.cursor = "col-resize";
        return;
      }

      // Ruler area → playhead drag（寻址钳制在素材终点内）
      if (y <= view.rulerHeight) {
        const startTimeUs = activePlayheadStore.get();
        const timeUs = clampRulerTime(xToTime(x, view));
        onSeek?.(timeUs);
        const next: TimelineInteraction = { kind: "playhead", startX: x, startTimeUs };
        interactionRef.current = next;
        setInteraction(next);
        // 擦洗态必须在这里也置位：本路径是「在标尺区按下开始拖播放头」，
        // 与 handleRulerPinDown 是两条入口。此前只在后者里 setScrubbing(true)，
        // 于是一路拖动时旋钮一直是空心的（参照：按住实心、松开空心）。
        rulerScrubbingRef.current = true;
        setScrubbing(true);
        canvas.style.cursor = "col-resize";
        return;
      }

      // Transition marker → select (checked before clips; markers overlap edges)
      const activeTransitionId = hitTestActiveTransitions(x, y, activeTransitionRects);
      if (activeTransitionId) {
        setSelection({ kind: "active-transition", id: activeTransitionId });
        return;
      }
      const transitionId = hitTestTransitions(x, y, transitionRects);
      if (transitionId) {
        setSelection({ kind: "transition", id: transitionId });
        return;
      }

      // Trim handle → trim drag (must take priority over plain clip hit)
      const handle = speedHandle ?? hitTestTrimHandle(x, y, clipRects);
      if (speedHandle) {
        const clip = clips.find(candidate => candidate.clip_id === speedHandle!.clipId);
        if (!clip || isClipLocked(clip.clip_id, event.altKey)) return;
        const linkedClipIds = clip.link_group_id && !event.altKey
          ? clips.filter(member => member.link_group_id === clip.link_group_id && !isClipLocked(member.clip_id, true) && canChangeClipSpeed(member)).map(member => member.clip_id)
          : [clip.clip_id];
        if (!selectedSpeedClipIds.includes(clip.clip_id)) {
          setSelection(event.altKey ? { kind: "clip", id: clip.clip_id } : linkedSelection(clip));
        }
        const next: TimelineInteraction = {
          kind: "speed",
          clipId: clip.clip_id,
          linkedClipIds,
          ignoreLink: event.altKey,
          edge: speedHandle.edge,
          startX: x,
          startScrollX: view.scrollX,
          originalSpeedMilli: clip.speed_milli ?? 1_000,
          targetSpeedMilli: clip.speed_milli ?? 1_000,
          originalTimelineStartUs: clip.timeline_start_us,
          originalTimelineEndUs: clip.timeline_end_us,
          targetTimelineStartUs: clip.timeline_start_us,
          targetTimelineEndUs: clip.timeline_end_us,
          targets: [],
          operations: [],
          snapUs: null,
        };
        interactionRef.current = next;
        setInteraction(next);
        canvas.style.cursor = "ew-resize";
        return;
      }
      if (handle && scrubMode === "roll") {
        const clip = clips.find((c) => c.clip_id === handle.clipId);
        if (!clip || isClipLocked(handle.clipId)) return;
        const adjacent = clips.find(candidate => candidate.track_id === clip.track_id &&
          (handle.edge === "right" ? candidate.timeline_start_us === clip.timeline_end_us : candidate.timeline_end_us === clip.timeline_start_us));
        if (!adjacent) {
          setToolbarFeedback("滚动修剪需要拖动两个首尾相接片段的公共边缘");
          return;
        }
        const clipIds = handle.edge === "right" ? [clip.clip_id, adjacent.clip_id] : [adjacent.clip_id, clip.clip_id];
        setSelection({ kind: "clips", ids: clipIds });
        beginAdvancedEdit("roll", clipIds, x, canvas);
        return;
      }
      if (handle && (scrubMode === "slip" || scrubMode === "slide")) {
        setToolbarFeedback(scrubMode === "slip" ? "滑移素材请拖动片段主体" : "滑动片段请拖动片段主体");
        return;
      }
      if (handle && !isClipLocked(handle.clipId, true)) {
        const clip = clips.find((c) => c.clip_id === handle.clipId);
        if (clip) {
          const linkedClipIds = clip.link_group_id && !event.altKey
            ? clips.filter(member => member.link_group_id === clip.link_group_id && !isClipLocked(member.clip_id, true)).map(member => member.clip_id)
            : [clip.clip_id];
          setSelection(event.altKey ? { kind: "clip", id: handle.clipId } : linkedSelection(clip));
          const next: TimelineInteraction = {
            kind: "trim",
            clipId: handle.clipId,
            linkedClipIds,
            ignoreLink: event.altKey,
            edge: handle.edge,
            startX: x,
            startScrollX: view.scrollX,
            originalStartUs: clip.source_start_us ?? 0,
            originalEndUs: clip.source_end_us ?? 0,
            targetStartUs: clip.source_start_us ?? 0,
            targetEndUs: clip.source_end_us ?? 0,
            originalTimelineStartUs: clip.timeline_start_us,
            originalTimelineEndUs: clip.timeline_end_us,
            targetTimelineStartUs: clip.timeline_start_us,
            targetTimelineEndUs: clip.timeline_end_us,
            snapUs: null,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "ew-resize";
          return;
        }
      }

      // Volume line → gain drag (checked after trim handles; Round 5)
      const volumeId = hitTestVolumeLine(x, y, clipRects, isClipLocked, prefs.waveformRatio);
      if (volumeId) {
        const clip = clips.find((c) => c.clip_id === volumeId);
        if (clip) {
          setSelection({ kind: "clip", id: volumeId });
          const next: TimelineInteraction = {
            kind: "volume",
            clipId: volumeId,
            startY: y,
            startGainDb: clip.audio.gain_db,
            targetGainDb: clip.audio.gain_db,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "ns-resize";
          return;
        }
      }

      // Clip body → move drag (single) or group move (multi-selection of A1)
      const clipId = hitTestClips(x, y, clipRects);
      if (clipId) {
        // A locked linked partner is left in place (OpenFilm's writable crowd); only the grabbed clip itself blocks
        // the gesture. Alt-copy already acts on the grabbed clip alone.
        if (isClipLocked(clipId, true)) return;
        const clip = clips.find((c) => c.clip_id === clipId);
        if (!clip) return;
        if ((event.metaKey || event.ctrlKey) && scrubMode !== "split") {
          const selectedIds = selection?.kind === "clip"
            ? [selection.id]
            : selection?.kind === "clips" ? selection.ids : [];
          const linkedIds = linkedSelection(clip);
          const members = linkedIds.kind === "clips" ? linkedIds.ids : [linkedIds.id];
          const nextIds = selectedIds.includes(clipId)
            ? selectedIds.filter(id => !members.includes(id))
            : [...new Set([...selectedIds, ...members])];
          setSelection(nextIds.length === 0 ? null : nextIds.length === 1
            ? { kind: "clip", id: nextIds[0]! }
            : { kind: "clips", ids: nextIds });
          return;
        }
        // The blade cuts at the pointer; the toolbar and shortcut cut at the playhead.
        if (scrubMode === "split") {
          const cutUs = clampRulerTime(xToTime(x, view));
          const operation = splitClipAt(clip, cutUs, document);
          if (operation) void onPatch([operation], "分割片段");
          hideBlade();
          return;
        }
        let selectionForDrag = selection;
        if (event.shiftKey && !event.altKey) {
          const selectedIds = selection?.kind === "clip"
            ? [selection.id]
            : selection?.kind === "clips" ? selection.ids : [];
          const wasSelected = selectedIds.includes(clipId);
          if (wasSelected) {
            // Keep the group while the pointer is down. OpenFilm collapses to
            // the clicked clip on a no-move release, but drags the whole group.
            collapseSelectedClickRef.current = { clipId, alone: Boolean(event.altKey) };
            selectionForDrag = selection;
          } else {
            selectionForDrag = toggleClipSelection(clip, event.altKey);
            setSelection(selectionForDrag);
          }
        } else if (!event.altKey) {
          const selectedIds = selection?.kind === "clip"
            ? [selection.id]
            : selection?.kind === "clips" ? selection.ids : [];
          if (selectedIds.length > 1 && selectedIds.includes(clipId)) {
            collapseSelectedClickRef.current = { clipId, alone: false };
          }
        } else {
          const selectedIds = selection?.kind === "clip"
            ? [selection.id]
            : selection?.kind === "clips" ? selection.ids : [];
          if (selectedIds.length > 1 && selectedIds.includes(clipId)) {
            collapseSelectedClickRef.current = { clipId, alone: true };
          }
        }
        if (event.altKey && !collapseSelectedClickRef.current) {
          collapseSelectedClickRef.current = { clipId, alone: true };
        }
        if (scrubMode === "roll") {
          setSelection(linkedSelection(clip));
          setToolbarFeedback("滚动修剪：请拖动相邻片段的公共边缘");
          return;
        }
        if (scrubMode === "slip") {
          setSelection({ kind: "clip", id: clip.clip_id });
          beginAdvancedEdit("slip", [clip.clip_id], x, canvas);
          return;
        }
        if (scrubMode === "slide") {
          const rowClips = clips.filter(item => item.track_id === clip.track_id).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
          const index = rowClips.findIndex(item => item.clip_id === clip.clip_id);
          const previous = rowClips[index - 1];
          const next = rowClips[index + 1];
          if (!previous || !next) {
            setSelection({ kind: "clip", id: clip.clip_id });
            setToolbarFeedback("滑动编辑需要选中轨道中间、且两侧无空隙的片段");
            return;
          }
          setSelection({ kind: "clip", id: clip.clip_id });
          beginAdvancedEdit("slide", [previous.clip_id, clip.clip_id, next.clip_id], x, canvas);
          return;
        }
        const selectedGroup = selectionForDrag?.kind === "clips" && selectionForDrag.ids.includes(clipId)
          ? selectionForDrag.ids
          : selectionForDrag?.kind === "clip" && selectionForDrag.id === clipId ? [selectionForDrag.id] : [clipId];
        const capturedClipIds = [...new Set(selectedGroup.flatMap(id => {
          const member = clips.find(item => item.clip_id === id);
          return member?.link_group_id
            ? clips.filter(item => item.link_group_id === member.link_group_id).map(item => item.clip_id)
            : [id];
        }))].filter(id => clips.some(item => item.clip_id === id) && !isClipLocked(id as TimelineClipId, true));
        const capturedMembers = capturedClipIds.map(id => clips.find(item => item.clip_id === id)!).filter(Boolean);
        const copyIds = event.altKey ? capturedClipIds.map(() => createTimelineClipId()) : [];
        const moveClipIds = capturedMembers.map(member => member.clip_id);
        const linkedRiderClipIds = document
          ? linkedRiderClipIdsForDrag(document, moveClipIds, event.altKey)
          : [];
        if (prefs.snappingEnabled) {
          const makeSnapTargets = (excluded: Set<TimelineClipId>) => orderedMoveSnapTargets(
            clipRects,
            markers.map(marker => marker.timeUs),
            excluded,
          );
          const withoutRiders = makeSnapTargets(new Set(moveClipIds));
          const withRiderExclusions = new Set(moveClipIds);
          for (const riderId of linkedRiderClipIds) withRiderExclusions.add(riderId);
          const withRiders = makeSnapTargets(withRiderExclusions);
          moveSnapTargetsRef.current = {
            clipRects,
            markers,
            withoutRiders: withoutRiders.times,
            withRiders: withRiders.times,
            withoutRidersOrder: withoutRiders.orderByTime,
            withRidersOrder: withRiders.orderByTime,
          };
        } else {
          moveSnapTargetsRef.current = null;
        }
        if (!event.altKey) {
          setSelection(capturedClipIds.length > 1
            ? { kind: "clips", ids: capturedClipIds }
            : { kind: "clip", id: capturedClipIds[0] ?? clipId });
        } else if (!(selection?.kind === "clips" && selection.ids.includes(clipId))) {
          setSelection(capturedClipIds.length > 1
            ? { kind: "clips", ids: capturedClipIds }
            : { kind: "clip", id: clipId });
        }
        const next: TimelineInteraction = {
          kind: "move",
          clipId,
          ignoreLink: false,
          startX: x,
          startY: y,
          currentX: x,
          currentY: y,
          startUs: clip.timeline_start_us,
          previewStartUs: clip.timeline_start_us,
          targetStartUs: clip.timeline_start_us,
          targetTrackId: null,
          resolution: null,
          snapUs: null,
          copyOnStart: event.altKey,
          moveMode: "place",
          clipIds: moveClipIds,
          linkedRiderClipIds,
          copyIds,
          dragPlan: null,
          dropHit: null,
        };
        interactionRef.current = next;
        setInteraction(next);
        return;
      }

      // B4：字幕端点拖拽（C1 轨；±8px 边缘容差，复用 trim 交互）。
      const CAPTION_EDGE_PX = 8;
      const captionHit = hitTestCaptions(x, y, captionRects);
      if (captionHit) {
        const caption = captions.find((c) => c.caption_id === captionHit);
        const rect = captionRects.find((r) => r.caption.caption_id === captionHit);
        if (caption && rect) {
          const fromLeft = x <= rect.x + CAPTION_EDGE_PX;
          const fromRight = x >= rect.x + rect.width - CAPTION_EDGE_PX;
          if (fromLeft || fromRight) {
            setSelection({ kind: "caption", id: captionHit });
            const next: TimelineInteraction = {
              kind: "caption-trim",
              captionId: captionHit,
              edge: fromLeft ? "left" : "right",
              startX: x,
              startScrollX: view.scrollX,
              originalStartUs: caption.start_us,
              originalEndUs: caption.end_us,
              targetStartUs: caption.start_us,
              targetEndUs: caption.end_us,
            };
            interactionRef.current = next;
            setInteraction(next);
            canvas.style.cursor = "ew-resize";
            return;
          }
        }
      }

      // Caption → 整体拖拽启动（B4 追加；松手提交 set_caption_timing 平移）。
      const captionId = hitTestCaptions(x, y, captionRects);
      if (captionId) {
        const caption = captions.find((c) => c.caption_id === captionId);
        if (caption) {
          setSelection({ kind: "caption", id: captionId });
          const next: TimelineInteraction = {
            kind: "caption-move",
            captionId,
            startX: x,
            startScrollX: view.scrollX,
            startY: y,
            originalStartUs: caption.start_us,
            originalEndUs: caption.end_us,
            targetStartUs: caption.start_us,
            targetEndUs: caption.end_us,
          };
          interactionRef.current = next;
          setInteraction(next);
          return;
        }
      }

      // V1 boundary gap → offer adding a transition (B2)
      const gapAnchor = hitTestTransitionGap(x, y, clipRects);
      if (gapAnchor) {
        setSelection(null);
        setAddTransitionAnchor(gapAnchor);
        return;
      }

      // T13 参照 Timeline.tsx:1869-1935：空白按下即起框选（≥5px 成框，未成框的单击
      // 在松手时定位播放头——见 marquee 终点分支）；⇧/⌘ = 加选（旧选区保留合并）。
      setSelection(event.shiftKey || event.metaKey || event.ctrlKey ? selection : null);
      shiftClickRef.current = event.shiftKey || event.metaKey || event.ctrlKey;
      const next: TimelineInteraction = {
        kind: "marquee",
        startX: x + view.scrollX,
        startClientX: event.clientX,
        startY: y,
        currentX: x + view.scrollX,
        currentY: y,
      };
      interactionRef.current = next;
      setInteraction(next);
      canvas.style.cursor = "crosshair";
    },
    [view.rulerHeight, view, onSeek, clipRects, clips, captionRects, captions, setSelection, selection, totalUs, canvasSize.width, canvasSize.height, trackRows, scrubMode, beginAdvancedEdit, activeTransitionRects, transitionRects, document, markers, prefs.snappingEnabled, speedModeActive, selectedSpeedClipIds, setSpeedModeKey],
  );

  const processCanvasPointerMove = useCallback(
    (event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId" | "altKey">) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const coords = canvasCoords(event);
      if (!coords) return;
      const { x, y } = coords;

      // T3：分割模式下刀线跟随指针（直写 DOM）。
      if (!interactionRef.current && scrubMode === "split") {
        const clipId = hitTestClips(x, y, clipRects);
        const rect = clipId ? clipRects.find(r => r.clip.clip_id === clipId) : null;
        aimBlade(x, y, rect ? { y: rect.y, height: rect.height } : null);
      }
      const active = interactionRef.current;
      if (active) {
        lastPointerRef.current = { x, y };
        if (!pointerDragLiftedRef.current) {
          if (active.kind === "move" || active.kind === "group-move" || active.kind === "caption-move") {
            if (!hasLiftedTimelineDrag("move", x - active.startX, y - active.startY)) return;
            pointerDragLiftedRef.current = true;
            collapseSelectedClickRef.current = null;
          } else if (active.kind === "marquee") {
            if (!hasLiftedTimelineDrag("marquee", event.clientX - active.startClientX, 0)) return;
            pointerDragLiftedRef.current = true;
          } else if (active.kind === "trim" || active.kind === "speed" || active.kind === "edge-edit" || active.kind === "caption-trim") {
            if (!hasLiftedTimelineDrag("edge", x - active.startX, 0)) return;
            pointerDragLiftedRef.current = true;
          }
        }
        const pps = view.pixelsPerSecond;
        if (active.kind === "playhead") {
          onSeek?.(clampRulerTime(xToTime(x, view)));
          canvas.style.cursor = "col-resize";
          return;
        }
        if (active.kind === "volume") {
          const rect = clipRects.find((r) => r.clip.clip_id === active.clipId);
          const band = rect ? clipAudioBand(rect.clip, rect, prefs.waveformRatio) : null;
          if (rect && band) {
            const next: TimelineInteraction = {
              ...active,
              targetGainDb: Math.round(yToVolume(y, band) * 10) / 10,
            };
            interactionRef.current = next;
            setInteraction(next);
            canvas.style.cursor = "ns-resize";
            return;
          }
        }
        if (active.kind === "scrollbar") {
          const { maxScrollX } = scrollBounds(view, totalUs, canvasSize.width);
          const nextScrollX = clampScrollX(active.startScrollX + (x - active.startX), maxScrollX);
          setView((v) => ({ ...v, scrollX: nextScrollX }));
          canvas.style.cursor = "col-resize";
          return;
        }
        if (active.kind === "marquee") {
          // Marquee coords are content-space so auto-scroll keeps the rect anchored.
          const next: TimelineInteraction = {
            ...active,
            currentX: x + view.scrollX,
            currentY: y,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "crosshair";
          return;
        }
        if (active.kind === "move") {
          const deltaUs = ((x - active.startX) / pps) * 1_000_000;
          const movingClip = clips.find(c => c.clip_id === active.clipId);
          const captured = active.clipIds.map(id => clips.find(clip => clip.clip_id === id)).filter((clip): clip is TimelineClip => Boolean(clip));
          const linkedStarts = captured.length ? captured.map(clip => clip.timeline_start_us) : [active.startUs];
          const minStartUs = Math.max(0, active.startUs - Math.min(...linkedStarts));
          const rawStartUs = Math.max(minStartUs, active.startUs + deltaUs);
          const clipDurationUs = movingClip ? movingClip.timeline_end_us - movingClip.timeline_start_us : 0;
          const threshold = (SNAP_PX / pps) * 1_000_000;
          const moveMode = active.copyOnStart ? "place" : event.altKey ? "insert" : "place";
          const frameAlignedStartUs = Math.max(minStartUs, snapTimeToFrame(rawStartUs, fpsNum, fpsDen));
          const rawStep: MoveInteraction = {
            ...active,
            currentX: x,
            currentY: y,
            targetStartUs: frameAlignedStartUs,
            moveMode,
          };
          const { targetTrackId, dropHit } = resolveDragTargeting(rawStep);
          const planAt = (leadStartUs: number) => clipDragPlanner?.({
            clipIds: active.clipIds,
            leadClipId: active.clipId,
            leadStartUs,
            pointerTimeUs: xToTime(x, view),
            dropHit,
            targetTrackId,
            mode: moveMode,
            copyOnStart: active.copyOnStart,
            copyIds: active.copyIds,
            mainTrackMagnet: prefs.mainTrackMagnet,
            linkageEnabled: prefs.linkageEnabled,
            snappingEnabled: prefs.snappingEnabled,
            flushToleranceUs: threshold,
          }) ?? null;
          // Candidate times are sorted and cached for the gesture. Rebuild only if the latest
          // document geometry or marker list changes; the moving playhead is supplied separately.
          let snapTargets = moveSnapTargetsRef.current;
          if (!snapTargets || snapTargets.clipRects !== clipRects || snapTargets.markers !== markers) {
            const makeSnapTargets = (excluded: Set<TimelineClipId>) => orderedMoveSnapTargets(
              clipRects,
              markers.map(marker => marker.timeUs),
              excluded,
            );
            const withoutRiders = makeSnapTargets(new Set(active.clipIds));
            const withRiderExclusions = new Set(active.clipIds);
            for (const riderId of active.linkedRiderClipIds) withRiderExclusions.add(riderId);
            const withRiders = makeSnapTargets(withRiderExclusions);
            snapTargets = {
              clipRects,
              markers,
              withoutRiders: withoutRiders.times,
              withRiders: withRiders.times,
              withoutRidersOrder: withoutRiders.orderByTime,
              withRidersOrder: withRiders.orderByTime,
            };
            moveSnapTargetsRef.current = snapTargets;
          }
          const selectedSnapTargets = prefs.snappingEnabled
            ? (prefs.linkageEnabled
              ? { values: snapTargets.withRiders, order: snapTargets.withRidersOrder }
              : { values: snapTargets.withoutRiders, order: snapTargets.withoutRidersOrder })
            : { values: [] as number[], order: undefined };
          const candidates = selectedSnapTargets.values;
          const playheadUs = activePlayheadStore.get();
          const startSnap = prefs.snappingEnabled
            ? snapResultSorted(rawStartUs, candidates, threshold, playheadUs, selectedSnapTargets.order)
            : { valueUs: rawStartUs, snappedTo: null };
          const endSnap = prefs.snappingEnabled
            ? snapResultSorted(rawStartUs + clipDurationUs, candidates, threshold, playheadUs, selectedSnapTargets.order)
            : { valueUs: rawStartUs + clipDurationUs, snappedTo: null };
          const startDelta = startSnap.valueUs - rawStartUs;
          const endDelta = endSnap.valueUs - (rawStartUs + clipDurationUs);
          const useEnd = endSnap.snappedTo !== null && (startSnap.snappedTo === null || Math.abs(endDelta) < Math.abs(startDelta));
          const snappedTo = useEnd ? endSnap.snappedTo : startSnap.snappedTo;
          const landedStartUs = snappedTo === null
            ? snapTimeToFrame(rawStartUs + (useEnd ? endDelta : startDelta), fpsNum, fpsDen)
            : Math.round(rawStartUs + (useEnd ? endDelta : startDelta));
          const targetStartUs = Math.max(minStartUs, landedStartUs);
          const step: MoveInteraction = {
            ...rawStep,
            currentX: x,
            currentY: y,
            targetStartUs,
            moveMode,
          };
          const dragPlan = planAt(targetStartUs);
          const landed = dragPlan?.lead;
          const resolution = landed ? {
            startUs: landed.startUs,
            trackId: landed.trackId,
            mode: dropHit?.zone === "before" ? "before" as const : dropHit?.zone === "after" ? "after" as const : "free" as const,
          } : null;
          const next: TimelineInteraction = {
            ...step,
            previewStartUs: rawStartUs,
            targetStartUs: landed?.startUs ?? targetStartUs,
            targetTrackId: landed?.trackId ?? targetTrackId,
            dropHit,
            resolution,
            dragPlan,
            snapUs: landed?.startUs === targetStartUs && targetStartUs === rawStartUs + (useEnd ? endDelta : startDelta)
              ? (useEnd ? endSnap.snappedTo : startSnap.snappedTo) : null,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "grabbing";
          return;
        }
        if (active.kind === "group-move") {
          const deltaUs = ((x - active.startX) / pps) * 1_000_000;
          const starts = active.clipIds.map((id) => active.startUsByClip[id] ?? 0);
          const anchorStart = Math.min(...starts);
          const rawAnchor = Math.max(0, anchorStart + deltaUs);
          const threshold = (SNAP_PX / pps) * 1_000_000;
          const excluded = new Set(active.clipIds);
          const candidates = prefs.snappingEnabled
            ? [
                ...snapCandidates(clipRects, activePlayheadStore.get(), excluded),
                ...markers.map(marker => marker.timeUs),
              ]
            : [];
          const snappedAnchor = snapValue(rawAnchor, candidates, threshold);
          const rawDelta = snappedAnchor - anchorStart;
          const members = active.clipIds
            .map((id) => clips.find((c) => c.clip_id === id))
            .filter((c): c is TimelineClip => Boolean(c));
          // 视频组：刚体平移 + 同轨无重叠钳制；音频组：自由平移（原点钳制）。
          const groupTrackId = members[0]?.track_id ?? null;
          const finalDelta =
            members.length > 0 && members[0].asset_kind !== "audio"
              ? clampGroupDelta(
                  members,
                  clips.filter(
                    (c) => c.track_id === groupTrackId && !excluded.has(c.clip_id),
                  ),
                  rawDelta,
                )
              : resolveGroupMove(starts, rawDelta).actualDeltaUs;
          const targetStartUsByClip: Record<string, number> = {};
          for (const id of active.clipIds) {
            targetStartUsByClip[id] = Math.max(0, (active.startUsByClip[id] ?? 0) + finalDelta);
          }
          const next: TimelineInteraction = {
            ...active,
            targetStartUsByClip,
            snapUs: Math.abs(snappedAnchor - rawAnchor) > 1 ? snappedAnchor : null,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "grabbing";
          return;
        }
        if (active.kind === "edge-edit") {
          const rawDeltaUs = timelineGestureDeltaUs(x, active.startX, viewRef.current.scrollX, active.startScrollX, pps);
          let requestedDeltaUs = rawDeltaUs;
          let snapUs: number | null = null;
          if (active.mode !== "slip" && prefs.snappingEnabled) {
            const originClipId = active.mode === "roll" ? active.clipIds[0] : active.clipIds[1];
            const originClip = clips.find(clip => clip.clip_id === originClipId);
            if (originClip) {
              const originUs = active.mode === "roll" ? originClip.timeline_end_us : originClip.timeline_start_us;
              const candidates = [
                ...snapCandidates(clipRects, activePlayheadStore.get(), new Set(active.clipIds)),
                ...markers.map(marker => marker.timeUs),
              ];
              const snapped = snapValue(originUs + rawDeltaUs, candidates, (SNAP_PX / pps) * 1_000_000);
              requestedDeltaUs = snapped - originUs;
              if (Math.abs(snapped - (originUs + rawDeltaUs)) > 1) snapUs = snapped;
            }
          }
          const plan = getAdvancedEditPlan(active.mode, active.clipIds, requestedDeltaUs);
          if (!plan || plan.reason) {
            setToolbarFeedback(plan?.reason ?? "编辑无法完成");
            return;
          }
          const next: TimelineInteraction = { ...active, deltaUs: plan.deltaUs, targets: plan.targets, operations: plan.operations,
            snapUs: snapUs !== null && Math.abs(plan.deltaUs - requestedDeltaUs) < frameUs ? snapUs : null };
          interactionRef.current = next;
          setInteraction(next);
          const label = active.mode === "roll" ? "滚动修剪" : active.mode === "slip" ? "滑移素材" : "滑动片段";
          setToolbarFeedback(`${label} ${plan.deltaUs >= 0 ? "+" : "−"}${Math.abs(plan.deltaUs / 1_000_000).toFixed(2)} 秒`);
          canvas.style.cursor = "ew-resize";
          return;
        }
        if (active.kind === "speed") {
          const clip = clips.find(item => item.clip_id === active.clipId);
          if (!clip || !canChangeClipSpeed(clip) || !document) return;
          const mainRipple = prefs.mainTrackMagnet && clip.track_id === "V1" && clip.asset_kind === "video";
          const effectiveEdge: TrimEdge = mainRipple ? "right" : active.edge;
          const pointerDeltaUs = timelineGestureDeltaUs(x, active.startX, viewRef.current.scrollX, active.startScrollX, pps);
          const effectiveDeltaUs = mainRipple && active.edge === "left" ? -pointerDeltaUs : pointerDeltaUs;
          const originalEdgeUs = effectiveEdge === "left" ? active.originalTimelineStartUs : active.originalTimelineEndUs;
          const rawEdgeUs = originalEdgeUs + effectiveDeltaUs;
          const movingIds = new Set(active.linkedClipIds);
          const candidates = prefs.snappingEnabled
            ? [...snapCandidates(clipRects, activePlayheadStore.get(), movingIds), ...markers.map(marker => marker.timeUs)]
              .filter(candidate => Math.abs(candidate - originalEdgeUs) >= 1_000)
            : [];
          const snappedEdgeUs = snapValue(rawEdgeUs, candidates, (SNAP_PX / pps) * 1_000_000);
          const didSnap = Math.abs(snappedEdgeUs - rawEdgeUs) > 1;
          let targetEdgeUs = didSnap ? snappedEdgeUs : snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen);
          if (!mainRipple) {
            const groupIds = new Set(active.linkedClipIds);
            const neighbors = clips.filter(item => item.track_id === clip.track_id && !groupIds.has(item.clip_id));
            if (effectiveEdge === "left") {
              const previousEnd = Math.max(0, ...neighbors.filter(item => item.timeline_end_us <= active.originalTimelineStartUs).map(item => item.timeline_end_us));
              targetEdgeUs = Math.max(previousEnd, Math.min(active.originalTimelineEndUs - 1, targetEdgeUs));
            } else {
              const nextStart = Math.min(Number.MAX_SAFE_INTEGER, ...neighbors.filter(item => item.timeline_start_us >= active.originalTimelineEndUs).map(item => item.timeline_start_us));
              targetEdgeUs = Math.max(active.originalTimelineStartUs + 1, Math.min(nextStart, targetEdgeUs));
            }
          }
          const targetLengthUs = effectiveEdge === "left"
            ? active.originalTimelineEndUs - targetEdgeUs
            : targetEdgeUs - active.originalTimelineStartUs;
          const sourceDurationUs = clip.source_end_us! - clip.source_start_us!;
          const edgeHeld = Math.abs(targetEdgeUs - snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen)) >= 0.5;
          const requestedSpeedMilli = speedMilliForLength(sourceDurationUs, targetLengthUs, didSnap || edgeHeld);
          const plan = planTimelineSpeedEdge(document, clip, requestedSpeedMilli, active.edge, prefs.mainTrackMagnet, prefs.linkageEnabled, active.ignoreLink);
          if (plan.reason) {
            const reset: TimelineInteraction = {
              ...active,
              targetSpeedMilli: active.originalSpeedMilli,
              targetTimelineStartUs: active.originalTimelineStartUs,
              targetTimelineEndUs: active.originalTimelineEndUs,
              targets: [],
              operations: [],
              snapUs: null,
            };
            interactionRef.current = reset;
            setInteraction(reset);
            setToolbarFeedback(plan.reason);
            return;
          }
          const lead = plan.targets.find(item => item.clipId === active.clipId);
          if (!lead && plan.operations.length) return;
          const landedEdgeUs = lead
            ? effectiveEdge === "left" ? lead.startUs : lead.endUs
            : originalEdgeUs;
          const snapUs = didSnap && Math.abs(landedEdgeUs - snappedEdgeUs) <= frameUs / 2 ? snappedEdgeUs : null;
          const next: TimelineInteraction = {
            ...active,
            targetSpeedMilli: plan.speedMilli,
            targetTimelineStartUs: lead?.startUs ?? active.originalTimelineStartUs,
            targetTimelineEndUs: lead?.endUs ?? active.originalTimelineEndUs,
            targets: plan.targets,
            operations: plan.operations,
            snapUs,
          };
          interactionRef.current = next;
          setInteraction(next);
          setToolbarFeedback(`${(plan.speedMilli / 1_000).toFixed(2)}x`);
          canvas.style.cursor = "ew-resize";
          return;
        }
        if (active.kind === "trim") {
          const clip = clips.find((c) => c.clip_id === active.clipId);
          if (clip) {
            const deltaUs = timelineGestureDeltaUs(x, active.startX, viewRef.current.scrollX, active.startScrollX, pps);
            const threshold = (SNAP_PX / pps) * 1_000_000;
            const movingIds = new Set(active.linkedClipIds);
            const originalEdgeUs = active.edge === "left" ? clip.timeline_start_us : clip.timeline_end_us;
            const candidates = prefs.snappingEnabled
              ? [
                  ...snapCandidates(clipRects, activePlayheadStore.get(), movingIds),
                  ...markers.map(marker => marker.timeUs),
                ].filter(candidate => Math.abs(candidate - originalEdgeUs) >= 1000)
              : [];
            const rawEdgeUs = originalEdgeUs + deltaUs;
            const snappedEdgeUs = snapValue(rawEdgeUs, candidates, threshold);
            const snapped = Math.abs(snappedEdgeUs - rawEdgeUs) > 1;
            const desiredEdgeUs = snapped ? snappedEdgeUs : snapTimeToFrame(rawEdgeUs, fpsNum, fpsDen);
            if (clip.asset_kind === "image") {
              let lowerDeltaUs = -Number.MAX_SAFE_INTEGER;
              let upperDeltaUs = Number.MAX_SAFE_INTEGER;
              const mainMagnetRipple = prefs.mainTrackMagnet && clip.track_id === "V1";
              for (const memberId of active.linkedClipIds) {
                const member = clips.find(item => item.clip_id === memberId);
                if (!member) continue;
                const durationUs = member.timeline_end_us - member.timeline_start_us;
                const minimumLengthUs = MIN_CLIP_US;
                if (active.edge === "left") {
                  lowerDeltaUs = Math.max(lowerDeltaUs, -member.timeline_start_us);
                  upperDeltaUs = Math.min(upperDeltaUs, durationUs - minimumLengthUs);
                  if (!mainMagnetRipple) for (const other of clips) {
                    if (other.track_id === member.track_id && !movingIds.has(other.clip_id) && other.timeline_start_us < member.timeline_start_us) {
                      lowerDeltaUs = Math.max(lowerDeltaUs, Math.min(other.timeline_end_us, member.timeline_start_us) - member.timeline_start_us);
                    }
                  }
                } else {
                  lowerDeltaUs = Math.max(lowerDeltaUs, minimumLengthUs - durationUs);
                  if (!mainMagnetRipple) for (const other of clips) {
                    if (other.track_id === member.track_id && !movingIds.has(other.clip_id) && other.timeline_start_us >= member.timeline_end_us) {
                      upperDeltaUs = Math.min(upperDeltaUs, Math.max(other.timeline_start_us, member.timeline_end_us) - member.timeline_end_us);
                    }
                  }
                }
              }
              const edgeDeltaUs = Math.max(lowerDeltaUs, Math.min(upperDeltaUs, desiredEdgeUs - originalEdgeUs));
              const targetTimelineEdgeUs = originalEdgeUs + edgeDeltaUs;
              const next: TimelineInteraction = {
                ...active,
                targetTimelineStartUs: active.edge === "left" ? targetTimelineEdgeUs : active.originalTimelineStartUs,
                targetTimelineEndUs: active.edge === "right" ? targetTimelineEdgeUs : active.originalTimelineEndUs,
                snapUs: snapped && Math.abs(targetTimelineEdgeUs - snappedEdgeUs) <= 1 ? snappedEdgeUs : null,
              };
              interactionRef.current = next;
              setInteraction(next);
              canvas.style.cursor = "ew-resize";
              return;
            }
            let lowerDeltaUs = -Number.MAX_SAFE_INTEGER;
            let upperDeltaUs = Number.MAX_SAFE_INTEGER;
            const mainMagnetRipple = prefs.mainTrackMagnet && clip.track_id === "V1";
            for (const memberId of active.linkedClipIds) {
              const member = clips.find(item => item.clip_id === memberId);
              if (!member) continue;
              const durationUs = member.timeline_end_us - member.timeline_start_us;
              const speed = Math.max(1, member.speed_milli ?? 1000);
              const sourceToTimeline = (sourceUs: number) => member.asset_kind !== "image"
                ? Math.round(sourceUs * 1000 / speed)
                : sourceUs;
              const minimumLengthUs = MIN_CLIP_US;
              if (active.edge === "left") {
                lowerDeltaUs = Math.max(lowerDeltaUs, -member.timeline_start_us, -sourceToTimeline(member.source_start_us ?? 0));
                upperDeltaUs = Math.min(upperDeltaUs, durationUs - minimumLengthUs);
                if (!mainMagnetRipple) {
                  for (const other of clips) {
                    if (other.track_id !== member.track_id || movingIds.has(other.clip_id)) continue;
                    if (other.timeline_start_us < member.timeline_start_us) {
                      const fence = Math.min(other.timeline_end_us, member.timeline_start_us);
                      lowerDeltaUs = Math.max(lowerDeltaUs, fence - member.timeline_start_us);
                    }
                  }
                }
              } else {
                lowerDeltaUs = Math.max(lowerDeltaUs, minimumLengthUs - durationUs);
                const sourceDurationUs = assetDurationById.get(member.asset_id) ?? Number.MAX_SAFE_INTEGER;
                upperDeltaUs = Math.min(upperDeltaUs, sourceToTimeline(Math.max(0, sourceDurationUs - (member.source_end_us ?? sourceDurationUs))));
                if (!mainMagnetRipple) {
                  for (const other of clips) {
                    if (other.track_id !== member.track_id || movingIds.has(other.clip_id)) continue;
                    if (other.timeline_start_us >= member.timeline_end_us) {
                      const fence = Math.max(other.timeline_start_us, member.timeline_end_us);
                      upperDeltaUs = Math.min(upperDeltaUs, fence - member.timeline_end_us);
                    }
                  }
                }
              }
            }
            const edgeDeltaUs = Math.max(lowerDeltaUs, Math.min(upperDeltaUs, desiredEdgeUs - originalEdgeUs));
            const targetTimelineEdgeUs = originalEdgeUs + edgeDeltaUs;
            const sourceDeltaUs = Math.round(edgeDeltaUs * Math.max(1, clip.speed_milli ?? 1000) / 1000);
            let targetStartUs = active.targetStartUs;
            let targetEndUs = active.targetEndUs;
            let snapUs: number | null = null;
            if (active.edge === "left") {
              targetStartUs = Math.max(0, active.originalStartUs + sourceDeltaUs);
              targetEndUs = active.originalEndUs;
            } else {
              targetStartUs = active.originalStartUs;
              targetEndUs = Math.max(targetStartUs + MIN_CLIP_US, active.originalEndUs + sourceDeltaUs);
            }
            if (snapped && Math.abs(targetTimelineEdgeUs - snappedEdgeUs) <= 1) snapUs = snappedEdgeUs;
            const next: TimelineInteraction = {
              ...active,
              targetStartUs,
              targetEndUs,
              snapUs,
            };
            interactionRef.current = next;
            setInteraction(next);
            canvas.style.cursor = "ew-resize";
            return;
          }
        }
        if (active.kind === "caption-trim") {
          // B4：字幕端点拖拽。约束：≥200ms（MIN_CAPTION_US）、
          // 与相邻字幕不重叠（按时间排序取近邻边界）。
          const caption = captions.find((c) => c.caption_id === active.captionId);
          if (caption) {
            const deltaUs = timelineGestureDeltaUs(x, active.startX, viewRef.current.scrollX, active.startScrollX, pps);
            const sorted = [...captions].sort((a, b) => a.start_us - b.start_us);
            const idx = sorted.findIndex((c) => c.caption_id === active.captionId);
            const prev = idx > 0 ? sorted[idx - 1] : null;
            const nextCap = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
            let targetStartUs = active.targetStartUs;
            let targetEndUs = active.targetEndUs;
            if (active.edge === "left") {
              const upper = active.originalEndUs - MIN_CAPTION_US;
              const lower = Math.max(0, prev ? prev.end_us : 0);
              targetStartUs = Math.max(lower, Math.min(upper, active.originalStartUs + deltaUs));
            } else {
              const lower = active.originalStartUs + MIN_CAPTION_US;
              const upper = nextCap ? nextCap.start_us : Number.MAX_SAFE_INTEGER;
              targetEndUs = Math.max(lower, Math.min(upper, active.originalEndUs + deltaUs));
            }
            const next: TimelineInteraction = { ...active, targetStartUs, targetEndUs };
            interactionRef.current = next;
            setInteraction(next);
            canvas.style.cursor = "ew-resize";
            return;
          }
        }
        if (active.kind === "caption-move") {
          // B4 追加：字幕整体平移。约束：与相邻字幕不重叠（保持原时长）。
          const caption = captions.find((c) => c.caption_id === active.captionId);
          if (caption) {
            const deltaUs = timelineGestureDeltaUs(x, active.startX, viewRef.current.scrollX, active.startScrollX, pps);
            const durationUs = active.originalEndUs - active.originalStartUs;
            const sorted = [...captions].sort((a, b) => a.start_us - b.start_us);
            const idx = sorted.findIndex((c) => c.caption_id === active.captionId);
            const prev = idx > 0 ? sorted[idx - 1] : null;
            const nextCap = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
            const targetStartUs = Math.max(
              0,
              Math.max(prev ? prev.end_us : 0,
                Math.min(active.originalStartUs + deltaUs,
                  (nextCap ? nextCap.start_us : Number.MAX_SAFE_INTEGER) - durationUs)),
            );
            const next: TimelineInteraction = {
              ...active,
              targetStartUs,
              targetEndUs: targetStartUs + durationUs,
            };
            interactionRef.current = next;
            setInteraction(next);
            canvas.style.cursor = "grabbing";
            return;
          }
        }
      }

      // Hover cursor + trim handle detection
      const handle = hitTestTrimHandle(x, y, clipRects);
      const volumeHoverId = handle ? null : hitTestVolumeLine(x, y, clipRects, isClipLocked, prefs.waveformRatio);
      const nextHover: TimelineHover = handle
        ? { clipId: handle.clipId, edge: handle.edge }
        : { clipId: volumeHoverId ?? hitTestClips(x, y, clipRects), edge: null };
      setHover((prev) =>
        prev.clipId === nextHover.clipId && prev.edge === nextHover.edge ? prev : nextHover,
      );
      setRulerHoverUs((prev) => {
        const next = y <= view.rulerHeight ? clampRulerTime(xToTime(x, view)) : null;
        return prev === next ? prev : next;
      });
      if (handle) {
        canvas.style.cursor = "ew-resize";
      } else if (volumeHoverId) {
        canvas.style.cursor = "ns-resize";
      } else {
        const clipId = hitTestClips(x, y, clipRects);
        const locked = clipId ? isClipLocked(clipId) : false;
        canvas.style.cursor = clipId && !locked ? "grab" : "default";
      }
    },
    [view, onSeek, clipRects, clips, markers, activePlayheadStore, prefs.snappingEnabled, prefs.mainTrackMagnet, totalUs, frameRate, frameUs, fpsNum, fpsDen, assetDurationById, document, canvasSize.width, canvasSize.height, trackRows, resolveDragTargeting, scrubMode, getAdvancedEditPlan, setToolbarFeedback, clipDragPlanner],
  );

  // OpenFilm changes Place ↔ Insert as Alt is pressed/released during an active move,
  // even when the pointer itself does not emit another move event.
  useEffect(() => {
    if (interaction?.kind !== "move" || interaction.copyOnStart) return;
    const updateMode = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      const last = lastClientPointerRef.current;
      if (!last || activeCanvasPointerIdRef.current === null) return;
      const altKey = event.type === "keydown";
      lastClientPointerRef.current = { ...last, altKey };
      processCanvasPointerMove({ ...last, altKey });
    };
    window.addEventListener("keydown", updateMode);
    window.addEventListener("keyup", updateMode);
    return () => {
      window.removeEventListener("keydown", updateMode);
      window.removeEventListener("keyup", updateMode);
    };
  }, [interaction?.kind, interaction?.kind === "move" ? interaction.copyOnStart : false, processCanvasPointerMove]);

  const processCanvasPointerMoveRef = useRef(processCanvasPointerMove);
  processCanvasPointerMoveRef.current = processCanvasPointerMove;

  const handleCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement> | PointerEvent) => {
    const activePointerId = activeCanvasPointerIdRef.current;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    if (activePointerId !== null) {
      lastClientPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        altKey: Boolean(event.altKey),
      };
    }
    pendingPointerMoveRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      altKey: event.altKey,
    };
    if (pointerMoveFrameRef.current) return;
    pointerMoveFrameRef.current = requestAnimationFrame(() => {
      pointerMoveFrameRef.current = 0;
      const latest = pendingPointerMoveRef.current;
      pendingPointerMoveRef.current = null;
      if (latest) processCanvasPointerMove(latest);
    });
  }, [processCanvasPointerMove]);

  // Double-click the ruler → fit the whole timeline into the viewport (Round 5).
  const fitToContent = useCallback(() => {
    setView(v => ({
      ...v,
      projectZoom: TIMELINE_ZOOM_DEFAULT,
      pixelsPerSecond: timelineZoomToPps(totalUs, Math.max(0, canvasSize.width - v.headerWidth), TIMELINE_ZOOM_DEFAULT),
      scrollX: 0,
    }));
  }, [totalUs, canvasSize.width]);

  // 全局预览缩放快捷键（剪映式 Shift+Z）：输入框聚焦时不抢键。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        fitToContent();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fitToContent]);

  const handleCanvasDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const coords = canvasCoords(event);
      if (!coords) return;
      if (coords.y <= view.rulerHeight) fitToContent();
    },
    [view.rulerHeight, fitToContent],
  );

  const finishInteraction = useCallback((event?: { clientX: number; clientY: number; pointerId?: number; altKey?: boolean }, commit = true) => {
    let active = interactionRef.current;
    const canvas = canvasRef.current;
    const pointerId = event?.pointerId ?? activeCanvasPointerIdRef.current;
    if (pointerMoveFrameRef.current) cancelAnimationFrame(pointerMoveFrameRef.current);
    pointerMoveFrameRef.current = 0;
    pendingPointerMoveRef.current = null;
    // pointerup can arrive at a different coordinate without a final pointermove;
    // synchronously replan from that exact release point before committing.
    if (commit && event && active && pointerId !== null && pointerId === activeCanvasPointerIdRef.current) {
      processCanvasPointerMove({ clientX: event.clientX, clientY: event.clientY, pointerId, altKey: Boolean(event.altKey) });
      active = interactionRef.current;
    }
    if (!commit && active?.kind === "playhead") {
      (onSeekCommit ?? onSeek)?.(active.startTimeUs);
    }
    if (active && commit) {
      if (active.kind === "playhead") {
        const x = (event && canvasCoords(event)?.x) ?? lastPointerRef.current?.x ?? active.startX;
        (onSeekCommit ?? onSeek)?.(clampRulerTime(xToTime(x, view)));
      } else if (active.kind === "move") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        const plan = active.dragPlan;
        if (clip && plan) {
          if (plan.reason) setToolbarFeedback(plan.reason);
          else setToolbarFeedback("");
          if (plan.operations.length) {
            if (active.copyOnStart) {
              const copies = plan.operations.find(operation => operation.op === "duplicate_timeline_items");
              if (copies?.op === "duplicate_timeline_items") {
                const ids = copies.copies.map(copy => copy.copy_id as TimelineClipId);
                setSelection(ids.length > 1 ? { kind: "clips", ids } : { kind: "clip", id: ids[0]! });
              }
            }
            const isReplace = plan.operations.some(operation => operation.op === "remove_clip");
            const isInsert = active.moveMode === "insert" || active.dropHit?.zone === "before" || active.dropHit?.zone === "after";
            const summary = active.copyOnStart ? "复制片段" : isReplace ? "替换片段" : isInsert ? "插入移动片段" : "移动片段";
            if (isReplace) {
              const remove = plan.operations.find(operation => operation.op === "remove_clip");
              if (remove?.op === "remove_clip") {
                const affectedIds = new Set<TimelineClipId>([...active.clipIds, remove.clip_id]);
                for (const operation of plan.operations) if (operation.op === "position_clips") {
                  for (const placement of operation.placements) affectedIds.add(placement.clip_id);
                }
                const expected = (document?.clips ?? []).filter(item => affectedIds.has(item.clip_id)).map(item => ({
                  clipId: item.clip_id,
                  trackId: item.track_id,
                  startUs: item.timeline_start_us,
                  endUs: item.timeline_end_us,
                }));
                setReplaceClipRequest({ operations: plan.operations, targetClipId: remove.clip_id, expected });
              }
            } else {
              if (plan.lead) {
                const placements = new Map<TimelineClipId, { clipId: TimelineClipId; trackId: string; startUs: number }>();
                for (const item of plan.placements) placements.set(item.clipId as TimelineClipId, {
                  clipId: item.clipId as TimelineClipId,
                  trackId: item.trackId,
                  startUs: Math.round(item.startUs),
                });
                placements.set(plan.lead.clipId as TimelineClipId, {
                  clipId: plan.lead.clipId as TimelineClipId,
                  trackId: plan.lead.trackId,
                  startUs: Math.round(plan.lead.startUs),
                });
                const copiesById = new Map<TimelineClipId, TimelineClipId>();
                for (const operation of plan.operations) if (operation.op === "duplicate_timeline_items") {
                  for (const copy of operation.copies) if (copy.item_kind === "clip") {
                    copiesById.set(copy.copy_id as TimelineClipId, copy.source_id as TimelineClipId);
                  }
                }
                const copies = plan.placements.flatMap(item => {
                  const sourceClipId = copiesById.get(item.clipId as TimelineClipId);
                  return sourceClipId ? [{
                    clipId: item.clipId as TimelineClipId,
                    sourceClipId,
                    trackId: item.trackId,
                    startUs: Math.round(item.startUs),
                  }] : [];
                });
                setPendingKeep({ placements: [...placements.values()], copies });
              }
              void onPatch(plan.operations, summary);
            }
          }
        }
      } else if (active.kind === "group-move") {
        const ops: TimelinePatchOperation[] = active.clipIds
          .map((id) => ({
            clip: clips.find((c) => c.clip_id === id),
            targetUs: Math.round(active.targetStartUsByClip[id] ?? 0),
          }))
          .filter(
            (item): item is { clip: TimelineClip; targetUs: number } =>
              Boolean(item.clip) &&
              Math.abs(item.targetUs - item.clip!.timeline_start_us) >= 1000,
          )
          .map((item) => ({
            op: "position_clip" as const,
            clip_id: item.clip.clip_id,
            timeline_start_us: item.targetUs,
          }));
        if (ops.length > 0) void onPatch(ops, "移动音频片段");
      } else if (active.kind === "volume") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        if (clip && Math.abs(active.targetGainDb - active.startGainDb) >= 0.1) {
          void onPatch(
            [
              {
                op: "set_audio",
                clip_id: clip.clip_id,
                enabled: clip.audio.enabled,
                gain_db: Math.round(active.targetGainDb * 10) / 10,
              },
            ],
            "调整片段音量",
          );
        }
      } else if (active.kind === "edge-edit") {
        if (active.operations.length > 0) {
          const label = active.mode === "roll" ? "滚动修剪" : active.mode === "slip" ? "滑移素材" : "滑动片段";
          void onPatch(active.operations, label);
          setToolbarFeedback(`${label}已提交 · ${active.deltaUs >= 0 ? "+" : "−"}${Math.abs(active.deltaUs / 1_000_000).toFixed(2)} 秒`);
        }
      } else if (active.kind === "speed") {
        if (active.operations.length > 0) {
          void onPatch(active.operations, `调整速度 ${(active.targetSpeedMilli / 1_000).toFixed(2)}x`);
          setToolbarFeedback(`速度已提交 · ${(active.targetSpeedMilli / 1_000).toFixed(2)}x`);
        }
      } else if (active.kind === "trim") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        if (clip?.asset_kind === "image") {
          const edgeDeltaUs = active.edge === "left"
            ? active.targetTimelineStartUs - active.originalTimelineStartUs
            : active.targetTimelineEndUs - active.originalTimelineEndUs;
          if (Math.abs(edgeDeltaUs) >= 1000 && document) {
            const magnetic = prefs.mainTrackMagnet && clip.track_id === "V1";
            const plan = planMagneticImageTrim(document, clip, active.edge, Math.round(edgeDeltaUs), prefs.linkageEnabled, magnetic, active.ignoreLink);
            if (!plan.operations.length) setToolbarFeedback(plan.reason ?? "图片修剪无法完成");
            else void onPatch(plan.operations, magnetic ? "主轨磁吸修剪" : "修剪图片");
          }
          return;
        }
        const startChanged = Math.abs(active.targetStartUs - active.originalStartUs) >= 1000;
        const endChanged = Math.abs(active.targetEndUs - active.originalEndUs) >= 1000;
        if (clip && (startChanged || endChanged)) {
            const operations: TimelinePatchOperation[] = [{
              op: "trim_clip",
              clip_id: clip.clip_id,
              source_start_us: Math.round(active.targetStartUs),
              source_end_us: Math.round(active.targetEndUs),
              ...(active.ignoreLink ? { ignore_link: true } : {}),
            }];
          if (prefs.mainTrackMagnet && clip.track_id === "V1" && document) {
            const plan = planMagneticTrim(document, clip, Math.round(active.targetStartUs), Math.round(active.targetEndUs), prefs.linkageEnabled, active.ignoreLink);
            if (!plan.operations.length) setToolbarFeedback(plan.reason ?? "磁吸修剪无法完成");
            else void onPatch(plan.operations, "主轨磁吸修剪");
          } else void onPatch(operations, "修剪片段");
        }
      } else if (active.kind === "caption-trim") {
        const startChanged = Math.abs(active.targetStartUs - active.originalStartUs) >= 1000;
        const endChanged = Math.abs(active.targetEndUs - active.originalEndUs) >= 1000;
        if (startChanged || endChanged) {
          void onPatch(
            [
              {
                op: "set_caption_timing",
                caption_id: active.captionId as never,
                start_us: Math.round(active.targetStartUs),
                end_us: Math.round(active.targetEndUs),
              },
            ],
            "调整字幕时长",
          );
        }
      } else if (active.kind === "caption-move") {
        const moved = Math.abs(active.targetStartUs - active.originalStartUs) >= 1000;
        if (moved) {
          void onPatch(
            [
              {
                op: "set_caption_timing",
                caption_id: active.captionId as never,
                start_us: Math.round(active.targetStartUs),
                end_us: Math.round(active.targetEndUs),
              },
            ],
            "移动字幕",
          );
        }
      } else if (active.kind === "marquee") {
        const rect = marqueeRect(active.startX, active.startY, active.currentX, active.currentY);
        if (pointerDragLiftedRef.current) {
          // OpenFilm's marquee selects by horizontal time span and swept rows.
          const hits = clipsInTimelineMarquee(rect, contentClipRects, trackRows);
          const merged = shiftClickRef.current
            ? mergeLinkedMarqueeSelection(selection, hits, clips)
            : expandLinkedClipIds(hits, clips);
          setSelection(merged.length > 0 ? { kind: "clips", ids: merged } : null);
        } else {
          // Plain click on empty area → move the playhead there (Round 4)，
          // 寻址同样钳制在素材终点内。
          const viewportX = active.currentX - view.scrollX;
          (onSeekCommit ?? onSeek)?.(clampRulerTime(xToTime(viewportX, view)));
          if (!shiftClickRef.current) setSelection(null);
        }
      }
    }
    if (commit && !pointerDragLiftedRef.current && collapseSelectedClickRef.current) {
      const { clipId, alone } = collapseSelectedClickRef.current;
      const clicked = clips.find(clip => clip.clip_id === clipId);
      if (clicked) setSelection(alone ? { kind: "clip", id: clicked.clip_id } : linkedSelection(clicked));
    }
    collapseSelectedClickRef.current = null;
    interactionRef.current = null;
    moveSnapTargetsRef.current = null;
    setInteraction(null);
    pointerDragLiftedRef.current = false;
    lastPointerRef.current = null;
    // 松手必须退出擦洗态，旋钮才会从实心变回空心（参照 PlayheadKnob: 按住实心、松开空心）。
    // 此前只在 handleRulerPinUp 里复位，画布内的拖动路径没有复位点，
    // 于是旋钮一旦变实心就再也不回去了（或如实测那样全程空心）。
    rulerScrubbingRef.current = false;
    setScrubbing(false);
    if (canvas) canvas.style.cursor = "default";
    if (canvas && pointerId !== null && canvas.hasPointerCapture?.(pointerId)) {
      try { canvas.releasePointerCapture(pointerId); } catch { /* Capture can already be gone on cancel/blur. */ }
    }
    activeCanvasPointerIdRef.current = null;
    // 依赖里含 clips：文档更新（补丁生效）后本回调重建，但 pendingKeep 已在
    // 下面的 effect 中消费完毕，不会残留。
  }, [clips, captions, clipRects, contentClipRects, onPatch, setSelection, selection, toggleClipSelection, onSeek, onSeekCommit, view, totalUs, canvasTopY, resolveDragTargeting, document, prefs.mainTrackMagnet, prefs.linkageEnabled, processCanvasPointerMove]);

  // Pointer capture normally keeps the gesture on canvas; window listeners are
  // a fallback for detached test surfaces and platform capture failures.
  const hasInteraction = interaction !== null;
  useEffect(() => {
    if (!hasInteraction) return;
    const handleWindowPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== activeCanvasPointerIdRef.current || event.target === canvasRef.current) return;
      if (interactionRef.current) finishInteraction(event, true);
    };
    const handleWindowPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === activeCanvasPointerIdRef.current && event.target !== canvasRef.current) finishInteraction(event, false);
    };
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [hasInteraction, finishInteraction]);

  // Capture fallback：pointer capture 失效时继续接收越出画布的移动。
  useEffect(() => {
    if (!hasInteraction) return;
    const handleWindowMove = (event: PointerEvent) => {
      if (event.pointerId !== activeCanvasPointerIdRef.current || event.target === canvasRef.current) return;
      handleCanvasPointerMove(event as unknown as React.PointerEvent<HTMLCanvasElement>);
    };
    window.addEventListener("pointermove", handleWindowMove);
    return () => window.removeEventListener("pointermove", handleWindowMove);
  }, [hasInteraction, handleCanvasPointerMove]);

  useEffect(() => {
    if (!hasInteraction) return;
    const cancel = () => finishInteraction(undefined, false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", cancel);
    };
  }, [hasInteraction, finishInteraction]);

  // Round 4: edge auto-scroll while dragging (ported from OpenCut classic's
  // use-edge-auto-scroll pattern). Each frame, if the pointer sits within the
  // edge zone, advance scrollX and shift the drag targets by the same delta so
  // the ghost follows the content point under the cursor.
  useEffect(() => {
    if (!interaction) return;
    if (!["move", "group-move", "trim", "speed", "edge-edit", "caption-trim", "caption-move", "marquee"].includes(interaction.kind)) return;
    if (!pointerDragLiftedRef.current) return;
    let raf = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveDragTargeting 由 move 分支单独依赖
    const resolveTargetingRef = { current: resolveDragTargeting };
    resolveTargetingRef.current = resolveDragTargeting;
    const tick = () => {
      const pointer = lastPointerRef.current;
      const step = pointer ? dragEdgeAutoScrollStep(pointer.x, canvasSize.width) : 0;
      if (step !== 0) {
        const current = viewRef.current;
        const { maxScrollX } = scrollBounds(current, totalUs, canvasSize.width);
        const nextScrollX = clampScrollX(current.scrollX + step, maxScrollX);
        const deltaPx = nextScrollX - current.scrollX;
        if (deltaPx !== 0) {
          const nextView = { ...current, scrollX: nextScrollX };
          viewRef.current = nextView;
          setView(nextView);
          const deltaUs = (deltaPx / current.pixelsPerSecond) * 1_000_000;
          const active = interactionRef.current;
          if (active) {
            let adjusted: TimelineInteraction = active;
            if (active.kind === "move") {
              adjusted = {
                ...active,
                previewStartUs: active.previewStartUs + deltaUs,
                targetStartUs: Math.max(0, active.targetStartUs + deltaUs),
                startUs: active.startUs + deltaUs,
              };
              // 滚动改变了片段在视口中的位置：按平移后的 targetStartUs
              // 重算落点预览，保证预览与内容点始终对齐。
              const draggedClip = clips.find((c) => c.clip_id === active.clipId);
              if (draggedClip) {
                const { targetTrackId, dropHit } = resolveTargetingRef.current(
                  adjusted as MoveInteraction,
                );
                const dragPlan = clipDragPlanner?.({
                  clipIds: active.clipIds,
                  leadClipId: active.clipId,
                  leadStartUs: adjusted.targetStartUs,
                  pointerTimeUs: pointer ? xToTime(pointer.x, nextView) : adjusted.targetStartUs,
                  dropHit,
                  targetTrackId,
                  mode: active.moveMode,
                  copyOnStart: active.copyOnStart,
                  copyIds: active.copyIds,
                  mainTrackMagnet: prefs.mainTrackMagnet,
                  linkageEnabled: prefs.linkageEnabled,
                  snappingEnabled: prefs.snappingEnabled,
                  flushToleranceUs: (SNAP_PX / nextView.pixelsPerSecond) * 1_000_000,
                }) ?? null;
                const landed = dragPlan?.lead;
                adjusted = {
                  ...(adjusted as MoveInteraction),
                  targetStartUs: landed?.startUs ?? adjusted.targetStartUs,
                  targetTrackId: landed?.trackId ?? targetTrackId,
                  dropHit,
                  dragPlan,
                  resolution: landed ? { startUs: landed.startUs, trackId: landed.trackId, mode: "free" } : null,
                };
              }
            } else if (active.kind === "group-move") {
              const startUsByClip: Record<string, number> = {};
              const targetStartUsByClip: Record<string, number> = {};
              for (const id of active.clipIds) {
                startUsByClip[id] = (active.startUsByClip[id] ?? 0) + deltaUs;
                targetStartUsByClip[id] = Math.max(0, (active.targetStartUsByClip[id] ?? 0) + deltaUs);
              }
              adjusted = { ...active, startUsByClip, targetStartUsByClip };
            } else if (active.kind === "marquee") {
              adjusted = { ...active, currentX: active.currentX + deltaPx };
            }
            interactionRef.current = adjusted;
            setInteraction(adjusted);
            if ((adjusted.kind === "speed" || adjusted.kind === "edge-edit" || adjusted.kind === "trim" ||
              adjusted.kind === "caption-trim" || adjusted.kind === "caption-move") && lastClientPointerRef.current) {
              processCanvasPointerMoveRef.current(lastClientPointerRef.current);
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [interaction, canvasSize.width, totalUs, document, prefs.mainTrackMagnet, prefs.linkageEnabled, clipDragPlanner]);

  const handleCanvasMouseLeave = useCallback(() => {
    if (!interactionRef.current) setHover({ clipId: null, edge: null });
    setRulerHoverUs(null);
  }, []);

  // ── Context menu (Round 4) ─────────────────────────────────────────────────

  const handleCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const coords = canvasCoords(event);
      if (!coords) return;
      const { x, y } = coords;
      const timeUs = xToTime(x, view);
      const transitionId = hitTestTransitions(x, y, transitionRects);
      const clipId = hitTestClips(x, y, clipRects);
      const captionId = hitTestCaptions(x, y, captionRects);
      if (transitionId) {
        setSelection({ kind: "transition", id: transitionId });
        setContextMenu({ x, y, target: { kind: "transition", transitionId }, timeUs });
      } else if (clipId) {
        const clip = clips.find(item => item.clip_id === clipId);
        const alreadySelected = selection?.kind === "clip" ? selection.id === clipId : selection?.kind === "clips" && selection.ids.includes(clipId);
        if (clip && !alreadySelected) setSelection(linkedSelection(clip));
        setContextMenu({ x, y, target: { kind: "clip", clipId }, timeUs });
      } else if (captionId) {
        setSelection({ kind: "caption", id: captionId });
        setContextMenu({ x, y, target: { kind: "caption", captionId }, timeUs });
      } else {
        setContextMenu({ x, y, target: { kind: "empty", trackId: trackRowAt(trackRows, x, y)?.track.id ?? null }, timeUs });
      }
    },
    [view, transitionRects, clipRects, captionRects, trackRows, clips, selection, setSelection],
  );

  // Close the context menu on scroll（T10：外点关闭与 Esc 已由参照 ContextMenu 自带）。
  const hasContextMenu = contextMenu !== null;
  useEffect(() => {
    if (!hasContextMenu) return;
    const handleWheelClose = () => setContextMenu(null);
    window.addEventListener("wheel", handleWheelClose, { passive: true });
    return () => {
      window.removeEventListener("wheel", handleWheelClose);
    };
  }, [hasContextMenu]);

  // ── Drag & drop (asset → timeline) ────────────────────────────────────────

  const dragKinds = (transfer: DataTransfer, droppedIds?: readonly string[]) => {
    const types = Array.from(transfer.types ?? []);
    if (droppedIds?.length) {
      if (droppedIds.length === 1 && droppedIds[0] === SYSTEM_FILE_DROP_ID) {
        const files = peekSystemFileDrop();
        const supportedKinds = files
          .map(file => assetDropKindFromFile(file.name, file.type))
          .filter((kind): kind is NonNullable<typeof kind> => kind !== null);
        return { itemCount: supportedKinds.length, kinds: supportedKinds.length ? supportedKinds : null, durationsUs: supportedKinds.map(() => null) };
      }
      const media = droppedIds.map(id => mediaById.get(id));
      const kinds = media.map(item => item?.kind ?? null);
      return { itemCount: droppedIds.length, kinds: kinds.length && kinds.every((kind): kind is NonNullable<typeof kind> => kind !== null) ? kinds : null,
        durationsUs: media.map(item => item?.kind === "image" ? 4_000_000 : item?.duration_us ?? null) };
    }

    const activeIds = getActiveDraggedAssetIds();
    if (activeIds.length) {
      const media = activeIds.map(id => mediaById.get(id));
      const kinds = media.map(item => item?.kind ?? null);
      return { itemCount: activeIds.length, kinds: kinds.every((kind): kind is NonNullable<typeof kind> => kind !== null) ? kinds : null,
        durationsUs: media.map(item => item?.kind === "image" ? 4_000_000 : item?.duration_us ?? null) };
    }
    if (types.includes("Files")) {
      const items = Array.from(transfer.items ?? []).filter(item => item.kind === "file");
      if (!items.length) return { itemCount: 1, kinds: ["video"] as const, durationsUs: [null] };
      const kinds = items.map(item => assetDropKindFromFile("", item.type, true));
      return { itemCount: items.length, kinds: kinds.every((kind): kind is NonNullable<typeof kind> => kind !== null) ? kinds : null, durationsUs: items.map(() => null) };
    }
    if (types.includes(ASSET_BATCH_DRAG) || types.includes(ASSET_DRAG)) return { itemCount: 1, kinds: null, durationsUs: [] };
    return { itemCount: 0, kinds: null, durationsUs: [] };
  };

  const resolveAssetDropIntentForEvent = (event: React.DragEvent<HTMLElement>, index: number, droppedIds?: readonly string[]) => {
    const coords = canvasCoords(event);
    const hit = coords
      ? timelineDropHit(coords.x, coords.y, trackRows, clipRects)
      : { rowIndex: -1, trackId: null, band: "above" as const, clipId: null, zone: null };
    const timeUs = coords ? xToTime(coords.x, view) : 0;
    const drag = dragKinds(event.dataTransfer, droppedIds);
    const intent = resolveTimelineAssetDropIntent({
      hit,
      clips,
      tracks,
      lockedClipIds: document?.locked_elements,
      assetKinds: drag.kinds,
      assetDurationsUs: drag.durationsUs,
      itemCount: drag.itemCount,
      canReplace: Boolean(onReplaceAssetDrop),
      pointerUs: timeUs,
      fpsNum: document?.canvas.fps_num ?? 30,
      fpsDen: document?.canvas.fps_den ?? 1,
      hasCoordinates: Boolean(coords),
      defaultSlot: index,
      altKey: event.altKey,
      mainTrackMagnet: prefs.mainTrackMagnet,
    });
    return { intent, itemCount: drag.itemCount };
  };

  const clearDropPreview = (preserveSystemFiles = Boolean(replaceAssetRequestRef.current)) => {
    setDropIndex(null);
    setDropIntent(null);
    dropItemCountRef.current = 0;
    setActiveDraggedAssetIds([]);
    if (!preserveSystemFiles) clearSystemFileDrop();
  };

  useEffect(() => {
    const onDragEnd = () => clearDropPreview();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (replaceAssetRequestRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setReplaceAssetRequest(null);
        clearDropPreview(false);
      } else if (dropIntentRef.current) {
        clearDropPreview(false);
      }
    };
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("keydown", onKeyDown, true);
      clearSystemFileDrop();
      setActiveDraggedAssetIds([]);
    };
  }, []);

  const updateDropPreview = (event: React.DragEvent<HTMLElement>, index: number, ids?: readonly string[]) => {
    const { intent, itemCount } = resolveAssetDropIntentForEvent(event, index, ids);
    dropItemCountRef.current = itemCount;
    setDropIntent(intent);
    setDropIndex(intent.slot);
    event.dataTransfer.dropEffect = intent.accepts ? "copy" : "none";
    return intent;
  };

  const allowDrop = (event: React.DragEvent<HTMLElement>, index: number) => {
    if (!hasAssetDrag(event.dataTransfer)) return;
    event.preventDefault();
    updateDropPreview(event, index);
  };

  const handleDrop = (event: React.DragEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    const assetIds = readAssetDrop(event.dataTransfer);
    if (!assetIds.length) {
      clearDropPreview(false);
      return;
    }
    const intent = updateDropPreview(event, index, assetIds);
    const singleCenterReplace = intent.accepts && intent.zone === "center" && Boolean(intent.targetClipId) && assetIds.length === 1;
    clearDropPreview(Boolean(singleCenterReplace) || assetIds[0] === SYSTEM_FILE_DROP_ID);
    if (!intent.accepts) {
      clearSystemFileDrop();
      return;
    }
    if (singleCenterReplace && intent.targetClipId) {
      setReplaceAssetRequest({ assetIds, targetClipId: intent.targetClipId, intent, systemFiles: peekSystemFileDrop() });
      return;
    }
    const targetTrack = intent.trackId && intent.trackId !== "new" ? tracks.find(track => track.id === intent.trackId) : undefined;
    const edit = event.altKey && !intent.boundary && intent.zone !== "center" && targetTrack && targetTrack.kind !== "text"
      ? { mode: "overwrite" as const, atUs: intent.atUs }
      : undefined;
    onDropAsset(assetIds, intent.slot, intent.trackId ?? undefined, edit, intent);
  };

  const cancelReplaceAsset = () => {
    setReplaceAssetRequest(null);
    clearDropPreview(false);
  };
  const confirmReplaceAsset = () => {
    const request = replaceAssetRequestRef.current;
    if (!request || !onReplaceAssetDrop) { cancelReplaceAsset(); return; }
    setReplaceAssetRequest(null);
    clearDropPreview(true);
    restoreSystemFileDrop(request.systemFiles);
    try {
      void Promise.resolve(onReplaceAssetDrop(request.assetIds, request.targetClipId, request.intent)).catch(() => {
        clearSystemFileDrop();
        setToolbarFeedback("素材替换失败；时间线未修改。");
      });
    } catch {
      clearSystemFileDrop();
      setToolbarFeedback("素材替换失败；时间线未修改。");
    }
  };

  const cancelReplaceClip = () => setReplaceClipRequest(null);
  const confirmReplaceClip = () => {
    const request = replaceClipRequest;
    if (!request) return;
    const currentClips = new Map((document?.clips ?? []).map(item => [item.clip_id, item]));
    const stale = request.expected.some(expected => {
      const current = currentClips.get(expected.clipId);
      return !current || current.track_id !== expected.trackId || current.timeline_start_us !== expected.startUs || current.timeline_end_us !== expected.endUs;
    });
    const target = currentClips.get(request.targetClipId);
    const trackById = new Map((document?.tracks ?? []).map(track => [track.id, track]));
    const lockedIds = new Set(document?.locked_elements ?? []);
    const locked = request.expected.some(expected => {
      const current = currentClips.get(expected.clipId);
      return !current || lockedIds.has(current.clip_id) || Boolean(trackById.get(current.track_id)?.locked);
    });
    if (stale || !target || locked) {
      setReplaceClipRequest(null);
      setToolbarFeedback(stale ? "时间线已变化，请重新拖动后再替换。" : "替换目标或相关轨道已锁定，时间线未修改。");
      return;
    }
    setReplaceClipRequest(null);
    void Promise.resolve(onPatch(request.operations, "替换片段")).catch(() => {
      setToolbarFeedback("片段替换失败；时间线未修改。");
    });
  };

  // ── Caption hit testing ────────────────────────────────────────────────────

  function hitTestCaptions(
    x: number,
    y: number,
    rects: CaptionRenderRect[],
  ): string | null {
    for (const rect of rects) {
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        return rect.caption.caption_id;
      }
    }
    return null;
  }

  // ── Selection helpers for the toolbar ──────────────────────────────────────

  const selectedClip =
    selection?.kind === "clip" ? clips.find((c) => c.clip_id === selection.id) : undefined;
  const selectedCaption =
    selection?.kind === "caption"
      ? captions.find((c) => c.caption_id === selection.id)
      : undefined;
  const selectedIds =
    selection?.kind === "clip"
      ? [selection.id]
      : selection?.kind === "clips"
        ? selection.ids
        : [];
  const selectedClips = selectedIds
    .map((id) => clips.find((c) => c.clip_id === id))
    .filter((c): c is TimelineClip => Boolean(c));
  const selectedGroups = new Set(selectedClips.flatMap(clip => clip.link_group_id ? [clip.link_group_id] : []));
  const linkMembers = clips.filter(clip => selectedIds.includes(clip.clip_id) || (clip.link_group_id && selectedGroups.has(clip.link_group_id)));
  const canLinkMembers = linkMembers.length >= 2 && !linkMembers.some(clip => isClipLocked(clip.clip_id)) &&
    !(selectedGroups.size === 1 && linkMembers.every(clip => clip.link_group_id === [...selectedGroups][0]));
  const unlinkRepresentatives = [...selectedGroups].flatMap(group => {
    const members = clips.filter(clip => clip.link_group_id === group);
    return members.length && members.every(clip => !isClipLocked(clip.clip_id)) ? [members[0]] : [];
  });
  const clipLocked = Boolean(
    selectedClip && isClipLocked(selectedClip.clip_id),
  );
  const canSplitSelection = useSyncExternalStore(activePlayheadStore.subscribe, () =>
    splitSelectionAt(selectedClips, activePlayheadStore.get(), document).length !== 0
  );
  const rangeAnchor = rangeButton?.getBoundingClientRect();
  const closeRangeMenu = () => {
    setRangeButton(null);
    rangeButton?.focus({ preventScroll: true });
  };
  const markRange = (edge: "in" | "out") => {
    const time = clampRulerTime(activePlayheadStore.get());
    const startUs = edge === "in" ? time : timeRange?.startUs ?? 0;
    const endUs = edge === "out" ? time : timeRange?.endUs ?? totalUs;
    if (endUs - startUs >= MIN_RANGE_US) setTimeRange({ startUs, endUs });
  };
  const moveRangeEdge = (edge: "startUs" | "endUs", timeUs: number) => {
    setTimeRange(current => {
      if (!current) return null;
      return edge === "startUs"
        ? { ...current, startUs: Math.max(0, Math.min(timeUs, current.endUs - MIN_RANGE_US)) }
        : { ...current, endUs: Math.min(totalUs, Math.max(timeUs, current.startUs + MIN_RANGE_US)) };
    });
  };
  const captionLocked = Boolean(
    selectedCaption?.source_clip_id &&
      isClipLocked(selectedCaption.source_clip_id),
  );

  // ── 自由定位：向前/向后移动 = 逐帧微调（同轨无重叠钳制） ──────────────────
  const nudgeTarget = (clip: TimelineClip, deltaUs: number): number | null => {
    const raw = Math.max(0, clip.timeline_start_us + deltaUs);
    const target =
      clip.asset_kind !== "audio"
        ? clampMoveStart(
            clips.filter((c) => c.track_id === clip.track_id && c.clip_id !== clip.clip_id),
            clipDuration(clip),
            raw,
          )
        : raw;
    const rounded = Math.round(target);
    return Math.abs(rounded - clip.timeline_start_us) >= 1000 ? rounded : null;
  };
  const canNudge = (deltaUs: number) =>
    Boolean(selectedClip) && !clipLocked && nudgeTarget(selectedClip!, deltaUs) !== null;
  const advancedEditIds = (): string[] | null => {
    if (scrubMode === "roll") {
      if (selectedClips.length !== 2) return null;
      return [...selectedClips].sort((a, b) => a.timeline_start_us - b.timeline_start_us).map(clip => clip.clip_id);
    }
    if (scrubMode !== "slip" && scrubMode !== "slide") return null;
    if (!selectedClip) return null;
    if (scrubMode === "slip") return [selectedClip.clip_id];
    const row = clips.filter(clip => clip.track_id === selectedClip.track_id).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    const index = row.findIndex(clip => clip.clip_id === selectedClip.clip_id);
    const before = row[index - 1];
    const after = row[index + 1];
    return before && after ? [before.clip_id, selectedClip.clip_id, after.clip_id] : null;
  };
  const advancedNudgePlan = (deltaUs: number) => {
    const ids = advancedEditIds();
    return document && ids && (scrubMode === "roll" || scrubMode === "slip" || scrubMode === "slide")
      ? getAdvancedEditPlan(scrubMode, ids, deltaUs)
      : null;
  };
  const canAdvancedNudge = (deltaUs: number) => Boolean(advancedNudgePlan(deltaUs)?.operations.length);
  const nudge = (deltaUs: number) => {
    if (scrubMode === "roll" || scrubMode === "slip" || scrubMode === "slide") {
      const plan = advancedNudgePlan(deltaUs);
      if (!plan?.operations.length) {
        setToolbarFeedback(plan?.reason ?? "先在时间线上选择可编辑的片段边界");
        return;
      }
      const label = scrubMode === "roll" ? "滚动修剪" : scrubMode === "slip" ? "滑移素材" : "滑动片段";
      void onPatch(plan.operations, label);
      setToolbarFeedback(`${label}微调 ${deltaUs >= 0 ? "+" : "−"}${Math.abs(deltaUs / 1_000_000).toFixed(3)} 秒`);
      return;
    }
    if (!selectedClip) return;
    const target = nudgeTarget(selectedClip, deltaUs);
    if (target === null) return;
    void onPatch(
      [{ op: "position_clip", clip_id: selectedClip.clip_id, timeline_start_us: target }],
      selectedClip.track_id === "V1" ? "移动片段" : "移动音频片段",
    );
  };
  const trackDropTarget = (clientY: number) => {
    const dynamic = trackRows.filter(item => item.track.id !== "V1" && item.track.id !== "A1");
    const index = dynamic.findIndex(item => {
      const bounds = window.document.querySelector<HTMLElement>(`[data-track-id="${item.track.id}"]`)?.getBoundingClientRect();
      return bounds && clientY < bounds.bottom;
    });
    const targetIndex = index < 0 ? dynamic.length - 1 : index;
    return { targetIndex, id: dynamic[targetIndex]?.track.id ?? null, dynamic };
  };
  const pickTimelineMode = (mode: TimelineMode) => {
    setScrubMode(mode);
    const hint: Record<TimelineMode, string> = {
      select: "选择工具：拖动片段移动，拖动边缘修剪。",
      split: "分割工具：在片段上单击可按指针位置分割。",
      roll: "滚动修剪：拖动两个相邻片段的公共边缘；也可用左右微调按钮逐帧操作。",
      slip: "滑移素材：拖动片段主体可移动源画面；左右微调按钮支持键盘操作。",
      slide: "滑动片段：拖动片段主体以移动片段并修整两侧；左右微调按钮支持键盘操作。",
    };
    setToolbarFeedback(hint[mode]);
  };

  return (
    <section className="timeline-pane" aria-label="时间线">
      {/* Toolbar (DOM) */}
      <div className="timeline-toolbar" style={{ height: TIMELINE_TOOLBAR_HEIGHT, minHeight: TIMELINE_TOOLBAR_HEIGHT }}>
        {/* 参照工具栏最左侧是模式切换（选择 / 分割）+ 1px 竖分隔（Timeline.tsx:4081-4084）。
            主操作在最靠左、其余工具随后，这是时间线工具栏的统一阅读起点。
            我们此前没有这个入口，工具栏从「添加轨道」开始。 */}
        <ModePicker mode={scrubMode} onPick={pickTimelineMode} />
        <span className="toolbar-sep timeline-mode-sep" aria-hidden="true" />
        <IconButton label="撤销" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="重做" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={16} />
        </IconButton>
        {/* Frame nudge remains available through the keyboard/edit commands. OpenFilm's select/split toolbar has no
            duplicate nudge controls, so keep this row focused on its actual editing tools. */}
        {scrubMode !== "select" && scrubMode !== "split" ? <>
          <IconButton label="向前微调一帧" title="向前微调一帧" disabled={!canAdvancedNudge(-frameUs)} onClick={() => nudge(-frameUs)}><ChevronLeft /></IconButton>
          <IconButton label="向后微调一帧" title="向后微调一帧" disabled={!canAdvancedNudge(frameUs)} onClick={() => nudge(frameUs)}><ChevronRight /></IconButton>
        </> : null}
        <IconButton label="添加标记" disabled={!document || totalUs <= 0}
          onClick={() => markerLaneRef.current?.addAtTime(clampRulerTime(activePlayheadStore.get()))}>
          <MarkerToolbarGlyph />
        </IconButton>
        <IconButton label="拆分片段" disabled={!canSplitSelection} onClick={() => {
          const operations = splitSelectionAt(selectedClips, activePlayheadStore.get(), document);
          if (operations.length) void onPatch(operations, "在播放头处拆分");
        }}>
          <SplitToolbarGlyph />
        </IconButton>
        <ToolButton label="时间区间" disabled={totalUs <= 0} active={Boolean(timeRange)} menuOpen={Boolean(rangeButton)}
          onClick={event => {
            rangeTrigger.current = event.currentTarget;
            if (rangeButton) closeRangeMenu();
            else setRangeButton(event.currentTarget);
          }}>
          <SquareDashed size={16} />
        </ToolButton>
        {rangeAnchor && <ContextMenu x={rangeAnchor.left} y={rangeAnchor.bottom + 4} flipTo={rangeAnchor.top - 4}
          onClose={closeRangeMenu} trigger={rangeTrigger} items={[
            { id: "in", label: "设为区间入点", disabled: (timeRange?.endUs ?? totalUs) - activePlayheadStore.get() < MIN_RANGE_US, onSelect: () => markRange("in") },
            { id: "out", label: "设为区间出点", disabled: activePlayheadStore.get() - (timeRange?.startUs ?? 0) < MIN_RANGE_US, onSelect: () => markRange("out") },
            { id: "clear", label: "清除时间区间", disabled: !timeRange, onSelect: () => setTimeRange(null) },
          ]} />}
        {/* 中段状态区（参照 Timeline.tsx:4130-4168）：工具栏中央留给状态，
            不把「正在应用 / 出错了」放进工具堆里，否则读起来像一个按钮。
            我们暂无长任务态，先占位——三段工具围绕它分布，这是参照的阅读节奏。 */}
        <div className="toolbar-status" aria-live="polite">{toolbarFeedback}</div>
        <button
          className="icon-btn"
          title="磁吸吸附：拖动时对齐片段边缘、播放头与网格"
          aria-label="磁吸吸附"
          aria-pressed={prefs.snappingEnabled}
          onClick={toggleSnapping}
        >
          <SeparatorVertical size={15} />
        </button>
        <button className="icon-btn" title={`主轨磁吸${prefs.mainTrackMagnet ? "：开，主轨片段自动首尾相接" : "：关，保留放置位置"}`} aria-label="主轨磁吸" aria-pressed={prefs.mainTrackMagnet} onClick={() => toggleTimelinePref("mainTrackMagnet")}>
          <Magnet size={15} />
        </button>
        <button className="icon-btn" title={`联动${prefs.linkageEnabled ? "：开，随主轨片段移动或删除字幕、画中画和声音" : "：关，编辑主轨时不移动关联素材"}`} aria-label="联动" aria-pressed={prefs.linkageEnabled} onClick={() => toggleTimelinePref("linkageEnabled")}>
          <Paperclip size={15} />
        </button>
        <span className="toolbar-sep toolbar-zoom-sep" aria-hidden="true" />
        <div className="timeline-zoom">
          <button
            aria-label="缩小时间线"
            title="缩小时间线"
            disabled={tracks.length === 0 || totalUs <= 0 || view.projectZoom <= timelineZoomLimits(totalUs).min + 1e-9}
            onClick={() => setZoomAnchored(stepTimelineZoom(view.projectZoom, totalUs, -1))}
          >
            <ZoomOut size={15} />
          </button>
          {/* 已走过部分点亮的轨道（对齐 OpenFilm 的 .tl-zoom）：把当前百分比
              经 --pos 传给 CSS，轨道用 accent 渐变到 --pos 处切换成灰。
              原来轨道是纯灰，看不出"当前处于整条缩放区间的哪一段"。 */}
          <input
            className="timeline-zoom-slider"
            type="range"
            aria-label="时间线缩放"
            min={0}
            max={1}
            step={0.001}
            disabled={tracks.length === 0 || totalUs <= 0}
            value={timelineZoomToSlider(view.projectZoom, totalUs)}
            style={{ width: TIMELINE_ZOOM_SLIDER_WIDTH, "--pos": timelineZoomToSlider(view.projectZoom, totalUs) } as React.CSSProperties}
            onChange={(event) => setZoomAnchored(timelineSliderToZoom(Number(event.target.value), totalUs))}
          />
          <button
            aria-label="放大时间线"
            title="放大时间线"
            disabled={tracks.length === 0 || totalUs <= 0 || view.projectZoom >= timelineZoomLimits(totalUs).max - 1e-9}
            onClick={() => setZoomAnchored(stepTimelineZoom(view.projectZoom, totalUs, 1))}
          >
            <ZoomIn size={15} />
          </button>
        </div>
      </div>

      {/* Body: 冻结标尺（滚动区外，零抖动）+ 滚动区（轨道头列/封面条带/片段区）。
          标尺画布绝对定位覆盖滚动视口顶部（见 .timeline-ruler-pin），主画布仍是第一个 canvas。 */}
      {/* 时间线主体 + 右侧 44px 音频电平表（参照 ProjectView.tsx:4926/4995：
          电平表在时间线右缘独占一列，时间线内容 inset 掉 METERS_W）。
          我们此前只有一个 12px 的两点 VU，且在播放条里——与参照的位置和形态都不同。 */}
      <div className="timeline-body-row">
      <div ref={timelineBodyRef} className="timeline-body" onKeyDown={event => {
        if (event.key !== "Escape" || !timeRange || contextMenu || rangeButton) return;
        event.preventDefault();
        setTimeRange(null);
      }}>
        <div ref={scrollRef} className="timeline-scroll" onScroll={onTimelineScroll}>
        {/* Left gutter (DOM)：每条轨道一个属性头
            [类型标识] [锁定] [隐藏(视频/文本)] [静音(视频/音频)] [独奏(视频/音频)] */}
        <div className="timeline-left" data-scrolled={view.scrollX > 0 ? "1" : undefined} style={{ width: trackHeadWidth, height: contentHeight, position: "relative" }}>
          <div className="timeline-left-corner" style={{ height: view.rulerHeight }} />
          {tracks.length > 0 && (
            <button
              type="button"
              className="timeline-track-head-divider"
              aria-label={headsCollapsed ? "展开轨道控制栏" : "收起轨道控制栏"}
              aria-expanded={!headsCollapsed}
              title={headsCollapsed ? "展开轨道控制栏" : "收起轨道控制栏"}
              style={{ left: trackHeadWidth - 6, top: Math.max(view.rulerHeight + 4, contentHeight / 2 - 10) }}
              onClick={() => setHeadsCollapsed(value => !value)}
            >
              {headsCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
            </button>
          )}
          {trackRows.map((row) => {
            // 兼容旧文档/旧 core 的轨道 kind（visual→video、caption→text）。
            const rawKind: string = row.track.kind;
            const kind = rawKind === "visual" ? "video" : rawKind === "caption" ? "text" : rawKind;
            // 剪映式：轨道上没有素材时不显示属性开关（仅保留类型标识）。
            const hasClips = clips.some((clip) => clip.track_id === row.track.id);
            return (
              <div
                key={row.track.id}
                className="timeline-track-head"
                data-track-kind={kind}
                data-track-id={row.track.id}
                data-head-collapsed={headsCollapsed ? "true" : undefined}
                data-track-drop-target={trackDragTarget === row.track.id ? "true" : undefined}
                tabIndex={0}
                role="group"
                aria-label={`轨道 ${row.track.id}`}
                aria-keyshortcuts={row.track.id !== "V1" && row.track.id !== "A1" ? "Alt+ArrowUp Alt+ArrowDown Shift+F10" : undefined}
                title={row.track.id !== "V1" && row.track.id !== "A1" ? "拖动轨道编号或使用 Alt+↑/↓ 排序；右键打开菜单" : undefined}
                onContextMenu={event => {
                  event.preventDefault(); event.stopPropagation();
                  if (["V1", "A1", "C1"].includes(row.track.id)) return;
                  setTrackMenu({ trackId: row.track.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget });
                }}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    const dynamic = trackRows.filter(item => item.track.id !== "V1" && item.track.id !== "A1");
                    const from = dynamic.findIndex(item => item.track.id === row.track.id);
                    const to = from + (event.key === "ArrowUp" ? -1 : 1);
                    if (from >= 0 && to >= 0 && to < dynamic.length) void onPatch([{ op: "move_track", track_id: row.track.id, to_index: to }], "调整轨道顺序");
                    event.preventDefault(); event.stopPropagation(); return;
                  }
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                  event.preventDefault(); event.stopPropagation();
                  if (["V1", "A1", "C1"].includes(row.track.id)) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTrackMenu({ trackId: row.track.id, x: rect.left, y: rect.bottom, trigger: event.currentTarget });
                }}
                data-flag-cols={kind === "text" ? "2" : "4"}
                data-lane-picked={trackRows.some(r => selection?.kind === "clip" && clips.some(c => c.clip_id === selection.id && c.track_id === row.track.id)) ? "1" : undefined}
                style={{ top: row.y, height: row.height }}
              >
                <TrackResizeHandle trackId={row.track.id} height={row.height}
                  onResize={(height, done) => resizeTrack(row.track.id, height, done)} />
                {/* 2026-11-11 对齐 OpenFilm 的 LaneMark（Timeline.tsx:295）：
                   轨道头左侧是**纯文字轨号**，没有图标、没有色块底、没有方块边框。
                   原来是「图标 + 轨号」的小徽章，在 119px 的头列里占了 30px，
                   且带一层与图标同色的小方框；参照软件里这一格只是个 10.5px
                   的灰字，左侧留白、右侧才是开关图标列。 */}
                <span className="timeline-track-badge" title={`${row.track.id} ${kind === "video" ? "视频" : kind === "text" ? "文本" : "音频"}轨道`}
                  onPointerDown={event => {
                    if (event.button !== 0 || row.track.id === "V1" || row.track.id === "A1") return;
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    trackDragRef.current = { id: row.track.id, startY: event.clientY, moved: false };
                  }}
                  onPointerMove={event => {
                    const drag = trackDragRef.current;
                    if (drag && Math.abs(event.clientY - drag.startY) >= 5) {
                      drag.moved = true;
                      setTrackDragTarget(trackDropTarget(event.clientY).id);
                    }
                  }}
                  onPointerCancel={() => { trackDragRef.current = null; setTrackDragTarget(null); }}
                  onPointerUp={event => {
                    const drag = trackDragRef.current;
                    trackDragRef.current = null;
                    setTrackDragTarget(null);
                    if (!drag?.moved) return;
                    const { dynamic, targetIndex } = trackDropTarget(event.clientY);
                    if (targetIndex !== dynamic.findIndex(item => item.track.id === drag.id)) void onPatch([{ op: "move_track", track_id: drag.id, to_index: targetIndex }], "调整轨道顺序");
                  }}>
                  <small>{row.track.id}</small>
                </span>
                {headsCollapsed && (
                  <button
                    type="button"
                    className="timeline-track-collapsed-menu"
                    aria-label={`打开轨道 ${row.track.id} 控制菜单`}
                    aria-haspopup="menu"
                    onClick={event => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTrackMenu({ trackId: row.track.id, x: rect.right + 4, y: rect.top, trigger: event.currentTarget });
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                )}
                {!headsCollapsed && (
                  <>
                    {/* OpenFilm 轨号与开关列间固定留 4px。 */}
                    <span aria-hidden />
                    {hasClips && <>
                    <button
                      className="track-flag"
                      aria-label={`锁定轨道 ${row.track.id}`}
                      aria-pressed={row.track.locked}
                      title="锁定轨道"
                      onClick={() => patchTrackFlags(row.track.id, { locked: !row.track.locked })}
                    >
                      {row.track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                    </button>
                    <button
                      className="track-flag"
                      aria-label={`隐藏轨道 ${row.track.id}`}
                      aria-pressed={row.track.hidden}
                      title="隐藏轨道（预览不渲染该轨内容）"
                      onClick={() => patchTrackFlags(row.track.id, { hidden: !row.track.hidden })}
                    >
                      {row.track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                    </button>
                    {kind !== "text" && (
                      <button
                        className="track-flag"
                        aria-label={`静音轨道 ${row.track.id}`}
                        aria-pressed={row.track.muted}
                        title="关闭原声"
                        onClick={() => patchTrackFlags(row.track.id, { muted: !row.track.muted })}
                      >
                        {row.track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                      </button>
                    )}
                    {kind !== "text" && (
                      <button
                        className={`track-flag track-solo${row.track.solo ? " active" : ""}`}
                        aria-label={`独奏轨道 ${row.track.id}`}
                        aria-pressed={row.track.solo}
                        title="独奏（仅播放该轨声音）"
                        onClick={() => patchTrackFlags(row.track.id, { solo: !row.track.solo })}
                      >
                        S
                      </button>
                    )}
                    </>}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {trackMenu && (() => {
          const track = tracks.find(item => item.id === trackMenu.trackId);
          const members = clips.filter(clip => clip.track_id === trackMenu.trackId);
          const fixed = trackMenu.trackId === "V1" || trackMenu.trackId === "A1" || trackMenu.trackId === "C1";
          const disabled = !track || track.locked || members.some(clip => isClipLocked(clip.clip_id));
          const height = trackRows.find(row => row.track.id === trackMenu.trackId)?.height;
          const sizeKind = track?.kind === "audio" ? "audio" : track?.kind === "video" ? "visual" : null;
          const close = () => { setTrackMenu(null); trackMenu.trigger.focus({ preventScroll: true }); };
          const presetItems = sizeKind ? (["small", "medium", "large"] as const).map(size => ({
            id: `height-${size}`,
            label: `轨道高度：${size === "small" ? "小" : size === "medium" ? "中" : "大"}`,
            note: `${TRACK_SIZES[size][sizeKind]} px`,
            checked: height === TRACK_SIZES[size][sizeKind],
            onSelect: () => { resizeTrack(trackMenu.trackId, TRACK_SIZES[size][sizeKind], true); close(); },
          })) : [];
          const items = [
            ...(track ? [{
              id: "toggle-lock", label: track.locked ? "解锁轨道" : "锁定轨道", checked: track.locked,
              onSelect: () => { patchTrackFlags(track.id, { locked: !track.locked }); close(); },
            }, {
              id: "toggle-hidden", label: track.hidden ? "显示轨道" : "隐藏轨道", checked: track.hidden,
              onSelect: () => { patchTrackFlags(track.id, { hidden: !track.hidden }); close(); },
            }, ...(track.kind !== "text" ? [{
              id: "toggle-muted", label: track.muted ? "开启声音" : "关闭声音", checked: track.muted,
              onSelect: () => { patchTrackFlags(track.id, { muted: !track.muted }); close(); },
            }, {
              id: "toggle-solo", label: track.solo ? "取消独奏" : "独奏", checked: track.solo,
              onSelect: () => { patchTrackFlags(track.id, { solo: !track.solo }); close(); },
            }] : [])] : []),
            ...(track && (presetItems.length || height !== undefined) ? [{ id: "track-options-separator", separator: true as const }] : []),
            ...presetItems,
            ...(track && height !== undefined ? [{
              id: "height-default", label: "恢复默认高度", checked: !prefs.trackHeights[trackMenu.trackId],
              onSelect: () => { resizeTrack(trackMenu.trackId, null, true); close(); },
            }] : []),
            ...(members.length && !fixed ? [{ id: "delete-track-separator", separator: true as const }] : []),
            ...(members.length && !fixed ? [{
              id: "delete-track", label: "删除轨道", danger: true, disabled,
              hint: disabled ? "轨道或轨道中的片段已锁定" : undefined,
              onSelect: () => { void onPatch([{ op: "remove_track", track_id: trackMenu.trackId }], "删除轨道"); close(); },
            }] : []),
          ];
          return <ContextMenu x={trackMenu.x} y={trackMenu.y} onClose={close} items={items} />;
        })()}

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="timeline-canvas-container"
          data-mode={scrubMode}
          style={{ flex: 1, position: "relative", height: contentHeight }}
        >
          {/* T3 参照 Timeline.tsx:2090-2110：分割模式刀线，直写 DOM 防每 move 重渲。 */}
          <div ref={bladeRef} className="tl-blade-line" style={{ display: "none" }} aria-hidden="true" />
          <canvas
            ref={canvasRef}
            aria-label="时间线画布"
            data-timeline-pps={view.pixelsPerSecond}
            data-timeline-scroll-x={view.scrollX}
            data-speed-mode={speedModeActive ? "true" : undefined}
            // 可聚焦：点击时间线后键盘焦点落在画布上，Del/方向键等
            // 时间线快捷键（以事件目标判定作用域）才能生效。
            tabIndex={0}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={event => finishInteraction(event, true)}
            onPointerCancel={event => finishInteraction(event, false)}
            onLostPointerCapture={event => {
              if (activeCanvasPointerIdRef.current === event.pointerId) finishInteraction(event, false);
            }}
            onPointerLeave={handleCanvasMouseLeave}
            onDoubleClick={handleCanvasDoubleClick}
            onContextMenu={handleCanvasContextMenu}
            onDragOver={(event) => { event.preventDefault(); allowDrop(event, clips.length); }}
            onDrop={(event) => handleDrop(event, dropIndex ?? clips.length)}
            // relatedTarget 仍在画布内说明只是子区域切换，不清除落区高亮，避免 overlay 抖动。
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node && canvasRef.current?.contains(event.relatedTarget))) {
                clearDropPreview();
              }
            }}
            onDragEnd={() => clearDropPreview()}
            style={{
              display: "block",
              cursor: "default",
              outline: "none",
              // B17：画布 viewport 化——DOM 滚动空间保持全内容尺寸
              //（容器高=contentHeight），Canvas backing 仅覆盖视口+overscan
              //（纵向 2 轨），不分配等于所有轨道高度的大位图。画布随
              // scrollTop 同步摆位（render 内联写 top，无 effect 一帧滞后），
              // 绘制时 ctx 平移 -canvasTopY 使内容坐标照常。
              position: "absolute",
              left: 0,
              top: canvasTopY,
            }}
          />
          {filmstripOverlayGroups.length > 0 && (
            <div
              data-timeline-filmstrip-overlay="1"
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: canvasTopY,
                width: canvasSize.width,
                height: canvasViewportHeight,
                overflow: "hidden",
                pointerEvents: "none",
                zIndex: 0,
              }}
            >
              {filmstripOverlayGroups.map(group => (
                <div
                  key={group.clipId}
                  data-timeline-filmstrip-clip={group.clipId}
                  style={{
                    position: "absolute",
                    left: group.x,
                    top: group.y - canvasTopY,
                    width: group.width,
                    height: group.height,
                    overflow: "hidden",
                    borderRadius: `0 0 ${CLIP_RADIUS}px ${CLIP_RADIUS}px`,
                    filter: group.filter,
                  }}
                >
                  {group.cells.map(cell => <TimelineFilmstripCanvas key={cell.key} cell={cell} />)}
                </div>
              ))}
            </div>
          )}
          <div className="timeline-clip-label-layer" aria-hidden="true">
            {clipLabelRects.map((label) => (
              <div
                key={label.id}
                className="timeline-clip-label"
                data-timeline-clip-label={label.id}
                data-speed={label.speed}
                style={{
                  left: label.x,
                  top: label.y,
                  width: label.width,
                  height: label.height,
                  filter: label.hidden ? "grayscale(1)" : undefined,
                }}
              >
                <div className="timeline-clip-label-info" style={{ height: CLIP_HEADER_H, backgroundColor: label.headerColor }}>
                  <span className="timeline-clip-label-pin" data-label-pin="" style={{ translate: label.pinShift > 0 ? `${label.pinShift}px 0` : undefined }}>
                    <span className="timeline-clip-label-name" data-label-text="">{label.title}</span>
                    {label.speed && <span className="timeline-clip-label-speed" data-label-text="">{label.speed}</span>}
                    {label.showDuration && <span className="timeline-clip-label-duration" data-label-text="">{label.duration}</span>}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {interaction?.kind === "move" && !interaction.copyOnStart && interaction.moveMode === "insert" &&
            interaction.dragPlan?.lead && !interaction.dragPlan.reason && (() => {
              const lead = interaction.dragPlan.lead;
              const row = trackRowOf(trackRows, lead.trackId);
              if (!row) return null;
              const top = row.y + CLIP_ROW_INSET - 3;
              const clipHeight = Math.max(4, row.height - CLIP_ROW_INSET * 2);
              return (
                <div
                  data-timeline-insert-point={Math.round(lead.startUs)}
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    zIndex: 3,
                    pointerEvents: "none",
                    left: Math.round(timeToX(lead.startUs, view)) - 1,
                    top,
                    width: 3,
                    height: clipHeight + 6,
                    borderRadius: 999,
                    background: "var(--accent)",
                    boxShadow: "0 0 6px color-mix(in srgb, var(--accent) 70%, transparent)",
                  }}
                />
              );
            })()}
          {/* 主轨封面入口（剪映式）：仅主轨一处，钉在 V1 轨道头列（与左侧
              图标区同高齐平——上方有字幕轨/动态视频轨时仍随 V1 行定位，
              不再写死标尺下方首行）；点击截取当前播放头画面设为项目封面。 */}
          {(() => {
            const mainRow = trackRowOf(trackRows, "V1");
            if (!mainRow) return null;
            return (
              <button
                className="timeline-cover-entry"
                style={{ top: mainRow.y + (mainRow.height - 38) / 2, height: 38, width: 38, left: 5 }}
                title={coverUrl ? "点击更换项目封面（截取当前播放头画面）" : "截取当前播放头画面设为项目封面"}
                onClick={() => onCaptureCover?.()}
              >
                {coverUrl ? <img src={coverUrl} alt="" draggable={false} /> : <PenLine size={13} strokeWidth={1.8} />}
                <span>封面</span>
              </button>
            );
          })()}
          {/* Accessible clip list (DOM): mirrors selection so keyboard /
              screen-reader users and tests can select clips. */}
          <div
            className="timeline-a11y-clips"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0 0 0 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {clips.map((clip, index) => {
              const isSelected =
                selection?.kind === "clip"
                  ? selection.id === clip.clip_id
                  : selection?.kind === "clips"
                    ? selection.ids.includes(clip.clip_id)
                    : false;
              return (
                <button
                  key={clip.clip_id}
                  data-clip-id={clip.clip_id}
                  aria-label={`Clip ${index + 1} ${clip.asset_kind} ${formatTime(clip.timeline_end_us - clip.timeline_start_us)}`}
                  aria-pressed={isSelected}
                  onClick={event => setSelection(event.shiftKey || event.ctrlKey || event.metaKey
                    ? toggleClipSelection(clip, event.altKey)
                    : event.altKey ? { kind: "clip", id: clip.clip_id } : linkedSelection(clip))}
                />
              );
            })}
            {captions.map((caption, index) => {
              const isSelected =
                selection?.kind === "caption" && selection.id === caption.caption_id;
              return (
                <button
                  key={caption.caption_id}
                  aria-label={caption.text || `字幕 ${index + 1}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelection({ kind: "caption", id: caption.caption_id })}
                />
              );
            })}
          </div>
          {/* B2: transition markers (DOM overlay for hover/selection styles) */}
          {transitionRects.map((rect) => {
            const isSelected =
              selection?.kind === "transition" &&
              selection.id === rect.transition.transition_id;
            // T9 参照 Timeline.tsx:3489-3526：16px 高芯片、行垂直居中（不低于信息条）、
            // 未选 rgba(255,255,255,.88)+#1b1e25、选中 accent、X 交叉线 1.2px、>70px 显示名、左右 6px 拖条。
            const chipTop = Math.max(rect.y + 16, rect.y + Math.round(rect.height / 2) - 8);
            const chipW = Math.max(10, rect.width);
            return (
              <div
                key={rect.transition.transition_id}
                role="button"
                tabIndex={-1}
                className={`timeline-transition-marker${isSelected ? " selected" : ""}`}
                data-transition={rect.transition.kind}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: chipTop,
                  width: chipW,
                  height: 16,
                  pointerEvents: "auto",
                }}
                title={`转场 ${rect.transition.kind} · ${(rect.transition.duration_us / 1_000_000).toFixed(2)}s`}
                aria-label={`转场 ${rect.transition.kind} ${(rect.transition.duration_us / 1_000_000).toFixed(2)}秒`}
                aria-pressed={isSelected}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelection({ kind: "transition", id: rect.transition.transition_id });
                }}
              >
                <svg aria-hidden className="transition-x" viewBox="0 0 100 16" preserveAspectRatio="none">
                  <path d="M0 15 L100 1" vectorEffect="non-scaling-stroke" fill="none" />
                  <path d="M0 1 L100 15" vectorEffect="non-scaling-stroke" fill="none" />
                </svg>
                {chipW > 70 ? <span className="transition-name">{rect.transition.kind}</span> : null}
                {(["start", "end"] as const).map(side => (
                  <span key={side} role="presentation" className={`transition-edge ${side}`}
                    aria-label={`调整转场时长 ${side === "start" ? "起点" : "终点"}`}
                    onPointerDown={event => {
                      event.stopPropagation();
                      beginTransitionResize(rect.transition, side, event);
                    }}
                    onPointerMove={moveTransitionResize}
                    onPointerUp={endTransitionResize}
                    onPointerCancel={endTransitionResize} />
                ))}
              </div>
            );
          })}
          {/* Core-projected source-fact transitions have their own identity path;
              these IDs are never passed to legacy update/remove_transition ops. */}
          {activeTransitionRects.map((rect) => {
            const transition = rect.transition;
            const isSelected = selection?.kind === "active-transition" && selection.id === transition.transition_id;
            const chipTop = Math.max(rect.y + 16, rect.y + Math.round(rect.height / 2) - 8);
            const chipW = Math.max(10, rect.width);
            const title = `${transition.kind} · ${((transition.end_us - transition.start_us) / 1_000_000).toFixed(2)}s`;
            return (
              <div
                key={`active:${transition.transition_id}`}
                role="button"
                tabIndex={-1}
                className={`timeline-transition-marker timeline-active-transition-marker${isSelected ? " selected" : ""}${rect.editable ? " editable" : " read-only"}`}
                data-transition={transition.kind}
                data-active-transition-id={transition.transition_id}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: chipTop,
                  width: chipW,
                  height: 16,
                  pointerEvents: "auto",
                }}
                title={`${title}${transition.rest_clip_id ? ` · rest ${transition.rest_clip_id}` : ""}${rect.editable ? " · 拖动边缘调整" : " · 只读"}`}
                aria-label={`活动转场 ${title}`}
                aria-pressed={isSelected}
                onClick={event => {
                  event.stopPropagation();
                  setSelection({ kind: "active-transition", id: transition.transition_id });
                }}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  const coords = canvasCoords(event);
                  if (!coords) return;
                  setSelection({ kind: "active-transition", id: transition.transition_id });
                  setContextMenu({ x: coords.x, y: coords.y, target: { kind: "active-transition", transitionId: transition.transition_id }, timeUs: xToTime(coords.x, view) });
                }}
              >
                <svg aria-hidden className="transition-x" viewBox="0 0 100 16" preserveAspectRatio="none">
                  <path d="M0 15 L100 1" vectorEffect="non-scaling-stroke" fill="none" />
                  <path d="M0 1 L100 15" vectorEffect="non-scaling-stroke" fill="none" />
                </svg>
                {chipW > 70 ? <span className="transition-name">{transition.kind}</span> : null}
                {rect.editable ? (["start", "end"] as const).map(edge => (
                  <span
                    key={edge}
                    role="presentation"
                    className={`transition-edge ${edge}`}
                    aria-label={`调整活动转场${edge === "start" ? "起点" : "终点"}`}
                    onPointerDown={event => beginActiveTransitionResize(rect, edge, event)}
                    onPointerMove={moveActiveTransitionResize}
                    onPointerUp={endActiveTransitionResize}
                    onPointerCancel={endActiveTransitionResize}
                  />
                )) : null}
              </div>
            );
          })}
          {/* B3/Round5: keyframe dots on selected clips, laid out in the expanded lanes */}
          {clips.map((clip) => {
            if (!clip.keyframes || selection?.kind !== "clip" || selection.id !== clip.clip_id) return null;
            const rect = clipRects.find((item) => item.clip.clip_id === clip.clip_id);
            if (!rect) return null;
            const colors: Record<string, string> = { position: "#6fd3d3", scale: "#f0d264", rotate: "#f0a264", opacity: "#ffffff" };
            const props = KEYFRAME_ORDER.filter((property) => clip.keyframes?.[property]);
            return props.flatMap((property) => {
              const track = clip.keyframes?.[property as keyof NonNullable<TimelineClip["keyframes"]>];
              if (!track) return [];
              const laneIndex = props.indexOf(property);
              const laneCenterY =
                rect.y + rect.height + 2 + 4 + laneIndex * KEYFRAME_LANE_HEIGHT + KEYFRAME_LANE_HEIGHT / 2;
              return track.frames.map((frame: { t_us: number; x?: number; y?: number; v?: number }) => {
                const x = timeToX(clip.timeline_start_us + frame.t_us, view);
                if (x < rect.x || x > rect.x + rect.width) return null;
                const commit = (newTUs: number) => {
                  const frames = track.frames
                    .map((f: { t_us: number; x?: number; y?: number; v?: number }) => (f.t_us === frame.t_us ? { ...f, t_us: Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(newTUs))) } : { ...f, t_us: Math.round(f.t_us) }))
                    .sort((a: { t_us: number }, b: { t_us: number }) => a.t_us - b.t_us);
                  void onPatch(
                    [{ op: "set_clip_keyframes", clip_id: clip.clip_id, property: property as never, frames }],
                    `调整${property}关键帧时间`,
                  );
                };
                return (
                  <button
                    key={`${clip.clip_id}-${property}-${frame.t_us}`}
                    className="timeline-keyframe-dot"
                    data-property={property}
                    style={{ position: "absolute", left: x - 4, top: laneCenterY - 4, width: 8, height: 8, background: colors[property] ?? "#fff", pointerEvents: "auto" }}
                    aria-label={`${property} 关键帧 ${formatTime(frame.t_us)}`}
                    title={`${property} @ ${formatTime(frame.t_us)}（拖动改时间）`}
                    draggable
                    onDragEnd={(event) => {
                      const canvas = canvasRef.current;
                      if (!canvas) return;
                      const bounds = canvas.getBoundingClientRect();
                      const scale = canvas.width / bounds.width || 1;
                      const newTUs = Math.max(0, Math.min(clip.timeline_end_us - clip.timeline_start_us, Math.round(xToTime((event.clientX - bounds.left) * scale, view))));
                      commit(newTUs);
                    }}
                    onClick={(event) => event.stopPropagation()}
                  />
                );
              });
            });
          })}
          {/* Drop zone overlay when dragging assets */}
          {dropIndex !== null && (
            <div
              className="timeline-drop-overlay"
              style={{
                position: "absolute",
                left: view.headerWidth,
                top: view.rulerHeight,
                right: 0,
                bottom: 0,
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {dropIntent?.accepts && (() => {
                const row = dropIntent.trackId !== "new" && dropIntent.trackId ? trackRowOf(trackRows, dropIntent.trackId) : null;
                const anchor = dropIntent.newTrackAnchorId ? trackRowOf(trackRows, dropIntent.newTrackAnchorId) : null;
                const startX = timeToX(dropIntent.atUs, view) - view.headerWidth;
                const width = Math.max(8, timeToX(dropIntent.atUs + dropIntent.previewDurationUs, view) - timeToX(dropIntent.atUs, view));
                const previewColor = dropIntent.mode === "overwrite" ? "var(--warn, #f0b45a)" : "var(--accent, #16c7c2)";
                const rowTop = row ? row.y - view.rulerHeight : 0;
                const lineY = anchor
                  ? (dropIntent.newTrackSide === "after" ? anchor.y + anchor.height - view.rulerHeight : anchor.y - view.rulerHeight)
                  : 0;
                const shiftIds = new Set(clips.filter(clip => row && clip.track_id === row.track.id && clip.timeline_start_us >= dropIntent.atUs).map(clip => clip.clip_id));
                if (prefs.linkageEnabled) {
                  const groups = new Set(clips.filter(clip => shiftIds.has(clip.clip_id) && clip.link_group_id).map(clip => clip.link_group_id));
                  for (const clip of clips) if (clip.link_group_id && groups.has(clip.link_group_id)) shiftIds.add(clip.clip_id);
                }
                const ripples = dropIntent.mode === "insert" ? clips.filter(clip => shiftIds.has(clip.clip_id)) : [];
                return <>
                  {row && dropIntent.trackId !== "new" && <div
                    aria-hidden="true"
                    style={{
                      position: "absolute", left: startX, top: rowTop,
                      width, height: row.height, boxSizing: "border-box",
                      border: `1px dashed ${previewColor}`,
                      background: dropIntent.mode === "overwrite" ? "rgba(240, 180, 90, 0.20)" : "rgba(22, 199, 194, 0.16)",
                      borderRadius: 3,
                    }}
                  />}
                  {dropIntent.trackId === "new" && <div
                    aria-hidden="true"
                    style={{ position: "absolute", left: 0, right: 0, top: lineY, height: 2, background: "var(--accent, #16c7c2)", boxShadow: "0 0 0 1px rgba(22, 199, 194, 0.18)" }}
                  />}
                  {ripples.map(clip => {
                    const clipRow = trackRowOf(trackRows, clip.track_id);
                    if (!clipRow) return null;
                    const shiftedStart = clip.timeline_start_us + dropIntent.previewDurationUs;
                    const left = timeToX(shiftedStart, view) - view.headerWidth;
                    const right = timeToX(clip.timeline_end_us + dropIntent.previewDurationUs, view) - view.headerWidth;
                    return <div key={`asset-drop-ripple-${clip.clip_id}`} aria-hidden="true" style={{
                      position: "absolute", left, top: clipRow.y - view.rulerHeight,
                      width: Math.max(2, right - left), height: clipRow.height,
                      border: "1px dashed var(--accent, #16c7c2)", boxSizing: "border-box",
                      background: "rgba(22, 199, 194, 0.08)", borderRadius: 3,
                    }} />;
                  })}
                </>;
              })()}
              {dropIntent?.accepts === false && <span className="drop-hint" role="status" aria-live="polite">无法放入已锁定或不兼容的轨道</span>}
              {dropIntent?.accepts && dropIntent.zone === "center" && dropItemCountRef.current === 1 && <span className="drop-hint" role="status" aria-live="polite">释放以确认替换此片段</span>}
              {dropIntent?.accepts && dropIntent.mode === "place" && <span className="drop-hint" role="status" aria-live="polite">{dropIntent.trackId === "new" ? "释放以新建轨道并放置素材" : "释放以放置素材"} · {formatTime(dropIntent.atUs)}</span>}
              {dropIntent?.accepts && dropIntent.mode === "insert" && <span className="drop-hint" role="status" aria-live="polite">释放以插入到时间线（后续片段顺延） · {formatTime(dropIntent.atUs)}</span>}
              {dropIntent?.accepts && dropIntent.mode === "overwrite" && dropIntent.zone !== "center" && <span className="drop-hint" role="status" aria-live="polite">释放以覆盖 · {formatTime(dropIntent.atUs)}</span>}
            </div>
          )}
          {replaceAssetRequest && (
            <div className="modal-backdrop timeline-drop-replace-backdrop" onClick={cancelReplaceAsset}>
              <section
                className="modal timeline-drop-replace-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="timeline-drop-replace-title"
                aria-describedby="timeline-drop-replace-description"
                tabIndex={-1}
                ref={element => { if (element && !element.contains(window.document.activeElement)) element.focus(); }}
                onClick={event => event.stopPropagation()}
                onKeyDown={event => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelReplaceAsset();
                  }
                }}
              >
                <div className="modal-heading">
                  <div><h2 id="timeline-drop-replace-title">替换时间线素材？</h2></div>
                  <button type="button" className="icon-btn" aria-label="取消替换" title="取消 · Esc" onClick={cancelReplaceAsset}><X size={15} /></button>
                </div>
                <div className="modal-body">
                  <p id="timeline-drop-replace-description">
                    将替换“{clipNames.get(replaceAssetRequest.targetClipId) ?? "此片段"}”引用的素材。确认后只提交一次时间线修改。
                  </p>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn secondary" onClick={cancelReplaceAsset}>取消</button>
                  <button type="button" className="btn primary" onClick={confirmReplaceAsset}>确认替换</button>
                </div>
              </section>
            </div>
          )}
          {replaceClipRequest && (
            <div className="modal-backdrop timeline-drop-replace-backdrop" onClick={cancelReplaceClip}>
              <section
                className="modal timeline-drop-replace-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="timeline-clip-replace-title"
                aria-describedby="timeline-clip-replace-description"
                tabIndex={-1}
                ref={element => { if (element && !element.contains(window.document.activeElement)) element.focus(); }}
                onClick={event => event.stopPropagation()}
                onKeyDown={event => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelReplaceClip();
                  }
                }}
              >
                <div className="modal-heading">
                  <div><h2 id="timeline-clip-replace-title">替换时间线片段？</h2></div>
                  <button type="button" className="icon-btn" aria-label="取消替换" title="取消 · Esc" onClick={cancelReplaceClip}><X size={15} /></button>
                </div>
                <div className="modal-body">
                  <p id="timeline-clip-replace-description">
                    将移除“{clipNames.get(replaceClipRequest.targetClipId) ?? "目标片段"}”，并把拖动的片段放到该位置。确认后一次提交时间线修改。
                  </p>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn secondary" onClick={cancelReplaceClip}>取消</button>
                  <button type="button" className="btn primary" onClick={confirmReplaceClip}>确认替换</button>
                </div>
              </section>
            </div>
          )}
          {clips.length === 0 && (
            // 空态提示（2026-11-11 对齐 OpenFilm 的 data-timeline-empty）：
            // 虚线框铺满整个轨道区，而不是只占首行一条带。参照软件里这块虚线
            // 就是「整片区域都能接住拖放」的视觉承诺；只框住一行时，用户会以为
            // 只有那一行能放。内缩 10px 上下留白，与行组的 TL_VPAD 一致。
            <div
              className="timeline-empty-drop"
              style={{
                position: "absolute",
                left: view.headerWidth,
                top: view.rulerHeight,
                right: 0,
                bottom: SCROLLBAR_HEIGHT_PX,
                margin: TRACK_VIEW_PAD,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <Film size={15} aria-hidden="true" style={{ marginRight: 8, flex: "0 0 auto", color: "var(--tl-label)" }} />
              将视频或图片拖到这里开始剪辑
            </div>
          )}
          {/* T10 参照 Timeline.tsx:3771-3960 + ContextMenu.tsx：body portal 菜单（键盘导航/
              翻边定位/danger/hint）。条目只接已有 op；删除类 danger；禁用项留原因。 */}
          {contextMenu && (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={() => setContextMenu(null)}
              items={((): ContextMenuEntry[] => {
                const target = contextMenu.target;
                const close = (fn: () => void) => () => { fn(); setContextMenu(null); };
                if (target.kind === "clip") {
                  const clip = clips.find((c) => c.clip_id === target.clipId);
                  if (!clip) return [];
                  const locked = isClipLocked(clip.clip_id);
                  const clipItselfLocked = Boolean(document?.locked_elements?.includes(clip.clip_id));
                  const deleteTargets = selectedClips.some(item => item.clip_id === clip.clip_id) ? selectedClips : [clip];
                  const magneticDelete = document && prefs.mainTrackMagnet && clip.track_id === "V1"
                    ? planMagneticDelete(document, deleteTargets, prefs.linkageEnabled)
                    : undefined;
                  const ripple = document ? planRippleDelete(document, deleteTargets, prefs.linkageEnabled) : { operations: [] };
                  const magneticMove = document && clip.track_id === "V1" ? planMagneticMove(document, clip.clip_id, activePlayheadStore.get(), true) : { operations: [] };
                  const playheadNowUs = activePlayheadStore.get();
                  const split = splitClipAt(clip, playheadNowUs, document);
                  const visualClip = clip.asset_kind === "video" || clip.asset_kind === "image";
                  const visualFactItems: ContextMenuEntry[] = visualClip ? [
                    {
                      id: "picture-fade-in",
                      label: clip.picture_fade_in_us ? "清除画面淡入" : "添加画面淡入（0.5 秒）",
                      disabled: locked,
                      onSelect: close(() => void onPatch([{
                        op: "set_clip_transition_facts",
                        clip_id: clip.clip_id,
                        picture_fade_in_us: clip.picture_fade_in_us ? null : 500_000,
                      }], clip.picture_fade_in_us ? "清除画面淡入" : "添加画面淡入")),
                    },
                    {
                      id: "picture-fade-out",
                      label: clip.picture_fade_out_us ? "清除画面淡出" : "添加画面淡出（0.5 秒）",
                      disabled: locked,
                      onSelect: close(() => void onPatch([{
                        op: "set_clip_transition_facts",
                        clip_id: clip.clip_id,
                        picture_fade_out_us: clip.picture_fade_out_us ? null : 500_000,
                      }], clip.picture_fade_out_us ? "清除画面淡出" : "添加画面淡出")),
                    },
                  ] : [];
                  const moveFactItem: ContextMenuEntry | null = clip.asset_kind === "video" ? {
                    id: "picture-move-in",
                    label: clip.move_in ? "清除进入运动" : "添加推入进入（0.5 秒）",
                    disabled: locked,
                    onSelect: close(() => void onPatch([{
                      op: "set_clip_transition_facts",
                      clip_id: clip.clip_id,
                      move_in: clip.move_in ? null : { preset_id: "motions/move-push-left", duration_us: 500_000 },
                    }], clip.move_in ? "清除进入运动" : "添加进入运动")),
                  } : null;
                  const pickedIds = selectedClips.some(item => item.clip_id === clip.clip_id)
                    ? selectedClips.map(item => item.clip_id)
                    : clip.link_group_id ? clips.filter(item => item.link_group_id === clip.link_group_id).map(item => item.clip_id) : [clip.clip_id];
                  const pickedKey = [...pickedIds].sort().join("|");
                  const pickedSpeedClips = pickedIds.map(id => clips.find(item => item.clip_id === id)).filter((item): item is TimelineClip => Boolean(item));
                  const speedable = pickedSpeedClips.some(canChangeClipSpeed);
                  const speedLocked = pickedSpeedClips.some(item => isClipLocked(item.clip_id, true));
                  return [
                    { id: "split", label: "在播放头处拆分", disabled: !split, hint: split ? undefined : locked ? "片段已锁定" : "播放头不在可拆分区间", onSelect: close(() => { if (split) void onPatch([split], "在播放头处拆分"); }) },
                    { id: "copy", label: "复制", disabled: locked, hint: locked ? "片段已锁定" : undefined, onSelect: close(() => onCommand?.("timeline.copy")) },
                    ...(canLinkMembers ? [{ id: "link", label: "链接片段", icon: <Link2 size={14} />, disabled: locked, hint: locked ? "片段已锁定" : undefined,
                      onSelect: close(() => void onPatch([{ op: "set_clip_link", clip_ids: linkMembers.map(item => item.clip_id) }], "链接片段")) }] : []),
                    ...(unlinkRepresentatives.length ? [{ id: "unlink", label: "取消片段链接", icon: <Link2Off size={14} />, disabled: locked, hint: locked ? "片段已锁定" : undefined,
                      onSelect: close(() => void onPatch(unlinkRepresentatives.map(item => ({ op: "clear_clip_link" as const, clip_id: item.clip_id })), "取消片段链接")) }] : []),
                    { id: "lock", label: clipItselfLocked ? "解锁片段" : "锁定片段", onSelect: close(() => void onPatch([{ op: "set_clip_locked", clip_id: clip.clip_id, locked: !clipItselfLocked }], clipItselfLocked ? "解锁片段" : "锁定片段")) },
                    { id: "speed", label: "速度", checked: speedModeKey === pickedKey, disabled: !speedable || speedLocked, hint: !speedable ? "只有具有确定源区间的视频/音频片段可以变速" : speedLocked ? "片段或所在轨道已锁定" : undefined,
                      onSelect: close(() => setSpeedModeKey(current => current === pickedKey ? null : pickedKey)) },
                    ...(visualFactItems.length || moveFactItem ? [{ id: "source-transition-separator", separator: true as const }, ...visualFactItems, ...(moveFactItem ? [moveFactItem] : [])] : []),
                    { id: "sep1", separator: true as const },
                    { id: "del", label: magneticDelete ? "删除并闭合主轨" : "删除片段", danger: true, disabled: locked || magneticDelete?.operations.length === 0, hint: locked ? "片段已锁定" : magneticDelete?.reason, onSelect: close(() => void onPatch(magneticDelete?.operations ?? [{ op: "remove_clip", clip_id: clip.clip_id }], magneticDelete ? "主轨磁吸删除" : "删除片段")) },
                    { id: "ripple-delete", label: "波纹删除", disabled: locked || !ripple.operations.length, hint: locked ? "片段已锁定" : "reason" in ripple ? ripple.reason : undefined, onSelect: close(() => void onPatch(ripple.operations, "波纹删除")) },
                    { id: "magnetic-move", label: "主轨插入到播放头", disabled: !magneticMove.operations.length, hint: "reason" in magneticMove ? magneticMove.reason : undefined, onSelect: close(() => void onPatch(magneticMove.operations, "主轨插入到播放头")) },
                    { id: "sep2", separator: true as const },
                    { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  ];
                }
                if (target.kind === "caption") {
                  return [
                    { id: "del", label: "删除字幕", danger: true, onSelect: close(() => void onPatch([{ op: "remove_caption", caption_id: target.captionId as never }], "删除字幕")) },
                    { id: "sep", separator: true as const },
                    { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  ];
                }
                if (target.kind === "transition") {
                  return [
                    { id: "del", label: "删除转场", danger: true, onSelect: close(() => void onPatch([{ op: "remove_transition", transition_id: target.transitionId as never }], "删除转场")) },
                  ];
                }
                if (target.kind === "active-transition") {
                  const transition = activeTransitions.find(item => item.transition_id === target.transitionId);
                  if (!transition) return [];
                  const operations = clearActiveTransitionOperations(transition);
                  const blockedHint = transition.kind === "dip-white"
                    ? "白闪依赖 Core 的页面帧系统角色，目前只显示、不编辑"
                    : transition.kind === "crossfade"
                      ? "音频交叉淡化目前只读"
                      : undefined;
                  return operations.length
                    ? [{ id: "clear-active-transition", label: "清除片段转场事实", danger: true, onSelect: close(() => void onPatch(operations, "清除片段转场事实")) }]
                    : [{ id: "active-transition-readonly", label: "此转场当前只读", disabled: true, hint: blockedHint }];
                }
                const closeGap = closeGapAt(document, target.trackId, contextMenu.timeUs);
                const compact = document ? planCompactMainTrack(document, true) : { operations: [] };
                const waveformRatios = [
                  { value: 1, label: "100%" },
                  { value: 0.6, label: "60%" },
                  { value: 0.4, label: "40%" },
                  { value: 0.3, label: "30%" },
                ] as const;
                return [
                  { id: "close-gap", label: "关闭空隙", disabled: !closeGap.length, hint: closeGap.length ? undefined : "此处没有可关闭的空隙，或后续片段无法安全移动", onSelect: close(() => void onPatch(closeGap, "关闭空隙")) },
                  { id: "compact-main", label: "关闭主轨全部空隙", disabled: !compact.operations.length, hint: "reason" in compact ? compact.reason : undefined, onSelect: close(() => void onPatch(compact.operations, "关闭主轨全部空隙")) },
                  { id: "paste", label: "粘贴到播放头", onSelect: close(() => onCommand?.("timeline.paste")) },
                  { id: "sep1", separator: true as const },
                  { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  { id: "clear", label: "取消选择", onSelect: close(() => setSelection(null)) },
                  { id: "sep-timeline-tools", separator: true as const },
                  {
                    id: "add-track",
                    label: "添加轨道",
                    submenu: [
                      { id: "add-video-track", label: "视频轨道", onSelect: close(() => addTrack("video")) },
                      { id: "add-text-track", label: "文本轨道", onSelect: close(() => addTrack("text")) },
                    ],
                  },
                  {
                    id: "fit-content",
                    label: "缩放到全部素材",
                    shortcut: "Shift+Z",
                    onSelect: close(fitToContent),
                  },
                  {
                    id: "timeline-display-settings",
                    label: "显示设置",
                    submenu: [
                      { id: "track-height-label", label: `默认轨道高度 · ${prefs.trackHeight}px`, disabled: true },
                      {
                        id: "track-height-down",
                        label: "降低 4px",
                        disabled: prefs.trackHeight <= 40,
                        onSelect: close(() => updateTimelinePrefs(current => ({ ...current, trackHeight: Math.max(40, current.trackHeight - 4) }))),
                      },
                      {
                        id: "track-height-up",
                        label: "增加 4px",
                        disabled: prefs.trackHeight >= 128,
                        onSelect: close(() => updateTimelinePrefs(current => ({ ...current, trackHeight: Math.min(128, current.trackHeight + 4) }))),
                      },
                      {
                        id: "track-height-reset",
                        label: "恢复默认高度 · 56px",
                        checked: prefs.trackHeight === 56,
                        onSelect: close(() => updateTimelinePrefs(current => ({ ...current, trackHeight: 56 }))),
                      },
                      { id: "display-separator", separator: true as const },
                      ...waveformRatios.map(({ value, label }) => ({
                        id: `waveform-${label}`,
                        label: `波形占比 ${label}`,
                        checked: prefs.waveformRatio === value,
                        onSelect: close(() => updateTimelinePrefs(current => ({ ...current, waveformRatio: value }))),
                      })),
                    ],
                  },
                ];
              })()}
            />
          )}
        </div>
        {/* B2: 添加转场浮层——点击两片段边界后出现。
            与共享 Dialog 同骨架：标题区 / 内容区 / 关闭钮，补齐 aria-modal、
            初始焦点、Escape 与焦点返回；点击背幕关闭的既有语义保留。 */}
        {addTransitionAnchor && (
          <div
            className="modal-backdrop add-transition-popover"
            onClick={() => setAddTransitionAnchor(null)}
          >
            <section
              className="modal add-transition-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-transition-title"
              tabIndex={-1}
              ref={(element) => {
                if (!element) return;
                const active = window.document.activeElement;
                if (active !== element && !element.contains(active)) element.focus();
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAddTransitionAnchor(null);
                }
              }}
            >
              <div className="modal-heading">
                <div><h2 id="add-transition-title">在此处添加转场</h2></div>
                <button type="button" className="icon-btn" aria-label="关闭添加转场" title="关闭 · Esc" onClick={() => setAddTransitionAnchor(null)}>
                  <X size={15} />
                </button>
              </div>
              <div className="modal-body">
                <div className="add-transition-kinds">
                  {TRANSITION_KINDS.map((kind) => (
                    <button
                      key={kind}
                      className="add-transition-kind"
                      onClick={() => {
                        void onPatch(
                          [{ op: "add_transition", after_clip_id: addTransitionAnchor as never, kind, duration_us: 500_000 }],
                          `添加转场 ${kind}`,
                        );
                        setAddTransitionAnchor(null);
                      }}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
                <p className="modal-caption">默认 0.5s，添加后可在属性面板调整时长；仅权威预览渲染转场效果。</p>
              </div>
            </section>
          </div>
        )}
        </div>
        {/* 固定标尺条带：.timeline-body 直属（滚动区外，Excel 冻结表头式，零抖动）；
            绝对定位覆盖滚动视口顶部 rulerHeight 像素——主画布自带的标尺带正好被
            盖住，纵向滚动时轨道从固定标尺下穿过。 */}
        <canvas
          ref={rulerCanvasRef}
          className="timeline-ruler-pin"
          aria-label="时间线标尺"
          tabIndex={-1}
          onPointerMove={handleRulerPinMove}
          onPointerDown={handleRulerPinDown}
          onPointerUp={event => finishRulerGesture(event, true)}
          onPointerCancel={event => finishRulerGesture(event, false)}
          onLostPointerCapture={event => finishRulerGesture(event, false)}
          onPointerLeave={() => { if (rulerPointerId.current === null) setRulerHoverUs(null); }}
          onDoubleClick={handleRulerPinDoubleClick}
        />
        <div className="timeline-ruler-tick-layer" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={`${tick.x}:${tick.label}`}
              className={`absolute top-1 origin-left select-none border-l tabular-nums ${
                tick.major ? "h-[11px] pl-[3px] text-[10px] leading-[11px]" : "h-[5px]"
              }`}
              style={{
                left: trackHeadWidth + tick.x,
                borderColor: tick.major
                  ? "color-mix(in srgb, var(--text-muted) 65%, transparent)"
                  : "var(--border-strong)",
                color: tick.major ? "color-mix(in srgb, var(--text-muted) 82%, transparent)" : undefined,
                fontFamily: '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", "Heiti SC", sans-serif',
                letterSpacing: "-0.096px",
              }}
            >
              {tick.major ? tick.label : null}
            </span>
          ))}
        </div>
        {rulerGuideX !== null && rulerGuideX >= trackHeadWidth + view.headerWidth && rulerGuideX < trackHeadWidth + canvasSize.width && (
          <span className="timeline-ruler-guide" style={{ top: view.rulerHeight, transform: `translateX(${rulerGuideX}px)` }} aria-hidden="true" />
        )}
        {/* 播放头覆盖层（A06）：与固定标尺同坐标系（timeline-body 原点 +
            132px 轨头 + 51px 封面条偏移），预览每帧直写 store——播放期间零主画布重绘。 */}
        {/* 标记行：浮在轨道区顶部，不占布局高度（OpenFilm 同款做法），
            因此增删标记不会让轨道跳动。只在有标记时渲染。 */}
        <MarkerLane ref={markerLaneRef}
          projectId={document?.project_id ?? ""}
          view={{ ...view, headerWidth: trackHeadWidth + view.headerWidth }}
          totalUs={totalUs}
          snapFrameUs={timeUs => snapUsToFrame(timeUs, fpsNum, fpsDen)}
          playheadUs={activePlayheadStore.get()}
          onMarkersChange={setMarkers}
          onSeek={timeUs => { onSeek?.(timeUs); onSeekCommit?.(timeUs); }}
          snapUs={valueUs => (prefs.snappingEnabled ? snapValue(valueUs, [...snapCandidates(clipRects, activePlayheadStore.get(), new Set()), ...markers.map(marker => marker.timeUs)], (SNAP_PX / view.pixelsPerSecond) * 1_000_000) : valueUs)}
          onGuide={guide => setMarkerGuide(guide)}
        />
        {/* 时间区间选取（Shift + 标尺拖动）：只做视觉，不接操作。
            标尺段实心 + 贯穿全线的淡填充 + 两端把手，Shift 已由标尺拖动处理。 */}
        {timeRange && (() => {
          const rangeView = { ...view, headerWidth: trackHeadWidth + view.headerWidth };
          const x1 = timeToX(timeRange.startUs, rangeView);
          const x2 = timeToX(timeRange.endUs, rangeView);
          const left = Math.min(x1, x2);
          const width = Math.abs(x2 - x1);
          return (
            <>
              <div className="timeline-range-band" style={{ transform: `translateX(${left}px)`, width: `${width}px` }}>
                <span className="timeline-range-ruler" />
                {(["startUs", "endUs"] as const).map(edge => {
                  const start = edge === "startUs";
                  return <button key={edge} type="button" role="slider"
                    className={`timeline-range-edge ${start ? "start" : "end"}`}
                    aria-label={start ? "时间区间入点" : "时间区间出点"}
                    aria-valuemin={(start ? 0 : timeRange.startUs + MIN_RANGE_US) / 1_000_000}
                    aria-valuemax={(start ? timeRange.endUs - MIN_RANGE_US : totalUs) / 1_000_000}
                    aria-valuenow={timeRange[edge] / 1_000_000}
                    onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
                    onPointerMove={event => {
                      const rect = rulerCanvasRef.current?.getBoundingClientRect();
                      if (!rect || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    moveRangeEdge(edge, rulerSeekTime(xToTime(event.clientX - rect.left - trackHeadWidth, view)));
                    }}
                    onKeyDown={event => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      event.stopPropagation();
                      moveRangeEdge(edge, timeRange[edge] + (event.key === "ArrowLeft" ? -frameUs : frameUs));
                    }} />;
                })}
                <span className="timeline-range-label">{formatRange(timeRange)}</span>
              </div>
              <button
                type="button"
                className="timeline-range-clear"
                aria-label="清除时间区间"
                title="清除时间区间"
                onClick={() => setTimeRange(null)}
              >×</button>
            </>
          );
        })()}
        {markerGuide && (
          <span
            className="timeline-marker-guide"
            style={{ transform: `translateX(${timeToX(markerGuide.timeUs, { ...view, headerWidth: trackHeadWidth + view.headerWidth })}px)`, color: markerGuide.color, opacity: markerGuide.held ? 1 : .55 }}
            aria-hidden="true"
          />
        )}
        <TimelinePlayheadLayer
          store={activePlayheadStore}
          view={{ ...view, headerWidth: trackHeadWidth + view.headerWidth }}
          totalUs={totalUs}
          contentHeight={contentHeight}
          scrubbing={scrubbing}
        />
        {/* 吸附提示线（2026-11-10，对齐 OpenFilm 的吸附引导）：拖动片段被吸到
            某条边/播放头/网格时，在那个时间点画一条贯穿轨道区的竖向虚线，
            让"为什么停在这里"可见。未吸附时不渲染。
            用独立 DOM 层而非画布绘制：不必给 drawTimeline 增加位置参数
            （它已有 20+ 个），也避免每次拖动都触发整画布重绘。 */}

      </div>
      {/* 右侧音频电平表列（参照 METERS_W = 44）：只在有数据源时渲染，
          避免测试与独立使用场景出现一根空的白条。 */}
      {meterLevels ? <AudioMeters levels={meterLevels} playing={Boolean(playing)} /> : null}
      </div>
    </section>
  );
}
