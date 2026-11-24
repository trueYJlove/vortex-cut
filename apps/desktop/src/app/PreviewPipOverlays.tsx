import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { TimelineClip } from "@aivideo/contracts";
import { HANDLES, pipResizeFromHandle, type HandleDir } from "./pipResizeGeometry.js";
import { CORNERS, resizeCursor, rotateCellRect, rotateCursor, showEdgeMark, zRankByTracks, type CornerDir } from "./preview/stage-interaction.js";
import { clampMediaRate, mediaRateIsPlayable } from "./preview/media-rate.js";

/**
 * P1 画中画（PIP）：在交互预览画布上显示覆盖轨（V2+）片段的可视框。
 *
 * 手势性能关键约定：拖拽期间**直接写 DOM style（零 React 渲染）**，与原型一致；
 * pointerup 才一次性同步 App working 文档并提交 set_clip_transform（可撤销）。
 * 拖拽用 Pointer Capture 锁定指针（移出画布不丢手势，click 也命中盒子可拦截）。
 *
 * P2/P3 交互提示（设计文档 §5）：
 * - 蒙版：虚线边界拖拽平移/缩放 + CSS clip-path 实时裁剪（反选仅红色边界示意）；
 * - 抠像：底部棋盘格条 + KEY 徽标示意（精确效果以权威预览/成片为准）。
 * - 浮层媒体跟随播放头（时间线驱动），并按布局映射 object-fit（fit→contain，
 *   crop_fill/blurred_background→cover），与渲染管线的裁切表现一致。
 */

export type PipOverlay = {
  /** 覆盖片段。 */
  clip: TimelineClip;
  /** 片段素材媒体 URL（交互预览可用）。 */
  media_url: string;
  /** 内容盒尺寸（预览画布像素，scale=1 时）：素材等比适配进画布的实际大小
   *  （剪映式：选中框紧贴真实内容）；裁切填满 = 画布尺寸。 */
  fit_w: number;
  fit_h: number;
};

export type PipTransform = NonNullable<TimelineClip["transform"]>;
export type PipMask = NonNullable<TimelineClip["mask"]>;

type Props = {
  /** 播放头处的全部覆盖轨片段（已过滤轨道隐藏；含选中的覆盖片段）。 */
  items: PipOverlay[];
  selectedClipId: string | null;
  locked: boolean;
  onSelect: (clipId: TimelineClip["clip_id"]) => void;
  /** 手势结束同步本地文档（不落 revision）。 */
  onDraftTransform: (clipId: TimelineClip["clip_id"], transform: PipTransform) => void;
  /** 手势结束落盘。 */
  onCommitTransform: (clipId: TimelineClip["clip_id"], transform: PipTransform) => void;
  /** 蒙版边界拖拽草稿/落盘（Phase B）。 */
  onDraftMask?: (clipId: TimelineClip["clip_id"], mask: PipMask) => void;
  onCommitMask?: (clipId: TimelineClip["clip_id"], mask: PipMask) => void;
  /** 手势开始暂停预览播放（返回是否原本在播放）；结束时按需恢复——
   *  播放头在拖拽中前进会越出片段区间，导致浮层被移除（"弹出去"）。 */
  onGesturePause?: () => boolean;
  onGestureResume?: (wasPlaying: boolean) => void;
  /** 播放头（时间线唯一时钟）与播放状态：浮层媒体跟随标尺同步播放。 */
  playheadUs: number;
  playing: boolean;
  playbackRate?: number;
  /** S8：轨道数组序（0=最上层）作为命中与绘制的唯一 z 序来源。 */
  tracks?: readonly { id: string }[];
};

/** 画中画媒体：跟随播放头同步（时间线驱动，非自由播放）——所见即所得。 */
function PipMedia({ clip, src, clipPath, playing, playheadUs, playbackRate }: { clip: TimelineClip; src: string; clipPath?: string; playing: boolean; playheadUs: number; playbackRate: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const media = ref.current;
    if (!media || clip.asset_kind !== "video") return;
    const speed = ((clip.speed_milli ?? 1000) / 1000) * playbackRate;
    media.playbackRate = clampMediaRate(speed);
    const active = playheadUs >= clip.timeline_start_us && playheadUs < clip.timeline_end_us;
    if (!active) { if (!media.paused) media.pause(); return; }
    const expected = (clip.source_start_us ?? 0) / 1_000_000 + ((playheadUs - clip.timeline_start_us) / 1_000_000) * speed;
    const threshold = mediaRateIsPlayable(speed) ? 0.18 : 1 / 30;
    if (Math.abs(media.currentTime - expected) > threshold) media.currentTime = Math.max(0, expected);
    if (playing && mediaRateIsPlayable(speed)) void media.play().catch(() => {}); else if (!media.paused) media.pause();
  }, [clip, playing, playheadUs, playbackRate]);
  return <video ref={ref} className="pip-media" src={src} style={{ clipPath: clipPath ?? undefined, objectFit: "contain" }} muted playsInline aria-hidden="true" preload="auto" />;
}

function defaults(clip: TimelineClip): Required<PipTransform> {
  const t = clip.transform ?? {};
  return { x: t.x ?? 0.5, y: t.y ?? 0.5, scale: t.scale ?? 1, rotate: t.rotate ?? 0, opacity: t.opacity ?? 1 };
}

function maskDefaults(mask: PipMask): { x: number; y: number; width: number; height: number } {
  return { x: mask.x ?? 0.5, y: mask.y ?? 0.5, width: mask.width ?? 0.5, height: mask.height ?? 0.5 };
}

/** 蒙版 → CSS clip-path（相对本片段画面，与渲染 geq 语义一致）。
 *  反选暂不做实时裁剪（CSS 反选遮罩复杂度高一档），以红色边界示意、效果走权威预览。 */
function maskClipPath(mask: PipMask): string | undefined {
  if (mask.invert) return undefined;
  const x = (mask.x ?? 0.5) * 100, y = (mask.y ?? 0.5) * 100;
  const w = (mask.width ?? 0.5) * 100, h = (mask.height ?? 0.5) * 100;
  if (mask.kind === "ellipse") return `ellipse(${w / 2}% ${h / 2}% at ${x}% ${y}%)`;
  if (mask.kind === "rect") return `inset(${y - h / 2}% ${100 - (x + w / 2)}% ${100 - (y + h / 2)}% ${x - w / 2}%)`;
  return `polygon(0% 0%, 100% 0%, 100% ${Math.min(100, y + 12)}%, ${x}% ${y}%, 0% ${y}%)`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const CORNER_ANGLE: Record<CornerDir, number> = { nw: 45, ne: 135, se: 45, sw: 135 };
const EDGE_ANGLE: Record<"n" | "s" | "e" | "w", number> = { n: 90, s: 90, e: 0, w: 0 };
const ROTATE_AT: Record<CornerDir, number> = { ne: 0, se: 90, sw: 180, nw: 270 };
const resizeCursorForCorner = (corner: CornerDir, rotate: number) => resizeCursor(CORNER_ANGLE[corner] + rotate);
const resizeCursorForEdge = (edge: "n" | "s" | "e" | "w", rotate: number) => resizeCursor(EDGE_ANGLE[edge] + rotate);
const rotateAt = (corner: CornerDir) => ROTATE_AT[corner];

/** 手势期间直接写盒子 DOM（绕过 React，零延迟跟手）。 */
function applyPipTransformStyles(el: HTMLElement | null, tf: Required<PipTransform>, fitW: number, fitH: number) {
  if (!el) return;
  el.style.left = `${tf.x * 100}%`;
  el.style.top = `${tf.y * 100}%`;
  el.style.width = fitW ? `${fitW * tf.scale}px` : `${tf.scale * 100}%`;
  el.style.height = fitH ? `${fitH * tf.scale}px` : `${tf.scale * 100}%`;
  el.style.transform = `translate(-50%,-50%) rotate(${tf.rotate}deg)`;
  el.style.opacity = String(tf.opacity);
}

/** 手势期间直接写蒙版边界与媒体裁剪。 */
function applyMaskStyles(maskEl: HTMLElement | null, mediaEl: HTMLElement | null, mask: PipMask) {
  const d = maskDefaults(mask);
  if (maskEl) {
    if (mask.kind === "linear") {
      maskEl.style.left = "-10%";
      maskEl.style.top = `${d.y * 100}%`;
      maskEl.style.width = "120%";
      maskEl.style.height = "2px";
    } else {
      maskEl.style.left = `${(d.x - d.width / 2) * 100}%`;
      maskEl.style.top = `${(d.y - d.height / 2) * 100}%`;
      maskEl.style.width = `${d.width * 100}%`;
      maskEl.style.height = `${d.height * 100}%`;
    }
  }
  if (mediaEl) {
    const clipPath = maskClipPath(mask);
    if (clipPath) mediaEl.style.clipPath = clipPath;
  }
}

export function PreviewPipOverlays({
  items,
  selectedClipId,
  locked,
  onSelect,
  onDraftTransform,
  onCommitTransform,
  onDraftMask,
  onCommitMask,
  onGesturePause,
  onGestureResume,
  playheadUs,
  playing,
  playbackRate = 1,
  tracks = [],
}: Props) {
  /** 下层先画、上层后画：DOM 顺序按 zRank 降序，最后一个兄弟即最上层。
   *  与 Core layers 的下层先画/上层后画顺序同源；绝不按 document.clips 序。 */
  const rankedItems = items.map((item, index) => ({ item, index, rank: zRankByTracks(tracks, item.clip.track_id) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(entry => entry.item);
  const gesture = useRef<{ clipId: TimelineClip["clip_id"]; mode: "move" | "rotate" | HandleDir; startX: number; startY: number; cw: number; ch: number; latest: Required<PipTransform>; el: HTMLElement; fitW: number; fitH: number; wasPlaying: boolean; startAngle: number; centerX: number; centerY: number } | null>(null);
  const maskGesture = useRef<{ clipId: TimelineClip["clip_id"]; mode: "move" | "resize"; startX: number; startY: number; box: DOMRect; start: { x: number; y: number; width: number; height: number }; latest: PipMask; maskEl: HTMLElement; mediaEl: HTMLElement | null; wasPlaying: boolean } | null>(null);

  const begin = (item: PipOverlay, mode: "move" | "rotate" | HandleDir, e: ReactPointerEvent<HTMLElement>) => {
    if (locked) return;
    onSelect(item.clip.clip_id);
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.closest?.(".preview-canvas")?.getBoundingClientRect();
    const cw = (rect?.width ?? window.innerWidth) || 1;
    const ch = (rect?.height ?? window.innerHeight) || 1;
    // 手势起点：暂停预览播放（播放头前进会越出片段区间，导致浮层被移除）。
    const wasPlaying = onGesturePause?.() ?? false;
    // Pointer Capture：后续指针事件（含 pointerup 后的 click）锁定到盒子上——
    // 指针移出盒子/画布也持续跟踪，且 click 命中盒子可被 stopPropagation 拦截，
    // 不会冒泡到预览画布把选中切回主轨片段。
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* 指针可能已释放 */ }
    const start = defaults(item.clip);
    // 旋转：以盒子中心为原点的起始方位角（客户 px 空间）。
    const centerX = (rect?.left ?? 0) + start.x * cw;
    const centerY = (rect?.top ?? 0) + start.y * ch;
    gesture.current = {
      clipId: item.clip.clip_id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      cw: Math.max(1, cw),
      ch: Math.max(1, ch),
      latest: { ...start },
      el,
      fitW: item.fit_w,
      fitH: item.fit_h,
      wasPlaying,
      startAngle: Math.atan2(e.clientY - centerY, e.clientX - centerX),
      centerX,
      centerY,
    };
    const onMove = (ev: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.mode === "move") {
        // 增量位移锚定抓取点；禁止用指针绝对位置反推中心——否则首帧会向指针跳动。
        const dx = (ev.clientX - g.startX) / g.cw;
        const dy = (ev.clientY - g.startY) / g.ch;
        g.latest.x = clamp(g.latest.x + dx, 0, 1);
        g.latest.y = clamp(g.latest.y + dy, 0, 1);
      } else if (g.mode === "rotate") {
        const angle = Math.atan2(ev.clientY - g.centerY, ev.clientX - g.centerX);
        let deg = defaults(item.clip).rotate + ((angle - g.startAngle) * 180) / Math.PI;
        deg = ((deg % 360) + 540) % 360 - 180;
        if (Math.abs(deg) < 2) deg = 0;
        g.latest.rotate = deg;
      } else {
        // 8 向手柄：对侧锚定（被拖方向的对边/对角保持不动），内拉缩小、外拉放大。
        const resized = pipResizeFromHandle(g.mode, { x: ev.clientX, y: ev.clientY }, start, g.cw, g.ch);
        g.latest.scale = resized.scale;
        g.latest.x = resized.x;
        g.latest.y = resized.y;
      }
      // 直接写 DOM：零 React 渲染，指针到像素零延迟。
      applyPipTransformStyles(g.el, g.latest, g.fitW, g.fitH);
    };
    const onUp = () => {
      const g = gesture.current;
      gesture.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onGestureResume?.(g?.wasPlaying ?? false);
      if (!g) return;
      const final = { ...g.latest };
      applyPipTransformStyles(g.el, final, g.fitW, g.fitH);
      onDraftTransform(item.clip.clip_id, final);
      onCommitTransform(item.clip.clip_id, final);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 蒙版边界拖拽：move 平移 x/y；resize 缩放 width/height（均为片段画面归一化坐标）。 */
  const beginMask = (item: PipOverlay, mask: PipMask, mode: "move" | "resize", e: ReactPointerEvent<HTMLElement>) => {
    if (locked) return;
    onSelect(item.clip.clip_id);
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget as HTMLElement).closest?.(".pip-overlay")?.getBoundingClientRect();
    if (!box) return;
    const wasPlaying = onGesturePause?.() ?? false;
    const maskEl = e.currentTarget as HTMLElement;
    try { maskEl.setPointerCapture(e.pointerId); } catch { /* 指针可能已释放 */ }
    const mediaEl = (e.currentTarget as HTMLElement).closest?.(".pip-overlay")?.querySelector<HTMLElement>(".pip-media") ?? null;
    maskGesture.current = {
      clipId: item.clip.clip_id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      box,
      start: maskDefaults(mask),
      latest: { ...mask },
      maskEl,
      mediaEl,
      wasPlaying,
    };
    const onMove = (ev: PointerEvent) => {
      const g = maskGesture.current;
      if (!g) return;
      const latest = maskDefaults(g.latest as PipMask);
      if (g.mode === "move") {
        const dx = (ev.clientX - g.startX) / Math.max(1, g.box.width);
        const dy = (ev.clientY - g.startY) / Math.max(1, g.box.height);
        latest.x = clamp(g.start.x + dx, 0, 1);
        latest.y = clamp(g.start.y + dy, 0, 1);
      } else {
        const cx = g.box.left + g.start.x * g.box.width;
        const cy = g.box.top + g.start.y * g.box.height;
        latest.width = clamp(Math.abs(ev.clientX - cx) * 2 / Math.max(1, g.box.width), 0.02, 1);
        latest.height = clamp(Math.abs(ev.clientY - cy) * 2 / Math.max(1, g.box.height), 0.02, 1);
      }
      g.latest = { ...(g.latest as PipMask), ...latest };
      // 直接写 DOM：边界框与媒体裁剪零延迟。
      applyMaskStyles(g.maskEl, g.mediaEl, g.latest as PipMask);
    };
    const onUp = () => {
      const g = maskGesture.current;
      maskGesture.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onGestureResume?.(g?.wasPlaying ?? false);
      if (!g) return;
      const final = { ...g.latest };
      applyMaskStyles(g.maskEl, g.mediaEl, final);
      onDraftMask?.(item.clip.clip_id, final);
      onCommitMask?.(item.clip.clip_id, final);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      {rankedItems.map((item) => {
        // 手势中的片段读 gesture ref（任何重渲染也保持手势值，避免回跳）。
        const gesturing = gesture.current?.clipId === item.clip.clip_id ? gesture.current : null;
        const tf = gesturing ? gesturing.latest : defaults(item.clip);
        const selected = item.clip.clip_id === selectedClipId;
        const maskLive = maskGesture.current?.clipId === item.clip.clip_id ? (maskGesture.current.latest as PipMask) : null;
        const mask = maskLive ?? (item.clip.mask && Object.keys(item.clip.mask).length ? item.clip.mask : null);
        const md = mask ? maskDefaults(mask) : null;
        const clipPath = mask ? maskClipPath(mask) : undefined;
        const maskStyle: CSSProperties | null = mask && md
          ? (mask.kind === "linear"
            ? { left: "-10%", top: `${md.y * 100}%`, width: "120%", height: 2 }
            : { left: `${(md.x - md.width / 2) * 100}%`, top: `${(md.y - md.height / 2) * 100}%`, width: `${md.width * 100}%`, height: `${md.height * 100}%` })
          : null;
        // 盒 = 内容实际大小（fit/模糊背景 = 内容等比适配进画布；裁切填满 = 满画布）
        // × 缩放；object-fit 恒为 contain（盒比例==内容比例）——与渲染几何一致。
        const boxW = item.fit_w * tf.scale;
        const boxH = item.fit_h * tf.scale;
        return (
          <div
            key={item.clip.clip_id}
            className={`pip-overlay${selected ? " selected" : ""}`}
            style={{
              left: `${tf.x * 100}%`,
              top: `${tf.y * 100}%`,
              width: `${boxW}px`,
              height: `${boxH}px`,
              transform: `translate(-50%,-50%) rotate(${tf.rotate}deg)`,
              opacity: tf.opacity,
            }}
            onPointerDown={(e) => begin(item, "move", e)}
            onClick={e => e.stopPropagation()}
            role="button"
            aria-label={`画中画 ${item.clip.clip_id}`}
          >
            <span className="pip-badge">PIP</span>
            {item.clip.keying && Object.keys(item.clip.keying).length > 0 && (
              <>
                <span className="pip-badge key">KEY</span>
                <span className="pip-key-hint" title="已启用抠像：色度键无法在交互画布精确预览，以权威预览/成片为准" />
              </>
            )}
            {item.clip.asset_kind === "video" ? (
              <PipMedia clip={item.clip} src={item.media_url} clipPath={clipPath} playing={playing} playheadUs={playheadUs} playbackRate={playbackRate} />
            ) : (
              <img className="pip-media" src={item.media_url} style={{ clipPath: clipPath ?? undefined, objectFit: "contain" }} alt="" draggable={false} />
            )}
            {mask && maskStyle && onDraftMask && onCommitMask && (
              <div
                className={`pip-maskline kind-${mask.kind}${mask.invert ? " invert" : ""}`}
                style={maskStyle}
                title="蒙版边界：拖动平移，拖白点缩放"
                onClick={e => e.stopPropagation()}
                onPointerDown={e => {
                  if ((e.target as HTMLElement).closest(".pip-mask-knob")) return;
                  beginMask(item, mask, "move", e);
                }}
              >
                {selected && mask.kind !== "linear" && (
                  <span
                    className="pip-mask-knob"
                    style={{ left: "100%", top: "100%" }}
                    onPointerDown={e => beginMask(item, mask, "resize", e)}
                  />
                )}
              </div>
            )}
            {selected && !locked &&
              HANDLES.map((dir) => {
                const corner = CORNERS.includes(dir as CornerDir) ? dir as CornerDir : null;
                const rotate = tf.rotate;
                const cursor = corner
                  ? resizeCursorForCorner(corner, rotate)
                  : resizeCursorForEdge(dir as "n" | "s" | "e" | "w", rotate);
                const mark = corner ? null : showEdgeMark(dir as "n" | "s" | "e" | "w", boxW, boxH);
                return (
                  <span
                    key={dir}
                    className={`pip-handle h-${dir}${mark ? " marked" : ""}`}
                    data-dir={dir}
                    style={{ width: 14, height: 14, cursor }}
                    title={`缩放（${dir}）`}
                    onPointerDown={(e) => begin(item, dir, e)}
                  />
                );
              })}
            {selected && !locked && CORNERS.map(corner => {
              const cell = rotateCellRect(corner, { x: 0, y: 0, w: boxW, h: boxH });
              return (
                <span
                  key={`rotate-${corner}`}
                  className={`pip-rotate pip-rotate-${corner}`}
                  data-dir={corner}
                  aria-label={`旋转画中画 ${corner}`}
                  style={{ left: cell.x, top: cell.y, width: 20, height: 20, cursor: rotateCursor(rotateAt(corner) + tf.rotate) }}
                  onPointerDown={(e) => begin(item, "rotate", e)}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}
