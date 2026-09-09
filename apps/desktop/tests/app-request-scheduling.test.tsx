/** A08：App 级请求调度测试——single-flight、结束后再排程、退避、代次作废。
 *  验收映射（计划第 5 节 A08）：
 *  - 同 endpoint 在途最多 1（后端慢于间隔时不叠加请求）；
 *  - 上一轮结束前不排下一轮（setInterval → setTimeout 语义）；
 *  - 无活跃任务/后台退避；内容未变不写 state（apply 返回 false）；
 *  - 旧项目转录不写入新项目（BoundedTaskQueue 代次作废）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedTaskQueue, RequestScheduler } from "../src/app/request-scheduling.js";

class FakeClock {
  now = 0;
  timeouts: Array<{ at: number; run: () => void }> = [];
  setTimeout(callback: () => void, ms: number): () => void {
    const entry = { at: this.now + ms, run: callback };
    this.timeouts.push(entry);
    return () => {
      const index = this.timeouts.indexOf(entry);
      if (index >= 0) this.timeouts.splice(index, 1);
    };
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      // 先排微任务：resolve 之后的 promise 链（scheduleNext 注册 timer）
      // 需要微任务传播才能出现在 timeouts 里。
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      const next = this.timeouts.filter(entry => entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      const index = this.timeouts.indexOf(next);
      this.timeouts.splice(index, 1);
      next.run();
    }
    this.now = target;
  }
  /** 排空当前微任务（不动时钟）——start() 后让首轮 cycle 跑完排程。 */
  async settle(): Promise<void> {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  }
}

let clock: FakeClock;
let originalSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  clock = new FakeClock();
  originalSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    ((callback: TimerHandler, ms?: number) => {
      if (typeof callback === "function") return clock.setTimeout(() => { (callback as () => void)(); }, ms ?? 0) as never;
      return 0 as never;
    }) as unknown as typeof setTimeout;
});

afterEach(() => {
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
});

describe("RequestScheduler — 同端点 single-flight", () => {
  it("后端慢于间隔：同 endpoint 在途最多 1（合并不叠加）", async () => {
    let fetches = 0;
    let resolveFetch!: (value: { items: number[] }) => void;
    const applied: number[][] = [];
    const scheduler = new RequestScheduler({ activeIntervalMs: 100 });
    scheduler.register({
      key: "projects",
      fetch: () => {
        fetches += 1;
        return new Promise<{ items: number[] }>(resolve => { resolveFetch = resolve; });
      },
      apply: value => { applied.push((value as { items: number[] }).items); return true; },
    });
    scheduler.start();
    await clock.settle();
    await clock.advance(0);
    expect(fetches).toBe(1); // 首轮立即发起
    // 间隔到期但首轮仍在途：不新增请求（在途轮未结束不排下一轮——
    // 「结束后再 setTimeout」语义；timer 到期被 running 守卫重排）。
    await clock.advance(100);
    await clock.advance(100);
    expect(fetches).toBe(1);
    resolveFetch({ items: [1] });
    // resolve 后微任务链走完（advance 内每步排微任务）→ scheduleNext(100ms)。
    await clock.advance(100);
    expect(fetches).toBe(2);
    expect(applied).toEqual([[1]]);
    scheduler.dispose();
  });

  it("上一轮结束前不排下一轮（结束后再 setTimeout）", async () => {
    const completions: number[] = [];
    let pending = 0;
    let maxConcurrent = 0;
    const scheduler = new RequestScheduler({ activeIntervalMs: 50 });
    scheduler.register({
      key: "a",
      fetch: async () => {
        pending += 1;
        maxConcurrent = Math.max(maxConcurrent, pending);
        await clock.advance(30);
        pending -= 1;
        completions.push(clock.now);
        return { v: 1 };
      },
      apply: () => true,
    });
    scheduler.start();
    await clock.settle();
    await clock.advance(200);
    // 每轮完整结束才开始下一轮；同端点在途恒 ≤1。
    expect(maxConcurrent).toBe(1);
    expect(completions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < completions.length; i += 1) {
      expect(completions[i]).toBeGreaterThan(completions[i - 1]);
    }
    scheduler.dispose();
  });

  it("内容未变不写 state（apply 返回 false 记 skippedUnchanged）", async () => {
    let lastApplied: number[] | null = null;
    let applyCalls = 0;
    const scheduler = new RequestScheduler({ activeIntervalMs: 50 });
    scheduler.register({
      key: "jobs",
      fetch: async () => ({ items: [1, 2] }),
      apply: value => {
        applyCalls += 1;
        const signature = value.items.join("|");
        if (lastApplied === null || lastApplied.join("|") !== signature) {
          lastApplied = value.items;
          return true;
        }
        return false; // 浅比较短路：不写 state
      },
    });
    scheduler.start();
    await clock.settle();
    await clock.advance(250);
    expect(applyCalls).toBeGreaterThanOrEqual(3);
    expect(scheduler.stats.skippedUnchanged).toBe(applyCalls - 1); // 只有首轮写 state
    scheduler.dispose();
  });

  it("无活跃任务/后台走慢频；失败退避单调上升且有封顶", async () => {
    const scheduler = new RequestScheduler({
      activeIntervalMs: 100,
      idleIntervalMs: 1000,
      failureBackoffMultiplier: 3,
      failureBackoffCapMs: 5000,
      hasActiveWork: () => false,
      isHidden: () => true,
    });
    expect(scheduler.nextIntervalMs()).toBe(1000); // idle 慢频
    // 模拟连续失败：间隔 ×3^n 封顶 5000。
    const failures = 10;
    for (let i = 1; i <= failures; i += 1) {
      // 直接驱动一个失败轮次：注册一个总抛错的端点。
    }
    const failing = new RequestScheduler({
      activeIntervalMs: 100,
      idleIntervalMs: 1000,
      failureBackoffMultiplier: 3,
      failureBackoffCapMs: 5000,
      hasActiveWork: () => false,
      isHidden: () => true,
    });
    failing.register({ key: "x", fetch: async () => { throw new Error("down"); }, apply: () => true });
    failing.start();
    await clock.settle();
    await clock.advance(0);
    expect(failing.stats.failures).toBe(1);
    expect(failing.nextIntervalMs()).toBe(3000); // 1000 × 3
    await clock.advance(3000);
    expect(failing.stats.failures).toBe(2);
    expect(failing.nextIntervalMs()).toBe(5000); // 9000 → 封顶
    scheduler.dispose();
    failing.dispose();
  });

  it("enabled=false 的端点本轮跳过（模型列表只在事件时刷新）", async () => {
    let modelFetches = 0;
    let jobFetches = 0;
    const scheduler = new RequestScheduler({ activeIntervalMs: 50 });
    scheduler.register({ key: "jobs", fetch: async () => { jobFetches += 1; return {}; }, apply: () => true });
    scheduler.register({
      key: "models",
      enabled: () => false, // 不参与快频轮询
      fetch: async () => { modelFetches += 1; return {}; },
      apply: () => true,
    });
    scheduler.start();
    await clock.settle();
    await clock.advance(300);
    expect(jobFetches).toBeGreaterThanOrEqual(3);
    expect(modelFetches).toBe(0);
    scheduler.dispose();
  });

  it("dispose 后不再排程/发起", async () => {
    let fetches = 0;
    const scheduler = new RequestScheduler({ activeIntervalMs: 50 });
    scheduler.register({ key: "a", fetch: async () => { fetches += 1; return {}; }, apply: () => true });
    scheduler.start();
    await clock.settle();
    expect(fetches).toBe(1); // 只有首轮（间隔 50ms 内 dispose）
    scheduler.dispose();
    await clock.advance(500);
    expect(fetches).toBe(1);
  });
});

describe("BoundedTaskQueue — 并发上限与代次作废", () => {
  it("并发不超过 maxConcurrent（转录加载 ≤4）", async () => {
    let active = 0;
    let maxActive = 0;
    const queue = new BoundedTaskQueue<string>(4);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        queue.push(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return `t${i}`;
        }),
      ),
    );
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(results.filter(r => r !== queue.skipped)).toHaveLength(10);
  });

  it("切项目（代次推进）后旧任务结果被作废——旧项目转录不写入新项目", async () => {
    const queue = new BoundedTaskQueue<string>(4);
    const first = queue.push(async () => {
      await Promise.resolve();
      await Promise.resolve();
      return "旧项目转录";
    });
    queue.advanceGeneration(); // 模拟切项目
    const firstResult = await first;
    expect(firstResult).toBe(queue.skipped); // 旧返回被拦截
    const second = await queue.push(async () => "新项目转录");
    expect(second).toBe("新项目转录");
  });

  it("dispose 清空队列（在途结果被作废）", async () => {
    const queue = new BoundedTaskQueue<string>(1);
    const first = queue.push(async () => {
      await Promise.resolve();
      return "late";
    });
    const second = queue.push(async () => "never");
    queue.dispose();
    expect(await second).toBe(queue.skipped);
    expect(await first).toBe(queue.skipped);
  });

  it("任务异常不堵队列（后续任务继续）", async () => {
    const queue = new BoundedTaskQueue<string>(2);
    const failed = queue.push(async () => { throw new Error("bad media"); });
    const ok = queue.push(async () => "good");
    await expect(failed).resolves.toBe(queue.skipped);
    await expect(ok).resolves.toBe("good");
  });
});
