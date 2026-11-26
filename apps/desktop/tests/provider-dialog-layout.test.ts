import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

const css = readDesktopStyles().replace(/\/\*[\s\S]*?\*\//g, "");
function rules(selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].trim() === selector)
    .map(match => match[2]);
}

/**
 * Provider 弹窗的紧凑布局约束。
 *
 * **2026-11-09 修正**：本文件原先断言顶层宽度是 width: min(480px, calc(100vw - 64px))。
 * 但那条声明被后文 640 档的统一规则覆盖，**从未生效**——Chromium 实测渲染一直是 640px。
 * 旧断言只检查「这段文本存在」，不检查「它是否生效」，因此长期假绿。
 *
 * 640 才是对的：本弹窗 .form-grid 是两列 1fr 1fr，440 档下每列仅约 190px，
 * 放不下 API 地址与模型 ID 这类长值；DESIGN.md §5 也把「Provider 表单」
 * 列在标准 640 档。
 *
 * 全表不再出现「声明值 ≠ 生效值」由 dialog-width-single-source.test.ts 保证。
 */
describe("Provider compact layout constraints", () => {
  it("顶层宽度来自标准 640 档（不是从未生效的 480）", () => {
    // rules() 返回顶层同名规则；<=560px 窗口的 440px 收缩在 @media 内，
    // 是合理的响应式第二档，不在此断言范围。
    // rules() 是纯文本扫描，分不清顶层与 @media 内的同名规则。
    // 这里直接找那条含 640 的顶层规则——@media 里的收缩档是 440，不会误命中。
    const top = rules(".modal.provider-settings").find(rule => rule.includes("min(640px"));
    expect(top, "provider-settings 缺 640 档顶层规则").toBeTruthy();
    expect(top!).toContain("max-height: min(600px, 80dvh, calc(100dvh - 80px))");
    expect(top!).toContain("overflow: hidden");
  });

  it("内容区可滚动，标题区与底栏不随滚动消失", () => {
    expect(rules(".modal.provider-settings > .ps-body")[0]).toContain("min-height: 0");
    expect(rules(".modal.provider-settings > .ps-body")[0]).toContain("overflow-y: auto");
    expect(rules(".modal.provider-settings > .modal-heading")[0]).toContain("position: static");
    expect(rules(".modal.provider-settings > .ps-footer")[0]).toContain("position: static");
  });

  it("小窗口（<=560px）有独立的 440 收缩档", () => {
    // 440 本身没错——它是小窗口的收缩档。旧用例把它的断言挂在「桌面宽度」
    // 语义下，才产生了「桌面档应为 440」这个错误结论。
    const small = rules(".modal.provider-settings").find(rule => rule.includes("440px"));
    expect(small, "缺小窗口收紧档").toBeTruthy();
    expect(small!).toContain("max-height: min(80dvh, calc(100dvh - 48px))");
  });
});
