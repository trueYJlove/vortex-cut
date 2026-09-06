/** 合成画布画中画手势层（Phase 2 步骤 2）：把 IR 段几何映射为预览框上的
 * 可交互盒子——点击选中、拖拽移动、8 向手柄缩放（对侧锚定、宽高比锁定）、
 * 顶部手柄旋转、蒙版边界拖拽/缩放。draft/commit 走 App 既有 set_clip_transform
 * / set_clip_mask 链路；拖拽开始冻结合成时钟（gestureHold）。几何手势的实时
 * 值经 onLiveGeometry 直达会话就地补丁（IR 换表 + 重呈现，画布实时跟随）；
 * 蒙版几何合成器不渲染（实时预览仅边界示意，效果以权威预览/成片为准）。
 * pointerup 一次性提交。
 *
 * 坐标系约定：几何一律为「画布像素 + 中心点语义」（IR overlay box 是左上角
 * 语义，入口处换算）；指针经视图换算（letterbox offset + zoom 补偿）进入
 * 画布空间；蒙版坐标为片段画面（盒子）归一化，与渲染 geq 语义一致。 */
import { useRef, useState } from "react";
import type { TimelineClipMask } from "@aivideo/contracts";
import { boxResizeFromHandle, HANDLES, PIP_SCALE_MAX, PIP_SCALE_MIN, type HandleDir } from "../pipResizeGeometry.js";

export interface PipBoxItem {
  clipId: string;
  /** IR overlay box（画布像素，x/y 左上角语义）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 画布宽高（指针换算与归一化提交用，来自 IR canvas）。 */
  canvasW: number;
  canvasH: number;
  /** 片段 transform（App 透传）：缩放比/旋转角，提交换算与渲染用。 */
  scale: number;
  rotate: number;
  /** 片段蒙版（App 透传）：合成器不渲染，仅边界手势示意。 */
  mask?: TimelineClipMask;
}

export interface PipGeometry {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotate: number;
}

export interface SyntheticPipLayerProps {
  boxes: PipBoxItem[];
  view: { scale: number; offsetX: number; offsetY: number; width: number; height: number };
  selectedClipId: string | null;
  locked: boolean;
  onSelect: (clipId: string) => void;
  /** 手势中的实时几何（画布像素，中心点语义）：会话就地补丁 IR 并重呈现。 */
  onLiveGeometry: (clipId: string, geometry: PipGeometry) => void;
  /** 手势结束提交：x/y 为画布归一化中心点，scale/rotate 为绝对值；opacity
   *  等未涉及字段由调用方合并既有 transform。 */
  onCommitTransform: (clipId: string, transform: { x: number; y: number; scale: number; rotate: number }) => void;
  /** 蒙版手势结束：draft 同步本地文档，commit 落 revision（set_clip_mask）。 */
  onDraftMask?: (clipId: string, mask: TimelineClipMask) => void;
  onCommitMask?: (clipId: string, mask: TimelineClipMask) => void;
  /** 手势开始冻结播放（返回是否曾处于播放态，结束时可恢复）。 */
  onGestureStart: () => boolean;
  onGestureEnd: (wasPlaying: boolean) => void;
}

type GestureMode = "move" | HandleDir | "rotate" | "mask-move" | "mask-resize";

interface GestureState {
  mode: GestureMode;
  clipId: string;
  wasPlaying: boolean;
  /** 手势起始几何（画布像素，中心点语义）与起始 scale/rotate。 */
  box0: { cx: number; cy: number; w: number; h: number };
  scale0: number;
  rotate0: number;
  /** 旋转：起始指针相对盒子中心的方位角（弧度）。 */
  startAngle: number;
  /** 抓取偏移（画布像素）：起始指针相对盒中心的偏移，move 手势锚定抓取点。 */
  grab: { dx: number; dy: number };
  /** 蒙版手势：起始蒙版几何（片段画面归一化）与起始指针（画布像素）。 */
  mask0?: { x: number; y: number; width: number; height: number };
  startPointer?: { x: number; y: number };
  /** 视图换算：层根节点客户区矩形与 zoom 比（getBoundingClientRect 含
   *  preview-frame 的 transform scale；客户 CSS 空间 = client / zoom）。 */
  rect: { left: number; top: number; zoom: number };
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function maskDefaults(mask: TimelineClipMask): { x: number; y: number; width: number; height: number } {
  return { x: mask.x ?? 0.5, y: mask.y ?? 0.5, width: mask.width ?? 0.5, height: mask.height ?? 0.5 };
}

export function SyntheticPipLayer(props: SyntheticPipLayerProps): React.ReactElement {
  const { boxes, view, selectedClipId, locked, onSelect, onLiveGeometry, onCommitTransform, onDraftMask, onCommitMask, onGestureStart, onGestureEnd } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const [live, setLive] = useState<{ clipId: string; geometry: PipGeometry } | null>(null);
  const [maskLive, setMaskLive] = useState<{ clipId: string; mask: TimelineClipMask } | null>(null);

  /** 指针客户坐标 → 画布像素坐标（letterbox offset + preview zoom 补偿）。 */
  const pointerToCanvas = (event: { clientX: number; clientY: number }, rect: GestureState["rect"]): { x: number; y: number } => {
    const cssX = (event.clientX - rect.left) / rect.zoom;
    const cssY = (event.clientY - rect.top) / rect.zoom;
    return { x: (cssX - view.offsetX) / view.scale, y: (cssY - view.offsetY) / view.scale };
  };

  const beginGesture = (event: React.PointerEvent<HTMLElement>, box: PipBoxItem, mode: GestureMode): void => {
    if (locked) return;
    event.preventDefault();
    event.stopPropagation();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    // jsdom/极小布局下 rect 可能为 0：zoom 退化为 1（客户 CSS 空间 = client）。
    const zoom = rect.width > 0 && view.width > 0 ? rect.width / view.width : 1;
    const wasPlaying = onGestureStart();
    onSelect(box.clipId);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针可能已释放 */ }
    const box0 = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: box.w, h: box.h };
    const pointer = pointerToCanvas(event, { left: rect.left, top: rect.top, zoom });
    gestureRef.current = {
      mode,
      clipId: box.clipId,
      wasPlaying,
      box0,
      scale0: box.scale,
      rotate0: box.rotate,
      startAngle: Math.atan2(pointer.y - box0.cy, pointer.x - box0.cx),
      grab: { dx: pointer.x - box0.cx, dy: pointer.y - box0.cy },
      mask0: mode === "mask-move" || mode === "mask-resize" ? maskDefaults(box.mask ?? { kind: "rect" }) : undefined,
      startPointer: pointer,
      rect: { left: rect.left, top: rect.top, zoom },
    };
    if (mode === "mask-move" || mode === "mask-resize") setMaskLive({ clipId: box.clipId, mask: box.mask ?? { kind: "rect" } });
    else setLive({ clipId: box.clipId, geometry: { ...box0, rotate: box.rotate } });
  };

  const gestureMove = (event: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.clipId !== (live?.clipId ?? maskLive?.clipId)) return;
    const canvasW = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasW ?? 1);
    const canvasH = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasH ?? 1);
    if (gesture.mode === "mask-move" || gesture.mode === "mask-resize") {
      if (!gesture.mask0 || !gesture.startPointer) return;
      const pointer = pointerToCanvas(event, gesture.rect);
      const latest = { ...gesture.mask0 };
      if (gesture.mode === "mask-move") {
        // 蒙版平移：指针位移 / 盒子尺寸 → 片段画面归一化增量（linear 只动 y）。
        latest.x = clamp(gesture.mask0.x + (pointer.x - gesture.startPointer.x) / gesture.box0.w, 0, 1);
        latest.y = clamp(gesture.mask0.y + (pointer.y - gesture.startPointer.y) / gesture.box0.h, 0, 1);
      } else {
        // 蒙版缩放：以蒙版中心为锚，指针到中心的距离 ×2 / 盒子尺寸（与交互层一致）。
        const cxCanvas = gesture.box0.cx + (gesture.mask0.x - 0.5) * gesture.box0.w;
        const cyCanvas = gesture.box0.cy + (gesture.mask0.y - 0.5) * gesture.box0.h;
        latest.width = clamp(Math.abs(pointer.x - cxCanvas) * 2 / gesture.box0.w, 0.02, 1);
        latest.height = clamp(Math.abs(pointer.y - cyCanvas) * 2 / gesture.box0.h, 0.02, 1);
      }
      const mask = { ...(boxes.find(item => item.clipId === gesture.clipId)?.mask ?? { kind: "rect" as const }), ...latest };
      setMaskLive({ clipId: gesture.clipId, mask });
      return;
    }
    let geometry: PipGeometry;
    if (gesture.mode === "move") {
      // 增量位移锚定抓取点；禁止用指针绝对位置反推中心——否则首帧会向指针跳动。
      const pointer = pointerToCanvas(event, gesture.rect);
      geometry = {
        cx: clamp(pointer.x - gesture.grab.dx, 0, canvasW),
        cy: clamp(pointer.y - gesture.grab.dy, 0, canvasH),
        w: gesture.box0.w,
        h: gesture.box0.h,
        rotate: gesture.rotate0,
      };
    } else if (gesture.mode === "rotate") {
      const pointer = pointerToCanvas(event, gesture.rect);
      const angle = Math.atan2(pointer.y - gesture.box0.cy, pointer.x - gesture.box0.cx);
      let deg = gesture.rotate0 + ((angle - gesture.startAngle) * 180) / Math.PI;
      deg = ((deg % 360) + 540) % 360 - 180; // 归一化到 (-180, 180]
      if (Math.abs(deg) < 2) deg = 0; // 回正吸附：±2° 内视为水平
      geometry = { ...gesture.box0, rotate: deg };
    } else {
      const pointer = pointerToCanvas(event, gesture.rect);
      const { cx, cy, w, h } = boxResizeFromHandle(gesture.mode, pointer, gesture.box0,
        PIP_SCALE_MIN / Math.max(1e-6, gesture.scale0), PIP_SCALE_MAX / Math.max(1e-6, gesture.scale0));
      geometry = { cx, cy, w, h, rotate: gesture.rotate0 };
    }
    onLiveGeometry(gesture.clipId, geometry);
    setLive({ clipId: gesture.clipId, geometry });
  };

  const endGesture = (event: React.PointerEvent): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    onGestureEnd(gesture.wasPlaying);
    if (gesture.mode === "mask-move" || gesture.mode === "mask-resize") {
      const maskLiveNow = maskLive?.clipId === gesture.clipId ? maskLive.mask : null;
      setMaskLive(null);
      if (maskLiveNow && onDraftMask && onCommitMask) {
        onDraftMask(gesture.clipId, maskLiveNow);
        onCommitMask(gesture.clipId, maskLiveNow);
      }
      return;
    }
    const geometry = live?.clipId === gesture.clipId ? live.geometry : null;
    setLive(null);
    if (!geometry) return;
    const canvasW = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasW ?? 1);
    const canvasH = Math.max(1, boxes.find(item => item.clipId === gesture.clipId)?.canvasH ?? 1);
    onCommitTransform(gesture.clipId, {
      x: clamp(geometry.cx / canvasW, 0, 1),
      y: clamp(geometry.cy / canvasH, 0, 1),
      scale: gesture.scale0 * (geometry.w / Math.max(1e-6, gesture.box0.w)),
      rotate: geometry.rotate,
    });
  };

  if (boxes.length === 0) return <></>;

  return (
    <div ref={rootRef} style={{ position: "absolute", inset: 0, zIndex: 3 }} onPointerDown={event => event.stopPropagation()}>
      {boxes.map(box => {
        const selected = box.clipId === selectedClipId;
        const gesturing = live?.clipId === box.clipId ? live.geometry : null;
        const cx = gesturing ? gesturing.cx : box.x + box.w / 2;
        const cy = gesturing ? gesturing.cy : box.y + box.h / 2;
        const w = gesturing ? gesturing.w : box.w;
        const h = gesturing ? gesturing.h : box.h;
        const rotate = gesturing ? gesturing.rotate : box.rotate;
        const dragging = gesturing !== null;
        const mask = (maskLive?.clipId === box.clipId ? maskLive.mask : null) ?? (box.mask && Object.keys(box.mask).length ? box.mask : null);
        const md = mask ? maskDefaults(mask) : null;
        const gestureHandlers = { onPointerMove: gestureMove, onPointerUp: endGesture, onPointerCancel: endGesture };
        return (
          <div
            key={box.clipId}
            role="button"
            aria-label={`画中画 ${box.clipId}`}
            className={`sp-box${selected ? " selected" : ""}`}
            style={{
              left: view.offsetX + (cx - w / 2) * view.scale,
              top: view.offsetY + (cy - h / 2) * view.scale,
              width: w * view.scale,
              height: h * view.scale,
              transform: `rotate(${rotate}deg)`,
              cursor: locked ? "default" : dragging ? "grabbing" : "grab",
            }}
            onPointerDown={event => beginGesture(event, box, "move")}
            {...gestureHandlers}
          >
            {mask && md && onDraftMask && onCommitMask && (
              <div
                className={`sp-mask kind-${mask.kind}${mask.invert ? " invert" : ""}`}
                title="蒙版边界：拖动平移，拖角点缩放（实时预览仅边界示意，效果以权威预览/成片为准）"
                style={mask.kind === "linear"
                  ? { left: "-10%", top: `${md.y * 100}%`, width: "120%", height: 2 }
                  : { left: `${(md.x - md.width / 2) * 100}%`, top: `${(md.y - md.height / 2) * 100}%`, width: `${md.width * 100}%`, height: `${md.height * 100}%` }}
                onPointerDown={event => { if ((event.target as HTMLElement).closest(".sp-mask-knob")) return; beginGesture(event, box, "mask-move"); }}
                {...gestureHandlers}
              >
                {selected && mask.kind !== "linear" && (
                  <span
                    className="sp-mask-knob"
                    title="缩放蒙版"
                    style={{ left: "100%", top: "100%" }}
                    onPointerDown={event => beginGesture(event, box, "mask-resize")}
                    {...gestureHandlers}
                  />
                )}
              </div>
            )}
            {selected && !locked && HANDLES.map(dir => (
              <span
                key={dir}
                className={`sp-handle sp-${dir}`}
                data-dir={dir}
                title={`缩放（${dir}）`}
                onPointerDown={event => beginGesture(event, box, dir)}
                {...gestureHandlers}
              />
            ))}
            {selected && !locked && (
              <span
                className="sp-rotate"
                title="旋转"
                onPointerDown={event => beginGesture(event, box, "rotate")}
                {...gestureHandlers}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
