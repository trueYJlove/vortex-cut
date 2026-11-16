import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

/**
 * 属性面板 v2 控件集（页签容器 + 行/步进器/滑杆/开关/分段/徽章）。
 *
 * 信息架构与视觉规格对齐 docs/ui-mockups/property-panel/DESIGN.md（§1 IA、§9 视觉规范）：
 * - 顶层页签 PanelTabs（44px、激活主色 + 底部指示条）；
 * - 子页签 SubTabs（胶囊式，可带「规划中」小字）；
 * - 行 PRow（高 32、标签列 56）+ 分组 PGroup（悬停重置、可折叠占位组）；
 * - 数字步进器 NumberField（右对齐数值 + 大命中箭头 + 左右拖动搓值 + 键盘 ↑↓）；
 * - 滑杆 RangeRow（3px 轨道、填充色随值、与步进器双向同步）。
 *
 * 交互语义沿用现有面板：拖动/输入 = 本地 draft（onDraft，不落 Revision），
 * 松手/失焦/箭头/回车 = 提交单条 patch（onCommit，可撤销）。
 */

export type TabItem = { id: string; label: string; soon?: boolean };

/** 顶层页签（画面/音频/变速/动画 …）；soon 项在页签内显示「规划中」小字（对齐音频素材原型）。 */
export function PanelTabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="pp-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
          className={`pp-tab${active === t.id ? " pp-active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.soon && <span className="soon">规划中</span>}
        </button>
      ))}
    </div>
  );
}

/** 子页签（基础/抠像/蒙版 …），soon 项显示「规划中」小字但保持可点（占位内容）。 */
export function SubTabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="pp-subtabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
          className={`pp-sub${active === t.id ? " pp-active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.soon && <span className="soon">规划中</span>}
        </button>
      ))}
    </div>
  );
}

/** 分组标题：13px/600 + 悬停重置；chev 显示静态 ▼（如「位置大小」）；collapsible 用于占位组（默认折叠降噪）。 */
export function PGroup({ title, tail, onReset, resetTitle = "重置", collapsible, defaultClosed, chev, children }: {
  title: string;
  tail?: ReactNode;
  onReset?: () => void;
  resetTitle?: string;
  collapsible?: boolean;
  defaultClosed?: boolean;
  chev?: boolean;
  children: ReactNode;
}) {
  const [closed, setClosed] = useState(Boolean(defaultClosed));
  const showChev = collapsible || chev;
  return (
    <>
      <div className={`pp-gh${collapsible ? " coll" : ""}${closed ? " closed" : ""}`}
        onClick={collapsible ? () => setClosed(c => !c) : undefined}>
        {showChev && <span className="chev" aria-hidden="true">▼</span>}
        <span>{title}</span>
        {tail}
        {onReset && (
          <button type="button" className="rst" title={resetTitle}
            onClick={e => { e.stopPropagation(); onReset(); }}>⟲</button>
        )}
      </div>
      {(!collapsible || !closed) && children}
    </>
  );
}

/** 分组分隔线。 */
export function PSep() {
  return <div className="pp-sep" aria-hidden="true" />;
}

/** 行：标签列（56px）+ 控件 + 尾注；dim 为规划占位灰显。 */
export function PRow({ label, tail, dim, children }: { label?: string; tail?: ReactNode; dim?: boolean; children: ReactNode }) {
  return (
    <div className={`pp-row${dim ? " dim" : ""}`}>
      {label !== undefined && <label>{label}</label>}
      {children}
      {tail && <span className="tail">{tail}</span>}
    </div>
  );
}

/** 「规划中」徽章。 */
export function SoonBadge({ children = "规划中" }: { children?: ReactNode }) {
  return <span className="pp-badge">{children}</span>;
}

/** 面板注释（实现提示 / 预览口径说明）。 */
export function PNote({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return <p className={`pp-note${warn ? " warn" : ""}`}>{children}</p>;
}

/** 开关（32×18，激活主色）。 */
export function Switch({ on, onToggle, title, disabled }: { on: boolean; onToggle: () => void; title?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title} disabled={disabled}
      className={`pp-sw${on ? " on" : ""}`} onClick={onToggle} />
  );
}

/** 分段选择（布局/蒙版形状/倍速预设 …）；columns 指定每行列数（如倍速 4 列网格，对齐原型）。 */
export function Seg({ options, value, onChange, columns }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void; columns?: number }) {
  return (
    <div className="pp-segset" style={columns ? { display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}>
      {options.map(o => (
        <button key={o.value} type="button" className={`pp-seg${value === o.value ? " pp-active" : ""}`}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * 数值框（2026-11-16 按 OpenFilm NumField 复刻，inspector-fields.tsx:31-33,320-332,386-388）：
 * **左边 22px 是一个字母/符号标记（W/H/X/Y/°），它本身就是拖拽手柄**——
 * 横向拖动改值（ew-resize），不是点击箭头。参照里**全表面没有一个 ▲▼ 步进器**，
 * 原来我们每个框右侧一对箭头，那是 HUD 而非设计工具的形态，也是这一栏读起来
 * 最不像参照的地方。
 *
 * 结构 = [22px 标记][输入框][单位后缀 10.5px 淡色]
 * 单位是框内后缀而非拼进值里：参照规则是「值里不含单位，单位由控件渲染」。
 * 键盘 ↑↓ / 直接输入照旧；拖动与输入走 onDraft，松手/失焦/回车走 onCommit。
 *
 * mark 省略时退回标签首字（参照同款规则：prefix ?? 标签首字 ?? 整词）。
 */
export function NumberField({ value, min, max, step = 1, unit = "", decimals, w66, placeholder, disabled, ariaLabel, mark, bare, onDraft, onCommit }: {
  value?: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
  w66?: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 左端 22px 拖拽标记上的字（W / H / X / Y / ° …）。 */
  mark?: string;
  /** 无标记模式：滑杆右侧的数字框用它（参照 NumField bare，inspector-fields.tsx:612-625）——
   *  值已经由滑杆直接拖，再给一个拖拽标记会同时出现两个手柄，且标记字是中文标签首字
   *  （「缩」「不」）落在 10.5px 上非常难看。 */
  bare?: boolean;
  onDraft?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const dec = decimals ?? (step < 1 ? 2 : 0);
  /* 值里不带单位：单位由控件作为 10.5px 后缀单独渲染（参照同款）。 */
  const fmt = (v: number) => `${parseFloat(v.toFixed(4)).toFixed(dec)}`;
  const clampSnap = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    return parseFloat((Math.round(c / step) * step).toFixed(4));
  };
  const [editing, setEditing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = editing ?? (value === undefined || Number.isNaN(value) ? "" : fmt(value));
  const commitText = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) onCommit(clampSnap(parsed));
    setEditing(null);
  };
  const bump = (dir: 1 | -1) => {
    const parsed = editing !== null ? parseFloat(editing) : value;
    const base = Number.isFinite(parsed) ? (parsed as number) : min;
    const v = clampSnap(base + dir * step);
    setEditing(null);
    onCommit(v);
  };
  const scrub = useRef<{ sx: number; sv: number; active: boolean; last: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || (e.target as HTMLElement).closest("button")) return;
    const v0 = Number.isFinite(value ?? NaN) ? (value as number) : min;
    scrub.current = { sx: e.clientX, sv: v0, active: false, last: v0 };
    const move = (ev: PointerEvent) => {
      const s = scrub.current;
      if (!s) return;
      if (!s.active && Math.abs(ev.clientX - s.sx) < 4) return;
      if (!s.active) {
        s.active = true;
        document.body.classList.add("pp-scrubbing");
        inputRef.current?.blur();
      }
      const v = clampSnap(s.sv + Math.round((ev.clientX - s.sx) / 3) * step);
      s.last = v;
      setEditing(fmt(v));
      onDraft?.(v);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("pp-scrubbing");
      const s = scrub.current;
      scrub.current = null;
      if (s?.active) {
        setEditing(null);
        onCommit(s.last);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /* 值里不含单位：数字与单位分开渲染（参照 inspector-fields.tsx:386-388）。
     自己已经在值里打了单位符号时不再补后缀，避免 "0.00°°"。 */
  const hasOwnUnit = /[a-z%°×:]$/i.test(shown);
  return (
    <span className={`pp-field${w66 ? " w66" : ""}${disabled ? " is-disabled" : ""}`}>
      {/* 22px 标记 = 拖拽手柄。cursor:ew-resize 就是「这里可以横向搓」的提示，
         参照没有别的暗示物。键盘用户走输入框（↑↓）与 aria-label，不依赖指针。 */}
      {bare
        ? <span className="mark-spacer" aria-hidden="true" />
        : <span className="mark" onPointerDown={onPointerDown} aria-hidden="true">{mark ?? ""}</span>}
      <input ref={inputRef} value={shown} placeholder={placeholder} disabled={disabled} aria-label={ariaLabel}
        onChange={e => {
          setEditing(e.target.value);
          const p = parseFloat(e.target.value);
          if (Number.isFinite(p)) onDraft?.(p);
        }}
        onBlur={() => { if (editing !== null) commitText(editing); }}
        onKeyDown={e => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            bump(e.key === "ArrowUp" ? 1 : -1);
          } else if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }} />
      {unit && !hasOwnUnit && <span className="unit" aria-hidden="true">{unit}</span>}
    </span>
  );
}

/**
 * 滑杆行：3px 轨道（填充色随值）+ 右侧步进器，draft/commit 与值域完全一致，
 * 两者任一改动都反映到另一个（受控值来自父级）。
 */
export function RangeRow({ label, value, min, max, step = 1, unit = "", decimals, w66, onDraft, onCommit, disabled, dim, badge, tail, ariaLabel }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
  w66?: boolean;
  onDraft: (v: number) => void;
  onCommit: (v: number) => void;
  disabled?: boolean;
  dim?: boolean;
  badge?: ReactNode;
  tail?: string;
  ariaLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className={`pp-row${dim ? " dim" : ""}`}>
      <label>{label}</label>
      <input type="range" className="pp-range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-label={ariaLabel ?? label}
        style={{ background: `linear-gradient(90deg, var(--pp-accent-2, #12b998) ${pct}%, #2b353d ${pct}%)` }}
        onChange={e => onDraft(Number(e.target.value))}
        onPointerUp={e => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => onCommit(Number((e.target as HTMLInputElement).value))} />
      <NumberField value={value} min={min} max={max} step={step} unit={unit} decimals={decimals} w66={w66} disabled={disabled}
        bare ariaLabel={ariaLabel ?? label} onDraft={onDraft} onCommit={onCommit} />
      {badge}
      {tail && <span className="tail">{tail}</span>}
    </div>
  );
}
