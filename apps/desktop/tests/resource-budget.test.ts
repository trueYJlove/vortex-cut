/** B13 资源预算 + 输入池回归：档位表/判定、状态机、pin 保护、
 *  压力降级顺序（缩预热 → 清 idle → 缩环深 → 超预算明确回退）、
 *  generation 释放语义。 */
import { describe, expect, it } from "vitest";
import {
  BUDGET_TABLES,
  frameTextureBytes,
  inputTextureBytes,
  ringDepthFor,
  tierForTotalMemory,
  type BudgetTier,
} from "../src/app/preview/resource-budget.js";
import { InputPool, type PoolInput } from "../src/app/preview/input-pool.js";

describe("BUDGET_TABLES", () => {
  it("三档位预算表（MiB）：保守 < balanced < high；保温 1/2/2", () => {
    expect(BUDGET_TABLES.conservative).toEqual({ rangeCacheMiB: 64, pcmCacheMiB: 64, textureBytesMiB: 128, decoderKeepWarm: 1 });
    expect(BUDGET_TABLES.balanced).toEqual({ rangeCacheMiB: 128, pcmCacheMiB: 128, textureBytesMiB: 256, decoderKeepWarm: 2 });
    expect(BUDGET_TABLES.high).toEqual({ rangeCacheMiB: 256, pcmCacheMiB: 256, textureBytesMiB: 512, decoderKeepWarm: 2 });
    expect(BUDGET_TABLES.conservative.textureBytesMiB).toBeLessThan(BUDGET_TABLES.balanced.textureBytesMiB);
    expect(BUDGET_TABLES.balanced.textureBytesMiB).toBeLessThan(BUDGET_TABLES.high.textureBytesMiB);
  });
});

describe("tierForTotalMemory", () => {
  it("≤8GiB/未知 → conservative；>16GiB → high；其余 balanced", () => {
    expect(tierForTotalMemory(null)).toBe("conservative");
    expect(tierForTotalMemory(0)).toBe("conservative");
    expect(tierForTotalMemory(Number.NaN)).toBe("conservative");
    expect(tierForTotalMemory(4 * 1024)).toBe("conservative");
    expect(tierForTotalMemory(8 * 1024)).toBe("conservative");
    expect(tierForTotalMemory(8 * 1024 + 1)).toBe("balanced");
    expect(tierForTotalMemory(16 * 1024)).toBe("balanced");
    expect(tierForTotalMemory(16 * 1024 + 1)).toBe("high");
    expect(tierForTotalMemory(32 * 1024)).toBe("high");
  });
});

describe("纹理估算", () => {
  it("帧纹理 = w*h*1.5*(4/3)（NV12+mipmap 口径）", () => {
    expect(frameTextureBytes(1920, 1080)).toBe(Math.round(1920 * 1080 * 1.5 * (4 / 3)));
    expect(frameTextureBytes(640, 360)).toBe(Math.round(640 * 360 * 1.5 * (4 / 3)));
  });

  it("输入环池估算含影子槽", () => {
    const without = inputTextureBytes(640, 360, 8, false);
    const withShadow = inputTextureBytes(640, 360, 8, true);
    expect(withShadow).toBe(without * 9 / 8);
  });

  it("ringDepthFor：conservative 4+ 输入收 5，其余 8", () => {
    expect(ringDepthFor("conservative", 3)).toBe(8);
    expect(ringDepthFor("conservative", 4)).toBe(5);
    expect(ringDepthFor("conservative", 9)).toBe(5);
    expect(ringDepthFor("balanced", 9)).toBe(8);
    expect(ringDepthFor("high", 9)).toBe(8);
  });
});

describe("InputPool 状态机", () => {
  const input = (id: string, w = 640, h = 360): PoolInput => ({ inputId: id, width: w, height: h, shadow: false });

  it("register → initializing；mark 生命周期推进；failed 状态", () => {
    const pool = new InputPool("balanced");
    const gen = pool.register(input("a"));
    expect(gen).toBe(1);
    expect(pool.stateOf("a")).toBe("initializing");
    expect(pool.mark("a", "warm")).toBe(true);
    expect(pool.stateOf("a")).toBe("warm");
    expect(pool.mark("a", "active")).toBe(true);
    expect(pool.activeIds()).toEqual(["a"]);
    expect(pool.mark("a", "failed")).toBe(true);
    expect(pool.stateOf("a")).toBe("failed");
  });

  it("release 按 generation 作废旧代引用", () => {
    const pool = new InputPool("balanced");
    pool.register(input("a"));
    const gen2 = pool.register(input("a")); // 重新注册 → generation 2
    expect(gen2).toBe(2);
    expect(pool.release("a", 1)).toBe(false); // 旧代引用：作废，不实际移除
    expect(pool.stateOf("a")).not.toBeNull();
    expect(pool.release("a", 2)).toBe(true);
    expect(pool.stateOf("a")).toBeNull();
    expect(pool.release("a", 2)).toBe(false); // 已移除
  });

  it("evicting 状态只接受 cold（回收完成）", () => {
    const pool = new InputPool("balanced");
    pool.register(input("a"));
    pool.mark("a", "active");
    pool.mark("a", "evicting");
    expect(pool.mark("a", "active")).toBe(false); // 回收中不可回 active
    expect(pool.mark("a", "cold")).toBe(true);
    expect(pool.stateOf("a")).toBe("cold");
  });

  it("pin 输入不出现在 idle 淘汰候选", () => {
    const pool = new InputPool("balanced");
    pool.register(input("a"));
    pool.register(input("b"));
    pool.mark("a", "idle");
    pool.mark("b", "idle");
    pool.pin("a");
    expect(pool.idleIds()).toEqual(["b"]);
    expect(pool.evictableIdleIds(0)).toEqual(["b"]);
    pool.unpin("a");
    expect(pool.idleIds().sort()).toEqual(["a", "b"]);
  });
});

describe("InputPool 压力降级（顺序约束）", () => {
  const large = (id: string): PoolInput => ({ inputId: id, width: 3840, height: 2160, shadow: false });

  it("预算内：none（active 不受限）", () => {
    const pool = new InputPool("balanced");
    for (const id of ["a", "b"]) { pool.register({ inputId: id, width: 640, height: 360, shadow: false }); pool.mark(id, "active"); }
    const decision = pool.pressure(pool.activeIds());
    expect(decision.kind).toBe("none");
  });

  it("超预算 + idle 在场：先清 idle（保 keepWarm）", () => {
    const pool = new InputPool("conservative");
    for (const id of ["a", "b"]) { pool.register(large(id)); pool.mark(id, "active"); }
    // 3 个 idle（keepWarm=1 → 回收 2 个；保留 1 个保温）
    for (const id of ["idle1", "idle2", "idle3"]) {
      pool.register({ inputId: id, width: 640, height: 360, shadow: false });
      pool.mark(id, "idle");
    }
    const decision = pool.pressure(pool.activeIds());
    expect(decision.kind).toBe("evict-idle");
    if (decision.kind === "evict-idle") {
      expect(decision.inputIds).toHaveLength(2);
      expect(decision.inputIds).toContain("idle1");
    }
  });

  it("idle 数 ≤ keepWarm 且超预算：缩预热（保温让位）", () => {
    const pool = new InputPool("conservative");
    for (const id of ["a", "b"]) { pool.register(large(id)); pool.mark(id, "active"); }
    pool.register({ inputId: "idle1", width: 640, height: 360, shadow: false });
    pool.mark("idle1", "idle");
    const decision = pool.pressure(pool.activeIds());
    expect(decision.kind).toBe("shrink-prewarm");
  });

  it("idle 全 pin 或清完仍超：缩环深（8→5）", () => {
    const pool = new InputPool("conservative");
    for (const id of ["a", "b", "c", "d"]) {
      pool.register({ ...large(id), shadow: false });
      pool.mark(id, "active");
    }
    // conservative 4 输入 → register 时环深已收 5：手动抬回 8 触发缩环
    for (const id of ["a", "b", "c", "d"]) {
      const entry = pool.entryOf(id)!;
      entry.ringDepth = 8;
    }
    const decision = pool.pressure(pool.activeIds());
    expect(decision.kind).toBe("shrink-ring");
    if (decision.kind === "shrink-ring") {
      expect(decision.ringDepth).toBe(5);
      expect(decision.inputIds.length).toBe(4);
    }
  });

  it("无法降级仍超：over-budget 明确回退（active 列表携带，不静默删层）", () => {
    const pool = new InputPool("conservative");
    for (const id of ["a", "b", "c", "d"]) { pool.register(large(id)); pool.mark(id, "active"); }
    // 环深全部收至 5（无再降空间）且无 idle
    for (const id of ["a", "b", "c", "d"]) {
      pool.entryOf(id)!.ringDepth = 5;
    }
    const decision = pool.pressure(pool.activeIds());
    expect(decision.kind).toBe("over-budget");
    if (decision.kind === "over-budget") expect(decision.activeIds.length).toBe(4);
  });

  it("档位切换（setTier）影响后续 register 环深", () => {
    const pool = new InputPool("conservative");
    pool.register({ inputId: "a", width: 640, height: 360, shadow: false });
    expect(pool.entryOf("a")!.ringDepth).toBe(8); // 3 输入内
    pool.setTier("conservative");
    for (const id of ["b", "c", "d", "e"]) pool.register({ inputId: id, width: 640, height: 360, shadow: false });
    expect(pool.entryOf("e")!.ringDepth).toBe(5); // 4+ 输入收 5
  });

  it("纹理字节估算：cold 条目不计入", () => {
    const pool = new InputPool("balanced");
    pool.register({ inputId: "a", width: 1920, height: 1080, shadow: false });
    const before = pool.textureBytes();
    pool.mark("a", "cold");
    expect(pool.textureBytes()).toBe(0);
    expect(before).toBeGreaterThan(0);
  });
});

describe("档位表与池联动", () => {
  it("三档环深决策一致（枚举驱动的属性测试）", () => {
    for (const tier of ["conservative", "balanced", "high"] as const satisfies readonly BudgetTier[]) {
      const pool = new InputPool(tier);
      for (let i = 0; i < 6; i++) {
        pool.register({ inputId: `in${i}`, width: 640, height: 360, shadow: false });
      }
      expect(pool.entryOf("in5")!.ringDepth).toBe(ringDepthFor(tier, 6));
    }
  });
});
