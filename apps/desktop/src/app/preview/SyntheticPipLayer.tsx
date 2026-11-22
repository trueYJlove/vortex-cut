/** 合成画布画中画手势层：IR 几何 → 可交互盒子（S3-S6/S8）。
 *
 *  - zRank 恒由 working.tracks 数组序派生（0=最上层），Core layers 下层先画/
 *    上层后画；DOM 顺序与命中序同源；绝不读 document.clips 顺序。
 *  - 空白按下 → rAF 合帧框选 → release 判定 click/marquee（8px 双轴门槛）。
 *  - 手柄命中格 14×14（视觉 8×8）、8px 边带、四角外 20×20 旋转格、
 *    计算式光标（15° 缓存）。
 *  - 手势中的 lastGeometry 是同步真值：pointerup 恰好提交一次；
 *    pointercancel/blur 与 patch 失败都恢复起始 IR 盒和 DOM 盒，不提交。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineClipMask } from "@aivideo/contracts";
import { boxResizeFromHandle, HANDLES, PIP_SCALE_MAX, PIP_SCALE_MIN, type HandleDir } from "../pipResizeGeometry.js";
import {
  CORNERS, GESTURE_HINT, HANDLE_BOX_MIN, IDLE_PRESS,
  cornerHitRect, edgeHitRect, gestureHintText, pickTopmostBox,
  rankForHit, reducePreviewPress, resizeCursor, rotateCellRect, rotateCursor,
  selectionFromOutcome, showEdgeMark, type CornerDir, type EdgeDir, type HitBox, type PreviewPress,
} from "./stage-interaction.js";

export interface PipBoxItem {
  clipId: string;
  /** IR overlay box（画布像素，x/y 左上角语义）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  canvasW: number;
  canvasH: number;
  scale: number;
  rotate: number;
  mask?: TimelineClipMask;
  /** S8：working.tracks 数组索引（0=最上层）；缺省按 renderOrder 回退。 */
  zRank?: number;
  /** Core layers 绘制序（下层先、上层后）。 */
  renderOrder?: number;
}

export interface PipGeometry { cx: number; cy: number; w: number; h: number; rotate: number }

export interface SyntheticPipLayerProps {
  boxes: PipBoxItem[];
  view: { scale: number; offsetX: number; offsetY: number; width: number; height: number };
  selectedClipId: string | null;
  locked: boolean;
  /** null = 点击空处清选（S4）。 */
  onSelect: (clipId: string | null) => void;
  /** 框选多选（本地 React 状态，不需要任何新 Core patch op）。 */
  onSelectClips?: (clipIds: string[]) => void;
  selectedClipIds?: readonly string[];
  onLiveGeometry: (clipId: string, geometry: PipGeometry) => void;
  /** 返回 false = 补丁失败，手势层恢复起始几何。 */
  onCommitTransform: (clipId: string, transform: { x: number; y: number; scale: number; rotate: number }) => boolean | Promise<boolean>;
  onRestoreGeometry?: (clipId: string, geometry: PipGeometry) => void;
  onDraftMask?: (clipId: string, mask: TimelineClipMask) => void;
  onCommitMask?: (clipId: string, mask: TimelineClipMask) => void;
  onGestureStart: () => boolean;
  onGestureEnd: (wasPlaying: boolean) => void;
}

type GestureMode = "move" | HandleDir | "rotate" | "mask-move" | "mask-resize" | "marquee";

interface GestureState {
  mode: GestureMode;
  clipId: string | null;
  wasPlaying: boolean;
  box0: PipGeometry;
  scale0: number;
  rotate0: number;
  startAngle: number;
  grab: { dx: number; dy: number };
  mask0?: { x: number; y: number; width: number; height: number };
  startPointer?: { x: number; y: number };
  rect: { left: number; top: number };
  /** 同步真值：最后一次 move 的几何，不依赖 React state 提交。 */
  lastGeometry: PipGeometry | null;
  committed: boolean;
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const CORNER_ANGLE: Record<CornerDir, number> = { nw: 45, ne: 135, se: 45, sw: 135 };
const EDGE_ANGLE: Record<EdgeDir, number> = { n: 90, s: 90, e: 0, w: 0 };
const ROTATE_AT: Record<CornerDir, number> = { ne: 0, se: 90, sw: 180, nw: 270 };

function maskDefaults(mask: TimelineClipMask): { x: number; y: number; width: number; height: number } {
  return { x: mask.x ?? 0.5, y: mask.y ?? 0.5, width: mask.width ?? 0.5, height: mask.height ?? 0.5 };
}

/** frame.layers 的绘制序 = 下层先、上层后；渲染 DOM 按此序，命中取 zRank 最小。 */
function rankOf(box: PipBoxItem, index: number): number {
  return box.zRank ?? index;
}

export function SyntheticPipLayer(props: SyntheticPipLayerProps): React.ReactElement {
  const { boxes, view, selectedClipId, locked, onSelect, onSelectClips, selectedClipIds = [], onLiveGeometry,
    onCommitTransform, onRestoreGeometry, onDraftMask, onCommitMask, onGestureStart, onGestureEnd } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const pressRef = useRef<PreviewPress>(IDLE_PRESS);
  const pressRafRef = useRef(0);
  const [live, setLive] = useState<{ clipId: string; geometry: PipGeometry } | null>(null);
  const [maskLive, setMaskLive] = useState<{ clipId: string; mask: TimelineClipMask } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hint, setHint] = useState<{ x: number; y: number; text: string } | null>(null);

  /** S2 单点换算：客户 px → CSS px → 画布 px。父层无 transform:scale，
   *  故 rect.zoom 恒为 1；view.scale 已含画布 CSS 尺寸 / IR 尺寸（含缩放）。 */
  const pointerToCanvas = (event: { clientX: number; clientY: number }, rect: { left: number; top: number }): { x: number; y: number } => {
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    return { x: (cssX - view.offsetX) / view.scale, y: (cssY - view.offsetY) / view.scale };
  };

  /** 视图空间盒（左上角语义）→ 命中盒；逆旋转在 insideFrame 内完成。 */
  const hitBoxes = useMemo<HitBox[]>(() => boxes.map((box, index) => ({
    clipId: box.clipId,
    x: view.offsetX + box.x * view.scale,
    y: view.offsetY + box.y * view.scale,
    w: box.w * view.scale,
    h: box.h * view.scale,
    rotate: box.rotate,
    renderOrder: box.renderOrder ?? index,
  })), [boxes, view.offsetX, view.offsetY, view.scale]);
  const rankByClip = useMemo(() => new Map(boxes.map((box, index) => [box.clipId, rankOf(box, index)])), [boxes]);
  const rankForHitBox = (box: HitBox) => rankByClip.get(box.clipId) ?? Infinity;
  /** 下层先画、上层后画：zRank 降序渲染（最后一个兄弟 = 最上层）。 */
  const renderBoxes = useMemo(() => rankForHit(boxes, (box, index) => -rankOf(box, index)), [boxes]);

  const currentRect = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
  };

  const clearGesture = (restore: boolean) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setLive(null);
    setHint(null);
    if (!g) return;
    onGestureEnd(g.wasPlaying);
    if (restore && g.mode !== "marquee" && g.mode !== "mask-move" && g.mode !== "mask-resize") {
      // 恢复就地 IR 盒（会话 setPipGeometry）与 DOM 盒（live state 清空后回 box0）。
      onLiveGeometry(g.clipId!, g.box0);
      onRestoreGeometry?.(g.clipId!, g.box0);
    }
  };

  const beginGesture = (event: React.PointerEvent<HTMLElement>, box: PipBoxItem, mode: GestureMode): void => {
    if (locked) return;
    event.preventDefault();
    event.stopPropagation();
    const root = rootRef.current;
    if (!root) return;
    const rect = currentRect();
    const wasPlaying = onGestureStart();
    onSelect(box.clipId);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针已释放 */ }
    const box0: PipGeometry = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: box.w, h: box.h, rotate: box.rotate };
    const pointer = pointerToCanvas(event, rect);
    gestureRef.current = {
      mode, clipId: box.clipId, wasPlaying, box0, scale0: box.scale, rotate0: box.rotate,
      startAngle: Math.atan2(pointer.y - box0.cy, pointer.x - box0.cx),
      grab: { dx: pointer.x - box0.cx, dy: pointer.y - box0.cy },
      mask0: mode === "mask-move" || mode === "mask-resize" ? maskDefaults(box.mask ?? { kind: "rect" }) : undefined,
      startPointer: pointer, rect, lastGeometry: box0, committed: false,
    };
    if (mode === "mask-move" || mode === "mask-resize") setMaskLive({ clipId: box.clipId, mask: box.mask ?? { kind: "rect" } });
    else setLive({ clipId: box.clipId, geometry: box0 });
    setHint({ x: event.clientX - rect.left, y: event.clientY - rect.top, text: gestureHintText(mode === "rotate" ? "rotate" : "scale", box0) });
  };

  const lastMoveEvent = useRef<object | null>(null);
  const gestureMove = (event: React.PointerEvent): void => {
    // React 合成事件沿「手柄 → 盒子」冒泡，两层都挂了 gestureMove：
    // 同一原生事件必须只处理一次，否则每个 move 会写两次几何。
    if (lastMoveEvent.current === event.nativeEvent) return;
    lastMoveEvent.current = event.nativeEvent;
    const gesture = gestureRef.current;
    if (!gesture) return;
    const canvasW = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasW ?? 1);
    const canvasH = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasH ?? 1);
    if (gesture.mode === "mask-move" || gesture.mode === "mask-resize") {
      if (!gesture.mask0 || !gesture.startPointer) return;
      const pointer = pointerToCanvas(event, gesture.rect);
      const latest = { ...gesture.mask0 };
      if (gesture.mode === "mask-move") {
        latest.x = clamp(gesture.mask0.x + (pointer.x - gesture.startPointer.x) / gesture.box0.w, 0, 1);
        latest.y = clamp(gesture.mask0.y + (pointer.y - gesture.startPointer.y) / gesture.box0.h, 0, 1);
      } else {
        const cxCanvas = gesture.box0.cx + (gesture.mask0.x - 0.5) * gesture.box0.w;
        const cyCanvas = gesture.box0.cy + (gesture.mask0.y - 0.5) * gesture.box0.h;
        latest.width = clamp(Math.abs(pointer.x - cxCanvas) * 2 / gesture.box0.w, 0.02, 1);
        latest.height = clamp(Math.abs(pointer.y - cyCanvas) * 2 / gesture.box0.h, 0.02, 1);
      }
      const mask = { ...(boxes.find(item => item.clipId === gesture.clipId)?.mask ?? { kind: "rect" as const }), ...latest };
      setMaskLive({ clipId: gesture.clipId!, mask });
      return;
    }
    let geometry: PipGeometry = gesture.box0;
    const pointer = pointerToCanvas(event, gesture.rect);
    if (gesture.mode === "move") {
      geometry = {
        cx: clamp(pointer.x - gesture.grab.dx, 0, canvasW),
        cy: clamp(pointer.y - gesture.grab.dy, 0, canvasH),
        w: gesture.box0.w, h: gesture.box0.h, rotate: gesture.rotate0,
      };
    } else if (gesture.mode === "rotate") {
      const angle = Math.atan2(pointer.y - gesture.box0.cy, pointer.x - gesture.box0.cx);
      let deg = gesture.rotate0 + ((angle - gesture.startAngle) * 180) / Math.PI;
      deg = ((deg % 360) + 540) % 360 - 180;
      if (Math.abs(deg) < 2) deg = 0;
      geometry = { ...gesture.box0, rotate: deg };
    } else if (gesture.mode !== "marquee") {
      const { cx, cy, w, h } = boxResizeFromHandle(gesture.mode, pointer, gesture.box0,
        PIP_SCALE_MIN / Math.max(1e-6, gesture.scale0), PIP_SCALE_MAX / Math.max(1e-6, gesture.scale0));
      geometry = { cx, cy, w, h, rotate: gesture.rotate0 };
    }
    gesture.lastGeometry = geometry;
    onLiveGeometry(gesture.clipId!, geometry);
    setLive({ clipId: gesture.clipId!, geometry });
    setHint({
      x: event.clientX - gesture.rect.left, y: event.clientY - gesture.rect.top,
      text: gestureHintText(gesture.mode === "rotate" ? "rotate" : gesture.mode === "move" ? "move" : "scale", geometry),
    });
  };

  const endGesture = (event?: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.committed) return;
    if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // 同步真值：不用异步 live state，避免最后一帧落后一次 move。
    const geometry = gesture.lastGeometry ?? gesture.box0;
    gestureRef.current = null;
    gesture.committed = true;
    setLive(null);
    setHint(null);
    onGestureEnd(gesture.wasPlaying);
    if (gesture.mode === "mask-move" || gesture.mode === "mask-resize") {
      const maskLiveNow = maskLive?.clipId === gesture.clipId ? maskLive.mask : null;
      setMaskLive(null);
      if (maskLiveNow && onDraftMask && onCommitMask) { onDraftMask(gesture.clipId!, maskLiveNow); onCommitMask(gesture.clipId!, maskLiveNow); }
      return;
    }
    if (geometry === gesture.box0) return;
    const canvasW = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasW ?? 1);
    const canvasH = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasH ?? 1);
    const commit = {
      x: clamp(geometry.cx / canvasW, 0, 1), y: clamp(geometry.cy / canvasH, 0, 1),
      scale: gesture.scale0 * (geometry.w / Math.max(1e-6, gesture.box0.w)), rotate: geometry.rotate,
    };
    void Promise.resolve(onCommitTransform(gesture.clipId!, commit)).then(ok => {
      if (ok !== false) return;
      // 补丁失败：就地 IR 盒与 DOM 盒都恢复起始值，不引入任何新 patch op。
      onLiveGeometry(gesture.clipId!, gesture.box0);
      onRestoreGeometry?.(gesture.clipId!, gesture.box0);
      setLive({ clipId: gesture.clipId!, geometry: gesture.box0 });
    });
  };

  /** S4：根层空白按下 → rAF move → release 判定。选中动作只在 release 发出。 */
  const onRootPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // 手势/手柄的 pointerdown 已 stopPropagation，能到达根层的必定是空白按下；
    // 仍按 pickTopmostBox 求命中，保证与绘制序（zRank）同源。
    if (gestureRef.current) return;
    const rect = currentRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const hit = pickTopmostBox(hitBoxes, point, rankForHitBox);
    pressRef.current = reducePreviewPress(IDLE_PRESS, {
      type: "down", x: point.x, y: point.y,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      hitClipId: hit?.clipId ?? null,
    }).state;
  };
  const onRootPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    // 手势 move 已由子元素 gestureMove 处理；冒泡到根层会再处理一次同一事件。
    if (gestureRef.current) return;
    if (pressRef.current.phase !== "press") return;
    const rect = currentRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const result = reducePreviewPress(pressRef.current, { type: "move", x, y });
    pressRef.current = result.state;
    if (pressRafRef.current) cancelAnimationFrame(pressRafRef.current);
    pressRafRef.current = requestAnimationFrame(() => { pressRafRef.current = 0; setMarquee(result.marquee); });
  };
  const onRootPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pressRef.current.phase !== "press") return;
    const rect = currentRect();
    const result = reducePreviewPress(pressRef.current, { type: "up", x: event.clientX - rect.left, y: event.clientY - rect.top });
    pressRef.current = IDLE_PRESS;
    setMarquee(null);
    if (!result.outcome) return;
    if (result.outcome.kind === "marquee") {
      const ids = selectionFromOutcome(result.outcome, hitBoxes, rankForHitBox, selectedClipIds);
      onSelectClips?.(ids);
    } else {
      onSelect(result.outcome.clipId);
    }
  };

  /** pointercancel / window blur：不提交，恢复就地 IR 盒与 DOM 盒。 */
  useEffect(() => {
    const onCancel = () => {
      if (gestureRef.current) clearGesture(true);
      pressRef.current = IDLE_PRESS;
      setMarquee(null);
    };
    window.addEventListener("blur", onCancel);
    return () => { window.removeEventListener("blur", onCancel); if (pressRafRef.current) cancelAnimationFrame(pressRafRef.current); };
  }, []);

  if (boxes.length === 0) return <></>;

  return (
    <div
      ref={rootRef}
      className="sp-layer"
      style={{ position: "absolute", inset: 0, zIndex: 3 }}
      onPointerDown={onRootPointerDown}
      onPointerMove={onRootPointerMove}
      onPointerUp={onRootPointerUp}
      // sp-layer 覆盖整个画布（含黑区）：吞掉 click 冒泡，避免祖先
      // preview-frame 的 onClick（interactive 的播放头选中）在合成模式下
      // 把刚清空的选择又填回去（S4 语义唯一所有者 = 本层状态机）。
      onClick={event => event.stopPropagation()}
      onPointerCancel={event => { const g = gestureRef.current; if (g) clearGesture(true); pressRef.current = IDLE_PRESS; setMarquee(null); void event; }}
    >
      {marquee && <div className="preview-marquee" aria-hidden="true" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      {renderBoxes.map(box => {
        const selected = box.clipId === selectedClipId;
        const picked = selected || selectedClipIds.includes(box.clipId);
        const gesturing = live?.clipId === box.clipId ? live.geometry : null;
        const geometry: PipGeometry = gesturing ?? { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: box.w, h: box.h, rotate: box.rotate };
        const w = geometry.w * view.scale;
        const h = geometry.h * view.scale;
        const mask = (maskLive?.clipId === box.clipId ? maskLive.mask : null) ?? (box.mask && Object.keys(box.mask).length ? box.mask : null);
        const md = mask ? maskDefaults(mask) : null;
        const gestureHandlers = { onPointerMove: gestureMove, onPointerUp: endGesture, onPointerCancel: (e: React.PointerEvent) => { clearGesture(true); void e; } };
        const hw = Math.max(w, HANDLE_BOX_MIN), hh = Math.max(h, HANDLE_BOX_MIN);
        return (
          <div
            key={box.clipId}
            role="button"
            aria-label={`画中画 ${box.clipId}`}
            className={`sp-box${picked ? " selected" : ""}`}
            style={{
              left: view.offsetX + (geometry.cx - geometry.w / 2) * view.scale,
              top: view.offsetY + (geometry.cy - geometry.h / 2) * view.scale,
              width: w, height: h,
              transform: `rotate(${geometry.rotate}deg)`,
              cursor: locked ? "default" : gesturing ? "grabbing" : "grab",
            }}
            onPointerDown={event => beginGesture(event, box, "move")}
            onClick={event => event.stopPropagation()}
            {...gestureHandlers}
            onPointerCancel={event => { clearGesture(true); void event; }}
          >
            {mask && md && onDraftMask && onCommitMask && (
              <div
                className={`sp-mask kind-${mask.kind}${mask.invert ? " invert" : ""}`}
                title="蒙版边界：拖动平移，拖角点缩放"
                style={mask.kind === "linear"
                  ? { left: "-10%", top: `${md.y * 100}%`, width: "120%", height: 2 }
                  : { left: `${(md.x - md.width / 2) * 100}%`, top: `${(md.y - md.height / 2) * 100}%`, width: `${md.width * 100}%`, height: `${md.height * 100}%` }}
                onPointerDown={event => { if ((event.target as HTMLElement).closest(".sp-mask-knob")) return; beginGesture(event, box, "mask-move"); }}
                {...gestureHandlers}
              >
                {selected && mask.kind !== "linear" && (
                  <span className="sp-mask-knob" title="缩放蒙版" style={{ left: "100%", top: "100%" }}
                    onPointerDown={event => beginGesture(event, box, "mask-resize")} {...gestureHandlers} />
                )}
              </div>
            )}
            {selected && !locked && HANDLES.map(dir => {
              const corner = CORNERS.includes(dir as CornerDir) ? dir as CornerDir : null;
              const cursor = corner ? resizeCursor(CORNER_ANGLE[corner] + geometry.rotate)
                : resizeCursor(EDGE_ANGLE[dir as EdgeDir] + geometry.rotate);
              const cell = corner ? cornerHitRect(corner, { x: 0, y: 0, w, h }) : edgeHitRect(dir as EdgeDir, { x: 0, y: 0, w, h });
              const marked = !corner && showEdgeMark(dir as EdgeDir, hw, hh);
              return (
                <span
                  key={dir}
                  className={`sp-handle sp-${dir}${marked ? " marked" : ""}`}
                  data-dir={dir}
                  title={`缩放（${dir}）`}
                  style={{ left: cell.x, top: cell.y, width: 14, height: 14, cursor }}
                  {...gestureHandlers}
                  onPointerDown={event => beginGesture(event, box, dir)}
                />
              );
            })}
            {selected && !locked && CORNERS.map(corner => {
              const cell = rotateCellRect(corner, { x: 0, y: 0, w, h });
              return (
                <span
                  key={`rotate-${corner}`}
                  className={`sp-rotate sp-rotate-${corner}`}
                  data-dir={corner}
                  aria-label={`旋转画中画 ${corner}`}
                  style={{ left: cell.x, top: cell.y, width: 20, height: 20, cursor: rotateCursor(ROTATE_AT[corner] + geometry.rotate) }}
                  {...gestureHandlers}
                  onPointerDown={event => beginGesture(event, box, "rotate")}
                />
              );
            })}
          </div>
        );
      })}
      {hint && (
        <div className="sp-gesture-hint" aria-hidden="true" style={{ left: hint.x + GESTURE_HINT.dx, top: hint.y + GESTURE_HINT.dy,
          background: GESTURE_HINT.background, fontSize: `${GESTURE_HINT.fontSizePx}px` }}>
          {hint.text}
        </div>
      )}
    </div>
  );
}
