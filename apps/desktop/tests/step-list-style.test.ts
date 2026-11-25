import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * B 族「步骤流」· 步骤记录列表（2026-11-09）。
 *
 * 结构稿：docs/design/ui-mockups/dialog-system-v2/prototype-step-family.html
 *
 * ## 改造前的状态：零规则
 *
 * `.agent-session-steps` 在样式表里**一条规则都没有**。三个弹窗共用它
 * （AgentSession / EditingGrammar / Worklist），实际用的是浏览器默认 <ol>。
 * Chromium 实测：
 *
 *   padding-left?      40px        （与弹窗内容左缘错位 40px）
 *   list-style?        decimal     （与内容里的「第 N 步」**重复编号**）
 *   li 内边距?         0           （行挤在一起）
 *   行高?              17 / 28     （带按钮的行更高，不统一）
 *   分隔线?            无           （分不清步骤边界）
 *
 * 这个问题此前从未被发现，因为没有任何测试检查步骤列表的样式——
 * 而它的可读性直接决定「多步会话」这个功能能不能被看懂。
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

const LIST = ".modal .agent-session-steps";
const ROW = ".modal .agent-session-steps > li";

describe("步骤列表：去掉浏览器默认 ol 的三处遗留", () => {
  it("去掉默认序号（内容里已有「第 N 步」，再显示 1./2./3. 是重复编号）", () => {
    expect(effective(LIST, "list-style")).toBe("none");
  });

  it("去掉默认 40px 左缩进（会与弹窗内容左缘错位）", () => {
    expect(effective(LIST, "padding")).toBe("0");
  });

  it("列表本身是 grid 且零间距（行间距交给分隔线表达）", () => {
    expect(effective(LIST, "display")).toBe("grid");
    expect(effective(LIST, "gap")).toBe("0");
  });
});

describe("步骤列表：行结构与分隔", () => {
  it("行用内边距撑开，不写死高度（带按钮的行会自然更高）", () => {
    expect(effective(ROW, "padding")).toBe("11px 13px");
    expect(effective(ROW, "height"), "行不该写死 height").toBeNull();
  });

  it("行间分隔线只在非首行（首行靠容器上边界）", () => {
    expect(effective(LIST + " > li + li", "border-top")).toContain("1px");
  });

  it("序号 strong 不参与收缩，且等宽数字对齐", () => {
    expect(effective(ROW + " > strong", "flex")).toBe("none");
    expect(effective(ROW + " > strong", "font-variant-numeric")).toBe("tabular-nums");
  });

  it("摘要段字号低于步骤名（避免整行同级抢读）", () => {
    expect(effective(ROW + " > span", "font-size")).toBe("var(--dlg-fs-caption)");
  });

  it("操作按钮靠右、不与文字混排", () => {
    expect(effective(ROW + " .mini-btn", "margin-left")).toBe("auto");
    expect(effective(ROW + " .mini-btn", "flex")).toBe("none");
  });
});

describe("步骤列表：容器与进度条", () => {
  it("列表容器有卡片底与圆角（不再是裸 ol）", () => {
    expect(effective(LIST, "background")).toBe("var(--dlg-raise)");
    expect(effective(LIST, "border-radius")).toBe("var(--r-box)");
  });

  it("会话进度条是 4px 细条（不是浏览器默认的粗条）", () => {
    const sel = '.modal.agent-session progress[aria-label="会话步数进度"]';
    expect(effective(sel, "height")).toBe("4px");
    expect(effective(sel, "appearance")).toBe("none");
  });
});
