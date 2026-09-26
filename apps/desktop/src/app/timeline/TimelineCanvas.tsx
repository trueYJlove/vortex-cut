import { editorPerf } from "../preview/perf-metrics.js";
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
  Lock,
  LockOpen,
  Magnet,
  Minus,
  MoreHorizontal,
  Music,
  ImagePlus,
  Plus,
  Redo2,
  ScanSearch,
  Scissors,
  Trash2,
  Type as TypeIcon,
  Undo2,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import type {
  TimelineCaption,
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
  TimelineTrack,
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
  return (
    <button
      className="icon-btn"
      title={title ?? label}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
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
  const count = quantizeFrameCount(Math.round(((timelineDurUs / 1_000_000) * pps) / 44));
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
  const frameSecs = 1 / Math.max(1, frameRate);
  // 目标：主刻度间隔 ≥ 90px。候选间隔（秒）：帧级 → 秒级 → 分钟级逐级放大，
  // 取第一个满足的；f 标签只在帧级间隔（< 1s）时出现。
  const candidates: Array<{ secs: number; majorEvery: number; frame?: boolean }> = [
    { secs: frameSecs, majorEvery: 2, frame: true },
    { secs: 2 * frameSecs, majorEvery: 5, frame: true },
    { secs: 0.5, majorEvery: 5 },
    { secs: 1, majorEvery: 5 },
    { secs: 2, majorEvery: 5 },
    { secs: 5, majorEvery: 4 },
    { secs: 10, majorEvery: 5 },
    { secs: 30, majorEvery: 6 },
    { secs: 60, majorEvery: 5 },
    { secs: 300, majorEvery: 5 },
    { secs: 600, majorEvery: 6 },
    { secs: 1800, majorEvery: 6 },
    { secs: 3600, majorEvery: 5 },
  ];
  const minMajorPx = 90;
  const pick =
    candidates.find((c) => c.secs * pps * c.majorEvery >= minMajorPx) ??
    candidates[candidates.length - 1];
  const intervalUs = pick.secs * 1_000_000;
  const majorUs = intervalUs * pick.majorEvery;
  const pxToUs = 1_000_000 / pps;
  // 可视时间范围（含左右余量），再对齐到主刻度边界。
  const viewStartUs = Math.max(0, (scrollX - headerWidth) * pxToUs - majorUs);
  const viewEndUs = (scrollX - headerWidth + viewportWidth) * pxToUs + majorUs;
  // 标尺不越过素材终点：有素材时主刻度只生成到 totalUs；
  // 空时间线（totalUs=0）保持整宽标尺，便于首次拖入素材。
  const rulerEndUs = totalUs > 0 ? Math.min(viewEndUs, totalUs) : viewEndUs;
  const firstMajor = Math.floor(viewStartUs / majorUs);
  const lastMajor = Math.floor(rulerEndUs / majorUs);
  const ticks: TickMark[] = [];
  for (let m = firstMajor; m <= lastMajor; m += 1) {
    const majorUsValue = m * majorUs;
    if (majorUsValue < 0) continue;
    const majorX = headerWidth + (majorUsValue / 1_000_000) * pps - scrollX;
    // 主刻度：竖线 + 剪映式 "|时间" 标签；t=0 显示 00:00，帧级显示 Nf。
    const majorLabel = pick.frame
      ? m === 0
        ? formatRulerTime(0)
        : `${m * pick.majorEvery}f`
      : formatRulerTime(majorUsValue);
    ticks.push({ x: majorX, label: majorLabel, major: true });
    // 小刻度：主刻度之间均分，长度为主刻度的一半。
    for (let s = 1; s < pick.majorEvery; s += 1) {
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
const CLIP_RADIUS = 3;
/** 片段在轨道行内的上下留白（px）——相邻轨道片段之间形成剪映式缝隙。 */
const CLIP_ROW_INSET = 2;
/** 片段配色（剪映取色）：名称条与原声带底色 rgb(0,77,82)，波形 rgb(0,119,126)。
 *  选中不变色——只叠加白色描边 + 四角手柄。 */
const CLIP_PALETTE = {
  video: {
    body: "#10161b",
    header: "#004d52",
    band: "#004d52",
    wave: "#00777e",
  },
  audio: {
    body: "#0e3058",
    header: "#1d4d8f",
    band: "#0e4888",
    wave: "rgb(14, 129, 179)",
  },
} as const;

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
const RULER_DEAD_BG = "#181c1f"; // 素材终点外的死区底色（= 没有轨道的地方）
const RULER_BG_TOP = "#222629"; // 标尺带渐变顶（中性灰，衔接工具栏 #181c1f 与轨道 #202427）
const RULER_BG_BOTTOM = "#1a1e21"; // 标尺带渐变底
const RULER_END_EDGE = "#3d4a5c"; // 素材终点竖标线
const RULER_TICK_MAJOR = "#8a95a5";
const RULER_TICK_MINOR = "#596372";
const RULER_LABEL_COLOR = "#b9c4d1";
const RULER_LABEL_FONT = "10px sans-serif";
const RANGE_BAR_TOP = "#14b58f"; // 素材范围条渐变
const RANGE_BAR_BOTTOM = "#3fe0bd";
const HOVER_CHIP_BG = "rgba(9, 12, 24, 0.88)";
const HOVER_CHIP_EDGE = "rgba(37, 211, 172, 0.45)";
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
  },
) {
  const { bandX, width, height, xOffset, ticks, hoverUs, hoverText, contentRange, xAt } = opts;
  const endX = Math.max(bandX, Math.min(width, opts.endX));

  // 带底：纵向微渐变；素材终点外压平为死区，并以竖标线收尾。
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, RULER_BG_TOP);
  grad.addColorStop(1, RULER_BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(bandX, 0, Math.max(0, endX - bandX), height);
  if (endX < width) {
    ctx.fillStyle = RULER_DEAD_BG;
    ctx.fillRect(endX, 0, width - endX, height);
    ctx.strokeStyle = RULER_END_EDGE;
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
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
    }
  }

  // 刻度：主刻度贯通、小刻度下半段短线；一律不越过素材终点。
  ctx.textBaseline = "bottom";
  ctx.font = RULER_LABEL_FONT;
  for (const tick of ticks) {
    const tickX = Math.round(tick.x + xOffset) + 0.5;
    if (tickX < bandX - 1 || tickX > endX + 1) continue;
    ctx.strokeStyle = tick.major ? RULER_TICK_MAJOR : RULER_TICK_MINOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tickX, tick.major ? 0 : Math.round(height * 0.45) + 0.5);
    ctx.lineTo(tickX, height);
    ctx.stroke();
  }
  // 主刻度时间标签（紧贴刻度右侧，后画避免被刻度线压住）。
  ctx.fillStyle = RULER_LABEL_COLOR;
  for (const tick of ticks) {
    if (!tick.major) continue;
    const tickX = Math.round(tick.x + xOffset) + 0.5;
    if (tickX < bandX - 1 || tickX > endX + 1) continue;
    ctx.fillText(tick.label, tickX + 5, height - 2);
  }

  // 内容范围条：标尺顶 3px 圆角渐变条（素材最左/最右为界，剪映式）。
  if (contentRange) {
    const barLeft = Math.max(bandX, xAt(contentRange.fromUs));
    const barRight = Math.min(endX, xAt(contentRange.toUs));
    if (barRight - barLeft > 2) {
      const barGrad = ctx.createLinearGradient(0, 0, 0, 3);
      barGrad.addColorStop(0, RANGE_BAR_TOP);
      barGrad.addColorStop(1, RANGE_BAR_BOTTOM);
      ctx.fillStyle = barGrad;
      ctx.beginPath();
      ctx.roundRect(barLeft, 0, barRight - barLeft, 3, 1.5);
      ctx.fill();
    }
  }

  // 悬停时间胶囊（圆角底 + 描边，保证任何刻度上都可读）。
  if (hoverUs !== null && hoverUs !== undefined) {
    const hx = xAt(hoverUs);
    if (hx >= bandX && hx <= endX) {
      ctx.font = "10px Consolas, monospace";
      const chipW = ctx.measureText(hoverText).width + 10;
      const chipH = Math.min(14, Math.max(10, height - 2));
      const cx = hx > width - chipW - 10 ? hx - chipW - 4 : hx + 4;
      const cy = Math.max(1, height - chipH - 1);
      ctx.fillStyle = HOVER_CHIP_BG;
      ctx.strokeStyle = HOVER_CHIP_EDGE;
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
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fillRect(view.headerWidth, trackY, trackWidth, SCROLLBAR_HEIGHT_PX - 1);
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
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
  ctx.fillStyle = "#181c1f";
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
  });

  // Track backgrounds（素材未覆盖部分：视频/文本轨 #202427、音频轨 #24272b）。
  for (const row of trackRows) {
    const fill =
      row.track.kind === "audio"
        ? "#24272b"
        : "#202427";
    ctx.fillStyle = fill;
    ctx.fillRect(view.headerWidth, row.y, Math.max(0, contentEndX - view.headerWidth), row.height);
  }

  // Grid lines between tracks（同样截断在素材终点）。
  ctx.strokeStyle = "#14171a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(view.headerWidth, view.rulerHeight);
  ctx.lineTo(contentEndX, view.rulerHeight);
  for (const row of trackRows) {
    ctx.moveTo(view.headerWidth, row.y + row.height);
    ctx.lineTo(contentEndX, row.y + row.height);
  }
  ctx.stroke();

  // Ruler hover guide (Round 5)：标尺带下方的整高淡引导线（时间胶囊在标尺面内）。
  if (rulerHoverUs !== null && rulerHoverUs !== undefined) {
    const hx = timeToX(rulerHoverUs, view);
    if (hx >= view.headerWidth && hx <= Math.min(width, contentEndX)) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
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
    const palette = isAudioClip ? CLIP_PALETTE.audio : CLIP_PALETTE.video;
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
        const frameCount = quantizeFrameCount(Math.round(((clipDurUs / 1_000_000) * view.pixelsPerSecond) / 44));
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
          ctx.fillStyle = palette.band;
          ctx.fillRect(rect.x, band.top, rect.width, band.height);
        }
        const baseline = band.top + band.height;
        // 纯音频片段固定 100% 高度（不随轨道高度/波形占比设置变化，剪映式）；
        // 视频片段原声带按占比档位缩放。
        const maxH = Math.max(2, band.height * (isAudioClip ? 1 : Math.max(0.1, Math.min(1, waveformRatio ?? 0.4))));
        // 剪映「一体感」来源：整条波形是一块连续剪影（单 path 填充 + 顶边
        // 二次曲线），而不是一排 fillRect 密柱。密柱即使高度连续，边缘仍是
        // 折线/接缝，读起来会“碎”。
        const drawLeft = rect.x + 1;
        const pxWidth = Math.max(1, Math.floor(rect.width - 2));
        const shapeAmp = (v: number): number => {
          const gained = Math.min(1, Math.max(0, v) * WAVEFORM_GAIN);
          return Math.pow(gained, 0.72);
        };
        // 剪映「毛刺」感：保留高频瞬态——像素内取 max，且不做邻域抹平。
        // 线性插值 + 平滑会把尖刺吃掉，只剩光滑山脊。
        const heights: number[] = new Array(pxWidth);
        for (let px = 0; px < pxWidth; px += 1) {
          const t0 = pxWidth === 1 ? 0 : px / pxWidth;
          const t1 = pxWidth === 1 ? 1 : (px + 1) / pxWidth;
          // 该像素覆盖的 peaks 区间取 max（瞬态尖刺保留为「毛刺」）
          const i0 = Math.min(peaks.length - 1, Math.floor(t0 * peaks.length));
          const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.ceil(t1 * peaks.length) - 1));
          let peak = 0;
          for (let k = i0; k <= i1; k += 1) {
            const v = shapeAmp(peaks[k]);
            if (v > peak) peak = v;
          }
          heights[px] = maxH * peak;
        }
        // 单路径剪影 + 纯折线顶边：微尖刺全部保留（无二次曲线、无平滑）。
        const topY = (px: number): number => baseline - Math.max(1, heights[px]);
        const topX = (px: number): number => drawLeft + px;
        ctx.beginPath();
        ctx.moveTo(topX(0), baseline);
        ctx.lineTo(topX(0), topY(0));
        for (let px = 1; px < pxWidth; px += 1) {
          ctx.lineTo(topX(px), topY(px));
        }
        ctx.lineTo(topX(pxWidth - 1), baseline);
        ctx.closePath();
        ctx.fillStyle = palette.wave;
        ctx.fill();
        // 偶发峰值点：2px 橙点落在剪影顶端（点缀，不切开主体）。
        ctx.fillStyle = "rgb(233, 150, 68)";
        for (let px = 2; px < pxWidth - 2; px += 1) {
          const h = heights[px];
          const isLocalPeak =
            h / maxH > 0.55 &&
            h >= heights[px - 1] && h >= heights[px + 1] &&
            h > heights[px - 2] + maxH * 0.06 &&
            h > heights[px + 2] + maxH * 0.06;
          if (isLocalPeak) {
            ctx.fillRect(topX(px), topY(px), 1.5, Math.min(2.5, h));
          }
        }
        // 基线：带底 1px 亮线（压在剪影下沿，不抢一体感）。
        ctx.fillStyle = "rgba(150, 224, 221, 0.45)";
        ctx.fillRect(drawLeft, Math.round(baseline) + 0.5 - 1, pxWidth, 1);
      }
    }

    // 4) 名称条（20px，剪映式）：素材文件名，时长码紧跟其后（左对齐、不靠右）。
    if (headerH > 0) {
      const headerText =
        clipNames.get(rect.clip.clip_id) ??
        (isAudioClip ? `音频 ${rect.clip.order_index + 1}` : `片段 ${rect.clip.order_index + 1}`);
      const durText = formatTimecode(
        rect.clip.timeline_end_us - rect.clip.timeline_start_us,
        frameRate,
      );
      ctx.fillStyle = palette.header;
      ctx.fillRect(rect.x, rect.y, rect.width, headerH);
      ctx.font = "11px sans-serif";
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
      ctx.fillStyle = "#eef4f6";
      ctx.fillText(name, rect.x + 6, textY);
      if (showDur) {
        ctx.fillStyle = "rgba(238, 244, 246, 0.8)";
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
      ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
      ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
    }
    ctx.restore();

    // 5) 选中效果（剪映式 1:1）：白色圆角描边包住整段片段 + 四角圆形手柄。
    //    拖动途中不画（片段已"提起来"，落位意图由灰色预览剪影表达，
    //    白框只属于"选中"语义）。
    if (isSelected && !isMovingClip) {
      const inset = 0.75;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(
        rect.x + inset,
        rect.y + inset,
        rect.width - inset * 2,
        rect.height - inset * 2,
        CLIP_RADIUS,
      );
      ctx.stroke();
      const corners: Array<[number, number]> = [
        [rect.x + inset, rect.y + inset],
        [rect.x + rect.width - inset, rect.y + inset],
        [rect.x + inset, rect.y + rect.height - inset],
        [rect.x + rect.width - inset, rect.y + rect.height - inset],
      ];
      for (const [handleX, handleY] of corners) {
        ctx.beginPath();
        ctx.arc(handleX, handleY, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 6) 分贝线（剪映式）：1px 横线贯穿音频区域、左端圆点；常态 rgb(66,155,159)，
    //    hover 到片段（非 hover 线本身）即变 rgb(222,237,238)；拖动时黄色高亮。
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
      ctx.strokeStyle = draggingVolume
        ? "#ffd76e"
        : isLocked
          ? "rgba(66, 155, 159, 0.4)"
          : hoveredClip
            ? "rgb(222, 237, 238)"
            : "rgb(66, 155, 159)";
      // 0.5 对齐：DPR 缩放下让 1px 线落在单设备像素上（避免被取整成 2px）。
      const lineY = Math.round(shownY) + 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + 6, lineY);
      ctx.lineTo(rect.x + rect.width - 6, lineY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rect.x + 12, lineY, 3, 0, Math.PI * 2);
      ctx.fillStyle = draggingVolume ? "#ffd76e" : hoveredClip ? "rgb(222, 237, 238)" : "rgb(66, 155, 159)";
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
      ctx.strokeStyle = "#5a6a72";
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
        ctx.fillStyle = rect.clip.asset_kind === "audio" ? CLIP_PALETTE.audio.body : CLIP_PALETTE.video.band;
        ctx.fillRect(gx, rect.y + 2, gw, view.trackHeight - 4);
        ctx.strokeStyle = "#2fc9a5";
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
      ctx.fillStyle = clip.asset_kind === "audio" ? CLIP_PALETTE.audio.body : CLIP_PALETTE.video.band;
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
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffd76e";
      ctx.font = "10px monospace";
      ctx.textBaseline = "top";
      ctx.fillText(formatRulerTime(snapUs), sx + 4, view.rulerHeight + 4);
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
    ctx.fillStyle = "rgba(37, 211, 172, 0.10)";
    ctx.fillRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
    ctx.strokeStyle = "#2fc9a5";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
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
  ctx.fillStyle = "#12181c";
  ctx.fillRect(0, 0, headW, height);
  ctx.fillStyle = "#181c1f";
  ctx.fillRect(headW, 0, stripW, height);
  ctx.strokeStyle = "#14171a";
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
  onCommand,
  coverUrl,
  onCaptureCover,
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
  /** Optional seek callback invoked when the playhead is dragged or a caption is clicked. */
  onSeek?: (timeUs: number) => void;
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
  const contextMenuRef = useRef<HTMLDivElement>(null);

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
  const trackRows = useMemo(
    () => computeTrackRows(tracks, view.rulerHeight, view.trackHeight),
    [tracks, view.rulerHeight, view.trackHeight],
  );
  // 内容总高（标尺 + 全部固定行 + 横向滚动条条带）；画布与左栏同步按此伸展。
  const contentHeight = view.rulerHeight + trackRowsTotalHeight(trackRows) + SCROLLBAR_HEIGHT_PX;
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
  const ticks = useMemo(
    () => computeTicks(totalUs, view.pixelsPerSecond, view.headerWidth, frameRate, view.scrollX, canvasSize.width),
    [totalUs, view.pixelsPerSecond, view.headerWidth, frameRate, view.scrollX, canvasSize.width],
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
  }, [canvasSize, view, trackRows, contentHeight, clipRects, captionRects, captions, ticks, selection, interaction, hover, totalUs, thumbnailVersion, waveformVersion, rulerHoverUs, clipNames, frameRate, pendingKeep, scrollTop, canvasTopY, canvasViewportHeight]);

  // 固定标尺条带：绘制到覆盖层 Canvas（随纵向滚动钉在可视区顶部）。
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rulerScrubbingRef = useRef(false);
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
    drawRulerStrip(ctx, width, view.rulerHeight, view, ticks, rulerHoverUs, clipRects);
  }, [view, canvasSize, ticks, rulerHoverUs, clipRects]);

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
    if (rulerScrubbingRef.current) onSeek?.(timeUs);
  };
  const handleRulerPinDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    rulerScrubbingRef.current = true;
    event.currentTarget.style.cursor = "col-resize";
    onSeek?.(clampRulerTime(rulerPinTimeAt(event)));
  };
  const handleRulerPinUp = (event: React.MouseEvent<HTMLCanvasElement>) => {
    rulerScrubbingRef.current = false;
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

      // 空白区域（鼠标未在素材上）：默认拖动播放头（剪映式）；
      // Shift + 拖拽保留框选。
      if (!event.shiftKey) {
        setSelection(null);
        const timeUs = clampRulerTime(xToTime(x, view));
        onSeek?.(timeUs);
        const scrub: TimelineInteraction = { kind: "playhead", startX: x };
        interactionRef.current = scrub;
        setInteraction(scrub);
        canvas.style.cursor = "col-resize";
        return;
      }
      setSelection(null);
      shiftClickRef.current = true;
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
          setSelection(ids.length > 0 ? { kind: "clips", ids } : null);
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

  // Close the context menu on outside mousedown / Escape / scroll.
  const hasContextMenu = contextMenu !== null;
  useEffect(() => {
    if (!hasContextMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const handleWheelClose = () => setContextMenu(null);
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("wheel", handleWheelClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
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
    // 落点意图：轨道行 id（App 校验类型兼容）；上部空白区 = "new"（自动建
    // 视频轨）；其余空白 = undefined（追加主轨）。
    const coords = canvasCoords(event);
    const row = coords ? trackRowAt(trackRows, coords.x, coords.y) : null;
    let intent: string | "new" | undefined;
    if (row) {
      intent = row.track.id;
    } else if (coords) {
      const captionRow = trackRowOf(trackRows, "C1");
      const upperBound = captionRow?.y ?? view.rulerHeight;
      intent = coords.y < upperBound ? "new" : undefined;
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
        <IconButton label="撤销" disabled={!canUndo} onClick={onUndo}>
          <Undo2 />
        </IconButton>
        <IconButton label="重做" disabled={!canRedo} onClick={onRedo}>
          <Redo2 />
        </IconButton>
        <span className="toolbar-sep" aria-hidden="true" />
        <IconButton
          label={allSelectedLocked ? "解锁片段" : "锁定片段"}
          disabled={selectedClips.length === 0}
          onClick={() =>
            void onPatch(
              selectedClips
                .filter((c) => (allSelectedLocked ? isClipLocked(c.clip_id) : !isClipLocked(c.clip_id)))
                .map((c) => ({
                  op: "set_clip_locked" as const,
                  clip_id: c.clip_id,
                  locked: !allSelectedLocked,
                })),
              allSelectedLocked ? "解锁片段" : "锁定片段",
            )
          }
        >
          {allSelectedLocked ? <LockOpen /> : <Lock />}
        </IconButton>
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
          <input
            className="timeline-zoom-slider"
            type="range"
            aria-label="时间线缩放"
            min={0}
            max={100}
            step={1}
            value={Math.round(ppsToZoomPct(view.pixelsPerSecond))}
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
      </div>

      {/* Body: 冻结标尺（滚动区外，零抖动）+ 滚动区（轨道头列/封面条带/片段区）。
          标尺画布绝对定位覆盖滚动视口顶部（见 .timeline-ruler-pin），主画布仍是第一个 canvas。 */}
      <div className="timeline-body">
        <div ref={scrollRef} className="timeline-scroll" onScroll={onTimelineScroll}>
        {/* Left gutter (DOM)：每条轨道一个属性头
            [类型标识] [锁定] [隐藏(视频/文本)] [静音(视频/音频)] [独奏(视频/音频)] */}
        <div className="timeline-left" style={{ width: view.headerWidth, height: contentHeight, position: "relative" }}>
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
                style={{ top: row.y, height: row.height }}
              >
                <span className="timeline-track-badge" title={`${row.track.id} ${kind === "video" ? "视频" : kind === "text" ? "文本" : "音频"}轨道`}>
                  {kind === "video" ? <Video size={11} /> : kind === "text" ? <TypeIcon size={11} /> : <Music size={11} />}
                  <small>{row.track.id}</small>
                </span>
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
          style={{ flex: 1, position: "relative", height: contentHeight }}
          onWheel={handleWheel}
        >
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
            return (
              <button
                key={rect.transition.transition_id}
                className={`timeline-transition-marker${isSelected ? " selected" : ""}`}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: rect.y + 4,
                  width: rect.width,
                  height: Math.min(28, rect.height - 8),
                  pointerEvents: "auto",
                }}
                title={`转场 ${rect.transition.kind} · ${(rect.transition.duration_us / 1_000_000).toFixed(1)}s`}
                aria-label={`转场 ${rect.transition.kind} ${(rect.transition.duration_us / 1_000_000).toFixed(1)}秒`}
                aria-pressed={isSelected}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelection({ kind: "transition", id: rect.transition.transition_id });
                }}
              >
                ◈
              </button>
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
                background: "rgba(37, 211, 172, 0.12)",
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
            <div
              className="timeline-empty-drop"
              style={{
                position: "absolute",
                left: view.headerWidth,
                top: view.rulerHeight,
                right: 0,
                height: view.trackHeight,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              将视频或图片拖到这里开始剪辑
            </div>
          )}
          {/* Round 4: canvas context menu (flips up near the bottom edge) */}
          {contextMenu && (() => {
            const menuHeight = contextMenu.target.kind === "clip" ? 175 : contextMenu.target.kind === "empty" ? 115 : 80;
            // B17：可视区底（内容空间）= scrollTop + 视口高——菜单上翻判定。
            const viewportBottomY = scrollTopRef.current + canvasSize.height;
            const menuTop =
              contextMenu.y + menuHeight > viewportBottomY
                ? Math.max(2, contextMenu.y - menuHeight)
                : contextMenu.y;
            return (
            <div
              ref={contextMenuRef}
              role="menu"
              aria-label="时间线右键菜单"
              className="timeline-context-menu"
              style={{
                left: Math.max(2, Math.min(contextMenu.x, canvasSize.width - 170)),
                top: Math.max(2, Math.min(menuTop, Math.max(2, viewportBottomY - menuHeight))),
              }}
            >
              {(() => {
                const close = (action: () => void) => () => {
                  action();
                  setContextMenu(null);
                };
                const target = contextMenu.target;
                if (target.kind === "clip") {
                  const clip = clips.find((c) => c.clip_id === target.clipId);
                  if (!clip) return null;
                  const locked = isClipLocked(clip.clip_id);
                  const speedFactor = (clip.speed_milli ?? 1000) / 1000;
                  // 右键菜单打开瞬间读取播放头即时值（store 直读，不触发重渲染）。
                  const playheadNowUs = activePlayheadStore.get();
                  const playheadSourceUs =
                    (clip.source_start_us ?? 0) +
                    (playheadNowUs - clip.timeline_start_us) * speedFactor;
                  const canSplitAtPlayhead =
                    clip.asset_kind === "video" &&
                    !locked &&
                    playheadNowUs > clip.timeline_start_us + 1000 &&
                    playheadNowUs < clip.timeline_end_us - 1000 &&
                    playheadSourceUs > (clip.source_start_us ?? 0) + 1000 &&
                    playheadSourceUs < (clip.source_end_us ?? 0) - 1000;
                  return [
                    <button key="split" role="menuitem" disabled={!canSplitAtPlayhead}
                      onClick={close(() => void onPatch(
                        [{
                          op: "split_clip",
                          clip_id: clip.clip_id,
                          source_time_us: Math.round(playheadSourceUs),
                        }],
                        "拆分片段",
                      ))}
                    >
                      在播放头处拆分
                    </button>,
                    <button key="copy" role="menuitem" disabled={locked}
                      onClick={close(() => onCommand?.("timeline.copy"))}
                    >
                      复制
                    </button>,
                    <button key="lock" role="menuitem"
                      onClick={close(() => void onPatch(
                        [{ op: "set_clip_locked", clip_id: clip.clip_id, locked: !locked }],
                        locked ? "解锁片段" : "锁定片段",
                      ))}
                    >
                      {locked ? "解锁片段" : "锁定片段"}
                    </button>,
                    <button key="del" role="menuitem" disabled={locked}
                      onClick={close(() => void onPatch(
                        [{ op: "remove_clip", clip_id: clip.clip_id }],
                        "删除片段",
                      ))}
                    >
                      删除片段
                    </button>,
                    <div key="sep" role="separator" className="menu-sep" />,
                    <button key="seek" role="menuitem" onClick={close(() => onSeek?.(contextMenu.timeUs))}>
                      定位播放头
                    </button>,
                  ];
                }
                if (target.kind === "caption") {
                  return [
                    <button key="del" role="menuitem" onClick={close(() => void onPatch(
                      [{ op: "remove_caption", caption_id: target.captionId as never }],
                      "删除字幕",
                    ))}
                    >
                      删除字幕
                    </button>,
                    <div key="sep" role="separator" className="menu-sep" />,
                    <button key="seek" role="menuitem" onClick={close(() => onSeek?.(contextMenu.timeUs))}>
                      定位播放头
                    </button>,
                  ];
                }
                if (target.kind === "transition") {
                  return [
                    <button key="del" role="menuitem" onClick={close(() => void onPatch(
                      [{ op: "remove_transition", transition_id: target.transitionId as never }],
                      "删除转场",
                    ))}
                    >
                      删除转场
                    </button>,
                  ];
                }
                return [
                  <button key="paste" role="menuitem" onClick={close(() => onCommand?.("timeline.paste"))}>
                    粘贴到播放头
                  </button>,
                  <button key="seek" role="menuitem" onClick={close(() => onSeek?.(contextMenu.timeUs))}>
                    定位播放头
                  </button>,
                  <button key="clear" role="menuitem" onClick={close(() => setSelection(null))}>
                    取消选择
                  </button>,
                ];
              })()}
            </div>
            );
          })()}
        </div>
        {/* B2: 添加转场浮层——点击两片段边界后出现；样式见 styles.css 万兴喵影弹窗层 */}
        {addTransitionAnchor && (
          <div
            className="add-transition-popover"
            role="dialog"
            aria-label="添加转场"
            onClick={() => setAddTransitionAnchor(null)}
          >
            <div
              className="add-transition-card"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="add-transition-hd">
                在此处添加转场
                <button aria-label="关闭添加转场" onClick={() => setAddTransitionAnchor(null)}>✕</button>
              </div>
              <div className="add-transition-body">
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
                <small>默认 0.5s，添加后可在属性面板调整时长；仅权威预览渲染转场效果。</small>
              </div>
            </div>
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
        <TimelinePlayheadLayer
          store={activePlayheadStore}
          view={{ ...view, headerWidth: view.headerWidth * 2 }}
          totalUs={totalUs}
          contentHeight={contentHeight}
        />
      </div>
    </section>
  );
}
