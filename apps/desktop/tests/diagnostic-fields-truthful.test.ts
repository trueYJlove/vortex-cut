/** 诊断字段不得是字面量（2026-11-01，由一次真实误判产生）。
 *
 * **背景**：`decode-worker.worker.ts` 的 `FRAME_UNREACHABLE` 错误消息里，
 * `lastFedSample=1776` 曾是**硬编码字面量**——无论实际喂到哪一帧都报 1776。
 * 我据此把「夹具只有一个关键帧」误判成「产品有 24fps 换算缺陷」，排查绕了一圈。
 *
 * **为什么用源码文本卡**：该值是 worker 运行时才有的局部状态，单测里跑不到
 * 那条 stall 分支（需要真实解码器停摆），语义仿真也守不住（本项目已两次
 * 栽在「仿真测自己」上）。文本卡是这里唯一能落到 CI 的手段。
 *
 * **必须用精确匹配而非包含**：本项目已有两次教训——包含匹配会让变异后的
 * 前缀仍然命中，变异因此存活。故对关键字段做全等断言。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "preview", "decode-worker.worker.ts");

describe("诊断字段真实性", () => {
  it("FRAME_UNREACHABLE 消息里的 lastFedSample 必须是插值，不得是字面量", () => {
    const source = readFileSync(WORKER, "utf8");
    // **必须排除注释行**：`FRAME_UNREACHABLE` 在注释里也出现过（提醒该路径语义），
    // 初次实现用 `find` 命中了注释，导致断言看的是说明文字而不是真实调用。
    const line = source.split(/\r?\n/).find(row => row.includes("FRAME_UNREACHABLE") && !row.trimStart().startsWith("//")) ?? "";
    expect(line, "找不到 FRAME_UNREACHABLE 的 post 调用").not.toBe("");
    // ① 不得出现「lastFedSample=数字」这样的固定字面量
    expect(line, "lastFedSample 被写成了字面量 ⇒ 该诊断恒为假值").not.toMatch(/lastFedSample=\d/);
    // ② 必须是插值形式
    expect(line, "lastFedSample 未以插值形式输出").toMatch(/lastFedSample=\$\{[^}]+\}/);
  });

  it("快照发生在重置之前（否则插值只会打印 -1）", () => {
    const source = readFileSync(WORKER, "utf8");
    const lines = source.split(/\r?\n/);
    const postIdx = lines.findIndex(row => row.includes("FRAME_UNREACHABLE") && !row.trimStart().startsWith("//"));
    expect(postIdx, "找不到 FRAME_UNREACHABLE").toBeGreaterThan(0);
    const from = Math.max(0, postIdx - 15);
    const snapshotAt = lines.findIndex((row, i) => i >= from && i < postIdx && /const\s+\w+\s*=\s*lastFedSample/.test(row));
    const resetAt = lines.findIndex((row, i) => i >= from && i < postIdx && /^\s*lastFedSample\s*=\s*-1\s*;/.test(row));
    expect(snapshotAt, "post 之前没有 lastFedSample 快照 ⇒ 消息会打印重置后的 -1").toBeGreaterThan(0);
    expect(resetAt, "找不到 lastFedSample = -1 重置行").toBeGreaterThan(0);
    expect(snapshotAt, "快照必须在重置之前").toBeLessThan(resetAt);
  });
});
