/** M3-0 探针公共：确定性 PRNG（固定种子，报告记录种子值）与百分位统计。 */

/** mulberry32 — 确定性 32 位 PRNG，实现公开可复算（LiuKeAi 复跑要求）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function summarize(values: number[]) {
  if (values.length === 0) return { count: 0, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  return {
    count: values.length,
    p50: round3(percentile(values, 50)),
    p95: round3(percentile(values, 95)),
    max: round3(Math.max(...values)),
    mean: round3(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export const P1_SCRUB_SEED = 20260904;
export const P3_SEED = 20260905;
