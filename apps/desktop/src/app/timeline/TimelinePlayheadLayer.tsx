/** 播放头独立覆盖层（A06）：主画布/固定标尺不再绘制播放头，播放头成为
 *  独立 DOM 线 + 标尺带手柄（transform: translateX 合成器路径，无布局/重绘
 *  传播）。预览每帧写入 playhead-store，本组件 useSyncExternalStore 高频跟随，
 *  App 仍然 10Hz 更新其播放头状态（App commit 频率不随 rAF 提升——验收指标）。
 *  pointer-events: none——拖拽命中仍由标尺/空白区原有命中测试提供。 */
import { memo, useSyncExternalStore } from "react";
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
}

function TimelinePlayheadLayerImpl({
  store,
  view,
  totalUs,
  contentHeight,
}: TimelinePlayheadLayerProps): React.ReactElement | null {
  const playheadUs = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const clampedUs = totalUs > 0 ? Math.min(playheadUs, totalUs) : playheadUs;
  const x = timeToX(clampedUs, view);
  // 与旧 Canvas 绘制相同的可视判据：线段起点钳制在头列右缘。
  if (x < view.headerWidth - 3) return null;
  return (
    <div className="timeline-playhead-layer" aria-hidden="true">
      <span
        className="timeline-playhead-line"
        style={{ height: contentHeight, transform: `translateX(${x}px)` }}
      />
      {/* 手柄带与固定标尺同高（钉在可视区顶部）：绝对定位，translateX 跟随。 */}
      <span
        className="timeline-playhead-handle"
        style={{ transform: `translateX(${x}px)`, top: 3 }}
      />
    </div>
  );
}

export const TimelinePlayheadLayer = memo(TimelinePlayheadLayerImpl);
