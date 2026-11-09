import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C 族「列表型」行对齐的级联回归（2026-11-09）。
 *
 * 结构稿：docs/ui-mockups/dialog-system-v2/prototype-list-family.html
 *
 * 为什么要锁「徽章固定列宽」：行内三列是
 *   主信息（可伸缩） | 状态徽章 | 操作按钮
 * 徽章宽度若随文案走（「待外传」vs「已移除」），后面的按钮就会被推着左右跑，
 * 同一列表里按钮左缘参差。结构稿里实测到 33px vs 52px 的位移，用户以截图指出。
 * 这不是观感问题：同一位置的按钮在不同行落在不同 x 上，点击目标会漂移。
 *
 * 本文件对本仓既有 CSS 测试同法——直接对 styles.css 做级联裁决，而不是
 * 断言某段文本存在（"写了但被更高特异性规则压掉" 正是这类缺陷最初的失效方式）。
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

/** 特异性 [id, class/attr/pseudo-class, type]；:not() 参数计入、自身不计。 */
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

/** 顶层规则中，该选择器生效值（同权重取后声明者，与浏览器一致）。 */
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

const ROW = ".modal.keyframe-review .kf-row";
const BADGE = ".modal.keyframe-review .kf-badge";
const MAIN = ".modal.keyframe-review .kf-main";
const LIST = ".modal.keyframe-review .kf-list";

describe("C 族行列表：徽章固定列宽（否则按钮左缘随文案漂移）", () => {
  it("徽章宽度写死为 62px 且不参与伸缩", () => {
    expect(effective(BADGE, "width"), "徽章缺固定宽度，宽度会随文案变化").toBe("62px");
    expect(effective(BADGE, "flex")).toContain("none");
  });

  it("徽章内容居中且单行省略（长文案不撑破列宽）", () => {
    expect(effective(BADGE, "justify-content")).toBe("center");
    expect(effective(BADGE, "text-overflow")).toBe("ellipsis");
    expect(effective(BADGE, "white-space")).toBe("nowrap");
  });

  it("行内主信息可伸缩、徽章与按钮不伸缩", () => {
    expect(effective(MAIN, "flex")).toContain("1");
    expect(effective(MAIN, "min-width")).toBe("0");
    expect(effective(BADGE, "flex")).toBe("none");
  });

  it("行本身是 flex 且垂直居中（三列同一水平线）", () => {
    expect(effective(ROW, "display")).toBe("flex");
    expect(effective(ROW, "align-items")).toBe("center");
  });
});

describe("C 族行列表：行高由内容撑开，不写死高度", () => {
  it("行用内边距而非固定 height", () => {
    expect(effective(ROW, "padding")).toBe("9px 12px");
    // 写死 height 会让两行文案（单行/换行）高度不一致
    expect(effective(ROW, "height"), "行不应写死 height").toBeNull();
  });

  it("列表是 grid + 6px 行距，且去掉默认 ul 缩进与圆点", () => {
    expect(effective(LIST, "display")).toBe("grid");
    expect(effective(LIST, "gap")).toBe("6px");
    expect(effective(LIST, "list-style")).toBe("none");
    expect(effective(LIST, "padding")).toBe("0");
  });
});

describe("C 族行列表：状态不只靠颜色", () => {
  it("已移除行有降透明度 + 删除线（不只靠灰色文字）", () => {
    expect(effective(".modal.keyframe-review .kf-row.excluded", "opacity")).toBeTruthy();
    const strike = effective(".modal.keyframe-review .kf-row.excluded .kf-title", "text-decoration");
    expect(strike, "已移除状态需要非颜色的第二通道").toContain("line-through");
  });
});
