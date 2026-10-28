/**
 * P200 归因仿真：长时线上 missingStuck 的**永久化**效应。
 *
 * 背景（真实数据，app-drop-p196-crosswindow-max.json）：
 *   对照组（41.4s / 1241 帧）：cold_start 1、unmatched_near 0、near_repeat_substitute 0、
 *     output_p50 1.9ms、丢帧 0
 *   长跑组（869s / 26069 帧）：cold_start 1808、unmatched_near 17476、
 *     near_repeat_substitute 15181、output_p50 45.6ms、丢帧 6086
 *
 * 本文件不跑真实 worker（jsdom 无法），而是**语义对齐**地复现
 * decode-worker.worker.ts 的 rank 记账（:497/:538/:981），检验一个结构性推论：
 *
 *   `emittedRankMax` 是**只增不减**的累积最大值（Math.max 累积）。
 *   `missingStuck = targetRank <= emittedRankMax`。
 *   ⇒ **只要播放头曾经到过 rank R，之后任何 targetRank ≤ R 的请求都会被判 missingStuck。**
 *
 * 推论：`reanchor` 把播放头**向后**归位后，接下来的请求必然全部 ≤ emittedRankMax
 * ⇒ 必然进冷启判定分支。短时线上 reanchor 极少（对照组 0 次），
 * 长时线上 reanchor 895 次 ⇒ 每次重锚都开启一段 missingStuck 序列。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FPS = 30;
const GOP = 150; // 实测：该素材关键帧每 5.000s（150 帧）
const NEAR_REPEAT_RANKS = 3; // decode-worker.worker.ts:858

/** worker 的 emittedRankMax 记账（:497 / :538：只增不减）。 */
class RankLedger {
  emittedRankMax = -1;
  coldStarts = 0;
  /** 每次冷启时的回退深度（emittedRankMax - targetRank），对齐产品 trace 的 backDistance。 */
  backDistances: number[] = [];
  nearSubstitutes = 0;
  misses = 0;

  /** 一次"已吐出帧"事件。 */
  emit(rank: number): void {
    this.emittedRankMax = Math.max(this.emittedRankMax, rank);
  }

  /** 一次请求。返回它是否走了「冷启/近邻替代」分支。 */
  request(targetRank: number, heldRanks: number[]): "hit" | "substitute" | "cold" {
    if (targetRank > this.emittedRankMax) return "hit";
    // missingStuck 分支：先尝试近邻替代（recovery 语义）
    const donor = heldRanks.some(r => Math.abs(r - targetRank) <= NEAR_REPEAT_RANKS);
    if (donor) { this.nearSubstitutes += 1; return "substitute"; }
    this.coldStarts += 1;
    this.backDistances.push(this.emittedRankMax - targetRank);
    this.misses += 1;
    return "cold";
  }
}

describe("P200：emittedRankMax 只增不减 ⇒ 回跳后永久 missingStuck", () => {
  it("守卫：emittedRankMax 是累积最大值，不随播放头回退而恢复", () => {
    const ledger = new RankLedger();
    ledger.emit(100);
    expect(ledger.emittedRankMax).toBe(100);
    // 播放头回退后再吐出更小的 rank —— max 不下降
    ledger.emit(50);
    expect(ledger.emittedRankMax).toBe(100);
  });

  it("线性播放（无回跳）：发出后立刻被判 missingStuck —— 这是设计意图，不是缺陷", () => {
    const ledger = new RankLedger();
    // 顺序吐 0..9，随后请求 0..9 全部 ≤ emittedRankMax
    for (let rank = 0; rank < 10; rank++) ledger.emit(rank);
    const outcomes = [];
    for (let rank = 0; rank < 10; rank++) outcomes.push(ledger.request(rank, []));
    // 关键：每一步都命中 missingStuck 分支（无近邻者则冷启）
    expect(outcomes.every(o => o !== "hit")).toBe(true);
  });

  it("回跳（reanchor）后：即使请求的是**从未请求过**的前方帧，只要 ≤ 已吐最大值就必判 missingStuck", () => {
    const ledger = new RankLedger();
    // 播放到 rank 5000（模拟长时线播了 166s）
    for (let rank = 4990; rank <= 5000; rank++) ledger.emit(rank);
    expect(ledger.emittedRankMax).toBe(5000);
    // reanchor 把播放头归位到 4900（preview-session.ts:2147 只挪指针，不动台账）
    // 之后请求 4901..4910 —— 这些帧**可能从未被请求过**，但 ≤ 5000
    const outcomes = [];
    for (let rank = 4901; rank <= 4910; rank++) outcomes.push(ledger.request(rank, []));
    expect(outcomes.every(o => o === "cold")).toBe(true);
    expect(ledger.coldStarts).toBe(10);
  });

  it("backDistance 记录回退深度（对齐 cold_start trace 的新字段）", () => {
    const ledger = new RankLedger();
    for (let rank = 4900; rank <= 5000; rank++) ledger.emit(rank);
    // 回跳到 4950（reanchor 归位形态）——深度应为 5000-4950 = 50
    ledger.request(4950, []);
    expect(ledger.backDistances).toEqual([50]);
    // 再回退更深一帧，深度递增
    ledger.request(4940, []);
    expect(ledger.backDistances).toEqual([50, 60]);
  });

  it("守卫产品代码：cold_start trace 必须带 backDistance，且定义为 emittedRankMax - targetRank", () => {
    // **为什么需要这条**：上面的 RankLedger 是仿真，它测的是仿真自己。
    // 我做过一次变异（把产品里 backDistance 改成 +1）——6 例全绿、变异存活，
    // 证明纯语义仿真**守不住产品代码**。这条对 worker 源码设文本卡，
    // 是让「下一手能拿到回退深度」这件事真的有人守。
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "preview", "decode-worker.worker.ts");
    const source = readFileSync(workerPath, "utf8");
    const line = source.split(/\r?\n/).find(row => row.includes('trace("cold_start"')) ?? "";
    expect(line, "找不到 cold_start trace 调用").not.toBe("");
    expect(line, "cold_start trace 丢了 backDistance ⇒ 无法判定重锚与 missingStuck 的因果").toContain("backDistance");
    // **必须精确相等，不能用 toContain**：我第一次写的是 toContain，
    // 而变异成 `emittedRankMax - targetRank + 1` 后规范化成 `-targetRank+1`，
    // 目标串仍是它的前缀 ⇒ toContain 通过、变异存活。改成对整字段做全等。
    const normalized = line.replace(/\s+/g, "");
    const field = /backDistance:([^,}]*)/.exec(normalized)?.[1] ?? "";
    expect(field, `backDistance 定义不对：${field}`).toBe("emittedRankMax-targetRank");
  });

  it("决定性：**纯线性播放永不触发** —— 该机制必须由回跳驱动", () => {
    // 这一步最初被我写反了（写成「长跑组 coldStarts 应更多」），跑红后才发现真义：
    // 每步先 emit(rank) 再 request(rank+1)，targetRank 恒 > emittedRankMax
    // ⇒ 两条线都**一次都不进** missingStuck。这正好证明：**该分支只能由回跳触发**，
    // 单纯「时间线长」不会让 cold_start 变多。
    const control = new RankLedger();
    for (let rank = 0; rank < 1241; rank++) { control.emit(rank); control.request(rank + 1, []); }
    const long = new RankLedger();
    for (let rank = 0; rank < 26069; rank++) { long.emit(rank); long.request(rank + 1, []); }
    expect(control.coldStarts).toBe(0);
    expect(long.coldStarts).toBe(0);
  });

  it("决定性对照：同样的播放，**加入真实重锚次数**后 cold_start 才出现", () => {
    // 真实数据：对照组 reanchor 0 次；长跑组 reanchor 895 次
    // （app-drop-p196-*.json 的 perf_events 中 kind="reanchor" 计数）
    const run = (frames: number, reanchors: number, step = 300): number => {
      const ledger = new RankLedger();
      const reanchorEvery = reanchors > 0 ? Math.floor(frames / reanchors) : Infinity;
      let nextReanchor = reanchorEvery;
      for (let rank = 0; rank < frames; rank++) {
        ledger.emit(rank);
        if (rank >= nextReanchor) {
          // preview-session.ts:2147：reanchor 只挪播放头，**不动 emittedRankMax**
          nextReanchor += reanchorEvery;
          // 归位后接着请求（真实数据里重锚后 skip 一段，这里取保守下界）
          for (let back = 1; back <= step; back++) {
            ledger.request(Math.max(0, rank - back), []);
          }
          continue;
        }
        ledger.request(rank + 1, []);
      }
      return ledger.coldStarts;
    };
    const control = run(1241, 0);
    const long = run(26069, 895);
    console.log(`对照 coldStarts=${control}  长跑 coldStarts=${long}`);
    expect(control).toBe(0); // 无重锚 ⇒ 一次都不触发
    // **注意：数值不可与真实 1808 直接比**。本仿真每步都发请求（真实播放是 30fps
    // 逐帧、但 worker 有暂存命中），且重锚后连发 step 个回退请求、真实是稀疏的。
    // 本用例只证明**方向与存在性**：无重锚=0、有重锚>0。量级差异见报告 §5。
    expect(long).toBeGreaterThan(0);
  });
});
