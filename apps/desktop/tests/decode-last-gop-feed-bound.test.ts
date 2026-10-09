/**
 * P71 末段 GOP 喂包终点边界回归（真机「固定 2:47:07 起卡」根修）。
 *
 * ## 病根（trace 实锤）
 *
 * W2.6 为覆盖**截断尾 GOP**，把「目标位于最后一个 GOP」时的**初始喂包终点**
 * 直接设为文件尾。但「末段 GOP」≠「接近文件尾」：用户 1920x1080 **50fps** 素材
 * 共 8400 采样、GOP=50（1s），末段 GOP = 源采样 8350..8399 **完整 50 帧**，
 * 目标 8365 距文件尾还有 34 个采样。无界终点使该请求从游标 8371 一口气灌到 8399
 * （29 个采样）——解码器输入队列 `dq` 2→30 **单调攀升且零输出**（表面池停摆），
 * 只能靠 `stall_retry` 整例重建 + 关键帧重喂挽回（约 1s 空窗 = 用户看到的固定
 * 卡顿，落在帧 5017 = 00:02:47:07）；同时喂包游标被推到目标之后，紧随其后的
 * 顺序请求被误判 `behindCursor` → 近邻替代交付重复帧。
 *
 * ## 契约（本测试锁定的不变量）
 *
 * **单次喂包的初始终点必须恒有界**：`initialFeedEnd(target) ≤ feedEndFor(target)`，
 * 与目标是否位于末段 GOP 无关。「喂到文件尾」只允许经由 worker 内**输出驱动**的
 * 几何小步延伸发生（要求静默 STALL_MS 且 `dq==0`）。
 *
 * 截断尾 GOP 语义**不受影响**：`feedEndFor` 对贴近文件尾的目标本就返回文件尾
 * （排序位 + 偏移被 count−1 截断），故 W2.6 的 EOF 定格/回卷行为原样保留。
 * 该保留由 tests/… 的 e2e `p33-eof-replay` 端到端覆盖。
 */
import { describe, expect, it } from "vitest";
import { buildSampleIndex, feedEndForIndex, initialFeedEnd, keyframeAtOrBefore } from "../src/app/preview/sample-index.js";

/** 用户素材形状：50fps、8400 采样（168s）、GOP=50（关键帧每 1s）。 */
const FPS = 50;
const COUNT = 8400;
const GOP = 50;
/** 无 B 帧（该素材 has_b_frames=0）→ 呈现序 == 采样序。 */
const BFRAME_LOOKAHEAD = 3;

function buildFixture() {
  const samples = Array.from({ length: COUNT }, (_, i) => ({
    dts: i * (1000 / FPS),
    ctsOffset: 0,
    sync: i % GOP === 0,
  }));
  return buildSampleIndex(samples, 1000);
}

/** 旧策略（W2.6 至 P71 前）：末段 GOP 目标 → 文件尾。保留以便反向对照。 */
function legacyInitialFeedEnd(index: ReturnType<typeof buildFixture>, target: number): number {
  const lastGopKey = index.keyframes[index.keyframes.length - 1] ?? -1;
  const inLastGop = keyframeAtOrBefore(index, target) === lastGopKey;
  return inLastGop ? index.count - 1 : feedEndForIndex(index, target, BFRAME_LOOKAHEAD);
}

describe("P71 末段 GOP 初始喂包终点必须有界", () => {
  const index = buildFixture();

  it("复现真机数字：目标 8365（帧 5019）的初始终点不得是文件尾", () => {
    const bounded = initialFeedEnd(index, 8365, BFRAME_LOOKAHEAD);
    // 排序位 8365 + 偏移 3 = 8368，距文件尾 8399 还有 31 个采样
    expect(bounded).toBe(8368);
    expect(bounded).toBeLessThan(index.count - 1);
    // 反向对照：旧策略给出文件尾 → 单请求可灌 29 个采样（trace 实测 8371→8399）
    const legacy = legacyInitialFeedEnd(index, 8365);
    expect(legacy).toBe(8399);
    const cursor = 8370; // 上一次请求把游标推到这里（trace: lastFedSample=8370）
    expect(Math.max(0, legacy - cursor)).toBe(29);
    expect(Math.max(0, bounded - cursor)).toBe(0); // 有界后该请求不再灌包，改为等输出
  });

  it("不变量：任何目标的初始终点 ≤ feedEndFor，且不因「末段 GOP」跳变到文件尾", () => {
    const lastGopKey = index.keyframes[index.keyframes.length - 1]!;
    expect(lastGopKey).toBe(8350);
    for (let target = 8350; target < index.count; target += 7) {
      const bounded = initialFeedEnd(index, target, BFRAME_LOOKAHEAD);
      expect(bounded).toBe(feedEndForIndex(index, target, BFRAME_LOOKAHEAD));
      expect(bounded).toBeGreaterThanOrEqual(target);
      expect(bounded).toBeLessThanOrEqual(index.count - 1);
    }
    // 末段 GOP 中段（距文件尾 > 偏移）一律有界；旧策略在这里全是文件尾
    for (const target of [8351, 8360, 8365, 8380, 8390]) {
      expect(initialFeedEnd(index, target, BFRAME_LOOKAHEAD)).toBeLessThan(index.count - 1);
      expect(legacyInitialFeedEnd(index, target)).toBe(index.count - 1);
    }
  });

  it("截断尾 GOP 语义保留：贴近文件尾的目标仍到文件尾（W2.6 不被回归）", () => {
    // 偏移 3 → 目标 ≥ count−1−3 时终点自然被截断到文件尾
    for (const target of [8396, 8397, 8398, 8399]) {
      expect(initialFeedEnd(index, target, BFRAME_LOOKAHEAD)).toBe(index.count - 1);
    }
    // 截断尾 GOP（真机 HEVC 素材：末段仅 20 帧）同理——目标落在尾 3 帧内即到文件尾
    const truncated = buildSampleIndex(
      Array.from({ length: 1777 }, (_, i) => ({ dts: i * (1000 / 30), ctsOffset: 0, sync: i % 88 === 0 || i === 1757 })),
      1000,
    );
    expect(initialFeedEnd(truncated, 1776, BFRAME_LOOKAHEAD)).toBe(1776);
  });

  it("B 帧交错流：偏移取 max(lookahead, 交错跨度+1)，终点覆盖排序位前缀最大原索引", () => {
    // 构造 B 帧金字塔式 ctts：偶数采样显示序滞后（ctsOffset 交错）
    const samples = Array.from({ length: 200 }, (_, i) => ({
      dts: i * (1000 / 30),
      ctsOffset: i % 4 === 3 ? -2 * (1000 / 30) : i % 4 === 0 ? 1 * (1000 / 30) : 0,
      sync: i % 88 === 0,
    }));
    const bframe = buildSampleIndex(samples, 1000);
    expect(bframe.maxStagger).toBeGreaterThan(0);
    for (const target of [10, 50, 120, 180]) {
      const end = initialFeedEnd(bframe, target, BFRAME_LOOKAHEAD);
      expect(end).toBeGreaterThanOrEqual(target);
      expect(end).toBeLessThanOrEqual(bframe.count - 1);
      // 交错流上终点必须覆盖「目标排序位 + 交错跨度」以内的全部原索引
      expect(end).toBeGreaterThanOrEqual(feedEndForIndex(bframe, target, BFRAME_LOOKAHEAD));
    }
  });

  it("forcedEnd 显式覆写优先（worker 参数语义不变）", () => {
    expect(initialFeedEnd(index, 8365, BFRAME_LOOKAHEAD, 8399)).toBe(8399);
    expect(initialFeedEnd(null, 42, BFRAME_LOOKAHEAD)).toBe(42); // 无索引：目标原样
  });
});
