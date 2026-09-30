/**
 * 无 B 帧直线流的「解码器输出管线深度 vs 持有窗容量」仿真回归。
 *
 * 病根（2026-09-30 用户原素材复现，repro-user-h264-3440-r1 trace 实锤）：
 * 用户素材 3440x1440 H.264 **无 B 帧**（has_b_frames=0，GOP=150/5s）。这类流
 * 的呈现序 == 采样序（回跳深度 0），旧公式 `readyByPtsMax = min(8, max(4,
 * maxBackstep+2))` 因此算得持有窗 **4**。但该流在 D3D11 硬解上的**输出管线深度
 * 是 11**（trace：喂到 target+11 才吐第一帧）。两个事实叠加：
 *
 *   1. 持有窗 4 < 管线深度 11 → 解码器为释放目标而必须喂出的后续帧，被自己的
 *      容量挤掉；
 *   2. 段末延伸用 `dq==0` 判定「输出已排空」——批间让步（setTimeout 0）期间
 *      解码器必把 input queue 抽干，dq 归零只代表「输入被接受」，于是几乎每次
 *      都命中延伸分支，且一次 +32 采样 → 超前量远超容量。
 *
 * 结果：客户端**顺序**请求的下一个目标恰是被驱逐的帧 → `missingStuck` 冷启
 * 整 GOP（清空暂存 + 关键帧重喂 150 包）→ 每次 ~300ms 空窗。实测 41s 内冷启
 * **154 次**、丢帧 242/1241、合成间隔 p95 200ms。
 *
 * 本测试用同一个「解码器管线深度」模型对拍两种策略，必须是**有区分力**的：
 * 旧策略必然触发重建风暴，新策略（持有窗按实测超前量前摄扩容 + 有界小步延伸）
 * 必须零重建、零 miss。
 */
import { describe, expect, it } from "vitest";

/** 解码器输出管线深度：喂到 target+DEPTH 才吐第一帧（repro-user-h264-3440 实测 11）。 */
const PIPELINE_DEPTH = 11;
/** 喂包批大小（无 B 帧：max(LOOKAHEAD, maxStagger)+1 = 4）。 */
const BATCH = 4;
/** feedEndFor(target) 的超前量（无 B 帧：max(3, maxStagger+1) = 3）。 */
const FEED_AHEAD = 3;
/** 采样总数（3440x1440 素材 1241 帧；取 600 缩短测试时长，性质不变）。 */
const COUNT = 600;
/** GOP（用户素材关键帧间隔 5s@30fps = 150）。 */
const GOP = 150;

interface SimOutcome {
  /** 目标帧不可得 → 冷启整 GOP 重建次数。 */
  rebuilds: number;
  /** 客户端顺序请求中命中持有窗的次数（越高越顺）。 */
  hits: number;
  /** 单请求最大超前喂包量（应被有界延伸压住）。 */
  maxAhead: number;
  /** 持有窗实际用到的最大容量。 */
  maxHold: number;
}

type Policy = "legacy" | "fixed";

/**
 * 极简 worker 语义模型（保留与缺陷直接相关的部分）：
 * - 客户端顺序请求 0..COUNT-1（顺播直线流；与 PreviewSession.pump 的升序请求一致）；
 * - 解码器：喂到 fedTo 后，已喂且满足 `i <= fedTo - DEPTH` 的输出一次性吐回；
 * - 持有窗：容量 holdCap，溢出时驱逐**展示序最新**（客户端是顺序消费者，
 *   丢最新 = 损失落在最远处，前沿方向保留连续跑道）；
 * - miss 且 `target <= emittedMax`（已吐出过、现不在窗内）→ 冷启重建整 GOP。
 */
function simulate(policy: Policy): SimOutcome {
  let holdCap = 4; // 旧公式对无 B 帧流算得的容量
  let fedTo = -1;
  let nextEmit = 0;
  let emittedMax = -1;
  const hold = new Map<number, true>(); // 持有窗（pts 单调 ⇒ 键即采样号）

  const emitAvailable = (): number => {
    let emitted = 0;
    while (nextEmit < COUNT && nextEmit <= fedTo - PIPELINE_DEPTH) {
      const index = nextEmit++;
      emittedMax = Math.max(emittedMax, index);
      if (index === activeTarget) { delivered = true; } else {
        hold.set(index, true);
        while (hold.size > holdCap) {
          let newest = -1;
          for (const key of hold.keys()) if (key > newest) newest = key;
          hold.delete(newest);
        }
        maxHold = Math.max(maxHold, hold.size);
      }
      emitted += 1;
    }
    return emitted;
  };

  let activeTarget = -1;
  let delivered = false;
  let rebuilds = 0;
  let hits = 0;
  let maxAhead = 0;
  let maxHold = 0;

  const feedTo = (end: number): void => {
    while (fedTo < end) fedTo += 1;
  };
  const keyframeAtOrBefore = (index: number): number => Math.floor(index / GOP) * GOP;

  for (let target = 0; target < COUNT; target++) {
    activeTarget = target;
    delivered = false;
    if (hold.has(target)) { hold.delete(target); hits += 1; continue; }

    let start: number;
    if (target <= emittedMax) {
      // missingStuck：已吐出但已被驱逐 → 只有重建重解能拿到正确帧。
      rebuilds += 1;
      hold.clear();
      start = keyframeAtOrBefore(target);
      fedTo = start - 1;
      nextEmit = start;
      emittedMax = start - 1;
    } else {
      start = fedTo + 1;
    }

    if (policy === "fixed") {
      // 持有窗前摄扩容：喂包时按实测超前量扩容，输出落地前生效。
      for (let index = start; index <= Math.min(COUNT - 1, target + FEED_AHEAD); index++) {
        fedTo = Math.max(fedTo, index);
        holdCap = Math.min(16, Math.max(6, fedTo - target + 2));
      }
    }

    // 段内喂包（批间让步后检查输出）
    let end = Math.min(COUNT - 1, target + FEED_AHEAD);
    let step = BATCH;
    for (let guard = 0; guard < 4096 && !delivered; guard++) {
      while (fedTo < end) {
        fedTo = Math.min(end, fedTo + BATCH);
        if (policy === "fixed") holdCap = Math.min(16, Math.max(6, fedTo - target + 2));
      }
      maxAhead = Math.max(maxAhead, fedTo - target);
      const emitted = emitAvailable();
      if (delivered) break;
      if (fedTo >= COUNT - 1) break; // 文件尾：真实实现走 EOF 定格/报错
      if (emitted > 0) continue; // 管线仍在吐 → 继续等，不延伸
      // 停滞 → 延伸
      if (policy === "legacy") {
        end = Math.min(COUNT - 1, fedTo + 32);
      } else {
        end = Math.min(COUNT - 1, fedTo + step);
        step = Math.min(32, step * 2);
      }
      if (end <= fedTo) break;
    }
    if (!delivered) emitAvailable();
  }
  return { rebuilds, hits, maxAhead, maxHold };
}

describe("无 B 帧直线流的持有窗容量与喂包延伸策略", () => {
  it("反向对照：旧策略（窗=回跳深度、dq 判定 + 一次 +32）必然触发冷启重建风暴", () => {
    const legacy = simulate("legacy");
    // 每 ~4 帧一次 miss → 重建次数与帧数量级相当（实测 41s/1241 帧 154 次）
    expect(legacy.rebuilds).toBeGreaterThan(COUNT / 20);
    expect(legacy.maxAhead).toBeGreaterThanOrEqual(PIPELINE_DEPTH + 20);
  });

  it("新策略：持有窗前摄扩容 + 有界延伸 ⇒ 顺序播放零重建零 miss", () => {
    const fixed = simulate("fixed");
    expect(fixed.rebuilds).toBe(0);
    // 持有窗确有复用（解码器已吐出的后续帧被后续请求直接取用，而非重新解码）
    expect(fixed.hits).toBeGreaterThan(COUNT * 0.5);
    // 超前量被压到管线深度附近（旧策略 ≥31）：留出批大小余量
    expect(fixed.maxAhead).toBeLessThanOrEqual(PIPELINE_DEPTH + 2 * BATCH);
    expect(fixed.maxHold).toBeLessThanOrEqual(16);
  });
});
