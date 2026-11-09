import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 原型保真度回归（2026-11-06 用户两次指出"没 1:1 实现"之后新增）。
 *
 * 为什么需要它：前两轮的锁只断言"组件存在"和"CSS 规则存在"，
 * 而真实缺陷是**存在但取值不对**——命令面板 520px 而非 640px、
 * 搜索框 34px 而非 40px、行是 2 列而非 4 列、底栏右对齐而非左对齐。
 * 存在性检查对这类缺陷完全无效。
 *
 * 本文件锁定三类信息：
 *   ① 原型 CSS 的权威取值（从 index.html 直接解析，不手抄）；
 *   ② 实现 CSS 中存在能压过历史规则的最终声明；
 *   ③ 结构上真实渲染出对应节点（图标槽/分组/键位提示）。
 */

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktopRoot, "../..");
const prototype = readFileSync(resolve(root, "docs/ui-mockups/dialog-system-v2/index.html"), "utf8");
const css = readFileSync(resolve(desktopRoot, "src/styles.css"), "utf8");
const appSource = readFileSync(resolve(desktopRoot, "src/app/App.tsx"), "utf8");

/** 从原型 <style> 中取某选择器块的属性值（最后一个匹配即原型最终态）。 */
function prototypeProp(selector: string, prop: string): string | null {
  const style = prototype.slice(prototype.indexOf("<style>"), prototype.indexOf("</style>"));
  const out: string[] = [];
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() !== selector) continue;
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (decl) out.push(decl[1].trim());
  }
  return out.length ? out[out.length - 1] : null;
}

/** 实现 CSS 中某属性最后一次声明（后写胜出，近似级联最终值）。 */
function lastDeclaration(predicate: (selector: string) => boolean, prop: string): string | null {
  const out: string[] = [];
  // 先剥离 @media 块：小窗口的降级值（84px 封面 / 单列网格）不是桌面终值。
  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    if (!predicate(selector)) continue;
    const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (decl) out.push(decl[1].trim());
  }
  return out.length ? out[out.length - 1] : null;
}

describe("命令搜索：取值必须与原型一致（非仅存在）", () => {
  it("原型确实规定了 640px 面板与 40px 搜索框（基准值防漂移）", () => {
    expect(prototype).toContain(".command-dialog{--dialog-width:640px}");
    expect(prototypeProp(".search-wrap input", "height")).toBe("40px");
  });

  it("面板最终宽度声明为 640px，且 max-width 不能把宽度压回去", () => {
    // 同一条规则同时声明 max-width:none 与 width:min(640px…)，取含 width 的最后一条。
    const rule = css.split("\n").filter(l => l.trim().startsWith(".modal.command-palette {") && l.includes("max-width: none"));
    expect(rule.length, "缺少同时覆盖 max-width 与 width 的终值规则").toBeGreaterThan(0);
    expect(rule[rule.length - 1]).toContain("640px");
    expect(rule[rule.length - 1]).toContain("max-width: none");
  });

  it("搜索框最终高度 40px（旧规则 34px 必须被压过）", () => {
    const height = lastDeclaration(
      s => s.includes(".modal.command-palette") && s.includes("search-wrap") && s.includes('input[type="search"]'),
      "height",
    );
    expect(height).toBe("40px");
  });

  it("行网格是 4 列（图标·标签·快捷键·状态），不是 2 列", () => {
    const cols = lastDeclaration(s => s.includes(".command-option") && !s.includes("hover"), "grid-template-columns");
    expect(cols).toContain("20px");
    expect(cols?.split(" ").length).toBeGreaterThanOrEqual(4);
  });

  it("底栏键位提示左对齐（原型 flex-start）", () => {
    const justify = lastDeclaration(s => s.includes("command-footer") && s.includes("modal-actions"), "justify-content");
    expect(justify).toBe("flex-start");
  });

  it("每行真实渲染图标槽", () => {
    expect(appSource).toContain("COMMAND_ICON_MAP");
    expect(appSource).toMatch(/COMMAND_ICON_MAP\[command\.id\]/);
  });
});

describe("导出弹窗：取值必须与原型一致", () => {
  it("项目封面 112×70、文件名后缀列 42px（原型值）", () => {
    expect(prototypeProp(".project-cover", "width")).toBe("112px");
    expect(prototypeProp(".project-cover", "height")).toBe("70px");
    // .project-cover 的 img/svg 是 width:100%，只取按钮自身那条。
    const coverRule = lastDeclaration(s => s === ".modal .project-cover", "width");
    expect(coverRule, "缺少 .modal .project-cover 宽度声明").toBe("112px");
    const cols = lastDeclaration(s => s.includes(".modal .filename"), "grid-template-columns");
    expect(cols).toContain("42px");
  });

  it("导出网格是「表单 + 126px 画幅卡」两列", () => {
    const cols = lastDeclaration(s => s.includes(".modal .export-grid"), "grid-template-columns");
    expect(cols).toContain("126px");
  });

  it("小窗口下画幅卡折叠、表单单列（原型降级行为）", () => {
    expect(css).toMatch(/max-width: 760px\)[\s\S]{0,400}?\.modal \.export-grid \{ grid-template-columns: 1fr/);
  });
});

describe("高度保真：正文布局与底栏高度必须与原型一致", () => {
  it("导出正文是块级布局，不使用 gap（否则与子元素 margin 叠加，多出 22px）", () => {
    const rule = lastDeclaration(s => s.includes(".modal-body") && s.includes("project-strip"), "display");
    expect(rule, "缺少让导出正文回到块级布局的规则").toBe("block");
  });

  it("分组标题 margin-bottom 为 13px，需用 h3.section-label 压过 .modal h3", () => {
    const mb = lastDeclaration(s => s.includes("h3.section-label"), "margin");
    expect(mb).toContain("13px");
  });

  it("命令面板底栏是 44px 提示条，而不是 65px 操作底栏", () => {
    const minH = lastDeclaration(s => s.includes("command-footer") && s.includes("modal-actions"), "min-height");
    expect(minH).toBe("44px");
  });
});

describe("命令面板几何：逐元素高度必须等于原型实测值", () => {
  // 原型实测（1440×900，Chrome）：507 = header 82 + body 379 + footer 44
  it("header 内边距为 21/24/14（通用 18px 底会让它高 4px）", () => {
    expect(css).toMatch(/\.modal\.command-palette > \.modal-heading \{ padding: 21px 24px 14px/);
  });

  it("body 内边距底部为 14px，且必须是块级布局（grid+gap 会高 20px）", () => {
    const pad = lastDeclaration(
      s => s.includes(".modal.command-palette") && s.includes("modal-body") && s.includes(":not("),
      "padding",
    );
    expect(pad, "命令面板正文缺少 14px 底部内边距覆盖").toContain("14px");
    const display = lastDeclaration(
      s => s.includes(".modal.command-palette") && s.includes("modal-body") && s.includes(":not("),
      "display",
    );
    expect(display).toBe("block");
  });

  it("底栏 44px、选项行 39px、列表上限 315px", () => {
    expect(css).toMatch(/\.modal > \.modal-actions:has\(> \.command-footer\) \{[\s\S]{0,200}?min-height: 44px/);
    expect(css).toMatch(/\.modal\.command-palette \.command-option \{[\s\S]{0,300}?height: 39px/);
    expect(css).toMatch(/\.modal\.command-palette \.command-option \{[\s\S]{0,400}?display: grid/);
    expect(css).toMatch(/\.modal \.command-list \{ max-height: 315px/);
  });

  it("分组标题 26px 高（9px/10px/5px 内边距）", () => {
    expect(css).toMatch(/\.modal\.command-palette \.command-group \{ padding: 9px 10px 5px/);
  });
});

describe("Provider 与确认框：结构与几何对齐原型", () => {
  const providerSource = readFileSync(resolve(desktopRoot, "src/app/provider-settings/ProviderSettingsDialog.tsx"), "utf8");

  it("Provider 使用原型的 mode-tab / privacy-line / form-grid / provider-note", () => {
    for (const cls of ["mode-tabs", "mode-tab", "privacy-line", "form-grid", "field", "provider-note", "footer-link"]) {
      expect(providerSource, `Provider 缺少 .${cls}`).toContain(cls);
    }
  });

  it("Provider 页签有激活圆点与 31px 高度（原型特征）", () => {
    expect(css).toMatch(/\.modal \.mode-tab\.active::before \{[^}]*background: var\(--dlg-primary\)/);
    expect(css).toMatch(/\.modal \.mode-tab \{[\s\S]{0,200}?height: 31px/);
  });

  it("Provider 正文块级布局、form-grid 两列 15/16 间距", () => {
    expect(css).toMatch(/\.modal\.provider-settings > div\.modal-body:not\(\.modal-heading\):not\(\.modal-actions\) \{[^}]*display: block/);
    expect(css).toMatch(/\.modal\.provider-settings \.form-grid \{[^}]*gap: 15px 16px/);
  });

  it("确认框使用 confirm-object / warning / btn danger", () => {
    expect(appSource).toContain('className="confirm-object"');
    expect(appSource).toContain('className="warning"');
    expect(appSource).toContain('className="btn danger"');
  });

  it("确认框 header 为 21/24/13（原型无副标题时更紧）", () => {
    expect(css).toMatch(/\.modal\.asset-delete-modal > \.modal-heading \{ padding: 21px 24px 13px/);
  });

  it("warning 是柔性提示框，不再用左侧色条（原型无左边框）", () => {
    expect(css).toMatch(/\.modal \.warning \{[\s\S]{0,220}?border: 0/);
  });
});

describe("Provider 三处用户反馈修正（2026-11-06）", () => {
  const providerSource = readFileSync(resolve(desktopRoot, "src/app/provider-settings/ProviderSettingsDialog.tsx"), "utf8");

  it("模型 ID 与 API 协议在同一行（都不是 span-2），API 密钥在最后", () => {
    // 只认新建表单里的字段行，避免命中错误文案中的同名字样。
    const formStart = providerSource.indexOf('aria-label="新建 Provider"');
    const formEnd = providerSource.indexOf('className="provider-note"', formStart);
    const form = providerSource.slice(formStart, formEnd);
    const protocolIdx = form.indexOf("<label>API 协议</label>");
    const modelIdx = form.indexOf("<label>模型 ID</label>");
    const keyIdx = form.indexOf("API 密钥");
    expect(protocolIdx).toBeGreaterThan(0);
    expect(modelIdx).toBeGreaterThan(protocolIdx);
    expect(keyIdx, "API 密钥必须在模型 ID 之后（原型顺序）").toBeGreaterThan(modelIdx);
    // 协议与模型都不带 span-2，才能各占半栏同行
    const protocolLine = form.slice(form.lastIndexOf("<div", protocolIdx), protocolIdx);
    const modelLine = form.slice(form.lastIndexOf("<div", modelIdx), modelIdx);
    expect(protocolLine).not.toContain("span-2");
    expect(modelLine).not.toContain("span-2");
  });

  it("管理视图使用 detail-panel / secret-actions / danger-quiet", () => {
    for (const cls of ["detail-panel", "secret-actions", "danger-quiet"]) {
      expect(providerSource, `管理视图缺少 .${cls}`).toContain(cls);
    }
  });

  it("错误提示是显著警示块，不再与普通状态同款", () => {
    expect(providerSource).toContain('className="alert alert-danger"');
    expect(providerSource).toContain("无法完成操作");
    expect(css).toMatch(/\.modal \.alert-danger \{[\s\S]{0,200}?border-color: rgba\(227, 93, 98/);
    expect(css).toMatch(/\.modal \.alert-danger > \.icon \{ color: var\(--dlg-danger\)/);
  });

  it("危险操作靠右并与密钥操作拉开距离", () => {
    expect(css).toMatch(/\.modal \.secret-actions > \.btn\.danger-quiet \{[\s\S]{0,120}?margin-left: auto/);
  });
});
