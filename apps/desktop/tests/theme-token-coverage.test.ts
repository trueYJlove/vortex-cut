import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

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
  const css = readDesktopStyles();
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

  it("悬停底不得与它所在容器的底色同色（否则深色下 hover 完全不可见）", () => {
    // 真实缺陷（2026-11-15 用户截图）：项目下拉列表鼠标滑动时浅色有 hover、
    // 深色看不见。实测根因：.project-switcher-dropdown > button:hover 用
    // --ws-raise，而 --ws-raise 正是该下拉面板自己的底色
    // （.editor-shell .project-switcher-dropdown { background: var(--ws-raise) }）
    // ⇒ 深色下 hover 前后同为 rgb(32,32,36)，对比 1.00，等于没有 hover。
    // 浅色下"正常"纯属巧合：[data-theme="light"] button:hover:not(:disabled)
    // 抢先把底色改成 --ctl-bg-hover(#e8e8ea)，才让它碰巧可见。
    //
    // 判据（精确到容器祖先，不做全局"面板"猜测）：
    //   对每条含 :hover 的规则，取它的基本选择器（去掉 :hover 及其后的
    //   伪类/状态），若基本选择器形如「容器 > 元素」，取「容器」；否则取
    //   选择器最后一段之前的部分作为容器。再在样式表里找"以该容器结尾"的
    //   非 hover 规则，若它与 hover 用的是同一个 background 令牌，即判失败。
    //
    // 两个写错会导致守卫恒真的坑，都踩过：
    //  1. 拿 ":hover" 去匹配 rule.body（选择器不在 body 里）——恒空；
    //  2. 用「选择器里含 panel/dropdown 字样」当容器判据——会把
    //     .pp-panel .pp-sub.pp-active 这类「选中态底色」误判成面板底色，
    //     于是 --ctl-bg-hover 全表命中，守卫变成满地假红。
    const bgToken = (body: string): string | null => {
      const m = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*var\((--[a-z0-9-]+)/);
      return m ? m[1] : null;
    };
    const splitSelectors = (sel: string) =>
      sel.split(",").map((s) => s.trim()).filter(Boolean);

    /** 由 hover 规则的某个选择器推出它所在的容器选择器尾巴。 */
    const containerOf = (sel: string): string | null => {
      const base = sel.replace(/:hover.*$/, "").trim();
      if (!base) return null;
      const gt = base.lastIndexOf(">");
      if (gt > 0) return base.slice(0, gt).trim();
      const parts = base.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return null;
      return parts.slice(0, -1).join(" ");
    };

    /** 容器尾巴 -> 该容器用到的背景令牌集合。 */
    const containerTokens = new Map<string, Set<string>>();
    for (const rule of all) {
      if (rule.selector.includes(":hover")) continue;
      const token = bgToken(rule.body);
      if (!token) continue;
      for (const sel of splitSelectors(rule.selector)) {
        if (!containerTokens.has(sel)) containerTokens.set(sel, new Set());
        containerTokens.get(sel)!.add(token);
      }
    }
    expect(containerTokens.size, "未收集到任何容器背景令牌（判据本身失效）").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rule of all) {
      if (!rule.selector.includes(":hover")) continue;
      const token = bgToken(rule.body);
      if (!token) continue;
      for (const sel of splitSelectors(rule.selector)) {
        if (!sel.includes(":hover")) continue;
        const container = containerOf(sel);
        if (!container) continue;
        const tail = container.split(/\s+/).pop()!;
        for (const [cSel, tokens] of containerTokens) {
          if (!tokens.has(token)) continue;
          if (!cSel.split(/\s+/).pop()!.replace(/,/g, "").endsWith(tail)) continue;
          if (cSel === sel.replace(/:hover.*$/, "").trim()) continue;
          offenders.push(
            `L${rule.line}  ${sel.slice(0, 60)}  ::  hover 底 ${token} 与容器 ${cSel.slice(0, 46)} 相同`,
          );
        }
      }
    }
    expect(
      [...new Set(offenders)],
      `这些 :hover 规则的底色与它所在容器的底色是同一个令牌，悬停前后没有视觉变化：\n${offenders.join("\n")}`,
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

  it("P220：--vc-accent 仅作为 --dlg-primary 的单源别名，不得出现颜色字面量或重复定义", () => {
    const declarations: Array<{ selector: string; value: string; line: number }> = [];
    for (const rule of all) {
      for (const m of rule.body.matchAll(/(?:^|;)\s*--vc-accent\s*:\s*([^;]+)/g)) {
        declarations.push({
          selector: rule.selector,
          value: m[1].replace(/\s+/g, ""),
          line: rule.line,
        });
      }
    }
    expect(declarations, "应恰好只在 :root 保留一处 --vc-accent 别名定义").toHaveLength(1);
    expect(declarations[0].selector).toBe(":root");
    expect(declarations[0].value).toBe("var(--dlg-primary)");

    const hasDlgPrimary = (selector: string) =>
      all.some(
        (rule) =>
          rule.selector === selector &&
          /(?:^|;)\s*--dlg-primary\s*:\s*#[0-9a-fA-F]{3,8}/.test(rule.body),
      );
    expect(hasDlgPrimary(":root"), ":root 必须定义 --dlg-primary").toBe(true);
    expect(
      hasDlgPrimary('html[data-theme="light"]'),
      'html[data-theme="light"] 必须定义 --dlg-primary',
    ).toBe(true);
  });
});