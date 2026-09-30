/**
 * 「持有帧预算/持有窗：收缩后必须能自愈」策略回归（2026-09-30 P33 W11）。
 *
 * 病根（真机 dev A/B 实锤，见 decode-worker.worker.ts 的 UNCLOSED_FRAME_BUDGET_MAX
 * 上方表格与本节末的实测数字）：持有帧预算/持有窗一旦观察到解码器背压就被**永久**
 * 压低（`backpressureSeen = true` 单向棘轮）。对管线深度 11 的素材（3440x1440
 * H.264 无 B 帧），窗被压到 5 后客户端顺序请求连环 miss → 每帧一次「冷启整 GOP」
 * → 越卡越重建。真机 dev 实测（同一素材/窗口，`VITE_AIVS_FORCE_DEGRADED_BUDGET`
 * 强制起点，20s）：
 *
 * | 起点 | 解码 p50 | 出帧 p95 | 冷启 | 观感 |
 * |---|---|---|---|---|
 * | 预算 6 / 窗 5（修复前） | 53→107ms（持续恶化） | 173ms | 176 | 时间码 20s 只走 2s |
 * | 预算 6 / 窗 5（修复后） | 1.8ms | 4.6~17ms | **0** | 正常（首秒 4 帧起播抖动） |
 *
 * 本测试只验证**策略状态机**（与 worker 内常量一一对应；decode worker 是 worker
 * 入口模块无法直接 import，故与 decode-linear-pipeline-hold.test.ts 同套路数建模）。
 * 端到端证据另见 evidence/performance/preview-smoothness-baseline/ 与 App 内 e2e。
 */
import { describe, expect, it } from "vitest";

// ── 与 decode-worker.worker.ts 同值的策略常量 ──────────────────────────────
const BUDGET_MIN = 5;
const BUDGET_H264 = 12;
const BUDGET_HEVC = 8;
const WINDOW_HARD_CAP = 12;
const WINDOW_MIN = 6;
const HEALTHY_DELIVERIES_PER_RAISE = 3;
const BACKPRESSURE_RECOVERY_COOLDOWN_MS = 1_500;
const RECOVERY_DELIVERIES_PER_RAISE = 4;
const EVICTED_MISS_RAISE_INTERVAL_MS = 200;

/** 策略状态（worker 内为模块级变量；此处显式化以便对拍）。 */
interface State {
  budget: number;
  cap: number;
  windowCap: number;
  feedAheadPeak: number;
  healthyDeliveries: number;
  lastBackpressureAt: number;
  lastEvictedMissRaiseAt: number;
}

function init(codec: "avc" | "hevc"): State {
  const cap = codec === "hevc" ? BUDGET_HEVC : BUDGET_H264;
  return {
    budget: Math.max(BUDGET_MIN, cap), cap, windowCap: WINDOW_MIN, feedAheadPeak: 0,
    healthyDeliveries: 0, lastBackpressureAt: Number.NEGATIVE_INFINITY, lastEvictedMissRaiseAt: Number.NEGATIVE_INFINITY,
  };
}

/** 收到一次成功交付（worker：输出回调命中活动请求时 healthyDeliveries += 1）。 */
const noteDelivery = (state: State): void => { state.healthyDeliveries += 1; };

/** 观察到背压（静默 + dq>0）：立即收缩 + 重置回升计时（安全侧不变）。 */
function shrinkForBackpressure(state: State, held: number, now: number): number {
  state.lastBackpressureAt = now;
  state.healthyDeliveries = 0;
  const before = held;
  state.budget = Math.max(BUDGET_MIN, Math.min(state.budget, before - 2));
  state.windowCap = Math.max(2, Math.min(state.windowCap, state.budget - 1));
  // 注意：实测管线深度（feedAheadPeak）**不随收缩清零**——它是知识，不是水位。
  const after = Math.min(before, state.budget);
  return Math.max(0, before - after); // 实际释放的帧数（0 = 空操作）
}

/** 前摄扩容（worker：growHoldCapFor）——能否抬预算。 */
function tryProactiveRaise(state: State, aheadSamples: number, now: number, cacheSize: number, hasAnchor: boolean): boolean {
  state.feedAheadPeak = Math.max(state.feedAheadPeak, aheadSamples);
  const want = Math.min(WINDOW_HARD_CAP, Math.max(WINDOW_MIN, aheadSamples + 2));
  if (want <= state.windowCap) return false;
  const needed = want + cacheSize + (hasAnchor ? 1 : 0);
  if (needed > state.budget) {
    const recovering = Number.isFinite(state.lastBackpressureAt);
    const required = recovering ? RECOVERY_DELIVERIES_PER_RAISE : HEALTHY_DELIVERIES_PER_RAISE;
    if (state.healthyDeliveries < required) return false;
    if (recovering && now - state.lastBackpressureAt < BACKPRESSURE_RECOVERY_COOLDOWN_MS) return false;
    state.budget = Math.min(state.cap, state.budget + 1);
    state.healthyDeliveries = 0;
  }
  state.windowCap = Math.min(want, state.budget);
  return true;
}

/** 被驱逐 miss（missingStuck）→ 抬一级水位（不受冷却窗口限制，按 codec 档位封顶 + 限速）。 */
function raiseForEvictedMiss(state: State, now: number): boolean {
  if (now - state.lastEvictedMissRaiseAt < EVICTED_MISS_RAISE_INTERVAL_MS) return false;
  if (state.budget >= state.cap) return false;
  state.lastEvictedMissRaiseAt = now;
  state.budget = Math.min(state.cap, state.budget + 1);
  const want = Math.min(WINDOW_HARD_CAP, Math.max(WINDOW_MIN, state.feedAheadPeak + 2));
  state.windowCap = Math.min(want, state.budget);
  state.healthyDeliveries = 0;
  return true;
}

/** 旧策略：被驱逐 miss 只重建，不动水位（棘轮）。新策略：抬水位。 */
const recover = (state: State, now: number, policy: "ratchet" | "recoverable"): void => {
  if (policy === "recoverable") raiseForEvictedMiss(state, now);
};

describe("持有帧预算/持有窗：背压收缩后必须能自愈", () => {
  it("收缩仍然即时且激进（安全侧不变）：8 → 6，窗跟着压到 5", () => {
    const state = init("avc");
    state.windowCap = 12;
    state.feedAheadPeak = 11;
    const freed = shrinkForBackpressure(state, 8, 1_000);
    expect(state.budget).toBe(6);
    expect(state.windowCap).toBe(5);
    expect(freed).toBe(2);
  });

  it("旧策略（棘轮）在深管线素材上永远回不去：被驱逐 miss 抬不动水位", () => {
    const state = init("avc");
    state.windowCap = 12;
    state.feedAheadPeak = 11;
    shrinkForBackpressure(state, 8, 0);
    for (let frame = 0; frame < 200; frame++) {
      noteDelivery(state);
      recover(state, frame * 33, "ratchet");
    }
    expect(state.budget).toBe(6); // 单向棘轮：无论多少帧、多少 miss，水位不动
    expect(state.windowCap).toBe(5);
  });

  it("新策略：被驱逐 miss 抬水位 ⇒ 限速内收敛回档位上限，且换 codec 用各自档位", () => {
    const state = init("avc");
    state.windowCap = 12;
    state.feedAheadPeak = 11;
    shrinkForBackpressure(state, 8, 0);
    let raises = 0;
    // 每帧一次 miss（风暴形态），限速 200ms ⇒ 理论上每 ~6 帧抬一级
    for (let frame = 0; frame < 200 && state.budget < state.cap; frame++) {
      if (raiseForEvictedMiss(state, frame * 33)) raises += 1;
    }
    expect(state.budget).toBe(BUDGET_H264);
    expect(state.windowCap).toBe(BUDGET_H264); // 窗随预算回到 12 ≥ 管线深度 11
    expect(raises).toBe(BUDGET_H264 - 6);
    // 限速生效：133ms 内第二次 miss 不再抬
    const quick = init("avc");
    quick.budget = 6;
    quick.feedAheadPeak = 11;
    expect(raiseForEvictedMiss(quick, 1_000)).toBe(true);
    expect(raiseForEvictedMiss(quick, 1_100)).toBe(false);
    expect(raiseForEvictedMiss(quick, 1_250)).toBe(true);
    // HEVC 档位上限 8：抬到 8 即止（W5 记录的 10 就停摆，绝不能爬过去）
    const hevc = init("hevc");
    hevc.windowCap = 12;
    hevc.feedAheadPeak = 11;
    shrinkForBackpressure(hevc, 8, 0);
    for (let frame = 0; frame < 200; frame++) raiseForEvictedMiss(hevc, frame * 33);
    expect(hevc.budget).toBe(BUDGET_HEVC);
    expect(hevc.windowCap).toBe(BUDGET_HEVC);
  });

  it("纯计时式回升仍受「安静 + 持续健康」约束（不在池子还紧时往上撞）", () => {
    const state = init("avc");
    state.budget = 6;          // 已被压过的水位
    state.windowCap = 5;
    state.feedAheadPeak = 11;
    shrinkForBackpressure(state, 6, 10_000); // 刚落过背压（held 6 → budget 5? 取 max(MIN,..)=5）
    const budgetAfterShrink = state.budget;
    // 冷却窗口内：即便连续健康交付也不抬
    for (let i = 0; i < 20; i++) { noteDelivery(state); tryProactiveRaise(state, 11, 10_200, 3, true); }
    expect(state.budget).toBe(budgetAfterShrink);
    // 安静够久 + 健康序列足：允许逐级回升
    for (let i = 0; i < 20; i++) { noteDelivery(state); tryProactiveRaise(state, 11, 12_000, 3, true); }
    expect(state.budget).toBeGreaterThan(budgetAfterShrink);
    expect(state.budget).toBeLessThanOrEqual(state.cap);
  });
});
