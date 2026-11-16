/**
 * 时间线模式切换 —— 移植自 OpenFilm Timeline.tsx:4797 ModePicker。
 *
 * 参照只有两种模式：选择 / 分割。它在工具栏**最左侧**，前面是它、后面跟着一条 1px 竖分隔。
 *
 * 两个设计决定照抄：
 * ① 按钮**没有激活底色**——光标形状与刀线本身已经说明「现在是分割模式」，图标也随之切换；
 * ② tooltip 写的是「切过去之后是哪个模式」，并带该模式的快捷键（而不是写当前模式）。
 *
 * 我们原来没有模式概念：分割是一个一次性按钮（拆当前选中片段）。
 * 这里保持现有的一次性拆分行为不变，只补上参照的**形态与位置**——
 * 模式切换会让「点击即分割」这种全局行为上线，属交互语义变更，需单独确认。
 */
import * as React from 'react';
import { MousePointer2, SplitSquareHorizontal } from 'lucide-react';
import { Tooltip } from './Tooltip.js';

export type TimelineMode = 'select' | 'split';

export function ModePicker({ mode, onPick }: { mode: TimelineMode; onPick: (m: TimelineMode) => void }) {
  const next: TimelineMode = mode === 'split' ? 'select' : 'split';
  const label = next === 'split' ? '切换为分割模式' : '切换为选择模式';
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={() => onPick(next)}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={label}
        aria-pressed={mode === 'split'}
        className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px] outline-none transition hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        style={{ color: 'var(--text-muted)' }}
      >
        {mode === 'split' ? <SplitSquareHorizontal size={16} /> : <MousePointer2 size={16} />}
      </button>
    </Tooltip>
  );
}
