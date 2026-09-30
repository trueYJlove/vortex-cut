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
import { memo, useEffect, useRef } from "react";
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

/** 与旧 Canvas 绘制相同的可视判据：线段起点钳制在头列右缘。 */
const isVisible = (x: number, headerWidth: number): boolean => x >= headerWidth - 3;

function TimelinePlayheadLayerImpl({
  store,
  view,
  totalUs,
  contentHeight,
}: TimelinePlayheadLayerProps): React.ReactElement {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLSpanElement | null>(null);
  const handleRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const apply = (): void => {
      const layer = layerRef.current;
      const line = lineRef.current;
      const handle = handleRef.current;
      if (!layer || !line || !handle) return;
      const raw = store.get();
      const clampedUs = totalUs > 0 ? Math.min(raw, totalUs) : raw;
      const x = timeToX(clampedUs, view);
      if (!isVisible(x, view.headerWidth)) {
        // 可视判据不满足：隐藏（保留节点，避免进出视区时反复挂载/卸载）。
        layer.style.display = "none";
        return;
      }
      layer.style.display = "";
      line.style.height = `${contentHeight}px`;
      line.style.transform = `translateX(${x}px)`;
      handle.style.transform = `translateX(${x}px)`;
    };
    apply(); // 首帧：立即跟随当前时间（订阅只在变更时回调）
    return store.subscribe(apply);
    // view/totalUs/contentHeight 变化（缩放/滚动/换片）→ 重算并重订阅
  }, [store, view, totalUs, contentHeight]);

  return (
    <div className="timeline-playhead-layer" aria-hidden="true" ref={layerRef}>
      <span className="timeline-playhead-line" ref={lineRef} />
      {/* 手柄带与固定标尺同高（钉在可视区顶部）：绝对定位，translateX 跟随。 */}
      <span className="timeline-playhead-handle" ref={handleRef} style={{ top: 3 }} />
    </div>
  );
}

export const TimelinePlayheadLayer = memo(TimelinePlayheadLayerImpl);
