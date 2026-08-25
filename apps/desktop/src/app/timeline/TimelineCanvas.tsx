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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Lock,
  LockOpen,
  Minus,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Video,
} from "lucide-react";
import type {
  AssetKind,
  TimelineCaption,
  TimelineClip,
  TimelineClipId,
  TimelineDocument,
  TimelinePatchOperation,
} from "@aivideo/contracts";
import {
  DEFAULT_VIEW_STATE,
  ZOOM_MAX_PPS,
  ZOOM_MIN_PPS,
  type AssetMediaEntry,
  type CaptionRenderRect,
  type ClipRenderRect,
  type TickMark,
  type TimelineHover,
  type TimelineInteraction,
  type TimelineSelection,
  type TimelineViewState,
  type TrimEdge,
} from "./types.js";
import {
  MIN_CLIP_US,
  SNAP_PX,
  TRIM_HANDLE_PX,
  clipDuration,
  clipsInRect,
  computeClipRects,
  computeV1TargetIndex,
  ghostPosition,
  hitTestClips,
  hitTestTrimHandle,
  marqueeRect,
  packV1Clips,
  snapCandidates,
  snapValue,
  timeToX,
  v1ReorderToMixedIndex,
  xToTime,
} from "./geometry.js";

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

const duration = (document?: TimelineDocument) =>
  document?.clips.at(-1)?.timeline_end_us ?? 0;

const zoomPctToPps = (zoom: number) =>
  ZOOM_MIN_PPS * Math.pow(ZOOM_MAX_PPS / ZOOM_MIN_PPS, zoom / 100);
const ppsToZoomPct = (pps: number) =>
  (100 * Math.log(pps / ZOOM_MIN_PPS)) / Math.log(ZOOM_MAX_PPS / ZOOM_MIN_PPS);

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="icon-btn"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ── Thumbnail frame URL computation ──────────────────────────────────────────

/** Compute frame URLs for a clip, matching App.tsx buildClipFrames logic. */
function computeFrameUrls(
  mediaUrl: string | null,
  assetKind: AssetKind,
  sourceStartUs: number,
  sourceEndUs: number,
  pps: number,
): string[] {
  if (!mediaUrl) return [];
  if (assetKind === "image") return [mediaUrl];
  if (assetKind !== "video") return [];
  const sourceDurationUs = sourceEndUs - sourceStartUs;
  if (sourceDurationUs <= 0) return [];
  const widthPx = (sourceDurationUs / 1_000_000) * pps;
  const count = Math.max(1, Math.min(16, Math.round(widthPx / 56)));
  const urls: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const tUs = sourceStartUs + ((i + 0.5) * sourceDurationUs) / count;
    urls.push(`${mediaUrl}#t=${tUs / 1_000_000}`);
  }
  return urls;
}

// ── Caption geometry ─────────────────────────────────────────────────────────

function computeCaptionRects(
  captions: TimelineCaption[],
  view: TimelineViewState,
): CaptionRenderRect[] {
  return captions.map((caption) => ({
    x: view.headerWidth + (caption.start_us / 1_000_000) * view.pixelsPerSecond,
    y: view.rulerHeight + 2 * view.trackHeight,
    width: Math.max(2, ((caption.end_us - caption.start_us) / 1_000_000) * view.pixelsPerSecond),
    height: view.trackHeight,
    caption,
  }));
}

function computeTicks(
  totalUs: number,
  pps: number,
  headerWidth: number,
  frameRate: number,
): TickMark[] {
  const tickSpacingSecs =
    pps >= 200 ? 2 / frameRate : pps >= 100 ? 0.5 : pps >= 50 ? 1 : pps >= 25 ? 2 : pps >= 10 ? 5 : 10;
  const ticks: TickMark[] = [];
  if (totalUs <= 0) return ticks;
  const intervalUs = tickSpacingSecs * 1_000_000;
  const count = Math.min(400, Math.ceil(totalUs / intervalUs) + 1);
  for (let i = 0; i < count; i += 1) {
    const timeUs = i * intervalUs;
    const x = headerWidth + (timeUs / 1_000_000) * pps;
    const major = i % 5 === 0;
    const label =
      tickSpacingSecs < 1
        ? `${Math.round((timeUs / 1_000_000) * frameRate)}f`
        : formatRulerTime(timeUs);
    ticks.push({ x, label, major });
  }
  return ticks;
}

// ── Audio waveform data ──────────────────────────────────────────────────────

/** Number of amplitude peaks kept per clip (visual resolution vs memory). */
const WAVEFORM_PEAK_COUNT = 200;
/** Amplitude gain applied at draw time so quiet audio stays visible. */
const WAVEFORM_GAIN = 1.4;

/** Lazily created Web Audio context used only for decodeAudioData(). */
let audioDecodeContext: AudioContext | OfflineAudioContext | null = null;

/** Create (once) a decoding context; returns null when Web Audio is unavailable. */
function getAudioDecodeContext(): AudioContext | OfflineAudioContext | null {
  if (audioDecodeContext) return audioDecodeContext;
  try {
    if (typeof OfflineAudioContext !== "undefined") {
      // Offline context never touches the audio output device, so no user
      // gesture is required and nothing audible is produced.
      audioDecodeContext = new OfflineAudioContext(1, 1, 44100);
    } else if (typeof AudioContext !== "undefined") {
      // Fallback for renderers without OfflineAudioContext.
      audioDecodeContext = new AudioContext();
      void audioDecodeContext.resume().catch(() => undefined);
    }
  } catch {
    audioDecodeContext = null;
  }
  return audioDecodeContext;
}

/** Reduce an AudioBuffer to per-peak amplitudes (mono / left channel). */
function extractPeaks(buffer: AudioBuffer, numPeaks: number): Float32Array {
  if (numPeaks <= 0) return new Float32Array(0);
  const channel = buffer.getChannelData(0);
  if (channel.length === 0) return new Float32Array(numPeaks);
  const peaks = new Float32Array(numPeaks);
  const samplesPerPeak = Math.floor(channel.length / numPeaks);
  if (samplesPerPeak <= 0) {
    // Fewer audio samples than requested peaks: mirror the samples we have.
    for (let i = 0; i < numPeaks; i++) {
      peaks[i] = Math.abs(channel[Math.min(i, channel.length - 1)]);
    }
    return peaks;
  }
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, channel.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }
  return peaks;
}

/** Decode an ArrayBuffer into peaks; resolves null on any failure. */
async function decodeAudioPeaks(
  arrayBuffer: ArrayBuffer,
  numPeaks: number,
): Promise<Float32Array | null> {
  const ctx = getAudioDecodeContext();
  if (!ctx) return null;
  try {
    // decodeAudioData() detaches the buffer; pass a copy so callers stay safe.
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return extractPeaks(audioBuffer, numPeaks);
  } catch {
    // No audio track, unsupported codec, etc. — skip silently.
    return null;
  }
}

// ── Canvas drawing ───────────────────────────────────────────────────────────

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: TimelineViewState,
  clipRects: ClipRenderRect[],
  captionRects: CaptionRenderRect[],
  ticks: TickMark[],
  playheadUs: number,
  selection: TimelineSelection,
  interaction: TimelineInteraction | null,
  hover: TimelineHover,
  totalUs: number,
  lockedElements: string[],
  thumbnailCache?: Map<string, HTMLImageElement>,
  waveformCache?: Map<string, Float32Array>,
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, width, height);

  // Ruler background
  ctx.fillStyle = "#16213e";
  ctx.fillRect(view.headerWidth, 0, width - view.headerWidth, view.rulerHeight);

  // Track backgrounds (3 tracks: V1, A1, C1)
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(view.headerWidth, view.rulerHeight, width - view.headerWidth, view.trackHeight);
  ctx.fillStyle = "#16213e";
  ctx.fillRect(view.headerWidth, view.rulerHeight + view.trackHeight, width - view.headerWidth, view.trackHeight);
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(view.headerWidth, view.rulerHeight + view.trackHeight * 2, width - view.headerWidth, view.trackHeight);

  // Grid lines between tracks
  ctx.strokeStyle = "#2a2a4a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(view.headerWidth, view.rulerHeight);
  ctx.lineTo(width, view.rulerHeight);
  ctx.moveTo(view.headerWidth, view.rulerHeight + view.trackHeight);
  ctx.lineTo(width, view.rulerHeight + view.trackHeight);
  ctx.moveTo(view.headerWidth, view.rulerHeight + view.trackHeight * 2);
  ctx.lineTo(width, view.rulerHeight + view.trackHeight * 2);
  ctx.moveTo(view.headerWidth, view.rulerHeight + view.trackHeight * 3);
  ctx.lineTo(width, view.rulerHeight + view.trackHeight * 3);
  ctx.stroke();

  // Ticks
  ctx.textBaseline = "bottom";
  ctx.font = "10px monospace";
  for (const tick of ticks) {
    ctx.strokeStyle = tick.major ? "#8888aa" : "#444466";
    ctx.lineWidth = tick.major ? 1 : 0.5;
    ctx.beginPath();
    ctx.moveTo(tick.x, tick.major ? 0 : view.rulerHeight * 0.5);
    ctx.lineTo(tick.x, view.rulerHeight);
    ctx.stroke();
    if (tick.major) {
      ctx.fillStyle = "#aaaacc";
      ctx.fillText(tick.label, tick.x + 3, view.rulerHeight - 2);
    }
  }

  const selectedIds =
    selection?.kind === "clip"
      ? [selection.id]
      : selection?.kind === "clips"
        ? selection.ids
        : [];

  const trimmable = (clip: TimelineClip) =>
    clip.asset_kind === "video" || clip.asset_kind === "audio";

  // Clips
  for (const rect of clipRects) {
    const isSelected = selectedIds.includes(rect.clip.clip_id);
    const isLocked = lockedElements.includes(rect.clip.clip_id);

    // Clip body
    ctx.fillStyle = isSelected
      ? "#4a90d9"
      : rect.clip.asset_kind === "audio"
        ? "#8a5a9a"
        : rect.clip.asset_kind === "video"
          ? "#3a6ea5"
          : "#5a8a5a";
    ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);

    // Draw thumbnail frames if available
    if (thumbnailCache && rect.width > 10 && rect.clip.asset_kind === "video") {
      const frameCount = Math.max(1, Math.min(16, Math.round(rect.width / 56)));
      const frameWidth = rect.width / frameCount;
      for (let fi = 0; fi < frameCount; fi++) {
        const key = `${rect.clip.clip_id}:${fi}`;
        const img = thumbnailCache.get(key);
        if (img && img.complete && img.naturalWidth > 0) {
          try {
            ctx.drawImage(
              img,
              rect.x + fi * frameWidth,
              rect.y + 2,
              frameWidth,
              rect.height - 4,
            );
          } catch { /* ignore draw errors */ }
        }
      }
    }

    // Waveform overlay (video clips carry audio; audio clips are pure audio)
    if (waveformCache && rect.clip.asset_kind !== "image" && rect.width > 20) {
      const peaks = waveformCache.get(rect.clip.clip_id);
      if (peaks && peaks.length > 0) {
        const padding = 6;
        const maxHeight = Math.max(4, rect.height - 4 - padding * 2);
        const barWidth = 1;
        const barTotal = barWidth + 1; // bar + gap
        const drawableWidth = Math.max(1, rect.width - 4);
        const count = Math.min(peaks.length, Math.floor(drawableWidth / barTotal));
        const centerY = rect.y + 2 + (rect.height - 4) / 2;
        ctx.fillStyle =
          rect.clip.asset_kind === "audio"
            ? "rgba(255, 200, 120, 0.55)"
            : "rgba(100, 200, 255, 0.5)";
        for (let i = 0; i < count; i++) {
          const amp = Math.min(1, peaks[i] * WAVEFORM_GAIN);
          const h = Math.max(1, maxHeight * amp);
          ctx.fillRect(rect.x + 2 + i * barTotal, centerY - h / 2, barWidth, h);
        }
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
    }

    // Selection border
    if (isSelected) {
      ctx.strokeStyle = "#7ab8ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y + 2, rect.width, rect.height - 4);
    }

    // Clip label
    if (rect.width > 30) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "middle";
      const label =
        rect.clip.asset_kind === "audio"
          ? `Audio ${rect.clip.order_index + 1}`
          : `Clip ${rect.clip.order_index + 1}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x + 4, rect.y + 2, rect.width - 8, rect.height - 4);
      ctx.clip();
      ctx.fillText(label, rect.x + 6, rect.y + rect.height / 2);
      ctx.restore();
    }
  }

  // Trim handles: single selected clip (Phase 4) or hovered clip
  const handleTargets = new Map<TimelineClipId, ClipRenderRect>();
  if (selection?.kind === "clip") {
    const rect = clipRects.find((r) => r.clip.clip_id === selection.id);
    if (rect && trimmable(rect.clip)) handleTargets.set(rect.clip.clip_id, rect);
  }
  if (hover.clipId && hover.edge) {
    const rect = clipRects.find((r) => r.clip.clip_id === hover.clipId);
    if (rect && trimmable(rect.clip)) handleTargets.set(rect.clip.clip_id, rect);
  }
  for (const rect of handleTargets.values()) {
    const handleY = rect.y + 6;
    const handleH = rect.height - 12;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rect.x - 3, handleY, 6, handleH);
    ctx.fillRect(rect.x + rect.width - 3, handleY, 6, handleH);
    ctx.strokeStyle = "#7ab8ff";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x - 3, handleY, 6, handleH);
    ctx.strokeRect(rect.x + rect.width - 3, handleY, 6, handleH);
  }

  // Captions (enhanced transcript style)
  for (const rect of captionRects) {
    const isSelected = selection?.kind === "caption" && selection.id === rect.caption.caption_id;
    const isActive = playheadUs >= rect.caption.start_us && playheadUs < rect.caption.end_us;
    const isEdited = rect.caption.edited;

    // Skip if too narrow
    if (rect.width < 10) continue;

    // Background with rounded corners
    const bgY = rect.y + 2;
    const bgH = rect.height - 4;
    ctx.fillStyle = isSelected ? "#d9a04a" : isActive ? "#b8863a" : "#8a6a3a";
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

  // Drag ghost (move / trim)
  if (interaction?.kind === "move") {
    const clip = clipRects.find((r) => r.clip.clip_id === interaction.clipId)?.clip;
    if (clip) {
      const ghost = ghostPosition(clipRects.map((r) => r.clip), clip, interaction.targetStartUs);
      const gx = timeToX(ghost.startUs, view);
      const gy = view.rulerHeight + (clip.track_id === "A1" ? 1 : 0) * view.trackHeight;
      const gw = Math.max(2, ((ghost.endUs - ghost.startUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = clip.asset_kind === "audio" ? "#8a5a9a" : clip.asset_kind === "video" ? "#3a6ea5" : "#5a8a5a";
      ctx.fillRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.strokeStyle = "#7ab8ff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.restore();
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
      const gy = view.rulerHeight + (clip.track_id === "A1" ? 1 : 0) * view.trackHeight;
      const gw = Math.max(2, ((ghostEndUs - ghostStartUs) / 1_000_000) * view.pixelsPerSecond);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = clip.asset_kind === "audio" ? "#8a5a9a" : "#3a6ea5";
      ctx.fillRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.strokeStyle = "#ffd76e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(gx, gy + 2, gw, view.trackHeight - 4);
      ctx.restore();
    }
  }

  // Snap guide (Phase 4)
  const snapUs =
    (interaction?.kind === "move" || interaction?.kind === "trim") ? interaction.snapUs : null;
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

  // Marquee selection rect (Phase 4)
  if (interaction?.kind === "marquee") {
    const rect = marqueeRect(
      interaction.startX,
      interaction.startY,
      interaction.currentX,
      interaction.currentY,
    );
    ctx.fillStyle = "rgba(74, 144, 217, 0.12)";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = "#7ab8ff";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
  }

  // Playhead
  const playheadX = view.headerWidth + (playheadUs / 1_000_000) * view.pixelsPerSecond;
  if (playheadX >= view.headerWidth && playheadX <= width) {
    ctx.strokeStyle = "#ff4444";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Playhead triangle at top
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();
  }
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
  playheadUs,
  onSeek,
}: {
  document?: TimelineDocument;
  selection: TimelineSelection;
  setSelection: (selection: TimelineSelection) => void;
  onPatch: (ops: TimelinePatchOperation[], summary: string) => Promise<void>;
  onDropAsset: (assetId: string, atIndex: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  assetMedia: AssetMediaEntry[];
  playheadUs: number;
  /** Optional seek callback invoked when the playhead is dragged or a caption is clicked. */
  onSeek?: (timeUs: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TimelineViewState>(DEFAULT_VIEW_STATE);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 200 });
  // Active pointer interaction (Phase 4): null when idle.
  const [interaction, setInteraction] = useState<TimelineInteraction | null>(null);
  // Synchronous mirror of interaction so pointer handlers always read the latest value.
  const interactionRef = useRef<TimelineInteraction | null>(null);
  // Hover state (trim handles + cursor).
  const [hover, setHover] = useState<TimelineHover>({ clipId: null, edge: null });

  const clips = document?.clips ?? [];
  const captions = document?.captions ?? [];
  const totalUs = duration(document);
  const frameRate =
    document?.canvas?.fps_num && document?.canvas?.fps_den
      ? document.canvas.fps_num / document.canvas.fps_den
      : 30;

  // Compute geometry
  const clipRects = computeClipRects(clips, view);
  const captionRects = computeCaptionRects(captions, view);
  const ticks = computeTicks(totalUs, view.pixelsPerSecond, view.headerWidth, frameRate);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Thumbnail image cache: key = "clipId:frameIndex" -> loaded HTMLImageElement
  const thumbnailCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const [thumbnailVersion, setThumbnailVersion] = useState(0); // trigger re-render when images load

  // Waveform peak cache: clip_id -> amplitude peaks (0..1).
  const waveformCache = useRef<Map<string, Float32Array>>(new Map());
  const [waveformVersion, setWaveformVersion] = useState(0); // trigger re-render when peaks load
  // Clip ids with an in-flight decode, to avoid duplicate fetches per render.
  const pendingWaveforms = useRef<Set<string>>(new Set());

  // Load thumbnail images for visible clips
  useEffect(() => {
    const cache = thumbnailCache.current;
    const activeKeys = new Set<string>();
    for (const rect of clipRects) {
      const mediaUrl = assetMedia.find((m) => m.asset_id === rect.clip.asset_id)?.media_url ?? null;
      const urls = computeFrameUrls(
        mediaUrl,
        rect.clip.asset_kind,
        rect.clip.source_start_us ?? 0,
        rect.clip.source_end_us ?? 0,
        view.pixelsPerSecond,
      );
      for (let fi = 0; fi < urls.length; fi++) {
        const key = `${rect.clip.clip_id}:${fi}`;
        activeKeys.add(key);
        if (!cache.has(key)) {
          const img = new Image();
          img.src = urls[fi];
          img.onload = () => setThumbnailVersion((v) => v + 1);
          cache.set(key, img);
        }
      }
    }
    for (const key of cache.keys()) {
      if (!activeKeys.has(key)) cache.delete(key);
    }
  }, [clipRects, assetMedia, view.pixelsPerSecond]);

  // Load waveform peaks for visible video and audio clips. Decoding runs fully
  // async (fetch + OfflineAudioContext), so it never blocks rendering; failures
  // (e.g. media with no audio track) are skipped silently. Decoded peaks are
  // cached permanently for the lifetime of the component.
  useEffect(() => {
    if (!getAudioDecodeContext()) return;
    const cache = waveformCache.current;

    const documentClipIds = new Set<string>();
    for (const rect of clipRects) {
      if (rect.clip.asset_kind !== "image") documentClipIds.add(rect.clip.clip_id);
    }
    // Prune entries for clips that no longer exist in the document.
    for (const key of cache.keys()) {
      if (!documentClipIds.has(key)) cache.delete(key);
    }

    // Visible viewport in content coordinates (scrollX is 0 until scrolling is
    // wired up, so this also gates future horizontal panning).
    const viewLeft = view.scrollX;
    const viewRight = view.scrollX + canvasSize.width;

    for (const rect of clipRects) {
      const clip = rect.clip;
      if (clip.asset_kind === "image") continue;
      if (cache.has(clip.clip_id) || pendingWaveforms.current.has(clip.clip_id)) continue;
      // Only start decoding clips currently on screen.
      if (rect.x + rect.width <= viewLeft || rect.x >= viewRight) continue;

      const mediaUrl = assetMedia.find((m) => m.asset_id === clip.asset_id)?.media_url ?? null;
      if (!mediaUrl) continue;

      pendingWaveforms.current.add(clip.clip_id);
      fetch(mediaUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`waveform fetch failed: ${res.status}`);
          return res.arrayBuffer();
        })
        .then((buf) => decodeAudioPeaks(buf, WAVEFORM_PEAK_COUNT))
        .then((peaks) => {
          if (peaks) {
            cache.set(clip.clip_id, peaks);
            setWaveformVersion((v) => v + 1);
          }
        })
        .catch(() => { /* fetch/decode failure — skip silently */ })
        .finally(() => {
          pendingWaveforms.current.delete(clip.clip_id);
        });
    }
  }, [clipRects, assetMedia, view.scrollX, view.pixelsPerSecond, canvasSize.width]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawTimeline(
      ctx,
      canvasSize.width,
      canvasSize.height,
      view,
      clipRects,
      captionRects,
      ticks,
      playheadUs,
      selection,
      interaction,
      hover,
      totalUs,
      document?.locked_elements ?? [],
      thumbnailCache.current,
      waveformCache.current,
    );
  }, [canvasSize, view, clipRects, captionRects, ticks, playheadUs, selection, interaction, hover, totalUs, thumbnailVersion, waveformVersion]);

  // Zoom via wheel
  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      setView((v) => ({
        ...v,
        pixelsPerSecond: Math.max(
          ZOOM_MIN_PPS,
          Math.min(ZOOM_MAX_PPS, v.pixelsPerSecond * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
        ),
      }));
    },
    [],
  );

  // ── Pointer interactions (Phase 4) ─────────────────────────────────────────

  const canvasCoords = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const isClipLocked = (clipId: TimelineClipId) =>
    Boolean(document?.locked_elements?.includes(clipId));

  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const coords = canvasCoords(event);
      if (!coords) return;
      const { x, y } = coords;
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Ruler area → playhead drag
      if (y <= view.rulerHeight) {
        const timeUs = xToTime(x, view);
        onSeek?.(timeUs);
        const next: TimelineInteraction = { kind: "playhead", startX: x };
        interactionRef.current = next;
        setInteraction(next);
        canvas.style.cursor = "col-resize";
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

      // Clip body → move drag
      const clipId = hitTestClips(x, y, clipRects);
      if (clipId) {
        if (isClipLocked(clipId)) return;
        const clip = clips.find((c) => c.clip_id === clipId);
        if (!clip) return;
        setSelection({ kind: "clip", id: clipId });
        const next: TimelineInteraction = {
          kind: "move",
          clipId,
          startX: x,
          startUs: clip.timeline_start_us,
          targetStartUs: clip.timeline_start_us,
          snapUs: null,
        };
        interactionRef.current = next;
        setInteraction(next);
        canvas.style.cursor = "grabbing";
        return;
      }

      // Caption → select + seek (click only; captions are not draggable yet)
      const captionId = hitTestCaptions(x, y, captionRects);
      if (captionId) {
        const caption = captions.find((c) => c.caption_id === captionId);
        if (caption && onSeek) onSeek(caption.start_us);
        setSelection({ kind: "caption", id: captionId });
        return;
      }

      // Empty area → marquee selection
      if (!event.shiftKey) setSelection(null);
      const next: TimelineInteraction = {
        kind: "marquee",
        startX: x,
        startY: y,
        currentX: x,
        currentY: y,
      };
      interactionRef.current = next;
      setInteraction(next);
      canvas.style.cursor = "crosshair";
    },
    [view.rulerHeight, view, onSeek, clipRects, clips, captionRects, captions, setSelection],
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
        const pps = view.pixelsPerSecond;
        if (active.kind === "playhead") {
          onSeek?.(xToTime(x, view));
          canvas.style.cursor = "col-resize";
          return;
        }
        if (active.kind === "marquee") {
          const next: TimelineInteraction = { ...active, currentX: x, currentY: y };
          interactionRef.current = next;
          setInteraction(next);
          canvas.style.cursor = "crosshair";
          return;
        }
        if (active.kind === "move") {
          const deltaUs = ((x - active.startX) / pps) * 1_000_000;
          const raw = Math.max(0, active.startUs + deltaUs);
          const candidates = snapCandidates(clipRects, playheadUs, active.clipId);
          const threshold = (SNAP_PX / pps) * 1_000_000;
          const snapped = snapValue(raw, candidates, threshold);
          const next: TimelineInteraction = {
            ...active,
            targetStartUs: snapped,
            snapUs: Math.abs(snapped - raw) > 1 ? snapped : null,
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
            const candidates = snapCandidates(clipRects, playheadUs, active.clipId);
            let targetStartUs = active.targetStartUs;
            let targetEndUs = active.targetEndUs;
            let snapUs: number | null = null;
            if (active.edge === "left") {
              const rawStart = Math.max(
                0,
                Math.min(active.originalEndUs - MIN_CLIP_US, active.originalStartUs + deltaUs),
              );
              const visualEdge = clip.timeline_start_us + (rawStart - active.originalStartUs);
              const snapped = snapValue(visualEdge, candidates, threshold);
              targetStartUs = Math.max(
                0,
                Math.min(
                  active.originalEndUs - MIN_CLIP_US,
                  active.originalStartUs + (snapped - clip.timeline_start_us),
                ),
              );
              snapUs = Math.abs(snapped - visualEdge) > 1 ? snapped : null;
            } else {
              const rawEnd = Math.max(active.originalStartUs + MIN_CLIP_US, active.originalEndUs + deltaUs);
              const visualEdge = clip.timeline_end_us + (rawEnd - active.originalEndUs);
              const snapped = snapValue(visualEdge, candidates, threshold);
              targetEndUs = Math.max(
                active.originalStartUs + MIN_CLIP_US,
                active.originalEndUs + (snapped - clip.timeline_end_us),
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
      }

      // Hover cursor + trim handle detection
      const handle = hitTestTrimHandle(x, y, clipRects);
      const nextHover: TimelineHover = handle
        ? { clipId: handle.clipId, edge: handle.edge }
        : { clipId: hitTestClips(x, y, clipRects), edge: null };
      setHover((prev) =>
        prev.clipId === nextHover.clipId && prev.edge === nextHover.edge ? prev : nextHover,
      );
      if (handle) {
        canvas.style.cursor = "ew-resize";
      } else {
        const clipId = hitTestClips(x, y, clipRects);
        const locked = clipId ? isClipLocked(clipId) : false;
        canvas.style.cursor = clipId && !locked ? "grab" : "default";
      }
    },
    [view, onSeek, clipRects, clips, playheadUs],
  );

  const finishInteraction = useCallback(() => {
    const active = interactionRef.current;
    const canvas = canvasRef.current;
    if (active) {
      if (active.kind === "move") {
        const clip = clips.find((c) => c.clip_id === active.clipId);
        if (clip && !isClipLocked(clip.clip_id)) {
          if (clip.track_id === "V1") {
            const v1Clips = clips.filter((c) => c.track_id === "V1");
            const targetIndex = computeV1TargetIndex(v1Clips, clip.clip_id, active.targetStartUs);
            if (targetIndex !== clip.order_index) {
              const toIndex = v1ReorderToMixedIndex(clips, clip.clip_id, targetIndex);
              void onPatch(
                [{ op: "move_clip", clip_id: clip.clip_id, to_index: toIndex }],
                "移动片段",
              );
            }
          } else {
            const rounded = Math.round(active.targetStartUs);
            if (Math.abs(rounded - clip.timeline_start_us) >= 1000) {
              void onPatch(
                [{ op: "position_clip", clip_id: clip.clip_id, timeline_start_us: rounded }],
                "移动音频片段",
              );
            }
          }
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
      } else if (active.kind === "marquee") {
        const rect = marqueeRect(active.startX, active.startY, active.currentX, active.currentY);
        if (rect.width >= 4 && rect.height >= 4) {
          const ids = clipsInRect(rect, clipRects);
          setSelection(ids.length > 0 ? { kind: "clips", ids } : null);
        }
      }
    }
    interactionRef.current = null;
    setInteraction(null);
    if (canvas) canvas.style.cursor = "default";
  }, [clips, clipRects, onPatch, setSelection]);

  // Finish the interaction even when the pointer leaves the canvas mid-drag.
  const hasInteraction = interaction !== null;
  useEffect(() => {
    if (!hasInteraction) return;
    const handleWindowMouseUp = () => finishInteraction();
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => window.removeEventListener("mouseup", handleWindowMouseUp);
  }, [hasInteraction, finishInteraction]);

  const handleCanvasMouseLeave = useCallback(() => {
    if (!interactionRef.current) setHover({ clipId: null, edge: null });
  }, []);

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
    if (assetId) onDropAsset(assetId, index);
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

  const coverClip = clips.find((c) => c.asset_kind === "video" || c.asset_kind === "image");
  const coverUrl = coverClip
    ? assetMedia.find((m) => m.asset_id === coverClip.asset_id)?.media_url ?? null
    : null;

  return (
    <section className="timeline-pane" aria-label="时间线">
      {/* Toolbar (DOM) */}
      <div className="timeline-toolbar">
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
          disabled={!selectedClip || clipLocked || selectedClip.order_index === 0}
          onClick={() =>
            selectedClip &&
            void onPatch(
              [{ op: "move_clip", clip_id: selectedClip.clip_id, to_index: selectedClip.order_index - 1 }],
              "移动片段",
            )
          }
        >
          <ChevronLeft />
        </IconButton>
        <IconButton
          label="向后移动"
          disabled={
            !selectedClip || clipLocked || selectedClip.order_index === clips.length - 1
          }
          onClick={() =>
            selectedClip &&
            void onPatch(
              [{ op: "move_clip", clip_id: selectedClip.clip_id, to_index: selectedClip.order_index + 1 }],
              "移动片段",
            )
          }
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
        <div className="timeline-zoom">
          <button
            aria-label="缩小时间线"
            onClick={() =>
              setView((v) => ({
                ...v,
                pixelsPerSecond: Math.max(ZOOM_MIN_PPS, v.pixelsPerSecond / 1.2),
              }))
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
              setView((v) => ({ ...v, pixelsPerSecond: zoomPctToPps(Number(event.target.value)) }))
            }
          />
          <button
            aria-label="放大时间线"
            onClick={() =>
              setView((v) => ({
                ...v,
                pixelsPerSecond: Math.min(ZOOM_MAX_PPS, v.pixelsPerSecond * 1.2),
              }))
            }
          >
            <Plus />
          </button>
        </div>
      </div>

      {/* Body: left headers (DOM) + canvas area */}
      <div className="timeline-body">
        {/* Left gutter (DOM) */}
        <div className="timeline-left" style={{ width: view.headerWidth }}>
          <div className="timeline-left-corner" style={{ height: view.rulerHeight }} />
          <div className="timeline-left-track" style={{ height: view.trackHeight }}>
            <div className="timeline-left-cover">
              {coverUrl ? <img src={coverUrl} alt="" /> : <Video />}
            </div>
            <div className="timeline-left-meta">
              <strong><span className="timeline-track-id">V1</span> 视频</strong>
              <span>{clips.filter(c => c.track_id === "V1").length} 个片段</span>
            </div>
          </div>
          <div className="timeline-left-track" style={{ height: view.trackHeight, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: "12px", color: "#aaa", whiteSpace: "nowrap" }}><span className="timeline-track-id">A1</span> 音频</span>
          </div>
          <div
            className="timeline-left-track timeline-left-caption"
            style={{ height: view.trackHeight, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ fontSize: "12px", color: "#aaa", whiteSpace: "nowrap" }}><span className="timeline-track-id">C1</span> 字幕</span>
          </div>
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="timeline-canvas-container"
          style={{ flex: 1, position: "relative", overflow: "hidden" }}
          onWheel={handleWheel}
        >
          <canvas
            ref={canvasRef}
            aria-label="时间线画布"
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={finishInteraction}
            onMouseLeave={handleCanvasMouseLeave}
            onDragOver={(event) => { event.preventDefault(); allowDrop(event, clips.length); }}
            onDrop={(event) => handleDrop(event, dropIndex ?? clips.length)}
            onDragLeave={() => setDropIndex(null)}
            onDragEnd={() => setDropIndex(null)}
            style={{ display: "block", cursor: "default" }}
          />
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
                background: "rgba(74, 144, 217, 0.15)",
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
        </div>
      </div>
    </section>
  );
}
