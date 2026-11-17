import { editorPerf } from "../preview/perf-metrics.js";
import { ToolButton } from "../../ui/of/ToolButton.js";
import { ModePicker, type TimelineMode } from "../../ui/of/ModePicker.js";
import { ContextMenu } from "../../ui/of/ContextMenu.js";
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Magnet,
  Minus,
  MoreHorizontal,
  ImagePlus,
  Plus,
  Redo2,
  ScanSearch,
  Scissors,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  TimelineCaption,
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
  TimelineTrack,
  TimelineTransition,
} from "@aivideo/contracts";
import type { EditorCommand } from "../editorCommands.js";
import {
  DEFAULT_RUNTIME_PREFS,
  DEFAULT_VIEW_STATE,
  TIMELINE_PREFS_STORAGE_KEY,
  ZOOM_MAX_PPS,
  ZOOM_MIN_PPS,
  type AssetMediaEntry,
  type CaptionRenderRect,
  type ClipRenderRect,
  type TickMark,
  type TimelineHover,
  type TimelineInteraction,
  type MoveInteraction,
  type TimelineRuntimePrefs,
  type TimelineSelection,
  type TimelineViewState,
  type TransitionRenderRect,
  type TrimEdge,
} from "./types.js";
import { TimelinePlayheadLayer } from "./TimelinePlayheadLayer.js";
import { MarkerLane } from "./MarkerLane.js";
import { formatRange, normalizeRange, rangeDuration, MIN_RANGE_US, type TimeRange } from "./time-range.js";
import { createPlayheadStore, type PlayheadStore } from "./playhead-store.js";
import { ThumbnailLoader, defaultFilmstripSourceFactory } from "./thumbnail-loader.js";
import { OVERSCAN_ROWS, filterVisibleRects } from "./viewport-index.js";
import type { WaveformCache } from "./waveform-cache.js";

/** B2 转场种类（与 core TRANSITION_KINDS 对齐）。 */
const TRANSITION_KINDS = ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "zoomin"] as const;

import {
  MIN_CLIP_US,
  SCROLLBAR_HEIGHT_PX,
  SNAP_PX,
  TRIM_HANDLE_PX,
  CLIP_HEADER_H,
  clampGroupDelta,
  clampMoveStart,
  clampScrollX,
  clipAudioBand,
  clipDuration,
  clipsInRect,
  computeClipRects,
  computeTrackRows,
  computeTransitionRects,
  TRACK_VIEW_PAD,
  dragEdgeAutoScrollStep,
  fitZoomPps,
  ghostPosition,
  gridSnapCandidates,
  hitTestClips,
  hitTestTransitionGap,
  hitTestTransitions,
  hitTestTrimHandle,
  hitTestVolumeLine,
  marqueeRect,
  resolveGroupMove,
  resolveMoveTarget,
  scrollBounds,
  snapCandidates,
  snapValue,
  timeToX,
  trimHitPx,
  trackRowAt,
  trackRowOf,
  trackRowsTotalHeight,
  volumeToY,
  xToTime,
  yToVolume,
  zoomAtAnchor,
  type TrackRowLayout,
} from "./geometry.js";

/** Keyframe lane order for the expanded panel (matches contracts' four properties). */
const KEYFRAME_ORDER = ["position", "scale", "rotate", "opacity"] as const;
const KEYFRAME_LANE_LABELS: Record<string, string> = { position: "位", scale: "缩", rotate: "旋", opacity: "透" };
const KEYFRAME_LANE_HEIGHT = 14;

// ── Helpers ──────────────────────────────────────────────────────────────────

const formatTime = (us: number) => {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  return `${seconds.toFixed(2)}s`;
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

const zoomPctToPps = (zoom: number) =>
  ZOOM_MIN_PPS * Math.pow(ZOOM_MAX_PPS / ZOOM_MIN_PPS, zoom / 100);
const ppsToZoomPct = (pps: number) =>
  (100 * Math.log(pps / ZOOM_MIN_PPS)) / Math.log(ZOOM_MAX_PPS / ZOOM_MIN_PPS);

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
    <span aria-expanded={expanded} style={{ display: "inline-flex" }}>
      <ToolButton label={label} disabled={disabled} active={Boolean(expanded)} onClick={onClick}>
        {children}
      </ToolButton>
    </span>
  );
}

// ── Thumbnail frame computation（剪映式：抽帧铺满片段） ──────────────────────

/** 帧数档位：缩放时量化到最近档，小幅缩放直接复用已抽帧（不重抽）。
 *  上限 64（配合"只抽可视区格子"的按需请求，seek 负载仍有界）——
 *  长片段放大后格宽能继续变小，帧与时间对位随之更准。
 *  档位对齐剪映密度：格宽基准 44px + 3 步进细档——同宽下格数与剪映一致
 *  （11.8s 片段 @~94pps：剪映 22 格，旧 56px/粗档只有 18 格），格间距越小
 *  硬切场景的采样错位越不易被察觉。 */
const FRAME_COUNT_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 24, 29, 35, 42, 50, 58, 64];
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

/** Compute (mediaUrl, seek time) pairs for a clip's filmstrip frames.
 *  所见即所得：格位由片段的【时间线】时长均匀切分（格宽≈44px 量化档位），
 *  每帧 seek 该格中心的源时刻（含变速/倒放映射：源时刻 = source_start +
 *  时间线偏移 × speed，倒放从 source_end 反向）；绘制端按 fromUs/toUs 精确
 *  落位——片段放得越大、格越小，帧与时间的对位误差越小。
 *  （导出仅供单元测试断言时间对位。） */
export function computeFrameRequests(
  mediaUrl: string | null,
  clip: TimelineClip,
  pps: number,
): Array<{ url: string; timeSec: number; fromUs: number; toUs: number }> {
  if (!mediaUrl) return [];
  const isVisual = clip.asset_kind === "video" || clip.asset_kind === "image";
  if (!isVisual) return [];
  const timelineDurUs = clip.timeline_end_us - clip.timeline_start_us;
  if (timelineDurUs <= 0) return [];
  // T8 修正：格宽与绘制侧同步 80px（原 44——两侧不一致时缓存键对不上，缩略图空白）
  const count = quantizeFrameCount(Math.round(((timelineDurUs / 1_000_000) * pps) / 80));
  const sourceStartUs = clip.source_start_us ?? 0;
  const sourceEndUs = clip.source_end_us ?? 0;
  const speed = (clip.speed_milli ?? 1000) / 1000;
  const frames: Array<{ url: string; timeSec: number; fromUs: number; toUs: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const fromUs = clip.timeline_start_us + (i * timelineDurUs) / count;
    const toUs = clip.timeline_start_us + ((i + 1) * timelineDurUs) / count;
    const centerUs = (fromUs + toUs) / 2;
    const offsetUs = centerUs - clip.timeline_start_us;
    const srcUs = clip.reverse_playback
      ? sourceEndUs - offsetUs * speed
      : sourceStartUs + offsetUs * speed;
    frames.push({ url: mediaUrl, timeSec: Math.max(0, srcUs) / 1_000_000, fromUs, toUs });
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
function computeTicks(
  totalUs: number,
  pps: number,
  headerWidth: number,
  frameRate: number,
  scrollX: number,
  viewportWidth = 800,
): TickMark[] {
  /* T6 参照 timeline-layout.ts:238-306：标签阶梯（≥96px）与刻度阶梯（≥12px）独立推导，
     刻度步整除标签步（标签必须落在刻度上）；帧级步取「秒帧数的因子」（每一秒的刻度
     落点一致）。秒级以上步长 1/2/3/5×10ⁿ（SECOND_STEPS）。标尺画过素材终点——
     参照的标尺不随素材截断（Timeline.tsx:3565-3581 绘制按可视范围）。 */
  const perSec = Math.max(1, Math.round(frameRate));
  const frameSecs = 1 / perSec;
  const pxPerFrame = frameSecs * pps;
  const SECOND_STEPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  // 秒内帧因子（整除秒帧数的），从 2 开始做标签档、1 起做刻度档。
  const frameFactors = (from: number): number[] => {
    const list: number[] = [];
    for (let n = from; n < perSec; n += 1) if (perSec % n === 0) list.push(n);
    return list;
  };
  const labelLadder = [...frameFactors(2).map(n => n * frameSecs), ...SECOND_STEPS.map(s => s * frameSecs)];
  const tickLadder = [...frameFactors(1).map(n => n * frameSecs), ...SECOND_STEPS.map(s => s * frameSecs)];
  const pickLabel = labelLadder.find(secs => secs * pps >= 96) ?? labelLadder[labelLadder.length - 1];
  const wantedTick = tickLadder.find(secs => secs * pps >= 12) ?? tickLadder[tickLadder.length - 1];
  // 刻度步整除标签步：不整除则向上找更粗的；找不到就只画标签档。
  const pickTick = Math.abs(pickLabel % wantedTick) < 1e-9
    ? wantedTick
    : tickLadder.find(secs => secs >= wantedTick && Math.abs(pickLabel % secs) < 1e-9) ?? pickLabel;
  const labelFrame = Math.abs(pickLabel / frameSecs);
  const frameLevel = pickLabel < 1; // 帧级标签（2f/4f…）只在 <1s 档出现
  const intervalUs = pickTick * 1_000_000;
  const majorUs = pickLabel * 1_000_000;
  const pxToUs = 1_000_000 / pps;
  const viewStartUs = Math.max(0, (scrollX - headerWidth) * pxToUs - majorUs);
  const viewEndUs = (scrollX - headerWidth + viewportWidth) * pxToUs + majorUs;
  const firstMajor = Math.floor(viewStartUs / majorUs);
  const lastMajor = Math.floor(viewEndUs / majorUs);
  const ticks: TickMark[] = [];
  for (let m = firstMajor; m <= lastMajor; m += 1) {
    const majorUsValue = m * majorUs;
    if (majorUsValue < 0) continue;
    const majorX = headerWidth + (majorUsValue / 1_000_000) * pps - scrollX;
    const majorLabel = frameLevel
      ? m === 0
        ? formatRulerTime(0)
        : `${Math.round(m * labelFrame)}f`
      : formatRulerTime(majorUsValue);
    ticks.push({ x: majorX, label: majorLabel, major: true });
    for (let s = 1; s * intervalUs < majorUs - 1; s += 1) {
      const minorUsValue = majorUsValue + s * intervalUs;
      const minorX = headerWidth + (minorUsValue / 1_000_000) * pps - scrollX;
      ticks.push({ x: minorX, label: "", major: false });
    }
  }
  return ticks;
}

// ── Audio waveform data ──────────────────────────────────────────────────────

// B14：波形峰值来自 timeline/waveform-cache.ts（Core 派生缓存金字塔产物，
// 按 clip 源区间/速度/倒放取窗）。Renderer 不再保留整媒体 decodeAudioData
// 链路（旧 getAudioDecodeContext/extractPeaks/decodeAudioPeaks 已移除）。

/** Amplitude gain applied at draw time so quiet audio stays visible. */
const WAVEFORM_GAIN = 1.4;
/** 绘制路径每 clip 峰值数上限。须 ≥ 片段像素宽——旧值 200 会把宽片段
 *  拉成大块台阶（剪映是近似 1 峰/像素的密柱）。 */
const WAVEFORM_PEAK_COUNT_MAX = 4096;

// ── 剪映式片段外观（1:1 复刻参考） ────────────────────────────────────────────
/** 片段圆角半径（px）。 */
// 参照片段圆角 4px（openfilm Timeline.tsx:3247 rounded-[4px]）；原 3px。
const CLIP_RADIUS = 4;
/** 片段在轨道行内的上下留白（px）——相邻轨道片段之间形成剪映式缝隙。 */
const CLIP_ROW_INSET = 2;
/** 片段配色（2026-11-11 对齐 OpenFilm 的 KIND_COLOR 令牌，globals.css:87-94/163-170）：
 *  按素材类别取色（video/image/page/text/sticker/filter/effect/audio），浅深双主题各一套。
 *  画布不吃 CSS 选择器——cssColor() 运行期读 [data-theme] 命中的变量值。
 *  选中不变色——只叠加外扩描边。 */
const KIND_COLOR_VARS: Record<string, { body: string; header: string; band: string; wave: string }> = {
  video:   { body: "--clip-video",  header: "--clip-video",  band: "--clip-video",  wave: "--clip-video" },
  image:   { body: "--clip-image",  header: "--clip-image",  band: "--clip-image",  wave: "--clip-image" },
  page:    { body: "--clip-page",   header: "--clip-page",   band: "--clip-page",   wave: "--clip-page" },
  text:    { body: "--clip-text",   header: "--clip-text",   band: "--clip-text",   wave: "--clip-text" },
  sticker: { body: "--clip-sticker", header: "--clip-sticker", band: "--clip-sticker", wave: "--clip-sticker" },
  filter:  { body: "--clip-filter", header: "--clip-filter", band: "--clip-filter", wave: "--clip-filter" },
  effect:  { body: "--clip-effect", header: "--clip-effect", band: "--clip-effect", wave: "--clip-effect" },
  audio:   { body: "--clip-audio",  header: "--clip-audio",  band: "--clip-audio",  wave: "--clip-audio" },
};

// ── Runtime prefs (magnetic snapping) ────────────────────────────────────────

function loadRuntimePrefs(): TimelineRuntimePrefs {
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
          typeof candidate.waveformRatio === "number" && [1, 0.6, 0.4].includes(candidate.waveformRatio)
            ? candidate.waveformRatio
            : DEFAULT_RUNTIME_PREFS.waveformRatio;        return {
          snappingEnabled: candidate.snappingEnabled === true,
          trackHeight,
          waveformRatio,
        };
      }
    }
  } catch {
    // Corrupted prefs — fall back to defaults.
  }
  return DEFAULT_RUNTIME_PREFS;
}

// ── Canvas drawing ───────────────────────────────────────────────────────────

/** Small dark tooltip shown above a drag ghost (timecode + duration/delta). */
function drawDragTooltip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lines: string[],
  viewportWidth: number,
) {
  ctx.save();
  ctx.font = "10px monospace";
  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const boxWidth = textWidth + 12;
  const boxHeight = lines.length * 13 + 7;
  const boxX = Math.max(2, Math.min(viewportWidth - boxWidth - 2, x - boxWidth / 2));
  const boxY = Math.max(2, y - boxHeight);
  ctx.fillStyle = "rgba(10, 14, 20, 0.85)";
  ctx.strokeStyle = "#5a6a72";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, index) => {
    ctx.fillStyle = index === 0 ? "#ffd76e" : "#d7e2e8";
    ctx.fillText(line, boxX + boxWidth / 2, boxY + 9 + index * 13);
  });
  ctx.restore();
}

// ── 标尺外观常量（drawTimeline 与固定标尺覆盖层 drawRulerStrip 共享，
//    保证两条绘制路径像素级一致）──────────────────────────────────────────
/* 画布颜色改为从 CSS 变量读取（2026-11-10）：主题切换时画布也要跟随，
   否则浅色主题下时间线仍是一整块深色（实测截图确认）。
   取不到变量时回退到原深色常量，保证独立渲染（测试/离屏）不依赖样式表。 */
const cssColor = (name: string, fallback: string): string => {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};
const RULER_DEAD_BG = () => cssColor("--tl-dead-bg", "#161618"); // 素材终点外的死区底色
const RULER_BG_TOP = () => cssColor("--tl-ruler-top", "#1c1c1f"); // 标尺带渐变顶
const RULER_BG_BOTTOM = () => cssColor("--tl-ruler-bottom", "#17171a"); // 标尺带渐变底
const RULER_END_EDGE = () => cssColor("--tl-end-edge", "#3d4a5c"); // 素材终点竖标线（主题令牌）
const RULER_TICK_MAJOR = () => cssColor("--tl-tick-major", "#8a95a5");
const RULER_TICK_MINOR = () => cssColor("--tl-tick-minor", "#596372");
const RULER_LABEL_COLOR = () => cssColor("--tl-label", "#b9c4d1");
const RULER_LABEL_FONT = "10px sans-serif";
// 标尺刻度几何（2026-11-11，对齐 OpenFilm Timeline.tsx 的 tickMarks）：
//   小刻度自标尺上沿 9px 处往下垂到标尺底（OpenFilm top-[9px]）；
//   主刻度文字顶部对齐、距刻度线 4px（OpenFilm top-0 pl-1、leading-[14px]）。
const RULER_MINOR_TICK_TOP = 9;
const RULER_LABEL_PAD_X = 4;
const RULER_LABEL_TOP = 1;
const HOVER_CHIP_BG = () => cssColor("--tl-chip-bg", "rgba(9, 12, 24, 0.88)");
const HOVER_CHIP_EDGE = () => cssColor("--tl-chip-edge", "rgba(0, 193, 205, 0.45)");
const HOVER_CHIP_TEXT = "#d6e1ff";
// 播放头线/手柄已拆为独立 DOM 覆盖层（A06，TimelinePlayheadLayer），
// 外观常量与绘制函数不再在 Canvas 路径保留。

/** 标尺面（两条绘制路径共享的标尺带外观）：渐变底 + 悬停竖线/时间胶囊 +
 *  刻度 + 素材范围条 + 素材终点标线 + 终点外死区。
 *  bandX/width/height 为目标画布坐标系；xOffset 把刻度 x 映射到本画布；
 *  xAt 把时间映射到本画布 x；endX 为素材终点 x（自动收敛到 width 内）。 */
function drawRulerFace(
  ctx: CanvasRenderingContext2D,
  opts: {
    bandX: number;
    width: number;
    height: number;
    endX: number;
    xOffset: number;
    ticks: TickMark[];
    hoverUs: number | null | undefined;
    hoverText: string;
    contentRange: { fromUs: number; toUs: number } | null;
    xAt: (us: number) => number;
    /** 当前选中：用于在标尺上高亮所选片段对应区段。 */
    selection?: TimelineSelection;
    /** 片段像素矩形：取选中片段的时间范围铺在标尺带上。 */
    clipRects?: ClipRenderRect[];
  },
) {
  const { bandX, width, height, xOffset, ticks, hoverUs, hoverText, contentRange, xAt, selection, clipRects: faceClipRects } = opts;
  const endX = Math.max(bandX, Math.min(width, opts.endX));

  // ④修正：标尺面 = 纯平 var(--bg-panel)（参照 Timeline.tsx:273 TL.ruler——无渐变）。
  // 原「纵向微渐变」顶色偏亮，在工具栏 border-bottom 之下叠出用户指认的「加粗顶边」。
  // 死区同底色；素材终点竖标线保留（参照 endX 也有收尾线）。
  ctx.fillStyle = cssColor("--bg-panel", "#181818");
  ctx.fillRect(bandX, 0, Math.max(0, width - bandX), height);
  if (endX < width) {
    ctx.strokeStyle = RULER_END_EDGE();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(endX) + 0.5, 0);
    ctx.lineTo(Math.round(endX) + 0.5, height);
    ctx.stroke();
  }

  // 悬停竖线（带内部分；整高引导线由主画布另绘）。
  if (hoverUs !== null && hoverUs !== undefined) {
    const hx = xAt(hoverUs);
    if (hx >= bandX && hx <= endX) {
      ctx.strokeStyle = cssColor("--tl-tick-major", "#8a95a5");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
      // ⑥修正：hover 时间胶囊（参照标尺 hover 的可拖提示——黑底白字圆角小签，
      // 文本 hoverText 由调用方传入；胶囊跟随竖线、贴标尺顶部）。
      if (hoverText) {
        ctx.font = RULER_LABEL_FONT;
        const tw = ctx.measureText(hoverText).width + 10;
        const bubbleX = Math.min(Math.max(hx - tw / 2, bandX), endX - tw);
        ctx.fillStyle = "rgba(0, 0, 0, 0.82)";
        ctx.beginPath();
        ctx.roundRect(bubbleX, 1, tw, 15, 4);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
        ctx.textBaseline = "middle";
        ctx.fillText(hoverText, bubbleX + 5, 9);
        ctx.textBaseline = "top";
      }
    }
  }

  // 刻度：主刻度贯通、小刻度自上沿下垂短线；一律不越过素材终点。
  // 2026-11-11 对齐 OpenFilm 的刻度画法（Timeline.tsx tickMarks）：
  //   主刻度 span 用 border-l 贯通整条标尺，标签顶部对齐（top-0 pl-1）；
  //   小刻度 span 从 top-[9px] 起，即从标尺上沿往下挂一小段。
  // 我们原来是「小刻度从中段起」+「标签贴底基线」，两处都与参照相反：
  // 贴底的文字被顶部内容条、贯通主刻度、标尺下边框围成一个方框，
  // 看起来像输入框而不是刻度文字——这是录屏对比里最直观的一处差异。
  ctx.textBaseline = "top";
  ctx.font = RULER_LABEL_FONT;
  /* 刻度线宽一律 1px（参照 Timeline.tsx:3565 的 tick 是 `border-l`，没有加粗）：
     主刻度与小刻度的区别在**长度**（主贯通、小从上沿下垂 11px）和**颜色**
     （主 --border、小 --border-strong），不在线宽。
     我们原来给主刻度更大的对比色（#8a95a5 vs #596372），视觉上像「加粗」了。 */
  for (const tick of ticks) {
    const tickX = Math.round(tick.x + xOffset) + 0.5;
    if (tickX < bandX - 1 || tickX > endX + 1) continue;
    ctx.strokeStyle = tick.major
      ? cssColor("--border", "rgba(16, 16, 24, 0.085)")
      : cssColor("--border-strong", "rgba(16, 16, 24, 0.16)");
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 小刻度自上沿下垂；主刻度贯通。
    ctx.moveTo(tickX, tick.major ? 0 : RULER_MINOR_TICK_TOP);
    ctx.lineTo(tickX, height);
    ctx.stroke();
  }
  /* 标尺下沿那条细线（参照：标尺容器 border-b，Timeline.tsx:4285 的 border-b border-[var(--border)]）。
     它把「刻度区」与「轨道区」分开——我们此前没有，于是刻度直接压到轨道上。 */
  ctx.strokeStyle = cssColor("--border", "rgba(16, 16, 24, 0.085)");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bandX, height - 0.5);
  ctx.lineTo(Math.min(endX, bandX + width), height - 0.5);
  ctx.stroke();
  // 主刻度时间标签：顶部对齐、刻度右侧留 4px（OpenFilm pl-1）。
  ctx.fillStyle = RULER_LABEL_COLOR();
  for (const tick of ticks) {
    if (!tick.major) continue;
    const tickX = Math.round(tick.x + xOffset) + 0.5;
    if (tickX < bandX - 1 || tickX > endX + 1) continue;
    ctx.fillText(tick.label, tickX + RULER_LABEL_PAD_X, RULER_LABEL_TOP);
  }

  // 选中片段在标尺上的对应区段：实心强调色块（2026-11-10，对齐 OpenFilm）。
  // 原来标尺只传达"素材有多长"（下方内容范围条），不表达"我选中了哪段"——
  // 拖片段时视线要来回于画布与标尺之间。这里把选中片段的时间范围直接铺在
  // 标尺带上，让"选中 → 它占标尺上哪一段"一眼可读。
  // 画在内容范围条之前：内容条是全局基准，选中块是叠加信息。
  if (faceClipRects && faceClipRects.length > 0) {
    const selected = faceClipRects.filter((rect: ClipRenderRect) => selection?.kind === "clip" && selection.id === rect.clip.clip_id);
    for (const rect of selected) {
      const selLeft = Math.max(bandX, rect.x + xOffset);
      const selRight = Math.min(endX, rect.x + xOffset + rect.width);
      if (selRight - selLeft > 1) {
        ctx.fillStyle = "rgba(0, 193, 205, 0.28)";
        ctx.fillRect(selLeft, 0, selRight - selLeft, height);
        // 上下两条描边把区段与刻度线区分开
        ctx.fillStyle = "rgba(0, 193, 205, 0.75)";
        ctx.fillRect(selLeft, 0, selRight - selLeft, 1.5);
        ctx.fillRect(selLeft, height - 1.5, selRight - selLeft, 1.5);
      }
    }
  }

  // P230-③（2026-11-17）：内容范围条已删除——参照标尺无此元素
  // （Timeline.tsx:4284-4316：标尺 = 平底 + tickMarks + border-b，别无长条）。
  // 它是用户指认的「刻度上方粗线」：素材最左到最右的一条 3px 渐变条常驻在
  // 刻度上方，读起来像一条加粗的顶边。素材范围信息已由泳道带与死区表达。

  // 悬停时间胶囊（圆角底 + 描边，保证任何刻度上都可读）。
  if (hoverUs !== null && hoverUs !== undefined) {
    const hx = xAt(hoverUs);
    if (hx >= bandX && hx <= endX) {
      ctx.font = "10px Consolas, monospace";
      const chipW = ctx.measureText(hoverText).width + 10;
      const chipH = Math.min(14, Math.max(10, height - 2));
      const cx = hx > width - chipW - 10 ? hx - chipW - 4 : hx + 4;
      const cy = Math.max(1, height - chipH - 1);
      ctx.fillStyle = HOVER_CHIP_BG();
      ctx.strokeStyle = HOVER_CHIP_EDGE();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(cx, cy, chipW, chipH, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = HOVER_CHIP_TEXT;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(hoverText, cx + 5, cy + chipH / 2 + 0.5);
      ctx.textAlign = "left";
    }
  }
}

/** Bottom scrollbar strip: track + thumb proportional to visible content. */
function drawScrollbar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  totalUs: number,
) {
  const { maxScrollX } = scrollBounds(view, totalUs, width);
  if (maxScrollX <= 0) return;
  const trackWidth = width - view.headerWidth;
  const visibleRatio = Math.min(1, trackWidth / (trackWidth + maxScrollX));
  const thumbWidth = Math.max(30, trackWidth * visibleRatio);
  const thumbX =
    view.headerWidth + (view.scrollX / maxScrollX) * (trackWidth - thumbWidth);
  const trackY = height - SCROLLBAR_HEIGHT_PX;
  ctx.fillStyle = cssColor("--tl-grid-line", "rgba(255, 255, 255, 0.05)");
  ctx.fillRect(view.headerWidth, trackY, trackWidth, SCROLLBAR_HEIGHT_PX - 1);
  ctx.fillStyle = cssColor("--tl-grid-line-strong", "rgba(255, 255, 255, 0.22)");
  ctx.beginPath();
  ctx.roundRect(thumbX, trackY, thumbWidth, SCROLLBAR_HEIGHT_PX - 1, 3);
  ctx.fill();
}

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  trackRows: TrackRowLayout[],
  clipRects: ClipRenderRect[],
  captionRects: CaptionRenderRect[],
  captions: TimelineCaption[],
  ticks: TickMark[],
  selection: TimelineSelection,
  interaction: TimelineInteraction | null,
  hover: TimelineHover,
  playheadUs: number,
  totalUs: number,
  lockedElements: string[],
  rulerHoverUs: number | null,
  clipNames: Map<string, string>,
  frameRate: number,
  pendingKeep: {
    clipId: TimelineClipId;
    trackId: string;
    startUs: number;
    displaced?: { clipId: TimelineClipId; trackId: string; startUs: number };
  } | null,
  thumbnailCache?: Map<string, HTMLCanvasElement>,
  waveformCache?: WaveformCache | null,
  waveformRatio?: number,
  /** 面板可视高度（画布可能高于面板——纵向滚动时滚动条仍钉在可视区底部）。 */
  viewportHeight?: number,
  /** B17：画布顶的内容 y（viewport 化画布在内容空间中覆盖
   *  [contentTopY, contentTopY + height)——内容坐标绘制照常，ctx 统一
   *  平移 -contentTopY；底部滚动条带除外（画布底部固定）。 */
  contentTopY?: number,
  /** B17：当前纵向滚动位置（滚动条带定位用）。 */
  contentScrollTop?: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const topY = contentTopY ?? 0;
  const scrollTopRaw = contentScrollTop ?? 0;
  // 内容坐标统一平移：内容 y → 画布 y = 内容 y - topY（矩阵一步到位，
  // 不用 ctx.translate——测试桩只实现常用 API 面）。
  ctx.setTransform(dpr, 0, 0, dpr, 0, -topY * dpr);
  ctx.clearRect(0, topY, width, height);

  // Background（没有轨道的地方；内容空间全画布）
  // 2026-11-10：改读主题变量，否则浅色主题下空白区仍是一整块深色。
  ctx.fillStyle = cssColor("--tl-canvas-bg", "#161618");
  ctx.fillRect(0, topY, width, height);

  // 素材终点（多条片段取最靠后的结束点）：标尺/行背景/网格一律到此为止，
  // 终点之外是死区——时间线不会超过素材长度。空时间线不设终点（整宽标尺）。
  const contentEndX = clipRects.length > 0 ? timeToX(totalUs, view) : width;

  // 标尺面：渐变底 + 刻度 + 素材范围条 + 终点标线/死区 + 悬停时间胶囊。
  drawRulerFace(ctx, {
    bandX: view.headerWidth,
    width,
    height: view.rulerHeight,
    endX: contentEndX,
    xOffset: 0,
    ticks,
    hoverUs: rulerHoverUs,
    hoverText: rulerHoverUs !== null && rulerHoverUs !== undefined ? formatTime(rulerHoverUs) : "",
    contentRange:
      clipRects.length > 0
        ? {
            fromUs: Math.min(...clipRects.map((r) => r.clip.timeline_start_us)),
            toUs: Math.max(...clipRects.map((r) => r.clip.timeline_end_us)),
          }
        : null,
    xAt: (us) => timeToX(us, view),
    selection,
    clipRects,
  });

  // 轨道带（2026-11-16 复刻 OpenFilm Lane 模型）：
  //   参照里每条轨道是「一条自己的带子」，铺满整个时间线宽度、靠 2px 的面板底色
  //   间隙彼此分开，带子本身是**半透明的行色**（--tl-row 3% alpha），被选中的
  //   轨道再深一档（--tl-lane-on）——没有分隔线，结构由间隙与色阶表达
  //   （openfilm Timeline.tsx:282-289 laneTone / :3048 行 marginTop GAP）。
  //   我们原来是两件事都不对：实色不透明带 + 1px 强分隔线，且都截断在素材终点，
  //   于是「轨道」读起来像表格行而不是时间线泳道。

  const laneTone = (row: (typeof trackRows)[number]): string => {
    // 被选中片段所在的轨道深一档：选中这件事既落在片段上，也落在它所在的泳道上
    // （OpenFilm laneTone 的 picked 分支，Timeline.tsx:286）。
    const picked =
      selection?.kind === "clip" &&
      clipRects.some((r) => r.clip.clip_id === selection.id && r.y >= row.y && r.y < row.y + row.height);
    if (picked) return cssColor("--tl-lane-on", "rgba(240, 240, 255, 0.085)");
    return row.track.kind === "audio"
      ? cssColor("--tl-row-audio", "rgba(240, 240, 255, 0.035)")
      : cssColor("--tl-row", "rgba(240, 240, 255, 0.035)");
  };
  // 带子铺满画布宽度（不是到素材终点）：泳道的长度感来自标尺与死区，不来自色带。
  for (const row of trackRows) {
    ctx.fillStyle = laneTone(row);
    ctx.fillRect(view.headerWidth, row.y, Math.max(0, width - view.headerWidth), row.height);
  }

  // Ruler hover guide (Round 5)：标尺带下方的整高淡引导线（时间胶囊在标尺面内）。
  if (rulerHoverUs !== null && rulerHoverUs !== undefined) {
    const hx = timeToX(rulerHoverUs, view);
    if (hx >= view.headerWidth && hx <= Math.min(width, contentEndX)) {
      ctx.strokeStyle = cssColor("--tl-snap", "#0098a3");
      ctx.lineWidth = 1;
      ctx.beginPath();
      // B17：画布 viewport 化——引导线画到画布覆盖的内容底（topY+height），
      // 不再用旧的全内容 height（viewport 化后那是视口+overscan 高）。
      ctx.moveTo(hx, view.rulerHeight);
      ctx.lineTo(hx, topY + height);
      ctx.stroke();
    }
  }

  // B17：可见区裁剪窗口（文档坐标）——画布只覆盖视口+overscan，clip/
  // caption 循环先过滤，draw 访问量随可见元素而非文档总量增长。命中/
  // 框选仍走全量 clipRects（不因不画丢文档元素——drawClipRects 变量名
  // 只指绘制输入，交互几何一律用未裁剪的 clipRects）。
  const viewport = height > 0
    ? { left: 0, right: width, top: topY, bottom: topY + height }
    : null;
  const drawClipRects = viewport
    ? filterVisibleRects(clipRects, viewport, OVERSCAN_ROWS * view.trackHeight)
    : [];
  const drawCaptionRects = viewport
    ? filterVisibleRects(captionRects, viewport, OVERSCAN_ROWS * view.trackHeight)
    : [];

  const selectedIds =
    selection?.kind === "clip"
      ? [selection.id]
      : selection?.kind === "clips"
        ? selection.ids
        : [];

  const hiddenTrackIds = new Set(
    trackRows.filter((row) => row.track.hidden).map((row) => row.track.id),
  );

  // Clips（拖动中的片段最后绘制在顶层、按鼠标自由跟随——剪映式）
  const movingId = interaction?.kind === "move" ? interaction.clipId : null;
  const drawClipRect = (sourceRect: ClipRenderRect) => {
    // 轨道行内上下留白：相邻轨道片段之间形成剪映式缝隙。
    const baseRect: ClipRenderRect = {
      ...sourceRect,
      y: sourceRect.y + CLIP_ROW_INSET,
      height: Math.max(4, sourceRect.height - CLIP_ROW_INSET * 2),
    };
    let rect = baseRect;
    const isMovingClip =
      movingId !== null && movingId === sourceRect.clip.clip_id && interaction?.kind === "move";
    // 拖拽提交态（防回弹）：补丁在途时片段（与被交换片段）保持渲染在目标位置。
    let keepOverride: { trackId: string; startUs: number } | null = null;
    if (pendingKeep && interaction === null) {
      if (pendingKeep.clipId === sourceRect.clip.clip_id) {
        keepOverride = { trackId: pendingKeep.trackId, startUs: pendingKeep.startUs };
      } else if (pendingKeep.displaced && pendingKeep.displaced.clipId === sourceRect.clip.clip_id) {
        keepOverride = {
          trackId: pendingKeep.displaced.trackId,
          startUs: pendingKeep.displaced.startUs,
        };
      }
    }
    if (keepOverride) {
      const keepRow = trackRowOf(trackRows, keepOverride.trackId);
      rect = {
        ...baseRect,
        x: timeToX(keepOverride.startUs, view),
        y: (keepRow ? keepRow.y : baseRect.y - CLIP_ROW_INSET) + CLIP_ROW_INSET,
      };
    }
    if (isMovingClip && interaction?.kind === "move") {
      const ghost = ghostPosition(
        // ghostPosition 需要同轨邻居算无重叠钳制——拖动中一律喂全量
        //（被拖片段可能被拖出可见区，邻居裁掉会导致 ghost 错位）。
        clipRects.map((item) => item.clip),
        sourceRect.clip,
        interaction.targetStartUs,
        interaction.targetTrackId ?? undefined,
      );
      // 剪映式跟手：水平严格按时间增量、垂直自由浮动跟随光标（钳制在轨道区内）；
      // 落点由 resolveMoveTarget 的预览剪影表达，松手按它吸附。
      const floatY = baseRect.y + (interaction.currentY - interaction.startY);
      const minY = view.rulerHeight + CLIP_ROW_INSET;
      const maxY = Math.max(minY, height - baseRect.height);
      rect = {
        ...baseRect,
        x: timeToX(ghost.startUs, view),
        y: Math.min(maxY, Math.max(minY, floatY)),
        width: Math.max(2, ((ghost.endUs - ghost.startUs) / 1_000_000) * view.pixelsPerSecond),
      };
    }
    const isSelected = selectedIds.includes(rect.clip.clip_id);
    const isLocked = lockedElements.includes(rect.clip.clip_id);
    const isHiddenTrack = hiddenTrackIds.has(rect.clip.track_id);
    // 隐藏轨道半透明；拖动中的片段再叠一层透明（"提起来"），落点由预览表达。
    ctx.globalAlpha = (isHiddenTrack ? 0.35 : 1) * (isMovingClip ? 0.7 : 1);

    const clipKind = rect.clip.asset_kind;
    const isAudioClip = clipKind === "audio";
    const isVisualClip = clipKind === "video" || clipKind === "image";
    const kindKey = String((rect.clip as unknown as { asset_kind?: string }).asset_kind ?? (isAudioClip ? "audio" : "video"));
    const vars = KIND_COLOR_VARS[kindKey] ?? (isAudioClip ? KIND_COLOR_VARS.audio : KIND_COLOR_VARS.video);
    const palette = {
      body: cssColor(vars.body, isAudioClip ? "#318383" : "#54789d"),
      header: cssColor(vars.header, isAudioClip ? "#1c5757" : "#354f6a"),
      band: cssColor(vars.band, isAudioClip ? "#1c5757" : "#354f6a"),
      wave: cssColor(vars.wave, isAudioClip ? "#318383" : "#54789d"),
    };
    const headerH = rect.width > 36 ? CLIP_HEADER_H : 0;
    // 音频区域（剪映式）：视频 = 底部原声带（高度 = 占比 × 名称条以下区域），
    // 纯音频 = 名称条以下全部（占比只作用于波形振幅）。
    const band = clipAudioBand(rect.clip, rect, waveformRatio);
    const bodyTop = rect.y + headerH;
    const bodyBottom = band?.top ?? rect.y + rect.height;
    const bodyH = Math.max(4, bodyBottom - bodyTop);

    ctx.save();
    // 圆角裁剪区域：名称条、缩略图、波形全部限制在片段圆角矩形内。
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, CLIP_RADIUS);
    ctx.clip();

    // 1) 片段体底色（视频/图片：近黑；音频：剪映蓝）。
    ctx.fillStyle = palette.body;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    // 2) 缩略图带（视频/图片）：所见即所得——片段【时间线】时长均匀切格
    //    （格宽≈44px 档位），每格 seek 该格中心的源时刻，绘制按格位精确落位
    //    并等比 cover 裁切（不拉伸、不留缝）。播放头压在哪一格，看到的就是
    //    那一刻的内容；片段放得越大格越小、对位越准。缩放换档后旧帧经
    //    ":any:" 别名兜底，新档位帧到达即逐格替换。
    if (thumbnailCache && isVisualClip && rect.width > 10) {
      const clipDurUs = rect.clip.timeline_end_us - rect.clip.timeline_start_us;
      if (clipDurUs > 0) {
        // T8 参照 BlockThumbs.tsx:21：THUMB_CELL_PX=80 固定格宽（原 44，密度差一倍）
        const frameCount = quantizeFrameCount(Math.round(((clipDurUs / 1_000_000) * view.pixelsPerSecond) / 80));
        const clipRight = rect.x + rect.width;
        // 帧只画在名称条以下的体内；cover 的垂直溢出由该矩形裁掉。
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, bodyTop, rect.width, bodyH);
        ctx.clip();
        for (let fi = 0; fi < frameCount; fi++) {
          const cellFromUs = rect.clip.timeline_start_us + (fi * clipDurUs) / frameCount;
          const cellToUs = rect.clip.timeline_start_us + ((fi + 1) * clipDurUs) / frameCount;
          const cellX = timeToX(cellFromUs, view);
          if (cellX >= clipRight) break;
          const cellW = Math.max(1, timeToX(cellToUs, view) - cellX);
          const frame =
            thumbnailCache.get(`${rect.clip.clip_id}:${frameCount}:${fi}`) ??
            thumbnailCache.get(`${rect.clip.clip_id}:any:${frameCount}:${fi}`);
          if (!frame || frame.height <= 0 || frame.width <= 0) continue; // 未抽好，到达后补上
          const scale = Math.max(cellW / frame.width, bodyH / frame.height);
          const drawW = frame.width * scale;
          const drawH = frame.height * scale;
          try {
            ctx.drawImage(
              frame,
              cellX - (drawW - cellW) / 2,
              bodyTop - (drawH - bodyH) / 2,
              drawW,
              drawH,
            );
          } catch { /* ignore draw errors */ }
        }
        ctx.restore();
      }
    }

    // 3) 音频波形（剪映式一体剪影）：单 path 填充 + 顶边二次曲线，底部对齐；
    //    偶发峰顶橙点；带底 1px 亮线。B14：按 clip 源区间/速度/倒放取窗。
    if (waveformCache && band && rect.width > 20) {
      const pxWidthForPeaks = Math.max(1, Math.floor(rect.width) - 2);
      const peaks = waveformCache.peaksFor({
        clipId: rect.clip.clip_id,
        assetId: rect.clip.asset_id,
        sourceStartUs: rect.clip.source_start_us ?? 0,
        sourceEndUs: rect.clip.source_end_us ?? 0,
        speedMilli: rect.clip.speed_milli ?? 1000,
        reverse: rect.clip.reverse_playback ?? false,
      }, Math.min(WAVEFORM_PEAK_COUNT_MAX, pxWidthForPeaks * 2));
      if (peaks && peaks.length > 0) {
        if (!isAudioClip) {
          // T7 修正（Timeline.tsx:3350）：视频原声带底 = rgba(0,0,0,0.22)（非令牌色）
          ctx.fillStyle = cssColor("--tl-band-bg", "rgba(0,0,0,0.22)");
          ctx.fillRect(rect.x, band.top, rect.width, band.height);
        }
        const baseline = band.top + band.height;
        // T7 参照 Timeline.tsx:241,3145 + globals.css:96-109：视频原声带固定 AUDIO_BAND_H=15px；
        // 纯音频片段仍占满轨高。
        const AUDIO_BAND_H = 15;
        const maxH = Math.max(2, isAudioClip ? band.height : Math.min(band.height, AUDIO_BAND_H));
        // 剪映「一体感」来源：整条波形是一块连续剪影（单 path 填充 + 顶边
        // 二次曲线），而不是一排 fillRect 密柱。密柱即使高度连续，边缘仍是
        // 折线/接缝，读起来会“碎”。
        const drawLeft = rect.x + 1;
        const pxWidth = Math.max(1, Math.floor(rect.width - 2));
        // T7 修正（对齐 BlockWaveform.tsx 注释 + waveBarPx）：无造形曲线——柱高 = peak × 音量（线性），
        // 音量 = 10^(gain_db/20)（0dB=1）；削波 cap 在带顶并把削波部分染 --tl-wave-clip。静音片段 = 1px 线。
        const volumeLin = Math.max(0, Math.pow(10, (rect.clip.audio.gain_db ?? 0) / 20));
        // 剪映「毛刺」感：保留高频瞬态——像素内取 max，且不做邻域抹平。
        // 线性插值 + 平滑会把尖刺吃掉，只剩光滑山脊。
        const heights: number[] = new Array(pxWidth);
        const clipPx: number[] = new Array(pxWidth);
        for (let px = 0; px < pxWidth; px += 1) {
          const t0 = pxWidth === 1 ? 0 : px / pxWidth;
          const t1 = pxWidth === 1 ? 1 : (px + 1) / pxWidth;
          // 该像素覆盖的 peaks 区间取 max（瞬态尖刺保留为「毛刺」）
          const i0 = Math.min(peaks.length - 1, Math.floor(t0 * peaks.length));
          const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.ceil(t1 * peaks.length) - 1));
          let peak = 0;
          for (let k = i0; k <= i1; k += 1) {
            const v = peaks[k];
            if (v > peak) peak = v;
          }
          // waveBarPx：柱高 = peak × volume 线性 cap 带顶；削波部分（顶部）染 clip 色。
          const level = Math.max(0, peak) * volumeLin;
          heights[px] = Math.max(1, Math.min(1, level) * maxH);
          clipPx[px] = level > 1 ? Math.min(heights[px], Math.max(2, Math.min(maxH / 3, (1 - 1 / level) * maxH))) : 0;
        }
        // 单路径剪影 + 纯折线顶边：微尖刺全部保留（无二次曲线、无平滑）。
        const topY = (px: number): number => baseline - heights[px];
        const topX = (px: number): number => drawLeft + px;
        ctx.beginPath();
        ctx.moveTo(topX(0), baseline);
        ctx.lineTo(topX(0), topY(0));
        for (let px = 1; px < pxWidth; px += 1) {
          ctx.lineTo(topX(px), topY(px));
        }
        ctx.lineTo(topX(pxWidth - 1), baseline);
        ctx.closePath();
        // 波形色：纯音轨主波形 --tl-wave；视频原声带 --tl-wave-band（Timeline.tsx:3353）。
        ctx.fillStyle = cssColor(isAudioClip ? "--tl-wave" : "--tl-wave-band", "rgba(255,255,255,.4)");
        ctx.fill();
        // 削波部分染 --tl-wave-clip（waveBarPx 的 clipPx：至少 2px、至多带高 1/3）。
        const clipColor = cssColor("--tl-wave-clip", "#f2665f");
        ctx.fillStyle = clipColor;
        for (let px = 0; px < pxWidth; px += 1) {
          if (clipPx[px] > 0) ctx.fillRect(topX(px), topY(px), 1, clipPx[px]);
        }
      }
    }

    // 4) 名称条（20px，剪映式）：素材文件名，时长码紧跟其后（左对齐、不靠右）。
    if (headerH > 0) {
      const headerText =
        clipNames.get(rect.clip.clip_id) ??
        (isAudioClip ? `音频 ${rect.clip.order_index + 1}` : `片段 ${rect.clip.order_index + 1}`);
      // T8 参照 Timeline.tsx:3291-3294：时长 "N.Ns"（<1s 两位小数）
      const durUs = rect.clip.timeline_end_us - rect.clip.timeline_start_us;
      const durText = `${(durUs / 1_000_000).toFixed(durUs < 1_000_000 ? 2 : 1)}s`;
      ctx.fillStyle = palette.header;
      ctx.fillRect(rect.x, rect.y, rect.width, headerH);
      // 参照信息条文字：10px / medium / white 90%；时长 white 55%（openfilm Timeline.tsx:3285-3292）。
      // 原来是 11px 纯白——字号大 1px 且纯白，让名称条比画面更抢眼。
      ctx.font = "500 10px sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const textY = rect.y + headerH / 2 + 0.5;
      const durWidth = ctx.measureText(durText).width;
      const showDur =
        rect.width > 90 && 12 + ctx.measureText(headerText).width + 8 + durWidth <= rect.width - 4;
      const maxNameWidth = rect.width - 12 - (showDur ? durWidth + 8 : 0);
      let name = headerText;
      if (ctx.measureText(name).width > maxNameWidth) {
        while (name.length > 0 && ctx.measureText(`${name}…`).width > maxNameWidth) {
          name = name.slice(0, -1);
        }
        name += "…";
      }
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fillText(name, rect.x + 6, textY);
      if (showDur) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
        ctx.fillText(durText, rect.x + 6 + ctx.measureText(name).width + 8, textY);
      }
    }

    // Locked indicator
    if (isLocked) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
      ctx.fillStyle = "#cccccc";
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("🔒", rect.x + rect.width - 14, rect.y + rect.height / 2);
    } else if (hover.clipId === rect.clip.clip_id && !isSelected) {
      // 悬停高亮（非边框）。
      ctx.fillStyle = cssColor("--tl-row-hover", "rgba(255, 255, 255, 0.07)");
      ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
    }
    ctx.restore();

    // 5) 选中效果（P230-②b 2026-11-17 修正为参照 SelectFrame 的**纯描边**）：
    //    旧实现先以 70% alpha 整面填充外扩矩形再压左右实边——等价于给片段罩了
    //    一圈半透明「背景板」（用户指认的选中背景异常）。参照是 border-box 描边：
    //    borderColor = `Y X`（上/下 70%、左/右 实色）， borderWidth = `1px 3px`，
    //    盒子外扩到片段外 3px/1px，内部完全透明。
    if (isSelected && !isMovingClip) {
      const sx = 3, sy = 1;
      const frame = cssColor("--tl-select", "#161619");
      ctx.save();
      // 外框 = 片段矩形外扩 (sx, sy)。逐边画，绝不填充内部：
      //   上/下：1px @70%（color-mix 70% 等效——globalAlpha 只作用这两条）
      //   左/右：3px 实色
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = frame;
      ctx.fillRect(rect.x - sx, rect.y - sy, rect.width + sx * 2, sy);                    // 上
      ctx.fillRect(rect.x - sx, rect.y + rect.height, rect.width + sx * 2, sy);           // 下
      ctx.globalAlpha = 1;
      ctx.fillRect(rect.x - sx, rect.y - sy, sx, rect.height + sy * 2);                   // 左
      ctx.fillRect(rect.x + rect.width, rect.y - sy, sx, rect.height + sy * 2);           // 右
      ctx.restore();
    }

    // 6) 分贝线——T11 参照 Timeline.tsx:3427-3444：1px #fff（30% 常态→60% hover），
    //    两端内缩 trimHit(w)（不再固定 6px）；拖动高亮 = 全亮白。
    const volBand = clipAudioBand(rect.clip, rect, waveformRatio);
    if (volBand && rect.width > 30) {
      const draggingVolume =
        interaction?.kind === "volume" && interaction.clipId === rect.clip.clip_id;
      const hoveredClip = hover.clipId === rect.clip.clip_id;
      const gainDb = draggingVolume
        ? (interaction as { targetGainDb: number }).targetGainDb
        : rect.clip.audio.gain_db;
      const shownY = volumeToY(gainDb, volBand);
      ctx.save();
      const volInset = trimHitPx(rect.width);
      ctx.strokeStyle = draggingVolume
        ? "rgba(255, 255, 255, 1)"
        : isLocked
          ? "rgba(255, 255, 255, 0.2)"
          : hoveredClip
            ? "rgba(255, 255, 255, 0.6)"
            : "rgba(255, 255, 255, 0.3)";
      // 0.5 对齐：DPR 缩放下让 1px 线落在单设备像素上（避免被取整成 2px）。
      const lineY = Math.round(shownY) + 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + volInset, lineY);
      ctx.lineTo(rect.x + rect.width - volInset, lineY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rect.x + volInset + 6, lineY, 3, 0, Math.PI * 2);
      ctx.fillStyle = draggingVolume
        ? "rgba(255, 255, 255, 1)"
        : hoveredClip
          ? "rgba(255, 255, 255, 0.6)"
          : "rgba(255, 255, 255, 0.3)";
      ctx.fill();
      if (draggingVolume || hoveredClip) {
        const label = `${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)}dB`;
        ctx.font = "9px sans-serif";
        const chipWidth = ctx.measureText(label).width + 10;
        ctx.fillStyle = "rgba(8, 14, 16, 0.8)";
        ctx.beginPath();
        ctx.roundRect(rect.x + 19, lineY - 8, chipWidth, 16, 3);
        ctx.fill();
        ctx.fillStyle = "#eef4f6";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(label, rect.x + 24, lineY + 0.5);
      }
      ctx.restore();
    }

    // Speed / reverse badge (M2 B1)
    const clipSpeed = rect.clip.speed_milli ?? 1000;
    if (clipSpeed !== 1000 || rect.clip.reverse_playback) {
      const badge = [
        clipSpeed !== 1000 ? `${(clipSpeed / 1000).toFixed(clipSpeed % 1000 === 0 ? 1 : 2)}x` : "",
        rect.clip.reverse_playback ? "◀◀" : "",
      ]
        .filter(Boolean)
        .join(" ");
      ctx.font = "9px sans-serif";
      const badgeWidth = ctx.measureText(badge).width + 8;
      const badgeX = rect.x + rect.width - badgeWidth - 4;
      const badgeY = rect.y + headerH + 2;
      if (badgeX > rect.x + 4) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(badgeX, badgeY, badgeWidth, 14);
        ctx.fillStyle = "#ffd27a";
        ctx.textBaseline = "middle";
        ctx.fillText(badge, badgeX + 4, badgeY + 7);
      }
    }
    ctx.globalAlpha = 1;
  };
  for (const sourceRect of drawClipRects) {
    if (movingId !== null && sourceRect.clip.clip_id === movingId) continue;
    drawClipRect(sourceRect);
  }

  // 剪映式放置预览：拖动中按 resolveMoveTarget 的解析结果画落点剪影
  // （目标轨上将被放置的实体位置 + 交换片段的去向）；松手按同一结果提交，
  // 预览即结果、自动吸附。同轨自由拖动时片段本身就是预览，不重复画。
  if (interaction?.kind === "move" && interaction.resolution) {
    const resolution = interaction.resolution;
    const draggedRect = clipRects.find((r) => r.clip.clip_id === interaction.clipId);
    const dragged = draggedRect?.clip;
    if (dragged && draggedRect) {
      const sameTrackFree = resolution.trackId === dragged.track_id && resolution.mode === "free";
      if (!sameTrackFree) {
        const targetRow = trackRowOf(trackRows, resolution.trackId);
        if (targetRow) {
          const gx = timeToX(resolution.startUs, view);
          const gy = targetRow.y + CLIP_ROW_INSET;
          const gw = Math.max(2, (clipDuration(dragged) / 1_000_000) * view.pixelsPerSecond);
          const gh = targetRow.height - CLIP_ROW_INSET * 2;
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = "rgb(71, 71, 71)";
          ctx.beginPath();
          ctx.roundRect(gx, gy, gw, gh, CLIP_RADIUS);
          ctx.fill();
          ctx.restore();
        }
      }
      if (resolution.displaced) {
        const displacedRect = clipRects.find(
          (r) => r.clip.clip_id === resolution.displaced!.clipId,
        );
        const displacedRow = trackRowOf(trackRows, resolution.displaced.trackId);
        if (displacedRect && displacedRow) {
          const dx = timeToX(resolution.displaced.startUs, view);
          const dw = Math.max(
            2,
            (clipDuration(displacedRect.clip) / 1_000_000) * view.pixelsPerSecond,
          );
          ctx.save();
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = "#8fa8b8";
          ctx.beginPath();
          ctx.roundRect(
            dx,
            displacedRow.y + CLIP_ROW_INSET,
            dw,
            displacedRow.height - CLIP_ROW_INSET * 2,
            CLIP_RADIUS,
          );
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  // 拖动中的片段最后绘制：半透明"提起来"、带投影，压过邻居。
  const movingRect = movingId !== null ? clipRects.find((r) => r.clip.clip_id === movingId) : null;
  if (movingRect) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 10;
    drawClipRect(movingRect);
    ctx.restore();
  }

  // 修剪端点的可视反馈已并入片段绘制（底边两角圆形端点柄）；
  // 命中区仍由 hitTestTrimHandle 的左右 ±6px 区域提供。

  // Captions (enhanced transcript style)
  // 播放头驻留高亮（A06 语义调整）：主画布不再跟随播放头逐帧重绘，驻留态
  // 改由命中测试选中/悬停通道驱动——选中字幕仍保留其较强的激活外观。
  // B17：只画可见区字幕（选中字幕即使不可见也保留在过滤结果外——canvas
  // 交互反馈由选中描边表达，不因裁剪丢语义）。
  for (const rect of drawCaptionRects) {
    const isSelected = selection?.kind === "caption" && selection.id === rect.caption.caption_id;
    const isActive = isSelected;
    const isEdited = rect.caption.edited;

    // Skip if too narrow
    if (rect.width < 10) continue;

    // Background with rounded corners（剪映式：手工/导入文本 = 橘色条）。
    const bgY = rect.y + 2;
    const bgH = rect.height - 4;
    const manualText = rect.caption.origin === "user";
    ctx.fillStyle = isSelected
      ? manualText ? "#e8622a" : "#d9a04a"
      : isActive
        ? manualText ? "#d95b24" : "#b8863a"
        : manualText
          ? "#c6511e"
          : "#8a6a3a";
    ctx.beginPath();
    ctx.roundRect(rect.x, bgY, rect.width, bgH, 4);
    ctx.fill();

    // Selection/active border
    if (isSelected || isActive) {
      ctx.strokeStyle = isSelected ? "#ffc87a" : "#e0b060";
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.stroke();
    }

    // Text with ellipsis
    if (rect.width > 20) {
      ctx.fillStyle = "#ffffff";
      ctx.font = isEdited ? "italic 10px sans-serif" : "10px sans-serif";
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x + 4, bgY, rect.width - 8, bgH);
      ctx.clip();

      // Truncate with ellipsis
      let displayText = rect.caption.text;
      const maxWidth = rect.width - 12;
      if (ctx.measureText(displayText).width > maxWidth) {
        while (displayText.length > 0 && ctx.measureText(displayText + "…").width > maxWidth) {
          displayText = displayText.slice(0, -1);
        }
        displayText += "…";
      }
      ctx.fillText(displayText, rect.x + 6, bgY + bgH / 2);
      ctx.restore();
    }

    // Edited indicator dot
    if (isEdited && rect.width > 30) {
      ctx.fillStyle = "#ffcc00";
      ctx.beginPath();
      ctx.arc(rect.x + rect.width - 8, bgY + 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Keyframe lanes (Round 5): expanded panel below the selected clip.
  const laneColors: Record<string, string> = { position: "#6fd3d3", scale: "#f0d264", rotate: "#f0a264", opacity: "#ffffff" };
  if (selection?.kind === "clip") {
    const rect = clipRects.find((r) => r.clip.clip_id === selection.id);
    const props = rect?.clip.keyframes
      ? KEYFRAME_ORDER.filter((property) => rect.clip.keyframes?.[property])
      : [];
    if (rect && props.length > 0) {
      const panelTop = rect.y + rect.height + 2;
      const panelHeight = props.length * KEYFRAME_LANE_HEIGHT + 4;
      ctx.save();
      ctx.fillStyle = "rgba(10, 14, 20, 0.92)";
      ctx.strokeStyle = cssColor("--tl-snap", "#0098a3");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rect.x, panelTop, rect.width, panelHeight, 4);
      ctx.fill();
      ctx.stroke();
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      props.forEach((property, laneIndex) => {
        const laneY = panelTop + 4 + laneIndex * KEYFRAME_LANE_HEIGHT + KEYFRAME_LANE_HEIGHT / 2;
        ctx.fillStyle = "#9fb3bd";
        ctx.fillText(KEYFRAME_LANE_LABELS[property] ?? property, rect.x + 5, laneY);
        const track = rect.clip.keyframes?.[property as keyof NonNullable<TimelineClip["keyframes"]>];
        if (!track) return;
        for (const frame of track.frames) {
          const fx = timeToX(rect.clip.timeline_start_us + frame.t_us, view);
          if (fx < rect.x + 14 || fx > rect.x + rect.width - 4) continue;
          ctx.fillStyle = laneColors[property] ?? "#ffffff";
          ctx.beginPath();
          ctx.moveTo(fx, laneY - 4);
          ctx.lineTo(fx + 4, laneY);
          ctx.lineTo(fx, laneY + 4);
          ctx.lineTo(fx - 4, laneY);
          ctx.closePath();
          ctx.fill();
        }
      });
      ctx.restore();
    }
  }

  // Drag feedback (move / group-move / trim)。
  // 单片段移动：片段本体已在目标位置跟随鼠标（见片段绘制循环），这里只画时间提示。
  if (interaction?.kind === "move") {
    const clip = clipRects.find((r) => r.clip.clip_id === interaction.clipId)?.clip;
    if (clip) {
      const ghost = ghostPosition(clipRects.map((r) => r.clip), clip, interaction.targetStartUs, interaction.targetTrackId ?? undefined);
      const ghostRow = trackRowOf(trackRows, interaction.targetTrackId ?? clip.track_id) ?? trackRowOf(trackRows, clip.track_id);
      const gx = timeToX(ghost.startUs, view);
      const gy = ghostRow?.y ?? view.rulerHeight;
      const gw = Math.max(2, ((ghost.endUs - ghost.startUs) / 1_000_000) * view.pixelsPerSecond);
      drawDragTooltip(
        ctx,
        gx + gw / 2,
        gy,
        [
          `${formatRulerTime(ghost.startUs)} · ${((ghost.endUs - ghost.startUs) / 1_000_000).toFixed(2)}s`,
          `Δ${interaction.targetStartUs - interaction.startUs >= 0 ? "+" : ""}${((interaction.targetStartUs - interaction.startUs) / 1_000_000).toFixed(2)}s`,
        ],
        width,
      );
    }
  } else if (interaction?.kind === "group-move") {
    // 组移动 ghost：按平移后的目标位置绘制（V1 已钳制为合法位置）。
    {
      ctx.save();
      ctx.globalAlpha = 0.55;
      let firstRect: { x: number; y: number; width: number } | null = null;
      for (const clipId of interaction.clipIds) {
        const rect = clipRects.find((r) => r.clip.clip_id === clipId);
        const targetUs = interaction.targetStartUsByClip[clipId];
        if (!rect || targetUs === undefined) continue;
        const gw = Math.max(2, (clipDuration(rect.clip) / 1_000_000) * view.pixelsPerSecond);
        const gx = timeToX(targetUs, view);
        ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(rect.clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
        ctx.fillRect(gx, rect.y + 2, gw, view.trackHeight - 4);
        // 描边走强调令牌（原 #2fc9a5 是旧青绿，色相与新强调色差 30°，且落在自己的填充上只有 1.05:1）。
        // 必须用 :root 上真实存在的令牌：cssColor() 读的是 documentElement 的计算样式，
        // 而 --ws-accent-text 只声明在 .editor-shell 上 ⇒ 永远取不到、恒走兜底值
        // （实测深色因此从 8.62:1 掉到 2.43:1，属回归）。--brand-b 才是挂在 :root 的那一个。
        ctx.strokeStyle = cssColor("--tl-canvas-accent", "#00c1cd");
        ctx.lineWidth = 1.5;
        ctx.strokeRect(gx, rect.y + 2, gw, view.trackHeight - 4);
        if (!firstRect) firstRect = { x: gx, y: rect.y, width: gw };
      }
      ctx.restore();
      if (firstRect) {
        const anchorDelta =
          Math.min(...interaction.clipIds.map((id) => interaction.targetStartUsByClip[id] ?? 0)) -
          Math.min(...interaction.clipIds.map((id) => interaction.startUsByClip[id] ?? 0));
        drawDragTooltip(
          ctx,
          firstRect.x + firstRect.width / 2,
          firstRect.y,
          [
            `${interaction.clipIds.length} 个片段`,
            `Δ${anchorDelta >= 0 ? "+" : ""}${(anchorDelta / 1_000_000).toFixed(2)}s`,
          ],
          width,
        );
      }
    }
  } else if (interaction?.kind === "volume") {
    const rect = clipRects.find((r) => r.clip.clip_id === interaction.clipId);
    const band = rect ? clipAudioBand(rect.clip, rect, waveformRatio) : null;
    if (rect && band) {
      const shownY = volumeToY(interaction.targetGainDb, band);
      ctx.save();
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + 4, Math.round(shownY) + 0.5);
      ctx.lineTo(rect.x + rect.width - 4, Math.round(shownY) + 0.5);
      ctx.stroke();
      ctx.restore();
      drawDragTooltip(
        ctx,
        rect.x + rect.width / 2,
        shownY - 4,
        [
          `${interaction.targetGainDb >= 0 ? "+" : ""}${interaction.targetGainDb.toFixed(1)}dB`,
          `${interaction.startGainDb >= 0 ? "+" : ""}${interaction.startGainDb.toFixed(1)} → ${interaction.targetGainDb >= 0 ? "+" : ""}${interaction.targetGainDb.toFixed(1)}`,
        ],
        width,
      );
    }
  } else if (interaction?.kind === "trim") {
    const clip = clipRects.find((r) => r.clip.clip_id === interaction.clipId)?.clip;
    if (clip) {
      const durationUs = clipDuration(clip);
      let ghostStartUs = clip.timeline_start_us;
      let ghostEndUs = clip.timeline_end_us;
      if (interaction.edge === "left") {
        const delta = interaction.targetStartUs - interaction.originalStartUs;
        ghostStartUs = clip.timeline_start_us + delta;
      } else {
        const delta = interaction.targetEndUs - interaction.originalEndUs;
        ghostEndUs = clip.timeline_end_us + delta;
      }
      if (ghostEndUs - ghostStartUs < MIN_CLIP_US) ghostEndUs = ghostStartUs + MIN_CLIP_US;
      const gx = timeToX(ghostStartUs, view);
      const trimRow = trackRowOf(trackRows, clip.track_id);
      const gy = trimRow?.y ?? view.rulerHeight;
      const gh = trimRow?.height ?? view.trackHeight;
      const gw = Math.max(2, ((ghostEndUs - ghostStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
      ctx.fillRect(gx, gy + 2, gw, gh - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, gh - 4);
      ctx.restore();
      const edgeDelta =
        interaction.edge === "left"
          ? interaction.targetStartUs - interaction.originalStartUs
          : interaction.targetEndUs - interaction.originalEndUs;
      drawDragTooltip(
        ctx,
        interaction.edge === "left" ? gx : gx + gw,
        gy,
        [
          `${((ghostEndUs - ghostStartUs) / 1_000_000).toFixed(2)}s`,
          `Δ${edgeDelta >= 0 ? "+" : ""}${(edgeDelta / 1_000_000).toFixed(2)}s`,
        ],
        width,
      );
    }
  } else if (interaction?.kind === "caption-trim") {
    const caption = captions.find((c: TimelineCaption) => c.caption_id === interaction.captionId);
    if (caption) {
      let ghostStartUs = caption.start_us;
      let ghostEndUs = caption.end_us;
      if (interaction.edge === "left") {
        ghostStartUs = interaction.targetStartUs;
      } else {
        ghostEndUs = interaction.targetEndUs;
      }
      const gx = timeToX(ghostStartUs, view);
      const gy = view.rulerHeight + 2 * view.trackHeight;
      const gw = Math.max(2, ((ghostEndUs - ghostStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#7a6a3a";
      ctx.fillRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.restore();
      const edgeDelta =
        interaction.edge === "left"
          ? interaction.targetStartUs - interaction.originalStartUs
          : interaction.targetEndUs - interaction.originalEndUs;
      drawDragTooltip(
        ctx,
        interaction.edge === "left" ? gx : gx + gw,
        gy,
        [
          `${((ghostEndUs - ghostStartUs) / 1_000_000).toFixed(2)}s`,
          `Δ${edgeDelta >= 0 ? "+" : ""}${(edgeDelta / 1_000_000).toFixed(2)}s`,
        ],
        width,
      );
    }
  } else if (interaction?.kind === "caption-move") {
    const caption = captions.find((c: TimelineCaption) => c.caption_id === interaction.captionId);
    if (caption) {
      const gx = timeToX(interaction.targetStartUs, view);
      const gy = view.rulerHeight + 2 * view.trackHeight;
      const gw = Math.max(2, ((interaction.targetEndUs - interaction.targetStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#7a6a3a";
      ctx.fillRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.restore();
    }
  }

  // Snap guide (Phase 4; group-move included since Round 4)
  const snapUs =
    (interaction?.kind === "move" ||
      interaction?.kind === "trim" ||
      interaction?.kind === "group-move")
      ? interaction.snapUs
      : null;
  if (snapUs !== null && snapUs !== undefined) {
    const sx = timeToX(snapUs, view);
    if (sx >= view.headerWidth && sx <= width) {
      // T12 参照 Timeline.tsx:4391-4403：吸附线 = 1px 实线 --accent，无时间标签；
      // 吸附到播放头时不画（ref：候选命中播放头则跳过 guide）。
      if (Math.abs(sx - timeToX(playheadUs, view)) < 0.5) return;
      ctx.strokeStyle = cssColor("--accent", "#00c1cd");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
    }
  }

  // Marquee selection rect (Phase 4) — coords are content-space, scroll applied
  if (interaction?.kind === "marquee") {
    const rect = marqueeRect(
      interaction.startX,
      interaction.startY,
      interaction.currentX,
      interaction.currentY,
    );
    // T12 参照 Timeline.tsx:4502-4515：框选 = 实线边 + accent 18% 填充 + r2
    ctx.fillStyle = cssColor("--accent-soft", "rgba(0,193,205,.14)");
    ctx.fillRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
    ctx.strokeStyle = cssColor("--accent", "#00c1cd");
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
  }

  // 播放头已拆为独立 DOM 覆盖层（A06：TimelinePlayheadLayer + playhead-store），
  // 主画布/固定标尺不再绘制播放头线与手柄——播放期间不再触发全量重绘。

  // Bottom scrollbar strip (Round 4)：绘制在可视区底部（而非画布内容底部），
  // 内容高于面板时滚动条始终可见、可拖。
  // B17：画布 viewport 化后画布顶 = scrollTop - overscan——可视区底部在
  // 画布坐标 = scrollTop + 面板高 - topY。滚动条是画布固定 UI（不随内容
  // 平移）：先复位变换再画。
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const viewportBottom = Math.min(height, scrollTopRaw + (viewportHeight ?? height) - topY);
  drawScrollbar(ctx, width, viewportBottom, view, totalUs);
}

/** 固定标尺条带：多轨道纵向滚动时钉在可视区顶部，轨道内容从其下方滚过。
 *  绘制内容与 drawTimeline 的标尺带一致（角区 + 底色 + 刻度 + 内容范围条 +
 *  悬停时间标签；播放头由 TimelinePlayheadLayer DOM 覆盖层绘制），
 *  由独立覆盖层 Canvas 调用。 */
function drawRulerStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  ticks: TickMark[],
  rulerHoverUs: number | null | undefined,
  clipRects: ClipRenderRect[],
  selection: TimelineSelection | undefined,
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // 三段几何：[0, headW) 角区（轨道头列上方）· [headW, rulerX) 封面条带（主画布
  // 在头列右侧同样留了 headW 宽的死区条带）· [rulerX, width) 标尺/片段区。
  // 注意 tick.x / timeToX 均已含 headerWidth（画布内坐标，内容自 x=headW 起），
  // 而覆盖层横跨整个 .timeline-body（主画布在头列右侧 headW 处开始），
  // 因此屏幕对齐 = tick.x + headW，刻度 0 落在 rulerX = 2*headW = 片段区起点。
  const headW = view.headerWidth;
  const stripW = headW;
  const rulerX = headW + stripW;
  // 主题令牌：角区 = 轨道头底、封面条带 = 画布底，分隔线走网格线令牌
  //（2026-11-11 浅色修复——此前硬编码，浅色下角区仍是一块深色）。
  ctx.fillStyle = cssColor("--tl-track-head-bg", "#101012");
  ctx.fillRect(0, 0, headW, height);
  ctx.fillStyle = cssColor("--tl-canvas-bg", "#161618");
  ctx.fillRect(headW, 0, stripW, height);
  ctx.strokeStyle = cssColor("--tl-grid-line-strong", "rgba(255, 255, 255, 0.22)");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rulerX - 0.5, 0);
  ctx.lineTo(rulerX - 0.5, height);
  ctx.moveTo(0, height - 0.5);
  ctx.lineTo(width, height - 0.5);
  ctx.stroke();

  // 标尺面（与主绘制完全同源）：渐变底 + 刻度 + 素材范围条 + 终点标线/死区 +
  // 悬停时间胶囊。终点外同样压平——固定标尺不会长过素材。
  const totalEndUs =
    clipRects.length > 0 ? Math.max(...clipRects.map((r) => r.clip.timeline_end_us)) : null;
  drawRulerFace(ctx, {
    bandX: rulerX,
    width,
    height,
    endX: totalEndUs !== null ? timeToX(totalEndUs, view) + headW : width,
    xOffset: headW,
    ticks,
    hoverUs: rulerHoverUs,
    hoverText: rulerHoverUs !== null && rulerHoverUs !== undefined ? formatTime(rulerHoverUs) : "",
    contentRange:
      clipRects.length > 0
        ? {
            fromUs: Math.min(...clipRects.map((r) => r.clip.timeline_start_us)),
            toUs: totalEndUs as number,
          }
        : null,
    xAt: (us) => timeToX(us, view) + headW,
    selection,
    clipRects,
  });

  // 播放头（含手柄）由独立 DOM 覆盖层 TimelinePlayheadLayer 绘制（A06）。
}

// ── Component ────────────────────────────────────────────────────────────────

export function TimelinePanel({
  document,
  selection,
  setSelection,
  onPatch,
  onDropAsset,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  assetMedia,
  waveformCache,
  playheadStore,
  onSeek,
  onSeekCommit,
  onCommand,
  coverUrl,
  onCaptureCover,
  meterLevels,
  playing,
}: {
  document?: TimelineDocument;
  selection: TimelineSelection;
  setSelection: (selection: TimelineSelection) => void;
  onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>;
  onDropAsset: (assetId: string, atIndex: number, trackId?: string | "new") => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  assetMedia: AssetMediaEntry[];
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
  /** Optional editor command runner (copy/paste context-menu actions). */
  onCommand?: (id: EditorCommand["id"]) => void;
  /** 项目封面（本地截帧持久化），有值时封面入口显示缩略图。 */
  coverUrl?: string | null;
  /** 截取当前播放头画面设为项目封面（由 App 层从预览画布取帧）。 */
  onCaptureCover?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 播放头 store：外部拥有（App 跨组件写入）或组件自建（测试/独立使用）。
  const localPlayheadStoreRef = useRef<PlayheadStore | null>(null);
  if (!localPlayheadStoreRef.current && !playheadStore) {
    localPlayheadStoreRef.current = createPlayheadStore();
  }
  const activePlayheadStore = playheadStore ?? localPlayheadStoreRef.current!;
  const [view, setView] = useState<TimelineViewState>(DEFAULT_VIEW_STATE);
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
  viewRef.current = view;  const [dropIndex, setDropIndex] = useState<number | null>(null);
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
  // 拖拽松手后的"提交态"：补丁在途期间片段继续渲染在目标位置（剪映式无回弹），
  // 文档更新后清除。moved = 主片段去向，displaced = 被交换片段去向（可选）。
  const [pendingKeep, setPendingKeep] = useState<{
    clipId: TimelineClipId;
    trackId: string;
    startUs: number;
    displaced?: { clipId: TimelineClipId; trackId: string; startUs: number };
  } | null>(null);
  // Synchronous mirror of interaction so pointer handlers always read the latest value.
  const interactionRef = useRef<TimelineInteraction | null>(null);
  // Hover state (trim handles + cursor).
  const [hover, setHover] = useState<TimelineHover>({ clipId: null, edge: null });
  // Round 5: hovered time on the ruler (faint guide + label), null when idle.
  const [rulerHoverUs, setRulerHoverUs] = useState<number | null>(null);
  // Round 4: persisted runtime prefs (magnetic snapping / 轨道高度 / 波形占比)。
  const [prefs, setPrefs] = useState<TimelineRuntimePrefs>(loadRuntimePrefs);
  // 轨道高度偏好同步到视图（行高固定，不随窗口压缩）。
  useEffect(() => {
    setView((value) => (value.trackHeight === prefs.trackHeight ? value : { ...value, trackHeight: prefs.trackHeight }));
  }, [prefs.trackHeight]);
  // 时间线显示设置（… 菜单）开关。
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const displayMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!displayMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!displayMenuRef.current?.contains(event.target as Node)) setDisplayMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [displayMenuOpen]);
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
      | { kind: "empty" };
    timeUs: number;
  } | null>(null);

  const clips = document?.clips ?? [];
  const captions = document?.captions ?? [];
  const transitions = document?.transitions ?? [];
  const tracks: TimelineTrack[] = document?.tracks ?? [];
  const totalUs = duration(document);
  const frameRate =
    document?.canvas?.fps_num && document?.canvas?.fps_den
      ? document.canvas.fps_num / document.canvas.fps_den
      : 30;
  // 播放头即时值（不触发 React 重渲染）：交互几何在事件发生的那一刻读取
  // store——播放期间组件完全静止，播放头推进只走覆盖层 useSyncExternalStore
  // 通道（不进入本组件的渲染/绘制路径）。
  const playheadUs = activePlayheadStore.get();
  void playheadUs; // 调试镜像值；交互路径一律 activePlayheadStore.get() 即时读取

  // Compute geometry：轨道行自上而下排列，行高固定（不随窗口大小压缩）；
  // 轨道过多时时间线区域纵向滚动。
  // 行数少、面板有余量时，行组在轨道区内垂直居中（2026-11-11，对齐 OpenFilm
  // 的 padTop：面板拉高后行组跟着居中，而不是贴着标尺、底下空一大片）。
  // 传入的高度是轨道区自身高度（扣掉工具栏与标尺）。
  const trackRows = useMemo(
    () => computeTrackRows(tracks, view.rulerHeight, view.trackHeight, Math.max(0, canvasSize.height - view.rulerHeight)),
    [tracks, view.rulerHeight, view.trackHeight, canvasSize.height],
  );
  // 内容总高（标尺 + 行组 + 行间隙 + 横向滚动条条带）；画布与左栏同步按此伸展。
  // 行组居中后首行起点会下移（padTop），所以按「末行底边」算而不是把行高相加——
  // 否则居中的行会掉到内容区之外，canvas 不绘制它。
  // 下限取可视高度：行数少时内容仍铺满面板，底下那片空白才是可点击的轨道区。
  // T1 参照 Timeline.tsx:2767 的 solo 分支：任一轨 solo 激活即整条进入 solo 形态（头列 108+24）。
  const anySolo = trackRows.some(row => Boolean(row.track.solo));
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
    (() => {
      const moved = clips.find((c) => c.clip_id === pendingKeep.clipId);
      return Boolean(
        moved &&
          (moved.timeline_start_us !== pendingKeep.startUs || moved.track_id !== pendingKeep.trackId),
      );
    })();
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
  const clipNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const clip of clips) {
      const name = assetMedia.find((media) => media.asset_id === clip.asset_id)?.display_name;
      if (name) map.set(clip.clip_id, name);
    }
    return map;
  }, [clips, assetMedia]);
  const captionRects = useMemo(
    () => computeCaptionRects(captions, trackRows, view),
    [captions, trackRows, view],
  );
  const transitionRects = useMemo(
    () => computeTransitionRects(clips, transitions, trackRows, view),
    [clips, transitions, trackRows, view],
  );
  /* 空时间线不画刻度（用户指出：参照在没有素材时不显示刻度，有素材才显示）。
     手工建一条空时间线时，主轨上还没有任何片段——此时标尺只是一条干净的带子，
     刻度出现即暗示「这里有内容可以对齐」，实际没有。 */
  const ticks = useMemo(
    () => (clips.length === 0
      ? []
      : computeTicks(totalUs, view.pixelsPerSecond, view.headerWidth, frameRate, view.scrollX, canvasSize.width)),
    [clips.length, totalUs, view.pixelsPerSecond, view.headerWidth, frameRate, view.scrollX, canvasSize.width],
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

  // Thumbnail frame cache: key = "clipId:frameIndex" -> captured frame canvas.
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
  // 档位淘汰计票（问题3修复）：tier → 连续未成为当前档位的轮数。
  const tierStaleRoundsRef = useRef<Map<string, number>>(new Map());
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
          // 键形 = clipId:frameCount:fi。别名键带档位（frameCount）：
          // 兜底语义 = 同档位内"epoch 取消未入缓存的格"复用本档位已抽帧；
          // 旧实现无档位（clipId:any:fi），跨档位同 fi 时间点不同——换档后
          // 旧图按同 fi 落在新格位上，出现"抽帧内容与所在位置对不上"。
          const [clipId, frameCount, frameIndex] = key.split(":");
          cache.set(key, frame.canvas);
          cache.set(`${clipId}:any:${frameCount}:${frameIndex}`, frame.canvas);
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
  // 图片素材直接用 <img> 加载。缩放只改变帧数档位（量化），旧帧保留兜底
  // （别名键 ":any:"），新帧就绪后逐格替换——缩放时画面不消失。请求防抖
  // 200ms，连续缩放不触发重抽风暴。
  useEffect(() => {
    if (!thumbnailLoader) return; // StrictMode 重挂载间隙：新 loader 到位后再发请求
    const timer = window.setTimeout(() => {
      const cache = thumbnailCache.current;
      const clipIds = new Set(clips.map((clip) => clip.clip_id));
      thumbnailLoader.advanceViewport(); // 旧视口未开始的任务取消
      for (const rect of clipRects) {
        const mediaUrl = assetMedia.find((m) => m.asset_id === rect.clip.asset_id)?.media_url ?? null;
        const frames = computeFrameRequests(mediaUrl, rect.clip, view.pixelsPerSecond);
        for (let fi = 0; fi < frames.length; fi++) {
          // 可视区优先：只抽当前视口（±160px 余量）覆盖的格；平移/缩放后
          // effect 重跑，新进入视野的格按需补抽——seek 负载不随片段总长膨胀。
          const cellLeft = timeToX(frames[fi].fromUs, view);
          const cellRight = timeToX(frames[fi].toUs, view);
          if (cellRight < -160 || cellLeft > canvasSize.width + 160) continue;
          // 键含档位帧数：档位变化 → 重新抽帧（时间点不同）；旧帧保留兜底。
          const key = `${rect.clip.clip_id}:${frames.length}:${fi}`;
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
              cache.set(`${rect.clip.clip_id}:any:${frames.length}:${fi}`, captured);
              pendingImageKeys.current.delete(`${key}:img`);
              setThumbnailVersion((v) => v + 1);
            };
            img.onerror = () => pendingImageKeys.current.delete(`${key}:img`);
            continue;
          }
          // 视口内（priority 0）优先，预读余量内（±160px）为 1。
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
      // 仅清理已不存在片段的帧；档位旧帧保留作兜底（上限防膨胀）。
      thumbnailLoader.prune(clipIds);
      for (const key of [...cache.keys()]) {
        if (!thumbnailLoader.peek(key) && !key.includes(":any:")) {
          const clipId = key.split(":")[0] as TimelineClipId;
          if (!clipIds.has(clipId)) cache.delete(key);
        }
      }
      // 档位收敛【按轮次计票】：连续 N 轮（3 轮 ≈ 600ms）都未成为当前档位的
      // 键才淘汰——缩放是连续动画（每轮 pps 都在变），按"单轮非当前"清理会把
      // 抽了一半的新档位帧删掉（实测：缩放后抽帧消失只剩一帧的根因）。
      const currentTiers = new Set<string>();
      for (const rect of clipRects) {
        if ((rect.clip.asset_kind === "video" || rect.clip.asset_kind === "image")
          && (rect.clip.timeline_end_us - rect.clip.timeline_start_us) > 0) {
          const count = quantizeFrameCount(Math.round((((rect.clip.timeline_end_us - rect.clip.timeline_start_us) / 1_000_000) * view.pixelsPerSecond) / 44));
          currentTiers.add(`${rect.clip.clip_id}:${count}`);
        }
      }
      const tierStaleRounds = tierStaleRoundsRef.current;
      for (const tier of [...tierStaleRounds.keys()]) {
        if (currentTiers.has(tier)) tierStaleRounds.delete(tier);
        else tierStaleRounds.set(tier, (tierStaleRounds.get(tier) ?? 0) + 1);
      }
      const staleTiers = new Set(
        [...tierStaleRounds.entries()].filter(([, rounds]) => rounds >= 3).map(([tier]) => tier),
      );
      for (const stale of staleTiers) tierStaleRounds.delete(stale);
      if (staleTiers.size > 0) {
        for (const key of [...cache.keys()]) {
          const parts = key.split(":");
          // 精确键 clipId:frameCount:fi；别名键 clipId:any:frameCount:fi
          const tier = key.includes(":any:") ? `${parts[0]}:${parts[2]}` : `${parts[0]}:${parts[1]}`;
          if (staleTiers.has(tier)) cache.delete(key);
        }
      }
      while (cache.size > 600) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [clipRects, assetMedia, view.pixelsPerSecond, clips, view, canvasSize.width, thumbnailLoader]);

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
      if (rect.x + rect.width <= viewLeft || rect.x >= viewRight) continue;
      void waveformCache.pyramidFor(clip.asset_id).then(pyramid => {
        if (pyramid) setWaveformVersion(v => v + 1);
      });
    }
  }, [clipRects, view.scrollX, view.pixelsPerSecond, view.headerWidth, canvasSize.width, waveformCache]);

  // Canvas rendering
  // B17：画布 viewport 化——DOM 滚动空间保持全内容尺寸（.timeline-left 与
  // 容器高度=contentHeight），Canvas backing 仅覆盖 viewport+overscan
  // （纵向 2 轨），不分配等于所有轨道高度的大位图。画布在容器内绝对定位
  // （top 跟随 scrollTop），绘制时 ctx 平移 -canvasTopY 使内容坐标照常。
  const OVERSCAN_Y_PX = 160; // 2 轨 × ~80px
  const canvasTopY = Math.max(0, scrollTop - OVERSCAN_Y_PX);
  const canvasViewportHeight = Math.min(
    contentHeight - canvasTopY,
    canvasSize.height + 2 * OVERSCAN_Y_PX,
  );
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
    drawTimeline(
      ctx,
      canvasSize.width,
      canvasHeight,
      view,
      trackRows,
      clipRects,
      captionRects,
      captions,
      ticks,
      selection,
      interaction,
      hover,
      activePlayheadStore.get(),
      totalUs,
      document?.locked_elements ?? [],
      rulerHoverUs,
      clipNames,
      frameRate,
      pendingKeep,
      thumbnailCache.current,
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
  }, [canvasSize, view, trackRows, contentHeight, clipRects, captionRects, captions, ticks, selection, interaction, hover, totalUs, thumbnailVersion, waveformVersion, rulerHoverUs, clipNames, frameRate, pendingKeep, scrollTop, canvasTopY, canvasViewportHeight, themeEpoch]);

  // 固定标尺条带：绘制到覆盖层 Canvas（随纵向滚动钉在可视区顶部）。
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rulerScrubbingRef = useRef(false);
  /** 擦洗态（镜像 rulerScrubbingRef，供旋钮实心/空心渲染）。
   *  ref 用于事件路径同步判断，state 只用于把"按住"这件事画出来。 */
  const [scrubbing, setScrubbing] = useState(false);
  /* 时间线模式（参照 Timeline.tsx:4797 ModePicker）。
     当前只承载**视觉与状态**：选择模式 = 现有行为，分割模式暂不改变点击语义
     （「点击即分割」是全局交互变更，需单独确认后再接）。 */
  const [scrubMode, setScrubMode] = useState<TimelineMode>("select");
  // T3：离开分割模式即隐藏刀线（mode 切换发生在 ModePicker onPick）。
  useEffect(() => { if (scrubMode !== "split") hideBlade(); }, [scrubMode, hideBlade]);
  /** 标记悬停/拖动时的贯穿引导线（null = 无）。 */
  const [markerGuide, setMarkerGuide] = useState<{ timeUs: number; color: string; held: boolean } | null>(null);
  /** 时间区间选取（Shift + 在标尺上拖动）：只做视觉，不接任何操作。
   *  与播放头擦洗共用同一标尺，用 Shift 区分意图——标尺拖动本身是擦洗，
   *  加 Shift 才是框选，两者不抢同一个手势。 */
  const [timeRange, setTimeRange] = useState<TimeRange | null>(null);
  const rangeDragRef = useRef<{ anchorUs: number } | null>(null);
  useEffect(() => {
    const canvas = rulerCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = view.headerWidth * 2 + canvasSize.width;
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(view.rulerHeight * dpr));
    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
    if (canvas.style.height !== `${view.rulerHeight}px`) canvas.style.height = `${view.rulerHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawRulerStrip(ctx, width, view.rulerHeight, view, ticks, rulerHoverUs, clipRects, selection);
  }, [view, canvasSize, ticks, rulerHoverUs, clipRects, selection, themeEpoch]);

  // 纵向滚动时把覆盖层钉在滚动容器可视区顶部（直接写样式，避免重渲染）。
  const rulerPinTimeAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return xToTime(event.clientX - rect.left - view.headerWidth, view);
  };
  // 标尺寻址不越过素材终点（标尺本身也画到终点为止）。
  const clampRulerTime = (us: number) => (totalUs > 0 ? Math.min(us, totalUs) : us);
  const handleRulerPinMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const timeUs = clampRulerTime(rulerPinTimeAt(event));
    setRulerHoverUs(timeUs);
    const rangeDrag = rangeDragRef.current;
    if (rangeDrag) {
      setTimeRange(normalizeRange({ startUs: rangeDrag.anchorUs, endUs: timeUs }, totalUs));
      return;
    }
    if (rulerScrubbingRef.current) onSeek?.(timeUs);
  };
  const handleRulerPinDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    // Shift + 拖动 = 框选时间区间（不擦洗、不动播放头）。
    // 与普通拖动的区别只在 Shift，因此不会误触。
    if (event.shiftKey) {
      const anchorUs = clampRulerTime(rulerPinTimeAt(event));
      rangeDragRef.current = { anchorUs };
      setTimeRange({ startUs: anchorUs, endUs: anchorUs });
      return;
    }
    rulerScrubbingRef.current = true;
    setScrubbing(true);
    event.currentTarget.style.cursor = "col-resize";
    onSeek?.(clampRulerTime(rulerPinTimeAt(event)));
  };
  const handleRulerPinUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (rangeDragRef.current) {
      rangeDragRef.current = null;
      // 拖得太短视为误触：清掉，不留一个看不清的细条
      setTimeRange(current => (current && rangeDuration(current) >= MIN_RANGE_US ? current : null));
      return;
    }
    // 松手提交精确值：拖动过程走节流（画面跟手但不逐事件提交），
    // 最终位置必须落在指针实际所指处，否则会停在一个节流近似值上。
    if (rulerScrubbingRef.current) onSeekCommit?.(clampRulerTime(rulerPinTimeAt(event)));
    rulerScrubbingRef.current = false;
    setScrubbing(false);
    event.currentTarget.style.cursor = "default";
  };
  const handleRulerPinLeave = (event: React.MouseEvent<HTMLCanvasElement>) => {
    rulerScrubbingRef.current = false;
    event.currentTarget.style.cursor = "default";
    setRulerHoverUs(null);
  };
  const handleRulerPinDoubleClick = () => fitToContent();

  // 滚轮策略：Ctrl+滚轮 = 以光标为锚缩放；Shift/触摸板横向 = 横向平移；
  // 普通滚轮 = 原生纵向滚动（.timeline-scroll，画布 viewport 随动）。
  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.deltaY === 0 && event.deltaX === 0) return;
      const width = canvasSize.width;
      // Ctrl/⌘ + 滚轮：以光标为锚缩放。
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const coords = canvasCoords(event);
        const anchorX = coords ? coords.x : width / 2;
        setView((v) => zoomAtAnchor(v, anchorX, width, event.deltaY < 0 ? 1.15 : 1 / 1.15, totalUs));
        return;
      }
      // Shift/Alt + 滚轮，或触摸板横向滑动：横向平移时间线。
      if (event.shiftKey || event.altKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        setView((v) => {
          const { maxScrollX } = scrollBounds(v, totalUs, width);
          return { ...v, scrollX: clampScrollX(v.scrollX + delta, maxScrollX) };
        });
        return;
      }
      // 普通滚轮：交给 .timeline-scroll 原生纵向滚动（画布 viewport 化后
      // 滚动即视口推进——画布重定位/重绘由 onScroll 链路驱动）；内容不
      // 溢出时原生滚动无事发生，用户无感知。横向平移一律用 Shift/触摸板
      // 或底部滚动条拖拽。
    },
    [canvasSize.width, totalUs],
  );

  /** Zoom to an absolute pps keeping the viewport center time anchored. */
  const setPpsAnchored = useCallback(
    (ppsTarget: number) => {
      setView((v) =>
        zoomAtAnchor(
          v,
          canvasSize.width / 2,
          canvasSize.width,
          ppsTarget / v.pixelsPerSecond,
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
        window.localStorage.setItem(TIMELINE_PREFS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — prefs stay session-only.
      }
      return next;
    });
  }, []);

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

  const isClipLocked = (clipId: TimelineClipId) => {
    if (document?.locked_elements?.includes(clipId)) return true;
    const clip = clips.find((c) => c.clip_id === clipId);
    if (!clip) return false;
    return Boolean(tracks.find((track) => track.id === clip.track_id)?.locked);
  };

  /**
   * 剪映式拖放目标解析：按片段中心判定目标轨；光标压住目标轨片段时按
   * 左/右半边决定"放它前方/后方"的偏好（pointerRatio）。mousemove 实时
   * 调用画预览，边缘自动滚动与松手提交也调用同一函数——预览即结果。
   */
  const resolveDragTargeting = useCallback(
    (active: MoveInteraction): { targetTrackId: string | null; pointerRatio: number } => {
      const draggedClip = clips.find((c) => c.clip_id === active.clipId);
      if (!draggedClip) return { targetTrackId: null, pointerRatio: 0 };
      const compatibleKind = draggedClip.asset_kind === "audio" ? "audio" : "video";
      const originRow = trackRowOf(trackRows, draggedClip.track_id);
      const originCenterY = originRow ? originRow.y + originRow.height / 2 : active.startY;
      const clipCenterY = originCenterY + (active.currentY - active.startY);
      const hoveredRow = trackRowAt(trackRows, active.currentX, clipCenterY);
      const targetTrackId =
        hoveredRow && hoveredRow.track.kind === compatibleKind ? hoveredRow.track.id : null;
      let pointerRatio = 0;
      const effTrackId = targetTrackId ?? draggedClip.track_id;
      if (effTrackId !== draggedClip.track_id) {
        const overlapped = clips.find(
          (c) =>
            c.track_id === effTrackId &&
            c.clip_id !== draggedClip.clip_id &&
            active.targetStartUs < c.timeline_end_us &&
            c.timeline_start_us < active.targetStartUs + clipDuration(draggedClip),
        );
        if (overlapped) {
          const overlappedRect = clipRects.find((r) => r.clip.clip_id === overlapped.clip_id);
          if (overlappedRect && overlappedRect.width > 0) {
            pointerRatio = (active.currentX - overlappedRect.x) / overlappedRect.width;
          }
        }
      }
      return { targetTrackId, pointerRatio };
    },
    [clips, trackRows, clipRects],
  );

  // ── 轨道管理（剪映式）：新增/删除/换位/属性开关 ────────────────────────────
  const [addTrackMenuOpen, setAddTrackMenuOpen] = useState(false);
  const addTrack = (kind: "video" | "text") => {
    void onPatch(
      [{ op: "add_track", kind }],
      kind === "video" ? "添加视频轨道" : "添加文本轨道",
    );
  };
  const moveTrack = (trackId: string, toIndex: number) => {
    void onPatch([{ op: "move_track", track_id: trackId, to_index: toIndex }], "调整轨道顺序");
  };
  const patchTrackFlags = (
    trackId: string,
    flags: { locked?: boolean; hidden?: boolean; muted?: boolean; solo?: boolean },
  ) => {
    void onPatch([{ op: "set_track_flags", track_id: trackId, ...flags }], "调整轨道属性");
  };
  // 点击菜单外部时关闭“添加轨道”菜单。
  const addTrackMenuOpenRef = useRef(addTrackMenuOpen);
  addTrackMenuOpenRef.current = addTrackMenuOpen;
  useEffect(() => {
    if (!addTrackMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".timeline-add-track-menu, .timeline-add-track-wrap")) {
        setAddTrackMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [addTrackMenuOpen]);

  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      setContextMenu(null);
      const coords = canvasCoords(event);
      if (!coords) return;
      const { x, y } = coords;
      const canvas = canvasRef.current;
      if (!canvas) return;

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
        const timeUs = clampRulerTime(xToTime(x, view));
        onSeek?.(timeUs);
        const next: TimelineInteraction = { kind: "playhead", startX: x };
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
      const transitionId = hitTestTransitions(x, y, transitionRects);
      if (transitionId) {
        setSelection({ kind: "transition", id: transitionId });
        return;
      }

      // Trim handle → trim drag (must take priority over plain clip hit)
      const handle = hitTestTrimHandle(x, y, clipRects);
      if (handle && !isClipLocked(handle.clipId)) {
        const clip = clips.find((c) => c.clip_id === handle.clipId);
        if (clip) {
          setSelection({ kind: "clip", id: handle.clipId });
          const next: TimelineInteraction = {
            kind: "trim",
            clipId: handle.clipId,
            edge: handle.edge,
            startX: x,
            originalStartUs: clip.source_start_us ?? 0,
            originalEndUs: clip.source_end_us ?? 0,
            targetStartUs: clip.source_start_us ?? 0,
            targetEndUs: clip.source_end_us ?? 0,
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
        if (isClipLocked(clipId)) return;
        const clip = clips.find((c) => c.clip_id === clipId);
        if (!clip) return;
        // T3 参照 Timeline.tsx:2066-2110：分割模式下点击即分割（沿播放头时间。
        // 参照按指针时刻切，但 ours 的 split_clip 走 source_time_us=播放头处源时刻——
        // 与工具栏既有「拆分片段」同一语义，行为一致可预期。
        if (scrubMode === "split") {
          const cutUs = clampRulerTime(xToTime(x, view));
          if (cutUs <= clip.timeline_start_us || cutUs >= clip.timeline_end_us) return;
          const rel = (cutUs - clip.timeline_start_us) * ((clip.speed_milli ?? 1000) / 1000);
          void onPatch([{ op: "split_clip", clip_id: clip.clip_id, source_time_us: (clip.source_start_us ?? 0) + Math.round(rel) }], "分割片段");
          hideBlade();
          return;
        }
        // Round 5: Shift+click toggles the clip in/out of a multi-selection
        // without starting a drag (standard NLE behaviour).
        if (event.shiftKey) {
          const currentIds =
            selection?.kind === "clip"
              ? [selection.id]
              : selection?.kind === "clips"
                ? selection.ids
                : [];
          const nextIds = currentIds.includes(clipId)
            ? currentIds.filter((id) => id !== clipId)
            : [...currentIds, clipId];
          setSelection(
            nextIds.length === 0
              ? null
              : nextIds.length === 1
                ? { kind: "clip", id: nextIds[0] }
                : { kind: "clips", ids: nextIds },
          );
          return;
        }
        const multiIds = selection?.kind === "clips" ? selection.ids : null;
        const members = multiIds
          ? multiIds
              .map((id) => clips.find((c) => c.clip_id === id))
              .filter((c): c is TimelineClip => Boolean(c))
          : [];
        const groupEligible =
          multiIds &&
          multiIds.includes(clipId) &&
          members.length > 1 &&
          members.every((c) => !isClipLocked(c.clip_id)) &&
          (members.every((c) => c.track_id === "A1") || members.every((c) => c.track_id === "V1"));
        if (groupEligible) {
          const startUsByClip: Record<string, number> = {};
          for (const member of members) startUsByClip[member.clip_id] = member.timeline_start_us;
          const next: TimelineInteraction = {
            kind: "group-move",
            clipIds: members.map((c) => c.clip_id),
            startX: x,
            startUsByClip,
            targetStartUsByClip: { ...startUsByClip },
            snapUs: null,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "grabbing";
          return;
        }
        setSelection({ kind: "clip", id: clipId });
        const next: TimelineInteraction = {
          kind: "move",
          clipId,
          startX: x,
          startY: y,
          currentX: x,
          currentY: y,
          startUs: clip.timeline_start_us,
          targetStartUs: clip.timeline_start_us,
          targetTrackId: null,
          resolution: null,
          snapUs: null,
        };
        interactionRef.current = next;
        setInteraction(next);
        canvas.style.cursor = "grabbing";
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
            originalStartUs: caption.start_us,
            originalEndUs: caption.end_us,
            targetStartUs: caption.start_us,
            targetEndUs: caption.end_us,
          };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "grabbing";
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
        startY: y,
        currentX: x + view.scrollX,
        currentY: y,
      };
      interactionRef.current = next;
      setInteraction(next);
      canvas.style.cursor = "crosshair";
    },
    [view.rulerHeight, view, onSeek, clipRects, clips, captionRects, captions, setSelection, selection, totalUs, canvasSize.width, canvasSize.height, trackRows],
  );

  const handleCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
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
          // 剪映式拖拽：片段 1:1 跟随鼠标，拖动途中无吸附、无钳制、不跳格；
          // 同步解析落点（预览 + 松手提交共用 resolveMoveTarget）。
          const deltaUs = ((x - active.startX) / pps) * 1_000_000;
          const targetStartUs = Math.max(0, active.startUs + deltaUs);
          const step: MoveInteraction = { ...active, currentX: x, currentY: y, targetStartUs };
          const { targetTrackId, pointerRatio } = resolveDragTargeting(step);
          const resolution = clips.find((c) => c.clip_id === active.clipId)
            ? resolveMoveTarget(
                clips,
                clips.find((c) => c.clip_id === active.clipId)!,
                targetStartUs,
                targetTrackId ?? undefined,
                pointerRatio,
              )
            : null;
          const next: TimelineInteraction = {
            ...step,
            targetTrackId,
            resolution,
            snapUs: null,
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
                ...gridSnapCandidates(view, totalUs, frameRate),
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
        if (active.kind === "trim") {
          const clip = clips.find((c) => c.clip_id === active.clipId);
          if (clip) {
            const deltaUs = ((x - active.startX) / pps) * 1_000_000;
            const threshold = (SNAP_PX / pps) * 1_000_000;
                const candidates = prefs.snappingEnabled
                  ? [
                      ...snapCandidates(clipRects, activePlayheadStore.get(), active.clipId),
                      ...gridSnapCandidates(view, totalUs, frameRate),
                    ]
                  : [];
            let targetStartUs = active.targetStartUs;
            let targetEndUs = active.targetEndUs;
            let snapUs: number | null = null;
            // 后端约束：修剪范围必须 ⊆ 当前片段源区间（只许收缩，不允许向外扩），
            // 因此两端都钳制回 [originalStartUs, originalEndUs]。
            if (active.edge === "left") {
              const rawStart = Math.max(
                active.originalStartUs,
                Math.min(active.originalEndUs - MIN_CLIP_US, active.originalStartUs + deltaUs),
              );
              const visualEdge = clip.timeline_start_us + (rawStart - active.originalStartUs);
              const snapped = snapValue(visualEdge, candidates, threshold);
              targetStartUs = Math.max(
                active.originalStartUs,
                Math.min(
                  active.originalEndUs - MIN_CLIP_US,
                  active.originalStartUs + (snapped - clip.timeline_start_us),
                ),
              );
              snapUs = Math.abs(snapped - visualEdge) > 1 ? snapped : null;
            } else {
              const rawEnd = Math.min(
                active.originalEndUs,
                Math.max(active.originalStartUs + MIN_CLIP_US, active.originalEndUs + deltaUs),
              );
              const visualEdge = clip.timeline_end_us + (rawEnd - active.originalEndUs);
              const snapped = snapValue(visualEdge, candidates, threshold);
              targetEndUs = Math.min(
                active.originalEndUs,
                Math.max(
                  active.originalStartUs + MIN_CLIP_US,
                  active.originalEndUs + (snapped - clip.timeline_end_us),
                ),
              );
              snapUs = Math.abs(snapped - visualEdge) > 1 ? snapped : null;
            }
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
            const deltaUs = ((x - active.startX) / pps) * 1_000_000;
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
            const deltaUs = ((x - active.startX) / pps) * 1_000_000;
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
    [view, onSeek, clipRects, clips, activePlayheadStore, prefs.snappingEnabled, totalUs, frameRate, canvasSize.width, canvasSize.height, trackRows, resolveDragTargeting],
  );

  // Double-click the ruler → fit the whole timeline into the viewport (Round 5).
  const fitToContent = useCallback(() => {
    setView((v) => ({
      ...v,
      pixelsPerSecond: fitZoomPps(totalUs, canvasSize.width, v.headerWidth),
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

  const finishInteraction = useCallback(() => {
    const active = interactionRef.current;
    const canvas = canvasRef.current;
    if (active) {
      if (active.kind === "move") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        if (clip && !isClipLocked(clip.clip_id)) {
          // 剪映式落位：直接采用拖动预览的解析结果（预览即结果，自动吸附）。
          // 预览缺失（如指针未移动过）时按松手位置补算一次。
          const dragged = clipRects.find((r) => r.clip.clip_id === clip.clip_id);
          const pointerRatio =
            dragged && dragged.width > 0
              ? Math.max(0, Math.min(1, (lastPointerRef.current?.x ?? dragged.x) - dragged.x) / dragged.width)
              : 0;
          const step: MoveInteraction = {
            ...active,
            currentX: lastPointerRef.current?.x ?? active.currentX,
            currentY: lastPointerRef.current?.y ?? active.currentY,
          };
          const { targetTrackId, pointerRatio: ratio } = resolveDragTargeting(step);
          const resolution =
            active.resolution ??
            resolveMoveTarget(clips, clip, active.targetStartUs, targetTrackId ?? undefined, pointerRatio || ratio);
          const ops: TimelinePatchOperation[] = [
            ...(resolution.displaced
              ? [
                  {
                    op: "position_clip" as const,
                    clip_id: resolution.displaced.clipId,
                    timeline_start_us: Math.round(resolution.displaced.startUs),
                    track_id: resolution.displaced.trackId,
                  },
                ]
              : []),
            {
              op: "position_clip" as const,
              clip_id: clip.clip_id,
              timeline_start_us: Math.round(resolution.startUs),
              ...(resolution.trackId !== clip.track_id ? { track_id: resolution.trackId } : {}),
            },
          ];
          const moved = resolution.startUs !== clip.timeline_start_us || resolution.trackId !== clip.track_id;
          if (moved || resolution.displaced) {
            // 提交态：片段保持渲染在目标位置，直到文档更新（消除松手回弹）。
            setPendingKeep({
              clipId: clip.clip_id,
              trackId: resolution.trackId,
              startUs: Math.round(resolution.startUs),
              displaced: resolution.displaced
                ? {
                    clipId: resolution.displaced.clipId,
                    trackId: resolution.displaced.trackId,
                    startUs: Math.round(resolution.displaced.startUs),
                  }
                : undefined,
            });
            void onPatch(
              ops,
              resolution.mode === "swap"
                ? "交换片段位置"
                : resolution.trackId !== clip.track_id
                  ? "移动片段"
                  : clip.asset_kind === "audio"
                    ? "移动音频片段"
                    : "移动片段",
            );
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
      } else if (active.kind === "trim") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        const startChanged = Math.abs(active.targetStartUs - active.originalStartUs) >= 1000;
        const endChanged = Math.abs(active.targetEndUs - active.originalEndUs) >= 1000;
        if (clip && (startChanged || endChanged)) {
          void onPatch(
            [
              {
                op: "trim_clip",
                clip_id: clip.clip_id,
                source_start_us: Math.round(active.targetStartUs),
                source_end_us: Math.round(active.targetEndUs),
              },
            ],
            "修剪片段",
          );
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
        if (rect.width >= 4 && rect.height >= 4) {
          // Marquee rect is content-space; compare against content-space rects.
          const ids = clipsInRect(rect, contentClipRects);
          // T13 参照：⇧ 加选——并入框选前的旧选区（旧选区是 clips 才可并）。
          const prev = shiftClickRef.current && selection?.kind === "clips" ? selection.ids : [];
          const merged = Array.from(new Set([...prev, ...ids]));
          setSelection(merged.length > 0 ? { kind: "clips", ids: merged } : null);
        } else {
          // Plain click on empty area → move the playhead there (Round 4)，
          // 寻址同样钳制在素材终点内。
          const viewportX = active.currentX - view.scrollX;
          onSeek?.(clampRulerTime(xToTime(viewportX, view)));
          if (!shiftClickRef.current) setSelection(null);
        }
      }
    }
    interactionRef.current = null;
    setInteraction(null);
    lastPointerRef.current = null;
    // 松手必须退出擦洗态，旋钮才会从实心变回空心（参照 PlayheadKnob: 按住实心、松开空心）。
    // 此前只在 handleRulerPinUp 里复位，画布内的拖动路径没有复位点，
    // 于是旋钮一旦变实心就再也不回去了（或如实测那样全程空心）。
    rulerScrubbingRef.current = false;
    setScrubbing(false);
    if (canvas) canvas.style.cursor = "default";
    // 依赖里含 clips：文档更新（补丁生效）后本回调重建，但 pendingKeep 已在
    // 下面的 effect 中消费完毕，不会残留。
  }, [clips, captions, clipRects, contentClipRects, onPatch, setSelection, onSeek, view.scrollX, resolveDragTargeting]);

  // Finish the interaction even when the pointer leaves the canvas mid-drag.
  const hasInteraction = interaction !== null;
  useEffect(() => {
    if (!hasInteraction) return;
    const handleWindowMouseUp = () => finishInteraction();
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => window.removeEventListener("mouseup", handleWindowMouseUp);
  }, [hasInteraction, finishInteraction]);

  // 拖拽期间把 mousemove 提升到 window：指针扫过左栏/滚出画布边缘时跟随不中断。
  useEffect(() => {
    if (!hasInteraction) return;
    const handleWindowMove = (event: MouseEvent) => {
      handleCanvasMouseMove(event as unknown as React.MouseEvent<HTMLCanvasElement>);
    };
    window.addEventListener("mousemove", handleWindowMove);
    return () => window.removeEventListener("mousemove", handleWindowMove);
  }, [hasInteraction, handleCanvasMouseMove]);

  // Round 4: edge auto-scroll while dragging (ported from OpenCut classic's
  // use-edge-auto-scroll pattern). Each frame, if the pointer sits within the
  // edge zone, advance scrollX and shift the drag targets by the same delta so
  // the ghost follows the content point under the cursor.
  useEffect(() => {
    if (!interaction) return;
    if (!["move", "group-move", "trim", "caption-trim", "marquee"].includes(interaction.kind)) return;
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
                targetStartUs: Math.max(0, active.targetStartUs + deltaUs),
                startUs: active.startUs + deltaUs,
              };
              // 滚动改变了片段在视口中的位置：按平移后的 targetStartUs
              // 重算落点预览，保证预览与内容点始终对齐。
              const draggedClip = clips.find((c) => c.clip_id === active.clipId);
              if (draggedClip) {
                const { targetTrackId, pointerRatio } = resolveTargetingRef.current(
                  adjusted as MoveInteraction,
                );
                adjusted = {
                  ...(adjusted as MoveInteraction),
                  targetTrackId,
                  resolution: resolveMoveTarget(
                    clips,
                    draggedClip,
                    adjusted.targetStartUs,
                    targetTrackId ?? undefined,
                    pointerRatio,
                  ),
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
            } else if (active.kind === "trim") {
              adjusted = {
                ...active,
                originalStartUs: active.originalStartUs + deltaUs,
                originalEndUs: active.originalEndUs + deltaUs,
                targetStartUs: active.targetStartUs + deltaUs,
                targetEndUs: active.targetEndUs + deltaUs,
              };
            } else if (active.kind === "caption-trim") {
              adjusted = {
                ...active,
                originalStartUs: active.originalStartUs + deltaUs,
                originalEndUs: active.originalEndUs + deltaUs,
                targetStartUs: active.targetStartUs + deltaUs,
                targetEndUs: active.targetEndUs + deltaUs,
              };
            } else if (active.kind === "marquee") {
              adjusted = { ...active, currentX: active.currentX + deltaPx };
            }
            interactionRef.current = adjusted;
            setInteraction(adjusted);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [interaction, canvasSize.width, totalUs]);

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
        setSelection({ kind: "clip", id: clipId });
        setContextMenu({ x, y, target: { kind: "clip", clipId }, timeUs });
      } else if (captionId) {
        setSelection({ kind: "caption", id: captionId });
        setContextMenu({ x, y, target: { kind: "caption", captionId }, timeUs });
      } else {
        setContextMenu({ x, y, target: { kind: "empty" }, timeUs });
      }
    },
    [view, transitionRects, clipRects, captionRects, setSelection],
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

  const readAssetId = (event: React.DragEvent<HTMLElement>) =>
    event.dataTransfer.getData("application/x-vortex-cut-asset");
  const allowDrop = (event: React.DragEvent<HTMLElement>, index: number) => {
    if (!readAssetId(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropIndex(index);
  };
  const handleDrop = (event: React.DragEvent<HTMLElement>, index: number) => {
    event.preventDefault();
    const assetId = readAssetId(event);
    setDropIndex(null);
    if (!assetId) return;
    // 落点意图：轨道行 id（App 校验类型兼容）；**任何空白区（轨行之外）= "new"（自动建轨）**——
    // 参照 Timeline.tsx:361-370 的 laneAt：落点超出全部轨行即 newTrack:true。原实现只有
    // 上部空白 = new，拖到 A1 之下的大片空白只追加主轨，用户指认「自动加轨没了」。
    const coords = canvasCoords(event);
    const row = coords ? trackRowAt(trackRows, coords.x, coords.y) : null;
    let intent: string | "new" | undefined;
    if (row) {
      intent = row.track.id;
    } else if (coords) {
      intent = "new";
    }
    onDropAsset(assetId, index, intent);
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
  const anySelectedLocked = selectedClips.some((c) => isClipLocked(c.clip_id));
  const allSelectedLocked =
    selectedClips.length > 0 && selectedClips.every((c) => isClipLocked(c.clip_id));
  const clipLocked = Boolean(
    selectedClip && isClipLocked(selectedClip.clip_id),
  );
  const captionLocked = Boolean(
    selectedCaption?.source_clip_id &&
      isClipLocked(selectedCaption.source_clip_id),
  );

  // ── 自由定位：向前/向后移动 = 逐帧微调（同轨无重叠钳制） ──────────────────
  const frameUs = Math.max(1, Math.round(1_000_000 / (frameRate || 30)));
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
  const nudge = (deltaUs: number) => {
    if (!selectedClip) return;
    const target = nudgeTarget(selectedClip, deltaUs);
    if (target === null) return;
    void onPatch(
      [{ op: "position_clip", clip_id: selectedClip.clip_id, timeline_start_us: target }],
      selectedClip.track_id === "V1" ? "移动片段" : "移动音频片段",
    );
  };

  return (
    <section className="timeline-pane" aria-label="时间线">
      {/* Toolbar (DOM) */}
      <div className="timeline-toolbar">
        {/* 参照工具栏最左侧是模式切换（选择 / 分割）+ 1px 竖分隔（Timeline.tsx:4081-4084）。
            主操作在最靠左、其余工具随后，这是时间线工具栏的统一阅读起点。
            我们此前没有这个入口，工具栏从「添加轨道」开始。 */}
        <ModePicker mode={scrubMode} onPick={setScrubMode} />
        <span className="toolbar-sep" aria-hidden="true" />
        <IconButton label="撤销" disabled={!canUndo} onClick={onUndo}>
          <Undo2 />
        </IconButton>
        <IconButton label="重做" disabled={!canRedo} onClick={onRedo}>
          <Redo2 />
        </IconButton>
        <span className="toolbar-sep" aria-hidden="true" />
        {/* T2 参照次序（Timeline.tsx:4075-4225）：模式｜分隔｜撤销/重做｜分割｜细移｜中段状态｜
            开关/缩放。锁定入口收进右键菜单（每片段语义更贴切）；ours 独有的「添加轨道」放最右。 */}
        <IconButton
          label="向前移动"
          title="向前移动一帧（自由定位，拖动片段可留空隙）"
          disabled={!canNudge(-frameUs)}
          onClick={() => nudge(-frameUs)}
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          label="向后移动"
          title="向后移动一帧（自由定位，拖动片段可留空隙）"
          disabled={!canNudge(frameUs)}
          onClick={() => nudge(frameUs)}
        >
          <ChevronRight />
        </IconButton>
        <IconButton
          label="拆分片段"
          disabled={!selectedClip || clipLocked || selectedClip.asset_kind !== "video"}
          onClick={() =>
            selectedClip &&
            void onPatch(
              [
                {
                  op: "split_clip",
                  clip_id: selectedClip.clip_id,
                  source_time_us:
                    selectedClip.source_start_us! +
                    Math.floor((selectedClip.source_end_us! - selectedClip.source_start_us!) / 2),
                },
              ],
              "拆分片段",
            )
          }
        >
          <Scissors />
        </IconButton>
        <IconButton
          label="删除所选"
          disabled={!selection || (selectedClips.length === 0 && !selectedCaption)}
          onClick={() => {
            if (selectedCaption) {
              void onPatch(
                [{ op: "remove_caption", caption_id: selectedCaption.caption_id }],
                "删除字幕",
              );
            } else if (selectedClips.length > 0) {
              const deletable = selectedClips.filter((c) => !isClipLocked(c.clip_id));
              if (deletable.length > 0) {
                void onPatch(
                  deletable.map((c) => ({
                    op: "remove_clip" as const,
                    clip_id: c.clip_id,
                  })),
                  "删除片段",
                );
              }
            }
          }}
        >
          <Trash2 />
        </IconButton>
        {/* 中段状态区（参照 Timeline.tsx:4130-4168）：工具栏中央留给状态，
            不把「正在应用 / 出错了」放进工具堆里，否则读起来像一个按钮。
            我们暂无长任务态，先占位——三段工具围绕它分布，这是参照的阅读节奏。 */}
        <div className="toolbar-status" aria-live="polite" />
        <span className="toolbar-sep" aria-hidden="true" />
        <button
          className="icon-btn"
          title="磁吸吸附：拖动时对齐片段边缘、播放头与网格"
          aria-label="磁吸吸附"
          aria-pressed={prefs.snappingEnabled}
          onClick={toggleSnapping}
        >
          <Magnet />
        </button>
        <div className="timeline-zoom">
          {/* 全局预览缩放（剪映 Shift+Z）：无论当前放大/缩小到什么程度，
              一键把所有轨道素材缩放到最合适的大小。 */}
          <button
            className="icon-btn"
            title="全局预览缩放（Shift+Z）：缩放到最合适的大小"
            aria-label="全局预览缩放"
            aria-keyshortcuts="Shift+Z"
            onClick={fitToContent}
          >
            <ScanSearch />
          </button>
          <button
            aria-label="缩小时间线"
            onClick={() =>
              setPpsAnchored(Math.max(ZOOM_MIN_PPS, view.pixelsPerSecond / 1.2))
            }
          >
            <Minus />
          </button>
          {/* 已走过部分点亮的轨道（对齐 OpenFilm 的 .tl-zoom）：把当前百分比
              经 --pos 传给 CSS，轨道用 accent 渐变到 --pos 处切换成灰。
              原来轨道是纯灰，看不出"当前处于整条缩放区间的哪一段"。 */}
          <input
            className="timeline-zoom-slider"
            type="range"
            aria-label="时间线缩放"
            min={0}
            max={100}
            step={1}
            value={Math.round(ppsToZoomPct(view.pixelsPerSecond))}
            style={{ "--pos": Math.round(ppsToZoomPct(view.pixelsPerSecond)) / 100 } as React.CSSProperties}
            onChange={(event) =>
              setPpsAnchored(zoomPctToPps(Number(event.target.value)))
            }
          />
          <button
            aria-label="放大时间线"
            onClick={() =>
              setPpsAnchored(Math.min(ZOOM_MAX_PPS, view.pixelsPerSecond * 1.2))
            }
          >
            <Plus />
          </button>
        </div>
        {/* 显示设置（剪映"…"菜单）：轨道高度 + 波形占比 */}
        <div className="timeline-display-wrap" ref={displayMenuRef}>
          <IconButton
            label="时间线显示设置"
            expanded={displayMenuOpen}
            onClick={() => setDisplayMenuOpen((value) => !value)}
          >
            <MoreHorizontal />
          </IconButton>
          {displayMenuOpen && (
            <div className="timeline-display-menu" role="menu" aria-label="时间线显示设置">
              <label className="display-row">
                <span>轨道高度</span>
                <input
                  className="track-height-slider display-slider"
                  type="range"
                  aria-label="轨道高度"
                  min={40}
                  max={128}
                  step={4}
                  value={prefs.trackHeight}
                  onChange={(event) =>
                    setPrefs((value) => ({ ...value, trackHeight: Number(event.target.value) }))
                  }
                />
              </label>
              <div className="display-row">
                <span>波形占比</span>
                <div className="ratio-group" role="group" aria-label="波形占比">
                  {([1, 0.6, 0.4] as const).map((ratio) => {
                    // 图标（剪映式）：小示波卡。选中 = 亮青实底卡 + 深色柱；
                    // 未选中 = 深色底 + 白描边小白卡 + 白色柱。柱高按档位比例。
                    const label = ratio === 1 ? "100%" : ratio === 0.6 ? "60%" : "40%";
                    const barHs = [5, 8, 6.5].map((h) => Math.max(1.5, h * ratio));
                    return (
                      <button
                        key={ratio}
                        className={`ratio-icon${prefs.waveformRatio === ratio ? " active" : ""}`}
                        title={`波形占比 ${label}`}
                        aria-label={`波形占比 ${label}`}
                        aria-pressed={prefs.waveformRatio === ratio}
                        onClick={() => setPrefs((value) => ({ ...value, waveformRatio: ratio }))}
                      >
                        <span className="ratio-icon-card" aria-hidden="true">
                          <i style={{ height: `${barHs[0]}px` }} />
                          <i style={{ height: `${barHs[1]}px` }} />
                          <i style={{ height: `${barHs[2]}px` }} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
        {/* T2：ours 独有的「添加轨道」放工具栏最右（参照三段之外的功能位）。 */}
        <div className="timeline-add-track-wrap">
          <IconButton
            label="添加轨道"
            expanded={addTrackMenuOpen}
            onClick={() => setAddTrackMenuOpen((value) => !value)}
          >
            <Plus />
          </IconButton>
          {addTrackMenuOpen && (
            <div className="timeline-add-track-menu" role="menu" aria-label="新增轨道">
              <button role="menuitem" onClick={() => { addTrack("video"); setAddTrackMenuOpen(false); }}>
                视频轨道
              </button>
              <button role="menuitem" onClick={() => { addTrack("text"); setAddTrackMenuOpen(false); }}>
                文本轨道
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Body: 冻结标尺（滚动区外，零抖动）+ 滚动区（轨道头列/封面条带/片段区）。
          标尺画布绝对定位覆盖滚动视口顶部（见 .timeline-ruler-pin），主画布仍是第一个 canvas。 */}
      {/* 时间线主体 + 右侧 44px 音频电平表（参照 ProjectView.tsx:4926/4995：
          电平表在时间线右缘独占一列，时间线内容 inset 掉 METERS_W）。
          我们此前只有一个 12px 的两点 VU，且在播放条里——与参照的位置和形态都不同。 */}
      <div className="timeline-body-row">
      <div className="timeline-body">
        <div ref={scrollRef} className="timeline-scroll" onScroll={onTimelineScroll}>
        {/* Left gutter (DOM)：每条轨道一个属性头
            [类型标识] [锁定] [隐藏(视频/文本)] [静音(视频/音频)] [独奏(视频/音频)] */}
        <div className="timeline-left" data-scrolled={view.scrollX > 0 ? "1" : undefined} style={{ width: view.headerWidth, height: contentHeight, position: "relative" }}>
          <div className="timeline-left-corner" style={{ height: view.rulerHeight }} />
          {trackRows.map((row) => {
            // 兼容旧文档/旧 core 的轨道 kind（visual→video、caption→text）。
            const rawKind: string = row.track.kind;
            const kind = rawKind === "visual" ? "video" : rawKind === "caption" ? "text" : rawKind;
            // 动态轨道：可上移/下移/删除。仅主视频轨 V1 与音频轨 A1 位置、
            // 数量固定；文本轨 C1 与其他轨一样动态（剪映式）。
            const isDynamic = row.track.id !== "V1" && row.track.id !== "A1";
            const dynamicTracks = trackRows.filter((item) => item.track.id !== "V1" && item.track.id !== "A1");
            const dynamicIndex = dynamicTracks.findIndex((item) => item.track.id === row.track.id);
            const dynamicCount = dynamicTracks.length;
            // 剪映式：轨道上没有素材时不显示属性开关（仅保留类型标识）。
            const hasClips = clips.some((clip) => clip.track_id === row.track.id);
            return (
              <div
                key={row.track.id}
                className="timeline-track-head"
                data-track-kind={kind}
                data-track-id={row.track.id}
                data-flag-cols={kind === "video" ? "4" : kind === "audio" ? "3" : "2"}
                data-lane-picked={trackRows.some(r => selection?.kind === "clip" && clips.some(c => c.clip_id === selection.id && c.track_id === row.track.id)) ? "1" : undefined}
                style={{ top: row.y, height: row.height }}
              >
                {/* 2026-11-11 对齐 OpenFilm 的 LaneMark（Timeline.tsx:295）：
                   轨道头左侧是**纯文字轨号**，没有图标、没有色块底、没有方块边框。
                   原来是「图标 + 轨号」的小徽章，在 119px 的头列里占了 30px，
                   且带一层与图标同色的小方框；参照软件里这一格只是个 10.5px
                   的灰字，左侧留白、右侧才是开关图标列。 */}
                <span className="timeline-track-badge" title={`${row.track.id} ${kind === "video" ? "视频" : kind === "text" ? "文本" : "音频"}轨道`}>
                  <small>{row.track.id}</small>
                </span>
                {/* T1 参照 Timeline.tsx:2780：badge 与开关之间是一条 4px 占位列（网格第 2 列） */}
                <span aria-hidden />
                {hasClips && (
                  <>
                    <button
                      className="track-flag"
                      aria-label={`锁定轨道 ${row.track.id}`}
                      aria-pressed={row.track.locked}
                      title="锁定轨道"
                      onClick={() => patchTrackFlags(row.track.id, { locked: !row.track.locked })}
                    >
                      {row.track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                    </button>
                    {kind !== "audio" && (
                      <button
                        className="track-flag"
                        aria-label={`隐藏轨道 ${row.track.id}`}
                        aria-pressed={row.track.hidden}
                        title="隐藏轨道（预览不渲染该轨内容）"
                        onClick={() => patchTrackFlags(row.track.id, { hidden: !row.track.hidden })}
                      >
                        {row.track.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    )}
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
                  </>
                )}
                {isDynamic && (
                  <span className="track-row-actions">
                    <button
                      aria-label={`上移轨道 ${row.track.id}`}
                      title="上移轨道"
                      disabled={dynamicIndex === 0}
                      onClick={() => moveTrack(row.track.id, dynamicIndex - 1)}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      aria-label={`下移轨道 ${row.track.id}`}
                      title="下移轨道"
                      disabled={dynamicIndex >= dynamicCount - 1}
                      onClick={() => moveTrack(row.track.id, dynamicIndex + 1)}
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      aria-label={`删除轨道 ${row.track.id}`}
                      title="删除轨道（其上片段一并删除，可撤销）"
                      onClick={() => void onPatch([{ op: "remove_track", track_id: row.track.id }], "删除轨道")}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="timeline-canvas-container"
          data-mode={scrubMode}
          style={{ flex: 1, position: "relative", height: contentHeight }}
          onWheel={handleWheel}
        >
          {/* T3 参照 Timeline.tsx:2090-2110：分割模式刀线，直写 DOM 防每 move 重渲。 */}
          <div ref={bladeRef} className="tl-blade-line" style={{ display: "none" }} aria-hidden="true" />
          <canvas
            ref={canvasRef}
            aria-label="时间线画布"
            // 可聚焦：点击时间线后键盘焦点落在画布上，Del/方向键等
            // 时间线快捷键（以事件目标判定作用域）才能生效。
            tabIndex={0}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={finishInteraction}
            onMouseLeave={handleCanvasMouseLeave}
            onDoubleClick={handleCanvasDoubleClick}
            onContextMenu={handleCanvasContextMenu}
            onDragOver={(event) => { event.preventDefault(); allowDrop(event, clips.length); }}
            onDrop={(event) => handleDrop(event, dropIndex ?? clips.length)}
            // relatedTarget 仍在画布内说明只是子区域切换，不清除落区高亮，避免 overlay 抖动。
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node && canvasRef.current?.contains(event.relatedTarget))) {
                setDropIndex(null);
              }
            }}
            onDragEnd={() => setDropIndex(null)}
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
          {/* 主轨封面入口（剪映式）：仅主轨一处，钉在 V1 轨道头列（与左侧
              图标区同高齐平——上方有字幕轨/动态视频轨时仍随 V1 行定位，
              不再写死标尺下方首行）；点击截取当前播放头画面设为项目封面。 */}
          {(() => {
            const mainRow = trackRowOf(trackRows, "V1");
            if (!mainRow) return null;
            return (
              <button
                className="timeline-cover-entry"
                style={{ top: mainRow.y + 2, height: mainRow.height - 4, width: view.headerWidth - 8 }}
                title={coverUrl ? "点击更换项目封面（截取当前播放头画面）" : "截取当前播放头画面设为项目封面"}
                onClick={() => onCaptureCover?.()}
              >
                {coverUrl ? <img src={coverUrl} alt="" /> : <ImagePlus size={13} />}
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
                  aria-label={`Clip ${index + 1} ${clip.asset_kind} ${formatTime(clip.timeline_end_us - clip.timeline_start_us)}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelection({ kind: "clip", id: clip.clip_id })}
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
                background: "rgba(0, 193, 205, 0.12)",
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span className="drop-hint">释放以追加到时间线</span>
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
              items={(() => {
                const target = contextMenu.target;
                const close = (fn: () => void) => () => { fn(); setContextMenu(null); };
                if (target.kind === "clip") {
                  const clip = clips.find((c) => c.clip_id === target.clipId);
                  if (!clip) return [];
                  const locked = isClipLocked(clip.clip_id);
                  const playheadNowUs = activePlayheadStore.get();
                  const speedFactor = (clip.speed_milli ?? 1000) / 1000;
                  const playheadSourceUs =
                    (clip.source_start_us ?? 0) + (playheadNowUs - clip.timeline_start_us) * speedFactor;
                  const canSplitAtPlayhead =
                    clip.asset_kind === "video" &&
                    !locked &&
                    playheadNowUs > clip.timeline_start_us + 1000 &&
                    playheadNowUs < clip.timeline_end_us - 1000 &&
                    playheadSourceUs > (clip.source_start_us ?? 0) + 1000 &&
                    playheadSourceUs < (clip.source_end_us ?? 0) - 1000;
                  return [
                    { id: "split", label: "在播放头处拆分", disabled: !canSplitAtPlayhead, hint: canSplitAtPlayhead ? undefined : locked ? "片段已锁定" : "播放头不在片段内或不可分割", onSelect: close(() => void onPatch([{ op: "split_clip", clip_id: clip.clip_id, source_time_us: Math.round(playheadSourceUs) }], "拆分片段")) },
                    { id: "copy", label: "复制", disabled: locked, hint: locked ? "片段已锁定" : undefined, onSelect: close(() => onCommand?.("timeline.copy")) },
                    { id: "lock", label: locked ? "解锁片段" : "锁定片段", onSelect: close(() => void onPatch([{ op: "set_clip_locked", clip_id: clip.clip_id, locked: !locked }], locked ? "解锁片段" : "锁定片段")) },
                    { id: "sep1", separator: true },
                    { id: "del", label: "删除片段", danger: true, disabled: locked, hint: locked ? "片段已锁定" : undefined, onSelect: close(() => void onPatch([{ op: "remove_clip", clip_id: clip.clip_id }], "删除片段")) },
                    { id: "sep2", separator: true },
                    { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  ];
                }
                if (target.kind === "caption") {
                  return [
                    { id: "del", label: "删除字幕", danger: true, onSelect: close(() => void onPatch([{ op: "remove_caption", caption_id: target.captionId as never }], "删除字幕")) },
                    { id: "sep", separator: true },
                    { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  ];
                }
                if (target.kind === "transition") {
                  return [
                    { id: "del", label: "删除转场", danger: true, onSelect: close(() => void onPatch([{ op: "remove_transition", transition_id: target.transitionId as never }], "删除转场")) },
                  ];
                }
                return [
                  { id: "paste", label: "粘贴到播放头", onSelect: close(() => onCommand?.("timeline.paste")) },
                  { id: "sep1", separator: true },
                  { id: "seek", label: "定位播放头", onSelect: close(() => onSeek?.(contextMenu.timeUs)) },
                  { id: "clear", label: "取消选择", onSelect: close(() => setSelection(null)) },
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
          onMouseMove={handleRulerPinMove}
          onMouseDown={handleRulerPinDown}
          onMouseUp={handleRulerPinUp}
          onMouseLeave={handleRulerPinLeave}
          onDoubleClick={handleRulerPinDoubleClick}
        />
        {/* 播放头覆盖层（A06）：与固定标尺同坐标系（timeline-body 原点 +
            2*headerWidth 偏移），预览每帧直写 store——播放期间零主画布重绘。 */}
        {/* 标记行：浮在轨道区顶部，不占布局高度（OpenFilm 同款做法），
            因此增删标记不会让轨道跳动。只在有标记时渲染。 */}
        <MarkerLane
          projectId={document?.project_id ?? ""}
          view={{ ...view, headerWidth: view.headerWidth * 2 }}
          totalUs={totalUs}
          playheadUs={activePlayheadStore.get()}
          snapUs={valueUs => (prefs.snappingEnabled ? snapValue(valueUs, [...snapCandidates(clipRects, activePlayheadStore.get(), new Set()), ...gridSnapCandidates(view, totalUs, frameRate)], (SNAP_PX / view.pixelsPerSecond) * 1_000_000) : valueUs)}
          onGuide={guide => setMarkerGuide(guide)}
        />
        {/* 时间区间选取（Shift + 标尺拖动）：只做视觉，不接操作。
            标尺段实心 + 贯穿全线的淡填充 + 两端把手，Shift 已由标尺拖动处理。 */}
        {timeRange && (() => {
          const rangeView = { ...view, headerWidth: view.headerWidth * 2 };
          const x1 = timeToX(timeRange.startUs, rangeView);
          const x2 = timeToX(timeRange.endUs, rangeView);
          const left = Math.min(x1, x2);
          const width = Math.abs(x2 - x1);
          return (
            <>
              <div className="timeline-range-band" style={{ transform: `translateX(${left}px)`, width: `${width}px` }} aria-hidden="true">
                <span className="timeline-range-ruler" />
                <span className="timeline-range-edge start" />
                <span className="timeline-range-edge end" />
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
            style={{ transform: `translateX(${timeToX(markerGuide.timeUs, { ...view, headerWidth: view.headerWidth * 2 })}px)`, color: markerGuide.color, opacity: markerGuide.held ? 1 : .55 }}
            aria-hidden="true"
          />
        )}
        <TimelinePlayheadLayer
          store={activePlayheadStore}
          view={{ ...view, headerWidth: view.headerWidth * 2 }}
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
