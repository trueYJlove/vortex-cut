import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesktopStyles } from "./helpers/read-styles.js";

/**
 * 规范档位闭环：DESIGN.md 定义的每一档，实现里不得出现档外取值（2026-11-09）。
 *
 * ## 背景
 *
 * 用户以截图指出命令搜索「字体太小看不清」，由此扫全表发现：
 *   · 25 处字号低于规范写死的 10.5px（已修）；
 *   · 7 处用了 **11px**，而规范档位只有 18/13/12.5/12/11.5/10.5；
 *   · 按钮高度长出 26/30/39/44/47 五档，而规范只写了 34/28。
 *
 * **两种处置方式**：把实现压回规范，或把规范补全。
 * 用户裁决「补规范」——理由是这些取值本身语义清晰且已自洽
 * （11px 是「分组标题」而不是「辅助信息」；47px 是通栏页签而不是普通按钮），
 * 压回规范反而会让层级退步。
 *
 * 本文件把补全后的档位**锁死**：新增档外取值会红，逼着实现与规范同步演进。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readDesktopStyles().replace(/\/\*[\s\S]*?\*\//g, "");
const design = readFileSync(resolve(root, "../../docs/design/ui-mockups/dialog-system-v2/DESIGN.md"), "utf8");

type Rule = { sels: string[]; body: string; inMedia: boolean };
function parseRules(source: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buffer = "";
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
      out.push({ sels: prelude.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean), body, inMedia: stack.length > 0 });
      i = j; continue;
    }
    if (ch === "}") { stack.pop(); buffer = ""; continue; }
    buffer += ch;
  }
  return out;
}
const RULES = parseRules(css);

// DESIGN.md §3.2 的档位（2026-11-09 补全后）
// 15px 是「图标按钮」字号：图标 15px 时文字同尺寸才不会错位（规范 §3.2 已补）。
// 本测试只覆盖**弹窗内**——弹窗外的顶栏/属性面板有各自的字号体系，
// 不属 DESIGN.md 的对话框规范范围。
const FONT_TIERS = [18, 15, 13, 12.5, 12, 11.5, 11, 10.5];
const BUTTON_HEIGHT_TIERS = [34, 30, 28, 26, 39, 47, 44];

describe("规范闭环：DESIGN.md 已声明这些档位", () => {
  it.each([
    ["字号 11px 分组标签档", "分组标题 / 分组标签"],
    ["按钮高度补充说明", "按钮高度档位"],
    ["通栏页签 47px", "通栏页签"],
    ["页签 30px", "页签"],
    ["紧凑操作行 26px", "紧凑操作行"],
  ])("%s 在规范中有记录", (_label, keyword) => {
    expect(design, `DESIGN.md 缺少「${keyword}」的档位定义`).toContain(keyword);
  });
});

describe("规范闭环：实现里的字号不越档", () => {
  it("弹窗内的 font-size 都是规范档位之一", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      if (!rule.sels.some(s => /\.modal/.test(s))) continue;   // 只管弹窗作用域
      for (const m of rule.body.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
        const v = parseFloat(m[1]);
        if (!FONT_TIERS.includes(v)) offenders.push(`${rule.sels[0]}: ${v}px`);
      }
      // font 简写也会设字号（曾藏过 9px）
      for (const m of rule.body.matchAll(/font\s*:\s*([\d.]+)px\s/g)) {
        const v = parseFloat(m[1]);
        if (!FONT_TIERS.includes(v)) offenders.push(`${rule.sels[0]} (font 简写): ${v}px`);
      }
    }
    expect(offenders, `字号越档（规范档位：${FONT_TIERS.join(" / ")}）：\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("规范闭环：弹窗内按钮高度不越档", () => {
  it("按钮本体高度都是规范档位之一", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      for (const sel of rule.sels) {
        if (!/\.modal/.test(sel)) continue;           // 只看弹窗内
        if (!/button|\.btn|command-option/.test(sel)) continue;
        // 排除图标（svg / .icon）与伪元素指示线——它们不是按钮本体
        if (/svg|::after|::before|\.icon/.test(sel)) continue;
        const m = /(?:^|;)\s*height\s*:\s*([\d.]+)px/.exec(rule.body);
        if (!m) continue;
        const v = parseFloat(m[1]);
        if (!BUTTON_HEIGHT_TIERS.includes(v)) offenders.push(`${sel}: ${v}px`);
      }
    }
    expect(
      offenders,
      `弹窗内按钮高度越档（规范档位：${BUTTON_HEIGHT_TIERS.join(" / ")}）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
