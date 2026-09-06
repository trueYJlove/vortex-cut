/** 合成画布画中画手势层（Phase 2 步骤 2 第一片）：把 IR 段几何映射为预览框上
 * 的可交互盒子——点击选中、拖拽移动（中心点语义 x/y ∈ [0,1] 画布归一化）。
 * draft/commit 走 App 既有 set_clip_transform 链路；拖拽开始冻结合成时钟
 * （播放头前进会越出片段区间）。旋转/缩放手柄与裁剪手势仍在交互预览层，
 * 后续逐手势迁移。 */
import { useRef, useState } from "react";

export interface PipBoxItem {
  clipId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 画布宽高（归一化换算用，来自 IR canvas）。 */
  canvasW: number;
  canvasH: number;
}

export interface SyntheticPipLayerProps {
  boxes: PipBoxItem[];
  view: { scale: number; offsetX: number; offsetY: number; width: number; height: number };
  selectedClipId: string | null;
  locked: boolean;
  onSelect: (clipId: string) => void;
  /** 拖拽中持续回调（画布归一化中心点）；调用方走 draft（本地文档）。 */
  onDraftMove: (clipId: string, x: number, y: number) => void;
  /** 拖拽结束提交（调用方走 patchTimeline）。 */
  onCommitMove: (clipId: string, x: number, y: number) => void;
  /** 拖拽开始冻结播放（返回是否曾处于播放态，结束时可恢复）。 */
  onGestureStart: () => boolean;
  onGestureEnd: (wasPlaying: boolean) => void;
}

export function SyntheticPipLayer(props: SyntheticPipLayerProps): React.ReactElement {
  const { boxes, view, selectedClipId, locked, onSelect, onDraftMove, onCommitMove, onGestureStart, onGestureEnd } = props;
  const dragRef = useRef<{ clipId: string; startX: number; startY: number; cx: number; cy: number; wasPlaying: boolean } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const toCss = (box: PipBoxItem): React.CSSProperties => ({
    position: "absolute",
    left: view.offsetX + box.x * view.scale,
    top: view.offsetY + box.y * view.scale,
    width: box.w * view.scale,
    height: box.h * view.scale,
  });

  const beginDrag = (event: React.PointerEvent, box: PipBoxItem): void => {
    if (locked) return;
    event.stopPropagation();
    const wasPlaying = onGestureStart();
    onSelect(box.clipId);
    dragRef.current = {
      clipId: box.clipId,
      startX: event.clientX,
      startY: event.clientY,
      cx: (box.x + box.w / 2) / box.canvasW,
      cy: (box.y + box.h / 2) / box.canvasH,
      wasPlaying,
    };
    setDraggingId(box.clipId);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dragMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = boxes.find(item => item.clipId === drag.clipId);
    if (!box) return;
    const nx = drag.cx + (event.clientX - drag.startX) / (box.canvasW * view.scale);
    const ny = drag.cy + (event.clientY - drag.startY) / (box.canvasH * view.scale);
    onDraftMove(drag.clipId, Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny)));
  };

  const endDrag = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = boxes.find(item => item.clipId === drag.clipId);
    if (box) {
      const nx = Math.max(0, Math.min(1, drag.cx + (event.clientX - drag.startX) / (box.canvasW * view.scale)));
      const ny = Math.max(0, Math.min(1, drag.cy + (event.clientY - drag.startY) / (box.canvasH * view.scale)));
      onCommitMove(drag.clipId, nx, ny);
    }
    dragRef.current = null;
    setDraggingId(null);
    onGestureEnd(drag.wasPlaying);
  };

  if (boxes.length === 0) return <></>;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 3 }} onPointerDown={event => event.stopPropagation()}>
      {boxes.map(box => {
        const selected = box.clipId === selectedClipId;
        const dragging = box.clipId === draggingId;
        return (
          <div
            key={box.clipId}
            role="button"
            aria-label={`画中画 ${box.clipId}`}
            style={{
              ...toCss(box),
              border: selected ? "1px solid #25d3ac" : "1px dashed rgba(37, 211, 172, .35)",
              cursor: locked ? "default" : dragging ? "grabbing" : "grab",
              touchAction: "none",
            }}
            onPointerDown={event => beginDrag(event, box)}
            onPointerMove={dragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        );
      })}
    </div>
  );
}
