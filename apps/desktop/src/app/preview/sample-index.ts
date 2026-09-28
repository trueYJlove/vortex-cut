/** A03 解码 PTS 与关键帧定位索引：demux 完成后构建一次，随机 seek 与
 * 关键帧回退从 O(N) 线性扫描改为二分（比较次数可断言，不靠毫秒阈值）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN A03）：
 * - decode 输入仍按原始 sample 顺序喂包——索引只改变"查找"，绝不改变喂包顺序。
 * - 排序按 PTS（= dts + ctsOffset）升序；相同 PTS tie-break = 原 sample index
 *   小者；最近距离相同的两邻，也选择原 index 小者。
 * - B 帧非单调 CTS 下，排序索引与原始顺序脱钩——随机 seek 在排序 PTS 中
 *   lowerBound，比较左右邻居取 |pts−target| 最小者；原实现的提前 break
 *   （ptsUs > targetUs + 100ms）在非单调流会漏掉更优解，oracle 用
 *   完整扫描、不提前退出。
 * - 顺播游标：目标单调时从上次命中位置局部推进（O(1) 均摊）；反向/跨段
 *   跳转回二分。
 * - 关键帧索引：sync sample 的有序序列，二分找 ≤ 目标的最大关键帧。 */

export interface SampleIndex {
  /** 采样数。 */
  readonly count: number;
  /** PTS（微秒）原始顺序视图：ptsUs[i] = sample i 的显示时间戳。 */
  readonly ptsUs: Float64Array;
  /** 升序 PTS 排序后的原始 sample 索引（sampleByPts[k] = 第 k 小 PTS 的样本）。 */
  readonly sampleByPts: Uint32Array;
  /** 升序 PTS（与 sampleByPts 对齐：sortedPtsUs[k] = ptsUs[sampleByPts[k]]）。 */
  readonly sortedPtsUs: Float64Array;
  /** 关键帧原始索引升序序列（stss 或全关键帧回退）。 */
  readonly keyframes: Uint32Array;
  /** 排序空间前缀最大索引：maxSampleIdxByRank[r] = max(sampleByPts[0..r])。
   *  B 帧交错流上「排序位置 r 以前的全部帧」散布在原索引 0..maxSampleIdxByRank[r]；
   *  解码器释放滞后按 pts 排序距离计（D3D11 HEVC 实测随 B 金字塔结构浮动），
   *  喂包区间必须覆盖到该前缀最大索引才能保证释放目标。 */
  readonly maxSampleIdxByRank: Uint32Array;
  /** 交错跨度：max(i − rank(i))，即原索引超前其 pts 排序位置的最大值。
   *  解码器重排缓冲 ≤ has_b_frames+1 ≤ 交错跨度——喂包终点在排序空间的
   *  安全偏移量（覆盖任意释放滞后）。 */
  readonly maxStagger: number;
}

/** demux 后构建索引（一次性成本 O(N log N)，108k 样本 <10ms）。 */
export function buildSampleIndex(samples: Array<{ dts: number; ctsOffset: number; sync: boolean }>, timescale: number): SampleIndex {
  const count = samples.length;
  const ptsUs = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const sample = samples[index]!;
    ptsUs[index] = ((sample.dts + sample.ctsOffset) / timescale) * 1e6;
  }
  const sampleByPts = new Uint32Array(count);
  for (let index = 0; index < count; index++) sampleByPts[index] = index;
  // sort 稳定（V8 Array#sort / TypedArray#sort 对相等键保序）→ PTS 相同时
  // 原 sample index 小者在前（tie-break 约束）。
  Array.prototype.sort.call(sampleByPts, (a: number, b: number) => {
    const diff = ptsUs[a]! - ptsUs[b]!;
    return diff !== 0 ? diff : a - b;
  });
  const sortedPtsUs = new Float64Array(count);
  for (let k = 0; k < count; k++) sortedPtsUs[k] = ptsUs[sampleByPts[k]!]!;
  const keys: number[] = [];
  for (let index = 0; index < count; index++) {
    if (samples[index]!.sync) keys.push(index);
  }
  // 排序空间前缀最大索引（B 帧交错流的喂包覆盖计算，见 decodeSamples）
  const maxSampleIdxByRank = new Uint32Array(count);
  let runningMax = 0;
  let maxStagger = 0;
  for (let r = 0; r < count; r++) {
    const idx = sampleByPts[r]!;
    if (idx > runningMax) runningMax = idx;
    maxSampleIdxByRank[r] = runningMax;
    if (idx - r > maxStagger) maxStagger = idx - r;
  }
  return { count, ptsUs, sampleByPts, sortedPtsUs, keyframes: new Uint32Array(keys), maxSampleIdxByRank, maxStagger };
}

/** 二分比较计数（测试断言 O(log N) 用；生产忽略）。 */
export const probe = { comparisons: 0 };

/** 升序数组 lowerBound：第一个 ≥ value 的位置（k ∈ [0, length]）。 */
function lowerBound(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    probe.comparisons += 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 随机 seek 定位：排序 PTS 中 lowerBound，比较左右邻居取 |pts−target| 最小。
 *  距离并列时选择原 sample index 较小者（tie-break 与排序一致）。
 *  找不到（全部越界）返回 -1；bestDiffUs 输出最优距离（调用方判定容差）。
 *  二分路径（无游标）：比较次数 O(log N)。 */
export function locateByPts(index: SampleIndex, targetUs: number, cursor = -1): { sample: number; diffUs: number } {
  const sorted = index.sortedPtsUs;
  if (sorted.length === 0) return { sample: -1, diffUs: Number.POSITIVE_INFINITY };
  // 顺播游标：目标 PTS 与上次命中 PTS 单调递增 → 从游标局部推进
  //（每步一次比较，均摊 O(1)；跨步超过阈值回二分防长推进退化）。
  if (cursor >= 0 && cursor < sorted.length) {
    const cursorPts = sorted[cursor]!;
    if (targetUs >= cursorPts) {
      let k = cursor;
      while (k + 1 < sorted.length && sorted[k + 1]! <= targetUs) {
        k += 1;
        probe.comparisons += 1;
        if (k - cursor > 64) return locateByBinary(index, targetUs); // 长推进回二分
      }
      return pickNeighbor(index, k, targetUs);
    }
  }
  return locateByBinary(index, targetUs);
}

function locateByBinary(index: SampleIndex, targetUs: number): { sample: number; diffUs: number } {
  const sorted = index.sortedPtsUs;
  const k = lowerBound(sorted, targetUs);
  // lowerBound 落点：sorted[k-1] < targetUs ≤ sorted[k]（k 可能=length）
  return pickNeighbor(index, Math.min(k, sorted.length - 1), targetUs);
}

/** 比较排序位置 k 的左右邻居（k-1 与 k），取 |pts−target| 最小；距离并列
 *  选原 sample index 小者。并列 PTS 组（多样本同 pts）全组展开——组内
 *  index 最小者才是 tie-break 胜者（只看相邻位会漏组首）。k 已 clamp。 */
function pickNeighbor(index: SampleIndex, k: number, targetUs: number): { sample: number; diffUs: number } {
  const sorted = index.sortedPtsUs;
  if (sorted.length === 0) return { sample: -1, diffUs: Number.POSITIVE_INFINITY };
  const candidates: Array<{ sample: number; diffUs: number }> = [];
  const pushPos = (pos: number): void => {
    if (pos < 0 || pos >= sorted.length) return;
    const pts = sorted[pos]!;
    const diff = Math.abs(pts - targetUs);
    // 并列组全展开：向两侧扫完所有 pts 相同的相邻位
    candidates.push({ sample: index.sampleByPts[pos]!, diffUs: diff });
    let lo = pos - 1;
    while (lo >= 0 && sorted[lo]! === pts) { candidates.push({ sample: index.sampleByPts[lo]!, diffUs: diff }); lo -= 1; }
    let hi = pos + 1;
    while (hi < sorted.length && sorted[hi]! === pts) { candidates.push({ sample: index.sampleByPts[hi]!, diffUs: diff }); hi += 1; }
  };
  pushPos(k);
  pushPos(k - 1);
  pushPos(k + 1);
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.diffUs < best.diffUs
      || (candidate.diffUs === best.diffUs && candidate.sample < best.sample)) {
      best = candidate;
    }
  }
  return best;
}

/** 关键帧回退：≤ sample 的最大关键帧原始索引（无 ≤ 者返回 0——与原实现
 *  "startSample 退到 0" 语义一致）。二分 O(log N)。 */
export function keyframeAtOrBefore(index: SampleIndex, sample: number): number {
  const keys = index.keyframes;
  if (keys.length === 0) return 0;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    probe.comparisons += 1;
    if (keys[mid]! <= sample) lo = mid + 1;
    else hi = mid;
  }
  // lo = 第一个 > sample 的关键帧位置；lo-1 = 最后一个 ≤ sample 的
  return lo > 0 ? keys[lo - 1]! : 0;
}

/** oracle：完整扫描、不提前退出（测试金标准——原实现的提前 break 在
 *  非单调 PTS 流会漏掉更优解，不作为正确性依据）。 */
export function locateByPtsOracle(index: SampleIndex, targetUs: number): { sample: number; diffUs: number } {
  let best = { sample: -1, diffUs: Number.POSITIVE_INFINITY };
  for (let i = 0; i < index.count; i++) {
    const diff = Math.abs(index.ptsUs[i]! - targetUs);
    if (diff < best.diffUs
      || (diff === best.diffUs && (best.sample < 0 || i < best.sample))) {
      best = { sample: i, diffUs: diff };
    }
  }
  return best;
}
