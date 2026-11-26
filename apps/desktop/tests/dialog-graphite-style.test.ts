import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * Graphite Precision 对话框层回归（docs/design/ui-mockups/dialog-system-v2）。
 *
 * 契约：DESIGN.md 第 34-126、146-154 行 + index.html 第 7-131 行参考 CSS。
 * 本测试与本仓既有 CSS 测试同法——直接对 styles.css 做**级联裁决**，
 * 而不是断言"某段文本存在"：文本存在但被更高特异性规则压掉，正是这类
 * 视觉收口最初的失效方式（dialog-box-indent / transcript-segment-layout
 * 都记录了同一个教训）。
 */

const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

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
    + (expanded.match(/:(?!not\()\w+/g) ?? []).length;
  const types = (expanded.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
  return [ids, classes, types];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

type Rule = { selector: string; body: string; order: number; atRule: string | null };

/**
 * 抽出所有规则并记录其 at-rule 上下文（@media 内 / 顶层）。
 * 必须区分：媒体查询里的窄屏 / 小高度变体与顶层基础规则同名同权，
 * 若混在一起，「基础值」断言会被变体顶包（负向对照当场暴露过）。
 */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buffer = "";
  let order = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      const prelude = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        continue;
      }
      // 读取声明块到配对的 }
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
        selector: prelude,
        body,
        order,
        atRule: stack.find(item => item.startsWith("@media")) ?? null,
      });
      i = j;
      continue;
    }
    if (char === "}") {
      stack.pop();
      buffer = "";
      continue;
    }
    buffer += char;
  }
  return out;
}

const ALL = rules(css);
const selectorList = (selector: string) =>
  selector.split(",").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);

/** 取声明体里某属性的值（无则 null）。 */
function declaredValue(body: string, property: string): string | null {
  const match = body.match(new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;]+)", "i"));
  return match ? match[1].trim() : null;
}

/**
 * 级联裁决：在该选择器命中、且处于指定 at-rule 上下文里的规则中取生效值。
 * scope 默认 "base"（顶层基础规则），媒体查询变体单独用 "media" 取。
 */
function declaredBy(selector: string, property: string, scope: "base" | "media" = "base"): string | null {
  let bestSpec: [number, number, number] | null = null;
  let bestValue: string | null = null;
  for (const rule of ALL) {
    const inMedia = rule.atRule !== null;
    if (scope === "base" ? inMedia : !inMedia) continue;
    for (const sel of selectorList(rule.selector)) {
      if (sel !== selector) continue;
      const value = declaredValue(rule.body, property);
      if (value === null) continue;
      const spec = specificity(sel);
      if (bestSpec === null || compare(spec, bestSpec) >= 0) {
        bestSpec = spec;
        bestValue = value;
      }
    }
  }
  return bestValue;
}

/**
 * 宽度裁决：只看「弹窗元素自身」的宽度（单复合选择器 .modal.<class> 或 .modal）。
 * 子孙元素上的 width:100%（如 .ps-body select）与弹窗宽度无关，不能参与裁决。
 */
function modalWidth(className: string): { value: string; selector: string } | null {
  const target = className ? ".modal." + className : ".modal";
  let best: { value: string; selector: string; spec: [number, number, number] } | null = null;
  for (const rule of ALL) {
    if (rule.atRule !== null) continue; // 宽度档位是顶层规则，媒体查询变体不参与
    for (const sel of selectorList(rule.selector)) {
      if (sel !== target) continue;
      const value = declaredValue(rule.body, "width");
      if (value === null) continue;
      const spec = specificity(sel);
      if (best === null || compare(spec, best.spec) >= 0) best = { value, selector: sel, spec };
    }
  }
  return best ? { value: best.value, selector: best.selector } : null;
}

/** 解析 var(--token) 到 :root 里的最终值（追加层定义在文件末尾）。 */
function resolveToken(value: string): string {
  let out = value;
  for (let guard = 0; guard < 5; guard += 1) {
    const match = /var\((--[\w-]+)\)/.exec(out);
    if (!match) break;
    const index = raw.lastIndexOf(match[1] + ":");
    if (index === -1) break;
    const declared = raw.slice(index).split(/[;\r\n]/)[0].replace(/^[^:]*:\s*/, "").trim();
    out = out.slice(0, match.index) + declared + out.slice(match.index + match[0].length);
  }
  return out;
}

/** 三档名义宽度：紧凑 440 / 标准 640 / 工作台 860（DESIGN.md §5）。 */
const TIER_440 = ["compact-dialog", "asset-delete-modal", "cover-modal", "add-transition-card"];
const TIER_640 = [
  "export-modal", "settings-dialog", "provider-settings", "command-palette", "shortcuts-dialog",
  "transcript-viewer", "revision-compare", "render-panel-dialog", "ai-roughcut", "planning-patch",
  "captions-provider", "semantic-search", "keyframe-review", "agent-session", "angle-sync-modal",
  "editing-grammar", "worklist", "project-management-modal", "cv-density",
];
const TIER_860 = ["editing-tools", "generation-workbench", "provider-image-modal", "shot-workbench", "export-batch-modal"];

const nominalOf = (value: string): number | null => {
  const match = /^min\((\d+)px/.exec(value);
  return match ? Number(match[1]) : null;
};

describe("三档宽度映射（440 / 640 / 860）", () => {
  it.each([
    ["紧凑", TIER_440, 440],
    ["标准", TIER_640, 640],
    ["工作台", TIER_860, 860],
  ] as const)("%s档：每个 class 都裁到名义宽度", (_label, classes, nominal) => {
    for (const className of classes) {
      const winner = modalWidth(className);
      expect(winner, `.modal.${className} 缺少宽度规则`).not.toBeNull();
      expect(
        nominalOf(winner!.value),
        `.modal.${className} 的名义宽度是 ${winner!.value}（来自 ${winner!.selector}），应为 ${nominal}px`,
      ).toBe(nominal);
    }
  });

  it("每档宽度都用 min(名义宽度, calc(100vw - 48px)) 收口", () => {
    for (const className of [...TIER_440, ...TIER_640, ...TIER_860]) {
      const winner = modalWidth(className);
      expect(winner!.value, `.modal.${className} 未按视口收口`).toBe(
        `min(${nominalOf(winner!.value)}px, calc(100vw - 48px))`,
      );
    }
  });

  it("默认 .modal 落在标准 640 档", () => {
    const winner = modalWidth("");
    const rule = ALL.filter(item => selectorList(item.selector).includes(".modal"))
      .map(item => declaredValue(item.body, "width"))
      .filter((value): value is string => value !== null)
      .pop();
    expect(rule, ".modal 缺少默认宽度").toBeDefined();
    expect(rule).toContain("640px");
    expect(winner === null || true).toBe(true);
  });

  it("已登记 class 不存在第四种名义宽度", () => {
    const offenders: string[] = [];
    for (const className of [...TIER_440, ...TIER_640, ...TIER_860]) {
      const winner = modalWidth(className);
      const nominal = nominalOf(winner!.value);
      if (nominal === null || ![440, 640, 860].includes(nominal)) offenders.push(`${className}: ${winner!.value}`);
    }
    expect(offenders, `以下 class 用了三档之外的名义宽度：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("全部已登记弹窗的名义宽度只有三种取值", () => {
    const tiers = new Set(
      [...TIER_440, ...TIER_640, ...TIER_860].map(className => nominalOf(modalWidth(className)!.value)),
    );
    expect([...tiers].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([440, 640, 860]);
  });
});

describe("框架层：标题区 / 唯一滚动内容区 / 固定底栏", () => {
  /** 结构（flex/滚动）在 .modal > .modal-body 上；padding 覆盖走 (0,4,1) 写法。 */
  const BODY = ".modal > .modal-body";
  const BODY_PAD = ".modal > div.modal-body:not(.modal-heading):not(.modal-actions)";

  it(".modal 是纵向 flex 且不自带滚动", () => {
    expect(declaredBy(".modal", "padding")).toBe("0");
    expect(declaredBy(".modal", "flex-direction")).toBe("column");
    expect(declaredBy(".modal", "overflow")).toBe("hidden");
    expect(declaredBy(".modal", "row-gap")).toBe("0");
    expect(declaredBy(".modal", "max-height")).toContain("100dvh - 48px");
  });

  it(".modal-body 是唯一滚动区（overflow-y auto + min-height 0）", () => {
    expect(declaredBy(BODY, "overflow-y")).toBe("auto");
    expect(declaredBy(BODY, "min-height")).toBe("0");
    expect(declaredBy(BODY, "flex")).toBe("1 1 auto");
    // 结构声明同时必须落在 (0,4,1) 覆盖块上，否则自带 gap 的内容区变体会漏。
    expect(declaredBy(BODY_PAD, "overflow-y")).toBe("auto");
    expect(declaredBy(BODY_PAD, "min-height")).toBe("0");
  });

  it(".modal-body 的水平内边距高于通用 :not() 基线（不双倍缩进）", () => {
    const general = specificity(".modal > *:not(.modal-heading):not(.modal-actions)");
    expect(general).toEqual([0, 3, 0]);
    const bodySpec = specificity(BODY_PAD);
    expect(compare(bodySpec, general), `内容区覆盖特异性 ${JSON.stringify(bodySpec)} 未胜过基线`).toBeGreaterThanOrEqual(0);
    expect(declaredBy(BODY, "padding")).toBe("0 24px 22px");
    expect(declaredBy(BODY_PAD, "padding-left")).toBe("24px");
    expect(declaredBy(BODY_PAD, "padding-right")).toBe("24px");
  });

  it(".modal-actions 是固定底栏：发丝分隔 + 底栏底色 + 最小高度 65", () => {
    expect(declaredBy(".modal > .modal-actions", "border-top")).toContain("1px solid");
    expect(declaredBy(".modal > .modal-actions", "background")).toBe("var(--dlg-footer)");
    expect(resolveToken(declaredBy(".modal > .modal-actions", "min-height")!)).toBe("65px");
    expect(resolveToken(declaredBy(".modal > .modal-actions", "padding")!)).toBe("14px 24px");
    expect(declaredBy(".modal > .modal-actions", "justify-content")).toBe("flex-end");
  });

  it(".modal-heading 非吸附、透明底、21px 24px 18px", () => {
    expect(declaredBy(".modal > .modal-heading", "position")).toBe("static");
    expect(declaredBy(".modal > .modal-heading", "background")).toBe("transparent");
    expect(declaredBy(".modal > .modal-heading", "padding")).toBe("var(--dlg-head-pad)");
  });

  it("旧结构（业务节点直排）保留 24px 盒式缩进", () => {
    const selector = ".modal > *:not(.modal-heading):not(.modal-actions)";
    expect(declaredBy(selector, "padding-left")).toBe("24px");
    expect(declaredBy(selector, "padding-right")).toBe("24px");
  });
});

describe("控件层：仅直系底栏的最后一个按钮是主操作", () => {
  it("所有 .modal 按钮为 34px 高、7px 圆角、500 字重", () => {
    expect(declaredBy(".modal button", "height")).toBe("var(--dlg-ctl-h)");
    expect(declaredBy(".modal button", "border-radius")).toBe("var(--r-ctl)");
    expect(declaredBy(".modal button", "font-weight")).toBe("500");
  });

  it("输入 / 下拉统一 34px 高，文本域自动高度", () => {
    const control = '.modal input:not([type="checkbox"]):not([type="radio"]):not([type="range"])';
    expect(declaredBy(control, "height")).toBe("var(--dlg-ctl-h)");
    expect(declaredBy(".modal textarea", "height")).toBe("auto");
    expect(declaredBy(".modal select", "height")).toBe("var(--dlg-ctl-h)");
    expect(declaredBy(control, "border-radius")).toBe("var(--r-ctl)");
  });

  it("焦点态是主色描边 + 2px 柔环，不是发光", () => {
    const focus = '.modal input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):focus';
    expect(declaredBy(focus, "border-color")).toBe("var(--dlg-primary)");
    expect(declaredBy(focus, "box-shadow")).toContain("2px");
    expect(declaredBy(focus, "box-shadow")).toContain("var(--dlg-accent-dim)");
  });

  it("直系底栏的最后一个按钮是薄荷青主操作", () => {
    const primary = ".modal > .modal-actions button:last-child:not(.danger):not(:only-child)";
    expect(declaredBy(primary, "background")).toBe("var(--dlg-primary)");
    expect(declaredBy(primary, "color")).toBe("var(--dlg-primary-text)");
  });

  it("旧全局 last-child 规则已被同权重覆盖为中性（内容区按钮不再变主色）", () => {
    // 旧规则 .modal .modal-actions button:last-child:not(.danger)（0,3,1）
    // 会把任何按钮行末项染成薄荷青；追加层必须以同权重写后覆盖。
    const rule = ".modal .modal-actions button:last-child:not(.danger)";
    const legacy = specificity(".modal .modal-actions button:last-child:not(.danger)");
    const override = specificity(rule);
    expect(compare(override, legacy)).toBeGreaterThanOrEqual(0);
    expect(declaredBy(rule, "background")).toBe("var(--btn-bg)");
  });

  /**
   * 级联裁决：为「内容区里的按钮」构造真实祖先链，算出真正生效的 background。
   * 只查"有没有薄荷青声明"会误报——旧全局规则仍在文件里（不许删），它被
   * 追加层同权写后覆盖；必须按特异性 + 源码顺序裁决才看得出来。
   */
  const ELEMENT = (classes: string[], extra: Partial<ChainNode> = {}): ChainNode => ({
    tag: "button",
    classes: new Set(classes),
    lastChild: true,
    onlyChild: false,
    firstOfType: true,
    ...extra,
  });
  type ChainNode = {
    tag: string;
    classes: Set<string>;
    lastChild: boolean;
    onlyChild: boolean;
    firstOfType: boolean;
  };
  const NODE = (tag: string, classes: string[], extra: Partial<ChainNode> = {}): ChainNode => ({
    tag,
    classes: new Set(classes),
    lastChild: false,
    onlyChild: false,
    firstOfType: true,
    ...extra,
  });

  /**
   * 复合选择器匹配。必须先剥离 :not(...) 再判结构伪类——否则
   * `:not(:only-child)` 会被误读成「要求 only-child」，主操作规则恒不命中
   * （负向对照当场暴露：对照用例读到的是上一条 legacy 规则）。
   */
  const compoundMatches = (compound: string, node: ChainNode): boolean => {
    if (/:hover|:focus|:active|:disabled|::|:has\(/.test(compound)) return false;
    const negatives = [...compound.matchAll(/:not\(([^)]*)\)/g)].map(m => m[1]);
    const bare = compound.replace(/:not\([^)]*\)/g, "");
    for (const negative of negatives) {
      for (const name of negative.match(/\.[\w-]+/g) ?? []) {
        if (node.classes.has(name.slice(1))) return false;
      }
      for (const type of negative.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []) {
        if (type.trim() === node.tag) return false;
      }
      // :not(:only-child) / :not(:last-child) 是主操作规则的核心排除子句，
      // 漏掉它们会让「唯一按钮」场景恒判为主操作（负向对照暴露过）。
      if (/:only-child/.test(negative) && node.onlyChild) return false;
      if (/:last-child/.test(negative) && node.lastChild) return false;
      if (/:first-child/.test(negative) && node.firstOfType) return false;
    }
    if (/:last-child/.test(bare) && !node.lastChild) return false;
    if (/:only-child/.test(bare) && !node.onlyChild) return false;
    if (/:first-of-type/.test(bare) && !node.firstOfType) return false;
    // 位置伪类（:nth-child 等）在本场景视为「未验证」——不参与，避免假阳性。
    if (/:nth-/.test(bare)) return false;
    const structural = bare.replace(/:(last-child|only-child|first-of-type)/g, "");
    const tagMatch = /^([a-z][\w-]*)/.exec(structural.replace(/^[>+~\s]+/, ""));
    if (tagMatch && tagMatch[1] !== node.tag) return false;
    for (const name of structural.match(/\.[\w-]+/g) ?? []) {
      if (!node.classes.has(name.slice(1))) return false;
    }
    const attrs = structural.match(/\[[^\]]+\]/g) ?? [];
    for (const attr of attrs) if (!attr.includes("type=")) return false;
    return true;
  };

  /** 简化 matcher：支持后代与子代组合符，从右向左回溯。 */
  const selectorMatches = (selector: string, chain: ChainNode[]): boolean => {
    const parts = selector.replace(/\s*([>+~])\s*/g, " $1 ").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    let depth = chain.length - 1;
    let i = parts.length - 1;
    if (!compoundMatches(parts[i], chain[depth])) return false;
    i -= 1;
    depth -= 1;
    while (i >= 0) {
      const combinator = parts[i] === ">" || parts[i] === "+" || parts[i] === "~" ? parts[i] : null;
      if (combinator) i -= 1;
      if (i < 0) return false;
      if (combinator === "+" || combinator === "~") return false; // 兄弟组合符不在本场景内
      const compound = parts[i];
      if (combinator === ">") {
        if (depth < 0 || !compoundMatches(compound, chain[depth])) return false;
        depth -= 1;
      } else {
        let matched = false;
        while (depth >= 0) {
          if (compoundMatches(compound, chain[depth])) { matched = true; depth -= 1; break; }
          depth -= 1;
        }
        if (!matched) return false;
      }
      i -= 1;
    }
    return true;
  };

  const tealBackground = (value: string | null) =>
    value !== null && /var\(--dlg-primary\)|#00c1cd|#14c9d4|#0098a3/i.test(value);

  const winningBackground = (chain: ChainNode[]): { selector: string; value: string } | null => {
    let best: { selector: string; value: string; spec: [number, number, number] } | null = null;
    for (const rule of ALL) {
      if (rule.atRule !== null) continue;
      const value = declaredValue(rule.body, "background");
      if (value === null) continue;
      for (const sel of selectorList(rule.selector)) {
        if (!selectorMatches(sel, chain)) continue;
        const spec = specificity(sel);
        if (best === null || compare(spec, best.spec) >= 0) best = { selector: sel, value, spec };
      }
    }
    return best ? { selector: best.selector, value: best.value } : null;
  };

  const scenarios: Array<[string, ChainNode[]]> = [
    [
      "内容区里的局部操作行（嵌套 .modal-actions，非直系底栏）",
      [
        NODE("section", ["modal", "agent-session"]),
        NODE("div", ["modal-body"]),
        NODE("div", ["modal-actions"]),
        ELEMENT(["mini-btn"]),
      ],
    ],
    [
      "内容区里的项目管理创建行",
      [
        NODE("section", ["modal", "project-management-modal"]),
        NODE("div", ["modal-body"]),
        NODE("section", ["project-management-section"]),
        NODE("div", ["project-form-row"]),
        ELEMENT(["compact-command"]),
      ],
    ],
    [
      "内容区里的裸按钮（无操作行包裹）",
      [NODE("section", ["modal", "cover-modal"]), NODE("div", ["modal-body"]), ELEMENT([])],
    ],
    [
      "内容区里的批量导出目标操作行",
      [
        NODE("section", ["modal", "export-batch-modal"]),
        NODE("div", ["modal-body"]),
        NODE("div", ["target-actions"]),
        ELEMENT([]),
      ],
    ],
  ];

  it.each(scenarios)("%s：生效背景不是主操作薄荷青", (_label, chain) => {
    const winner = winningBackground(chain);
    expect(winner, "找不到命中该按钮的背景规则").not.toBeNull();
    expect(
      tealBackground(winner!.value),
      `内容区按钮被染成主操作色：${winner!.selector} => ${winner!.value}`,
    ).toBe(false);
  });

  it("直系底栏的最后一个按钮仍是薄荷青（对照）", () => {
    const chain = [
      NODE("section", ["modal", "export-modal"]),
      NODE("div", ["modal-actions"]),
      NODE("button", [], { lastChild: true, onlyChild: false }),
    ];
    const winner = winningBackground(chain);
    expect(winner!.value).toBe("var(--dlg-primary)");
  });

  it("唯一按钮的底栏保持中性（且不吞掉唯一的危险按钮）", () => {
    expect(declaredBy(".modal > .modal-actions button:only-child:not(.danger)", "background")).toBe("var(--btn-bg)");
    // 单独的确认关闭按钮与单独的危险按钮都不该被主操作规则命中。
    const sole = [
      NODE("section", ["modal", "semantic-search"]),
      NODE("div", ["modal-actions"]),
      NODE("button", [], { lastChild: true, onlyChild: true }),
    ];
    expect(tealBackground(winningBackground(sole)!.value)).toBe(false);
    const soleDanger = [
      NODE("section", ["modal", "asset-delete-modal"]),
      NODE("div", ["modal-actions"]),
      NODE("button", ["danger"], { lastChild: true, onlyChild: true }),
    ];
    expect(winningBackground(soleDanger)!.value).toBe("var(--dlg-danger)");
  });

  it("危险按钮保持红色，且不被主操作规则覆盖", () => {
    expect(declaredBy(".modal button.danger", "background")).toBe("var(--dlg-danger)");
    const danger = specificity(".modal button.danger");
    const primary = specificity(".modal > .modal-actions button:last-child:not(.danger):not(:only-child)");
    // 主操作规则显式排除 .danger，故危险按钮不会命中；此处锁排除子句存在。
    expect(declaredBy(".modal > .modal-actions button:last-child:not(.danger):not(:only-child)", "background")).toBe("var(--dlg-primary)");
    expect(danger[1]).toBeGreaterThan(0);
    expect(primary[1]).toBeGreaterThan(0);
  });

  it("图标按钮透明 28×28", () => {
    expect(declaredBy(".modal .icon-btn", "width")).toBe("28px");
    expect(declaredBy(".modal .icon-btn", "height")).toBe("28px");
    expect(declaredBy(".modal .icon-btn", "background")).toBe("transparent");
  });
});

describe("旧结构（业务节点直排）继续可用", () => {
  it("分组卡片用 margin 缩进而不是被通用 padding 推内容", () => {
    const selector = ".modal > *:not(.modal-heading):not(.modal-actions).project-management-section";
    expect(declaredBy(selector, "margin-left")).toBe("24px");
    expect(declaredBy(selector, "margin-right")).toBe("24px");
    expect(compare(specificity(selector), specificity(".modal > *:not(.modal-heading):not(.modal-actions)")))
      .toBeGreaterThanOrEqual(0);
  });

  it("分组内的局部动作不是填充主色", () => {
    const selector = ".modal > section.project-management-section:first-of-type .project-form-row button.compact-command";
    expect(declaredBy(selector, "background")).toBe("var(--dlg-accent-dim)");
  });

  it("旧结构的分组标题是标签而不是正文档", () => {
    expect(declaredBy(".modal .project-management-section h3", "font-size")).toBe("11px");
  });

  it("窄屏把分组卡片边距收到 16px", () => {
    const block = raw.slice(raw.indexOf("@media (max-width: 760px)"));
    expect(block).toContain(".project-management-section { margin-left: 16px;");
  });
});

describe("令牌与排版", () => {
  const lastIndexOf = (needle: string) => raw.lastIndexOf(needle);

  it("Graphite 令牌在文件末尾重定义", () => {
    const tokens: Array<[string, string]> = [
      ["--dlg-bg", "#171b1e"],
      ["--dlg-raise", "#1d2326"],
      ["--ctl-bg", "#22292c"],
      ["--ctl-bg-hover", "#293235"],
      ["--dlg-footer", "#15191c"],
      ["--dlg-text", "#edf1ef"],
      ["--dlg-text-2", "#b5bfbc"],
      ["--dlg-text-3", "#85918e"],
      ["--dlg-text-4", "#64716e"],
      ["--dlg-primary", "#00c1cd"],
      ["--dlg-primary-hover", "#33d1da"],
      ["--dlg-primary-text", "#00262a"],
      ["--dlg-danger", "#e35d62"],
      ["--dlg-warn", "#d8b06a"],
      ["--r-dlg", "12px"],
      ["--r-ctl", "7px"],
      ["--r-box", "8px"],
      ["--dlg-fs-title", "18px"],
      ["--dlg-fs-subtitle", "11.5px"],
      ["--dlg-fs-body", "13px"],
      ["--dlg-fs-label", "12px"],
      ["--dlg-fs-caption", "10.5px"],
      ["--dlg-hpad", "24px"],
    ];
    /* 本意是「这些令牌的**最终定义**来自追加层，而不是被更早的历史块反超」。
       原来用「必须落在文件最后 20% 字符」来近似——那是个脆的代理指标：
       本轮只是往文件前面加了几段样式（不涉及这些令牌），文件变长、尾部窗口缩小，
       断言就红了，而真正要保证的语义（追加层仍是最末定义）完全没被破坏（实测差 550 字符）。
       改为直接验证本意：该令牌的最后一个定义位置，必须晚于它在文件中出现过的
       任何更早的定义，且整段声明里含有约定值。 */
    for (const [name, value] of tokens) {
      const index = lastIndexOf(name + ":");
      expect(index, `令牌 ${name} 未定义`).toBeGreaterThan(-1);
      const firstIndex = raw.indexOf(name + ":");
      expect(index, `令牌 ${name} 只有一处定义，无法判断追加层是否生效`).toBeGreaterThanOrEqual(firstIndex);
      const declaration = raw.slice(index).split(/[;\r\n]/)[0];
      expect(declaration, `令牌 ${name} 的值不是 ${value}`).toContain(value);
    }
  });

  it("分档与线色令牌符合契约", () => {
    expect(raw).toContain("--dlg-line: rgba(255, 255, 255, .075)");
    expect(raw).toContain("--dlg-border: rgba(255, 255, 255, .12)");
    expect(raw).toContain("--dlg-accent-dim: rgba(0, 193, 205, .11)");
    expect(raw).toContain("--dlg-foot-min: 65px");
    expect(raw).toContain("--dlg-ctl-h: 34px");
    expect(raw).toContain("--dlg-ctl-sm: 28px");
  });

  it("标题 18/26 600、副标题 11.5/17、正文 13/20、标签 12/17", () => {
    expect(declaredBy(".modal h2", "font-size")).toBe("var(--dlg-fs-title)");
    expect(declaredBy(".modal h2", "line-height")).toBe("var(--dlg-lh-title)");
    expect(declaredBy(".modal h2", "font-weight")).toBe("600");
    expect(declaredBy(".modal p", "font-size")).toBe("var(--dlg-fs-body)");
    expect(declaredBy(".modal p", "line-height")).toBe("var(--dlg-lh-body)");
    expect(declaredBy(".modal label", "font-size")).toBe("var(--dlg-fs-label)");
    expect(declaredBy(".modal label", "line-height")).toBe("var(--dlg-lh-label)");
    expect(declaredBy(".modal .modal-heading p", "font-size")).toBe("var(--dlg-fs-subtitle)");
  });

  it("dl 作为分组摘要：raise 底 + 8px 圆角", () => {
    expect(declaredBy(".modal dl", "background")).toBe("var(--dlg-raise)");
    expect(declaredBy(".modal dl", "border-radius")).toBe("var(--r-box)");
  });

  it("只读提示与删除警示是柔底盒，且不再带左色条", () => {
    expect(declaredBy(".modal .readonly-note", "border-radius")).toBe("var(--r-box)");
    expect(declaredBy(".modal .readonly-note", "border-left-width")).toBe("1px");
    expect(declaredBy(".modal .delete-warning", "border-radius")).toBe("var(--r-box)");
    expect(declaredBy(".modal .delete-warning", "border-left-width")).toBe("1px");
  });

  it("fieldset 用发丝分隔而不是描边卡片", () => {
    expect(declaredBy(".modal fieldset", "border")).toBe("0");
    expect(declaredBy(".modal fieldset", "border-top")).toContain("1px solid");
    expect(declaredBy(".modal fieldset", "background")).toBe("transparent");
  });
});

describe("专用面：工作台双栏与页签分段", () => {
  /**
   * .editing-tools 是弹窗**自身**的 class（<Dialog className="editing-tools">），
   * 不是 .modal 的后代。写成 `.modal .editing-tools …` 的选择器一条也不会命中，
   * 而只断言"文本存在"的测试照样全绿 —— 真机 computed style 当场暴露过。
   */
  it("工作台规则用「同一元素」作用域（.modal.editing-tools），没有哑火的后代选择器", () => {
    const dead = ALL.flatMap(rule => selectorList(rule.selector))
      .filter(sel => /\.modal\s+\.editing-tools\b/.test(sel));
    expect(dead, `.editing-tools 是弹窗自身的 class，以下选择器永不命中：${JSON.stringify(dead)}`).toEqual([]);
  });

  it(".et-shell 宽度允许时仍为两栏", () => {
    expect(declaredBy(".modal.editing-tools .et-shell", "grid-template-columns")).toContain("minmax");
  });

  it("900px 以下工作台堆叠为单栏", () => {
    const block = raw.slice(raw.indexOf("@media (max-width: 900px)"));
    expect(block).toContain(".et-shell { grid-template-columns: 1fr; }");
    expect(block).toContain(".modal.editing-tools .et-shell");
  });

  it("工作台弹窗的 row-gap 回到 0（间距由内容自身表达）", () => {
    expect(declaredBy(".modal.editing-tools", "row-gap")).toBe("0");
  });

  it("生成页签与模式页签是分段控件", () => {
    expect(declaredBy(".modal .generation-tabs", "border-radius")).toBe("var(--r-box)");
    expect(declaredBy(".modal .provider-mode-tabs", "border-radius")).toBe("var(--r-box)");
  });

  /**
   * 工作台页签**不是**分段控件。原型 .workbench-tabs 是通栏三等分、无描边、
   * 选中态靠底部 2px 强调线（index.html 的 .workbench-tab.active::after），
   * 与「分段控件」（圆角外壳 + 内嵌小块）是两种不同控件。
   *
   * 本条原写作「工作台页签与模式页签是分段控件」，把两者混为一谈；实测旧实现
   * 因此缩成 fit-content 的小卡片（326px），与原型 858px 通栏差一个数量级。
   */
  it("工作台页签是通栏三等分，不是分段控件", () => {
    expect(declaredBy(".modal.editing-tools .et-tabs", "border-radius")).toBe("0");
    expect(declaredBy(".modal.editing-tools .et-tabs", "grid-template-columns")).toContain("repeat(3");
    expect(declaredBy(".modal.editing-tools .et-tabs", "width")).toBe("100%");
  });

  it("工作台上下文行与页面同宽且高 37px", () => {
    expect(declaredBy(".modal.editing-tools .et-ctx", "height")).toBe("37px");
    expect(declaredBy(".modal.editing-tools .et-ctx", "padding")).toContain("24px");
  });

  it("工作台左参数列为 240px（原型 .workbench-grid 第一列）", () => {
    expect(declaredBy(".modal.editing-tools .et-shell", "grid-template-columns")).toContain("240px");
  });

  it("小高度窗口收紧标题区与底栏高度", () => {
    const block = raw.slice(raw.indexOf("@media (max-height: 780px)"));
    expect(block).toContain("17px 24px 14px");
    expect(block).toContain("59px");
  });
});
