import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Provider 启用开关的级联回归（2026-11-09）。
 *
 * 用户实测：开关是个 38×34 的圆环，圆点贴着上沿，看着不像开关。
 * 根因不是开关自身写错，而是它没压过 `.modal button` 这条给普通按钮用的
 * 宽规则。两条规则同时命中同一个 <button class="switch">：
 *
 *   · min-height  `.modal button` (0,1,1) 声明 min-height:var(--dlg-ctl-h)=34px；
 *                 `.modal .switch` 只写 height:22px ⇒ 轨高被钳成 34px。
 *                 Chromium 实测：38×34，圆钮 knobTop 3 / knobBottom 15。
 *   · hover       `.modal button:hover:not(:disabled)` (0,3,1) 高于
 *                 `.modal .switch.on` (0,3,0) ⇒ 开启态薄荷青底在指针移上去的
 *                 瞬间消失（实测 bg 由 rgba(53,214,174,.11) 变 rgb(41,50,53)），
 *                 border 被打成 0，圆钮横移 1px（knobL 19→18、knobTop 3→2）。
 *
 * 本测试与本仓既有 CSS 测试（dialog-box-indent / dialog-graphite-style）同法：
 * 直接对 styles.css 做**级联裁决**，而不是断言某段文本存在——"写了但被压掉"
 * 正是这类视觉缺陷最初的失效方式。
 *
 * 命中判定用 jsdom 的 Element.matches()，不手写选择器正则：第一版手写正则在
 * `.switch > span` 与 `.generation-request-list > button` 上误判，把圆钮的
 * 16px 当成了轨道宽度。命中是浏览器的既有语义，不该在这里重造。
 */

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; body: string; order: number; inMedia: boolean };

/** 抽出所有规则，跳过 at-rule 包裹层（@media 变体不是 1440×900 基准态）。 */
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
        selectors: prelude.split(",").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean),
        body,
        order,
        inMedia: stack.some(item => item.startsWith("@media")),
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

function declaredValue(body: string, property: string): string | null {
  const match = body.match(new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;]+)", "i"));
  return match ? match[1].trim() : null;
}

/**
 * 开关 + 圆钮的真实 DOM，与 ProviderSettingsDialog 的 role=switch 结构一致。
 * 用 vitest 的 jsdom 环境（全局 document），不额外 import jsdom 包——
 * 该包没有类型声明，直接 import 会让 tsc 报 TS7016。
 */
function makeDom(switchClass: string): { window: Window; track: Element; knob: Element } {
  document.body.innerHTML =
    `<div class="modal-backdrop"><section class="modal provider-settings">` +
    `<div class="modal-body ps-body"><div class="field span-2 enabled-row"><div><label>在 AI 功能中启用</label></div>` +
    `<button type="button" role="switch" class="${switchClass}"><span></span></button>` +
    `</div></div><div class="modal-actions"><button class="btn ghost">关闭</button></div></section></div>`;
  return {
    window,
    track: document.querySelector("button.switch")!,
    knob: document.querySelector("button.switch > span")!,
  };
}

/**
 * 结构命中：选择器里声明的交互伪类必须与目标状态一致，其余交给 el.matches()。
 * jsdom 的 :hover / :focus-visible 永远为假（没有指针），所以这两类先按状态
 * 一致性与否裁决，再从选择器里剥掉后做真实匹配。
 */
function structurallyMatches(el: Element, selector: string, state: { hover: boolean }): boolean {
  if (/:hover/.test(selector) !== state.hover) return false;
  const stripped = selector.replace(/:(hover|focus-visible)/g, "");
  try {
    return el.matches(stripped);
  } catch {
    return false;
  }
}

/**
 * 级联裁决：取该元素在该状态下、顶层规则中生效的属性值。
 * 特异性高者胜；同权重按声明顺序后者胜——与浏览器一致。
 */
function effective(el: Element, state: { hover: boolean }, property: string): { value: string; selector: string } | null {
  let best: { value: string; selector: string; spec: [number, number, number]; order: number } | null = null;
  for (const rule of RULES) {
    if (rule.inMedia) continue;
    for (const selector of rule.selectors) {
      if (!structurallyMatches(el, selector, state)) continue;
      const value = declaredValue(rule.body, property);
      if (value === null) continue;
      const spec = specificity(selector);
      if (best === null
        || compare(spec, best.spec) > 0
        || (compare(spec, best.spec) === 0 && rule.order >= best.order)) {
        best = { value, selector, spec, order: rule.order };
      }
    }
  }
  return best ? { value: best.value, selector: best.selector } : null;
}

const IDLE = { hover: false };
const HOVER = { hover: true };

afterEach(() => { document.body.innerHTML = ""; });

describe("Provider 启用开关：轨高不被 .modal button 钳制", () => {
  const { track, knob } = makeDom("switch");

  it("轨道是 38×22 的胶囊，不是 38×34 的圆环", () => {
    expect(effective(track, IDLE, "width")?.value).toBe("38px");
    expect(effective(track, IDLE, "height")?.value).toBe("22px");
  });

  it("min-height 显式声明为 22px，压过 .modal button 的 34px", () => {
    const minHeight = effective(track, IDLE, "min-height");
    expect(
      minHeight?.value,
      "开关没有声明自己的 min-height；不声明则 .modal button 的 min-height:var(--dlg-ctl-h)=34px 生效，" +
      "height:22px 被钳成 34px（用户实测的圆环）。实际生效来源：" + (minHeight?.selector ?? "无"),
    ).toBe("22px");
    expect(minHeight?.selector).toContain(".switch");
  });

  it("圆钮 16×16，内外间距对称（轨道 22 = 2 + 16 + 2 内容高 + 2×1 边框）", () => {
    expect(effective(knob, IDLE, "width")?.value).toBe("16px");
    expect(effective(knob, IDLE, "height")?.value).toBe("16px");
    expect(effective(knob, IDLE, "top")?.value).toBe("2px");
    expect(effective(knob, IDLE, "left")?.value).toBe("2px");
  });

  it("开启态圆钮右移 16px（38 - 2×1 边框 - 2×2 - 16 = 16），两端对称", () => {
    const on = makeDom("switch on");
    expect(effective(on.knob, IDLE, "transform")?.value).toBe("translateX(16px)");
  });
});

describe("Provider 启用开关：hover 不吞噬状态色", () => {
  it(".modal button:hover 的 border:0 不再压过开关", () => {
    const { track } = makeDom("switch");
    const hoverBorder = effective(track, HOVER, "border");
    expect(
      hoverBorder?.value,
      "开关缺少自己的 :hover border 声明；.modal button:hover:not(:disabled) (0,3,1) 会把边框抹成 0，" +
      "轨道尺寸随之变化、圆钮横移 1px。实际生效来源：" + (hoverBorder?.selector ?? "无"),
    ).toContain("1px");
    expect(hoverBorder?.selector).toContain(".switch");
  });

  it("开启态 hover 仍保持薄荷青底与强调色边框", () => {
    const { track } = makeDom("switch on");
    const hoverBg = effective(track, HOVER, "background");
    expect(
      hoverBg?.value,
      "开启态缺少 :hover 背景声明；.modal button:hover 会把底换成 --btn-bg-hover，薄荷青在指针进入瞬间消失。" +
      "实际生效来源：" + (hoverBg?.selector ?? "无"),
    ).toContain("--dlg-accent-dim");
    expect(hoverBg?.selector).toContain(".switch.on");
    // 2026-11-11 令牌化：边框色改走 var(--rgba-93)（深色值即原来的 rgba(53,214,174,.45)），
    // 断言改为「指向同一个品牌色令牌」而不是字面色值——本测试的意图是
    //「hover 不把薄荷青边框吞成中性色」，不是锁死一个 rgb 三元组。
    expect(effective(track, HOVER, "border-color")?.value).toMatch(/--rgba-93|--dlg-primary|--brand/);
  });

  it("关闭态 hover 保持中性轨道，不跳成主按钮色", () => {
    const { track } = makeDom("switch");
    const hoverBg = effective(track, HOVER, "background");
    expect(hoverBg?.value).toContain("--ctl-bg");
    expect(hoverBg?.selector).toContain(".switch");
  });

  it("两个状态的 idle 与 hover 底色各自不同（否则开关失去开/关语义）", () => {
    const onTrack = makeDom("switch on").track;
    makeDom("switch");
    const offTrack = makeDom("switch").track;
    expect(effective(onTrack, IDLE, "background")?.value).not.toBe(effective(offTrack, IDLE, "background")?.value);
    expect(effective(onTrack, HOVER, "background")?.value).not.toBe(effective(offTrack, HOVER, "background")?.value);
  });
});
