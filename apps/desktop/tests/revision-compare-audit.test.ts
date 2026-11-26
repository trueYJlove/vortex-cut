import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 版本比较（revision-compare）— C 族审计（2026-11-09）。
 *
 * 与「原始转录」同型：结构本身健康，只发现两处真缺陷。
 *
 * 1. 宽度死代码：.modal.revision-compare 有两条 width
 *      line 1051  min(720px, 100%)
 *      line 2426  min(640px, calc(100vw - 48px))  ← 更高特异性且更晚，恒胜
 *    720 那条从未生效，与 dialog-graphite-style.test.ts 的 640 档登记矛盾。
 *
 * 2. diff 减号色值硬编码 #f2797d，而**同组的加号用的是 var(--dlg-primary)**——
 *    同一组语义两个来源。换主题时加号会变、减号不变，是视觉统一里最难
 *    发现的那类裂缝（本仓已有语义检索 8 处硬编码的先例）。
 *
 * 注意：.diff-groups 是**共享组件** TimelineDiffView 的样式，被 4 个面板使用
 * （RevisionCompare / AgentSession / EditingGrammar / EditingTools）。
 * 令牌化会同时影响这 4 处 —— 这是有意的：它们本来就该同一个颜色语义。
 */

const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; body: string; order: number; inMedia: boolean };
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
      out.push({ selectors: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean), body, order, inMedia: stack.length > 0 });
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = parseRules(css);
const declared = (body: string, prop: string): string | null => {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(body);
  return m ? m[1].trim() : null;
};
function effective(selector: string, prop: string): string | null {
  const owners = RULES.filter(r => !r.inMedia && r.selectors.includes(selector));
  for (const r of owners.reverse()) {
    const v = declared(r.body, prop);
    if (v !== null) return v;
  }
  return null;
}

describe("版本比较：宽度只来自 640 档", () => {
  it("revision-compare 自身不含 720px 声明", () => {
    const own = RULES
      .filter(r => !r.inMedia && r.selectors.includes(".modal.revision-compare"))
      .map(r => declared(r.body, "width"))
      .filter((w): w is string => w !== null);
    expect(own.some(w => w.includes("720px")), `仍残留 720 宽度：${JSON.stringify(own)}`).toBe(false);
  });

  it("宽度来自 640 档统一规则（与标准档其它弹窗同源）", () => {
    const rule = RULES
      .filter(r => !r.inMedia)
      .find(r => r.selectors.includes(".modal.revision-compare") && (declared(r.body, "width") ?? "").includes("640px"));
    expect(rule, "revision-compare 未落在 640 档").toBeTruthy();
    // 同一条规则里应当还有其它标准档弹窗，证明是统一档而非单独特例
    expect(rule!.selectors.length).toBeGreaterThan(3);
  });
});

describe("版本比较：diff 增减色同一来源", () => {
  it("减号用 --dlg-danger，不再是硬编码 #f2797d", () => {
    expect(effective(".modal .diff-groups .diff-removed", "color")).toBe("var(--dlg-danger)");
  });

  it("加号仍用 --dlg-primary（与减号成对，都走令牌）", () => {
    expect(effective(".modal .diff-groups .diff-added", "color")).toBe("var(--dlg-primary)");
  });

  it("diff 语义色段落不含 #hex（移动/更新/裁剪也应走令牌）", () => {
    const start = css.indexOf(".modal .diff-groups .diff-added");
    const end = css.indexOf("}", css.indexOf(".modal .diff-groups .diff-trimmed")) + 1;
    const seg = css.slice(start, end);
    const hard = [...seg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
    expect(hard, `diff 语义色仍有硬编码：${JSON.stringify(hard)}`).toEqual([]);
  });
});

describe("版本比较：两列选择器布局不被破坏", () => {
  it("基线/目标为两列等宽", () => {
    expect(effective(".revision-selectors", "grid-template-columns")).toBe("minmax(0, 1fr) minmax(0, 1fr)");
  });

  it("窄屏堆叠为单列", () => {
    const media = RULES.filter(r => r.inMedia && r.selectors.includes(".revision-selectors"));
    expect(media.length, "缺窄屏单列规则").toBeGreaterThan(0);
    expect(declared(media[0].body, "grid-template-columns")).toBe("1fr");
  });
});
