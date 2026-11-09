import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C 族「列表型」· 形态 2（机位同步表格）回归（2026-11-09）。
 *
 * 结构稿：docs/ui-mockups/dialog-system-v2/prototype-list-family.html
 *
 * 改造前实测到的四个问题（Chromium 量出，不是读代码猜的）：
 *  1. 表头 13px —— 与正文同号，表头与数据分不出层级；
 *  2. 单元格内边距 4px 6px —— 内容贴边；
 *  3. 偏移/置信度是数字列却全部左对齐 —— 位数不同无法纵向比较，
 *     而这表存在的意义就是「一眼看出各机位差多少」；
 *  4. 分隔线用 var(--ctl-bg)（控件填充色）当线色 —— 令牌层级用错。
 *
 * 另有两个只有渲染后才暴露的问题，也一并锁住：
 *  5. table-layout:auto 把剩余宽度摊给状态列（实测撑到 144px，
 *     内部只有 62px 徽章）⇒ 机位与数字列之间裂开空白；
 *  6. 92px 状态列放不下「徽章 + 原因」，把原因挤成孤立的换行。
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
const raw = readFileSync(cssPath, "utf8");
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
const specOf = (sel: string): number[] => {
  let e = sel, prev = "";
  while (prev !== e) { prev = e; e = e.replace(/:not\(([^)]*)\)/g, " $1 "); }
  return [
    (e.match(/#[\w-]+/g) ?? []).length,
    (e.match(/\.[\w-]+/g) ?? []).length + (e.match(/\[[^\]]+\]/g) ?? []).length + (e.match(/:(?!not\()[\w-]+/g) ?? []).length,
    (e.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
};
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const declared = (body: string, prop: string): string | null => {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(body);
  return m ? m[1].trim() : null;
};
function effective(selector: string, prop: string): string | null {
  let best: { value: string; spec: number[]; order: number } | null = null;
  for (const rule of RULES) {
    if (rule.inMedia) continue;
    for (const sel of rule.selectors) {
      if (sel !== selector) continue;
      const v = declared(rule.body, prop);
      if (v === null) continue;
      const spec = specOf(sel);
      if (!best || cmp(spec, best.spec) > 0 || (cmp(spec, best.spec) === 0 && rule.order >= best.order)) best = { value: v, spec, order: rule.order };
    }
  }
  return best ? best.value : null;
}

const T = ".angle-sync-modal .angle-sync-table";

describe("机位同步表格：层级与令牌", () => {
  it("表头用 caption 字号，与正文分层", () => {
    expect(effective(T + " th", "font-size")).toBe("var(--dlg-fs-caption)");
    expect(effective(T + " th", "font-weight")).toBe("500");
  });

  it("分隔线用发丝线令牌，不是控件填充色", () => {
    // 改造前是 var(--ctl-bg) —— 拿控件底色当线色，令牌层级用错
    expect(effective(T + " td", "border-bottom")).toContain("var(--dlg-line)");
    expect(effective(T + " td", "border-bottom")).not.toContain("--ctl-bg");
  });

  it("单元格内边距 9px 8px（不是改前的 4px 6px）", () => {
    expect(effective(T + " td", "padding")).toBe("9px 8px");
  });
});

describe("机位同步表格：数字列右对齐", () => {
  it("偏移与置信度两列右对齐并启用 tabular-nums", () => {
    // 列序：机位 | 状态 | 偏移 | 置信度 | 来源 | 手填
    for (const col of [3, 4]) {
      const sel = T + " td:nth-child(" + col + ")";
      expect(effective(sel, "text-align"), `第 ${col} 列应右对齐`).toBe("right");
    }
    expect(effective(T + " td", "font-variant-numeric")).toBe("tabular-nums");
  });

  it("机位列保持左对齐（文字列不该右对齐）", () => {
    expect(effective(T + " td", "text-align")).toBe("left");
  });
});

describe("机位同步表格：表头与数据同对齐（表格的基本契约）", () => {
  /**
   * 用户实测指出：「左对齐还是右对齐还是中间对齐，需要和其他弹窗统一起来」。
   *
   * 实测到的问题：状态列表头是 left，而 td 内是定宽 62px 居中的徽章——
   * 视觉上表头偏左 22px，看着就是错位。
   *
   * 表格的基本契约是「表头与它管辖的数据同对齐方式」。这里逐列断言，
   * 而不是只看一眼截图：新增列时若忘了对齐，这条会红。
   */
  const ALIGN_CASES: Array<[string, number, string]> = [
    ["机位", 1, "left"],
    ["状态", 2, "center"],
    ["偏移", 3, "right"],
    ["置信度", 4, "right"],
    ["来源", 5, "left"],
    ["手填", 6, "left"],
  ];

  it.each(ALIGN_CASES)("第 %s 列：表头与数据同为 %s", (_label, col, align) => {
    const th = T + " th:nth-child(" + col + ")";
    const td = T + " td:nth-child(" + col + ")";
    // 注意：.angle-sync-table td 的基样式是 left，右/中列必须有专属规则；
    // 只改 th 不改 td（或反之）正是本次的缺陷形态。
    const thAlign = effective(th, "text-align") ?? effective(T + " th", "text-align");
    const tdAlign = effective(td, "text-align") ?? effective(T + " td", "text-align");
    expect(thAlign, `第 ${col} 列表头应为 ${align}`).toBe(align);
    expect(tdAlign, `第 ${col} 列数据应为 ${align}`).toBe(align);
  });
});

describe("机位同步表格：布局不塌陷", () => {
  it("显式 table-layout:fixed，避免剩余宽度摊给状态列", () => {
    // 实测：auto 布局把状态列撑到 144px，内部只有 62px 徽章 → 出现大段空白
    expect(effective(T, "table-layout")).toBe("fixed");
  });

  it("六列都有显式宽度", () => {
    for (const col of [2, 3, 4, 5, 6]) {
      const w = effective(T + " th:nth-child(" + col + ")", "width");
      expect(w, `第 ${col} 列缺显式宽度`).toBeTruthy();
      expect(w).toMatch(/^\d+px$/);
    }
  });

  it("状态徽章固定 62px（与 keyframe / 语义检索同一契约）", () => {
    const sel = ".angle-sync-modal .angle-status";
    expect(effective(sel, "width")).toBe("62px");
    expect(effective(sel, "justify-content")).toBe("center");
  });

  it("状态原因是独立一行，不与徽章挤在同一行", () => {
    const sel = T + " td small";
    expect(effective(sel, "display")).toBe("block");
  });
});
