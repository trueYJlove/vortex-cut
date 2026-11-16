import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * JSX 注释泄漏守卫（2026-11-16）。
 *
 * **为什么要这条测试**：在 JSX 表达式容器里（`<div>` 与 `</div>` 之间、或 ``<>...<>` 里）
 * 直接写 `//` 或 `/* *\/` 注释，React 会把它**当成文本节点渲染出来**——
 * 屏幕上出现一整段源码注释。本轮我连续踩中两次（属性面板顶部出现整段说明文字），
 * 两次都是靠截图才发现，测试全绿。记性靠不住，故机器检查。
 *
 * 判定规则（保守，只报确定的形态）：
 * 在 .tsx 文件里，若某行以 `//` 开头且其所在的兄弟上下文是 JSX 子节点位置，
 * 即报错。实现上不追求完整解析——只用「上一非空行以 `>` 结尾 或 本行处于
 * `return (` 之后的首批行」这两个可判定信号，命中即报出文件与行号。
 * 宁可漏报也不误报：误报会训练人忽略这条守卫。
 */
const SRC = resolve(__dirname, "../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("JSX 注释不得泄漏成文本", () => {
  it("src 下没有在 JSX 子节点位置出现的 // 或 /* 注释", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const trimmed = line.trim();
        const isLineComment = trimmed.startsWith("//");
        const isBlockComment = trimmed.startsWith("/*") && !trimmed.startsWith("/* eslint");
        if (!isLineComment && !isBlockComment) continue;
        // 上一行非空内容：若以 JSX 开标签的 '>' 结尾，说明本行处于 JSX 子节点位置
        let j = i - 1;
        while (j >= 0 && lines[j]!.trim() === "") j -= 1;
        const prev = j >= 0 ? lines[j]!.trim() : "";
        const afterJsxOpen = prev.endsWith(">") && !prev.endsWith("=>");
        const afterReturnParen = /^return\s*\($/.test(prev) || prev === "<>";
        if (afterJsxOpen || afterReturnParen) {
          offenders.push(`${file.replace(SRC, "src")}:${i + 1}  ${trimmed.slice(0, 60)}`);
        }
      }
    }
    expect(offenders, `以下注释写在 JSX 子节点位置，会被渲染成文本：\n${offenders.join("\n")}`).toEqual([]);
  });
});
