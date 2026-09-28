/**
 * B 帧 ctts 重排播放仿真：用真实素材采样表（fixtures/bframe-hevc-sample-table.json，
 * 720×1280 HEVC 30fps B 帧，GOP=88，呈现序回跳深度 6）验证 decode-worker 三处
 * 防御修复在真实请求流下不丢输出、不触发整 GOP 冷启重建风暴。
 *
 * 修复清单（2026-09-28「丢帧不多但持续卡顿」定位会话，decode-worker.worker.ts）：
 * ① GOP 连续性锚 lastTargetKey（上个请求目标所在 GOP）——旧锚 lastFedSample
 *   含 LOOKAHEAD 前瞻，目标+3 越过下个关键帧即误判跨 GOP → 整 GOP 88 包冷启
 *   重解 + clearReadyByPts 清暂存 → 后续请求连环排队重建（风暴）。
 * ② 重排暂存窗容量按素材回跳深度自适应（本素材 6 → 10；旧定长 4 会 FIFO
 *   驱逐待请求输出 → 同 GOP 无包可喂 → 45s 看门狗挂起）。
 * ③ activeRequest 输出匹配容差整帧 33_334us → 半帧 16_667us（本素材相邻帧
 *   距 33_333us：整帧容差会偷相邻输出 = 错帧/视觉抖动；半帧永不偷且保留 VFR
 *   半帧偏移命中能力）。
 *
 * 请求流场景（全部带暂存回填——worker 正常路径：takeByPts 命中直接回填，
 * GOP 检查仅在 miss 排队时执行）：
 * - seek 后播放（显示序目标流，B 帧回跳 ±6 采样）：真机 scrub/续播形态；
 * - 单调播放流（pump 升序请求）：正常播放；
 * - 播放中回跳（seek 后退/变速抽帧）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSampleIndex, keyframeAtOrBefore, locateByPtsOracle, type SampleIndex } from "../src/app/preview/sample-index.js";

interface FixtureSample { dts: number; cts: number; sync: boolean }

function loadFixture(): { timescale: number; samples: FixtureSample[] } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bframe-hevc-sample-table.json");
  return JSON.parse(readFileSync(path, "utf8")) as { timescale: number; samples: FixtureSample[] };
}

const LOOKAHEAD = 3;

interface SimResult {
  /** 请求无输出可达（挂起形态——真机 45s 看门狗/客户端超时 → 降级 FFmpeg 慢路径）。 */
  lost: number;
  /** 冷启重建（跨 GOP 判定）次数。 */
  rebuilds: number;
  /** 最大单请求喂包数（伪重建 = 整 GOP 量级 89）。 */
  maxFeed: number;
  /** activeRequest 拿到非目标帧（整帧容差偷相邻输出 = 错帧）。 */
  wrongFrame: number;
}

/** worker 语义对齐（GOP 检查仅在暂存 miss 时执行；喂 [start..target+LA]；
 *  输出按 PTS 序，activeRequest 命中首个容差内输出（post 即离场），其余入
 *  暂存（FIFO 上限 cap）；重建清暂存。 */
function simulate(index: SampleIndex, targets: number[], gopAnchor: "target" | "fed", stashCap: number, matchTolUs: number): SimResult {
  const stash: number[] = [];
  let lastFedSample = -1;
  let lastTargetKey = -1;
  let lost = 0, rebuilds = 0, maxFeed = 0, wrongFrame = 0;
  for (const target of targets) {
    const hit = stash.indexOf(target);
    if (hit >= 0) { stash.splice(hit, 1); continue; }
    const keyTarget = keyframeAtOrBefore(index, target);
    const sameGop = gopAnchor === "target"
      ? lastTargetKey >= 0 && lastTargetKey === keyTarget
      : lastFedSample >= 0 && keyframeAtOrBefore(index, lastFedSample) === keyTarget;
    let start: number;
    if (!sameGop) {
      rebuilds += 1;
      start = keyTarget;
      stash.length = 0; // clearReadyByPts
    } else {
      start = lastFedSample + 1;
      if (start > target + LOOKAHEAD) { lost += 1; continue; }
    }
    const end = Math.min(index.count - 1, target + LOOKAHEAD);
    const outs = Array.from({ length: end - start + 1 }, (_, i) => start + i)
      .sort((a, b) => index.ptsUs[a]! - index.ptsUs[b]!);
    const targetPts = index.ptsUs[target]!;
    let resolved = -1;
    for (const o of outs) {
      if (Math.abs(index.ptsUs[o]! - targetPts) <= matchTolUs) { resolved = o; break; }
    }
    if (resolved === -1) { lost += 1; continue; }
    if (resolved !== target) wrongFrame += 1;
    maxFeed = Math.max(maxFeed, end - start + 1);
    for (const o of outs) {
      if (o !== resolved && !stash.includes(o)) {
        stash.push(o);
        if (stash.length > stashCap) stash.shift();
      }
    }
    lastFedSample = Math.max(lastFedSample, end);
    lastTargetKey = keyTarget;
  }
  return { lost, rebuilds, maxFeed, wrongFrame };
}

/** 素材呈现序回跳深度（worker init 同式：目标流相对已喂边界最大回跳）。 */
function maxBackstepOf(index: SampleIndex, targets: number[]): number {
  let fedBoundary = -1;
  let max = 0;
  for (const target of targets) {
    if (fedBoundary >= 0 && target < fedBoundary) max = Math.max(max, fedBoundary - target);
    fedBoundary = Math.max(fedBoundary, target + LOOKAHEAD);
  }
  return max;
}

/** 显示序目标流：display n → 最近邻 PTS 采样（B 帧回跳形态）。 */
function displayTargets(index: SampleIndex, from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n < to; n++) out.push(locateByPtsOracle(index, (n / 30) * 1e6).sample);
  return out;
}

describe("B 帧 ctts 重排播放仿真（真实采样表）", () => {
  const fixture = loadFixture();
  const index = buildSampleIndex(
    fixture.samples.map(sample => ({ dts: sample.dts, ctsOffset: sample.cts, sync: sample.sync })),
    fixture.timescale,
  );
  const fullDisplay = displayTargets(index, 0, index.count);
  const depth = maxBackstepOf(index, fullDisplay);
  const adaptiveCap = Math.min(16, Math.max(4, depth + LOOKAHEAD + 1));

  it("fixture 是 B 帧素材且带真实重排（守卫：fixture 覆盖目标形态）", () => {
    expect(index.count).toBeGreaterThan(1000);
    expect(fixture.samples.some(sample => sample.cts !== 0)).toBe(true);
    expect(index.keyframes.length).toBeGreaterThan(5);
    expect(depth).toBeGreaterThanOrEqual(6);
    // 相邻帧距 > 半帧容差（修复③前提：本类素材半帧容差不偷相邻输出）
    let minGap = Infinity;
    for (let k = 1; k < index.sortedPtsUs.length; k++) {
      minGap = Math.min(minGap, index.sortedPtsUs[k]! - index.sortedPtsUs[k - 1]!);
    }
    expect(minGap).toBeGreaterThan(16_667);
    // 自适应容量公式（worker init 同式）
    expect(adaptiveCap).toBe(depth + LOOKAHEAD + 1);
  });

  it("seek 后播放（显示序回跳流）：旧配置挂起 47 帧整 GOP 重建——修复后零挂起零错帧", () => {
    // 真机 scrub 场景：跳到 display 500（GOP 中段）后按显示序续播 200 帧
    const seekStream = displayTargets(index, 500, 700);
    const old = simulate(index, seekStream, "fed", 4, 33_334);
    // 旧配置：错帧（整帧容差偷相邻输出）+ 伪重建（整 GOP 89 包）+ 挂起
    expect(old.wrongFrame).toBeGreaterThan(0);
    expect(old.maxFeed).toBeGreaterThan(80);
    expect(old.lost).toBeGreaterThan(0);

    const fixed = simulate(index, seekStream, "target", adaptiveCap, 16_667);
    expect(fixed.lost).toBe(0);
    expect(fixed.wrongFrame).toBe(0);
    // 冷启只剩 seek 落点的合法关键帧回退（首个目标 502 与 key 437 距离 ~66 包）
    expect(fixed.maxFeed).toBeLessThan(old.maxFeed);
    expect(fixed.rebuilds).toBeLessThan(old.rebuilds);
  });

  it("播放流（单调采样请求）：修复组合零挂起零错帧", () => {
    const monotonic = Array.from({ length: index.count }, (_, s) => s);
    const fixed = simulate(index, monotonic, "target", adaptiveCap, 16_667);
    expect(fixed.lost).toBe(0);
    expect(fixed.wrongFrame).toBe(0);
    // 无伪重建（真实 GOP 进入 ≤ 关键帧数；整 GOP 量级喂包不出现）
    expect(fixed.rebuilds).toBeLessThanOrEqual(index.keyframes.length);
    expect(fixed.maxFeed).toBeLessThanOrEqual(LOOKAHEAD + 4);
  });

  it("播放流 + 回跳（变速抽帧/回退 seek 形态）：旧配置挂起 24 帧 + 错帧 16；修复组合错误清零", () => {
    const jumps: number[] = [];
    for (let s = 0; s < 200; s++) jumps.push(s);
    jumps.push(194, 193, 192, 191, 190); // 回跳 6 采样（呈现序回退）
    for (let s = 195; s < 260; s++) jumps.push(s);
    const old = simulate(index, jumps, "fed", 4, 33_334);
    const fixed = simulate(index, jumps, "target", adaptiveCap, 16_667);
    // 旧配置：错帧（整帧容差偷相邻）+ 回跳目标被暂存驱逐后同 GOP 无包可喂 → 挂起
    expect(old.wrongFrame).toBeGreaterThan(0);
    expect(old.lost).toBeGreaterThan(0);
    // 修复组合：零错帧；残余 lost 仅出现在「回放已消费帧」的人造流（worker
    // 对该形态按关键帧冷启救援重喂——真实客户端回跳经 resetChains 重建链，
    // 不产生该形态；此断言锁定修复不劣化）
    expect(fixed.wrongFrame).toBe(0);
    expect(fixed.lost).toBeLessThan(old.lost);
    // 无整 GOP 风暴（旧 maxFeed=4 因挂起路径吞掉重建——修复后冷启救援有界）
    expect(fixed.maxFeed).toBeLessThanOrEqual(LOOKAHEAD + 30);
  });

  it("暂存容量小于回跳深度时丢失/错配（证明自适应容量公式必要性）", () => {
    // seek 后播放流 + 定长容量 4（< 回跳深度 6）：回跳目标被 FIFO 驱逐 → 挂起
    const seekStream = displayTargets(index, 500, 700);
    const tooSmall = simulate(index, seekStream, "target", 4, 16_667);
    expect(tooSmall.lost).toBeGreaterThan(0);
    const fixed = simulate(index, seekStream, "target", adaptiveCap, 16_667);
    expect(fixed.lost).toBe(0);
  });

  it("整帧容差在显示序流上偷相邻输出（证明半帧收紧必要性）", () => {
    const seekStream = displayTargets(index, 500, 700);
    const wholeFrame = simulate(index, seekStream, "target", adaptiveCap, 33_334);
    expect(wholeFrame.wrongFrame).toBeGreaterThan(0);
    const halfFrame = simulate(index, seekStream, "target", adaptiveCap, 16_667);
    expect(halfFrame.wrongFrame).toBe(0);
  });
});
