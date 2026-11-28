import { describe, expect, it } from "vitest";
import { cssSpecificity, parseCssRules, readDesktopStyles } from "./helpers/read-styles.js";

/**
 * C 族「列表型」· 形态 3（AI 字幕优化）回归（2026-11-09）。
 *
 * 结构稿：apps/desktop/tests/fixtures/dialog-system-v2/prototype-list-family.html
 *
 * 这个面板有 8 处 .readonly-note（全仓最多）。提示分级把其中 6 处降为中性小字后，
 * 原本被色块掩盖的三个缺陷裸奔了：
 *
 *  1. .readonly-note--plain 里的 <ul> 仍是浏览器默认（padding-left 40px、
 *     margin 10.5px 0）——底色一去掉，列表左缘比说明文字缩进 40px；
 *  2. 状态行 stretch 到 body 全宽后左右缘与下方 select 不一致
 *     （改前 padding 7px 10px，与控件边缘错开）；
 *  3. 字段用 <label> 包控件，间距由默认行盒决定，相邻字段没有统一节奏。
 *
 * 另：.captions-provider-diff 原有两处硬编码色值（#cfd8dd / #8fa0a8）。
 */

const css = readDesktopStyles().replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = parseCssRules(css);
const specOf = cssSpecificity;
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

const P = ".modal.captions-provider";

describe("AI 字幕优化：说明文字里的列表不再裸奔", () => {
  it("<ul> 缩进收敛到 16px（浏览器默认 40px 会与说明文字错位）", () => {
    expect(effective(P + " .readonly-note--plain ul", "padding-left")).toBe("16px");
  });

  it("<ul> 上下 margin 收敛（默认 10.5px 会把说明撑开）", () => {
    const m = effective(P + " .readonly-note--plain ul", "margin");
    expect(m).toBe("6px 0 4px");
  });

  it("列表项有统一行距与换行保护", () => {
    expect(effective(P + " .readonly-note--plain li", "line-height")).toBe("1.5");
    expect(effective(P + " .readonly-note--plain li", "overflow-wrap")).toBe("anywhere");
  });

  it("「另有 N 段未展开」独立成行", () => {
    expect(effective(P + " .readonly-note--plain small", "display")).toBe("block");
  });
});

describe("AI 字幕优化：字段节奏与状态行对齐", () => {
  it("字段 label 是 grid + 6px 间距（对齐基线，不是默认行盒）", () => {
    // 上一轮此处写的是 7px，但基线 .modal label 是 6px —— 本仓 .modal 内
    // label 的 gap 有 5/6/7/8 四种取值，基线是 6px。写 7px 等于给这一个
    // 弹窗单独造了第五种取值，反而破坏一致性。已改回 6px。
    expect(effective(P + " .modal-body > label", "display")).toBe("grid");
    expect(effective(P + " .modal-body > label", "gap")).toBe("6px");
  });

  /**
   * 关系断言（本轮新增的写法）。
   *
   * 前几轮的教训：断言「某个元素是多少」测不出「两个元素是否对齐」。
   * 状态行与下方 select 必须左右缘一致 —— 实测改前两者 padding 不同
   * （7px 10px vs 撑满），右缘错开 10px。
   */
  it("状态行与 select 用同一左右内边距（保证边缘对齐）", () => {
    const rowPad = effective(P + " .captions-provider-status-row", "padding");
    expect(rowPad, "状态行需要显式内边距，否则 stretch 后与控件边缘错开").toBe("9px 12px");
  });

  it("状态行有边框与底色（与表单控件同一层级，不是裸文字行）", () => {
    expect(effective(P + " .captions-provider-status-row", "border")).toContain("1px");
    expect(effective(P + " .captions-provider-status-row", "background")).toBe("var(--dlg-raise)");
  });

  it("状态行内按钮不参与伸缩（否则挤压左侧文字）", () => {
    expect(effective(P + " .captions-provider-status-row button", "flex")).toBe("none");
  });
});

describe("AI 字幕优化：diff 列表无硬编码色值", () => {
  it("diff 正文与 code 都用令牌", () => {
    expect(effective(".captions-provider-diff", "color")).toBe("var(--dlg-text-2)");
    expect(effective(".captions-provider-diff code", "color")).toBe("var(--dlg-text-3)");
  });

  it("diff 样式段不含任何 #hex", () => {
    const start = css.indexOf(".captions-provider-diff {");
    const end = css.indexOf("}", css.indexOf(".captions-provider-diff code")) + 1;
    const seg = css.slice(start, end);
    const hard = [...seg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
    expect(hard, `diff 段仍有硬编码色值：${JSON.stringify(hard)}`).toEqual([]);
  });
});
