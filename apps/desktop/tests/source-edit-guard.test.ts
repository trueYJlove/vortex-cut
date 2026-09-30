/**
 * 编辑事故守卫（2026-09-30 真实事故复盘）。
 *
 * 事故：一次「删除空行」的编辑把紧随其后的一行并进了行注释——
 *   `if (decodeTiming) request.startedMs = performance.now(); // 出队开始处理    activeRequest = request;`
 * `activeRequest = request;` 被注释吞掉后，worker 永不出队 → **预览永远停在
 * 「正在加载合成预览」**。tsc 与全部单测都照常通过（它们不启动真实 worker），
 * 只有跑 App 级 e2e 才会暴露——而当时我先提交、后验证。
 *
 * 本测试把「行注释尾部粘着一条 `a = b;` 语句」这一形态钉死：正常注释不会以
 * 这种赋值语句结尾（本仓注释里的等号都带空格且不含分号收尾）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PREVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "preview");
const FILES = ["decode-worker.worker.ts", "preview-session.ts", "compositor-worker.worker.ts", "decode-worker.ts"];

/** 行注释后面粘着 `ident = ident;`（编辑并行的典型残留）。允许 `==`/`===`/`=>` 等正常写法。 */
const SWALLOWED_STATEMENT = /\/\/[^\n]*\s[A-Za-z_$][\w$.]*\s*=\s*[A-Za-z_$][\w$.()]*;\s*$/;

describe("源码编辑事故守卫", () => {
  it("守卫本身有区分力（真实事故样本必须命中、正常注释不得命中）", () => {
    // 2026-09-30 真实被提交过的坏行（原样）：先证明抓得到，再谈守得住。
    const realAccident = "    if (decodeTiming) request.startedMs = performance.now(); // P33：出队开始处理    activeRequest = request;";
    expect(SWALLOWED_STATEMENT.test(realAccident), "守卫对真实事故样本未命中 = 形同虚设").toBe(true);
    expect(SWALLOWED_STATEMENT.test("    if (decodeTiming) request.startedMs = performance.now(); // P33：出队开始处理")).toBe(false);
    expect(SWALLOWED_STATEMENT.test(" *  容量公式：min(HARD_CAP, max(MIN, 回跳深度+2))——重排覆盖")).toBe(false);
  });

  for (const file of FILES) {
    it(`${file} 无「语句被行注释吞掉」`, () => {
      const lines = readFileSync(join(PREVIEW_DIR, file), "utf8").split("\n");
      const hits = lines
        .map((line, index) => ({ line: line.trimEnd(), number: index + 1 }))
        .filter(entry => SWALLOWED_STATEMENT.test(entry.line) && !entry.line.trimStart().startsWith("*"));
      expect(hits, `疑似被注释吞掉的语句：\n${hits.map(h => `${h.number}: ${h.line}`).join("\n")}`).toEqual([]);
    });
  }

  it("decode worker 的 pumpQueue 必须真的认领请求（事故直接后果）", () => {
    const source = readFileSync(join(PREVIEW_DIR, "decode-worker.worker.ts"), "utf8");
    const body = source.slice(source.indexOf("function pumpQueue()"), source.indexOf("function decodeSamples("));
    // 未认领 activeRequest = 请求永远排在队里（预览卡在加载态）
    expect(/^\s*activeRequest = request;\s*$/m.test(body), "pumpQueue 缺少 activeRequest = request;").toBe(true);
  });
});
