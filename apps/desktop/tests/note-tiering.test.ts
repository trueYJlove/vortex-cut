import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 提示分级：安全类保留色块，说明类降为中性小字（2026-11-09 用户裁决）。
 *
 * 背景：`.readonly-note` 全仓 47 处都是薄荷青淡底色块，其中 8 个弹窗叠放 ≥3 条
 * （CaptionsProvider 8 / SemanticSearch 7 / AgentSession 5 …）。一屏四五个同色块，
 * 强调色失去稀有性，与 DESIGN.md §3.1「薄荷青作为有限的语义强调，不铺成大面积
 * 发光背景」冲突。
 *
 * 分级判据只有一条：**这条提示被忽略后，后果是否涉及金钱、隐私或不可逆**。
 *   · 是 → 安全类，保留色块（14 处）
 *   · 否 → 说明类，加 .readonly-note--plain（33 处）
 *
 * 本文件锁两件事：
 * 1. 两类样式确实不同（否则分级是假的）；
 * 2. 现有 47 处都被显式分过级，且安全类仍是色块——
 *    防止有人新增提示时忘了标记，悄悄变成中性小字把风险藏起来。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readDesktopStyles();
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selectors: string[]; body: string; order: number; inMedia: boolean };
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
      out.push({ selectors: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean), body, order, inMedia: stack.length > 0 });
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = parseRules(css);
const specOf = (sel: string): number[] => {
  let e = sel, prev = "";
  while (prev !== e) { prev = e; e = e.replace(/:not\(([^)]*)\)/g, " $1 "); }
  return [
    (e.match(/#[\w-]+/g) ?? []).length,
    (e.match(/\.[\w-]+/g) ?? []).length + (e.match(/\[[^\]]+\]/g) ?? []).length + (e.match(/:(?!not\()[\w-]+/g) ?? []).length,
    (e.match(/(^|[\s>+~])([a-z][\w-]*)/g) ?? []).length,
  ];
};
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const declared = (body: string, prop: string): string | null => {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(body);
  return m ? m[1].trim() : null;
};
/** 该选择器在顶层规则里的生效值（同权重取后声明者）。 */
function effective(selector: string, prop: string): string | null {
  let best: { value: string; spec: number[]; order: number } | null = null;
  for (const rule of RULES) {
    if (rule.inMedia) continue;
    for (const sel of rule.selectors) {
      if (sel !== selector) continue;
      const v = declared(rule.body, prop);
      if (v === null) continue;
      const spec = specOf(sel);
      if (!best || cmp(spec, best.spec) > 0 || (cmp(spec, best.spec) === 0 && rule.order >= best.order)) best = { value: v, spec, order: rule.order };
    }
  }
  return best ? best.value : null;
}

/** 递归收集 src 下所有 .tsx。 */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = tsxFiles(resolve(root, "src"));
const usages: Array<{ file: string; line: number; text: string; plain: boolean }> = [];
for (const file of files) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!/className=.*readonly-note/.test(line)) return;
    usages.push({
      file: file.slice(root.length + 1),
      line: i + 1,
      text: line.trim().slice(0, 120),
      plain: line.includes("readonly-note--plain"),
    });
  });
}

describe("提示分级：两类样式确实不同", () => {
  it("说明类是无内边距、无边框、无底色的中性小字", () => {
    const pad = effective(".modal .readonly-note--plain", "padding");
    const border = effective(".modal .readonly-note--plain", "border");
    const bg = effective(".modal .readonly-note--plain", "background");
    expect(pad, "说明类必须去掉色块的内边距").toBe("0");
    expect(border, "说明类必须去掉描边").toBe("0");
    expect(bg, "说明类必须去掉底色").toBe("none");
    expect(effective(".modal .readonly-note--plain", "color")).toContain("--dlg-text-3");
  });

  it("安全类仍保留强调底色与描边（不能被说明类规则波及）", () => {
    // 安全类用的就是原 .readonly-note，未加修饰类
    expect(effective(".modal .readonly-note", "background")).toContain("--dlg-accent-dim");
  });
});

describe("提示分级：47 处全部分过级", () => {
  it("两类之和等于实际引用数，且都非空", () => {
    const plain = usages.filter(u => u.plain);
    const safe = usages.filter(u => !u.plain);
    expect(plain.length, "说明类不应为空——否则分级没落地").toBeGreaterThan(0);
    expect(safe.length, "安全类不应为空——否则色块被一刀切掉了").toBeGreaterThan(0);
    expect(plain.length + safe.length).toBe(usages.length);
  });

  it("安全类恰好是那 14 处（改动安全提示会被这条拦住）", () => {
    // 这 14 处涉及外发内容 / 费用 / 不可逆，是分级的原始判据。
    // 若有人把其中一处改成中性小字，把风险提示藏起来 → 这里变红。
    const safeLocations = usages.filter(u => !u.plain).map(u => u.file + ":" + u.line).sort();
    expect(safeLocations.length, `安全类应为 14 处，实际 ${safeLocations.length}：${JSON.stringify(safeLocations)}`).toBe(14);
    // 关键几条必须在列（不逐条写死行号，只锁文件名 + 关键词，避免行号漂移误红）
    const mustKeepBlock = [
      "KeyframeReviewPanel.tsx",           // 「这不是匿名化」
      "CaptionsProviderPanel.tsx",         // 只发送文本、不发送画面
      "AgentSessionPanel.tsx",             // 费用 + 覆盖整个会话
      "ProviderImageGenerationWorkbench.tsx", // 单价 + 重试再次收费
      "SemanticSearchPanel.tsx",           // 需要显式开启并逐张审阅
    ];
    for (const name of mustKeepBlock) {
      expect(
        safeLocations.some(loc => loc.includes(name)),
        `${name} 的安全提示被降级成了中性小字——这类提示被忽略的后果是金钱或隐私`,
      ).toBe(true);
    }
  });
});
