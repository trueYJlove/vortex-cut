/** B16b 编辑器负载 lease 心跳测试（自重调度/退避/停止语义）。
 *
 * 覆盖（计划第 6 节 B16b）：
 * - 1s 心跳：模式随 updateMode 即时生效（playing/scrubbing/idle）。
 * - 上次请求结束后再调度（无 setInterval 堆叠）：请求在途不重入。
 * - Core 失败退避（1s → 2s → 5s 封顶），恢复回 1s。
 * - stop：不再调度（Core TTL 兜底）；start 幂等。
 * - 非法模式拒绝（updateMode 保持最后值）。
 */
import { describe, expect, it, vi } from "vitest";
import { EditorLoadLeaseHeartbeat, type EditorLoadMode } from "../electron/main/editor-load-lease.js";

interface Scheduled {
  delayMs: number;
  callback: () => void;
}

function makeHarness() {
  const scheduled: Scheduled[] = [];
  const activeTimers = new Set<Scheduled>();
  const report = vi.fn<(input: { window_id: string; mode: EditorLoadMode }) => Promise<unknown>>(
    () => Promise.resolve({ status: "ok" }));
  const heartbeat = new EditorLoadLeaseHeartbeat({
    windowId: "win-1234-abcd",
    report,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback };
      scheduled.push(timer);
      activeTimers.add(timer);
      return () => activeTimers.delete(timer);
    },
  });
  /** 快进下一个待触发定时器（FIFO）。 */
  const fireNext = () => {
    const timer = scheduled.find(item => activeTimers.has(item));
    if (!timer) return;
    activeTimers.delete(timer);
    timer.callback();
  };
  return { heartbeat, report, scheduled, activeTimers, fireNext };
}

describe("EditorLoadLeaseHeartbeat", () => {
  it("1s 心跳：模式即时生效并携带 window_id", async () => {
    const { heartbeat, report, fireNext } = makeHarness();
    heartbeat.updateMode("playing");
    heartbeat.start();
    fireNext();
    await Promise.resolve(); // beat 微任务完成
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ window_id: "win-1234-abcd", mode: "playing" });
    heartbeat.updateMode("scrubbing");
    fireNext();
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith({ window_id: "win-1234-abcd", mode: "scrubbing" });
    heartbeat.stop();
  });

  it("失败退避 1s→2s→封顶；恢复回 1s", async () => {
    const { heartbeat, report, scheduled, fireNext } = makeHarness();
    for (let i = 0; i < 5; i++) report.mockRejectedValueOnce(new Error("core down"));
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    heartbeat.start();
    fireNext(); await settle(); // 失败 1 → 下轮 1s（BASE × failureCount）
    fireNext(); await settle(); // 失败 2 → 下轮 2s
    fireNext(); await settle(); // 失败 3 → 下轮 3s（线性，未到 5s 封顶）
    fireNext(); await settle(); // 失败 4 → 下轮 4s
    fireNext(); await settle(); // 失败 5 → 封顶 5s
    // 调度间隔序列：初始 1s，随后按失败次数线性退避至 5s 封顶
    expect(scheduled[1]!.delayMs).toBe(1_000);
    expect(scheduled[2]!.delayMs).toBe(2_000);
    expect(scheduled[3]!.delayMs).toBe(3_000);
    expect(scheduled[4]!.delayMs).toBe(4_000);
    expect(scheduled[5]!.delayMs).toBe(5_000);
    // 恢复成功 → 回 1s
    fireNext(); await settle();
    expect(scheduled[6]!.delayMs).toBe(1_000);
    heartbeat.stop();
  });

  it("stop 后不再调度；start 幂等（单循环）", async () => {
    const { heartbeat, report, fireNext, activeTimers } = makeHarness();
    heartbeat.start();
    heartbeat.start(); // 幂等
    heartbeat.stop();
    fireNext(); // stop 后即使定时器被外部触发也不再上报
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
    expect(activeTimers.size).toBe(0);
  });

  it("非法模式拒绝（保持最后值）；无推送默认 idle", () => {
    const { heartbeat } = makeHarness();
    expect(heartbeat.currentMode).toBe("idle");
    heartbeat.updateMode("playing");
    heartbeat.updateMode("bogus" as EditorLoadMode);
    expect(heartbeat.currentMode).toBe("playing");
  });
});
