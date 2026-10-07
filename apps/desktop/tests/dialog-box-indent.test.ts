import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 弹窗盒式缩进回归（2026-10-06）。
 *
 * 背景：`.modal > *:not(.modal-heading):not(.modal-actions)`（特异性 0,3,0）
 * 给弹窗直系子元素 22px padding。带边框/背景的整宽盒子因此「只推内容、不缩
 * 盒子」，边框与背景铺满弹窗左右边缘（用户实测转录查看器与 AI 字幕优化弹窗）。
 * 收口要求：这类盒子必须改用 margin 缩进，且覆盖规则的特异性必须 ≥ 0,3,0，
 * 否则 padding 覆盖失效、margin 与旧 padding 叠加成双倍缩进。
 *
 * 本测试直接对 styles.css 做特异性计算，而不是断言文本存在——文本存在但
 * 特异性不足正是最初的失效方式。
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
const css = readFileSync(cssPath, "utf8");

/** 计算选择器特异性 [id, class/attr/pseudo-class, type]（:not() 内部按其参数计入）。 */
function specificity(selector: string): [number, number, number] {
  // 先把 :not(...) 展开为其内部内容参与计数（规范：:not() 自身不计，
  // 但其参数的选择器计入），避免重复计数。
  let expanded = selector;
  let previous = "";
  while (previous !== expanded) {
    previous = expanded;
    expanded = expanded.replace(/:not\(([^)]*)\)/g, " $1 ");
  }
  const ids = (expanded.match(/#[\w-]+/g) ?? []).length;
  const classes = (expanded.match(/\.[\w-]+/g) ?? []).length
    + (expanded.match(/\[[^\]]+\]/g) ?? []).length
    + (expanded.match(/:(?!not\()[\w-]+/g) ?? []).length;
  const types = (expanded.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
  return [ids, classes, types];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** 抽出所有规则（选择器 → 声明块），跳过 at-rule 包裹层。
    选择器列表常跨多行，故用「最后一个 { 之前」的全部文本作为选择器。
    注释必须先剥离：否则紧邻规则的块注释会被并入选择器，令 startsWith 判定失效。 */
function rules(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const selector = match[1].trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

/** 规则的选择器列表（按逗号切分，容忍跨行与空白）。 */
function selectorList(selector: string): string[] {
  return selector.split(",").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const GENERAL = ".modal > *:not(.modal-heading):not(.modal-actions)";
const GENERAL_SPEC = specificity(GENERAL);

describe("弹窗盒式缩进：覆盖规则特异性必须胜过通用 :not() 规则", () => {
  it("通用规则的基线特异性确为 (0,3,0)", () => {
    expect(GENERAL_SPEC).toEqual([0, 3, 0]);
  });

  it("提示盒的 margin 缩进规则特异性 ≥ 基线（否则被压制）", () => {
    const targets = ["readonly-note", "readonly-segments", "provider-capability-list", "instruction-preview", "egress-text"];
    for (const target of targets) {
      const selectors = rules(css)
        .filter(rule => /margin-left\s*:/.test(rule.body))
        .flatMap(rule => selectorList(rule.selector))
        .filter(sel => sel.startsWith(".modal") && sel.includes(`.${target}`));
      expect(selectors.length, `${target} 缺少 margin 缩进规则`).toBeGreaterThan(0);
      const best = selectors.map(specificity).reduce((a, b) => (compare(a, b) >= 0 ? a : b));
      expect(
        compare(best, GENERAL_SPEC),
        `${target} 的 margin 规则特异性 ${JSON.stringify(best)} 未胜过基线 ${JSON.stringify(GENERAL_SPEC)}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("提示盒的 padding 覆盖规则特异性 ≥ 基线（否则双倍缩进）", () => {
    const targets = ["readonly-note", "readonly-segments", "provider-capability-list"];
    for (const target of targets) {
      const selectors = rules(css)
        .filter(rule => /padding-(left|right)\s*:/.test(rule.body))
        .flatMap(rule => selectorList(rule.selector))
        .filter(sel => sel.startsWith(".modal") && sel.includes(`.${target}`));
      const best = selectors
        .map(specificity)
        .reduce((a, b) => (compare(a, b) >= 0 ? a : b), [0, 0, 0] as [number, number, number]);
      expect(
        compare(best, GENERAL_SPEC),
        `${target} 的 padding 覆盖特异性 ${JSON.stringify(best)} 未胜过基线 ${JSON.stringify(GENERAL_SPEC)}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("转录查看器片段列表自身滚动且补底部留白（未全屏时不撑满整屏）", () => {
    const viewer = rules(css).filter(rule => rule.selector.includes("transcript-viewer"));
    const scrollRule = viewer.find(rule => rule.selector.includes("readonly-segments") && /max-height/.test(rule.body));
    expect(scrollRule, "转录查看器片段列表缺少 max-height 滚动约束").toBeDefined();
    expect(scrollRule!.body).toMatch(/overflow\s*:\s*auto/);
    const bottomPad = viewer.find(rule => /^\.modal\.transcript-viewer\s*$/.test(rule.selector.trim()) && /padding-bottom/.test(rule.body));
    expect(bottomPad, "转录查看器缺少底部留白（无 modal-actions 底栏）").toBeDefined();
  });

  it("AI 字幕优化弹窗有独立宽度档位", () => {
    const rule = rules(css).find(item => item.selector.includes(".modal.captions-provider") && /width/.test(item.body));
    expect(rule, "AI 字幕优化弹窗缺少宽度档位（会退到 560px 默认）").toBeDefined();
  });
});
