/**
 * 「源帧率 ≠ 画布帧率（含变速片段）」的持有窗驱逐策略回归（2026-09-30 P33 W12）。
 *
 * 病根（真机 App 内 e2e 实锤，素材「刘可艾 小花猫舞蹈视频.mp4」= 1920x1080 **50fps**
 * H.264 Main L4.2 + 30fps 画布，`app-drop-w12-dance-1080p50-r1.json`）：
 * 客户端按**画布**帧率取帧（0, 1, 2, … @30fps → PTS 0/33.3/66.7ms…），映射到 50fps 源
 * 上只请求约 **3/5** 的源帧（0,2,3,5,6,8…）。其余 2/5 被解码器照常吐出，**永远不会被
 * 请求**——它们堆满持有窗，而旧驱逐策略（只有「丢展示序最新」一档）丢掉的恰好是客户端
 * 下一步要的帧 ⇒ 每个请求都 miss ⇒ `missingStuck` 冷启整 GOP。实测：`cold_start` 2251、
 * `unmatched_near` 32067、解码器吐出 73837 帧而只交付 3459 帧（21×）、丢帧 60/5040、
 * 解码 p50 64ms（观感幻灯片）。同一缺陷覆盖**变速片段**（speed≠1 也是请求跳过部分源帧）。
 *
 * 修法：驱逐分两档——先丢「展示序位 < 消费前沿」的陈旧帧（本轮播放永不再被请求，最旧
 * 优先），没有陈旧帧时再按 W4 语义丢展示序最新。
 *
 * 本测试是**策略模型**（decode worker 是 worker 入口模块，无法在 vitest 里直接 import；
 * 与 decode-linear-pipeline-hold.test.ts 同套路数）。端到端证据见上述 evidence JSON。
 */
import { describe, expect, it } from "vitest";

/** 源 50fps：PTS = i * 20ms。 */
const SOURCE_FPS = 50;
/** 画布 30fps：请求 PTS = n * 33.33ms → 每 5 个源帧请求 3 个。 */
const CANVAS_FPS = 30;
/** 解码器输出管线深度（喂到 target+DEPTH 才吐第一帧；与 W4 同量级）。 */
const PIPELINE_DEPTH = 9;
/** 喂包批大小（无 B 帧：max(LOOKAHEAD, maxStagger)+1 = 4）——「匹配即停」的检查发生在
 *  批间让步之后，因此喂包终点会**越过**目标最多一个批大小，这些多喂出来的帧会被解码器
 *  吐出并进窗（真机这就是「陈旧帧把窗挤满」的入口）。 */
const FEED_OVERSHOOT = 3;
/** 持有窗容量（真机 residency 实测 windowCap 4~5）。 */
const WINDOW_CAP = 5;
/** GOP（源帧计；关键帧重解代价 ≈ mini(GOP, 150)）。 */
const GOP = 150;
/** 输出帧总数（= 请求数；30fps × 30s）。 */
const OUTPUT_FRAMES = 900;

type Policy = "newest-only" | "stale-first";

interface Outcome {
  /** missingStuck 冷启整 GOP 次数。 */
  coldStarts: number;
  /** 命中持有窗的请求数。 */
  windowHits: number;
  /** 解码器实际吐出的帧数（含永不被请求的陈旧帧与冷启重解）。 */
  decoded: number;
  /** 被驱逐的帧数（策略越差，驱逐越多）。 */
  evictions: number;
}

/** 输出帧号 → 源采样号（最近 PTS，等价 worker 的 locateByPts + 半帧容差）。 */
function sourceSampleFor(outputFrame: number): number {
  const targetUs = (outputFrame / CANVAS_FPS) * 1e6;
  return Math.round((targetUs / 1e6) * SOURCE_FPS);
}

function simulate(policy: Policy): Outcome {
  const window = new Map<number, true>(); // 源采样号（无 B 帧 ⇒ rank == 采样号）
  let frontierRank = -1;
  let fedTo = -1;
  let nextEmit = 0;
  let emittedMax = -1;
  let coldStarts = 0;
  let windowHits = 0;
  let decoded = 0;
  let evictions = 0;

  const evict = (): void => {
    // 第一档：前沿之前的陈旧帧（最旧优先）
    if (policy === "stale-first") {
      let staleKey = -1;
      for (const key of window.keys()) {
        if (key >= frontierRank) continue;
        if (staleKey < 0 || key < staleKey) staleKey = key;
      }
      if (staleKey >= 0) { window.delete(staleKey); evictions += 1; return; }
    }
    // 第二档：展示序最新
    let newest = -1;
    for (const key of window.keys()) if (key > newest) newest = key;
    if (newest >= 0) { window.delete(newest); evictions += 1; }
  };

  const emitAvailable = (): void => {
    while (nextEmit <= fedTo - PIPELINE_DEPTH) {
      const index = nextEmit++;
      decoded += 1;
      emittedMax = Math.max(emittedMax, index);
      while (window.size >= WINDOW_CAP) evict();
      window.set(index, true);
    }
  };

  for (let outputFrame = 0; outputFrame < OUTPUT_FRAMES; outputFrame++) {
    const target = sourceSampleFor(outputFrame);
    if (window.has(target)) {
      window.delete(target);
      windowHits += 1;
    } else {
      if (target <= emittedMax) {
        // 已吐出过却不在窗内 → 冷启整 GOP 重解（真机走的就是这条）
        coldStarts += 1;
        window.clear();
        const start = Math.floor(target / GOP) * GOP;
        fedTo = start - 1;
        nextEmit = start;
        emittedMax = start - 1;
      }
      const end = target + PIPELINE_DEPTH + FEED_OVERSHOOT;
      while (fedTo < end) { fedTo += 1; emitAvailable(); }
      emitAvailable();
      window.delete(target);
    }
    frontierRank = Math.max(frontierRank, target);
  }
  return { coldStarts, windowHits, decoded, evictions };
}

describe("源帧率 ≠ 画布帧率时的持有窗驱逐（50fps 源 / 30fps 画布）", () => {
  it("反向对照：只丢「展示序最新」⇒ 陈旧帧堆满窗、每请求 miss、冷启风暴", () => {
    const legacy = simulate("newest-only");
    // 被跳过的源帧（2/5）永不被请求，却参与容量竞争 → miss 常态化
    expect(legacy.coldStarts).toBeGreaterThan(OUTPUT_FRAMES * 0.3);
    // 冷启重解导致解码量远大于请求数（真机 21×）
    expect(legacy.decoded).toBeGreaterThan(OUTPUT_FRAMES * 5);
    // 命中率极低：窗里装的多是陈旧帧
    expect(legacy.windowHits).toBeLessThan(OUTPUT_FRAMES * 0.3);
  });

  it("新策略：先丢消费前沿之前的陈旧帧 ⇒ 零冷启、解码量回到「源帧 + 管线深度」", () => {
    const fixed = simulate("stale-first");
    expect(fixed.coldStarts).toBe(0);
    // 请求并非全部命中持有窗（输出管线深度 9 > 窗 5，部分目标仍在管线里，属正常），
    // 关键是**不再有冷启重解**：解码量 ≈ 源帧数（900 请求对应 ~1500 源帧）+ 管线深度。
    expect(fixed.decoded).toBeLessThan(OUTPUT_FRAMES * 2);
    expect(fixed.windowHits).toBeGreaterThan(OUTPUT_FRAMES * 0.3);
    // 陈旧帧确实被丢掉了（每 ~5 个请求 2 个陈旧帧）
    expect(fixed.evictions).toBeGreaterThan(OUTPUT_FRAMES * 0.3);
  });
});
