import { describe, expect, it } from "vitest";
import { cssSpecificity as spec, parseCssRules, readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 弹窗宽度：声明的值必须等于实际生效的值（2026-11-09）。
 *
 * ## 为什么这条锁值得存在
 *
 * 样式表里存在两套宽度声明：
 *   · 每个弹窗自己的单类规则  .modal.X { width: min(XXXpx, 100%) }
 *   · 后文的统一档位规则      .modal.X, .modal.Y, ... { width: min(档位px, calc(100vw - 48px)) }
 *
 * 后者的特异性相同但位置更晚（且选择器成组），因此**恒胜**。于是前者成了死代码。
 *
 * 危险不在于"多写一行"，而在于**声明的值与真实不符**：
 * 维护者打开 .modal.ai-roughcut 看到 720px，会按 720 理解布局，
 * 而屏幕上是 640px。这类误读不会报错，只会在改样式时算错。
 *
 * 本仓已因此踩过两次（transcript-viewer 620、revision-compare 720），
 * 逐个人工发现不可持续，故改为**机器扫描全表**。
 *
 * ## 判据
 *
 * 对每个 .modal.X 的单类 width 声明，按级联规则计算实际生效值；
 * 若声明的名义宽度 ≠ 生效的名义宽度 → 红。
 * 宽高都相等（如 860 / 860）的死代码不在此列——它不误导任何人。
 */

const RULES = parseCssRules(readDesktopStyles());
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const widthOf = (body: string): string | null => {
  const m = /(?:^|;)\s*width\s*:\s*([^;]+)/.exec(body);
  return m ? m[1].trim() : null;
};
/** 名义宽度：min(XXXpx, ...) 里的 XXX。 */
const nominal = (w: string): number | null => {
  const m = /^min\((\d+)px/.exec(w);
  return m ? Number(m[1]) : null;
};

/**
 * 收集所有弹窗单类选择器。
 *
 * **2026-11-09 补漏**：原实现只匹配 `.modal.X`，漏掉了不带 .modal 前缀的写法，
 * 例如 `.project-management-modal { width: min(620px,100%) }`——它同样被后文
 * 640 档规则覆盖，却从未被扫描到。后者按 `-modal` / `-dialog` / `-card` 后缀识别。
 */
const dialogClasses = new Set<string>();
const MODAL_SUFFIX = /-(modal|dialog|card)$/;
for (const r of RULES) {
  for (const s of r.selectors) {
    const prefixed = /^\.modal\.([\w-]+)$/.exec(s);
    if (prefixed) { dialogClasses.add(prefixed[1]); continue; }
    const bare = /^\.([\w-]+)$/.exec(s);
    if (bare && MODAL_SUFFIX.test(bare[1])) dialogClasses.add(bare[1]);
  }
}

describe("弹窗宽度：声明的名义宽度必须等于实际生效的", () => {
  it("扫描全表，不存在被更高优先级规则顶掉的宽度声明", () => {
    const misleading: string[] = [];
    for (const name of dialogClasses) {
      // 一个弹窗可能同时有 .X 与 .modal.X 两种写法，都要纳入候选
      const sels = [".modal." + name, "." + name];
      const candidates = RULES
        .filter(r => !r.inMedia && sels.some(s => r.selectors.includes(s)))
        .map(r => ({ width: widthOf(r.body), spec: spec(sels.find(s => r.selectors.includes(s))!), order: r.order }))
        .filter((c): c is { width: string; spec: [number, number, number]; order: number } => c.width !== null);
      if (candidates.length < 2) continue;

      let winner = candidates[0];
      for (const c of candidates) {
        if (cmp(c.spec, winner.spec) > 0 || (cmp(c.spec, winner.spec) === 0 && c.order >= winner.order)) winner = c;
      }
      const declaredNominal = nominal(candidates[0].width);
      const effectiveNominal = nominal(winner.width);
      if (declaredNominal !== null && effectiveNominal !== null && declaredNominal !== effectiveNominal) {
        misleading.push(
          `.modal.${name}: 声明 ${declaredNominal}px 但实际生效 ${effectiveNominal}px`,
        );
      }
    }
    expect(
      misleading,
      "以下弹窗的宽度声明与实际生效值不符——维护者会按声明值理解布局：\n" + misleading.join("\n"),
    ).toEqual([]);
  });

  it("已修复的两个弹窗保持单一来源（回归锚点）", () => {
    for (const name of ["transcript-viewer", "revision-compare"]) {
      const sel = ".modal." + name;
      const widths = RULES
        .filter(r => !r.inMedia && r.selectors.includes(sel))
        .map(r => widthOf(r.body))
        .filter((w): w is string => w !== null);
      expect(widths.length, `.modal.${name} 应恰有一条 width 声明`).toBe(1);
    }
  });
});
