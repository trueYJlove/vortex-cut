import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 主题令牌覆盖率守卫（2026-11-11）。
 *
 * **为什么需要这条测试**：样式表曾有 759 处硬编码颜色、458 条规则受影响，
 * 浅色主题下反复出现「文字看不见」（实测连续三处：标题栏项目名对比度 1.01、
 * 缩放标签 1.29、项目下拉项 1.08/1.47）。逐处修补不可能收敛——出现最多的
 * 30 个色值也只覆盖 64%，长尾极重，用户会不断在新位置遇到同类问题。
 *
 * 因此本测试把「不许写颜色字面量」变成机器检查：新增一处硬编码即变红，
 * 而不是等用户截图来发现。
 *
 * **允许出现颜色字面量的地方只有两类**：
 *   1. 令牌定义块（:root 与 html[data-theme="light"] 的 --xxx: 声明）——
 *      那是颜色的唯一来源；
 *   2. [data-theme="light"] 前缀的主题覆盖规则——它们本身就在做配色，
 *      把值抽成令牌只会多一层跳转而无收益。
 *
 * 其余任何规则里的颜色字面量都必须走 var(--token)。
 */

const CSS_PATH = resolve(__dirname, "../src/styles.css");

/** 从 CSS 里取出所有规则（选择器 + 声明体），跳过注释与 @ 规则。 */
function rules(css: string): { selector: string; body: string; line: number }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  const out: { selector: string; body: string; line: number }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const selector = match[1].trim().split("\n").pop()!.trim();
    if (!selector || selector.startsWith("@")) continue;
    const line = stripped.slice(0, match.index).split("\n").length;
    out.push({ selector, body: match[2], line });
  }
  return out;
}

/** 一组不该出现在普通规则里的颜色字面量：十六进制与 rgb()/hsl()。 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;

/** 本测试允许保留颜色字面量的选择器。 */
const ALLOWED = [
  // 主题覆盖规则本身就在配色
  (sel: string) => sel.startsWith('[data-theme="light"]'),
  (sel: string) => sel.startsWith('html[data-theme="light"]'),
];

describe("主题令牌覆盖率", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const all = rules(css);

  it("样式表能被解析出规则（防止解析器本身失效导致测试形同虚设）", () => {
    expect(all.length).toBeGreaterThan(1500);
  });

  it("普通规则里不得出现颜色字面量——必须走 var(--token)", () => {
    const offenders: string[] = [];
    for (const rule of all) {
      if (ALLOWED.some((allow) => allow(rule.selector))) continue;
      // 令牌定义块：声明名以 -- 开头，值是颜色 —— 这是颜色的唯一来源
      const decls = rule.body.split(";");
      for (const decl of decls) {
        const [rawProp, ...rest] = decl.split(":");
        if (!rawProp || rest.length === 0) continue;
        const prop = rawProp.trim();
        const value = rest.join(":");
        if (prop.startsWith("--")) continue; // 令牌定义，允许
        // var(--x, #fallback) 里的兜底值也允许：它只在令牌缺失时生效
        const withoutVar = value.replace(/var\(\s*--[^,)]+\s*,[^)]*\)/g, "");
        if (!COLOR_LITERAL.test(withoutVar)) continue;
        offenders.push(
          `L${rule.line}  ${rule.selector.slice(0, 70)}  ::  ${prop}: ${value.trim().slice(0, 60)}`,
        );
      }
    }
    expect(offenders, `以下规则使用了颜色字面量，请改用 var(--token)：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("令牌层不得重定义样式表其它位置已有的令牌名（重名会静默改掉画布取色）", () => {
    // 真实缺陷（2026-11-11 本轮踩中）：令牌层给 #3c4a56 起名 --tl-tick-major，
    // 而 --tl-tick-major 早在 :root 里就是时间线画布的主刻度色
    // （TimelineCanvas.tsx:463 cssColor("--tl-tick-major")）。后定义的层获胜，
    // 深色时间线刻度因此从 #8a95a5 变成 #3c4a56——**CSS 侧看不出任何异常**：
    // 没有任何规则引用错，是「名字被抢了」。逐像素 diff 才发现（119 像素）。
    // 画布取色走 getComputedStyle，名字冲突在静态检查里完全隐形，故单列一条。
    //
    // 识别令牌层：找出「整块只由 --x: value 声明构成」且声明数最多的 :root /
    // html[data-theme="light"] 规则。不依赖行号，也不依赖「同名恰好出现两次」——
    // 后者会被真正的重名绕过：本轮 4 处同名时，那个启发式把全部 240 个令牌
    // 一起归为「层外」，于是守卫恒真（第一版实测变异体照样全绿）。
    const pureBlocks = all
      .filter((rule) => rule.selector === ":root" || rule.selector === 'html[data-theme="light"]')
      .map((rule) => ({
        rule,
        names: [...rule.body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
        decls: rule.body.split(";").filter((d) => d.trim()).length,
      }))
      .filter((b) => b.names.length > 0 && b.names.length === b.decls);
    const biggest = (selector: string) =>
      pureBlocks.filter((b) => b.rule.selector === selector).sort((a, b) => b.names.length - a.names.length)[0];

    const darkLayer = biggest(":root");
    const lightLayer = biggest('html[data-theme="light"]');
    expect(darkLayer, "未找到只含 --x 声明的 :root 令牌块").toBeTruthy();
    expect(lightLayer, "未找到只含 --x 声明的浅色令牌块").toBeTruthy();
    expect(darkLayer.names.length, "深色令牌层应有数百条").toBeGreaterThan(200);
    expect(lightLayer.names.length, "浅色令牌层应与深色同量").toBe(darkLayer.names.length);

    const layerRules = new Set([darkLayer.rule, lightLayer.rule]);
    const layerNames = new Set([...darkLayer.names, ...lightLayer.names]);

    const shadowed: string[] = [];
    for (const rule of all) {
      if (layerRules.has(rule)) continue;
      for (const m of rule.body.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
        if (!layerNames.has(m[1])) continue;
        shadowed.push(`${m[1]}  @${rule.line}  ${rule.selector.slice(0, 60)}`);
      }
    }
    expect(
      [...new Set(shadowed)],
      `这些令牌名在令牌层之外已有定义，会静默改变引用它的规则或画布取色：\n${shadowed.join("\n")}`,
    ).toEqual([]);
  });

  it("深色与浅色令牌一一配对（不许只定义深色）", () => {
    const tokenNames = (block: string): Set<string> => {
      const names = new Set<string>();
      for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]);
      return names;
    };
    const darkBlock = css.slice(css.indexOf(":root {"), css.indexOf("html[data-theme=\"light\"] {"));
    const lightBlock = css.slice(css.indexOf("html[data-theme=\"light\"] {"));
    const dark = tokenNames(darkBlock);
    const light = tokenNames(lightBlock);
    const missing = [...dark].filter((name) => !light.has(name) && !name.startsWith("--tl-") && !name.startsWith("--clip-") && !name.startsWith("--pp-") && !name.startsWith("--ws-") && !name.startsWith("--dlg-") && !name.startsWith("--ctl-") && !name.startsWith("--btn-") && !name.startsWith("--vc-"));
    expect(missing, `这些令牌只有深色值，浅色主题下会漏用深色：\n${missing.join("\n")}`).toEqual([]);
  });
});