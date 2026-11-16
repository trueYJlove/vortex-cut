/**
 * 时间线工具栏按钮 —— 移植自 OpenFilm（Timeline.tsx:4744 ToolButton）。
 *
 * 三个行为细节是这套实现的价值所在，照抄而非重写：
 * ① `onMouseDown preventDefault`：鼠标点击**不留焦点**，否则紧接着按空格会去按这个按钮
 *    而不是播放（键盘 Tab 焦点不受影响）；
 * ② 用 `aria-disabled` 而非 `disabled`：原生 disabled 会吞掉鼠标事件、**连提示都没有**，
 *    而「为什么不能点」恰恰是 disabled 时最需要的提示；
 *    ⚠️ 但**必须同时真的阻止点击**：aria-disabled 只是声明，浏览器不会替你拦。
 *    另外 testing-library 的 toBeEnabled() 只看原生 disabled —— 只用 aria-disabled
 *    会让「等按钮可用再点」的测试提前通过，然后在仍不可用时点了空（实测踩中：
 *    editor-shell 的「保存中」用例因此红）。故这里同时设 data-disabled，
 *    并保留原生 disabled 之外的点击拦截（见 onClick 内的判断）。
 * ③ 按下态是强调色 + 强调色柔底（不是实心块），一排开关不会呛眼。
 */
import * as React from 'react';
import { Tooltip } from './Tooltip.js';

export const TOOL_BUTTON_CLASS =
  'flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px] outline-none transition focus-visible:ring-1 focus-visible:ring-[var(--accent)]';

export function ToolButton({
  onClick,
  disabled,
  label,
  hint,
  active = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  hint?: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const title = hint ? `${label} (${hint})` : label;
  return (
    <Tooltip side="bottom" label={label} {...(hint ? { shortcut: hint } : {})}>
      <button
        type="button"
        onClick={() => { if (!disabled) onClick(); }}
        onMouseDown={(e) => e.preventDefault()}
        /* 同时给原生 disabled 与 aria-disabled：
           原生 disabled 保证「不可用」对所有消费者（含 testing-library 的 toBeEnabled）
           是**真实**的，而不只是一句声明；aria-disabled 保留语义描述。
           参照只用 aria-disabled 是为了保住 tooltip，但代价是按钮实际仍可被点
           （它的 onClick 里自己判断 disabled）——在测试与辅助技术看来是「可用但没反应」。
           这里选择「两者都给」：语义与真实性一致，tooltip 由外层 wrapper 承接鼠标事件保留。 */
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={title}
        aria-pressed={active}
        className={`${TOOL_BUTTON_CLASS} ${disabled ? 'cursor-default' : ''} ${active || disabled ? '' : 'hover:bg-[var(--bg-hover)]'}`}
        style={active
          ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
          : { color: disabled ? 'var(--text-faint)' : 'var(--text-muted)' }}
      >
        {children}
      </button>
    </Tooltip>
  );
}
