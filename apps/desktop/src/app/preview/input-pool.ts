/** B13 活跃输入池：输入状态机 + 预算压力降级决策（纯逻辑，无 GL/Worker）。
 *
 * 约束（PERFORMANCE_IMPLEMENTATION_PLAN 第 6 节 B13）：
 * - 状态机 cold→initializing→warm→active→idle→evicting→cold；另有 failed。
 * - active 为当前帧/转场/同时 overlay 全部输入——不能把"最多 2 个解码器"
 *   误解为只显示 2 轨（active 数可 > 保温数）。
 * - current/next 窗口 pin 不能被 LRU 淘汰；缓存空间不足时请求排队/降级，
 *   不能超预算后才统计。
 * - 资源紧张顺序：缩预热 → 清 idle → 降环深/代理档，仍无法满足 active
 *   → 明确回退/暂停（reduction 判定结果），不静默删图层。
 * - 释放必须等待当前引用/上传完成或经 generation 作废——本模块只做
 *   决策（generation 计数与 ack 等待在 Worker 协议层）。
 */
import {
  BUDGET_TABLES,
  inputTextureBytes,
  ringDepthFor,
  type BudgetTier,
} from "./resource-budget.js";

export type InputState =
  | "cold" | "initializing" | "warm" | "active" | "idle" | "evicting" | "failed";

export interface PoolInput {
  inputId: string;
  width: number;
  height: number;
  shadow: boolean;
}

export interface PoolEntry extends PoolInput {
  state: InputState;
  /** 绑定代（releaseInput(generation) 作废旧代引用）。 */
  generation: number;
  /** 环深（随预算动态调整）。 */
  ringDepth: number;
}

/** 压力降级决策（按计划顺序）。 */
export type Reduction =
  | { kind: "none" }
  | { kind: "shrink-prewarm"; keepWarm: number }
  | { kind: "evict-idle"; inputIds: string[] }
  | { kind: "shrink-ring"; inputIds: string[]; ringDepth: number }
  | { kind: "over-budget"; activeIds: string[] };

export class InputPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pinned = new Set<string>(); // current/next 窗口 pin

  constructor(private tier: BudgetTier) {}

  get tierRef(): BudgetTier {
    return this.tier;
  }

  setTier(tier: BudgetTier): void {
    this.tier = tier;
  }

  /** 注册/更新输入（registerInput 对应物；代递增）。
   *
   * 环深按当前注册输入总数决策（active+idle+initializing 均占纹理）。 */
  register(input: PoolInput): number {
    const existing = this.entries.get(input.inputId);
    const generation = (existing?.generation ?? 0) + 1;
    const ringDepth = ringDepthFor(this.tier, this.entries.size + (existing ? 0 : 1));
    this.entries.set(input.inputId, {
      ...input, state: existing?.state === "active" ? "active" : "initializing",
      generation, ringDepth,
    });
    return generation;
  }

  /** 释放输入（idle 回收/cold 化）；返回是否实际移除。 */
  release(inputId: string, generation?: number): boolean {
    const entry = this.entries.get(inputId);
    if (!entry) return false;
    if (generation !== undefined && entry.generation !== generation) return false; // 旧代引用作废
    this.entries.delete(inputId);
    this.pinned.delete(inputId);
    return true;
  }

  mark(inputId: string, state: InputState): boolean {
    const entry = this.entries.get(inputId);
    if (!entry) return false;
    if (entry.state === "evicting" && state !== "cold" && state !== "evicting") return false;
    entry.state = state;
    return true;
  }

  stateOf(inputId: string): InputState | null {
    return this.entries.get(inputId)?.state ?? null;
  }

  entryOf(inputId: string): PoolEntry | null {
    return this.entries.get(inputId) ?? null;
  }

  /** pin/unpin（current/next 窗口——LRU 不可淘汰）。 */
  pin(inputId: string): void { this.pinned.add(inputId); }
  unpin(inputId: string): void { this.pinned.delete(inputId); }

  activeIds(): string[] {
    return [...this.entries.values()].filter(entry => entry.state === "active").map(entry => entry.inputId);
  }

  idleIds(): string[] {
    return [...this.entries.values()].filter(entry => entry.state === "idle" && !this.pinned.has(entry.inputId))
      .map(entry => entry.inputId);
  }

  /** 保温候选：idle 中最近活跃者之外可回收（keepWarm 数量内保留）。 */
  evictableIdleIds(keepWarm: number): string[] {
    const idle = this.idleIds();
    return idle.slice(0, Math.max(0, idle.length - keepWarm));
  }

  /** 纹理字节估算总和（active + idle 注册项）。 */
  textureBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "cold") continue;
      total += inputTextureBytes(entry.width, entry.height, entry.ringDepth, entry.shadow);
    }
    return total;
  }

  /** 压力评估：给出下一步降级动作（顺序：清 idle（保 keepWarm）→ 缩
   * 预热 → 缩环深 → 超预算回退）。active 输入在预算内时永不降级到删层。 */
  pressure(activeIds: string[]): Reduction {
    const table = BUDGET_TABLES[this.tier];
    const budgetBytes = table.textureBytesMiB * 1024 * 1024;
    // active 需求：全部 active 输入的环池 + 影子
    let activeBytes = 0;
    for (const inputId of activeIds) {
      const entry = this.entries.get(inputId);
      if (entry) activeBytes += inputTextureBytes(entry.width, entry.height, entry.ringDepth, entry.shadow);
    }
    const idleList = this.idleIds();
    if (activeBytes + this.idleTextureBytes() > budgetBytes) {
      // 第 1 步：清 idle（保留 keepWarm 数量；不足回收时全清——保温让位）
      const reclaim = this.evictableIdleIds(table.decoderKeepWarm);
      if (reclaim.length > 0) {
        return { kind: "evict-idle", inputIds: reclaim };
      }
      if (idleList.length > 0 && table.decoderKeepWarm > 0) {
        // 第 2 步：仍有 idle（被 keepWarm 保留）→ 缩预热（全清）
        return { kind: "shrink-prewarm", keepWarm: 0 };
      }
    }
    // 第 3 步：仍超 → 缩 active 环深（8→5）
    if (activeBytes > budgetBytes) {
      const shrunk = activeIds.filter(inputId => {
        const entry = this.entries.get(inputId);
        return entry !== undefined && entry.ringDepth > 5;
      });
      if (shrunk.length > 0) {
        return { kind: "shrink-ring", inputIds: shrunk, ringDepth: 5 };
      }
    }
    // 第 4 步：无法降级仍超 → 明确回退（调用方提示/暂停，不静默删层）
    if (activeBytes > budgetBytes) {
      return { kind: "over-budget", activeIds };
    }
    return { kind: "none" };
  }

  private idleTextureBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "idle") {
        total += inputTextureBytes(entry.width, entry.height, entry.ringDepth, entry.shadow);
      }
    }
    return total;
  }
}
