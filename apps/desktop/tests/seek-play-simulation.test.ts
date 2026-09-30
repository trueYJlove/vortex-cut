/**
 * 真机素材（fdf0f0e2 采样表）上的解码链路高保真仿真：回归门「时间线任意位置
 * 跳转后点播放卡死 + decode worker watchdog 无匹配输出」的修复。
 *
 * 忠实移植 decode-worker.worker.ts P33 W2.7/W2.8 之后的关键语义：
 * - 请求流 = preview-session pump 的展示序 src_n（升序 PTS/rank）；
 * - cache(3) → stash(takeByPts) → 串行队列 → decodeSamples；
 * - 冷启决策 = neverFed | missingStuck(输出已吐出被驱逐) | farForward(成本比较)；
 *   其余一律热态续喂（跨 GOP 连续过界不重建——丢帧根治）；
 * - feedSamples 增量延伸（EXTEND_STEP，dq 排空才延伸）——终点估短不死等；
 * - 输出按 pts 序释放（喂 N 释前 N-2），stash 智能驱逐（保距目标最近）；
 * - EOF 尾 GOP 定格替代（postEofFreezeFrame）；
 * - 45s 看门狗 = 请求在喂包结束后仍未匹配输出（dangling）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSampleIndex, keyframeAtOrBefore, type SampleIndex } from "../src/app/preview/sample-index.js";

interface FixtureSample { dts: number; cts: number; sync: boolean; size: number }
const LOOKAHEAD = 3;
const TOL_US = 16_667;
const STASH_CAP = 6;
const REBUILD_OVERHEAD = 24;

function load(): { timescale: number; samples: FixtureSample[] } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "user-media-sample-table.json");
  return JSON.parse(readFileSync(path, "utf8")) as { timescale: number; samples: FixtureSample[] };
}

type Result = "ok" | "stash" | "cache" | "freeze" | "eof_error" | "dangling";

interface ReqLog { target: number; result: Result; fed: number; wrongFrom?: number }

class Sim {
  index: SampleIndex;
  lastFedSample = -1;
  lastTargetKey = -1;
  lastRequestPtsUs = -1;
  emittedRankMax = -1;
  readyByPts = new Map<number, number>();
  cache = new Map<number, number>();
  /** 已喂未吐的采样集合（真实解码器重排缓冲的近似）。 */
  fedSet = new Set<number>();
  coldStarts = 0;
  totalFed = 0;

  constructor(index: SampleIndex) { this.index = index; }

  feedEndFor(target: number): number {
    const idx = this.index;
    const pts = idx.ptsUs[target]!;
    let lo = 0, hi = idx.sortedPtsUs.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (idx.sortedPtsUs[mid]! < pts) lo = mid + 1; else hi = mid; }
    const offset = Math.max(LOOKAHEAD, idx.maxStagger + 1);
    const rankEnd = Math.min(idx.count - 1, lo + offset);
    return Math.max(target, Math.min(idx.count - 1, idx.maxSampleIdxByRank[rankEnd]!));
  }

  rankOf(target: number): number {
    const pts = this.index.ptsUs[target]!;
    let lo = 0, hi = this.index.sortedPtsUs.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.index.sortedPtsUs[mid]! < pts) lo = mid + 1; else hi = mid; }
    return lo;
  }

  stashByPts(pts: number, sample: number): void {
    if (this.readyByPts.size >= STASH_CAP) {
      let worstKey = -1, worstDist = -1;
      for (const key of this.readyByPts.keys()) {
        const dist = Math.abs(key - this.lastRequestPtsUs);
        if (dist > worstDist) { worstDist = dist; worstKey = key; }
      }
      if (worstKey >= 0) this.readyByPts.delete(worstKey);
    }
    this.readyByPts.set(pts, sample);
    this.emittedRankMax = Math.max(this.emittedRankMax, this.rankOf(sample));
  }

  takeByPts(ptsUs: number): number | null {
    const hit = this.readyByPts.get(ptsUs);
    if (hit !== undefined) { this.readyByPts.delete(ptsUs); return hit; }
    for (const [pts, s] of this.readyByPts) {
      if (Math.abs(pts - ptsUs) <= 1_000) { this.readyByPts.delete(pts); return s; }
    }
    return null;
  }

  /** 释放 [from..end] 新喂采样：真实解码器吐出「已喂未吐」的全部帧（不限本
   *  批次——B 帧交错下目标包常在前批喂过），按 pts 序，喂 N 释前 N-2。 */
  emit(from: number, end: number, targetPts: number, active: { matched: boolean }): void {
    const idx = this.index;
    for (let i = from; i <= end; i++) this.fedSet.add(i);
    const rankLimit = this.rankOf(end) - 1;
    const pending = [...this.fedSet].filter(i => this.rankOf(i) > this.emittedRankMax && this.rankOf(i) <= rankLimit)
      .sort((a, b) => idx.ptsUs[a]! - idx.ptsUs[b]!);
    for (const s of pending) {
      const pts = idx.ptsUs[s]!;
      this.emittedRankMax = Math.max(this.emittedRankMax, this.rankOf(s));
      this.fedSet.delete(s);
      if (!active.matched && Math.abs(pts - targetPts) <= TOL_US) {
        active.matched = true;
        this.cache.set(s, pts);
        continue;
      }
      this.stashByPts(pts, s);
    }
  }

  coldStart(start: number): void {
    this.readyByPts.clear();
    this.fedSet.clear();
    this.coldStarts += 1;
    this.lastFedSample = start - 1;
    this.emittedRankMax = this.rankOf(start) - 1;
  }

  request(frameN: number, fps: number): ReqLog {
    const idx = this.index;
    const targetUs = (frameN / fps) * 1e6;
    let target = -1, bestDiff = Infinity;
    for (let i = 0; i < idx.count; i++) {
      const d = Math.abs(idx.ptsUs[i]! - targetUs);
      if (d < bestDiff || (d === bestDiff && i < target)) { bestDiff = d; target = i; }
    }
    const samplePtsUs = idx.ptsUs[target]!;
    this.lastRequestPtsUs = samplePtsUs;
    if (this.cache.has(target)) return { target, result: "cache", fed: 0 };
    const staged = this.takeByPts(samplePtsUs);
    if (staged !== null) {
      this.cache.set(target, samplePtsUs);
      return { target, result: "stash", fed: 0 };
    }
    const keyTarget = keyframeAtOrBefore(idx, target);
    const active = { matched: false };
    // W2.8 冷启决策
    const targetRank = this.rankOf(target);
    const missingStuck = targetRank <= this.emittedRankMax;
    const neverFed = this.lastFedSample < 0;
    const forwardGap = target > this.lastFedSample ? target - this.lastFedSample : 0;
    const rebuildCost = Math.max(0, target - keyTarget);
    const farForward = target > this.lastFedSample && forwardGap > rebuildCost + REBUILD_OVERHEAD;
    if (neverFed || missingStuck || farForward) {
      this.coldStart(keyTarget);
      this.lastTargetKey = keyTarget;
      // feedSamples 模型：分批喂 + 批间检查匹配；终点估短则增量延伸
      let realEnd = Math.min(idx.count - 1, this.feedEndFor(target));
      let fedNow = 0;
      for (;;) {
        this.emit(this.lastFedSample + 1, realEnd, samplePtsUs, active);
        fedNow += realEnd - this.lastFedSample;
        this.lastFedSample = realEnd;
        if (active.matched) break;
        if (realEnd >= idx.count - 1) break;
        if (this.rankOf(target) <= this.rankOf(realEnd) - 1) break;
        const extEnd = Math.min(idx.count - 1, realEnd + 32);
        if (extEnd <= realEnd) break;
        realEnd = extEnd;
      }
      this.totalFed += fedNow;
      if (active.matched) return { target, result: "ok", fed: fedNow };
      // 喂到文件尾仍 miss → EOF 定格/报错
      return this.eofRescue(target, samplePtsUs, fedNow);
    }
    // 热态续喂（含跨 GOP 连续过界——W2.8 不再冷启）
    this.lastTargetKey = keyTarget;
    const start = this.lastFedSample + 1;
    const needEnd = this.feedEndFor(target);
    // feedSamples 增量延伸模型：先喂到 needEnd，仍未匹配则逐段延伸（32/段）
    // 至文件尾——目标已喂过（start > needEnd）时同样向前延伸释放重排滞留。
    let realEnd = Math.max(needEnd, start - 1);
    let fedNow = 0;
    for (;;) {
      if (start <= realEnd) {
        this.emit(start, realEnd, samplePtsUs, active);
        fedNow += realEnd - Math.max(start, this.lastFedSample + 1) + 1;
        this.lastFedSample = Math.max(this.lastFedSample, realEnd);
      } else {
        // 目标已喂过且 needEnd 未超前：延伸释放（喂 realEnd+1..realEnd+32）
        const extEnd = Math.min(idx.count - 1, realEnd + 32);
        if (extEnd <= realEnd) break;
        realEnd = extEnd;
        this.emit(this.lastFedSample + 1, realEnd, samplePtsUs, active);
        fedNow += realEnd - this.lastFedSample;
        this.lastFedSample = realEnd;
        continue;
      }
      if (active.matched) break;
      if (this.lastFedSample >= idx.count - 1) break;
      if (realEnd >= needEnd && start <= realEnd && this.rankOf(target) <= this.rankOf(realEnd) - 1) break;
      // 未达目标排序位：延伸
      const extEnd = Math.min(idx.count - 1, realEnd + 32);
      if (extEnd <= realEnd) break;
      realEnd = extEnd;
    }
    this.totalFed += fedNow;
    if (active.matched) return { target, result: "ok", fed: fedNow };
    if (this.lastFedSample >= idx.count - 1) return this.eofRescue(target, samplePtsUs, fedNow);
    return { target, result: "dangling", fed: fedNow };
  }

  eofRescue(target: number, samplePtsUs: number, fed: number): ReqLog {
    let donor: number | null = null, donorPts = -Infinity;
    for (const [pts, s] of this.readyByPts) {
      if (pts <= samplePtsUs + 1_000 && pts > donorPts) { donorPts = pts; donor = s; }
    }
    if (donor === null) {
      for (const [k, pts] of this.cache) {
        if (k <= target && pts <= samplePtsUs + 1_000 && (donor === null || pts > donorPts)) { donorPts = pts; donor = k; }
      }
    }
    if (donor !== null) {
      this.cache.set(target, donorPts);
      return { target, result: "freeze", fed, wrongFrom: donor };
    }
    return { target, result: "eof_error", fed };
  }
}

describe("seek→play 卡死仿真（真机采样表，W2.7/W2.8 修复回归）", () => {
  const fixture = load();
  const index = buildSampleIndex(fixture.samples.map(s => ({ dts: s.dts, ctsOffset: s.cts, sync: s.sync })), fixture.timescale);

  it("基线：从头顺序播放全程（零卡死 + 冷启 ≤ 2）", () => {
    const s = new Sim(index);
    const all: ReqLog[] = [];
    for (let n = 0; n <= 1700; n++) all.push(s.request(n, 30));
    const stuck = all.filter(l => l.result === "dangling" || l.result === "eof_error");
    const wrong = all.filter(l => l.result === "freeze" && l.wrongFrom !== l.target);
    console.log(`[baseline] stuck=${stuck.length} wrong=${wrong.length} coldStarts=${s.coldStarts} totalFed=${s.totalFed}`);
    if (stuck.length) console.log("  first stuck", stuck.slice(0, 5));
    expect(stuck.length).toBe(0);
    // W2.8：顺序播放应只冷启 1 次（起播），GOP 边界不再重建风暴
    expect(s.coldStarts).toBeLessThanOrEqual(2);
  });

  it("场景 C：播放到 500 → 同 GOP 回跳 450 → 播放", () => {
    const s = new Sim(index);
    for (let n = 0; n <= 500; n++) s.request(n, 30);
    const before = { cold: s.coldStarts, fed: s.totalFed };
    const logs: ReqLog[] = [];
    for (let n = 450; n <= 500; n++) logs.push(s.request(n, 30));
    const stuck = logs.filter(l => l.result === "dangling" || l.result === "eof_error");
    const wrong = logs.filter(l => l.result === "freeze" && l.wrongFrom !== l.target);
    console.log(`[C same-gop-back] stuck=${stuck.length} wrong=${wrong.length} fedDuring=${s.totalFed - before.fed} coldStarts=${s.coldStarts - before.cold}`);
    console.log("  logs", logs.slice(0, 8).map(l => `${l.target}:${l.result}(${l.fed})`).join(" "));
    expect(stuck.length).toBe(0);
  });

  it("场景 D：播放到 488 → 跳 257（跨 GOP）→ 播放", () => {
    const s = new Sim(index);
    for (let n = 0; n <= 488; n++) s.request(n, 30);
    const before = { cold: s.coldStarts, fed: s.totalFed };
    const logs: ReqLog[] = [];
    for (let n = 257; n <= 320; n++) logs.push(s.request(n, 30));
    const stuck = logs.filter(l => l.result === "dangling" || l.result === "eof_error");
    const wrong = logs.filter(l => l.result === "freeze" && l.wrongFrom !== l.target);
    console.log(`[D cross-gop-back] stuck=${stuck.length} wrong=${wrong.length} fedDuring=${s.totalFed - before.fed} coldStarts=${s.coldStarts - before.cold}`);
    if (stuck.length) console.log("  stuck", stuck.slice(0, 5));
    if (wrong.length) console.log("  wrong", wrong.slice(0, 5));
    expect(stuck.length).toBe(0);
    expect(wrong.length).toBe(0);
  });

  it("场景 E：播到尾 → 回卷从头", () => {
    const s = new Sim(index);
    for (let n = 0; n <= 1771; n++) s.request(n, 30);
    const logs: ReqLog[] = [];
    for (let n = 0; n <= 100; n++) logs.push(s.request(n, 30));
    const stuck = logs.filter(l => l.result === "dangling" || l.result === "eof_error");
    console.log(`[E rewind] stuck=${stuck.length} coldStarts=${s.coldStarts} fed=${s.totalFed}`);
    if (stuck.length) console.log("  stuck", stuck.slice(0, 5));
    expect(stuck.length).toBe(0);
  });

  it("场景 F：随机 seek（20 个位置各播 30 帧）", () => {
    const s = new Sim(index);
    const spots = [30, 120, 200, 257, 300, 350, 400, 450, 488, 520, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500];
    const all: ReqLog[] = [];
    for (const spot of spots) {
      for (let n = Math.max(0, spot - 60); n < spot; n++) s.request(n, 30);
      for (let n = spot; n <= spot + 30; n++) all.push(s.request(n, 30));
    }
    const stuck = all.filter(l => l.result === "dangling" || l.result === "eof_error");
    const wrong = all.filter(l => l.result === "freeze" && l.wrongFrom !== l.target);
    console.log(`[F random-seek] stuck=${stuck.length} wrong=${wrong.length} coldStarts=${s.coldStarts} totalFed=${s.totalFed}`);
    if (stuck.length) console.log("  stuck sample", stuck.slice(0, 8).map(l => `${l.target}:${l.result}(fed${l.fed})`).join(" "));
    if (wrong.length) console.log("  wrong sample", wrong.slice(0, 8).map(l => `${l.target}<-${l.wrongFrom}`).join(" "));
    expect(stuck.length).toBe(0);
    expect(wrong.length).toBe(0);
  });

  it("场景 G：图3 现场复刻——播放到 488 后跳 257 附近播放", () => {
    const s = new Sim(index);
    // 先顺播到 488（图1/2 的状态）
    for (let n = 0; n <= 488; n++) s.request(n, 30);
    // 跳到 8:17 时间码附近（250-257）点播放
    const logs: ReqLog[] = [];
    for (let n = 250; n <= 300; n++) logs.push(s.request(n, 30));
    const stuck = logs.filter(l => l.result === "dangling" || l.result === "eof_error");
    const wrong = logs.filter(l => l.result === "freeze" && l.wrongFrom !== l.target);
    console.log(`[G user-scenario] stuck=${stuck.length} wrong=${wrong.length} coldStarts=${s.coldStarts}`);
    if (stuck.length) console.log("  stuck", stuck.slice(0, 5));
    expect(stuck.length).toBe(0);
  });
});
