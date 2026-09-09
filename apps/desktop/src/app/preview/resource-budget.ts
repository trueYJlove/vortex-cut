/** B13 资源预算档位（计划第 6 节 B13）。
 *
 * 约束：
 * - Main 只传离散档位（conservative/balanced/high），不向 Renderer 暴露
 *   额外主机信息；不能仅凭 navigator.deviceMemory 决定独显显存。
 * - 档位默认表（MiB）：
 *   conservative：Range 缓存 64 / PCM 缓存 64 / 纹理估算 128 / 保温 1
 *   balanced：    128 / 128 / 256 / 2
 *   high：        256 / 256 / 512 / 2
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
}

export const BUDGET_TABLES: Record<BudgetTier, BudgetTable> = {
  conservative: { rangeCacheMiB: 64, pcmCacheMiB: 64, textureBytesMiB: 128, decoderKeepWarm: 1 },
  balanced: { rangeCacheMiB: 128, pcmCacheMiB: 128, textureBytesMiB: 256, decoderKeepWarm: 2 },
  high: { rangeCacheMiB: 256, pcmCacheMiB: 256, textureBytesMiB: 512, decoderKeepWarm: 2 },
};

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
