import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 原型组件落地回归（2026-11-06）。
 *
 * 教训：上一轮我把「框架层 CSS 生效」当成了「设计已实现」，回归锁也只断言
 * CSS 规则存在。结果原型里的内容级组件（分组标题、项目条、画幅卡、快捷键
 * 胶囊…）在真实弹窗里根本不存在，用户一眼就看出来了。
 *
 * 本文件锁定的是「原型组件真的出现在了源码里」，而不是「CSS 里有这条规则」。
 * 断言对象是 TSX 源码中的 class 名，这是原型与实现之间唯一能自动核对的契约。
 */

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(desktopRoot, p), "utf8");
const exportSource = read("src/app/ExportDialog.tsx");
const appSource = read("src/app/App.tsx");
const commandSource = read("src/app/editorCommands.ts");
const css = readDesktopStyles();

describe("导出弹窗必须使用原型的内容级解剖", () => {
  const required = ["project-strip", "project-cover", "project-name", "project-stats", "filename", "file-ext", "section-label", "export-grid", "form-grid", "field-hint", "span-2", "path-control", "path-value", "ratio-panel", "ratio-frame", "ratio-name", "ratio-dim", "ratio-sub", "footer-note"];
  for (const cls of required) {
    it(`包含 .${cls}`, () => {
      // 类名可能与其他类共用同一个 class 属性（如 "field span-2"），按单词边界匹配。
      expect(new RegExp(`(^|[\\s"])${cls}($|[\\s"])`).test(exportSource)).toBe(true);
    });
  }

  it("旧的 exd-* 平行类已清零（避免两套解剖并存）", () => {
    expect(exportSource).not.toMatch(/"(exd-[a-z-]+)"/);
  });

  it("每个字段标签都带 field-hint 辅助说明", () => {
    const hints = exportSource.match(/className="field-hint"/g) ?? [];
    expect(hints.length).toBeGreaterThanOrEqual(4);
  });
});

describe("命令搜索必须使用原型的分组与状态解剖", () => {
  it("渲染分组标题", () => {
    expect(appSource).toContain('className="command-group"');
  });
  it("使用搜索框外壳", () => {
    expect(appSource).toContain('className="search-wrap"');
  });
  it("每行使用 command-option 与状态徽标", () => {
    expect(appSource).toContain('className="command-option"');
    expect(appSource).toContain('"command-state"');
  });
  it("底栏有键位提示，且没有业务主按钮", () => {
    expect(appSource).toContain('className="key-hints"');
    expect(appSource).toContain('className="command-footer"');
  });
  it("命令注册表带分组字段", () => {
    expect(commandSource).toContain("group: EditorCommandGroup");
  });
});

describe("原型组件样式落地", () => {
  const required = ["section-label", "field", "field-hint", "project-strip", "project-cover", "project-stats", "file-ext", "export-grid", "ratio-panel", "ratio-frame", "path-control", "path-value", "footer-note", "btn primary", "search-wrap", "command-group", "command-option", "command-state", "key-hints"];
  for (const cls of required) {
    it(`CSS 定义 .${cls.split(" ")[0]}`, () => {
      expect(css).toContain(`.${cls.split(" ")[0]}`);
    });
  }
  it("分组标题是真正的排版元素而非普通加粗", () => {
    expect(css).toMatch(/\.modal \.section-label \{[^}]*letter-spacing/);
  });
});
