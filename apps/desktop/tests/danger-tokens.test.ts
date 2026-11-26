import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 危险语义令牌（2026-11-09）。
 *
 * ## 问题
 *
 * .modal 作用域内「危险 / 错误」语义用了 **9 种红色**，全部硬编码：
 *   #f0a1a5 / #e88b8f / #f0b9b2 / #f2b8b5 / #edb9bb / #d9b4b4 /
 *   #f2797d / #f05a5f / #ee7377
 *
 * 同一语义九种红：改一处配色要翻九个地方，改漏了也没人发现。
 * 实测还发现 #f05a5f 与 #ee7377 是两个不同的 danger hover 值——
 * 同一语义两处不一致。
 *
 * ## 为什么不用 color-mix 推导
 *
 * 试过从 --dlg-danger 线性推导，**失败**：反解配比时 #f2b8b5 需要 132%、
 * #f0b9b2 需要 128%（超出 0–100%），说明这些色不是与主色的混合，
 * 是各自挑的。硬推导会改变视觉（实测 warning 会暗 19 个色阶）。
 *
 * ## 方案
 *
 * 语义令牌，值保持原样（视觉零变化），来源收敛到一处。
 *
 * ## 本文件锁什么
 *
 * 1. 六个危险令牌都已定义；
 * 2. 上面列出的关键规则确实走令牌，不是又散回字面值；
 * 3. 危险色令牌区自身不含 #hex 以外的散落用法（防止有人新增第 10 种红）。
 */

const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { sels: string[]; body: string; order: number; inMedia: boolean };
function parseRules(source: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buffer = "";
  let order = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      const prelude = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (prelude.startsWith("@")) { stack.push(prelude); continue; }
      let depth = 1, j = i + 1, body = "";
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") { depth -= 1; if (depth === 0) break; }
        body += source[j]; j += 1;
      }
      order += 1;
      out.push({ sels: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean), body, order, inMedia: stack.length > 0 });
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = parseRules(css);

function effective(selector: string, prop: string): string | null {
  const owners = RULES.filter(r => !r.inMedia && r.sels.includes(selector));
  for (let i = owners.length - 1; i >= 0; i -= 1) {
    const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(owners[i].body);
    if (m) return m[1].trim();
  }
  return null;
}

const TOKENS = [
  "--dlg-danger-text",
  "--dlg-danger-text-soft",
  "--dlg-danger-strong",
  "--dlg-danger-muted",
  "--dlg-danger-warm",
  "--dlg-danger-calm",
];

describe("危险语义令牌：六个令牌都已定义", () => {
  it.each(TOKENS)("%s 在 :root 中有定义", (token) => {
    expect(css).toContain(token + ":");
  });

  it("令牌值是原始色值（视觉零变化，不做推导）", () => {
    // 若有人改成 color-mix(...) 推导，配比会失真——见本文件头部说明
    const rootBlock = RULES.filter(r => r.sels.includes(":root")).map(r => r.body).join("\n");
    for (const token of TOKENS) {
      const m = new RegExp(token + ":\\s*([^;]+)").exec(rootBlock);
      expect(m, token + " 未在 :root 中").toBeTruthy();
      expect(m![1].trim(), token + " 应为原始 #hex").toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("危险语义令牌：关键规则已走令牌", () => {
  const CASES: Array<[string, string]> = [
    [".modal .warning", "--dlg-danger-calm"],
    [".modal .alert-danger", "--dlg-danger-text"],
    [".modal .alert-danger span", "--dlg-danger-text-soft"],
    [".modal .delete-warning", "--dlg-danger-warm"],
    [".modal .generation-safe-error", "--dlg-danger-warm"],
    [".modal .render-job-state.bad", "--dlg-danger-muted"],
    [".modal .ps-secret-actions > button.danger", "--dlg-danger-strong"],
    [".modal .secret-actions > .btn.danger-quiet", "--dlg-danger-strong"],
  ];

  it.each(CASES)("%s 的 color 走 %s", (selector, token) => {
    const value = effective(selector, "color");
    expect(value, selector + " 缺 color 声明").toBeTruthy();
    expect(value!).toContain("var(" + token + ")");
  });
});

describe("危险语义令牌：不再新增第 10 种红", () => {
  it("危险令牌区内只有 6 个 #hex（即可预期的收敛数量）", () => {
    // 直接取「含 --dlg-danger-text 的那条 :root 规则体」，不要按字符串反查 :root，
    // 因为多个 :root 块存在，indexOf 会定位到错误的那一个。
    const block = RULES.filter(r => r.sels.includes(":root") && r.body.includes("--dlg-danger-text"))
      .map(r => r.body).join("\n");
    expect(block, "找不到危险令牌的 :root 块").not.toBe("");
    const hexes = [...block.matchAll(/#[0-9a-fA-F]{6}\b/g)].map(m => m[0].toLowerCase());
    expect(new Set(hexes).size, `危险令牌区出现 ${new Set(hexes).size} 种色值：${[...new Set(hexes)]}`).toBe(6);
  });
});
