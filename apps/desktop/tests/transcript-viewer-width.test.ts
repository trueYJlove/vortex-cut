import { describe, expect, it } from "vitest";
import { parseCssRules, readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 原始转录（transcript-viewer）— C 族审计结论（2026-11-09）。
 *
 * 这个弹窗与前面几个不同：它**本来就有较完整的样式**（20+ 条规则，含三列行结构、
 * 工具栏、响应式与两档窗口高度），且已为「时间码与正文行盒对齐」做过精细处理
 * （见 .transcript-selectable-segments .segment-row 的注释）。
 *
 * 所以本轮**刻意不重做**它，只做了两件事：
 *   1. 删掉一处死代码：width: min(620px,100%)；
 *   2. 把「宽度必须落在 640 档」锁死。
 *
 * 如实记录审计结论：行高 44 与 43 的差异来自单行/双行文本，不是缺陷；
 * 跨度列 x 唯一、分隔线一致、动作区对齐——均无需改动。
 */

const css = readDesktopStyles().replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = parseCssRules(css);
const declared = (body: string, prop: string): string | null => {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(body);
  return m ? m[1].trim() : null;
};

describe("原始转录：宽度只来自 640 档，不残留 620 死代码", () => {
  /**
   * 改造前存在两条 width 声明：
   *   line 1056  .modal.transcript-viewer { width: min(620px,100%) }
   *   line 2425  .modal.transcript-viewer, ... { width: min(640px, calc(100vw - 48px)) }
   * 后者特异性更高且位置更晚 ⇒ 620 那条从未生效，是死代码。
   * 危害：维护者按 620 理解布局，而 dialog-graphite-style.test.ts 登记的是 640 档。
   */
  it("transcript-viewer 自身不含 min(620px,100%) 声明", () => {
    // 不能断言「全局无 620px」：layout-switch / project-management-modal /
    // render-panel 等确实在用 620/560 这类名义宽度，与本弹窗无关。
    // 只锁 transcript-viewer 自己的那一条。
    const own = RULES
      .filter(r => !r.inMedia)
      .filter(r => r.selectors.includes(".modal.transcript-viewer"))
      .map(r => declared(r.body, "width"))
      .filter((w): w is string => w !== null);
    expect(own.some(w => w.includes("620px")), `transcript-viewer 仍残留 620 宽度：${JSON.stringify(own)}`).toBe(false);
  });

  it("宽度来自与其它标准档弹窗同一条规则（640 档）", () => {
    const owners = RULES
      .filter(r => !r.inMedia)
      .filter(r => r.selectors.includes(".modal.transcript-viewer"))
      .map(r => declared(r.body, "width"))
      .filter((w): w is string => w !== null);
    expect(owners.length, "transcript-viewer 应恰有一条生效的宽度声明").toBe(1);
    expect(owners[0]).toContain("min(640px");
  });
});

describe("原始转录：既有精细实现不得被破坏", () => {
  it("三列行结构保留（复选 18 / 时间码 78 / 正文 1fr）", () => {
    const row = RULES
      .filter(r => !r.inMedia)
      .find(r => r.selectors.includes(".transcript-selectable-segments .segment-row"));
    expect(row, "segment-row 规则丢失").toBeTruthy();
    expect(declared(row!.body, "grid-template-columns")).toBe("18px 78px 1fr");
  });

  it("时间码与正文共用同一行盒高度（防字号漂移）", () => {
    expect(css).toContain("line-height: calc(var(--dlg-fs-body) * 1.7)");
  });
});
