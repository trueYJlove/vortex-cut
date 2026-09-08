/** A03 采样索引回归：PTS 排序索引 + 关键帧二分 + 顺播游标。
 *  覆盖计划要求的场景：108k 样本、随机/递增/回退目标、B 帧非单调 CTS、
 *  负/重复 PTS、VFR、tie（相同 PTS / 最近距离并列）、最后一帧、范围外。
 *  正确性金标准 = locateByPtsOracle（完整扫描、不提前退出——旧实现的
 *  ptsUs > target+100ms 提前 break 在非单调流会漏更优解，不作金标准）。
 *  性能口径 = 比较次数断言（随机 seek O(log N)，游标单调推进 O(1) 均摊），
 *  不用 CI 毫秒阈值。 */
import { describe, expect, it } from "vitest";
import { buildSampleIndex, keyframeAtOrBefore, locateByPts, locateByPtsOracle, probe, type SampleIndex } from "../src/app/preview/sample-index.js";

interface SampleLike { dts: number; ctsOffset: number; sync: boolean }

/** CFR 采样构造（timescale 微秒制简化：ts=1e6 → dts 即 µs）。 */
function cfrSamples(count: number, fps = 30, gop = 15, ctsOffset = 0): SampleLike[] {
  const samples: SampleLike[] = [];
  for (let index = 0; index < count; index++) {
    samples.push({ dts: Math.round((index / fps) * 1e6), ctsOffset, sync: index % gop === 0 });
  }
  return samples;
}

/** B 帧模式：偶数采样前移一帧时长（显示序先于解码序），CTS 非单调。 */
function bframeSamples(count: number, fps = 30, gop = 30): SampleLike[] {
  const frameDur = Math.round((1 / fps) * 1e6);
  const samples: SampleLike[] = [];
  for (let index = 0; index < count; index++) {
    const dts = index * frameDur;
    // 奇数位是 B 帧：显示早于解码（ctsOffset 负）；偶数位（P/I）晚一帧
    const ctsOffset = index % 2 === 1 ? -frameDur : index > 0 ? frameDur / 2 : 0;
    samples.push({ dts, ctsOffset, sync: index % gop === 0 });
  }
  return samples;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildSampleIndex", () => {
  it("CFR：ptsUs 原始顺序、排序索引升序、关键帧序列正确", () => {
    const samples = cfrSamples(90, 30, 15);
    const index = buildSampleIndex(samples, 1e6);
    expect(index.count).toBe(90);
    expect(index.ptsUs[0]).toBe(0);
    expect(index.ptsUs[89]).toBeCloseTo(89 / 30 * 1e6, 0);
    for (let k = 1; k < index.count; k++) {
      expect(index.sortedPtsUs[k]!).toBeGreaterThanOrEqual(index.sortedPtsUs[k - 1]!);
    }
    expect(Array.from(index.keyframes)).toEqual([0, 15, 30, 45, 60, 75]);
  });

  it("相同 PTS tie-break：原 sample index 小者在排序序列前", () => {
    const samples: SampleLike[] = [
      { dts: 100, ctsOffset: 0, sync: true },
      { dts: 50, ctsOffset: 50, sync: false },
      { dts: 100, ctsOffset: 0, sync: false },
    ];
    const index = buildSampleIndex(samples, 1e6);
    // 三样本同 PTS 100µs：排序序列按原始索引 0,1,2
    expect(Array.from(index.sampleByPts)).toEqual([0, 1, 2]);
    // 定位该 PTS：距离并列 → 选原 index 最小者（0）
    expect(locateByPts(index, 100).sample).toBe(0);
  });

  it("无 stss 回退全关键帧：keyframes 为全序列", () => {
    const samples = cfrSamples(10, 30, 15).map(sample => ({ ...sample, sync: true }));
    const index = buildSampleIndex(samples, 1e6);
    expect(index.keyframes.length).toBe(10);
    expect(keyframeAtOrBefore(index, 9)).toBe(9);
  });
});

describe("locateByPts vs oracle（随机目标全覆盖）", () => {
  const cases: Array<{ name: string; samples: SampleLike[] }> = [
    { name: "CFR 单调", samples: cfrSamples(300, 30, 15) },
    { name: "B 帧非单调 CTS", samples: bframeSamples(300, 30, 30) },
    { name: "VFR 帧时长抖动", samples: cfrSamples(300, 30, 15).map((sample, i) => ({ ...sample, dts: sample.dts + (i % 7) * 333 })) },
    { name: "负 ctsOffset", samples: cfrSamples(200, 30, 12).map(sample => ({ ...sample, ctsOffset: -500_000 })) },
    { name: "重复 PTS（dts+cts 折返）", samples: cfrSamples(200, 30, 10).map((sample, i) => ({ ...sample, dts: i < 100 ? sample.dts : sample.dts - 1_000_000, sync: sample.sync })) },
  ];

  for (const { name, samples } of cases) {
    it(`${name}：1000 个种子化随机目标二分 == oracle`, () => {
      const index = buildSampleIndex(samples, 1e6);
      const rng = mulberry32(20260908);
      for (let i = 0; i < 1000; i++) {
        const targetUs = rng() * (10 * 1e6) - 1e6; // 含负目标（范围外）
        const viaIndex = locateByPts(index, targetUs);
        const viaOracle = locateByPtsOracle(index, targetUs);
        expect(viaIndex.sample).toBe(viaOracle.sample);
        expect(viaIndex.diffUs).toBe(viaOracle.diffUs);
      }
    });
  }

  it("B 帧流：旧线性扫描提前 break 会漏的位置，索引路径与 oracle 一致", () => {
    // 构造：前段一个超大 PTS（> target+100ms）后跟更近的采样——旧实现
    // break 在前者，oracle 与索引都应命中后者。
    const samples: SampleLike[] = [
      { dts: 0, ctsOffset: 0, sync: true },
      { dts: 5_000_000, ctsOffset: 0, sync: false }, // 5s：旧实现在此 break
      { dts: 100_000, ctsOffset: 0, sync: false },   // 100ms：真正最近
      { dts: 101_000, ctsOffset: 0, sync: false },
    ];
    const index = buildSampleIndex(samples, 1e6);
    const viaIndex = locateByPts(index, 100_500);
    const viaOracle = locateByPtsOracle(index, 100_500);
    expect(viaOracle.sample).toBe(2); // oracle 命中真正最近的样本 2
    expect(viaIndex.sample).toBe(viaOracle.sample);
    expect(viaIndex.sample).toBe(2);
  });

  it("最后一帧与范围外目标", () => {
    const samples = cfrSamples(90, 30, 15);
    const index = buildSampleIndex(samples, 1e6);
    const last = 89 / 30 * 1e6;
    expect(locateByPts(index, last).sample).toBe(89);
    expect(locateByPts(index, last + 500_000).sample).toBe(89); // 越界仍取最近（调用方按 diff 判容差）
    expect(locateByPts(index, -1e6).sample).toBe(0);
    const empty = buildSampleIndex([], 1e6);
    expect(locateByPts(empty, 0).sample).toBe(-1);
  });

  it("108k 样本：随机 seek 比较次数 O(log N)（≤ 2×log2 + 常数）", () => {
    const count = 108_000;
    const samples = cfrSamples(count, 30, 250); // 长源长 GOP（60min@30fps）
    const index = buildSampleIndex(samples, 1e6);
    const rng = mulberry32(20260908);
    let maxComparisons = 0;
    for (let i = 0; i < 300; i++) {
      probe.comparisons = 0;
      locateByPts(index, rng() * (count / 30 * 1e6));
      maxComparisons = Math.max(maxComparisons, probe.comparisons);
    }
    // log2(108000) ≈ 16.7；二分 + pickNeighbor 常数次比较 → 上限 2×log2+8
    expect(maxComparisons).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count)) + 8);
    expect(maxComparisons).toBeGreaterThan(4); // 确非全扫描退化
  });

  it("游标单调推进：递增目标序列比较次数均摊 O(1)（≤ 常数×步数）", () => {
    const samples = cfrSamples(3600, 30, 30); // 2 分钟
    const index = buildSampleIndex(samples, 1e6);
    let cursor = -1;
    probe.comparisons = 0;
    for (let frame = 0; frame < 3600; frame += 1) {
      const located = locateByPts(index, (frame / 30) * 1e6, cursor);
      cursor = index.sampleByPts.indexOf(located.sample);
    }
    // 3600 次递增查询：游标路径下总比较应远小于 3600×log2(3600)
    const total = probe.comparisons;
    expect(total).toBeLessThan(3600 * 4); // 均摊每查询 <4 次比较
  });

  it("回退目标（游标不可用）自动回二分且结果正确", () => {
    const samples = cfrSamples(300, 30, 15);
    const index = buildSampleIndex(samples, 1e6);
    let cursor = -1;
    let last = locateByPts(index, 5 * 1e6, cursor);
    cursor = index.sampleByPts.indexOf(last.sample);
    // 回退 seek：目标小于游标 → 二分路径
    probe.comparisons = 0;
    const back = locateByPts(index, 1e6, cursor);
    expect(back.sample).toBe(locateByPtsOracle(index, 1e6).sample);
    expect(probe.comparisons).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(300)) + 8);
  });
});

describe("keyframeAtOrBefore", () => {
  it("≤ target 的最大关键帧；无 ≤ 者返回 0（原回退语义）", () => {
    const samples = cfrSamples(100, 30, 15);
    const index = buildSampleIndex(samples, 1e6);
    expect(keyframeAtOrBefore(index, 0)).toBe(0);
    expect(keyframeAtOrBefore(index, 14)).toBe(0);
    expect(keyframeAtOrBefore(index, 15)).toBe(15);
    expect(keyframeAtOrBefore(index, 29)).toBe(15);
    expect(keyframeAtOrBefore(index, 99)).toBe(90);
  });

  it("关键帧索引二分与线性回退 oracle 一致（随机目标）", () => {
    const samples = cfrSamples(1000, 30, 7);
    const index = buildSampleIndex(samples, 1e6);
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const target = Math.floor(rng() * 1000);
      let expected = 0;
      for (let s = target; s >= 0; s--) { if (samples[s]!.sync) { expected = s; break; } }
      expect(keyframeAtOrBefore(index, target)).toBe(expected);
    }
  });
});

describe("喂包顺序不变（协议不变式）", () => {
  it("排序索引不改变原始顺序喂包：sampleByPts 是排列而非重写", () => {
    const samples = bframeSamples(200, 30, 30);
    const index: SampleIndex = buildSampleIndex(samples, 1e6);
    // sampleByPts 必须是 0..N-1 的一个排列（每个原始样本恰好出现一次）
    const seen = new Uint8Array(index.count);
    for (const sample of index.sampleByPts) {
      expect(seen[sample]).toBe(0);
      seen[sample] = 1;
    }
    expect(seen.reduce((a, b) => a + b, 0)).toBe(index.count);
    // ptsUs 保持原始顺序（dts+ctsOffset 直译）
    for (let i = 0; i < index.count; i++) {
      expect(index.ptsUs[i]).toBeCloseTo(((samples[i]!.dts + samples[i]!.ctsOffset) / 1e6) * 1e6, 6);
    }
  });
});
