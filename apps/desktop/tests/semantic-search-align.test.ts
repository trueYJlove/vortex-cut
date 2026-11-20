import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C 族「列表型」· 组合态（素材语义检索）回归（2026-11-09）。
 *
 * 结构稿：docs/design/ui-mockups/dialog-system-v2/prototype-list-family.html
 *
 * 改造前本段有 **8 处硬编码色值**（#d16055 / #2e211f / #eec4be / #303b40×3 /
 * #d1a453 / #8b9aa1），完全绕过 Graphite 令牌。这类漏网最难发现：真机上看着
 * 「差不多对」，但改令牌或换主题时这一段不跟随，是视觉统一里唯一不衰减的裂缝。
 *
 * 与 keyframe 那组锁同法——对 styles.css 做级联裁决，而不是断言文本存在。
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
    const char = source[i];
    if (char === "{") {
      const prelude = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") { depth -= 1; if (depth === 0) break; }
        body += source[j];
        j += 1;
      }
      order += 1;
      out.push({
        selectors: prelude.split(",").map(p => p.replace(/\s+/g, " ").trim()).filter(Boolean),
        body, order, inMedia: stack.length > 0,
      });
      i = j;
      continue;
    }
    if (char === "}") { stack.pop(); buffer = ""; continue; }
    buffer += char;
  }
  return out;
}

const RULES = parseRules(css);

function specificity(selector: string): [number, number, number] {
  let expanded = selector;
  let previous = "";
  while (previous !== expanded) {
    previous = expanded;
    expanded = expanded.replace(/:not\(([^)]*)\)/g, " $1 ");
  }
  return [
    (expanded.match(/#[\w-]+/g) ?? []).length,
    (expanded.match(/\.[\w-]+/g) ?? []).length
      + (expanded.match(/\[[^\]]+\]/g) ?? []).length
      + (expanded.match(/:(?!not\()[\w-]+/g) ?? []).length,
    (expanded.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const declared = (body: string, prop: string): string | null => {
  const m = body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i"));
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
      const spec = specificity(sel);
      if (!best || cmp(spec, best.spec) > 0 || (cmp(spec, best.spec) === 0 && rule.order >= best.order)) {
        best = { value: v, spec, order: rule.order };
      }
    }
  }
  return best ? best.value : null;
}

const P = ".modal.semantic-search";

/** 取本面板段落源码：从首条本面板规则起，到下一个大注释分隔为止。 */
const segStart = css.indexOf(P + " .semantic-search-form");
const segEnd = css.indexOf(".modal.semantic-search .index-hint", segStart);
const panelSegment = segStart < 0 ? "" : css.slice(segStart, segEnd > 0 ? css.indexOf("}", segEnd) + 1 : css.length);

describe("语义检索：不再有硬编码色值（令牌化）", () => {
  it("本面板样式段不含任何 #hex 色值", () => {
    const hardcoded = [...panelSegment.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
    expect(
      hardcoded,
      `本面板仍在用硬编码色值（改令牌时不会跟随）：${JSON.stringify([...new Set(hardcoded)])}`,
    ).toEqual([]);
  });

  it("状态与分数用令牌而非字面色", () => {
    expect(effective(P + " .hit-score", "color")).toContain("var(--dlg-primary)");
    expect(effective(P + " .index-status.ready", "background")).toContain("var(--dlg-accent-dim)");
    expect(effective(P + " .index-status.failed", "background")).toContain("var(--dlg-warn-dim)");
  });
});

describe("语义检索：行对齐（宽度不随文案漂移）", () => {
  it("分数列固定 56px 且右对齐（0.912 与 0.5 位数不同也不推歪右缘）", () => {
    expect(effective(P + " .hit-score", "width")).toBe("56px");
    expect(effective(P + " .hit-score", "text-align")).toBe("right");
    expect(effective(P + " .hit-score", "flex")).toContain("none");
  });

  it("状态徽章固定 62px 且居中省略（与 keyframe 行同一契约）", () => {
    expect(effective(P + " .index-status", "width")).toBe("62px");
    expect(effective(P + " .index-status", "justify-content")).toBe("center");
    expect(effective(P + " .index-status", "text-overflow")).toBe("ellipsis");
  });

  it("名称列可伸缩且不会撑破容器", () => {
    expect(effective(P + " .hit-name", "flex")).toContain("1");
    expect(effective(P + " .hit-name", "min-width")).toBe("0");
    expect(effective(P + " .index-name", "min-width")).toBe("0");
  });
});

describe("语义检索：列表与 C 族行形态一致", () => {
  it("命中列表是 grid + 6px 间距，行为卡片行（圆角 + raise 底）", () => {
    expect(effective(P + " .semantic-search-hits", "display")).toBe("grid");
    expect(effective(P + " .semantic-search-hits", "gap")).toBe("6px");
    expect(effective(P + " .semantic-search-hits li", "border-radius")).toBe("var(--r-ctl)");
    expect(effective(P + " .semantic-search-hits li", "background")).toBe("var(--dlg-raise)");
  });

  it("语义索引列表同一形态（不是只给命中列表升级）", () => {
    expect(effective(P + " .semantic-index-list", "display")).toBe("grid");
    expect(effective(P + " .semantic-index-list", "gap")).toBe("6px");
    expect(effective(P + " .semantic-index-list li", "background")).toBe("var(--dlg-raise)");
  });

  it("行用内边距而非写死高度", () => {
    expect(effective(P + " .semantic-search-hits li", "padding")).toBe("9px 12px");
    expect(effective(P + " .semantic-search-hits li", "height")).toBeNull();
  });
});
