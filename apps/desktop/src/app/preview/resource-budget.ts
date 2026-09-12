/** B13 资源预算档位（计划第 6 节 B13）。
 *
 * 约束：
 * - Main 只传离散档位（conservative/balanced/high），不向 Renderer 暴露
 *   额外主机信息；不能仅凭 navigator.deviceMemory 决定独显显存。
 * - 档位默认表（MiB）：
 *   conservative：Range 缓存 64 / PCM 缓存 64 / 纹理估算 128 / 保温 1 / 窗缓存 16 / 预取 1 / 窗在途 2
 *   balanced：    128 / 128 / 256 / 2 / 32 / 2 / 3
 *   high：        256 / 256 / 512 / 2 / 64 / 2 / 4
 * - 资源紧张先缩预热、清 idle、降代理/池深，仍无法满足 active 则明确
 *   回退/暂停并提示，不能静默删图层。
 */
export type BudgetTier = "conservative" | "balanced" | "high";

export interface BudgetTable {
  /** 压缩 Range 字节缓存总预算（MiB）。 */
  rangeCacheMiB: number;
  /** PCM 音频缓存总预算（MiB）。 */
  pcmCacheMiB: number;
  /** 纹理字节估算总预算（MiB）。 */
  textureBytesMiB: number;
  /** 未激活解码器保温数。 */
  decoderKeepWarm: number;
  /** C20-T1：v2 窗口帧源 LRU 预算（MiB；IR 帧元数据记账，与解码驻留正交）。 */
  windowCacheMiB: number;
  /** C20-T1：seek 落定后的预取窗数（目标窗 ±N，去抖触发）。 */
  prefetchWindows: number;
  /** C20-T1：窗口取数在途上限。 */
  maxInFlightWindows: number;
}

export const BUDGET_TABLES: Record<BudgetTier, BudgetTable> = {
  conservative: { rangeCacheMiB: 64, pcmCacheMiB: 64, textureBytesMiB: 128, decoderKeepWarm: 1,
    windowCacheMiB: 16, prefetchWindows: 1, maxInFlightWindows: 2 },
  balanced: { rangeCacheMiB: 128, pcmCacheMiB: 128, textureBytesMiB: 256, decoderKeepWarm: 2,
    windowCacheMiB: 32, prefetchWindows: 2, maxInFlightWindows: 3 },
  high: { rangeCacheMiB: 256, pcmCacheMiB: 256, textureBytesMiB: 512, decoderKeepWarm: 2,
    windowCacheMiB: 64, prefetchWindows: 2, maxInFlightWindows: 4 },
};

/** C20-T1：窗口帧源参数上限（表值失配不得放大在途/预取风暴）。 */
export const MAX_PREFETCH_WINDOWS = 2;
export const MAX_IN_FLIGHT_WINDOWS = 4;

/** C20-T1：v2 窗口帧源参数（SyntheticPreview 构造帧源与会话预取共用）。 */
export function windowSourceBudget(tier: BudgetTier): { cacheBytes: number; prefetchWindows: number; maxInFlight: number } {
  const table = BUDGET_TABLES[tier];
  return {
    cacheBytes: table.windowCacheMiB * 1024 * 1024,
    prefetchWindows: Math.min(table.prefetchWindows, MAX_PREFETCH_WINDOWS),
    maxInFlight: Math.min(table.maxInFlightWindows, MAX_IN_FLIGHT_WINDOWS),
  };
}

/** 档位判定（Main 侧执行，Renderer 收离散结果）。
 *
 * - 系统总内存 ≤8GiB 或未知 → conservative（未知按保守策略）。
 * - >16GiB → high（计划注：需实测，先按表开放）。
 * - 其余 → balanced（约 16GiB）。
 */
export function tierForTotalMemory(totalMiB: number | null): BudgetTier {
  if (totalMiB === null || !Number.isFinite(totalMiB) || totalMiB <= 0) return "conservative";
  if (totalMiB <= 8 * 1024) return "conservative";
  if (totalMiB > 16 * 1024) return "high";
  return "balanced";
}

/** 单帧纹理字节估算（NV12：Y 1B/px + UV 1B/px = 1.5B/px + mipmap ~1/3）。
 * 估算口径 = width*height*1.5*4/3（仅预算比较，非精确记账）。 */
export function frameTextureBytes(width: number, height: number): number {
  return Math.round(width * height * 1.5 * (4 / 3));
}

/** 输入环形池（RING 槽 × 单槽帧纹理 + 影子槽）的纹理估算。 */
export function inputTextureBytes(width: number, height: number, ringDepth: number, shadow: boolean): number {
  return frameTextureBytes(width, height) * (ringDepth + (shadow ? 1 : 0));
}

/** 环深调节：预算紧张时 3–8 收缩（计划：LEAD 必须同步下降避免写入覆盖
 * 尚未展示的槽位——调用方联动 LEAD = min(LEAD, ringDepth - 3)）。 */
export function ringDepthFor(tier: BudgetTier, activeInputs: number): number {
  const base = BUDGET_TABLES[tier].textureBytesMiB;
  // 保守档 4 输入以上收 5，其余 8；balanced/high 8（池深上限）
  if (base <= 128 && activeInputs >= 4) return 5;
  return 8;
}

/** B13-R R3：解码驻留平台预测（实测经验律，见 B13-R 实施报告 §2）。
 *
 * 实测（F01/F02/F03/F04/F05 五场景 300s/2400s 轨迹拟合）：Tab 工作集随
 * **unique 源帧解码数**饱和增长至平台 ≈ base + uniqueFrames × perFrameBytes，
 * 与 IR 形态（v1/v2）、上传路径（copyTo/direct）、解码后端（HW/SW）无关
 * ——驻留主体在 Chromium 合成器/解码缓冲层（应用 JS 帧生命周期无泄漏，
 * framesLive=0 遥测证明）。perFrameBytes 为经验值（F02: 16.66GB 平台 =
 * ~0.4GB base + 27000×~600KB；4K60 F05 不符合该律——SW 4K 解码 DPB 有界），
 * 仅用于超限预警，不作为硬上限依据。
 */
const RESIDENCY_BASE_BYTES = 400 * 1024 * 1024;
const RESIDENCY_PER_FRAME_BYTES = 600 * 1024;

export function predictResidencyBytes(uniqueFrames: number, frameWidth: number, frameHeight: number): number {
  // 尺寸缩放：640×360 实测 600KB/帧锚定；驻留主体近似随帧字节数缩放，
  // 但 F05 反例（4K60 SW 平台 510MB）表明大帧 DPB 有界——封顶不外推。
  const anchorBytes = 640 * 360 * 1.5;
  const frameBytes = frameWidth * frameHeight * 1.5;
  if (frameBytes > 4 * anchorBytes) {
    // ≥4× 锚定尺寸（约 ≥1080p）不适用 unique 帧律（DPB 有界），给常数档。
    return RESIDENCY_BASE_BYTES + 512 * 1024 * 1024;
  }
  return RESIDENCY_BASE_BYTES + uniqueFrames * RESIDENCY_PER_FRAME_BYTES;
}
