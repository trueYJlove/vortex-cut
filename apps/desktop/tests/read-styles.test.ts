import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cssSpecificity,
  expandStylesFile,
  extractCssBlocks,
  parseCssRules,
} from "./helpers/read-styles.js";

const tempDirs: string[] = [];

function createTempStylesDir(): string {
  const dir = join(tmpdir(), `aivideo-styles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const stylesDir = join(dir, "src", "styles");
  mkdirSync(stylesDir, { recursive: true });
  tempDirs.push(dir);
  return stylesDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-styles helpers", () => {
  it("supports diamond @import graphs while still rejecting circular @imports", () => {
    const stylesDir = createTempStylesDir();
    writeFileSync(join(stylesDir, "tokens.css"), ":root { --a: 1; }", "utf8");
    writeFileSync(join(stylesDir, "left.css"), '@import "./tokens.css";\n.left { color: red; }', "utf8");
    writeFileSync(join(stylesDir, "right.css"), '@import "./tokens.css";\n.right { color: blue; }', "utf8");
    writeFileSync(join(stylesDir, "diamond.css"), '@import "./left.css";\n@import "./right.css";', "utf8");

    const expanded = expandStylesFile(join(stylesDir, "diamond.css"));
    expect(expanded).toContain(":root { --a: 1; }");
    expect(expanded).toContain(".left { color: red; }");
    expect(expanded).toContain(".right { color: blue; }");

    writeFileSync(join(stylesDir, "cycle-a.css"), '@import "./cycle-b.css";', "utf8");
    writeFileSync(join(stylesDir, "cycle-b.css"), '@import "./cycle-a.css";', "utf8");
    expect(() => expandStylesFile(join(stylesDir, "cycle-a.css"))).toThrow(/Circular CSS @import detected/);
  });

  it("skips @keyframes and @-webkit-keyframes blocks cleanly", () => {
    const css = `
      .before { color: red; }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @-webkit-keyframes pulse {
        from { opacity: 0.2; }
        50% { opacity: 1; }
      }
      @media (max-width: 760px) {
        @keyframes nested-spin { to { transform: rotate(360deg); } }
        .mobile-only { display: block; }
      }
      .after { color: blue; }
    `;
    const parsed = parseCssRules(css);
    expect(parsed.map(rule => rule.selector)).toEqual([".before", ".mobile-only", ".after"]);
    expect(parsed.find(rule => rule.selector === ".mobile-only")?.inMedia).toBe(true);
    expect(parsed.find(rule => rule.selector === ".after")?.inMedia).toBe(false);
    expect(extractCssBlocks(css).map(block => block.selector)).toEqual([".before", ".mobile-only", ".after"]);
  });

  it("computes CSS Selectors Level 4 specificity accurately", () => {
    expect(cssSpecificity(":where(button)")).toEqual([0, 0, 0]);
    expect(cssSpecificity(".pp-panel :where(button)")).toEqual([0, 1, 0]);
    expect(cssSpecificity(".pp-panel :where(button):hover:not(:disabled)")).toEqual([0, 3, 0]);
    expect(cssSpecificity("::before")).toEqual([0, 0, 1]);
    expect(cssSpecificity("input::placeholder")).toEqual([0, 0, 2]);
    expect(cssSpecificity(".modal ::-webkit-scrollbar-thumb")).toEqual([0, 1, 1]);
    expect(cssSpecificity('[data-url="https://a.b#c:d.e"]')).toEqual([0, 1, 0]);
    expect(cssSpecificity(":not(:nth-child(2n+1))")).toEqual([0, 1, 0]);
    expect(cssSpecificity(".modal.captions-provider:not(:has(> .modal-actions))")).toEqual([0, 3, 0]);
    expect(cssSpecificity(":not(.a, #b)")).toEqual([1, 0, 0]);
  });
});
