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
 */
import * as React from 'react';
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip.js';

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type AlignDistribution = 'horizontal' | 'vertical';

const ICON = 13;

const ITEMS: { edge: AlignEdge; label: string; icon: LucideIcon }[] = [
  { edge: 'left', label: '左对齐', icon: AlignStartVertical },
  { edge: 'hcenter', label: '水平居中', icon: AlignCenterVertical },
  { edge: 'right', label: '右对齐', icon: AlignEndVertical },
  { edge: 'top', label: '顶对齐', icon: AlignStartHorizontal },
  { edge: 'vcenter', label: '垂直居中', icon: AlignCenterHorizontal },
  { edge: 'bottom', label: '底对齐', icon: AlignEndHorizontal },
];

const DISTRIBUTION_ITEMS: { axis: AlignDistribution; label: string; icon: LucideIcon }[] = [
  { axis: 'horizontal', label: '水平等距分布', icon: AlignHorizontalDistributeCenter },
  { axis: 'vertical', label: '垂直等距分布', icon: AlignVerticalDistributeCenter },
];

export function AlignBar({ onAlign, onDistribute, distributionDisabled = false }: { onAlign?: (edge: AlignEdge) => void; onDistribute?: (axis: AlignDistribution) => void; distributionDisabled?: boolean }) {
  const btn = (item: (typeof ITEMS)[number]) => (
    <Tooltip key={item.edge} label={item.label}>
      <button
        type="button"
        aria-label={item.label}
        disabled={!onAlign}
        onClick={onAlign ? () => onAlign(item.edge) : undefined}
        className="flex h-6 flex-1 items-center justify-center rounded-[4px] text-[var(--text-muted)] transition hover:bg-[var(--bg-panel)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40"
      >
        <item.icon size={ICON} aria-hidden="true" />
      </button>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="画面对齐">
      {[ITEMS.slice(0, 3), ITEMS.slice(3)].map((group, i) => (
        <div key={i} className="flex h-[26px] flex-1 items-center rounded-[5px] bg-[var(--bg-field)] p-px">
          {group.map(btn)}
        </div>
      ))}
      {onDistribute && (
        <div className="flex h-[26px] flex-1 items-center rounded-[5px] bg-[var(--bg-field)] p-px">
          {DISTRIBUTION_ITEMS.map(item => (
            <Tooltip key={item.axis} label={item.label}>
              <button
                type="button"
                aria-label={item.label}
                disabled={distributionDisabled}
                onClick={() => onDistribute(item.axis)}
                className="flex h-6 flex-1 items-center justify-center rounded-[4px] text-[var(--text-muted)] transition hover:bg-[var(--bg-panel)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40"
              >
                <item.icon size={ICON} aria-hidden="true" />
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
