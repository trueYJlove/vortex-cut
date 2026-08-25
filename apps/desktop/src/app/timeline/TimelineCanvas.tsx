/**
 * Timeline Phase 1 — Canvas + DOM hybrid timeline component.
 * Replaces the inline TimelinePanel in App.tsx.
 *
 * Architecture:
 * - DOM: toolbar, track headers, drop zones
 * - Canvas: ruler ticks, clip blocks, caption blocks, playhead, selection highlight
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
  type TimelineSelection,
  type TimelineViewState,
} from "./types.js";

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

// ── Geometry computation ─────────────────────────────────────────────────────

function computeClipRects(
  clips: TimelineClip[],
  view: TimelineViewState,
): ClipRenderRect[] {
  return clips.map((clip, index) => {
    const trackIndex = clip.track_id === "A1" ? 1 : 0;
    return {
      x: view.headerWidth + (clip.timeline_start_us / 1_000_000) * view.pixelsPerSecond,
      y: view.rulerHeight + trackIndex * view.trackHeight,
      width: Math.max(2, ((clip.timeline_end_us - clip.timeline_start_us) / 1_000_000) * view.pixelsPerSecond),
      height: view.trackHeight,
      clip,
      index,
    };
  });
}

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

// ── Drag state ───────────────────────────────────────────────────────────────

/** Active clip drag-reorder state (Timeline Phase 3). */
interface DragState {
  clipId: TimelineClipId;
  startX: number;
  originalIndex: number;
  currentIndex: number;
}

// ── Audio waveform data (Timeline Phase 4) ──────────────────────────────────

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
  dragState: DragState | null,
  totalUs: number,
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

  // Clips
  for (const rect of clipRects) {
    const isSelected = selection?.kind === "clip" && selection.id === rect.clip.clip_id;
    const isLocked = false; // locked state comes from document.locked_elements, handled via prop

    // Clip body
    ctx.fillStyle = isSelected ? "#4a90d9" : rect.clip.asset_kind === "audio" ? "#8a5a9a" : rect.clip.asset_kind === "video" ? "#3a6ea5" : "#5a8a5a";
    ctx.fillRect(rect.x, rect.y + 2, rect.width, rect.height - 4);

    // Draw thumbnail frames if available
    if (thumbnailCache && rect.width > 10) {
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

    // Waveform overlay (video clips only; semi-transparent over thumbnails)
    if (waveformCache && rect.clip.asset_kind === "video" && rect.width > 20) {
      const peaks = waveformCache.get(rect.clip.clip_id);
      if (peaks && peaks.length > 0) {
        const padding = 6;
        const maxHeight = Math.max(4, rect.height - 4 - padding * 2);
        const barWidth = 1;
        const barTotal = barWidth + 1; // bar + gap
        const drawableWidth = Math.max(1, rect.width - 4);
        const count = Math.min(peaks.length, Math.floor(drawableWidth / barTotal));
        const centerY = rect.y + 2 + (rect.height - 4) / 2;
        ctx.fillStyle = "rgba(100, 200, 255, 0.5)";
        for (let i = 0; i < count; i++) {
          const amp = Math.min(1, peaks[i] * WAVEFORM_GAIN);
          const h = Math.max(1, maxHeight * amp);
          ctx.fillRect(rect.x + 2 + i * barTotal, centerY - h / 2, barWidth, h);
        }
      }
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
      const label = `Clip ${rect.index + 1}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x + 4, rect.y + 2, rect.width - 8, rect.height - 4);
      ctx.clip();
      ctx.fillText(label, rect.x + 6, rect.y + rect.height / 2);
      ctx.restore();
    }
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

  // Drag reorder feedback: ghost clip + insertion indicator at the landing slot
  if (dragState) {
    const draggedRect = clipRects.find((r) => r.clip.clip_id === dragState.clipId);
    const targetRect = clipRects[dragState.currentIndex];
    if (draggedRect && targetRect) {
      // Moving right inserts after the clip currently at currentIndex; moving
      // left inserts before it. Clips are packed, so x positions reflect order.
      const targetX =
        dragState.currentIndex > dragState.originalIndex
          ? targetRect.x + targetRect.width
          : targetRect.x;

      // Ghost of the dragged clip at its landing position
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = draggedRect.clip.asset_kind === "video" ? "#3a6ea5" : "#5a8a5a";
      ctx.fillRect(targetX, draggedRect.y + 2, draggedRect.width, draggedRect.height - 4);
      ctx.strokeStyle = "#7ab8ff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(targetX, draggedRect.y + 2, draggedRect.width, draggedRect.height - 4);
      ctx.restore();

      // Insertion indicator line
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(targetX, draggedRect.y);
      ctx.lineTo(targetX, draggedRect.y + draggedRect.height);
      ctx.stroke();
    }
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

// ── Hit testing ──────────────────────────────────────────────────────────────

function hitTestClips(
  x: number,
  y: number,
  clipRects: ClipRenderRect[],
): TimelineClipId | null {
  for (const rect of clipRects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.clip.clip_id;
    }
  }
  return null;
}

function hitTestCaptions(
  x: number,
  y: number,
  captionRects: CaptionRenderRect[],
): string | null {
  for (const rect of captionRects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.caption.caption_id;
    }
  }
  return null;
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
  /** Optional seek callback invoked when a caption is clicked (transcript overlay). */
  onSeek?: (timeUs: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TimelineViewState>(DEFAULT_VIEW_STATE);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 200 });
  // Drag reorder state (Phase 3): null when no drag is in progress.
  const [dragState, setDragState] = useState<DragState | null>(null);
  // Synchronous mirror of dragState so pointer handlers always read the latest value.
  const dragStateRef = useRef<DragState | null>(null);

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
  const [, setThumbnailVersion] = useState(0); // trigger re-render when images load

  // Waveform peak cache (Phase 4): clip_id -> amplitude peaks (0..1).
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

  // Load waveform peaks for visible video clips (Phase 4).
  // Only video clips carry audio — image clips are skipped. Decoding runs fully
  // async (fetch + OfflineAudioContext), so it never blocks rendering; failures
  // (e.g. media with no audio track) are skipped silently. Decoded peaks are
  // cached permanently for the lifetime of the component.
  useEffect(() => {
    if (!getAudioDecodeContext()) return;
    const cache = waveformCache.current;

    const documentClipIds = new Set<string>();
    for (const rect of clipRects) {
      if (rect.clip.asset_kind === "video") documentClipIds.add(rect.clip.clip_id);
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
      if (clip.asset_kind !== "video") continue;
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
      dragState,
      totalUs,
      thumbnailCache.current,
      waveformCache.current,
    );
  }, [canvasSize, view, clipRects, captionRects, ticks, playheadUs, selection, dragState, totalUs, waveformVersion]);

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

  // Click to select
  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const clipId = hitTestClips(x, y, clipRects);
      if (clipId) {
        setSelection({ kind: "clip", id: clipId });
        return;
      }
      const captionId = hitTestCaptions(x, y, captionRects);
      if (captionId) {
        const caption = captions.find((c) => c.caption_id === captionId);
        if (caption && onSeek) onSeek(caption.start_us);
        setSelection({ kind: "caption", id: captionId });
        return;
      }
      setSelection(null);
    },
    [clipRects, captionRects, captions, onSeek, setSelection],
  );

  // Clip drag reorder (Phase 3)

  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const clipId = hitTestClips(x, y, clipRects);
      if (!clipId || document?.locked_elements?.includes(clipId)) return;
      const clip = clips.find((c) => c.clip_id === clipId);
      if (!clip) return;

      const next: DragState = {
        clipId,
        startX: x,
        originalIndex: clip.order_index,
        currentIndex: clip.order_index,
      };
      dragStateRef.current = next;
      setDragState(next);
      canvas.style.cursor = "grabbing";
    },
    [clipRects, clips, document?.locked_elements],
  );

  const handleCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const active = dragStateRef.current;
      if (active) {
        // One index position ≈ one average clip width on screen.
        const avgWidth =
          clipRects.length > 0
            ? clipRects.reduce((sum, r) => sum + r.width, 0) / clipRects.length
            : view.pixelsPerSecond * 2;
        const indexOffset = avgWidth > 0 ? (x - active.startX) / avgWidth : 0;
        const target = Math.max(
          0,
          Math.min(clips.length - 1, active.originalIndex + Math.round(indexOffset)),
        );
        if (target !== active.currentIndex) {
          const next = { ...active, currentIndex: target };
          dragStateRef.current = next;
          setDragState(next);
        }
        canvas.style.cursor = "grabbing";
      } else {
        // Hover cursor: "grab" over non-locked clips, "default" elsewhere.
        const clipId = hitTestClips(x, y, clipRects);
        const locked = clipId ? document?.locked_elements?.includes(clipId) : false;
        canvas.style.cursor = clipId && !locked ? "grab" : "default";
      }
    },
    [clipRects, clips.length, view.pixelsPerSecond, document?.locked_elements],
  );

  const finishDrag = useCallback(() => {
    const active = dragStateRef.current;
    if (active && active.currentIndex !== active.originalIndex) {
      void onPatch(
        [{ op: "move_clip", clip_id: active.clipId, to_index: active.currentIndex }],
        "移动片段",
      );
    }
    dragStateRef.current = null;
    setDragState(null);
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "default";
  }, [onPatch]);

  // Finish the drag even when the pointer leaves the canvas mid-drag.
  const isDragging = dragState !== null;
  useEffect(() => {
    if (!isDragging) return;
    const handleWindowMouseUp = () => finishDrag();
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => window.removeEventListener("mouseup", handleWindowMouseUp);
  }, [isDragging, finishDrag]);

  // Drag & drop
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

  const selectedClip =
    selection?.kind === "clip" ? clips.find((c) => c.clip_id === selection.id) : undefined;
  const selectedCaption =
    selection?.kind === "caption"
      ? captions.find((c) => c.caption_id === selection.id)
      : undefined;
  const clipLocked = Boolean(
    selectedClip && document?.locked_elements?.includes(selectedClip.clip_id),
  );
  const captionLocked = Boolean(
    selectedCaption?.source_clip_id &&
      document?.locked_elements?.includes(selectedCaption.source_clip_id),
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
          label={clipLocked ? "解锁片段" : "锁定片段"}
          disabled={!selectedClip}
          onClick={() =>
            selectedClip &&
            void onPatch(
              [{ op: "set_clip_locked", clip_id: selectedClip.clip_id, locked: !clipLocked }],
              clipLocked ? "解锁片段" : "锁定片段",
            )
          }
        >
          {clipLocked ? <LockOpen /> : <Lock />}
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
          disabled={!selection || clipLocked || captionLocked}
          onClick={() =>
            selection &&
            void onPatch(
              [
                selection.kind === "clip"
                  ? { op: "remove_clip", clip_id: selection.id as never }
                  : { op: "remove_caption", caption_id: selection.id as never },
              ],
              selection.kind === "clip" ? "删除片段" : "删除字幕",
            )
          }
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
              <strong>V1 视频</strong>
              <span>{clips.filter(c => c.track_id === "V1").length} 个片段</span>
            </div>
          </div>
          <div className="timeline-left-track" style={{ height: view.trackHeight, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: "12px", color: "#aaa", whiteSpace: "nowrap" }}>A1 音频</span>
          </div>
          <div
            className="timeline-left-track timeline-left-caption"
            style={{ height: view.trackHeight, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ fontSize: "12px", color: "#aaa", whiteSpace: "nowrap" }}>C1 字幕</span>
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
            onClick={handleCanvasClick}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={finishDrag}
            onDragOver={(event) => { event.preventDefault(); allowDrop(event, clips.length); }}
            onDrop={(event) => handleDrop(event, dropIndex ?? clips.length)}
            onDragLeave={() => setDropIndex(null)}
            onDragEnd={() => setDropIndex(null)}
            style={{ display: "block", cursor: "default" }}
          />
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