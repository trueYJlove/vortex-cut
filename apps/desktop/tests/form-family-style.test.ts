import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * A 族「纯表单」· Settings / Shortcuts（2026-11-09）。
 *
 * 契约复用 Provider 稿的 fieldset 分组形态。
 *
 * ## 改造前实测
 *
 * 三个弹窗的样式分布极不均匀：
 *   · .settings-dialog     —— 只有 1 条规则（仅宽度档位）；
 *   · .settings-radio      —— **零规则**（单选行用浏览器默认）；
 *   · .settings-effective  —— **零规则**（「当前生效」行用浏览器默认）；
 *   · .shortcuts-dialog    —— 3 条（2 条按钮例外 + 1 条宽度）；
 *   · .shortcut-row        —— 住在旧的 .vc-* 令牌体系里（与 Graphite 不是一套）。
 *
 * ## Cover 的审计结论
 *
 * .cover-modal 有自己完整的 .cov-* 样式（12 条规则），实测健康：
 * 预览 390×219（16:9 正确）、动作按钮高 34 且并排、强调色底正常。
 * **未做改动**，如实记录「看过且无需改」。
 */

const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { sels: string[]; body: string; order: number; inMedia: boolean };
function parseRules(source: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buffer = "";
  let order = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      const prelude = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      let depth = 1, j = i + 1, body = "";
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") { depth -= 1; if (depth === 0) break; }
        body += source[j]; j += 1;
      }
      order += 1;
      out.push({ sels: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean), body, order, inMedia: stack.length > 0 });
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = parseRules(css);

function spec(sel: string): [number, number, number] {
  let e = sel, prev = "";
  while (prev !== e) { prev = e; e = e.replace(/:not\(([^)]*)\)/g, " $1 "); }
  return [
    (e.match(/#[\w-]+/g) ?? []).length,
    (e.match(/\.[\w-]+/g) ?? []).length + (e.match(/\[[^\]]+\]/g) ?? []).length + (e.match(/:(?!not\()[\w-]+/g) ?? []).length,
    (e.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
}
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function effective(selector: string, prop: string): string | null {
  let best: { value: string; spec: number[]; order: number } | null = null;
  for (const rule of RULES) {
    if (rule.inMedia) continue;
    for (const sel of rule.sels) {
      if (sel !== selector) continue;
      const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(rule.body);
      if (!m) continue;
      const s = spec(sel);
      if (!best || cmp(s, best.spec) > 0 || (cmp(s, best.spec) === 0 && rule.order >= best.order)) {
        best = { value: m[1].trim(), spec: s, order: rule.order };
      }
    }
  }
  return best ? best.value : null;
}

describe("A 族 · 设置的单选行不再用浏览器默认", () => {
  it("单选行是 flex + 8px 间距 + 最小高 30", () => {
    expect(effective(".modal .settings-radio", "display")).toBe("flex");
    expect(effective(".modal .settings-radio", "gap")).toBe("8px");
    expect(effective(".modal .settings-radio", "min-height")).toBe("30px");
  });

  it("单选框用主色（accent-color），与全站一致", () => {
    expect(effective('.modal .settings-radio input[type="radio"]', "accent-color")).toBe("var(--dlg-primary)");
  });
});

describe("A 族 · 「当前生效」是状态行而非段落", () => {
  it("有底色、边框与圆角（与内容分层）", () => {
    expect(effective(".modal .settings-effective", "background")).toBe("var(--dlg-raise)");
    expect(effective(".modal .settings-effective", "border")).toContain("1px");
    expect(effective(".modal .settings-effective", "border-radius")).toBe("var(--r-box)");
  });
});

describe("A 族 · 快捷键行迁到 Graphite 令牌", () => {
  it("行是卡片底 + 圆角 + 6px 列表间距（不是旧 .vc-* 描边行）", () => {
    expect(effective(".modal .shortcuts-list", "gap")).toBe("6px");
    expect(effective(".modal .shortcut-row", "background")).toBe("var(--dlg-raise)");
    expect(effective(".modal .shortcut-row", "border-radius")).toBe("var(--r-ctl)");
  });

  it("标签可伸缩，kbd 与按钮不伸缩（否则长标签会把键位挤走）", () => {
    expect(effective(".modal .shortcut-row .shortcut-label", "flex")).toContain("1");
    expect(effective(".modal .shortcut-row .shortcut-label", "min-width")).toBe("0");
    expect(effective(".modal .shortcut-row kbd", "flex")).toBe("none");
    expect(effective(".modal .shortcut-row .compact-command", "flex")).toBe("none");
  });

  it("kbd 有最小宽度，按键长短不一时键位列仍对齐", () => {
    expect(effective(".modal .shortcut-row kbd", "min-width")).toBe("72px");
  });

  it("录制态用主色描边 + 强调底色（不是只有动画）", () => {
    const sel = ".modal .shortcut-row kbd.shortcut-recording";
    expect(effective(sel, "border-color")).toBe("var(--dlg-primary)");
    expect(effective(sel, "background")).toBe("var(--dlg-accent-dim)");
  });
});
