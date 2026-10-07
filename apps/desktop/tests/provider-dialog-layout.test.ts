import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function rules(selector: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].trim() === selector)
    .map(match => match[2]);
}

describe("Provider compact layout constraints", () => {
  it("caps desktop dialog width and viewport-relative height", () => {
    const rule = rules(".modal.provider-settings")[0];
    expect(rule).toContain("width: min(480px, calc(100vw - 64px))");
    expect(rule).toContain("max-height: min(600px, 80dvh, calc(100dvh - 80px))");
    expect(rule).toContain("overflow: hidden");
  });

  it("keeps content scrollable without scrolling away header and actions", () => {
    expect(rules(".modal.provider-settings > .ps-body")[0]).toContain("min-height: 0");
    expect(rules(".modal.provider-settings > .ps-body")[0]).toContain("overflow-y: auto");
    expect(rules(".modal.provider-settings > .modal-heading")[0]).toContain("position: static");
    expect(rules(".modal.provider-settings > .ps-footer")[0]).toContain("position: static");
  });

  it("also preserves viewport margins at small window sizes", () => {
    const small = rules(".modal.provider-settings")[1];
    expect(small).toContain("width: min(440px, calc(100vw - 40px))");
    expect(small).toContain("max-height: min(80dvh, calc(100dvh - 48px))");
  });
});
