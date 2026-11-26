import type { TimelineCaption } from "@aivideo/contracts";
import {
  CAPTION_ROW_H,
  MIN_CLIP_US,
  clipAudioBand,
  clipDuration,
  marqueeRect,
  snapClipPaintRect,
  timeToX,
  trackRowOf,
  volumeToY,
  type TrackRowLayout,
} from "../../geometry.js";
import type { ClipRenderRect, TimelineInteraction, TimelineViewState } from "../../types.js";
import { drawClipRect, type ClipDrawEnv } from "./clips-layer.js";
import { CLIP_RADIUS, CLIP_ROW_INSET, KIND_COLOR_VARS, cssColor, drawDragTooltip } from "./theme.js";

export function drawInteractionOverlays(
  env: ClipDrawEnv,
  clipRects: ClipRenderRect[],
  captions: TimelineCaption[],
  playheadUs: number,
  interaction: TimelineInteraction | null,
  trackRows: TrackRowLayout[],
  view: TimelineViewState,
  width: number,
  height: number,
  waveformRatio?: number,
): void {
  const { ctx, movingId } = env;

  // Speed edge drag ghosts + tooltip
  if (interaction?.kind === "speed") {
    for (const target of interaction.targets) {
      if (interaction.linkedClipIds.includes(target.clipId)) continue;
      const source = clipRects.find((rect) => rect.clip.clip_id === target.clipId);
      const row = trackRowOf(trackRows, target.trackId);
      if (!source || !row) continue;
      const x = timeToX(target.startUs, view);
      const y = row.y + CLIP_ROW_INSET;
      const w = Math.max(2, ((target.endUs - target.startUs) / 1_000_000) * view.pixelsPerSecond);
      const h = Math.max(4, row.height - CLIP_ROW_INSET * 2);
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(source.clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
      ctx.strokeStyle = "#a8e8d5";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, CLIP_RADIUS);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    const lead = interaction.targets.find((target) => target.clipId === interaction.clipId);
    if (lead) {
      const headRipples = interaction.edge === "left" && lead.startUs === interaction.originalTimelineStartUs;
      const x = interaction.edge === "left" && !headRipples ? timeToX(lead.startUs, view) : timeToX(lead.endUs, view);
      const row = trackRowOf(trackRows, lead.trackId);
      drawDragTooltip(
        ctx,
        x,
        row?.y ?? view.rulerHeight,
        [
          `${(interaction.targetSpeedMilli / 1_000).toFixed(2)}x`,
          `${((lead.endUs - lead.startUs) / 1_000_000).toFixed(2)}s`,
        ],
        width,
      );
    }
  }

  // Copy and refused-plan dashed overlays
  if (interaction?.kind === "move" && interaction.dragPlan?.lead) {
    const copySources = new Map<string, string>();
    for (const operation of interaction.dragPlan.operations) {
      if (operation.op === "duplicate_timeline_items") {
        for (const copy of operation.copies) {
          if (copy.item_kind === "clip") copySources.set(copy.copy_id, copy.source_id);
        }
      }
    }
    for (const placement of interaction.copyOnStart || interaction.dragPlan.reason ? interaction.dragPlan.placements : []) {
      if (!interaction.copyOnStart && interaction.clipIds.some((clipId) => clipId === placement.clipId)) continue;
      const sourceId = copySources.get(placement.clipId) ?? placement.clipId;
      const source = clipRects.find((rect) => rect.clip.clip_id === sourceId)?.clip;
      if (!source) continue;
      const targetRow = trackRowOf(trackRows, placement.trackId);
      const hitRow = interaction.dropHit?.trackId ? trackRowOf(trackRows, interaction.dropHit.trackId) : null;
      const sourceKind = source.asset_kind === "audio" ? "audio" : "video";
      const anchorRow = hitRow?.track.kind === sourceKind ? hitRow : trackRowOf(trackRows, source.track_id) ?? hitRow;
      const rowHeight = targetRow?.height ?? anchorRow?.height ?? view.trackHeight;
      const gy = targetRow?.y ?? (anchorRow
        ? source.asset_kind === "audio" ? anchorRow.y + anchorRow.height : anchorRow.y - rowHeight
        : view.rulerHeight);
      const gx = timeToX(placement.startUs, view);
      const gw = Math.max(2, (clipDuration(source) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = interaction.dragPlan.reason ? 0.16 : 0.42;
      ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(source.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
      ctx.strokeStyle = interaction.copyOnStart ? "#63d3c5" : "#a8e8d5";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.roundRect(gx, gy + CLIP_ROW_INSET, gw, Math.max(4, rowHeight - CLIP_ROW_INSET * 2), CLIP_RADIUS);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Lifted dragging clip shadow + foreground body (painted last over neighbours)
  const movingRect = movingId !== null ? clipRects.find((r) => r.clip.clip_id === movingId) : null;
  if (movingRect) {
    if (interaction?.kind === "move") {
      const projected = snapClipPaintRect(
        {
          ...movingRect,
          x: timeToX(Math.round(interaction.previewStartUs), view),
          y: movingRect.y + interaction.currentY - interaction.startY + CLIP_ROW_INSET,
          height: Math.max(4, movingRect.height - CLIP_ROW_INSET * 2),
        },
        view.scrollX,
      );
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.32)";
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
      ctx.beginPath();
      ctx.roundRect(projected.x, projected.y, projected.width, projected.height, CLIP_RADIUS);
      ctx.fill();
      ctx.restore();
    }
    drawClipRect(env, movingRect);
  }

  // Drag feedback (move / group-move / volume / trim / edge-edit / caption-trim / caption-move)
  if (interaction?.kind === "move") {
    // Intentionally empty; the moving clip itself is the feedback.
  } else if (interaction?.kind === "group-move") {
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (const clipId of interaction.clipIds) {
      const rect = clipRects.find((r) => r.clip.clip_id === clipId);
      const targetUs = interaction.targetStartUsByClip[clipId];
      if (!rect || targetUs === undefined) continue;
      const gw = Math.max(2, (clipDuration(rect.clip) / 1_000_000) * view.pixelsPerSecond);
      const gx = timeToX(targetUs, view);
      ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(rect.clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
      ctx.fillRect(gx, rect.y + 2, gw, rect.height - 4);
      ctx.strokeStyle = cssColor("--tl-canvas-accent", "#00c1cd");
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, rect.y + 2, gw, rect.height - 4);
    }
    ctx.restore();
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
    const lead = clipRects.find((rect) => rect.clip.clip_id === interaction.clipId)?.clip;
    if (lead) {
      const leadSpeed = Math.max(1, lead.speed_milli ?? 1000);
      const sourceDelta = interaction.edge === "left"
        ? interaction.targetStartUs - interaction.originalStartUs
        : interaction.targetEndUs - interaction.originalEndUs;
      const edgeDeltaUs = lead.asset_kind === "image"
        ? interaction.edge === "left"
          ? interaction.targetTimelineStartUs - interaction.originalTimelineStartUs
          : interaction.targetTimelineEndUs - interaction.originalTimelineEndUs
        : Math.round(sourceDelta * 1000 / leadSpeed);
      for (const clipId of interaction.linkedClipIds) {
        const rect = clipRects.find((item) => item.clip.clip_id === clipId);
        if (!rect) continue;
        const clip = rect.clip;
        const ghostStartUs = interaction.edge === "left" ? clip.timeline_start_us + edgeDeltaUs : clip.timeline_start_us;
        const ghostEndUs = interaction.edge === "right" ? clip.timeline_end_us + edgeDeltaUs : clip.timeline_end_us;
        if (ghostEndUs - ghostStartUs < MIN_CLIP_US) continue;
        const gx = timeToX(ghostStartUs, view);
        const trimRow = trackRowOf(trackRows, clip.track_id);
        const gy = trimRow?.y ?? view.rulerHeight;
        const gh = trimRow?.height ?? view.trackHeight;
        const gw = Math.max(2, ((ghostEndUs - ghostStartUs) / 1_000_000) * view.pixelsPerSecond);
        ctx.save();
        ctx.globalAlpha = clipId === interaction.clipId ? 0.55 : 0.34;
        ctx.fillStyle = cssColor(KIND_COLOR_VARS[String(clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
        ctx.fillRect(gx, gy + 2, gw, gh - 4);
        ctx.strokeStyle = "#ffd76e";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(gx, gy + 2, gw, gh - 4);
        ctx.restore();
        if (clipId === interaction.clipId) {
          drawDragTooltip(
            ctx,
            interaction.edge === "left" ? gx : gx + gw,
            gy,
            [
              `${((ghostEndUs - ghostStartUs) / 1_000_000).toFixed(2)}s`,
              `Δ${edgeDeltaUs >= 0 ? "+" : ""}${(edgeDeltaUs / 1_000_000).toFixed(2)}s`,
            ],
            width,
          );
        }
      }
    }
  } else if (interaction?.kind === "edge-edit") {
    const label = interaction.mode === "roll" ? "滚动修剪" : interaction.mode === "slip" ? "滑移素材" : "滑动片段";
    for (const target of interaction.targets) {
      const rect = clipRects.find((item) => item.clip.clip_id === target.clipId);
      if (!rect) continue;
      const gx = timeToX(target.timelineStartUs, view);
      const gy = rect.y;
      const gw = Math.max(2, ((target.timelineEndUs - target.timelineStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = interaction.mode === "slip" ? 0.28 : 0.46;
      ctx.fillStyle = interaction.mode === "slip" ? "#00aeb7" : cssColor(KIND_COLOR_VARS[String(rect.clip.asset_kind ?? "video")]?.band ?? "--clip-video", "#354f6a");
      ctx.fillRect(gx, gy + 2, gw, rect.height - 4);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(gx, gy + 2, gw, rect.height - 4);
      ctx.restore();
    }
    const focusId = interaction.mode === "slide" ? interaction.clipIds[1] : interaction.clipIds[0];
    const target = interaction.targets.find((item) => item.clipId === focusId);
    const rect = clipRects.find((item) => item.clip.clip_id === focusId);
    if (target && rect) {
      const x = interaction.mode === "roll"
        ? timeToX(target.timelineEndUs, view)
        : timeToX((target.timelineStartUs + target.timelineEndUs) / 2, view);
      const delta = `${interaction.deltaUs >= 0 ? "+" : "−"}${Math.abs(interaction.deltaUs / 1_000_000).toFixed(2)}s`;
      drawDragTooltip(ctx, x, rect.y, [label, interaction.mode === "slip" ? `源偏移 ${delta}` : `边界 ${delta}`], width);
    }
  } else if (interaction?.kind === "caption-trim") {
    const caption = captions.find((c: TimelineCaption) => c.caption_id === interaction.captionId);
    if (caption) {
      const ghostStartUs = interaction.edge === "left" ? interaction.targetStartUs : caption.start_us;
      const ghostEndUs = interaction.edge === "right" ? interaction.targetEndUs : caption.end_us;
      const gx = timeToX(ghostStartUs, view);
      const captionRow = trackRowOf(trackRows, "C1");
      const gy = captionRow?.y ?? view.rulerHeight;
      const gh = captionRow?.height ?? CAPTION_ROW_H;
      const gw = Math.max(2, ((ghostEndUs - ghostStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#7a6a3a";
      ctx.fillRect(gx, gy + 2, gw, gh - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, gh - 4);
      ctx.restore();
      const edgeDelta = interaction.edge === "left"
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
      const captionRow = trackRowOf(trackRows, "C1");
      const gy = captionRow?.y ?? view.rulerHeight;
      const gh = captionRow?.height ?? CAPTION_ROW_H;
      const gw = Math.max(2, ((interaction.targetEndUs - interaction.targetStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#7a6a3a";
      ctx.fillRect(gx, gy + 2, gw, gh - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, gh - 4);
      ctx.restore();
    }
  }

  // Snap vertical guide
  const snapUs = (interaction?.kind === "move"
    || interaction?.kind === "trim"
    || interaction?.kind === "edge-edit"
    || interaction?.kind === "group-move")
    ? interaction.snapUs
    : null;
  if (snapUs !== null && snapUs !== undefined) {
    const sx = timeToX(snapUs, view);
    if (sx >= view.headerWidth && sx <= width && Math.abs(sx - timeToX(playheadUs, view)) >= 0.5) {
      ctx.strokeStyle = cssColor("--accent", "#00c1cd");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
      ctx.stroke();
    }
  }

  // Marquee selection rectangle
  if (interaction?.kind === "marquee") {
    const rect = marqueeRect(
      interaction.startX,
      interaction.startY,
      interaction.currentX,
      interaction.currentY,
    );
    ctx.fillStyle = cssColor("--accent-soft", "rgba(0,193,205,.14)");
    ctx.fillRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
    ctx.strokeStyle = cssColor("--accent", "#00c1cd");
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x - view.scrollX, rect.y, rect.width, rect.height);
  }
}
