import type { Asset, MediaStream, OutputRatio, TimelineClip, TimelineDocument, TimelinePatchOperation } from "@aivideo/contracts";
import type { AlignDistribution, AlignEdge } from "../../ui/of/AlignBar.js";

export type FrameBounds = { left: number; top: number; width: number; height: number };
export type GroupBoundsField = "x" | "y" | "width" | "height";
type Box = FrameBounds;
type Subject = { clip: TimelineClip; box: Box };
type CanvasSize = Pick<TimelineDocument["canvas"], "width" | "height">;
type ProbeStream = MediaStream & { sample_aspect_ratio_num?: number; sample_aspect_ratio_den?: number };
// Match the Core authoritative preview profile used to build the live composition.
export const alignmentPreviewSize: Record<Exclude<OutputRatio, "fit">, CanvasSize> = {
  "169": { width: 960, height: 540 },
  "916": { width: 540, height: 960 },
  "11": { width: 720, height: 720 },
  "43": { width: 832, height: 624 },
  "34": { width: 624, height: 832 },
};

// Adapted from OpenFilm (MIT), studio/ui/src/lib/stage-gesture.ts alignShift.
function alignShift(edge: AlignEdge, box: Box, target: Box) {
  return {
    dx: edge === "left" ? target.left - box.left
      : edge === "right" ? target.left + target.width - (box.left + box.width)
      : edge === "hcenter" ? target.left + target.width / 2 - (box.left + box.width / 2) : 0,
    dy: edge === "top" ? target.top - box.top
      : edge === "bottom" ? target.top + target.height - (box.top + box.height)
      : edge === "vcenter" ? target.top + target.height / 2 - (box.top + box.height / 2) : 0,
  };
}

export function alignmentBox(clip: TimelineClip, asset: Asset | undefined, canvas: CanvasSize): Box | null {
  const streams = asset?.media_info?.video_streams;
  const stream = Array.isArray(streams) ? streams[0] as ProbeStream | undefined : undefined;
  if (!stream?.width || !stream.height || !canvas.width || !canvas.height) return null;
  const sar = (stream.sample_aspect_ratio_num || 1) / (stream.sample_aspect_ratio_den || 1);
  const turned = Math.abs(stream.rotation ?? 0) % 180 === 90;
  const width = (turned ? stream.height : stream.width) * sar;
  const height = turned ? stream.width : stream.height;
  const ratios = [canvas.width / width, canvas.height / height];
  const fit = clip.layout === "crop_fill" ? Math.max(...ratios) : Math.min(...ratios);
  const scale = clip.transform?.scale ?? 1;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const w = even(even(width * fit) * scale);
  const h = even(even(height * fit) * scale);
  const radians = (clip.transform?.rotate ?? 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const boxWidth = w * cos + h * sin;
  const boxHeight = w * sin + h * cos;
  const x = (clip.transform?.x ?? 0.5) * canvas.width;
  const y = (clip.transform?.y ?? 0.5) * canvas.height;
  return { left: x - boxWidth / 2, top: y - boxHeight / 2, width: boxWidth, height: boxHeight };
}

export function planFrameAlignment(
  edge: AlignEdge, canvas: CanvasSize, subjects: readonly { clip: TimelineClip; box: Box }[],
): TimelinePatchOperation[] | null {
  if (subjects.length === 0) return [];
  let target: Box = { left: 0, top: 0, ...canvas };
  if (subjects.length > 1) {
    const boxes = subjects.map(subject => subject.box);
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    target = {
      left, top,
      width: Math.max(...boxes.map(box => box.left + box.width)) - left,
      height: Math.max(...boxes.map(box => box.top + box.height)) - top,
    };
  }
  const operations: TimelinePatchOperation[] = [];
  for (const { clip, box } of subjects) {
    const { dx, dy } = alignShift(edge, box, target);
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
    const x = (clip.transform?.x ?? 0.5) + dx / canvas.width;
    const y = (clip.transform?.y ?? 0.5) + dy / canvas.height;
    if (x < -1e-9 || x > 1 + 1e-9 || y < -1e-9 || y > 1 + 1e-9) return null;
    operations.push({ op: "set_clip_transform", clip_id: clip.clip_id, transform: {
      ...clip.transform,
      ...(Math.abs(dx) >= 0.01 ? { x: Math.max(0, Math.min(1, x)) } : {}),
      ...(Math.abs(dy) >= 0.01 ? { y: Math.max(0, Math.min(1, y)) } : {}),
    } });
  }
  return operations;
}

// Adapted from OpenFilm (MIT), studio/ui/src/lib/stage-gesture.ts distributeShifts.
export function planFrameDistribution(axis: AlignDistribution, canvas: CanvasSize, subjects: readonly { clip: TimelineClip; box: Box }[]): TimelinePatchOperation[] | null {
  if (subjects.length < 3) return [];
  const horizontal = axis === "horizontal";
  const start = (b: Box) => horizontal ? b.left : b.top;
  const size = (b: Box) => horizontal ? b.width : b.height;
  const order = [...subjects].sort((a, b) => start(a.box) - start(b.box));
  const first = order[0]!.box;
  const last = order[order.length - 1]!.box;
  const span = start(last) + size(last) - start(first);
  const gap = (span - order.reduce((sum, item) => sum + size(item.box), 0)) / (order.length - 1);
  let cursor = start(first) + size(first) + gap;
  const operations: TimelinePatchOperation[] = [];
  for (const { clip, box } of order.slice(1, -1)) {
    const delta = cursor - start(box);
    cursor += size(box) + gap;
    if (Math.abs(delta) < 0.01) continue;
    const current = horizontal ? (clip.transform?.x ?? 0.5) : (clip.transform?.y ?? 0.5);
    const next = current + delta / (horizontal ? canvas.width : canvas.height);
    if (next < -1e-9 || next > 1 + 1e-9) return null;
    operations.push({ op: "set_clip_transform", clip_id: clip.clip_id, transform: {
      ...clip.transform,
      ...(horizontal ? { x: Math.max(0, Math.min(1, next)) } : { y: Math.max(0, Math.min(1, next)) }),
    } });
  }
  return operations;
}

export function groupFrameBounds(subjects: readonly Subject[]): FrameBounds | null {
  if (subjects.length < 2) return null;
  const boxes = subjects.map(({ box }) => box);
  const left = Math.min(...boxes.map(box => box.left));
  const top = Math.min(...boxes.map(box => box.top));
  return {
    left, top,
    width: Math.max(...boxes.map(box => box.left + box.width)) - left,
    height: Math.max(...boxes.map(box => box.top + box.height)) - top,
  };
}

// OpenFilm's groupEdit/scaleBounds keeps the upper-left corner fixed when scaling.
export function planGroupBoundsEdit(
  field: GroupBoundsField, value: number, canvas: CanvasSize, subjects: readonly Subject[],
): TimelinePatchOperation[] | null {
  const bounds = groupFrameBounds(subjects);
  if (!bounds || !Number.isFinite(value)) return null;
  const resizing = field === "width" || field === "height";
  const current = resizing ? bounds[field] : field === "x" ? bounds.left : bounds.top;
  if (Math.abs(value - current) < 0.01) return [];
  const factor = resizing ? value / bounds[field] : 1;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  const dx = field === "x" ? value - bounds.left : 0;
  const dy = field === "y" ? value - bounds.top : 0;

  const operations: TimelinePatchOperation[] = [];
  for (const { clip } of subjects) {
    const original = clip.transform;
    const cx = (original?.x ?? 0.5) * canvas.width;
    const cy = (original?.y ?? 0.5) * canvas.height;
    const x = (bounds.left + (cx - bounds.left) * factor + dx) / canvas.width;
    const y = (bounds.top + (cy - bounds.top) * factor + dy) / canvas.height;
    const scale = (original?.scale ?? 1) * factor;
    if (x < -1e-9 || x > 1 + 1e-9 || y < -1e-9 || y > 1 + 1e-9 || scale < 0.05 - 1e-9 || scale > 5 + 1e-9) return null;
    operations.push({
      op: "set_clip_transform", clip_id: clip.clip_id, transform: {
        ...original,
        ...(resizing || field === "x" ? { x: Math.max(0, Math.min(1, x)) } : {}),
        ...(resizing || field === "y" ? { y: Math.max(0, Math.min(1, y)) } : {}),
        ...(resizing ? { scale: Math.max(0.05, Math.min(5, scale)) } : {}),
      },
    });
  }
  return operations;
}
