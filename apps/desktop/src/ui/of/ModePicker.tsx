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
import { ArrowLeftRight, ChevronDown, Film, MousePointer2, MoveHorizontal, SplitSquareHorizontal } from 'lucide-react';
import { ToolButton } from './ToolButton.js';

export type TimelineMode = 'select' | 'split' | 'roll' | 'slip' | 'slide';

/** OpenFilm's default timeline tool keys: A/V select, B split. */
export function timelineModeFromKeyEvent(event: KeyboardEvent): TimelineMode | null {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null; isContentEditable?: boolean }) | null;
  if (target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"]') || target?.isContentEditable) return null;
  const key = event.key.toLowerCase();
  if (key === 'a' || key === 'v') return 'select';
  if (key === 'b') return 'split';
  return null;
}

export function ModePicker({ mode, onPick }: { mode: TimelineMode; onPick: (m: TimelineMode) => void }) {
  const tools: Array<{ id: TimelineMode; label: string; icon: React.ReactNode }> = [
    { id: 'select', label: '选择', icon: <MousePointer2 size={16} /> },
    { id: 'split', label: '分割', icon: <SplitSquareHorizontal size={16} /> },
    { id: 'roll', label: '滚动修剪', icon: <ArrowLeftRight size={16} /> },
    { id: 'slip', label: '滑移素材', icon: <Film size={16} /> },
    { id: 'slide', label: '滑动片段', icon: <MoveHorizontal size={16} /> },
  ];
  const selected = tools.find(tool => tool.id === mode) ?? tools[0]!;
  const nextMode: TimelineMode = mode === 'select' ? 'split' : 'select';
  const nextTool = tools.find(tool => tool.id === nextMode)!;
  return (
    <div className="flex shrink-0 items-center" data-timeline-mode-picker>
      <ToolButton onClick={() => onPick(nextMode)} label={nextTool.label} hint={nextMode === 'select' ? 'A' : 'B'}>
        {selected.icon}
      </ToolButton>
      <label className="timeline-mode-picker-select relative flex h-[28px] w-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-[var(--editor-control)] transition hover:bg-[var(--bg-hover)] focus-within:ring-1 focus-within:ring-[var(--accent)]">
        <ChevronDown size={12} aria-hidden="true" />
        <select
          value={mode}
          aria-label={`时间线工具，当前${selected.label}`}
          onChange={event => onPick(event.target.value as TimelineMode)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {tools.map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
        </select>
      </label>
    </div>
  );
}
