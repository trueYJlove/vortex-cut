import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * .modal 作用域内的硬编码色值必须为零（2026-11-09 完成）。
 *
 * ## 为什么定这个标准
 *
 * 起点是 71 处硬编码（含 14 处 var() 兜底），去掉兜底后 57 处。分三轮收敛：
 *
 *  1. 危险色 9 种红 → 6 个语义令牌（#f0a1a5 / #e88b8f / ...）
 *  2. 凹陷底 5 个近似深色 → --dlg-inset*；滚动条 → --dlg-scroll-thumb；
 *     两个不一致的 danger hover → --dlg-danger-hover
 *  3. 删掉真死代码（旧全局 danger、第一代 .modal danger、旧 .modal 基础块），
 *     余下独立装饰色建令牌（封面渐变、进度条、纯白文字）
 *
 * 结果：**.modal 作用域内硬编码色值 0 处**。
 *
 * ## 判据细节
 *
 * 排除 `var(--token, #fallback)` 形态——那是**有意的兜底**，不是硬编码；
 * 把它改成 var(--token) 反而会削弱健壮性。本测试只抓"裸字面值"。
 *
 * ## 删除死代码的两条纪律（本轮踩过）
 *
 * 1. 删除前必须**逐属性计算并比对**：曾以为第 241 行整行是死代码，
 *    实测发现删掉后 .readonly-segments 的列宽从 108px 变 auto——
 *    那条长行里混着仍在生效的规则，只能精确删片段，不能整行删。
 * 2. 同一选择器出现多次时，按"特异性 → 声明顺序"判定谁生效，
 *    不能凭位置直觉。
 */

const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { sels: string[]; body: string; line: number };
function modalRules(source: string): Rule[] {
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
      if (prelude.includes(".modal")) {
        out.push({ sels: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()), body, line: 0 });
      }
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = modalRules(css);

/** 取出规则体里「不在 var() 兜底位」的裸 #hex 字面值。 */
function bareHexes(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const before = body.slice(Math.max(0, m.index! - 64), m.index!);
    // 形如 var(--x, 的是兜底位，跳过
    if (/var\(--[\w-]+,\s*$/.test(before)) continue;
    out.push(m[0]);
  }
  return out;
}

describe(".modal 作用域：硬编码色值必须为零", () => {
  it("没有任何裸 #hex 字面值", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      const bare = bareHexes(rule.body);
      if (bare.length) offenders.push(`${rule.sels[0]}: ${bare.join(", ")}`);
    }
    expect(
      offenders,
      `.modal 作用域仍有硬编码色值（应改用令牌）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("var() 兜底值仍被保留（不是被一刀切删掉）", () => {
    // 兜底是有意的健壮性设计；本仓大量使用 var(--vc-accent, #25d3ac) 形态。
    // 若有人把兜底也删了，这条会提醒：删兜底不是本次治理的目标。
    const fallbacks = [...css.matchAll(/var\(--[\w-]+,\s*#[0-9a-fA-F]{3,8}\s*\)/g)];
    expect(fallbacks.length, "兜底值不应被清空").toBeGreaterThan(0);
  });
});

describe(".modal 作用域：语义令牌已定义", () => {
  const TOKENS = [
    "--dlg-danger-text", "--dlg-danger-text-soft", "--dlg-danger-strong",
    "--dlg-danger-muted", "--dlg-danger-warm", "--dlg-danger-calm",
    "--dlg-danger-hover", "--dlg-danger-ink", "--dlg-danger-deep",
    "--dlg-inset", "--dlg-inset-2", "--dlg-inset-3", "--dlg-inset-4", "--dlg-inset-5",
    "--dlg-scroll-thumb", "--dlg-run-accent", "--dlg-track", "--dlg-success-soft",
    "--dlg-cover-bg", "--dlg-cover-a", "--dlg-cover-b", "--dlg-cover-c", "--dlg-ink",
  ];
  it.each(TOKENS)("%s 在 :root 中定义", (token) => {
    expect(css, token + " 未定义").toContain(token + ":");
  });
});
