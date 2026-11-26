import { useRef, type MutableRefObject } from "react";
import { SNAP_PX, snapValue, xToTime } from "../../geometry.js";
import type { TimelineMarker } from "../../markers.js";
import type { PlayheadStore } from "../../playhead-store.js";
import { MIN_RANGE_US, normalizeRange, rangeDuration, type TimeRange } from "../../time-range.js";
import type { ClipRenderRect, TimelineViewState } from "../../types.js";

export function clampRulerTime(us: number, totalUs: number): number {
  return totalUs > 0 ? Math.min(us, totalUs) : us;
}

export function resolveRulerSeekTime(opts: {
  us: number;
  totalUs: number;
  snappingEnabled: boolean;
  clipRects: readonly ClipRenderRect[];
  markers: readonly TimelineMarker[];
  pixelsPerSecond: number;
}): number {
  const { us, totalUs, snappingEnabled, clipRects, markers, pixelsPerSecond } = opts;
  const clamped = clampRulerTime(us, totalUs);
  if (!snappingEnabled) return clamped;
  const edges = [
    ...clipRects.flatMap(({ clip }) => [clip.timeline_start_us, clip.timeline_end_us]),
    ...markers.map((marker) => marker.timeUs),
    0,
    totalUs,
  ];
  return clampRulerTime(snapValue(clamped, edges, (SNAP_PX / pixelsPerSecond) * 1_000_000), totalUs);
}

export function useRulerScrubGesture(opts: {
  view: TimelineViewState;
  trackHeadWidth: number;
  totalUs: number;
  snappingEnabled: boolean;
  clipRects: readonly ClipRenderRect[];
  markers: readonly TimelineMarker[];
  activePlayheadStore: PlayheadStore;
  rulerScrubbingRef: MutableRefObject<boolean>;
  setScrubbing: (scrubbing: boolean) => void;
  setRulerHoverUs: (us: number | null) => void;
  timeRange: TimeRange | null;
  setTimeRange: (next: TimeRange | null) => void;
  onSeek?: (timeUs: number) => void;
  onSeekCommit?: (timeUs: number) => void;
  fitToContent: () => void;
}) {
  const {
    view,
    trackHeadWidth,
    totalUs,
    snappingEnabled,
    clipRects,
    markers,
    activePlayheadStore,
    rulerScrubbingRef,
    setScrubbing,
    setRulerHoverUs,
    timeRange,
    setTimeRange,
    onSeek,
    onSeekCommit,
    fitToContent,
  } = opts;

  const rulerPointerId = useRef<number | null>(null);
  const rulerScrubOrigin = useRef(0);
  const rangeDragRef = useRef<{ anchorUs: number; previous: TimeRange | null } | null>(null);

  const rulerPinTimeAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return xToTime(event.clientX - rect.left - trackHeadWidth, view);
  };

  const seekTime = (us: number) =>
    resolveRulerSeekTime({
      us,
      totalUs,
      snappingEnabled,
      clipRects,
      markers,
      pixelsPerSecond: view.pixelsPerSecond,
    });

  const handleRulerPinMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (rulerPointerId.current !== null && rulerPointerId.current !== event.pointerId) return;
    if (
      rulerPointerId.current === null
      && event.clientX - event.currentTarget.getBoundingClientRect().left < trackHeadWidth + view.headerWidth
    ) {
      setRulerHoverUs(null);
      return;
    }
    const timeUs = clampRulerTime(rulerPinTimeAt(event), totalUs);
    setRulerHoverUs(timeUs);
    const rangeDrag = rangeDragRef.current;
    if (rangeDrag) {
      setTimeRange(normalizeRange({ startUs: rangeDrag.anchorUs, endUs: timeUs }, totalUs));
      return;
    }
    if (rulerScrubbingRef.current) onSeek?.(seekTime(timeUs));
  };

  const handleRulerPinDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (
      event.button !== 0
      || rulerPointerId.current !== null
      || totalUs <= 0
      || event.clientX - event.currentTarget.getBoundingClientRect().left < trackHeadWidth + view.headerWidth
    ) {
      return;
    }
    rulerPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    if (event.shiftKey) {
      const anchorUs = clampRulerTime(rulerPinTimeAt(event), totalUs);
      rangeDragRef.current = { anchorUs, previous: timeRange };
      setTimeRange({ startUs: anchorUs, endUs: anchorUs });
      return;
    }
    rulerScrubOrigin.current = activePlayheadStore.get();
    rulerScrubbingRef.current = true;
    setScrubbing(true);
    event.currentTarget.style.cursor = "col-resize";
    onSeek?.(seekTime(rulerPinTimeAt(event)));
  };

  const finishRulerGesture = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    if (rulerPointerId.current === null || rulerPointerId.current !== event.pointerId) return;
    rulerPointerId.current = null;
    const rangeDrag = rangeDragRef.current;
    rangeDragRef.current = null;
    if (rangeDrag) {
      const range = normalizeRange(
        { startUs: rangeDrag.anchorUs, endUs: clampRulerTime(rulerPinTimeAt(event), totalUs) },
        totalUs,
      );
      setTimeRange(commit && range && rangeDuration(range) >= MIN_RANGE_US ? range : rangeDrag.previous);
    } else if (rulerScrubbingRef.current) {
      onSeekCommit?.(commit ? seekTime(rulerPinTimeAt(event)) : rulerScrubOrigin.current);
    }
    rulerScrubbingRef.current = false;
    setScrubbing(false);
    setRulerHoverUs(null);
    event.currentTarget.style.cursor = "default";
  };

  const handleRulerPinLeave = () => {
    if (rulerPointerId.current === null) setRulerHoverUs(null);
  };

  const handleRulerPinDoubleClick = () => fitToContent();

  return {
    rulerSeekTime: seekTime,
    handleRulerPinMove,
    handleRulerPinDown,
    finishRulerGesture,
    handleRulerPinLeave,
    handleRulerPinDoubleClick,
  };
}
