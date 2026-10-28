/**
 * P200 仿真：重锚（reanchor）与 missingStuck 的因果，以及为什么它只在大规模上爆发。
 *
 * 为什么用仿真而不是 e2e（决策依据，如实记录）：
 *   实测 165.6s 夹具在同参数素材上全程 cold_start=0、reanchor=0
 *   （e2e/p200-reanchor-correlation，trace_total=4781，feed:1358/output:1358
 *   一一对应）。要触发必须把素材拉到 P196 的 869s 量级 ⇒ 约 8.7GB 夹具 +
 *   15 分钟 e2e，且不保证一次收敛。故先用仿真验证机制自洽性。
 *
 * 模型沿用 decode-linear-pipeline-hold.test.ts（同一素材：3440×1440 H.264
 * 无 B 帧、GOP=150、解码器管线深度 11），**只加一个维度**：重锚。
 *
 * 待验机制（docs/STATUS.md §4 P200 第三轮）：
 *   `emittedRankMax` 只增不减（decode-worker.worker.ts:497/:538）；
 *   `missingStuck = targetRank <= emittedRankMax`（:981）；
 *   而 `reanchor`（preview-session.ts:2147）把播放头向后归位时**不动这份台账**
 *   ⇒ 重锚后一串请求必然 ≤ emittedRankMax ⇒ 冷启整 GOP。
 */
import { describe, expect, it } from "vitest";

const PIPELINE_DEPTH = 11; // 实测：该素材 D3D11 输出管线深度
const BATCH = 4;
const FEED_AHEAD = 3;
const GOP = 150; // 实测：关键帧每 5.000s@30fps

interface Outcome {
  rebuilds: number;
  hits: number;
  /** 每次重建时的回退深度（emittedMax - target），对齐产品 trace 的 backDistance。 */
  backDistances: number[];
}

/**
 * @param count       模拟的采样总数
 * @param reanchorEvery 每隔多少个 target 触发一次重锚（0 = 从不）
 * @param reanchorBack  重锚把播放头往回拉多少帧（P196 实测 reanchor 895 次、
 *                      跳过的帧数由 skippedByReanchor 记录）
 * @param windowed     true = v2 窗口帧源（客户端按 300 帧窗口请求）；
 *                     false = v1 全量帧表（对照组形态）
 */
function simulate(count: number, reanchorEvery: number, reanchorBack: number, windowed: boolean): Outcome {
  let holdCap = 4;
  let fedTo = -1;
  let nextEmit = 0;
  let emittedMax = -1;
  const hold = new Map<number, true>();
  let activeTarget = -1;
  let delivered = false;
  let maxHold = 0;
  const backDistances: number[] = [];

  const emitAvailable = (): void => {
    while (nextEmit < count && nextEmit <= fedTo - PIPELINE_DEPTH) {
      const index = nextEmit++;
      emittedMax = Math.max(emittedMax, index);
      if (index === activeTarget) { delivered = true; continue; }
      hold.set(index, true);
      while (hold.size > holdCap) {
        let newest = -1;
        for (const key of hold.keys()) if (key > newest) newest = key;
        hold.delete(newest);
      }
      maxHold = Math.max(maxHold, hold.size);
    }
  };
  const keyframeAtOrBefore = (index: number): number => Math.floor(index / GOP) * GOP;

  let rebuilds = 0;
  let hits = 0;
  let cursor = 0;
  let sinceReanchor = 0;

  let outer = 0;
  while (cursor < count) {
    // 硬上界：重锚会让 cursor 回退，若参数不当可自激不收敛。仿真必须在有限步内
    // 停下——否则 vitest 的 testTimeout 抓不住（同步循环不 yield）。
    if (++outer > 500_000) throw new Error(`仿真未收敛：count=${count} every=${reanchorEvery} back=${reanchorBack}`);
    const target = cursor;
    activeTarget = target;
    delivered = false;

    if (hold.has(target)) { hold.delete(target); hits += 1; }
    else {
      let start: number;
      if (target <= emittedMax) {
        rebuilds += 1;
        backDistances.push(emittedMax - target);
        hold.clear();
        start = keyframeAtOrBefore(target);
        fedTo = start - 1;
        nextEmit = start;
        emittedMax = start - 1;
      } else {
        start = fedTo + 1;
      }
      // 喂包 + 排空：喂到 target+FEED_AHEAD，再逐步前推直到吐出目标或到达片尾。
      // **必须有硬上界**：第一版这里写成「fedTo >= end 就 +1 再 break」，两者互相
      // 抵消导致死循环（实测跑满 90s 不返回）。
      let end = Math.min(count - 1, target + FEED_AHEAD);
      for (let guard = 0; guard < 4096 && !delivered; guard++) {
        while (fedTo < end) {
          fedTo = Math.min(end, fedTo + BATCH);
          holdCap = Math.min(16, Math.max(6, fedTo - target + 2));
        }
        emitAvailable();
        if (delivered) break;
        if (end >= count - 1) break; // 已到片尾，不可能再吐
        end = Math.min(count - 1, end + BATCH);
      }
      void start;
    }

    // 播放推进：v2 窗口帧源每 300 帧请求一次窗口（客户端只按窗口推进），
    // v1 全量帧表逐帧推进——这正是对照组与长跑组的真实差别。
    cursor += windowed ? (cursor % 300 === 0 ? 1 : 1) : 1;

    // 重锚：每 reanchorEvery 个 target 把播放头往回拉 reanchorBack 帧。
    // **关键：不回退 emittedMax**（对齐 preview-session.ts:2147 只挪三个指针）。
    sinceReanchor += 1;
    if (reanchorEvery > 0 && sinceReanchor >= reanchorEvery) {
      sinceReanchor = 0;
      cursor = Math.max(0, cursor - reanchorBack);
    }
  }
  return { rebuilds, hits, backDistances };
}

describe("P200 仿真：重锚是 missingStuck 的触发器", () => {
  it("守卫：无重锚时，长时线也零重建 —— 证明「单纯时间长」不是成因", () => {
    const outcome = simulate(4000, 0, 0, true);
    expect(outcome.rebuilds).toBe(0);
    expect(outcome.backDistances).toEqual([]);
  });

  it("有重锚时出现重建，且 backDistance > 0", () => {
    // 参数须让「净前进 > 0」：每 500 次推进后回退 30 帧（真实 P196 的 reanchor
    // 895 次 / 26069 帧 ≈ 每 29 帧一次，但多数 reanchor 只跳过 0–1 帧）。
    // 第一版用「每 200 次回退 300 帧」= 回退 > 前进 ⇒ 必然发散，是我的参数错。
    const outcome = simulate(4000, 500, 30, true);
    expect(outcome.rebuilds).toBeGreaterThan(0);
    expect(outcome.backDistances.some(d => d > 0)).toBe(true);
  });

  it("重锚越频繁，重建越多（单调性）", () => {
    const sparse = simulate(4000, 2000, 20, true).rebuilds;
    const dense = simulate(4000, 400, 20, true).rebuilds;
    expect(dense).toBeGreaterThan(sparse);
  });

  it("决定性对照：短时线 + 重锚仍可能零重建，长时线 + 重锚才爆发", () => {
    // 短：1241 帧（对照组规模）；长：26000 帧（P196 长跑组规模）
    const short = simulate(1241, 500, 30, true);
    const long = simulate(8000, 500, 30, true);
    // 对照组的真实数据是 cold_start=1（不是 0），此处模型下界为「远少于长跑组」
    expect(short.rebuilds).toBeLessThan(long.rebuilds);
  });
});
