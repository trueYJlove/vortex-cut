/** 时间区间选取（2026-11-10）：在标尺上拖出一段时间，两端可调、可清除。
 *
 * **范围限定**：本模块只负责"选中一段时间"及其视觉表达，**不接任何操作**。
 * 它驱动什么（导出该区间 / 删除静音 / 循环播放）尚未定义——按 OpenFilm
 * 的做法，区间是"引用"的载体（可拖到聊天里），但我们的产品还没有那个入口。
 * 因此这里刻意只做视觉与几何，任何破坏性行为都不在此模块发生。
 *
 * 与 TimelineSelection（clip/caption/transition）并行独立：
 * 对象选择与时间区间是两件事，混进同一个联合会让所有既有分支都要改。
 */
export interface TimeRange {
  /** 起点（µs，时间线时间域）。 */
  startUs: number;
  /** 终点（µs）。 */
  endUs: number;
}

/** 归一化：保证 start ≤ end，并钳制在 [0, totalUs] 内。 */
export function normalizeRange(range: TimeRange, totalUs: number): TimeRange {
  const lo = Math.max(0, Math.min(range.startUs, range.endUs));
  const hi = Math.min(totalUs > 0 ? totalUs : Number.MAX_SAFE_INTEGER, Math.max(range.startUs, range.endUs));
  return { startUs: lo, endUs: hi };
}

/** 区间长度（µs）。 */
export function rangeDuration(range: TimeRange): number {
  return Math.max(0, range.endUs - range.startUs);
}

/** 区间是否短到不值得显示（拖一下产生的抖动用这个过滤）。 */
export const MIN_RANGE_US = 50_000;

/** 把区间格式化成可读文本（用于角标）：0:01.50 – 0:04.20（3.20s）。 */
export function formatRange(range: TimeRange): string {
  const fmt = (us: number): string => {
    const totalSec = us / 1_000_000;
    const m = Math.floor(totalSec / 60);
    const s = totalSec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  };
  return `${fmt(range.startUs)} – ${fmt(range.endUs)}（${(rangeDuration(range) / 1_000_000).toFixed(2)}s）`;
}
