import type { TimelineCaption, TimelineClip, TimelineClipId } from "@aivideo/contracts";
import {
  CLIP_HEADER_H,
  clipAudioBand,
  snapClipPaintRect,
  timeToX,
  trackRowOf,
  volumeToY,
  xToTime,
  type TrackRowLayout,
} from "../../geometry.js";
import type {
  CaptionRenderRect,
  ClipRenderRect,
  TimelineHover,
  TimelineInteraction,
  TimelineSelection,
  TimelineViewState,
} from "../../types.js";
import type { WaveformCache } from "../../waveform-cache.js";
import {
  THUMB_CELL_PX,
  cachedFilmstripFallback,
  cellSourceTimeSec,
  filmstripCachePrefix,
  frameTierFor,
  nearestSourceFrame,
  type CachedSourceFrame,
  type FilmstripSprite,
} from "./filmstrip-index.js";
import {
  CLIP_RADIUS,
  CLIP_ROW_INSET,
  KEYFRAME_LANE_HEIGHT,
  KEYFRAME_LANE_LABELS,
  KEYFRAME_ORDER,
  KIND_COLOR_VARS,
  WAVEFORM_PEAK_COUNT_MAX,
  cssColor,
} from "./theme.js";

export interface PendingKeepPreview {
  placements: Array<{ clipId: TimelineClipId; trackId: string; startUs: number }>;
  copies: Array<{ clipId: TimelineClipId; sourceClipId: TimelineClipId; trackId: string; startUs: number }>;
}

export interface ClipDrawEnv {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: TimelineViewState;
  trackRows: TrackRowLayout[];
  selectedIds: readonly string[];
  speedModeActive: boolean;
  interaction: TimelineInteraction | null;
  hover: TimelineHover;
  lockedElements: readonly string[];
  hiddenTrackIds: ReadonlySet<string>;
  movingId: TimelineClipId | null;
  movingClip: TimelineClip | undefined;
  pendingKeep: PendingKeepPreview | null;
  thumbnailCache?: Map<string, HTMLCanvasElement>;
  cachedSourceFrames: Map<string, CachedSourceFrame[]>;
  sprites?: ReadonlyMap<string, FilmstripSprite>;
  waveformCache?: WaveformCache | null;
  waveformRatio?: number;
}

export function drawClipRect(env: ClipDrawEnv, sourceRect: ClipRenderRect): void {
  const {
    ctx,
    width,
    height,
    view,
    trackRows,
    selectedIds,
    speedModeActive,
    interaction,
    hover,
    lockedElements,
    hiddenTrackIds,
    movingId,
    movingClip,
    pendingKeep,
    thumbnailCache,
    cachedSourceFrames,
    sprites,
    waveformCache,
    waveformRatio,
  } = env;

  const baseRect: ClipRenderRect = {
    ...sourceRect,
    y: sourceRect.y + CLIP_ROW_INSET,
    height: Math.max(4, sourceRect.height - CLIP_ROW_INSET * 2),
  };
  let rect = baseRect;
  const speedTarget = interaction?.kind === "speed"
    ? interaction.targets.find((target) => target.clipId === sourceRect.clip.clip_id && interaction.linkedClipIds.includes(target.clipId))
    : undefined;
  if (speedTarget) {
    const speedRow = trackRowOf(trackRows, speedTarget.trackId);
    const previewClip = {
      ...sourceRect.clip,
      timeline_start_us: speedTarget.startUs,
      timeline_end_us: speedTarget.endUs,
      speed_milli: speedTarget.speedMilli as TimelineClip["speed_milli"],
    };
    rect = {
      ...baseRect,
      clip: previewClip,
      x: timeToX(speedTarget.startUs, view),
      width: Math.max(1, ((speedTarget.endUs - speedTarget.startUs) / 1_000_000) * view.pixelsPerSecond),
      y: (speedRow?.y ?? baseRect.y - CLIP_ROW_INSET) + CLIP_ROW_INSET,
    };
  }
  const isMovingClip = movingId !== null && movingId === sourceRect.clip.clip_id && interaction?.kind === "move";
  let keepOverride: { trackId: string; startUs: number } | null = null;
  if (pendingKeep && interaction === null) {
    const kept = pendingKeep.placements.find((item) => item.clipId === sourceRect.clip.clip_id);
    if (kept) keepOverride = { trackId: kept.trackId, startUs: kept.startUs };
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
    const floatY = baseRect.y + (interaction.currentY - interaction.startY);
    const minY = view.rulerHeight + CLIP_ROW_INSET;
    const maxY = Math.max(minY, height - baseRect.height);
    const durationUs = sourceRect.clip.timeline_end_us - sourceRect.clip.timeline_start_us;
    const previewStartUs = Math.round(interaction.previewStartUs);
    rect = {
      ...baseRect,
      clip: {
        ...baseRect.clip,
        timeline_start_us: previewStartUs,
        timeline_end_us: previewStartUs + durationUs,
      },
      x: timeToX(previewStartUs, view),
      y: Math.min(maxY, Math.max(minY, floatY)),
    };
  }
  const isLinkedFollower = interaction?.kind === "move"
    && !interaction.copyOnStart
    && !interaction.ignoreLink
    && movingClip?.link_group_id
    && sourceRect.clip.clip_id !== movingId
    && sourceRect.clip.link_group_id === movingClip.link_group_id;
  if (isLinkedFollower && interaction?.kind === "move" && movingClip) {
    const target = interaction.previewStartUs;
    rect = { ...rect, x: timeToX(sourceRect.clip.timeline_start_us + target - movingClip.timeline_start_us, view) };
  }

  rect = snapClipPaintRect(rect, view.scrollX);
  const isSelected = selectedIds.includes(rect.clip.clip_id);
  const isLocked = lockedElements.includes(rect.clip.clip_id);
  const isHiddenTrack = hiddenTrackIds.has(rect.clip.track_id);

  ctx.save();
  ctx.filter = isHiddenTrack ? "grayscale(1)" : "none";
  ctx.globalAlpha = 1;

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
  const headerH = Math.min(CLIP_HEADER_H, rect.height);
  const band = clipAudioBand(rect.clip, rect, waveformRatio);
  const bodyTop = rect.y + headerH;
  const bodyBottom = band?.top ?? rect.y + rect.height;
  const bodyH = Math.max(4, bodyBottom - bodyTop);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, CLIP_RADIUS);
  ctx.clip();

  // 1) Clip body background
  ctx.fillStyle = palette.body;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  // 2) OpenFilm filmstrip inside the body box
  if (thumbnailCache && isVisualClip && rect.width > 10) {
    const clipDurUs = rect.clip.timeline_end_us - rect.clip.timeline_start_us;
    if (clipDurUs > 0) {
      const clipRight = rect.x + rect.width;
      const cachePrefix = filmstripCachePrefix(rect.clip);
      const clipFrames = cachedSourceFrames.get(cachePrefix) ?? [];
      const spriteEntry = sprites?.get(rect.clip.asset_id);
      const sprite = spriteEntry && spriteEntry.count > 0 && spriteEntry.stepMs > 0 ? spriteEntry : undefined;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, bodyTop, rect.width, bodyH);
      ctx.clip();
      const visibleFromUs = Math.max(rect.clip.timeline_start_us, xToTime(view.headerWidth - THUMB_CELL_PX, view));
      const visibleToUs = Math.min(rect.clip.timeline_end_us, xToTime(width + THUMB_CELL_PX, view));
      const speed = Math.max(0.001, (rect.clip.speed_milli ?? 1000) / 1000);
      const sourceStartUs = Math.max(0, rect.clip.source_start_us ?? 0);
      const sourceEndUs = Math.max(sourceStartUs, rect.clip.source_end_us ?? sourceStartUs + clipDurUs);

      const drawFrame = (cellFromUs: number, cellToUs: number, sourceTimeUs: number, frame?: HTMLCanvasElement) => {
        const cellX = timeToX(cellFromUs, view);
        if (cellX >= clipRight) return;
        const cellW = Math.max(1, timeToX(cellToUs, view) - cellX);
        if (cellX + cellW <= view.headerWidth || cellX >= width) return;
        const source = frame && frame.width > 0 && frame.height > 0 ? frame : sprite?.bitmap;
        const sourceWidth = frame?.width && frame.width > 0 ? frame.width : sprite?.cellW ?? 0;
        const sourceHeight = frame?.height && frame.height > 0 ? frame.height : sprite?.cellH ?? 0;
        if (!source || sourceWidth <= 0 || sourceHeight <= 0) return;
        const sourceY = sprite && source === sprite.bitmap
          ? Math.max(0, Math.min(sprite.count - 1, Math.round(sourceTimeUs / 1000 / sprite.stepMs))) * sourceHeight
          : 0;
        const scale = Math.max(cellW / sourceWidth, bodyH / sourceHeight);
        const cropWidth = cellW / scale;
        const cropHeight = bodyH / scale;
        try {
          ctx.globalAlpha = (isHiddenTrack ? 0.35 : 1) * 0.9;
          ctx.drawImage(
            source,
            (sourceWidth - cropWidth) / 2,
            sourceY + (sourceHeight - cropHeight) / 2,
            cropWidth,
            cropHeight,
            cellX,
            bodyTop,
            cellW,
            bodyH,
          );
        } catch {
          // The bitmap may become unavailable while changing projects.
        } finally {
          ctx.globalAlpha = isHiddenTrack ? 0.35 : 1;
        }
      };

      if (rect.clip.reverse_playback) {
        const frameCount = frameTierFor(clipDurUs, view.pixelsPerSecond);
        for (let fi = 0; fi < frameCount; fi += 1) {
          const cellFromUs = rect.clip.timeline_start_us + (fi * clipDurUs) / frameCount;
          const cellToUs = rect.clip.timeline_start_us + ((fi + 1) * clipDurUs) / frameCount;
          const sourceTimeUs = Math.round(cellSourceTimeSec(rect.clip, fi, frameCount) * 1_000_000);
          const exactFrame = thumbnailCache.get(`${cachePrefix}:${frameCount}:${fi}`);
          const fallback = exactFrame ?? cachedFilmstripFallback(thumbnailCache, cachePrefix, frameCount, fi);
          drawFrame(cellFromUs, cellToUs, sourceTimeUs, fallback);
        }
      } else if (visibleToUs >= visibleFromUs && view.pixelsPerSecond > 0) {
        const stepUs = (THUMB_CELL_PX * 1_000_000 / view.pixelsPerSecond) * speed;
        const sourceAtVisibleFromUs = sourceStartUs + (visibleFromUs - rect.clip.timeline_start_us) * speed;
        const sourceAtVisibleToUs = sourceStartUs + (visibleToUs - rect.clip.timeline_start_us) * speed;
        const firstCell = Math.floor(sourceAtVisibleFromUs / stepUs) - 1;
        const lastCell = Math.ceil(sourceAtVisibleToUs / stepUs) + 1;
        for (let cell = firstCell; cell <= lastCell; cell += 1) {
          const sourceCellFromUs = cell * stepUs;
          const sourceCellToUs = sourceCellFromUs + stepUs;
          const cellFromUs = rect.clip.timeline_start_us + (sourceCellFromUs - sourceStartUs) / speed;
          const cellToUs = rect.clip.timeline_start_us + (sourceCellToUs - sourceStartUs) / speed;
          if (cellToUs <= rect.clip.timeline_start_us || cellFromUs >= rect.clip.timeline_end_us) continue;
          const wantedSourceUs = Math.max(sourceStartUs, Math.min(sourceEndUs, sourceCellFromUs));
          const frame = nearestSourceFrame(clipFrames, Math.round(wantedSourceUs / 1000));
          drawFrame(cellFromUs, cellToUs, wantedSourceUs, frame);
        }
      }
      ctx.restore();
    }
  }

  // 3) Audio waveform columns
  if (waveformCache && band && rect.width > 20) {
    const visibleLeft = Math.max(rect.x, view.headerWidth);
    const visibleRight = Math.min(rect.x + rect.width, width);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const pxWidth = Math.min(WAVEFORM_PEAK_COUNT_MAX, Math.max(1, Math.round(visibleWidth)));
    const timelineSpanUs = rect.clip.timeline_end_us - rect.clip.timeline_start_us;
    const sourceStartUs = rect.clip.source_start_us ?? 0;
    const sourceEndUs = rect.clip.source_end_us ?? sourceStartUs;
    const sourceSpanUs = Math.max(0, sourceEndUs - sourceStartUs);
    const fromFraction = rect.width > 0 ? Math.max(0, Math.min(1, (visibleLeft - rect.x) / rect.width)) : 0;
    const toFraction = rect.width > 0 ? Math.max(fromFraction, Math.min(1, (visibleRight - rect.x) / rect.width)) : 1;
    const sourceWindowStartUs = rect.clip.reverse_playback
      ? sourceStartUs + (1 - toFraction) * sourceSpanUs
      : sourceStartUs + fromFraction * sourceSpanUs;
    const sourceWindowEndUs = rect.clip.reverse_playback
      ? sourceStartUs + (1 - fromFraction) * sourceSpanUs
      : sourceStartUs + toFraction * sourceSpanUs;
    const peaks = visibleWidth > 0 && timelineSpanUs > 0
      ? waveformCache.peaksFor(
        {
          clipId: rect.clip.clip_id,
          assetId: rect.clip.asset_id,
          sourceStartUs: Math.round(sourceWindowStartUs),
          sourceEndUs: Math.round(sourceWindowEndUs),
          speedMilli: rect.clip.speed_milli ?? 1000,
          reverse: rect.clip.reverse_playback ?? false,
        },
        pxWidth,
      )
      : null;
    if (peaks && peaks.length > 0) {
      if (!isAudioClip) {
        ctx.fillStyle = cssColor("--tl-band-bg", "rgba(0,0,0,0.22)");
        ctx.fillRect(rect.x, band.top, rect.width, band.height);
      }
      const baseline = band.top + band.height;
      const maxH = Math.max(6, band.height - 2);
      const columnWidth = visibleWidth / peaks.length;
      const volumeLin = Math.max(0, Math.pow(10, (rect.clip.audio.gain_db ?? 0) / 20));
      const clipped = new Path2D();
      let hasClippedPeaks = false;
      ctx.beginPath();
      for (let px = 0; px < peaks.length; px += 1) {
        const peak = peaks[px] ?? 0;
        const level = Math.max(0, peak) * volumeLin;
        const barH = Math.max(1, Math.min(1, level) * maxH);
        const clipH = level > 1 ? Math.min(barH, Math.max(2, Math.min(1 / 3, 1 - 1 / level) * maxH)) : 0;
        const columnX = visibleLeft + px * columnWidth;
        const columnY = baseline - barH;
        ctx.rect(columnX, columnY + clipH, columnWidth, barH - clipH);
        if (clipH > 0) {
          clipped.rect(columnX, columnY, columnWidth, clipH);
          hasClippedPeaks = true;
        }
      }
      ctx.fillStyle = cssColor(isAudioClip ? "--tl-wave" : "--tl-wave-band", "rgba(255,255,255,.4)");
      ctx.fill();
      if (hasClippedPeaks) {
        ctx.fillStyle = cssColor("--tl-wave-clip", "#f2665f");
        ctx.fill(clipped);
      }
    }
  }

  // 4) Header band background
  if (headerH > 0) {
    ctx.fillStyle = palette.header;
    ctx.fillRect(rect.x, rect.y, rect.width, headerH);
  }

  // Locked / hover overlay
  if (isLocked) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
    ctx.fillStyle = "#cccccc";
    ctx.font = '9px "Inter Variable", sans-serif';
    ctx.textBaseline = "middle";
    ctx.fillText("🔒", rect.x + rect.width - 14, rect.y + rect.height / 2);
  } else if (hover.clipId === rect.clip.clip_id && !isSelected) {
    ctx.fillStyle = cssColor("--tl-row-hover", "rgba(255, 255, 255, 0.07)");
    ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
  }
  ctx.restore();

  // 5) Border-box selection frame (unfilled interior)
  if (isSelected && !isMovingClip) {
    const sx = 3;
    const sy = 1;
    const frame = speedModeActive && (rect.clip.asset_kind === "video" || rect.clip.asset_kind === "audio")
      ? cssColor("--accent", "#00c1cd")
      : cssColor("--tl-select", "#161619");
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = frame;
    ctx.fillRect(rect.x - sx, rect.y - sy, rect.width + sx * 2, sy);
    ctx.fillRect(rect.x - sx, rect.y + rect.height, rect.width + sx * 2, sy);
    ctx.globalAlpha = 1;
    ctx.fillRect(rect.x - sx, rect.y - sy, sx, rect.height + sy * 2);
    ctx.fillRect(rect.x + rect.width, rect.y - sy, sx, rect.height + sy * 2);
    ctx.restore();
  }

  // 6) Volume line for hovered or actively dragged clip
  const volBand = clipAudioBand(rect.clip, rect, waveformRatio);
  if (volBand && rect.width > 30) {
    const draggingVolume = interaction?.kind === "volume" && interaction.clipId === rect.clip.clip_id;
    const hoveredClip = !isMovingClip && !isLinkedFollower && hover.clipId === rect.clip.clip_id;
    if ((draggingVolume || hoveredClip) && !isLocked) {
      const gainDb = draggingVolume
        ? (interaction as { targetGainDb: number }).targetGainDb
        : rect.clip.audio.gain_db;
      const shownY = volumeToY(gainDb, volBand);
      ctx.save();
      ctx.strokeStyle = draggingVolume ? "rgba(255, 255, 255, 1)" : "rgba(255, 255, 255, 0.6)";
      const lineY = Math.round(shownY) + 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x, lineY);
      ctx.lineTo(rect.x + rect.width, lineY);
      ctx.stroke();
      if (draggingVolume) {
        const label = `${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)}dB`;
        ctx.font = '9px "Inter Variable", sans-serif';
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
  }

  // Speed / reverse badge
  const clipSpeed = rect.clip.speed_milli ?? 1000;
  if (clipSpeed !== 1000 || rect.clip.reverse_playback) {
    const badge = [
      clipSpeed !== 1000 ? `${(clipSpeed / 1000).toFixed(clipSpeed % 1000 === 0 ? 1 : 2)}x` : "",
      rect.clip.reverse_playback ? "◀◀" : "",
    ]
      .filter(Boolean)
      .join(" ");
    ctx.font = '9px "Inter Variable", sans-serif';
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
  ctx.restore();
}

export function drawClipsLayer(
  env: ClipDrawEnv,
  clipRects: ClipRenderRect[],
  drawClipRects: ClipRenderRect[],
  movePreviewPositions: ReadonlyArray<{ clipId: string; trackId: string; startUs: number }>,
  movePreviewFollowerIds: ReadonlySet<string>,
): void {
  const { interaction, pendingKeep, trackRows, view } = env;
  const movePreviewPositionById = new Map(movePreviewPositions.map((position) => [position.clipId, position]));

  for (const sourceRect of drawClipRects) {
    if (interaction?.kind === "move" && !interaction.copyOnStart && interaction.clipIds.includes(sourceRect.clip.clip_id)) {
      continue;
    }
    if (movePreviewFollowerIds.has(sourceRect.clip.clip_id)) continue;
    drawClipRect(env, sourceRect);
  }

  if (pendingKeep && interaction === null) {
    for (const copy of pendingKeep.copies) {
      if (clipRects.some((rect) => rect.clip.clip_id === copy.clipId)) continue;
      const sourceRect = clipRects.find((rect) => rect.clip.clip_id === copy.sourceClipId);
      const targetRow = trackRowOf(trackRows, copy.trackId);
      if (!sourceRect || !targetRow) continue;
      const durationUs = sourceRect.clip.timeline_end_us - sourceRect.clip.timeline_start_us;
      drawClipRect(env, {
        ...sourceRect,
        clip: {
          ...sourceRect.clip,
          clip_id: copy.clipId,
          track_id: copy.trackId,
          timeline_start_us: copy.startUs,
          timeline_end_us: copy.startUs + durationUs,
        },
        x: timeToX(copy.startUs, view),
        y: targetRow.y,
        height: targetRow.height,
      });
    }
  }

  if (interaction?.kind === "move" && !interaction.copyOnStart && interaction.dragPlan?.lead && !interaction.dragPlan.reason) {
    for (const clipId of movePreviewFollowerIds) {
      const placement = movePreviewPositionById.get(clipId);
      const sourceRect = clipRects.find((rect) => rect.clip.clip_id === clipId);
      const targetRow = placement ? trackRowOf(trackRows, placement.trackId) : null;
      if (!placement || !sourceRect || !targetRow) continue;
      const durationUs = sourceRect.clip.timeline_end_us - sourceRect.clip.timeline_start_us;
      drawClipRect(env, {
        ...sourceRect,
        clip: {
          ...sourceRect.clip,
          track_id: placement.trackId,
          timeline_start_us: placement.startUs,
          timeline_end_us: placement.startUs + durationUs,
        },
        x: timeToX(placement.startUs, view),
        y: targetRow.y,
        height: targetRow.height,
      });
    }
  }
}

export function drawCaptionsAndKeyframesLayer(
  ctx: CanvasRenderingContext2D,
  view: TimelineViewState,
  clipRects: ClipRenderRect[],
  drawCaptionRects: CaptionRenderRect[],
  selection: TimelineSelection,
): void {
  for (const rect of drawCaptionRects) {
    const isSelected = selection?.kind === "caption" && selection.id === rect.caption.caption_id;
    const isActive = isSelected;
    const isEdited = rect.caption.edited;

    if (rect.width < 10) continue;

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

    if (isSelected || isActive) {
      ctx.strokeStyle = isSelected ? "#ffc87a" : "#e0b060";
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.stroke();
    }

    if (rect.width > 20) {
      ctx.fillStyle = "#ffffff";
      ctx.font = isEdited ? 'italic 10px "Inter Variable", sans-serif' : '10px "Inter Variable", sans-serif';
      ctx.textBaseline = "middle";
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x + 4, bgY, rect.width - 8, bgH);
      ctx.clip();

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

    if (isEdited && rect.width > 30) {
      ctx.fillStyle = "#ffcc00";
      ctx.beginPath();
      ctx.arc(rect.x + rect.width - 8, bgY + 8, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Keyframe lanes (expanded panel below selected clip)
  const laneColors: Record<string, string> = {
    position: "#6fd3d3",
    scale: "#f0d264",
    rotate: "#f0a264",
    opacity: "#ffffff",
  };
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
      ctx.font = '9px "Inter Variable", sans-serif';
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
}
