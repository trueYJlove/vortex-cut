import { useCallback, useEffect, useRef, useState } from "react";
import type { OutputRatio, Project, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";
import type { PipOverlay } from "../PreviewPipOverlays.js";
import {
  FIT_VIEW,
  ZOOM_SETTLE_MS,
  createWheelCoalescer,
  createZoomSettle,
  fittedSize,
  isFit,
  panBy,
  wheelPx,
  wheelZoomFactor,
  zoomAt,
  zoomLayout,
  zoomMax,
  type ViewerView,
} from "../preview/viewer-zoom.js";
import {
  IDLE_PRESS,
  pickTopmostBox,
  reducePreviewPress,
  selectionFromOutcome,
  type HitBox,
  type PreviewPress,
} from "../preview/stage-interaction.js";
import type { NoticeTone, Selection } from "../appHelpers.js";

export interface UseStageViewportParams {
  project: Project | undefined;
  working: TimelineDocument | undefined;
  previewMode: "interactive" | "authoritative" | "synthetic";
  trackById: Map<string, TimelineDocument["tracks"][number]>;
  tracksAtPlayhead: TimelineDocument["tracks"];
  selectedClipIds: string[];
  showSelBox: boolean;
  getOverlayPips: () => PipOverlay[];
  setSelection: (selection: Selection) => void;
  patchTimeline: (operations: TimelinePatchOperation[], summary: string) => Promise<boolean>;
  showNotice: (text: string, tone?: NoticeTone) => void;
}

export function useStageViewport({
  project,
  working,
  previewMode,
  trackById,
  tracksAtPlayhead,
  selectedClipIds,
  showSelBox,
  getOverlayPips,
  setSelection,
  patchTimeline,
  showNotice,
}: UseStageViewportParams) {
  const [previewRatio, setPreviewRatio] = useState("fit");
  const [previewRatioTouched, setPreviewRatioTouched] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<number | "fit">("fit");
  const [viewerView, setViewerView] = useState<ViewerView>(FIT_VIEW);
  const [zoomDrawn, setZoomDrawn] = useState(1);
  const [stageMarquee, setStageMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const frameRatioRef = useRef({ w: 16, h: 9 });
  const viewerViewRef = useRef(viewerView);
  viewerViewRef.current = viewerView;
  const previewPressRef = useRef<PreviewPress>(IDLE_PRESS);
  const previewClickGuardRef = useRef(false);
  const pressRafRef = useRef(0);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stagePaneRef = useRef<HTMLElement | null>(null);
  const stageColumnRef = useRef<HTMLDivElement | null>(null);
  // 画面选中框：白色边框 + 8 向拖拽手柄（角等比 / 边单轴），缩放时随画面一起缩放。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const selBoxRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  const [selDimsText, setSelDimsText] = useState("");
  const selDragRef = useRef<{ dir: string; startX: number; startY: number; w: number; h: number; ratio: number } | null>(null);

  // 预览/导出比例真源 = 项目画布（所见即所得；素材比例不再反客为主）。
  const canvasInfo = project?.canvas;
  const autoRatio = canvasInfo
    ? (Math.abs(canvasInfo.width / canvasInfo.height - 16 / 9) < 0.02 ? "169"
      : Math.abs(canvasInfo.width / canvasInfo.height - 9 / 16) < 0.02 ? "916"
      : Math.abs(canvasInfo.width / canvasInfo.height - 1) < 0.02 ? "11"
      : Math.abs(canvasInfo.width / canvasInfo.height - 4 / 3) < 0.02 ? "43"
      : Math.abs(canvasInfo.width / canvasInfo.height - 3 / 4) < 0.02 ? "34"
      : "fit")
    : "fit";
  const effectiveRatio: OutputRatio = (previewRatioTouched ? previewRatio : autoRatio) as OutputRatio;
  const renderRatio: OutputRatio = effectiveRatio === "fit" ? "169" : effectiveRatio;
  const previewClass = `ratio-${renderRatio}`;
  frameRatioRef.current = renderRatio === "916" || renderRatio === "34" ? { w: 9, h: 16 }
    : renderRatio === "11" ? { w: 1, h: 1 }
      : renderRatio === "43" ? { w: 4, h: 3 }
        : { w: 16, h: 9 };
  const framePixelSizeRef = useRef({ w: 1920, h: 1080 });
  framePixelSizeRef.current = {
    w: Math.max(1, working?.canvas.width ?? project?.canvas.width ?? 1920),
    h: Math.max(1, working?.canvas.height ?? project?.canvas.height ?? 1080),
  };

  // 比例切换（剪映式）：选具体比例时全视觉轨布局切为 crop_fill。
  const changePreviewRatio = (value: string) => {
    setPreviewRatio(value);
    setPreviewRatioTouched(true);
    setCanvasSize(null);
    if (canvasRef.current) { canvasRef.current.style.width = ""; canvasRef.current.style.height = ""; }
    if (value !== "fit" && working) {
      const layoutOps = working.clips
        .filter(clip => clip.layout === "blurred_background" && (clip.asset_kind === "video" || clip.asset_kind === "image") && trackById.get(clip.track_id)?.kind === "video")
        .map(clip => ({ op: "set_layout" as const, clip_id: clip.clip_id, layout: "crop_fill" as const }));
      if (layoutOps.length > 0) void patchTimeline(layoutOps, "切换比例：全视觉轨裁切填满");
    }
  };

  // 预览缩放（剪映式）：对数刻度 25%–500%。
  const zoomT = (z: number) => Math.round(Math.log(z / 0.25) / Math.log(20) * 1000);
  const zoomZ = (t: number) => 0.25 * Math.exp(Math.log(20) * t / 1000);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stagePaneRef.current?.requestFullscreen();
    } catch { showNotice("进入全屏失败。", "warning"); }
  };

  // 全屏：跟随浏览器全屏状态（Esc 退出时按钮图标同步复原）。
  useEffect(() => {
    const listener = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  }, []);

  // 基准宽：工具栏 / 舞台 / 进度条 / 播放条共享 16:9 适应宽度。
  useEffect(() => {
    const pane = stagePaneRef.current;
    const col = stageColumnRef.current;
    if (!pane || !col) return;
    const layout = () => {
      const el = stageColumnRef.current;
      const host = stagePaneRef.current;
      if (!el || !host) return;
      const isFs = document.fullscreenElement === host;
      const availW = Math.max(1, isFs ? window.innerWidth - 24 : host.clientWidth - 24);
      const availH = Math.max(1, isFs ? window.innerHeight - 24 - 40 - 40 - 16 : host.clientHeight - 24 - 40 - 40 - 16);
      const w = Math.min(availW, availH * 16 / 9);
      el.style.width = `${w}px`;
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(pane);
    window.addEventListener("resize", layout);
    document.addEventListener("fullscreenchange", layout);
    return () => { ro.disconnect(); window.removeEventListener("resize", layout); document.removeEventListener("fullscreenchange", layout); };
  }, []);

  // S1/S2：预览缩放 = 布局尺寸（不用 transform:scale，手柄恒为屏幕 px）。
  const zoomZValue = previewZoom === "fit" ? viewerView.z : (typeof previewZoom === "number" ? previewZoom : viewerView.z);
  useEffect(() => {
    const el = previewFrameRef.current;
    if (!el) return;
    const coalescer = createWheelCoalescer(
      fn => requestAnimationFrame(fn),
      id => cancelAnimationFrame(id),
      (factor, dx, dy, anchor) => {
        const viewer = { w: el.clientWidth || 1, h: el.clientHeight || 1 };
        const fitted = fittedSize(viewer, frameRatioRef.current);
        let next = viewerViewRef.current;
        if (factor !== 1) next = zoomAt(next, factor, anchor, viewer, fitted, zoomMax(fitted.w / framePixelSizeRef.current.w));
        if (dx || dy) next = panBy(next, dx, dy, fitted);
        if (next !== viewerViewRef.current) { viewerViewRef.current = next; setViewerView(next); setPreviewZoom(next.z); }
      },
    );
    let stopPan = () => {};
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (event.buttons) return;
        const rect = el.getBoundingClientRect();
        coalescer.pushZoom(wheelZoomFactor(wheelPx(event, event.deltaY)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      if (isFit(viewerViewRef.current)) return;
      event.preventDefault();
      if (event.buttons) return;
      const sideways = event.shiftKey && !event.deltaX;
      coalescer.pushPan(wheelPx(event, sideways ? event.deltaY : event.deltaX), sideways ? 0 : wheelPx(event, event.deltaY));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 1 || isFit(viewerViewRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      el.dataset.panActive = "true";
      let last = { x: event.clientX, y: event.clientY };
      const move = (next: PointerEvent) => {
        coalescer.pushPan(last.x - next.clientX, last.y - next.clientY);
        last = { x: next.clientX, y: next.clientY };
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        el.removeAttribute("data-pan-active");
        stopPan = () => {};
      };
      stopPan = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      stopPan();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown, true);
      coalescer.dispose();
    };
  }, []);

  /** 缩放静止 ZOOM_SETTLE_MS 后同步一次 DOM 几何。 */
  const zoomSettleRef = useRef(createZoomSettle(
    ZOOM_SETTLE_MS,
    (fn, ms) => window.setTimeout(fn, ms),
    id => clearTimeout(id),
    () => {
      setZoomDrawn(value => value + 1);
    },
  ));
  useEffect(() => {
    if (zoomZValue === 1 && previewZoom === "fit") return;
    zoomSettleRef.current.schedule();
    return () => zoomSettleRef.current.dispose();
  }, [zoomZValue, previewZoom]);

  /** 布局尺寸：显式 width/height（不是 transform）。 */
  useEffect(() => {
    const el = previewFrameRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const sync = () => {
      const viewer = { w: el.clientWidth || 1, h: el.clientHeight || 1 };
      const fitted = fittedSize(viewer, frameRatioRef.current);
      const layout = zoomLayout(viewerViewRef.current, fitted, viewer);
      const fit = isFit(viewerViewRef.current);
      canvas.style.position = fit ? "relative" : "absolute";
      canvas.style.left = fit ? "" : `${layout.x}px`;
      canvas.style.top = fit ? "" : `${layout.y}px`;
      canvas.style.width = `${layout.w}px`;
      canvas.style.height = `${layout.h}px`;
      const nextSize = { w: Math.round(layout.w), h: Math.round(layout.h) };
      setCanvasSize(previous => previous?.w === nextSize.w && previous.h === nextSize.h ? previous : nextSize);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => { observer.disconnect(); window.removeEventListener("resize", sync); };
  }, [viewerView, previewZoom, previewClass, zoomDrawn]);

  /** S4：空白按下 → rAF move → release 判定 click/marquee；绝不定位播放头。 */
  const stageBoxesForPress = (): HitBox[] => {
    if (previewMode === "synthetic") return [];
    return getOverlayPips().map((item, index) => ({
      clipId: item.clip.clip_id,
      x: (item.clip.transform?.x ?? 0.5) * (canvasSize?.w ?? 0) - item.fit_w * (item.clip.transform?.scale ?? 1) / 2,
      y: (item.clip.transform?.y ?? 0.5) * (canvasSize?.h ?? 0) - item.fit_h * (item.clip.transform?.scale ?? 1) / 2,
      w: item.fit_w * (item.clip.transform?.scale ?? 1),
      h: item.fit_h * (item.clip.transform?.scale ?? 1),
      rotate: item.clip.transform?.rotate ?? 0,
      renderOrder: index,
    }));
  };
  const rankForPress = (box: HitBox) => {
    const clip = (working?.clips ?? []).find(item => item.clip_id === box.clipId);
    return clip ? tracksAtPlayhead.findIndex(track => track.id === clip.track_id) : tracksAtPlayhead.length;
  };
  const onPreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (previewMode === "synthetic") return;
    const onInteractiveOverlay = (event.target as HTMLElement).closest(".pip-overlay, .sel-box");
    if (onInteractiveOverlay) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const boxes = stageBoxesForPress();
    const hit = pickTopmostBox(boxes, point, rankForPress);
    previewPressRef.current = reducePreviewPress(IDLE_PRESS, { type: "down", x: point.x, y: point.y, additive: event.shiftKey || event.metaKey || event.ctrlKey, hitClipId: hit?.clipId ?? null }).state;
  };
  const onPreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (previewPressRef.current.phase !== "press") return;
    const canvasRect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const frameRect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - canvasRect.left, y = event.clientY - canvasRect.top;
    const result = reducePreviewPress(previewPressRef.current, { type: "move", x, y });
    previewPressRef.current = result.state;
    if (pressRafRef.current) cancelAnimationFrame(pressRafRef.current);
    pressRafRef.current = requestAnimationFrame(() => {
      pressRafRef.current = 0;
      setStageMarquee(result.marquee ? {
        x: result.marquee.x + canvasRect.left - frameRect.left,
        y: result.marquee.y + canvasRect.top - frameRect.top,
        w: result.marquee.w,
        h: result.marquee.h,
      } : null);
    });
  };
  const onPreviewPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (previewPressRef.current.phase !== "press") return;
    const rect = canvasRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    const result = reducePreviewPress(previewPressRef.current, { type: "up", x: event.clientX - rect.left, y: event.clientY - rect.top });
    previewPressRef.current = IDLE_PRESS;
    previewClickGuardRef.current = true;
    setStageMarquee(null);
    if (!result.outcome) return;
    const ids = selectionFromOutcome(result.outcome, stageBoxesForPress(), rankForPress, selectedClipIds);
    if (result.outcome.kind === "marquee") setSelection(ids.length ? { kind: "clips", ids } : null);
    else if (ids.length === 1) setSelection({ kind: "clip", id: ids[0] });
    else setSelection(null);
  };

  const onPreviewPointerCancel = () => {
    previewPressRef.current = IDLE_PRESS;
    setStageMarquee(null);
  };
  const onPreviewKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, onSelectAtPlayhead: () => void) => {
    if (!isFit(viewerView) && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const viewer = { w: event.currentTarget.clientWidth || 1, h: event.currentTarget.clientHeight || 1 };
      const fitted = fittedSize(viewer, frameRatioRef.current);
      const step = event.shiftKey ? 80 : 32;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      const next = panBy(viewerViewRef.current, dx, dy, fitted);
      viewerViewRef.current = next;
      setViewerView(next);
      setPreviewZoom(next.z);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectAtPlayhead();
    }
  };
  const resetZoom = () => {
    viewerViewRef.current = FIT_VIEW;
    setViewerView(FIT_VIEW);
    setPreviewZoom("fit");
  };
  const applySliderZoom = (sliderValue: number) => {
    const z = Math.round(zoomZ(sliderValue) * 100) / 100;
    const next = { ...viewerViewRef.current, z };
    viewerViewRef.current = next;
    setViewerView(next);
    setPreviewZoom(z);
  };
  const isViewerFit = isFit(viewerView);

  // 画面选中框：8 向手柄拖拽改画面大小。
  const selZoomFactor = 1;
  const beginSelDrag = (dir: string) => (event: React.PointerEvent<HTMLElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selDragRef.current = { dir, startX: event.clientX, startY: event.clientY, w: canvas.offsetWidth, h: canvas.offsetHeight, ratio: canvas.offsetWidth / Math.max(1, canvas.offsetHeight) };
    setSelDimsText(`${Math.round(canvas.offsetWidth)} × ${Math.round(canvas.offsetHeight)}`);
  };
  const moveSelDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = selDragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const dx = (event.clientX - drag.startX) / selZoomFactor;
    const dy = (event.clientY - drag.startY) / selZoomFactor;
    let w = drag.w, h = drag.h;
    const d = drag.dir;
    if (d.includes("e")) w = drag.w + dx;
    if (d.includes("s")) h = drag.h + dy;
    if (d.includes("w")) w = drag.w - dx;
    if (d.includes("n")) h = drag.h - dy;
    if (d === "nw" || d === "ne" || d === "sw" || d === "se") {
      const byW = Math.abs(w - drag.w), byH = Math.abs(h - drag.h);
      if (byW >= byH) h = w / drag.ratio; else w = h * drag.ratio;
    }
    w = Math.max(80, Math.min(2400, w));
    h = Math.max(45, Math.min(1350, h));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    setCanvasSize({ w: Math.round(w), h: Math.round(h) });
    setSelDimsText(`${Math.round(w)} × ${Math.round(h)}`);
  };
  const endSelDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    selDragRef.current = null;
  };

  // 选中框同步：框贴合画面（canvas）的布局矩形。
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = selBoxRef.current;
    if (!canvas || !box) return;
    const sync = () => {
      box.style.left = `${canvas.offsetLeft}px`;
      box.style.top = `${canvas.offsetTop}px`;
      box.style.width = `${canvas.offsetWidth}px`;
      box.style.height = `${canvas.offsetHeight}px`;
      setSelDimsText(`${Math.round(canvas.offsetWidth)} × ${Math.round(canvas.offsetHeight)}`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener("resize", sync);
    return () => { ro.disconnect(); window.removeEventListener("resize", sync); };
  }, [previewClass, canvasSize, showSelBox]);

  return {
    previewRatio, previewZoom, setPreviewZoom,
    viewerView, setViewerView, viewerViewRef, isViewerFit,
    stageMarquee, previewClickGuardRef, previewFrameRef,
    isFullscreen, stagePaneRef, stageColumnRef,
    canvasRef, selBoxRef, canvasSize, setCanvasSize, selDimsText,
    effectiveRatio, renderRatio, previewClass,
    changePreviewRatio, zoomT, zoomZ, resetZoom, applySliderZoom, toggleFullscreen, zoomZValue,
    onPreviewPointerDown, onPreviewPointerMove, onPreviewPointerUp, onPreviewPointerCancel, onPreviewKeyDown,
    beginSelDrag, moveSelDrag, endSelDrag,
  };
}
