import { describe, expect, it } from "vitest";
import { cssSpecificity as spec, parseCssRules, readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 字号下限与命令搜索列对齐（2026-11-09，用户以截图标出）。
 *
 * ## 用户的两个问题
 *
 * 1. 红框处「空格」与右侧「可用」不对齐，且「字体太小看不清」；
 * 2. 当前用的什么字体。
 *
 * ## 实测
 *
 * - **kbd 字号 9px**；grid 第 3/4 列都是 `auto` ⇒ 列宽随内容变：
 *   kbd 左缘 3 种值（838/826/763）、右缘 2 种（868/805），
 *   状态徽章左缘 2 种（877/814）。只有最右缘齐。
 * - 全表 **25 处字号低于规范**（其中 9px ×10、9.5px ×8、8.5px ×2），
 *   而 DESIGN.md §3.2 明确写「辅助信息 10.5px / 17px」。
 *   **这 25 处里有好几处是我前几族自己写的**（kf-meta/kf-badge/angle-status/
 *   index-status），等于我引用了规范却没遵守。
 *
 * ## 字体问题的答案
 *
 * `:root { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif }`
 * 但 **Inter 未随产品捆绑**（仓库无线索字体文件），实际不命中；
 * 真正生效的是 `Segoe UI`（英文/数字）与 `Microsoft YaHei`（中文）——
 * 即**系统默认字体栈**，Inter 只是无效占位。
 */

const RULES = parseCssRules(readDesktopStyles());
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function effective(selector: string, prop: string): string | null {
  let best: { value: string; spec: number[]; order: number } | null = null;
  for (const rule of RULES) {
    if (rule.inMedia) continue;
    for (const sel of rule.selectors) {
      if (sel !== selector) continue;
      const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(rule.body);
      if (!m) continue;
      const s = spec(sel);
      if (!best || cmp(s, best.spec) > 0 || (cmp(s, best.spec) === 0 && rule.order >= best.order)) {
        best = { value: m[1].trim(), spec: s, order: rule.order };
      }
    }
  }
  return best ? best.value : null;
}

describe("字号下限：规范 10.5px，全表不得低于", () => {
  it("没有任何 font-size 小于 10.5px", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      const m = /font-size\s*:\s*([\d.]+)px/.exec(rule.body);
      if (m && parseFloat(m[1]) < 10.5) offenders.push(rule.selectors[0] + ": " + m[1] + "px");
      // font: 简写同样会设字号，实测这里曾藏了 9px
      const f = /font\s*:\s*([\d.]+)px\s/.exec(rule.body);
      if (f && parseFloat(f[1]) < 10.5) offenders.push(rule.selectors[0] + " (font 简写): " + f[1] + "px");
    }
    expect(offenders, `低于 DESIGN.md §3.2「辅助信息 10.5px」的声明：\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("命令搜索：kbd 与状态列固定宽度", () => {
  const OPT = ".modal.command-palette .command-option";

  it("四列显式：图标 20 / 名称 1fr / kbd 64 / 状态 112", () => {
    const cols = effective(OPT, "grid-template-columns");
    expect(cols).toContain("20px");
    expect(cols).toContain("minmax(0, 1fr)");
    expect(cols).toContain("64px");
    expect(cols).toContain("112px");
  });

  it("第 3/4 列不再是 auto（auto 会让列宽随内容漂移）", () => {
    const cols = effective(OPT, "grid-template-columns")!;
    // 末尾两列必须是固定 px，不是 auto
    expect(cols.trim().endsWith("112px"), `实际列定义：${cols}`).toBe(true);
  });

  it("kbd 右对齐且溢出省略（键位长短不一时右缘仍齐）", () => {
    const sel = ".modal.command-palette .command-option > kbd";
    expect(effective(sel, "justify-self")).toBe("end");
    expect(effective(sel, "text-overflow")).toBe("ellipsis");
  });

  it("状态列左对齐（左缘一致，右缘随文案长度自然不同）", () => {
    const sel = ".modal.command-palette .command-option > .command-ok";
    expect(effective(sel, "justify-self")).toBe("start");
    expect(effective(sel, "text-overflow")).toBe("ellipsis");
  });
});

describe("字体栈：Inter 未捆绑，实际用系统默认", () => {
  it("根字体栈包含系统回退（Segoe UI / Microsoft YaHei）", () => {
    const root = RULES.filter(r => !r.inMedia && r.selectors.includes(":root"))
      .map(r => /font-family\s*:\s*([^;]+)/.exec(r.body)?.[1]).filter(Boolean).join(" ");
    expect(root).toContain("Segoe UI");
    expect(root).toContain("Microsoft YaHei");
    expect(root).toContain("sans-serif");
  });
});
