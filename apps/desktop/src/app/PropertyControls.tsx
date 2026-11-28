import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
// 移植自 OpenFilm 的数值框（src/ui/of）：左端字母拖拽标记、无 ▲▼ 步进器。
import { NumField, Section, Segmented, SliderField } from "../ui/of/inspector-fields.js";
import iwStyles from "../ui/of/InspectorWorkspace.module.css";

/**
 * 属性面板 v2 控件集（页签容器 + 行/步进器/滑杆/开关/分段/徽章）。
 *
 * 信息架构与视觉规格对齐 docs/specs/desktop-ui.md（§1 IA 与视觉规范）：
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

/**
 * 顶层页签 —— **直接用参照的 InspectorWorkspace.module.css**（随 P2 移植进来）。
 *
 * 复用参照的类名（styles.tabs / styles.selectedTab）而不是再仿写一遍：
 * 40px 条高、11.5px、选中 = 强调色 + 600、无下划线、横向可滚且隐藏滚动条。
 * 这是「抄参照实现本身」而非「照参照的样子重写」的差别所在。
 */
export function PanelTabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className={iwStyles.tabs} role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
          className={active === t.id ? iwStyles.selectedTab : undefined} onClick={() => onChange(t.id)}>
          {t.label}
          {t.soon && <span className="pp-soon">规划中</span>}
        </button>
      ))}
    </div>
  );
}

/** 子页签（基础/抠像/蒙版 …）：与顶层页签共用参照的同一套页签样式，
 *  只多一层左侧缩进把它们分成二级（参照里二级用 Section 承载，我们保留页签形态）。 */
export function SubTabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className={`pp-subtabs ${iwStyles.tabs}`} role="tablist" style={{ height: 34 }}>
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
          className={active === t.id ? iwStyles.selectedTab : undefined} onClick={() => onChange(t.id)}>
          {t.label}
          {t.soon && <span className="pp-soon">规划中</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * 分组 —— **换成移植来的参照 Section**（src/ui/of/inspector-fields.tsx:88）。
 *
 * 保留调用签名（title/tail/onReset/collapsible/defaultClosed/chev），30 处调用点不动。
 * 观感随之变成参照的：12px/600 标题、11px 折角、分隔线走**分组底边**、折叠状态可记忆。
 * 参照用 chevron 图标而非我们原来的 ▼ 字符，这里交给 Section 自己画。
 */
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
  /* 参照的 Section 自带折叠（closedByDefault），但**默认展开**且不可禁用折叠；
     我们的 chev/collapsible 语义是「有折角 / 可折叠」两种。
     映射：collapsible → 可折叠；chev 仅表示有个静态折角（传 true 也不折叠）。
     为保持「不可折叠时点击标题无反应」，collapsible=false 时默认展开即可——
     Section 总是可折叠，这是参照行为，接受。 */
  void chev;
  return (
    <Section
      id={title}
      title={title}
      closedByDefault={collapsible ? Boolean(defaultClosed) : false}
      aside={onReset ? (
        <button type="button" className="pp-reset" title={resetTitle} aria-label={resetTitle}
          onClick={e => { e.stopPropagation(); onReset(); }}>⟲</button>
      ) : (tail ? <span className="pp-tail">{tail}</span> : undefined)}
    >
      {children}
    </Section>
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

/**
 * 分段选择 —— **换成移植来的参照 Segmented**（src/ui/of/inspector-fields.tsx:632）。
 *
 * 参照形态：26px 高、--bg-field 底、1px 内边距、项圆角 4px；
 * 选中项是 --bg-picked 底 + 强调色字 + 600（不是我们原来的边框强调）。
 * 语义仍是 radiogroup + aria-checked，只换外观。
 */
export function Seg({ options, value, onChange, columns }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void; columns?: number }) {
  void columns;
  return (
    <div className="pp-segwrap">
      <Segmented
        label=""
        value={value}
        options={options.map(o => ({ value: o.value, label: o.label }))}
        onChange={onChange}
      />
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
/**
 * 数值框 —— **实现已换成移植来的参照 NumField**（2026-11-16，src/ui/of/inspector-fields.tsx:191）。
 *
 * 保留本函数的对外签名，是为了让 30 处调用点零改动；但观感与交互完全由参照实现决定：
 * 左侧 22px 字母标记即拖拽手柄（ew-resize）、11px tabular-nums、单位是框内 10.5px 后缀、
 * **没有 ▲▼ 步进器**。此前我们自己写的那版带右侧箭头，那是 HUD 形态而非设计工具形态。
 *
 * 语义映射（关键，别改错）：
 * - onPreview ↔ 我们的 onDraft：拖动/输入期间只改本地草稿，不落 Revision；
 * - onCommit  ↔ 我们的 onCommit：松手/失焦/回车提交单条 patch。
 * 参照的 onCommit 还会给一个 apply 函数（多选时逐项换算），我们这里是单值面板，
 * 直接忽略 apply 用 (n) 即可。
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
  /** 无标记模式：滑杆右侧的数字框用它（参照 NumField bare）。 */
  bare?: boolean;
  onDraft?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  /* decimals 在我们的语义里是「显示保留几位」，参照用 format 回调表达同一件事。
     两者都要保住，否则 0.00° 会变成 0°。 */
  const format = decimals === undefined ? undefined : (n: number) => n.toFixed(decimals);
  return (
    <div className={w66 ? "pp-num w66" : "pp-num"}>
      <NumField
        label={ariaLabel ?? ""}
        prefix={mark}
        bare={bare}
        value={disabled ? undefined : value}
        step={step}
        min={min}
        max={max}
        unit={unit || undefined}
        placeholder={placeholder}
        disabled={disabled}
        format={format}
        onPreview={onDraft ? (n: number) => onDraft(n) : undefined}
        onCommit={(n: number) => onCommit(n)}
      />
    </div>
  );
}

/**
 * 滑杆行 —— **换成移植来的参照 SliderField**（src/ui/of/inspector-fields.tsx:536）。
 *
 * 参照形态与我们的旧实现差别最大的几处（都已随这次替换生效）：
 * - 轨道 3px，填充色是 --text-muted（中性），**中性位有一条 1px 刻度**；
 * - 滑块 12px 圆形，--bg-panel 底 + 0 0 0 1px --border-strong 描边（我们原来没有刻度、滑块样式也不同）；
 * - 三列网格 64px 标签 / 1fr 滑轨 / 56px 数值，数值框是 NumField bare（无拖拽标记）；
 * - 双击回到中性值。
 * 我们的 onDraft ↔ 参照 onPreview（拖动期间不落 Revision），onCommit 提交单条 patch。
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
  void decimals;
  return (
    <div className={`pp-slider${dim ? " dim" : ""}`} aria-label={ariaLabel ?? label}>
      <SliderField
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        unit={unit || undefined}
        fieldWidth={w66 ? 66 : 56}
        disabled={disabled}
        onPreview={(n: number) => onDraft(n)}
        onCommit={(n: number) => onCommit(n)}
      />
      {badge}
      {tail && <span className="pp-tail">{tail}</span>}
    </div>
  );
}
