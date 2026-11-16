/**
 * 播放条结构常量 —— 与 OpenFilm ViewerBar.tsx:51 的结构定义逐项对应。
 *
 * **为什么是常量而不是直接 import 参照的 ViewerBar 组件**：
 * 参照的 ViewerBar 只有「时间码 / 播放键 / 播放设置 / 全屏」四个东西；
 * 我们的播放条还承担音量、预览缩放、倍速三项它没有的功能（以及各自的弹层）。
 * 直接换成它的组件会**丢功能**——那不是复刻，是删减。
 * 所以这里抄的是它定义的**结构与度量**，控件按我们的功能集展开：
 * 三列网格（左时间码 / 中播放键 / 右工具组）、40px、minmax(0,1fr) 而不是 1fr
 * （1fr 不会缩到内容以下，两个完整时间码有 25 字符，窄面板会把播放键顶到时间码上）。
 */
export const VIEWER_BAR = {
  /** grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-2 */
  root: "pb-root",
  height: 40,
  /** 列宽：minmax(0,1fr) auto minmax(0,1fr) —— 两侧可收缩、中间播放键固定居中 */
  columns: "minmax(0,1fr) auto minmax(0,1fr)",
  gap: 8,
  paddingInline: 8,
  /** 时间码 12px 正文色；时长 11px 更淡（ViewerBar.tsx:54-58） */
  timeFontSize: 12,
  durationFontSize: 11,
  /** 播放键与工具键：22×22 盒 / 图标 14（dock-pane-bar.ts PANE_BTN / PANE_ICON） */
  buttonBox: 22,
  iconSize: 14,
  buttonRadius: 6,
} as const;
