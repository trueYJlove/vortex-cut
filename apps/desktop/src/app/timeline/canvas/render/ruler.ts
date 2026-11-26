import { timeToX } from "../../geometry.js";
import type { TickMark, TimelineViewState } from "../../types.js";
import {
  HOVER_CHIP_BG,
  HOVER_CHIP_EDGE,
  HOVER_CHIP_TEXT,
  RULER_END_EDGE,
  cssColor,
  formatTimelineHoverTime,
} from "./theme.js";

/** Ruler surface shared across main and fixed overlay ruler canvases. */
export function drawRulerFace(
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
    xAt: (us: number) => number;
  },
) {
  const { bandX, width, height, hoverUs, hoverText, xAt } = opts;
  const endX = Math.max(bandX, Math.min(width, opts.endX));

  ctx.fillStyle = cssColor("--tl-panel", "#191919");
  ctx.fillRect(bandX, 0, Math.max(0, width - bandX), height);
  if (endX < width) {
    ctx.strokeStyle = RULER_END_EDGE();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(endX) + 0.5, 0);
    ctx.lineTo(Math.round(endX) + 0.5, height);
    ctx.stroke();
  }

  if (hoverUs !== null && hoverUs !== undefined) {
    const hx = xAt(hoverUs);
    if (hx >= bandX && hx <= width) {
      ctx.strokeStyle = cssColor("--tl-tick-major", "#8a95a5");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, height);
      ctx.stroke();
    }
  }

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

/** Fixed ruler strip canvas pinned above the scrollable track stack. */
export function drawRulerStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  headWidth: number,
  view: TimelineViewState,
  ticks: TickMark[],
  totalUs: number,
  rulerHoverUs: number | null | undefined,
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const headW = headWidth;
  const stripW = view.headerWidth;
  const rulerX = headW + stripW;
  ctx.fillStyle = cssColor("--tl-rail-bg", "#191919");
  ctx.fillRect(0, 0, headW, height);
  ctx.fillStyle = cssColor("--tl-rail-bg", "#191919");
  ctx.fillRect(headW, 0, stripW, height);
  drawRulerFace(ctx, {
    bandX: rulerX,
    width,
    height,
    endX: totalUs > 0 ? timeToX(totalUs, view) + headW : width,
    xOffset: headW,
    ticks,
    hoverUs: rulerHoverUs,
    hoverText: rulerHoverUs !== null && rulerHoverUs !== undefined ? formatTimelineHoverTime(rulerHoverUs) : "",
    xAt: (us) => timeToX(us, view) + headW,
  });
}
