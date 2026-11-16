/** 播放头独立覆盖层（A06）：主画布/固定标尺不再绘制播放头，播放头成为
 *  独立 DOM 线 + 标尺带手柄（transform: translateX 合成器路径，无布局/重绘
 *  传播）。
 *
 *  P33 L9（2026-09-30）：**改为命令式跟随，不再 useSyncExternalStore**。
 *  旧实现让 store 的每一次通知都走一次 React 提交——播放期 store 按帧写入
 *  （30Hz），实测 dev 构建下 `react_commit` **1791 次 / 11.3 秒（59 秒播放，
 *  单次最大 68ms）**，把主线程切成 rAF p95 ≈ 50ms 的碎片；而呈现循环挂在主
 *  线程 rAF 上，于是每次提交尖峰都会跳帧（真机 dev 丢帧 85~112，同机生产构建
 *  0 丢帧）。现在订阅只改 `style.transform` / `style.height` / `display`：
 *  播放期零 React 提交，覆盖层跟随精度不变（仍是 store 通知驱动）。
 *  pointer-events: none——拖拽命中仍由标尺/空白区原有命中测试提供。 */
import { memo, useEffect, useRef, useState } from "react";
import type { PlayheadStore } from "./playhead-store.js";
import { timeToX } from "./geometry.js";
import type { TimelineViewState } from "./types.js";

export interface TimelinePlayheadLayerProps {
  store: PlayheadStore;
  /** 时间 → 主画布坐标 x（px）。播放头显示位置钳制在素材终点内。 */
  view: TimelineViewState;
  /** 素材终点（µs）；空时间线（=0）不钳制。 */
  totalUs: number;
  /** 主画布内容高度（px）——竖线高度。 */
  contentHeight: number;
  /** 正在擦洗（按住播放头/标尺拖动）：旋钮由空心变实心。
   *  参照 OpenFilm 的 PlayheadKnob(filled)——按下实心、松开空心，
   *  让"我正在拖它"这件事在指针下就有反馈，不必等时间码变化。 */
  scrubbing?: boolean;
}

/** 与旧 Canvas 绘制相同的可视判据：线段起点钳制在头列右缘。 */
const isVisible = (x: number, headerWidth: number): boolean => x >= headerWidth - 3;

function TimelinePlayheadLayerImpl({
  store,
  view,
  totalUs,
  contentHeight,
  scrubbing = false,
}: TimelinePlayheadLayerProps): React.ReactElement {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLSpanElement | null>(null);
  const handleRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    /** 画到某个时间点（µs）——所有跟随路径的公共出口。 */
    const paint = (rawUs: number): void => {
      const layer = layerRef.current;
      const lineEl = lineRef.current;
      const handle = handleRef.current;
      if (!layer || !lineEl || !handle) return;
      const clampedUs = totalUs > 0 ? Math.min(rawUs, totalUs) : rawUs;
      const x = timeToX(clampedUs, view);
      if (!isVisible(x, view.headerWidth)) {
        // 可视判据不满足：隐藏（保留节点，避免进出视区时反复挂载/卸载）。
        layer.style.display = "none";
        return;
      }
      layer.style.display = "";
      lineEl.style.height = `${contentHeight}px`;
      lineEl.style.transform = `translateX(${x}px)`;
      handle.style.transform = `translateX(${x}px)`;
    };

    /** 订阅回调：store 变更时按"此刻该在哪"重画。
     *  有直线时 store.get() 已按直线外推，因此这里无需区分两种表示。 */
    const apply = (): void => paint(store.get());

    apply(); // 首帧：立即跟随当前时间（订阅只在变更时回调）

    const unsubscribe = store.subscribe(apply);
    // 有播放直线时，额外挂一个 rAF 循环自行外推：
    // OpenFilm 的播放头就是这么跟的——整段播放期间 store 只通知一次，
    // 之后靠本地 rAF 按 anchorTime 推进，避免每帧走"微任务合并 + 通知订阅者"。
    let raf = 0;
    const followLine = (): void => {
      const activeLine = store.getLine();
      if (!activeLine) { raf = 0; return; }
      paint(Math.max(0, activeLine.tUs + Math.max(0, performance.now() - activeLine.atMs) * activeLine.rate));
      raf = requestAnimationFrame(followLine);
    };
    // 订阅回调里若检测到直线启动/结束，负责起停 rAF
    const sync = (): void => {
      apply();
      if (store.getLine()) { if (!raf) raf = requestAnimationFrame(followLine); }
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    };
    const unsubSync = store.subscribe(sync);

    return () => { unsubscribe(); unsubSync(); if (raf) cancelAnimationFrame(raf); };
    // view/totalUs/contentHeight 变化（缩放/滚动/换片）→ 重算并重订阅
  }, [store, view, totalUs, contentHeight]);

  return (
    <div className="timeline-playhead-layer" aria-hidden="true" ref={layerRef}>
      <span className="timeline-playhead-line" ref={lineRef} />
      {/* 手柄带与固定标尺同高（钉在可视区顶部）：绝对定位，translateX 跟随。 */}
      {/* 旋钮：12x17 图钉形状（与 OpenFilm 同形），空心态=常态、实心态=按住拖动。
          命中区 24x20 比图形本身大——人手瞄准的是那根线，差几像素就抓不到。
          图形固定在水平中心，由外层 translateX 跟随；缩放时父层 transform 不放大它。 */}
      <span className="timeline-playhead-handle" ref={handleRef}>
        <svg width="12" height="17" viewBox="0 0 12 17" aria-hidden="true">
          <path
            d="M1.9 3.4a2 2 0 0 1 2-2h4.2a2 2 0 0 1 2 2v5.3a4.1 4.1 0 0 1-8.2 0z"
            fill={scrubbing ? "var(--tl-playhead-fill, #ffffff)" : "var(--tl-playhead-rest, #18181b)"}
            stroke="var(--tl-playhead-stroke, #ffffff)"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  );
}

export const TimelinePlayheadLayer = memo(TimelinePlayheadLayerImpl);
