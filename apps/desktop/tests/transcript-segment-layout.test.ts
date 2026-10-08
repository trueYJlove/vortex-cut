import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 转录片段行排版回归（2026-10-08 用户实测）。
 *
 * 现场：转录查看器里每个片段不是独占一行，而是按内容宽度收缩、首尾相接折行，
 * 57 段挤成一屏碎块（截图可见「复选框 + 时间码 + 文本」三三两两并排）。
 *
 * 根因不是 .segment-row 写错了，而是它被一条更通用的规则压掉：
 *   `.modal label:has(> input[type="checkbox"]:first-child)` （特异性 0,3,2）
 *   { display: inline-flex; align-items: center; }
 * 片段行恰好是 `<label>` 且首子元素就是复选框，于是 (0,1,0) 的
 * `.segment-row { display: grid; grid-template-columns: 18px 78px 1fr }`
 * 整条失效 —— display 与 grid-template-columns 一起被 inline-flex 覆盖。
 *
 * 本测试做的是「级联裁决」而不是断言某段文本存在：把两条规则的选择器都取出，
 * 用真实特异性比较，确认 grid 规则不会被任何 label:has(...) 规则命中。
 * 断言文本存在无法发现这个缺陷 —— 旧 CSS 里两条规则都在，只是后者输了。
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 计算选择器特异性 [id, class/attr/pseudo-class, type]（:not() 参数计入，自身不计）。 */
function specificity(selector: string): [number, number, number] {
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

function rules(source: string): Array<{ selector: string; body: string }> {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => !match[1].trim().startsWith("@"))
    .map(match => ({ selector: match[1].trim(), body: match[2] }));
}

const selectorList = (selector: string) => selector.split(",").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);

/**
 * 「通用」label 选择器 = 除了 .modal 之外不带任何限定 class，因此能命中弹窗里
 * 任意一个 label（片段行也是 label）。带 .property-form / .shot-card 等容器限定
 * 的选择器不可能命中片段行，不参与裁决。
 */
function isGenericModalLabel(selector: string): boolean {
  if (/\.segment-row\b/.test(selector)) return false;
  if (!/(^|[\s>+~])label\b/.test(selector)) return false;
  if (!/\.modal\b/.test(selector)) return false;
  const otherClasses = (selector.match(/\.[\w-]+/g) ?? []).filter(name => name !== ".modal");
  return otherClasses.length === 0;
}

describe("转录片段行排版：通用 label 规则不得压掉 .segment-row 的 grid", () => {
  it(".segment-row 自身声明了整行 grid（含三列模板）", () => {
    const base = rules(css).filter(rule => selectorList(rule.selector).includes(".segment-row"));
    expect(base.length, "找不到 .segment-row 基础规则").toBeGreaterThan(0);
    const decl = base.map(rule => rule.body).join(";");
    expect(decl, ".segment-row 必须是 grid（整行独占）").toMatch(/display\s*:\s*grid/);
    expect(decl, ".segment-row 必须定义三列模板").toMatch(/grid-template-columns/);
  });

  it("没有任何通用弹窗 label 规则以更高特异性把片段行改成非 grid", () => {
    const rowSpec = specificity(".segment-row");
    const offenders = rules(css)
      .filter(rule => /display\s*:/.test(rule.body))
      .flatMap(rule => selectorList(rule.selector).map(sel => ({ sel, body: rule.body })))
      .filter(({ sel }) => isGenericModalLabel(sel))
      .filter(({ body }) => !/display\s*:\s*grid\b/.test(body))
      .filter(({ sel }) => compare(specificity(sel), rowSpec) > 0)
      .map(({ sel }) => sel);

    expect(
      offenders,
      `以下通用 label 规则会覆盖 .segment-row 的 display（需加 :not(.segment-row)）：${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("复选框/单选框行内标签规则确实排除了 .segment-row", () => {
    const inline = rules(css).filter(rule =>
      selectorList(rule.selector).some(sel => /label:has\(/.test(sel) && /input\[type="checkbox"\]/.test(sel)));
    expect(inline.length, "找不到 label:has(...checkbox...) 行内标签规则").toBeGreaterThan(0);
    for (const rule of inline) {
      for (const sel of selectorList(rule.selector)) {
        expect(sel, `该行内标签选择器未排除 .segment-row：${sel}`).toMatch(/:not\(\.segment-row\)/);
      }
    }
  });
});

/**
 * 复选框垂直对齐回归（2026-10-08 用户实测：勾选框与文字不在一条水平线上）。
 *
 * 根因：`.modal input, .modal select, .modal textarea { height:30px;
 * min-height:30px }`（特异性 0,1,1）把 13×13 的复选框撑成 13×30。
 * `.segment-row input { width:13px; height:13px }`（同为 0,1,1）只声明了
 * height、**从不声明 min-height**，因此任何命中它的 min-height 必然获胜；
 * 又因 `.modal input` 在文件更靠后，连 height 也被改写。
 * 方框内垂直居中后勾选标记比同行文字下沉约 4px（Chromium 实测
 * checkbox_cy 低 4.0px；修复后 0.0px）。
 *
 * 与上组测试同理：断言"存在某条规则"无法发现缺陷，必须做级联裁决。
 */
describe("复选框垂直对齐：通用 input 高度规则不得命中 checkbox/radio", () => {
  /** 该选择器是否会命中 `.segment-row` 里的复选框。 */
  const hitsSegmentCheckbox = (sel: string): boolean => {
    if (/\.segment-row\b/.test(sel)) return true; // 直接命中（如 .segment-row input）
    if (/\[type=/.test(sel)) return false; // 已按类型限定，天然安全
    if (!/(^|[\s>+~])input\b/.test(sel)) return false;
    // 容器限定（.generation-assets / .check-line / .pp-panel …）不覆盖弹窗片段行；
    // 只保留 .modal 与裸 input 这类会落到片段行上的选择器。
    const classes = (sel.match(/\.[\w-]+/g) ?? []).filter(name => name !== ".modal");
    return classes.length === 0;
  };

  it("没有任何 min-height 规则会命中片段行复选框（min-height 必然获胜）", () => {
    const offenders = rules(css)
      .filter(rule => /min-height\s*:/.test(rule.body))
      .flatMap(rule => selectorList(rule.selector))
      .filter(hitsSegmentCheckbox);
    expect(
      offenders,
      `以下规则的 min-height 会把 13×13 复选框撑高（.segment-row input 从不声明 min-height，必然被压制）：${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("通用弹窗 input 尺寸规则显式排除 checkbox/radio", () => {
    // 「通用」= 除 .modal 外不带任何容器限定类，因此能落到片段行复选框上
    // （.provider-settings .ps-body input 等被容器限定，不可能命中
    // .transcript-viewer 里的片段行）。排除伪元素与交互态变体
    // （::placeholder / :hover / :focus）——它们不声明尺寸，与对齐无关；
    // 注意 :not(...) 不算交互态，它是修复本身。
    const isGenericModalInput = (sel: string): boolean =>
      /\.modal\b/.test(sel)
      && /(^|[\s>+~])input\b/.test(sel)
      && !/::/.test(sel)
      && !/:(hover|focus|focus-visible|active|disabled)\b/.test(sel)
      && (sel.match(/\.[\w-]+/g) ?? []).filter(name => name !== ".modal").length === 0;

    // 已把类型限定为 search/range 等的规则天然不可能命中复选框，豁免。
    const limitedToOtherType = (sel: string): boolean => {
      const types = [...sel.matchAll(/\[type="([^"]+)"\]/g)].map(m => m[1]);
      return types.length > 0 && types.every(t => t !== "checkbox" && t !== "radio");
    };

    const generic = rules(css).filter(rule =>
      /(min-)?height\s*:/.test(rule.body)
      && selectorList(rule.selector).some(sel => isGenericModalInput(sel) && !limitedToOtherType(sel)));
    expect(generic.length, "找不到 .modal 通用 input 尺寸规则（预期已改为 :not([type=checkbox])）").toBeGreaterThan(0);

    for (const rule of generic) {
      for (const sel of selectorList(rule.selector)) {
        if (!isGenericModalInput(sel) || limitedToOtherType(sel)) continue;
        expect(
          sel,
          `.modal 通用 input 尺寸规则未排除 checkbox/radio，会改写片段行复选框尺寸：${sel}`,
        ).toMatch(/:not\(\[type="checkbox"\]\)/);
      }
    }
  });
});

/**
 * 片段行三列水平对齐回归（2026-10-08 用户实测：复选框夹在时间码与正文中间，
 * 三者不在一条水平线上）。
 *
 * 根因不在某条规则被压掉，而在两列的**行盒高度不同**：
 *  ① 正文 .modal .readonly-segments p { line-height: 1.7 }（0,2,1）按
 *     --dlg-fs-body(12.5px) 算出行盒 21.25px；时间码没有任何长度声明，
 *     只能继承基础 .segment-row { line-height: 1.55 }（0,1,0），按
 *     --dlg-fs-caption(10.5px) 算出 16.275px。同一行内两列基线因此错开
 *     约 4px（Chromium 实测 span 基线 433.19 vs p 基线 437.19）。
 *  ② grid 默认 align-items:stretch，13px 复选框贴到行盒顶部，墨迹中心再偏。
 * 实测三者中心偏差（@4x device px）：修复前 cb-time +7.5 / cb-text −4.5；
 * 修复后 0 / 0 / 0。
 *
 * 与上组同理：断言「存在 align-items:center」不够，必须做**级联裁决**，
 * 算出真正生效的那条声明，确认它是长度而非无单位倍数。
 */

/** 片段行的已知祖先/自身 class 集合（.modal → 列表容器 → 行）。 */
const SEGMENT_CHAIN = new Set(["modal", "transcript-viewer", "readonly-segments", "transcript-selectable-segments", "segment-row"]);

/**
 * 去掉 :has(...) / :not(...) 的括号内容（支持嵌套），再做结构判定。
 * 必须去掉：`:not(.segment-row)` 里的 .segment-row 是「排除」，不是命中；
 * 而 `:has(> input[...])` 里的 `>` 会被复合选择器切分器误当成子代组合符，
 * 使末段错落到 input 上——第一版辅助函数因此把
 * `.modal label:has(> input[type="checkbox"]:first-child):not(.segment-row)`
 * 误判为「命中片段行」，让 align-items 断言在未修复的 CSS 上也能通过
 * （负向对照当场暴露）。
 */
function stripFunctionalPseudos(sel: string): string {
  let out = "";
  let i = 0;
  while (i < sel.length) {
    const match = /^:(has|not)\(/i.exec(sel.slice(i));
    if (!match) {
      out += sel[i];
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + match[0].length;
    while (j < sel.length && depth > 0) {
      if (sel[j] === "(") depth += 1;
      else if (sel[j] === ")") depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

const classesOf = (sel: string) => (stripFunctionalPseudos(sel).match(/\.[\w-]+/g) ?? []).map(name => name.slice(1));
const onSegmentChain = (sel: string) => classesOf(sel).every(name => SEGMENT_CHAIN.has(name));
const lastCompound = (sel: string) => stripFunctionalPseudos(sel).split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";

/** 该选择器是否作用到片段行的「时间码 / 正文」列（含从行继承）。 */
function targetsSegmentColumn(sel: string, element: "span" | "p"): boolean {
  if (!onSegmentChain(sel)) return false;
  const last = lastCompound(sel);
  return new RegExp("(^|[.\\w-])" + element + "\\b").test(last) || /segment-row/.test(last);
}

/** 该选择器是否作用到片段行自身（align-items 由此生效）。 */
function targetsSegmentRow(sel: string): boolean {
  if (!onSegmentChain(sel)) return false;
  return /segment-row/.test(lastCompound(sel));
}

/** 取声明体里某属性的值（无则 null）。 */
function declaredValue(body: string, property: string): string | null {
  const match = body.match(new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;]+)", "i"));
  return match ? match[1].trim() : null;
}

/** 级联裁决：作用于 target 且声明了 property 的规则里，特异性最高者；同特异性取后写。 */
function winningDeclaration(target: (sel: string) => boolean, property: string): { selector: string; value: string } | null {
  let bestSelector = "";
  let bestValue = "";
  let bestSpec: [number, number, number] | null = null;
  for (const rule of rules(css)) {
    for (const sel of selectorList(rule.selector)) {
      if (!target(sel)) continue;
      const value = declaredValue(rule.body, property);
      if (value === null) continue;
      const spec = specificity(sel);
      if (bestSpec === null || compare(spec, bestSpec) >= 0) {
        bestSpec = spec;
        bestSelector = sel;
        bestValue = value;
      }
    }
  }
  return bestSpec === null ? null : { selector: bestSelector, value: bestValue };
}

/** 无单位倍数（1.55）会随字号换算出不同行盒；长度（px/rem/em/calc）不会。 */
const isLengthValue = (value: string) => /calc\(/.test(value) || /^-?[\d.]+(px|rem|em|pt)$/.test(value.trim());

describe("片段行三列水平对齐：行盒等高 + 复选框垂直居中", () => {
  it("时间码与正文生效的 line-height 是同一个长度（不随各自字号漂移）", () => {
    const time = winningDeclaration(sel => targetsSegmentColumn(sel, "span"), "line-height");
    const text = winningDeclaration(sel => targetsSegmentColumn(sel, "p"), "line-height");
    expect(time, "找不到作用于片段行时间码的 line-height 声明").not.toBeNull();
    expect(text, "找不到作用于片段行正文的 line-height 声明").not.toBeNull();
    for (const [label, decl] of [["时间码", time!], ["正文", text!]] as const) {
      expect(
        isLengthValue(decl.value),
        label + "生效的 line-height 是「" + decl.value + "」（来自 " + decl.selector + "）——无单位倍数会按各自字号换算出行盒，两列基线必然错开",
      ).toBe(true);
    }
    expect(time!.value, "时间码与正文的 line-height 不是同一个长度").toBe(text!.value);
  });

  it("片段行生效的 align-items 是 center（复选框落进行盒垂直中心）", () => {
    const align = winningDeclaration(targetsSegmentRow, "align-items");
    expect(align, "找不到作用于片段行的 align-items 声明").not.toBeNull();
    expect(
      align!.value,
      "片段行生效的 align-items 是「" + align!.value + "」（来自 " + align!.selector + "）——stretch 会把 13px 复选框贴到行盒顶部",
    ).toBe("center");
  });
});
