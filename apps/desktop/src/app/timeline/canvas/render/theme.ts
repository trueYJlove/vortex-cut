import { SCROLLBAR_HEIGHT_PX, scrollBounds } from "../../geometry.js";
import type { TimelineViewState } from "../../types.js";

/** Keyframe lane order for the expanded panel (matches contracts' four properties). */
export const KEYFRAME_ORDER = ["position", "scale", "rotate", "opacity"] as const;
export const KEYFRAME_LANE_LABELS: Record<string, string> = {
  position: "位",
  scale: "缩",
  rotate: "旋",
  opacity: "透",
};
export const KEYFRAME_LANE_HEIGHT = 14;

/** Amplitude gain applied at draw time so quiet audio stays visible. */
export const WAVEFORM_GAIN = 1.4;
/** Draw-path peak cap per clip (must stay >= pixel width for 1 peak/px density). */
export const WAVEFORM_PEAK_COUNT_MAX = 4096;

/** Clip corner radius (px, aligned with OpenFilm rounded-[4px]). */
export const CLIP_RADIUS = 4;
/** Vertical clip inset inside a track row (px). */
export const CLIP_ROW_INSET = 0.5;

export const KIND_COLOR_VARS: Record<string, { body: string; header: string; band: string; wave: string }> = {
  video: { body: "--clip-video", header: "--clip-video", band: "--clip-video", wave: "--clip-video" },
  image: { body: "--clip-image", header: "--clip-image", band: "--clip-image", wave: "--clip-image" },
  page: { body: "--clip-page", header: "--clip-page", band: "--clip-page", wave: "--clip-page" },
  text: { body: "--clip-text", header: "--clip-text", band: "--clip-text", wave: "--clip-text" },
  sticker: { body: "--clip-sticker", header: "--clip-sticker", band: "--clip-sticker", wave: "--clip-sticker" },
  filter: { body: "--clip-filter", header: "--clip-filter", band: "--clip-filter", wave: "--clip-filter" },
  effect: { body: "--clip-effect", header: "--clip-effect", band: "--clip-effect", wave: "--clip-effect" },
  audio: { body: "--clip-audio", header: "--clip-audio", band: "--clip-audio", wave: "--clip-audio" },
};

export function formatTimelineHoverTime(us: number): string {
  const totalSeconds = us / 1_000_000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  }
  if (minutes > 0) return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
  return `${seconds.toFixed(2)}s`;
}

/** Read timeline-scoped CSS variables first, falling back to root / isolated renderer defaults. */
export const cssColor = (name: string, fallback: string): string => {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const timeline = document.querySelector<HTMLElement>(".timeline-pane");
  const value = getComputedStyle(timeline ?? document.documentElement).getPropertyValue(name).trim()
    || getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

export const RULER_DEAD_BG = () => cssColor("--tl-dead-bg", "#161618");
export const RULER_BG_TOP = () => cssColor("--tl-ruler-top", "#1c1c1f");
export const RULER_BG_BOTTOM = () => cssColor("--tl-ruler-bottom", "#17171a");
export const RULER_END_EDGE = () => cssColor("--tl-end-edge", "#3d4a5c");
export const HOVER_CHIP_BG = () => cssColor("--tl-chip-bg", "rgba(9, 12, 24, 0.88)");
export const HOVER_CHIP_EDGE = () => cssColor("--tl-chip-edge", "rgba(0, 193, 205, 0.45)");
export const HOVER_CHIP_TEXT = "#d6e1ff";

/** Small dark tooltip shown above a drag ghost (timecode + duration/delta). */
export function drawDragTooltip(
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

/** OpenFilm's persistent 4px range thumb under the lanes. */
export function drawScrollbar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  totalUs: number,
) {
  const { maxScrollX } = scrollBounds(view, totalUs, width);
  const timeViewportWidth = Math.max(0, width - view.headerWidth);
  const visibleRatio = maxScrollX > 0
    ? Math.min(1, timeViewportWidth / (timeViewportWidth + maxScrollX))
    : 1;
  const thumbWidth = Math.min(width, Math.max(16, width * visibleRatio));
  const thumbX = maxScrollX > 0
    ? (view.scrollX / maxScrollX) * (width - thumbWidth)
    : 0;
  const thumbHeight = 4;
  const thumbY = height - SCROLLBAR_HEIGHT_PX + (SCROLLBAR_HEIGHT_PX - thumbHeight) / 2;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = cssColor("--text", "#e5e7eb");
  ctx.beginPath();
  ctx.roundRect(thumbX, thumbY, thumbWidth, thumbHeight, 2);
  ctx.fill();
  ctx.restore();
}
