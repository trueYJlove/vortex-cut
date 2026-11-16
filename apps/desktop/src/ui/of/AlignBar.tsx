/**
 * 对齐条 —— 移植自 OpenFilm FilmInspector.tsx:560 AlignBar。
 *
 * 形态：两组胶囊（横向三键 / 纵向三键），每个是 26px 高、--bg-field 底、1px 内边距里
 * 塞一个 h-6 flex-1 的按钮；图标 13px muted，hover 浮 --bg-panel 底。
 * 参照里它是「位置与大小」分组的**第一行**，我们此前完全缺这一行——
 * 这是属性面板第一屏就能看出来的结构差。
 *
 * 语义：六个边（左/水平居中/右/上/垂直居中/下）。没有可对齐对象时按钮 disabled（40% 透明），
 * 与参照一致——参照也是 `onAlign ? ... : undefined`。
 * 我们目前没有「多元素对齐」的数据通道，故按钮呈 disabled 态但**保留在版面上**：
 * 视觉一致是这一轮的目标，功能待后续接。
 */
import * as React from 'react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical } from 'lucide-react';
import { Tooltip } from './Tooltip.js';

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

const ICON = 13;

const ITEMS: { edge: AlignEdge; label: string; icon: React.ReactNode }[] = [
  { edge: 'left', label: '左对齐', icon: <AlignStartVertical size={ICON} /> },
  { edge: 'hcenter', label: '水平居中', icon: <AlignCenterVertical size={ICON} /> },
  { edge: 'right', label: '右对齐', icon: <AlignEndVertical size={ICON} /> },
  { edge: 'top', label: '顶对齐', icon: <AlignStartHorizontal size={ICON} /> },
  { edge: 'vcenter', label: '垂直居中', icon: <AlignCenterHorizontal size={ICON} /> },
  { edge: 'bottom', label: '底对齐', icon: <AlignEndHorizontal size={ICON} /> },
];

export function AlignBar({ onAlign }: { onAlign?: (edge: AlignEdge) => void }) {
  const btn = (item: (typeof ITEMS)[number]) => (
    <Tooltip key={item.edge} label={item.label}>
      <button
        type="button"
        aria-label={item.label}
        disabled={!onAlign}
        onClick={onAlign ? () => onAlign(item.edge) : undefined}
        className="flex h-6 flex-1 items-center justify-center rounded-[4px] text-[var(--text-muted)] transition hover:bg-[var(--bg-panel)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40"
      >
        {item.icon}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-1.5">
      {[ITEMS.slice(0, 3), ITEMS.slice(3)].map((group, i) => (
        <div key={i} className="flex h-[26px] flex-1 items-center rounded-[5px] bg-[var(--bg-field)] p-px">
          {group.map(btn)}
        </div>
      ))}
    </div>
  );
}
