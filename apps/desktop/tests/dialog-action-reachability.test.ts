import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 弹窗可操作性回归（2026-11-06 真机测量发现）。
 *
 * 背景：把所有弹窗迁到 title/body/footer 骨架后，真机 Chromium 实测暴露两处
 * 结构缺口——分步弹窗（AI 粗剪等）的操作行留在正文里，1024×720 下
 * body clientH 592 / scrollH 848，主操作滚出视野；项目管理弹窗则完全没有
 * Dialog 级底栏。两者都不是样式问题，而是「操作必须可达」的结构契约，
 * 因此用 CSS 层声明 + 组件契约双重锁定。
 *
 * 这里断言的是级联结果而不是文本存在：文本存在但被更高特异性规则压过，
 * 正是这类缺陷最初的失效方式。
 */

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readDesktopStyles();
const appSource = readFileSync(resolve(desktopRoot, "src/app/App.tsx"), "utf8");
const projectLibrarySource = readFileSync(resolve(desktopRoot, "src/app/ProjectLibraryDialog.tsx"), "utf8");
const dialogSource = readFileSync(resolve(desktopRoot, "src/app/Dialog.tsx"), "utf8");

function rules(source: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const selector = match[1].trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

const allRules = rules(css);

describe("分步弹窗的操作行必须吸附在可见区底部", () => {
  it("存在正文末个操作行的 sticky 规则", () => {
    const rule = allRules.find(
      (item) => item.selector.includes("> .modal-body > .modal-actions:last-child") && /position\s*:\s*sticky/.test(item.body),
    );
    expect(rule, "缺少分步弹窗操作行的 sticky 规则（主操作会随内容滚出视野）").toBeDefined();
    expect(rule!.body).toMatch(/bottom\s*:/);
  });

  it("该行有与底栏一致的表面、分隔线与最小高度", () => {
    const rule = allRules.find(
      (item) => item.selector.includes("> .modal-body > .modal-actions:last-child") && /position\s*:\s*sticky/.test(item.body),
    );
    expect(rule!.body).toMatch(/background\s*:\s*var\(--dlg-footer/);
    expect(rule!.body).toMatch(/border-top\s*:/);
    expect(rule!.body).toMatch(/min-height\s*:/);
  });

  it("分步弹窗这一步的末个按钮是主按钮（单按钮也算，因为该步就是主操作）", () => {
    const rule = allRules.find(
      (item) =>
        item.selector.includes("> .modal-body > .modal-actions:last-child") &&
        item.selector.includes("button:last-child:not(.danger)") &&
        /var\(--dlg-primary\)/.test(item.body),
    );
    expect(rule, "分步弹窗主操作没有主按钮样式").toBeDefined();
    // 排除「唯一按钮」正是缺陷成因：单按钮步骤会被降级成中性灰。
    expect(rule!.selector).not.toContain(":only-child");
  });
});

describe("Dialog 骨架契约", () => {
  it("提供 title 时才渲染标题/内容/底栏三段，未提供时保持旧结构", () => {
    expect(dialogSource).toMatch(/framed\s*\?/);
    expect(dialogSource).toMatch(/modal-body/);
    expect(dialogSource).toMatch(/footer !== undefined/);
  });

  it("Escape 与 Tab 不会泄漏到嵌套的父级 Dialog", () => {
    expect(dialogSource).toMatch(/event\.stopPropagation\(\)/);
    expect(dialogSource).toMatch(/closest\('[^']*role="dialog"/);
  });
});

describe("持有全局操作的弹窗必须有真实底栏", () => {
  it("项目管理通过 ProjectLibraryDialog 将归档操作放在卡片 footer，而不是正文段落里", () => {
    expect(appSource, "App.tsx 缺少 ProjectLibraryDialog 入口").toContain("<ProjectLibraryDialog");
    expect(projectLibrarySource, "找不到项目管理弹窗").toContain('title="项目管理"');
    expect(projectLibrarySource, "项目管理卡片缺少 footer 操作栏").toContain('className="project-library-card-actions"');
    expect(projectLibrarySource).toMatch(/onToggleArchive\(project\)/);
  });

  it("项目管理正文里不再残留内嵌的 modal-actions 操作行", () => {
    expect(projectLibrarySource).not.toContain('className="modal-actions"');
  });
});

describe("Provider 管理视图：危险动作不得压过底栏主操作", () => {
  it("「删除配置」是红字次级按钮，不是实心红块", () => {
    const rule = allRules.find(
      (item) => item.selector.includes(".ps-secret-actions") && item.selector.includes("button.danger") && /border\s*:/.test(item.body),
    );
    expect(rule, "删配置缺少次级危险样式（会退回实心红块）").toBeDefined();
    expect(rule!.body).toMatch(/background\s*:\s*transparent/);
  });

  it("密钥操作统一为 28px 次级尺寸，不与底栏主操作同级", () => {
    const rule = allRules.find(
      (item) => item.selector.includes(".ps-secret-actions") && /height\s*:\s*var\(--dlg-ctl-sm/.test(item.body),
    );
    expect(rule, "密钥操作行缺少 28px 尺寸约束").toBeDefined();
  });

  it("详情摘要卡用规范分组容器，且特异性压过历史 70px 网格", () => {
    const matches = allRules.filter(
      (item) => item.selector.includes(".modal.provider-settings .ps-details") && /grid-template-columns/.test(item.body),
    );
    // 末条胜出：规则必须落在文件尾部才能压过第 1064 行的历史 70px 网格。
    const rule = matches[matches.length - 1];
    expect(rule, "缺少 provider-settings 专用详情卡规则（旧 70px 网格会胜出）").toBeDefined();
    expect(rule!.body).toMatch(/76px/);
  });
});
